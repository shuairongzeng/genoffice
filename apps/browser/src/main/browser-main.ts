import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, ipcMain, session, shell, WebContentsView } from 'electron'
import type { Rectangle, WebContents } from 'electron'

import { getUiLang } from '@genoffice/i18n'
import { rendererUrl, safeExternalUrl } from '@genoffice/electron-utils'
import { BROWSER_CHANNELS } from '../shared/ipc'
import type { BrowserPageState, PageAnnotateState } from '../shared/ipc'
import type { BrowserAnnotation, BrowserAskAboutPayload } from '../shared/annotations'
import { annotationStorePath, createAnnotationStore } from './annotation-store'
import type { AnnotationStore } from './annotation-store'
import { resolveAddressInput } from './url-input'
import { decideNavigation, decideWindowOpen, isPaletteSummonChord } from './navigation-policy'
import {
  dedupeDownloadName,
  decidePermissionRequest,
  sanitizeDownloadFilename,
} from './page-session'
import { applyNavigation, applyPageFavicon, applyPageTitle, type TabMetadata } from './tab-metadata'

/**
 * The browser app's main module: the shell-facing face the AppDescriptor
 * dispatches through, plus the per-tab machinery. One browser tab is two
 * nested views —
 *
 * - the **chrome view** (this app's renderer: address bar, back/forward/
 *   reload/stop), created by `createBrowserView` and laid out by the shell's
 *   TabManager like any document tab's view;
 * - the **page view**, a child of the chrome view that the page's webContents
 *   renders into, bounds-synced to the rect the chrome reports for its
 *   content area. Nesting (rather than a sibling view the shell would have to
 *   keep in step) is what lets the page ride along for free when the tab is
 *   moved, hidden, detached or torn off.
 *
 * Pages live in their own `persist:browser` session, so cookies, storage and
 * downloads never mix with the document apps' sessions. That session is
 * policy-armed before the first page view exists: permission requests are
 * denied by default (geolocation, media, notifications, pointer lock, MIDI,
 * clipboard read and write — see page-session.ts for the one grant and the
 * extension point), and downloads are explicit — the `will-download` handler
 * sinks every file under `userData/Downloads/` with a de-duplicated name, so
 * a same-named file is never overwritten and nothing is written outside the
 * suite's own data directory without the person seeing where it went.
 *
 * The page view also carries the **annotation layer's preload** (an
 * isolated-world overlay the chrome's annotate toggle arms): picking-mode
 * hover/click handling plus the persisted markers, all invisible to page
 * scripts. Annotations live in `userData/browser-annotations.json` keyed by
 * the hash-stripped page URL, and the "Ask AI" action on one is relayed to
 * the Home AI dock through the shell hook (`browser:ask-about`).
 */

/** the partition every page view renders in (chrome views use the default session) */
export const BROWSER_PARTITION = 'persist:browser'

interface BrowserRuntime {
  preloadPath: string
  /**
   * The page view's preload (the annotation layer's isolated-world host).
   * Optional: it defaults to `page-annotate.js` beside the chrome preload, so
   * the shell's existing runtime wiring picks it up with no extra plumbing.
   */
  pagePreloadPath?: string
  rendererUrl?: string
  rendererFile?: string
}

let runtime: BrowserRuntime = { preloadPath: '' }

export function configureBrowserRuntime(paths: BrowserRuntime): void {
  runtime = paths
}

/** the preload the page view loads: the chrome preload's sibling by default */
function pageViewPreloadPath(): string {
  if (runtime.pagePreloadPath !== undefined) return runtime.pagePreloadPath
  if (runtime.preloadPath === '') return ''
  return join(dirname(runtime.preloadPath), 'page-annotate.js')
}

/**
 * What the browser module needs the shell for. The shell wires these in
 * window-lifecycle (the AppDescriptor registry is the contract between the
 * two sides — the browser module never imports shell code).
 */
export interface BrowserShellHooks {
  /** open a new browser tab in the shell strip (target=_blank), optionally at a URL */
  openTab: (url?: string) => void
  /** the page's title landed — the shell syncs its strip entry */
  setTabTitle: (shellWc: WebContents, title: string) => void
  /** the page's favicon landed (null: none) — the shell syncs its strip entry */
  setTabFavicon: (shellWc: WebContents, faviconUrl: string | null) => void
  /** Ctrl/Cmd+K pressed inside a page view: the shell's palette summon */
  summonPalette: () => void
  /**
   * "Ask AI" was pressed on an annotation: hand the record to the Home AI
   * dock. The chrome renderer cannot reach `window.aiOffice` (the dock lives
   * in the shell window's webContents, a different renderer), so main relays
   * the event — the shell forwards it on the `browser:ask-about` channel as a
   * question draft with attachment context, park-into-draft style (never
   * auto-sent).
   */
  askAbout: (payload: BrowserAskAboutPayload) => void
}

let hooks: BrowserShellHooks | null = null

export function setBrowserShellHooks(next: BrowserShellHooks | null): void {
  hooks = next
}

/** one open browser tab */
interface BrowserTab {
  /** the chrome view the shell's TabManager hosts (the tab's view) */
  shell: WebContentsView
  /** the page view nested inside the chrome view */
  page: WebContentsView
  metadata: TabMetadata
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** a navigation the policy refused; the chrome explains it until the next one */
  blockedUrl: string | null
  /** the content rect as the chrome reported it (page-view bounds, view-local px) */
  contentRect: Rectangle | null
  /** the first navigation started: the page view shows, the chrome's empty hint hides */
  hasContent: boolean
  /** page bounds saved while HTML fullscreen covers the chrome */
  fullscreenRestore: Rectangle | null
  /** the annotation picker is on for this tab */
  annotateMode: boolean
}

/** open tabs by their chrome view's webContents id (the IPC sender's id) */
const tabs = new Map<number, BrowserTab>()

/** open tabs by their *page* view's webContents id (the page preload's sender id) */
const tabsByPage = new Map<number, BrowserTab>()

// ── the annotation store (userData/browser-annotations.json) ───────────────

let annotationStore: AnnotationStore | null = null

function annotations(): AnnotationStore {
  if (annotationStore === null) {
    annotationStore = createAnnotationStore({
      path: () => annotationStorePath(app.getPath('userData')),
      onWriteError: (error) => console.warn('[browser] annotation store write failed:', error),
    })
  }
  return annotationStore
}

/** the annotate state for what a tab's page is showing right now */
function annotateStateOf(tab: BrowserTab): PageAnnotateState {
  return {
    mode: tab.annotateMode,
    lang: getUiLang(),
    annotations: annotations().listForUrl(tab.page.webContents.getURL()),
  }
}

/** push the annotate state into a tab's page view (its preload owns the layer) */
function pushAnnotateState(tab: BrowserTab): void {
  const wc = tab.page.webContents
  if (wc.isDestroyed()) return
  wc.send(BROWSER_CHANNELS.pageAnnotateState, annotateStateOf(tab))
}

/** push the annotate state into every open page view (a store mutation landed) */
function pushAnnotateStateToAll(): void {
  for (const tab of tabs.values()) pushAnnotateState(tab)
}

// ── state fold ─────────────────────────────────────────────────────────────

function stateOf(tab: BrowserTab): BrowserPageState {
  return {
    url: tab.page.webContents.getURL(),
    title: tab.metadata.title,
    faviconUrl: tab.metadata.faviconUrl,
    loading: tab.loading,
    canGoBack: tab.canGoBack,
    canGoForward: tab.canGoForward,
    blockedUrl: tab.blockedUrl,
    annotateMode: tab.annotateMode,
  }
}

function pushState(tab: BrowserTab): void {
  const wc = tab.shell.webContents
  if (wc.isDestroyed()) return
  wc.send(BROWSER_CHANNELS.stateChanged, stateOf(tab))
}

/** the chrome's content-area report: whole-pixel, positive-size, or ignored */
function asContentRect(rect: unknown): Rectangle | null {
  if (!rect || typeof rect !== 'object') return null
  const r = rect as Partial<Rectangle>
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    const n = r[key]
    if (typeof n !== 'number' || !Number.isFinite(n)) return null
  }
  const out = {
    x: Math.round(r.x!),
    y: Math.round(r.y!),
    width: Math.round(r.width!),
    height: Math.round(r.height!),
  }
  if (out.x < 0 || out.y < 0 || out.width <= 0 || out.height <= 0) return null
  return out
}

/** fit the page view to the chrome's content area (or hold it hidden until content exists) */
function layoutPage(tab: BrowserTab): void {
  if (tab.fullscreenRestore !== null) return
  if (!tab.hasContent || tab.contentRect === null) {
    tab.page.setVisible(false)
    return
  }
  tab.page.setBounds(tab.contentRect)
  tab.page.setVisible(true)
}

// ── the page view ──────────────────────────────────────────────────────────

/** where the session's downloads land, under userData */
const DOWNLOADS_DIR = 'Downloads'

/** the page session's policy, armed once before the first page view */
let pageSessionArmed = false

/**
 * Arm the `persist:browser` session: the deny-by-default permission handler
 * (P1-5) and the explicit download sink. Both are session-wide and the
 * session is a per-process singleton per partition, so once is enough — the
 * guard only keeps repeated tab creation from re-registering.
 */
function armPageSession(): void {
  if (pageSessionArmed) return
  pageSessionArmed = true
  const pageSession = session.fromPartition(BROWSER_PARTITION)
  pageSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(decidePermissionRequest(permission) === 'allow')
  })
  pageSession.on('will-download', (_event, item) => {
    // explicit, not the OS default: the file lands under userData/Downloads,
    // never over a same-named file that is already there
    const dir = join(app.getPath('userData'), DOWNLOADS_DIR)
    try {
      mkdirSync(dir, { recursive: true })
      const name = dedupeDownloadName(
        (candidate) => existsSync(join(dir, candidate)),
        sanitizeDownloadFilename(item.getFilename()),
      )
      item.setSavePath(join(dir, name))
    } catch (error) {
      // a download that cannot be placed is cancelled, not mislaid elsewhere
      item.cancel()
      console.warn('[browser] download could not be placed:', error)
    }
  })
}

function createPageView(): WebContentsView {
  armPageSession()
  const preload = pageViewPreloadPath()
  return new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // the W1 slot, filled: the annotation layer's preload. It is the only
      // trusted code in this renderer — it exposes no context-bridge surface,
      // so the untrusted page cannot call anything it holds; the layer itself
      // lives in the isolated world behind a closed shadow root
      ...(preload === '' ? {} : { preload }),
      partition: BROWSER_PARTITION,
      // webSecurity stays at its default (on): the browser must not weaken
      // Chromium's same-origin guarantees
    },
  })
}

function bindPage(tab: BrowserTab): void {
  const wc = tab.page.webContents
  const shellWc = tab.shell.webContents

  wc.on('did-start-loading', () => {
    tab.loading = true
    pushState(tab)
  })
  wc.on('did-stop-loading', () => {
    tab.loading = false
    pushState(tab)
  })
  wc.on('did-navigate', (_event, url) => {
    tab.hasContent = true
    tab.blockedUrl = null
    tab.canGoBack = wc.navigationHistory.canGoBack()
    tab.canGoForward = wc.navigationHistory.canGoForward()
    tab.metadata = applyNavigation(tab.metadata, url)
    hooks?.setTabTitle(shellWc, tab.metadata.title)
    hooks?.setTabFavicon(shellWc, tab.metadata.faviconUrl)
    layoutPage(tab)
    // the markers follow the page's URL: the previous page's clear, this URL's
    // restore (a selector that no longer resolves stays silently undrawn)
    pushAnnotateState(tab)
    pushState(tab)
  })
  wc.on('did-navigate-in-page', (_event, _url) => {
    tab.canGoBack = wc.navigationHistory.canGoBack()
    tab.canGoForward = wc.navigationHistory.canGoForward()
    // an SPA route move is a page change for the markers: the push re-keys the
    // set (hash moves share the hash-stripped key and keep their markers)
    pushAnnotateState(tab)
    pushState(tab)
  })
  wc.on('page-title-updated', (_event, title) => {
    tab.metadata = applyPageTitle(tab.metadata, title, wc.getURL())
    hooks?.setTabTitle(shellWc, tab.metadata.title)
    pushState(tab)
  })
  wc.on('page-favicon-updated', (_event, favicons) => {
    tab.metadata = applyPageFavicon(tab.metadata, favicons)
    hooks?.setTabFavicon(shellWc, tab.metadata.faviconUrl)
    pushState(tab)
  })
  wc.on('will-navigate', (event, url) => {
    const decision = decideNavigation(url)
    if (decision.action === 'allow') return
    event.preventDefault()
    if (decision.action === 'external') {
      const target = safeExternalUrl(url)
      if (target) void shell.openExternal(target)
      return
    }
    tab.blockedUrl = url
    pushState(tab)
  })
  wc.setWindowOpenHandler(({ url }) => {
    const decision = decideWindowOpen(url)
    if (decision.action === 'tab') {
      hooks?.openTab(url)
      return { action: 'deny' }
    }
    if (decision.action === 'external') {
      const target = safeExternalUrl(url)
      if (target) void shell.openExternal(target)
    }
    return { action: 'deny' }
  })
  // the palette chord stays the shell's everywhere a page renders: the page
  // view is content of the workbench, not an app that could own Ctrl+K
  wc.on('before-input-event', (event, input) => {
    if (!isPaletteSummonChord(input)) return
    event.preventDefault()
    hooks?.summonPalette()
  })
  // HTML fullscreen stays tab-local: the page covers the browser chrome, not
  // the desktop's tab strip (a deliberate wave-1 simplification — the slides
  // show's strip-covering bleed is a document-presentation affordance)
  wc.on('enter-html-full-screen', () => {
    if (tab.fullscreenRestore !== null) return
    const full = tab.shell.getBounds()
    tab.fullscreenRestore = tab.contentRect
    if (full.width > 0 && full.height > 0) {
      tab.page.setBounds(full)
      tab.page.setVisible(true)
    }
  })
  wc.on('leave-html-full-screen', () => {
    tab.fullscreenRestore = null
    layoutPage(tab)
  })
  wc.on('render-process-gone', (_event, details) => {
    console.warn(`[browser] page renderer gone (${details.reason})`)
    tab.loading = false
    pushState(tab)
  })
}

// ── the chrome view (the tab's view) ───────────────────────────────────────

/**
 * Build one browser tab's chrome view with its nested page view. The TabManager
 * parents, bounds and shows this view like any document tab's; the page view
 * is already its child and follows along. No path argument — a browser tab is
 * never opened *from* a file (the html app owns .html files).
 */
export function createBrowserView(): WebContentsView {
  registerBrowserIpc()
  const shellView = new WebContentsView({
    webPreferences: {
      preload: runtime.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  const tab: BrowserTab = {
    shell: shellView,
    page: createPageView(),
    metadata: { title: '', faviconUrl: null },
    loading: false,
    canGoBack: false,
    canGoForward: false,
    blockedUrl: null,
    contentRect: null,
    hasContent: false,
    fullscreenRestore: null,
    annotateMode: false,
  }
  shellView.addChildView(tab.page)
  tab.page.setVisible(false)
  tabs.set(shellView.webContents.id, tab)
  tabsByPage.set(tab.page.webContents.id, tab)
  shellView.webContents.once('destroyed', () => teardownBrowserTab(shellView.webContents))
  bindPage(tab)
  void shellView.webContents.loadURL(rendererUrl(runtime.rendererUrl, 'browser'))
  return shellView
}

/**
 * The close guard: a browser tab holds no unsaved document state, so closing
 * never needs a prompt.
 */
export async function requestBrowserClose(): Promise<boolean> {
  return true
}

/**
 * Tab teardown beyond the chrome view's own webContents.close(): the nested
 * page view is a separate renderer the shell does not know about, so it is
 * removed and closed here, and the tab's tracking dropped.
 */
export function teardownBrowserTab(contents: WebContents): void {
  const tab = tabs.get(contents.id)
  if (!tab) return
  tabs.delete(contents.id)
  tabsByPage.delete(tab.page.webContents.id)
  if (!tab.shell.webContents.isDestroyed()) tab.shell.removeChildView(tab.page)
  if (!tab.page.webContents.isDestroyed()) tab.page.webContents.close()
}

// ── actions the shell can drive from outside IPC (window-lifecycle) ────────

/** load a resolved URL into the tab's page view (target=_blank's new tab) */
export function browserNavigate(contents: WebContents, url: string): void {
  const tab = tabs.get(contents.id)
  if (!tab || tab.page.webContents.isDestroyed()) return
  void tab.page.webContents.loadURL(url)
}

/**
 * The annotations one page URL carries — the W2b browser skill's read side
 * (the dock's read_page tool folds them into its outline). The consumer is
 * defensive about this export's absence; the answer is the store's own
 * normalized records, hash-stripped key matching included.
 */
export function readAnnotationsFor(url: string): BrowserAnnotation[] {
  return [...annotations().listForUrl(url)]
}

// ── IPC: the chrome renderer's controls ────────────────────────────────────

function tabOfSender(sender: WebContents): BrowserTab | undefined {
  return tabs.get(sender.id)
}

let ipcRegistered = false

function registerBrowserIpc(): void {
  if (ipcRegistered) return
  ipcRegistered = true

  ipcMain.handle(BROWSER_CHANNELS.navigate, (e, input: unknown) => {
    const tab = tabOfSender(e.sender)
    const text = typeof input === 'string' ? input : ''
    const { url } = resolveAddressInput(text)
    if (!tab || tab.page.webContents.isDestroyed() || url === '') return { url: '' }
    void tab.page.webContents.loadURL(url)
    return { url }
  })
  ipcMain.on(BROWSER_CHANNELS.goBack, (e) => {
    const wc = tabOfSender(e.sender)?.page.webContents
    if (wc && !wc.isDestroyed() && wc.navigationHistory.canGoBack()) wc.goBack()
  })
  ipcMain.on(BROWSER_CHANNELS.goForward, (e) => {
    const wc = tabOfSender(e.sender)?.page.webContents
    if (wc && !wc.isDestroyed() && wc.navigationHistory.canGoForward()) wc.goForward()
  })
  ipcMain.on(BROWSER_CHANNELS.reload, (e) => {
    const wc = tabOfSender(e.sender)?.page.webContents
    if (wc && !wc.isDestroyed()) wc.reload()
  })
  ipcMain.on(BROWSER_CHANNELS.stop, (e) => {
    const wc = tabOfSender(e.sender)?.page.webContents
    if (wc && !wc.isDestroyed()) wc.stop()
  })
  ipcMain.handle(BROWSER_CHANNELS.getState, (e): BrowserPageState | null => {
    const tab = tabOfSender(e.sender)
    return tab ? stateOf(tab) : null
  })
  ipcMain.on(BROWSER_CHANNELS.contentRect, (e, rect: unknown) => {
    const tab = tabOfSender(e.sender)
    if (!tab) return
    const clean = asContentRect(rect)
    if (clean === null) return
    tab.contentRect = clean
    layoutPage(tab)
  })

  // ── annotations: the chrome's toggle ──────────────────────────────────────

  ipcMain.on(BROWSER_CHANNELS.setAnnotateMode, (e, on: unknown) => {
    const tab = tabOfSender(e.sender)
    if (!tab) return
    tab.annotateMode = on === true
    pushAnnotateState(tab)
    pushState(tab)
  })

  // ── annotations: the page preload's channels ─────────────────────────────
  //
  // Only the page view's trusted preload can originate these (nothing is
  // exposed to the page's main world), but every payload is still validated
  // and clamped at the store — a compromised renderer gets junk dropped, not
  // written.

  /** the sender is a page view's webContents, not the chrome's */
  const tabOfPage = (sender: WebContents): BrowserTab | undefined => tabsByPage.get(sender.id)

  // the initial sync: the preload asks on startup, in case did-navigate's
  // push beat its listener (commit ordering is not guaranteed)
  ipcMain.handle(BROWSER_CHANNELS.pageAnnotateSync, (e): PageAnnotateState | null => {
    const tab = tabOfPage(e.sender)
    return tab ? annotateStateOf(tab) : null
  })

  ipcMain.handle(BROWSER_CHANNELS.pageAnnotatePin, (e, draft: unknown): string => {
    const tab = tabOfPage(e.sender)
    if (!tab || tab.page.webContents.isDestroyed()) return ''
    const record = annotations().add(tab.page.webContents.getURL(), draft)
    if (record === null) return ''
    pushAnnotateStateToAll()
    return record.id
  })

  ipcMain.on(BROWSER_CHANNELS.pageAnnotateNote, (e, payload: unknown) => {
    if (!tabOfPage(e.sender)) return
    const { id, note } =
      payload !== null && typeof payload === 'object'
        ? (payload as { id?: unknown; note?: unknown })
        : {}
    if (typeof id !== 'string' || typeof note !== 'string') return
    if (annotations().setNote(id, note)) pushAnnotateStateToAll()
  })

  ipcMain.on(BROWSER_CHANNELS.pageAnnotateDelete, (e, payload: unknown) => {
    if (!tabOfPage(e.sender)) return
    const id =
      payload !== null && typeof payload === 'object' ? (payload as { id?: unknown }).id : undefined
    if (typeof id !== 'string') return
    if (annotations().remove(id)) pushAnnotateStateToAll()
  })

  ipcMain.on(BROWSER_CHANNELS.pageAnnotateAsk, (e, payload: unknown) => {
    if (!tabOfPage(e.sender)) return
    const id =
      payload !== null && typeof payload === 'object' ? (payload as { id?: unknown }).id : undefined
    if (typeof id !== 'string') return
    const record = annotations().byId(id)
    if (record) hooks?.askAbout(record)
  })

  ipcMain.on(BROWSER_CHANNELS.pageAnnotateExit, (e) => {
    const tab = tabOfPage(e.sender)
    if (!tab || !tab.annotateMode) return
    tab.annotateMode = false
    pushAnnotateState(tab)
    pushState(tab)
  })

  // Language channel shared with the other app modules; removeHandler
  // tolerates duplicate registration (the shell serves the same channel)
  ipcMain.removeHandler(BROWSER_CHANNELS.getLanguage)
  ipcMain.handle(BROWSER_CHANNELS.getLanguage, () => getUiLang())
}

// ── standalone mode (`npm run dev -w @genoffice/browser`) ──────────────────

/**
 * Standalone window: the chrome view hosts the window itself so the page view
 * keeps its nested place. The shell registers 'app:get-theme' for hosted tabs;
 * standalone supplies its own.
 */
export function startBrowserStandalone(): void {
  configureBrowserRuntime({
    preloadPath: join(__dirname, '../preload/index.js'),
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    rendererFile: join(__dirname, '../renderer/index.html'),
  })
  void app.whenReady().then(() => {
    // the shell registers 'app:get-theme' for hosted tabs; standalone supplies its own
    ipcMain.removeHandler(BROWSER_CHANNELS.getTheme)
    ipcMain.handle(BROWSER_CHANNELS.getTheme, () => 'system' as const)
    registerBrowserIpc()
    const win = new BrowserWindow({
      width: 1200,
      height: 850,
      title: 'GenOffice Browser',
    })
    const view = createBrowserView()
    win.contentView = view
    const fit = (): void => {
      const { width, height } = win.getContentBounds()
      view.setBounds({ x: 0, y: 0, width, height })
    }
    win.on('resize', fit)
    fit()
  })
  app.on('window-all-closed', () => app.quit())
}
