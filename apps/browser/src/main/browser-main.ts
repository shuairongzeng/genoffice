import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, ipcMain, session, shell, WebContentsView } from 'electron'
import type { Rectangle, WebContents } from 'electron'

import { getUiLang } from '@genoffice/i18n'
import { rendererUrl, safeExternalUrl } from '@genoffice/electron-utils'
import { BROWSER_CHANNELS } from '../shared/ipc'
import type { BrowserPageState, PageAnnotateState } from '../shared/ipc'
import type { BrowserAnnotation, BrowserAskAboutPayload } from '../shared/annotations'
import { normalizeViewportRect } from '../shared/annotations'
import { annotationStorePath, createAnnotationStore } from './annotation-store'
import type { AnnotationStore } from './annotation-store'
import {
  captureRectOf,
  readAnnotationShotFile,
  resolveAnnotationShotPath,
  writeAnnotationShot,
} from './annotation-shots'
import type { AnnotationShotFile } from './annotation-shots'
import { fetchFaviconDataUrl } from './favicon-fetch'
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
 * views —
 *
 * - the **chrome view** (this app's renderer: address bar, back/forward/
 *   reload/stop), created by `createBrowserView` and laid out by the shell's
 *   TabManager like any document tab's view;
 * - the **page view**, a sibling of the chrome view in the host window's
 *   contentView, bounds-synced to the chrome's own bounds plus the rect the
 *   chrome reports for its content area.
 *
 * The page is deliberately NOT a child of the chrome view. Nesting it there
 * composites nowhere on the current Electron/platform combination: the page
 * loads (title, favicon, screenshots all arrive) while the screen stays
 * black — moving the page out onto the window's contentView made it paint
 * immediately. A sibling costs the follow-along the nesting bought for free,
 * so the shell re-anchors it through the AppDescriptor's `syncView` every
 * time it parents, lays out, shows, hides or unpairs the chrome view (and
 * `layoutPage` mirrors the chrome's visibility), and the bounds are window
 * coordinates: `chromeView.getBounds()` plus the reported content-rect
 * offset.
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
 * the hash-stripped page URL, each an evidence pack — CSS selector + XPath +
 * the pin-time element shot under `userData/annotation-shots/` — and the
 * "Ask AI" action on one is relayed to the Home AI dock through the shell
 * hook (`browser:ask-about`).
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
  /** the page view, a sibling of the chrome view in the host window's contentView */
  page: WebContentsView
  /** the window whose contentView currently parents the page view; null while unparented */
  pageHost: BrowserWindow | null
  metadata: TabMetadata
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** a navigation the policy refused; the chrome explains it until the next one */
  blockedUrl: string | null
  /**
   * The content rect as the chrome reported it (chrome-local px). Added to the
   * chrome view's own bounds it is the page view's rect in window coordinates
   * — the page is a sibling of the chrome, not a child, so this offset is what
   * keeps the page under the toolbar instead of over it.
   */
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
      // remove() deletes the record's shot file with the record itself
      userData: () => app.getPath('userData'),
      onShotError: (error) => console.warn('[browser] annotation shot delete failed:', error),
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

/**
 * Fit the page view to the chrome's content area, in window coordinates:
 * chrome bounds plus the reported content-rect offset (or hold it hidden
 * until content exists to draw).
 *
 * The chrome renderer reports the rect in its own CSS pixels. The browser
 * chrome has not opted into `--ui-scale` (no `zoom: var(--ui-scale)` in its
 * styles and no zoomFactor set on its webContents), so CSS px and view px are
 * 1:1 and the report needs no rescaling — the day the chrome opts in, the
 * report must divide by the effective zoom before it can be treated as view
 * px again.
 */
function layoutPage(tab: BrowserTab): void {
  if (tab.fullscreenRestore !== null) return
  if (tab.pageHost === null || !tab.hasContent || tab.contentRect === null) {
    tab.page.setVisible(false)
    return
  }
  const base = tab.shell.getBounds()
  const rect = tab.contentRect
  tab.page.setBounds({
    x: base.x + rect.x,
    y: base.y + rect.y,
    width: rect.width,
    height: rect.height,
  })
  // the page shows exactly while the chrome does: the TabManager hides the
  // chrome view when another tab takes the stage, and the page — a sibling,
  // which nothing hides for it — must not stay painted over that tab
  tab.page.setVisible(tab.shell.getVisible())
}

/** take the page view out of its host window's contentView, if it has one */
function detachPageFromHost(tab: BrowserTab): void {
  const host = tab.pageHost
  if (host === null) return
  tab.pageHost = null
  // the window may already be tearing down with the tab (a close walked here
  // through the chrome's own 'destroyed'); its contentView subtree is gone
  // with it, so there is nothing left to remove the page from
  if (!host.isDestroyed()) host.contentView.removeChildView(tab.page)
}

/**
 * Re-anchor a tab's page view after the shell moved, laid out, showed, hid or
 * unpairs the chrome view. `host` is the window whose contentView should carry
 * the page (null: unparent it — the chrome is leaving a window, and a page
 * left behind would either paint over the shell or die with the window's
 * teardown). The page is appended after the chrome view, so it stacks above
 * it: the chrome's toolbar must never cover the page.
 *
 * The shell reaches this through the AppDescriptor's `syncView` — the same
 * registry contract as `createView`/`teardown` — because only the shell knows
 * when and where it re-hosts a tab view; the browser module never imports
 * shell code.
 */
export function syncBrowserPageView(chrome: WebContents, host: BrowserWindow | null): void {
  const tab = tabs.get(chrome.id)
  if (!tab || tab.page.webContents.isDestroyed()) return
  if (tab.pageHost !== host) {
    detachPageFromHost(tab)
    if (host && !host.isDestroyed()) {
      host.contentView.addChildView(tab.page)
      tab.pageHost = host
    }
  }
  layoutPage(tab)
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
    // the strip renders under `img-src 'self' data:` — a remote favicon URL can
    // never load there, so the main process fetches it and hands over a data
    // URL; until that lands the strip keeps its glyph fallback
    const url = tab.metadata.faviconUrl
    if (url) {
      void fetchFaviconDataUrl(url).then((dataUrl) => {
        if (dataUrl && tab.metadata.faviconUrl === url) {
          hooks?.setTabFavicon(shellWc, dataUrl)
        }
      })
    } else {
      hooks?.setTabFavicon(shellWc, null)
    }
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
  // show's strip-covering bleed is a document-presentation affordance). The
  // chrome view's bounds are window coordinates and the page is its sibling,
  // so the chrome's full rect is exactly the page's fullscreen rect.
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
 * Build one browser tab's chrome view. The TabManager parents, bounds and
 * shows this view like any document tab's; the tab's page view is created
 * alongside it but left unparented and hidden — the shell's `syncView` call
 * (fired by activation) anchors it into the same window's contentView and
 * `layoutPage` keeps it fitted. No path argument — a browser tab is never
 * opened *from* a file (the html app owns .html files).
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
    pageHost: null,
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
 * Tab teardown beyond the chrome view's own webContents.close(): the page view
 * is a separate renderer the shell does not know about, so it is taken out of
 * its host window's contentView and closed here, and the tab's tracking
 * dropped.
 */
export function teardownBrowserTab(contents: WebContents): void {
  const tab = tabs.get(contents.id)
  if (!tab) return
  tabs.delete(contents.id)
  tabsByPage.delete(tab.page.webContents.id)
  detachPageFromHost(tab)
  if (!tab.page.webContents.isDestroyed()) tab.page.webContents.close()
}

// ── actions the shell can drive from outside IPC (window-lifecycle) ────────

/**
 * load a resolved URL into the tab's page view (target=_blank's new tab).
 * Returns the load's commit promise: it resolves when the page finished
 * loading (did-finish-load) and rejects when the load failed
 * (did-fail-load) — the agent's navigate reports that outcome instead of
 * pretending the address alone means the page arrived. A tab with no live
 * page resolves at once.
 */
export function browserNavigate(contents: WebContents, url: string): Promise<void> {
  const tab = tabs.get(contents.id)
  if (!tab || tab.page.webContents.isDestroyed()) return Promise.resolve()
  return tab.page.webContents.loadURL(url)
}

/**
 * The tab's page URL (empty while the tab has no page yet or is gone). The
 * dock's agent tooling reads it through the app-registry's sibling import in
 * the shell (browser-agent.ts) — the chrome webContents is the handle both
 * sides already share.
 */
export function browserTabUrlOf(chrome: WebContents): string {
  const tab = tabs.get(chrome.id)
  return tab && !tab.page.webContents.isDestroyed() ? tab.page.webContents.getURL() : ''
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

/** the shot payload `browser:read_annotation_shot` answers (agent-core's shape) */
export interface BrowserAnnotationShotResult extends AnnotationShotFile {
  /** the annotation the shot belongs to (echoed for the model-facing text) */
  id: string
}

/**
 * One annotation's pin-time element shot, by annotation id — the browser
 * skill's read-only `browser:read_annotation_shot` tool and the Ask AI card's
 * thumbnail both come here. The id whitelist is the store itself: only a
 * *known* record whose `shotPath` is the canonical shots shape resolves, and
 * the resolved path is re-checked to stay inside the shots directory. null
 * for an unknown id, a shotless record, or a missing/corrupt file.
 */
export function readAnnotationShot(id: string): BrowserAnnotationShotResult | null {
  if (typeof id !== 'string' || id.trim() === '') return null
  const record = annotations().byId(id)
  if (record === undefined || record.shotPath === undefined) return null
  const path = resolveAnnotationShotPath(app.getPath('userData'), record.shotPath)
  if (path === null) return null
  const shot = readAnnotationShotFile(path)
  if (shot === null) return null
  return { id: record.id, ...shot }
}

/**
 * Capture one pin's element shot and record it: crop the reported viewport
 * rect out of the page view, write the PNG under the shots directory, and
 * stamp the record's `shotPath`. Fire-and-forget on purpose — the pin itself
 * has already landed, and a capture that fails (hidden view, destroyed
 * renderer, disk error) leaves the record simply without a shot.
 */
async function attachPinShot(
  tab: BrowserTab,
  id: string,
  viewportRect: { x: number; y: number; width: number; height: number },
): Promise<void> {
  const wc = tab.page.webContents
  try {
    if (wc.isDestroyed()) return
    const rect = captureRectOf(viewportRect, wc.getZoomFactor(), tab.page.getBounds())
    if (rect === null) return
    const image = await wc.capturePage(rect)
    if (image.isEmpty()) return
    const shotPath = await writeAnnotationShot(app.getPath('userData'), id, image.toPNG())
    if (annotations().setShotPath(id, shotPath)) pushAnnotateStateToAll()
  } catch (error) {
    console.warn('[browser] annotation shot capture failed:', error)
  }
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
    // the evidence pack's image half: the pin draft's viewport rect (stale on
    // scroll, so consumed immediately) cropped out of the page view. The pin
    // has already landed — a capture that fails just leaves the record
    // shotless, never blocks the pin.
    const viewport =
      draft !== null && typeof draft === 'object'
        ? normalizeViewportRect((draft as { viewportRect?: unknown }).viewportRect)
        : null
    if (viewport !== null) void attachPinShot(tab, record.id, viewport)
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
 * Standalone window: the chrome view is a child of the window's contentView —
 * the same sibling arrangement the shell hosts, with this module playing the
 * shell's syncView part itself on every fit. The shell registers
 * 'app:get-theme' for hosted tabs; standalone supplies its own.
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
    // a child of the contentView, not the contentView itself: the page view is
    // the chrome's sibling in this same contentView (nesting under the chrome
    // does not composite), so the chrome must stay an ordinary child view
    win.contentView.addChildView(view)
    const fit = (): void => {
      const { width, height } = win.getContentBounds()
      view.setBounds({ x: 0, y: 0, width, height })
      syncBrowserPageView(view.webContents, win)
    }
    win.on('resize', fit)
    fit()
    // the window's own webContents is the base layer now (the chrome is its
    // child, not its replacement), and it takes the initial focus: hand it to
    // the chrome so the address bar answers the first keystroke
    view.webContents.focus()
  })
  app.on('window-all-closed', () => app.quit())
}
