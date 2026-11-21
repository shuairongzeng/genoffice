export type DesktopWindowMode = 'normal' | 'minimized' | 'maximized' | 'mini'
export type DesktopWindowSnap = 'none' | 'left' | 'right' | 'top'
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export interface WindowRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface StageBounds {
  readonly width: number
  readonly height: number
  readonly topInset?: number
  readonly bottomInset?: number
  readonly leftInset?: number
  readonly rightInset?: number
}

export interface PersistedWindowState {
  readonly rect: WindowRect
  readonly mode: DesktopWindowMode
  readonly snap: DesktopWindowSnap
}

export const DEFAULT_MIN_WINDOW_WIDTH = 440
export const DEFAULT_MIN_WINDOW_HEIGHT = 340
export const STAGE_TOP_INSET = 52
export const STAGE_BOTTOM_INSET = 92
export const STAGE_SIDE_INSET = 12
const MIN_VISIBLE_HEADER_PX = 140
const SNAP_SIDE_THRESHOLD_PX = 18
const SNAP_TOP_THRESHOLD_PX = 14
const SNAP_GAP_PX = 8

interface WorkArea {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

function workAreaOf(stage: StageBounds): WorkArea {
  const sw = Math.max(stage.width || 1200, 320)
  const sh = Math.max(stage.height || 800, 280)
  const left = Math.max(0, stage.leftInset ?? STAGE_SIDE_INSET)
  const top = Math.max(0, stage.topInset ?? STAGE_TOP_INSET)
  const rightPad = Math.max(0, stage.rightInset ?? STAGE_SIDE_INSET)
  const bottomPad = Math.max(0, stage.bottomInset ?? STAGE_BOTTOM_INSET)
  const right = Math.max(left + 260, sw - rightPad)
  const bottom = Math.max(top + 220, sh - bottomPad)
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  }
}

function clampNum(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/** Compute the default desktop window placement, avoiding left-side desktop icons when room permits. */
export function defaultWindowRect(
  stage: StageBounds,
  preferred: { width?: number; height?: number } = {},
): WindowRect {
  const area = workAreaOf(stage)
  const minW = Math.min(DEFAULT_MIN_WINDOW_WIDTH, area.width)
  const minH = Math.min(DEFAULT_MIN_WINDOW_HEIGHT, area.height)
  const width = Math.round(clampNum(preferred.width ?? 880, minW, area.width))
  const height = Math.round(clampNum(preferred.height ?? 560, minH, area.height))
  const centeredX = area.left + Math.round((area.width - width) / 2)
  const iconClearanceX = area.left + (area.width >= width + 220 ? 200 : 0)
  const x = Math.round(
    clampNum(Math.max(centeredX, iconClearanceX), area.left, area.right - width),
  )
  const y = Math.round(
    clampNum(area.top + Math.round((area.height - height) / 2), area.top, area.bottom - height),
  )
  return { x, y, width, height }
}

/** Return the full work area rect for maximized or top-snapped windows. */
export function maximizedWindowRect(stage: StageBounds): WindowRect {
  const area = workAreaOf(stage)
  return {
    x: Math.round(area.left),
    y: Math.round(area.top),
    width: Math.round(area.width),
    height: Math.round(area.height),
  }
}

/** Clamp a window rect so dimensions respect minimums and the titlebar always stays reachable. */
export function clampWindowRect(
  rect: WindowRect,
  stage: StageBounds,
  minSize: { width?: number; height?: number } = {},
): WindowRect {
  const area = workAreaOf(stage)
  const minW = Math.min(minSize.width ?? DEFAULT_MIN_WINDOW_WIDTH, area.width)
  const minH = Math.min(minSize.height ?? DEFAULT_MIN_WINDOW_HEIGHT, area.height)
  const width = Math.round(clampNum(rect.width, minW, area.width))
  const height = Math.round(clampNum(rect.height, minH, area.height))
  const minX = area.left - Math.max(0, width - MIN_VISIBLE_HEADER_PX)
  const maxX = area.right - Math.min(width, MIN_VISIBLE_HEADER_PX)
  const x = Math.round(clampNum(rect.x, minX, maxX))
  const maxY = Math.max(area.top, area.bottom - 48)
  const y = Math.round(clampNum(rect.y, area.top, maxY))
  return { x, y, width, height }
}

/** Compute next rect during 8-edge resize while keeping the anchored opposite edges stationary. */
export function computeResizeRect(
  startRect: WindowRect,
  edge: ResizeEdge,
  dx: number,
  dy: number,
  stage: StageBounds,
  minSize: { width?: number; height?: number } = {},
): WindowRect {
  const area = workAreaOf(stage)
  const minW = Math.min(minSize.width ?? DEFAULT_MIN_WINDOW_WIDTH, area.width)
  const minH = Math.min(minSize.height ?? DEFAULT_MIN_WINDOW_HEIGHT, area.height)

  let { x, y, width, height } = startRect
  const startRight = startRect.x + startRect.width
  const startBottom = startRect.y + startRect.height

  if (edge.includes('e')) {
    const maxW = Math.max(minW, area.right - startRect.x)
    width = Math.round(clampNum(startRect.width + dx, minW, maxW))
  } else if (edge.includes('w')) {
    const maxW = Math.max(minW, startRight - area.left)
    width = Math.round(clampNum(startRect.width - dx, minW, maxW))
    x = Math.round(startRight - width)
  }

  if (edge.includes('s')) {
    const maxH = Math.max(minH, area.bottom - startRect.y)
    height = Math.round(clampNum(startRect.height + dy, minH, maxH))
  } else if (edge.includes('n')) {
    const maxH = Math.max(minH, startBottom - area.top)
    height = Math.round(clampNum(startRect.height - dy, minH, maxH))
    y = Math.round(startBottom - height)
  }

  return { x, y, width, height }
}

/** Detect edge snap zone from stage-relative pointer coordinates during titlebar drag. */
export function detectSnapZone(
  pointerX: number,
  pointerY: number,
  stage: StageBounds,
): DesktopWindowSnap {
  const area = workAreaOf(stage)
  if (pointerX <= area.left + SNAP_SIDE_THRESHOLD_PX) return 'left'
  if (pointerX >= area.right - SNAP_SIDE_THRESHOLD_PX) return 'right'
  if (pointerY <= area.top + SNAP_TOP_THRESHOLD_PX) return 'top'
  return 'none'
}

/** Return the target preview/applied rect for a snap zone, or null for 'none'. */
export function snapPreviewRect(zone: DesktopWindowSnap, stage: StageBounds): WindowRect | null {
  if (zone === 'none') return null
  if (zone === 'top') return maximizedWindowRect(stage)
  const area = workAreaOf(stage)
  const halfW = Math.max(DEFAULT_MIN_WINDOW_WIDTH, Math.floor((area.width - SNAP_GAP_PX) / 2))
  if (zone === 'left') {
    return {
      x: Math.round(area.left),
      y: Math.round(area.top),
      width: Math.min(halfW, Math.round(area.width)),
      height: Math.round(area.height),
    }
  }
  const rightW = Math.min(halfW, Math.round(area.width))
  return {
    x: Math.round(area.right - rightW),
    y: Math.round(area.top),
    width: rightW,
    height: Math.round(area.height),
  }
}

export function readWindowPrefs(storageKey: string): Partial<PersistedWindowState> | null {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PersistedWindowState> | null
    if (!parsed || typeof parsed !== 'object') return null
    const out: {
      rect?: WindowRect
      mode?: DesktopWindowMode
      snap?: DesktopWindowSnap
    } = {}
    if (
      parsed.rect &&
      typeof parsed.rect === 'object' &&
      typeof parsed.rect.x === 'number' &&
      typeof parsed.rect.y === 'number' &&
      typeof parsed.rect.width === 'number' &&
      typeof parsed.rect.height === 'number' &&
      Number.isFinite(parsed.rect.x) &&
      Number.isFinite(parsed.rect.y) &&
      Number.isFinite(parsed.rect.width) &&
      Number.isFinite(parsed.rect.height)
    ) {
      out.rect = parsed.rect
    }
    if (
      parsed.mode === 'normal' ||
      parsed.mode === 'minimized' ||
      parsed.mode === 'maximized' ||
      parsed.mode === 'mini'
    ) {
      out.mode = parsed.mode
    }
    if (
      parsed.snap === 'none' ||
      parsed.snap === 'left' ||
      parsed.snap === 'right' ||
      parsed.snap === 'top'
    ) {
      out.snap = parsed.snap
    }
    return out
  } catch {
    return null
  }
}

export function writeWindowPrefs(storageKey: string, state: PersistedWindowState): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state))
  } catch {
    // Ignore storage quota errors in sandboxed/private hosts.
  }
}
