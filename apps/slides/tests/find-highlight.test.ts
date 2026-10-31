/**
 * Issue #56 P1 #7 — the slides find trio: per-keystroke full-deck rescans
 * (now 150ms-settled + memoized), hits that only selected the shape (now
 * run-level text spans the canvas highlights), and ⌘F dead while editing
 * (pinned in keyboard-actions.test.ts). This file pins the span math — the
 * count must stay the old joined-text count — and the debounce wiring.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type {
  GroupRenderNode,
  RenderSlide,
  ShapeRenderNode,
  TableRenderNode,
} from '@genoffice/pptx-render'
import { buildMatches, FindReplaceDialog } from '../src/renderer/components/FindReplaceDialog'
import { layoutGlyphs, layoutGlyphsWithFind } from '../src/renderer/konva-adapter'

const HIT = 'rgba(255,205,0,0.45)'

type Runish = Record<string, unknown>
const run = (text: string, x: number, w: number, over: Runish = {}): Runish => ({
  text,
  x,
  baselineY: 20,
  fontFamily: 'Arial',
  fontSizePx: 24,
  color: '#000',
  bold: false,
  italic: false,
  underline: false,
  widthPx: w,
  ...over,
})
const line = (runs: Runish[], top = 0, height = 28, over: Runish = {}): Runish => ({
  runs,
  top,
  height,
  paraStart: true,
  ...over,
})
const layout = (lines: Runish[]): Record<string, unknown> => ({
  lines,
  insets: { l: 0, t: 0, r: 0, b: 0 },
  anchor: 'top',
  fontScale: 1,
  contentHeight: 28,
  wrap: true,
})

const BOX = { x: 0, y: 0, w: 400, h: 80, rotationDeg: 0, flipH: false, flipV: false }
const textNode = (id: string, text: Record<string, unknown>): ShapeRenderNode =>
  ({
    id,
    sourceId: id,
    type: 'shape',
    box: BOX,
    fill: { kind: 'none' },
    text,
  }) as unknown as ShapeRenderNode

/** 'Hel' | 'lo wo' on line 1, 'rld' on line 2 → layoutText 'Hello wo\nrld' */
const THREE_RUNS = layout([
  line([run('Hel', 0, 30), run('lo wo', 30, 50)]),
  line([run('rld', 0, 30)], 28),
])

const slideOf = (...nodes: unknown[]): RenderSlide =>
  ({ widthPx: 1280, heightPx: 720, scale: 1, nodes }) as unknown as RenderSlide

describe('buildMatches spans (issue #56 P1 #7)', () => {
  it('points a span at the run and char range the hit sits in', () => {
    const m = buildMatches([slideOf(textNode('e0', THREE_RUNS))], 'wo', false)
    expect(m).toHaveLength(1)
    expect(m[0]!.count).toBe(1)
    expect(m[0]!.sourceId).toBe('e0')
    // 'wo' is chars 3..5 of the second run ('lo wo'), flat index 1 over the
    // layout's runs in layoutGlyphs order
    expect(m[0]!.spans).toEqual([{ runIdx: 1, start: 3, end: 5 }])
  })

  it('splits a hit that crosses a paragraph separator into one span per run', () => {
    // the single-line input cannot type this, but the exported function must
    // not glue text across a gap no run covers
    const m = buildMatches([slideOf(textNode('e0', THREE_RUNS))], 'o\nr', false)
    expect(m[0]!.count).toBe(1)
    expect(m[0]!.spans).toEqual([
      { runIdx: 1, start: 4, end: 5 },
      { runIdx: 2, start: 0, end: 1 },
    ])
  })

  it('honors matchCase and keeps the count the old joined-text count gave', () => {
    const slides = [slideOf(textNode('e0', THREE_RUNS))]
    expect(buildMatches(slides, 'hel', true)).toHaveLength(0)
    expect(buildMatches(slides, 'hel', false)).toHaveLength(1)
    // three hits in one element ('l' twice in 'Hello', once in 'rld'): one
    // match carrying count 3 — the old joined-text count
    expect(buildMatches(slides, 'l', false)[0]!.count).toBe(3)
  })

  it('tags table spans with their cell and keeps per-cell counting', () => {
    const table = {
      id: 't0',
      sourceId: 't0',
      type: 'table',
      box: BOX,
      gridX: [0, 200],
      gridY: [0, 40],
      cells: [
        { row: 0, col: 0, x: 0, y: 0, w: 200, h: 40, text: layout([line([run('cat', 0, 30)])]) },
        { row: 1, col: 0, x: 0, y: 40, w: 200, h: 40, text: layout([line([run('cat', 0, 30)])]) },
      ],
    } as unknown as TableRenderNode
    const m = buildMatches([slideOf(table)], 'cat', false)
    expect(m).toHaveLength(1)
    expect(m[0]!.count).toBe(2)
    expect(m[0]!.spans).toEqual([
      { runIdx: 0, start: 0, end: 3, cell: { row: 0, col: 0 } },
      { runIdx: 0, start: 0, end: 3, cell: { row: 1, col: 0 } },
    ])
  })

  it('group hits keep the joined-text count but carry no spans', () => {
    const group = {
      id: 'g0',
      sourceId: 'g0',
      type: 'group',
      box: BOX,
      children: [textNode('c0', layout([line([run('cat', 0, 30)])]))],
    } as unknown as GroupRenderNode
    const m = buildMatches([slideOf(group)], 'cat', false)
    expect(m).toHaveLength(1)
    expect(m[0]!.count).toBe(1)
    expect(m[0]!.spans).toEqual([])
  })

  it('indexes runs with bullets included, so a span addresses the draw the geometry lives in', () => {
    const withBullet = layout([line([run('•', 0, 12, { isBullet: true }), run('word', 12, 40)])])
    const m = buildMatches([slideOf(textNode('e0', withBullet))], 'word', false)
    expect(m[0]!.spans).toEqual([{ runIdx: 1, start: 0, end: 4 }])
    // layoutGlyphs pushes the bullet draw too — the span's flat index lines up
    expect(layoutGlyphs(withBullet as never)).toHaveLength(2)
  })

  it('a hit covering a swallowed trailing space counts but marks only the run chars', () => {
    const trailing = layout([
      line([run('wor', 0, 30)], 0, 28, { trailingSpace: true, trailingText: ' ' }),
    ])
    const m = buildMatches([slideOf(textNode('e0', trailing))], 'or ', false)
    expect(m[0]!.count).toBe(1)
    expect(m[0]!.spans).toEqual([{ runIdx: 0, start: 1, end: 3 }])
  })

  it('keeps span offsets aligned when case folding grows a char (Turkish İ)', () => {
    // 'İ' is the only char whose toLowerCase is longer (two units); the
    // folded haystack must stay index-aligned with the per-char back-map or
    // every hit after it lands one char off
    const turkish = layout([line([run('İabc', 0, 40)])])
    const slides = [slideOf(textNode('e0', turkish))]
    expect(buildMatches(slides, 'b', false)[0]!.spans).toEqual([{ runIdx: 0, start: 2, end: 3 }])
    expect(buildMatches(slides, 'c', false)[0]!.spans).toEqual([{ runIdx: 0, start: 3, end: 4 }])
    // matching the grown char itself highlights the whole char
    expect(buildMatches(slides, 'i', false)[0]!.spans).toEqual([{ runIdx: 0, start: 0, end: 1 }])
    // exact-case matching never folds, so alignment is trivial there
    expect(buildMatches(slides, 'İ', true)[0]!.spans).toEqual([{ runIdx: 0, start: 0, end: 1 }])
  })

  it('a hit containing a grown İ ends at its last original char, not one past it', () => {
    // the span end must come from the back-map, not folded-unit arithmetic:
    // 'İ' folds to two units, so m.off + (j-k) overruns by one original char
    const one = [slideOf(textNode('e0', layout([line([run('İb', 0, 20)])])))]
    expect(buildMatches(one, 'İ', false)[0]!.spans).toEqual([{ runIdx: 0, start: 0, end: 1 }])
    // mid-run: 'İc' over 'abİcd' covers original chars 2..4 ('İc'), not 2..5
    const mid = [slideOf(textNode('e1', layout([line([run('abİcd', 0, 50)])])))]
    expect(buildMatches(mid, 'İc', false)[0]!.spans).toEqual([{ runIdx: 0, start: 2, end: 4 }])
  })

  it('folds Greek word-final Σ to ς like the old whole-string scan', () => {
    // V8's whole-string toLowerCase applies the Unicode Final_Sigma rule
    // ('ΔΟΣ' → 'δος'); a bare per-char fold gives 'σ' and case-insensitive
    // find silently loses matches the old joined-text count found
    const greek = [slideOf(textNode('e0', layout([line([run('ΔΟΣ', 0, 30)])])))]
    expect(buildMatches(greek, 'δος', false)).toHaveLength(1)
    expect(buildMatches(greek, 'δος', false)[0]!.count).toBe(1)
    expect(buildMatches(greek, 'ΔΟΣ', false)[0]!.spans).toEqual([{ runIdx: 0, start: 0, end: 3 }])
    // typed final sigma finds the word, non-final sigma does not — the same
    // answers the old fold gave, so the count-parity invariant holds
    expect(buildMatches(greek, 'ς', false)[0]!.count).toBe(1)
    expect(buildMatches(greek, 'σ', false)).toHaveLength(0)
    // Σ followed by a letter is not final: the ordinary per-char fold applies
    const mid = [slideOf(textNode('e1', layout([line([run('ΣΑ', 0, 20)])])))]
    expect(buildMatches(mid, 'σα', false)).toHaveLength(1)
  })

  it('Final_Sigma needs a CASED letter: CJK/Hebrew neighbors keep Σ ordinary, ignorables are skipped', () => {
    // V8 folds '事Σ' to '事σ' (事 is a letter but not cased); folding it to 'ς'
    // would lose the 'σ' match the old joined-text scan found — and fabricate
    // one for 'ς'
    const cjk = [slideOf(textNode('e0', layout([line([run('事Σ', 0, 20)])])))]
    expect(buildMatches(cjk, 'σ', false)).toHaveLength(1)
    expect(buildMatches(cjk, 'ς', false)).toHaveLength(0)
    const hebrew = [slideOf(textNode('e1', layout([line([run('אΣ', 0, 20)])])))]
    expect(buildMatches(hebrew, 'σ', false)).toHaveLength(1)
    // a case-ignorable (ZWSP) between the letters does not end the word:
    // 'ΑΣ\u200bΟ' folds 'ασ\u200bο', so the non-final 'σ' match survives
    const zwsp = [slideOf(textNode('e2', layout([line([run('ΑΣ\u200bΟ', 0, 30)])])))]
    expect(buildMatches(zwsp, 'σ', false)[0]!.count).toBe(1)
    // and the ignorables are skipped on the before side too: 'Α\u200bΣ' is final
    const before = [slideOf(textNode('e3', layout([line([run('Α\u200bΣ', 0, 30)])])))]
    expect(buildMatches(before, 'ς', false)).toHaveLength(1)
  })
})

describe('layoutGlyphsWithFind (issue #56 P1 #7)', () => {
  it('interpolates the span linearly within the run and paints the line box', () => {
    const glyphs = layoutGlyphsWithFind(THREE_RUNS as never, [{ runIdx: 1, start: 3, end: 5 }], HIT)
    expect(glyphs).toHaveLength(3)
    // run 'lo wo': x=30 w=50 len=5; chars 3..5 → x 30+(3/5)*50=60, w (2/5)*50=20
    expect(glyphs[1]!.highlight).toEqual({ x: 60, y: 0, w: 20, h: 28, color: HIT })
    expect(glyphs[0]!.highlight).toBeUndefined()
    expect(glyphs[2]!.highlight).toBeUndefined()
  })

  it('merges overlapping spans of one run, keeps disjoint ones separate', () => {
    // overlapping ({0..1} ∪ {1..4} → covering {0..4}) merges; disjoint
    // occurrences stay two rects so the text between them is not painted
    const overlap = layoutGlyphsWithFind(
      THREE_RUNS as never,
      [
        { runIdx: 1, start: 0, end: 1 },
        { runIdx: 1, start: 1, end: 4 },
      ],
      HIT,
    )
    expect(overlap[1]!.highlight).toEqual({ x: 30, y: 0, w: 40, h: 28, color: HIT })
    const disjoint = layoutGlyphsWithFind(
      THREE_RUNS as never,
      [
        { runIdx: 1, start: 0, end: 1 },
        { runIdx: 1, start: 3, end: 5 },
      ],
      HIT,
    )
    expect(disjoint[1]!.highlight).toEqual([
      { x: 30, y: 0, w: 10, h: 28, color: HIT },
      { x: 60, y: 0, w: 20, h: 28, color: HIT },
    ])
  })

  it('paints a span on the second line at that line box', () => {
    // 'rld' is line 2 (top 28): the rect's y/h follow the line it renders in
    const glyphs = layoutGlyphsWithFind(THREE_RUNS as never, [{ runIdx: 2, start: 0, end: 2 }], HIT)
    expect(glyphs[2]!.highlight).toEqual({ x: 0, y: 28, w: 20, h: 28, color: HIT })
  })

  it('mirrors the interpolation for RTL runs — logical char 0 renders at the right edge', () => {
    const rtl = layout([line([run('word', 12, 40, { rtl: true })])])
    const glyphs = layoutGlyphsWithFind(rtl as never, [{ runIdx: 0, start: 0, end: 2 }], HIT)
    // logical {0..2} of 4 chars, w 40: right-anchored → x 12+40-20 .. 12+40
    expect(glyphs[0]!.highlight).toEqual({ x: 32, y: 0, w: 20, h: 28, color: HIT })
  })

  it('replaces an authored run highlight only while the hit names that run', () => {
    const authored = layout([line([run('word', 0, 40, { highlight: '#feed00' })])])
    const plain = layoutGlyphs(authored as never)
    expect(plain[0]!.highlight).toEqual({ x: 0, y: 0, w: 40, h: 28, color: '#feed00' })
    const hit = layoutGlyphsWithFind(authored as never, [{ runIdx: 0, start: 0, end: 2 }], HIT)
    expect(hit[0]!.highlight).toEqual({ x: 0, y: 0, w: 20, h: 28, color: HIT })
    // no spans: the authored highlight survives untouched
    const untouched = layoutGlyphsWithFind(authored as never, [], HIT)
    expect(untouched[0]!.highlight).toEqual({ x: 0, y: 0, w: 40, h: 28, color: '#feed00' })
  })

  it('skips vertical layouts like authored highlights — lines are whole columns', () => {
    const vert = { ...THREE_RUNS, vert: 'vert' }
    const glyphs = layoutGlyphsWithFind(vert as never, [{ runIdx: 1, start: 3, end: 5 }], HIT)
    expect(glyphs[1]!.highlight).toBeUndefined()
  })

  it('a bullet-indexed span highlights the body draw, not the bullet', () => {
    const withBullet = layout([line([run('•', 0, 12, { isBullet: true }), run('word', 12, 40)])])
    const glyphs = layoutGlyphsWithFind(withBullet as never, [{ runIdx: 1, start: 0, end: 4 }], HIT)
    expect(glyphs[0]!.highlight).toBeUndefined()
    expect(glyphs[1]!.highlight).toEqual({ x: 12, y: 0, w: 40, h: 28, color: HIT })
  })
})

describe('FindReplaceDialog settle + navigate (issue #56 P1 #7)', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    delete (window as unknown as { slidesApi?: unknown }).slidesApi
    vi.useRealTimers()
  })

  const mountDialog = (
    onNavigate: (si: number, id: string, spans: unknown[]) => void,
    scanFn?: typeof buildMatches,
  ): void => {
    const props = {
      slides: [slideOf(textNode('e0', THREE_RUNS))],
      onNavigate,
      onReplaced: () => {},
      onClose: () => {},
    }
    act(() => {
      root.render(createElement(FindReplaceDialog, scanFn ? { ...props, scanFn } : props))
    })
  }

  const findInput = (): HTMLInputElement => {
    const el = container.querySelector<HTMLInputElement>('.find-panel input')
    if (!el) throw new Error('find input not rendered')
    return el
  }

  const type = (value: string): void => {
    act(() => {
      const input = findInput()
      // bypass React's value tracker so the change event is seen as a change
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('typing does not settle the scan for 150ms, then it does', () => {
    mountDialog(() => {})
    type('wo')
    // before the settle window closes, the passive status is still empty
    expect(container.textContent).not.toContain('共')
    act(() => vi.advanceTimersByTime(150))
    // after: 1 element / 1 hit
    expect(container.textContent).toContain('第 0 项，共 1 项')
  })

  it('the settle timer is re-armed per keystroke, not fired per keystroke', () => {
    mountDialog(() => {})
    type('w')
    act(() => vi.advanceTimersByTime(100))
    type('wo')
    // the second keystroke reset the window: 100ms more and it is still empty
    act(() => vi.advanceTimersByTime(100))
    expect(container.textContent).not.toContain('共')
    act(() => vi.advanceTimersByTime(50))
    expect(container.textContent).toContain('第 0 项，共 1 项')
  })

  it('Enter acts on the typed query right away, before the settle window', () => {
    const onNavigate = vi.fn()
    mountDialog(onNavigate)
    type('wo')
    act(() =>
      findInput().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      ),
    )
    expect(onNavigate).toHaveBeenCalledTimes(1)
    expect(onNavigate).toHaveBeenCalledWith(0, 'e0', [{ runIdx: 1, start: 3, end: 5 }])
  })

  it('scans once per settle and once per action — never per keystroke or re-render', () => {
    const scan = vi.fn(buildMatches)
    mountDialog(() => {}, scan)
    // the mount render scans the empty settled query once
    expect(scan).toHaveBeenCalledTimes(1)
    const slidesArg = scan.mock.calls[0]![0]
    type('w')
    type('wo')
    type('wor')
    // three keystrokes, the settle window still re-arming: still just the
    // mount scan — the old code rebuilt the whole match list every render
    expect(scan).toHaveBeenCalledTimes(1)
    act(() => vi.advanceTimersByTime(150))
    expect(scan).toHaveBeenCalledTimes(2)
    expect(scan).toHaveBeenLastCalledWith(slidesArg, 'wor', false)
    // Enter is one user action → exactly one fresh synchronous scan
    act(() =>
      findInput().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      ),
    )
    expect(scan).toHaveBeenCalledTimes(3)
    expect(scan).toHaveBeenLastCalledWith(slidesArg, 'wor', false)
  })

  it('Replace acts on the typed query, not the 150ms-stale settled list', async () => {
    const findReplace = vi.fn().mockResolvedValue({ count: 1, slides: [] })
    ;(window as unknown as { slidesApi?: unknown }).slidesApi = { findReplace }
    mountDialog(() => {})
    type('wo')
    // no timer advance: the settled display list is still empty. If Replace
    // read that list it would take the findNext fallback and never call the
    // model — acting on the stale list is exactly the bug this guards.
    act(() =>
      findInput().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      ),
    )
    const replaceInput = container.querySelectorAll<HTMLInputElement>('.find-panel input')[1]!
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(replaceInput, 'XX')
      replaceInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const replaceBtn = container.querySelectorAll<HTMLButtonElement>(
      '.find-panel-actions button',
    )[1]!
    await act(async () => {
      replaceBtn.click()
    })
    expect(findReplace).toHaveBeenCalledTimes(1)
    expect(findReplace).toHaveBeenCalledWith({
      find: 'wo',
      replace: 'XX',
      matchCase: false,
      firstOnly: true,
      slideIndex: 0,
      elementId: 'e0',
    })
  })

  it('toggling match case recomposes the list and drops the cursor and stale status', () => {
    mountDialog(() => {})
    type('hel')
    act(() => vi.advanceTimersByTime(150))
    expect(container.textContent).toContain('第 0 项，共 1 项')
    act(() =>
      findInput().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      ),
    )
    // Enter stepped to position 1 of 1
    expect(container.textContent).toContain('第 1 项')
    const box = container.querySelector<HTMLInputElement>(
      '.find-panel-opts input[type="checkbox"]',
    )!
    act(() => box.click())
    // 'hel' matches nothing case-sensitively: the display list is empty and
    // neither the stepped position nor the old status survives into it — a
    // surviving cursor would have Replace target an element never navigated
    expect(container.textContent).toContain('第 0 项，共 0 项')
    expect(container.textContent).not.toContain('第 1 项')
  })

  it('a deck refresh under the open panel recomposes the list — position and cursor do not survive', () => {
    mountDialog(() => {})
    type('wo')
    act(() => vi.advanceTimersByTime(150))
    expect(container.textContent).toContain('共 1 项')
    // step to a position first, so a surviving cursor/position is observable
    act(() =>
      findInput().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      ),
    )
    expect(container.textContent).toContain('第 1 项')
    // a replace result or undo landed: the same panel, a new slides identity
    // whose text no longer matches the settled query
    act(() => {
      root.render(
        createElement(FindReplaceDialog, {
          slides: [slideOf(textNode('e0', layout([line([run('zzz', 0, 30)])])))],
          onNavigate: () => {},
          onReplaced: () => {},
          onClose: () => {},
        }),
      )
    })
    // the stepped position and the cursor behind it are gone, not stale — a
    // surviving index would have single Replace target an element that was
    // never navigated, and a surviving position string would claim a hit
    // that no longer exists
    expect(container.textContent).toContain('第 0 项，共 0 项')
    expect(container.textContent).not.toContain('第 1 项')
  })

  it('Replace All is enabled the moment a query is typed, not after the settle', () => {
    mountDialog(() => {})
    type('wo')
    // no timer advance: the settled list is still empty — the action scans
    // the typed query fresh, so the 150ms-stale total must not gate it
    const replaceAll = container.querySelectorAll<HTMLButtonElement>(
      '.find-panel-actions button',
    )[2]!
    expect(replaceAll.disabled).toBe(false)
  })
})
