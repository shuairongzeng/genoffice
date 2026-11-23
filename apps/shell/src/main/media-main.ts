import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync, type Dirent } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, protocol, shell, WebContentsView } from 'electron'
import type { WebContents } from 'electron'
import { MEDIA_SCHEME, rendererUrl, safeExternalUrl } from '@genoffice/electron-utils'
import {
  HOME_CHANNELS,
  type MediaAudioMetadata,
  type MediaFolderEntry,
  type MediaInfo,
  type MediaKind,
  type MediaPlayerStateSnapshot,
  type MediaPlaylistItem,
  type MediaSavePrefsPatch,
  type MediaSnapshotImage,
  type MediaSnapshotReply,
  type MediaStateMutationResult,
  type MediaSubtitleTrack,
} from '../shared/home-api'
import { extractAudioMetadata, type ExtractedCoverArt } from './media-metadata'
import {
  MEDIA_LIBRARY_FILE,
  addLibraryFolders,
  addLibraryPinnedFiles,
  naturalCompareMediaName,
  normalizeMediaPathKey,
  readMediaLibrary,
  removeLibraryFolder,
  removeLibraryPinnedFile,
  resumePositionForPath,
  srtToWebVtt,
  updateLibraryPlayback,
  writeMediaLibrary,
  type MediaLibraryStoreData,
} from './media-library'

export type { MediaKind }

export const IMAGE_MEDIA_EXTS = [
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'svg',
  'bmp',
  'ico',
  'avif',
] as const

export const AUDIO_MEDIA_EXTS = [
  'mp3',
  'wav',
  'm4a',
  'aac',
  'ogg',
  'flac',
  'opus',
] as const

export const VIDEO_MEDIA_EXTS = ['mp4', 'webm', 'mov', 'm4v', 'mkv'] as const

export const MEDIA_EXTS: readonly string[] = [
  ...IMAGE_MEDIA_EXTS,
  ...AUDIO_MEDIA_EXTS,
  ...VIDEO_MEDIA_EXTS,
]

const IMAGE_EXT_SET = new Set<string>(IMAGE_MEDIA_EXTS)
const AUDIO_EXT_SET = new Set<string>(AUDIO_MEDIA_EXTS)
const VIDEO_EXT_SET = new Set<string>(VIDEO_MEDIA_EXTS)

const MAX_DIR_SCAN_ITEMS = 2000

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  opus: 'audio/opus',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  mkv: 'video/x-matroska',
}

export interface MediaSubtitleEntry {
  id: string
  filePath: string
  label: string
  ext: 'vtt' | 'srt'
}

export interface MediaSessionEntry {
  token: string
  wcId: number
  filePath: string
  fileName: string
  ext: string
  mediaKind: MediaKind
  mime: string
  subtitles: Map<string, MediaSubtitleEntry>
  cover?: ExtractedCoverArt
}

export interface MediaSnapshotResult {
  text: string
  images?: MediaSnapshotImage[]
}

export type ByteRangeParse =
  | { kind: 'full' }
  | { kind: 'unsatisfiable' }
  | { kind: 'partial'; start: number; end: number }

interface MediaViewContext {
  sessionDirs: Set<string>
  playerMode: boolean
}

const sessionsByToken = new Map<string, MediaSessionEntry>()
const tokenByWcId = new Map<number, string>()
const viewContexts = new Map<number, MediaViewContext>()

export const MAX_TRANSIENT_PREVIEW_TOKENS = 64
const transientPreviewTokens: string[] = []
const transientTokenByPath = new Map<string, string>()

interface PendingSnapshotWaiter {
  wcId: number
  resolve: (result: MediaSnapshotResult) => void
}
const pendingSnapshots = new Map<string, PendingSnapshotWaiter>()

let protocolRegistered = false
let ipcRegistered = false
let mediaFileChangedHook: ((wcId: number, filePath: string) => void) | null = null
let mediaLibraryPathResolver: () => string = () =>
  join(app.getPath('userData'), MEDIA_LIBRARY_FILE)

export function setMediaFileChangedHook(hook: ((wcId: number, filePath: string) => void) | null): void {
  mediaFileChangedHook = hook
}

export function setMediaLibraryPathResolver(resolver: () => string): void {
  mediaLibraryPathResolver = resolver
}

export function mediaLibraryStorePath(): string {
  return mediaLibraryPathResolver()
}

export function normalizeMediaExt(ext: string): string {
  return ext.trim().toLowerCase().replace(/^\.+/, '')
}

export function mediaKindForExt(ext: string): MediaKind | undefined {
  const clean = normalizeMediaExt(ext)
  if (IMAGE_EXT_SET.has(clean)) return 'image'
  if (AUDIO_EXT_SET.has(clean)) return 'audio'
  if (VIDEO_EXT_SET.has(clean)) return 'video'
  return undefined
}

export function isPlayableMediaExt(ext: string): boolean {
  const kind = mediaKindForExt(ext)
  return kind === 'audio' || kind === 'video'
}

export function mimeForMediaExt(ext: string): string {
  const clean = normalizeMediaExt(ext)
  return MIME_BY_EXT[clean] ?? 'application/octet-stream'
}

export function mediaStreamUrl(token: string): string {
  return `${MEDIA_SCHEME}://view/${token}`
}

export function mediaSubtitleUrl(token: string, subId: string): string {
  return `${MEDIA_SCHEME}://sub/${token}/${subId}`
}

export function mediaCoverUrl(token: string): string {
  return `${MEDIA_SCHEME}://cover/${token}`
}

function getOrCreateViewContext(wcId: number): MediaViewContext {
  let ctx = viewContexts.get(wcId)
  if (!ctx) {
    ctx = { sessionDirs: new Set<string>(), playerMode: false }
    viewContexts.set(wcId, ctx)
  }
  return ctx
}

export function configureMediaViewContext(
  wcId: number,
  opts: { sessionDir?: string; playerMode?: boolean },
): void {
  const ctx = getOrCreateViewContext(wcId)
  if (opts.playerMode !== undefined) ctx.playerMode = opts.playerMode
  if (opts.sessionDir && opts.sessionDir.trim()) {
    ctx.sessionDirs.add(resolve(opts.sessionDir.trim()))
  }
}

/** Register or replace the single local media path bound to a WebContents view. */
export function registerMediaSession(wcId: number, filePath: string): MediaSessionEntry {
  unregisterMediaSessionByWcId(wcId)
  const resolvedPath = resolve(filePath)
  const ext = normalizeMediaExt(extname(resolvedPath))
  const mediaKind = mediaKindForExt(ext) ?? 'image'
  const token = randomUUID()
  const entry: MediaSessionEntry = {
    token,
    wcId,
    filePath: resolvedPath,
    fileName: basename(resolvedPath),
    ext,
    mediaKind,
    mime: mimeForMediaExt(ext),
    subtitles: new Map<string, MediaSubtitleEntry>(),
  }
  sessionsByToken.set(token, entry)
  tokenByWcId.set(wcId, token)
  return entry
}

/** Register or LRU-refresh a bounded transient media URL for read-only preview without touching player state. */
export function registerTransientPreviewUrl(
  filePath: string,
  mime?: string,
  ext?: string,
): string {
  const resolvedPath = resolve(filePath)
  const pathKey = normalizeMediaPathKey(resolvedPath)
  const existingToken = transientTokenByPath.get(pathKey)
  if (existingToken !== undefined && sessionsByToken.has(existingToken)) {
    const idx = transientPreviewTokens.indexOf(existingToken)
    if (idx !== -1) {
      transientPreviewTokens.splice(idx, 1)
      transientPreviewTokens.push(existingToken)
      return mediaStreamUrl(existingToken)
    }
  }

  const rawExt = typeof ext === 'string' && ext.trim() ? ext : extname(resolvedPath)
  const cleanExt = normalizeMediaExt(rawExt)
  const resolvedMime =
    typeof mime === 'string' && mime.trim()
      ? mime.trim()
      : cleanExt === 'pdf'
        ? 'application/pdf'
        : mimeForMediaExt(cleanExt)
  const token = randomUUID()
  const entry: MediaSessionEntry = {
    token,
    wcId: -1,
    filePath: resolvedPath,
    fileName: basename(resolvedPath),
    ext: cleanExt,
    mediaKind: mediaKindForExt(cleanExt) ?? 'image',
    mime: resolvedMime,
    subtitles: new Map<string, MediaSubtitleEntry>(),
  }
  sessionsByToken.set(token, entry)
  transientTokenByPath.set(pathKey, token)
  transientPreviewTokens.push(token)

  while (transientPreviewTokens.length > MAX_TRANSIENT_PREVIEW_TOKENS) {
    const evicted = transientPreviewTokens.shift()
    if (!evicted) break
    const evictedEntry = sessionsByToken.get(evicted)
    sessionsByToken.delete(evicted)
    if (evictedEntry) {
      const evictedKey = normalizeMediaPathKey(evictedEntry.filePath)
      if (transientTokenByPath.get(evictedKey) === evicted) {
        transientTokenByPath.delete(evictedKey)
      }
    }
  }

  return mediaStreamUrl(token)
}

export function unregisterMediaSessionByWcId(wcId: number): boolean {
  const token = tokenByWcId.get(wcId)
  if (!token) return false
  tokenByWcId.delete(wcId)
  sessionsByToken.delete(token)
  return true
}

export function unregisterMediaSessionByToken(token: string): boolean {
  const entry = sessionsByToken.get(token)
  if (!entry) return false
  sessionsByToken.delete(token)
  if (tokenByWcId.get(entry.wcId) === token) tokenByWcId.delete(entry.wcId)
  if (entry.wcId === -1) {
    const idx = transientPreviewTokens.indexOf(token)
    if (idx !== -1) transientPreviewTokens.splice(idx, 1)
    const pathKey = normalizeMediaPathKey(entry.filePath)
    if (transientTokenByPath.get(pathKey) === token) transientTokenByPath.delete(pathKey)
  }
  return true
}

export function clearMediaViewContext(wcId: number): void {
  viewContexts.delete(wcId)
}

export function clearMediaSessions(): void {
  sessionsByToken.clear()
  tokenByWcId.clear()
  viewContexts.clear()
  pendingSnapshots.clear()
  transientPreviewTokens.length = 0
  transientTokenByPath.clear()
}

export function mediaSessionForToken(token: string): MediaSessionEntry | undefined {
  return sessionsByToken.get(token)
}

export function mediaSessionForWebContents(wcId: number): MediaSessionEntry | undefined {
  const token = tokenByWcId.get(wcId)
  return token ? sessionsByToken.get(token) : undefined
}

export function mediaFilePathForWebContents(wcId: number): string | undefined {
  return mediaSessionForWebContents(wcId)?.filePath
}

function recordPlayedTrackInLibrary(filePath: string): void {
  const storePath = mediaLibraryStorePath()
  const resolved = resolve(filePath)
  const ext = normalizeMediaExt(extname(resolved))
  if (!isPlayableMediaExt(ext)) return
  let lib = readMediaLibrary(storePath)
  const dirKey = normalizeMediaPathKey(dirname(resolved))
  const inPersistedFolder = lib.folders.some((folder) => normalizeMediaPathKey(folder) === dirKey)
  if (!inPersistedFolder) {
    lib = addLibraryPinnedFiles(lib, [resolved])
  }
  lib = updateLibraryPlayback(lib, { lastFilePath: resolved })
  writeMediaLibrary(storePath, lib)
}

/** Parse single-range HTTP `Range: bytes=...` headers for media streaming. */
export function parseByteRange(
  rangeHeader: string | null | undefined,
  totalSize: number,
): ByteRangeParse {
  if (!Number.isFinite(totalSize) || totalSize < 0) return { kind: 'unsatisfiable' }
  if (rangeHeader === null || rangeHeader === undefined || rangeHeader.trim() === '') {
    return { kind: 'full' }
  }
  if (totalSize === 0) return { kind: 'unsatisfiable' }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim())
  if (!match) return { kind: 'unsatisfiable' }
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return { kind: 'unsatisfiable' }
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { kind: 'unsatisfiable' }
    const start = Math.max(0, totalSize - suffix)
    return { kind: 'partial', start, end: totalSize - 1 }
  }
  const start = Number(rawStart)
  if (!Number.isSafeInteger(start) || start < 0 || start >= totalSize) {
    return { kind: 'unsatisfiable' }
  }
  if (rawEnd === '') {
    return { kind: 'partial', start, end: totalSize - 1 }
  }
  const parsedEnd = Number(rawEnd)
  if (!Number.isSafeInteger(parsedEnd) || parsedEnd < start) {
    return { kind: 'unsatisfiable' }
  }
  return { kind: 'partial', start, end: Math.min(parsedEnd, totalSize - 1) }
}

function fileStreamToWeb(
  filePath: string,
  options: { start?: number; end?: number },
  signal?: AbortSignal | null,
): ReadableStream<Uint8Array> {
  const nodeStream = createReadStream(filePath, options)
  let closed = false
  const destroyStream = (): void => {
    if (!nodeStream.destroyed) nodeStream.destroy()
  }
  const onAbort = (): void => destroyStream()
  if (signal) {
    if (signal.aborted) destroyStream()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on('data', (chunk: string | Buffer) => {
        if (closed) return
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
        try {
          controller.enqueue(new Uint8Array(buf))
        } catch {
          closed = true
          destroyStream()
          return
        }
        if ((controller.desiredSize ?? 1) <= 0) nodeStream.pause()
      })
      nodeStream.once('end', () => {
        signal?.removeEventListener('abort', onAbort)
        if (!closed) {
          closed = true
          try {
            controller.close()
          } catch {
            // Stream already closed or canceled by consumer.
          }
        }
      })
      nodeStream.once('error', (err) => {
        signal?.removeEventListener('abort', onAbort)
        if (!closed) {
          closed = true
          try {
            controller.error(err)
          } catch {
            // Stream already closed or canceled by consumer.
          }
        }
      })
      nodeStream.once('close', () => {
        signal?.removeEventListener('abort', onAbort)
      })
    },
    pull() {
      if (!closed && nodeStream.isPaused()) nodeStream.resume()
    },
    cancel() {
      closed = true
      signal?.removeEventListener('abort', onAbort)
      destroyStream()
    },
  })
}

type ParsedMediaRequest =
  | { kind: 'view'; token: string }
  | { kind: 'sub'; token: string; subId: string }
  | { kind: 'cover'; token: string }

function parseMediaRequestUrl(rawUrl: string): ParsedMediaRequest | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${MEDIA_SCHEME}:`) return null
  const segments = url.pathname.replace(/^\/+/, '').split('/').filter(Boolean)
  if (url.hostname === 'view' && segments.length === 1) {
    return { kind: 'view', token: segments[0]! }
  }
  if (url.hostname === 'cover' && segments.length === 1) {
    return { kind: 'cover', token: segments[0]! }
  }
  if (url.hostname === 'sub' && segments.length === 2) {
    return { kind: 'sub', token: segments[0]!, subId: segments[1]! }
  }
  return null
}

/** Handle `genoffice-media://view/<token>`, `genoffice-media://cover/<token>`, and `genoffice-media://sub/<token>/<subId>` securely. */
export function registerMediaProtocol(): void {
  if (protocolRegistered) return
  protocolRegistered = true
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const parsedReq = parseMediaRequestUrl(request.url)
    if (!parsedReq) return new Response(null, { status: 404 })
    const entry = sessionsByToken.get(parsedReq.token)
    if (!entry) return new Response(null, { status: 404 })

    const method = request.method.toUpperCase()
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'Range',
          'Access-Control-Max-Age': '600',
        },
      })
    }
    if (method !== 'GET' && method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD, OPTIONS' } })
    }

    if (parsedReq.kind === 'cover') {
      if (!entry.cover) return new Response(null, { status: 404 })
      const headers = {
        'Content-Type': entry.cover.mime,
        'Content-Length': String(entry.cover.data.length),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': '*',
      }
      if (method === 'HEAD') return new Response(null, { status: 200, headers })
      return new Response(new Uint8Array(entry.cover.data), { status: 200, headers })
    }

    if (parsedReq.kind === 'sub') {
      const subEntry = entry.subtitles.get(parsedReq.subId)
      if (!subEntry) return new Response(null, { status: 404 })
      try {
        const raw = await readFile(subEntry.filePath, 'utf8')
        const vtt = subEntry.ext === 'srt' ? srtToWebVtt(raw) : raw
        const headers = {
          'Content-Type': 'text/vtt; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Access-Control-Allow-Origin': '*',
        }
        if (method === 'HEAD') return new Response(null, { status: 200, headers })
        return new Response(vtt, { status: 200, headers })
      } catch {
        return new Response(null, { status: 404 })
      }
    }

    let size = 0
    try {
      const info = await stat(entry.filePath)
      if (!info.isFile()) return new Response(null, { status: 404 })
      size = info.size
    } catch {
      return new Response(null, { status: 404 })
    }

    const parsed = parseByteRange(request.headers.get('range'), size)
    if (parsed.kind === 'unsatisfiable') {
      return new Response(null, {
        status: 416,
        headers: {
          'Content-Range': `bytes */${size}`,
          'Accept-Ranges': 'bytes',
        },
      })
    }

    const securityHeaders: Record<string, string> = {
      'Content-Type': entry.mime,
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
      ...(entry.ext === 'svg' ? { 'Content-Security-Policy': 'sandbox' } : {}),
    }

    if (parsed.kind === 'partial') {
      const { start, end } = parsed
      const length = end - start + 1
      const headers = {
        ...securityHeaders,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(length),
      }
      if (method === 'HEAD') return new Response(null, { status: 206, headers })
      return new Response(fileStreamToWeb(entry.filePath, { start, end }, request.signal), {
        status: 206,
        headers,
      })
    }

    const headers = {
      ...securityHeaders,
      'Content-Length': String(size),
    }
    if (method === 'HEAD' || size === 0) return new Response(null, { status: 200, headers })
    return new Response(fileStreamToWeb(entry.filePath, {}, request.signal), {
      status: 200,
      headers,
    })
  })
}

async function safeRealpath(targetPath: string): Promise<string | null> {
  try {
    return await realpath(targetPath)
  } catch {
    return null
  }
}

/** Scan one directory (shallow) for playable audio/video files sorted naturally by name. */
export async function scanDirectoryMedia(
  dirPath: string,
  source: 'session' | 'folder' = 'folder',
  maxItems = MAX_DIR_SCAN_ITEMS,
): Promise<{ items: MediaPlaylistItem[]; missing: boolean }> {
  const resolvedDir = resolve(dirPath)
  let dirStat: Awaited<ReturnType<typeof stat>>
  try {
    dirStat = await stat(resolvedDir)
  } catch {
    return { items: [], missing: true }
  }
  if (!dirStat.isDirectory()) return { items: [], missing: true }

  let dirents: Dirent<string>[]
  try {
    dirents = await readdir(resolvedDir, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return { items: [], missing: true }
  }

  const realDir = (await safeRealpath(resolvedDir)) ?? resolvedDir
  const realDirKey = normalizeMediaPathKey(realDir)

  const candidates = dirents
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => ({
      name: entry.name,
      ext: normalizeMediaExt(extname(entry.name)),
    }))
    .filter((entry) => isPlayableMediaExt(entry.ext))
    .sort((a, b) => naturalCompareMediaName(a.name, b.name))
    .slice(0, maxItems)

  const dirName = basename(resolvedDir) || resolvedDir
  const results = await Promise.all(
    candidates.map(async ({ name, ext }): Promise<MediaPlaylistItem | null> => {
      const fullPath = join(resolvedDir, name)
      try {
        const fileStat = await stat(fullPath)
        if (!fileStat.isFile()) return null
        const realFile = (await safeRealpath(fullPath)) ?? fullPath
        if (normalizeMediaPathKey(dirname(realFile)) !== realDirKey) {
          return null
        }
        const mediaKind = mediaKindForExt(ext)
        if (mediaKind !== 'audio' && mediaKind !== 'video') return null
        return {
          filePath: fullPath,
          fileName: name,
          ext,
          mediaKind,
          mime: mimeForMediaExt(ext),
          sizeBytes: fileStat.size,
          dirPath: resolvedDir,
          dirName,
          source,
        }
      } catch {
        return null
      }
    }),
  )

  return {
    items: results.filter((item): item is MediaPlaylistItem => item !== null),
    missing: false,
  }
}

/** Find matching `.vtt` / `.srt` sidecar subtitle files alongside a video file. */
export async function discoverSidecarSubtitles(
  videoPath: string,
  token: string,
): Promise<{ tracks: MediaSubtitleTrack[]; entries: Map<string, MediaSubtitleEntry> }> {
  const tracks: MediaSubtitleTrack[] = []
  const entries = new Map<string, MediaSubtitleEntry>()
  const dir = dirname(videoPath)
  const file = basename(videoPath)
  const stem = file.slice(0, file.length - extname(file).length).toLowerCase()
  if (!stem) return { tracks, entries }

  let dirents: Dirent<string>[]
  try {
    dirents = await readdir(dir, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return { tracks, entries }
  }

  const matches = dirents
    .filter((d) => d.isFile())
    .map((d) => {
      const name = d.name
      const ext = normalizeMediaExt(extname(name))
      if (ext !== 'vtt' && ext !== 'srt') return null
      const subStem = name.slice(0, name.length - extname(name).length)
      const subLower = subStem.toLowerCase()
      if (subLower !== stem && !subLower.startsWith(`${stem}.`)) return null
      const suffix = subStem.slice(stem.length).replace(/^\.+/, '').trim()
      return {
        name,
        ext: ext as 'vtt' | 'srt',
        label: suffix || name,
        filePath: join(dir, name),
      }
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => naturalCompareMediaName(a.name, b.name))

  matches.forEach((item, index) => {
    const id = `s${index + 1}`
    entries.set(id, { id, filePath: item.filePath, label: item.label, ext: item.ext })
    tracks.push({
      id,
      label: item.label,
      url: mediaSubtitleUrl(token, id),
      ext: item.ext,
    })
  })
  return { tracks, entries }
}

/**
 * Authorize switching to `candidatePath` from `wcId`: only playable audio/video
 * inside an authorized directory (sessionDirs or persisted folders) or pinned
 * files is allowed, and symlinks escaping outside are rejected.
 */
export async function isAuthorizedMediaPath(
  wcId: number,
  candidatePath: string,
  library?: MediaLibraryStoreData,
): Promise<string | null> {
  if (typeof candidatePath !== 'string' || !candidatePath.trim()) return null
  const resolved = resolve(candidatePath.trim())
  const ext = normalizeMediaExt(extname(resolved))
  if (!isPlayableMediaExt(ext)) return null

  let infoStat: Awaited<ReturnType<typeof stat>>
  try {
    infoStat = await stat(resolved)
    if (!infoStat.isFile()) return null
  } catch {
    return null
  }
  const realTarget = await safeRealpath(resolved)
  if (!realTarget) return null

  const lib = library ?? readMediaLibrary(mediaLibraryStorePath())
  const ctx = viewContexts.get(wcId)
  const dirCandidates = new Set<string>([
    ...lib.folders.map((f) => resolve(f)),
    ...(ctx ? Array.from(ctx.sessionDirs) : []),
  ])

  const authorizedDirKeys = new Set<string>()
  await Promise.all(
    Array.from(dirCandidates).map(async (dir) => {
      const realDir = await safeRealpath(dir)
      if (realDir) authorizedDirKeys.add(normalizeMediaPathKey(realDir))
    }),
  )

  const targetDirKey = normalizeMediaPathKey(dirname(realTarget))
  if (authorizedDirKeys.has(targetDirKey)) {
    return resolved
  }

  const targetKey = normalizeMediaPathKey(realTarget)
  for (const pinned of lib.pinnedFiles) {
    const realPinned = await safeRealpath(pinned)
    if (realPinned && normalizeMediaPathKey(realPinned) === targetKey) {
      return resolved
    }
  }
  return null
}

async function buildMediaInfoForEntry(entry: MediaSessionEntry): Promise<MediaInfo> {
  let sizeBytes = 0
  try {
    const info = await stat(entry.filePath)
    if (info.isFile()) sizeBytes = info.size
  } catch {
    // Keep sizeBytes=0 so the renderer can display a friendly load error.
  }
  return {
    token: entry.token,
    streamUrl: mediaStreamUrl(entry.token),
    filePath: entry.filePath,
    fileName: entry.fileName,
    ext: entry.ext,
    mediaKind: entry.mediaKind,
    mime: entry.mime,
    sizeBytes,
  }
}

/** Build the complete player snapshot for a view, scanning directories and restoring tracks. */
export async function buildMediaPlayerState(
  wcId: number,
  requestedToken?: string,
): Promise<MediaPlayerStateSnapshot> {
  const token =
    typeof requestedToken === 'string' && requestedToken.trim()
      ? requestedToken.trim()
      : tokenByWcId.get(wcId)
  let entry = token ? sessionsByToken.get(token) : undefined
  if (entry && entry.wcId !== wcId) entry = undefined

  const ctx = getOrCreateViewContext(wcId)
  const library = readMediaLibrary(mediaLibraryStorePath())

  if (entry && entry.mediaKind === 'image' && !ctx.playerMode) {
    const current = await buildMediaInfoForEntry(entry)
    return {
      current,
      subtitles: [],
      items: [],
      folders: [],
      prefs: library.prefs,
      resumePositionSec: 0,
      playerMode: false,
    }
  }

  ctx.playerMode = true
  const persistedDirKeys = new Set(library.folders.map(normalizeMediaPathKey))
  const orderedDirs: Array<{ path: string; persisted: boolean }> = []
  const seenDirKeys = new Set<string>()

  for (const folder of library.folders) {
    const key = normalizeMediaPathKey(folder)
    if (seenDirKeys.has(key)) continue
    seenDirKeys.add(key)
    orderedDirs.push({ path: folder, persisted: true })
  }
  for (const sessionDir of ctx.sessionDirs) {
    const key = normalizeMediaPathKey(sessionDir)
    if (seenDirKeys.has(key)) continue
    seenDirKeys.add(key)
    orderedDirs.push({ path: sessionDir, persisted: persistedDirKeys.has(key) })
  }

  const scanned = await Promise.all(
    orderedDirs.map(async (dir) => ({
      dir,
      scan: await scanDirectoryMedia(dir.path, dir.persisted ? 'folder' : 'session'),
    })),
  )

  const items: MediaPlaylistItem[] = []
  const seenItemKeys = new Set<string>()
  const folders: MediaFolderEntry[] = []

  for (const { dir, scan } of scanned) {
    folders.push({
      path: dir.path,
      name: basename(dir.path) || dir.path,
      count: scan.items.length,
      persisted: dir.persisted,
      ...(scan.missing ? { missing: true } : {}),
    })
    for (const item of scan.items) {
      const key = normalizeMediaPathKey(item.filePath)
      if (seenItemKeys.has(key)) continue
      seenItemKeys.add(key)
      items.push(item)
    }
  }

  // Merge standalone persisted files (unless already represented by a scanned directory).
  const pinnedResults = await Promise.all(
    library.pinnedFiles.map(async (pinnedPath): Promise<MediaPlaylistItem | null> => {
      const key = normalizeMediaPathKey(pinnedPath)
      if (seenItemKeys.has(key)) return null
      const ext = normalizeMediaExt(extname(pinnedPath))
      const mediaKind = mediaKindForExt(ext)
      if (mediaKind !== 'audio' && mediaKind !== 'video') return null
      try {
        const st = await stat(pinnedPath)
        if (!st.isFile()) return null
        return {
          filePath: pinnedPath,
          fileName: basename(pinnedPath),
          ext,
          mediaKind,
          mime: mimeForMediaExt(ext),
          sizeBytes: st.size,
          dirPath: dirname(pinnedPath),
          dirName: basename(dirname(pinnedPath)) || dirname(pinnedPath),
          source: 'pinned',
        }
      } catch {
        return null
      }
    }),
  )
  for (const pinnedItem of pinnedResults) {
    if (!pinnedItem) continue
    const key = normalizeMediaPathKey(pinnedItem.filePath)
    if (seenItemKeys.has(key)) continue
    seenItemKeys.add(key)
    items.push(pinnedItem)
  }

  // Standalone launcher startup: restore lastFilePath if available, else fall back to items[0].
  if (!entry && items.length > 0) {
    const preferred =
      (library.lastFilePath
        ? items.find((item) => normalizeMediaPathKey(item.filePath) === normalizeMediaPathKey(library.lastFilePath!))
        : undefined) ?? items[0]!
    entry = registerMediaSession(wcId, preferred.filePath)
    if (library.lastFilePath !== entry.filePath) {
      const updated = updateLibraryPlayback(library, { lastFilePath: entry.filePath })
      writeMediaLibrary(mediaLibraryStorePath(), updated)
    }
    mediaFileChangedHook?.(wcId, entry.filePath)
  }

  let current: MediaInfo | null = null
  let subtitles: MediaSubtitleTrack[] = []
  let resumePositionSec = 0
  let audioMeta: MediaAudioMetadata | undefined

  if (entry) {
    current = await buildMediaInfoForEntry(entry)
    resumePositionSec = resumePositionForPath(library, entry.filePath)
    if (entry.mediaKind === 'video') {
      entry.cover = undefined
      const subResult = await discoverSidecarSubtitles(entry.filePath, entry.token)
      entry.subtitles = subResult.entries
      subtitles = subResult.tracks
    } else if (entry.mediaKind === 'audio') {
      entry.subtitles.clear()
      try {
        const extracted = await extractAudioMetadata(entry.filePath)
        entry.cover = extracted.cover
        audioMeta = {
          ...(extracted.title ? { title: extracted.title } : {}),
          ...(extracted.artist ? { artist: extracted.artist } : {}),
          ...(extracted.album ? { album: extracted.album } : {}),
          ...(extracted.sampleRateHz ? { sampleRateHz: extracted.sampleRateHz } : {}),
          ...(extracted.bitDepth ? { bitDepth: extracted.bitDepth } : {}),
          ...(extracted.cover ? { coverUrl: mediaCoverUrl(entry.token) } : {}),
          ...(extracted.lyrics ? { lyrics: extracted.lyrics } : {}),
        }
      } catch {
        entry.cover = undefined
      }
    } else {
      entry.cover = undefined
      entry.subtitles.clear()
    }
  }

  return {
    current,
    subtitles,
    items,
    folders,
    prefs: library.prefs,
    resumePositionSec,
    playerMode: true,
    ...(audioMeta ? { audioMeta } : {}),
  }
}

/** Switch an open media view to an authorized audio/video track and sync its tab metadata. */
export async function switchMediaTrackForView(
  wcId: number,
  candidatePath: string,
): Promise<MediaStateMutationResult> {
  const authorized = await isAuthorizedMediaPath(wcId, candidatePath)
  if (!authorized) {
    return { ok: false, error: 'Media path is not authorized or no longer exists.' }
  }
  configureMediaViewContext(wcId, { playerMode: true })
  const entry = registerMediaSession(wcId, authorized)
  recordPlayedTrackInLibrary(entry.filePath)
  mediaFileChangedHook?.(wcId, entry.filePath)
  const state = await buildMediaPlayerState(wcId, entry.token)
  return { ok: true, state }
}

export async function addMediaFoldersForView(
  wcId: number,
  dirPaths: readonly string[],
): Promise<MediaStateMutationResult> {
  const storePath = mediaLibraryStorePath()
  let lib = readMediaLibrary(storePath)
  const validDirs: string[] = []
  for (const raw of dirPaths) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    const resolved = resolve(raw.trim())
    try {
      const info = await stat(resolved)
      if (info.isDirectory()) validDirs.push(resolved)
    } catch {
      // Ignore unreachable directory.
    }
  }
  if (validDirs.length === 0) {
    const state = await buildMediaPlayerState(wcId)
    return { ok: false, added: 0, state, error: 'No valid directory selected.' }
  }
  lib = addLibraryFolders(lib, validDirs)
  writeMediaLibrary(storePath, lib)

  configureMediaViewContext(wcId, { playerMode: true })
  const state = await buildMediaPlayerState(wcId)
  return { ok: true, added: validDirs.length, state }
}

export async function addMediaFilesForView(
  wcId: number,
  filePaths: readonly string[],
): Promise<MediaStateMutationResult> {
  const validFiles: string[] = []
  for (const raw of filePaths) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    const resolved = resolve(raw.trim())
    if (!isPlayableMediaExt(extname(resolved))) continue
    try {
      const info = await stat(resolved)
      if (info.isFile()) validFiles.push(resolved)
    } catch {
      // Skip non-existent files.
    }
  }
  if (validFiles.length === 0) {
    const state = await buildMediaPlayerState(wcId)
    return { ok: false, added: 0, state, error: 'No supported audio or video files selected.' }
  }

  const storePath = mediaLibraryStorePath()
  let lib = readMediaLibrary(storePath)
  const folderKeys = new Set(lib.folders.map(normalizeMediaPathKey))
  const toPin = validFiles.filter((f) => !folderKeys.has(normalizeMediaPathKey(dirname(f))))
  if (toPin.length > 0) {
    lib = addLibraryPinnedFiles(lib, toPin)
  }
  lib = updateLibraryPlayback(lib, { lastFilePath: validFiles[0]! })
  writeMediaLibrary(storePath, lib)

  configureMediaViewContext(wcId, { playerMode: true })
  const entry = registerMediaSession(wcId, validFiles[0]!)
  mediaFileChangedHook?.(wcId, entry.filePath)
  const state = await buildMediaPlayerState(wcId, entry.token)
  return { ok: true, added: validFiles.length, state }
}

export async function importDroppedMediaForView(
  wcId: number,
  rawPaths: readonly string[],
): Promise<MediaStateMutationResult> {
  const dirs: string[] = []
  const files: string[] = []
  for (const raw of rawPaths) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    const resolved = resolve(raw.trim())
    try {
      const info = await stat(resolved)
      if (info.isDirectory()) {
        dirs.push(resolved)
      } else if (info.isFile() && isPlayableMediaExt(extname(resolved))) {
        files.push(resolved)
      }
    } catch {
      // Ignore invalid or unreachable paths.
    }
  }

  if (dirs.length === 0 && files.length === 0) {
    const state = await buildMediaPlayerState(wcId)
    return { ok: false, added: 0, state, error: 'No supported folders or audio/video files dropped.' }
  }

  const storePath = mediaLibraryStorePath()
  let lib = readMediaLibrary(storePath)
  if (dirs.length > 0) lib = addLibraryFolders(lib, dirs)
  const folderKeys = new Set(lib.folders.map(normalizeMediaPathKey))
  const toPin = files.filter((f) => !folderKeys.has(normalizeMediaPathKey(dirname(f))))
  if (toPin.length > 0) lib = addLibraryPinnedFiles(lib, toPin)
  writeMediaLibrary(storePath, lib)

  configureMediaViewContext(wcId, { playerMode: true })

  let nextTrack: string | null = files[0] ?? null
  if (!nextTrack) {
    for (const dir of dirs) {
      const scan = await scanDirectoryMedia(dir, 'folder')
      if (scan.items.length > 0) {
        nextTrack = scan.items[0]!.filePath
        break
      }
    }
  }
  if (nextTrack) {
    const entry = registerMediaSession(wcId, nextTrack)
    recordPlayedTrackInLibrary(entry.filePath)
    mediaFileChangedHook?.(wcId, entry.filePath)
  }

  const state = await buildMediaPlayerState(wcId)
  return { ok: true, added: dirs.length + files.length, state }
}

export async function pinSessionFolderForView(
  wcId: number,
  dirPath: string,
): Promise<MediaStateMutationResult> {
  if (typeof dirPath !== 'string' || !dirPath.trim()) {
    return { ok: false, error: 'Invalid directory path.' }
  }
  const resolved = resolve(dirPath.trim())
  const ctx = viewContexts.get(wcId)
  const key = normalizeMediaPathKey(resolved)
  const inSession = ctx
    ? Array.from(ctx.sessionDirs).some((d) => normalizeMediaPathKey(d) === key)
    : false
  const storePath = mediaLibraryStorePath()
  let lib = readMediaLibrary(storePath)
  const alreadyPersisted = lib.folders.some((f) => normalizeMediaPathKey(f) === key)
  if (!inSession && !alreadyPersisted) {
    return { ok: false, error: 'Only an active session directory can be pinned.' }
  }
  lib = addLibraryFolders(lib, [resolved])
  writeMediaLibrary(storePath, lib)
  const state = await buildMediaPlayerState(wcId)
  return { ok: true, state }
}

export async function removePersistedFolderForView(
  wcId: number,
  dirPath: string,
): Promise<MediaStateMutationResult> {
  if (typeof dirPath !== 'string' || !dirPath.trim()) {
    return { ok: false, error: 'Invalid directory path.' }
  }
  const resolved = resolve(dirPath.trim())
  const storePath = mediaLibraryStorePath()
  const lib = removeLibraryFolder(readMediaLibrary(storePath), resolved)
  writeMediaLibrary(storePath, lib)

  const ctx = viewContexts.get(wcId)
  if (ctx) {
    for (const dir of Array.from(ctx.sessionDirs)) {
      if (normalizeMediaPathKey(dir) === normalizeMediaPathKey(resolved)) {
        ctx.sessionDirs.delete(dir)
      }
    }
  }
  const state = await buildMediaPlayerState(wcId)
  return { ok: true, state }
}

export async function removePinnedFileForView(
  wcId: number,
  filePath: string,
): Promise<MediaStateMutationResult> {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return { ok: false, error: 'Invalid file path.' }
  }
  const resolved = resolve(filePath.trim())
  const storePath = mediaLibraryStorePath()
  const lib = removeLibraryPinnedFile(readMediaLibrary(storePath), resolved)
  writeMediaLibrary(storePath, lib)
  const state = await buildMediaPlayerState(wcId)
  return { ok: true, state }
}

/** Register renderer-facing media IPC channels once per main-process run. */
export function registerMediaIpc(): void {
  if (ipcRegistered) return
  ipcRegistered = true

  ipcMain.handle(
    HOME_CHANNELS.mediaGetInfo,
    async (event, rawToken: unknown): Promise<MediaInfo | null> => {
      const token = typeof rawToken === 'string' ? rawToken.trim() : ''
      if (!token) return null
      const entry = sessionsByToken.get(token)
      if (!entry || entry.wcId !== event.sender.id) return null
      return buildMediaInfoForEntry(entry)
    },
  )

  ipcMain.handle(
    HOME_CHANNELS.mediaPlayerState,
    async (event, rawToken: unknown): Promise<MediaPlayerStateSnapshot> => {
      const token = typeof rawToken === 'string' ? rawToken.trim() : undefined
      return buildMediaPlayerState(event.sender.id, token)
    },
  )

  ipcMain.handle(
    HOME_CHANNELS.mediaSwitchTrack,
    async (event, rawPath: unknown): Promise<MediaStateMutationResult> => {
      if (typeof rawPath !== 'string') return { ok: false, error: 'Invalid track path.' }
      return switchMediaTrackForView(event.sender.id, rawPath)
    },
  )

  ipcMain.handle(
    HOME_CHANNELS.mediaAddFolder,
    async (event): Promise<MediaStateMutationResult> => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const options = { properties: ['openDirectory', 'multiSelections'] as Array<'openDirectory' | 'multiSelections'> }
      const picked = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (picked.canceled || picked.filePaths.length === 0) {
        return { ok: false, cancelled: true }
      }
      return addMediaFoldersForView(event.sender.id, picked.filePaths)
    },
  )

  ipcMain.handle(
    HOME_CHANNELS.mediaAddFiles,
    async (event): Promise<MediaStateMutationResult> => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const options = {
        properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
        filters: [
          {
            name: 'Audio & Video',
            extensions: [...AUDIO_MEDIA_EXTS, ...VIDEO_MEDIA_EXTS],
          },
        ],
      }
      const picked = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (picked.canceled || picked.filePaths.length === 0) {
        return { ok: false, cancelled: true }
      }
      return addMediaFilesForView(event.sender.id, picked.filePaths)
    },
  )

  ipcMain.handle(
    HOME_CHANNELS.mediaPinFolder,
    async (event, rawDir: unknown): Promise<MediaStateMutationResult> => {
      if (typeof rawDir !== 'string') return { ok: false, error: 'Invalid directory path.' }
      return pinSessionFolderForView(event.sender.id, rawDir)
    },
  )

  ipcMain.handle(
    HOME_CHANNELS.mediaRemoveFolder,
    async (event, rawDir: unknown): Promise<MediaStateMutationResult> => {
      if (typeof rawDir !== 'string') return { ok: false, error: 'Invalid directory path.' }
      return removePersistedFolderForView(event.sender.id, rawDir)
    },
  )

  ipcMain.handle(
    HOME_CHANNELS.mediaRemovePinnedFile,
    async (event, rawFile: unknown): Promise<MediaStateMutationResult> => {
      if (typeof rawFile !== 'string') return { ok: false, error: 'Invalid file path.' }
      return removePinnedFileForView(event.sender.id, rawFile)
    },
  )

  ipcMain.handle(
    HOME_CHANNELS.mediaImportDropped,
    async (event, rawPaths: unknown): Promise<MediaStateMutationResult> => {
      const list = Array.isArray(rawPaths)
        ? rawPaths.filter((p): p is string => typeof p === 'string')
        : []
      return importDroppedMediaForView(event.sender.id, list)
    },
  )

  ipcMain.handle(
    HOME_CHANNELS.mediaSavePrefs,
    (_event, rawPatch: unknown): { ok: boolean } => {
      if (!rawPatch || typeof rawPatch !== 'object') return { ok: false }
      const patch = rawPatch as MediaSavePrefsPatch
      const storePath = mediaLibraryStorePath()
      const next = updateLibraryPlayback(readMediaLibrary(storePath), patch)
      writeMediaLibrary(storePath, next)
      return { ok: true }
    },
  )

  ipcMain.handle(
    HOME_CHANNELS.mediaOpenSystem,
    async (event): Promise<{ ok: boolean; error?: string }> => {
      const entry = mediaSessionForWebContents(event.sender.id)
      if (!entry) return { ok: false, error: 'Media session is no longer active.' }
      const errMsg = await shell.openPath(entry.filePath)
      return errMsg ? { ok: false, error: errMsg } : { ok: true }
    },
  )

  ipcMain.on(HOME_CHANNELS.mediaReadSnapshotReply, (event, rawReply: unknown) => {
    const reply = (rawReply && typeof rawReply === 'object' ? rawReply : null) as
      | MediaSnapshotReply
      | null
    if (!reply || typeof reply.requestId !== 'string') return
    const waiter = pendingSnapshots.get(reply.requestId)
    if (!waiter || waiter.wcId !== event.sender.id) return
    pendingSnapshots.delete(reply.requestId)
    waiter.resolve({
      text: typeof reply.text === 'string' ? reply.text : '',
      ...(Array.isArray(reply.images) && reply.images.length > 0 ? { images: reply.images } : {}),
    })
  })
}

/** Prepare a media session and playback context for an existing WebContents (e.g. desktop player). */
export function prepareMediaSessionForWebContents(
  wcId: number,
  filePath?: string,
): MediaSessionEntry | undefined {
  registerMediaProtocol()
  registerMediaIpc()

  let entry: MediaSessionEntry | undefined
  if (filePath) {
    entry = registerMediaSession(wcId, filePath)
    if (entry.mediaKind === 'audio' || entry.mediaKind === 'video') {
      configureMediaViewContext(wcId, {
        sessionDir: dirname(entry.filePath),
        playerMode: true,
      })
      recordPlayedTrackInLibrary(entry.filePath)
    } else {
      configureMediaViewContext(wcId, { playerMode: false })
    }
    return entry
  }

  configureMediaViewContext(wcId, { playerMode: true })
  const existing = mediaSessionForWebContents(wcId)
  if (existing && isPlayableMediaExt(existing.ext)) {
    return existing
  }
  const lib = readMediaLibrary(mediaLibraryStorePath())
  if (lib.lastFilePath && existsSync(lib.lastFilePath)) {
    const ext = normalizeMediaExt(extname(lib.lastFilePath))
    if (isPlayableMediaExt(ext)) {
      entry = registerMediaSession(wcId, lib.lastFilePath)
    }
  }
  return entry
}

/** Clear any media session and context associated with a WebContents. */
export function clearMediaSessionForWebContents(wcId: number): void {
  unregisterMediaSessionByWcId(wcId)
  clearMediaViewContext(wcId)
}

export function createMediaView(filePath?: string): WebContentsView {
  registerMediaProtocol()
  registerMediaIpc()
  const view = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  view.webContents.setWindowOpenHandler(({ url }) => {
    const target = safeExternalUrl(url)
    if (target) void shell.openExternal(target)
    return { action: 'deny' }
  })
  const wcId = view.webContents.id
  const entry = prepareMediaSessionForWebContents(wcId, filePath)

  view.webContents.once('destroyed', () => {
    clearMediaSessionForWebContents(wcId)
  })
  void view.webContents.loadURL(
    rendererUrl(process.env.ELECTRON_RENDERER_URL, 'help', {
      view: 'media',
      ...(entry ? { token: entry.token } : {}),
      ...(!filePath ? { mode: 'player' } : {}),
    }),
  )
  return view
}

export function requestMediaClose(): Promise<boolean> {
  return Promise.resolve(true)
}

function fallbackMetadataText(wcId: number, reason: string): string {
  const entry = mediaSessionForWebContents(wcId)
  if (!entry) return `Media metadata unavailable (${reason}).`
  return [
    `File: ${entry.fileName}`,
    `Path: ${entry.filePath}`,
    `Kind: ${entry.mediaKind} (.${entry.ext}, ${entry.mime})`,
    `Note: ${reason}`,
  ].join('\n')
}

/** Request current image/video/audio snapshot & metadata from a mounted media view. */
export function mediaReadSnapshot(
  contents: WebContents,
  opts?: { timestampSec?: number },
): Promise<MediaSnapshotResult> {
  if (contents.isDestroyed()) {
    return Promise.reject(new Error('the media tab is no longer open'))
  }
  const wcId = contents.id
  const requestId = randomUUID()
  const timestampSec =
    typeof opts?.timestampSec === 'number' &&
    Number.isFinite(opts.timestampSec) &&
    opts.timestampSec >= 0
      ? opts.timestampSec
      : undefined
  const payload = { requestId, ...(timestampSec !== undefined ? { timestampSec } : {}) }

  return new Promise<MediaSnapshotResult>((resolvePromise) => {
    let settled = false
    const settle = (result: MediaSnapshotResult): void => {
      if (settled) return
      settled = true
      clearInterval(retry)
      clearTimeout(timer)
      pendingSnapshots.delete(requestId)
      resolvePromise(result)
    }
    const retry = setInterval(() => {
      if (contents.isDestroyed()) {
        settle({ text: fallbackMetadataText(wcId, 'media tab closed while reading') })
        return
      }
      contents.send(HOME_CHANNELS.mediaReadSnapshotRequest, payload)
    }, 250)
    const timer = setTimeout(() => {
      settle({
        text: fallbackMetadataText(
          wcId,
          'viewer snapshot timed out; check whether the media finished loading',
        ),
      })
    }, 15_000)

    pendingSnapshots.set(requestId, { wcId, resolve: settle })
    contents.send(HOME_CHANNELS.mediaReadSnapshotRequest, payload)
  })
}
