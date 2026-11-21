import { open, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import type { MediaLyricLine } from '../shared/home-api'
import { normalizeMediaPathKey } from './media-library'

export const MAX_AUDIO_HEADER_BYTES = 8 * 1024 * 1024
export const MAX_COVER_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_LRC_BYTES = 512 * 1024

const ALLOWED_COVER_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const SIDECAR_IMAGE_EXTS = [
  { ext: 'jpg', mime: 'image/jpeg' },
  { ext: 'jpeg', mime: 'image/jpeg' },
  { ext: 'png', mime: 'image/png' },
  { ext: 'webp', mime: 'image/webp' },
] as const

export interface ExtractedCoverArt {
  data: Buffer
  mime: string
}

export interface ExtractedAudioMetadata {
  title?: string
  artist?: string
  album?: string
  sampleRateHz?: number
  bitDepth?: number
  cover?: ExtractedCoverArt
  lyrics?: MediaLyricLine[]
}

function canonicalCoverMime(raw: string): string | null {
  const clean = raw.trim().toLowerCase()
  if (clean === 'image/jpg' || clean === 'jpg' || clean === 'jpeg') return 'image/jpeg'
  if (clean === 'png') return 'image/png'
  if (clean === 'webp') return 'image/webp'
  if (clean === 'gif') return 'image/gif'
  return ALLOWED_COVER_MIMES.has(clean) ? clean : null
}

function swapUtf16Pairs(buf: Buffer): Buffer {
  const len = buf.length - (buf.length % 2)
  const out = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i += 2) {
    out[i] = buf[i + 1]!
    out[i + 1] = buf[i]!
  }
  return out
}

function decodeTextWithBomUtf16(slice: Buffer, bigEndianDefault = false): string {
  if (slice.length === 0) return ''
  let offset = 0
  let bigEndian = bigEndianDefault
  if (slice.length >= 2) {
    if (slice[0] === 0xfe && slice[1] === 0xff) {
      bigEndian = true
      offset = 2
    } else if (slice[0] === 0xff && slice[1] === 0xfe) {
      bigEndian = false
      offset = 2
    }
  }
  const body = slice.subarray(offset)
  const leBuf = bigEndian ? swapUtf16Pairs(body) : body.subarray(0, body.length - (body.length % 2))
  return leBuf.toString('utf16le').replace(/\0+$/g, '').trim()
}

function decodeId3TextPayload(payload: Buffer): string {
  if (payload.length === 0) return ''
  const enc = payload[0]!
  const body = payload.subarray(1)
  if (enc === 0) return body.toString('latin1').replace(/\0+$/g, '').trim()
  if (enc === 1) return decodeTextWithBomUtf16(body, false)
  if (enc === 2) return decodeTextWithBomUtf16(body, true)
  return body.toString('utf8').replace(/\0+$/g, '').trim()
}

function readSynchsafeInt(buf: Buffer, offset: number): number {
  return (
    ((buf[offset]! & 0x7f) << 21) |
    ((buf[offset + 1]! & 0x7f) << 14) |
    ((buf[offset + 2]! & 0x7f) << 7) |
    (buf[offset + 3]! & 0x7f)
  )
}

/** Parse FLAC STREAMINFO, VORBIS_COMMENT, and PICTURE blocks safely without reading full file. */
export function parseFlacMetadata(buf: Buffer): ExtractedAudioMetadata {
  if (buf.length < 8 || buf.subarray(0, 4).toString('ascii') !== 'fLaC') {
    return {}
  }

  const out: ExtractedAudioMetadata = {}
  let bestPicType = -1
  let offset = 4
  let iterations = 0

  while (offset + 4 <= buf.length && iterations < 128) {
    iterations += 1
    const header = buf[offset]!
    const isLast = (header & 0x80) !== 0
    const blockType = header & 0x7f
    const blockLen = (buf[offset + 1]! << 16) | (buf[offset + 2]! << 8) | buf[offset + 3]!
    const dataStart = offset + 4
    const dataEnd = dataStart + blockLen
    if (dataEnd > buf.length) break

    const block = buf.subarray(dataStart, dataEnd)

    if (blockType === 0 && block.length >= 18) {
      const b10 = block[10]!
      const b11 = block[11]!
      const b12 = block[12]!
      const b13 = block[13]!
      const sampleRateHz = (b10 << 12) | (b11 << 4) | (b12 >> 4)
      const bitDepth = (((b12 & 0x01) << 4) | (b13 >> 4)) + 1
      if (sampleRateHz > 0) out.sampleRateHz = sampleRateHz
      if (bitDepth >= 4 && bitDepth <= 64) out.bitDepth = bitDepth
    } else if (blockType === 4 && block.length >= 8) {
      let pos = 0
      const vendorLen = block.readUInt32LE(pos)
      pos += 4
      if (vendorLen <= block.length - pos) {
        pos += vendorLen
        if (pos + 4 <= block.length) {
          const count = Math.min(512, block.readUInt32LE(pos))
          pos += 4
          for (let i = 0; i < count && pos + 4 <= block.length; i += 1) {
            const len = block.readUInt32LE(pos)
            pos += 4
            if (len > block.length - pos) break
            const entry = block.subarray(pos, pos + len).toString('utf8')
            pos += len
            const eq = entry.indexOf('=')
            if (eq <= 0) continue
            const key = entry.slice(0, eq).trim().toUpperCase()
            const val = entry.slice(eq + 1).trim()
            if (!val) continue
            if (key === 'TITLE' && !out.title) out.title = val
            else if (key === 'ARTIST' && !out.artist) out.artist = val
            else if (key === 'ALBUM' && !out.album) out.album = val
          }
        }
      }
    } else if (blockType === 6 && block.length >= 32) {
      let pos = 0
      const picType = block.readUInt32BE(pos)
      pos += 4
      const mimeLen = block.readUInt32BE(pos)
      pos += 4
      if (mimeLen <= block.length - pos) {
        const mimeRaw = block.subarray(pos, pos + mimeLen).toString('ascii')
        pos += mimeLen
        if (mimeRaw !== '-->' && pos + 4 <= block.length) {
          const descLen = block.readUInt32BE(pos)
          pos += 4
          if (descLen <= block.length - pos) {
            pos += descLen + 16 // Skip width, height, color depth, indexed colors.
            if (pos + 4 <= block.length) {
              const picLen = block.readUInt32BE(pos)
              pos += 4
              const mime = canonicalCoverMime(mimeRaw)
              if (
                mime &&
                picLen > 0 &&
                picLen <= MAX_COVER_IMAGE_BYTES &&
                pos + picLen <= block.length &&
                (!out.cover || (bestPicType !== 3 && picType === 3))
              ) {
                out.cover = {
                  data: Buffer.from(block.subarray(pos, pos + picLen)),
                  mime,
                }
                bestPicType = picType
              }
            }
          }
        }
      }
    }

    offset = dataEnd
    if (isLast) break
  }

  return out
}

/** Parse ID3v2.3 / ID3v2.4 metadata tags and embedded APIC album artwork. */
export function parseId3v2Metadata(buf: Buffer): ExtractedAudioMetadata {
  if (buf.length < 10 || buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) {
    return {}
  }
  const major = buf[3]!
  if (major !== 3 && major !== 4) return {}
  const flags = buf[5]!
  const tagSize = readSynchsafeInt(buf, 6)
  if (tagSize <= 0) return {}

  const tagEnd = Math.min(buf.length, 10 + tagSize)
  let offset = 10

  if ((flags & 0x40) !== 0 && offset + 4 <= tagEnd) {
    if (major === 4) {
      const extSize = readSynchsafeInt(buf, offset)
      if (extSize >= 4) offset += extSize
    } else {
      const extSize = buf.readUInt32BE(offset)
      offset += 4 + extSize
    }
  }

  const out: ExtractedAudioMetadata = {}
  let bestPicType = -1
  let iterations = 0

  while (offset + 10 <= tagEnd && iterations < 512) {
    iterations += 1
    if (buf[offset] === 0) break
    const frameId = buf.subarray(offset, offset + 4).toString('ascii')
    if (!/^[A-Z0-9]{4}$/.test(frameId)) break

    const frameSize =
      major === 4 ? readSynchsafeInt(buf, offset + 4) : buf.readUInt32BE(offset + 4)
    const dataStart = offset + 10
    const dataEnd = dataStart + frameSize
    if (frameSize <= 0 || dataEnd > tagEnd) break

    const payload = buf.subarray(dataStart, dataEnd)
    if (frameId === 'TIT2' && !out.title) {
      const v = decodeId3TextPayload(payload)
      if (v) out.title = v
    } else if (frameId === 'TPE1' && !out.artist) {
      const v = decodeId3TextPayload(payload)
      if (v) out.artist = v
    } else if (frameId === 'TALB' && !out.album) {
      const v = decodeId3TextPayload(payload)
      if (v) out.album = v
    } else if (frameId === 'APIC' && payload.length >= 4) {
      const enc = payload[0]!
      const mimeZero = payload.indexOf(0, 1)
      if (mimeZero > 1 && mimeZero + 2 < payload.length) {
        const mimeRaw = payload.subarray(1, mimeZero).toString('ascii')
        const picType = payload[mimeZero + 1]!
        let cursor = mimeZero + 2
        if (enc === 1 || enc === 2) {
          while (cursor + 1 < payload.length) {
            if (payload[cursor] === 0 && payload[cursor + 1] === 0) {
              cursor += 2
              break
            }
            cursor += 2
          }
        } else {
          const descZero = payload.indexOf(0, cursor)
          cursor = descZero >= 0 ? descZero + 1 : payload.length
        }
        const imgSlice = payload.subarray(cursor)
        const mime = canonicalCoverMime(mimeRaw)
        if (
          mime &&
          imgSlice.length > 0 &&
          imgSlice.length <= MAX_COVER_IMAGE_BYTES &&
          (!out.cover || (bestPicType !== 3 && picType === 3))
        ) {
          out.cover = {
            data: Buffer.from(imgSlice),
            mime,
          }
          bestPicType = picType
        }
      }
    }

    offset = dataEnd
  }

  return out
}

/** Parse synchronized LRC lyric lines (including `[offset:ms]` and multiple timestamps per line). */
export function parseLrcLyrics(raw: string): MediaLyricLine[] {
  const clean = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const offsetMatch = /\[offset:\s*([+-]?\d+)\s*\]/i.exec(clean)
  const offsetSec = offsetMatch ? Number(offsetMatch[1]) / 1000 : 0

  const timePattern = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g
  const lines: MediaLyricLine[] = []

  for (const rawLine of clean.split('\n')) {
    const timestamps: number[] = []
    timePattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = timePattern.exec(rawLine)) !== null) {
      const mins = Number(match[1])
      const secs = Number(match[2])
      const frac = match[3] ? Number(`0.${match[3]}`) : 0
      if (Number.isFinite(mins) && Number.isFinite(secs) && Number.isFinite(frac)) {
        timestamps.push(Math.max(0, mins * 60 + secs + frac + offsetSec))
      }
    }
    if (timestamps.length === 0) continue
    const text = rawLine.replace(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g, '').trim()
    if (!text) continue
    for (const timeSec of timestamps) {
      lines.push({ timeSec, text })
    }
  }

  lines.sort((a, b) => a.timeSec - b.timeSec)
  return lines
}

/** Infer clean title and optional artist from filenames like `04.Title - Artist.flac`. */
export function parseTitleArtistFromFilename(fileName: string): { title: string; artist?: string } {
  const ext = extname(fileName)
  const rawStem = ext ? fileName.slice(0, fileName.length - ext.length) : fileName
  const withoutTrackNo = rawStem.replace(/^\s*\d{1,3}\s*(?:\.|-|_|\s)\s*/, '').trim()
  const base = withoutTrackNo || rawStem.trim() || fileName
  const sepMatch = /^(.+?)\s+[-–—]\s+(.+?)$/.exec(base)
  if (sepMatch) {
    const left = sepMatch[1]!.trim()
    const right = sepMatch[2]!.trim()
    if (left && right) {
      return { title: left, artist: right }
    }
  }
  return { title: base }
}

async function readHeadChunk(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(filePath, 'r')
  try {
    const info = await handle.stat()
    const targetLen = Math.min(info.size, maxBytes)
    if (targetLen <= 0) return Buffer.alloc(0)
    const buf = Buffer.allocUnsafe(targetLen)
    let totalRead = 0
    while (totalRead < targetLen) {
      const { bytesRead } = await handle.read(buf, totalRead, targetLen - totalRead, totalRead)
      if (bytesRead === 0) break
      totalRead += bytesRead
    }
    return totalRead === targetLen ? buf : buf.subarray(0, totalRead)
  } finally {
    await handle.close()
  }
}

async function resolveSameDirSidecar(dirRealKey: string, candidatePath: string): Promise<string | null> {
  try {
    const real = await realpath(candidatePath)
    if (normalizeMediaPathKey(dirname(real)) !== dirRealKey) return null
    const info = await stat(real)
    return info.isFile() ? real : null
  } catch {
    return null
  }
}

async function findSidecarCover(dir: string, dirRealKey: string, stem: string): Promise<ExtractedCoverArt | undefined> {
  const stems = [stem, 'cover', 'folder', 'Cover', 'Folder']
  for (const s of stems) {
    if (!s) continue
    for (const { ext, mime } of SIDECAR_IMAGE_EXTS) {
      const candidate = join(dir, `${s}.${ext}`)
      const verified = await resolveSameDirSidecar(dirRealKey, candidate)
      if (!verified) continue
      try {
        const info = await stat(verified)
        if (info.size <= 0 || info.size > MAX_COVER_IMAGE_BYTES) continue
        const data = await readFile(verified)
        if (data.length > 0 && data.length <= MAX_COVER_IMAGE_BYTES) {
          return { data, mime }
        }
      } catch {
        // Ignore unreadable sidecar image.
      }
    }
  }
  return undefined
}

async function findSidecarLyrics(dir: string, dirRealKey: string, stem: string): Promise<MediaLyricLine[] | undefined> {
  if (!stem) return undefined
  const verified = await resolveSameDirSidecar(dirRealKey, join(dir, `${stem}.lrc`))
  if (!verified) return undefined
  try {
    const info = await stat(verified)
    if (info.size <= 0 || info.size > MAX_LRC_BYTES) return undefined
    const rawBuf = await readFile(verified)
    const text =
      rawBuf.length >= 2 &&
      ((rawBuf[0] === 0xff && rawBuf[1] === 0xfe) || (rawBuf[0] === 0xfe && rawBuf[1] === 0xff))
        ? decodeTextWithBomUtf16(rawBuf)
        : rawBuf.toString('utf8')
    const parsed = parseLrcLyrics(text)
    return parsed.length > 0 ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Extract tags, cover art, technical audio params, and sidecar lyrics for an audio file. */
export async function extractAudioMetadata(filePath: string): Promise<ExtractedAudioMetadata> {
  const resolved = resolve(filePath)
  const fileName = basename(resolved)
  const ext = extname(fileName)
  const lowerExt = ext.toLowerCase()
  const stem = ext ? fileName.slice(0, fileName.length - ext.length) : fileName
  const dir = dirname(resolved)

  let parsed: ExtractedAudioMetadata = {}
  try {
    const head = await readHeadChunk(resolved, MAX_AUDIO_HEADER_BYTES)
    if (lowerExt === '.flac' || (head.length >= 4 && head.subarray(0, 4).toString('ascii') === 'fLaC')) {
      parsed = parseFlacMetadata(head)
    } else if (
      lowerExt === '.mp3' ||
      (head.length >= 3 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33)
    ) {
      parsed = parseId3v2Metadata(head)
    }
  } catch {
    parsed = {}
  }

  const fallback = parseTitleArtistFromFilename(fileName)
  const result: ExtractedAudioMetadata = {
    title: parsed.title || fallback.title,
    ...(parsed.artist || fallback.artist ? { artist: parsed.artist || fallback.artist } : {}),
    ...(parsed.album ? { album: parsed.album } : {}),
    ...(parsed.sampleRateHz ? { sampleRateHz: parsed.sampleRateHz } : {}),
    ...(parsed.bitDepth ? { bitDepth: parsed.bitDepth } : {}),
    ...(parsed.cover ? { cover: parsed.cover } : {}),
  }

  try {
    const dirRealKey = normalizeMediaPathKey(await realpath(dir))
    if (!result.cover) {
      const sidecarCover = await findSidecarCover(dir, dirRealKey, stem)
      if (sidecarCover) result.cover = sidecarCover
    }
    const lyrics = await findSidecarLyrics(dir, dirRealKey, stem)
    if (lyrics) result.lyrics = lyrics
  } catch {
    // Ignore sidecar inspection failures on restricted filesystems.
  }

  return result
}
