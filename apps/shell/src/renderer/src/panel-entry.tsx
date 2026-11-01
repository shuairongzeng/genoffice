import { useEffect, useState } from 'react'
import type { HomeApi } from '../../shared/home-api'
import type { PendingAskQuery } from '../../shared/ask-forward'
import { MascotSvg, PET_MARGIN } from './AiDock'
import { useI18n } from './locale'
import { KbAskPanel } from './KbAskPanel'

/**
 * The ask panel's standalone mount: the shell renderer loaded with
 * `?view=ask-panel` renders only the knowledge-base ask panel — no Home, no
 * sidebar, no onboarding. Same trick the manual plays with `?mode=help` (one
 * renderer bundle, one branch), so no second renderer build exists. The
 * native overlay view that hosts the panel above documents (W2 —
 * main/ai-drawer-view.ts) loads this URL: a WebContentsView over the active
 * document, sized from the `aiDock` width.
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
 * The floating pet remains the overlay's click affordance: the same bird,
 * click-only (the position gesture is Home's — the pet cannot be dragged
 * around a drawer that is itself a native view), writing the same
 * `home:ai-dock-set` contract Home's pet writes. It perches at this view's
 * bottom-right corner: the pet's default window perch lands inside the
 * overlay's footprint, and a pet dragged elsewhere in Home mode stays under
 * the document (the W1 known coverage) — this corner is the one place it can
 * be both visible and clickable in document mode.
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

export function AskPanelEntry(): React.JSX.Element {
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
    if (!entryReady) return
    // the ready handshake: main holds the messages routed to this view (the
    // forwarded asks, the browser annotations) until the panel's listeners
    // exist, because a flush at the view's did-finish-load would beat the
    // panel's own subscriptions — the panel entry boots after an await chain
    // (language, theme, dictionary), so "loaded" and "listening" are different
    // moments. React runs child effects before parent ones, so by the time
    // this fires, KbAskPanel's subscriptions are armed; the dependency keeps
    // it from firing out of the error state, whose mount has no listeners to
    // flush into. Guarded: a stale preload without the channel keeps the
    // messages buffered, never a crash.
    const api = window.aiOffice as Partial<HomeApi> | undefined
    api?.askPanelReady?.()
  }, [entryReady])
  if (!entryReady) {
    return <div className="ask-panel-entry ask-panel-entry-error">{t('panelApiMissing')}</div>
  }
  return (
    <div className="ask-panel-entry">
      <KbAskPanel
        chatId={OVERLAY_CHAT_ID}
        onOpenPath={(path) => void window.aiOffice.openPath(path)}
        /* this view has no list to switch: both CTAs raise the Home tab, where
           the list and the settings live — a section-specific handoff is a
           known simplification, not a promise */
        onGoToRecents={() => void window.aiOffice.tabsActivate('home')}
        onOpenModelSettings={() => void window.aiOffice.openAiModelSettings()}
        onOpenScopeSettings={() => void window.aiOffice.tabsActivate('home')}
        pendingQuery={pendingQuery}
        onPendingQueryConsumed={() => setPendingQuery(null)}
        focusSignal={focusSeq}
        onEscapeCollapse={() => {
          const api = window.aiOffice as Partial<HomeApi>
          if (typeof api.setAiDock === 'function') {
            void api.setAiDock({ collapsed: true }).catch(() => undefined)
          }
        }}
      />
      <OverlayPet />
    </div>
  )
}

/**
 * The overlay view's pet: the collapse control for the drawer this view is.
 * Click-only — no drag, no scrim (those gestures belong to Home's surface;
 * see the module docblock). The write goes through the same
 * `home:ai-dock-set` channel Home's pet uses, so the main process's overlay
 * (watchAiDock → layout) and every other copy of the prefs follow it.
 * `aria-expanded` follows the real drawer state (P1-4) — the shared prefs
 * plus their broadcast — defaulting to expanded, since this view is only on
 * screen while the drawer is open.
 */
function OverlayPet(): React.JSX.Element {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(true)
  useEffect(() => {
    const api = window.aiOffice as Partial<HomeApi> | undefined
    if (typeof api?.getAiDock !== 'function' || typeof api?.onAiDockChanged !== 'function') return
    void api
      .getAiDock()
      .then((prefs) => setExpanded(!prefs.collapsed))
      .catch(() => undefined)
    return api.onAiDockChanged((prefs) => setExpanded(!prefs.collapsed))
  }, [])
  const onCollapse = () => {
    const api = window.aiOffice as Partial<HomeApi>
    if (typeof api.setAiDock === 'function') {
      void api.setAiDock({ collapsed: true }).catch(() => undefined)
    }
  }
  return (
    <button
      type="button"
      className="ai-pet"
      style={{ right: PET_MARGIN, bottom: PET_MARGIN }}
      aria-label={t('dockCollapse')}
      title={t('dockCollapse')}
      aria-expanded={expanded}
      onClick={onCollapse}
    >
      <MascotSvg />
    </button>
  )
}
