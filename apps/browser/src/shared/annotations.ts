/**
 * The annotation model: one element the person marked on a web page, the shape
 * main persists to `browser-annotations.json`, the shape the page-side overlay
 * receives, and the shape the `browser:ask-about` event carries to the Home AI
 * dock. Pure on purpose — main, preload and the tests all share it, so the
 * three sides cannot drift.
 */

/** the snippet cap the task's contract fixes (characters, after folding) */
export const ANNOTATION_SNIPPET_MAX = 200
/** the note's cap: the composer is a small popup card, not an editor */
export const ANNOTATION_NOTE_MAX = 500
/** the whole store's record cap: a hand-edited file cannot grow unbounded */
export const ANNOTATION_RECORDS_MAX = 2000

/** hard length caps for the fields a raw record may carry */
const ID_MAX = 100
const SELECTOR_MAX = 1000
const TAG_MAX = 60
const URL_MAX = 2000

/** schemes a page view may render — http/https from anywhere, file: from the address bar only */
const ANNOTATION_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'file:'])

/** one saved annotation as it is persisted and pushed around */
export interface BrowserAnnotation {
  /** stable id, randomUUID-shaped, minted by main at pin time */
  id: string
  /** the annotated page's URL, hash-stripped — the revisit key */
  url: string
  /** the CSS selector this build generated for the target element */
  selector: string
  /** the target's tag name as tagName reports it ('BUTTON', 'A', …) */
  tagName: string
  /** the target's text at pin time, whitespace-folded, ≤200 chars */
  textSnippet: string
  /** the target's rect in document coordinates at pin time */
  rect: { x: number; y: number; width: number; height: number }
  /** the person's note ('' until written) */
  note: string
  /** creation time, ms since epoch */
  createdAt: number
}

/**
 * The `browser:ask-about` event payload — one annotation handed to the Home AI
 * dock as a question draft's attachment context. Deliberately the whole
 * annotation record: the panel side composes the draft from whatever it needs
 * (selector + text + note + url), and no projection here can starve it.
 */
export type BrowserAskAboutPayload = BrowserAnnotation

/** what the page overlay needs to describe one pin */
export interface AnnotationPinDraft {
  selector: string
  tagName: string
  textSnippet: string
  rect: { x: number; y: number; width: number; height: number }
}

/**
 * The revisit key: the URL with its fragment dropped, so a hash-routing SPA
 * keeps one key across in-page hash moves (a route change that breaks the
 * selectors is handled by the silent-fail rule, not by a key split). null for
 * anything a page view may not render (about:blank before the first commit,
 * junk) — those pages carry no annotations.
 */
export function normalizeAnnotationUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '' || raw.length > URL_MAX) return null
  try {
    const url = new URL(raw)
    if (!ANNOTATION_SCHEMES.has(url.protocol)) return null
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

const finiteRounded = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  // `|| 0` folds -0 to +0 so a stored rect never carries negative zero
  return Math.round(value) || 0
}

/** fold whitespace and cap, the shape every snippet (read or pinned) takes */
export function foldSnippet(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/\s+/g, ' ').trim().slice(0, ANNOTATION_SNIPPET_MAX)
}

/** clamp a note to its cap (raw junk reads as '') */
export function clampNote(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.slice(0, ANNOTATION_NOTE_MAX)
}

function normalizedRect(raw: unknown): BrowserAnnotation['rect'] | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const x = finiteRounded(r.x)
  const y = finiteRounded(r.y)
  const width = finiteRounded(r.width)
  const height = finiteRounded(r.height)
  if (x === null || y === null || width === null || height === null) return null
  if (width < 0 || height < 0) return null
  return { x, y, width, height }
}

/**
 * Shape validation: anything read from disk (or crossing IPC) walks through
 * here; a record that fails any invariant answers null and is dropped — a
 * foreign or hand-edited file never breaks the feature that reads it. Values
 * that merely run long are clamped, not dropped, so a future cap change does
 * not orphan old records.
 */
export function normalizeAnnotationRecord(raw: unknown): BrowserAnnotation | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' ? r.id.trim() : ''
  if (id === '' || id.length > ID_MAX) return null
  const url = normalizeAnnotationUrl(r.url)
  if (url === null) return null
  const selector = typeof r.selector === 'string' ? r.selector.trim() : ''
  if (selector === '' || selector.length > SELECTOR_MAX) return null
  const tagName = typeof r.tagName === 'string' ? r.tagName.trim() : ''
  if (tagName === '' || tagName.length > TAG_MAX) return null
  const rect = normalizedRect(r.rect)
  if (rect === null) return null
  const createdAt =
    typeof r.createdAt === 'number' && Number.isFinite(r.createdAt)
      ? Math.max(0, Math.round(r.createdAt))
      : null
  if (createdAt === null) return null
  return {
    id,
    url,
    selector,
    tagName,
    textSnippet: foldSnippet(r.textSnippet),
    rect,
    note: clampNote(r.note),
    createdAt,
  }
}

/**
 * Normalize the whole stored list: keep the valid records in file order, cap
 * the count (newest first when the cap bites — the oldest drop), and re-key
 * by id so a duplicated id cannot reach the overlay twice.
 */
export function normalizeAnnotationList(raw: unknown): BrowserAnnotation[] {
  if (!Array.isArray(raw)) return []
  const out: BrowserAnnotation[] = []
  const seen = new Set<string>()
  for (const record of raw) {
    const clean = normalizeAnnotationRecord(record)
    if (clean === null || seen.has(clean.id)) continue
    seen.add(clean.id)
    out.push(clean)
  }
  if (out.length > ANNOTATION_RECORDS_MAX) {
    const byAge = [...out].sort((a, b) => b.createdAt - a.createdAt)
    const keep = new Set(byAge.slice(0, ANNOTATION_RECORDS_MAX).map((a) => a.id))
    return out.filter((a) => keep.has(a.id))
  }
  return out
}

/**
 * A pinned element's description as the page overlay sends it — validated with
 * the same clamps the store applies, so main never trusts shape from a
 * renderer. null when the draft is unusable (the pin is dropped).
 */
export function normalizePinDraft(
  raw: unknown,
  url: string,
  id: string,
  createdAt: number,
): BrowserAnnotation | null {
  if (raw === null || typeof raw !== 'object') return null
  const draft = raw as Record<string, unknown>
  const rect = normalizedRect(draft.rect)
  if (rect === null) return null
  return normalizeAnnotationRecord({
    id,
    url,
    selector: draft.selector,
    tagName: draft.tagName,
    textSnippet: draft.textSnippet,
    rect,
    note: '',
    createdAt,
  })
}
