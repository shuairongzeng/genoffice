import { z } from 'zod'
import type { McpCommandMessage } from '../shared/desktop-api'
import {
  describeOperationErrors,
  workbookOperationSchema,
  type WorkbookOperation,
} from '@genoffice/xlsx-gateway/domain/workbook-dsl'
import {
  columnLabel,
  formatAddress,
  parseAddress,
  parseRange,
  rangeCellCount,
  type RangeBounds,
} from '@genoffice/xlsx-gateway/domain/cell-address'
import { normalizeSheetRefs, primaryCellOf, primarySheetId, type SheetRef } from './mcp-sheet-refs'

const MAX_MCP_RANGE_CELLS = 2_000
const PREVIEW_MAX_ROWS = 100
const PREVIEW_MAX_COLS = 26

interface SheetExtent {
  sheetId?: string
  sheetName?: string
  rows?: number
  columns?: number
}

interface McpCellValue {
  value?: unknown
  display?: unknown
  formula?: string
}

/**
 * Renderer half of the MCP → sheets-grid bridge.
 *
 * The shell main process pushes one command at a time (`sheets:mcp-command`);
 * each command runs against the live Univer workbook through the same executors
 * the built-in AI uses (readers from ai/workbook-readers.ts, the op planner and
 * apply path from op-executor.ts, the save pipeline from save-actions.ts), so
 * external edits land in the edit journal and undo history exactly like
 * in-app/AI ones. Results are reported back correlated by requestId
 * (`sheets:mcp-result`), and once the workbook is mounted the bridge announces
 * `sheets:mcp-ready` — the shell waits for it before accepting a session.
 *
 * No-op when the preload lacks the bridge channels (standalone/dev builds
 * without MCP wiring).
 */

const READY_POLL_MS = 50
/** after the fast window the poll backs off instead of stopping (see below) */
const READY_SLOW_POLL_MS = 1_000
const READY_FAST_WINDOW_MS = 20_000

export interface McpSheetHandlers {
  /** workbook mounted and editable? (drives the ready announce) */
  hasWorkbook: () => boolean
  /** workbook overview: sheets with ids/names/extents, active sheet */
  context: () => unknown
  /** materialize lazy-loaded range blocks before reading cells when supported */
  ensureRangeLoaded?: (bounds: RangeBounds, sheetId?: string) => Promise<boolean> | boolean
  /** values + formulas for the requested A1 addresses */
  readCells: (addresses: string[], sheetId?: string) => unknown
  /** the workbook's worksheets, for resolving name-addressed ops */
  sheets: () => readonly SheetRef[]
  /** apply a workbook DSL batch (planFromOps + applyChangePlan) */
  applyOps: (ops: WorkbookOperation[], dryRun: boolean) => Promise<unknown>
  /** bring a sheet (and optionally a cell) into view before/after an edit */
  focusSheet: (sheetId: string, address?: string) => void
  /** save to an explicit absolute path (dialog-free) */
  saveTo: (
    path: string,
    overwrite: boolean,
  ) => Promise<{ ok: boolean; path?: string; error?: string }>
}

export function installSheetsMcpBridge(handlers: McpSheetHandlers): () => void {
  const api = window.desktopApi
  if (typeof api?.onMcpCommand !== 'function') return () => {}

  /** one command at a time, in arrival order — applies and saves must not interleave */
  let queue: Promise<void> = Promise.resolve()
  let disposed = false

  // Announce readiness as soon as the workbook is mounted, then stop polling.
  //
  // The poll must never give up permanently: a cold dev start (vite serving the
  // Univer bundle, the sidecar opening the workbook) can take longer than the
  // fast window, and once the timer has stopped the tab stays unaddressable
  // over MCP for the rest of its life — the grid looks perfectly normal in the
  // UI while every sheet command times out in the shell. Back off instead.
  let readyTimer: ReturnType<typeof setTimeout> | null = null
  const mountedAt = performance.now()
  const announceWhenMounted = (): void => {
    readyTimer = null
    if (disposed) return
    if (handlers.hasWorkbook()) {
      api.signalMcpReady()
      return
    }
    const slow = performance.now() - mountedAt > READY_FAST_WINDOW_MS
    readyTimer = setTimeout(announceWhenMounted, slow ? READY_SLOW_POLL_MS : READY_POLL_MS)
  }
  readyTimer = setTimeout(announceWhenMounted, READY_POLL_MS)

  const off = api.onMcpCommand((message: McpCommandMessage) => {
    queue = queue.then(() => runCommand(message)).catch(() => undefined)
  })

  return () => {
    disposed = true
    if (readyTimer !== null) clearTimeout(readyTimer)
    off()
  }

  /** First schema issue, with the offending op named so the client can fix it. */
  function describeOpError(ops: unknown[], error: z.ZodError): string {
    const text = describeOperationErrors(ops, error)
    return error.issues.some((issue) => issue.path.includes('sheetId'))
      ? `${text}\nCall read_sheet first and use a sheetId from its output.`
      : text
  }

  /**
   * A read's target sheet: the name the caller gave (`sheet`, the CLI's
   * vocabulary) resolved against the open workbook, else the id it passed.
   * Ids are session artifacts, so a name that no longer matches fails loudly
   * instead of reading the wrong sheet.
   */
  function resolveReadSheet(
    name: string | undefined,
    id: string | undefined,
  ): { ok: true; sheetId?: string } | { ok: false; error: string } {
    if (name === undefined) return { ok: true, ...(id === undefined ? {} : { sheetId: id }) }
    const sheets = handlers.sheets()
    if (sheets.some((sheet) => sheet.id === name)) return { ok: true, sheetId: name }
    const match = sheets.find(
      (sheet) => sheet.name.trim().toLowerCase() === name.trim().toLowerCase(),
    )
    if (match) return { ok: true, sheetId: match.id }
    const known = sheets.length === 0 ? 'none' : sheets.map((sheet) => sheet.name).join(', ')
    return {
      ok: false,
      error: `no worksheet named "${name}" in this workbook (sheets: ${known}); call read_sheet for the current sheets`,
    }
  }

  function targetSheetExtent(context: unknown, sheetId?: string): SheetExtent {
    if (!context || typeof context !== 'object') return {}
    const obj = context as { sheetId?: unknown; sheetName?: unknown; sheets?: unknown }
    const sheets = Array.isArray(obj.sheets)
      ? (obj.sheets as Array<{ id?: unknown; name?: unknown; rows?: unknown; columns?: unknown }>)
      : []
    const chosenId =
      typeof sheetId === 'string' && sheetId
        ? sheetId
        : typeof obj.sheetId === 'string'
          ? obj.sheetId
          : undefined
    const found =
      (chosenId ? sheets.find((s) => s.id === chosenId) : undefined) ??
      (typeof obj.sheetName === 'string' ? sheets.find((s) => s.name === obj.sheetName) : undefined) ??
      sheets[0]
    return {
      ...(typeof found?.id === 'string'
        ? { sheetId: found.id }
        : chosenId
          ? { sheetId: chosenId }
          : {}),
      ...(typeof found?.name === 'string'
        ? { sheetName: found.name }
        : typeof obj.sheetName === 'string'
          ? { sheetName: obj.sheetName }
          : {}),
      ...(typeof found?.rows === 'number' && Number.isFinite(found.rows) ? { rows: found.rows } : {}),
      ...(typeof found?.columns === 'number' && Number.isFinite(found.columns)
        ? { columns: found.columns }
        : {}),
    }
  }

  function clampBoundsToExtent(
    bounds: RangeBounds,
    extent: SheetExtent,
    maxCells: number,
  ): { bounds: RangeBounds | null; truncated: boolean; dataExtent?: string } {
    if (extent.rows === 0 || extent.columns === 0) {
      return { bounds: null, truncated: false }
    }
    const hasExtent =
      extent.rows !== undefined &&
      extent.columns !== undefined &&
      extent.rows > 0 &&
      extent.columns > 0
    const dataExtent = hasExtent
      ? `A1:${columnLabel(extent.columns! - 1)}${extent.rows!}`
      : undefined
    if (hasExtent && (bounds.startRow >= extent.rows! || bounds.startColumn >= extent.columns!)) {
      return { bounds: null, truncated: false, ...(dataExtent ? { dataExtent } : {}) }
    }
    let endRow = hasExtent ? Math.min(bounds.endRow, extent.rows! - 1) : bounds.endRow
    let endColumn = hasExtent ? Math.min(bounds.endColumn, extent.columns! - 1) : bounds.endColumn
    let truncated = false
    const colsWanted = endColumn - bounds.startColumn + 1
    if (colsWanted > maxCells) {
      endColumn = bounds.startColumn + maxCells - 1
      truncated = true
    }
    const colsClamped = endColumn - bounds.startColumn + 1
    const maxRows = Math.max(1, Math.floor(maxCells / colsClamped))
    if (endRow - bounds.startRow + 1 > maxRows) {
      endRow = bounds.startRow + maxRows - 1
      truncated = true
    }
    return {
      bounds: {
        startRow: bounds.startRow,
        startColumn: bounds.startColumn,
        endRow,
        endColumn,
      },
      truncated,
      ...(dataExtent ? { dataExtent } : {}),
    }
  }

  function formatCellForGrid(cell: McpCellValue | undefined): {
    text: string
    hasContent: boolean
    formula?: string
  } {
    if (!cell) return { text: '', hasContent: false }
    const raw =
      cell.display !== undefined && cell.display !== null
        ? cell.display
        : cell.value !== undefined && cell.value !== null
          ? cell.value
          : cell.formula
    const hasContent = raw !== undefined && raw !== null && String(raw) !== ''
    const text = hasContent
      ? String(raw).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\r?\n|\r/g, '\\n')
      : ''
    return { text, hasContent, ...(cell.formula ? { formula: cell.formula } : {}) }
  }

  async function readRangeGrid(
    bounds: RangeBounds,
    sheetId: string | undefined,
    extent: SheetExtent,
    dataExtent: string | undefined,
    truncated: boolean,
  ): Promise<Record<string, unknown>> {
    if (handlers.ensureRangeLoaded) {
      await handlers.ensureRangeLoaded(bounds, sheetId)
    }
    const addresses: string[] = []
    for (let r = bounds.startRow; r <= bounds.endRow; r += 1) {
      for (let c = bounds.startColumn; c <= bounds.endColumn; c += 1) {
        addresses.push(formatAddress(r, c))
      }
    }
    const cells = handlers.readCells(addresses, sheetId) as Record<string, McpCellValue | undefined>
    const header = [
      '',
      ...Array.from({ length: bounds.endColumn - bounds.startColumn + 1 }, (_, i) =>
        columnLabel(bounds.startColumn + i),
      ),
    ].join('\t')
    const dataLines: string[] = []
    const formulas: Record<string, string> = {}
    for (let r = bounds.startRow; r <= bounds.endRow; r += 1) {
      const rowCols: string[] = [String(r + 1)]
      let rowHasContent = false
      for (let c = bounds.startColumn; c <= bounds.endColumn; c += 1) {
        const addr = formatAddress(r, c)
        const formatted = formatCellForGrid(cells[addr])
        if (formatted.hasContent) rowHasContent = true
        if (formatted.formula) formulas[addr] = formatted.formula
        rowCols.push(formatted.text)
      }
      if (rowHasContent) dataLines.push(rowCols.join('\t'))
    }
    const grid = dataLines.length > 0 ? [header, ...dataLines].join('\n') : '(empty range)'
    return {
      ...(extent.sheetId ? { sheetId: extent.sheetId } : {}),
      ...(extent.sheetName ? { sheetName: extent.sheetName } : {}),
      range: `${formatAddress(bounds.startRow, bounds.startColumn)}:${formatAddress(bounds.endRow, bounds.endColumn)}`,
      ...(dataExtent ? { dataExtent } : {}),
      ...(extent.rows !== undefined ? { rows: extent.rows } : {}),
      ...(extent.columns !== undefined ? { columns: extent.columns } : {}),
      truncated,
      grid,
      ...(Object.keys(formulas).length > 0 ? { formulas } : {}),
    }
  }

  async function readSheetRangePayload(
    rawRange: string,
    sheetId: string | undefined,
  ): Promise<Record<string, unknown>> {
    const parsed = parseRange(rawRange.toUpperCase())
    const extent = targetSheetExtent(handlers.context(), sheetId)
    const clamped = clampBoundsToExtent(parsed, extent, MAX_MCP_RANGE_CELLS)
    if (!clamped.bounds) {
      return {
        ...(extent.sheetId ? { sheetId: extent.sheetId } : {}),
        ...(extent.sheetName ? { sheetName: extent.sheetName } : {}),
        range: rawRange.toUpperCase(),
        ...(clamped.dataExtent ? { dataExtent: clamped.dataExtent } : {}),
        ...(extent.rows !== undefined ? { rows: extent.rows } : {}),
        ...(extent.columns !== undefined ? { columns: extent.columns } : {}),
        truncated: false,
        grid: '(empty range)',
      }
    }
    return readRangeGrid(clamped.bounds, sheetId, extent, clamped.dataExtent, clamped.truncated)
  }

  async function readSheetAddressesPayload(
    rawAddresses: string[],
    sheetId: string | undefined,
  ): Promise<Record<string, unknown>> {
    if (!rawAddresses.some((a) => a.includes(':'))) {
      const coords = rawAddresses.flatMap((a) => {
        try {
          return [parseAddress(a.toUpperCase())]
        } catch {
          return []
        }
      })
      if (coords.length > 0 && handlers.ensureRangeLoaded) {
        const box: RangeBounds = {
          startRow: Math.min(...coords.map((p) => p.row)),
          startColumn: Math.min(...coords.map((p) => p.column)),
          endRow: Math.max(...coords.map((p) => p.row)),
          endColumn: Math.max(...coords.map((p) => p.column)),
        }
        if (rangeCellCount(box) <= MAX_MCP_RANGE_CELLS) {
          await handlers.ensureRangeLoaded(box, sheetId)
        }
      }
      const normalized = rawAddresses.map((a) => {
        try {
          const p = parseAddress(a.toUpperCase())
          return formatAddress(p.row, p.column)
        } catch {
          return a
        }
      })
      return { cells: handlers.readCells(normalized, sheetId) }
    }

    const extent = targetSheetExtent(handlers.context(), sheetId)
    const expanded = new Set<string>()
    const explicitSingles = new Set<string>()
    let truncated = false
    for (const token of rawAddresses) {
      if (token.includes(':')) {
        const remaining = MAX_MCP_RANGE_CELLS - expanded.size
        if (remaining <= 0) {
          truncated = true
          break
        }
        const parsed = parseRange(token.toUpperCase())
        const clamped = clampBoundsToExtent(parsed, extent, remaining)
        if (clamped.truncated) truncated = true
        if (!clamped.bounds) continue
        if (handlers.ensureRangeLoaded) {
          await handlers.ensureRangeLoaded(clamped.bounds, sheetId)
        }
        for (let r = clamped.bounds.startRow; r <= clamped.bounds.endRow; r += 1) {
          for (let c = clamped.bounds.startColumn; c <= clamped.bounds.endColumn; c += 1) {
            if (expanded.size >= MAX_MCP_RANGE_CELLS) {
              truncated = true
              break
            }
            expanded.add(formatAddress(r, c))
          }
          if (expanded.size >= MAX_MCP_RANGE_CELLS) break
        }
      } else {
        const p = parseAddress(token.toUpperCase())
        const addr = formatAddress(p.row, p.column)
        explicitSingles.add(addr)
        if (expanded.size < MAX_MCP_RANGE_CELLS) expanded.add(addr)
        else truncated = true
      }
    }
    if (explicitSingles.size > 0 && handlers.ensureRangeLoaded) {
      const pts = [...explicitSingles].map((a) => parseAddress(a))
      const box: RangeBounds = {
        startRow: Math.min(...pts.map((p) => p.row)),
        startColumn: Math.min(...pts.map((p) => p.column)),
        endRow: Math.max(...pts.map((p) => p.row)),
        endColumn: Math.max(...pts.map((p) => p.column)),
      }
      if (rangeCellCount(box) <= MAX_MCP_RANGE_CELLS) {
        await handlers.ensureRangeLoaded(box, sheetId)
      }
    }
    const rawCells = handlers.readCells([...expanded], sheetId) as Record<
      string,
      McpCellValue | undefined
    >
    const cells: Record<string, McpCellValue | undefined> = {}
    for (const [addr, cell] of Object.entries(rawCells)) {
      const isNonEmpty =
        cell !== undefined &&
        ((cell.value !== undefined && cell.value !== null) ||
          (cell.display !== undefined && cell.display !== null) ||
          Boolean(cell.formula))
      if (explicitSingles.has(addr) || isNonEmpty) {
        cells[addr] = cell
      }
    }
    return truncated ? { cells, truncated: true } : { cells }
  }

  async function readSheetPreview(
    context: unknown,
    sheetId: string | undefined,
  ): Promise<Record<string, unknown> | undefined> {
    const extent = targetSheetExtent(context, sheetId)
    if (!extent.rows || !extent.columns || extent.rows <= 0 || extent.columns <= 0) {
      return undefined
    }
    const wanted: RangeBounds = {
      startRow: 0,
      startColumn: 0,
      endRow: Math.min(extent.rows - 1, PREVIEW_MAX_ROWS - 1),
      endColumn: Math.min(extent.columns - 1, PREVIEW_MAX_COLS - 1),
    }
    const clamped = clampBoundsToExtent(wanted, extent, MAX_MCP_RANGE_CELLS)
    if (!clamped.bounds) return undefined
    const truncated =
      clamped.truncated || extent.rows > PREVIEW_MAX_ROWS || extent.columns > PREVIEW_MAX_COLS
    return readRangeGrid(clamped.bounds, sheetId, extent, clamped.dataExtent, truncated)
  }

  async function runCommand(message: McpCommandMessage): Promise<void> {
    const reply = (ok: boolean, result?: unknown, error?: string): void => {
      api.reportMcpResult({
        requestId: message.requestId,
        ok,
        ...(result !== undefined ? { result } : {}),
        ...(error !== undefined ? { error } : {}),
      })
    }
    try {
      const payload = (message.payload ?? {}) as Record<string, unknown>
      switch (message.command) {
        case 'read_sheet': {
          const rawRange =
            typeof payload.range === 'string' && payload.range.trim()
              ? payload.range.trim()
              : undefined
          const rawAddresses = Array.isArray(payload.addresses)
            ? payload.addresses
                .filter((a): a is string => typeof a === 'string')
                .map((a) => a.trim())
                .filter(Boolean)
            : []
          const resolved = resolveReadSheet(
            typeof payload.sheet === 'string' ? payload.sheet : undefined,
            typeof payload.sheetId === 'string' ? payload.sheetId : undefined,
          )
          if (!resolved.ok) {
            reply(false, undefined, resolved.error)
            return
          }
          if (rawRange) {
            reply(true, await readSheetRangePayload(rawRange, resolved.sheetId))
          } else if (rawAddresses.length === 1 && rawAddresses[0]!.includes(':')) {
            reply(true, await readSheetRangePayload(rawAddresses[0]!, resolved.sheetId))
          } else if (rawAddresses.length > 0) {
            reply(true, await readSheetAddressesPayload(rawAddresses, resolved.sheetId))
          } else {
            const context = handlers.context()
            const preview = await readSheetPreview(context, resolved.sheetId)
            reply(true, preview ? { context, preview } : { context })
          }
          return
        }
        case 'apply_ops': {
          const ops = Array.isArray(payload.ops) ? payload.ops : []
          if (ops.length === 0) {
            reply(false, undefined, 'ops must be a non-empty array')
            return
          }
          // Worksheet names are the stable reference (the CLI's vocabulary);
          // ids remain accepted. Resolved here, in the renderer, because only
          // this process knows the open workbook's sheets.
          const named = normalizeSheetRefs(ops, handlers.sheets())
          if (!named.ok) {
            reply(false, undefined, named.error)
            return
          }
          // Same validation the built-in AI path applies (ai/tools.ts): without
          // it a missing sheetId surfaces later as a cryptic
          // "Unknown sheet: undefined" from the planner instead of naming the op.
          const parsed = z.array(workbookOperationSchema).safeParse(named.ops)
          if (!parsed.success) {
            reply(false, undefined, describeOpError(named.ops, parsed.error))
            return
          }
          const sheetId = primarySheetId(parsed.data)
          const dryRun = payload.dryRun === true
          if (sheetId !== undefined && !dryRun)
            handlers.focusSheet(sheetId, primaryCellOf(parsed.data))
          reply(true, await handlers.applyOps(parsed.data, dryRun))
          return
        }
        case 'save_sheet': {
          const path = typeof payload.path === 'string' ? payload.path : ''
          const overwrite = payload.overwrite === true
          if (!path) {
            reply(false, undefined, 'save_sheet needs an absolute path')
            return
          }
          const saved = await handlers.saveTo(path, overwrite)
          // a refused save must surface as an error so the agent keeps its session and can retry
          if (!saved.ok) {
            reply(false, undefined, saved.error ?? 'the spreadsheet could not be saved')
            return
          }
          reply(true, saved)
          return
        }
        default:
          reply(false, undefined, `unknown command: ${String(message.command)}`)
      }
    } catch (error: unknown) {
      reply(false, undefined, error instanceof Error ? error.message : String(error))
    }
  }
}
