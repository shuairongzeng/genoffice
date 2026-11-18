import { describe, expect, it, vi } from 'vitest'
import { revealPdfText } from '../src/renderer/text-reveal'
import type { PageEntry, SearchIndex } from '../src/renderer/search'

const page = (text: string): PageEntry => ({
  text,
  lower: text.toLowerCase(),
  items: [{ start: 0, end: text.length, x: 0, y: 0, w: 100, h: 10 }],
})

const index: SearchIndex = [
  page('Lease termination clause here.'),
  page('Another termination clause.'),
  page('No match on this page.'),
]

describe('revealPdfText (the search deep link reveal)', () => {
  it('stages the find surface on the first match and reports success', async () => {
    const applyFindState = vi.fn()
    const ok = await revealPdfText(
      {
        searchIndex: () => Promise.resolve(index),
        deletedPages: () => new Set<number>(),
        applyFindState,
      },
      'termination clause',
    )
    expect(ok).toBe(true)
    expect(applyFindState).toHaveBeenCalledTimes(1)
    const state = applyFindState.mock.calls[0]![0]!
    expect(state.open).toBe(true)
    expect(state.query).toBe('termination clause')
    // both carrying pages matched; the miss page contributed nothing
    expect(state.matches.map((m: { pageIndex: number }) => m.pageIndex)).toEqual([0, 1])
  })

  it('a deleted page never reveals: its matches are filtered out before staging', async () => {
    const applyFindState = vi.fn()
    const ok = await revealPdfText(
      {
        searchIndex: () => Promise.resolve(index),
        deletedPages: () => new Set([0]),
        applyFindState,
      },
      'termination clause',
    )
    expect(ok).toBe(true)
    const state = applyFindState.mock.calls[0]![0]!
    expect(state.matches.map((m: { pageIndex: number }) => m.pageIndex)).toEqual([1])

    // every carrying page deleted → nothing to reveal, find bar stays closed
    const none = await revealPdfText(
      {
        searchIndex: () => Promise.resolve(index),
        deletedPages: () => new Set([0, 1]),
        applyFindState,
      },
      'termination clause',
    )
    expect(none).toBe(false)
    expect(applyFindState).toHaveBeenCalledTimes(1)
  })

  it('no document and no match are both false, with the find surface untouched', async () => {
    const applyFindState = vi.fn()
    expect(
      await revealPdfText(
        { searchIndex: () => null, deletedPages: () => new Set(), applyFindState },
        'termination clause',
      ),
    ).toBe(false)
    expect(
      await revealPdfText(
        {
          searchIndex: () => Promise.resolve(index),
          deletedPages: () => new Set(),
          applyFindState,
        },
        'needle',
      ),
    ).toBe(false)
    expect(applyFindState).not.toHaveBeenCalled()
  })
})
