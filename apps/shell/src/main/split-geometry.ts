import type { Rectangle } from 'electron'

import {
  SPLIT_DEFAULT_RATIO,
  SPLIT_DIVIDER_WIDTH,
  SPLIT_MAX_RATIO,
  SPLIT_MIN_PANE_WIDTH,
  SPLIT_MIN_RATIO,
  type SplitPaneSide,
  type SplitState,
} from '../shared/split-api'
import type { TabKind } from '../shared/tabs-api'

export interface SplitCandidateTab {
  id: string
  kind: TabKind
  lastActiveAt?: number
}

export interface SplitRects {
  left: Rectangle
  divider: Rectangle
  right: Rectangle
  effectiveRatio: number
}

export interface SplitPair {
  leftTabId: string
  rightTabId: string
  activePane: SplitPaneSide
}

/** Return true when a tab kind can participate in side-by-side split view. */
export function isSplitEligibleKind(kind: TabKind): boolean {
  return kind !== 'home'
}

/**
 * Clamp a split ratio to [SPLIT_MIN_RATIO, SPLIT_MAX_RATIO], and when a
 * positive totalWidth is provided ensure both panes stay at least
 * SPLIT_MIN_PANE_WIDTH wide (falling back to 0.5 when the viewport is too
 * narrow to satisfy both minimums).
 */
export function clampSplitRatio(ratio: number, totalWidth?: number): number {
  let clamped = Number.isFinite(ratio) ? ratio : SPLIT_DEFAULT_RATIO
  clamped = Math.min(SPLIT_MAX_RATIO, Math.max(SPLIT_MIN_RATIO, clamped))
  if (totalWidth !== undefined && Number.isFinite(totalWidth) && totalWidth > 0) {
    const minTotal = 2 * SPLIT_MIN_PANE_WIDTH + SPLIT_DIVIDER_WIDTH
    if (totalWidth < minTotal) return SPLIT_DEFAULT_RATIO
    const available = totalWidth - SPLIT_DIVIDER_WIDTH
    const minByWidth = SPLIT_MIN_PANE_WIDTH / available
    const maxByWidth = (available - SPLIT_MIN_PANE_WIDTH) / available
    const minAllowed = Math.max(SPLIT_MIN_RATIO, minByWidth)
    const maxAllowed = Math.min(SPLIT_MAX_RATIO, maxByWidth)
    if (minAllowed > maxAllowed) return SPLIT_DEFAULT_RATIO
    clamped = Math.min(maxAllowed, Math.max(minAllowed, clamped))
  }
  return clamped
}

/**
 * Compute pixel-exact, non-overlapping left, divider, and right bounds inside
 * the given container rectangle.
 */
export function computeSplitRects(bounds: Rectangle, ratio: number): SplitRects {
  const dividerWidth = Math.min(SPLIT_DIVIDER_WIDTH, Math.max(0, bounds.width - 2))
  const available = Math.max(0, bounds.width - dividerWidth)
  const effectiveRatio = clampSplitRatio(ratio, bounds.width)
  const leftWidth = Math.max(0, Math.round(available * effectiveRatio))
  const rightWidth = Math.max(0, available - leftWidth)
  return {
    left: { x: bounds.x, y: bounds.y, width: leftWidth, height: bounds.height },
    divider: { x: bounds.x + leftWidth, y: bounds.y, width: dividerWidth, height: bounds.height },
    right: {
      x: bounds.x + leftWidth + dividerWidth,
      y: bounds.y,
      width: rightWidth,
      height: bounds.height,
    },
    effectiveRatio,
  }
}

function sortByMruOrNeighbor(
  candidates: readonly SplitCandidateTab[],
  anchorIndex?: number,
  eligibleOrder?: ReadonlyMap<string, number>,
): SplitCandidateTab[] {
  return [...candidates].sort((a, b) => {
    const aTime = typeof a.lastActiveAt === 'number' ? a.lastActiveAt : -Infinity
    const bTime = typeof b.lastActiveAt === 'number' ? b.lastActiveAt : -Infinity
    if (aTime !== bTime) return bTime - aTime
    if (anchorIndex !== undefined && eligibleOrder) {
      const aIdx = eligibleOrder.get(a.id) ?? 0
      const bIdx = eligibleOrder.get(b.id) ?? 0
      const aDist = Math.abs(aIdx - anchorIndex)
      const bDist = Math.abs(bIdx - anchorIndex)
      if (aDist !== bDist) return aDist - bDist
      return bIdx - aIdx
    }
    return 0
  })
}

/**
 * Choose or update the left/right tab pairing for split view. Returns null when
 * fewer than two split-eligible tabs exist.
 */
export function pickSplitPair(
  tabs: readonly SplitCandidateTab[],
  activeId: string,
  currentSplit: SplitState | null,
  targetTabId?: string,
  preferredSide?: SplitPaneSide,
): SplitPair | null {
  const eligible = tabs.filter((t) => isSplitEligibleKind(t.kind))
  if (eligible.length < 2) return null

  const eligibleIndex = new Map<string, number>()
  eligible.forEach((t, idx) => eligibleIndex.set(t.id, idx))

  const validTarget =
    targetTabId !== undefined && eligibleIndex.has(targetTabId) ? targetTabId : undefined

  const hasValidCurrentSplit =
    currentSplit !== null &&
    eligibleIndex.has(currentSplit.leftTabId) &&
    eligibleIndex.has(currentSplit.rightTabId) &&
    currentSplit.leftTabId !== currentSplit.rightTabId

  if (hasValidCurrentSplit && currentSplit !== null) {
    if (!validTarget) {
      return {
        leftTabId: currentSplit.leftTabId,
        rightTabId: currentSplit.rightTabId,
        activePane: currentSplit.activePane,
      }
    }
    if (validTarget === currentSplit.leftTabId) {
      return {
        leftTabId: currentSplit.leftTabId,
        rightTabId: currentSplit.rightTabId,
        activePane: 'left',
      }
    }
    if (validTarget === currentSplit.rightTabId) {
      return {
        leftTabId: currentSplit.leftTabId,
        rightTabId: currentSplit.rightTabId,
        activePane: 'right',
      }
    }
    const replaceSide = preferredSide ?? currentSplit.activePane
    if (replaceSide === 'left') {
      return {
        leftTabId: validTarget,
        rightTabId: currentSplit.rightTabId,
        activePane: 'left',
      }
    }
    return {
      leftTabId: currentSplit.leftTabId,
      rightTabId: validTarget,
      activePane: 'right',
    }
  }

  const anchorId = eligibleIndex.has(activeId) ? activeId : sortByMruOrNeighbor(eligible)[0]!.id
  const anchorIdx = eligibleIndex.get(anchorId)!
  const otherId = sortByMruOrNeighbor(
    eligible.filter((t) => t.id !== anchorId),
    anchorIdx,
    eligibleIndex,
  )[0]!.id

  if (validTarget !== undefined) {
    if (validTarget !== anchorId) {
      const targetSide = preferredSide ?? 'right'
      return targetSide === 'left'
        ? { leftTabId: validTarget, rightTabId: anchorId, activePane: 'left' }
        : { leftTabId: anchorId, rightTabId: validTarget, activePane: 'right' }
    }
    if (preferredSide === 'right') {
      return { leftTabId: otherId, rightTabId: anchorId, activePane: 'right' }
    }
    return { leftTabId: anchorId, rightTabId: otherId, activePane: 'left' }
  }

  if (preferredSide === 'right') {
    return { leftTabId: otherId, rightTabId: anchorId, activePane: 'right' }
  }
  return { leftTabId: anchorId, rightTabId: otherId, activePane: 'left' }
}
