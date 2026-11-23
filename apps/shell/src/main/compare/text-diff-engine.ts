import { diffArrays } from 'diff'
import type { CompareResult, DiffRow, DiffStats, InlineDiffSegment } from '../../shared/compare-api'

const DEFAULT_MAX_INLINE_TOTAL_CHARS = 200_000
const DEFAULT_MAX_INLINE_LINE_CHARS = 4_000
const MAX_SUMMARY_CHARS = 6_000
const MAX_SUMMARY_LINE_CHARS = 320

// Match single CJK unified/extension-A/compatibility Han characters,
// contiguous ASCII/Latin/digit word tokens (preserving inner apostrophes/hyphens),
// contiguous whitespace runs, or any single remaining code point.
const INLINE_TOKEN_RE =
  /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]|[A-Za-z0-9_]+(?:['\u2019-][A-Za-z0-9_]+)*|\s+|./gu

export interface ComputeTextDiffOptions {
  ignoreWhitespace?: boolean
  maxInlineTotalChars?: number
  maxInlineLineChars?: number
}

export interface ComputeTextDiffResult {
  rows: DiffRow[]
  stats: DiffStats
  hunkRowIndices: number[]
  inlineSkipped: boolean
}

interface LineEntry {
  lineNo: number
  text: string
}

/** Collapse consecutive whitespace runs to a single space and trim ends. */
export function normalizeWhitespaceForCompare(line: string): string {
  return line.replace(/\s+/g, ' ').trim()
}

/** Normalize CRLF/CR line endings to LF and split into lines; empty string returns []. */
export function splitLines(text: string): string[] {
  if (text === '') return []
  return text.replace(/\r\n?/g, '\n').split('\n')
}

/** Split a line into CJK character tokens, ASCII/digit word tokens, whitespace runs, and punctuation. */
export function tokenizeForInlineDiff(line: string): string[] {
  if (line === '') return []
  return line.match(INLINE_TOKEN_RE) ?? []
}

function appendInlineSegment(
  segments: InlineDiffSegment[],
  kind: InlineDiffSegment['kind'],
  value: string,
): void {
  if (value === '') return
  const last = segments[segments.length - 1]
  if (last && last.kind === kind) {
    last.value += value
    return
  }
  segments.push({ value, kind })
}

/** Compute token-level inline diff segments for a paired replace row, merging adjacent same-kind spans. */
export function computeInlineSegments(
  leftLine: string,
  rightLine: string,
): { leftSegments: InlineDiffSegment[]; rightSegments: InlineDiffSegment[] } {
  const leftTokens = tokenizeForInlineDiff(leftLine)
  const rightTokens = tokenizeForInlineDiff(rightLine)
  const parts = diffArrays(leftTokens, rightTokens)

  const leftSegments: InlineDiffSegment[] = []
  const rightSegments: InlineDiffSegment[] = []

  for (const part of parts) {
    const joined = part.value.join('')
    if (part.removed) {
      appendInlineSegment(leftSegments, 'delete', joined)
    } else if (part.added) {
      appendInlineSegment(rightSegments, 'insert', joined)
    } else {
      appendInlineSegment(leftSegments, 'equal', joined)
      appendInlineSegment(rightSegments, 'equal', joined)
    }
  }

  return { leftSegments, rightSegments }
}

/**
 * Two-stage text diff:
 * Stage 1 aligns lines via diffArrays while tracking explicit left/right cursors
 * so both sides keep their original text even when ignoreWhitespace is enabled.
 * Stage 2 pairs adjacent removed/added blocks into replace rows with optional inline diffs.
 */
export function computeTextDiff(
  leftText: string,
  rightText: string,
  opts?: ComputeTextDiffOptions,
): ComputeTextDiffResult {
  const ignoreWhitespace = opts?.ignoreWhitespace === true
  const maxInlineTotalChars = opts?.maxInlineTotalChars ?? DEFAULT_MAX_INLINE_TOTAL_CHARS
  const maxInlineLineChars = opts?.maxInlineLineChars ?? DEFAULT_MAX_INLINE_LINE_CHARS

  const leftLines = splitLines(leftText)
  const rightLines = splitLines(rightText)

  const parts = diffArrays(
    leftLines,
    rightLines,
    ignoreWhitespace
      ? {
          comparator: (a, b) =>
            normalizeWhitespaceForCompare(a) === normalizeWhitespaceForCompare(b),
        }
      : undefined,
  )

  const skipInlineGlobal = leftText.length + rightText.length > maxInlineTotalChars
  let inlineSkipped = skipInlineGlobal

  const rows: DiffRow[] = []
  let leftCursor = 0
  let rightCursor = 0
  let addedLines = 0
  let removedLines = 0
  let unchangedLines = 0

  let removedQueue: LineEntry[] = []
  let addedQueue: LineEntry[] = []

  const flushChanges = (): void => {
    if (removedQueue.length === 0 && addedQueue.length === 0) return

    const pairCount = Math.min(removedQueue.length, addedQueue.length)
    for (let i = 0; i < pairCount; i += 1) {
      const left = removedQueue[i]!
      const right = addedQueue[i]!
      const canInline =
        !skipInlineGlobal &&
        left.text.length <= maxInlineLineChars &&
        right.text.length <= maxInlineLineChars

      let leftSegments: InlineDiffSegment[] | undefined
      let rightSegments: InlineDiffSegment[] | undefined
      if (canInline) {
        const inline = computeInlineSegments(left.text, right.text)
        leftSegments = inline.leftSegments
        rightSegments = inline.rightSegments
      } else {
        inlineSkipped = true
      }

      rows.push({
        index: rows.length,
        kind: 'replace',
        leftLineNo: left.lineNo,
        rightLineNo: right.lineNo,
        leftText: left.text,
        rightText: right.text,
        ...(leftSegments ? { leftSegments } : {}),
        ...(rightSegments ? { rightSegments } : {}),
        hunkIndex: -1,
      })
      removedLines += 1
      addedLines += 1
    }

    for (let i = pairCount; i < removedQueue.length; i += 1) {
      const left = removedQueue[i]!
      rows.push({
        index: rows.length,
        kind: 'delete',
        leftLineNo: left.lineNo,
        rightLineNo: null,
        leftText: left.text,
        rightText: '',
        hunkIndex: -1,
      })
      removedLines += 1
    }

    for (let i = pairCount; i < addedQueue.length; i += 1) {
      const right = addedQueue[i]!
      rows.push({
        index: rows.length,
        kind: 'insert',
        leftLineNo: null,
        rightLineNo: right.lineNo,
        leftText: '',
        rightText: right.text,
        hunkIndex: -1,
      })
      addedLines += 1
    }

    removedQueue = []
    addedQueue = []
  }

  for (const part of parts) {
    const count = part.count ?? part.value.length
    if (part.removed) {
      // Defensive flush if a removed run ever follows an added run without an equal separator.
      if (addedQueue.length > 0) flushChanges()
      for (let i = 0; i < count; i += 1) {
        removedQueue.push({
          lineNo: leftCursor + 1,
          text: leftLines[leftCursor] ?? '',
        })
        leftCursor += 1
      }
    } else if (part.added) {
      for (let i = 0; i < count; i += 1) {
        addedQueue.push({
          lineNo: rightCursor + 1,
          text: rightLines[rightCursor] ?? '',
        })
        rightCursor += 1
      }
    } else {
      flushChanges()
      for (let i = 0; i < count; i += 1) {
        rows.push({
          index: rows.length,
          kind: 'equal',
          leftLineNo: leftCursor + 1,
          rightLineNo: rightCursor + 1,
          leftText: leftLines[leftCursor] ?? '',
          rightText: rightLines[rightCursor] ?? '',
          hunkIndex: -1,
        })
        leftCursor += 1
        rightCursor += 1
        unchangedLines += 1
      }
    }
  }

  flushChanges()

  const hunkRowIndices: number[] = []
  let currentHunk = -1
  let inHunk = false
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!
    row.index = i
    if (row.kind === 'equal') {
      row.hunkIndex = -1
      inHunk = false
    } else {
      if (!inHunk) {
        currentHunk += 1
        hunkRowIndices.push(i)
        inHunk = true
      }
      row.hunkIndex = currentHunk
    }
  }

  return {
    rows,
    stats: {
      addedLines,
      removedLines,
      changedBlocks: hunkRowIndices.length,
      unchangedLines,
      totalRows: rows.length,
    },
    hunkRowIndices,
    inlineSkipped,
  }
}

function clipSummaryLine(text: string): string {
  if (text.length <= MAX_SUMMARY_LINE_CHARS) return text
  return `${text.slice(0, MAX_SUMMARY_LINE_CHARS - 3)}...`
}

function formatLineRange(rows: readonly DiffRow[]): string {
  const leftNos = rows.map((r) => r.leftLineNo).filter((n): n is number => n !== null)
  const rightNos = rows.map((r) => r.rightLineNo).filter((n): n is number => n !== null)
  const leftRange =
    leftNos.length === 0
      ? 'L-'
      : leftNos.length === 1
        ? `L${leftNos[0]}`
        : `L${leftNos[0]}..${leftNos[leftNos.length - 1]}`
  const rightRange =
    rightNos.length === 0
      ? 'R-'
      : rightNos.length === 1
        ? `R${rightNos[0]}`
        : `R${rightNos[0]}..${rightNos[rightNos.length - 1]}`
  return `${leftRange} -> ${rightRange}`
}

/** Build a structured Markdown diff summary capped at 6,000 characters. */
export function buildDiffSummaryMarkdown(result: CompareResult, maxHunks = 12): string {
  const leftMeta = result.left
  const rightMeta = result.right
  const { stats, rows, hunkRowIndices } = result

  const headerLines = [
    '# Document Comparison Summary',
    '',
    `- **Left**: ${leftMeta.label} (${leftMeta.source}, ${leftMeta.lineCount} lines, ${leftMeta.charCount} chars${leftMeta.filePath ? `, \`${leftMeta.filePath}\`` : ''})`,
    `- **Right**: ${rightMeta.label} (${rightMeta.source}, ${rightMeta.lineCount} lines, ${rightMeta.charCount} chars${rightMeta.filePath ? `, \`${rightMeta.filePath}\`` : ''})`,
    `- **Whitespace**: ${result.ignoreWhitespace ? 'Ignored' : 'Exact'}`,
    `- **Stats**: ${stats.changedBlocks} change block(s), +${stats.addedLines} added, -${stats.removedLines} removed, ${stats.unchangedLines} unchanged (${stats.totalRows} total rows)`,
  ]

  let output = headerLines.join('\n')
  if (hunkRowIndices.length === 0) {
    output += '\n\nNo differences found.'
    return output.length > MAX_SUMMARY_CHARS
      ? `${output.slice(0, MAX_SUMMARY_CHARS - 3)}...`
      : output
  }

  const limit = Math.max(0, Math.min(maxHunks, hunkRowIndices.length))
  let includedHunks = 0
  const footerReserve = 80

  for (let h = 0; h < limit; h += 1) {
    const startIdx = hunkRowIndices[h]!
    const hunkIndex = rows[startIdx]?.hunkIndex ?? h
    const hunkRows: DiffRow[] = []
    let cursor = startIdx
    while (cursor < rows.length && rows[cursor]!.hunkIndex === hunkIndex) {
      hunkRows.push(rows[cursor]!)
      cursor += 1
    }
    if (hunkRows.length === 0) continue

    const endIdx = cursor - 1
    const blockLines: string[] = [
      '',
      `## Change ${h + 1} (${formatLineRange(hunkRows)})`,
      '```diff',
    ]

    const prevRow = startIdx > 0 ? rows[startIdx - 1] : undefined
    if (prevRow && prevRow.kind === 'equal') {
      blockLines.push(`  ${clipSummaryLine(prevRow.leftText)}`)
    }

    for (const row of hunkRows) {
      if (row.kind === 'delete' || row.kind === 'replace') {
        blockLines.push(`- ${clipSummaryLine(row.leftText)}`)
      }
      if (row.kind === 'insert' || row.kind === 'replace') {
        blockLines.push(`+ ${clipSummaryLine(row.rightText)}`)
      }
    }

    const nextRow = endIdx + 1 < rows.length ? rows[endIdx + 1] : undefined
    if (nextRow && nextRow.kind === 'equal') {
      blockLines.push(`  ${clipSummaryLine(nextRow.leftText)}`)
    }

    blockLines.push('```')
    const section = blockLines.join('\n')

    if (output.length + section.length + footerReserve > MAX_SUMMARY_CHARS) {
      break
    }
    output += section
    includedHunks += 1
  }

  const omitted = hunkRowIndices.length - includedHunks
  if (omitted > 0) {
    const note = `\n\n_...and ${omitted} more change block(s) omitted._`
    if (output.length + note.length <= MAX_SUMMARY_CHARS) {
      output += note
    }
  }

  return output.length > MAX_SUMMARY_CHARS ? `${output.slice(0, MAX_SUMMARY_CHARS - 3)}...` : output
}
