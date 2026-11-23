import { describe, expect, it } from 'vitest'

import {
  SPLIT_DEFAULT_RATIO,
  SPLIT_DIVIDER_WIDTH,
  SPLIT_MAX_RATIO,
  SPLIT_MIN_PANE_WIDTH,
  SPLIT_MIN_RATIO,
  type SplitState,
} from '../shared/split-api'
import type { TabKind } from '../shared/tabs-api'
import {
  clampSplitRatio,
  computeSplitRects,
  isSplitEligibleKind,
  pickSplitPair,
  type SplitCandidateTab,
} from './split-geometry'

describe('isSplitEligibleKind', () => {
  it('excludes only home and accepts all other tab kinds', () => {
    expect(isSplitEligibleKind('home')).toBe(false)
    const eligible: TabKind[] = [
      'docs',
      'sheets',
      'slides',
      'pdf',
      'markdown',
      'html',
      'media',
      'browser',
      'help',
      'compare',
    ]
    for (const kind of eligible) {
      expect(isSplitEligibleKind(kind)).toBe(true)
    }
  })
})

describe('clampSplitRatio', () => {
  it('falls back to SPLIT_DEFAULT_RATIO for non-finite values', () => {
    expect(clampSplitRatio(Number.NaN)).toBe(SPLIT_DEFAULT_RATIO)
    expect(clampSplitRatio(Number.POSITIVE_INFINITY)).toBe(SPLIT_DEFAULT_RATIO)
    expect(clampSplitRatio(Number.NEGATIVE_INFINITY)).toBe(SPLIT_DEFAULT_RATIO)
  })

  it('clamps to [SPLIT_MIN_RATIO, SPLIT_MAX_RATIO] without totalWidth', () => {
    expect(clampSplitRatio(0)).toBe(SPLIT_MIN_RATIO)
    expect(clampSplitRatio(0.1)).toBe(SPLIT_MIN_RATIO)
    expect(clampSplitRatio(0.42)).toBe(0.42)
    expect(clampSplitRatio(0.9)).toBe(SPLIT_MAX_RATIO)
    expect(clampSplitRatio(1)).toBe(SPLIT_MAX_RATIO)
  })

  it('returns 0.5 when viewport cannot fit two minimum panes plus divider', () => {
    const minTotal = 2 * SPLIT_MIN_PANE_WIDTH + SPLIT_DIVIDER_WIDTH
    expect(clampSplitRatio(0.25, minTotal - 1)).toBe(0.5)
    expect(clampSplitRatio(0.75, 400)).toBe(0.5)
    expect(clampSplitRatio(0.3, minTotal)).toBe(0.5)
    expect(clampSplitRatio(0.7, minTotal)).toBe(0.5)
  })

  it('guarantees at least SPLIT_MIN_PANE_WIDTH pixels on both panes for tight widths', () => {
    const totalWidth = 700
    const available = totalWidth - SPLIT_DIVIDER_WIDTH
    const minClamped = clampSplitRatio(0.25, totalWidth)
    const maxClamped = clampSplitRatio(0.75, totalWidth)
    expect(Math.round(available * minClamped)).toBeGreaterThanOrEqual(SPLIT_MIN_PANE_WIDTH)
    expect(available - Math.round(available * maxClamped)).toBeGreaterThanOrEqual(
      SPLIT_MIN_PANE_WIDTH,
    )
    expect(minClamped).toBeGreaterThan(SPLIT_MIN_RATIO)
    expect(maxClamped).toBeLessThan(SPLIT_MAX_RATIO)
  })

  it('preserves static ratio bounds when viewport is wide enough', () => {
    expect(clampSplitRatio(0.1, 1600)).toBe(SPLIT_MIN_RATIO)
    expect(clampSplitRatio(0.9, 1600)).toBe(SPLIT_MAX_RATIO)
    expect(clampSplitRatio(0.6, 1600)).toBe(0.6)
  })
})

describe('computeSplitRects', () => {
  it('partitions wide bounds into contiguous, non-overlapping rects', () => {
    const bounds = { x: 208, y: 44, width: 1008, height: 700 }
    for (const ratio of [0.25, 0.333, 0.5, 0.667, 0.75]) {
      const rects = computeSplitRects(bounds, ratio)
      expect(rects.left.x).toBe(bounds.x)
      expect(rects.left.y).toBe(bounds.y)
      expect(rects.left.height).toBe(bounds.height)
      expect(rects.divider.x).toBe(rects.left.x + rects.left.width)
      expect(rects.divider.y).toBe(bounds.y)
      expect(rects.divider.width).toBe(SPLIT_DIVIDER_WIDTH)
      expect(rects.divider.height).toBe(bounds.height)
      expect(rects.right.x).toBe(rects.divider.x + rects.divider.width)
      expect(rects.right.y).toBe(bounds.y)
      expect(rects.right.height).toBe(bounds.height)
      expect(rects.left.width + rects.divider.width + rects.right.width).toBe(bounds.width)
      expect(rects.left.width).toBeGreaterThanOrEqual(SPLIT_MIN_PANE_WIDTH)
      expect(rects.right.width).toBeGreaterThanOrEqual(SPLIT_MIN_PANE_WIDTH)
    }
  })

  it('enforces 0.5 effective ratio on narrow windows without gaps or overlaps', () => {
    const bounds = { x: 0, y: 44, width: 450, height: 600 }
    const rects = computeSplitRects(bounds, 0.25)
    expect(rects.effectiveRatio).toBe(0.5)
    expect(rects.left.width + rects.divider.width + rects.right.width).toBe(450)
    expect(rects.divider.x).toBe(rects.left.x + rects.left.width)
    expect(rects.right.x).toBe(rects.divider.x + rects.divider.width)
  })

  it('handles tiny and degenerate widths safely', () => {
    for (const width of [0, 1, 2, 5, 10]) {
      const rects = computeSplitRects({ x: 10, y: 20, width, height: 100 }, 0.3)
      expect(rects.left.width).toBeGreaterThanOrEqual(0)
      expect(rects.divider.width).toBeGreaterThanOrEqual(0)
      expect(rects.right.width).toBeGreaterThanOrEqual(0)
      expect(rects.divider.x).toBe(rects.left.x + rects.left.width)
      expect(rects.right.x).toBe(rects.divider.x + rects.divider.width)
      expect(rects.left.width + rects.divider.width + rects.right.width).toBe(width)
    }
  })
})

describe('pickSplitPair', () => {
  const makeTabs = (): SplitCandidateTab[] => [
    { id: 'home', kind: 'home', lastActiveAt: 1000 },
    { id: 't1', kind: 'docs', lastActiveAt: 100 },
    { id: 't2', kind: 'sheets', lastActiveAt: 300 },
    { id: 't3', kind: 'pdf', lastActiveAt: 200 },
  ]

  it('returns null when fewer than two split-eligible tabs exist', () => {
    expect(pickSplitPair([{ id: 'home', kind: 'home' }], 'home', null)).toBeNull()
    expect(
      pickSplitPair(
        [
          { id: 'home', kind: 'home' },
          { id: 't1', kind: 'docs' },
        ],
        't1',
        null,
      ),
    ).toBeNull()
  })

  it('pairs the active tab with the most recently active other eligible tab', () => {
    const pair = pickSplitPair(makeTabs(), 't1', null)
    expect(pair).toEqual({ leftTabId: 't1', rightTabId: 't2', activePane: 'left' })
  })

  it('falls back to MRU anchor when activeId is home', () => {
    const pair = pickSplitPair(makeTabs(), 'home', null)
    expect(pair).toEqual({ leftTabId: 't2', rightTabId: 't3', activePane: 'left' })
  })

  it('pairs with an adjacent neighbor when lastActiveAt timestamps are absent', () => {
    const tabs: SplitCandidateTab[] = [
      { id: 'home', kind: 'home' },
      { id: 't1', kind: 'docs' },
      { id: 't2', kind: 'sheets' },
      { id: 't3', kind: 'pdf' },
    ]
    const pair = pickSplitPair(tabs, 't1', null)
    expect(pair).toEqual({ leftTabId: 't1', rightTabId: 't2', activePane: 'left' })
    const fromEnd = pickSplitPair(tabs, 't3', null)
    expect(fromEnd).toEqual({ leftTabId: 't3', rightTabId: 't2', activePane: 'left' })
  })

  it('places explicit targetTabId according to preferredSide (default right)', () => {
    expect(pickSplitPair(makeTabs(), 't1', null, 't3')).toEqual({
      leftTabId: 't1',
      rightTabId: 't3',
      activePane: 'right',
    })
    expect(pickSplitPair(makeTabs(), 't1', null, 't3', 'left')).toEqual({
      leftTabId: 't3',
      rightTabId: 't1',
      activePane: 'left',
    })
  })

  it('pairs by MRU when targetTabId equals the anchor tab', () => {
    expect(pickSplitPair(makeTabs(), 't1', null, 't1')).toEqual({
      leftTabId: 't1',
      rightTabId: 't2',
      activePane: 'left',
    })
    expect(pickSplitPair(makeTabs(), 't1', null, 't1', 'right')).toEqual({
      leftTabId: 't2',
      rightTabId: 't1',
      activePane: 'right',
    })
  })

  it('ignores an ineligible targetTabId such as home', () => {
    expect(pickSplitPair(makeTabs(), 't1', null, 'home')).toEqual({
      leftTabId: 't1',
      rightTabId: 't2',
      activePane: 'left',
    })
  })

  it('keeps existing split pairing and updates activePane when target hits an open side', () => {
    const current: SplitState = {
      leftTabId: 't1',
      rightTabId: 't2',
      activePane: 'left',
      ratio: 0.5,
      syncScroll: false,
      suspended: false,
    }
    expect(pickSplitPair(makeTabs(), 't1', current)).toEqual({
      leftTabId: 't1',
      rightTabId: 't2',
      activePane: 'left',
    })
    expect(pickSplitPair(makeTabs(), 't1', current, 't2')).toEqual({
      leftTabId: 't1',
      rightTabId: 't2',
      activePane: 'right',
    })
    expect(pickSplitPair(makeTabs(), 't2', { ...current, activePane: 'right' }, 't1')).toEqual({
      leftTabId: 't1',
      rightTabId: 't2',
      activePane: 'left',
    })
  })

  it('replaces preferredSide or activePane when a new targetTabId is opened into split', () => {
    const current: SplitState = {
      leftTabId: 't1',
      rightTabId: 't2',
      activePane: 'left',
      ratio: 0.5,
      syncScroll: false,
      suspended: false,
    }
    expect(pickSplitPair(makeTabs(), 't1', current, 't3')).toEqual({
      leftTabId: 't3',
      rightTabId: 't2',
      activePane: 'left',
    })
    expect(pickSplitPair(makeTabs(), 't1', current, 't3', 'right')).toEqual({
      leftTabId: 't1',
      rightTabId: 't3',
      activePane: 'right',
    })
  })

  it('re-pairs cleanly when an existing split member was closed or became invalid', () => {
    const stale: SplitState = {
      leftTabId: 't1',
      rightTabId: 'closed-tab',
      activePane: 'right',
      ratio: 0.4,
      syncScroll: true,
      suspended: false,
    }
    expect(pickSplitPair(makeTabs(), 't3', stale)).toEqual({
      leftTabId: 't3',
      rightTabId: 't2',
      activePane: 'left',
    })
  })
})
