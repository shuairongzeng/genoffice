import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_COMPARE_CHARS,
  createDocumentTextExtractor,
  extractDocsLivePlainText,
  formatSheetsLiveText,
  formatSlidesLiveText,
  htmlToPlainText,
  type DocumentTabInfo,
} from './document-text-extractor'

function fakeWc(extras: Record<string, unknown> = {}): WebContents {
  return { id: 101, ...extras } as unknown as WebContents
}

describe('htmlToPlainText', () => {
  it('strips scripts/styles, preserves line breaks, decodes entities, and collapses excess blank lines', () => {
    const html = [
      '<!-- ignored comment -->',
      '<style>.x { color: red; }</style>',
      '<script>alert("xss")</script>',
      '<h1>Title &amp; Overview</h1>',
      '<p>Hello&nbsp;World &lt;tag&gt; &quot;quoted&quot; &#39;single&#39; &#x4E2D;&#25991;</p>',
      '<p>Line 1<br/>Line 2   </p>',
      '',
      '',
      '',
      '',
      '<table><tr><td>Cell A</td><td>Cell B</td></tr></table>',
      '<p>&amp;lt;not-decoded-twice&amp;gt;</p>',
    ].join('\n')

    const plain = htmlToPlainText(html)
    expect(plain).not.toContain('alert')
    expect(plain).not.toContain('color: red')
    expect(plain).toContain('Title & Overview')
    expect(plain).toContain('Hello World <tag> "quoted" \'single\' 中文')
    expect(plain).toContain('Line 1\nLine 2')
    expect(plain).toContain('Cell A\tCell B')
    expect(plain).toContain('&lt;not-decoded-twice&gt;')
    expect(plain).not.toMatch(/\n{3,}/)
    expect(plain).not.toMatch(/[ \t]+$/m)
  })
})

describe('extractDocsLivePlainText', () => {
  it('extracts body from Full content and Content preview responses with truncation info', () => {
    const full = [
      'The document has 2 blocks, listed below (index|type|content preview):',
      '0|h1|Heading',
      '1|p|Body text',
      'Full-text stats: words 3, characters (no spaces) 15, characters (with spaces) 17',
      '',
      '## Full content (blocks 0-1)',
      '<h1>Heading</h1><p>Body text</p>',
    ].join('\n')

    expect(extractDocsLivePlainText(full)).toEqual({
      text: 'Heading\nBody text',
    })

    const preview = [
      'The document has 10 blocks, listed below (index|type|content preview):',
      '0|p|First chunk',
      'Full-text stats: words 100, characters (no spaces) 500, characters (with spaces) 600',
      '',
      '## Content preview (blocks 0-9, characters 0..16000 of 35000)',
      '<p>First chunk</p>',
      '…(truncated: 35000 characters in total, call read_document again with offset=16000 or pass startBlockIndex/endBlockIndex to read specific blocks)',
    ].join('\n')

    expect(extractDocsLivePlainText(preview)).toEqual({
      text: 'First chunk',
      totalLength: 35000,
      nextOffset: 16000,
    })
  })

  it('extracts paginated read_blocks output and strips overview metadata headers', () => {
    const paged = '<p>Second chunk</p>\n(end of range: 35000 characters in total)'
    expect(extractDocsLivePlainText(paged)).toEqual({
      text: 'Second chunk',
      totalLength: 35000,
    })

    const overviewOnly = [
      'The document has 2 blocks, listed below (index|type|content preview):',
      '0|h1|Chapter One',
      '1|p|Summary paragraph',
      'Full-text stats: words 4, characters (no spaces) 25, characters (with spaces) 28',
      'No selection; cursor is in block 0',
    ].join('\n')

    expect(extractDocsLivePlainText(overviewOnly)).toEqual({
      text: 'Chapter One\nSummary paragraph',
    })

    expect(extractDocsLivePlainText('(document is empty)')).toEqual({ text: '' })
  })
})

describe('formatSheetsLiveText and formatSlidesLiveText', () => {
  it('formats multiple Sheets payload shapes', () => {
    expect(formatSheetsLiveText({ text: 'raw sheet text' })).toBe('raw sheet text')
    expect(formatSheetsLiveText({ summary: 'workbook summary' })).toBe('workbook summary')
    expect(
      formatSheetsLiveText({
        sheets: [
          {
            name: 'Revenue',
            rows: [
              ['Month', 'Amount'],
              ['Jan', { display: '$100', value: 100 }],
            ],
          },
          {
            sheetName: 'Costs',
            data: [
              ['Item', 'Cost'],
              ['Hosting', 40],
            ],
          },
        ],
      }),
    ).toBe('# Revenue\nMonth | Amount\nJan | $100\n\n# Costs\nItem | Cost\nHosting | 40')

    expect(
      formatSheetsLiveText({
        context: { sheets: [{ id: 's1', name: 'Q1', rows: 2, columns: 2 }] },
        preview: { sheetName: 'Q1', grid: '\tA\tB\n1\tName\tScore\n2\tAda\t99' },
      }),
    ).toBe('# Q1\n\tA\tB\n1\tName\tScore\n2\tAda\t99')
  })

  it('formats Slides readDeck payloads by slide page number', () => {
    expect(formatSlidesLiveText({ text: 'deck plain text' })).toBe('deck plain text')
    expect(
      formatSlidesLiveText({
        totalSlides: 2,
        slides: [
          {
            index: 0,
            elements: [
              { type: 'text', text: 'Quarterly Review' },
              {
                type: 'group',
                children: [{ type: 'shape', text: 'Subtitle inside group' }],
              },
            ],
            notes: 'Opening remarks',
          },
          {
            index: 1,
            elements: [
              {
                type: 'chart',
                categories: ['Q1', 'Q2'],
                series: [{ name: 'Sales', values: [10, 20] }],
              },
            ],
          },
        ],
      }),
    ).toBe(
      '## Slide 1\nQuarterly Review\nSubtitle inside group\n### Notes\nOpening remarks\n\n## Slide 2\nCategories: Q1 | Q2\nSales: 10 | 20',
    )
  })
})

describe('createDocumentTextExtractor', () => {
  it('stitches paginated Docs live chunks seamlessly across split HTML tags', async () => {
    const readLiveDocs = vi
      .fn()
      .mockResolvedValueOnce({
        text: [
          'The document has 2 blocks, listed below (index|type|content preview):',
          '0|p|First',
          'Full-text stats: words 2, characters (no spaces) 10, characters (with spaces) 11',
          '',
          '## Content preview (blocks 0-1, characters 0..20 of 40)',
          '<p>Hello </p><p>Wor',
          '…(truncated: 40 characters in total, call read_document again with offset=20 or pass startBlockIndex/endBlockIndex to read specific blocks)',
        ].join('\n'),
      })
      .mockResolvedValueOnce({
        text: 'ld!</p>\n(end of range: 40 characters in total)',
      })

    const extractor = createDocumentTextExtractor({
      findTab: (id) =>
        id === 'detached:42'
          ? { id: 'detached:42', kind: 'docs', title: 'Draft', webContents: fakeWc() }
          : undefined,
      readLiveDocs,
      parseFileOnDisk: vi.fn(),
    })

    const extracted = await extractor.extract({ kind: 'tab', tabId: 'detached:42' })
    expect(readLiveDocs).toHaveBeenCalledTimes(2)
    expect(readLiveDocs).toHaveBeenNthCalledWith(1, expect.anything(), {})
    expect(readLiveDocs).toHaveBeenNthCalledWith(2, expect.anything(), { offset: 20 })
    expect(extracted.text).toBe('Hello\nWorld!')
    expect(extracted.meta).toMatchObject({
      id: 'tab:detached:42',
      tabId: 'detached:42',
      tabKind: 'docs',
      label: 'Draft',
      source: 'live',
      charCount: 'Hello\nWorld!'.length,
      lineCount: 2,
    })
  })

  it('falls back to parseFileOnDisk with source="disk" and warning when live reader throws', async () => {
    const tab: DocumentTabInfo = {
      id: 'tab-sheet',
      kind: 'sheets',
      title: 'Budget.xlsx',
      filePath: '/work/Budget.xlsx',
      webContents: fakeWc(),
    }
    const parseFileOnDisk = vi.fn().mockResolvedValue({
      ok: true,
      kind: 'text',
      text: '# Sheet1\nItem | Cost\nDesk | 200',
    })

    const extractor = createDocumentTextExtractor({
      findTab: () => tab,
      readLiveSheets: vi.fn().mockRejectedValue(new Error('renderer disconnected')),
      parseFileOnDisk,
    })

    const extracted = await extractor.extract({ kind: 'tab', tabId: 'tab-sheet' })
    expect(parseFileOnDisk).toHaveBeenCalledWith('/work/Budget.xlsx')
    expect(extracted.text).toBe('# Sheet1\nItem | Cost\nDesk | 200')
    expect(extracted.meta.source).toBe('disk')
    expect(extracted.meta.warning).toContain('renderer disconnected')
  })

  it('falls back to parseFileOnDisk when live reader returns empty string for a saved tab', async () => {
    const tab: DocumentTabInfo = {
      id: 'tab-doc-saved',
      kind: 'docs',
      title: 'Report.docx',
      filePath: '/work/Report.docx',
      webContents: fakeWc(),
    }
    const parseFileOnDisk = vi.fn().mockResolvedValue({
      ok: true,
      kind: 'text',
      text: 'Saved report body',
    })

    const extractor = createDocumentTextExtractor({
      findTab: () => tab,
      readLiveDocs: vi.fn().mockResolvedValue({ text: '(document is empty)' }),
      parseFileOnDisk,
    })

    const extracted = await extractor.extract({ kind: 'tab', tabId: 'tab-doc-saved' })
    expect(parseFileOnDisk).toHaveBeenCalledWith('/work/Report.docx')
    expect(extracted.text).toBe('Saved report body')
    expect(extracted.meta.source).toBe('disk')
    expect(extracted.meta.warning).toContain('empty content')
  })

  it('stops paginating Docs live chunks once MAX_COMPARE_CHARS is reached', async () => {
    const chunkA = 'x'.repeat(200_000)
    const chunkB = 'y'.repeat(150_000)
    const readLiveDocs = vi
      .fn()
      .mockResolvedValueOnce({
        text: `## Content preview (blocks 0-1)\n<p>${chunkA}</p>\n…(truncated: 400000 characters in total, call read_document again with offset=200000)`,
      })
      .mockResolvedValueOnce({
        text: `<p>${chunkB}</p>\n…(truncated: 400000 characters in total, call read_document again with offset=350000)`,
      })
      .mockResolvedValueOnce({
        text: '<p>should not be fetched</p>',
      })

    const extractor = createDocumentTextExtractor({
      findTab: () => ({ id: 'doc-big', kind: 'docs', title: 'Big', webContents: fakeWc() }),
      readLiveDocs,
      parseFileOnDisk: vi.fn(),
    })

    const extracted = await extractor.extract({ kind: 'tab', tabId: 'doc-big' })
    expect(readLiveDocs).toHaveBeenCalledTimes(2)
    expect(extracted.text.length).toBe(MAX_COMPARE_CHARS)
    expect(extracted.meta.truncated).toBe(true)
  })

  it('returns empty text without crashing for an unsaved blank tab', async () => {
    const tab: DocumentTabInfo = {
      id: 'blank-1',
      kind: 'markdown',
      title: 'Untitled',
      webContents: fakeWc(),
    }

    const extractor = createDocumentTextExtractor({
      findTab: () => tab,
      readLiveMarkdown: vi.fn().mockResolvedValue(''),
      parseFileOnDisk: vi.fn(),
    })

    const extracted = await extractor.extract({ kind: 'tab', tabId: 'blank-1' })
    expect(extracted.text).toBe('')
    expect(extracted.meta).toMatchObject({
      source: 'live',
      charCount: 0,
      lineCount: 0,
    })
  })

  it('reads browser tabs via default executeJavaScript fallback and truncates text over 300,000 chars', async () => {
    const huge = 'A'.repeat(MAX_COMPARE_CHARS + 500)
    const tab: DocumentTabInfo = {
      id: 'browser-1',
      kind: 'browser',
      title: 'Web Page',
      webContents: fakeWc({
        executeJavaScript: vi.fn().mockResolvedValue(huge),
      }),
    }

    const extractor = createDocumentTextExtractor({
      findTab: () => tab,
      parseFileOnDisk: vi.fn(),
    })

    const extracted = await extractor.extract({ kind: 'tab', tabId: 'browser-1' })
    expect(extracted.text.length).toBe(MAX_COMPARE_CHARS)
    expect(extracted.meta.truncated).toBe(true)
    expect(extracted.meta.source).toBe('live')
  })

  it('throws readable errors when disk parsing fails or returns non-text kind', async () => {
    const extractor = createDocumentTextExtractor({
      findTab: () => undefined,
      parseFileOnDisk: vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          kind: 'unsupported',
          error: 'Unsupported file type: .zip',
        })
        .mockResolvedValueOnce({ ok: true, kind: 'image' }),
    })

    await expect(extractor.extract({ kind: 'file', filePath: '/tmp/archive.zip' })).rejects.toThrow(
      'Unsupported file type: .zip',
    )
    await expect(extractor.extract({ kind: 'file', filePath: '/tmp/photo.png' })).rejects.toThrow(
      'not a comparable text document',
    )
  })
})
