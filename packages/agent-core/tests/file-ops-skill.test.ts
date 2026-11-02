import { describe, expect, it, vi } from 'vitest'
import type { AgentSkill } from '../src/skill'
import type { AgentToolCall } from '../src/types'
import {
  DELETE_FILE_TOOL,
  EDIT_FILE_TOOL,
  MAX_EDIT_PATCH_CHARS,
  createFileOpsSkill,
  type EditFileRequest,
  type FileOpsDeps,
} from '../src'

/**
 * The dock's file operator skill: the write powers over the kb-scoped text
 * files — edit_file (a patch-style, risk:'high', session-allowable edit) and
 * delete_file (the OS trash, risk:'always-ask' — gated on every call, never
 * session-allowed). The risk grades ride the tool defs the loop gates on;
 * the executor validates the model's input before anything crosses IPC, and
 * a main-side refusal (scope, not found, ambiguous) is the tool result.
 */

interface Harness {
  skill: AgentSkill
  deps: FileOpsDeps
}

function skillWith(
  editImpl: (request: EditFileRequest) => {
    path: string
    occurrences: number
    bytes: number
  } = () => ({
    path: '/docs/report.md',
    occurrences: 1,
    bytes: 100,
  }),
  deleteImpl: (path: string) => { path: string } = () => ({ path: '/docs/report.md' }),
): Harness {
  const deps: FileOpsDeps = {
    editFile: vi.fn(async (request) => editImpl(request)),
    deleteFile: vi.fn(async (path) => deleteImpl(path)),
  }
  return { skill: createFileOpsSkill(deps), deps }
}

const call = (name: string, input: Record<string, unknown> = {}): AgentToolCall => ({
  id: 'c1',
  name,
  input,
})

describe('the file-ops skill surface', () => {
  it('offers edit_file as risk:high and delete_file as risk:always-ask', () => {
    const { skill } = skillWith()
    expect(skill.tools.map((t) => t.name)).toEqual([EDIT_FILE_TOOL, DELETE_FILE_TOOL])
    const byName = new Map(skill.tools.map((t) => [t.name, t]))
    expect(byName.get(EDIT_FILE_TOOL)!.risk).toBe('high')
    // destructive: the host never offers always-allow for it
    expect(byName.get(DELETE_FILE_TOOL)!.risk).toBe('always-ask')
    expect(byName.get(EDIT_FILE_TOOL)!.inputSchema).toMatchObject({
      required: ['path', 'old_string', 'new_string'],
    })
    expect(byName.get(DELETE_FILE_TOOL)!.inputSchema).toMatchObject({ required: ['path'] })
    // the prompt states the read-first rule and the destructive grade
    expect(skill.systemPrompt).toContain('edit_file')
    expect(skill.systemPrompt).toContain('asks the person every')
    expect(skill.systemPrompt).toContain('quote it exactly')
  })

  it('edit_file routes a valid patch and reports what changed', async () => {
    const { skill, deps } = skillWith(() => ({ path: '/docs/notes.md', occurrences: 1, bytes: 42 }))
    const execution = await skill.executeTool(
      call(EDIT_FILE_TOOL, {
        path: '/docs/notes.md',
        old_string: 'old text',
        new_string: 'new text',
      }),
    )
    expect(deps.editFile).toHaveBeenCalledWith({
      path: '/docs/notes.md',
      oldString: 'old text',
      newString: 'new text',
    })
    expect(execution.isError).toBeUndefined()
    expect(execution.mutated).toBe(true)
    expect(execution.output).toContain('edited notes.md')
    expect(execution.output).toContain('replaced 1 occurrence')
    expect(execution.output).toContain('42 bytes')
    expect(execution.summary).toBe('edited notes.md')
  })

  it('edit_file with replace_all forwards the flag', async () => {
    const { skill, deps } = skillWith()
    await skill.executeTool(
      call(EDIT_FILE_TOOL, { path: '/x.md', old_string: 'a', new_string: 'b', replace_all: true }),
    )
    expect(deps.editFile).toHaveBeenCalledWith({
      path: '/x.md',
      oldString: 'a',
      newString: 'b',
      replaceAll: true,
    })
    // absent stays absent: the single-match rule is the default
    await skill.executeTool(
      call(EDIT_FILE_TOOL, { path: '/x.md', old_string: 'a', new_string: 'b' }),
    )
    expect(deps.editFile).toHaveBeenLastCalledWith({
      path: '/x.md',
      oldString: 'a',
      newString: 'b',
    })
  })

  it('edit_file rejects malformed patches before anything crosses IPC', async () => {
    const { skill, deps } = skillWith()
    const bad: Array<Record<string, unknown>> = [
      { path: '', old_string: 'a', new_string: 'b' },
      { path: '/x.md', old_string: '', new_string: 'b' },
      { path: '/x.md', old_string: 'a', new_string: 'a' },
      { path: '/x.md', old_string: 'a', new_string: 7 },
      { path: '/x.md', old_string: 'a', new_string: 'b', replace_all: 'yes' },
      { path: '/x.md', old_string: 'x'.repeat(MAX_EDIT_PATCH_CHARS + 1), new_string: 'b' },
      { path: '/x.md', old_string: 'a', new_string: 'y'.repeat(MAX_EDIT_PATCH_CHARS + 1) },
      { old_string: 'a', new_string: 'b' },
    ]
    for (const input of bad) {
      const execution = await skill.executeTool(call(EDIT_FILE_TOOL, input))
      expect(execution.isError, JSON.stringify(input)).toBe(true)
      expect(execution.output, JSON.stringify(input)).toMatch(
        /`(?:path|old_string|new_string|replace_all)`|identical/,
      )
    }
    expect(deps.editFile).not.toHaveBeenCalled()
  })

  it('a main-side refusal (scope, not found, ambiguous) is the tool result', async () => {
    const { skill } = skillWith(() => {
      throw new Error('old_string matches 3 places in "notes.md" — include more surrounding text')
    })
    const execution = await skill.executeTool(
      call(EDIT_FILE_TOOL, { path: '/x.md', old_string: 'a', new_string: 'b' }),
    )
    expect(execution.isError).toBe(true)
    expect(execution.output).toContain('matches 3 places')
  })

  it('delete_file routes the path and reports where the file went', async () => {
    const { skill, deps } = skillWith(undefined, () => ({ path: '/docs/notes.md' }))
    const execution = await skill.executeTool(call(DELETE_FILE_TOOL, { path: '/docs/notes.md' }))
    expect(deps.deleteFile).toHaveBeenCalledWith('/docs/notes.md')
    expect(execution.mutated).toBe(true)
    expect(execution.output).toContain('moved notes.md to the OS trash')
    expect(execution.summary).toBe('deleted notes.md')
    // a bad path or a main-side refusal is an error result, not a crash
    const bad = await skill.executeTool(call(DELETE_FILE_TOOL, { path: '' }))
    expect(bad.isError).toBe(true)
  })

  it('answers an unknown tool with an error', async () => {
    const { skill, deps } = skillWith()
    const execution = await skill.executeTool(call('rename_file'))
    expect(execution.isError).toBe(true)
    expect(execution.output).toContain('unknown file-ops tool')
    expect(deps.editFile).not.toHaveBeenCalled()
    expect(deps.deleteFile).not.toHaveBeenCalled()
  })

  it('verifyResponse catches a deletion claim no successful delete backs', () => {
    const { skill } = skillWith()
    const guard = skill.verifyResponse?.bind(skill)
    expect(guard?.('I deleted the file as you asked.', [])).toBeTruthy()
    expect(
      guard?.('I deleted the file as you asked.', [{ name: DELETE_FILE_TOOL, ok: true }]),
    ).toBeNull()
    // a declined delete is not a success: the claim is still wrong
    expect(guard?.('I have deleted it.', [{ name: DELETE_FILE_TOOL, ok: false }])).toBeTruthy()
    // passive voice claims count too
    expect(
      guard?.('The file has been moved to the trash.', [{ name: EDIT_FILE_TOOL, ok: true }]),
    ).toBeTruthy()
    // a noun phrase about a past state is not a claim about this run
    expect(guard?.('The deleted draft was recoverable.', [])).toBeNull()
  })
})
