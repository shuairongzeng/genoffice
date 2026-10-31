/**
 * Issue #40 P0 pair: speaker notes become readable (read_slide shows the
 * page's CURRENT notes, so a setNotes that adds to them can compose instead
 * of clobbering), and page-positioned writes refuse while the deck's page
 * order diverged from the run's outline snapshot — the user deleting or
 * moving pages mid-run used to send those edits silently to whatever page
 * now occupies the slot.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RenderSlide, ShapeRenderNode } from '@genoffice/pptx-render'
import {
  createSlidesSkill,
  formatSlideDump,
  type DeckAccess,
} from '../src/renderer/ai/slides-skill'
import { createSlideFixSkill } from '../src/renderer/ai/slide-qc'

const here = dirname(fileURLToPath(import.meta.url))

const textNode = (id: string, text: string, redact?: string): ShapeRenderNode =>
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
              ...(redact ? { redact } : {}),
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

/** one page with a single text element — partPath is its stable identity */
const page = (part: string, text: string, redact?: string): RenderSlide =>
  ({
    widthPx: 1280,
    heightPx: 720,
    scale: 1,
    partPath: part,
    nodes: [textNode('e0', text, redact)],
  }) as unknown as RenderSlide

let deck: RenderSlide[]
/** ops that reached the executor: a refusal must leave this empty */
let appliedOps: unknown[]
/** slides carried by the txn result — the authoritative post-op deck from main */
let txnSlides: RenderSlide[] | null
/** deck a regenerate_slide landing reports (and lands, like AiPanel does) */
let regenSlides: RenderSlide[] | null
/** simulate the real host: a deck landing whose React commit has NOT run yet */
let lagApplyDeck: boolean

const access: DeckAccess = {
  getSlides: () => deck,
  getCurrent: () => 0,
  getSelectedIds: () => [],
  applySlide: () => {},
  applyDeck: (all: RenderSlide[]) => {
    if (!lagApplyDeck) deck = all
  },
  regenerateSlide: async () => {
    if (!regenSlides) return { ok: true }
    deck = regenSlides
    return { ok: true, slides: regenSlides }
  },
  generatePageLocal: async () => ({ ok: true, marker: 'm' }),
  fitWidthPx: 1280,
} as unknown as DeckAccess

const call = (name: string, input: Record<string, unknown>) => ({ id: 't', name, input }) as never

beforeEach(() => {
  deck = [
    page('ppt/slides/slide1.xml', 'Title'),
    page('ppt/slides/slide2.xml', 'Team'),
    page('ppt/slides/slide3.xml', 'Revenue'),
  ]
  appliedOps = []
  txnSlides = null
  regenSlides = null
  lagApplyDeck = false
  ;(globalThis as unknown as { window: unknown }).window = {
    slidesApi: {
      getNotes: vi.fn(async (i: number) => ['first notes', '', 'third notes'][i] ?? ''),
      applyTxn: vi.fn(async (req: { ops: unknown[] }) => {
        appliedOps.push(...req.ops)
        return {
          applied: true,
          records: [{ op: 'setNotes', target: 'slide 2' }],
          slides: txnSlides ?? deck,
          failures: [],
        }
      }),
    },
  }
})

describe('read_slide speaker notes (issue 40 item 1)', () => {
  it("shows the page's current notes, and '(none)' when it has none", async () => {
    const skill = createSlidesSkill(access)
    const r = await skill.executeTool(call('read_slide', { slideIndex: 0 }))
    expect(r.output).toContain('Speaker notes: first notes')
    const empty = await skill.executeTool(call('read_slide', { slideIndex: 1 }))
    expect(empty.output).toContain('Speaker notes: (none)')
    // notes are read per call, not cached in the render tree: a change
    // between two reads is visible in the second one
    ;(window.slidesApi.getNotes as unknown as Mock).mockResolvedValue('updated notes')
    const fresh = await skill.executeTool(call('read_slide', { slideIndex: 0 }))
    expect(fresh.output).toContain('Speaker notes: updated notes')
  })

  it('a missing notes IPC fails open: the dump still describes the page', async () => {
    ;(globalThis as unknown as { window: unknown }).window = { slidesApi: {} }
    const skill = createSlidesSkill(access)
    const r = await skill.executeTool(call('read_slide', { slideIndex: 0 }))
    expect(r.output).toContain('Speaker notes: (none)')
    expect(r.output).toContain('Title')
  })

  it('hides the notes of a page that withholds content from AI (the canvas marks cover the page, notes carry none)', async () => {
    deck = [page('ppt/slides/slide1.xml', 'secret', 'k1'), page('ppt/slides/slide2.xml', 'Team')]
    const skill = createSlidesSkill(access)
    const withheld = await skill.executeTool(call('read_slide', { slideIndex: 0 }))
    expect(withheld.output).toContain('Speaker notes: (not shown')
    expect(withheld.output).not.toContain('first notes')
    // a clean page on the same deck still shows its notes
    const clean = await skill.executeTool(call('read_slide', { slideIndex: 1 }))
    expect(clean.output).toContain('Speaker notes: (none)')
  })

  it('a structural change landing during the notes read is re-read, not paired with a stale dump', async () => {
    const skill = createSlidesSkill(access)
    skill.buildContext!()
    let moved = false
    ;(window.slidesApi.getNotes as unknown as Mock).mockImplementation(async () => {
      // the user deletes page 2 (Team) while the IPC is in flight (once —
      // the re-fetch below must see the same post-change deck)
      if (!moved) {
        moved = true
        deck = [deck[0]!, deck[2]!]
      }
      return 'kept notes'
    })
    const r = await skill.executeTool(call('read_slide', { slideIndex: 1 }))
    // slideIndex 1 dumps the CURRENT page in that slot (Revenue), never the
    // deleted Team page the entry snapshot still held
    expect(r.output).toContain('Revenue')
    expect(r.output).not.toContain('Team')
    expect(r.output).toContain('page order changed')
    expect(r.output).toContain('The deck now has 2 page(s)')
  })

  it('a withheld page moving out of the slot mid-IPC never has its notes shown under the page that moved in', async () => {
    // the leak shape: notes resolve against main BEFORE the move (the
    // withheld page was in the slot at IPC time), the render tree reflects
    // the move AFTER — pairing the first fetch with the fresh dump would show
    // the withheld page's notes under the clean page, past the gate
    deck = [page('ppt/slides/slideA.xml', 'Hidden', 'k1'), page('ppt/slides/slideB.xml', 'Team')]
    let calls = 0
    ;(window.slidesApi.getNotes as unknown as Mock).mockImplementation(async (i: number) => {
      calls += 1
      if (calls === 1) {
        // the user moves the withheld page to the end; the renderer commits
        // while the first notes fetch is still resolving
        deck = [deck[1]!, deck[0]!]
        return 'secret notes'
      }
      // the re-fetch resolves against the post-move slot: the clean page
      return i === 0 ? 'plain notes' : ''
    })
    const skill = createSlidesSkill(access)
    const r = await skill.executeTool(call('read_slide', { slideIndex: 0 }))
    expect(calls).toBe(2)
    expect(r.output).toContain('Team')
    expect(r.output).toContain('Speaker notes: plain notes')
    expect(r.output).not.toContain('secret notes')
  })

  it('formatSlideDump stays notes-free when notes are not passed (QC callers)', () => {
    expect(formatSlideDump(deck[0]!)).not.toContain('Speaker notes')
    expect(formatSlideDump(deck[0]!, 'some notes')).toContain('Speaker notes: some notes')
  })

  it('the prompt teaches reading before replacing notes', () => {
    // the mechanism only helps if the model is told: setNotes REPLACES, so
    // the instruction to read first is the contract this feature rests on
    const prompt = readFileSync(join(here, '../src/renderer/ai/prompts/system.md'), 'utf8')
    expect(prompt).toContain('setNotes REPLACES')
    expect(prompt).toContain("read_slide shows the page's current notes")
  })
})

describe('page-positioned writes refuse a diverged deck (issue 40 item 2)', () => {
  it('refuses scripts, images, charts, regenerations, and numeric ops with the current order', async () => {
    const skill = createSlidesSkill(access)
    skill.buildContext!()
    // the user deletes page 2 (Team) while the run is in flight
    deck = [deck[0]!, deck[2]!]

    const r = await skill.executeTool(
      call('apply_ops', { ops: [{ op: 'setNotes', target: { slide: 2 }, text: 'x' }] }),
    )
    expect((r as { isError?: boolean }).isError).toBe(true)
    expect(r.output).toContain('page order changed')
    expect(r.output).toContain('Nothing was modified')
    // the refusal carries the current order, so the model can renumber
    expect(r.output).toContain('The deck now has 2 page(s)')
    expect(r.output).toContain('page 1: Title')
    expect(r.output).toContain('page 2: Revenue')
    expect(r.output).toContain('read_slide')
    // nothing reached the executor
    expect(appliedOps).toHaveLength(0)

    for (const [name, input] of [
      ['execute_slide_script', { slideIndex: 1, code: 'moveBy("e0", 1, 1)' }],
      [
        'insert_web_image',
        { slideIndex: 1, url: 'https://example.com/a.png', x: 0, y: 0, w: 100, h: 100 },
      ],
      ['replace_image', { slideIndex: 1, sourceId: 'e0', url: 'https://example.com/b.png' }],
      ['edit_chart', { slideIndex: 1, sourceId: 'e0' }],
      ['regenerate_slide', { slideIndex: 1, brief: 'redo this page' }],
    ] as const) {
      const refused = await skill.executeTool(call(name, input))
      expect((refused as { isError?: boolean }).isError, name).toBe(true)
      expect(refused.output, name).toContain('page order changed')
    }
    expect(appliedOps).toHaveLength(0)
  })

  it('ops that address pages positionally OUTSIDE target.slide refuse too', async () => {
    const skill = createSlidesSkill(access)
    skill.buildContext!()
    deck = [deck[0]!, deck[2]!]
    for (const op of [
      // whole-deck find scoped to one page by a positional slideIndex
      { op: 'findReplace', find: 'x', replace: 'y', slideIndex: 1 },
      // identity-addressed move whose DESTINATION is a live position
      { op: 'moveSlide', target: { slide: 's_0' }, to: 0 },
      // section boundaries placed by page index
      { op: 'addSection', atSlideIndex: 1, name: 'n' },
      { op: 'setSections', sections: [{ id: 'S', name: 'n', slideIndices: [0, 1] }] },
    ]) {
      const refused = await skill.executeTool(call('apply_ops', { ops: [op] }))
      expect((refused as { isError?: boolean }).isError, JSON.stringify(op)).toBe(true)
      expect(refused.output, JSON.stringify(op)).toContain('page order changed')
    }
    expect(appliedOps).toHaveLength(0)
  })

  it('a refusal does not re-arm: a second stale write refuses too', async () => {
    const skill = createSlidesSkill(access)
    skill.buildContext!()
    deck = [deck[0]!, deck[2]!]
    const first = await skill.executeTool(
      call('apply_ops', { ops: [{ op: 'setText', target: { slide: 0, el: 'e0' }, text: 'x' }] }),
    )
    expect((first as { isError?: boolean }).isError).toBe(true)
    const second = await skill.executeTool(
      call('apply_ops', { ops: [{ op: 'setText', target: { slide: 0, el: 'e0' }, text: 'x' }] }),
    )
    expect((second as { isError?: boolean }).isError).toBe(true)
  })

  it('dry runs of numeric ops are refused too — a stale rehearsal must not read green', async () => {
    const skill = createSlidesSkill(access)
    skill.buildContext!()
    deck = [deck[0]!, deck[2]!]
    const r = await skill.executeTool(
      call('apply_ops', {
        ops: [{ op: 'setNotes', target: { slide: 2 }, text: 'x' }],
        dry_run: true,
      }),
    )
    expect((r as { isError?: boolean }).isError).toBe(true)
    expect(r.output).toContain('page order changed')
  })

  it('durable-id ops bypass the structure guard — identity addressing is reorder-proof', async () => {
    const skill = createSlidesSkill(access)
    skill.buildContext!()
    deck = [deck[0]!, deck[2]!]
    const r = await skill.executeTool(
      call('apply_ops', { ops: [{ op: 'setNotes', target: { slide: 's_9' }, text: 'x' }] }),
    )
    expect((r as { isError?: boolean }).isError).toBeFalsy()
    expect(appliedOps).toHaveLength(1)
  })

  it('read_slide reports the divergence, shows the current order, and refreshes addressing', async () => {
    const skill = createSlidesSkill(access)
    skill.buildContext!()
    deck = [deck[0]!, deck[2]!]
    const r = await skill.executeTool(call('read_slide', { slideIndex: 0 }))
    expect((r as { isError?: boolean }).isError).toBeFalsy()
    expect(r.output).toContain('page order changed')
    expect(r.output).toContain('CURRENT page')
    expect(r.output).toContain('The deck now has 2 page(s)')
    // the read re-arms: a numeric retry with current numbers goes through
    const retry = await skill.executeTool(
      call('apply_ops', { ops: [{ op: 'setNotes', target: { slide: 1 }, text: 'x' }] }),
    )
    expect((retry as { isError?: boolean }).isError).toBeFalsy()
    expect(appliedOps).toHaveLength(1)
  })

  it("the skill's own structural write re-arms the baseline from the RESULT deck", async () => {
    const skill = createSlidesSkill(access)
    skill.buildContext!()
    // the model's own structural change: the txn result carries the rebuilt
    // deck, exactly like the real flow
    txnSlides = [deck[0]!, deck[2]!]
    const r = await skill.executeTool(
      call('apply_ops', { ops: [{ op: 'deleteSlide', target: { slide: 1 } }] }),
    )
    expect((r as { isError?: boolean }).isError).toBeFalsy()
    expect(deck).toHaveLength(2)
    // the follow-up numeric write passes without any read in between
    const next = await skill.executeTool(
      call('apply_ops', { ops: [{ op: 'setNotes', target: { slide: 1 }, text: 'x' }] }),
    )
    expect((next as { isError?: boolean }).isError).toBeFalsy()
    expect(appliedOps).toHaveLength(2)
  })

  it('the re-arm reads the write result, not the still-committing render tree', async () => {
    // the real host lands deck changes through React state: getSlides() still
    // returns the PRE-change deck when the tool returns, and the commit lands
    // before the model's next call (an LLM roundtrip later). Simulate exactly
    // that: applyDeck drops the landing; the "commit" happens by hand.
    lagApplyDeck = true
    const skill = createSlidesSkill(access)
    skill.buildContext!()
    txnSlides = [deck[0]!, deck[2]!]
    const r = await skill.executeTool(
      call('apply_ops', { ops: [{ op: 'deleteSlide', target: { slide: 1 } }] }),
    )
    expect((r as { isError?: boolean }).isError).toBeFalsy()
    // the render tree has NOT committed: getSlides() is still the old 3 pages
    expect(deck).toHaveLength(3)
    // the React commit lands before the model's next call
    deck = [deck[0]!, deck[2]!]
    const next = await skill.executeTool(
      call('apply_ops', { ops: [{ op: 'setNotes', target: { slide: 1 }, text: 'x' }] }),
    )
    // re-armed from the txn result: the follow-up must not trip the guard. (A
    // re-arm that read the render tree would arm the pre-delete fingerprint.)
    expect((next as { isError?: boolean }).isError).toBeFalsy()
    expect(appliedOps).toHaveLength(2)
  })

  it('a content-only write does not re-arm — a user reorder during the await keeps the guard armed', async () => {
    const skill = createSlidesSkill(access)
    skill.buildContext!()
    // entry aligned; the user reorders the live deck while our content op is
    // in flight — main applies our op to the reordered deck and the txn
    // result carries it
    txnSlides = [deck[2]!, deck[0]!, deck[1]!]
    const r = await skill.executeTool(
      call('apply_ops', { ops: [{ op: 'setNotes', target: { slide: 0 }, text: 'x' }] }),
    )
    expect((r as { isError?: boolean }).isError).toBeFalsy()
    // the structure moved, but NOT by our op: the baseline must stay at the
    // run outline so the next positional write refuses
    const next = await skill.executeTool(
      call('apply_ops', { ops: [{ op: 'setNotes', target: { slide: 1 }, text: 'x' }] }),
    )
    expect((next as { isError?: boolean }).isError).toBe(true)
    expect(next.output).toContain('page order changed')
  })

  it('moveSection re-arms too — a section move reorders pages like moveSlide does', async () => {
    const skill = createSlidesSkill(access)
    skill.buildContext!()
    // the model moves a section: pages travel with it, so the post-op deck
    // carries a new order the model knows from its own op
    txnSlides = [deck[2]!, deck[0]!, deck[1]!]
    const r = await skill.executeTool(
      call('apply_ops', { ops: [{ op: 'moveSection', id: 'S', dir: 'up' }] }),
    )
    expect((r as { isError?: boolean }).isError).toBeFalsy()
    // a section op addresses by id, never by page position: no refusal even
    // on a diverged deck (checked below) and the re-arm must follow its own
    // reorder or every later positional write false-refuses
    const next = await skill.executeTool(
      call('apply_ops', { ops: [{ op: 'setNotes', target: { slide: 1 }, text: 'x' }] }),
    )
    expect((next as { isError?: boolean }).isError).toBeFalsy()
  })

  it('a structural write on an already-diverged deck does not re-arm (durable addressing only)', async () => {
    const skill = createSlidesSkill(access)
    skill.buildContext!()
    deck = [deck[0]!, deck[2]!]
    // durable-id deleteSlide bypasses the guard; the deck changes, but the
    // model's page numbers were already stale — the baseline must not move
    txnSlides = [deck[0]!]
    const r = await skill.executeTool(
      call('apply_ops', { ops: [{ op: 'deleteSlide', target: { slide: 's_2' } }] }),
    )
    expect((r as { isError?: boolean }).isError).toBeFalsy()
    expect(deck).toHaveLength(1)
    const next = await skill.executeTool(
      call('apply_ops', { ops: [{ op: 'setNotes', target: { slide: 0 }, text: 'x' }] }),
    )
    expect((next as { isError?: boolean }).isError).toBe(true)
    expect(next.output).toContain('page order changed')
  })

  it('regenerate_slide re-arms from the rebuilt deck it reports', async () => {
    const skill = createSlidesSkill(access)
    skill.buildContext!()
    // regenerate replaces the slot's part with a freshly merged one
    regenSlides = [deck[0]!, page('ppt/slides/slide9.xml', 'Redone'), deck[2]!]
    const r = await skill.executeTool(
      call('regenerate_slide', { slideIndex: 1, brief: 'redo this page' }),
    )
    expect((r as { isError?: boolean }).isError).toBeFalsy()
    // the fine-tune the tool output invites must not trip the guard
    const next = await skill.executeTool(
      call('apply_ops', { ops: [{ op: 'setNotes', target: { slide: 1 }, text: 'x' }] }),
    )
    expect((next as { isError?: boolean }).isError).toBeFalsy()
    expect(appliedOps).toHaveLength(1)
  })

  it('a regenerate result that is NOT a slot replacement does not re-arm (user restructure rode along)', async () => {
    const skill = createSlidesSkill(access)
    skill.buildContext!()
    // during the LLM generation window the user deletes page 3: the result
    // deck is our slot replacement AND the deletion — not the shape the model
    // can derive numbering from
    regenSlides = [deck[0]!, page('ppt/slides/slide9.xml', 'Redone')]
    const r = await skill.executeTool(
      call('regenerate_slide', { slideIndex: 1, brief: 'redo this page' }),
    )
    expect((r as { isError?: boolean }).isError).toBeFalsy()
    expect(deck).toHaveLength(2)
    // the baseline stays at the run outline: positional writes keep refusing
    // until the model reads the current order
    const next = await skill.executeTool(
      call('apply_ops', { ops: [{ op: 'setNotes', target: { slide: 1 }, text: 'x' }] }),
    )
    expect((next as { isError?: boolean }).isError).toBe(true)
    expect(next.output).toContain('page order changed')
  })

  it('an aligned deck never refuses', async () => {
    const skill = createSlidesSkill(access)
    skill.buildContext!()
    // a content-only change does not count as divergence
    deck = [...deck]
    const r = await skill.executeTool(
      call('apply_ops', { ops: [{ op: 'setNotes', target: { slide: 2 }, text: 'x' }] }),
    )
    expect((r as { isError?: boolean }).isError).toBeFalsy()
    expect(appliedOps).toHaveLength(1)
  })

  it('the QC pass arms the guard too: its fix writes are positioned and refuse a diverged deck', async () => {
    const qc = createSlideFixSkill(access)
    qc.buildContext!()
    deck = [deck[0]!, deck[2]!]
    const refused = await qc.executeTool(
      call('execute_slide_script', { slideIndex: 1, code: 'moveBy("e0", 1, 1)' }),
    )
    expect((refused as { isError?: boolean }).isError).toBe(true)
    expect(refused.output).toContain('page order changed')
  })
})
