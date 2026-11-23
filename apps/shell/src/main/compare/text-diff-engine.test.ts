import { describe, expect, it } from 'vitest'
import type { CompareResult } from '../../shared/compare-api'
import {
  buildDiffSummaryMarkdown,
  computeInlineSegments,
  computeTextDiff,
  normalizeWhitespaceForCompare,
  splitLines,
  tokenizeForInlineDiff,
} from './text-diff-engine'

describe('text-diff-engine helpers', () => {
  it('normalizes consecutive whitespace and trims ends', () => {
    expect(normalizeWhitespaceForCompare('  hello   \t  world \n ')).toBe('hello world')
    expect(normalizeWhitespaceForCompare('   ')).toBe('')
  })

  it('splits lines uniformly across CRLF, CR, and LF and returns [] for empty text', () => {
    expect(splitLines('')).toEqual([])
    expect(splitLines('a\r\nb\rc\n')).toEqual(['a', 'b', 'c', ''])
  })

  it('tokenizes CJK characters individually and keeps Latin/digit words intact', () => {
    expect(tokenizeForInlineDiff('')).toEqual([])
    expect(tokenizeForInlineDiff("Hello, 世界! foo-bar's 123  end")).toEqual([
      'Hello',
      ',',
      ' ',
      '世',
      '界',
      '!',
      ' ',
      "foo-bar's",
      ' ',
      '123',
      '  ',
      'end',
    ])
    expect(tokenizeForInlineDiff('中文English混合')).toEqual(['中', '文', 'English', '混', '合'])
  })
})

describe('computeInlineSegments', () => {
  it('computes CJK character-level inline diff and merges adjacent segments', () => {
    const { leftSegments, rightSegments } = computeInlineSegments(
      '今天天气真不错啊',
      '今天心情特别不错啊',
    )

    expect(leftSegments).toEqual([
      { value: '今天', kind: 'equal' },
      { value: '天气真', kind: 'delete' },
      { value: '不错啊', kind: 'equal' },
    ])
    expect(rightSegments).toEqual([
      { value: '今天', kind: 'equal' },
      { value: '心情特别', kind: 'insert' },
      { value: '不错啊', kind: 'equal' },
    ])
    expect(leftSegments.map((s) => s.value).join('')).toBe('今天天气真不错啊')
    expect(rightSegments.map((s) => s.value).join('')).toBe('今天心情特别不错啊')
  })

  it('computes English word-level inline diff without splitting inside words', () => {
    const { leftSegments, rightSegments } = computeInlineSegments(
      'The quick brown fox jumps',
      'The rapid brown dog leaps',
    )

    expect(leftSegments).toEqual([
      { value: 'The ', kind: 'equal' },
      { value: 'quick', kind: 'delete' },
      { value: ' brown ', kind: 'equal' },
      { value: 'fox', kind: 'delete' },
      { value: ' ', kind: 'equal' },
      { value: 'jumps', kind: 'delete' },
    ])
    expect(rightSegments).toEqual([
      { value: 'The ', kind: 'equal' },
      { value: 'rapid', kind: 'insert' },
      { value: ' brown ', kind: 'equal' },
      { value: 'dog', kind: 'insert' },
      { value: ' ', kind: 'equal' },
      { value: 'leaps', kind: 'insert' },
    ])
  })
})

describe('computeTextDiff', () => {
  it('handles identical texts and empty texts', () => {
    const empty = computeTextDiff('', '')
    expect(empty.rows).toEqual([])
    expect(empty.hunkRowIndices).toEqual([])
    expect(empty.stats).toEqual({
      addedLines: 0,
      removedLines: 0,
      changedBlocks: 0,
      unchangedLines: 0,
      totalRows: 0,
    })

    const same = computeTextDiff('line1\nline2', 'line1\nline2')
    expect(same.rows).toHaveLength(2)
    expect(same.rows.every((r) => r.kind === 'equal' && r.hunkIndex === -1)).toBe(true)
    expect(same.hunkRowIndices).toEqual([])
    expect(same.stats).toEqual({
      addedLines: 0,
      removedLines: 0,
      changedBlocks: 0,
      unchangedLines: 2,
      totalRows: 2,
    })
  })

  it('handles pure insertions and pure deletions with 1-based line numbers', () => {
    const inserted = computeTextDiff('', 'alpha\nbeta')
    expect(inserted.rows).toEqual([
      {
        index: 0,
        kind: 'insert',
        leftLineNo: null,
        rightLineNo: 1,
        leftText: '',
        rightText: 'alpha',
        hunkIndex: 0,
      },
      {
        index: 1,
        kind: 'insert',
        leftLineNo: null,
        rightLineNo: 2,
        leftText: '',
        rightText: 'beta',
        hunkIndex: 0,
      },
    ])
    expect(inserted.hunkRowIndices).toEqual([0])
    expect(inserted.stats).toEqual({
      addedLines: 2,
      removedLines: 0,
      changedBlocks: 1,
      unchangedLines: 0,
      totalRows: 2,
    })

    const deleted = computeTextDiff('alpha\nbeta', '')
    expect(deleted.rows).toEqual([
      {
        index: 0,
        kind: 'delete',
        leftLineNo: 1,
        rightLineNo: null,
        leftText: 'alpha',
        rightText: '',
        hunkIndex: 0,
      },
      {
        index: 1,
        kind: 'delete',
        leftLineNo: 2,
        rightLineNo: null,
        leftText: 'beta',
        rightText: '',
        hunkIndex: 0,
      },
    ])
    expect(deleted.hunkRowIndices).toEqual([0])
    expect(deleted.stats).toEqual({
      addedLines: 0,
      removedLines: 2,
      changedBlocks: 1,
      unchangedLines: 0,
      totalRows: 2,
    })
  })

  it('pairs asymmetric change blocks into replace rows plus trailing delete/insert rows', () => {
    const left = ['head', 'old 1', 'old 2', 'old 3', 'mid', 'keep', 'tail'].join('\n')
    const right = ['head', 'new 1', 'mid', 'changed keep', 'extra', 'tail'].join('\n')
    const result = computeTextDiff(left, right)

    expect(result.rows.map((r) => [r.kind, r.hunkIndex])).toEqual([
      ['equal', -1],
      ['replace', 0],
      ['delete', 0],
      ['delete', 0],
      ['equal', -1],
      ['replace', 1],
      ['insert', 1],
      ['equal', -1],
    ])
    expect(result.hunkRowIndices).toEqual([1, 5])
    expect(result.stats).toEqual({
      addedLines: 3,
      removedLines: 4,
      changedBlocks: 2,
      unchangedLines: 3,
      totalRows: 8,
    })
  })

  it('preserves original whitespace on both sides via explicit cursors when ignoreWhitespace is true', () => {
    const left = ['  const   x = 1  ', 'line   two', '  keep   me', 'end'].join('\n')
    const right = ['const x = 1', 'line two modified', 'keep me', 'end'].join('\n')

    const result = computeTextDiff(left, right, { ignoreWhitespace: true })

    expect(result.rows).toHaveLength(4)
    expect(result.rows[0]).toMatchObject({
      kind: 'equal',
      leftLineNo: 1,
      rightLineNo: 1,
      leftText: '  const   x = 1  ',
      rightText: 'const x = 1',
      hunkIndex: -1,
    })
    expect(result.rows[1]).toMatchObject({
      kind: 'replace',
      leftLineNo: 2,
      rightLineNo: 2,
      leftText: 'line   two',
      rightText: 'line two modified',
      hunkIndex: 0,
    })
    expect(result.rows[2]).toMatchObject({
      kind: 'equal',
      leftLineNo: 3,
      rightLineNo: 3,
      leftText: '  keep   me',
      rightText: 'keep me',
      hunkIndex: -1,
    })
    expect(result.rows[3]).toMatchObject({
      kind: 'equal',
      leftLineNo: 4,
      rightLineNo: 4,
      leftText: 'end',
      rightText: 'end',
      hunkIndex: -1,
    })
    expect(result.hunkRowIndices).toEqual([1])
  })

  it('skips inline diffing when total chars or single line chars exceed thresholds', () => {
    const overTotal = computeTextDiff('hello world', 'hello there', {
      maxInlineTotalChars: 10,
    })
    expect(overTotal.inlineSkipped).toBe(true)
    expect(overTotal.rows[0]!.kind).toBe('replace')
    expect(overTotal.rows[0]!.leftSegments).toBeUndefined()
    expect(overTotal.rows[0]!.rightSegments).toBeUndefined()

    const overLine = computeTextDiff('short\nlong_line_left', 'short\nlong_line_right', {
      maxInlineTotalChars: 10_000,
      maxInlineLineChars: 10,
    })
    expect(overLine.inlineSkipped).toBe(true)
    expect(overLine.rows[1]!.kind).toBe('replace')
    expect(overLine.rows[1]!.leftSegments).toBeUndefined()
    expect(overLine.rows[1]!.rightSegments).toBeUndefined()
  })
})

describe('buildDiffSummaryMarkdown', () => {
  it('builds structured markdown within 6000 chars and respects maxHunks', () => {
    const leftLines: string[] = []
    const rightLines: string[] = []
    for (let i = 0; i < 30; i += 1) {
      leftLines.push(`same-${i}`)
      leftLines.push(`before-${i}-${'x'.repeat(250)}`)
      rightLines.push(`same-${i}`)
      rightLines.push(`after-${i}-${'y'.repeat(250)}`)
    }
    const leftText = leftLines.join('\n')
    const rightText = rightLines.join('\n')
    const diff = computeTextDiff(leftText, rightText)

    const result: CompareResult = {
      left: {
        id: 'tab:1',
        label: 'Left Doc',
        filePath: '/docs/left.docx',
        source: 'live',
        charCount: leftText.length,
        lineCount: leftLines.length,
      },
      right: {
        id: 'file:/docs/right.docx',
        label: 'right.docx',
        filePath: '/docs/right.docx',
        source: 'disk',
        charCount: rightText.length,
        lineCount: rightLines.length,
      },
      rows: diff.rows,
      stats: diff.stats,
      hunkRowIndices: diff.hunkRowIndices,
      ignoreWhitespace: false,
      computedAt: 1700000000000,
    }

    const summary = buildDiffSummaryMarkdown(result, 5)
    expect(summary).toContain('Left Doc')
    expect(summary).toContain('right.docx')
    expect(summary).toContain('30 change block(s)')
    expect(summary).toContain('Change 1')
    expect(summary).toContain('Change 5')
    expect(summary).not.toContain('Change 6')
    expect(summary).toContain('more change block(s) omitted')
    expect(summary.length).toBeLessThanOrEqual(6_000)
  })
})
