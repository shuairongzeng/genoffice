import { describe, expect, it } from 'vitest'
import {
  MAX_AI_SESSION_ALLOW_TOOL_CHARS,
  asSessionAllowTool,
  createAiSessionAllows,
} from '../src/main/ai-session-allows'

/**
 * The app-session tool-allow set (src/main/ai-session-allows.ts): the
 * main-side memory behind the confirm card's 始终允许（本会话） — one set for
 * both panel mounts, surviving thread switches, dying with the process.
 * The tests pin the set semantics and the channel input guard; "an app
 * restart clears it" is the trivial property the fresh instance below
 * stands for (nothing is persisted anywhere).
 */

describe('createAiSessionAllows', () => {
  it('starts empty: every consult answers false', () => {
    const allows = createAiSessionAllows()
    expect(allows.has('run_genoffice')).toBe(false)
    expect(allows.has('edit_file')).toBe(false)
    expect(allows.tools()).toEqual([])
  })

  it('records an always-allow and answers it forever after (idempotent)', () => {
    const allows = createAiSessionAllows()
    allows.add('run_genoffice')
    allows.add('run_genoffice')
    expect(allows.has('run_genoffice')).toBe(true)
    // per tool: a different gated tool still consults false
    expect(allows.has('edit_file')).toBe(false)
    expect(allows.tools()).toEqual(['run_genoffice'])
  })

  it('a fresh instance starts empty again — the app restart', () => {
    // the set is in-memory by design: a restart is a new instance, and
    // nothing anywhere persists the grants (the card says "this session",
    // and the mode itself is the durable half of the trust question)
    const first = createAiSessionAllows()
    first.add('delete_everything')
    expect(first.has('delete_everything')).toBe(true)
    const second = createAiSessionAllows()
    expect(second.has('delete_everything')).toBe(false)
  })
})

describe('asSessionAllowTool (the channel guard)', () => {
  it('accepts a plain tool name', () => {
    expect(asSessionAllowTool('run_genoffice')).toBe('run_genoffice')
    expect(asSessionAllowTool('shell:navigate')).toBe('shell:navigate')
  })

  it('refuses anything that is not a non-empty bounded string', () => {
    expect(asSessionAllowTool(undefined)).toBeNull()
    expect(asSessionAllowTool(42)).toBeNull()
    expect(asSessionAllowTool('')).toBeNull()
    expect(asSessionAllowTool('   ')).toBeNull()
    expect(asSessionAllowTool('x'.repeat(MAX_AI_SESSION_ALLOW_TOOL_CHARS + 1))).toBeNull()
  })
})
