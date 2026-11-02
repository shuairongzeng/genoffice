/**
 * The AI panel's global permission mode — one posture for the whole app, not
 * per panel or per conversation (Home's kb-ask copy and the doc-mode
 * overlay's copy are different conversations, but they share one person
 * whose trust one setting should describe). Persisted by the shell in
 * app-settings.json under `aiPermissions` and broadcast to every panel mount.
 *
 * The modes:
 *
 * - `auto` — every tool runs without a card, deletions included. The honest
 *   safety net is the OS trash: delete_file moves files there, so "fully
 *   automatic" still means recoverable, not irreversible. The tool-note chips
 *   still record what ran.
 * - `smart` — the default, today's behavior: risk:'high' tools card once per
 *   app session (the card's "always allow" records into the main-side
 *   session set), risk:'always-ask' tools (delete_file) card every single
 *   time, pure reads never card.
 * - `paranoid` — every side-effecting tool call cards: the risk-graded ones
 *   plus the desktop's visible acts (opening a tab, navigating, switching
 *   tabs, opening a file). Pure reads — knowledge-base search/read,
 *   attachments, list_tabs, the browser read tools, the proxied apps' read
 *   tools — stay cardless even here, because asking about a read is noise
 *   that trains the person to click Allow.
 */
export type AiPermissionMode = 'auto' | 'smart' | 'paranoid'

/** every mode the picker offers, in the menu's order */
export const AI_PERMISSION_MODES = ['auto', 'smart', 'paranoid'] as const

/** the out-of-the-box posture (and the value a malformed store read falls back to) */
export const DEFAULT_AI_PERMISSION_MODE: AiPermissionMode = 'smart'

/** A stored/IPC value as a mode: unknown or malformed reads fall back to the default. */
export function normalizeAiPermissionMode(value: unknown): AiPermissionMode {
  return typeof value === 'string' && (AI_PERMISSION_MODES as readonly string[]).includes(value)
    ? (value as AiPermissionMode)
    : DEFAULT_AI_PERMISSION_MODE
}

/**
 * A raw value as a mode name — null on anything the picker never offered.
 * The set channel's guard: a malformed write keeps the stored mode instead
 * of resetting it to the default (the trust posture never flips on noise).
 */
export function asAiPermissionMode(value: unknown): AiPermissionMode | null {
  return typeof value === 'string' && (AI_PERMISSION_MODES as readonly string[]).includes(value)
    ? (value as AiPermissionMode)
    : null
}

/** same mode (trivial for one field; named so stores and watchers read uniformly) */
export function sameAiPermissionMode(a: AiPermissionMode, b: AiPermissionMode): boolean {
  return a === b
}
