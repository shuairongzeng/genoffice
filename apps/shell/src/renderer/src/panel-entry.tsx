import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { HomeApi } from '../../shared/home-api'
import type { PendingAskQuery } from '../../shared/ask-forward'
import {
  AI_DOCK_WIDTH_DEFAULT,
  aiMotionReduced,
  clampPetPos,
  chromeScale,
  DRAWER_MORPH_CLOSE_MS,
  DRAWER_MORPH_OPEN_MS,
  MascotSvg,
  PET_CLICK_SLOP,
  PET_GULP_MS,
  PET_MARGIN,
  PET_SIZE,
  type AiPetPos,
} from './AiDock'
import { useI18n } from './locale'
import { KbAskPanel } from './KbAskPanel'

/**
 * The ask panel's standalone mount: the shell renderer loaded with
 * `?view=ask-panel` renders only the knowledge-base ask panel — no Home, no
 * sidebar, no onboarding. Same trick the manual plays with `?mode=help` (one
 * renderer bundle, one branch), so no second renderer build exists. The
 * native overlay view that hosts the panel above documents (W2 —
 * main/ai-drawer-view.ts) loads this URL, and the same `aiDock` prefs pick
 * which of its two shapes this tree paints: the drawer (the panel plus the
 * pet perched at its foot) or, while collapsed, the pet alone — the drawer's
 * whole reachable presence then, because Home's HTML pet is painted under
 * the document. The panel never unmounts on the flip (hidden while
 * collapsed, the streaming-keeps-streaming contract), so the pet is the
 * collapsed state's only *visible* affordance, never its only listener.
 *
 * The panel's context is self-checked here rather than assumed:
 *
 * - aiOffice — the preload's API face. A view without it (a stale preload, a
 *   wrong window) gets a plain explanation instead of a panel that dies
 *   mid-mount. `panelApiReady` is exported so the check is testable alone.
 * - i18n — the shared boot (main.tsx) awaits the active dictionary before
 *   the first render; a translate that reads a key back as its own text
 *   means that boot never happened for this view.
 * - theme — applied on `<html>` by the same boot (`data-theme`, or the
 *   `prefers-color-scheme` fallback for system), so the panel inherits the
 *   tokens like every other surface; nothing to re-resolve here.
 * - the drawer's prefs — read at mount and followed through
 *   `onAiDockChanged`: the view's own shape already follows them (main sizes
 *   it), and this tree must flip with it, not fight it.
 *
 * This view is the drawer the person sees while a document tab is active, so
 * it carries the pieces that surface cannot: its own transcript id (P0-1 —
 * Home's copy keeps `kb-ask`; sharing it made the two AgentLoops cross-read
 * one transcript), the ask-intent handoffs Home forwards through the main
 * process (P0-2 — a palette/deep-link question asked while this view is the
 * visible drawer lands here with the same pending-query semantics, and the
 * browser annotations routed the same way), the ready signal that releases
 * them (main buffers this view's messages until the panel's listeners are
 * armed — see the handshake in main/ai-drawer-view.ts), and the keyboard's
 * Esc ladder (P1-4): the document owns the keydown below the
 * overlay, so the drawer itself answers Esc — clearing a non-empty draft
 * first, then collapsing through the same `home:ai-dock-set` write the pet
 * makes.
 *
 * The pet ⇄ panel morph plays here too, as the doc-mode approximation: the
 * overlay's native bounds do not animate, so this renderer runs the same
 * keyframes inside the view — the panel scales in from the pet's corner
 * perch on expand and shrinks toward it on collapse (the panel clipping
 * into the bird's footprint as main's own shrink lands, read as being
 * eaten); the pet then gulps, the same satisfied munch.
 *
 * The floating pet is the drawer's whole affordance here: the same bird, the
 * same click-to-toggle contract, and — while collapsed, when the view
 * shrinks to the bird itself — the same drag as Home's pet. A pet-sized
 * renderer cannot capture the pointer (once the cursor leaves the view its
 * events belong to the view below), and a view that *follows* the pointer
 * would make the drag's math depend on the input device: a real pointer's
 * client coordinates shift with the moved view while a synthetic or
 * assistive trajectory's do not, so the displacement is only exact for one
 * of the two. The drag therefore runs on a surface main expands to the
 * whole window for the gesture's duration (home:ai-pet-drag's `start`):
 * static and window-wide, every event's client position IS the pointer's
 * window position for every input model, the pointer cannot leave it (so
 * the release always arrives), and the renderer owns the whole drag — the
 * pet follows the pointer locally and the release persists the spot through
 * the same `aiDock` store write Home's pet makes; `end` re-fits the view.
 */
/**
 * True while the shell renderer was loaded as the panel's standalone view.
 * The search string is a parameter so the routing decision is testable
 * without touching jsdom's location; production reads this window's own.
 */
export function isAskPanelView(search: string = location.search): boolean {
  return new URLSearchParams(search).get('view') === 'ask-panel'
}

/**
 * This mount's transcript id (P0-1). Deliberately not `kb-ask-overlay`, the
 * obvious name: the thread list filters by prefix family (panelThreads), and
 * that id would sit inside Home's `kb-ask-…` family — Home's panel would
 * list the overlay's threads and offer deleting them from a surface that has
 * nothing to do with them. `kb-overlay-ask` is disjoint from `kb-ask` in
 * both directions.
 */
const OVERLAY_CHAT_ID = 'kb-overlay-ask'

/** the aiOffice methods the panel calls while mounting, asking and collapsing */
const REQUIRED_API = [
  'kbList',
  'kbSearch',
  'kbRead',
  'aiStream',
  'aiStreamCancel',
  'onAiStream',
  'aiGetSettings',
  'aiGskStatus',
  'onAiSettingsChanged',
  'setAiDock',
  'onBrowserAskAbout',
] as const satisfies readonly (keyof HomeApi)[]

/** the aiOffice face carries every method the panel needs at mount */
export function panelApiReady(api: Partial<HomeApi> | undefined | null): boolean {
  if (!api) return false
  return REQUIRED_API.every((name) => typeof api[name] === 'function')
}

/** the drawer's prefs as this view knows them: `known` false until the store answers */
interface OverlayDockState {
  known: boolean
  collapsed: boolean
  /** the persisted drawer width (the open morph's fallback denominator) */
  width: number
}

export function AskPanelEntry(): React.JSX.Element | null {
  const { t } = useI18n()
  const apiReady = panelApiReady(window.aiOffice as Partial<HomeApi> | undefined)
  // a missing dictionary translates a key to itself (see strings.ts)
  const stringsReady = t('navAsk') !== 'navAsk'
  // the entry is worth signaling only once it actually renders the panel: an
  // error-state mount (a partial aiOffice face, a dictionary that never
  // loaded) has no listeners, and arming the flush there would drop the
  // buffered messages into a renderer with no panel in it
  const entryReady = apiReady && stringsReady
  // the ask-intent handoffs Home forwards while a document is active (P0-2):
  // main pushes them over home:ask-forwarded and this view consumes them
  // exactly the way Home's own panel consumes a local handoff
  const [pendingQuery, setPendingQuery] = useState<PendingAskQuery | null>(null)
  const [focusSeq, setFocusSeq] = useState(0)
  // the drawer's shape, from the same prefs main sizes the view with —
  // unknown until the store answers (or the channels are absent: the stale
  // preload's fallback below), because this tree must not guess: the view may
  // be pet-sized, and a panel painted into it is garbage pixels over the
  // document, just as a pet painted into a drawer-sized hole is a blank flash
  const [dock, setDock] = useState<OverlayDockState>({
    known: false,
    collapsed: true,
    width: AI_DOCK_WIDTH_DEFAULT,
  })
  useEffect(() => {
    const api = window.aiOffice as Partial<HomeApi> | undefined
    if (typeof api?.getAiDock !== 'function' || typeof api?.onAiDockChanged !== 'function') {
      // a stale preload without the prefs channels: the drawer is the only
      // shape this mount can express (the pet-only one needs them)
      setDock({ known: true, collapsed: false, width: AI_DOCK_WIDTH_DEFAULT })
      return
    }
    void api
      .getAiDock()
      .then((prefs) => setDock({ known: true, collapsed: prefs.collapsed, width: prefs.width }))
      .catch(() => setDock({ known: true, collapsed: false, width: AI_DOCK_WIDTH_DEFAULT }))
    // the broadcast that follows every settled store write (including this
    // view's own pet commits): the tree flips with the view's own shape
    return api.onAiDockChanged((prefs) =>
      setDock({ known: true, collapsed: prefs.collapsed, width: prefs.width }),
    )
  }, [])
  // pet-only and the not-yet-known boot paint nothing but the bird: html and
  // body must drop their backgrounds so the transparent view shows the
  // document straight through (the expanded root paints its own opaque panel)
  useEffect(() => {
    document.documentElement.classList.toggle('ask-panel-pet-only', !dock.known || dock.collapsed)
    return () => document.documentElement.classList.remove('ask-panel-pet-only')
  }, [dock])

  /* ── the pet ⇄ panel morph, the doc-mode approximation ──
   * The overlay's native bounds do not animate (main cuts the view pet-sized
   * or drawer-sized on the write), so this renderer plays the same
   * transformation INSIDE the view: the panel scales in from the pet's
   * corner on expand — the bird perches at the overlay's bottom-right, so
   * the origin is that corner, stable — and on collapse it shrinks toward
   * the corner while main's own shrink lands, the panel clipped into the
   * bird's footprint reading as being eaten. The from-scales are the pet's
   * footprint over the view's own box (the view IS the panel's bounds when
   * expanded), computed per flip; reduced motion skips the whole thing, and
   * the pet's click is gated while a morph runs exactly like Home's. */
  const [panelMorph, setPanelMorph] = useState<'open' | 'close' | null>(null)
  /**
   * The view's own box the last time it was expanded, remembered so the
   * OPEN morph's from-scales can reference the drawer the view is about to
   * become: the optimistic flip fires while the view is still pet-sized
   * (main's resize lands a beat later), so the live innerWidth/innerHeight
   * at that moment would make the from-state the pet's size over ITSELF.
   * While expanded the effect below keeps it fresh; the very first open of
   * a pet-only boot falls back to the prefs' width and the screen's height
   * (a close-enough denominator for a cosmetic scale).
   */
  const expandedViewportRef = useRef<{ width: number; height: number } | null>(null)
  useEffect(() => {
    if (!dock.known || dock.collapsed) return
    /** the view IS the drawer's box right now (never at the open flip
     *  itself — the optimistic state change beats main's resize, and a
     *  pet-sized window must not overwrite the memory) */
    const record = (): void => {
      if (window.innerWidth <= PET_SIZE.width + 80) return
      expandedViewportRef.current = { width: window.innerWidth, height: window.innerHeight }
    }
    record()
    window.addEventListener('resize', record)
    return () => window.removeEventListener('resize', record)
  }, [dock.known, dock.collapsed])
  const [petGulp, setPetGulp] = useState(false)
  const morphBusyRef = useRef(false)
  const morphTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const gulpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevExpandedRef = useRef<boolean | null>(null)
  useEffect(() => {
    if (!dock.known) return
    const expanded = !dock.collapsed
    if (prevExpandedRef.current === expanded) return
    const firstObservation = prevExpandedRef.current === null
    prevExpandedRef.current = expanded
    // the boot's known-answer is the state the view loaded in, not a flip
    if (firstObservation || aiMotionReduced()) return
    const phase = expanded ? 'open' : 'close'
    setPanelMorph(phase)
    morphBusyRef.current = true
    if (morphTimerRef.current) clearTimeout(morphTimerRef.current)
    morphTimerRef.current = setTimeout(
      () => {
        morphTimerRef.current = null
        morphBusyRef.current = false
        setPanelMorph(null)
        if (phase === 'close') {
          setPetGulp(true)
          if (gulpTimerRef.current) clearTimeout(gulpTimerRef.current)
          gulpTimerRef.current = setTimeout(() => {
            gulpTimerRef.current = null
            setPetGulp(false)
          }, PET_GULP_MS)
        }
      },
      (expanded ? DRAWER_MORPH_OPEN_MS : DRAWER_MORPH_CLOSE_MS) + 30,
    )
  }, [dock])
  useEffect(
    () => () => {
      if (morphTimerRef.current) clearTimeout(morphTimerRef.current)
      if (gulpTimerRef.current) clearTimeout(gulpTimerRef.current)
    },
    [],
  )
  // the drawer's docked shape (main pushes the flip when the view fits the
  // docs app's reserved slot instead of the window's right edge): the panel's
  // chrome reads as the app's own panel while docked — flat against the app's
  // layout — and as the floating drawer otherwise. Guarded: a stale preload
  // without the channel keeps the floating look, which is the safe default.
  const [embedded, setEmbedded] = useState(false)
  useEffect(() => {
    const api = window.aiOffice as Partial<HomeApi> | undefined
    return api?.onAskPanelEmbedded?.((next) => setEmbedded(next))
  }, [])
  /* the floating card state (expanded, no host slot): the view is exactly the
   * card's bounds, so the corners read through — html/body stay transparent
   * behind the entry's own surface */
  useEffect(() => {
    document.documentElement.classList.toggle(
      'ask-panel-floating',
      dock.known && !dock.collapsed && !embedded,
    )
    return () => document.documentElement.classList.remove('ask-panel-floating')
  }, [dock.known, dock.collapsed, embedded])

  /* ── the floating panel's header drag ──
   * The pet drag's contract for the expanded card: a card-sized view cannot
   * capture the pointer past its own edge, so past the slop main grows the
   * view window-wide (`home:ask-panel-drag`'s start — honored only while
   * floating: a slotted panel is the app's own layout), the entry re-parks
   * itself under the pointer with the pet drag's absolute formula (exact for
   * real and synthetic input alike, because the surface never moves), and
   * the release persists the spot through the ordinary aiDock write
   * (panelPos) whose watcher re-fits the view around it. The end report
   * shrinks the surface even when the position never changed (the watcher
   * dedups identical writes). */
  const [panelDragBox, setPanelDragBox] = useState<{
    x: number
    y: number
    width: number
    height: number
  } | null>(null)
  const panelDraggingRef = useRef(false)
  const beginPanelDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      // the drag belongs to the floating expanded state: the slotted panel is
      // the app's own layout, and the collapsed state's drag is the pet's own
      if (dock.collapsed || embedded || event.button !== 0 || panelDraggingRef.current) return
      const api = window.aiOffice as Partial<HomeApi> | undefined
      const surface = api?.aiPanelDrag
      const setDock = api?.setAiDock
      // a stale preload without the channel keeps the header inert
      if (typeof surface !== 'function' || typeof setDock !== 'function') return
      panelDraggingRef.current = true
      const scale = chromeScale()
      // the grab point: client px at the press, inside the card-sized view —
      // which is the card's own footprint, so this is the pointer's offset
      // from the card's top-left in window px
      const grab = { x: event.clientX, y: event.clientY }
      const startX = event.clientX
      const startY = event.clientY
      /** the card-sized viewport at the press: the window-wide surface's
       *  arrival is the viewport outgrowing it (or its resize event) */
      const cardFrame = { width: window.innerWidth, height: window.innerHeight }
      /** the card's size in chrome px — panelPos's own space */
      const cardChrome = { width: cardFrame.width / scale, height: cardFrame.height / scale }
      /** the clamped spot the gesture last placed (committed on release) */
      let pos: AiPetPos | null = null
      /** whether the window-wide surface has landed */
      let surfaced = false
      const isCardSized = (): boolean =>
        window.innerWidth <= cardFrame.width + 2 && window.innerHeight <= cardFrame.height + 2
      const onSurface = (): void => {
        surfaced = true
      }
      const onSettle = (): void => {
        // the view shrank back around the card: its own bounds are the spot
        // again, and the entry returns to filling the view — one resize later
        // than the re-fit itself, so the panel never jumps at the hand-off
        if (!isCardSized() || pos === null) return
        window.removeEventListener('resize', onSettle)
        setPanelDragBox(null)
      }
      const finish = (commit: boolean): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onCancel)
        window.removeEventListener('blur', onCancel)
        window.removeEventListener('resize', onSurface)
        document.body.classList.remove('ai-pet-dragging')
        document.documentElement.classList.remove('ask-panel-drag-surface')
        panelDraggingRef.current = false
        if (!commit) {
          // a cancel abandons the gesture: the surface shrinks back with no
          // prefs write, and the entry re-docks to the unchanged view
          setPanelDragBox(null)
          surface({ end: true })
          return
        }
        if (pos === null) return
        surface({ end: true })
        void setDock({ panelPos: pos }).catch(() => undefined)
        window.addEventListener('resize', onSettle)
      }
      const onMove = (ev: PointerEvent): void => {
        if (pos === null) {
          // the slop is measured in the card-sized view's own frame — the
          // surface is only requested once a drag is actually happening
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < PET_CLICK_SLOP) return
          document.body.classList.add('ai-pet-dragging')
          // the window-wide surface must paint nothing but the card
          document.documentElement.classList.add('ask-panel-drag-surface')
          surface({ start: true })
        }
        if (!surfaced && isCardSized()) {
          // the expansion has not landed yet: this move still carries the
          // card-sized view's frame, and using it would offset the card by
          // the view's own origin — the absolute formula re-derives
          // everything once the surface is real, so waiting loses nothing
          return
        }
        surfaced = true
        pos = clampPetPos(
          { x: (ev.clientX - grab.x) / scale, y: (ev.clientY - grab.y) / scale },
          {
            width: window.innerWidth / chromeScale(),
            height: window.innerHeight / chromeScale(),
          },
          cardChrome,
        )
        setPanelDragBox({
          x: Math.round(pos.x * scale),
          y: Math.round(pos.y * scale),
          width: cardFrame.width,
          height: cardFrame.height,
        })
      }
      const onUp = (): void => finish(true)
      const onCancel = (): void => finish(false)
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onCancel)
      window.addEventListener('blur', onCancel)
      // the expansion's arrival IS a resize of this view
      window.addEventListener('resize', onSurface)
    },
    [dock.collapsed, embedded],
  )
  useEffect(() => {
    // optional-chained whole: this view exists to explain a missing aiOffice
    // face, so the subscriptions must tolerate one too
    const api = window.aiOffice as Partial<HomeApi> | undefined
    return api?.onForwardedAskQuery?.((query) => {
      setPendingQuery(query)
      setFocusSeq((n) => n + 1)
    })
  }, [])
  useEffect(() => {
    if (!entryReady || !dock.known) return
    // the ready handshake: main holds the messages routed to this view (the
    // forwarded asks, the browser annotations) until the panel's listeners
    // exist, because a flush at the view's did-finish-load would beat the
    // panel's own subscriptions — the panel entry boots after an await chain
    // (language, theme, dictionary), so "loaded" and "listening" are different
    // moments. React runs child effects before parent ones, so by the time
    // this fires, KbAskPanel's subscriptions are armed; the dependencies keep
    // it from firing out of the error state (no listeners to flush into) or
    // the pre-prefs blank (the panel is not mounted yet). Guarded: a stale
    // preload without the channel keeps the messages buffered, never a crash.
    const api = window.aiOffice as Partial<HomeApi> | undefined
    api?.askPanelReady?.()
  }, [entryReady, dock.known])
  if (!entryReady) {
    return <div className="ask-panel-entry ask-panel-entry-error">{t('panelApiMissing')}</div>
  }
  if (!dock.known) {
    // the store has not answered: a fully transparent blank (the html class
    // above holds the backgrounds off) — neither a panel in a pet-sized view
    // nor a pet floating in a drawer-shaped hole
    return null
  }
  /** the panel's × and the Esc ladder's last rung: the same collapse write
   *  the pet's click makes (the optimistic flip, the store round trip) */
  const collapseOverlayDrawer = (): void => {
    const api = window.aiOffice as Partial<HomeApi>
    if (typeof api.setAiDock === 'function') {
      void api.setAiDock({ collapsed: true }).catch(() => undefined)
    }
  }
  const toggle = (): void => {
    // mid-morph toggles are ignored (the same stutter rule Home's pet keeps)
    if (morphBusyRef.current) return
    // the write goes through the same `home:ai-dock-set` contract Home's pet
    // writes, so the main process's overlay (watchAiDock → layout) and every
    // other copy of the prefs follow it; the local flip is the optimistic
    // half, confirmed by the broadcast the write triggers. A failed write
    // rolls the optimistic half back — guarded, because a broadcast may have
    // landed in the meantime and whatever it says is the truth, not this
    // gesture's stale intent
    const next = !dock.collapsed
    setDock((d) => ({ ...d, collapsed: next }))
    const api = window.aiOffice as Partial<HomeApi>
    if (typeof api.setAiDock === 'function') {
      void api
        .setAiDock({ collapsed: next })
        .then(() => undefined)
        .catch(() => {
          setDock((d) => (d.collapsed === next ? { ...d, collapsed: !next } : d))
        })
    }
  }
  return (
    <div
      className={`ask-panel-entry${dock.collapsed ? ' ask-panel-pet-only' : ''}${
        embedded && !dock.collapsed ? ' ask-panel-embedded' : ''
      }${panelDragBox ? ' ask-panel-dragging' : ''}`}
      /* mid-drag the view is window-wide (the gesture's surface): the entry
         re-parks itself under the pointer as a free box — its left/top are
         the VIEW's frame (window px, the root is the unzoomed one), its
         width/height the card's box at the press */
      style={
        panelDragBox
          ? {
              inset: 'auto',
              left: panelDragBox.x,
              top: panelDragBox.y,
              width: panelDragBox.width,
              height: panelDragBox.height,
            }
          : undefined
      }
    >
      {/* the panel stays mounted through the flips — closing only hides it,
          the same contract Home's drawer keeps (a streaming answer keeps
          streaming), and the subscriptions it armed are why the ready
          handshake means what it means */}
      <div
        className={`ask-panel-panel${panelMorph ? ` ask-panel-morph-${panelMorph}` : ''}`}
        /* the close morph keeps the panel mounted-and-visible for its own
           shrink (the hidden flip lands with the morph's timer, not the
           broadcast's arrival); the from-scales are the pet's footprint over
           this view's box, set inline the same way Home's panel carries them */
        hidden={dock.collapsed && panelMorph !== 'close'}
        style={
          panelMorph
            ? ({
                transformOrigin: '100% 100%',
                ...morphFromScales(dock, expandedViewportRef.current, chromeScale()),
                '--morph-radius': '120px',
              } as React.CSSProperties)
            : undefined
        }
      >
        <KbAskPanel
          chatId={OVERLAY_CHAT_ID}
          /* the surface context's visibility line: while the drawer floats it
             sits over the active document/browser tab — the person is looking
             at THAT, not the Home desktop — and while the view fits the docs
             app's reserved slot it reads as the app's own docked panel. The
             prop is live (the panel mirrors it into the ref its prompt getter
             reads), so the embedded flip re-words the section mid-session */
          surfaceRole={embedded && !dock.collapsed ? 'docked' : 'overlay'}
          onOpenPath={(path) => void window.aiOffice.openPath(path)}
          /* this view has no list to switch: both CTAs raise the Home tab, where
             the list and the settings live — a section-specific handoff is a
             known simplification, not a promise */
          onGoToRecents={() => void window.aiOffice.tabsActivate('home')}
          onOpenModelSettings={() => void window.aiOffice.openAiModelSettings()}
          onOpenScopeSettings={() => void window.aiOffice.tabsActivate('home')}
          /* a handoff that arrived while the drawer was collapsed is held
             here until the panel is actually visible: parking it into a
             hidden tree parks the draft fine but focuses a display:none
             composer — a silent no-op the person experiences as the
             question never taking the focus. Handed over on the expand
             (the broadcast the handoff's own dock-open write triggered),
             the panel parks AND focuses in a tree that can take it */
          pendingQuery={dock.collapsed ? null : pendingQuery}
          onPendingQueryConsumed={() => setPendingQuery(null)}
          focusSignal={focusSeq}
          onEscapeCollapse={() => collapseOverlayDrawer()}
          onCollapse={collapseOverlayDrawer}
          /* the header is the floating card's grab zone (Home's bubble shares
             the verb): absent while docked into a host app's slot — that
             panel is the app's own layout and does not move */
          onBubbleDragStart={dock.collapsed || embedded ? undefined : beginPanelDrag}
        />
      </div>
      <OverlayPet collapsed={dock.collapsed} gulp={petGulp} onToggle={toggle} />
    </div>
  )
}

/**
 * The overlay view's pet: the drawer's whole presence while collapsed and
 * its collapse control while expanded. The click contract is Home's pet's
 * (a plain click toggles; the trailing click of a real drag is ignored) and
 * so is the collapsed state's drag, with one mechanical difference a
 * pet-sized renderer forces: it cannot capture the pointer itself — once
 * the cursor leaves the view, its moves belong to the view below. The drag
 * therefore runs on a window-wide surface instead (petDragPosition and the
 * module docblock explain the coordinate semantics): `home:ai-pet-drag`'s
 * `start` asks main to expand this very view for the gesture's duration,
 * and on that static surface the release always arrives — the pointer
 * cannot leave it — with the release persisting the spot through the
 * ordinary aiDock write and the `end` report shrinking the surface back.
 */
/**
 * The pet-only pet's dragged position (chrome CSS px) for a pointer at
 * `pointer` (window px — the window-wide surface's client frame) grabbed at
 * `grab` (the press's client px, measured inside the pet's own pet-sized
 * footprint, so it is the pointer's offset from the pet's top-left in window
 * px): the pet sits at pointer − grab, converted to the chrome space petPos
 * lives in and clamped into the window by the shared rule. Pure and exported
 * so the drag's exactness is testable alone: the formula is absolute — no
 * accumulation, no feedback — which is what makes it identical for real
 * pointers and synthetic or assistive trajectories alike.
 *
 * The division by `scale` is the correct direction, verified against this
 * app's Electron build with a live probe: MouseEvent.clientX is viewport px
 * for every input model, AND the pet's inline left/top (chrome px) renders at
 * chrome × scale viewport px. So a pointer moving Δ viewport px must move
 * petPos by Δ/scale chrome px — the pet's ON-SCREEN position tracks the
 * cursor 1:1 (petPos × scale follows Δ exactly) while the stored number
 * stays chrome-space. petPos reading Δ/scale is that conversion, not a lag;
 * removing the division would make the pet overshoot the cursor by ×scale.
 */
export function petDragPosition(
  pointer: { x: number; y: number },
  grab: { x: number; y: number },
  scale: number,
  viewport: { width: number; height: number },
): AiPetPos {
  return clampPetPos(
    { x: (pointer.x - grab.x) / scale, y: (pointer.y - grab.y) / scale },
    viewport,
    PET_SIZE,
  )
}

/**
 * The morph's from-scales for one flip: the pet's footprint over the view's
 * box. Close computes against the live box (the view IS the drawer at that
 * moment); open — the optimistic flip beats main's resize — against the
 * remembered expanded box, else the prefs' width over the screen's height.
 */
function morphFromScales(
  dock: OverlayDockState,
  remembered: { width: number; height: number } | null,
  scale: number,
): { '--morph-sx': number; '--morph-sy': number } {
  const petW = PET_SIZE.width * scale
  const petH = PET_SIZE.height * scale
  if (dock.collapsed) {
    return { '--morph-sx': petW / window.innerWidth, '--morph-sy': petH / window.innerHeight }
  }
  const box = remembered ?? {
    width: dock.width * scale,
    height: (window.screen?.height ?? 800) * scale,
  }
  return { '--morph-sx': petW / box.width, '--morph-sy': petH / box.height }
}

function OverlayPet({
  collapsed,
  gulp,
  onToggle,
}: {
  collapsed: boolean
  /** the close morph landed: the satisfied munch plays on the bird */
  gulp: boolean
  onToggle: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const draggingRef = useRef(false)
  /** true from the slop crossing until the next press: the trailing click of a
   *  finished drag must not toggle the drawer */
  const movedRef = useRef(false)
  /** the gesture's live pet position (chrome CSS px); null when the view's own bounds stand */
  const [dragPos, setDragPos] = useState<AiPetPos | null>(null)

  const beginDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>): void => {
      // the drag belongs to the pet-only state: while expanded the pet is
      // an affordance inside the drawer, not a floating position
      if (!collapsed || event.button !== 0 || draggingRef.current) return
      const api = window.aiOffice as Partial<HomeApi> | undefined
      const surface = api?.aiPetDrag
      const setDock = api?.setAiDock
      // the drag needs the surface channel: without it the pointer leaves the
      // pet-sized view after a few px and the gesture dies — a stale preload
      // keeps the pet click-only instead — and the commit is the ordinary
      // prefs write either way
      if (typeof surface !== 'function' || typeof setDock !== 'function') return
      draggingRef.current = true
      movedRef.current = false
      setDragPos(null)
      const scale = chromeScale()
      // the grab point: client px at the press, inside the pet-sized view —
      // which is the pet's own footprint, so this is the pointer's offset
      // from the pet's top-left in window px
      const grab = { x: event.clientX, y: event.clientY }
      const startX = event.clientX
      const startY = event.clientY
      // the pet-sized viewport at the press: the window-wide surface's
      // arrival is the viewport outgrowing it (or its resize event)
      const petFrame = { width: window.innerWidth, height: window.innerHeight }
      /** the clamped position the gesture last placed (committed on release) */
      let pos: AiPetPos | null = null
      /** whether the window-wide surface has landed */
      let surfaced = false
      const isPetSized = (): boolean =>
        window.innerWidth <= petFrame.width + 2 && window.innerHeight <= petFrame.height + 2
      const viewport = (): { width: number; height: number } => ({
        width: window.innerWidth / chromeScale(),
        height: window.innerHeight / chromeScale(),
      })
      const onSurface = (): void => {
        // the expansion (or any live resize) landing: the pointer's client
        // frame is window-true from here on
        surfaced = true
      }
      const onSettle = (): void => {
        // the view shrank back around the pet: its own bounds are the
        // position again, and the pet returns to the view's origin — one
        // resize later than the shrink itself, so the bird never jumps
        if (!isPetSized() || !pos) return
        window.removeEventListener('resize', onSettle)
        setDragPos(null)
      }
      const finish = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onEscape)
        window.removeEventListener('blur', onEscape)
        window.removeEventListener('pointerout', onOut)
        window.removeEventListener('resize', onSurface)
        document.body.classList.remove('ai-pet-dragging')
        draggingRef.current = false
        if (!movedRef.current) return
        // the surface must not stay window-wide: the end report re-fits it
        // whatever the prefs decide (an unchanged position leaves the store
        // watcher nothing to re-sync), and the position, when the drag moved
        // it, rides the ordinary aiDock write whose watcher re-fits this view
        // and broadcasts every prefs copy — the same commit Home's pet makes.
        // The pet keeps its live position until the view wraps it again (the
        // settle listener above), so the bird does not blink at the hand-off.
        surface({ end: true })
        if (pos) void setDock({ petPos: pos }).catch(() => undefined)
        if (pos) window.addEventListener('resize', onSettle)
      }
      const onMove = (ev: PointerEvent): void => {
        if (!movedRef.current) {
          // the slop is measured in the pet-sized view's own frame — the
          // surface is only requested once a drag is actually happening, so
          // a plain click never grows one
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < PET_CLICK_SLOP) return
          movedRef.current = true
          document.body.classList.add('ai-pet-dragging')
          surface({ start: true })
        }
        if (!surfaced && isPetSized()) {
          // the expansion has not landed yet: this move still carries the
          // pet-sized view's frame, and using it would offset the pet by the
          // view's own origin — the absolute formula below re-derives
          // everything once the surface is real, so waiting loses nothing
          return
        }
        surfaced = true
        pos = petDragPosition({ x: ev.clientX, y: ev.clientY }, grab, scale, viewport())
        setDragPos(pos)
      }
      const onUp = (): void => finish()
      const onEscape = (): void => finish()
      const onOut = (ev: PointerEvent): void => {
        // the pointer left this renderer entirely (no related target): the
        // release will never arrive here — end the gesture where it stands.
        // On the window-wide surface this cannot normally happen; it is the
        // backstop for something shrinking the view under a live drag.
        if (ev.relatedTarget === null) finish()
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onEscape)
      window.addEventListener('blur', onEscape)
      document.addEventListener('pointerout', onOut)
      window.addEventListener('resize', onSurface)
    },
    [collapsed],
  )

  /** keyboard activation arrives without pointer events, so the drag flag resets here */
  const onKeyDown = (): void => {
    movedRef.current = false
  }

  return (
    <button
      type="button"
      className={`ai-pet${!collapsed ? ' pet-hidden' : ''}${gulp ? ' gulp' : ''}`}
      /* collapsed: the view IS the pet's bounds (main sized it around the
         bird), so the pet perches at its own origin — unless a drag is live,
         when it follows the pointer across the window-wide surface; expanded:
         pet-hidden (the panel IS the bird), no perch to style */
      style={
        collapsed
          ? { left: dragPos?.x ?? 0, top: dragPos?.y ?? 0 }
          : { right: PET_MARGIN, bottom: PET_MARGIN }
      }
      aria-label={t(collapsed ? 'dockExpand' : 'dockCollapse')}
      title={t(collapsed ? 'dockExpand' : 'dockCollapse')}
      aria-expanded={!collapsed}
      onPointerDown={beginDrag}
      onClick={() => {
        // the trailing click of a real drag toggles nothing
        if (movedRef.current) return
        onToggle()
      }}
      onKeyDown={onKeyDown}
    >
      <MascotSvg />
    </button>
  )
}
