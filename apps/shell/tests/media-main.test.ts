import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  protocol: { handle: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
  WebContentsView: vi.fn(),
}))

import {
  AUDIO_MEDIA_EXTS,
  IMAGE_MEDIA_EXTS,
  MEDIA_EXTS,
  VIDEO_MEDIA_EXTS,
  clearMediaSessions,
  mediaFilePathForWebContents,
  mediaKindForExt,
  mediaSessionForToken,
  mediaSessionForWebContents,
  mediaStreamUrl,
  mimeForMediaExt,
  parseByteRange,
  registerMediaSession,
  unregisterMediaSessionByToken,
  unregisterMediaSessionByWcId,
} from '../src/main/media-main'

beforeEach(() => {
  clearMediaSessions()
})

describe('media format classification', () => {
  it('covers all 21 supported image, audio, and video extensions', () => {
    expect(IMAGE_MEDIA_EXTS).toHaveLength(9)
    expect(AUDIO_MEDIA_EXTS).toHaveLength(7)
    expect(VIDEO_MEDIA_EXTS).toHaveLength(5)
    expect(MEDIA_EXTS).toHaveLength(21)

    for (const ext of IMAGE_MEDIA_EXTS) expect(mediaKindForExt(ext)).toBe('image')
    for (const ext of AUDIO_MEDIA_EXTS) expect(mediaKindForExt(ext)).toBe('audio')
    for (const ext of VIDEO_MEDIA_EXTS) expect(mediaKindForExt(ext)).toBe('video')
    expect(mediaKindForExt('.PNG')).toBe('image')
    expect(mediaKindForExt('WAV')).toBe('audio')
    expect(mediaKindForExt('webm')).toBe('video')
    expect(mediaKindForExt('docx')).toBeUndefined()
  })

  it('resolves canonical MIME types and fallback octet-stream', () => {
    expect(mimeForMediaExt('png')).toBe('image/png')
    expect(mimeForMediaExt('.jpg')).toBe('image/jpeg')
    expect(mimeForMediaExt('svg')).toBe('image/svg+xml')
    expect(mimeForMediaExt('wav')).toBe('audio/wav')
    expect(mimeForMediaExt('mp3')).toBe('audio/mpeg')
    expect(mimeForMediaExt('mp4')).toBe('video/mp4')
    expect(mimeForMediaExt('mkv')).toBe('video/x-matroska')
    expect(mimeForMediaExt('unknown')).toBe('application/octet-stream')
  })
})

describe('parseByteRange', () => {
  it('returns full when Range header is absent or empty', () => {
    expect(parseByteRange(null, 100)).toEqual({ kind: 'full' })
    expect(parseByteRange(undefined, 100)).toEqual({ kind: 'full' })
    expect(parseByteRange('   ', 100)).toEqual({ kind: 'full' })
    expect(parseByteRange(null, 0)).toEqual({ kind: 'full' })
  })

  it('parses bounded and open-ended byte ranges', () => {
    expect(parseByteRange('bytes=0-99', 100)).toEqual({ kind: 'partial', start: 0, end: 99 })
    expect(parseByteRange('bytes=50-', 100)).toEqual({ kind: 'partial', start: 50, end: 99 })
    expect(parseByteRange('bytes=-20', 100)).toEqual({ kind: 'partial', start: 80, end: 99 })
    expect(parseByteRange('bytes=-200', 100)).toEqual({ kind: 'partial', start: 0, end: 99 })
    expect(parseByteRange('bytes=10-500', 100)).toEqual({ kind: 'partial', start: 10, end: 99 })
  })

  it('rejects unsatisfiable or malformed ranges for HTTP 416', () => {
    expect(parseByteRange('bytes=100-', 100)).toEqual({ kind: 'unsatisfiable' })
    expect(parseByteRange('bytes=200-300', 100)).toEqual({ kind: 'unsatisfiable' })
    expect(parseByteRange('bytes=50-10', 100)).toEqual({ kind: 'unsatisfiable' })
    expect(parseByteRange('bytes=-', 100)).toEqual({ kind: 'unsatisfiable' })
    expect(parseByteRange('bytes=-0', 100)).toEqual({ kind: 'unsatisfiable' })
    expect(parseByteRange('bytes=0-0', 0)).toEqual({ kind: 'unsatisfiable' })
    expect(parseByteRange('bytes=abc-def', 100)).toEqual({ kind: 'unsatisfiable' })
    expect(parseByteRange('items=0-10', 100)).toEqual({ kind: 'unsatisfiable' })
    expect(parseByteRange('bytes=0-1, 2-3', 100)).toEqual({ kind: 'unsatisfiable' })
  })
})

describe('media token session registry', () => {
  it('binds a per-view token and cleans it up on destroy or replacement', () => {
    const first = registerMediaSession(42, '/tmp/photo.png')
    expect(first.wcId).toBe(42)
    expect(first.mediaKind).toBe('image')
    expect(first.mime).toBe('image/png')
    expect(mediaStreamUrl(first.token)).toBe(`genoffice-media://view/${first.token}`)
    expect(mediaSessionForToken(first.token)?.filePath).toBe(first.filePath)
    expect(mediaSessionForWebContents(42)?.token).toBe(first.token)
    expect(mediaFilePathForWebContents(42)).toBe(first.filePath)

    const second = registerMediaSession(42, '/tmp/clip.mp4')
    expect(second.token).not.toBe(first.token)
    expect(mediaSessionForToken(first.token)).toBeUndefined()
    expect(mediaSessionForToken(second.token)?.mediaKind).toBe('video')

    expect(unregisterMediaSessionByWcId(42)).toBe(true)
    expect(mediaSessionForToken(second.token)).toBeUndefined()
    expect(mediaFilePathForWebContents(42)).toBeUndefined()
    expect(unregisterMediaSessionByToken(second.token)).toBe(false)
  })
})
