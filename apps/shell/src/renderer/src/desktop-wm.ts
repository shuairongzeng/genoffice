import {
  clampWindowRect,
  defaultWindowRect,
  type DesktopWindowMode,
  type DesktopWindowSnap,
  type StageBounds,
  type WindowRect,
} from './desktop-window-geometry'

export const WINDOW_CASCADE_OFFSET_PX = 28

const MAX_CASCADE_STEPS = 16
const CASCADE_OVERLAP_TOLERANCE_PX = 4

export type DesktopAppWindowKind =
  | 'computer'
  | 'preview'
  | 'player'
  | 'kb'
  | 'sessions'
  | 'folder'

export interface DesktopWindowInstance {
  readonly id: string
  readonly kind: DesktopAppWindowKind
  readonly title: string
  readonly rect: WindowRect
  readonly mode: DesktopWindowMode
  readonly snap: DesktopWindowSnap
  readonly payload?: Record<string, unknown>
  readonly reuseKey?: string
}

export interface OpenDesktopWindowPayload {
  readonly id?: string
  readonly kind: DesktopAppWindowKind
  readonly title: string
  readonly stage: StageBounds
  readonly preferredSize?: { readonly width: number; readonly height: number }
  readonly minSize?: { readonly width?: number; readonly height?: number }
  readonly initialRect?: WindowRect
  readonly singleton?: boolean
  readonly reuseKey?: string
  readonly payload?: Record<string, unknown>
}

export interface DesktopWmState {
  readonly windows: Readonly<Record<string, DesktopWindowInstance>>
  readonly order: readonly string[]
  readonly activeId: string | null
}

export const INITIAL_DESKTOP_WM_STATE: DesktopWmState = {
  windows: {},
  order: [],
  activeId: null,
}

export type DesktopWmAction =
  | { readonly type: 'open'; readonly spec: OpenDesktopWindowPayload }
  | { readonly type: 'focus'; readonly id: string }
  | { readonly type: 'blur-all' }
  | { readonly type: 'close'; readonly id: string }
  | {
      readonly type: 'set-mode'
      readonly id: string
      readonly mode: DesktopWindowMode
      readonly snap?: DesktopWindowSnap
    }
  | {
      readonly type: 'set-rect'
      readonly id: string
      readonly rect: WindowRect
      readonly snap?: DesktopWindowSnap
    }
  | {
      readonly type: 'update'
      readonly id: string
      readonly title?: string
      readonly payload?: Record<string, unknown>
    }
  | { readonly type: 'cycle'; readonly reverse?: boolean }

function hasOwnWindow(
  windows: Readonly<Record<string, DesktopWindowInstance>>,
  id: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(windows, id)
}

function topVisibleWindowId(
  windows: Readonly<Record<string, DesktopWindowInstance>>,
  order: readonly string[],
): string | null {
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const id = order[i]
    const win = hasOwnWindow(windows, id) ? windows[id] : undefined
    if (win && win.mode !== 'minimized') {
      return id
    }
  }
  return null
}

function bringToFront(order: readonly string[], id: string): string[] {
  const filtered = order.filter((item) => item !== id)
  filtered.push(id)
  return filtered
}

function findReusableWindow(
  state: DesktopWmState,
  spec: OpenDesktopWindowPayload,
): DesktopWindowInstance | undefined {
  if (spec.reuseKey !== undefined) {
    for (let i = state.order.length - 1; i >= 0; i -= 1) {
      const id = state.order[i]
      const win = hasOwnWindow(state.windows, id) ? state.windows[id] : undefined
      if (win && win.reuseKey === spec.reuseKey) return win
    }
    for (const win of Object.values(state.windows)) {
      if (win.reuseKey === spec.reuseKey) return win
    }
  }

  if (spec.singleton) {
    for (let i = state.order.length - 1; i >= 0; i -= 1) {
      const id = state.order[i]
      const win = hasOwnWindow(state.windows, id) ? state.windows[id] : undefined
      if (win && win.kind === spec.kind) return win
    }
    for (const win of Object.values(state.windows)) {
      if (win.kind === spec.kind) return win
    }
  }

  return undefined
}

function nextWindowId(
  windows: Readonly<Record<string, DesktopWindowInstance>>,
  spec: OpenDesktopWindowPayload,
): string {
  if (spec.id && !hasOwnWindow(windows, spec.id)) {
    return spec.id
  }

  const prefix = `${spec.kind}-`
  let maxCounter = 0
  for (const key of Object.keys(windows)) {
    if (!key.startsWith(prefix)) continue
    const suffix = key.slice(prefix.length)
    if (!/^\d+$/.test(suffix)) continue
    const parsed = Number.parseInt(suffix, 10)
    if (Number.isSafeInteger(parsed) && parsed > maxCounter) {
      maxCounter = parsed
    }
  }

  let counter = maxCounter + 1
  while (hasOwnWindow(windows, `${prefix}${counter}`)) {
    counter += 1
  }
  return `${prefix}${counter}`
}

function findCascadeAnchor(state: DesktopWmState): DesktopWindowInstance | undefined {
  for (let i = state.order.length - 1; i >= 0; i -= 1) {
    const id = state.order[i]
    const win = hasOwnWindow(state.windows, id) ? state.windows[id] : undefined
    if (win && win.mode !== 'maximized' && win.mode !== 'minimized') {
      return win
    }
  }
  return undefined
}

function computeInitialRect(state: DesktopWmState, spec: OpenDesktopWindowPayload): WindowRect {
  if (spec.initialRect) {
    return clampWindowRect(spec.initialRect, spec.stage, spec.minSize)
  }

  const baseRect = defaultWindowRect(spec.stage, spec.preferredSize)
  const anchor = findCascadeAnchor(state)
  if (!anchor) {
    return clampWindowRect(baseRect, spec.stage, spec.minSize)
  }

  const blockingRects = Object.values(state.windows)
    .filter((win) => win.mode !== 'minimized' && win.mode !== 'maximized')
    .map((win) => win.rect)

  const overlapsExisting = (rect: WindowRect): boolean =>
    blockingRects.some(
      (existing) =>
        Math.abs(existing.x - rect.x) <= CASCADE_OVERLAP_TOLERANCE_PX &&
        Math.abs(existing.y - rect.y) <= CASCADE_OVERLAP_TOLERANCE_PX,
    )

  let candidate: WindowRect = {
    x: anchor.rect.x + WINDOW_CASCADE_OFFSET_PX,
    y: anchor.rect.y + WINDOW_CASCADE_OFFSET_PX,
    width: baseRect.width,
    height: baseRect.height,
  }
  let clamped = clampWindowRect(candidate, spec.stage, spec.minSize)

  for (let step = 0; step < MAX_CASCADE_STEPS; step += 1) {
    if (!overlapsExisting(clamped)) break
    candidate = {
      x: candidate.x + WINDOW_CASCADE_OFFSET_PX,
      y: candidate.y + WINDOW_CASCADE_OFFSET_PX,
      width: baseRect.width,
      height: baseRect.height,
    }
    const nextClamped = clampWindowRect(candidate, spec.stage, spec.minSize)
    if (nextClamped.x === clamped.x && nextClamped.y === clamped.y) {
      break
    }
    clamped = nextClamped
  }

  return clamped
}

function handleOpen(state: DesktopWmState, spec: OpenDesktopWindowPayload): DesktopWmState {
  const existing = findReusableWindow(state, spec)
  if (existing) {
    const nextMode: DesktopWindowMode = existing.mode === 'minimized' ? 'normal' : existing.mode
    const nextPayload =
      spec.payload !== undefined
        ? { ...(existing.payload ?? {}), ...spec.payload }
        : existing.payload
    const updated: DesktopWindowInstance = {
      ...existing,
      title: spec.title,
      mode: nextMode,
      ...(nextPayload !== undefined ? { payload: nextPayload } : {}),
    }
    return {
      windows: {
        ...state.windows,
        [existing.id]: updated,
      },
      order: bringToFront(state.order, existing.id),
      activeId: existing.id,
    }
  }

  const id = nextWindowId(state.windows, spec)
  const rect = computeInitialRect(state, spec)
  const created: DesktopWindowInstance = {
    id,
    kind: spec.kind,
    title: spec.title,
    rect,
    mode: 'normal',
    snap: 'none',
    ...(spec.payload !== undefined ? { payload: { ...spec.payload } } : {}),
    ...(spec.reuseKey !== undefined ? { reuseKey: spec.reuseKey } : {}),
  }

  return {
    windows: {
      ...state.windows,
      [id]: created,
    },
    order: [...state.order, id],
    activeId: id,
  }
}

function handleFocus(state: DesktopWmState, id: string): DesktopWmState {
  if (!hasOwnWindow(state.windows, id)) return state
  const existing = state.windows[id]
  const restoredMode: DesktopWindowMode = existing.mode === 'minimized' ? 'normal' : existing.mode
  const alreadyTop =
    state.activeId === id &&
    state.order.length > 0 &&
    state.order[state.order.length - 1] === id &&
    restoredMode === existing.mode
  if (alreadyTop) return state

  const nextWindows =
    restoredMode !== existing.mode
      ? {
          ...state.windows,
          [id]: {
            ...existing,
            mode: restoredMode,
          },
        }
      : state.windows

  return {
    windows: nextWindows,
    order: bringToFront(state.order, id),
    activeId: id,
  }
}

function handleClose(state: DesktopWmState, id: string): DesktopWmState {
  if (!hasOwnWindow(state.windows, id)) return state
  const nextWindows: Record<string, DesktopWindowInstance> = {}
  for (const [key, win] of Object.entries(state.windows)) {
    if (key !== id) {
      nextWindows[key] = win
    }
  }
  const nextOrder = state.order.filter((item) => item !== id)
  const needsRecomputeActive =
    state.activeId === id ||
    (state.activeId !== null && !hasOwnWindow(nextWindows, state.activeId))
  const nextActiveId = needsRecomputeActive
    ? topVisibleWindowId(nextWindows, nextOrder)
    : state.activeId

  return {
    windows: nextWindows,
    order: nextOrder,
    activeId: nextActiveId,
  }
}

function handleSetMode(
  state: DesktopWmState,
  id: string,
  mode: DesktopWindowMode,
  snap?: DesktopWindowSnap,
): DesktopWmState {
  if (!hasOwnWindow(state.windows, id)) return state
  const existing = state.windows[id]
  const nextSnap = snap ?? existing.snap
  const nextWin: DesktopWindowInstance = {
    ...existing,
    mode,
    snap: nextSnap,
  }
  const nextWindows = {
    ...state.windows,
    [id]: nextWin,
  }

  if (mode === 'minimized') {
    const nextActiveId =
      state.activeId === id ? topVisibleWindowId(nextWindows, state.order) : state.activeId
    return {
      windows: nextWindows,
      order: state.order,
      activeId: nextActiveId,
    }
  }

  return {
    windows: nextWindows,
    order: bringToFront(state.order, id),
    activeId: id,
  }
}

function handleSetRect(
  state: DesktopWmState,
  id: string,
  rect: WindowRect,
  snap?: DesktopWindowSnap,
): DesktopWmState {
  if (!hasOwnWindow(state.windows, id)) return state
  const existing = state.windows[id]
  const nextSnap = snap ?? existing.snap
  return {
    ...state,
    windows: {
      ...state.windows,
      [id]: {
        ...existing,
        rect,
        snap: nextSnap,
      },
    },
  }
}

function handleUpdate(
  state: DesktopWmState,
  id: string,
  title?: string,
  payload?: Record<string, unknown>,
): DesktopWmState {
  if (!hasOwnWindow(state.windows, id)) return state
  if (title === undefined && payload === undefined) return state
  const existing = state.windows[id]
  const nextPayload =
    payload !== undefined ? { ...(existing.payload ?? {}), ...payload } : existing.payload

  return {
    ...state,
    windows: {
      ...state.windows,
      [id]: {
        ...existing,
        ...(title !== undefined ? { title } : {}),
        ...(nextPayload !== undefined ? { payload: nextPayload } : {}),
      },
    },
  }
}

function handleCycle(state: DesktopWmState, reverse = false): DesktopWmState {
  const len = state.order.length
  if (len === 0) return state

  const activeIdx = state.activeId !== null ? state.order.indexOf(state.activeId) : -1
  let nextIdx: number
  if (activeIdx === -1) {
    nextIdx = reverse ? 0 : len - 1
  } else if (reverse) {
    nextIdx = (activeIdx - 1 + len) % len
  } else {
    nextIdx = (activeIdx + 1) % len
  }

  const nextId = state.order[nextIdx]
  if (!hasOwnWindow(state.windows, nextId)) return state
  const target = state.windows[nextId]
  const nextWindows =
    target.mode === 'minimized'
      ? {
          ...state.windows,
          [nextId]: {
            ...target,
            mode: 'normal' as const,
          },
        }
      : state.windows

  return {
    windows: nextWindows,
    order: bringToFront(state.order, nextId),
    activeId: nextId,
  }
}

/** Pure state reducer for multi-window stacking, focus, geometry, and lifecycle management. */
export function desktopWmReducer(state: DesktopWmState, action: DesktopWmAction): DesktopWmState {
  switch (action.type) {
    case 'open':
      return handleOpen(state, action.spec)
    case 'focus':
      return handleFocus(state, action.id)
    case 'blur-all':
      return state.activeId === null ? state : { ...state, activeId: null }
    case 'close':
      return handleClose(state, action.id)
    case 'set-mode':
      return handleSetMode(state, action.id, action.mode, action.snap)
    case 'set-rect':
      return handleSetRect(state, action.id, action.rect, action.snap)
    case 'update':
      return handleUpdate(state, action.id, action.title, action.payload)
    case 'cycle':
      return handleCycle(state, action.reverse)
  }
}

/** Compute the dynamic CSS z-index for a managed window from its stacking order. */
export function zIndexOfWindow(state: DesktopWmState, id: string): number {
  const idx = state.order.indexOf(id)
  return idx >= 0 ? idx + 1 : 1
}

/** Return true when an active window exists and is not minimized. */
export function hasFocusedVisibleWindow(state: DesktopWmState): boolean {
  if (state.activeId === null) return false
  const win = hasOwnWindow(state.windows, state.activeId)
    ? state.windows[state.activeId]
    : undefined
  return win !== undefined && win.mode !== 'minimized'
}
