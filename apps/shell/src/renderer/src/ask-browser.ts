import type { BrowserAskAboutPayload } from '../../shared/home-api'

/**
 * The browser's "ask AI about this" entry (charter W2a/W2b): the browser side
 * pushes an annotation over `browser:ask-about` — selector, XPath, text
 * snippet, note, url, and the pin-time element shot's path — and the Ask AI
 * panel parks it as a draft question. The push is page-supplied, so this
 * module owns the normalization before any of it reaches panel state; the
 * park itself is deliberately a park, never a send.
 */

/** longest string kept from one push field (a page-supplied string) */
const MAX_FIELD_CHARS = 200
/** the URL field gets a little more room, but still bounded */
const MAX_URL_CHARS = 400
/**
 * Longest shot path kept — the field is only a "has a screenshot" signal for
 * the card (the bytes are read by annotation id through the browser skill's
 * restricted channel), so a long value carries nothing worth keeping.
 */
const MAX_SHOT_PATH_CHARS = 300

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
  const id = field('id')
  const selector = field('selector')
  const xpath = field('xpath')
  const textSnippet = field('textSnippet')
  const note = field('note')
  const rawUrl = typeof p.url === 'string' ? p.url.trim().slice(0, MAX_URL_CHARS) : ''
  const url = rawUrl || undefined
  const rawShotPath = typeof p.shotPath === 'string' ? p.shotPath.trim() : ''
  const shotPath = rawShotPath.slice(0, MAX_SHOT_PATH_CHARS) || undefined
  if (selector === undefined && textSnippet === undefined && note === undefined) return null
  return {
    ...(id !== undefined ? { id } : {}),
    ...(selector !== undefined ? { selector } : {}),
    ...(xpath !== undefined ? { xpath } : {}),
    ...(textSnippet !== undefined ? { textSnippet } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(shotPath !== undefined ? { shotPath } : {}),
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

/**
 * The evidence line appended under the localized scaffold: the element's
 * addressing keys and the annotation's id, in the model's own words (the
 * skill-body precedent — the appended context is English regardless of the UI
 * locale). It rides the *question text*, so the model holds the selector, the
 * XPath and the id even when the browser tab that could re-read them is gone.
 * '' when the pack carries nothing beyond the snippet.
 */
export function browserAskEvidenceSuffix(draft: BrowserAskAboutPayload): string {
  const bits: string[] = []
  if (draft.selector) bits.push(`selector ${draft.selector}`)
  if (draft.xpath) bits.push(`xpath ${draft.xpath}`)
  if (draft.id) bits.push(`annotation id ${draft.id}`)
  if (draft.shotPath) bits.push('its pin-time screenshot is attached to this question')
  if (bits.length === 0) return ''
  return `Marked element — ${bits.join('; ')}.`
}
