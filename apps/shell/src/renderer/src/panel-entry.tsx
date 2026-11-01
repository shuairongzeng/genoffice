import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { HomeApi } from '../../shared/home-api'
import type { PendingAskQuery } from '../../shared/ask-forward'
import {
  clampPetPos,
  chromeScale,
  MascotSvg,
  PET_CLICK_SLOP,
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
  const [dock, setDock] = useState<OverlayDockState>({ known: false, collapsed: true })
  useEffect(() => {
    const api = window.aiOffice as Partial<HomeApi> | undefined
    if (typeof api?.getAiDock !== 'function' || typeof api?.onAiDockChanged !== 'function') {
      // a stale preload without the prefs channels: the drawer is the only
      // shape this mount can express (the pet-only one needs them)
      setDock({ known: true, collapsed: false })
      return
    }
    void api
      .getAiDock()
      .then((prefs) => setDock({ known: true, collapsed: prefs.collapsed }))
      .catch(() => setDock({ known: true, collapsed: false }))
    // the broadcast that follows every settled store write (including this
    // view's own pet commits): the tree flips with the view's own shape
    return api.onAiDockChanged((prefs) => setDock({ known: true, collapsed: prefs.collapsed }))
  }, [])
  // pet-only and the not-yet-known boot paint nothing but the bird: html and
  // body must drop their backgrounds so the transparent view shows the
  // document straight through (the expanded root paints its own opaque panel)
  useEffect(() => {
    document.documentElement.classList.toggle('ask-panel-pet-only', !dock.known || dock.collapsed)
    return () => document.documentElement.classList.remove('ask-panel-pet-only')
  }, [dock])
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
  const toggle = (): void => {
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
    <div className={`ask-panel-entry${dock.collapsed ? ' ask-panel-pet-only' : ''}`}>
      {/* the panel stays mounted through the flips — closing only hides it,
          the same contract Home's drawer keeps (a streaming answer keeps
          streaming), and the subscriptions it armed are why the ready
          handshake means what it means */}
      <div className="ask-panel-panel" hidden={dock.collapsed}>
        <KbAskPanel
          chatId={OVERLAY_CHAT_ID}
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
          onEscapeCollapse={() => {
            const api = window.aiOffice as Partial<HomeApi>
            if (typeof api.setAiDock === 'function') {
              void api.setAiDock({ collapsed: true }).catch(() => undefined)
            }
          }}
        />
      </div>
      <OverlayPet collapsed={dock.collapsed} onToggle={toggle} />
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

function OverlayPet({
  collapsed,
  onToggle,
}: {
  collapsed: boolean
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
      className="ai-pet"
      /* collapsed: the view IS the pet's bounds (main sized it around the
         bird), so the pet perches at its own origin — unless a drag is live,
         when it follows the pointer across the window-wide surface; expanded:
         the foot of the drawer, clear of the composer's send controls */
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
