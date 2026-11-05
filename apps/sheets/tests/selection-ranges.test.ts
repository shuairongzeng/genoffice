import { describe, expect, it } from 'vitest'

import { formatSelectionRanges } from '../src/renderer/selection-ranges'

describe('formatSelectionRanges', () => {
  it('reports every selected range, not just the active one (Ctrl+click multi-select)', () => {
    const ranges = [
      { getA1Notation: () => 'A8:I8' },
      { getA1Notation: () => 'A9:I9' },
    ]
    // two rows added with Ctrl+click: BOTH must appear in the selection chip,
    // not just the last active range
    expect(formatSelectionRanges(ranges)).toBe('A8:I8, A9:I9')
  })

  it('a single range reads as one A1 range', () => {
    expect(formatSelectionRanges([{ getA1Notation: () => 'C8:I8' }])).toBe('C8:I8')
  })

  it('an empty selection reads empty (the chip clears)', () => {
    expect(formatSelectionRanges([])).toBe('')
  })
})
