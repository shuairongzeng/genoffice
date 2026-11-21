import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type {
  MediaPlayMode,
  MediaPlayerPrefs,
  MediaSavePrefsPatch,
} from '../shared/home-api'

export const MEDIA_LIBRARY_FILE = 'media-player.json'
export const MAX_SAVED_POSITIONS = 100
export const MIN_RESUME_POSITION_SEC = 5
export const END_CLEAR_MARGIN_SEC = 5
export const MIN_PLAYBACK_RATE = 0.25
export const MAX_PLAYBACK_RATE = 3

const VALID_PLAY_MODES = new Set<MediaPlayMode>(['list', 'loop-all', 'loop-one', 'shuffle'])

export const DEFAULT_MEDIA_PLAYER_PREFS: MediaPlayerPrefs = {
  playMode: 'list',
  volume: 1,
  muted: false,
  playbackRate: 1,
  playlistCollapsed: false,
  autoPlay: true,
}

export interface MediaSavedPosition {
  sec: number
  updatedAt: number
}

export interface MediaLibraryStoreData {
  version: 1
  folders: string[]
  pinnedFiles: string[]
  lastFilePath: string | null
  positions: Record<string, MediaSavedPosition>
  prefs: MediaPlayerPrefs
}

const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Compare two file or directory names in natural human numeric order (e.g. EP2 < EP10). */
export function naturalCompareMediaName(a: string, b: string): number {
  return naturalCollator.compare(a, b)
}

/** Platform-canonical comparison key for file and folder paths. */
export function normalizeMediaPathKey(filePath: string): string {
  const resolved = resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** Whether two paths refer to the same resolved location on the host platform. */
export function sameMediaPath(a: string, b: string): boolean {
  return normalizeMediaPathKey(a) === normalizeMediaPathKey(b)
}

/** Convert UTF-8 SubRip (.srt) cue text into standard WebVTT text. */
export function srtToWebVtt(raw: string): string {
  const cleaned = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (/^\s*WEBVTT(?:\s|$)/i.test(cleaned)) return cleaned
  const converted = cleaned.replace(
    /(\d{1,2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}),(\d{3})/g,
    '$1.$2 --> $3.$4',
  )
  return `WEBVTT\n\n${converted.trimStart()}`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function normalizeMediaPlayerPrefs(raw: unknown): MediaPlayerPrefs {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const playMode = VALID_PLAY_MODES.has(src.playMode as MediaPlayMode)
    ? (src.playMode as MediaPlayMode)
    : DEFAULT_MEDIA_PLAYER_PREFS.playMode
  const volume =
    typeof src.volume === 'number' && Number.isFinite(src.volume)
      ? clamp(src.volume, 0, 1)
      : DEFAULT_MEDIA_PLAYER_PREFS.volume
  const playbackRate =
    typeof src.playbackRate === 'number' && Number.isFinite(src.playbackRate)
      ? clamp(src.playbackRate, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE)
      : DEFAULT_MEDIA_PLAYER_PREFS.playbackRate
  return {
    playMode,
    volume,
    muted: typeof src.muted === 'boolean' ? src.muted : DEFAULT_MEDIA_PLAYER_PREFS.muted,
    playbackRate,
    playlistCollapsed:
      typeof src.playlistCollapsed === 'boolean'
        ? src.playlistCollapsed
        : DEFAULT_MEDIA_PLAYER_PREFS.playlistCollapsed,
    autoPlay:
      typeof src.autoPlay === 'boolean' ? src.autoPlay : DEFAULT_MEDIA_PLAYER_PREFS.autoPlay,
  }
}

function dedupeResolvedPaths(rawList: unknown): string[] {
  if (!Array.isArray(rawList)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of rawList) {
    if (typeof item !== 'string' || !item.trim()) continue
    const resolved = resolve(item.trim())
    const key = normalizeMediaPathKey(resolved)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(resolved)
  }
  return out
}

function normalizePositions(raw: unknown): Record<string, MediaSavedPosition> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const entries: Array<[string, MediaSavedPosition]> = []
  const seen = new Set<string>()
  for (const [rawPath, rawVal] of Object.entries(raw as Record<string, unknown>)) {
    if (!rawPath.trim() || !rawVal || typeof rawVal !== 'object') continue
    const val = rawVal as { sec?: unknown; updatedAt?: unknown }
    if (typeof val.sec !== 'number' || !Number.isFinite(val.sec) || val.sec < MIN_RESUME_POSITION_SEC) {
      continue
    }
    const resolved = resolve(rawPath.trim())
    const key = normalizeMediaPathKey(resolved)
    if (seen.has(key)) continue
    seen.add(key)
    const updatedAt =
      typeof val.updatedAt === 'number' && Number.isFinite(val.updatedAt) ? val.updatedAt : 0
    entries.push([resolved, { sec: val.sec, updatedAt }])
  }
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt)
  const capped = entries.slice(0, MAX_SAVED_POSITIONS)
  return Object.fromEntries(capped)
}

/** Normalize raw parsed JSON into a safe, canonical MediaLibraryStoreData object. */
export function normalizeMediaLibraryData(raw: unknown): MediaLibraryStoreData {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const lastFilePath =
    typeof src.lastFilePath === 'string' && src.lastFilePath.trim()
      ? resolve(src.lastFilePath.trim())
      : null
  return {
    version: 1,
    folders: dedupeResolvedPaths(src.folders),
    pinnedFiles: dedupeResolvedPaths(src.pinnedFiles),
    lastFilePath,
    positions: normalizePositions(src.positions),
    prefs: normalizeMediaPlayerPrefs(src.prefs),
  }
}

export function readMediaLibrary(storePath: string): MediaLibraryStoreData {
  try {
    const raw = readFileSync(storePath, 'utf8')
    return normalizeMediaLibraryData(JSON.parse(raw))
  } catch {
    return normalizeMediaLibraryData(null)
  }
}

export function writeMediaLibrary(storePath: string, data: MediaLibraryStoreData): void {
  const normalized = normalizeMediaLibraryData(data)
  const dir = dirname(storePath)
  mkdirSync(dir, { recursive: true })
  const tmpPath = `${storePath}.${randomUUID()}.tmp`
  writeFileSync(tmpPath, JSON.stringify(normalized, null, 2), 'utf8')
  renameSync(tmpPath, storePath)
}

export function addLibraryFolders(
  data: MediaLibraryStoreData,
  dirPaths: readonly string[],
): MediaLibraryStoreData {
  const seen = new Set(data.folders.map(normalizeMediaPathKey))
  const next = [...data.folders]
  for (const dirPath of dirPaths) {
    if (typeof dirPath !== 'string' || !dirPath.trim()) continue
    const resolved = resolve(dirPath.trim())
    const key = normalizeMediaPathKey(resolved)
    if (seen.has(key)) continue
    seen.add(key)
    next.push(resolved)
  }
  return { ...data, folders: next }
}

export function removeLibraryFolder(
  data: MediaLibraryStoreData,
  dirPath: string,
): MediaLibraryStoreData {
  const key = normalizeMediaPathKey(dirPath)
  const nextFolders = data.folders.filter((f) => normalizeMediaPathKey(f) !== key)
  if (nextFolders.length === data.folders.length) return data
  return { ...data, folders: nextFolders }
}

export function addLibraryPinnedFiles(
  data: MediaLibraryStoreData,
  filePaths: readonly string[],
): MediaLibraryStoreData {
  const seen = new Set(data.pinnedFiles.map(normalizeMediaPathKey))
  const next = [...data.pinnedFiles]
  for (const filePath of filePaths) {
    if (typeof filePath !== 'string' || !filePath.trim()) continue
    const resolved = resolve(filePath.trim())
    const key = normalizeMediaPathKey(resolved)
    if (seen.has(key)) continue
    seen.add(key)
    next.push(resolved)
  }
  return { ...data, pinnedFiles: next }
}

export function removeLibraryPinnedFile(
  data: MediaLibraryStoreData,
  filePath: string,
): MediaLibraryStoreData {
  const key = normalizeMediaPathKey(filePath)
  const nextPinned = data.pinnedFiles.filter((f) => normalizeMediaPathKey(f) !== key)
  if (nextPinned.length === data.pinnedFiles.length) return data
  return { ...data, pinnedFiles: nextPinned }
}

/** Lookup the stored resume position (in seconds) for a specific file path. */
export function resumePositionForPath(data: MediaLibraryStoreData, filePath: string): number {
  const key = normalizeMediaPathKey(filePath)
  for (const [savedPath, entry] of Object.entries(data.positions)) {
    if (normalizeMediaPathKey(savedPath) === key) {
      return entry.sec
    }
  }
  return 0
}

/** Update playback state, last played track, and resume positions atomically in memory. */
export function updateLibraryPlayback(
  data: MediaLibraryStoreData,
  patch: MediaSavePrefsPatch,
  now = Date.now(),
): MediaLibraryStoreData {
  let nextLastFilePath = data.lastFilePath
  if (patch.lastFilePath === null) {
    nextLastFilePath = null
  } else if (typeof patch.lastFilePath === 'string' && patch.lastFilePath.trim()) {
    nextLastFilePath = resolve(patch.lastFilePath.trim())
  }

  let nextPositions = data.positions
  if (patch.position && typeof patch.position.filePath === 'string' && patch.position.filePath.trim()) {
    const targetPath = resolve(patch.position.filePath.trim())
    const targetKey = normalizeMediaPathKey(targetPath)
    const sec = patch.position.sec
    const durationSec = patch.position.durationSec
    const filtered: Array<[string, MediaSavedPosition]> = Object.entries(data.positions).filter(
      ([existingPath]) => normalizeMediaPathKey(existingPath) !== targetKey,
    )
    const nearEnd =
      typeof durationSec === 'number' &&
      Number.isFinite(durationSec) &&
      durationSec > 0 &&
      durationSec - sec <= END_CLEAR_MARGIN_SEC
    if (typeof sec === 'number' && Number.isFinite(sec) && sec >= MIN_RESUME_POSITION_SEC && !nearEnd) {
      filtered.push([targetPath, { sec, updatedAt: now }])
      filtered.sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      nextPositions = Object.fromEntries(filtered.slice(0, MAX_SAVED_POSITIONS))
    } else {
      nextPositions = Object.fromEntries(filtered)
    }
  }

  const nextPrefs = patch.prefs
    ? normalizeMediaPlayerPrefs({ ...data.prefs, ...patch.prefs })
    : data.prefs

  return {
    ...data,
    lastFilePath: nextLastFilePath,
    positions: nextPositions,
    prefs: nextPrefs,
  }
}
