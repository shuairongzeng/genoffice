import type { BrowserAskAboutPayload } from '../../shared/home-api'

/**
 * The browser's "ask AI about this" entry (charter W2a/W2b): the browser side
 * pushes an annotation over `browser:ask-about` — selector, text snippet,
 * note, url — and the Ask AI panel parks it as a draft question. The push is
 * page-supplied, so this module owns the normalization before any of it
 * reaches panel state; the park itself is deliberately a park, never a send.
 */

/** longest string kept from one push field (a page-supplied string) */
const MAX_FIELD_CHARS = 200
/** the URL field gets a little more room, but still bounded */
const MAX_URL_CHARS = 400

/**
 * Normalize a raw `browser:ask-about` payload: keep the well-formed string
 * fields (clipped), drop everything else. Answers null when nothing usable
 * arrived — a malformed push parks nothing rather than an empty card.
 */
export function normalizeBrowserAskAbout(raw: unknown): BrowserAskAboutPayload | null {
  if (typeof raw !== 'object' || raw === null) return null
  const p = raw as Record<string, unknown>
  const field = (key: string): string | undefined => {
    const value = p[key]
    if (typeof value !== 'string') return undefined
    const clipped = value.trim().slice(0, MAX_FIELD_CHARS)
    return clipped || undefined
  }
  const selector = field('selector')
  const textSnippet = field('textSnippet')
  const note = field('note')
  const rawUrl = typeof p.url === 'string' ? p.url.trim().slice(0, MAX_URL_CHARS) : ''
  const url = rawUrl || undefined
  if (selector === undefined && textSnippet === undefined && note === undefined) return null
  return {
    ...(selector !== undefined ? { selector } : {}),
    ...(textSnippet !== undefined ? { textSnippet } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(url !== undefined ? { url } : {}),
  }
}

/**
 * The human label of one parked draft: the user's own note outranks the
 * highlighted snippet, and the selector is the last resort — it is the least
 * readable, but still tells the reader which element was marked.
 */
export function browserAskLabelOf(draft: BrowserAskAboutPayload): string {
  return draft.note ?? draft.textSnippet ?? draft.selector ?? '(annotation)'
}

/** the URL as the card shows it: scheme and trailing slash trimmed, then clipped */
export function browserAskUrlOf(draft: BrowserAskAboutPayload): string {
  const url = draft.url ?? ''
  const trimmed = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '')
  return trimmed.slice(0, 80) || '(no URL)'
}

/**
 * The params of the localized scaffold the composer parks (key
 * `askBrowserNoteDraft`): `content` is what the annotation says, `url` is
 * where it lives. A bare selector with no text still produces a usable
 * question — the model can read the page and find the element by selector.
 */
export function browserAskScaffoldParams(draft: BrowserAskAboutPayload): {
  content: string
  url: string
} {
  const content = [draft.note, draft.textSnippet].filter(Boolean).join(' — ')
  return {
    content: content || draft.selector || '(this element)',
    url: draft.url ?? browserAskUrlOf(draft),
  }
}
