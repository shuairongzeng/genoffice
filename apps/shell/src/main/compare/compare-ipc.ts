import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  COMPARE_CHANNELS,
  type CompareAskAiPayload,
  type CompareDocumentMeta,
  type CompareOpenOptions,
  type CompareResult,
  type CompareSourceRef,
  type CompareTabSource,
} from '../../shared/compare-api'
import { computeTextDiff } from './text-diff-engine'

export interface CompareIpcDeps {
  openCompareTab: (opts?: CompareOpenOptions) => string | Promise<string>
  getCompareInitForSender: (wcId: number) => CompareOpenOptions | undefined
  listSources: () => Promise<CompareTabSource[]>
  pickFile: () => Promise<string | null>
  extractor: {
    extract: (ref: CompareSourceRef) => Promise<{ meta: CompareDocumentMeta; text: string }>
  }
  askAi: (payload: CompareAskAiPayload) => void | Promise<void>
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isCompareSourceRef(value: unknown): value is CompareSourceRef {
  if (!isPlainRecord(value)) return false
  if (value.kind === 'tab') {
    return typeof value.tabId === 'string' && value.tabId.trim().length > 0
  }
  if (value.kind === 'file') {
    return typeof value.filePath === 'string' && value.filePath.trim().length > 0
  }
  return false
}

function parseOpenOptions(raw: unknown): CompareOpenOptions | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!isPlainRecord(raw)) {
    throw new Error('Invalid compare open options')
  }
  const opts: CompareOpenOptions = {}
  if (raw.left !== undefined) {
    if (!isCompareSourceRef(raw.left)) throw new Error('Invalid left compare source')
    opts.left = raw.left
  }
  if (raw.right !== undefined) {
    if (!isCompareSourceRef(raw.right)) throw new Error('Invalid right compare source')
    opts.right = raw.right
  }
  return opts
}

function parseRunRequest(raw: unknown): {
  left: CompareSourceRef
  right: CompareSourceRef
  ignoreWhitespace: boolean
} {
  if (!isPlainRecord(raw)) {
    throw new Error('Invalid compare request payload')
  }
  if (!isCompareSourceRef(raw.left)) {
    throw new Error('Invalid left compare source')
  }
  if (!isCompareSourceRef(raw.right)) {
    throw new Error('Invalid right compare source')
  }
  return {
    left: raw.left,
    right: raw.right,
    ignoreWhitespace: raw.ignoreWhitespace === true,
  }
}

function parseAskAiPayload(raw: unknown): CompareAskAiPayload {
  if (!isPlainRecord(raw)) {
    throw new Error('Invalid compare AI summary payload')
  }
  if (
    typeof raw.leftLabel !== 'string' ||
    typeof raw.rightLabel !== 'string' ||
    typeof raw.summaryMarkdown !== 'string'
  ) {
    throw new Error(
      'Compare AI summary payload requires leftLabel, rightLabel, and summaryMarkdown',
    )
  }
  return {
    leftLabel: raw.leftLabel,
    rightLabel: raw.rightLabel,
    summaryMarkdown: raw.summaryMarkdown,
  }
}

function registerIdempotentHandler(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, handler)
}

/** Register idempotent IPC invoke handlers for all document compare channels. */
export function registerCompareIpc(deps: CompareIpcDeps): void {
  registerIdempotentHandler(COMPARE_CHANNELS.openTab, (_event, rawOpts) =>
    deps.openCompareTab(parseOpenOptions(rawOpts)),
  )

  registerIdempotentHandler(COMPARE_CHANNELS.getInit, (event) =>
    deps.getCompareInitForSender(event.sender.id),
  )

  registerIdempotentHandler(COMPARE_CHANNELS.listSources, () => deps.listSources())

  registerIdempotentHandler(COMPARE_CHANNELS.pickFile, () => deps.pickFile())

  registerIdempotentHandler(
    COMPARE_CHANNELS.runDiff,
    async (_event, rawReq): Promise<CompareResult> => {
      const req = parseRunRequest(rawReq)
      const [leftData, rightData] = await Promise.all([
        deps.extractor.extract(req.left),
        deps.extractor.extract(req.right),
      ])
      const diff = computeTextDiff(leftData.text, rightData.text, {
        ignoreWhitespace: req.ignoreWhitespace,
      })

      return {
        left: {
          ...leftData.meta,
          truncated: Boolean(leftData.meta.truncated || diff.inlineSkipped),
        },
        right: {
          ...rightData.meta,
          truncated: Boolean(rightData.meta.truncated || diff.inlineSkipped),
        },
        rows: diff.rows,
        stats: diff.stats,
        hunkRowIndices: diff.hunkRowIndices,
        ignoreWhitespace: req.ignoreWhitespace,
        computedAt: Date.now(),
      }
    },
  )

  registerIdempotentHandler(COMPARE_CHANNELS.askAiSummary, (_event, rawPayload) =>
    deps.askAi(parseAskAiPayload(rawPayload)),
  )
}
