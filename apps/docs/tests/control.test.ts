import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { handleDocsControl } from '../src/renderer/control'

// module state stands in for the phased-open pipeline: default not pending,
// flipped per-case below to pin the reveal's wait-for-settle guard
vi.mock('../src/renderer/phased-content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/phased-content')>()
  return { ...actual, isPhasedContentPending: vi.fn(() => false) }
})
import { isPhasedContentPending } from '../src/renderer/phased-content'

const editors = new Set<Editor>()
afterEach(() => {
  for (const editor of editors) editor.destroy()
  editors.clear()
})

const para = (text: string) => ({ type: 'docParagraph', content: [{ type: 'text', text }] })

function createEditor(texts: string[]): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: { type: 'doc', content: texts.map(para) },
  })
  editors.add(editor)
  return editor
}

describe('docs control hook', () => {
  it('waits for a document, then selects the requested block', () => {
    const editor = createEditor(['First paragraph.', 'Second paragraph.', 'Third.'])
    expect(handleDocsControl({ cmd: 'selection' }, editor, false)).toEqual({ status: 'not_ready' })
    expect(
      handleDocsControl({ cmd: 'goto', target: { kind: 'block', block: 1 } }, editor, true),
    ).toEqual({
      status: 'ok',
      result: { block: 1, type: 'docParagraph' },
    })
    const { from, to } = editor.state.selection
    expect(editor.state.doc.textBetween(from, to)).toBe('Second paragraph.')
    expect(
      handleDocsControl({ cmd: 'goto', target: { kind: 'block', block: 7 } }, editor, true),
    ).toMatchObject({
      status: 'error',
      error: { reason: 'out_of_range', detail: { valid_range: '0-2' } },
    })
  })

  it('a text target (the search deep link) selects and reports the first match', () => {
    // issue #56: a search hit's cite opens the document where it matched
    const editor = createEditor(['The quarterly numbers.', 'Nothing here.', 'Draft notes.'])
    const reply = handleDocsControl(
      { cmd: 'goto', target: { kind: 'text', text: 'quarterly' } },
      editor,
      true,
    )
    expect(reply.status).toBe('ok')
    if (reply.status !== 'ok') return
    const { from, to } = editor.state.selection
    expect(editor.state.doc.textBetween(from, to)).toBe('quarterly')
    expect(reply.result).toMatchObject({ from, to })
    // a phased open's tail is still appending: the reveal waits for the
    // document to settle, it must not jump at a half-loaded body
    vi.mocked(isPhasedContentPending).mockReturnValueOnce(true)
    expect(
      handleDocsControl({ cmd: 'goto', target: { kind: 'text', text: 'quarterly' } }, editor, true),
    ).toEqual({ status: 'not_ready' })
    // case-insensitive like the find panel the text comes from — the match
    // lands on the actual casing, the query's casing is only the needle
    const folded = handleDocsControl(
      { cmd: 'goto', target: { kind: 'text', text: 'DRAFT' } },
      editor,
      true,
    )
    expect(folded.status).toBe('ok')
    if (folded.status !== 'ok') return
    const sel = editor.state.selection
    expect(editor.state.doc.textBetween(sel.from, sel.to)).toBe('Draft')
    // width-folding like the find panel's default: a full-width needle lands
    // on half-width document text, the same surface Ctrl+F offers
    const wide = handleDocsControl(
      { cmd: 'goto', target: { kind: 'text', text: 'ＱＵＡＲＴＥＲＬＹ' } },
      editor,
      true,
    )
    expect(wide.status).toBe('ok')
    if (wide.status !== 'ok') return
    const wsel = editor.state.selection
    expect(editor.state.doc.textBetween(wsel.from, wsel.to)).toBe('quarterly')
  })

  it('a text target that does not occur is target_not_found, an empty one invalid', () => {
    const editor = createEditor(['Alpha.'])
    expect(
      handleDocsControl({ cmd: 'goto', target: { kind: 'text', text: 'needle' } }, editor, true),
    ).toMatchObject({ status: 'error', error: { reason: 'target_not_found' } })
    expect(
      handleDocsControl({ cmd: 'goto', target: { kind: 'text', text: '  ' } }, editor, true),
    ).toMatchObject({ status: 'error', error: { reason: 'invalid_argument' } })
    // no document yet: not_ready, the same as every other goto
    expect(
      handleDocsControl({ cmd: 'goto', target: { kind: 'text', text: 'needle' } }, editor, false),
    ).toEqual({ status: 'not_ready' })
  })

  it('reports the selected block range and text', () => {
    const editor = createEditor(['Alpha beta.', 'Gamma delta.', 'Epsilon.'])
    const block0 = editor.state.doc.child(0).nodeSize
    editor.commands.setTextSelection({ from: 3, to: block0 + 6 })
    expect(handleDocsControl({ cmd: 'selection' }, editor, true)).toEqual({
      status: 'ok',
      result: { blocks: [0, 1], text: 'pha beta.\nGamma', collapsed: false },
    })
    editor.commands.setTextSelection(block0 + 2)
    expect(handleDocsControl({ cmd: 'selection' }, editor, true)).toEqual({
      status: 'ok',
      result: { blocks: [1, 1], text: '', collapsed: true },
    })
    // a caret at the very end of the document still belongs to the last block
    editor.commands.setTextSelection(editor.state.doc.content.size)
    expect(handleDocsControl({ cmd: 'selection' }, editor, true)).toMatchObject({
      status: 'ok',
      result: { blocks: [2, 2], collapsed: true },
    })
    // a whole-paragraph selection ends on the next block's boundary and must not count it
    editor.commands.setTextSelection({ from: 1, to: block0 })
    expect(handleDocsControl({ cmd: 'selection' }, editor, true)).toEqual({
      status: 'ok',
      result: { blocks: [0, 0], text: 'Alpha beta.', collapsed: false },
    })
  })
})
