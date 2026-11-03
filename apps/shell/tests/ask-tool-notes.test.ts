import { describe, expect, it } from 'vitest'

import type { AgentToolCall } from '@genoffice/agent-core'

import { appendToolNote, toolNoteDetail, type ToolNote } from '../src/renderer/src/ask-tool-notes'

function call(name: string, input: Record<string, unknown>): AgentToolCall {
  return { id: `c-${name}`, name, input }
}

const note = (over: Partial<ToolNote> = {}): ToolNote => ({
  label: 'Building a file',
  kind: 'cli',
  count: 1,
  ...over,
})

describe('toolNoteDetail', () => {
  it('names the CLI command and its --out file', () => {
    const detail = toolNoteDetail(
      call('run_genoffice', {
        args: ['slides', 'create', 'spec.json', '--out', '/out/brief.pptx'],
      }),
    )
    expect(detail).toBe('slides create · brief.pptx')
  })

  it('falls back to the file argument of an in-place edit', () => {
    const detail = toolNoteDetail(
      call('run_genoffice', { args: ['docs', 'apply', '/out/report.docx', 'ops.json'] }),
    )
    expect(detail).toBe('docs apply · report.docx')
  })

  it('marks a --help probe and a guide load', () => {
    expect(toolNoteDetail(call('run_genoffice', { args: ['sheet', 'read', '--help'] }))).toBe(
      'sheet read · --help',
    )
    expect(toolNoteDetail(call('load_guide', { domain: 'slides' }))).toBe('guide slides')
  })

  it('resolves a knowledge-base read to the file name', () => {
    const files = ['/kb/a/lease.docx', '/kb/b/notes.md']
    expect(toolNoteDetail(call('read_knowledge_file', { index: 1 }), (i) => files[i])).toBe(
      'notes.md',
    )
    expect(toolNoteDetail(call('read_knowledge_file', { index: '0' }), (i) => files[i])).toBe(
      'lease.docx',
    )
    expect(
      toolNoteDetail(call('read_knowledge_file', { index: 7 }), (i) => files[i]),
    ).toBeUndefined()
  })

  it('leaves a search without detail', () => {
    expect(toolNoteDetail(call('search_knowledge_base', { query: 'rent' }))).toBeUndefined()
  })

  it('names the selector of a browser page action, clipped', () => {
    expect(toolNoteDetail(call('browser:fill_field', { selector: '#q', value: 'rent' }))).toBe(
      'browser · #q',
    )
    expect(toolNoteDetail(call('browser:click_element', { selector: 'a:nth-child(2)' }))).toBe(
      'browser · a:nth-child(2)',
    )
    // a bare selector (or none) still says the domain
    expect(toolNoteDetail(call('browser:click_element', { selector: '   ' }))).toBe('browser')
    expect(toolNoteDetail(call('browser:fill_field', { selector: 'x'.repeat(80) }))).toBe(
      `browser · ${'x'.repeat(40)}`,
    )
  })

  it('a browser read carries no detail (the label says the domain)', () => {
    expect(toolNoteDetail(call('browser:read_page', {}))).toBeUndefined()
    expect(toolNoteDetail(call('browser:screenshot_page', {}))).toBeUndefined()
  })
})

describe('appendToolNote', () => {
  it('folds consecutive calls on the same target into a count', () => {
    let notes: ToolNote[] = []
    notes = appendToolNote(notes, note({ detail: 'slides apply · deck.pptx' }))
    notes = appendToolNote(notes, note({ detail: 'slides apply · deck.pptx' }))
    notes = appendToolNote(notes, note({ detail: 'slides apply · deck.pptx' }))
    expect(notes).toHaveLength(1)
    expect(notes[0]!.count).toBe(3)
  })

  it('keeps a different target or kind as its own chip', () => {
    let notes: ToolNote[] = []
    notes = appendToolNote(notes, note({ detail: 'slides create · deck.pptx' }))
    notes = appendToolNote(notes, note({ detail: 'slides apply · deck.pptx' }))
    notes = appendToolNote(
      notes,
      note({ kind: 'read', label: 'Reading a file', detail: 'deck.pptx' }),
    )
    notes = appendToolNote(notes, note({ detail: 'slides apply · deck.pptx' }))
    expect(notes.map((n) => [n.detail, n.count])).toEqual([
      ['slides create · deck.pptx', 1],
      ['slides apply · deck.pptx', 1],
      ['deck.pptx', 1],
      ['slides apply · deck.pptx', 1],
    ])
  })
})

describe('toolNoteDetail for the capability-completion tools', () => {
  const note = (name: string, input: Record<string, unknown>): string | undefined =>
    toolNoteDetail({ id: 'c1', name, input })

  it('the browser movement/download/annotation tools name their target', () => {
    expect(note('browser:scroll_page', { direction: 'down', amount: 800 })).toBe('browser · down')
    expect(note('browser:scroll_page', { selector: '.feed' })).toBe('browser · .feed')
    expect(note('browser:download_file', { url: 'https://example.com/x.zip' })).toBe(
      'browser · example.com',
    )
    expect(note('browser:go_back', {})).toBe('browser · history')
    expect(note('browser:reload', {})).toBe('browser · history')
    expect(note('browser:press_key', { key: 'enter' })).toBe('browser · enter')
    expect(note('browser:list_annotations', {})).toBe('browser · annotations')
    expect(note('browser:clear_annotations', {})).toBe('browser · annotations')
    // the reads stay bare
    expect(note('browser:read_page', {})).toBeUndefined()
    expect(note('browser:wait_for', { selector: '.r' })).toBeUndefined()
  })

  it('the shell desktop tools name the folder, file, todo or id they touched', () => {
    expect(note('shell:open_folder', { path: '/kb/drafts' })).toBe('shell · drafts')
    expect(note('shell:list_directory', { path: '/kb' })).toBe('shell · kb')
    expect(note('shell:create_folder', { path: '/kb/new' })).toBe('shell · new')
    expect(note('shell:write_text_file', { path: '/kb/a.txt', content: 'x' })).toBe('a.txt')
    expect(note('shell:move_file', { from: '/kb/a.txt', to: '/kb2/a.txt' })).toBe('a.txt')
    expect(note('shell:rename_file', { path: '/kb/a.txt', name: 'b.txt' })).toBe('b.txt')
    expect(note('shell:star_file', { path: '/kb/a.md' })).toBe('a.md')
    expect(note('shell:unstar_file', { path: '/kb/a.md' })).toBe('a.md')
    expect(note('shell:close_tab', { id: 't2' })).toBe('shell · t2')
    expect(note('shell:add_todo', { text: 'buy milk tomorrow' })).toBe('buy milk tomorrow')
    // list_tabs stays bare
    expect(note('shell:list_tabs', {})).toBeUndefined()
  })
})
