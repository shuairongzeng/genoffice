import type { DesktopBoxColor, DesktopGroupBox } from '../../shared/home-api'
import type { DesktopItem } from './desktop-items'

export const BOX_MIN_WIDTH = 220
export const BOX_MIN_HEIGHT = 156
export const BOX_DEFAULT_WIDTH = 320
export const BOX_DEFAULT_HEIGHT = 248
export const BOX_COLLAPSED_HEIGHT = 40
export const MAX_DESKTOP_BOXES = 24
export const DESKTOP_BOX_COLORS: readonly DesktopBoxColor[] = [
  'glass',
  'blue',
  'emerald',
  'amber',
  'rose',
  'violet',
]

export type BoxResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export interface BoxBounds {
  readonly width: number
  readonly height: number
}

export interface CreateGroupBoxOptions {
  readonly title: string
  readonly x?: number
  readonly y?: number
  readonly width?: number
  readonly height?: number
  readonly color?: DesktopBoxColor
  readonly itemIds?: readonly string[]
  readonly stageWidth: number
  readonly stageHeight: number
}

function clampNum(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function nextBoxId(existing: readonly DesktopGroupBox[]): string {
  const taken = new Set(existing.map((b) => b.id))
  const stamp = Date.now().toString(36)
  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? `box:${stamp}` : `box:${stamp}-${i}`
    if (!taken.has(candidate)) return candidate
  }
  return `box:${stamp}-${Math.random().toString(36).slice(2, 6)}`
}

export function clampBoxRect(
  rect: { x: number; y: number; width: number; height: number },
  stage: BoxBounds,
  collapsed = false,
): { x: number; y: number; width: number; height: number } {
  const sw = Math.max(stage.width || 1200, BOX_MIN_WIDTH + 24)
  const sh = Math.max(stage.height || 800, BOX_MIN_HEIGHT + 24)
  const width = Math.round(clampNum(rect.width, BOX_MIN_WIDTH, Math.max(BOX_MIN_WIDTH, sw - 24)))
  const height = Math.round(clampNum(rect.height, BOX_MIN_HEIGHT, Math.max(BOX_MIN_HEIGHT, sh - 24)))
  const effectiveH = collapsed ? BOX_COLLAPSED_HEIGHT : height
  const maxX = Math.max(12, Math.round(sw - width - 12))
  const maxY = Math.max(12, Math.round(sh - effectiveH - 12))
  return {
    x: Math.round(clampNum(rect.x, 12, maxX)),
    y: Math.round(clampNum(rect.y, 12, maxY)),
    width,
    height,
  }
}

export function computeBoxResize(
  startRect: { x: number; y: number; width: number; height: number },
  edge: BoxResizeEdge,
  dx: number,
  dy: number,
  stage: BoxBounds,
): { x: number; y: number; width: number; height: number } {
  const sw = Math.max(stage.width || 1200, BOX_MIN_WIDTH + 24)
  const sh = Math.max(stage.height || 800, BOX_MIN_HEIGHT + 24)
  const maxRight = sw - 12
  const maxBottom = sh - 12
  const startRight = startRect.x + startRect.width
  const startBottom = startRect.y + startRect.height

  let { x, y, width, height } = startRect

  if (edge.includes('e')) {
    const maxW = Math.max(BOX_MIN_WIDTH, maxRight - startRect.x)
    width = Math.round(clampNum(startRect.width + dx, BOX_MIN_WIDTH, maxW))
  } else if (edge.includes('w')) {
    const maxW = Math.max(BOX_MIN_WIDTH, startRight - 12)
    width = Math.round(clampNum(startRect.width - dx, BOX_MIN_WIDTH, maxW))
    x = Math.round(startRight - width)
  }

  if (edge.includes('s')) {
    const maxH = Math.max(BOX_MIN_HEIGHT, maxBottom - startRect.y)
    height = Math.round(clampNum(startRect.height + dy, BOX_MIN_HEIGHT, maxH))
  } else if (edge.includes('n')) {
    const maxH = Math.max(BOX_MIN_HEIGHT, startBottom - 12)
    height = Math.round(clampNum(startRect.height - dy, BOX_MIN_HEIGHT, maxH))
    y = Math.round(startBottom - height)
  }

  return { x, y, width, height }
}

/**
 * Finds a free cascading spot or clamps the requested anchor inside the stage
 * and constructs a normalized new DesktopGroupBox.
 */
export function createGroupBox(
  existing: readonly DesktopGroupBox[],
  opts: CreateGroupBoxOptions,
): DesktopGroupBox {
  const width = opts.width ?? BOX_DEFAULT_WIDTH
  const height = opts.height ?? BOX_DEFAULT_HEIGHT
  const step = existing.length
  const fallbackX = Math.max(120, Math.round((opts.stageWidth - width) / 2)) + ((step * 28) % 240) - 80
  const fallbackY = 48 + ((step * 28) % 220)
  const clamped = clampBoxRect(
    {
      x: opts.x ?? fallbackX,
      y: opts.y ?? fallbackY,
      width,
      height,
    },
    { width: opts.stageWidth, height: opts.stageHeight },
    false,
  )
  const dedupedItems: string[] = []
  if (opts.itemIds) {
    const seen = new Set<string>()
    for (const id of opts.itemIds) {
      if (id && !seen.has(id)) {
        seen.add(id)
        dedupedItems.push(id)
      }
    }
  }
  const cleanTitle = opts.title.trim() || 'Group box'
  return {
    id: nextBoxId(existing),
    title: cleanTitle,
    ...clamped,
    collapsed: false,
    color: opts.color ?? DESKTOP_BOX_COLORS[existing.length % DESKTOP_BOX_COLORS.length]!,
    itemIds: dedupedItems,
  }
}

/**
 * Assigns itemIds exclusively to `targetBoxId`, removing them from any other
 * box first so every desktop item belongs to at most one box.
 */
export function assignItemsToBox(
  boxes: readonly DesktopGroupBox[],
  targetBoxId: string,
  itemIds: readonly string[],
): DesktopGroupBox[] {
  const movingSet = new Set(itemIds.filter(Boolean))
  if (movingSet.size === 0) return [...boxes]
  const targetExists = boxes.some((b) => b.id === targetBoxId)
  if (!targetExists) return [...boxes]

  return boxes.map((box) => {
    const filtered = box.itemIds.filter((id) => !movingSet.has(id))
    if (box.id !== targetBoxId) {
      return filtered.length === box.itemIds.length ? box : { ...box, itemIds: filtered }
    }
    const appended = [...filtered]
    for (const id of itemIds) {
      if (movingSet.has(id) && !appended.includes(id)) {
        appended.push(id)
      }
    }
    return { ...box, itemIds: appended }
  })
}

export function removeItemsFromBoxes(
  boxes: readonly DesktopGroupBox[],
  itemIds: readonly string[],
): DesktopGroupBox[] {
  const dropSet = new Set(itemIds.filter(Boolean))
  if (dropSet.size === 0) return [...boxes]
  let changed = false
  const next = boxes.map((box) => {
    const filtered = box.itemIds.filter((id) => !dropSet.has(id))
    if (filtered.length === box.itemIds.length) return box
    changed = true
    return { ...box, itemIds: filtered }
  })
  return changed ? next : [...boxes]
}

export function dissolveBox(
  boxes: readonly DesktopGroupBox[],
  boxId: string,
): DesktopGroupBox[] {
  return boxes.filter((b) => b.id !== boxId)
}

export function bringBoxToFront(
  boxes: readonly DesktopGroupBox[],
  boxId: string,
): DesktopGroupBox[] {
  const idx = boxes.findIndex((b) => b.id === boxId)
  if (idx < 0 || idx === boxes.length - 1) return [...boxes]
  const picked = boxes[idx]!
  return [...boxes.slice(0, idx), ...boxes.slice(idx + 1), picked]
}

/**
 * Returns the topmost visible box under `(surfaceX, surfaceY)`, accounting for
 * collapsed header-only hit height.
 */
export function findBoxAtPoint(
  boxes: readonly DesktopGroupBox[],
  surfaceX: number,
  surfaceY: number,
): DesktopGroupBox | null {
  for (let i = boxes.length - 1; i >= 0; i--) {
    const box = boxes[i]!
    const hitH = box.collapsed ? BOX_COLLAPSED_HEIGHT : box.height
    if (
      surfaceX >= box.x &&
      surfaceX <= box.x + box.width &&
      surfaceY >= box.y &&
      surfaceY <= box.y + hitH
    ) {
      return box
    }
  }
  return null
}

/**
 * Partitions desktop items into ungrouped desktop-surface items (`looseItems`)
 * and per-box ordered lists (`boxItems`). Pinned widgets never enter boxes.
 */
export function partitionDesktopItems(
  items: readonly DesktopItem[],
  boxes: readonly DesktopGroupBox[],
): {
  looseItems: DesktopItem[]
  boxItems: Map<string, DesktopItem[]>
  ownerByItemId: Map<string, string>
} {
  const itemById = new Map<string, DesktopItem>()
  for (const item of items) {
    itemById.set(item.id, item)
  }

  const boxItems = new Map<string, DesktopItem[]>()
  const ownerByItemId = new Map<string, string>()

  for (const box of boxes) {
    const bucket: DesktopItem[] = []
    for (const itemId of box.itemIds) {
      if (ownerByItemId.has(itemId)) continue
      const item = itemById.get(itemId)
      if (!item || item.kind === 'widget') continue
      ownerByItemId.set(itemId, box.id)
      bucket.push(item)
    }
    boxItems.set(box.id, bucket)
  }

  const looseItems = items.filter((item) => !ownerByItemId.has(item.id))
  return { looseItems, boxItems, ownerByItemId }
}
