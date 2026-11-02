/**
 * The app-session tool-allow set: the tools the person always-allowed in a
 * confirm card ("始终允许（本会话）"), held MAIN-SIDE so one set serves every
 * panel mount — Home's kb-ask copy and the doc-mode overlay's copy are
 * different conversations, but the person's trust is one thing, and a thread
 * switch is a view change, not a trust change.
 *
 * In-memory ONLY, deliberately not persisted: the card says "this session",
 * and the person's restart is the reset point. Persisting the set would
 * silently upgrade a per-session grant into a standing one that outlives the
 * sitting; the mode itself (auto/smart/paranoid) is the durable half of the
 * trust question, this set is the volatile half.
 *
 * Pure bookkeeping behind an interface so the IPC layer stays injectable and
 * the tests can build throwaway instances: a fresh instance starts empty,
 * which is exactly what an app restart looks like.
 */
export interface AiSessionAllows {
  /** whether the person always-allowed this tool name this app session */
  has(tool: string): boolean
  /** record an always-allow (idempotent) */
  add(tool: string): void
  /** the recorded tool names (order of first record; diagnostics and tests) */
  tools(): readonly string[]
}

export function createAiSessionAllows(): AiSessionAllows {
  const allowed = new Set<string>()
  return {
    has: (tool) => allowed.has(tool),
    add: (tool) => {
      allowed.add(tool)
    },
    tools: () => [...allowed],
  }
}

/** longest tool name the channels accept (the loop's schema check is per-kind; this is the wire guard) */
export const MAX_AI_SESSION_ALLOW_TOOL_CHARS = 200

/** a tool name as the channels accept it: a non-empty string within the cap */
export function asSessionAllowTool(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  if (raw.length > MAX_AI_SESSION_ALLOW_TOOL_CHARS) return null
  return raw
}
