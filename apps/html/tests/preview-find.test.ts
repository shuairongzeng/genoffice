/**
 * Issue #56 P2 #8 — find-in-preview: the panel searches a text mirror the
 * frame's inspector pushes. These pin the mirror math (a hit spanning two
 * nodes is ONE hit with two pieces; block boundaries join through a '\n' so
 * whole-word matching survives block edges) and the controller's message
 * contract against a fake post.
 */
import { describe, expect, it, vi } from 'vitest'
import { PreviewFindController, searchMirror } from '../src/renderer/preview/preview-find'
import type { ToInspector } from '../src/renderer/preview/inspector-protocol'

const nodes = (
  spec: Array<[number, string, string?]>,
): Array<{ id: number; text: string; sep?: string }> =>
  spec.map(([id, text, sep]) => (sep === undefined ? { id, text } : { id, text, sep }))

describe('searchMirror (issue #56 P2 #8)', () => {
  it('matches across node boundaries: inline runs read continuously', () => {
    // <b>Hel</b>lo — the reader sees "Hello", so 'llo' is one hit in two pieces
    const m = searchMirror(
      nodes([
        [1, 'Hel'],
        [2, 'lo'],
      ]),
      'llo',
      {
        matchCase: false,
        wholeWord: false,
      },
    )
    expect(m.count).toBe(1)
    expect(m.matches).toEqual([
      [
        { id: 1, start: 2, end: 3 },
        { id: 2, start: 0, end: 2 },
      ],
    ])
  })

  it('a multi-node match and a later single-node one keep their own groups', () => {
    // the piece/index mismatch class: match 1 spans two nodes, match 2 does
    // not — activating match 2 must address group 2, never match 1's tail
    const m = searchMirror(
      nodes([
        [1, 'Hel'],
        [2, 'lo wo'],
        [3, 'hello'],
      ]),
      'hello',
      { matchCase: false, wholeWord: false },
    )
    expect(m.count).toBe(2)
    expect(m.matches).toEqual([
      [
        { id: 1, start: 0, end: 3 },
        { id: 2, start: 0, end: 2 },
      ],
      [{ id: 3, start: 0, end: 5 }],
    ])
  })

  it('threads findInText semantics: case folding and whole words', () => {
    const mirror = nodes([[1, 'Hello world']])
    expect(searchMirror(mirror, 'hello', { matchCase: false, wholeWord: false }).count).toBe(1)
    expect(searchMirror(mirror, 'hello', { matchCase: true, wholeWord: false }).count).toBe(0)
    expect(searchMirror(mirror, 'or', { matchCase: false, wholeWord: true }).count).toBe(0)
    expect(searchMirror(mirror, 'world', { matchCase: false, wholeWord: true }).count).toBe(1)
  })

  it('splits a three-node hit per node and skips zero-length nodes mid-match', () => {
    const m = searchMirror(
      nodes([
        [1, 'ab'],
        [2, ''],
        [3, 'cd'],
      ]),
      'abcd',
      {
        matchCase: false,
        wholeWord: false,
      },
    )
    expect(m.count).toBe(1)
    expect(m.matches).toEqual([
      [
        { id: 1, start: 0, end: 2 },
        { id: 3, start: 0, end: 2 },
      ],
    ])
  })

  it('counts multiple hits and addresses each in its own node', () => {
    const m = searchMirror(
      nodes([
        [1, 'one'],
        [2, 'two'],
        [3, 'one'],
      ]),
      'one',
      {
        matchCase: false,
        wholeWord: false,
      },
    )
    expect(m.count).toBe(2)
    expect(m.matches).toEqual([[{ id: 1, start: 0, end: 3 }], [{ id: 3, start: 0, end: 3 }]])
  })

  it('a block-boundary sep lets whole words match the last word of a block', () => {
    // <p>Results</p><p>2024</p> — the frame pushes the second node with a '\n':
    // "Results" is alone on its line, so whole-word must find it. Without the
    // sep the join reads "Results2024" and whole-word fails — the frame side
    // (inspector-find.test.ts) pins that the sep is actually produced
    const withSep = searchMirror(
      nodes([
        [1, 'Results'],
        [2, '2024', '\n'],
      ]),
      'Results',
      { matchCase: false, wholeWord: true },
    )
    expect(withSep.count).toBe(1)
    const withoutSep = searchMirror(
      nodes([
        [1, 'Results'],
        [2, '2024'],
      ]),
      'Results',
      { matchCase: false, wholeWord: true },
    )
    expect(withoutSep.count).toBe(0)
  })

  it('pieces are offset by the separators before them', () => {
    const m = searchMirror(
      nodes([
        [1, 'one'],
        [2, '\nmid', '\n'],
        [3, 'two', '\n'],
      ]),
      'mid',
      { matchCase: false, wholeWord: true },
    )
    expect(m.matches).toEqual([[{ id: 2, start: 1, end: 4 }]])
  })

  it('empty query or empty mirror finds nothing', () => {
    expect(searchMirror(nodes([[1, 'x']]), '', { matchCase: false, wholeWord: false })).toEqual({
      count: 0,
      matches: [],
    })
    expect(searchMirror([], 'x', { matchCase: false, wholeWord: false })).toEqual({
      count: 0,
      matches: [],
    })
  })
})

describe('PreviewFindController (issue #56 P2 #8)', () => {
  const mount = () => {
    const post = vi.fn()
    return { controller: new PreviewFindController(post as (msg: ToInspector) => void), post }
  }

  it('start turns reporting on; stop also clears the painted marks', () => {
    const { controller, post } = mount()
    controller.start()
    controller.stop()
    expect(post.mock.calls).toEqual([
      [{ type: 'gx:setDocText', on: true }],
      [{ type: 'gx:findClear' }],
      [{ type: 'gx:setDocText', on: false }],
    ])
  })

  it('search marks per-match groups with a clamped active and returns the count synchronously', () => {
    const { controller, post } = mount()
    controller.onDocText(
      nodes([
        [1, 'Hel'],
        [2, 'lo wo'],
      ]),
    )
    const target = controller.findTarget()
    const count = target.search('wo', { matchCase: false, wholeWord: false }, 99)
    expect(count).toBe(1)
    expect(post).toHaveBeenCalledWith({
      type: 'gx:findMark',
      matches: [[{ id: 2, start: 3, end: 5 }]],
      active: 0,
      scroll: true,
    })
    expect(target.editable).toBe(false)
  })

  it('a rescan with the same context repaints without scrolling; a moved context scrolls', () => {
    const { controller, post } = mount()
    controller.onDocText(nodes([[1, 'one two one']]))
    const target = controller.findTarget()
    target.search('one', { matchCase: false, wholeWord: false }, 0)
    // the doc changed underneath and the panel rescans: same needle, same
    // active — a repaint in place, not a scroll
    controller.onDocText(nodes([[1, 'one two one']]))
    target.search('one', { matchCase: false, wholeWord: false }, 0)
    expect(post).toHaveBeenLastCalledWith({
      type: 'gx:findMark',
      matches: [[{ id: 1, start: 0, end: 3 }], [{ id: 1, start: 8, end: 11 }]],
      active: 0,
      scroll: false,
    })
    // navigation moved the active match: the next rescan scrolls again
    target.search('one', { matchCase: false, wholeWord: false }, 1)
    expect(post).toHaveBeenLastCalledWith({
      type: 'gx:findMark',
      matches: [[{ id: 1, start: 0, end: 3 }], [{ id: 1, start: 8, end: 11 }]],
      active: 1,
      scroll: true,
    })
    // a new needle scrolls even at the same index
    target.search('two', { matchCase: false, wholeWord: false }, 0)
    expect(post).toHaveBeenLastCalledWith({
      type: 'gx:findMark',
      matches: [[{ id: 1, start: 4, end: 7 }]],
      active: 0,
      scroll: true,
    })
  })

  it('search before any snapshot reports zero matches and marks nothing', () => {
    const { controller, post } = mount()
    const target = controller.findTarget()
    expect(target.search('wo', { matchCase: false, wholeWord: false }, 0)).toBe(0)
    expect(post).toHaveBeenCalledWith({
      type: 'gx:findMark',
      matches: [],
      active: -1,
      scroll: true,
    })
  })

  it('a forged docText payload is dropped or sanitized, never trusted', () => {
    const { controller, post } = mount()
    const listener = vi.fn()
    controller.findTarget().onDocChanged(listener)
    // not an array at all: the mirror keeps its previous contents
    controller.onDocText(null)
    controller.onDocText('nope')
    expect(listener).not.toHaveBeenCalled()
    // malformed entries are skipped, a bogus sep is stripped, survivors stay
    controller.onDocText([
      { id: 1, text: 'ok' },
      { id: 'two', text: 'bad id' },
      { text: 'no id' },
      { id: 3, text: null },
      { id: 4, text: 'bad sep', sep: ' \n ' },
      null,
    ])
    expect(listener).toHaveBeenCalledTimes(1)
    expect(controller.findTarget().search('ok', { matchCase: false, wholeWord: false }, 0)).toBe(1)
    // 'bad sep' survived with its separator stripped
    expect(post).toHaveBeenLastCalledWith({
      type: 'gx:findMark',
      matches: [[{ id: 1, start: 0, end: 2 }]],
      active: 0,
      scroll: true,
    })
    expect(
      controller.findTarget().search('bad sep', { matchCase: false, wholeWord: false }, 0),
    ).toBe(1)
    // only the '\n' separator is the frame's vocabulary: anything else in a
    // payload is a forged attempt to wedge match offsets into the gaps
    controller.onDocText([
      { id: 9, text: 'a', sep: '\n' },
      { id: 10, text: 'b', sep: 'x' },
    ])
    expect(controller.findTarget().search('a', { matchCase: false, wholeWord: false }, 0)).toBe(1)
  })

  it('a query containing the separator cannot produce a negative piece offset', () => {
    // a caller passing a newline in the query (the panel input cannot) would
    // match inside the gap between nodes: the piece math must clamp, never
    // hand the frame a range with a negative start
    const m = searchMirror(
      nodes([
        [1, 'a'],
        [2, 'b', '\n'],
      ]),
      '\n',
      { matchCase: false, wholeWord: false },
    )
    expect(m.count).toBe(0)
    expect(m.matches).toEqual([])
  })

  it('a payload beyond the total-size cap is truncated (prefix kept, warn logged), not dropped whole', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { controller } = mount()
      controller.onDocText([
        { id: 1, text: 'x'.repeat(999_999) },
        { id: 2, text: 'yy' },
        { id: 3, text: 'dropped tail' },
      ])
      // the first node fit; the second kept its one-character prefix; the
      // third never made it in — and the search join never throws
      expect(
        controller.findTarget().search('x'.repeat(10), { matchCase: false, wholeWord: false }, 0),
      ).toBe(99_999)
      expect(controller.findTarget().search('y', { matchCase: false, wholeWord: false }, 0)).toBe(1)
      expect(
        controller.findTarget().search('dropped', { matchCase: false, wholeWord: false }, 0),
      ).toBe(0)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('activate, clear and the doc-changed subscription round the contract', () => {
    const { controller, post } = mount()
    const target = controller.findTarget()
    target.activate(2)
    target.clear()
    expect(post.mock.calls).toEqual([
      [{ type: 'gx:findActivate', active: 2 }],
      [{ type: 'gx:findClear' }],
    ])
    const listener = vi.fn()
    const off = target.onDocChanged(listener)
    controller.onDocText(nodes([[1, 'x']]))
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    controller.onDocText(nodes([[1, 'y']]))
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('findTarget returns ONE instance: re-opening the panel is not a retarget', () => {
    // the host hands the panel this target on every Cmd+F. A fresh object per
    // call would read as a retarget — the panel would clear the painted marks
    // and re-run its debounced scan on every keystroke that re-opens an open
    // panel (the source editor caches its target the same way)
    const { controller } = mount()
    expect(controller.findTarget()).toBe(controller.findTarget())
    controller.onDocText(nodes([[1, 'x']]))
    expect(controller.findTarget()).toBe(controller.findTarget())
  })
})
