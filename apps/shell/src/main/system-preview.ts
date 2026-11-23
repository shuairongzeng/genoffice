import { constants, type Stats } from 'node:fs'
import { access, open, stat } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { parseFileToText } from '@genoffice/file-parse'
import type { SystemPreviewKind, SystemPreviewResult } from '../shared/home-api'
import { appForPath } from './app-registry'
import {
  AUDIO_MEDIA_EXTS,
  IMAGE_MEDIA_EXTS,
  VIDEO_MEDIA_EXTS,
  mimeForMediaExt,
  registerTransientPreviewUrl,
} from './media-main'

export const MAX_TEXT_PREVIEW_BYTES = 512 * 1024
export const MAX_OFFICE_PREVIEW_BYTES = 40 * 1024 * 1024
export const MAX_OFFICE_PREVIEW_CHARS = 120_000

const IMAGE_EXT_SET = new Set<string>(IMAGE_MEDIA_EXTS)
const AUDIO_EXT_SET = new Set<string>(AUDIO_MEDIA_EXTS)
const VIDEO_EXT_SET = new Set<string>(VIDEO_MEDIA_EXTS)

const MARKDOWN_EXT_SET = new Set<string>(['md', 'markdown'])
const HTML_EXT_SET = new Set<string>(['html', 'htm'])

const TEXT_EXT_SET = new Set<string>([
  'txt',
  'ini',
  'cfg',
  'conf',
  'properties',
  'env',
  'json',
  'yaml',
  'yml',
  'xml',
  'toml',
  'log',
  'csv',
  'tsv',
  'py',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'css',
  'scss',
  'less',
  'sql',
  'sh',
  'bash',
  'zsh',
  'ps1',
  'bat',
  'cmd',
  'c',
  'cpp',
  'h',
  'hpp',
  'java',
  'go',
  'rs',
  'rb',
  'php',
  'swift',
  'kt',
  'vue',
  'svelte',
])

const TEXT_BASENAME_SET = new Set<string>([
  'dockerfile',
  'makefile',
  '.gitignore',
  '.env',
  '.gitattributes',
  '.gitmodules',
  '.editorconfig',
  '.dockerignore',
  '.npmrc',
  '.nvmrc',
  '.prettierrc',
  '.prettierignore',
  '.eslintrc',
  '.eslintignore',
])

const OFFICE_EXT_SET = new Set<string>([
  'docx',
  'doc',
  'xlsx',
  'xlsm',
  'xls',
  'pptx',
  'ppt',
  'odt',
  'ott',
  'ods',
  'ots',
  'odp',
  'otp',
])

const TEXT_MIME_BY_EXT: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  json: 'application/json',
  xml: 'application/xml',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
}

const OFFICE_MIME_BY_EXT: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  xls: 'application/vnd.ms-excel',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  odt: 'application/vnd.oasis.opendocument.text',
  ott: 'application/vnd.oasis.opendocument.text-template',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  ots: 'application/vnd.oasis.opendocument.spreadsheet-template',
  odp: 'application/vnd.oasis.opendocument.presentation',
  otp: 'application/vnd.oasis.opendocument.presentation-template',
}

export interface SystemPreviewOptions {
  registerMediaUrl?: (filePath: string, mime?: string, ext?: string) => string
  parseOfficeFile?: (
    filePath: string,
    opts?: { maxChars?: number },
  ) => Promise<{ ok: boolean; kind: string; text?: string; error?: string }>
}

function isTextPreviewTarget(ext: string, name: string): boolean {
  if (MARKDOWN_EXT_SET.has(ext) || HTML_EXT_SET.has(ext) || TEXT_EXT_SET.has(ext)) return true
  const lowerName = name.toLowerCase()
  return TEXT_BASENAME_SET.has(lowerName) || lowerName.startsWith('.env.')
}

function textKindForExt(ext: string): Extract<SystemPreviewKind, 'markdown' | 'html' | 'text'> {
  if (MARKDOWN_EXT_SET.has(ext)) return 'markdown'
  if (HTML_EXT_SET.has(ext)) return 'html'
  return 'text'
}

function errorKindFromErrno(err: unknown): 'missing' | 'denied' {
  const code = (err as NodeJS.ErrnoException | null)?.code
  if (code === 'EACCES' || code === 'EPERM') return 'denied'
  return 'missing'
}

function makeErrorResult(
  path: string,
  name: string,
  ext: string,
  error: NonNullable<SystemPreviewResult['error']>,
  overrides?: {
    size?: number
    mtimeMs?: number
    kind?: SystemPreviewKind
    mime?: string
    canOpenInEditor?: boolean
  },
): SystemPreviewResult {
  return {
    path,
    name,
    ext,
    size: overrides?.size ?? 0,
    mtimeMs: overrides?.mtimeMs ?? 0,
    kind: overrides?.kind ?? 'unsupported',
    mime: overrides?.mime ?? 'application/octet-stream',
    canOpenInEditor: overrides?.canOpenInEditor ?? false,
    error,
  }
}

function decodeUtf8BomAware(payload: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(payload)
  } catch {
    return new TextDecoder('utf-8').decode(payload)
  }
}

function hasUtfBom(buf: Buffer): boolean {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return true
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return true
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return true
  return false
}

/**
 * When a large UTF-8 text file is clipped at `MAX_TEXT_PREVIEW_BYTES`, the cut
 * can split a trailing 2-4 byte sequence. Trim only that incomplete tail if the
 * remaining prefix decodes strictly as UTF-8 so GB18030 fallback is not triggered.
 */
function trimSplitTrailingUtf8(buf: Buffer, truncated: boolean): Buffer {
  if (!truncated || buf.length === 0 || hasUtfBom(buf)) return buf
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return buf
  } catch {
    // Check whether stripping 1..3 trailing bytes of an incomplete multi-byte lead yields valid UTF-8.
  }

  for (let cut = 1; cut <= 3 && cut <= buf.length; cut += 1) {
    const start = buf.length - cut
    const lead = buf[start]!
    let expectedLen = 0
    if (lead >= 0xc2 && lead <= 0xdf) expectedLen = 2
    else if (lead >= 0xe0 && lead <= 0xef) expectedLen = 3
    else if (lead >= 0xf0 && lead <= 0xf4) expectedLen = 4
    else continue

    if (cut >= expectedLen) continue
    let validCont = true
    for (let i = start + 1; i < buf.length; i += 1) {
      if ((buf[i]! & 0xc0) !== 0x80) {
        validCont = false
        break
      }
    }
    if (!validCont) continue

    const candidate = buf.subarray(0, start)
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(candidate)
      return candidate
    } catch {
      return buf
    }
  }
  return buf
}

/**
 * Decode raw file bytes into preview text, honoring UTF-8/UTF-16 BOMs and
 * falling back from strict UTF-8 to GB18030 for legacy Windows text/config files.
 */
export function decodePreviewTextBytes(buf: Buffer): string {
  if (buf.length === 0) return ''

  // UTF-8 BOM
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return decodeUtf8BomAware(buf.subarray(3))
  }

  // UTF-16 LE BOM
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    const payload = buf.subarray(2)
    const evenLen = payload.length - (payload.length % 2)
    return payload.subarray(0, evenLen).toString('utf16le')
  }

  // UTF-16 BE BOM: swap even byte pairs before decoding as UTF-16 LE.
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const payload = buf.subarray(2)
    const evenLen = payload.length - (payload.length % 2)
    const swapped = Buffer.allocUnsafe(evenLen)
    for (let i = 0; i < evenLen; i += 2) {
      swapped[i] = payload[i + 1]!
      swapped[i + 1] = payload[i]!
    }
    return swapped.toString('utf16le')
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    try {
      return new TextDecoder('gb18030', { fatal: true }).decode(buf)
    } catch {
      try {
        return new TextDecoder('gb18030').decode(buf)
      } catch {
        return new TextDecoder('utf-8').decode(buf)
      }
    }
  }
}

async function readBoundedTextSlice(filePath: string, fileSize: number): Promise<Buffer> {
  const targetBytes = Math.max(0, Math.min(fileSize, MAX_TEXT_PREVIEW_BYTES))
  if (targetBytes === 0) return Buffer.alloc(0)

  const buffer = Buffer.allocUnsafe(targetBytes)
  let totalRead = 0
  const fh = await open(filePath, 'r')
  try {
    while (totalRead < targetBytes) {
      const { bytesRead } = await fh.read(
        buffer,
        totalRead,
        targetBytes - totalRead,
        totalRead,
      )
      if (bytesRead === 0) break
      totalRead += bytesRead
    }
  } finally {
    await fh.close()
  }
  return totalRead === buffer.length ? buffer : buffer.subarray(0, totalRead)
}

/**
 * Inspect a local filesystem path and return a read-only, bounded preview payload
 * without mutating recents, stars, folder roots, or media library persistence.
 */
export async function previewSystemFile(
  filePath: string,
  opts?: SystemPreviewOptions,
): Promise<SystemPreviewResult> {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    return makeErrorResult(typeof filePath === 'string' ? filePath : '', '', '', 'missing')
  }

  const resolved = resolve(filePath)
  const name = basename(resolved) || resolved
  const rawExt = extname(name)
  const ext = rawExt.length > 1 ? rawExt.slice(1).toLowerCase() : ''

  let st: Stats
  try {
    st = await stat(resolved)
  } catch (err) {
    return makeErrorResult(resolved, name, ext, errorKindFromErrno(err))
  }

  if (!st.isFile()) {
    return makeErrorResult(resolved, name, ext, 'not-file', {
      size: 0,
      mtimeMs: st.mtimeMs,
    })
  }

  try {
    await access(resolved, constants.R_OK)
  } catch (err) {
    return makeErrorResult(resolved, name, ext, errorKindFromErrno(err), {
      size: st.size,
      mtimeMs: st.mtimeMs,
    })
  }

  const registerMediaUrl = opts?.registerMediaUrl ?? registerTransientPreviewUrl
  const parseOfficeFile = opts?.parseOfficeFile ?? parseFileToText
  const canOpenInEditor = Boolean(appForPath(resolved))

  if (IMAGE_EXT_SET.has(ext)) {
    const mime = mimeForMediaExt(ext)
    return {
      path: resolved,
      name,
      ext,
      size: st.size,
      mtimeMs: st.mtimeMs,
      kind: 'image',
      mime,
      mediaUrl: registerMediaUrl(resolved, mime, ext),
      canOpenInEditor,
    }
  }

  if (AUDIO_EXT_SET.has(ext)) {
    const mime = mimeForMediaExt(ext)
    return {
      path: resolved,
      name,
      ext,
      size: st.size,
      mtimeMs: st.mtimeMs,
      kind: 'audio',
      mime,
      mediaUrl: registerMediaUrl(resolved, mime, ext),
      canOpenInEditor,
    }
  }

  if (VIDEO_EXT_SET.has(ext)) {
    const mime = mimeForMediaExt(ext)
    return {
      path: resolved,
      name,
      ext,
      size: st.size,
      mtimeMs: st.mtimeMs,
      kind: 'video',
      mime,
      mediaUrl: registerMediaUrl(resolved, mime, ext),
      canOpenInEditor,
    }
  }

  if (ext === 'pdf') {
    const mime = 'application/pdf'
    return {
      path: resolved,
      name,
      ext,
      size: st.size,
      mtimeMs: st.mtimeMs,
      kind: 'pdf',
      mime,
      mediaUrl: registerMediaUrl(resolved, mime, 'pdf'),
      canOpenInEditor: true,
    }
  }

  if (isTextPreviewTarget(ext, name)) {
    const kind = textKindForExt(ext)
    const mime = TEXT_MIME_BY_EXT[ext] ?? 'text/plain'
    const truncated = st.size > MAX_TEXT_PREVIEW_BYTES
    try {
      const slice = await readBoundedTextSlice(resolved, st.size)
      const text = decodePreviewTextBytes(trimSplitTrailingUtf8(slice, truncated))
      return {
        path: resolved,
        name,
        ext,
        size: st.size,
        mtimeMs: st.mtimeMs,
        kind,
        mime,
        text,
        language: ext || name.toLowerCase(),
        truncated,
        canOpenInEditor,
      }
    } catch (err) {
      return makeErrorResult(resolved, name, ext, errorKindFromErrno(err), {
        size: st.size,
        mtimeMs: st.mtimeMs,
        kind,
        mime,
        canOpenInEditor,
      })
    }
  }

  if (OFFICE_EXT_SET.has(ext)) {
    const mime = OFFICE_MIME_BY_EXT[ext] ?? 'application/octet-stream'
    if (st.size > MAX_OFFICE_PREVIEW_BYTES) {
      return makeErrorResult(resolved, name, ext, 'too-large', {
        size: st.size,
        mtimeMs: st.mtimeMs,
        kind: 'office',
        mime,
        canOpenInEditor,
      })
    }
    try {
      const parsed = await parseOfficeFile(resolved, { maxChars: MAX_OFFICE_PREVIEW_CHARS })
      if (!parsed.ok) {
        return makeErrorResult(resolved, name, ext, 'parse-failed', {
          size: st.size,
          mtimeMs: st.mtimeMs,
          kind: 'office',
          mime,
          canOpenInEditor,
        })
      }
      const rawText = parsed.text ?? ''
      const truncated = rawText.length >= MAX_OFFICE_PREVIEW_CHARS
      const text =
        rawText.length > MAX_OFFICE_PREVIEW_CHARS
          ? rawText.slice(0, MAX_OFFICE_PREVIEW_CHARS)
          : rawText
      return {
        path: resolved,
        name,
        ext,
        size: st.size,
        mtimeMs: st.mtimeMs,
        kind: 'office',
        mime,
        text,
        truncated,
        canOpenInEditor,
      }
    } catch {
      return makeErrorResult(resolved, name, ext, 'parse-failed', {
        size: st.size,
        mtimeMs: st.mtimeMs,
        kind: 'office',
        mime,
        canOpenInEditor,
      })
    }
  }

  return {
    path: resolved,
    name,
    ext,
    size: st.size,
    mtimeMs: st.mtimeMs,
    kind: 'unsupported',
    mime: 'application/octet-stream',
    canOpenInEditor: false,
  }
}
