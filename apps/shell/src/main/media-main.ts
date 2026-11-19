import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { ipcMain, protocol, shell, WebContentsView } from 'electron'
import type { WebContents } from 'electron'
import { MEDIA_SCHEME, rendererUrl, safeExternalUrl } from '@genoffice/electron-utils'
import {
  HOME_CHANNELS,
  type MediaInfo,
  type MediaKind,
  type MediaSnapshotImage,
  type MediaSnapshotReply,
} from '../shared/home-api'

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

export interface MediaSessionEntry {
  token: string
  wcId: number
  filePath: string
  fileName: string
  ext: string
  mediaKind: MediaKind
  mime: string
}

export interface MediaSnapshotResult {
  text: string
  images?: MediaSnapshotImage[]
}

export type ByteRangeParse =
  | { kind: 'full' }
  | { kind: 'unsatisfiable' }
  | { kind: 'partial'; start: number; end: number }

const sessionsByToken = new Map<string, MediaSessionEntry>()
const tokenByWcId = new Map<number, string>()

interface PendingSnapshotWaiter {
  wcId: number
  resolve: (result: MediaSnapshotResult) => void
}
const pendingSnapshots = new Map<string, PendingSnapshotWaiter>()

let protocolRegistered = false
let ipcRegistered = false

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

export function mimeForMediaExt(ext: string): string {
  const clean = normalizeMediaExt(ext)
  return MIME_BY_EXT[clean] ?? 'application/octet-stream'
}

export function mediaStreamUrl(token: string): string {
  return `${MEDIA_SCHEME}://view/${token}`
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
  }
  sessionsByToken.set(token, entry)
  tokenByWcId.set(wcId, token)
  return entry
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
  return true
}

export function clearMediaSessions(): void {
  sessionsByToken.clear()
  tokenByWcId.clear()
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

function tokenFromMediaRequestUrl(rawUrl: string): string | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${MEDIA_SCHEME}:` || url.hostname !== 'view') return null
  const segments = url.pathname.replace(/^\/+/, '').split('/').filter(Boolean)
  return segments.length === 1 ? segments[0]! : null
}

/** Handle `genoffice-media://view/<token>` with strict token lookup and HTTP Range support. */
export function registerMediaProtocol(): void {
  if (protocolRegistered) return
  protocolRegistered = true
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const token = tokenFromMediaRequestUrl(request.url)
    const entry = token ? sessionsByToken.get(token) : undefined
    if (!entry) return new Response(null, { status: 404 })

    const method = request.method.toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
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
  const entry = filePath ? registerMediaSession(wcId, filePath) : undefined
  view.webContents.once('destroyed', () => {
    unregisterMediaSessionByWcId(wcId)
  })
  void view.webContents.loadURL(
    rendererUrl(process.env.ELECTRON_RENDERER_URL, 'help', {
      view: 'media',
      ...(entry ? { token: entry.token } : {}),
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
