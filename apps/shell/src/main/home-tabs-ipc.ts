import { ipcMain } from 'electron'
import type { Rectangle } from 'electron'

import { HOME_CHANNELS } from '../shared/home-api'
import type { HomeTabsState } from '../shared/home-api'
import type { OpenDocumentTab } from '../shared/tabs-api'
import { normalizeAiDock } from '../shared/desktop-geometry'
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
 * The dock and stage channels of the workbench contract:
 *
 * - `home:ai-dock-get`/`home:ai-dock-set`: the prefs the renderer's docked
 *   panel persists (app-settings.json `aiDock`). The set merges the patch onto
 *   the current prefs, normalizes, persists and answers the effective value;
 *   the write also trips the ai-dock watcher, so a layout still on the
 *   fallback geometry re-fits immediately.
 * - `home:content-rect`: the renderer's measured content-stage rect — the
 *   exact area an embedded document's WebContentsView fills (the embedded
 *   strip's height and the sidebar's width live in the renderer's layout, so
 *   measuring beats deriving). Malformed reports are dropped whole; a rect
 *   that overruns the window's current content area is clamped inside it
 *   rather than bounding a document view partly past the window edge.
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
    const p = (patch ?? {}) as Partial<{ width: unknown; collapsed: unknown }>
    const next = normalizeAiDock({
      width: typeof p.width === 'number' && Number.isFinite(p.width) ? p.width : current.width,
      collapsed: typeof p.collapsed === 'boolean' ? p.collapsed : current.collapsed,
    })
    writeAppSetting(path, AI_DOCK_KEY, next)
    return next
  })
  ipcMain.on(HOME_CHANNELS.contentRect, (_event, rect: unknown) => {
    const stage = asStageRect(rect)
    if (stage) deps.getTabManager()?.setStageRect(clampStageRect(stage, deps.contentBounds()))
  })
}
