import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, nativeTheme, screen } from 'electron'
import type { Rectangle } from 'electron'
import { TabManager } from './tab-manager'
import { installShellCloseGuard } from './window-close-guard'
import {
  installShellWindowBoundsPersistence,
  readShellWindowState,
  SHELL_WINDOW_DEFAULT_HEIGHT,
  SHELL_WINDOW_DEFAULT_WIDTH,
  SHELL_WINDOW_MIN_HEIGHT,
  SHELL_WINDOW_MIN_WIDTH,
} from './window-bounds'
import { tabStripOverlay } from './title-bar-overlay'
import { shellWindowBackground } from './window-background'
import {
  attachPinnedWidgetsToShell,
  createDetachedEditorWindow,
  detachPinnedWidgetsFromShell,
  detachedFilePaths,
  detachedOpenDocuments,
  detachedSetFileFor,
  detachedSetTitleFor,
  detachedWindowForWebContents,
  dockBandFor,
  focusPinnedWidget,
  focusedDetachedKind,
  isTearingOff,
  setDockHost,
  setPinsHostSurfaceActive,
} from './detached-windows'
import {
  projectFileRenamed,
  recordRecentFile,
  replaceRecentFile,
  setBrowserShellHooks,
  BROWSER_CHANNELS,
  browserNavigate,
  setDocsFileOpenedHook,
  setDocsFileSavedHook,
  setDocsHostWindowHook,
  setDocsMenuGate,
  setDocsShellHooks,
  setDocsShellWindow,
  setHtmlFileSavedHook,
  setHtmlPresentHooks,
  setHtmlProvisionalTitleHook,
  setMarkdownDocxExportedHook,
  setMarkdownFileSavedHook,
  setPdfRedactionSavedHook,
  setPdfRenamedHook,
  setSheetsCloseTabHook,
  setSheetsHostWindowHook,
  setSheetsShellWindow,
  setSheetsWorkbookOpenedHook,
  setSlidesCloseTabHook,
  setSlidesHostWindowHook,
  setSlidesOpenedHook,
  setSlidesShellWindow,
  setSlidesShowBleed,
  setHtmlDocxExportPrepareHook,
  setHtmlDocxExportedHook,
} from './app-registry'
import { readDesktopPins } from './desktop-ipc'
import { readAiDock } from './ai-dock'
import { readDockPrefs } from './dock-prefs'
import { createAiDrawerOverlay } from './ai-drawer-view'
import { createDockOverlay } from './dock-overlay-view'
import {
  collectHomeTabsState,
  createHomeTabsBroadcaster,
  installHomeTabsPush,
  tabsChangedDualSend,
  type HomeTabsPush,
} from './home-tabs-ipc'
import { HOME_CHANNELS } from '../shared/home-api'
import { TABS_CHANNELS } from '../shared/tabs-api'
import type { TabKind } from '../shared/tabs-api'

/**
 * The shell window's lifecycle: creation (bounds restore, the TabManager and
 * every per-app registry hook it wires), reveal, and the detach/pin/tear-off
 * family that moves tabs between the shell and their own windows. Extracted
 * from index.ts; the shell window and tab manager singletons stay owned by
 * index.ts and arrive through `deps` (get/set), because dozens of index.ts
 * call sites read them.
 */

export interface ShellWindowDeps {
  appSettingsPath: () => string
  userDataDir: () => string
  /** the interface scale the tab strip and the Windows caption band are sized from */
  uiScale: () => number
  /**
   * The dock's live item count (the cloud launcher joins the seven
   * always-there items once the account is signed in — the state the
   * cached open-target report holds): the overlay's rect is cut from it on
   * every layout pass.
   */
  dockItemCount: () => number
  tabSleepEnabled: () => boolean
  /** the localized untitled-title for a fresh tab of that kind (registry keys resolve in index) */
  untitledTitle: (kind: TabKind) => string
  /** install the application menu the active tab kind asks for */
  applyMenuFor: (kind: TabKind) => void
  getTabManager: () => TabManager | null
  setTabManager: (manager: TabManager | null) => void
  getShellWindow: () => BrowserWindow | null
  setShellWindow: (win: BrowserWindow | null) => void
  /** the shell window's own closed handler: singletons and dock host teardown */
  onShellWindowClosed: (win: BrowserWindow, manager: TabManager) => void
  onTabsClosed: (tab: { kind: TabKind; filePath: string }) => void
  publishOpenDocumentsIfOwner: (paths: readonly string[]) => void
  broadcastChromePressed: () => void
  refreshTitleBarOverlay: () => void
  /** a tab's file first hit disk: move a folder-bound fresh file into its folder */
  applyPendingDir: (wcId: number, filePath: string) => string
  openDocumentPath: (filePath: string) => boolean
  openGeneratedDocument: (filePath: string) => boolean
  /** consume the dock slot the strip reported for the current dock preview */
  takeLastDockIndex: () => number | undefined
  sendToShellRenderer: (channel: string, payload?: unknown) => void
}

export function createShellWindow(deps: ShellWindowDeps): void {
  // Last session's geometry, when a display can still show it (issue #2049).
  // A saved position on an unplugged monitor falls back to the default
  // placement rather than opening where it cannot be grabbed.
  const restored = readShellWindowState(
    deps.appSettingsPath(),
    screen.getAllDisplays().map((display) => display.workArea),
  )
  const win = new BrowserWindow({
    width: restored?.width ?? SHELL_WINDOW_DEFAULT_WIDTH,
    height: restored?.height ?? SHELL_WINDOW_DEFAULT_HEIGHT,
    // x/y only when a saved position survived validation; omitting them keeps
    // Electron's default placement on a first run
    ...(restored ? { x: restored.x, y: restored.y } : {}),
    minWidth: SHELL_WINDOW_MIN_WIDTH,
    minHeight: SHELL_WINDOW_MIN_HEIGHT,
    title: 'GenOffice',
    // Paint the theme's surface before the renderer's first frame so the window
    // does not flash white in dark mode. nativeTheme.themeSource is already set
    // from the saved theme in app.whenReady, before this window is created.
    // macOS uses vibrancy below, which must stay transparent.
    ...(process.platform === 'darwin'
      ? {}
      : { backgroundColor: shellWindowBackground(nativeTheme.shouldUseDarkColors) }),
    // vibrancy: editor modules punch translucent regions (e.g. the slides
    // thumbnail pane) through to the desktop
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, vibrancy: 'sidebar' as const }
      : {
          // the tab strip is the title bar, as on macOS; the application menu
          // stays registered for its accelerators and opens from the strip's
          // menu button (Alt still reveals the native bar where one exists)
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: tabStripOverlay(nativeTheme.shouldUseDarkColors, deps.uiScale()),
          autoHideMenuBar: true,
        }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  // the stored rectangle is the normal-state one, so a maximized session
  // reopens maximized instead of as a screen-sized ordinary window
  if (restored?.maximized) win.maximize()
  deps.setShellWindow(win)
  nativeTheme.on('updated', deps.refreshTitleBarOverlay)
  win.once('closed', () => nativeTheme.off('updated', deps.refreshTitleBarOverlay))
  // dragging the window by the tab strip's blank (draggable) area produces no
  // DOM event anywhere — will-move is the only signal to dismiss popovers
  win.on('will-move', () => deps.broadcastChromePressed())
  // remember the window's position and size for the next launch (issue #2049)
  installShellWindowBoundsPersistence(deps.appSettingsPath(), win)
  // A detached editor window claims the process-global menu/active-editor targets
  // while focused; take them back when the shell window regains focus. Keyboard
  // focus must land back on the active tab's view too — regaining window focus
  // gives it to the chrome webContents, leaving typing dead in the document.
  win.on('focus', () => {
    deps.getTabManager()?.refreshActiveTargets()
    deps.getTabManager()?.focusActiveView()
  })

  const manager = new TabManager(
    win,
    () => {
      const tabs = manager.list()
      win.webContents.send(TABS_CHANNELS.changed, tabs)
      // the drawer's overlay panel copy listens on this same channel (its
      // document binding re-derives from tab changes): without its own copy
      // a doc opened mid-drawer never re-claims, and the panel keeps showing
      // the previous document's thread
      const overlayWc = manager.drawerOverlayWebContents()
      if (overlayWc && !overlayWc.isDestroyed()) overlayWc.send(TABS_CHANNELS.changed, tabs)
      pushHomeTabs.push()
      deps.publishOpenDocumentsIfOwner([...manager.openFilePaths(), ...detachedFilePaths()])
      // the pinned widgets layer over the Home desktop: another tab covering
      // it hides them until Home is active again
      setPinsHostSurfaceActive(manager.list().some((t) => t.active && t.kind === 'home'))
    },
    deps.applyMenuFor,
    deps.untitledTitle,
    // the tab strip is interface chrome, so its height follows the scale
    deps.uiScale,
    // the AI drawer rides app-settings.json's `aiDock` (renderer-owned writes);
    // the layout re-reads it each pass, so a change lands on the next layout
    () => readAiDock(deps.appSettingsPath()),
    // the dock's own prefs ride `dockPrefs` the same way: the icon size and
    // the magnification strength re-cut the doc-mode overlay's rect from
    // every sync, so a settings write re-fits the view on the next layout
    () => readDockPrefs(deps.appSettingsPath()),
    // the dock's live composition: the logged-in cloud launcher widens the
    // pill by one item, and the overlay's rect follows it every pass
    deps.dockItemCount,
  )
  // The desktop's tab strip renders in the Home layer, so it gets the tab
  // state pushed (docs dirtiness resolved, detached editors flagged) instead
  // of watching the shell-renderer strip channel: on every TabManager change,
  // and forced once per load so a fresh (or reloaded) renderer starts with
  // the full list even when nothing changed since.
  const pushHomeTabs: HomeTabsPush = createHomeTabsBroadcaster({
    collect: () => collectHomeTabsState(manager, detachedOpenDocuments),
    // dual-target: the Home strip in the shell renderer, and the drawer
    // overlay's panel copy — the doc-bound thread claim follows the tab
    // pushes, so a document opened while the drawer stays open switches the
    // panel's conversation to it (tabsChangedDualSend's contract)
    send: tabsChangedDualSend(deps.sendToShellRenderer, () => manager.drawerOverlayWebContents()),
  })
  installHomeTabsPush(pushHomeTabs)
  win.webContents.on('did-finish-load', () => pushHomeTabs.push(true))
  manager.setClosedListener((closed) => deps.onTabsClosed(closed))
  // W2: the AI drawer's native overlay — while a document tab is active, the
  // HTML drawer cannot paint above the document's WebContentsView, so the
  // manager drives this sibling view (the ask panel's standalone mount, and
  // the floating pet itself while the drawer is collapsed) from the same
  // layout/activation passes that fit the document under it. The view's
  // lifetime is the window's own: it is created lazily on the first
  // document-mode moment and dies with the shell like every tab view. The
  // focus verb is injected for the overlay's hide and pet-only shrink paths
  // (P1-3): the composer inside it held the keyboard, and a hidden — or
  // pet-sized — view would keep it. The pet drag needs no wiring here: its
  // surface requests ride the home:ai-pet-drag channel and its commit is the
  // renderer's ordinary aiDock write.
  manager.setDrawerOverlay(
    createAiDrawerOverlay(win, { focusActiveView: () => manager.focusActiveView() }),
  )
  // the doc-mode dock overlay — the 3px hot strip at the window's bottom
  // edge that grows into the standalone fisheye dock over a covering
  // document. Created beside the drawer's overlay and synced BEFORE it in
  // every layout pass (the TabManager's order), so the drawer's panel and
  // pet stay above the dock reveal. Its renderer reports over
  // home:dock-hot-edge; its routed clicks ride home:dock-action.
  manager.setDockOverlay(createDockOverlay(win))
  deps.setTabManager(manager)
  const stopSleepSweeper = manager.startSleepSweeper(deps.tabSleepEnabled)
  win.once('closed', stopSleepSweeper)
  // the push this window installed stops with it; a recreated shell window installs its own
  win.once('closed', () => installHomeTabsPush(null))

  // Docking: a detached window dragged over this window's tab strip hands its
  // document back. The strip reports the insertion slot for each preview
  // (lastDockIndex); the slot is consumed by the dock that follows.
  setDockHost({
    band: () => dockBandFor(win, deps.uiScale()),
    preview: (x) => {
      if (!win.isDestroyed())
        win.webContents.send(TABS_CHANNELS.dockPreview, x === null ? null : { x })
    },
    dock: (tab) => {
      const index = deps.takeLastDockIndex()
      if (!win.isDestroyed()) win.webContents.send(TABS_CHANNELS.dockPreview, null)
      manager.attachTab(tab, index)
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    },
  })
  // the pinned widgets re-parent to this window so they keep stacking above
  // the desktop they decorate (the shell can be recreated around them)
  attachPinnedWidgetsToShell(win)
  // and they must not be destroyed with it when it closes — their documents
  // outlive the shell like any detached editor's
  win.on('close', () => detachPinnedWidgetsFromShell(win))

  wireEditorHooks(win, manager, deps)
}

/**
 * Every registry hook that points the six editor apps' save/open/present
 * plumbing at this window and its tab manager. A detached docs/sheets window
 * can outlive the shell window, so the hooks reach through `deps` for the
 * live manager rather than this closure's.
 */
function wireEditorHooks(win: BrowserWindow, manager: TabManager, deps: ShellWindowDeps): void {
  // pushRecent-triggered docs menu rebuilds must not clobber the active tab's
  // menu; a focused detached docs window owns the menu just like an active tab
  setDocsMenuGate(
    () =>
      focusedDetachedKind() === 'docs' || manager.list().some((t) => t.active && t.kind === 'docs'),
  )

  setDocsShellWindow(win)
  setSheetsShellWindow(win)
  setDocsHostWindowHook((wc) => detachedWindowForWebContents(wc.id))
  setSheetsHostWindowHook((wc) => detachedWindowForWebContents(wc.id))
  setSlidesShellWindow(win)
  setSlidesHostWindowHook((wc) => detachedWindowForWebContents(wc.id))
  setSlidesShowBleed((wc, on) => manager.setContentBleed(wc, on))
  setHtmlPresentHooks({
    setBleed: (wc, on) => manager.setContentBleed(wc, on),
    hostWindow: (wc) => detachedWindowForWebContents(wc.id) ?? win,
    openTab: (owner, title) => {
      manager.openHtmlPresentTab(owner, title)
      return true
    },
    closeTab: (wc) => {
      const id = manager.tabIdForWebContents(wc.id)
      if (id) void manager.closeTab(id)
      return !!id
    },
  })
  // A detached docs/sheets window can outlive the shell window; its hooks must
  // then reach the live tab manager (recreating the shell), never this closure's.
  setDocsShellHooks({
    openTab: (openPath, options) => ensureTabManager(deps).openDocsTab(openPath, options),
    openAiDocTab: (content) =>
      ensureTabManager(deps).openDocsTab(undefined, { newBlank: true, aiContent: content }),
    listTabs: () =>
      (deps.getTabManager()?.list() ?? [])
        .filter((t) => t.kind === 'docs')
        .map((t) => ({ id: t.id, title: t.title, focused: t.active })),
    focusTab: (id) => deps.getTabManager()?.activateTab(id),
    // ⌘W in a detached docs window closes that window (its own close guard runs)
    closeActiveTab: () => {
      const focused = BrowserWindow.getFocusedWindow()
      if (focused && focused !== win) focused.close()
      else deps.getTabManager()?.closeActiveTab()
    },
    openGeneratedPath: (path) => deps.openGeneratedDocument(path),
  })
  setSheetsCloseTabHook(() => {
    const focused = BrowserWindow.getFocusedWindow()
    if (focused && focused !== win) focused.close()
    else deps.getTabManager()?.closeActiveTab()
  })
  // ⌘W targets the focused window: in a detached slides editor window it closes
  // that window (running its own close guard), not the shell's active tab
  setSlidesCloseTabHook(() => {
    const focused = BrowserWindow.getFocusedWindow()
    if (focused && focused !== win) focused.close()
    else manager.closeActiveTab()
  })
  // When ⌘O opens a file inside a tab, sync the tab title/path (used for de-dup by path) and record it as recent.
  // The first save / save-as fires this too, so applyPendingDir also runs here.
  setSheetsWorkbookOpenedHook((wc, path) => {
    manager.setTabFileFor(wc.id, path)
    detachedSetFileFor(wc.id, path)
    recordRecentFile(path)
  })
  setSlidesOpenedHook((wc, path) => {
    manager.setTabFileFor(wc.id, path)
    detachedSetFileFor(wc.id, path)
    recordRecentFile(path)
    deps.applyPendingDir(wc.id, path)
  })
  // docs' save-as / silent first save lands on a new path → sync the tab title too
  setDocsFileSavedHook((wc, path) => {
    manager.setTabFileFor(wc.id, path)
    detachedSetFileFor(wc.id, path)
    recordRecentFile(path)
    return deps.applyPendingDir(wc.id, path)
  })
  // ⌘O / open-path inside a docs tab: sync the tab title immediately, same
  // contract as the sheets/slides opened hooks (a plain save to the original
  // path never renames the tab, so the open must — r115)
  setDocsFileOpenedHook((wcId, path) => {
    manager.setTabFileFor(wcId, path)
    detachedSetFileFor(wcId, path)
    recordRecentFile(path)
    deps.applyPendingDir(wcId, path)
  })
  // markdown untitled first save / Save As lands on a new path
  setMarkdownFileSavedHook((wc, path) => {
    manager.setTabFileFor(wc.id, path)
    detachedSetFileFor(wc.id, path)
    recordRecentFile(path)
    deps.applyPendingDir(wc.id, path)
  })
  setHtmlFileSavedHook((wc, path) => {
    manager.setTabFileFor(wc.id, path)
    detachedSetFileFor(wc.id, path)
    recordRecentFile(path)
    deps.applyPendingDir(wc.id, path)
  })
  setHtmlProvisionalTitleHook((wc, title) => {
    manager.setTabTitleFor(wc.id, title)
    detachedSetTitleFor(wc.id, title)
  })
  // ── the browser app's shell hooks ────────────────────────────────────────
  // The browser manages its own two views (the chrome view the TabManager
  // hosts, plus the page view the descriptor's syncView anchors beside it in
  // the same window's contentView); this is the whole remaining shell
  // cooperation it needs, wired through the AppDescriptor registry's
  // re-exports — no home-api surface of its own.
  setBrowserShellHooks({
    // target=_blank from a page: a new browser tab joins the strip (the
    // desktop's embedded tab strip gains a row) and loads the URL
    openTab: (url) => {
      const tabManager = ensureTabManager(deps)
      const id = tabManager.openBrowserTab()
      const wc = tabManager.webContentsForTab(id)
      if (url && wc) browserNavigate(wc, url)
    },
    // a page's title landed: sync the shell tab and any detached entry
    setTabTitle: (wc, title) => {
      manager.setTabTitleFor(wc.id, title)
      detachedSetTitleFor(wc.id, title)
    },
    // a page's favicon landed: the strip entry carries it (detached entries
    // do not render favicons)
    setTabFavicon: (wc, faviconUrl) => {
      manager.setTabFaviconFor(wc.id, faviconUrl)
    },
    // Ctrl/Cmd+K inside a web page summons the palette like every shell surface
    summonPalette: () => {
      if (deps.getTabManager()) deps.getTabManager()!.summonPalette()
      else manager.summonPalette()
    },
    // "Ask AI" on a browser annotation: the dock lives in this window's
    // renderer (the chrome cannot reach window.aiOffice across webContents),
    // so the event rides the browser:ask-about channel to it. The dock treats
    // the payload as a parked question draft with attachment context — the
    // person sends it with an explicit Enter, like a web-supplied deep link.
    askAbout: (payload) => {
      deps.sendToShellRenderer(BROWSER_CHANNELS.askAbout, payload)
    },
    // the Chrome-side-panel inset: while the AI drawer floats over the shell
    // window (a browser tab active, expanded, nothing presenting), the
    // browser's page views narrow by the drawer's window-px width and the
    // drawer fills the freed strip instead of covering content. Only pages
    // hosted in THIS window inset — a detached browser window carries no
    // drawer — and every other state (Home active, collapsed, suppressed)
    // answers 0 through the manager's own predicate. Read per layout, so a
    // drawer toggle re-runs the pages' bounds through the same
    // layout() → syncView → layoutPage pass the resize rides
    drawerInsetRight: (host) => {
      const win = deps.getShellWindow()
      if (!win || win.isDestroyed() || host !== win) return 0
      return (deps.getTabManager() ?? manager).browserDrawerInset()
    },
  })
  // A redacted copy becomes this tab's document; the source still exists.
  setPdfRedactionSavedHook((wc, path) => {
    manager.setTabFileFor(wc.id, path)
    detachedSetFileFor(wc.id, path)
    recordRecentFile(path)
    deps.applyPendingDir(wc.id, path)
  })
  // pdf content-derived auto-rename: the file moved on disk, follow it everywhere
  setPdfRenamedHook((wc, oldPath, newPath) => {
    manager.setTabFileFor(wc.id, newPath)
    detachedSetFileFor(wc.id, newPath)
    replaceRecentFile(oldPath, newPath)
    projectFileRenamed(oldPath, newPath)
  })
  // markdown "convert & open in Docs" → route the fresh .docx to a docs tab
  setMarkdownDocxExportedHook((path) => {
    deps.openDocumentPath(path)
  })
  // Word export to a path already open in a docs tab: close that tab before the file is
  // written (its unsaved-changes prompt applies, and a later save of the stale document
  // could otherwise overwrite the export); a cancelled close aborts the export.
  setHtmlDocxExportPrepareHook(async (path) => {
    const stale = manager.findDocsTabByPath(path)
    if (!stale) return true
    const active = manager.list().find((t) => t.active)?.id
    await manager.closeTab(stale)
    if (active && active !== stale) manager.activateTab(active)
    return !manager.findDocsTabByPath(path)
  })
  setHtmlDocxExportedHook((path) => {
    deps.openDocumentPath(path)
  })

  // Closing the whole window walks every dirty sheets/pdf/slides/docs tab through
  // the same save/don't-save/cancel prompt; any cancel aborts the close. An
  // all-clean close is left untouched, so ⌘Q keeps quitting the app.
  installShellCloseGuard(win, manager)

  win.on('closed', () => deps.onShellWindowClosed(win, manager))

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** the shell's tab manager, recreating the shell window when a detached editor outlived it */
export function ensureTabManager(deps: ShellWindowDeps): TabManager {
  if (!deps.getTabManager()) createShellWindow(deps)
  const manager = deps.getTabManager()
  if (!manager) throw new Error('the shell window could not be created')
  return manager
}

// show() does not un-minimize, and on macOS ⌘W destroys the shell window while the
// app keeps running — either way a file opened from Finder would land out of sight.
export function revealShellWindow(deps: ShellWindowDeps): void {
  if (!deps.getShellWindow()) createShellWindow(deps)
  const win = deps.getShellWindow()
  if (win?.isMinimized()) win.restore()
  win?.show()
  win?.focus()
}

/** "Open in New Window": reparent the tab's live view into a detached editor
 *  window — the document moves as-is, unsaved edits included. */
export function detachTabToWindow(deps: ShellWindowDeps, id: string): void {
  const tabManager = deps.getTabManager()
  if (!tabManager) return
  const record = tabManager.detachTab(id)
  if (!record) return
  const win = createDetachedEditorWindow({ ...record, applyMenuFor: deps.applyMenuFor })
  win.focus()
}

/**
 * "Pin to Desktop": the tab's live view moves into a borderless widget window
 * floating over the Home desktop (unsaved edits included — nothing reloads).
 * The shell then lands on the desktop so the widget is visible where it was
 * placed; a document already pinned shows its widget instead of a second one.
 */
export function pinTabToDesktop(deps: ShellWindowDeps, id: string, bounds?: Rectangle): void {
  const tabManager = deps.getTabManager()
  if (!tabManager) return
  const tab = tabManager.list().find((t) => t.id === id)
  if (tab?.filePath && focusPinnedWidget(tab.filePath)) return
  const record = tabManager.detachTab(id)
  if (!record) return
  const shellWindow = deps.getShellWindow()
  if (!shellWindow) {
    // no shell to pin over (it closed): fall back to an ordinary window
    createDetachedEditorWindow({ ...record, applyMenuFor: deps.applyMenuFor }).focus()
    return
  }
  createDetachedEditorWindow({
    ...record,
    applyMenuFor: deps.applyMenuFor,
    pin: { parent: shellWindow, ...(bounds ? { bounds } : {}) },
  })
  tabManager.openHomeTab()
  deps.sendToShellRenderer(HOME_CHANNELS.showDesktop)
}

/**
 * Restore last session's pinned widgets: reopen each document (its saved file
 * — anything unsaved was prompted for at quit, like any detached window) and
 * pin it back at its saved rect. Missing files are skipped; the pin store's
 * own normalization caps and validates what is read.
 */
export function restoreDesktopPins(deps: ShellWindowDeps): void {
  const tabManager = deps.getTabManager()
  if (!tabManager) return
  for (const pin of readDesktopPins(deps.userDataDir())) {
    if (!existsSync(pin.filePath)) continue
    deps.openDocumentPath(pin.filePath)
    const tab = tabManager.findTabByPath(pin.filePath)
    if (!tab || !tabManager.canDetachTab(tab.id)) continue
    pinTabToDesktop(deps, tab.id, pin.bounds)
  }
}

/** Tear-off: the tab leaves the strip for a window created under the held
 *  pointer at (x, y); the strip keeps steering it until release. */
export function tearOffTabToWindow(
  deps: ShellWindowDeps,
  id: string,
  x: number,
  y: number,
): boolean {
  const tabManager = deps.getTabManager()
  if (!tabManager || isTearingOff() || !tabManager.canDetachTab(id)) return false
  const record = tabManager.detachTab(id)
  if (!record) return false
  createDetachedEditorWindow({ ...record, applyMenuFor: deps.applyMenuFor, tearOffAt: { x, y } })
  return true
}
