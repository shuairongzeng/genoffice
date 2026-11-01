/**
 * Navigation policy for page views: the pure decisions behind
 * `will-navigate` and `setWindowOpenHandler`, plus the Ctrl/Cmd+K chord test
 * that keeps the shell's palette summon working inside web pages. Pure on
 * purpose — the main process applies the decisions, the tests pin them.
 */

/** what to do with a page-initiated navigation (`will-navigate`) */
export type NavigationDecision =
  /** let the page navigate in this tab */
  | { action: 'allow' }
  /** refuse it in-view; the scheme belongs to another app (mailto:, tel:) */
  | { action: 'external' }
  /** refuse it outright */
  | { action: 'deny' }

/** what to do with a page-initiated window open (target=_blank, window.open) */
export type WindowOpenDecision =
  /** open the URL in a new browser tab of the shell strip */
  | { action: 'tab' }
  /** hand the URL to the OS handler; no tab */
  | { action: 'external' }
  /** refuse it; no tab, no OS handler */
  | { action: 'deny' }

/** schemes a page view may navigate to when the *page itself* asks (will-navigate) */
const PAGE_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:'])

/** schemes another application owns — the OS handler, never a tab */
const EXTERNAL_SCHEMES: ReadonlySet<string> = new Set(['mailto:', 'tel:', 'sms:', 'news:'])

function protocolOf(url: string): string | null {
  try {
    return new URL(url).protocol
  } catch {
    return null
  }
}

/**
 * `will-navigate`: same-tab navigation is the default for http/https. file: is
 * deliberately absent — a page-initiated file: navigation (a link, a redirect,
 * a script) is refused, because local files are the person's disk, not
 * something web content gets to pull into a renderer. The only file: entry is
 * the address bar: resolveAddressInput (url-input.ts) still accepts it, and
 * the load it triggers is main-initiated (`webContents.loadURL`), which never
 * passes through will-navigate. file cross-scheme rules stay Chromium's —
 * webSecurity is untouched. Hand-off schemes go to the OS; everything else is
 * refused.
 */
export function decideNavigation(url: string): NavigationDecision {
  const protocol = protocolOf(url)
  if (protocol === null) return { action: 'deny' }
  if (PAGE_SCHEMES.has(protocol)) return { action: 'allow' }
  if (EXTERNAL_SCHEMES.has(protocol)) return { action: 'external' }
  return { action: 'deny' }
}

/**
 * `setWindowOpenHandler`: http/https pop-ups become browser tabs of the shell
 * strip (the desktop's embedded tab strip gains a row); hand-off schemes go to
 * the OS; anything else (about:, chrome:, javascript:) opens nothing. The
 * opener handle a window.open caller would receive is deliberately dropped
 * with the deny — a page does not get to script GenOffice's tabs.
 */
export function decideWindowOpen(url: string): WindowOpenDecision {
  const protocol = protocolOf(url)
  if (protocol === null) return { action: 'deny' }
  if (protocol === 'http:' || protocol === 'https:') return { action: 'tab' }
  if (EXTERNAL_SCHEMES.has(protocol)) return { action: 'external' }
  return { action: 'deny' }
}

/**
 * The palette-summon chord on a page view: plain Ctrl/Cmd+K (no shift/alt)
 * summons the shell palette, exactly like every other surface of the shell
 * window — a web page never gets to own the suite's intent bus. Shift/alt
 * variants stay the page's.
 */
export function isPaletteSummonChord(input: {
  type: string
  control: boolean
  meta: boolean
  shift: boolean
  alt: boolean
  key?: string
}): boolean {
  if (input.type !== 'keyDown' && input.type !== 'rawKeyDown') return false
  if (!input.control && !input.meta) return false
  if (input.shift || input.alt) return false
  return input.key?.toLowerCase() === 'k'
}
