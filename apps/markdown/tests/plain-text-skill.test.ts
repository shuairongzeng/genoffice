import { describe, expect, it } from 'vitest'
import { createPlainTextSkill } from '../src/renderer/ai/plain-text-skill'

function makeHarness(initial: string, fileName = 'notes.txt', mode = 'plain') {
  let doc = initial
  const skill = createPlainTextSkill({
    getText: () => doc,
    replaceText: (next) => {
      doc = next
    },
    fileName: () => fileName,
    textMode: () => mode,
  })
  return {
    getText: () => doc,
    skill,
  }
}

describe('createPlainTextSkill', () => {
  it('reads line slices and reports total lines', () => {
    const h = makeHarness('alpha\nbeta\ngamma\ndelta')
    const ctx = h.skill.buildContext()
    expect(ctx).toContain('File: notes.txt | Mode: plain | Lines: 4')
    const res = h.skill.executeTool({ id: '1', name: 'read_text', input: { start_line: 2, end_line: 3 } })
    expect(res.isError).toBeUndefined()
    expect(res.output).toContain('Lines 2-3 of 4')
    expect(res.output).toContain('2: beta\n3: gamma')
  })

  it('searches matching lines case-insensitively by default and respects case_sensitive', () => {
    const h = makeHarness('Error: timeout\ninfo: ok\nerror: retry')
    const ci = h.skill.executeTool({ id: '1', name: 'search_text', input: { query: 'ERROR' } })
    expect(ci.output).toContain('1: Error: timeout')
    expect(ci.output).toContain('3: error: retry')

    const cs = h.skill.executeTool({
      id: '2',
      name: 'search_text',
      input: { query: 'Error', case_sensitive: true },
    })
    expect(cs.output).toContain('1: Error: timeout')
    expect(cs.output).not.toContain('3: error: retry')
  })

  it('rejects ambiguous replace_text unless replace_all is set and preserves CRLF line endings', () => {
    const h = makeHarness('port=8080\r\nbackup=8080\r\n')
    const ambiguous = h.skill.executeTool({
      id: '1',
      name: 'replace_text',
      input: { old_text: '8080', new_text: '9090' },
    })
    expect(ambiguous.isError).toBe(true)
    expect(h.getText()).toBe('port=8080\r\nbackup=8080\r\n')

    const single = h.skill.executeTool({
      id: '2',
      name: 'replace_text',
      input: { old_text: 'port=8080\n', new_text: 'port=9090\n' },
    })
    expect(single.mutated).toBe(true)
    expect(h.getText()).toBe('port=9090\r\nbackup=8080\r\n')

    const all = h.skill.executeTool({
      id: '3',
      name: 'replace_text',
      input: { old_text: '0', new_text: '1', replace_all: true },
    })
    expect(all.mutated).toBe(true)
    expect(h.getText()).toBe('port=9191\r\nbackup=8181\r\n')
  })

  it('edits inclusive line ranges and supports deleting lines', () => {
    const h = makeHarness('line1\r\nline2\r\nline3\r\nline4')
    const replaced = h.skill.executeTool({
      id: '1',
      name: 'edit_lines',
      input: { start_line: 2, end_line: 3, new_text: 'midA\nmidB\nmidC' },
    })
    expect(replaced.mutated).toBe(true)
    expect(h.getText()).toBe('line1\r\nmidA\r\nmidB\r\nmidC\r\nline4')

    const deleted = h.skill.executeTool({
      id: '2',
      name: 'edit_lines',
      input: { start_line: 2, end_line: 4, new_text: '' },
    })
    expect(deleted.mutated).toBe(true)
    expect(h.getText()).toBe('line1\r\nline4')
  })

  it('overwrites entire document cleanly with write_text', () => {
    const h = makeHarness('old\r\ncontent', 'config.json', 'json')
    const res = h.skill.executeTool({
      id: '1',
      name: 'write_text',
      input: { content: '{\n  "ok": true\n}' },
    })
    expect(res.mutated).toBe(true)
    expect(h.getText()).toBe('{\r\n  "ok": true\r\n}')
  })
})
