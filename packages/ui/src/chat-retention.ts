/**
 * Entry-count bound for the AI panels' live chat transcript (issue #51 P1).
 *
 * docs' panel got this first (apps/docs/src/renderer/ai/chat-retention.ts,
 * which additionally releases old roll-back snapshots), and the shell Ask
 * panel bounds at MAX_ASK_ENTRIES — but the five editor panels
 * (slides/sheets/pdf/markdown/html) grew without limit: every turn appends a
 * user entry plus one or more assistant entries (tools output included), so a
 * long session held the whole transcript in React state for the life of the
 * panel. The count bound lives here once and each panel routes its chat
 * state's growth through it — past MAX_CHAT_ENTRIES the oldest entries drop.
 */
export const MAX_CHAT_ENTRIES = 60

/**
 * Bound a chat array: drop the oldest entries past `max`
 * (default {@link MAX_CHAT_ENTRIES}).
 *
 * Returns the input array itself when nothing needed trimming, so the common
 * case (an append or a delta on a small transcript) does not produce a new
 * identity.
 */
export function boundChatHistory<T>(entries: readonly T[], max: number = MAX_CHAT_ENTRIES): T[] {
  return entries.length > max ? entries.slice(entries.length - max) : (entries as T[])
}
