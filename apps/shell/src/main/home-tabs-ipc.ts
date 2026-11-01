import { ipcMain } from 'electron'
import type { Rectangle, WebContents } from 'electron'

import { HOME_CHANNELS } from '../shared/home-api'
import type {
  AiPetDragReport,
  DockHotEdgeReport,
  DockNavIntent,
  HomeTabsState,
} from '../shared/home-api'
import type { OpenDocumentTab } from '../shared/tabs-api'
import { normalizeAiDock } from '../shared/desktop-geometry'
import { normalizeForwardedAskQuery, type PendingAskQuery } from '../shared/ask-forward'
import { readAiDock, AI_DOCK_KEY } from './ai-dock'
import { writeAppSetting } from './app-settings'
import type { TabManager } from './tab-manager'

/**
 * The Home workbench's main-process side: the desktop (the Home renderer, the
 * window's persistent base layer) renders the tab strip, the content stage and
 * the docked AI panel itself, so the shell serves its state and actions over
 * IPC instead. The strip's entries include the documents living in their own
 * windows, flagged `detached`, so one list covers everything the person has
 * open.
 */

/** the push interface the shell window installs; `force` re-sends a deduped state */
export interface HomeTabsPush {
  push(force?: boolean): void
}

/**
 * Trigger the installed push — the TabManager's own changes go through its
 * onChanged callback, but detached editor windows open, close and refocus
 * outside it, and their entries ride the same payload.
 */
export function notifyHomeTabsChanged(): void {
  livePush?.push()
}

/** install the push of the live shell window; null tears it down (window closed) */
export function installHomeTabsPush(push: HomeTabsPush | null): void {
  livePush = push
}

let livePush: HomeTabsPush | null = null

/**
 * Collect the pushed state: the shell's tabs with dirtiness resolved (docs
 * needs a renderer round-trip), then the detached editors flagged as their own
 * windows, with the shell's active tab id on top.
 */
export async function collectHomeTabsState(
  manager: TabManager,
  listDetached: () => Promise<OpenDocumentTab[]>,
): Promise<HomeTabsState> {
  const tabs = (await manager.listWithDirty()).map((tab) => ({
    id: tab.id,
    kind: tab.kind,
    title: tab.title,
    ...(tab.faviconUrl ? { faviconUrl: tab.faviconUrl } : {}),
    active: tab.active,
    dirty: tab.dirty ?? false,
    detached: false,
  }))
  const detached = (await listDetached()).map((doc) => ({
    id: doc.id,
    kind: doc.kind,
    title: doc.title,
    active: doc.active,
    dirty: doc.dirty,
    detached: true,
  }))
  return { tabs: [...tabs, ...detached], activeId: manager.activeTabId() }
}

/**
 * The push pipeline around collect + send. Two guards keep the renderer's
 * subscription cheap:
 *
 * - latest-wins: only the newest push's snapshot may land, so a slow dirty
 *   round-trip cannot overwrite the state a later change already superseded
 *   (they also resolve out of order)
 * - dedup: a snapshot byte-identical to the last sent one is skipped —
 *   activate/deactivate pairs and title churn collapse to what the renderer
 *   already holds. `force` (a load finished: the renderer just lost its copy
 *   while the state did not change) resets the baseline instead of merely
 *   bypassing it, so a concurrent push landing after it still sends
 */
export function createHomeTabsBroadcaster(deps: {
  collect: () => Promise<HomeTabsState>
  send: (state: HomeTabsState) => void
}): HomeTabsPush {
  let seq = 0
  let lastSent: string | null = null
  return {
    push(force = false) {
      const mine = ++seq
      if (force) lastSent = null
      void deps
        .collect()
        .then((state) => {
          if (mine !== seq) return
          const serialized = JSON.stringify(state)
          if (serialized === lastSent) return
          lastSent = serialized
          deps.send(state)
        })
        .catch(() => {
          // a collect torn down mid-round-trip (window closed) has nothing
          // left to send; the next change pushes again
        })
    },
  }
}

export interface HomeTabsIpcDeps {
  getTabManager: () => TabManager | null
  /** detached editor windows in the open-documents shape (ids are `detached:<n>`) */
  listDetached: () => Promise<OpenDocumentTab[]>
  /** whether the id names a live detached editor window */
  isDetachedTab: (id: string) => boolean
  /** bring a detached editor's window forward; false when the id names none */
  activateDetachedTab: (id: string) => boolean
  /** close a detached editor through its window's own close guard; false when the id names none */
  closeDetachedTab: (id: string) => boolean
}

/**
 * The strip's two actions. Ids are validated the way every tab channel is
 * (non-empty string), then routed by where the tab lives: a shell id switches
 * or closes the shell's tab (the close runs the same unsaved-changes guard as
 * every other close), a `detached:` id brings its window forward or closes it
 * the way its own close button would.
 */
export function registerHomeTabsIpc(deps: HomeTabsIpcDeps): void {
  ipcMain.handle(HOME_CHANNELS.tabsActivate, (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) return
    if (deps.isDetachedTab(id)) deps.activateDetachedTab(id)
    else deps.getTabManager()?.activateTab(id)
  })
  ipcMain.handle(HOME_CHANNELS.tabsClose, (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) return
    if (deps.isDetachedTab(id)) {
      deps.closeDetachedTab(id)
      return
    }
    return deps.getTabManager()?.closeTab(id)
  })
}

export interface HomeWorkbenchIpcDeps {
  appSettingsPath: () => string
  getTabManager: () => TabManager | null
  /** the shell window's live content area, for clamping a reported stage rect
   *  inside the window; a degenerate answer ({0,0}) skips the clamp */
  contentBounds: () => { width: number; height: number }
  /**
   * Route one validated ask-intent handoff to the drawer's live surface
   * (P0-2): the native overlay's panel copy while a document tab is active
   * (main's own truth decides — the renderer's view of the active tab can lag
   * a switch), else back to the shell renderer's own panel. Injected because
   * the routing needs the live window/tab state only index.ts holds.
   */
  forwardAskQuery: (query: PendingAskQuery) => void
  /**
   * Route a browser annotation's ask handoff to the overlay's panel copy only
   * (P0-2): the shell renderer already received the original
   * `browser:ask-about` push, so there is nothing to bounce for this one.
   */
  forwardBrowserAskAbout: (note: unknown) => void
  /**
   * Route the panel copy's ready ping (P0-2 delivery) to the overlay:
   * `sender` is the webContents `home:ask-panel-ready` arrived from, and the
   * overlay itself decides by identity whether that is its own live view
   * before flushing anything buffered for it. Injected because only the
   * TabManager (through index.ts) holds the overlay.
   */
  markDrawerOverlayReadyFor: (sender: WebContents) => void
  /**
   * Route a pet-drag surface report (`home:ai-pet-drag`) to the overlay: the
   * sender-identity check and the pet-only mode gate both live there, so a
   * report from any other renderer — or any other state — is a no-op before
   * the view changes. Injected like the ready ping, for the same reason.
   */
  applyDrawerOverlayPetDrag: (sender: WebContents, report: AiPetDragReport) => void
  /**
   * Route the doc-mode dock overlay's hot-edge report to the overlay: the
   * sender identity check and the strip/dock state machine both live there,
   * so a report from any other renderer is a no-op before anything moves.
   */
  reportDockHotEdge: (sender: WebContents, report: DockHotEdgeReport) => void
  /**
   * Route one validated doc-mode dock action: main activates the Home tab and
   * delivers the intent to Home over `home:dock-nav` (the ordering is the
   * wiring's business — the intent first, then the tab rise, the same beat
   * the dock-open write uses). Injected because only index.ts holds the
   * window and the tab manager.
   */
  dockNavAction: (intent: DockNavIntent) => void
  /**
   * Take the dock-nav intent buffered for Home's mount-time pull: answers (and
   * clears) the intent routed while Home's `home:dock-nav` subscription was
   * not yet armed — null when nothing is pending. Injected because the buffer
   * lives where the routing does (index.ts).
   */
  takeDockNavPending: () => DockNavIntent | null
}

/** a reported content-stage rect, whole-pixel and inside the window; null on anything malformed */
function asStageRect(value: unknown): Rectangle | null {
  if (!value || typeof value !== 'object') return null
  const r = value as Partial<Rectangle>
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    const n = r[key]
    if (typeof n !== 'number' || !Number.isFinite(n)) return null
  }
  const rect = {
    x: Math.round(r.x!),
    y: Math.round(r.y!),
    width: Math.round(r.width!),
    height: Math.round(r.height!),
  }
  if (rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0) return null
  return rect
}

/**
 * A pet-drag surface report, whole: an object carrying at least one of the
 * `start`/`end` flags, each a boolean when present. Null on anything else —
 * a dropped report costs the gesture nothing (the surface stays as the last
 * good one), and a report that says nothing is not routed at all. The report
 * carries no coordinates: the drag's math is entirely renderer-side, on the
 * window-wide surface `start` hosts.
 */
function asPetDragReport(value: unknown): AiPetDragReport | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<{ start: unknown; end: unknown }>
  if (raw.start !== undefined && typeof raw.start !== 'boolean') return null
  if (raw.end !== undefined && typeof raw.end !== 'boolean') return null
  const start = raw.start === true
  const end = raw.end === true
  if (!start && !end) return null
  return { ...(start ? { start: true } : {}), ...(end ? { end: true } : {}) }
}

/**
 * A hot-edge report, whole: an object carrying at least one of the
 * `enter`/`leave` flags, each a boolean when present. Null on anything else
 * — the state machine must never move on a half-parsed report.
 */
function asDockHotEdgeReport(value: unknown): DockHotEdgeReport | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<{ enter: unknown; leave: unknown }>
  if (raw.enter !== undefined && typeof raw.enter !== 'boolean') return null
  if (raw.leave !== undefined && typeof raw.leave !== 'boolean') return null
  const enter = raw.enter === true
  const leave = raw.leave === true
  if (!enter && !leave) return null
  return { ...(enter ? { enter: true } : {}), ...(leave ? { leave: true } : {}) }
}

/** the nav views a dock action may name */
const DOCK_NAV_VIEWS = ['desktop', 'recent', 'starred'] as const
/** the settings sections a dock action may open */
const DOCK_SETTINGS_SECTIONS = ['general', 'plugins'] as const

/**
 * A dock action, whole: the discriminated intent the doc-mode dock's items
 * send. Null on anything else — the routing must never guess a kind from a
 * malformed payload.
 */
function asDockNavIntent(value: unknown): DockNavIntent | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<{ kind: unknown; view: unknown; section: unknown }>
  if (raw.kind === 'nav') {
    if (typeof raw.view !== 'string') return null
    if (!(DOCK_NAV_VIEWS as readonly string[]).includes(raw.view)) return null
    return { kind: 'nav', view: raw.view as (typeof DOCK_NAV_VIEWS)[number] }
  }
  if (raw.kind === 'settings') {
    if (typeof raw.section !== 'string') return null
    if (!(DOCK_SETTINGS_SECTIONS as readonly string[]).includes(raw.section)) return null
    return { kind: 'settings', section: raw.section as (typeof DOCK_SETTINGS_SECTIONS)[number] }
  }
  if (raw.kind === 'templates') return { kind: 'templates' }
  return null
}

/**
 * Keep a stage rect inside the window's content area: a report that lands
 * mid-resize (or a renderer racing a fullscreen transition) can describe a
 * rect wider or lower than the window actually is, and the tab manager would
 * bound the document view partly outside it. Over-sized dimensions shrink to
 * the window, then the origin clamps so the rect hugs the edge it overshot
 * rather than dangling past it.
 */
function clampStageRect(rect: Rectangle, window: { width: number; height: number }): Rectangle {
  const width = Math.min(rect.width, window.width)
  const height = Math.min(rect.height, window.height)
  if (width <= 0 || height <= 0) return rect
  return {
    x: Math.min(Math.max(rect.x, 0), window.width - width),
    y: Math.min(Math.max(rect.y, 0), window.height - height),
    width,
    height,
  }
}

/**
 * The drawer, stage and ask-forward channels of the workbench contract:
 *
 * - `home:ai-dock-get`/`home:ai-dock-set`: the prefs the renderer's AI
 *   surface persists (app-settings.json `aiDock`: the overlay drawer's width
 *   and open state, the floating pet's position). The set merges the patch
 *   onto the current prefs, normalizes, persists and answers the effective
 *   value; the write also trips the ai-dock watcher, so a layout still on the
 *   fallback geometry re-fits immediately.
 * - `home:content-rect`: the renderer's measured content-stage rect — the
 *   exact area an embedded document's WebContentsView fills (the embedded
 *   strip's height and the sidebar's width live in the renderer's layout, so
 *   measuring beats deriving). Malformed reports are dropped whole; a rect
 *   that overruns the window's current content area is clamped inside it
 *   rather than bounding a document view partly past the window edge.
 * - `home:ask-forward`/`home:browser-ask-about-forward` (P0-2): the
 *   ask-intent handoffs Home forwards while a document tab is active — the
 *   overlay view's panel copy is the only drawer the person can see then.
 *   The handoff is re-validated here (the renderer owns the write path, the
 *   channel is only as trustworthy as any other); the annotation stays raw
 *   because the consuming panel normalizes a page-supplied shape itself, the
 *   same contract the `browser:ask-about` push already carries.
 * - `home:ask-panel-ready` (P0-2 delivery): the overlay view's panel copy
 *   finished booting — its subscriptions (the forwarded asks, the browser
 *   annotations) are armed — so the messages main buffered for that view may
 *   flush. Fire-and-forget like `home:content-rect`; any renderer sharing
 *   the shell preload can send the channel, and the sender's identity,
 *   checked inside the overlay, is what limits the effect to the overlay's
 *   own renderer (another renderer's ping must not arm its flush).
 * - `home:ai-pet-drag`: the overlay's pet-only view reporting its pet drag's
 *   surface transitions — `start` when the gesture begins (main expands the
 *   view to the whole window for its duration: static and window-wide, the
 *   pointer cannot leave it and its client coordinates are its window
 *   position whatever the input device, so the renderer's drag math is exact
 *   for real pointers and synthetic or assistive trajectories alike) and
 *   `end` when it finishes (main re-fits the synced footprint). The report
 *   is validated whole and carries no coordinates; the overlay checks the
 *   sender's identity and, for `start`, the pet-only state before anything
 *   changes. The dragged position persists through the ordinary
 *   `home:ai-dock-set` write, whose watcher re-syncs every copy.
 * - `home:dock-hot-edge`: the doc-mode dock overlay's renderer reporting the
 *   pointer's transitions over its surface — `enter` (from the 3px strip
 *   that is the summon, or from the revealed dock that is the re-enter
 *   cancelling a pending hide) and `leave` (arming the ~250ms grace before
 *   the dock hides back to the strip). Validated whole; the overlay checks
 *   the sender's identity before its state machine moves.
 * - `home:dock-action`: one routed doc-mode dock click (nav view, settings,
 *   templates) — validated whole, then activated-and-delivered by the
 *   injected dep: Home performs the intent over `home:dock-nav` as the Home
 *   tab rises, so the clicked surface is visible. The ask item never rides
 *   this channel; its prefs write is the drawer overlay's own contract.
 * - `home:dock-nav-pending`: Home's mount-time pull of a routed intent that
 *   beat its `home:dock-nav` subscription (the cold-boot race — main routed
 *   the click while the renderer was still loading, and a push nobody is
 *   listening for is lost). The dep answers the buffered intent once and
 *   clears it; null when nothing is pending.
 *
 * Known limitation (accepted): dirtiness is resolved per push, and a
 * document turning dirty or clean all by itself (an edit, an autosave) is not
 * what pushes. The strip's dirty dot therefore lags until the next state
 * change (open/close/activate/title/detach) — real-time re-push was
 * deliberately skipped as not worth the per-keystroke round-trips.
 */
export function registerHomeWorkbenchIpc(deps: HomeWorkbenchIpcDeps): void {
  ipcMain.handle(HOME_CHANNELS.aiDockGet, () => readAiDock(deps.appSettingsPath()))
  ipcMain.handle(HOME_CHANNELS.aiDockSet, (_event, patch: unknown) => {
    const path = deps.appSettingsPath()
    const current = readAiDock(path)
    const p = (patch ?? {}) as Partial<{ width: unknown; collapsed: unknown; petPos: unknown }>
    const next = normalizeAiDock({
      width: typeof p.width === 'number' && Number.isFinite(p.width) ? p.width : current.width,
      collapsed: typeof p.collapsed === 'boolean' ? p.collapsed : current.collapsed,
      // the field's presence adopts the patch — a petPos of null is "back to
      // the corner", not "keep the stored one"; the normalizer discards a
      // malformed value either way
      petPos: Object.hasOwn(p, 'petPos') ? p.petPos : current.petPos,
    })
    writeAppSetting(path, AI_DOCK_KEY, next)
    return next
  })
  ipcMain.on(HOME_CHANNELS.contentRect, (_event, rect: unknown) => {
    const stage = asStageRect(rect)
    if (stage) deps.getTabManager()?.setStageRect(clampStageRect(stage, deps.contentBounds()))
  })
  ipcMain.handle(HOME_CHANNELS.askForward, (_event, raw: unknown) => {
    const query = normalizeForwardedAskQuery(raw)
    if (query) deps.forwardAskQuery(query)
  })
  ipcMain.handle(HOME_CHANNELS.browserAskAboutForward, (_event, raw: unknown) => {
    if (typeof raw === 'object' && raw !== null) deps.forwardBrowserAskAbout(raw)
  })
  ipcMain.on(HOME_CHANNELS.askPanelReady, (event) => {
    deps.markDrawerOverlayReadyFor(event.sender)
  })
  ipcMain.on(HOME_CHANNELS.aiPetDrag, (event, raw: unknown) => {
    const report = asPetDragReport(raw)
    if (report) deps.applyDrawerOverlayPetDrag(event.sender, report)
  })
  ipcMain.on(HOME_CHANNELS.dockHotEdge, (event, raw: unknown) => {
    const report = asDockHotEdgeReport(raw)
    if (report) deps.reportDockHotEdge(event.sender, report)
  })
  ipcMain.handle(HOME_CHANNELS.dockAction, (_event, raw: unknown) => {
    const intent = asDockNavIntent(raw)
    if (intent) deps.dockNavAction(intent)
  })
  ipcMain.handle(HOME_CHANNELS.dockNavPending, () => deps.takeDockNavPending())
}
