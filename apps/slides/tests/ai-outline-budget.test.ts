/**
 * Issue #40 item 3: buildDeckOutline had no cap — 40 pages × 15 elements
 * ≈ 600+ lines re-sent every turn. The outline is now layered under an 8KB
 * budget, and every page line always survives layers 1-3 (page numbering is
 * the model's addressing surface, the contract the page-order guard rests
 * on). Also pins the plan_deck mention in system.md (issue item 7's rider).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RenderSlide, ShapeRenderNode } from '@genoffice/pptx-render'
import {
  createSlidesSkill,
  setDeckImageAttachment,
  type DeckAccess,
} from '../src/renderer/ai/slides-skill'

const here = dirname(fileURLToPath(import.meta.url))

const textNode = (id: string, text: string): ShapeRenderNode =>
  ({
    id,
    sourceId: id,
    type: 'shape',
    box: {
      x: 60,
      y: 60,
      w: 400,
      h: 80,
      rotationDeg: 0,
      flipH: false,
      flipV: false,
      centerX: 260,
      centerY: 100,
    },
    fill: { kind: 'none' },
    text: {
      lines: [
        {
          runs: [
            {
              text,
              x: 0,
              baselineY: 20,
              fontFamily: 'Arial',
              fontSizePx: 24,
              color: '#000',
              bold: false,
              italic: false,
              underline: false,
              widthPx: 100,
            },
          ],
          top: 0,
          height: 28,
        },
      ],
      insets: { l: 0, t: 0, r: 0, b: 0 },
      anchor: 'top',
      fontScale: 1,
      contentHeight: 28,
    },
  }) as unknown as ShapeRenderNode

const page = (part: string, texts: string[]): RenderSlide =>
  ({
    widthPx: 1280,
    heightPx: 720,
    scale: 1,
    partPath: part,
    nodes: texts.map((t, i) => textNode(`e${i}`, t)),
  }) as unknown as RenderSlide

const access = (deck: RenderSlide[]): DeckAccess =>
  ({
    getSlides: () => deck,
    getCurrent: () => 0,
    getSelectedIds: () => [],
    applySlide: () => {},
    applyDeck: () => {},
    fitWidthPx: 1280,
  }) as unknown as DeckAccess

afterEach(() => {
  setDeckImageAttachment(null)
})

describe('deck outline budget (issue 40 item 3)', () => {
  it('a deck with no page over the per-page cap is byte-identical to the unbounded form', () => {
    const deck = [
      page('ppt/slides/slide1.xml', ['Title', 'Sub']),
      page('ppt/slides/slide2.xml', ['A']),
    ]
    const outline = createSlidesSkill(access(deck)).buildContext!()
    expect(outline).toContain('- e0 | shape | "Title"')
    expect(outline).toContain('- e1 | shape | "Sub"')
    expect(outline).not.toContain('more element(s)')
    expect(outline).not.toContain('elided')
    expect(outline).toContain('(Use read_slide to see element positions/sizes/colors)')
  })

  it('a busy page caps its element list and points at read_slide', () => {
    const deck = [
      page(
        'ppt/slides/slide1.xml',
        Array.from({ length: 15 }, (_, i) => `element number ${i}`),
      ),
    ]
    const outline = createSlidesSkill(access(deck)).buildContext!()
    expect(outline).toContain('- e0 | shape | "element number 0"')
    expect(outline).toContain('- e9 | shape | "element number 9"')
    expect(outline).not.toContain('- e10 | shape')
    expect(outline).toContain('… 5 more element(s) on this page; read_slide lists them all')
  })

  it('an attached picture keeps its annotation line even under the cap (vision contract)', () => {
    setDeckImageAttachment({
      ordinals: new Map([[0, [{ elementId: 'e13', ordinal: 4 }]]]),
      skipped: 0,
    })
    const deck = [
      page(
        'ppt/slides/slide1.xml',
        Array.from({ length: 15 }, (_, i) => `element number ${i}`),
      ),
    ]
    // e13 is a shape here, not a real picture node — the annotation gate keys
    // on the attachment map, so the line still must survive the cap
    const outline = createSlidesSkill(access(deck)).buildContext!()
    expect(outline).toContain('e13 | shape | "element number 13" — attached as image #4')
    expect(outline).toContain('… 5 more element(s) on this page; read_slide lists them all')
  })

  it('attached elements beyond a tight cap survive — the ordinal map is the vision contract', () => {
    // layer 2 (cap 5) with 6 attached pictures on page 1: mere priority cuts
    // the 6th note, orphaning image #6 (read_slide prints no ordinals — the
    // outline note is the ONLY image#K → element mapping)
    setDeckImageAttachment({
      ordinals: new Map([
        [0, Array.from({ length: 6 }, (_, k) => ({ elementId: `e${k * 3}`, ordinal: k + 1 }))],
      ]),
      skipped: 0,
    })
    const deck = Array.from({ length: 22 }, (_, p) =>
      page(
        `ppt/slides/slide${p + 1}.xml`,
        Array.from({ length: 20 }, (_, i) => `page ${p} element ${i} with some words`),
      ),
    )
    const outline = createSlidesSkill(access(deck)).buildContext!()
    expect(outline.length).toBeLessThanOrEqual(8_000)
    for (let k = 1; k <= 6; k++) expect(outline).toContain(`— attached as image #${k}`)
    // the exemption shows ONLY the attached lines for that page, marker
    // counts the elided rest
    expect(outline).toContain('… 14 more element(s) on this page; read_slide lists them all')
  })

  it('skeleton layers carry the attached-picture map in the footer (vision contract survives elision)', () => {
    // layer 3 drops every element line, inline notes included — the footer
    // map must keep the ordinal → element mapping
    setDeckImageAttachment({
      ordinals: new Map([[4, [{ elementId: 'e13', ordinal: 7 }]]]),
      skipped: 0,
    })
    const deck = Array.from({ length: 100 }, (_, p) =>
      page(
        `ppt/slides/slide${p + 1}.xml`,
        Array.from({ length: 20 }, (_, i) => `page ${p} element ${i} with some words`),
      ),
    )
    const outline = createSlidesSkill(access(deck)).buildContext!()
    expect(outline.length).toBeLessThanOrEqual(8_000)
    expect(outline).toContain('Attached pictures: image #7 = Page 5 e13')
    expect(outline).not.toContain('— attached as image #7')
    expect(outline).toContain('(elided; read_slide lists this page)')
  })

  it('a big deck tightens per-page lists before dropping any page line', () => {
    // 22 pages × 20 elements: full lists would be ~12KB; every page line must
    // still be present (numbering is the addressing surface)
    const deck = Array.from({ length: 22 }, (_, p) =>
      page(
        `ppt/slides/slide${p + 1}.xml`,
        Array.from({ length: 20 }, (_, i) => `page ${p} element ${i} with some words`),
      ),
    )
    const outline = createSlidesSkill(access(deck)).buildContext!()
    expect(outline.length).toBeLessThanOrEqual(8_000)
    for (let p = 1; p <= 22; p++) expect(outline).toContain(`Page ${p} (slideIndex=${p - 1}):`)
    expect(outline).toContain('more element(s) on this page')
  })

  it('a huge deck falls back to one skeleton line per page — still every page', () => {
    const deck = Array.from({ length: 100 }, (_, p) =>
      page(
        `ppt/slides/slide${p + 1}.xml`,
        Array.from({ length: 20 }, (_, i) => `page ${p} element ${i} with some words`),
      ),
    )
    const outline = createSlidesSkill(access(deck)).buildContext!()
    expect(outline.length).toBeLessThanOrEqual(8_000)
    for (let p = 1; p <= 100; p++) expect(outline).toContain(`Page ${p} (slideIndex=${p - 1}):`)
    expect(outline).toContain('(elided; read_slide lists this page)')
  })

  it('a giant deck elides middle PAGE lines, keeping both ends and continuous numbering', () => {
    const deck = Array.from({ length: 300 }, (_, p) => page(`ppt/slides/s${p + 1}.xml`, ['x']))
    const outline = createSlidesSkill(access(deck)).buildContext!()
    expect(outline.length).toBeLessThanOrEqual(8_000)
    expect(outline).toContain('Page 1 (slideIndex=0):')
    expect(outline).toContain('Page 300 (slideIndex=299):')
    expect(outline).toContain('pages elided here; numbering and slideIndex are continuous')
    // the middle is actually gone, not just marked
    expect(outline).not.toContain('Page 150 (slideIndex=149):')
  })

  it('layer 4 measures the marker it inserts — the 8KB budget holds in the tight band', () => {
    // 150 × 12 reaches layer 4 with the initial split already "under budget"
    // when the marker line is not counted (≈8,025 chars over) — the loop must
    // count what it will actually return
    const deck = Array.from({ length: 150 }, (_, p) =>
      page(
        `ppt/slides/s${p + 1}.xml`,
        Array.from({ length: 12 }, (_, i) => `page ${p} element ${i} with some words`),
      ),
    )
    const outline = createSlidesSkill(access(deck)).buildContext!()
    expect(outline.length).toBeLessThanOrEqual(8_000)
    expect(outline).toContain('Page 1 (slideIndex=0):')
    expect(outline).toContain('Page 150 (slideIndex=149):')
    expect(outline).toContain('pages elided here; numbering and slideIndex are continuous')
  })

  it('a huge selection cannot unshrink the outline or eat a tiny deck page lines', () => {
    // 2,000 refs would make the selection line the only unshrinkable part —
    // layers 3-4 then elided BOTH page lines of a 2-page deck (the splice has
    // no middle to drop) and destroyed the addressing surface
    const deck = [page('ppt/slides/slide1.xml', ['A', 'B']), page('ppt/slides/slide2.xml', ['C'])]
    const manySelected = Array.from({ length: 2_000 }, (_, i) => `sel-${i}`)
    const outline = createSlidesSkill({
      ...access(deck),
      getSelectedIds: () => manySelected,
    }).buildContext!()
    expect(outline.length).toBeLessThanOrEqual(8_000)
    expect(outline).toContain('User selected elements: sel-0, sel-1')
    expect(outline).toContain('… (+1950 more selected; read_slide lists this page)')
    expect(outline).not.toContain('sel-50')
    expect(outline).toContain('Page 1 (slideIndex=0):')
    expect(outline).toContain('Page 2 (slideIndex=1):')
  })

  it('the prompt mentions plan_deck (issue 40 item 7 rider)', () => {
    const prompt = readFileSync(join(here, '../src/renderer/ai/prompts/system.md'), 'utf8')
    expect(prompt).toContain('plan_deck')
  })
})
