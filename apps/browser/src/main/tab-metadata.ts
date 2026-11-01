/**
 * Per-tab page metadata fold: how page events map onto the title and favicon
 * the shell tab carries. Pure — browser-main applies it, the tests pin it.
 */

export interface TabMetadata {
  title: string
  faviconUrl: string | null
}

/** the title while a page has none of its own: the URL's host, else the URL */
export function titleFallback(url: string): string {
  if (!url) return ''
  try {
    const parsed = new URL(url)
    return parsed.hostname || parsed.protocol.replace(/:$/, '') || url
  } catch {
    return url
  }
}

const MAX_TITLE_CHARS = 120

/**
 * A main-frame navigation landed: the new page has announced nothing yet, so
 * the tab carries the host as its title (a browser shows the address until the
 * real title arrives) and drops the previous page's favicon — the old site's
 * icon must not linger beside the new one.
 */
export function applyNavigation(current: TabMetadata, url: string): TabMetadata {
  return { title: titleFallback(url), faviconUrl: null }
}

/** a page-title-updated event: empty titles keep the fallback shape */
export function applyPageTitle(current: TabMetadata, title: string, url: string): TabMetadata {
  const clean = title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS)
  return { ...current, title: clean || titleFallback(url) }
}

/**
 * A page-favicon-updated event: the last candidate the page announced wins
 * (sites list several sizes; the last is the most specific), an empty list
 * clears the icon.
 */
export function applyPageFavicon(current: TabMetadata, favicons: readonly unknown[]): TabMetadata {
  const last = favicons[favicons.length - 1]
  const url = typeof last === 'string' ? last : ''
  return { ...current, faviconUrl: url !== '' ? url : null }
}
