import type { MediaPlayMode, MediaPlaylistItem } from '../../shared/home-api'

export const SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const

const PLAY_MODE_CYCLE: readonly MediaPlayMode[] = ['list', 'loop-all', 'loop-one', 'shuffle']

/** Cycle through list -> loop-all -> loop-one -> shuffle -> list. */
export function nextPlayMode(mode: MediaPlayMode): MediaPlayMode {
  const idx = PLAY_MODE_CYCLE.indexOf(mode)
  if (idx < 0) return 'list'
  return PLAY_MODE_CYCLE[(idx + 1) % PLAY_MODE_CYCLE.length]!
}

/** Step up or down along SPEED_PRESETS, clamping at ends. */
export function stepPlaybackSpeed(currentRate: number, delta: -1 | 1): number {
  let closestIdx = 0
  let bestDiff = Number.POSITIVE_INFINITY
  for (let i = 0; i < SPEED_PRESETS.length; i += 1) {
    const diff = Math.abs(SPEED_PRESETS[i]! - currentRate)
    if (diff < bestDiff) {
      bestDiff = diff
      closestIdx = i
    }
  }
  const nextIdx = Math.min(SPEED_PRESETS.length - 1, Math.max(0, closestIdx + delta))
  return SPEED_PRESETS[nextIdx]!
}

/** Build a Fisher-Yates permutation of `0..length-1` placing `currentIndex` first when valid. */
export function buildShuffleOrder(
  length: number,
  currentIndex: number,
  rng: () => number = Math.random,
): number[] {
  if (length <= 0) return []
  const pool: number[] = []
  for (let i = 0; i < length; i += 1) {
    if (i !== currentIndex) pool.push(i)
  }
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = pool[i]!
    pool[i] = pool[j]!
    pool[j] = tmp
  }
  if (currentIndex >= 0 && currentIndex < length) {
    return [currentIndex, ...pool]
  }
  return pool
}

function isValidShuffleOrder(order: readonly number[] | undefined, count: number): order is readonly number[] {
  if (!order || order.length !== count) return false
  const seen = new Set<number>()
  for (const idx of order) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= count || seen.has(idx)) return false
    seen.add(idx)
  }
  return true
}

function isWindowsRuntime(): boolean {
  if (typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string') {
    return /win/i.test(navigator.userAgent)
  }
  return typeof process !== 'undefined' && process.platform === 'win32'
}

/** Filter playlist items by folder path (`all` or exact dirPath) and filename/folder search query. */
export function filterPlaylistItems(
  items: readonly MediaPlaylistItem[],
  folderFilter: string,
  query: string,
): MediaPlaylistItem[] {
  const cleanQuery = query.trim().toLowerCase()
  const win = isWindowsRuntime()
  const normFilter = win ? folderFilter.toLowerCase() : folderFilter
  return items.filter((item) => {
    if (folderFilter !== 'all') {
      const itemDir = win ? item.dirPath.toLowerCase() : item.dirPath
      if (itemDir !== normFilter) return false
    }
    if (!cleanQuery) return true
    return (
      item.fileName.toLowerCase().includes(cleanQuery) ||
      item.dirName.toLowerCase().includes(cleanQuery)
    )
  })
}

export interface TrackAdvanceOptions {
  count: number
  currentIndex: number
  mode: MediaPlayMode
  reason: 'ended' | 'manual'
  shuffleOrder?: readonly number[]
}

/** Compute the target track index for automatic completion or manual next-track clicks. */
export function resolveNextTrackIndex(opts: TrackAdvanceOptions): number | null {
  const { count, currentIndex, mode, reason, shuffleOrder } = opts
  if (count <= 0) return null
  const safeCur = currentIndex >= 0 && currentIndex < count ? currentIndex : -1

  if (reason === 'ended' && mode === 'loop-one' && safeCur >= 0) {
    return safeCur
  }

  if (mode === 'shuffle') {
    if (count === 1) {
      return reason === 'ended' ? null : 0
    }
    const order = isValidShuffleOrder(shuffleOrder, count)
      ? shuffleOrder
      : buildShuffleOrder(count, safeCur)
    const pos = safeCur >= 0 ? order.indexOf(safeCur) : -1
    const nextPos = pos >= 0 ? (pos + 1) % count : 0
    return order[nextPos] ?? 0
  }

  if (mode === 'list') {
    if (safeCur < 0) return 0
    if (safeCur + 1 < count) return safeCur + 1
    return reason === 'ended' ? null : 0
  }

  // loop-all, or manual skip under loop-one
  if (safeCur < 0) return 0
  return (safeCur + 1) % count
}

/** Compute the target track index when stepping backward (`Prev`). */
export function resolvePrevTrackIndex(opts: Omit<TrackAdvanceOptions, 'reason'>): number | null {
  const { count, currentIndex, mode, shuffleOrder } = opts
  if (count <= 0) return null
  const safeCur = currentIndex >= 0 && currentIndex < count ? currentIndex : 0

  if (mode === 'shuffle') {
    if (count === 1) return 0
    const order = isValidShuffleOrder(shuffleOrder, count)
      ? shuffleOrder
      : buildShuffleOrder(count, safeCur)
    const pos = order.indexOf(safeCur)
    const prevPos = pos > 0 ? pos - 1 : count - 1
    return order[prevPos] ?? 0
  }

  return (safeCur - 1 + count) % count
}
