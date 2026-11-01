/**
 * The ask-intent handoff's shared contract (P0-2). A handoff starts in the
 * shell renderer (the command palette's Ask AI fallback, a genoffice://ask
 * deep link, the browser's "ask AI about this") and ends in whichever copy of
 * the drawer the person can actually see: Home's own panel while Home is the
 * active tab, or the native overlay's standalone mount while a document is —
 * in that state Home's HTML copy is display:none under the document's view, so
 * the handoff is forwarded through the main process
 * (Home → home:ask-forward → main → home:ask-forwarded → the overlay's panel).
 *
 * The handoff's shape and sanitizers live here — one definition shared by the
 * renderer's ask-intent module, the preload (which validates what main pushed)
 * and the main process (which re-validates what the renderer invoked) — so the
 * three cannot drift. Kept free of Electron, DOM and React imports for the
 * same reason desktop-geometry.ts is: every process and the unit tests share
 * it.
 */

/** A question handed to the Ask AI panel from outside. `seq` distinguishes two
 *  submissions of the same text: the panel consumes each seq at most once. */
export interface PendingAskQuery {
  readonly text: string
  readonly seq: number
  /** 'palette' is the user's own just-typed text; 'deep-link' is web-supplied */
  readonly origin: AskQueryOrigin
  /**
   * An explicit file selection (the desktop's multi-select) as this
   * conversation's corpus: the panel attaches it as the round scope — every
   * ask while it is attached searches and cites within the selection only.
   * Sanitized through {@link normalizeScopePaths}; the main process
   * re-validates what actually crosses IPC.
   */
  readonly scopePaths?: readonly string[]
}

/**
 * Where a pending query came from. The palette fallback is text the user just
 * typed and confirmed, so it submits itself; a `genoffice://ask?q=…` query can
 * be injected by any web page through location.href, so it only parks in the
 * composer draft — the person sends it with an explicit Enter.
 */
export type AskQueryOrigin = 'palette' | 'deep-link'

/**
 * How many scope paths one handoff may carry; mirrors the main-side onlyPaths
 * cap. Exported because the desktop's multi-select menu gates its Ask AI
 * action on it: a selection past the cap is refused up front with a hint
 * (a handoff would otherwise be silently truncated to the first 50).
 */
export const MAX_SCOPE_PATHS = 50

/**
 * Sanitize a handoff's scope paths: keep the non-empty strings, dedupe, cap.
 * The main process re-validates (absolute, per-path length, count) before any
 * IPC effect — this keeps the chip's count and the panel's calls well-formed
 * whatever shape arrives.
 */
export function normalizeScopePaths(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const path of raw) {
    if (typeof path !== 'string' || !path) continue
    if (seen.has(path)) continue
    seen.add(path)
    out.push(path)
    if (out.length >= MAX_SCOPE_PATHS) break
  }
  return out
}

/** a forwarded handoff's text is still the renderer's own, but the channel is
 *  only as trustworthy as any other: cap it far past the longest sane question
 *  so a runaway sender cannot balloon the payload it forwards */
const MAX_FORWARDED_ASK_TEXT = 10000

/**
 * A handoff that crossed IPC (the home:ask-forward invoke, the
 * home:ask-forwarded push), validated and data-stripped back to the
 * {@link PendingAskQuery} shape; null when the payload is not one, so a
 * malformed or forged handoff is dropped whole rather than half-kept — the
 * same contract the preload's other push validators keep (asRendererDeepLink).
 */
export function normalizeForwardedAskQuery(raw: unknown): PendingAskQuery | null {
  if (typeof raw !== 'object' || raw === null) return null
  const p = raw as Partial<PendingAskQuery>
  if (typeof p.text !== 'string') return null
  if (typeof p.seq !== 'number' || !Number.isFinite(p.seq)) return null
  if (p.origin !== 'palette' && p.origin !== 'deep-link') return null
  const scopePaths = normalizeScopePaths(p.scopePaths)
  return {
    text: p.text.slice(0, MAX_FORWARDED_ASK_TEXT),
    seq: Math.trunc(p.seq),
    origin: p.origin,
    ...(scopePaths.length > 0 ? { scopePaths } : {}),
  }
}
