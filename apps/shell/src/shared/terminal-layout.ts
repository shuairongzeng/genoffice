import type {
  TerminalDropZone,
  TerminalLayoutNode,
  TerminalLayoutPreset,
  TerminalLeafNode,
  TerminalSplitDirection,
} from './terminal-api'

export const MIN_SPLIT_RATIO = 0.15
export const MAX_SPLIT_RATIO = 0.85
export const DEFAULT_SPLIT_RATIO = 0.5

export interface LayoutIdGenerator {
  nextPaneId(): string
  nextSplitId(): string
}

export interface PaneRect {
  paneId: string
  sessionId: string
  x: number
  y: number
  width: number
  height: number
}

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_SPLIT_RATIO
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio))
}

export function createLeaf(paneId: string, sessionId: string): TerminalLeafNode {
  return { type: 'leaf', paneId, sessionId }
}

export function collectLeafPanes(node: TerminalLayoutNode): TerminalLeafNode[] {
  if (node.type === 'leaf') return [node]
  return [...collectLeafPanes(node.first), ...collectLeafPanes(node.second)]
}

export function countLeafPanes(node: TerminalLayoutNode): number {
  if (node.type === 'leaf') return 1
  return countLeafPanes(node.first) + countLeafPanes(node.second)
}

export function collectSessionIds(node: TerminalLayoutNode): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const leaf of collectLeafPanes(node)) {
    if (!seen.has(leaf.sessionId)) {
      seen.add(leaf.sessionId)
      result.push(leaf.sessionId)
    }
  }
  return result
}

export function findLeafByPaneId(
  node: TerminalLayoutNode,
  paneId: string,
): TerminalLeafNode | null {
  if (node.type === 'leaf') {
    return node.paneId === paneId ? node : null
  }
  return findLeafByPaneId(node.first, paneId) ?? findLeafByPaneId(node.second, paneId)
}

export function findLeafBySessionId(
  node: TerminalLayoutNode,
  sessionId: string,
): TerminalLeafNode | null {
  if (node.type === 'leaf') {
    return node.sessionId === sessionId ? node : null
  }
  return findLeafBySessionId(node.first, sessionId) ?? findLeafBySessionId(node.second, sessionId)
}

export function splitLeafPane(
  node: TerminalLayoutNode,
  targetPaneId: string,
  newLeaf: TerminalLeafNode,
  splitId: string,
  direction: TerminalSplitDirection,
  position: 'before' | 'after' = 'after',
  ratio = DEFAULT_SPLIT_RATIO,
): { node: TerminalLayoutNode; inserted: boolean } {
  if (node.type === 'leaf') {
    if (node.paneId !== targetPaneId) {
      return { node, inserted: false }
    }
    const clampedRatio = clampSplitRatio(ratio)
    return {
      inserted: true,
      node: {
        type: 'split',
        splitId,
        direction,
        ratio: clampedRatio,
        first: position === 'before' ? newLeaf : node,
        second: position === 'before' ? node : newLeaf,
      },
    }
  }

  const left = splitLeafPane(node.first, targetPaneId, newLeaf, splitId, direction, position, ratio)
  if (left.inserted) {
    return { inserted: true, node: { ...node, first: left.node } }
  }

  const right = splitLeafPane(
    node.second,
    targetPaneId,
    newLeaf,
    splitId,
    direction,
    position,
    ratio,
  )
  if (right.inserted) {
    return { inserted: true, node: { ...node, second: right.node } }
  }

  return { node, inserted: false }
}

export function removeLeafPane(
  node: TerminalLayoutNode,
  targetPaneId: string,
): TerminalLayoutNode | null {
  if (node.type === 'leaf') {
    return node.paneId === targetPaneId ? null : node
  }

  const nextFirst = removeLeafPane(node.first, targetPaneId)
  if (nextFirst === null) {
    return node.second
  }
  const nextSecond = removeLeafPane(node.second, targetPaneId)
  if (nextSecond === null) {
    return nextFirst
  }
  if (nextFirst === node.first && nextSecond === node.second) {
    return node
  }
  return {
    ...node,
    first: nextFirst,
    second: nextSecond,
  }
}

export function removeSessionFromLayout(
  node: TerminalLayoutNode,
  sessionId: string,
): TerminalLayoutNode | null {
  if (node.type === 'leaf') {
    return node.sessionId === sessionId ? null : node
  }

  const nextFirst = removeSessionFromLayout(node.first, sessionId)
  const nextSecond = removeSessionFromLayout(node.second, sessionId)
  if (nextFirst === null && nextSecond === null) return null
  if (nextFirst === null) return nextSecond
  if (nextSecond === null) return nextFirst
  if (nextFirst === node.first && nextSecond === node.second) return node
  return {
    ...node,
    first: nextFirst,
    second: nextSecond,
  }
}

export function updateSplitRatio(
  node: TerminalLayoutNode,
  splitId: string,
  ratio: number,
): TerminalLayoutNode {
  if (node.type === 'leaf') return node
  if (node.splitId === splitId) {
    const nextRatio = clampSplitRatio(ratio)
    return nextRatio === node.ratio ? node : { ...node, ratio: nextRatio }
  }
  const nextFirst = updateSplitRatio(node.first, splitId, ratio)
  const nextSecond = updateSplitRatio(node.second, splitId, ratio)
  if (nextFirst === node.first && nextSecond === node.second) return node
  return { ...node, first: nextFirst, second: nextSecond }
}

export function replacePaneSession(
  node: TerminalLayoutNode,
  targetPaneId: string,
  sessionId: string,
): TerminalLayoutNode {
  if (node.type === 'leaf') {
    if (node.paneId !== targetPaneId || node.sessionId === sessionId) return node
    return { ...node, sessionId }
  }
  const nextFirst = replacePaneSession(node.first, targetPaneId, sessionId)
  const nextSecond = replacePaneSession(node.second, targetPaneId, sessionId)
  if (nextFirst === node.first && nextSecond === node.second) return node
  return { ...node, first: nextFirst, second: nextSecond }
}

export function swapPaneSessions(
  node: TerminalLayoutNode,
  paneAId: string,
  paneBId: string,
): TerminalLayoutNode {
  if (paneAId === paneBId) return node
  const leafA = findLeafByPaneId(node, paneAId)
  const leafB = findLeafByPaneId(node, paneBId)
  if (!leafA || !leafB || leafA.sessionId === leafB.sessionId) return node

  const mapNode = (cur: TerminalLayoutNode): TerminalLayoutNode => {
    if (cur.type === 'leaf') {
      if (cur.paneId === paneAId) return { ...cur, sessionId: leafB.sessionId }
      if (cur.paneId === paneBId) return { ...cur, sessionId: leafA.sessionId }
      return cur
    }
    const nextFirst = mapNode(cur.first)
    const nextSecond = mapNode(cur.second)
    if (nextFirst === cur.first && nextSecond === cur.second) return cur
    return { ...cur, first: nextFirst, second: nextSecond }
  }

  return mapNode(node)
}

export function movePaneToDropTarget(
  node: TerminalLayoutNode,
  sourcePaneId: string,
  targetPaneId: string,
  zone: TerminalDropZone,
  nextSplitId: () => string,
): { node: TerminalLayoutNode; changed: boolean } {
  if (sourcePaneId === targetPaneId) {
    return { node, changed: false }
  }
  const sourceLeaf = findLeafByPaneId(node, sourcePaneId)
  const targetLeaf = findLeafByPaneId(node, targetPaneId)
  if (!sourceLeaf || !targetLeaf) {
    return { node, changed: false }
  }

  if (zone === 'center') {
    const swapped = swapPaneSessions(node, sourcePaneId, targetPaneId)
    return { node: swapped, changed: swapped !== node }
  }

  const pruned = removeLeafPane(node, sourcePaneId)
  if (!pruned) {
    return { node, changed: false }
  }

  const direction: TerminalSplitDirection =
    zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical'
  const position: 'before' | 'after' = zone === 'left' || zone === 'top' ? 'before' : 'after'
  const splitRes = splitLeafPane(
    pruned,
    targetPaneId,
    sourceLeaf,
    nextSplitId(),
    direction,
    position,
  )
  return {
    node: splitRes.inserted ? splitRes.node : node,
    changed: splitRes.inserted,
  }
}

export function requiredPanesForPreset(preset: TerminalLayoutPreset): number {
  switch (preset) {
    case 'single':
      return 1
    case 'split-h':
    case 'split-v':
      return 2
    case 'left-right2':
      return 3
    case 'grid-2x2':
      return 4
  }
}

export function buildPresetLayout(
  preset: TerminalLayoutPreset,
  sessionIds: readonly string[],
  ids: LayoutIdGenerator,
): TerminalLayoutNode {
  const s0 = sessionIds[0]
  if (!s0) {
    throw new Error('Cannot build preset layout without at least one session id')
  }
  const leaf0 = createLeaf(ids.nextPaneId(), s0)
  if (preset === 'single' || sessionIds.length < 2) {
    return leaf0
  }

  const leaf1 = createLeaf(ids.nextPaneId(), sessionIds[1]!)
  if (preset === 'split-h') {
    return {
      type: 'split',
      splitId: ids.nextSplitId(),
      direction: 'horizontal',
      ratio: DEFAULT_SPLIT_RATIO,
      first: leaf0,
      second: leaf1,
    }
  }
  if (preset === 'split-v') {
    return {
      type: 'split',
      splitId: ids.nextSplitId(),
      direction: 'vertical',
      ratio: DEFAULT_SPLIT_RATIO,
      first: leaf0,
      second: leaf1,
    }
  }
  if (preset === 'left-right2') {
    const leaf2 = createLeaf(ids.nextPaneId(), sessionIds[2] ?? sessionIds[1]!)
    return {
      type: 'split',
      splitId: ids.nextSplitId(),
      direction: 'horizontal',
      ratio: DEFAULT_SPLIT_RATIO,
      first: leaf0,
      second: {
        type: 'split',
        splitId: ids.nextSplitId(),
        direction: 'vertical',
        ratio: DEFAULT_SPLIT_RATIO,
        first: leaf1,
        second: leaf2,
      },
    }
  }

  const leaf2 = createLeaf(ids.nextPaneId(), sessionIds[2] ?? sessionIds[0]!)
  const leaf3 = createLeaf(ids.nextPaneId(), sessionIds[3] ?? sessionIds[1]!)
  return {
    type: 'split',
    splitId: ids.nextSplitId(),
    direction: 'vertical',
    ratio: DEFAULT_SPLIT_RATIO,
    first: {
      type: 'split',
      splitId: ids.nextSplitId(),
      direction: 'horizontal',
      ratio: DEFAULT_SPLIT_RATIO,
      first: leaf0,
      second: leaf1,
    },
    second: {
      type: 'split',
      splitId: ids.nextSplitId(),
      direction: 'horizontal',
      ratio: DEFAULT_SPLIT_RATIO,
      first: leaf2,
      second: leaf3,
    },
  }
}

export function computePaneRects(
  node: TerminalLayoutNode,
  bounds: { x: number; y: number; width: number; height: number } = {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  },
): PaneRect[] {
  if (node.type === 'leaf') {
    return [
      {
        paneId: node.paneId,
        sessionId: node.sessionId,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      },
    ]
  }

  const ratio = clampSplitRatio(node.ratio)
  if (node.direction === 'horizontal') {
    const leftW = bounds.width * ratio
    const rightW = bounds.width - leftW
    return [
      ...computePaneRects(node.first, {
        x: bounds.x,
        y: bounds.y,
        width: leftW,
        height: bounds.height,
      }),
      ...computePaneRects(node.second, {
        x: bounds.x + leftW,
        y: bounds.y,
        width: rightW,
        height: bounds.height,
      }),
    ]
  }

  const topH = bounds.height * ratio
  const bottomH = bounds.height - topH
  return [
    ...computePaneRects(node.first, {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: topH,
    }),
    ...computePaneRects(node.second, {
      x: bounds.x,
      y: bounds.y + topH,
      width: bounds.width,
      height: bottomH,
    }),
  ]
}

export function findAdjacentPane(
  node: TerminalLayoutNode,
  fromPaneId: string,
  direction: 'up' | 'down' | 'left' | 'right',
): string | null {
  const rects = computePaneRects(node)
  const origin = rects.find((r) => r.paneId === fromPaneId)
  if (!origin || rects.length <= 1) return null

  const ox = origin.x + origin.width / 2
  const oy = origin.y + origin.height / 2
  const EPS = 1e-4

  let bestPaneId: string | null = null
  let bestScore = Number.POSITIVE_INFINITY

  for (const candidate of rects) {
    if (candidate.paneId === fromPaneId) continue
    const cx = candidate.x + candidate.width / 2
    const cy = candidate.y + candidate.height / 2

    let primaryDelta = 0
    let perpOverlap = false
    let perpDelta = 0

    if (direction === 'left') {
      if (cx >= ox - EPS) continue
      primaryDelta = ox - cx
      perpOverlap =
        Math.min(origin.y + origin.height, candidate.y + candidate.height) -
          Math.max(origin.y, candidate.y) >
        EPS
      perpDelta = Math.abs(oy - cy)
    } else if (direction === 'right') {
      if (cx <= ox + EPS) continue
      primaryDelta = cx - ox
      perpOverlap =
        Math.min(origin.y + origin.height, candidate.y + candidate.height) -
          Math.max(origin.y, candidate.y) >
        EPS
      perpDelta = Math.abs(oy - cy)
    } else if (direction === 'up') {
      if (cy >= oy - EPS) continue
      primaryDelta = oy - cy
      perpOverlap =
        Math.min(origin.x + origin.width, candidate.x + candidate.width) -
          Math.max(origin.x, candidate.x) >
        EPS
      perpDelta = Math.abs(ox - cx)
    } else {
      if (cy <= oy + EPS) continue
      primaryDelta = cy - oy
      perpOverlap =
        Math.min(origin.x + origin.width, candidate.x + candidate.width) -
          Math.max(origin.x, candidate.x) >
        EPS
      perpDelta = Math.abs(ox - cx)
    }

    // Strongly prefer candidates sharing an edge band along the perpendicular axis.
    const score = (perpOverlap ? 0 : 10) + primaryDelta + perpDelta * 0.25
    if (score < bestScore) {
      bestScore = score
      bestPaneId = candidate.paneId
    }
  }

  return bestPaneId
}
