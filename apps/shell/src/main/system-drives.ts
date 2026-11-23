import { execFile } from 'node:child_process'
import { constants, type Stats } from 'node:fs'
import { access, readdir, realpath, stat, statfs } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { basename, dirname, extname, join, posix, resolve, win32 } from 'node:path'
import { app } from 'electron'
import type {
  SystemDirEntry,
  SystemDirListing,
  SystemDriveInfo,
  SystemDriveKind,
  SystemDrivesSnapshot,
  SystemListDirOpts,
  SystemPlaceId,
  SystemPlaceInfo,
  SystemSearchOpts,
  SystemSearchResult,
} from '../shared/home-api'
import { compileSystemSearchMatcher } from '../shared/system-search-matcher'
import { isSupportedTreeFile } from './folder-tree'

export const MAX_SYSTEM_DIR_ENTRIES = 1500
export const DEFAULT_SEARCH_MAX_RESULTS = 500
export const DEFAULT_SEARCH_MAX_DIRS = 20_000
export const DEFAULT_SEARCH_TIMEOUT_MS = 10_000
const DEFAULT_CACHE_TTL_MS = 10_000
const WINDOWS_PROBE_TIMEOUT_MS = 4_000
const STAT_CHUNK_SIZE = 64
const SEARCH_WORKER_CONCURRENCY = 12
const SEARCH_YIELD_DIR_INTERVAL = 16
const SEARCH_YIELD_ENTRY_INTERVAL = 512

const SYSTEM_PLACE_IDS: readonly SystemPlaceId[] = ['desktop', 'downloads', 'documents', 'pictures']

const FALLBACK_PLACE_DIR_NAMES: Record<SystemPlaceId, string> = {
  desktop: 'Desktop',
  downloads: 'Downloads',
  documents: 'Documents',
  pictures: 'Pictures',
}

const NOISE_DIR_NAMES = new Set([
  '$recycle.bin',
  'system volume information',
  'recovery',
  'config.msi',
  'msocache',
  'perflogs',
  '$windows.~bt',
  '$windows.~ws',
  'found.000',
])

const NOISE_FILE_NAMES = new Set([
  'pagefile.sys',
  'hiberfil.sys',
  'swapfile.sys',
  'dumpstack.log',
  'dumpstack.log.tmp',
  'desktop.ini',
  'thumbs.db',
  'bootmgr',
  'bootnxt',
  'ntuser.dat',
])

const ALWAYS_NOISE_FILE_NAMES = new Set(['desktop.ini', 'thumbs.db'])

interface CachedDrivesState {
  snapshot: SystemDrivesSnapshot
  cachedAt: number
}

let cachedDrives: CachedDrivesState | null = null
let inFlightDrives: Promise<SystemDrivesSnapshot> | null = null

export interface ListSystemDrivesOpts {
  readonly forceRefresh?: boolean
  readonly cacheTtlMs?: number
  readonly probeOverride?: () => Promise<SystemDriveInfo[]>
  readonly resolvePlacePath?: (id: SystemPlaceId) => string | null
}

export interface SystemListDirInternalOpts extends SystemListDirOpts {
  readonly maxEntries?: number
}

/**
 * Returns true when `dirPath` points to a Windows drive root (e.g. `C:\`, `C:`, `D:/`)
 * or a POSIX filesystem/volume root (`/` or `/Volumes/<name>`).
 */
export function isDriveRootPath(dirPath: string): boolean {
  if (typeof dirPath !== 'string') return false
  const trimmed = dirPath.trim()
  if (!trimmed) return false

  if (/^[a-zA-Z]:[\\/]?$/.test(trimmed)) return true

  if (/^[a-zA-Z]:/.test(trimmed)) {
    const normalized = win32.normalize(trimmed)
    return /^[a-zA-Z]:[\\/]?$/.test(normalized)
  }

  if (trimmed.startsWith('/')) {
    const normalized = posix.normalize(trimmed)
    const clean = normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
    return clean === '/' || /^\/Volumes\/[^/]+$/.test(clean)
  }

  return false
}

/**
 * Filters OS-reserved directories, page/hibernation files, lock files, and dotfiles
 * when hidden items are disabled.
 */
export function isSystemNoiseEntry(name: string, isDir: boolean, showHidden: boolean): boolean {
  if (name.startsWith('~$')) return true
  const lower = name.toLowerCase()
  if (!isDir && ALWAYS_NOISE_FILE_NAMES.has(lower)) return true
  if (showHidden) return false

  if (name.startsWith('.')) return true
  return isDir ? NOISE_DIR_NAMES.has(lower) : NOISE_FILE_NAMES.has(lower)
}

function defaultResolvePlacePath(id: SystemPlaceId): string | null {
  try {
    if (typeof app?.getPath === 'function') {
      const resolved = app.getPath(id)
      if (resolved) return resolved
    }
  } catch {
    // Electron app may be unavailable in unit tests or before ready; fall back to homedir.
  }
  const home = homedir()
  return home ? join(home, FALLBACK_PLACE_DIR_NAMES[id]) : null
}

async function isReadableDirectory(dirPath: string): Promise<boolean> {
  try {
    const st = await stat(dirPath)
    if (!st.isDirectory()) return false
    await access(dirPath, constants.R_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resolves standard OS quick-access folders (Desktop, Downloads, Documents, Pictures),
 * deduplicated by normalized path and annotated with live readability.
 */
export async function getSystemPlaces(
  resolvePlacePath: (id: SystemPlaceId) => string | null = defaultResolvePlacePath,
): Promise<SystemPlaceInfo[]> {
  const seen = new Set<string>()
  const candidates: Array<{ id: SystemPlaceId; path: string; name: string }> = []

  for (const id of SYSTEM_PLACE_IDS) {
    let raw: string | null = null
    try {
      raw = resolvePlacePath(id)
    } catch {
      raw = null
    }
    if (!raw || typeof raw !== 'string') continue
    const resolved = resolve(raw)
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({ id, path: resolved, name: basename(resolved) || resolved })
  }

  return Promise.all(
    candidates.map(async (item) => ({
      id: item.id,
      path: item.path,
      name: item.name,
      accessible: await isReadableDirectory(item.path),
    })),
  )
}

function computeUsage(
  totalBytes: number,
  freeBytes: number,
): Pick<SystemDriveInfo, 'totalBytes' | 'freeBytes' | 'usedBytes' | 'usedRatio'> {
  const safeTotal = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 0
  const safeFree =
    Number.isFinite(freeBytes) && freeBytes > 0
      ? safeTotal > 0
        ? Math.min(freeBytes, safeTotal)
        : freeBytes
      : 0
  const usedBytes = safeTotal > 0 ? Math.max(0, safeTotal - safeFree) : 0
  const usedRatio = safeTotal > 0 ? Math.min(1, Math.max(0, usedBytes / safeTotal)) : 0
  return { totalBytes: safeTotal, freeBytes: safeFree, usedBytes, usedRatio }
}

interface DriveProbeMeta {
  readonly id: string
  readonly path: string
  readonly name: string
  readonly label: string
  readonly kind: SystemDriveKind
  readonly isSystem: boolean
  readonly fallbackTotalBytes?: number
  readonly fallbackFreeBytes?: number
}

interface DriveProbeFsOps {
  readonly accessFn?: (path: string, mode?: number) => Promise<void>
  readonly statfsFn?: (path: string) => Promise<{ bsize: number; blocks: number; bavail: number }>
}

/**
 * Probes a single drive/mount in isolation so inaccessible or unmounted volumes
 * return `accessible: false` with zeroed metrics without failing the whole snapshot.
 */
export async function probeDriveEntry(
  meta: DriveProbeMeta,
  fsOps: DriveProbeFsOps = {},
): Promise<SystemDriveInfo> {
  const accessFn = fsOps.accessFn ?? access
  const statfsFn = fsOps.statfsFn ?? statfs

  try {
    await accessFn(meta.path, constants.R_OK)
    let totalBytes = meta.fallbackTotalBytes
    let freeBytes = meta.fallbackFreeBytes

    if (
      typeof totalBytes !== 'number' ||
      !Number.isFinite(totalBytes) ||
      totalBytes < 0 ||
      typeof freeBytes !== 'number' ||
      !Number.isFinite(freeBytes) ||
      freeBytes < 0
    ) {
      const fsStats = await statfsFn(meta.path)
      const bsize = Number(fsStats.bsize)
      totalBytes = Number(fsStats.blocks) * bsize
      freeBytes = Number(fsStats.bavail) * bsize
    }

    return {
      id: meta.id,
      path: meta.path,
      name: meta.name,
      label: meta.label,
      kind: meta.kind,
      ...computeUsage(totalBytes, freeBytes),
      accessible: true,
      isSystem: meta.isSystem,
    }
  } catch {
    return {
      id: meta.id,
      path: meta.path,
      name: meta.name,
      label: meta.label,
      kind: meta.kind,
      totalBytes: 0,
      freeBytes: 0,
      usedBytes: 0,
      usedRatio: 0,
      accessible: false,
      isSystem: meta.isSystem,
    }
  }
}

function getWindowsSystemDrive(): string {
  const raw = (process.env.SystemDrive || 'C:').trim().toUpperCase()
  const match = raw.match(/^[A-Z]:/)
  return match ? match[0] : 'C:'
}

function mapWindowsDriveType(driveType: unknown): SystemDriveKind {
  switch (Number(driveType)) {
    case 2:
      return 'removable'
    case 3:
      return 'fixed'
    case 4:
      return 'network'
    case 5:
      return 'optical'
    default:
      return 'unknown'
  }
}

interface RawWinLogicalDisk {
  DeviceID?: unknown
  VolumeName?: unknown
  DriveType?: unknown
  Size?: unknown
  FreeSpace?: unknown
}

function execPowerShellDiskQuery(): Promise<string> {
  const script =
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
    'Get-CimInstance Win32_LogicalDisk | ' +
    'Select-Object DeviceID,VolumeName,DriveType,Size,FreeSpace | ' +
    'ConvertTo-Json -Compress'

  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: WINDOWS_PROBE_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        if (err) {
          rejectPromise(err)
          return
        }
        resolvePromise(stdout)
      },
    )
  })
}

async function probeWindowsFallbackDrives(systemDrive: string): Promise<SystemDriveInfo[]> {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
  const results = await Promise.all(
    letters.map(async (letter) => {
      const deviceId = `${letter}:`
      const drivePath = `${deviceId}\\`
      const isSystem = deviceId === systemDrive
      const info = await probeDriveEntry({
        id: deviceId,
        path: drivePath,
        name: deviceId,
        label: '',
        kind: isSystem ? 'system' : 'fixed',
        isSystem,
      })
      return info.accessible ? info : null
    }),
  )
  return results.filter((item): item is SystemDriveInfo => item !== null)
}

async function probeWindowsDrives(): Promise<SystemDriveInfo[]> {
  const systemDrive = getWindowsSystemDrive()
  try {
    const rawOut = await execPowerShellDiskQuery()
    const clean = rawOut.replace(/^\uFEFF/, '').trim()
    if (!clean) return probeWindowsFallbackDrives(systemDrive)

    const parsed = JSON.parse(clean) as unknown
    const disks: RawWinLogicalDisk[] = Array.isArray(parsed)
      ? (parsed as RawWinLogicalDisk[])
      : parsed && typeof parsed === 'object'
        ? [parsed as RawWinLogicalDisk]
        : []

    if (disks.length === 0) return probeWindowsFallbackDrives(systemDrive)

    const metas: DriveProbeMeta[] = []
    for (const disk of disks) {
      if (typeof disk.DeviceID !== 'string') continue
      const match = disk.DeviceID.trim()
        .toUpperCase()
        .match(/^[A-Z]:/)
      if (!match) continue
      const deviceId = match[0]
      const drivePath = `${deviceId}\\`
      const label = typeof disk.VolumeName === 'string' ? disk.VolumeName.trim() : ''
      const baseKind = mapWindowsDriveType(disk.DriveType)
      const isSystem = deviceId === systemDrive
      const kind: SystemDriveKind = isSystem && baseKind === 'fixed' ? 'system' : baseKind
      const hasValidSizes =
        typeof disk.Size === 'number' &&
        Number.isFinite(disk.Size) &&
        disk.Size >= 0 &&
        typeof disk.FreeSpace === 'number' &&
        Number.isFinite(disk.FreeSpace) &&
        disk.FreeSpace >= 0

      metas.push({
        id: deviceId,
        path: drivePath,
        name: label ? `${label} (${deviceId})` : deviceId,
        label,
        kind,
        isSystem,
        ...(hasValidSizes
          ? { fallbackTotalBytes: disk.Size as number, fallbackFreeBytes: disk.FreeSpace as number }
          : {}),
      })
    }

    return Promise.all(metas.map((meta) => probeDriveEntry(meta)))
  } catch {
    return probeWindowsFallbackDrives(systemDrive)
  }
}

async function probeMacDrives(): Promise<SystemDriveInfo[]> {
  const rootDrive = await probeDriveEntry({
    id: '/',
    path: '/',
    name: '/',
    label: '',
    kind: 'system',
    isSystem: true,
  })

  const rootReal = await realpath('/').catch(() => '/')
  const rootStat = await stat('/').catch(() => null)
  const volumeEntries = await readdir('/Volumes', { withFileTypes: true }).catch(() => [])
  const mounted: SystemDriveInfo[] = []

  for (const entry of volumeEntries) {
    if (entry.name.startsWith('.')) continue
    const volPath = posix.join('/Volumes', entry.name)
    const real = await realpath(volPath).catch(() => null)
    if (real === '/' || real === rootReal) continue

    const st = await stat(volPath).catch(() => null)
    if (!st?.isDirectory()) continue
    if (rootStat && st.dev === rootStat.dev && st.ino === rootStat.ino) continue

    mounted.push(
      await probeDriveEntry({
        id: volPath,
        path: volPath,
        name: entry.name,
        label: entry.name,
        kind: 'removable',
        isSystem: false,
      }),
    )
  }

  return [rootDrive, ...mounted]
}

async function probeLinuxDrives(): Promise<SystemDriveInfo[]> {
  const rootDrive = await probeDriveEntry({
    id: '/',
    path: '/',
    name: '/',
    label: '',
    kind: 'system',
    isSystem: true,
  })

  let username = process.env.USER || ''
  try {
    username = userInfo().username || username
  } catch {
    // Fall back to environment username when passwd lookup fails.
  }

  const mountParents: Array<{ dir: string; kind: SystemDriveKind }> = [
    { dir: '/mnt', kind: 'fixed' },
  ]
  if (username) {
    mountParents.push({ dir: posix.join('/media', username), kind: 'removable' })
    mountParents.push({ dir: posix.join('/run/media', username), kind: 'removable' })
  }

  const mounted: SystemDriveInfo[] = []
  const seen = new Set<string>(['/'])

  for (const parent of mountParents) {
    const entries = await readdir(parent.dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const mountPath = posix.join(parent.dir, entry.name)
      if (seen.has(mountPath)) continue
      const st = await stat(mountPath).catch(() => null)
      if (!st?.isDirectory()) continue
      seen.add(mountPath)
      mounted.push(
        await probeDriveEntry({
          id: mountPath,
          path: mountPath,
          name: entry.name,
          label: entry.name,
          kind: parent.kind,
          isSystem: false,
        }),
      )
    }
  }

  return [rootDrive, ...mounted]
}

async function probePlatformDrives(): Promise<SystemDriveInfo[]> {
  if (process.platform === 'win32') return probeWindowsDrives()
  if (process.platform === 'darwin') return probeMacDrives()
  return probeLinuxDrives()
}

/**
 * Enumerates OS quick-access folders and mounted drives with a short TTL cache
 * to avoid repeatedly spawning platform probes.
 */
export async function listSystemDrives(opts?: ListSystemDrivesOpts): Promise<SystemDrivesSnapshot> {
  const forceRefresh = opts?.forceRefresh === true
  const ttl =
    typeof opts?.cacheTtlMs === 'number' && Number.isFinite(opts.cacheTtlMs) && opts.cacheTtlMs >= 0
      ? opts.cacheTtlMs
      : DEFAULT_CACHE_TTL_MS

  if (!forceRefresh && cachedDrives && ttl > 0 && Date.now() - cachedDrives.cachedAt < ttl) {
    return cachedDrives.snapshot
  }

  if (!forceRefresh && !opts?.probeOverride && !opts?.resolvePlacePath && inFlightDrives) {
    return inFlightDrives
  }

  const runProbe = async (): Promise<SystemDrivesSnapshot> => {
    const [places, drives] = await Promise.all([
      getSystemPlaces(opts?.resolvePlacePath),
      (opts?.probeOverride ? opts.probeOverride() : probePlatformDrives()).catch(
        () => [] as SystemDriveInfo[],
      ),
    ])
    const snapshot: SystemDrivesSnapshot = {
      platform: process.platform,
      places,
      drives,
      fetchedAt: Date.now(),
    }
    cachedDrives = { snapshot, cachedAt: Date.now() }
    return snapshot
  }

  if (!forceRefresh && !opts?.probeOverride && !opts?.resolvePlacePath) {
    inFlightDrives = runProbe().finally(() => {
      inFlightDrives = null
    })
    return inFlightDrives
  }

  return runProbe()
}

function mapFsError(err: unknown): 'missing' | 'denied' | 'not-directory' {
  const code = (err as NodeJS.ErrnoException | null)?.code
  if (code === 'EACCES' || code === 'EPERM') return 'denied'
  if (code === 'ENOTDIR') return 'not-directory'
  return 'missing'
}

async function statInChunks<T>(
  items: readonly T[],
  getPath: (item: T) => string,
): Promise<Array<Stats | null>> {
  const out: Array<Stats | null> = []
  for (let i = 0; i < items.length; i += STAT_CHUNK_SIZE) {
    const chunk = items.slice(i, i + STAT_CHUNK_SIZE)
    const stats = await Promise.all(chunk.map((item) => stat(getPath(item)).catch(() => null)))
    out.push(...stats)
  }
  return out
}

interface DirCandidate {
  readonly name: string
  readonly path: string
  readonly preStat?: Stats
}

interface FileCandidate {
  readonly name: string
  readonly path: string
  readonly supported: boolean
  readonly preStat?: Stats
}

function normalizeSystemDirPath(dirPath: string): string {
  const trimmed = dirPath.trim()
  // Bare drive letters like "C:" resolve to C:'s cwd in Node unless normalized to "C:\".
  const normalizedInput = /^[a-zA-Z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed
  return resolve(normalizedInput)
}

function resolvePositiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolveImmediate) => setImmediate(resolveImmediate))
}

/**
 * Lists one directory level read-only without recursion, watchers, or folder-root registration.
 */
export async function listSystemDirectory(
  dirPath: string,
  opts?: SystemListDirInternalOpts,
): Promise<SystemDirListing> {
  if (typeof dirPath !== 'string' || !dirPath.trim()) {
    return {
      dir: String(dirPath ?? ''),
      parentDir: null,
      isDriveRoot: false,
      folders: [],
      files: [],
      totalCount: 0,
      truncated: false,
      error: 'missing',
    }
  }

  const resolved = normalizeSystemDirPath(dirPath)
  const isDriveRoot = isDriveRootPath(resolved)
  const rawParent = dirname(resolved)
  const parentDir = isDriveRoot || rawParent === resolved ? null : rawParent

  let dirStat: Stats
  try {
    dirStat = await stat(resolved)
  } catch (err) {
    return {
      dir: resolved,
      parentDir,
      isDriveRoot,
      folders: [],
      files: [],
      totalCount: 0,
      truncated: false,
      error: mapFsError(err),
    }
  }

  if (!dirStat.isDirectory()) {
    return {
      dir: resolved,
      parentDir,
      isDriveRoot,
      folders: [],
      files: [],
      totalCount: 0,
      truncated: false,
      error: 'not-directory',
    }
  }

  let dirents
  try {
    dirents = await readdir(resolved, { withFileTypes: true })
  } catch (err) {
    return {
      dir: resolved,
      parentDir,
      isDriveRoot,
      folders: [],
      files: [],
      totalCount: 0,
      truncated: false,
      error: mapFsError(err),
    }
  }

  const showAllFiles = opts?.showAllFiles === true
  const showHidden = opts?.showHidden === true
  const maxEntries =
    typeof opts?.maxEntries === 'number' && Number.isFinite(opts.maxEntries) && opts.maxEntries > 0
      ? Math.floor(opts.maxEntries)
      : MAX_SYSTEM_DIR_ENTRIES

  const dirCandidates: DirCandidate[] = []
  const fileCandidates: FileCandidate[] = []
  const symlinkCandidates: Array<{ name: string; path: string }> = []

  for (const dirent of dirents) {
    const entryPath = join(resolved, dirent.name)
    if (dirent.isDirectory()) {
      if (!isSystemNoiseEntry(dirent.name, true, showHidden)) {
        dirCandidates.push({ name: dirent.name, path: entryPath })
      }
    } else if (dirent.isFile()) {
      if (!isSystemNoiseEntry(dirent.name, false, showHidden)) {
        const supported = isSupportedTreeFile(dirent.name)
        if (showAllFiles || supported) {
          fileCandidates.push({ name: dirent.name, path: entryPath, supported })
        }
      }
    } else if (dirent.isSymbolicLink()) {
      if (dirent.name.startsWith('~$') || (!showHidden && dirent.name.startsWith('.'))) continue
      symlinkCandidates.push({ name: dirent.name, path: entryPath })
    }
  }

  if (symlinkCandidates.length > 0) {
    const linkStats = await statInChunks(symlinkCandidates, (item) => item.path)
    symlinkCandidates.forEach((item, index) => {
      const st = linkStats[index]
      if (!st) return
      if (st.isDirectory()) {
        if (!isSystemNoiseEntry(item.name, true, showHidden)) {
          dirCandidates.push({ name: item.name, path: item.path, preStat: st })
        }
      } else if (st.isFile()) {
        if (!isSystemNoiseEntry(item.name, false, showHidden)) {
          const supported = isSupportedTreeFile(item.name)
          if (showAllFiles || supported) {
            fileCandidates.push({ name: item.name, path: item.path, supported, preStat: st })
          }
        }
      }
    })
  }

  dirCandidates.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  fileCandidates.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))

  const totalCount = dirCandidates.length + fileCandidates.length
  const truncated = totalCount > maxEntries

  const keptDirs = dirCandidates.slice(0, maxEntries)
  const remainingBudget = Math.max(0, maxEntries - keptDirs.length)
  const keptFiles = fileCandidates.slice(0, remainingBudget)

  const dirsToStat = keptDirs.filter((d) => !d.preStat)
  const filesToStat = keptFiles.filter((f) => !f.preStat)

  const [dirStats, fileStats] = await Promise.all([
    statInChunks(dirsToStat, (d) => d.path),
    statInChunks(filesToStat, (f) => f.path),
  ])

  const dirStatMap = new Map<string, Stats | null>()
  dirsToStat.forEach((d, idx) => dirStatMap.set(d.path, dirStats[idx]))

  const fileStatMap = new Map<string, Stats | null>()
  filesToStat.forEach((f, idx) => fileStatMap.set(f.path, fileStats[idx]))

  const folders: SystemDirEntry[] = []
  for (const item of keptDirs) {
    const st = item.preStat ?? dirStatMap.get(item.path) ?? null
    if (!st) continue
    folders.push({
      name: item.name,
      path: item.path,
      kind: 'folder',
      ext: '',
      size: 0,
      mtimeMs: st.mtimeMs,
      supported: true,
    })
  }

  const files: SystemDirEntry[] = []
  for (const item of keptFiles) {
    const st = item.preStat ?? fileStatMap.get(item.path) ?? null
    if (!st) continue
    files.push({
      name: item.name,
      path: item.path,
      kind: 'file',
      ext: extname(item.name).slice(1).toLowerCase(),
      size: st.size,
      mtimeMs: st.mtimeMs,
      supported: item.supported,
    })
  }

  files.sort(
    (a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name, undefined, { numeric: true }),
  )

  return {
    dir: resolved,
    parentDir,
    isDriveRoot,
    folders,
    files,
    totalCount,
    truncated,
  }
}

interface SearchDirCandidate {
  readonly name: string
  readonly path: string
  readonly relativeDir: string
}

interface SearchFileCandidate {
  readonly name: string
  readonly path: string
  readonly relativeDir: string
  readonly supported: boolean
}

function emptySearchResult(
  rootDir: string,
  query: string,
  overrides?: Partial<
    Pick<
      SystemSearchResult,
      'scannedDirs' | 'scannedEntries' | 'truncated' | 'timedOut' | 'cancelled' | 'error'
    >
  >,
): SystemSearchResult {
  return {
    rootDir,
    query,
    folders: [],
    files: [],
    scannedDirs: overrides?.scannedDirs ?? 0,
    scannedEntries: overrides?.scannedEntries ?? 0,
    truncated: overrides?.truncated ?? false,
    timedOut: overrides?.timedOut ?? false,
    cancelled: overrides?.cancelled ?? false,
    ...(overrides?.error ? { error: overrides.error } : {}),
  }
}

/**
 * Recursively searches a directory read-only using a bounded BFS worker pool without
 * traversing symbolic links or modifying folderRoots.
 */
export async function searchSystemDirectory(
  dirPath: string,
  opts: SystemSearchOpts,
  signal?: AbortSignal,
): Promise<SystemSearchResult> {
  const query = typeof opts?.query === 'string' ? opts.query : ''
  if (typeof dirPath !== 'string' || !dirPath.trim()) {
    return emptySearchResult(String(dirPath ?? ''), query, { error: 'missing' })
  }

  const resolved = normalizeSystemDirPath(dirPath)

  let rootStat: Stats
  try {
    rootStat = await stat(resolved)
  } catch (err) {
    return emptySearchResult(resolved, query, { error: mapFsError(err) })
  }

  if (!rootStat.isDirectory()) {
    return emptySearchResult(resolved, query, { error: 'not-directory' })
  }

  const matcher = compileSystemSearchMatcher({
    query,
    regex: opts?.regex === true,
  })
  if (!matcher.ok) {
    return emptySearchResult(resolved, query, { error: 'invalid-regex' })
  }

  if (!query.trim()) {
    return emptySearchResult(resolved, query)
  }

  if (signal?.aborted) {
    return emptySearchResult(resolved, query, { cancelled: true })
  }

  const showAllFiles = opts?.showAllFiles === true
  const showHidden = opts?.showHidden === true
  const maxResults = resolvePositiveInt(opts?.maxResults, DEFAULT_SEARCH_MAX_RESULTS)
  const maxVisitedDirs = resolvePositiveInt(opts?.maxVisitedDirs, DEFAULT_SEARCH_MAX_DIRS)
  const timeoutMs = resolvePositiveInt(opts?.timeoutMs, DEFAULT_SEARCH_TIMEOUT_MS)

  const deadline = Date.now() + timeoutMs
  const queue: Array<{ dir: string; rel: string }> = [{ dir: resolved, rel: '' }]
  let queueHead = 0
  let enqueuedDirs = 1
  let activeWorkers = 0
  let scannedDirs = 0
  let scannedEntries = 0
  let truncated = false
  let timedOut = false
  let cancelled = false
  let dirQuotaExceeded = false
  let stopping = false
  let rootReadError: 'missing' | 'denied' | 'not-directory' | undefined

  const dirCandidates: SearchDirCandidate[] = []
  const fileCandidates: SearchFileCandidate[] = []
  const waiters: Array<() => void> = []

  const notifyWaiters = () => {
    while (waiters.length > 0) {
      waiters.shift()!()
    }
  }

  const hitCount = () => dirCandidates.length + fileCandidates.length

  const checkCircuitBreaker = (): boolean => {
    if (signal?.aborted) {
      cancelled = true
      stopping = true
      return true
    }
    if (Date.now() >= deadline) {
      timedOut = true
      stopping = true
      return true
    }
    if (hitCount() >= maxResults) {
      truncated = true
      stopping = true
      return true
    }
    return false
  }

  const onAbort = () => {
    cancelled = true
    stopping = true
    notifyWaiters()
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  const timeoutTimer = setTimeout(() => {
    timedOut = true
    stopping = true
    notifyWaiters()
  }, timeoutMs)

  const worker = async () => {
    while (!stopping) {
      if (checkCircuitBreaker()) {
        notifyWaiters()
        return
      }

      if (queueHead >= queue.length) {
        if (activeWorkers === 0) {
          if (dirQuotaExceeded && !cancelled && !timedOut) {
            truncated = true
          }
          stopping = true
          notifyWaiters()
          return
        }
        await new Promise<void>((resolveWait) => waiters.push(resolveWait))
        continue
      }

      if (scannedDirs >= maxVisitedDirs) {
        truncated = true
        stopping = true
        notifyWaiters()
        return
      }

      const item = queue[queueHead++]
      if (queueHead >= 1024 && queueHead * 2 >= queue.length) {
        queue.splice(0, queueHead)
        queueHead = 0
      }

      scannedDirs += 1
      activeWorkers += 1
      try {
        let dirents
        try {
          dirents = await readdir(item.dir, { withFileTypes: true })
        } catch (err) {
          if (item.rel === '' && item.dir === resolved) {
            rootReadError = mapFsError(err)
            stopping = true
            notifyWaiters()
          }
          continue
        }

        if (stopping || checkCircuitBreaker()) {
          notifyWaiters()
          return
        }

        for (let i = 0; i < dirents.length; i += 1) {
          if (i > 0 && (i & (SEARCH_YIELD_ENTRY_INTERVAL - 1)) === 0) {
            await yieldToEventLoop()
            if (stopping || checkCircuitBreaker()) {
              notifyWaiters()
              return
            }
          }

          const dirent = dirents[i]
          scannedEntries += 1

          // Never follow symbolic links or Windows junctions to prevent directory cycles.
          if (dirent.isSymbolicLink()) continue

          if (dirent.isDirectory()) {
            if (isSystemNoiseEntry(dirent.name, true, showHidden)) continue
            const relPath = item.rel ? join(item.rel, dirent.name) : dirent.name
            const fullPath = join(item.dir, dirent.name)

            if (matcher.matches(dirent.name, relPath)) {
              dirCandidates.push({
                name: dirent.name,
                path: fullPath,
                relativeDir: item.rel,
              })
              if (hitCount() >= maxResults) {
                truncated = true
                stopping = true
                notifyWaiters()
                return
              }
            }

            if (enqueuedDirs < maxVisitedDirs) {
              queue.push({ dir: fullPath, rel: relPath })
              enqueuedDirs += 1
            } else {
              dirQuotaExceeded = true
            }
          } else if (dirent.isFile()) {
            if (isSystemNoiseEntry(dirent.name, false, showHidden)) continue
            const supported = isSupportedTreeFile(dirent.name)
            if (!showAllFiles && !supported) continue
            const relPath = item.rel ? join(item.rel, dirent.name) : dirent.name
            if (matcher.matches(dirent.name, relPath)) {
              fileCandidates.push({
                name: dirent.name,
                path: join(item.dir, dirent.name),
                relativeDir: item.rel,
                supported,
              })
              if (hitCount() >= maxResults) {
                truncated = true
                stopping = true
                notifyWaiters()
                return
              }
            }
          }
        }

        if (scannedDirs % SEARCH_YIELD_DIR_INTERVAL === 0) {
          await yieldToEventLoop()
        }
      } finally {
        activeWorkers -= 1
        notifyWaiters()
      }
    }
  }

  try {
    const workers = Array.from({ length: SEARCH_WORKER_CONCURRENCY }, () => worker())
    await Promise.all(workers)
  } finally {
    clearTimeout(timeoutTimer)
    signal?.removeEventListener('abort', onAbort)
  }

  if (rootReadError) {
    return emptySearchResult(resolved, query, { error: rootReadError })
  }

  if (cancelled) {
    return emptySearchResult(resolved, query, {
      scannedDirs,
      scannedEntries,
      truncated,
      timedOut,
      cancelled: true,
    })
  }

  if (hitCount() > maxResults) {
    truncated = true
  }
  const keptDirs = dirCandidates.slice(0, maxResults)
  const remainingBudget = Math.max(0, maxResults - keptDirs.length)
  const keptFiles = fileCandidates.slice(0, remainingBudget)

  const [dirStats, fileStats] = await Promise.all([
    statInChunks(keptDirs, (d) => d.path),
    statInChunks(keptFiles, (f) => f.path),
  ])

  if (signal?.aborted) {
    return emptySearchResult(resolved, query, {
      scannedDirs,
      scannedEntries,
      truncated,
      timedOut,
      cancelled: true,
    })
  }

  const folders: SystemDirEntry[] = []
  keptDirs.forEach((item, index) => {
    const st = dirStats[index]
    if (!st) return
    folders.push({
      name: item.name,
      path: item.path,
      kind: 'folder',
      ext: '',
      size: 0,
      mtimeMs: st.mtimeMs,
      supported: true,
      relativeDir: item.relativeDir,
    })
  })

  const files: SystemDirEntry[] = []
  keptFiles.forEach((item, index) => {
    const st = fileStats[index]
    if (!st) return
    files.push({
      name: item.name,
      path: item.path,
      kind: 'file',
      ext: extname(item.name).slice(1).toLowerCase(),
      size: st.size,
      mtimeMs: st.mtimeMs,
      supported: item.supported,
      relativeDir: item.relativeDir,
    })
  })

  folders.sort(
    (a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true }) ||
      a.path.localeCompare(b.path, undefined, { numeric: true }),
  )
  files.sort(
    (a, b) =>
      b.mtimeMs - a.mtimeMs ||
      a.name.localeCompare(b.name, undefined, { numeric: true }) ||
      a.path.localeCompare(b.path, undefined, { numeric: true }),
  )

  return {
    rootDir: resolved,
    query,
    folders,
    files,
    scannedDirs,
    scannedEntries,
    truncated,
    timedOut,
    cancelled,
  }
}
