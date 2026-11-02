import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { app, ipcMain, session, webContents } from 'electron'
import type { NativeImage, WebContents } from 'electron'
import * as browserModule from '../../../browser/src/main/browser-main'
import { resolveAddressInput } from '../../../browser/src/main/url-input'
import {
  BROWSER_CLICK_TOOL,
  BROWSER_FILL_FIELD_TOOL,
  BROWSER_READ_ANNOTATION_SHOT_TOOL,
  BROWSER_READ_PAGE_TOOL,
  BROWSER_SCREENSHOT_TOOL,
  MAX_ANNOTATION_ID_CHARS,
  MAX_FILL_VALUE_CHARS,
  MAX_SELECTOR_CHARS,
  MAX_SHELL_PATH_CHARS,
  MAX_SHELL_TAB_ID_CHARS,
  MAX_SHELL_URL_CHARS,
  SHELL_LIST_TABS_TOOL,
  SHELL_NAVIGATE_TOOL,
  SHELL_OPEN_BROWSER_TOOL,
  SHELL_OPEN_PATH_TOOL,
  SHELL_SWITCH_TAB_TOOL,
  formatPageOutline,
  type BrowserActionResult,
  type BrowserAnnotationShot,
  type BrowserPageAnnotation,
  type BrowserPageRead,
  type BrowserOutlineData,
  type BrowserOutlineElement,
  type BrowserScreenshot,
  type SurfaceTab,
} from '@genoffice/agent-core'

/**
 * Shell-main half of the dock's browser skill (charter workstream W2b). The
 * KbAskPanel's AgentLoop composes browser:* tools whose executor forwards
 * every call here over `browserskill:execute`; this module resolves the
 * *active browser tab*, finds the page webContents behind it, and runs the
 * page-side script (DOM outline read, capturePage screenshot, isolated-world
 * fill/click) against that renderer.
 *
 * Tab → chrome view → page view: the shell's TabManager owns the first hop
 * (a browser tab's view is the app's *chrome* renderer — address bar and
 * controls), and the browser module privately owns the second (the page view
 * sitting beside the chrome view in the host window's contentView). The
 * browser app's files are W2a's turf,
 * so the second hop is rebuilt here from Electron's own signals instead of
 * reaching into it: every page view lives in the `persist:browser` session
 * (the one partition only page views use), and each is created immediately
 * after the chrome view that hosts it — `BrowserPageLinks` watches
 * `web-contents-created` and pairs the two. A pairing that ever goes stale
 * fails closed: the tool answers a structured "page not reachable" error,
 * never a script against the wrong renderer.
 *
 * Reads are free; fill/click change the live page, so they are gated twice:
 * the renderer-side skill marks them risk:'high' and the loop's confirmTool
 * gate (the dock's allow/deny card) stops them before they cross IPC, and
 * this module re-checks each one with its own user-facing confirmation
 * (confirmAction — a native dialog in the shell wiring) before the page is
 * touched. The second gate exists because the first is renderer state.
 *
 * Deps are injected (the tab list, the chrome resolver, the annotation
 * reader) so the routing is unit-testable without Electron, like
 * mcp/app-skill-proxy.ts; index.ts wires the live tab state.
 */

/** the one IPC channel every browser skill tool call rides */
export const BROWSER_SKILL_CHANNEL = 'browserskill:execute'

// ── the W2a annotation contract ─────────────────────────────────────────────

/**
 * Read the annotations W2a's browser side keeps for one page URL. The
 * contract is a main-process `readAnnotationsFor(url)` export on the browser
 * module; it is consumed defensively — a browser build without it (W2a not
 * landed yet) answers the empty list, and a store that throws must not fail
 * the read. This module is the browser app's second import site besides the
 * app-registry (whose re-export table is off-limits this round), so the
 * pairing risk is the bundler's: both import the same resolved file, and
 * electron-vite bundles the graph once.
 */
export function browserAnnotationsFor(url: string): BrowserPageAnnotation[] {
  const reader = (browserModule as { readAnnotationsFor?: (url: string) => unknown })
    .readAnnotationsFor
  if (typeof reader !== 'function') return []
  try {
    return sanitizeAnnotations(reader(url))
  } catch {
    // a broken annotation store costs its annotations, not the page read
    return []
  }
}

/** longest annotation list read_page carries (the outline budget caps it anyway) */
const MAX_ANNOTATIONS = 32
/** per annotation field */
const ANNOTATION_CHARS = 400

/**
 * Keep the well-formed annotations only: the page is untrusted, the store may
 * predate the shape. The evidence pack's fields ride along — id + xpath +
 * hasShot for the model (the shot itself is fetched by id through
 * read_annotation_shot); the stored shotPath is *not* forwarded, so a local
 * path never reaches the model context.
 */
function sanitizeAnnotations(raw: unknown): BrowserPageAnnotation[] {
  if (!Array.isArray(raw)) return []
  const out: BrowserPageAnnotation[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || out.length >= MAX_ANNOTATIONS) continue
    const a = item as Record<string, unknown>
    const field = (key: string): string | undefined =>
      typeof a[key] === 'string' ? (a[key] as string).slice(0, ANNOTATION_CHARS) : undefined
    const id = field('id')
    const selector = field('selector')
    const xpath = field('xpath')
    const textSnippet = field('textSnippet')
    const note = field('note')
    const url = field('url')
    if (selector === undefined && textSnippet === undefined && note === undefined) continue
    out.push({
      ...(id !== undefined ? { id } : {}),
      ...(selector !== undefined ? { selector } : {}),
      ...(xpath !== undefined ? { xpath } : {}),
      ...(textSnippet !== undefined ? { textSnippet } : {}),
      ...(note !== undefined ? { note } : {}),
      ...(url !== undefined ? { url } : {}),
      ...(typeof a.shotPath === 'string' && a.shotPath !== '' ? { hasShot: true } : {}),
    })
  }
  return out
}

// ── the annotation shot contract ────────────────────────────────────────────

/**
 * Read one annotation's pin-time element shot, by id. The contract is a
 * main-process `readAnnotationShot(id)` export on the browser module — the
 * same defensive consumption as `readAnnotationsFor` above: a build without
 * the export answers null, and a reader that throws costs its image, not the
 * tool call. The whitelist (known id, canonical shots path, file inside the
 * shots directory) is enforced browser-side, where the store lives.
 */
export function browserAnnotationShotFor(id: string): BrowserAnnotationShot | null {
  const reader = (browserModule as { readAnnotationShot?: (id: string) => unknown })
    .readAnnotationShot
  if (typeof reader !== 'function') return null
  try {
    return sanitizeShot(reader(id))
  } catch {
    // a broken store or shot file costs the image, not the tool call
    return null
  }
}

/** narrow the browser module's answer: bytes, mime and the PNG's own size */
function sanitizeShot(raw: unknown): BrowserAnnotationShot | null {
  if (raw === null || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  const id = typeof s.id === 'string' ? s.id.slice(0, MAX_ANNOTATION_ID_CHARS) : ''
  const base64 = typeof s.base64 === 'string' ? s.base64 : ''
  const mime = typeof s.mime === 'string' ? s.mime : ''
  const width = typeof s.width === 'number' && Number.isFinite(s.width) ? s.width : 0
  const height = typeof s.height === 'number' && Number.isFinite(s.height) ? s.height : 0
  if (id === '' || base64 === '' || mime === '' || width <= 0 || height <= 0) return null
  return { id, base64, mime, width, height }
}

// ── chrome view ↔ page view pairing ────────────────────────────────────────

/** the shape BrowserPageLinks needs from a webContents (tests pass fakes) */
export interface PageViewLike {
  readonly id: number
  /** the session identity the page-view predicate matches on; absent on fakes of chrome views */
  readonly session?: unknown
}

/**
 * Rebuilds the browser app's private chrome-view → page-view pairing from
 * creation order: a browser tab is created as chrome view then page view,
 * back to back, so each page view (identified by the `persist:browser`
 * session — see `isBrowserPageView`) pairs with the most recently created
 * webContents that is not itself a page view. Pure bookkeeping over ids; the
 * caller prunes dead entries on lookup.
 */
export class BrowserPageLinks {
  private lastNonPageId: number | null = null
  private readonly pageByChrome = new Map<number, number>()
  private readonly chromeByPage = new Map<number, number>()

  constructor(private readonly isPageView: (wc: PageViewLike) => boolean) {}

  observeCreated(wc: PageViewLike): void {
    if (this.isPageView(wc)) {
      const host = this.lastNonPageId
      if (host !== null && host !== wc.id) {
        this.pageByChrome.set(host, wc.id)
        this.chromeByPage.set(wc.id, host)
      }
      return
    }
    this.lastNonPageId = wc.id
  }

  /** the page-view webContents id behind one chrome view's id, while tracked */
  pageOf(chromeId: number): number | undefined {
    return this.pageByChrome.get(chromeId)
  }

  /** drop one side of a pairing (a destroyed renderer) */
  forget(id: number): void {
    const page = this.pageByChrome.get(id)
    if (page !== undefined) {
      this.pageByChrome.delete(id)
      this.chromeByPage.delete(page)
    }
    const chrome = this.chromeByPage.get(id)
    if (chrome !== undefined) {
      this.chromeByPage.delete(id)
      this.pageByChrome.delete(chrome)
    }
  }
}

/**
 * A browser page view: the one partition only the browser's page views render
 * in (`BROWSER_PARTITION` in the browser module — the app's W1 delivery).
 * The session object is per-process singleton per partition, so identity
 * holds.
 */
function isBrowserPageView(wc: PageViewLike): boolean {
  try {
    return wc.session === session.fromPartition('persist:browser')
  } catch {
    // a wc that cannot even be asked is not one of ours
    return false
  }
}

/** the live page webContents behind one chrome view, or undefined when gone */
function pageWcOf(links: BrowserPageLinks, chrome: WebContents): WebContents | undefined {
  if (chrome.isDestroyed()) return undefined
  const pageId = links.pageOf(chrome.id)
  if (pageId === undefined) return undefined
  const wc = webContents.fromId(pageId)
  if (!wc || wc.isDestroyed()) {
    links.forget(pageId)
    return undefined
  }
  return wc
}

// ── the active browser tab ─────────────────────────────────────────────────

/** the tab facts the browser tools route on; shell tabs and detached windows both satisfy it */
export interface BrowserTabLike {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly active: boolean
}

/**
 * The tab the browser READ tools act on: the active tab when it is a browser
 * tab, else the last browser tab in the list. When several tabs share the
 * background there is no activity signal to rank them by, so "newest" is the
 * documented tiebreak — every tool result echoes the page it touched
 * (title + URL), so a wrong guess is visible and correctable by switching
 * tabs.
 *
 * shell:navigate deliberately does NOT use this fallback: navigation must
 * always be visible to the person, so it acts on a strictly active tab
 * ({@link resolveActiveOnlyBrowserTab}) and answers a guiding error when
 * none is.
 */
export function resolveActiveBrowserTab(
  tabs: readonly BrowserTabLike[],
): BrowserTabLike | undefined {
  const browserTabs = tabs.filter((t) => t.kind === 'browser')
  if (browserTabs.length === 0) return undefined
  return browserTabs.find((t) => t.active) ?? browserTabs[browserTabs.length - 1]
}

/**
 * The tab shell:navigate acts on: strictly one the surface marks active — no
 * background-tab fallback. A navigation into a tab nobody is looking at is an
 * invisible mutation, exactly what the ungated grade's defense excludes.
 */
function resolveActiveOnlyBrowserTab(tabs: readonly BrowserTabLike[]): BrowserTabLike | undefined {
  return tabs.find((t) => t.kind === 'browser' && t.active)
}

// ── timeouts ───────────────────────────────────────────────────────────────

const READ_TIMEOUT_MS = 10_000
const ACTION_TIMEOUT_MS = 8_000
const SCREENSHOT_TIMEOUT_MS = 10_000
/** how long shell:navigate waits for the page load to commit before answering a timeout error */
const NAVIGATE_COMMIT_TIMEOUT_MS = 8_000
/** widest screenshot kept (vision models reject much larger, and the base64 bloats the context) */
const SCREENSHOT_MAX_WIDTH = 1280

/** race one page promise against a deadline; a timed-out call keeps running but its answer is dropped */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `${label} timed out after ${Math.round(ms / 1000)}s — the page may be busy or hung; try again, or ask the user to reload it`,
        ),
      )
    }, ms)
    const done = (fn: () => void): void => {
      clearTimeout(timer)
      fn()
    }
    promise.then(
      (value) => done(() => resolve(value)),
      (error) => done(() => reject(error)),
    )
  })
}

// ── the page-side scripts ──────────────────────────────────────────────────

/**
 * The DOM outline script, executed in the page's main world (a read; the
 * world only matters for actions). Returns plain JSON-able data — every
 * budget beyond the in-page safety caps is applied main-side by
 * formatPageOutline, where it is testable. Exported for the jsdom suite that
 * pins the password redaction (the value surface of a password input is a
 * secret in cleartext, so the rule lives in the script itself).
 */
export const READ_PAGE_SCRIPT = `(() => {
  const MAX_BLOCKS = 120, MAX_ELEMENTS = 300, BLOCK_CHARS = 500, EL_CHARS = 160, SELECTOR_CHARS = 200
  const clip = (s, n) => (s.length > n ? s.slice(0, n) + '\\u2026' : s)
  const visible = (el) => {
    try {
      const r = el.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) return false
      const st = getComputedStyle(el)
      return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0'
    } catch (e) { return false }
  }
  const selectorOf = (el) => {
    try {
      if (el.id) {
        const idSel = '#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id)
        if (document.querySelectorAll(idSel).length === 1) return idSel
      }
      const name = el.getAttribute('name')
      if (name) {
        const nameSel = el.tagName.toLowerCase() + '[name=' + JSON.stringify(name) + ']'
        if (document.querySelectorAll(nameSel).length === 1) return nameSel
      }
      const parts = []
      let node = el
      while (node && node.nodeType === 1 && node !== document.documentElement) {
        const parent = node.parentElement
        let part = node.tagName.toLowerCase()
        if (parent) part += ':nth-child(' + (Array.prototype.indexOf.call(parent.children, node) + 1) + ')'
        parts.unshift(part)
        if (parts.join(' > ').length > SELECTOR_CHARS) return parts.join(' > ')
        node = parent
      }
      return parts.join(' > ')
    } catch (e) { return '' }
  }
  const blocks = (document.body ? document.body.innerText : '')
    .split(/\\n{2,}/).map((b) => b.replace(/\\s+/g, ' ').trim()).filter(Boolean)
    .slice(0, MAX_BLOCKS).map((b) => clip(b, BLOCK_CHARS))
  const interactive = document.querySelectorAll(
    'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"], [role="checkbox"]'
  )
  const elements = []
  for (let i = 0; i < interactive.length && elements.length < MAX_ELEMENTS; i++) {
    const el = interactive[i]
    if (!visible(el)) continue
    const selector = selectorOf(el)
    if (!selector) continue
    const tag = el.tagName.toLowerCase()
    const role = el.getAttribute('role') || tag
    // a password field's value is a secret in cleartext: it never reaches the
    // outline in any form — only the placeholder or aria-label describes the
    // field, so the model learns the field exists without its contents
    const inputType = tag === 'input' ? (el.getAttribute('type') || '').toLowerCase() : ''
    const label = (
      inputType === 'password'
        ? el.getAttribute('placeholder') || el.getAttribute('aria-label') || ''
        : el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('title') || ''
    ).replace(/\\s+/g, ' ').trim()
    elements.push({
      selector,
      tag,
      role: role.toLowerCase(),
      text: clip(label, EL_CHARS),
      ...(inputType ? { type: inputType } : {}),
    })
  }
  return { url: location.href, title: document.title, textBlocks: blocks, elements }
})()`

/**
 * The fill/click script, executed in an isolated world (page scripts cannot
 * see or monkeypatch it). The arguments travel as a JSON literal — never
 * string-interpolated — so a selector containing quotes cannot escape the
 * script. Reports structured outcomes instead of throwing wherever the page
 * can be asked a question.
 */
const PAGE_ACTION_WORLD = 42

function pageActionScript(action: 'click' | 'fill', selector: string, value: string): string {
  const args = JSON.stringify({ action, selector, value })
  return `(() => {
  const args = ${args}
  const clip = (s, n) => (s.length > n ? s.slice(0, n) + '\\u2026' : s)
  const describe = (el) => clip((el.innerText || el.getAttribute('aria-label') || el.getAttribute('name') || el.tagName.toLowerCase()).replace(/\\s+/g, ' ').trim() || el.tagName.toLowerCase(), 80)
  const notVisible = (el) => {
    try {
      const r = el.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) return true
      const st = getComputedStyle(el)
      return st.display === 'none' || st.visibility === 'hidden'
    } catch (e) { return false }
  }
  let el
  try { el = document.querySelector(args.selector) } catch (e) {
    return { ok: false, detail: '"' + args.selector + '" is not a valid CSS selector' }
  }
  if (!el) return { ok: false, detail: 'no element matches "' + args.selector + '" — the page may have changed; read the page again and use a selector from the new outline' }
  if (notVisible(el)) return { ok: false, detail: 'the element matching "' + args.selector + '" is not visible (zero size or hidden) — the page may have changed; read the page again' }
  if (el.disabled) return { ok: false, detail: 'the element matching "' + args.selector + '" is disabled' }
  if (args.action === 'click') {
    try { el.scrollIntoView({ block: 'center' }) } catch (e) {}
    el.click()
    return { ok: true, detail: 'clicked ' + describe(el) }
  }
  const setValue = (node, v) => {
    const proto = node.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, v)
  }
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    try { el.focus() } catch (e) {}
    setValue(el, args.value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, detail: 'filled ' + describe(el) + ' with "' + clip(args.value, 80) + '"' }
  }
  if (el.tagName === 'SELECT') {
    el.value = args.value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, detail: 'set ' + describe(el) + ' to "' + clip(args.value, 80) + '"' }
  }
  if (el.isContentEditable) {
    el.textContent = args.value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return { ok: true, detail: 'filled the editable region with "' + clip(args.value, 80) + '"' }
  }
  return { ok: false, detail: 'the element matching "' + args.selector + '" is not a fillable field (input, textarea, select or editable)' }
})()`
}

// ── the shell operator tools (the desktop's own actions) ───────────────────

/**
 * Resolve one agent-supplied address for a page load: the browser's own
 * address-bar rules (a bare domain gets https, a search-shaped input is not a
 * URL), then the agent-only scheme gate — http/https. The address bar itself
 * also accepts file:, but an agent-driven load must not: the model never gets
 * to walk the person's disk through a page view. Throws the model-facing
 * refusal; exported for the tests.
 */
export function resolveAgentUrl(input: string): string {
  const text = input.trim()
  if (text === '') {
    throw new Error('`url` must be a non-empty web address (http/https)')
  }
  if (text.length > MAX_SHELL_URL_CHARS) {
    throw new Error(`\`url\` must be at most ${MAX_SHELL_URL_CHARS} characters`)
  }
  const resolved = resolveAddressInput(text)
  if (resolved.kind === 'search') {
    throw new Error(
      `"${text.slice(0, 80)}" does not look like a web address — pass a url (a bare domain ` +
        "gets https); plain search terms are the person's to type, not the agent's",
    )
  }
  const protocol = (() => {
    try {
      return new URL(resolved.url).protocol
    } catch {
      return ''
    }
  })()
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(
      `agent navigation is web-only (http/https) — "${protocol.replace(':', '')}" addresses are ` +
        'refused; local files open with shell:open_path instead',
    )
  }
  return resolved.url
}

// ── the executors ──────────────────────────────────────────────────────────

/** what the main-process confirmation is asked about before fill/click runs */
export interface BrowserPageActionConfirm {
  tool: string
  action: 'click' | 'fill'
  selector: string
  /** the text fill_field would type ('' for click) */
  value: string
  pageTitle: string
  pageUrl: string
}

/** deps as index.ts wires them; the tests inject fakes */
export interface BrowserAgentDeps {
  /** every open browser tab (shell strip and detached windows); sync or async */
  listBrowserTabs(): Promise<readonly BrowserTabLike[]> | readonly BrowserTabLike[]
  /** the chrome-view webContents behind one tab id (undefined: closed or asleep) */
  webContentsFor(tabId: string): WebContents | undefined
  /** the page webContents behind one chrome view (undefined: untracked or destroyed) */
  pageFor(chrome: WebContents): WebContents | undefined
  /**
   * The main-process gate for the risk:'high' page actions. The dock's
   * confirm card is *renderer* state — anything running in that renderer
   * could skip it — so this process re-checks with its own user-facing
   * confirmation (a native dialog parented to the shell window, wired by
   * index.ts) before the live page is touched. Resolves false (or throws) =
   * the action does not run.
   */
  confirmAction(request: BrowserPageActionConfirm): Promise<boolean>
  /** W2a's annotation reader; absent = the module's own defensive consumption */
  readAnnotations?(url: string): BrowserPageAnnotation[]
  /**
   * W2a's annotation-shot reader (read_annotation_shot); absent = the
   * module's own defensive consumption. Reads the suite's own disk only.
   */
  readAnnotationShot?(id: string): BrowserAnnotationShot | null
  // ── the shell operator tools (all UNGATED: user-instructed, visible,
  // reversible — see the skill's prompt; the URL scheme gate stays) ──
  /** open a browser tab (optionally at a resolved URL) and activate it; answers the tab id */
  openBrowserTab(url?: string): string | Promise<string>
  /** activate one tab by id (shell strip or detached); false when the id names none */
  activateTab(id: string): boolean | Promise<boolean>
  /** every open tab with its url/filePath — the surface context and list_tabs share it */
  listSurfaceTabs(): Promise<readonly SurfaceTab[]> | readonly SurfaceTab[]
  /**
   * The kb:read verdicts for one absolute path: may the agent open it? (the
   * scope roots / recents / stars / index corpus). The open_path tool refuses
   * anything this returns false for — an arbitrary absolute path is not
   * openable just because the model named it. Required on purpose: a wiring
   * without a verdict fails closed.
   */
  pathAllowed(path: string): boolean | Promise<boolean>
  /** open a local file into its app tab; false when nothing opens it */
  openPath(path: string): boolean | Promise<boolean>
}

/** the tab + chrome + page the call resolved to, or a guiding error */
async function resolveTarget(
  deps: BrowserAgentDeps,
): Promise<{ tab: BrowserTabLike; chrome: WebContents; page: WebContents }> {
  const tab = resolveActiveBrowserTab(await deps.listBrowserTabs())
  if (!tab) {
    throw new Error(
      'no browser tab is open — open a web page in the desktop browser first (the Web tile on the desktop, or + in the tab strip), then ask again',
    )
  }
  const chrome = deps.webContentsFor(tab.id)
  if (!chrome || chrome.isDestroyed()) {
    throw new Error(
      `the browser tab "${tab.title || tab.id}" is no longer live — switch to it or reopen the page, then try again`,
    )
  }
  const page = deps.pageFor(chrome)
  if (!page || page.isDestroyed()) {
    throw new Error(
      `the page of browser tab "${tab.title || tab.id}" is not reachable right now — switch to the tab or reload the page, then try again`,
    )
  }
  return { tab, chrome, page }
}

/** the shape READ_PAGE_SCRIPT answers, narrowed from untrusted data */
function sanitizeOutlineData(raw: unknown): BrowserOutlineData {
  const r = (raw ?? {}) as Partial<BrowserOutlineData> & Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((b): b is string => typeof b === 'string') : []
  const elements: BrowserOutlineElement[] = []
  if (Array.isArray(r.elements)) {
    for (const e of r.elements) {
      if (!e || typeof e !== 'object') continue
      const el = e as unknown as Record<string, unknown>
      const selector = str(el.selector)
      if (!selector) continue
      elements.push({
        selector: selector.slice(0, MAX_SELECTOR_CHARS),
        tag: str(el.tag).slice(0, 40) || 'element',
        role: str(el.role).slice(0, 40) || 'element',
        text: str(el.text).slice(0, 400),
        ...(typeof el.type === 'string' ? { type: el.type.slice(0, 40) } : {}),
      })
    }
  }
  return {
    url: str(r.url),
    title: str(r.title),
    textBlocks: list(r.textBlocks),
    elements,
  }
}

async function readPageOf(deps: BrowserAgentDeps, page: WebContents): Promise<BrowserPageRead> {
  let raw: unknown
  try {
    raw = await withTimeout(
      page.executeJavaScript(READ_PAGE_SCRIPT, false),
      READ_TIMEOUT_MS,
      'reading the page',
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`the page did not answer the read: ${message}`, { cause: error })
  }
  const data = sanitizeOutlineData(raw)
  const annotations = deps.readAnnotations
    ? deps.readAnnotations(data.url)
    : browserAnnotationsFor(data.url)
  const { text, truncated } = formatPageOutline(data, annotations)
  return {
    url: data.url,
    title: data.title,
    outline: text,
    annotations,
    ...(truncated ? { truncated: true } : {}),
  }
}

async function screenshotOf(page: WebContents): Promise<BrowserScreenshot> {
  let image: NativeImage
  try {
    image = await withTimeout(page.capturePage(), SCREENSHOT_TIMEOUT_MS, 'capturing the page')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`the page could not be captured: ${message}`, { cause: error })
  }
  if (image.isEmpty()) {
    throw new Error(
      'the page has nothing visible to capture right now (its tab may be hidden or still loading) — switch to the browser tab, then try again',
    )
  }
  // cap the width: the base64 rides the model context, and vision providers
  // reject much larger images anyway; the aspect ratio is kept
  const sized =
    image.getSize().width > SCREENSHOT_MAX_WIDTH
      ? image.resize({ width: SCREENSHOT_MAX_WIDTH })
      : image
  const { width, height } = sized.getSize()
  return {
    url: page.getURL(),
    title: page.getTitle(),
    base64: sized.toPNG().toString('base64'),
    mime: 'image/png',
    width,
    height,
  }
}

async function actOnPage(
  page: WebContents,
  action: 'click' | 'fill',
  selector: string,
  value: string,
): Promise<BrowserActionResult> {
  const code = pageActionScript(action, selector, value)
  // userGesture true: both confirmation gates (the dock's card and this
  // process's dialog) approved this exact action, so the page may treat it as
  // user-initiated (focus, dialogs, navigation)
  let raw: unknown
  try {
    raw = await withTimeout(
      page.executeJavaScriptInIsolatedWorld(PAGE_ACTION_WORLD, [{ code }], true),
      ACTION_TIMEOUT_MS,
      `the page ${action === 'click' ? 'click' : 'fill'}`,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      detail: `the page rejected the ${action}: ${message}`,
    }
  }
  const r = (raw ?? {}) as { ok?: unknown; detail?: unknown }
  if (r.ok === true && typeof r.detail === 'string') {
    return { ok: true, detail: r.detail }
  }
  return {
    ok: false,
    detail:
      typeof r.detail === 'string' ? r.detail : `the page answered the ${action} without a result`,
  }
}

/**
 * One browser skill tool call, routed to the active browser tab's page — or
 * one of the shell operator tools (open_browser / navigate / list_tabs /
 * switch_tab / open_path), which act on the workspace itself and are
 * deliberately ungated (see the skill's prompt for the reasoning). Throws
 * structured, model-facing errors (no tab, unreachable page, timeout, refused
 * scheme); the renderer skill turns them into isError tool results.
 */
export async function executeBrowserSkillAction(
  deps: BrowserAgentDeps,
  tool: string,
  input: Record<string, unknown>,
): Promise<
  | BrowserPageRead
  | BrowserScreenshot
  | BrowserActionResult
  | BrowserAnnotationShot
  | { tabId: string }
  | { tabId: string; url: string }
  | readonly SurfaceTab[]
  | { id: string }
  | { path: string }
> {
  switch (tool) {
    case BROWSER_READ_PAGE_TOOL:
      return readPageOf(deps, (await resolveTarget(deps)).page)
    case BROWSER_SCREENSHOT_TOOL:
      return screenshotOf((await resolveTarget(deps)).page)
    case BROWSER_READ_ANNOTATION_SHOT_TOOL: {
      // a disk read of the suite's own shots directory: no live tab, page or
      // confirmation is involved, so the id validation is the whole gate
      const id = input.id
      if (typeof id !== 'string' || !id.trim()) {
        throw new Error('`id` must be a non-empty string (an annotation id from read_page)')
      }
      if (id.length > MAX_ANNOTATION_ID_CHARS) {
        throw new Error(`\`id\` must be at most ${MAX_ANNOTATION_ID_CHARS} characters`)
      }
      const shot = deps.readAnnotationShot
        ? deps.readAnnotationShot(id)
        : browserAnnotationShotFor(id)
      if (shot === null) {
        throw new Error(
          `no screenshot is on file for annotation ${id} — it was pinned without one, deleted, ` +
            'or the id does not match a read_page annotation line. Re-read the page and use an ' +
            'id from a line marked "screenshot on file", or fall back to browser:screenshot_page',
        )
      }
      return shot
    }
    case BROWSER_FILL_FIELD_TOOL:
    case BROWSER_CLICK_TOOL: {
      const { tab, page } = await resolveTarget(deps)
      const selector = input.selector
      if (typeof selector !== 'string' || !selector.trim()) {
        throw new Error('`selector` must be a non-empty string')
      }
      if (selector.length > MAX_SELECTOR_CHARS) {
        throw new Error(`\`selector\` must be at most ${MAX_SELECTOR_CHARS} characters`)
      }
      const action: 'click' | 'fill' = tool === BROWSER_FILL_FIELD_TOOL ? 'fill' : 'click'
      let value = ''
      if (action === 'fill') {
        const raw = input.value
        if (typeof raw !== 'string') throw new Error('`value` must be a string')
        if (raw.length > MAX_FILL_VALUE_CHARS) {
          throw new Error(`\`value\` must be at most ${MAX_FILL_VALUE_CHARS} characters`)
        }
        value = raw
      }
      // main-process defense in depth (P1-4): the renderer-side confirm card
      // gated this call already, but that card is renderer state — this
      // process asks the person itself, and a denial is a model-facing error
      // (not a silent skip) so the loop takes another approach
      const allowed = await Promise.resolve(
        deps.confirmAction({
          tool,
          action,
          selector,
          value,
          pageTitle: page.getTitle() || tab.title,
          pageUrl: page.getURL(),
        }),
      ).catch(() => false)
      if (!allowed) {
        throw new Error(
          'the desktop declined this page action — do not retry it as-is; say what you intended to do and let the person decide',
        )
      }
      return actOnPage(page, action, selector, value)
    }
    // ── the shell operator tools: UNGATED by design (each is a direct
    // execution of the person's instruction, immediately visible, trivially
    // reversible; the page-content actions above carry the risk grade because
    // they change a page in ways the person cannot see coming). The URL
    // scheme gate still applies, and the ids/paths are validated whole ──
    case SHELL_OPEN_BROWSER_TOOL: {
      const url = input.url
      if (url !== undefined && typeof url !== 'string') {
        throw new Error('`url` must be a string when present')
      }
      const tabId = await deps.openBrowserTab(url === undefined ? undefined : resolveAgentUrl(url))
      return { tabId }
    }
    case SHELL_NAVIGATE_TOOL: {
      const url = input.url
      if (typeof url !== 'string' || !url.trim()) {
        throw new Error('`url` must be a non-empty web address')
      }
      const resolved = resolveAgentUrl(url)
      // strictly the ACTIVE browser tab — never a background fallback: a
      // navigation is an ungated act only because the person sees it happen,
      // and they only see it in the tab they are looking at
      const tabs = await deps.listBrowserTabs()
      const tab = resolveActiveOnlyBrowserTab(tabs)
      if (!tab) {
        const anyBrowserTab = tabs.some((t) => t.kind === 'browser')
        throw new Error(
          anyBrowserTab
            ? 'no browser tab is active — call shell:switch_tab to make one active (or ' +
                'shell:open_browser for a new one), then navigate'
            : 'no browser tab is open — call shell:open_browser first, then navigate',
        )
      }
      const chrome = deps.webContentsFor(tab.id)
      if (!chrome || chrome.isDestroyed()) {
        throw new Error(
          `the browser tab "${tab.title || tab.id}" is no longer live — switch to it or reopen the page, then try again`,
        )
      }
      // the load's own outcome: browserNavigate answers the page's commit
      // promise (resolves at did-finish-load, rejects at did-fail-load), so
      // the tool result says what actually landed — the final URL after
      // redirects — instead of assuming the address alone meant success
      const page = deps.pageFor(chrome)
      const load = browserModule.browserNavigate(chrome, resolved)
      const settleLoad = async (): Promise<string> => {
        try {
          await load
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(
            `the page did not load: ${message} — check the address, or read the tab with ` +
              'browser:read_page to see what it shows now',
            { cause: error },
          )
        }
        return (page && !page.isDestroyed() && page.getURL()) || resolved
      }
      const finalUrl = await withTimeout(settleLoad(), NAVIGATE_COMMIT_TIMEOUT_MS, 'the navigation')
      return { tabId: tab.id, url: finalUrl }
    }
    // the tab array itself, unwrapped — the skill renders it directly, and the
    // seam test in apps/shell pins that both halves agree on this shape (a
    // {tabs} wrapper here once made every list read "No tabs are open")
    case SHELL_LIST_TABS_TOOL:
      return deps.listSurfaceTabs()
    case SHELL_SWITCH_TAB_TOOL: {
      const id = input.id
      if (typeof id !== 'string' || !id.trim()) {
        throw new Error('`id` must be a non-empty string (from shell:list_tabs)')
      }
      if (id.length > MAX_SHELL_TAB_ID_CHARS) {
        throw new Error(`\`id\` must be at most ${MAX_SHELL_TAB_ID_CHARS} characters`)
      }
      const ok = await deps.activateTab(id)
      if (!ok) {
        throw new Error(
          `no open tab has the id "${id}" — call shell:list_tabs and use an id from its list`,
        )
      }
      return { id }
    }
    case SHELL_OPEN_PATH_TOOL: {
      const path = input.path
      if (typeof path !== 'string' || !path.trim()) {
        throw new Error('`path` must be a non-empty absolute path')
      }
      if (path.length > MAX_SHELL_PATH_CHARS) {
        throw new Error(`\`path\` must be at most ${MAX_SHELL_PATH_CHARS} characters`)
      }
      // absolute only, the same rule parseKbOnlyPaths holds the kb:read
      // scope to: a relative path is the model guessing at a working
      // directory, and the desktop opens files by their full location
      if (!isAbsolute(path)) {
        throw new Error(
          `\`path\` must be absolute: "${path.slice(0, 120)}" — pass the file's full location`,
        )
      }
      // the scope gate (kb:read's verdicts): the agent opens files the person
      // has surfaced — starred or recent, inside a knowledge folder, or
      // indexed — never an arbitrary absolute path the desktop never knew
      if (!(await Promise.resolve(deps.pathAllowed(path)))) {
        throw new Error(
          `"${path.slice(0, 120)}" is outside the desktop's file scope — the agent may open ` +
            'files the person has surfaced (starred or recent, inside a knowledge folder, or ' +
            'indexed). Ask the person to open this one themselves, or have them add it to the ' +
            'knowledge base first',
        )
      }
      // a symlink must not smuggle an out-of-scope target past the location
      // verdict: resolve it and re-run the verdict on the real path
      const resolved: string | null = await realpath(path).catch(() => null)
      if (
        resolved !== null &&
        resolved !== path &&
        !(await Promise.resolve(deps.pathAllowed(resolved)))
      ) {
        throw new Error(
          `"${path.slice(0, 120)}" resolves outside the desktop's file scope — pass the ` +
            `file's real location (${resolved.slice(0, 120)}), or ask the person to open it`,
        )
      }
      const ok = await deps.openPath(path)
      if (!ok) {
        throw new Error(
          `"${path.slice(0, 120)}" did not open — the file may be missing, or no app in the ` +
            'suite reads that type. Check the path and the extension, then try again',
        )
      }
      return { path }
    }
    default:
      throw new Error(`unknown browser tool: ${tool}`)
  }
}

// ── IPC registration ───────────────────────────────────────────────────────

/** deps as index.ts wires them for the renderer-facing handler */
export interface BrowserAgentIpcDeps {
  /** every open browser tab (shell strip and detached windows); sync or async */
  listBrowserTabs(): Promise<readonly BrowserTabLike[]> | readonly BrowserTabLike[]
  webContentsFor(tabId: string): WebContents | undefined
  /**
   * The webContents the channel serves — both panel copies that host the
   * dock's AgentLoop: the shell window's own renderer (the HTML drawer's
   * home) and the drawer overlay's standalone panel (a separate
   * WebContentsView while a document tab is active, without which the
   * overlay's loop could call no browser tool at all and its parked
   * annotation card could never read the pin-time shot). Every other
   * webContents in the process (an app tab, a detached document window, a
   * browser page view) is refused before the call is even parsed; destroyed
   * or missing entries drop out and fail closed the same way.
   */
  panelWebContents(): readonly WebContents[]
  /**
   * The main-side confirmation for fill_field/click_element, wired to a native
   * dialog parented to the shell window (index.ts). Resolves false = the page
   * action does not run. Required on purpose: a wiring that forgets the gate
   * fails closed instead of silently running ungated actions.
   */
  confirmPageAction(request: BrowserPageActionConfirm): Promise<boolean>
  // ── the shell operator tools (the same channel serves them; all ungated) ──
  /** open a browser tab (optionally at a resolved URL) and activate it */
  openBrowserTab(url?: string): string | Promise<string>
  /** activate one tab by id (shell strip or detached); false when the id names none */
  activateTab(id: string): boolean | Promise<boolean>
  /** every open tab with its url/filePath — the surface context and list_tabs share it */
  listSurfaceTabs(): Promise<readonly SurfaceTab[]> | readonly SurfaceTab[]
  /** the kb:read scope verdicts for one absolute path (see BrowserAgentDeps.pathAllowed) */
  pathAllowed(path: string): boolean | Promise<boolean>
  /** open a local file into its app tab; false when nothing opens it */
  openPath(path: string): boolean | Promise<boolean>
}

/**
 * Register the browser skill's IPC handler and the page-view pairing watcher.
 * Safe to call once per process (the shell calls it from app.whenReady,
 * before the first browser tab can exist). The handler's sender gate serves
 * only the two panel copies that host the dock's AgentLoop (the shell
 * renderer and the drawer overlay's standalone panel — see
 * {@link BrowserAgentIpcDeps.panelWebContents}); everything else is refused
 * before the call is parsed, and the main-side confirmation stays as the
 * second gate on the risky tools.
 */
export function registerBrowserSkillIpc(deps: BrowserAgentIpcDeps): void {
  const links = new BrowserPageLinks(isBrowserPageView)
  // the pairing must exist before the first browser tab is created, and
  // app.whenReady (where the shell registers this) precedes any tab
  app.on('web-contents-created', (_event, wc) => links.observeCreated(wc))
  ipcMain.handle(BROWSER_SKILL_CHANNEL, async (event, call: unknown) => {
    // sender gate (P1-4 ①): compare against the panel-hosting webContents by
    // identity — the shell renderer and the overlay panel are the only ones
    // served, and a sender no live entry matches fails closed
    const allowed = deps.panelWebContents().some((wc) => !wc.isDestroyed() && wc === event.sender)
    if (!allowed) {
      throw new Error('browserskill:execute is not callable from this sender')
    }
    const { tool, input } = (call ?? {}) as { tool?: unknown; input?: unknown }
    if (typeof tool !== 'string' || !tool) {
      throw new Error('browserskill:execute requires a tool name')
    }
    if (
      input !== undefined &&
      input !== null &&
      (typeof input !== 'object' || Array.isArray(input))
    ) {
      throw new Error('browserskill:execute input must be an object')
    }
    return executeBrowserSkillAction(
      {
        listBrowserTabs: deps.listBrowserTabs,
        webContentsFor: deps.webContentsFor,
        pageFor: (chrome) => pageWcOf(links, chrome),
        confirmAction: (request) => deps.confirmPageAction(request),
        openBrowserTab: (url) => deps.openBrowserTab(url),
        activateTab: (id) => deps.activateTab(id),
        listSurfaceTabs: () => deps.listSurfaceTabs(),
        pathAllowed: (path) => deps.pathAllowed(path),
        openPath: (path) => deps.openPath(path),
      },
      tool,
      (input ?? {}) as Record<string, unknown>,
    )
  })
}
