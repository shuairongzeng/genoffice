import type { MarkdownNav } from './Markdown'

/**
 * filenav links: the shared way for AI answers to cite source files as
 * [name](filenav:///abs/path). Any app's panel can render them by spreading
 * createFileNav() into its Markdown navs; clicking one opens the file in the
 * app that owns its extension (a new tab under the shell), whatever the
 * current app is.
 *
 * A cite may also carry a text fragment — [name](filenav:///abs/path#:~:text=…)
 * names the sentence the search actually matched (issue #56: a hit has an
 * address, not just a path). Hosts that forward the text to their open
 * channel land the reader on the match; hosts that take only the path keep
 * today's open-at-the-top behavior.
 */

export const FILE_NAV_SCHEME = 'filenav://'

/** W3C text-fragment marker, so the deep-link grammar reads like the web's */
const TEXT_FRAGMENT_PREFIX = '#:~:text='

/**
 * filenav href for an absolute path, readable as filenav:///abs/path.
 * encodeURIComponent encodes everything the inline-link href grammar rejects
 * (spaces, %, CJK); it leaves '(' and ')' raw, so those are encoded on top —
 * the parser only accepts one level of balanced parens in an href. Slashes
 * are restored last; safe because '%' from the path is itself encoded.
 * A non-empty `text` appends the fragment (:~:text=), fragment-encoded the
 * same way; an empty/whitespace text is dropped, not carried as a stub.
 */
export function fileNavHref(path: string, text?: string): string {
  const encoded = encodeURIComponent(path)
    .replace(/%2F/g, '/')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
  const target = text?.trim()
  if (!target) return FILE_NAV_SCHEME + encoded
  return (
    FILE_NAV_SCHEME +
    encoded +
    TEXT_FRAGMENT_PREFIX +
    encodeURIComponent(target).replace(/\(/g, '%28').replace(/\)/g, '%29')
  )
}

/**
 * The path and fragment halves of a scheme-matching href; null when the href
 * carries no path. The split happens at the fragment MARKER, not at any '#':
 * '#' is a legal filename character, and a hand-written raw (unencoded) path
 * like filenav:///tmp/a#b.md must keep its '#' — pre-fragment behavior. An
 * encoded path never contains a raw '#' (it percent-escapes to %23), so every
 * href our producers build splits unambiguously.
 */
function splitFileNavHref(href: string): { encodedPath: string; fragment: string } | null {
  if (!href.startsWith(FILE_NAV_SCHEME)) return null
  const rest = href.slice(FILE_NAV_SCHEME.length)
  if (!rest) return null
  const marker = rest.indexOf(TEXT_FRAGMENT_PREFIX)
  const encodedPath = marker === -1 ? rest : rest.slice(0, marker)
  const fragment = marker === -1 ? '' : rest.slice(marker + 1)
  if (!encodedPath) return null
  return { encodedPath, fragment }
}

/** filenav:///abs/path → /abs/path (decoded); null when the href carries no path. A text fragment is ignored — use parseFileNavText for it. */
export function parseFileNavHref(href: string): string | null {
  const parts = splitFileNavHref(href)
  if (parts === null) return null
  try {
    return decodeURIComponent(parts.encodedPath)
  } catch {
    // hand-written hrefs may carry raw (unencoded) text — pass it through
    return parts.encodedPath
  }
}

/** the href's text fragment decoded, or null when it carries none */
export function parseFileNavText(href: string): string | null {
  const parts = splitFileNavHref(href)
  if (parts === null || !parts.fragment.startsWith(TEXT_FRAGMENT_PREFIX.slice(1))) return null
  const encoded = parts.fragment.slice(TEXT_FRAGMENT_PREFIX.length - 1)
  try {
    return decodeURIComponent(encoded)
  } catch {
    // hand-written fragments may be raw text — pass it through
    return encoded
  }
}

/** nav entry that opens cited files through the host app's open-channel; a cite carrying a text fragment passes the match text along (hosts may ignore it) */
export function createFileNav(openPath: (path: string, text?: string) => void): MarkdownNav {
  return {
    scheme: FILE_NAV_SCHEME,
    onNavigate: (href) => {
      const path = parseFileNavHref(href)
      if (path === null) return
      const text = parseFileNavText(href)
      // the text argument is present only when the cite carries a target, so
      // single-path hosts keep their exact one-argument call shape
      if (text !== null && text.length > 0) openPath(path, text)
      else openPath(path)
    },
  }
}
