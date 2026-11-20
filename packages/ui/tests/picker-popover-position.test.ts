import { describe, expect, it } from 'vitest'
import { computePickerPopoverStyle, PICKER_POPOVER_MARGIN } from '../src/picker-popover-position'

describe('computePickerPopoverStyle', () => {
  it('aligns to anchor.left with preferred width in wide viewports', () => {
    const style = computePickerPopoverStyle(
      { left: 190, right: 270, top: 630, bottom: 654 },
      { width: 900, height: 700 },
      { preferredWidth: 300 },
    )
    expect(style.left).toBe(190)
    expect(style.width).toBe(300)
    expect(style.bottom).toBe(700 - 630 + 6)
    expect(style.top).toBeUndefined()
  })

  it('clamps left inward when anchor + preferredWidth would overflow a narrow viewport', () => {
    const style = computePickerPopoverStyle(
      { left: 190, right: 270, top: 630, bottom: 654 },
      { width: 360, height: 680 },
      { preferredWidth: 300 },
    )
    expect(style.width).toBe(300)
    expect(style.left).toBe(52)
    expect(Number(style.left)).toBeGreaterThanOrEqual(PICKER_POPOVER_MARGIN)
    expect(Number(style.left) + Number(style.width)).toBeLessThanOrEqual(
      360 - PICKER_POPOVER_MARGIN,
    )
  })

  it('shrinks width to fit ultra-narrow viewports inside the horizontal margins', () => {
    const style = computePickerPopoverStyle(
      { left: 140, right: 200, top: 600, bottom: 624 },
      { width: 260, height: 640 },
      { preferredWidth: 300 },
    )
    expect(style.width).toBe(244)
    expect(style.left).toBe(8)
    expect(Number(style.left) + Number(style.width)).toBe(252)
  })

  it('flips downward when the chip sits near the top edge with more space below', () => {
    const style = computePickerPopoverStyle(
      { left: 20, right: 120, top: 40, bottom: 64 },
      { width: 400, height: 600 },
      { preferredWidth: 260 },
    )
    expect(style.top).toBe(70)
    expect(style.bottom).toBeUndefined()
    expect(style.maxHeight).toBe(420)
  })
})
