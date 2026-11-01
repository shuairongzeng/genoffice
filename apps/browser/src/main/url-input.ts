/**
 * Address-bar input resolution: one typed string in, either a page URL or a
 * search-engine URL out. Pure — the main process applies the decision, the
 * tests pin every rule.
 */

export interface ResolvedAddressInput {
  /** 'url' = load it as a page; 'search' = the input was not a usable address */
  kind: 'url' | 'search'
  url: string
}

export interface AddressInputOptions {
  /**
   * Builds the search URL for a query. DuckDuckGo by default: Electron has no
   * API for the OS default search engine, and DuckDuckGo needs no key and
   * tracks nothing. Swappable for tests and for a future setting.
   */
  searchUrl?: (query: string) => string
}

/** the default engine's query endpoint */
export function defaultSearchUrl(query: string): string {
  return `https://duckduckgo.com/?q=${encodeURIComponent(query)}`
}

/**
 * Schemes a page view may load from the address bar. file: is listed on
 * purpose: the address bar is the one entry local files have into a page view
 * — a page-initiated file: navigation is refused (navigation-policy's
 * decideNavigation), so web content cannot pull files off the disk by itself.
 */
const PAGE_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'file'])

/**
 * Schemes recognized as *not* hostnames when they lead the input. Anything
 * else that looks like `word:` (which includes `my-site.example.com:`) is
 * re-read as a `host:port` candidate — the WHATWG parser would happily take
 * `my-site.example.com` as a scheme, and the omnibox must not.
 */
const KNOWN_SCHEMES: ReadonlySet<string> = new Set([
  'http',
  'https',
  'file',
  'ftp',
  'about',
  'data',
  'javascript',
  'blob',
  'chrome',
  'view-source',
  'mailto',
  'tel',
  'sms',
  'news',
  'ws',
  'wss',
  'urn',
  'magnet',
])

/** the input's leading scheme candidate, e.g. `https` from `https://…` */
function schemeCandidate(text: string): string | null {
  return text.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase() ?? null
}

/** a syntactically plausible hostname label chain (no ports, no paths) */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i

/** dotted-quad IPv4 literal, the one host form that implies plain http */
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/

const PORT_RE = /^\d{1,5}$/

/**
 * Resolve one address-bar input. The rules, in order:
 *
 * 1. Empty input searches for nothing (the chrome disables submit, this only
 *    keeps the answer well-formed).
 * 2. Input led by a *known* scheme: a URL on http/https/file loads as a page;
 *    every other known scheme (`javascript:`, `data:`, `chrome:`, `mailto:`,
 *    a malformed `http://…`) falls to the search engine — never to a scheme
 *    the page view would execute.
 * 3. Input led by an unknown `word:` is re-read as a host:port candidate
 *    (`my-site.example.com:8443/x`) and falls through to rule 5.
 * 4. Whitespace anywhere means search terms (URLs never contain literal spaces).
 * 5. No scheme, no spaces: `host[:port][/path…]` where the host looks like a
 *    domain, `localhost`, or an IPv4 literal navigates — domains over https,
 *    localhost and IPs over plain http (the usual local-dev shape).
 * 6. Everything else is search terms.
 */
export function resolveAddressInput(
  input: string,
  options: AddressInputOptions = {},
): ResolvedAddressInput {
  const search = options.searchUrl ?? defaultSearchUrl
  const text = input.trim()
  if (text === '') return { kind: 'search', url: search('') }

  const scheme = schemeCandidate(text)
  if (scheme !== null && KNOWN_SCHEMES.has(scheme)) {
    if (PAGE_SCHEMES.has(scheme)) {
      try {
        return { kind: 'url', url: new URL(text).toString() }
      } catch {
        // a known page scheme that does not parse is search input
      }
    }
    return { kind: 'search', url: search(text) }
  }

  if (/\s/.test(text)) return { kind: 'search', url: search(text) }

  const hostPart = text.split('/')[0]!
  const [rawHost, rawPort] = splitPort(hostPart)
  const portOk = rawPort === undefined || PORT_RE.test(rawPort)
  const httpsHost = HOSTNAME_RE.test(rawHost)
  const httpHost = rawHost === 'localhost' || IPV4_RE.test(rawHost)
  if (portOk && (httpsHost || httpHost)) {
    return { kind: 'url', url: `${httpHost ? 'http' : 'https'}://${text}` }
  }
  return { kind: 'search', url: search(text) }
}

/** `example.com:8080` → `['example.com', '8080']`; a second colon keeps the whole tail (not a host) */
function splitPort(hostPart: string): [string, string | undefined] {
  const at = hostPart.indexOf(':')
  if (at < 0) return [hostPart, undefined]
  return [hostPart.slice(0, at), hostPart.slice(at + 1)]
}
