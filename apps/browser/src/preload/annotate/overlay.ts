/**
 * The annotation overlay the browser's *page view* preload injects: the
 * picking-mode hover highlight (element outline + corner tag), the persisted
 * markers (dashed outline + numbered corner badge), and the annotation popup
 * card. Everything it renders lives inside one host element carrying a
 * **closed shadow root**, so the untrusted page can neither style it nor
 * traverse into it — the page sees at most an attribute-less empty div.
 *
 * Isolation strategy (why plain DOM and hardcoded colors):
 *
 * - the overlay must render inside the page's own renderer (the page view
 *   paints over the chrome view's stage, so no layer above the page exists), and
 *   it must be invisible to page *JS* — hence the closed shadow root, which
 *   stops DOM traversal at the host, plus `all: initial` + `!important` inline
 *   styles on the host, which stop page CSS at the boundary;
 * - what the page *can* observe it must not profit from: the picking-mode
 *   interceptors sit on window in the capture phase (registered by the
 *   preload, so they precede every page listener), the note input's events
 *   stop at the shadow boundary, and a restyled or hidden host is re-asserted
 *   from its own attribute mutations;
 * - suite design tokens cannot apply here: `var(--surface)` and friends would
 *   resolve against the *page's* custom properties (custom properties inherit
 *   into shadow trees), and the overlay must stay legible on arbitrary page
 *   content regardless of the suite theme — so the palette is a fixed
 *   constants table, in the spirit of the canvas-chrome tables (CLAUDE.md
 *   rule 5), not theme-keyed.
 *
 * Pure DOM code on purpose: no Electron imports, so jsdom tests drive the
 * whole picking/marking/card flow without a browser. The IPC glue lives in
 * the thin page-annotate preload entry.
 */

import type { BrowserAnnotation, AnnotationPinDraft } from '../../shared/annotations'
import { buildSelector } from './selector'
import { buildXPath } from './xpath'
import { ANNOTATE_COLORS } from './colors'

/** the strings the overlay renders, resolved by the preload entry per locale */
export interface AnnotateOverlayStrings {
  /** the picking-mode hint chip */
  hint: string
  /** the note input's placeholder */
  notePlaceholder: string
  /** the card's delete button */
  delete: string
  /** the card's ask-AI button */
  askAi: string
  /** the overlay's writing direction ('rtl' for ar/he) */
  dir: 'ltr' | 'rtl'
}

export interface AnnotateOverlayDeps {
  /** the page's document (injected so tests can mount a fresh jsdom) */
  doc: Document
  /** current strings — re-read on every state push so a locale change lands */
  strings: () => AnnotateOverlayStrings
  /** an element was clicked in picking mode: pin it as a new annotation */
  onPin: (draft: AnnotationPinDraft) => void
  /** the card's note changed (debounced ~400 ms by the overlay) */
  onNote: (id: string, note: string) => void
  /** the card's delete button */
  onDelete: (id: string) => void
  /** the card's ask-AI button */
  onAsk: (id: string) => void
  /** Esc pressed in picking mode with no card open: leave the mode */
  onExit: () => void
  /**
   * Test seam: hands over the injected host and its closed shadow root right
   * after creation. Only the isolated world can ever hold these references —
   * the page renderer has no path to this callback — so it costs nothing at
   * runtime and lets the jsdom suite assert on the layer's internals.
   */
  inspect?: (parts: { host: HTMLElement; shadow: ShadowRoot }) => void
}

/** what main pushes (subset of the shared state the overlay consumes) */
export interface AnnotatePageState {
  mode: boolean
  annotations: readonly BrowserAnnotation[]
}

export interface AnnotateOverlay {
  /** adopt a new full state: markers diffed by id, mode + strings refreshed */
  setPageState(state: AnnotatePageState): void
  /** open the card for one annotation; waits for its marker if not drawn yet */
  openCardFor(id: string): void
  /** tear the overlay down (tests; a document teardown needs nothing) */
  destroy(): void
}

// ── picking-mode event interception ────────────────────────────────────────

/**
 * The host's inline style: `all: initial` resets inherited page styling, and
 * every declaration carries `!important` so a hostile `div { … !important }`
 * page rule cannot win against it (inline !important outranks stylesheet
 * !important). The host itself stays pointer-transparent — interactive
 * children (badges, the card) opt back in with `pointer-events: auto`.
 */
const HOST_STYLE =
  'all:initial!important;position:fixed!important;top:0!important;left:0!important;' +
  'width:100%!important;height:100%!important;z-index:2147483647!important;' +
  'pointer-events:none!important;display:block!important'

const NOTE_DEBOUNCE_MS = 400
const MUTATION_SETTLE_MS = 200

const snippetOf = (el: Element): string =>
  (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)

/** the target's rect in document coordinates (stable across scroll) */
function documentRect(el: Element): AnnotationPinDraft['rect'] {
  const rect = el.getBoundingClientRect()
  const view = el.ownerDocument.defaultView
  const scrollX = view?.scrollX ?? 0
  const scrollY = view?.scrollY ?? 0
  return {
    x: Math.round(rect.x + scrollX),
    y: Math.round(rect.y + scrollY),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

/**
 * The target's rect in viewport coordinates at pin time — the exact region
 * main crops out of a capturePage for the pin-time element shot. Unlike the
 * document rect this one goes stale on scroll, which is why it travels with
 * the pin IPC only (the capture runs immediately) and is never stored.
 */
function viewportRect(el: Element): AnnotationPinDraft['viewportRect'] {
  const rect = el.getBoundingClientRect()
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

/** one drawn marker: the record, its resolved target, and its two boxes */
interface MarkerEntry {
  record: BrowserAnnotation
  target: Element | null
  outline: HTMLElement
  badge: HTMLElement
}

export function createAnnotateOverlay(deps: AnnotateOverlayDeps): AnnotateOverlay {
  const { doc } = deps
  const win = doc.defaultView

  // ── the isolated host + closed shadow root ───────────────────────────────
  const host = doc.createElement('div')
  host.setAttribute('style', HOST_STYLE)
  const shadow = host.attachShadow({ mode: 'closed' })
  const style = doc.createElement('style')
  style.textContent = OVERLAY_CSS
  shadow.appendChild(style)
  const layer = doc.createElement('div')
  layer.className = 'anno-layer'
  shadow.appendChild(layer)
  const mount = (): void => {
    // a preload runs before the parser has produced <html> on a fresh
    // navigation — both body and documentElement can be null at that point;
    // defer to DOMContentLoaded instead of crashing the whole preload
    if (host.isConnected) return
    const root = doc.body ?? doc.documentElement
    if (root) root.appendChild(host)
  }
  if (doc.documentElement) mount()
  else doc.addEventListener('DOMContentLoaded', mount, { once: true })
  deps.inspect?.({ host, shadow })

  // ── overlay state ────────────────────────────────────────────────────────
  let mode = false
  const markers = new Map<string, MarkerEntry>()
  let hoverTarget: Element | null = null
  let pendingCardId: string | null = null
  let cardFor: string | null = null
  let noteTimer: ReturnType<typeof setTimeout> | null = null

  const hoverBox = doc.createElement('div')
  hoverBox.className = 'anno-hover'
  hoverBox.style.display = 'none'
  const hoverTag = doc.createElement('div')
  hoverTag.className = 'anno-hover-tag'
  hoverTag.style.display = 'none'
  const hint = doc.createElement('div')
  hint.className = 'anno-hint'
  hint.style.display = 'none'
  const card = doc.createElement('div')
  card.className = 'anno-card'
  card.style.display = 'none'
  for (const node of [hoverBox, hoverTag, hint, card]) layer.appendChild(node)

  /** the card's live inputs (rebuilt on open) */
  let cardSnippet = doc.createElement('div')
  let cardNote = doc.createElement('textarea')
  let cardDelete = doc.createElement('button')
  let cardAsk = doc.createElement('button')

  // a node belongs to the overlay when it is the host or lives in its shadow
  // tree (host.contains alone cannot see into a shadow root, and the page can
  // only ever hand us the host itself — events retarget at the boundary)
  const withinHost = (node: Node | null): boolean =>
    node !== null && (node === host || host.contains(node) || shadow.contains(node))

  /** the event's target as a node, null for non-node targets (window, document wrappers) */
  const targetNode = (event: Event): Node | null =>
    event.target instanceof Node ? event.target : null

  // ── hover highlight ──────────────────────────────────────────────────────

  const setHover = (target: Element | null): void => {
    if (!mode) target = null
    if (target !== null && (target === doc.documentElement || withinHost(target))) target = null
    if (target === hoverTarget) return
    hoverTarget = target
    if (target === null) {
      hoverBox.style.display = 'none'
      hoverTag.style.display = 'none'
      return
    }
    positionHover()
    hoverBox.style.display = 'block'
    hoverTag.style.display = 'block'
    const snippet = snippetOf(target).slice(0, 80)
    hoverTag.textContent = snippet ? `${target.tagName} · ${snippet}` : target.tagName
  }

  const place = (node: HTMLElement, rect: DOMRect, outset: number): void => {
    node.style.left = `${Math.round(rect.left) - outset}px`
    node.style.top = `${Math.round(rect.top) - outset}px`
    node.style.width = `${Math.round(rect.width) + outset * 2}px`
    node.style.height = `${Math.round(rect.height) + outset * 2}px`
  }

  function positionHover(): void {
    if (hoverTarget === null) return
    place(hoverBox, hoverTarget.getBoundingClientRect(), 2)
    const rect = hoverTarget.getBoundingClientRect()
    // the tag hugs the outline's top-left corner, never off-screen
    const tagRect = hoverTag.getBoundingClientRect()
    hoverTag.style.left = `${Math.max(2, Math.round(rect.left) - 2)}px`
    hoverTag.style.top = `${Math.max(2, Math.round(rect.top) - 2 - tagRect.height)}px`
  }

  // ── markers ──────────────────────────────────────────────────────────────

  /** re-resolve one marker's target from its selector; a miss hides it silently */
  const resolveMarker = (entry: MarkerEntry): void => {
    let next: Element | null = null
    try {
      const hits = doc.querySelectorAll(entry.record.selector)
      if (hits.length > 0) next = hits[0] ?? null
    } catch {
      next = null
    }
    entry.target = next
    const visible = next !== null
    entry.outline.style.display = visible ? 'block' : 'none'
    entry.badge.style.display = visible ? 'flex' : 'none'
  }

  const positionMarker = (entry: MarkerEntry): void => {
    if (entry.target === null) return
    place(entry.outline, entry.target.getBoundingClientRect(), 0)
    const rect = entry.target.getBoundingClientRect()
    entry.badge.style.left = `${Math.round(rect.left) - 11}px`
    entry.badge.style.top = `${Math.round(rect.top) - 11}px`
  }

  const resolveAll = (): void => {
    mount()
    for (const entry of markers.values()) {
      if (entry.target === null || !entry.target.isConnected) resolveMarker(entry)
      positionMarker(entry)
    }
  }

  function buildMarker(record: BrowserAnnotation, index: number): MarkerEntry {
    const outline = doc.createElement('div')
    outline.className = 'anno-marker'
    const badge = doc.createElement('div')
    badge.className = 'anno-badge'
    badge.textContent = String(index + 1)
    // stop the composed event at the boundary: the page must not observe a
    // click that never left the overlay (it would retarget to the host)
    badge.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      openCardFor(record.id)
    })
    layer.appendChild(outline)
    layer.appendChild(badge)
    const entry: MarkerEntry = { record, target: null, outline, badge }
    resolveMarker(entry)
    positionMarker(entry)
    return entry
  }

  // ── the popup card ───────────────────────────────────────────────────────

  const flushNote = (): void => {
    if (noteTimer === null || cardFor === null) return
    clearTimeout(noteTimer)
    noteTimer = null
    deps.onNote(cardFor, cardNote.value)
  }

  function buildCard(record: BrowserAnnotation): void {
    cardSnippet = doc.createElement('div')
    cardSnippet.className = 'anno-card-snippet'
    cardSnippet.textContent = record.textSnippet || record.tagName
    cardNote = doc.createElement('textarea')
    cardNote.className = 'anno-card-note'
    cardNote.placeholder = deps.strings().notePlaceholder
    cardNote.value = record.note
    cardNote.rows = 2
    cardNote.addEventListener('input', (event) => {
      // the note is the person's own words about the page: it stops at the
      // shadow boundary (the badge's click precedent), so no page listener on
      // the propagation path can see the input event and rebuild what was
      // typed. Our own handlers sit on window in the capture phase, which
      // runs before this target-phase listener, so the debounce below is
      // unaffected.
      event.stopPropagation()
      if (noteTimer !== null) clearTimeout(noteTimer)
      noteTimer = setTimeout(flushNote, NOTE_DEBOUNCE_MS)
    })
    for (const type of ['keydown', 'keypress'] as const) {
      cardNote.addEventListener(type, (event) => event.stopPropagation())
    }
    cardDelete = doc.createElement('button')
    cardDelete.className = 'anno-card-delete'
    cardDelete.textContent = deps.strings().delete
    cardDelete.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      closeCard()
      deps.onDelete(record.id)
    })
    cardAsk = doc.createElement('button')
    cardAsk.className = 'anno-card-ask'
    cardAsk.textContent = deps.strings().askAi
    cardAsk.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      flushNote()
      closeCard()
      deps.onAsk(record.id)
    })
    card.replaceChildren(cardSnippet, cardNote, cardDelete, cardAsk)
  }

  function openCardFor(id: string): void {
    const entry = markers.get(id)
    if (entry === undefined) {
      pendingCardId = id
      return
    }
    pendingCardId = null
    cardFor = id
    buildCard(entry.record)
    card.style.display = 'block'
    positionCard()
    cardNote.focus()
  }

  function positionCard(): void {
    if (cardFor === null) return
    const entry = markers.get(cardFor)
    if (!entry || entry.target === null) return
    const rect = entry.target.getBoundingClientRect()
    const view = doc.defaultView
    const width = view?.innerWidth ?? 1200
    const height = view?.innerHeight ?? 800
    const cardRect = card.getBoundingClientRect()
    const left = Math.min(Math.max(8, rect.left), Math.max(8, width - cardRect.width - 8))
    const below = rect.bottom + 8 + cardRect.height < height - 8
    const top = below ? rect.bottom + 8 : Math.max(8, rect.top - cardRect.height - 8)
    card.style.left = `${Math.round(left)}px`
    card.style.top = `${Math.round(top)}px`
  }

  function closeCard(): void {
    flushNote()
    cardFor = null
    pendingCardId = null
    card.style.display = 'none'
    card.replaceChildren()
  }

  // ── picking-mode interception ────────────────────────────────────────────
  //
  // The interceptors sit on *window* in the capture phase: window is the
  // first node of every propagation path, and the preload registers before
  // any page script, so no page listener — not even another window-capture
  // one — can run ahead of them. While picking, the page's whole input
  // surface is consumed (preventDefault kills the default action,
  // stopImmediatePropagation halts the dispatch — both flags live on the
  // shared event, so they hold across the isolation boundary too); off
  // picking mode, and on the overlay's own nodes, nothing is touched at all.

  const onOver = (event: Event): void => {
    if (!mode) return
    const target = event.target
    setHover(target instanceof Element ? target : null)
  }

  /** mouse/pointer/menu/wheel events that are not the pick itself: consumed */
  const onPlainIntercept = (event: Event): void => {
    if (!mode) return
    if (withinHost(targetNode(event))) return
    // no drags, no selection, no context menus, no page handlers while picking
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  const onClick = (event: Event): void => {
    if (withinHost(targetNode(event))) return
    if (cardFor !== null) {
      // a click outside the card closes it; off-mode the click passes through
      // (the page may keep working), in picking mode it is consumed
      closeCard()
      if (!mode) return
      event.preventDefault()
      event.stopImmediatePropagation()
      return
    }
    if (!mode) return
    event.preventDefault()
    event.stopImmediatePropagation()
    const target = event.target instanceof Element ? event.target : null
    if (target === null) return
    for (const entry of markers.values()) {
      if (entry.target === target) {
        openCardFor(entry.record.id)
        return
      }
    }
    const draft: AnnotationPinDraft = {
      selector: buildSelector(target),
      xpath: buildXPath(target),
      tagName: target.tagName,
      textSnippet: snippetOf(target),
      rect: documentRect(target),
      viewportRect: viewportRect(target),
    }
    setHover(null)
    deps.onPin(draft)
  }

  /**
   * Keyboard while picking: the overlay's own nodes (the card's textarea) and
   * a page field the user is actually editing keep their keys — those are
   * editing keys. Every other key can only drive the page (activation,
   * focus moves, page shortcuts), so it is consumed. Esc keeps its existing
   * meaning: close the card, else leave the mode.
   */
  const onKey = (event: Event): void => {
    if (event.type === 'keydown' && (event as KeyboardEvent).key === 'Escape') {
      if (cardFor !== null) {
        event.preventDefault()
        event.stopImmediatePropagation()
        closeCard()
        return
      }
      if (!mode) return
      event.preventDefault()
      event.stopImmediatePropagation()
      setHover(null)
      deps.onExit()
      return
    }
    if (!mode) return
    const target = targetNode(event)
    if (withinHost(target)) return
    if (
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    ) {
      return
    }
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  const onScroll = (): void => {
    positionHover()
    for (const entry of markers.values()) positionMarker(entry)
    positionCard()
  }

  const onResize = onScroll

  const capture = { capture: true, passive: true } as AddEventListenerOptions
  // passive:false is required for wheel: window/document-level wheel and
  // touch listeners default to passive in Chromium, where preventDefault
  // would then be ignored
  const captureIntercept = { capture: true, passive: false } as AddEventListenerOptions
  doc.addEventListener('pointerover', onOver, capture)
  doc.addEventListener('mouseover', onOver, capture)
  doc.addEventListener('scroll', onScroll, capture)
  win?.addEventListener('resize', onResize)
  for (const type of [
    'pointerdown',
    'pointerup',
    'mousedown',
    'mouseup',
    'auxclick',
    'contextmenu',
    'wheel',
  ] as const) {
    win?.addEventListener(type, onPlainIntercept, captureIntercept)
  }
  win?.addEventListener('click', onClick, captureIntercept)
  for (const type of ['keydown', 'keypress', 'keyup'] as const) {
    win?.addEventListener(type, onKey, captureIntercept)
  }

  // an SPA re-rendering content under the markers: re-resolve + reposition.
  // The host's own style attribute is watched too: a page that restyles or
  // hides the overlay (display:none, a replaced style attribute) loses the
  // race in the same microtask — HOST_STYLE is re-asserted, so the layer
  // cannot be quietly switched off before the next state push.
  let settleTimer: ReturnType<typeof setTimeout> | null = null
  const observer = new MutationObserver((records) => {
    if (
      records.some((record) => record.type === 'attributes') &&
      host.getAttribute('style') !== HOST_STYLE
    ) {
      host.setAttribute('style', HOST_STYLE)
    }
    if (settleTimer !== null) return
    settleTimer = setTimeout(() => {
      settleTimer = null
      resolveAll()
      positionCard()
    }, MUTATION_SETTLE_MS)
  })
  const observeMutations = (): void => {
    if (doc.documentElement)
      observer.observe(doc.documentElement, { childList: true, subtree: true })
    observer.observe(host, { attributes: true, attributeFilter: ['style'] })
  }
  observeMutations()

  // ── state adoption ───────────────────────────────────────────────────────

  function setPageState(state: AnnotatePageState): void {
    mount()
    mode = state.mode
    if (!mode) setHover(null)

    const incoming = state.annotations
    const incomingIds = new Set(incoming.map((record) => record.id))
    for (const [id, entry] of markers) {
      if (!incomingIds.has(id)) {
        entry.outline.remove()
        entry.badge.remove()
        markers.delete(id)
        if (cardFor === id) closeCard()
      }
    }
    incoming.forEach((record, index) => {
      const existing = markers.get(record.id)
      if (existing) {
        existing.record = record
        return
      }
      markers.set(record.id, buildMarker(record, index))
    })
    resolveAll()

    // markers are numbered by position in the (createdAt-ordered) list
    let position = 0
    for (const entry of markers.values()) {
      position += 1
      entry.badge.textContent = String(position)
    }

    const strings = deps.strings()
    layer.dir = strings.dir
    hint.textContent = strings.hint
    hint.style.display = mode ? 'block' : 'none'
    if (cardFor !== null) {
      // refresh the open card's texts without losing the in-progress note
      cardNote.placeholder = strings.notePlaceholder
      cardDelete.textContent = strings.delete
      cardAsk.textContent = strings.askAi
    }
    if (pendingCardId !== null) openCardFor(pendingCardId)
    positionCard()
  }

  return {
    setPageState,
    openCardFor,
    destroy: () => {
      if (noteTimer !== null) clearTimeout(noteTimer)
      noteTimer = null
      observer.disconnect()
      doc.removeEventListener('pointerover', onOver, capture)
      doc.removeEventListener('mouseover', onOver, capture)
      doc.removeEventListener('scroll', onScroll, capture)
      win?.removeEventListener('resize', onResize)
      for (const type of [
        'pointerdown',
        'pointerup',
        'mousedown',
        'mouseup',
        'auxclick',
        'contextmenu',
        'wheel',
      ] as const) {
        win?.removeEventListener(type, onPlainIntercept, captureIntercept)
      }
      win?.removeEventListener('click', onClick, captureIntercept)
      for (const type of ['keydown', 'keypress', 'keyup'] as const) {
        win?.removeEventListener(type, onKey, captureIntercept)
      }
      host.remove()
    },
  }
}

// ── the shadow stylesheet ──────────────────────────────────────────────────

const OVERLAY_CSS = `
.anno-layer {
  all: initial;
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  display: block;
  direction: ltr;
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  font-size: 12px;
  line-height: 1.4;
  color: ${ANNOTATE_COLORS.text};
}
.anno-hover {
  display: none;
  position: fixed;
  pointer-events: none;
  border: 2px solid ${ANNOTATE_COLORS.hover};
  border-radius: 3px;
  background: ${ANNOTATE_COLORS.hoverFill};
  box-sizing: border-box;
}
.anno-hover-tag {
  display: none;
  position: fixed;
  pointer-events: none;
  max-width: 480px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 2px 8px;
  border-radius: 4px;
  background: ${ANNOTATE_COLORS.hover};
  color: ${ANNOTATE_COLORS.onAccent};
  font-weight: 600;
}
.anno-hint {
  display: none;
  position: fixed;
  left: 50%;
  bottom: 18px;
  transform: translateX(-50%);
  pointer-events: none;
  padding: 6px 14px;
  border-radius: 999px;
  background: ${ANNOTATE_COLORS.hintBg};
  color: ${ANNOTATE_COLORS.hintText};
}
.anno-marker {
  display: block;
  position: fixed;
  pointer-events: none;
  border: 2px dashed ${ANNOTATE_COLORS.marker};
  border-radius: 3px;
  box-sizing: border-box;
}
.anno-badge {
  display: flex;
  position: fixed;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  background: ${ANNOTATE_COLORS.marker};
  color: ${ANNOTATE_COLORS.onAccent};
  font-weight: 700;
  cursor: pointer;
  pointer-events: auto;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
}
.anno-card {
  display: none;
  position: fixed;
  width: 300px;
  pointer-events: auto;
  box-sizing: border-box;
  padding: 10px;
  border-radius: 10px;
  border: 1px solid ${ANNOTATE_COLORS.cardBorder};
  background: ${ANNOTATE_COLORS.cardBg};
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
}
.anno-card-snippet {
  margin: 0 0 8px;
  max-height: 54px;
  overflow: hidden;
  color: ${ANNOTATE_COLORS.text};
}
.anno-card-note {
  display: block;
  width: 100%;
  box-sizing: border-box;
  margin: 0 0 8px;
  padding: 6px 8px;
  border: 1px solid ${ANNOTATE_COLORS.cardBorder};
  border-radius: 6px;
  background: ${ANNOTATE_COLORS.noteBg};
  color: ${ANNOTATE_COLORS.text};
  font: inherit;
  resize: vertical;
}
.anno-card-note:focus {
  outline: none;
  border-color: ${ANNOTATE_COLORS.marker};
}
.anno-card-delete,
.anno-card-ask {
  border: none;
  border-radius: 6px;
  padding: 5px 12px;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.anno-card-delete {
  background: transparent;
  color: ${ANNOTATE_COLORS.danger};
}
.anno-card-delete:hover {
  background: ${ANNOTATE_COLORS.dangerSoft};
}
.anno-card-ask {
  background: ${ANNOTATE_COLORS.hover};
  color: ${ANNOTATE_COLORS.onAccent};
}
.anno-card-ask:hover {
  background: ${ANNOTATE_COLORS.hoverStrong};
}
`
