import { describe, expect, it, vi } from 'vitest'
import type { AgentSkill } from '../src/skill'
import type { AgentToolCall } from '../src/types'
import {
  DOCUMENT_AGENT_TOOL,
  MAX_AGENT_TASK_CHARS,
  createDocumentAgentSkill,
  type AgentTaskResult,
  type DocumentAgentDeps,
} from '../src'

/**
 * The dock's document-agent delegation: the tool surface (one tool, the
 * task argument, risk:'high' — one confirm card per delegated task), the
 * result shaping (summary + the edits list), the error passthrough (the
 * routing/lifetime refusals are the tool result), and the abort wiring (the
 * run's Stop reaches the sub-agent through cancelAgentTask).
 */

interface Harness {
  skill: AgentSkill
  deps: DocumentAgentDeps
}

function skillWith(
  runImpl: (task: string) => Promise<AgentTaskResult> = async () => ({
    ok: true,
    summary: 'inserted two paragraphs and fixed the heading',
    edits: [
      { tool: 'insert_content', summary: 'inserted 2 blocks' },
      { tool: 'replace_blocks', summary: 'replaced blocks 0-1' },
    ],
  }),
): Harness {
  const deps: DocumentAgentDeps = {
    runAgentTask: vi.fn(runImpl),
    cancelAgentTask: vi.fn(),
  }
  return { skill: createDocumentAgentSkill(deps), deps }
}

const call = (name: string, input: Record<string, unknown> = {}): AgentToolCall => ({
  id: 'c1',
  name,
  input,
})

describe('the document-agent skill surface', () => {
  it('offers one risk:high tool whose argument is the whole task', () => {
    const { skill } = skillWith()
    expect(skill.tools.map((t) => t.name)).toEqual([DOCUMENT_AGENT_TOOL])
    const tool = skill.tools[0]!
    expect(tool.risk).toBe('high')
    expect(tool.inputSchema).toMatchObject({ required: ['task'] })
    // the guidance states the mandate and its limits
    expect(skill.systemPrompt).toContain('self-contained')
    expect(skill.systemPrompt).toContain('One task at a time')
    expect(skill.systemPrompt).toContain('never claim document changes')
    // the primacy wording: document_agent is the DEFAULT for document work,
    // never a file rewrite behind the app
    expect(skill.systemPrompt).toContain('document_agent is the DEFAULT for')
    expect(skill.systemPrompt).toContain("never rewrite the document's file behind the app")
    expect(skill.systemPrompt).toContain('把这份文档的标题改成《神兽研究》')
    // the tool's own description carries the same primacy
    expect(tool.description).toContain('the FIRST choice for any task about that document')
    expect(tool.description).toContain('NEVER rewrite or replace a file an app has open')
  })

  it('a successful task reports the summary and the edits', async () => {
    const { skill } = skillWith()
    const execution = await skill.executeTool(
      call(DOCUMENT_AGENT_TOOL, { task: 'add a summary section' }),
    )
    expect(execution.isError).toBeUndefined()
    expect(execution.mutated).toBe(true)
    expect(execution.output).toContain('inserted two paragraphs and fixed the heading')
    expect(execution.output).toContain('insert_content: inserted 2 blocks')
    expect(execution.output).toContain('edits (2)')
    expect(execution.summary).toBe('document assistant · 2 edits')
  })

  it('a task that only read reports edits: none', async () => {
    const { skill } = skillWith(async () => ({
      ok: true,
      summary: 'I only analyzed it',
      edits: [],
    }))
    const execution = await skill.executeTool(call(DOCUMENT_AGENT_TOOL, { task: 'analyze' }))
    expect(execution.mutated).toBe(false)
    expect(execution.output).toContain('edits: none')
  })

  it('a refused task (ok false) is an error result carrying the reason', async () => {
    const { skill } = skillWith(async () => ({ ok: false, summary: 'the document is protected' }))
    const execution = await skill.executeTool(call(DOCUMENT_AGENT_TOOL, { task: 'rewrite it' }))
    expect(execution.isError).toBe(true)
    expect(execution.output).toContain('did not finish the task: the document is protected')
  })

  it('the routing and lifetime errors are the tool result', async () => {
    const { skill } = skillWith(() => {
      throw new Error('no Word document is open — open one first')
    })
    const execution = await skill.executeTool(call(DOCUMENT_AGENT_TOOL, { task: 'x' }))
    expect(execution.isError).toBe(true)
    expect(execution.output).toBe('no Word document is open — open one first')
  })

  it('rejects malformed task arguments before anything crosses IPC', async () => {
    const { skill, deps } = skillWith()
    for (const input of [
      {},
      { task: '' },
      { task: 7 },
      { task: 'x'.repeat(MAX_AGENT_TASK_CHARS + 1) },
    ]) {
      const execution = await skill.executeTool(call(DOCUMENT_AGENT_TOOL, input))
      expect(execution.isError, JSON.stringify(input)).toBe(true)
      expect(execution.output, JSON.stringify(input)).toMatch(/`task` must be/)
    }
    expect(deps.runAgentTask).not.toHaveBeenCalled()
  })

  it("the run's abort signal cancels the sub-agent, not just the wait", async () => {
    const { skill, deps } = skillWith()
    const controller = new AbortController()
    const pending = skill.executeTool(
      call(DOCUMENT_AGENT_TOOL, { task: 'draft it' }),
      controller.signal,
    )
    controller.abort()
    await pending
    expect(deps.cancelAgentTask).toHaveBeenCalledTimes(1)
    // the listener detaches after the run settles: a later abort is silent
    controller.abort()
    expect(deps.cancelAgentTask).toHaveBeenCalledTimes(1)
  })

  it('answers an unknown tool with an error', async () => {
    const { skill, deps } = skillWith()
    const execution = await skill.executeTool(call('document_agent_v2'))
    expect(execution.isError).toBe(true)
    expect(execution.output).toContain('unknown tool')
    expect(deps.runAgentTask).not.toHaveBeenCalled()
  })

  it('verifyResponse catches an assistant claim the delegation did not back', () => {
    const { skill } = skillWith()
    const guard = skill.verifyResponse?.bind(skill)
    expect(guard?.('The document assistant restructured the document.', [])).toBeTruthy()
    expect(
      guard?.('The document assistant restructured the document.', [
        { name: DOCUMENT_AGENT_TOOL, ok: true },
      ]),
    ).toBeNull()
    // a denied/failed delegation does not back the claim
    expect(
      guard?.('文档助手 already fixed it.', [{ name: DOCUMENT_AGENT_TOOL, ok: false }]),
    ).toBeTruthy()
    // no delegation mentioned, no claim: accepted
    expect(guard?.('I answered from the document you pasted.', [])).toBeNull()
  })
})
