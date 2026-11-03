import { describe, expect, it } from 'vitest'

import {
  FEW_HEADING_COUNT,
  LONG_DOC_WORDS,
  MAX_DOC_SUGGESTIONS,
  STRUCTURE_MIN_WORDS,
  suggestForDocument,
  type DocSuggestion,
  type DocSuggestionMeta,
} from '../src/renderer/src/doc-suggestions'

/**
 * The document-suggestion engine (src/renderer/src/doc-suggestions.ts): the
 * rule table that turns what the shell knows about the open document into the
 * AI panel's per-document suggestions — the lineage continuation verbs first,
 * the blank page's starting kinds, the long/structure shape rules, the kind
 * rules (sheets data actions, slides polish, the pdf digest trio, markdown's
 * polish/publish), the everyday prose trio last. These tests pin every
 * branch the table has, the cap and the dedupe that hold the answer at four
 * stable keys, and the degenerate-metadata promise: junk never throws, and
 * every document — even an unrecognizable one — gets at least one safe
 * suggestion.
 */

/** the baseline: a plain non-empty docx, nothing else known about it */
const meta = (over: Partial<DocSuggestionMeta> = {}): DocSuggestionMeta => ({
  kind: 'docs',
  fileName: 'report.docx',
  isEmpty: false,
  hasLineage: false,
  ...over,
})

/** the junk-typed metadata a bad bridge could hand the engine */
const junk = (over: Record<string, unknown>): DocSuggestionMeta =>
  meta(over as Partial<DocSuggestionMeta>)

/** just the keys, in order — the shape pins use full objects */
const keys = (out: readonly DocSuggestion[]): string[] => out.map((each) => each.key)

describe('the lineage rule (the continuity case)', () => {
  it('leads with the continuation verbs on a task-born document', () => {
    expect(keys(suggestForDocument(meta({ hasLineage: true })))).toEqual([
      'continue-writing',
      'expand',
      'polish',
      'translate',
    ])
  })

  it('outranks the digest pair on a long lineage document', () => {
    expect(keys(suggestForDocument(meta({ hasLineage: true, wordCount: 9000 })))).toEqual([
      'continue-writing',
      'expand',
      'summarize',
      'outline',
    ])
  })

  it('fires on an empty task-born document: an interrupted task resumes', () => {
    const out = suggestForDocument(
      meta({ hasLineage: true, isEmpty: true, fileName: 'untitled.docx' }),
    )
    expect(keys(out)).toEqual(['continue-writing', 'expand', 'draft', 'outline'])
  })

  it('an empty task-born sheet resumes first, then fills', () => {
    expect(
      keys(suggestForDocument(meta({ hasLineage: true, isEmpty: true, kind: 'sheets' }))),
    ).toEqual(['continue-writing', 'expand', 'fill-data'])
  })

  it('stays quiet without lineage: expand is the lineage rule’s own verb', () => {
    const out = keys(suggestForDocument(meta()))
    expect(out).not.toContain('continue-writing')
    expect(out).not.toContain('expand')
  })
})

describe('the blank-page rule (an empty document suggests starting kinds)', () => {
  it('a fresh docx wants a draft — seeded with its own topic — and an outline', () => {
    expect(suggestForDocument(meta({ isEmpty: true }))).toEqual([
      { key: 'draft', params: { topic: 'report' } },
      { key: 'outline' },
    ])
  })

  it('an empty sheet wants its first data; an empty deck its first presentation', () => {
    expect(keys(suggestForDocument(meta({ isEmpty: true, kind: 'sheets' })))).toEqual(['fill-data'])
    expect(keys(suggestForDocument(meta({ isEmpty: true, kind: 'slides' })))).toEqual([
      'make-presentation',
    ])
  })

  it('no content rule fires on empty: summarize/polish/publish wait for words', () => {
    const out = keys(suggestForDocument(meta({ isEmpty: true, kind: 'markdown', wordCount: 5000 })))
    expect(out).toEqual(['draft', 'outline'])
  })
})

describe('the draft’s topic seed (params carry facts, never prose)', () => {
  it('the title wins when the app reports one', () => {
    const out = suggestForDocument(
      meta({ isEmpty: true, title: 'Launch Plan', fileName: 'q3-notes.docx' }),
    )
    expect(out[0]).toEqual({ key: 'draft', params: { topic: 'Launch Plan' } })
  })

  it('falls back to the file name’s stem — path and extension stripped', () => {
    const out = suggestForDocument(meta({ isEmpty: true, fileName: '/desk/Q3 Report.docx' }))
    expect(out[0]).toEqual({ key: 'draft', params: { topic: 'Q3 Report' } })
  })

  it('a placeholder stem is no seed at all: the draft carries no params', () => {
    for (const fileName of ['untitled.docx', 'Untitled 7.docx', 'untitled-2.md', '.docx']) {
      expect(suggestForDocument(meta({ isEmpty: true, fileName }))[0]).toEqual({ key: 'draft' })
    }
  })

  it('an unusable title falls through to the file name’s stem', () => {
    const blank = suggestForDocument(meta({ isEmpty: true, title: '  ', fileName: 'notes.md' }))
    const placeholder = suggestForDocument(
      meta({ isEmpty: true, title: 'Untitled', fileName: 'notes.md' }),
    )
    expect(blank[0]).toEqual({ key: 'draft', params: { topic: 'notes' } })
    expect(placeholder[0]).toEqual({ key: 'draft', params: { topic: 'notes' } })
  })
})

describe('the long-document rule (the digest pair)', () => {
  it('a long doc leads with summarize, then outline as the navigation aid', () => {
    expect(keys(suggestForDocument(meta({ wordCount: 2500 })))).toEqual([
      'summarize',
      'outline',
      'polish',
      'translate',
    ])
  })

  it('the line sits at LONG_DOC_WORDS, inclusive', () => {
    expect(keys(suggestForDocument(meta({ wordCount: LONG_DOC_WORDS - 1 })))).not.toContain(
      'summarize',
    )
    expect(keys(suggestForDocument(meta({ wordCount: LONG_DOC_WORDS })))[0]).toBe('summarize')
  })

  it('wordCount is a word metric: a huge sheet or deck never takes the outline', () => {
    expect(keys(suggestForDocument(meta({ kind: 'sheets', wordCount: 5000 })))).toEqual([
      'fill-data',
      'summarize',
    ])
    expect(keys(suggestForDocument(meta({ kind: 'slides', wordCount: 5000 })))).toEqual([
      'polish',
      'summarize',
    ])
  })

  it('a long pdf keeps the pair, with the fixed-layout trio behind it', () => {
    expect(keys(suggestForDocument(meta({ kind: 'pdf', wordCount: 4000 })))).toEqual([
      'summarize',
      'outline',
      'translate',
      'make-presentation',
    ])
  })
})

describe('the structure rule (few headings suggest structure)', () => {
  it('a heading-light doc with words worth structuring leads with outline', () => {
    expect(keys(suggestForDocument(meta({ wordCount: 600, headings: ['Intro'] })))).toEqual([
      'outline',
      'polish',
      'translate',
      'make-presentation',
    ])
  })

  it('the few line sits below FEW_HEADING_COUNT; the word floor at STRUCTURE_MIN_WORDS', () => {
    // FEW_HEADING_COUNT headings exactly is structured enough
    expect(
      keys(suggestForDocument(meta({ wordCount: 600, headings: ['a', 'b', 'c'] }))),
    ).not.toContain('outline')
    // fewer headings, but too few words: a short note needs no outline
    expect(
      keys(suggestForDocument(meta({ wordCount: STRUCTURE_MIN_WORDS - 1, headings: [] }))),
    ).not.toContain('outline')
    // at the floor exactly, structure fires
    expect(
      keys(suggestForDocument(meta({ wordCount: STRUCTURE_MIN_WORDS, headings: [] })))[0],
    ).toBe('outline')
  })

  it('a heading count the app never reported is unknown, not few', () => {
    expect(keys(suggestForDocument(meta({ wordCount: 600 })))).not.toContain('outline')
  })

  it('an unknown word count defers to the heading data, which is authoritative', () => {
    expect(keys(suggestForDocument(meta({ headings: [] })))[0]).toBe('outline')
  })

  it('structure is a word-shaped fix: a heading-light pdf takes the digest trio instead', () => {
    expect(keys(suggestForDocument(meta({ kind: 'pdf', wordCount: 600, headings: [] })))).toEqual([
      'summarize',
      'translate',
      'make-presentation',
    ])
  })
})

describe('the sheets rule (data actions)', () => {
  it('a non-empty workbook suggests fill-data, then what the data says', () => {
    expect(keys(suggestForDocument(meta({ kind: 'sheets', fileName: 'budget.xlsx' })))).toEqual([
      'fill-data',
      'summarize',
    ])
  })
})

describe('the slides rule', () => {
  it('a non-empty deck wants polish first, then its story', () => {
    expect(keys(suggestForDocument(meta({ kind: 'slides' })))).toEqual(['polish', 'summarize'])
  })
})

describe('the pdf rule (the fixed-layout trio)', () => {
  it('a pdf is a read-me artifact: digest, translate, repurpose — never polish', () => {
    expect(keys(suggestForDocument(meta({ kind: 'pdf' })))).toEqual([
      'summarize',
      'translate',
      'make-presentation',
    ])
  })
})

describe('the markdown rule (polish/publish)', () => {
  it('a markdown doc polishes then publishes, ahead of the prose trio', () => {
    expect(keys(suggestForDocument(meta({ kind: 'markdown', fileName: 'readme.md' })))).toEqual([
      'polish',
      'publish',
      'translate',
      'make-presentation',
    ])
  })

  it('publish needs content: an empty markdown gets the starting kinds', () => {
    expect(
      keys(suggestForDocument(meta({ kind: 'markdown', isEmpty: true, fileName: 'untitled.md' }))),
    ).toEqual(['draft', 'outline'])
  })
})

describe('the prose trio (the everyday fallback)', () => {
  it('a plain docx: polish, translate, make-presentation', () => {
    expect(keys(suggestForDocument(meta()))).toEqual(['polish', 'translate', 'make-presentation'])
  })

  it('html and unknown kinds read as prose — the safe default', () => {
    for (const kind of ['html', 'telegram-export', ''] as const) {
      expect(keys(suggestForDocument(meta({ kind })))).toEqual([
        'polish',
        'translate',
        'make-presentation',
      ])
    }
  })

  it('the kind is matched trimmed and case-insensitively', () => {
    expect(keys(suggestForDocument(meta({ kind: '  Sheets ' })))).toEqual([
      'fill-data',
      'summarize',
    ])
  })
})

describe('the cap, the dedupe, and the stable order', () => {
  it('never answers more than MAX_DOC_SUGGESTIONS', () => {
    // lineage + the blank page is the fullest pipeline: four keys exactly
    expect(suggestForDocument(meta({ isEmpty: true, hasLineage: true }))).toHaveLength(
      MAX_DOC_SUGGESTIONS,
    )
    // long + heading-light + markdown would offer six; the cap keeps four
    expect(
      keys(suggestForDocument(meta({ kind: 'markdown', wordCount: 3000, headings: [] }))),
    ).toEqual(['summarize', 'outline', 'polish', 'publish'])
  })

  it('no key appears twice: re-offerings (the long rule’s summarize, the structure rule’s outline) dedupe', () => {
    // the pdf rule re-offers summarize the long rule already contributed
    expect(keys(suggestForDocument(meta({ kind: 'pdf', wordCount: 4000 })))[0]).toBe('summarize')
    expect(
      keys(suggestForDocument(meta({ kind: 'pdf', wordCount: 4000 }))).filter(
        (key) => key === 'summarize',
      ),
    ).toHaveLength(1)
    // and a lineage workbook meets the sheets pair after the continuation verbs
    expect(
      keys(suggestForDocument(meta({ kind: 'sheets', wordCount: 5000, hasLineage: true }))),
    ).toEqual(['continue-writing', 'expand', 'fill-data', 'summarize'])
  })

  it('the same metadata always yields the same answer, key for key', () => {
    const once = suggestForDocument(meta({ wordCount: 3000, headings: ['only one'] }))
    const twice = suggestForDocument(meta({ wordCount: 3000, headings: ['only one'] }))
    expect(once).toEqual(twice)
  })
})

describe('degenerate metadata', () => {
  it('a meta that is not even an object answers the fresh-document pair', () => {
    for (const bad of [null, undefined, 7, 'doc'] as unknown as DocSuggestionMeta[]) {
      expect(suggestForDocument(bad)).toEqual([{ key: 'draft' }, { key: 'outline' }])
    }
  })

  it('every field junk at once still answers, without throwing', () => {
    const out = suggestForDocument(
      junk({
        kind: 7,
        fileName: null,
        title: 42,
        wordCount: 'lots',
        headings: 'nope',
        isEmpty: 'maybe',
        hasLineage: [],
      }),
    )
    expect(keys(out)).toEqual(['polish', 'translate', 'make-presentation'])
  })

  it('junk flags read as the quiet default: no continuity, no blank page', () => {
    // only a literal true is true — a truthy-but-not-true value conjures nothing
    expect(keys(suggestForDocument(junk({ hasLineage: 'yes' })))).not.toContain('continue-writing')
    expect(keys(suggestForDocument(junk({ isEmpty: 1 })))).not.toContain('draft')
  })

  it('a junk kind reads as prose; a NaN or negative word count as unknown', () => {
    expect(keys(suggestForDocument(junk({ kind: 7 })))).toEqual([
      'polish',
      'translate',
      'make-presentation',
    ])
    // unknown words + known-few headings: the heading data still structures
    expect(keys(suggestForDocument(junk({ wordCount: Number.NaN, headings: [] })))[0]).toBe(
      'outline',
    )
    expect(keys(suggestForDocument(junk({ wordCount: -50 })))).not.toContain('summarize')
  })

  it('headings that are not an array are unknown, not zero', () => {
    expect(keys(suggestForDocument(junk({ headings: 'nope', wordCount: 600 })))).not.toContain(
      'outline',
    )
  })
})

describe('the invariants (every rule branch, junk included)', () => {
  const KINDS: readonly unknown[] = [
    'docs',
    'sheets',
    'slides',
    'pdf',
    'markdown',
    'html',
    'weird-app',
    '',
    'Docs',
    7,
    null,
  ]
  const WORDS: readonly unknown[] = [
    undefined,
    0,
    150,
    199,
    200,
    1199,
    1200,
    9000,
    Number.NaN,
    -7,
    'lots',
  ]
  const HEADINGS: readonly unknown[] = [
    undefined,
    [],
    ['a'],
    ['a', 'b'],
    ['a', 'b', 'c'],
    'nope',
    null,
  ]

  it('never throws, always answers, never duplicates, never exceeds the cap', () => {
    for (const kind of KINDS) {
      for (const isEmpty of [true, false]) {
        for (const hasLineage of [true, false]) {
          for (const wordCount of WORDS) {
            for (const headings of HEADINGS) {
              const out = suggestForDocument(
                junk({
                  kind,
                  isEmpty,
                  hasLineage,
                  wordCount,
                  headings,
                  fileName: 'x.docx',
                  title: 'T',
                }),
              )
              expect(out.length).toBeGreaterThanOrEqual(1)
              expect(out.length).toBeLessThanOrEqual(MAX_DOC_SUGGESTIONS)
              expect(new Set(keys(out)).size).toBe(out.length)
              // every suggestion carries a real key, and params, when present, are strings
              for (const each of out) {
                expect(typeof each.key).toBe('string')
                expect(each.key).not.toBe('')
                for (const value of Object.values(each.params ?? {})) {
                  expect(typeof value).toBe('string')
                }
              }
            }
          }
        }
      }
    }
  })
})

describe('the tuned lines (shared with the integration slice)', () => {
  it('are the documented numbers: a cap of four, a 1200-word long line, a 200-word structure floor, three headings', () => {
    expect(MAX_DOC_SUGGESTIONS).toBe(4)
    expect(LONG_DOC_WORDS).toBe(1200)
    expect(STRUCTURE_MIN_WORDS).toBe(200)
    expect(FEW_HEADING_COUNT).toBe(3)
  })
})
