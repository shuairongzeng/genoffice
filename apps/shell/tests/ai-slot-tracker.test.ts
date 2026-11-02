import { describe, expect, it } from 'vitest'
import { createAiSlotTracker, type SlotRectReport } from '../src/main/ai-slot-tracker'

/**
 * The AI-slot tracker (src/main/ai-slot-tracker.ts): the docs app's reserved
 * slot rect, converted from the renderer's view-local measurement into
 * window px, and gated for use — keyed to the webContents that measured it,
 * refused while stale (the tab was hidden, its own report went degenerate)
 * or measured under another interface scale, a first degenerate report
 * arming nothing. Pure bookkeeping; the TabManager owns the wiring and the
 * drawer overlay owns the fitting.
 */

const VIEW = { x: 12, y: 44, width: 800, height: 556 }
const report = (over: Partial<SlotRectReport> = {}): SlotRectReport => ({
  x: 500,
  y: 0,
  width: 300,
  height: 556,
  ...over,
})

describe('createAiSlotTracker', () => {
  it('converts a view-local report into window px (view bounds + rect)', () => {
    const tracker = createAiSlotTracker()
    tracker.report(7, VIEW, report(), 1)
    expect(tracker.slotFor({ id: 7 }, 1)).toEqual({ x: 512, y: 44, width: 300, height: 556 })
  })

  it('rounds to whole pixels; a degenerate (collapsed) report marks the entry stale', () => {
    const tracker = createAiSlotTracker()
    tracker.report(7, VIEW, report({ x: 500.4, y: 0.4, width: 299.6 }), 1)
    expect(tracker.slotFor({ id: 7 }, 1)).toEqual({ x: 512, y: 44, width: 300, height: 556 })
    // a collapsed slot reports zero width — that is a layout event, not
    // noise: whatever the same webContents measured before no longer
    // describes it, so the entry goes stale and the overlay falls back to
    // the window-edge geometry one round trip sooner than the next
    // activation's re-request would heal it
    tracker.report(7, VIEW, report({ width: 0 }), 1)
    expect(tracker.slotFor({ id: 7 }, 1)).toBeNull()
    // a fresh re-report serves again (the drawer reopened)
    tracker.report(7, VIEW, report({ x: 490, width: 310 }), 1)
    expect(tracker.slotFor({ id: 7 }, 1)).toEqual({ x: 502, y: 44, width: 310, height: 556 })
    // a first degenerate report arms nothing
    const fresh = createAiSlotTracker()
    fresh.report(8, VIEW, report({ height: -4 }), 1)
    expect(fresh.slotFor({ id: 8 }, 1)).toBeNull()
    // and a degenerate report from ANOTHER wc does not touch the tracked
    // entry — only the owner's own collapse says its geometry changed
    const other = createAiSlotTracker()
    other.report(7, VIEW, report(), 1)
    other.report(9, VIEW, report({ width: 0 }), 1)
    expect(other.slotFor({ id: 7 }, 1)).not.toBeNull()
  })

  it('only the webContents that measured the slot may use it', () => {
    const tracker = createAiSlotTracker()
    tracker.report(7, VIEW, report(), 1)
    expect(tracker.slotFor({ id: 8 }, 1)).toBeNull()
    expect(tracker.slotFor(null, 1)).toBeNull()
    // a hibernated tab revives with a NEW webContents: its old id never
    // matches again, so the stale geometry cannot leak into the revival
    expect(tracker.slotFor({ id: 7 }, 1)).not.toBeNull()
  })

  it('a tab hidden is stale until it re-reports (and the re-report wins)', () => {
    const tracker = createAiSlotTracker()
    tracker.report(7, VIEW, report(), 1)
    tracker.markStale(7)
    expect(tracker.slotFor({ id: 7 }, 1)).toBeNull()
    // a stale mark for another wc touches nothing
    tracker.report(8, VIEW, report({ x: 100 }), 1)
    tracker.markStale(9)
    expect(tracker.slotFor({ id: 8 }, 1)).not.toBeNull()
    // the owner's fresh report clears its own staleness
    tracker.report(7, VIEW, report({ x: 490, width: 310 }), 1)
    expect(tracker.slotFor({ id: 7 }, 1)).toEqual({ x: 502, y: 44, width: 310, height: 556 })
  })

  it('a rect measured under another interface scale is refused', () => {
    const tracker = createAiSlotTracker()
    tracker.report(7, VIEW, report(), 1)
    expect(tracker.slotFor({ id: 7 }, 1.5)).toBeNull()
    expect(tracker.slotFor({ id: 7 }, 1)).not.toBeNull()
    // re-reported under the new scale, it serves again
    tracker.report(7, VIEW, report({ x: 400, width: 450 }), 1.5)
    expect(tracker.slotFor({ id: 7 }, 1.5)).toEqual({ x: 412, y: 44, width: 450, height: 556 })
  })
})
