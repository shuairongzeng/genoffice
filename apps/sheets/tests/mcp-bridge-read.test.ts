/**
 * Tests for the MCP read_sheet bridge enhancements:
 * - Parameterless overview calls include a compact first-screen preview grid with formulas
 * - Explicit A1 ranges and single-range addresses (e.g. ["A1:Z60"]) are safely clamped to data extent
 * - Legacy single-cell addresses (e.g. ["A1", "B2"]) keep the exact `{ cells }` contract
 * - Huge ranges exceeding 2,000 cells truncate deterministically with `truncated: true`
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installSheetsMcpBridge, type McpSheetHandlers } from '../src/renderer/mcp-bridge'

type CommandListener = (message: {
  requestId: number
  command: string
  payload: Record<string, unknown>
}) => void

let commandListener: CommandListener | undefined
const reportMcpResult = vi.fn()

beforeEach(() => {
  commandListener = undefined
  reportMcpResult.mockReset()
  ;(globalThis as unknown as { window: unknown }).window = {
    desktopApi: {
      onMcpCommand: (listener: CommandListener) => {
        commandListener = listener
        return () => {}
      },
      reportMcpResult,
      signalMcpReady: () => {},
    },
  }
})

async function runReadSheet(
  handlers: McpSheetHandlers,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> {
  const uninstall = installSheetsMcpBridge(handlers)
  commandListener!({ requestId: 1, command: 'read_sheet', payload })
  uninstall()
  await vi.waitFor(() => expect(reportMcpResult).toHaveBeenCalledTimes(1))
  return reportMcpResult.mock.calls[0]![0] as {
    ok: boolean
    result?: Record<string, unknown>
    error?: string
  }
}

function makeGridHandlers(rows: number, columns: number): {
  handlers: McpSheetHandlers
  ensureRangeLoaded: ReturnType<typeof vi.fn>
} {
  const data = new Map<string, { value: unknown; display?: unknown; formula?: string }>([
    ['A1', { value: 'Month' }],
    ['B1', { value: 'USD' }],
    ['C1', { value: 'RMB' }],
    ['A2', { value: '2026-08' }],
    ['B2', { value: 205 }],
    ['C2', { value: 1476, display: '1,476.00', formula: '=B2*7.2' }],
    ['A5', { value: '2026-10' }],
    ['B5', { value: 205 }],
    ['C5', { value: 1476, formula: '=B5*7.2' }],
  ])
  const ensureRangeLoaded = vi.fn().mockResolvedValue(true)
  const handlers: McpSheetHandlers = {
    hasWorkbook: () => true,
    context: () => ({
      mode: 'lazy',
      sheetId: 'sheet-1',
      sheetName: 'Sheet1',
      sheets: [{ id: 'sheet-1', name: 'Sheet1', rows, columns }],
    }),
    ensureRangeLoaded,
    readCells: (addresses) => {
      const out: Record<string, unknown> = {}
      for (const addr of addresses) {
        out[addr] = data.get(addr) ?? { value: null }
      }
      return out
    },
    sheets: () => [{ id: 'sheet-1', name: 'Sheet1' }],
    focusSheet: () => {},
    applyOps: vi.fn().mockResolvedValue({ ok: true }),
    saveTo: vi.fn().mockResolvedValue({ ok: true }),
  }
  return { handlers, ensureRangeLoaded }
}

describe('mcp bridge read_sheet range & preview enhancements', () => {
  it('returns both workbook context and a first-screen preview grid with formulas when called with no args', async () => {
    const { handlers, ensureRangeLoaded } = makeGridHandlers(5, 3)
    const reply = await runReadSheet(handlers, {})
    expect(reply.ok).toBe(true)
    expect(ensureRangeLoaded).toHaveBeenCalledWith(
      { startRow: 0, startColumn: 0, endRow: 4, endColumn: 2 },
      undefined,
    )
    const result = reply.result!
    expect(result.context).toMatchObject({ sheetId: 'sheet-1', sheetName: 'Sheet1' })
    const preview = result.preview as Record<string, unknown>
    expect(preview).toMatchObject({
      sheetId: 'sheet-1',
      sheetName: 'Sheet1',
      range: 'A1:C5',
      dataExtent: 'A1:C5',
      rows: 5,
      columns: 3,
      truncated: false,
      formulas: { C2: '=B2*7.2', C5: '=B5*7.2' },
    })
    expect(String(preview.grid)).toContain('\tA\tB\tC')
    expect(String(preview.grid)).toContain('2\t2026-08\t205\t1,476.00')
    expect(String(preview.grid)).toContain('5\t2026-10\t205\t1476')
  })

  it('safely clamps an oversized range to the actual data extent', async () => {
    const { handlers } = makeGridHandlers(5, 3)
    const reply = await runReadSheet(handlers, { range: 'A1:Z60' })
    expect(reply.ok).toBe(true)
    expect(reply.result).toMatchObject({
      range: 'A1:C5',
      dataExtent: 'A1:C5',
      truncated: false,
    })
    expect(String(reply.result!.grid)).toContain('1,476.00')
  })

  it('accepts an A1 range inside addresses (e.g. ["A1:Z60"]) instead of throwing Invalid cell address', async () => {
    const { handlers } = makeGridHandlers(5, 3)
    const reply = await runReadSheet(handlers, { addresses: ['A1:Z60'] })
    expect(reply.ok).toBe(true)
    expect(reply.result).toMatchObject({
      range: 'A1:C5',
      dataExtent: 'A1:C5',
      truncated: false,
      formulas: { C2: '=B2*7.2', C5: '=B5*7.2' },
    })
    expect(String(reply.result!.grid)).toContain('2\t2026-08\t205\t1,476.00')
  })

  it('preserves the legacy { cells } response shape for explicit cell addresses', async () => {
    const { handlers, ensureRangeLoaded } = makeGridHandlers(5, 3)
    const reply = await runReadSheet(handlers, { addresses: ['A1', 'b2'] })
    expect(reply.ok).toBe(true)
    expect(ensureRangeLoaded).toHaveBeenCalledWith(
      { startRow: 0, startColumn: 0, endRow: 1, endColumn: 1 },
      undefined,
    )
    expect(reply.result).toEqual({
      cells: {
        A1: { value: 'Month' },
        B2: { value: 205 },
      },
    })
  })

  it('caps ranges exceeding 2,000 cells and flags truncated: true', async () => {
    const { handlers, ensureRangeLoaded } = makeGridHandlers(500, 26)
    const reply = await runReadSheet(handlers, { range: 'A1:Z500' })
    expect(reply.ok).toBe(true)
    // 2000 / 26 = 76 rows (rows 0..75 => A1:Z76, 1,976 cells)
    expect(ensureRangeLoaded).toHaveBeenCalledWith(
      { startRow: 0, startColumn: 0, endRow: 75, endColumn: 25 },
      undefined,
    )
    expect(reply.result).toMatchObject({
      range: 'A1:Z76',
      dataExtent: 'A1:Z500',
      truncated: true,
    })
  })
})
