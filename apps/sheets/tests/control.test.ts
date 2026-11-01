import { describe, expect, it, vi } from 'vitest'
import type { FWorkbook } from '@univerjs/sheets/facade'
import { handleSheetsControl, splitSheetRange } from '../src/renderer/control'

function fakeWorkbook(names: string[], active = names[0]!, booted = true) {
  const ranges: Array<{ a1: string; activate: ReturnType<typeof vi.fn> }> = []
  let activeRange: { getA1Notation(): string } | null = null
  const sheets = names.map((name) => {
    const sheet = {
      getSheetName: () => name,
      getVisibleRange: () => {
        if (!booted) throw new Error('no scroll render controller')
        return { startRow: 0, endRow: 20, startColumn: 0, endColumn: 10 }
      },
      getRange: (a1: string) => {
        const range = {
          activate: vi.fn(() => {
            activeRange = range
          }),
          getRow: () => 1,
          getColumn: () => 1,
          getWidth: () => 2,
          getHeight: () => 2,
          getA1Notation: () => a1,
          getValues: () => [
            [1, 2],
            [3, 4],
          ],
        }
        ranges.push({ a1, activate: range.activate })
        return range
      },
      scrollToCell: vi.fn(),
    }
    return sheet
  })
  let current = sheets[names.indexOf(active)]!
  const workbook = {
    getSheets: () => sheets,
    getSheetByName: (n: string) => sheets.find((s) => s.getSheetName() === n) ?? null,
    getActiveSheet: () => current,
    setActiveSheet: vi.fn((s: (typeof sheets)[number]) => {
      current = s
    }),
    getActiveRange: () => activeRange,
  }
  return {
    workbook: workbook as unknown as FWorkbook,
    sheets,
    ranges,
    setActiveRange: (a1: string) => {
      activeRange = current.getRange(a1)
    },
  }
}

describe('sheets control hook', () => {
  it('splits Sheet!Range specs and rejects non-A1 text', async () => {
    expect(splitSheetRange('b2:d5')).toEqual({ range: 'B2:D5' })
    expect(splitSheetRange("'Q1 Data'!A1")).toEqual({ sheet: 'Q1 Data', range: 'A1' })
    expect(splitSheetRange('Sheet1!$A$1:$B$9')).toEqual({ sheet: 'Sheet1', range: '$A$1:$B$9' })
    expect(splitSheetRange('1:3')).toBeNull()
    expect(splitSheetRange('Sheet1!')).toBeNull()
  })

  it('activates the sheet and range, scrolling it into view', async () => {
    const wb = fakeWorkbook(['Data', 'Summary'])
    const reply = await handleSheetsControl(
      { cmd: 'goto', target: { kind: 'range', range: 'Summary!B2:C3' } },
      wb.workbook,
      true,
    )
    expect(reply).toEqual({ status: 'ok', result: { sheet: 'Summary', range: 'B2:C3' } })
    expect(wb.workbook.setActiveSheet).toHaveBeenCalledWith(wb.sheets[1])
    expect(wb.ranges.at(-1)!.activate).toHaveBeenCalled()
    expect(wb.sheets[1]!.scrollToCell).toHaveBeenCalledWith(1, 1)
  })

  it('names the sheets on a miss and matches sheet names case-insensitively', async () => {
    const wb = fakeWorkbook(['Data'])
    expect(
      await handleSheetsControl(
        { cmd: 'goto', target: { kind: 'range', sheet: 'Nope', range: 'A1' } },
        wb.workbook,
        true,
      ),
    ).toMatchObject({
      status: 'error',
      error: { reason: 'sheet_not_found', detail: { sheets: ['Data'] } },
    })
    expect(
      await handleSheetsControl(
        { cmd: 'goto', target: { kind: 'range', range: 'data!A1' } },
        wb.workbook,
        true,
      ),
    ).toMatchObject({ status: 'ok', result: { sheet: 'Data' } })
    expect(
      await handleSheetsControl(
        { cmd: 'goto', target: { kind: 'range', range: 'x' } },
        wb.workbook,
        true,
      ),
    ).toMatchObject({ status: 'error', error: { reason: 'invalid_argument' } })
  })

  it('answers not_ready while the placeholder workbook of a spare view is mounted', async () => {
    const wb = fakeWorkbook(['Sheet1'])
    expect(
      await handleSheetsControl(
        { cmd: 'goto', target: { kind: 'range', range: 'B2' } },
        wb.workbook,
        false,
      ),
    ).toEqual({ status: 'not_ready' })
    expect(await handleSheetsControl({ cmd: 'selection' }, wb.workbook, false)).toEqual({
      status: 'not_ready',
    })
  })

  it('answers not_ready while the sheet render controllers are still booting', async () => {
    const wb = fakeWorkbook(['Data'], 'Data', false)
    expect(
      await handleSheetsControl(
        { cmd: 'goto', target: { kind: 'range', range: 'B2' } },
        wb.workbook,
        true,
      ),
    ).toEqual({ status: 'not_ready' })
    expect(await handleSheetsControl({ cmd: 'selection' }, wb.workbook, true)).toEqual({
      status: 'not_ready',
    })
  })

  it('reads the active range with its values when small', async () => {
    const wb = fakeWorkbook(['Data'])
    expect(await handleSheetsControl({ cmd: 'selection' }, null, true)).toEqual({
      status: 'not_ready',
    })
    expect(await handleSheetsControl({ cmd: 'selection' }, wb.workbook, true)).toEqual({
      status: 'ok',
      result: { none: true, sheet: 'Data' },
    })
    wb.setActiveRange('A1:B2')
    expect(await handleSheetsControl({ cmd: 'selection' }, wb.workbook, true)).toEqual({
      status: 'ok',
      result: {
        sheet: 'Data',
        range: 'A1:B2',
        values: [
          [1, 2],
          [3, 4],
        ],
      },
    })
  })

  it('a text target (the search deep link) reveals through gotoText', async () => {
    // issue #56: a search hit's cite opens the workbook where it matched
    const gotoText = vi.fn(async () => 'revealed' as const)
    expect(
      await handleSheetsControl(
        { cmd: 'goto', target: { kind: 'text', text: 'termination' } },
        fakeWorkbook(['Data']).workbook,
        true,
        gotoText,
      ),
    ).toEqual({ status: 'ok', result: { text: 'termination' } })
    expect(gotoText).toHaveBeenCalledWith('termination')
    // a find miss is target_not_found — the ask loop stops there, it does not retry
    expect(
      await handleSheetsControl(
        { cmd: 'goto', target: { kind: 'text', text: 'needle' } },
        fakeWorkbook(['Data']).workbook,
        true,
        vi.fn(async () => 'not-found' as const),
      ),
    ).toMatchObject({ status: 'error', error: { reason: 'target_not_found' } })
    // a hit whose land failed is not_ready: the text exists, the shell retries
    // the boot window instead of concluding the target is absent
    expect(
      await handleSheetsControl(
        { cmd: 'goto', target: { kind: 'text', text: 'termination' } },
        fakeWorkbook(['Data']).workbook,
        true,
        vi.fn(async () => 'not-ready' as const),
      ),
    ).toEqual({ status: 'not_ready' })
    // no reveal surface wired: not_ready, the shell may ask again
    expect(
      await handleSheetsControl(
        { cmd: 'goto', target: { kind: 'text', text: 'needle' } },
        fakeWorkbook(['Data']).workbook,
        true,
        undefined,
      ),
    ).toEqual({ status: 'not_ready' })
  })

  it('an empty text target is invalid', async () => {
    expect(
      await handleSheetsControl(
        { cmd: 'goto', target: { kind: 'text', text: '  ' } },
        fakeWorkbook(['Data']).workbook,
        true,
        vi.fn(async () => 'revealed' as const),
      ),
    ).toMatchObject({ status: 'error', error: { reason: 'invalid_argument' } })
  })
})
