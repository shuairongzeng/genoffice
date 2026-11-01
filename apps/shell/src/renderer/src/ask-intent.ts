/**
 * The ask-intent handoff shared by the command palette's Ask AI fallback and
 * the `home:deep-link` bridge: both route a natural-language query into Home's
 * ask view, where the knowledge-base panel picks it up as a pending query —
 * or, while a document tab is active, into the drawer's native overlay copy
 * through the forward contract in shared/ask-forward.ts. Kept component-free
 * so the routing decisions are testable without mounting anything.
 *
 * The handoff's shape and sanitizers are defined in shared/ask-forward.ts (one
 * definition the preload and the main process share, so the payload is
 * validated identically on both sides of the forward IPC) and re-exported here
 * so the renderer's imports keep one home.
 */

import { normalizeScopePaths, type PendingAskQuery } from '../../shared/ask-forward'

export type { AskQueryOrigin, PendingAskQuery } from '../../shared/ask-forward'
export { MAX_SCOPE_PATHS, normalizeScopePaths } from '../../shared/ask-forward'

export type PendingAskPlan =
  | { readonly consume: false }
  | {
      readonly consume: true
      readonly seq: number
      /** submit = send now; park = an answer is streaming, wait in the composer; drop = blank text */
      readonly action: 'submit' | 'park' | 'drop'
      readonly text: string
      /** the round scope to attach as the panel's chip; present only when the handoff carried one */
      readonly scopePaths?: readonly string[]
    }

/**
 * What the panel does with a pending query. An already-consumed seq and an
 * absent query are no-ops; a blank text is consumed and dropped; a
 * deep-link-origin query parks in the composer draft whatever the panel's
 * state (web-supplied text never sends itself); a palette query submits when
 * the panel is idle and parks while an answer streams, so it is never lost —
 * the user sends it when the current answer lands.
 *
 * A query carrying scope paths attaches the round scope even when its text is
 * blank: opening the panel with the selection parked (nothing sent) is the
 * "ask about these files later" move, so blank+scope parks instead of
 * dropping.
 */
export function planPendingAskQuery(
  pending: PendingAskQuery | null,
  lastConsumedSeq: number,
  busy: boolean,
): PendingAskPlan {
  if (!pending || pending.seq === lastConsumedSeq) return { consume: false }
  const scopePaths = normalizeScopePaths(pending.scopePaths)
  const withScope =
    scopePaths.length > 0 ? { scopePaths } : ({} as { scopePaths?: readonly string[] })
  const text = pending.text.trim()
  if (!text && scopePaths.length === 0) {
    return { consume: true, seq: pending.seq, action: 'drop', text: '' }
  }
  if (!text) return { consume: true, seq: pending.seq, action: 'park', text: '', ...withScope }
  if (pending.origin === 'deep-link')
    return { consume: true, seq: pending.seq, action: 'park', text, ...withScope }
  return { consume: true, seq: pending.seq, action: busy ? 'park' : 'submit', text, ...withScope }
}

/** a deep link's query is web-supplied text: cap it before it reaches the composer */
const MAX_DEEP_LINK_QUERY = 2000

/**
 * The ask view's deep-link payload (`{ view: 'ask', query?: string }`),
 * normalized; null when the link addresses a different view. A missing or
 * non-string query reads as '' — open the panel without injecting a question —
 * and an over-long one is truncated to MAX_DEEP_LINK_QUERY characters.
 */
export function normalizeAskDeepLink(payload: unknown): { readonly query: string } | null {
  if (typeof payload !== 'object' || payload === null) return null
  if ((payload as { view?: unknown }).view !== 'ask') return null
  const query = (payload as { query?: unknown }).query
  return { query: typeof query === 'string' ? query.slice(0, MAX_DEEP_LINK_QUERY) : '' }
}
