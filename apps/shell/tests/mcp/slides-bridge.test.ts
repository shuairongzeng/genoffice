import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Slides MCP bridge read_deck tests: waitSession race resilience on cold
 * open/dormant wakeup, overview chart/notes/12-row table coverage, untruncated
 * page-range reading, safe end clamping, and 24,000-char detail budget cap.
 */

const { liveWc, fakeSessions } = vi.hoisted(() => ({
  liveWc: new Map<number, { id: number; isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> }>(),
  fakeSessions: new Map<number, unknown>(),
}))

vi.mock('electron', () => ({
  webContents: {
    fromId: (id: number) => liveWc.get(id),
  },
}))

vi.mock('../../../slides/src/main/slides-main', () => ({
  applySessionTxn: vi.fn(),
  saveSessionDeckTo: vi.fn(),
}))

vi.mock('../../../slides/src/main/session-state', () => ({
  sessions: fakeSessions,
  attachedIds: () => [],
}))

import { createSlidesControl } from '../../src/main/mcp/slides-bridge'

function makeNotesArchive(notesBySlide: Record<string, string>) {
  const entries = new Map<string, Uint8Array>()
  const texts = new Map<string, string>()
  for (const [slidePath, body] of Object.entries(notesBySlide)) {
    const idx = Object.keys(notesBySlide).indexOf(slidePath) + 1
    const notesPath = `ppt/notesSlides/notesSlide${idx}.xml`
    texts.set(
      notesPath,
      `<p:notes><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${body}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
    )
  }
  return {
    entries,
    readText: (path: string) => texts.get(path) ?? null,
    readRels: (slidePath: string) => {
      const m = new Map<string, { id: string; type: string; target: string }>()
      if (slidePath in notesBySlide) {
        const idx = Object.keys(notesBySlide).indexOf(slidePath) + 1
        m.set('rIdNotes', {
          id: 'rIdNotes',
          type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide',
          target: `../notesSlides/notesSlide${idx}.xml`,
        })
      }
      return m
    },
  }
}

function makeRichSession() {
  const tableRows = Array.from({ length: 14 }, (_, r) => [
    { text: { paragraphs: [{ runs: [{ text: `Row${r + 1}` }] }] } },
    { text: { paragraphs: [{ runs: [{ text: `Val${r + 1}` }] }] } },
  ])
  const slide0 = {
    path: 'ppt/slides/slide1.xml',
    elements: [
      {
        id: 'el-txt-1',
        type: 'text',
        transform: { offset: { x: 0, y: 0, cx: 1000, cy: 500 } },
        text: { paragraphs: [{ runs: [{ text: 'LongSlideBody '.repeat(80) }] }] },
      },
      {
        id: 'el-tbl-1',
        type: 'table',
        transform: { offset: { x: 0, y: 600, cx: 2000, cy: 1000 } },
        rows: tableRows,
      },
      {
        id: 'el-chart-1',
        type: 'chart',
        transform: { offset: { x: 0, y: 1700, cx: 2000, cy: 1000 } },
        chart: {
          kind: 'bar',
          categories: ['Q1', 'Q2', 'Q3'],
          series: [{ name: 'Revenue', values: [100, 220, 340] }],
        },
      },
    ],
  }
  const slide1 = {
    path: 'ppt/slides/slide2.xml',
    elements: [
      {
        id: 'el-txt-2',
        type: 'text',
        transform: { offset: { x: 0, y: 0, cx: 1000, cy: 500 } },
        text: { paragraphs: [{ runs: [{ text: `SECOND_HUGE_${'X'.repeat(23_500)}` }] }] },
      },
    ],
  }
  const archive = makeNotesArchive({
    'ppt/slides/slide1.xml': 'Speaker secret NOTE_404',
  })
  return {
    path: '/tmp/deck.pptx',
    opened: {
      deck: { size: { cx: 12192000, cy: 6858000 }, slides: [slide0, slide1] },
      archive,
    },
  }
}

beforeEach(() => {
  liveWc.clear()
  fakeSessions.clear()
})

describe('slides-bridge readDeck', () => {
  it('waits asynchronously when session is not yet populated instead of throwing immediately', async () => {
    liveWc.set(42, { id: 42, isDestroyed: () => false, send: vi.fn() })
    const control = createSlidesControl({ openBlankTab: () => 42 })

    setTimeout(() => {
      fakeSessions.set(42, makeRichSession())
    }, 60)

    const deck = (await control.readDeck(42)) as {
      totalSlides: number
      slides: Array<{ notes?: string; elements: Array<Record<string, unknown>> }>
    }
    expect(deck.totalSlides).toBe(2)
    expect(deck.slides[0]!.notes).toBe('Speaker secret NOTE_404')
    const tbl = deck.slides[0]!.elements.find((e) => e.type === 'table')!
    expect(tbl.text).toContain('Row12 | Val12')
    expect(tbl.text).not.toContain('Row13 | Val13')
    expect(tbl.textTruncated).toBe(true)
    expect(tbl.rows).toBe(14)

    const chart = deck.slides[0]!.elements.find((e) => e.type === 'chart')!
    expect(chart).toMatchObject({
      chartKind: 'bar',
      categories: ['Q1', 'Q2', 'Q3'],
      series: [{ name: 'Revenue', values: [100, 220, 340] }],
    })
  })

  it('reads untruncated slide content by slideIndex/start/end, clamps end, and caps oversized multi-slide payloads', async () => {
    fakeSessions.set(77, makeRichSession())
    const control = createSlidesControl({ openBlankTab: () => 77 })

    const page0 = (await control.readDeck(77, { slideIndex: 0 })) as {
      slides: Array<{ notes?: string; elements: Array<Record<string, unknown>> }>
    }
    const tblFull = page0.slides[0]!.elements.find((e) => e.type === 'table')!
    expect(tblFull.text).toContain('Row14 | Val14')
    expect(tblFull.textTruncated).toBeUndefined()
    const txtFull = page0.slides[0]!.elements.find((e) => e.type === 'text')!
    expect((txtFull.text as string).length).toBeGreaterThan(800)
    expect(txtFull.textTruncated).toBeUndefined()

    const capped = (await control.readDeck(77, { start: 0, end: 99 })) as {
      range: { start: number; end: number }
      truncated?: boolean
      nextSlideIndex?: number
      slides: unknown[]
    }
    expect(capped.truncated).toBe(true)
    expect(capped.nextSlideIndex).toBe(1)
    expect(capped.slides).toHaveLength(1)
    expect(capped.range).toEqual({ start: 0, end: 0 })

    await expect(control.readDeck(77, { slideIndex: 9 })).rejects.toThrow(/out of range/i)
  })
})
