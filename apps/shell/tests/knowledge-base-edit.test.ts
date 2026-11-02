import { describe, expect, it, vi } from 'vitest'
import {
  applyKnowledgeFileEdit,
  KB_EDIT_MAX_FILE_BYTES,
  KB_EDIT_MAX_PATCH_CHARS,
  parseKbDeleteRequest,
  parseKbEditRequest,
  type KbEditDeps,
} from '../src/main/knowledge-base'

/**
 * The edit_file half of the ask panel's write powers (knowledge-base.ts):
 * the patch shape — the exact old-string must occur once (more is ambiguous
 * without replace_all, none means the file moved under the model and it must
 * re-read), the patched text is written back whole, and the answer reports
 * what actually changed. Payload validation holds the same rules as the
 * kb:read scope's (absolute paths, length caps), and delete's payload also
 * carries the confirmation fact the main side fails closed on.
 */

function makeDeps(files: Record<string, string>) {
  const statFile = vi.fn((path: string) => {
    const text = files[path]
    return text === undefined ? null : { size: Buffer.byteLength(text, 'utf8'), isFile: () => true }
  })
  const readFile = vi.fn(async (path: string) => {
    const text = files[path]
    if (text === undefined) throw new Error('missing')
    return text
  })
  const written: Array<[string, string]> = []
  const writeFile = vi.fn(async (path: string, text: string) => void written.push([path, text]))
  const deps: KbEditDeps = { statFile, readFile, writeFile }
  return { deps, statFile, readFile, written }
}

describe('parseKbEditRequest', () => {
  it('keeps a valid patch and folds replace_all to a boolean', () => {
    expect(
      parseKbEditRequest({
        path: '/docs/a.md',
        old_string: 'x',
        new_string: 'y',
        replace_all: true,
      }),
    ).toEqual({ path: '/docs/a.md', oldString: 'x', newString: 'y', replaceAll: true })
    expect(parseKbEditRequest({ path: '/docs/a.md', old_string: 'x', new_string: 'y' })).toEqual({
      path: '/docs/a.md',
      oldString: 'x',
      newString: 'y',
    })
    // an empty new_string is a cut, not an error
    expect(
      parseKbEditRequest({ path: '/docs/a.md', old_string: 'x', new_string: '' }).newString,
    ).toBe('')
  })

  it('rejects relative paths, blanks, no-ops, and oversized patches', () => {
    expect(() => parseKbEditRequest({ path: 'a.md', old_string: 'x', new_string: 'y' })).toThrow(
      /absolute/,
    )
    expect(() => parseKbEditRequest({ old_string: 'x', new_string: 'y' })).toThrow(/path/)
    expect(() => parseKbEditRequest({ path: '/a.md', old_string: '', new_string: 'y' })).toThrow(
      /old_string/,
    )
    expect(() => parseKbEditRequest({ path: '/a.md', old_string: 'x' })).toThrow(/new_string/)
    expect(() => parseKbEditRequest({ path: '/a.md', old_string: 'x', new_string: 'x' })).toThrow(
      /identical/,
    )
    expect(() =>
      parseKbEditRequest({
        path: '/a.md',
        old_string: 'x'.repeat(KB_EDIT_MAX_PATCH_CHARS + 1),
        new_string: 'y',
      }),
    ).toThrow(/too long/)
    expect(() => parseKbEditRequest(null)).toThrow(/path/)
  })
})

describe('parseKbDeleteRequest', () => {
  it('validates the path and reports the confirmation fact', () => {
    expect(parseKbDeleteRequest({ path: '/docs/a.md', confirmed: true })).toEqual({
      path: '/docs/a.md',
      confirmed: true,
    })
    expect(parseKbDeleteRequest({ path: '/docs/a.md' }).confirmed).toBe(false)
    expect(parseKbDeleteRequest({ path: '/docs/a.md', confirmed: 'true' }).confirmed).toBe(false)
    expect(() => parseKbDeleteRequest({ path: 'a.md', confirmed: true })).toThrow(/absolute/)
    expect(() => parseKbDeleteRequest(null)).toThrow(/path/)
  })
})

describe('applyKnowledgeFileEdit', () => {
  it('replaces the one exact occurrence and writes the patched whole', async () => {
    const { deps, written } = makeDeps({ '/docs/a.md': '# Title\n\nold text\n\nbye' })
    const result = await applyKnowledgeFileEdit(deps, {
      path: '/docs/a.md',
      oldString: 'old text',
      newString: 'new text',
    })
    expect(result).toEqual({ path: '/docs/a.md', occurrences: 1, bytes: 22 })
    expect(written).toEqual([['/docs/a.md', '# Title\n\nnew text\n\nbye']])
  })

  it('an empty new_string cuts the old text out (a small cut stays legal)', async () => {
    const { deps, written } = makeDeps({ '/docs/a.md': 'keep thisdrop this' })
    const result = await applyKnowledgeFileEdit(deps, {
      path: '/docs/a.md',
      oldString: 'drop this',
      newString: '',
    })
    expect(result.occurrences).toBe(1)
    expect(written).toEqual([['/docs/a.md', 'keep this']])
  })

  it('a patch that would empty the whole file is refused with the delete_file hint (HIGH-2)', async () => {
    const { deps, written } = makeDeps({
      '/docs/whole.md': 'the entire content',
      '/docs/blankish.md': '   ',
    })
    // old_string spanning everything with an empty new_string
    await expect(
      applyKnowledgeFileEdit(deps, {
        path: '/docs/whole.md',
        oldString: 'the entire content',
        newString: '',
      }),
    ).rejects.toThrow(/would become empty.*delete_file/)
    // old_string === the entire text (the same outcome from the other side)
    await expect(
      applyKnowledgeFileEdit(deps, {
        path: '/docs/whole.md',
        oldString: 'the entire content',
        newString: '',
        replaceAll: true,
      }),
    ).rejects.toThrow(/deletion, not an edit/)
    // a file that would be left blank (whitespace only) is the same refusal
    await expect(
      applyKnowledgeFileEdit(deps, {
        path: '/docs/blankish.md',
        oldString: '   ',
        newString: '',
      }),
    ).rejects.toThrow(/delete_file/)
    // nothing was written in any of them
    expect(written).toEqual([])
  })

  it('replacing the entire text with NON-empty content stays legal (a rewrite, not a delete)', async () => {
    const { deps, written } = makeDeps({ '/docs/a.md': 'old content' })
    await applyKnowledgeFileEdit(deps, {
      path: '/docs/a.md',
      oldString: 'old content',
      newString: 'brand new content',
    })
    expect(written).toEqual([['/docs/a.md', 'brand new content']])
  })

  it('not found is the model-facing error that says to re-read', async () => {
    const { deps, written } = makeDeps({ '/docs/a.md': 'other' })
    await expect(
      applyKnowledgeFileEdit(deps, { path: '/docs/a.md', oldString: 'gone', newString: 'x' }),
    ).rejects.toThrow(/was not found.*read_knowledge_file/)
    expect(written).toEqual([])
  })

  it('several matches without replace_all are an ambiguity error with the count', async () => {
    const { deps, written } = makeDeps({ '/docs/a.md': 'x x x' })
    await expect(
      applyKnowledgeFileEdit(deps, { path: '/docs/a.md', oldString: 'x', newString: 'y' }),
    ).rejects.toThrow(/matches 3 places.*replace_all/)
    expect(written).toEqual([])
  })

  it('replace_all changes every occurrence', async () => {
    const { deps, written } = makeDeps({ '/docs/a.md': 'x x x' })
    const result = await applyKnowledgeFileEdit(deps, {
      path: '/docs/a.md',
      oldString: 'x',
      newString: 'yy',
      replaceAll: true,
    })
    expect(result.occurrences).toBe(3)
    expect(written).toEqual([['/docs/a.md', 'yy yy yy']])
  })

  it('a missing file, binary content, and oversize are plain refusals', async () => {
    const { deps } = makeDeps({
      '/docs/bin.md': 'text\u0000with nul',
      [`${'/docs/big.md'}`]: 'a'.repeat(KB_EDIT_MAX_FILE_BYTES + 1),
    })
    await expect(
      applyKnowledgeFileEdit(deps, { path: '/docs/none.md', oldString: 'a', newString: 'b' }),
    ).rejects.toThrow(/not an editable file/)
    await expect(
      applyKnowledgeFileEdit(deps, { path: '/docs/bin.md', oldString: 'text', newString: 'b' }),
    ).rejects.toThrow(/binary/)
    await expect(
      applyKnowledgeFileEdit(deps, {
        path: '/docs/big.md',
        oldString: 'a',
        newString: 'b',
        replaceAll: true,
      }),
    ).rejects.toThrow(/too large to edit/)
  })
})
