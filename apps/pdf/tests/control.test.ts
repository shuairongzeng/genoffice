import { describe, expect, it, vi } from 'vitest'
import { handlePdfControl, type PdfControlState } from '../src/renderer/control'

const state = (overrides: Partial<PdfControlState> = {}): PdfControlState => ({
  loaded: true,
  pageCount: 4,
  currentPage: 2,
  scrollToPage: vi.fn(),
  selectedText: () => '',
  ...overrides,
})

describe('pdf control hook', () => {
  it('scrolls to a page inside the document and rejects one outside it', async () => {
    const s = state()
    expect(await handlePdfControl({ cmd: 'goto', target: { kind: 'page', page: 3 } }, s)).toEqual({
      status: 'ok',
      result: { page: 3 },
    })
    expect(s.scrollToPage).toHaveBeenCalledWith(3)
    expect(
      await handlePdfControl({ cmd: 'goto', target: { kind: 'page', page: 0 } }, s),
    ).toMatchObject({
      status: 'error',
      error: { reason: 'out_of_range', detail: { valid_range: '1-4' } },
    })
  })

  it('reports the current page and any selected text, or not_ready before the file loads', async () => {
    expect(await handlePdfControl({ cmd: 'selection' }, state({ loaded: false }))).toEqual({
      status: 'not_ready',
    })
    expect(
      await handlePdfControl({ cmd: 'selection' }, state({ selectedText: () => 'quoted' })),
    ).toEqual({
      status: 'ok',
      result: { page: 2, text: 'quoted' },
    })
  })

  it('a text target (the search deep link) reveals through gotoText', async () => {
    // issue #56: a search hit's cite opens the PDF where it matched
    const gotoText = vi.fn(async () => true)
    expect(
      await handlePdfControl(
        { cmd: 'goto', target: { kind: 'text', text: 'termination clause' } },
        state({ gotoText }),
      ),
    ).toEqual({ status: 'ok', result: { text: 'termination clause' } })
    expect(gotoText).toHaveBeenCalledWith('termination clause')
    // a miss is target_not_found, not not_ready — the ask loop stops there
    expect(
      await handlePdfControl(
        { cmd: 'goto', target: { kind: 'text', text: 'needle' } },
        state({ gotoText: vi.fn(async () => false) }),
      ),
    ).toMatchObject({ status: 'error', error: { reason: 'target_not_found' } })
  })

  it('an empty text target is invalid; no gotoText surface answers not_ready', async () => {
    expect(
      await handlePdfControl({ cmd: 'goto', target: { kind: 'text', text: '  ' } }, state()),
    ).toMatchObject({ status: 'error', error: { reason: 'invalid_argument' } })
    expect(
      await handlePdfControl(
        { cmd: 'goto', target: { kind: 'text', text: 'needle' } },
        state({ gotoText: undefined }),
      ),
    ).toEqual({ status: 'not_ready' })
  })
})
