import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type {
  CompareDocumentMeta,
  CompareOpenOptions,
  CompareResult,
  CompareSourceRef,
  CompareTabSource,
  DiffRow,
  HomeApi,
  InlineDiffSegment,
} from '../../shared/home-api'
import { useI18n } from './locale'
import './compare-view.css'

export type CompareViewMode = 'side-by-side' | 'inline'

interface CustomFileEntry {
  filePath: string
  label: string
}

const DEFAULT_CONTEXT_LINES = 2
const MAX_SUMMARY_HUNKS = 30
const MAX_SUMMARY_CHARS = 6000
const MAX_SUMMARY_LINE_CHARS = 320
const COPIED_RESET_MS = 2000

/**
 * Serialize a CompareSourceRef into a stable select-option string key.
 */
export function sourceRefKey(ref: CompareSourceRef | null): string {
  if (!ref) return ''
  return ref.kind === 'tab' ? `tab:${ref.tabId}` : `file:${ref.filePath}`
}

/**
 * Parse a serialized select-option value back into a CompareSourceRef.
 */
export function parseSourceSelectValue(value: string): CompareSourceRef | null {
  if (!value) return null
  if (value.startsWith('tab:')) {
    const tabId = value.slice(4)
    return tabId ? { kind: 'tab', tabId } : null
  }
  if (value.startsWith('file:')) {
    const filePath = value.slice(5)
    return filePath ? { kind: 'file', filePath } : null
  }
  return null
}

function sameSourceAndTab(ref: CompareSourceRef, tab: CompareTabSource): boolean {
  if (ref.kind === 'tab') return ref.tabId === tab.tabId
  return Boolean(tab.filePath && tab.filePath === ref.filePath)
}

/**
 * Choose initial left and right compare sources, honoring any caller-provided
 * init options and pairing missing sides from open document tabs (excluding
 * compare tabs).
 */
export function pickDefaultCompareSources(
  sources: readonly CompareTabSource[],
  init?: CompareOpenOptions | null,
): { left: CompareSourceRef | null; right: CompareSourceRef | null } {
  const eligible = sources.filter((src) => src.kind !== 'compare')
  let left: CompareSourceRef | null = init?.left ?? null
  let right: CompareSourceRef | null = init?.right ?? null

  if (left && !right) {
    const pair = eligible.find((src) => !sameSourceAndTab(left!, src))
    right = pair ? { kind: 'tab', tabId: pair.tabId } : null
    return { left, right }
  }

  if (!left && right) {
    const pair = eligible.find((src) => !sameSourceAndTab(right!, src))
    left = pair ? { kind: 'tab', tabId: pair.tabId } : null
    return { left, right }
  }

  if (!left && !right) {
    if (eligible.length >= 2) {
      left = { kind: 'tab', tabId: eligible[0]!.tabId }
      right = { kind: 'tab', tabId: eligible[1]!.tabId }
    } else if (eligible.length === 1) {
      left = { kind: 'tab', tabId: eligible[0]!.tabId }
    }
  }

  return { left, right }
}

/**
 * Filter diff rows for display. When `onlyChanges` is true, keep all non-equal
 * rows together with `contextLines` surrounding rows before and after each
 * changed cluster.
 */
export function filterVisibleRows(
  rows: readonly DiffRow[],
  onlyChanges: boolean,
  contextLines = DEFAULT_CONTEXT_LINES,
): readonly DiffRow[] {
  if (!onlyChanges || rows.length === 0) return rows
  const ctx = Number.isFinite(contextLines)
    ? Math.max(0, Math.floor(contextLines))
    : DEFAULT_CONTEXT_LINES
  const intervals: Array<[number, number]> = []

  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.kind === 'equal') continue
    const start = Math.max(0, i - ctx)
    const end = Math.min(rows.length - 1, i + ctx)
    const prev = intervals[intervals.length - 1]
    if (prev && start <= prev[1] + 1) {
      prev[1] = Math.max(prev[1], end)
    } else {
      intervals.push([start, end])
    }
  }

  if (intervals.length === 0) return []

  const visible: DiffRow[] = []
  for (const [start, end] of intervals) {
    for (let i = start; i <= end; i++) {
      visible.push(rows[i]!)
    }
  }
  return visible
}

/**
 * Step forward or backward across diff hunks with wrap-around. Returns -1 when
 * no hunks exist.
 */
export function stepHunkIndex(
  current: number,
  hunkRowIndices: readonly number[],
  dir: 1 | -1,
): number {
  const total = hunkRowIndices.length
  if (total === 0) return -1
  if (!Number.isInteger(current) || current < 0 || current >= total) {
    return dir === 1 ? 0 : total - 1
  }
  return dir === 1 ? (current + 1) % total : (current - 1 + total) % total
}

function fileBaseName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  return idx >= 0 ? normalized.slice(idx + 1) || filePath : filePath
}

function matchesDocumentMeta(ref: CompareSourceRef | null, meta: CompareDocumentMeta): boolean {
  if (!ref) return false
  if (ref.kind === 'tab') return meta.tabId === ref.tabId
  return meta.filePath === ref.filePath
}

function clipSummaryLine(text: string): string {
  if (text.length <= MAX_SUMMARY_LINE_CHARS) return text
  return `${text.slice(0, MAX_SUMMARY_LINE_CHARS - 3)}...`
}

/**
 * Build a concise Markdown diff summary suitable for clipboard copy or Ask AI.
 */
export function buildCompareSummaryMarkdown(result: CompareResult): string {
  const lines: string[] = [
    '# Document Comparison',
    `- **Left:** ${result.left.label} (${result.left.source})`,
    `- **Right:** ${result.right.label} (${result.right.source})`,
    `- **Stats:** +${result.stats.addedLines} / -${result.stats.removedLines} across ${result.stats.changedBlocks} blocks`,
    '',
  ]

  if (result.hunkRowIndices.length === 0) {
    lines.push('No text differences found.')
    return lines.join('\n')
  }

  const rowsByHunk = new Map<number, DiffRow[]>()
  for (const row of result.rows) {
    if (row.hunkIndex < 0) continue
    let list = rowsByHunk.get(row.hunkIndex)
    if (!list) {
      list = []
      rowsByHunk.set(row.hunkIndex, list)
    }
    list.push(row)
  }

  const hunkEntries = [...rowsByHunk.entries()].sort((a, b) => a[0] - b[0])
  const shown = hunkEntries.slice(0, MAX_SUMMARY_HUNKS)
  let output = lines.join('\n')
  let included = 0
  const reserve = 80

  for (const [hunkIdx, hunkRows] of shown) {
    const first = hunkRows[0]!
    const loc = `L${first.leftLineNo ?? '-'} / R${first.rightLineNo ?? '-'}`
    const block: string[] = [`\n## Change ${hunkIdx + 1} (${loc})`, '```diff']
    for (const row of hunkRows) {
      if (row.kind === 'delete' || row.kind === 'replace') {
        block.push(`- ${clipSummaryLine(row.leftText)}`)
      }
      if (row.kind === 'insert' || row.kind === 'replace') {
        block.push(`+ ${clipSummaryLine(row.rightText)}`)
      }
    }
    block.push('```')
    const section = block.join('\n')
    if (output.length + section.length + reserve > MAX_SUMMARY_CHARS) {
      break
    }
    output += section
    included += 1
  }

  const omitted = hunkEntries.length - included
  if (omitted > 0) {
    const note = `\n\n_...and ${omitted} more change blocks omitted._`
    if (output.length + note.length <= MAX_SUMMARY_CHARS) {
      output += note
    }
  }

  return output.length > MAX_SUMMARY_CHARS ? `${output.slice(0, MAX_SUMMARY_CHARS - 3)}...` : output
}

function renderInlineSegments(text: string, segments?: readonly InlineDiffSegment[]): ReactNode {
  if (!segments || segments.length === 0) {
    return text
  }
  return segments.map((seg, i) => {
    if (seg.kind === 'delete') {
      return (
        <mark key={i} className="compare-mark-del">
          {seg.value}
        </mark>
      )
    }
    if (seg.kind === 'insert') {
      return (
        <mark key={i} className="compare-mark-ins">
          {seg.value}
        </mark>
      )
    }
    return <span key={i}>{seg.value}</span>
  })
}

function SwapIcon(): ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 5.5h11m0 0L11 3m2.5 2.5L11 8M13.5 10.5h-11m0 0L5 8m-2.5 2.5L5 13"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function RefreshIcon(): ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M13.2 7.5a5.2 5.2 0 1 1-1.35-3.5M13.2 2.4v2.6h-2.6"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function FolderOpenIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2 4.2A1.4 1.4 0 0 1 3.4 2.8h2.9l1.2 1.4h5.1A1.4 1.4 0 0 1 14 5.6v6.2a1.4 1.4 0 0 1-1.4 1.4H3.4A1.4 1.4 0 0 1 2 11.8V4.2Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ChevronUpIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4 10l4-4 4 4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ChevronDownIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4 6l4 4 4-4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function SparkAiIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 1.5l1.6 4.4 4.4 1.6-4.4 1.6L8 13.5l-1.6-4.4L2 7.5l4.4-1.6z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function EmptyCompareIcon(): ReactElement {
  return (
    <svg width="42" height="42" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <rect x="6" y="8" width="15" height="32" rx="3" stroke="currentColor" strokeWidth="2.2" />
      <rect x="27" y="8" width="15" height="32" rx="3" stroke="currentColor" strokeWidth="2.2" />
      <path
        d="M10.5 17h6M10.5 23h4.5M10.5 29h6M31.5 17h6M31.5 23h6M34.5 20v6M31.5 29h6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}

/**
 * Full-stage document comparison view (?view=compare): compares two open tabs
 * or disk files with side-by-side and inline diff modes, hunk navigation,
 * summary copy, and Ask AI handoff.
 */
export function CompareView(): ReactElement {
  const { t } = useI18n()
  const [sources, setSources] = useState<CompareTabSource[]>([])
  const [customFiles, setCustomFiles] = useState<CustomFileEntry[]>([])
  const [leftRef, setLeftRef] = useState<CompareSourceRef | null>(null)
  const [rightRef, setRightRef] = useState<CompareSourceRef | null>(null)
  const [viewMode, setViewMode] = useState<CompareViewMode>('side-by-side')
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false)
  const [onlyChanges, setOnlyChanges] = useState(false)
  const [result, setResult] = useState<CompareResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeHunk, setActiveHunk] = useState(-1)
  const [refreshSeq, setRefreshSeq] = useState(0)
  const [copied, setCopied] = useState(false)

  const diffBodyRef = useRef<HTMLDivElement>(null)
  const runSeqRef = useRef(0)
  const copyTimerRef = useRef<number | null>(null)

  const registerCustomFile = useCallback((ref: CompareSourceRef | null) => {
    if (!ref || ref.kind !== 'file') return
    setCustomFiles((prev) => {
      if (prev.some((item) => item.filePath === ref.filePath)) return prev
      return [...prev, { filePath: ref.filePath, label: fileBaseName(ref.filePath) }]
    })
  }, [])

  const applyInitialOptions = useCallback(
    (tabSources: readonly CompareTabSource[], opts: CompareOpenOptions | null) => {
      const picked = pickDefaultCompareSources(tabSources, opts)
      registerCustomFile(picked.left)
      registerCustomFile(picked.right)
      setLeftRef(picked.left)
      setRightRef(picked.right)
    },
    [registerCustomFile],
  )

  useEffect(() => {
    const api = window.aiOffice as Partial<HomeApi> | undefined
    let alive = true

    const bootstrap = async () => {
      try {
        const [listedSources, initOpts] = await Promise.all([
          api?.compareListSources?.() ?? Promise.resolve([]),
          api?.compareGetInit?.() ?? Promise.resolve(null),
        ])
        if (!alive) return
        setSources(listedSources)
        applyInitialOptions(listedSources, initOpts)
      } catch (err) {
        if (!alive) return
        setError(err instanceof Error ? err.message : String(err))
      }
    }
    void bootstrap()

    const offInit = api?.compareOnInitUpdated?.((opts) => {
      void (api?.compareListSources?.() ?? Promise.resolve([]))
        .then((listed) => {
          if (!alive) return
          setSources(listed)
          applyInitialOptions(listed, opts)
        })
        .catch(() => undefined)
    })

    const offTabs = api?.onTabsChanged?.(() => {
      void (api?.compareListSources?.() ?? Promise.resolve([]))
        .then((listed) => {
          if (alive) setSources(listed)
        })
        .catch(() => undefined)
    })

    return () => {
      alive = false
      offInit?.()
      offTabs?.()
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }
    }
  }, [applyInitialOptions])

  useEffect(() => {
    if (!leftRef || !rightRef) {
      runSeqRef.current += 1
      setResult(null)
      setError(null)
      setLoading(false)
      setActiveHunk(-1)
      return
    }
    const api = window.aiOffice as Partial<HomeApi> | undefined
    if (typeof api?.compareRunDiff !== 'function') return

    const seq = ++runSeqRef.current
    setLoading(true)
    setError(null)

    void api
      .compareRunDiff({
        left: leftRef,
        right: rightRef,
        ignoreWhitespace,
      })
      .then((res) => {
        if (seq !== runSeqRef.current) return
        setResult(res)
        setError(null)
        setLoading(false)
        setActiveHunk(res.hunkRowIndices.length > 0 ? 0 : -1)
      })
      .catch((err) => {
        if (seq !== runSeqRef.current) return
        setResult(null)
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
        setActiveHunk(-1)
      })
  }, [leftRef, rightRef, ignoreWhitespace, refreshSeq])

  const scrollToHunk = useCallback((hunkIdx: number, currentResult: CompareResult | null) => {
    if (!currentResult || hunkIdx < 0 || hunkIdx >= currentResult.hunkRowIndices.length) return
    const rowIdx = currentResult.hunkRowIndices[hunkIdx]
    if (rowIdx === undefined) return
    const container = diffBodyRef.current
    if (!container) return
    const rowEl = container.querySelector<HTMLElement>(`[data-row-index="${rowIdx}"]`)
    rowEl?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [])

  const navigateHunk = useCallback(
    (dir: 1 | -1) => {
      if (!result || result.hunkRowIndices.length === 0) return
      const next = stepHunkIndex(activeHunk, result.hunkRowIndices, dir)
      setActiveHunk(next)
      requestAnimationFrame(() => scrollToHunk(next, result))
    },
    [activeHunk, result, scrollToHunk],
  )

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      let dir: 1 | -1 | null = null
      if (e.key === 'F7' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        dir = e.shiftKey ? -1 : 1
      } else if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key === 'ArrowDown') {
        dir = 1
      } else if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key === 'ArrowUp') {
        dir = -1
      }
      if (dir === null) return
      e.preventDefault()
      navigateHunk(dir)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [navigateHunk])

  const handlePickFile = useCallback(
    async (side: 'left' | 'right') => {
      const api = window.aiOffice as Partial<HomeApi> | undefined
      const filePath = await api?.comparePickFile?.()
      if (!filePath) return
      const ref: CompareSourceRef = { kind: 'file', filePath }
      registerCustomFile(ref)
      if (side === 'left') setLeftRef(ref)
      else setRightRef(ref)
    },
    [registerCustomFile],
  )

  const handleSwap = useCallback(() => {
    if (!leftRef && !rightRef) return
    setLeftRef(rightRef)
    setRightRef(leftRef)
  }, [leftRef, rightRef])

  const handleRefresh = useCallback(() => {
    const api = window.aiOffice as Partial<HomeApi> | undefined
    void (api?.compareListSources?.() ?? Promise.resolve([]))
      .then((listed) => setSources(listed))
      .catch(() => undefined)
    setRefreshSeq((n) => n + 1)
  }, [])

  const handleCopySummary = useCallback(() => {
    if (!result) return
    const md = buildCompareSummaryMarkdown(result)
    const writePromise =
      navigator.clipboard?.writeText?.(md) ??
      window.aiOfficeIntegrations?.copyText?.(md) ??
      Promise.resolve()
    void writePromise
      .then(() => {
        setCopied(true)
        if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
        copyTimerRef.current = window.setTimeout(() => {
          copyTimerRef.current = null
          setCopied(false)
        }, COPIED_RESET_MS)
      })
      .catch(() => undefined)
  }, [result])

  const handleAskAi = useCallback(() => {
    if (!result) return
    const api = window.aiOffice as Partial<HomeApi> | undefined
    const summaryMarkdown = buildCompareSummaryMarkdown(result)
    void api
      ?.compareAskAiSummary?.({
        leftLabel: result.left.label,
        rightLabel: result.right.label,
        summaryMarkdown,
      })
      .catch(() => undefined)
  }, [result])

  const tabOptions = useMemo(() => sources.filter((src) => src.kind !== 'compare'), [sources])

  const visibleCustomFiles = useMemo(() => {
    const out: CustomFileEntry[] = [...customFiles]
    for (const ref of [leftRef, rightRef]) {
      if (ref?.kind === 'file' && !out.some((item) => item.filePath === ref.filePath)) {
        out.push({ filePath: ref.filePath, label: fileBaseName(ref.filePath) })
      }
    }
    return out
  }, [customFiles, leftRef, rightRef])

  const visibleRows = useMemo(
    () => (result ? filterVisibleRows(result.rows, onlyChanges, DEFAULT_CONTEXT_LINES) : []),
    [result, onlyChanges],
  )

  const leftSourceKind =
    result && matchesDocumentMeta(leftRef, result.left)
      ? result.left.source
      : leftRef?.kind === 'file'
        ? 'disk'
        : leftRef?.kind === 'tab'
          ? 'live'
          : null

  const rightSourceKind =
    result && matchesDocumentMeta(rightRef, result.right)
      ? result.right.source
      : rightRef?.kind === 'file'
        ? 'disk'
        : rightRef?.kind === 'tab'
          ? 'live'
          : null

  const totalHunks = result?.hunkRowIndices.length ?? 0
  const currentHunkDisplay = totalHunks > 0 && activeHunk >= 0 ? activeHunk + 1 : 0
  const isIdentical = Boolean(
    result && result.stats.changedBlocks === 0 && result.rows.every((row) => row.kind === 'equal'),
  )
  const isTruncated = Boolean(result && (result.left.truncated || result.right.truncated))

  const renderSourceSelector = (
    side: 'left' | 'right',
    selected: CompareSourceRef | null,
    sourceKind: 'live' | 'disk' | null,
  ) => {
    const label = t(side === 'left' ? 'compareLeftLabel' : 'compareRightLabel')
    const selectVal = sourceRefKey(selected)
    const missingTabFallback =
      selected?.kind === 'tab' && !tabOptions.some((src) => src.tabId === selected.tabId)
        ? selected
        : null

    return (
      <div className={`compare-source-card is-${side}`}>
        <div className="compare-source-top">
          <span className="compare-source-label">{label}</span>
          {sourceKind && (
            <span className={`compare-source-badge is-${sourceKind}`}>
              {t(sourceKind === 'live' ? 'compareSourceLive' : 'compareSourceDisk')}
            </span>
          )}
        </div>
        <div className="compare-source-controls">
          <select
            className="compare-select"
            aria-label={label}
            value={selectVal}
            onChange={(e) => {
              const parsed = parseSourceSelectValue(e.target.value)
              if (side === 'left') setLeftRef(parsed)
              else setRightRef(parsed)
            }}
          >
            <option value="">{t('compareSelectDoc')}</option>
            {tabOptions.map((src) => (
              <option
                key={src.tabId}
                value={sourceRefKey({ kind: 'tab', tabId: src.tabId })}
                title={src.filePath ?? src.title}
              >
                {src.title}
                {src.dirty ? ' •' : ''}
              </option>
            ))}
            {missingTabFallback && (
              <option value={sourceRefKey(missingTabFallback)}>{missingTabFallback.tabId}</option>
            )}
            {visibleCustomFiles.map((file) => (
              <option
                key={file.filePath}
                value={sourceRefKey({ kind: 'file', filePath: file.filePath })}
                title={file.filePath}
              >
                {file.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="compare-pick-btn"
            aria-label={t('comparePickFile')}
            title={t('comparePickFile')}
            onClick={() => void handlePickFile(side)}
          >
            <FolderOpenIcon />
            <span>{t('comparePickFile')}</span>
          </button>
        </div>
      </div>
    )
  }

  const renderRowsWithGaps = (rowsToRender: readonly DiffRow[], mode: CompareViewMode) => {
    const items: ReactNode[] = []
    const totalRowsCount = result?.rows.length ?? 0

    if (onlyChanges && rowsToRender.length > 0 && rowsToRender[0]!.index > 0) {
      items.push(
        <div key="gap-head" className="compare-gap-row" aria-hidden="true">
          <span>⋯ {rowsToRender[0]!.index}</span>
        </div>,
      )
    }

    rowsToRender.forEach((row, idx) => {
      if (onlyChanges && idx > 0) {
        const prev = rowsToRender[idx - 1]!
        const skipped = row.index - prev.index - 1
        if (skipped > 0) {
          items.push(
            <div
              key={`gap-${prev.index}-${row.index}`}
              className="compare-gap-row"
              aria-hidden="true"
            >
              <span>⋯ {skipped}</span>
            </div>,
          )
        }
      }

      const isActiveHunk = row.hunkIndex >= 0 && row.hunkIndex === activeHunk
      const focusHunk = () => {
        if (row.hunkIndex >= 0) setActiveHunk(row.hunkIndex)
      }

      if (mode === 'side-by-side') {
        const leftState =
          row.kind === 'delete' || row.kind === 'replace'
            ? 'is-removed'
            : row.kind === 'insert'
              ? 'is-empty-slot'
              : ''
        const rightState =
          row.kind === 'insert' || row.kind === 'replace'
            ? 'is-added'
            : row.kind === 'delete'
              ? 'is-empty-slot'
              : ''

        items.push(
          <div
            key={row.index}
            data-row-index={row.index}
            className={`compare-sbs-row${isActiveHunk ? ' is-active-hunk' : ''}${row.kind !== 'equal' ? ' is-changed' : ''}`}
            onClick={focusHunk}
          >
            <div className={`compare-cell is-left ${leftState}`}>
              <span className="compare-line-no">{row.leftLineNo ?? ''}</span>
              <span className="compare-line-text">
                {row.kind === 'insert' ? '' : renderInlineSegments(row.leftText, row.leftSegments)}
              </span>
            </div>
            <div className={`compare-cell is-right ${rightState}`}>
              <span className="compare-line-no">{row.rightLineNo ?? ''}</span>
              <span className="compare-line-text">
                {row.kind === 'delete'
                  ? ''
                  : renderInlineSegments(row.rightText, row.rightSegments)}
              </span>
            </div>
          </div>,
        )
        return
      }

      if (row.kind === 'replace') {
        items.push(
          <div
            key={row.index}
            data-row-index={row.index}
            className={`compare-inline-group${isActiveHunk ? ' is-active-hunk' : ''}`}
            onClick={focusHunk}
          >
            <div className="compare-inline-row is-removed">
              <span className="compare-line-no">{row.leftLineNo ?? ''}</span>
              <span className="compare-line-no" />
              <span className="compare-sign is-removed">-</span>
              <span className="compare-line-text">
                {renderInlineSegments(row.leftText, row.leftSegments)}
              </span>
            </div>
            <div className="compare-inline-row is-added">
              <span className="compare-line-no" />
              <span className="compare-line-no">{row.rightLineNo ?? ''}</span>
              <span className="compare-sign is-added">+</span>
              <span className="compare-line-text">
                {renderInlineSegments(row.rightText, row.rightSegments)}
              </span>
            </div>
          </div>,
        )
        return
      }

      const inlineClass =
        row.kind === 'delete' ? 'is-removed' : row.kind === 'insert' ? 'is-added' : ''
      const sign = row.kind === 'delete' ? '-' : row.kind === 'insert' ? '+' : ' '
      const content =
        row.kind === 'delete'
          ? renderInlineSegments(row.leftText, row.leftSegments)
          : row.kind === 'insert'
            ? renderInlineSegments(row.rightText, row.rightSegments)
            : row.leftText

      items.push(
        <div
          key={row.index}
          data-row-index={row.index}
          className={`compare-inline-row ${inlineClass}${isActiveHunk ? ' is-active-hunk' : ''}`}
          onClick={focusHunk}
        >
          <span className="compare-line-no">{row.leftLineNo ?? ''}</span>
          <span className="compare-line-no">{row.rightLineNo ?? ''}</span>
          <span className={`compare-sign ${inlineClass}`}>{sign}</span>
          <span className="compare-line-text">{content}</span>
        </div>,
      )
    })

    if (onlyChanges && rowsToRender.length > 0) {
      const lastRow = rowsToRender[rowsToRender.length - 1]!
      const tailSkipped = totalRowsCount - 1 - lastRow.index
      if (tailSkipped > 0) {
        items.push(
          <div key="gap-tail" className="compare-gap-row" aria-hidden="true">
            <span>⋯ {tailSkipped}</span>
          </div>,
        )
      }
    }

    return items
  }

  return (
    <div className="compare-view">
      <header className="compare-header">
        <div className="compare-selector-bar">
          {renderSourceSelector('left', leftRef, leftSourceKind)}
          <button
            type="button"
            className="compare-swap-btn"
            data-testid="compare-swap-btn"
            disabled={!leftRef && !rightRef}
            aria-label={t('compareSwap')}
            title={t('compareSwap')}
            onClick={handleSwap}
          >
            <SwapIcon />
          </button>
          {renderSourceSelector('right', rightRef, rightSourceKind)}
          <button
            type="button"
            className={`compare-refresh-btn${loading ? ' is-loading' : ''}`}
            data-testid="compare-refresh-btn"
            aria-label={t('compareRefresh')}
            title={t('compareRefresh')}
            onClick={handleRefresh}
          >
            <RefreshIcon />
          </button>
        </div>

        <div className="compare-toolbar">
          <div className="compare-toolbar-group">
            <div className="compare-mode-switch" role="group" aria-label={t('compareTabTitle')}>
              <button
                type="button"
                className={`compare-mode-btn${viewMode === 'side-by-side' ? ' is-active' : ''}`}
                aria-pressed={viewMode === 'side-by-side'}
                onClick={() => setViewMode('side-by-side')}
              >
                {t('compareModeSideBySide')}
              </button>
              <button
                type="button"
                className={`compare-mode-btn${viewMode === 'inline' ? ' is-active' : ''}`}
                aria-pressed={viewMode === 'inline'}
                onClick={() => setViewMode('inline')}
              >
                {t('compareModeInline')}
              </button>
            </div>

            <label className="compare-checkbox-label">
              <input
                type="checkbox"
                checked={ignoreWhitespace}
                onChange={(e) => setIgnoreWhitespace(e.target.checked)}
              />
              <span>{t('compareIgnoreWhitespace')}</span>
            </label>

            <label className="compare-checkbox-label">
              <input
                type="checkbox"
                checked={onlyChanges}
                onChange={(e) => setOnlyChanges(e.target.checked)}
              />
              <span>{t('compareOnlyChanges')}</span>
            </label>
          </div>

          <div className="compare-toolbar-group is-right">
            {result && (
              <div className="compare-stats">
                <span className="compare-stat-pill is-added">
                  {t('compareStatsAdded', { count: result.stats.addedLines })}
                </span>
                <span className="compare-stat-pill is-removed">
                  {t('compareStatsRemoved', { count: result.stats.removedLines })}
                </span>
                <span className="compare-stat-pill is-blocks">
                  {t('compareStatsBlocks', { count: result.stats.changedBlocks })}
                </span>
              </div>
            )}

            <div className="compare-hunk-nav">
              <button
                type="button"
                className="compare-nav-btn"
                disabled={totalHunks === 0}
                aria-label={t('comparePrevDiff')}
                title={t('comparePrevDiff')}
                onClick={() => navigateHunk(-1)}
              >
                <ChevronUpIcon />
                <span>{t('comparePrevDiff')}</span>
              </button>
              <span className="compare-hunk-counter">
                {currentHunkDisplay} / {totalHunks}
              </span>
              <button
                type="button"
                className="compare-nav-btn"
                disabled={totalHunks === 0}
                aria-label={t('compareNextDiff')}
                title={t('compareNextDiff')}
                onClick={() => navigateHunk(1)}
              >
                <span>{t('compareNextDiff')}</span>
                <ChevronDownIcon />
              </button>
            </div>

            <div className="compare-actions">
              <button
                type="button"
                className={`compare-action-btn${copied ? ' is-copied' : ''}`}
                disabled={!result}
                onClick={handleCopySummary}
              >
                {copied ? t('compareCopied') : t('compareCopySummary')}
              </button>
              <button
                type="button"
                className="compare-ai-btn"
                disabled={!result}
                onClick={handleAskAi}
              >
                <SparkAiIcon />
                <span>{t('compareAskAi')}</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="compare-diff-body" data-testid="compare-diff-body" ref={diffBodyRef}>
        {isTruncated && (
          <div className="compare-notice-banner" role="status">
            {t('compareTruncatedNotice')}
          </div>
        )}

        {!leftRef || !rightRef ? (
          <div className="compare-state-card">
            <div className="compare-state-icon">
              <EmptyCompareIcon />
            </div>
            <h2 className="compare-state-title">{t('compareEmptyTitle')}</h2>
            <p className="compare-state-hint">{t('compareEmptyHint')}</p>
          </div>
        ) : loading && !result ? (
          <div className="compare-state-card">
            <div className="compare-spinner" aria-hidden="true" />
            <p className="compare-state-hint">{t('compareLoading')}</p>
          </div>
        ) : error ? (
          <div className="compare-state-card is-error" role="alert">
            <p className="compare-state-error">{t('compareError', { message: error })}</p>
          </div>
        ) : result ? (
          isIdentical && onlyChanges ? (
            <div className="compare-state-card is-success">
              <p className="compare-state-title">{t('compareIdentical')}</p>
            </div>
          ) : (
            <div className={`compare-diff-surface is-${viewMode}`}>
              {isIdentical && (
                <div className="compare-identical-banner" role="status">
                  {t('compareIdentical')}
                </div>
              )}
              {viewMode === 'side-by-side' ? (
                <>
                  <div className="compare-sbs-header">
                    <div
                      className="compare-sbs-col-title"
                      title={result.left.filePath ?? result.left.label}
                    >
                      <span>{result.left.label}</span>
                      <span className={`compare-source-badge is-${result.left.source}`}>
                        {t(
                          result.left.source === 'live' ? 'compareSourceLive' : 'compareSourceDisk',
                        )}
                      </span>
                    </div>
                    <div
                      className="compare-sbs-col-title"
                      title={result.right.filePath ?? result.right.label}
                    >
                      <span>{result.right.label}</span>
                      <span className={`compare-source-badge is-${result.right.source}`}>
                        {t(
                          result.right.source === 'live'
                            ? 'compareSourceLive'
                            : 'compareSourceDisk',
                        )}
                      </span>
                    </div>
                  </div>
                  <div className="compare-rows">
                    {renderRowsWithGaps(visibleRows, 'side-by-side')}
                  </div>
                </>
              ) : (
                <>
                  <div className="compare-inline-header">
                    <span title={result.left.filePath ?? result.left.label}>
                      {result.left.label}
                    </span>
                    <span className="compare-inline-vs">⇄</span>
                    <span title={result.right.filePath ?? result.right.label}>
                      {result.right.label}
                    </span>
                  </div>
                  <div className="compare-rows">{renderRowsWithGaps(visibleRows, 'inline')}</div>
                </>
              )}
            </div>
          )
        ) : null}
      </main>
    </div>
  )
}
