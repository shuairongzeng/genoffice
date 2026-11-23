import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SPLIT_RATIO,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  buildPresetLayout,
  clampSplitRatio,
  collectLeafPanes,
  collectSessionIds,
  computePaneRects,
  countLeafPanes,
  createLeaf,
  findAdjacentPane,
  findLeafByPaneId,
  findLeafBySessionId,
  movePaneToDropTarget,
  removeLeafPane,
  removeSessionFromLayout,
  replacePaneSession,
  requiredPanesForPreset,
  splitLeafPane,
  swapPaneSessions,
  updateSplitRatio,
  type LayoutIdGenerator,
} from './terminal-layout'

function makeIdGen(): LayoutIdGenerator {
  let pane = 0
  let split = 0
  return {
    nextPaneId: () => `p-${++pane}`,
    nextSplitId: () => `s-${++split}`,
  }
}

describe('terminal-layout recursive split tree utilities', () => {
  it('clamps split ratios within safe minimum and maximum bounds', () => {
    expect(clampSplitRatio(Number.NaN)).toBe(DEFAULT_SPLIT_RATIO)
    expect(clampSplitRatio(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SPLIT_RATIO)
    expect(clampSplitRatio(0.02)).toBe(MIN_SPLIT_RATIO)
    expect(clampSplitRatio(0.99)).toBe(MAX_SPLIT_RATIO)
    expect(clampSplitRatio(0.62)).toBe(0.62)
  })

  it('splits deeply nested panes horizontally/vertically and collapses cleanly on removal', () => {
    const root = createLeaf('p1', 's1')
    const r1 = splitLeafPane(root, 'p1', createLeaf('p2', 's2'), 'sp1', 'horizontal', 'after', 0.4)
    expect(r1.inserted).toBe(true)
    expect(countLeafPanes(r1.node)).toBe(2)

    const r2 = splitLeafPane(
      r1.node,
      'p2',
      createLeaf('p3', 's3'),
      'sp2',
      'vertical',
      'before',
      0.5,
    )
    expect(r2.inserted).toBe(true)
    expect(collectSessionIds(r2.node)).toEqual(['s1', 's3', 's2'])

    const updatedRatio = updateSplitRatio(r2.node, 'sp1', 0.7)
    expect(computePaneRects(updatedRatio).find((r) => r.paneId === 'p1')?.width).toBeCloseTo(0.7, 5)

    // Remove p3 -> inner vertical split collapses back to p2
    const afterRemoveP3 = removeLeafPane(updatedRatio, 'p3')
    expect(afterRemoveP3).not.toBeNull()
    expect(collectLeafPanes(afterRemoveP3!).map((l) => l.paneId)).toEqual(['p1', 'p2'])

    // Remove session s2 -> collapses back to single p1 leaf
    const afterRemoveS2 = removeSessionFromLayout(afterRemoveP3!, 's2')
    expect(afterRemoveS2).toEqual(createLeaf('p1', 's1'))

    // Removing last remaining leaf yields null
    expect(removeLeafPane(afterRemoveS2!, 'p1')).toBeNull()
  })

  it('replaces, swaps, and rearranges panes via drop zones', () => {
    const ids = makeIdGen()
    const tree = buildPresetLayout('left-right2', ['s1', 's2', 's3'], ids)
    const leaves = collectLeafPanes(tree)
    expect(leaves).toHaveLength(3)

    const swapped = swapPaneSessions(tree, leaves[0]!.paneId, leaves[2]!.paneId)
    expect(findLeafByPaneId(swapped, leaves[0]!.paneId)?.sessionId).toBe('s3')
    expect(findLeafByPaneId(swapped, leaves[2]!.paneId)?.sessionId).toBe('s1')

    const replaced = replacePaneSession(swapped, leaves[1]!.paneId, 's99')
    expect(findLeafBySessionId(replaced, 's99')?.paneId).toBe(leaves[1]!.paneId)

    // Drag first pane to bottom edge of third pane
    const dropped = movePaneToDropTarget(
      tree,
      leaves[0]!.paneId,
      leaves[2]!.paneId,
      'bottom',
      ids.nextSplitId,
    )
    expect(dropped.changed).toBe(true)
    expect(countLeafPanes(dropped.node)).toBe(3)
    const rects = computePaneRects(dropped.node)
    const movedRect = rects.find((r) => r.paneId === leaves[0]!.paneId)!
    const targetRect = rects.find((r) => r.paneId === leaves[2]!.paneId)!
    expect(movedRect.y).toBeGreaterThan(targetRect.y)

    // Center zone swaps sessions cleanly
    const centerDrop = movePaneToDropTarget(
      tree,
      leaves[0]!.paneId,
      leaves[1]!.paneId,
      'center',
      ids.nextSplitId,
    )
    expect(centerDrop.changed).toBe(true)
    expect(findLeafByPaneId(centerDrop.node, leaves[0]!.paneId)?.sessionId).toBe('s2')
  })

  it('builds all 5 presets and resolves 4-way directional navigation accurately', () => {
    expect(requiredPanesForPreset('single')).toBe(1)
    expect(requiredPanesForPreset('split-h')).toBe(2)
    expect(requiredPanesForPreset('split-v')).toBe(2)
    expect(requiredPanesForPreset('left-right2')).toBe(3)
    expect(requiredPanesForPreset('grid-2x2')).toBe(4)

    const grid = buildPresetLayout('grid-2x2', ['a', 'b', 'c', 'd'], makeIdGen())
    const [topLeft, topRight, bottomLeft, bottomRight] = collectLeafPanes(grid)
    expect(findAdjacentPane(grid, topLeft!.paneId, 'right')).toBe(topRight!.paneId)
    expect(findAdjacentPane(grid, topLeft!.paneId, 'down')).toBe(bottomLeft!.paneId)
    expect(findAdjacentPane(grid, bottomRight!.paneId, 'left')).toBe(bottomLeft!.paneId)
    expect(findAdjacentPane(grid, bottomRight!.paneId, 'up')).toBe(topRight!.paneId)
    expect(findAdjacentPane(grid, topLeft!.paneId, 'left')).toBeNull()

    const tLayout = buildPresetLayout('left-right2', ['main', 'topR', 'botR'], makeIdGen())
    const [main, topR, botR] = collectLeafPanes(tLayout)
    expect(findAdjacentPane(tLayout, main!.paneId, 'right')).toBe(topR!.paneId)
    expect(findAdjacentPane(tLayout, topR!.paneId, 'down')).toBe(botR!.paneId)
    expect(findAdjacentPane(tLayout, botR!.paneId, 'left')).toBe(main!.paneId)
  })
})
