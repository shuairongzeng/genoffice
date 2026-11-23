import type { TabKind } from './tabs-api'

export type CompareSourceRef = { kind: 'tab'; tabId: string } | { kind: 'file'; filePath: string }

export interface CompareOpenOptions {
  left?: CompareSourceRef
  right?: CompareSourceRef
}

export interface CompareTabSource {
  tabId: string
  title: string
  kind: TabKind
  filePath?: string
  dirty: boolean
}

export interface CompareDocumentMeta {
  id: string
  label: string
  filePath?: string
  tabId?: string
  tabKind?: TabKind
  source: 'live' | 'disk'
  charCount: number
  lineCount: number
  truncated?: boolean
  warning?: string
}

export interface InlineDiffSegment {
  value: string
  kind: 'equal' | 'insert' | 'delete'
}

export interface DiffRow {
  index: number
  kind: 'equal' | 'insert' | 'delete' | 'replace'
  leftLineNo: number | null
  rightLineNo: number | null
  leftText: string
  rightText: string
  leftSegments?: InlineDiffSegment[]
  rightSegments?: InlineDiffSegment[]
  hunkIndex: number
}

export interface DiffStats {
  addedLines: number
  removedLines: number
  changedBlocks: number
  unchangedLines: number
  totalRows: number
}

export interface CompareResult {
  left: CompareDocumentMeta
  right: CompareDocumentMeta
  rows: DiffRow[]
  stats: DiffStats
  hunkRowIndices: number[]
  ignoreWhitespace: boolean
  computedAt: number
}

export interface CompareRunRequest {
  left: CompareSourceRef
  right: CompareSourceRef
  ignoreWhitespace?: boolean
}

export interface CompareAskAiPayload {
  leftLabel: string
  rightLabel: string
  summaryMarkdown: string
}

export const COMPARE_CHANNELS = {
  openTab: 'compare:open-tab',
  getInit: 'compare:get-init',
  initUpdated: 'compare:init-updated',
  listSources: 'compare:list-sources',
  pickFile: 'compare:pick-file',
  runDiff: 'compare:run-diff',
  askAiSummary: 'compare:ask-ai-summary',
} as const
