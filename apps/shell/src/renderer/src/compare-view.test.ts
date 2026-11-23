import { describe, expect, it } from 'vitest'
import type { CompareResult, CompareTabSource, DiffRow } from '../../shared/home-api'
import {
  buildCompareSummaryMarkdown,
  filterVisibleRows,
  parseSourceSelectValue,
  pickDefaultCompareSources,
  sourceRefKey,
  stepHunkIndex,
} from './CompareView'
import { buildCompareOpenOptions } from './HomeTabs'

function makeRow(index: number, kind: DiffRow['kind'], hunkIndex = -1): DiffRow {
  return {
    index,
    kind,
    leftLineNo: kind === 'insert' ? null : index + 1,
    rightLineNo: kind === 'delete' ? null : index + 1,
    leftText: kind === 'insert' ? '' : `left-${index}`,
    rightText: kind === 'delete' ? '' : `right-${index}`,
    hunkIndex,
  }
}

describe('CompareView helpers', () => {
  describe('sourceRefKey & parseSourceSelectValue', () => {
    it('serializes and parses tab and file refs including Windows drive colons', () => {
      expect(sourceRefKey(null)).toBe('')
      expect(sourceRefKey({ kind: 'tab', tabId: 'tab-1' })).toBe('tab:tab-1')
      expect(sourceRefKey({ kind: 'file', filePath: 'C:\\docs\\report.docx' })).toBe(
        'file:C:\\docs\\report.docx',
      )

      expect(parseSourceSelectValue('')).toBeNull()
      expect(parseSourceSelectValue('tab:tab-1')).toEqual({ kind: 'tab', tabId: 'tab-1' })
      expect(parseSourceSelectValue('file:C:\\docs\\report.docx')).toEqual({
        kind: 'file',
        filePath: 'C:\\docs\\report.docx',
      })
      expect(parseSourceSelectValue('tab:')).toBeNull()
      expect(parseSourceSelectValue('file:')).toBeNull()
      expect(parseSourceSelectValue('unknown:123')).toBeNull()
    })
  })

  describe('filterVisibleRows', () => {
    const sampleRows: DiffRow[] = [
      makeRow(0, 'equal'),
      makeRow(1, 'equal'),
      makeRow(2, 'equal'),
      makeRow(3, 'equal'),
      makeRow(4, 'delete', 0),
      makeRow(5, 'equal'),
      makeRow(6, 'equal'),
      makeRow(7, 'equal'),
      makeRow(8, 'equal'),
      makeRow(9, 'equal'),
      makeRow(10, 'insert', 1),
      makeRow(11, 'replace', 1),
      makeRow(12, 'equal'),
      makeRow(13, 'equal'),
      makeRow(14, 'equal'),
    ]

    it('returns all rows unchanged when onlyChanges is false', () => {
      const result = filterVisibleRows(sampleRows, false)
      expect(result).toBe(sampleRows)
    })

    it('keeps changed rows plus contextLines=2 around each cluster without duplicates', () => {
      const result = filterVisibleRows(sampleRows, true)
      expect(result.map((r) => r.index)).toEqual([2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13])
    })

    it('merges overlapping context windows between nearby changes', () => {
      const nearbyRows: DiffRow[] = [
        makeRow(0, 'equal'),
        makeRow(1, 'delete', 0),
        makeRow(2, 'equal'),
        makeRow(3, 'equal'),
        makeRow(4, 'insert', 1),
        makeRow(5, 'equal'),
      ]
      const result = filterVisibleRows(nearbyRows, true, 2)
      expect(result.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5])
    })

    it('supports contextLines=0 and returns empty when there are no differences', () => {
      expect(filterVisibleRows(sampleRows, true, 0).map((r) => r.index)).toEqual([4, 10, 11])

      const equalRows = [makeRow(0, 'equal'), makeRow(1, 'equal')]
      expect(filterVisibleRows(equalRows, true)).toEqual([])
    })
  })

  describe('stepHunkIndex', () => {
    it('returns -1 when there are no hunks', () => {
      expect(stepHunkIndex(0, [], 1)).toBe(-1)
      expect(stepHunkIndex(-1, [], -1)).toBe(-1)
    })

    it('initializes from -1 or out-of-range indices cleanly', () => {
      const hunks = [3, 12, 27]
      expect(stepHunkIndex(-1, hunks, 1)).toBe(0)
      expect(stepHunkIndex(-1, hunks, -1)).toBe(2)
      expect(stepHunkIndex(99, hunks, 1)).toBe(0)
    })

    it('wraps forward and backward across hunks', () => {
      const hunks = [3, 12, 27]
      expect(stepHunkIndex(0, hunks, 1)).toBe(1)
      expect(stepHunkIndex(2, hunks, 1)).toBe(0)
      expect(stepHunkIndex(0, hunks, -1)).toBe(2)
      expect(stepHunkIndex(1, hunks, -1)).toBe(0)
    })
  })

  describe('pickDefaultCompareSources', () => {
    const tabSources: CompareTabSource[] = [
      { tabId: 'cmp-1', title: 'Compare', kind: 'compare', dirty: false },
      { tabId: 'doc-1', title: 'Draft.docx', kind: 'docs', filePath: '/a/Draft.docx', dirty: true },
      {
        tabId: 'doc-2',
        title: 'Final.docx',
        kind: 'docs',
        filePath: '/a/Final.docx',
        dirty: false,
      },
    ]

    it('picks the first two non-compare tabs when init is absent', () => {
      expect(pickDefaultCompareSources(tabSources, null)).toEqual({
        left: { kind: 'tab', tabId: 'doc-1' },
        right: { kind: 'tab', tabId: 'doc-2' },
      })
    })

    it('honors explicit init pairs and skips compare tabs when auto-pairing one missing side', () => {
      expect(
        pickDefaultCompareSources(tabSources, {
          left: { kind: 'tab', tabId: 'doc-2' },
          right: { kind: 'file', filePath: '/tmp/other.docx' },
        }),
      ).toEqual({
        left: { kind: 'tab', tabId: 'doc-2' },
        right: { kind: 'file', filePath: '/tmp/other.docx' },
      })

      expect(
        pickDefaultCompareSources(tabSources, {
          left: { kind: 'tab', tabId: 'doc-1' },
        }),
      ).toEqual({
        left: { kind: 'tab', tabId: 'doc-1' },
        right: { kind: 'tab', tabId: 'doc-2' },
      })

      expect(
        pickDefaultCompareSources(tabSources, {
          right: { kind: 'file', filePath: '/a/Draft.docx' },
        }),
      ).toEqual({
        left: { kind: 'tab', tabId: 'doc-2' },
        right: { kind: 'file', filePath: '/a/Draft.docx' },
      })
    })

    it('returns null for unpaired side when fewer than two eligible tabs exist', () => {
      expect(
        pickDefaultCompareSources([
          { tabId: 'cmp-1', title: 'Compare', kind: 'compare', dirty: false },
          { tabId: 'doc-1', title: 'Only.md', kind: 'markdown', dirty: false },
        ]),
      ).toEqual({
        left: { kind: 'tab', tabId: 'doc-1' },
        right: null,
      })
    })
  })

  describe('buildCompareSummaryMarkdown & buildCompareOpenOptions', () => {
    it('formats comparison summary markdown with stats and diff blocks', () => {
      const res: CompareResult = {
        left: {
          id: 'l',
          label: 'v1.docx',
          source: 'live',
          charCount: 10,
          lineCount: 2,
        },
        right: {
          id: 'r',
          label: 'v2.docx',
          source: 'disk',
          charCount: 12,
          lineCount: 2,
        },
        rows: [
          {
            index: 0,
            kind: 'replace',
            leftLineNo: 1,
            rightLineNo: 1,
            leftText: 'old line',
            rightText: 'new line',
            hunkIndex: 0,
          },
        ],
        stats: {
          addedLines: 1,
          removedLines: 1,
          changedBlocks: 1,
          unchangedLines: 0,
          totalRows: 1,
        },
        hunkRowIndices: [0],
        ignoreWhitespace: false,
        computedAt: 1700000000000,
      }
      const md = buildCompareSummaryMarkdown(res)
      expect(md).toContain('v1.docx (live)')
      expect(md).toContain('v2.docx (disk)')
      expect(md).toContain('+1 / -1 across 1 blocks')
      expect(md).toContain('- old line')
      expect(md).toContain('+ new line')
    })

    it('derives compare options from active split state or eligible open tabs', () => {
      const tabs = [
        {
          id: 't1',
          kind: 'docs' as const,
          title: 'A',
          active: true,
          dirty: false,
          detached: false,
        },
        {
          id: 't2',
          kind: 'sheets' as const,
          title: 'B',
          active: false,
          dirty: false,
          detached: false,
        },
        {
          id: 't3',
          kind: 'help' as const,
          title: 'Help',
          active: false,
          dirty: false,
          detached: false,
        },
      ]
      expect(
        buildCompareOpenOptions(tabs, 't1', {
          leftTabId: 't2',
          rightTabId: 't1',
          activePane: 'left',
          ratio: 0.5,
          syncScroll: false,
          suspended: false,
        }),
      ).toEqual({
        left: { kind: 'tab', tabId: 't2' },
        right: { kind: 'tab', tabId: 't1' },
      })

      expect(buildCompareOpenOptions(tabs, 't1', null)).toEqual({
        left: { kind: 'tab', tabId: 't1' },
        right: { kind: 'tab', tabId: 't2' },
      })

      expect(buildCompareOpenOptions([tabs[0]!, tabs[2]!], 't1', null)).toEqual({})
    })
  })
})
