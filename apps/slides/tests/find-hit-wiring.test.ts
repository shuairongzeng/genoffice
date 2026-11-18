/**
 * Issue #56 P1 #7 — the find-hit injection chain, pinned the two ways the
 * repo pins unmountable wiring: NodeBody is mounted for real (react-konva
 * stubbed, Rect as a spy — the hit rect must actually render, with its
 * interpolated geometry), and the threading above it (App → SlideCanvas →
 * NodeView → NodeBody, the reflection recursion, the lifecycle) is pinned by
 * reading the sources, the html print-request convention — that chain once
 * shipped dead there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { RenderSlide, ShapeRenderNode, TableRenderNode } from '@genoffice/pptx-render'

// react-konva's node entry requires the native 'canvas' package; nothing here
// draws. Rect is a spy so the highlight rect's props can be inspected, and
// Group passes children through so the text layer's Rects actually render.
vi.mock('react-konva', () => {
  const stub = () => null
  const passthrough = ({ children }: { children?: React.ReactNode }) => children ?? null
  return {
    Stage: stub,
    Layer: stub,
    Rect: vi.fn(() => null),
    Group: passthrough,
    Transformer: stub,
    Line: stub,
    Arrow: stub,
    Text: vi.fn(() => null),
    Ellipse: stub,
    Image: stub,
    Path: stub,
    Circle: stub,
    Arc: stub,
  }
})

import { Rect } from 'react-konva'
import { NodeBody } from '../src/renderer/NodeBody'
import { CANVAS_COLORS } from '../src/renderer/canvas-colors'
import { buildMatches } from '../src/renderer/components/FindReplaceDialog'
import type { FindSpan } from '../src/renderer/konva-adapter'

const source = (relative: string) =>
  readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

const APP = '../src/renderer/App.tsx'
const CANVAS = '../src/renderer/SlideCanvas.tsx'
const NODE_BODY = '../src/renderer/NodeBody.tsx'

const run = (text: string, x: number, w: number, over: Record<string, unknown> = {}) => ({
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
/** 'Hel' | 'lo wo' on line 1, 'rld' on line 2 → layoutText 'Hello wo\nrld' */
const THREE_RUNS = {
  lines: [
    { runs: [run('Hel', 0, 30), run('lo wo', 30, 50)], top: 0, height: 28, paraStart: true },
    { runs: [run('rld', 0, 30)], top: 28, height: 28, paraStart: true },
  ],
  insets: { l: 0, t: 0, r: 0, b: 0 },
  anchor: 'top',
  fontScale: 1,
  contentHeight: 28,
  wrap: true,
}

const BOX = { x: 0, y: 0, w: 400, h: 80, rotationDeg: 0, flipH: false, flipV: false }
const textNode = (id: string, text: unknown, over: Record<string, unknown> = {}): ShapeRenderNode =>
  ({
    id,
    sourceId: id,
    type: 'shape',
    box: BOX,
    fill: { kind: 'none' },
    text,
    ...over,
  }) as unknown as ShapeRenderNode

let container: HTMLElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.mocked(Rect).mockClear()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const hitRects = (): Array<Record<string, unknown>> =>
  vi
    .mocked(Rect)
    .mock.calls.filter(
      ([props]) => (props as Record<string, unknown>)?.fill === CANVAS_COLORS.findHit,
    )
    .map(([props]) => props as Record<string, unknown>)

const mountNode = (
  node: ShapeRenderNode | TableRenderNode,
  findHit?: { sourceId: string; spans: FindSpan[] },
): void => {
  act(() => {
    root.render(
      createElement(NodeBody, { node, images: new Map<string, HTMLImageElement>(), findHit }),
    )
  })
}

describe('NodeBody renders the find hit (issue #56 P1 #7)', () => {
  it('draws one interpolated rect behind the spanned run', () => {
    // 'wo' chars 3..5 of 'lo wo' (x=30 w=50 len=5) → x 60, w 20, line box 0/28
    mountNode(textNode('e0', THREE_RUNS), {
      sourceId: 'e0',
      spans: [{ runIdx: 1, start: 3, end: 5 }],
    })
    expect(hitRects()).toEqual([
      { x: 60, y: 0, width: 20, height: 28, fill: CANVAS_COLORS.findHit, listening: false },
    ])
  })

  it('a table hit paints exactly the spanned cell, at that cell origin', () => {
    // both cells hold the same text, so only the row/col filter can tell
    // which one the span belongs to — and the rect must sit at the spanned
    // cell's own origin, not the table's
    const oneRun = (txt: string): Record<string, unknown> => ({
      lines: [{ runs: [run(txt, 0, 20)], top: 0, height: 28, paraStart: true }],
      insets: { l: 0, t: 0, r: 0, b: 0 },
      anchor: 'top',
      fontScale: 1,
      contentHeight: 28,
      wrap: true,
    })
    const table = {
      id: 't0',
      sourceId: 't0',
      type: 'table',
      box: BOX,
      gridX: [0, 100, 200],
      gridY: [0, 28],
      cells: [
        { row: 0, col: 0, x: 0, y: 0, w: 100, h: 28, fill: { kind: 'none' }, text: oneRun('wo') },
        { row: 0, col: 1, x: 200, y: 0, w: 100, h: 28, fill: { kind: 'none' }, text: oneRun('wo') },
      ],
    } as unknown as TableRenderNode
    mountNode(table, {
      sourceId: 't0',
      spans: [{ runIdx: 0, start: 0, end: 2, cell: { row: 0, col: 1 } }],
    })
    expect(hitRects()).toEqual([
      { x: 200, y: 0, width: 20, height: 28, fill: CANVAS_COLORS.findHit, listening: false },
    ])
  })

  it('draws nothing for a hit naming another node, and nothing without a hit', () => {
    mountNode(textNode('e0', THREE_RUNS), {
      sourceId: 'other',
      spans: [{ runIdx: 1, start: 3, end: 5 }],
    })
    expect(hitRects()).toHaveLength(0)
    mountNode(textNode('e0', THREE_RUNS))
    expect(hitRects()).toHaveLength(0)
  })

  it('keeps drawing the hit through the reflection recursion', () => {
    // a reflected node re-renders its real body through a recursive NodeBody
    // call — the findHit prop must survive that hop
    const reflected = textNode('e0', THREE_RUNS, {
      reflection: { blurPx: 2, startAlpha: 0.3, endPos: 0.5, distPx: 4 },
    })
    mountNode(reflected, { sourceId: 'e0', spans: [{ runIdx: 1, start: 3, end: 5 }] })
    expect(hitRects()).toHaveLength(1)
    expect(hitRects()[0]).toMatchObject({ x: 60, width: 20 })
  })
})

describe('findHit threading, source-read (issue #56 P1 #7)', () => {
  it('App owns the hit: set on navigate, cleared on close and on any deck mutation', async () => {
    const app = await source(APP)
    expect(app).toMatch(/const \[findHit, setFindHit\]/)
    // navigate arms it with the match's spans
    expect(app).toMatch(/setFindHit\(spans\.length \? \{ sourceId: id, spans \} : null\)/)
    expect(app).toMatch(/findHit=\{findHit\}/)
    // close drops it…
    expect(app).toMatch(/setFindOpen\(false\)[\s\S]{0,120}setFindHit\(null\)/)
    // …and so does any slides identity change (replace, undo, a committed
    // edit): the spans were measured against runs that no longer exist
    const effect = app.slice(app.indexOf('useEffect(() => {', app.indexOf('const [findHit')))
    expect(effect.slice(0, 200)).toMatch(/setFindHit\(null\)/)
    expect(effect.slice(0, 200)).toMatch(/\}, \[slides\]\)/)
  })

  it('SlideCanvas threads findHit to NodeView and NodeBody; group children stay excluded', async () => {
    const canvas = await source(CANVAS)
    expect(canvas).toMatch(/findHit\?: \{ sourceId: string; spans: FindSpan\[\] \} \| null/)
    expect(canvas).toMatch(/findHit\?: Props\['findHit'\]/)
    // exactly the two top-level handoffs: the NodeView render and the
    // NodeBody call — the group-children render site deliberately passes
    // nothing (their hits carry no spans, per the dialog)
    expect(canvas.match(/findHit=\{findHit\}/g)).toHaveLength(2)
    expect(canvas).toMatch(/findHit,/)
  })

  it('NodeBody injects through the shape and table-cell paths and renders arrays', async () => {
    const body = await source(NODE_BODY)
    expect(body).toMatch(/shapeGlyphsWithFind\(shape, findHit\.spans, CANVAS_COLORS\.findHit\)/)
    expect(body).toMatch(/layoutGlyphsWithFind\(cell\.text, cellSpans, CANVAS_COLORS\.findHit\)/)
    // a glyph's highlights may be several rects — both paint sites map them
    expect(body.match(/highlightRects\(g\)/g)).toHaveLength(2)
    // the reflection recursion forwards the hit
    expect(body).toMatch(/flipVInherited=\{flipVInherited\}[\s\S]{0,80}findHit=\{findHit\}/)
  })

  it('the dialog still produces the spans App passes down', () => {
    const slide = {
      widthPx: 1280,
      heightPx: 720,
      scale: 1,
      nodes: [textNode('e0', THREE_RUNS)],
    } as unknown as RenderSlide
    const m = buildMatches([slide], 'wo', false)
    expect(m[0]!.spans).toEqual([{ runIdx: 1, start: 3, end: 5 }])
  })
})
