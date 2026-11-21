import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
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
  addMediaFoldersForView,
  buildMediaPlayerState,
  clearMediaSessions,
  configureMediaViewContext,
  discoverSidecarSubtitles,
  isAuthorizedMediaPath,
  mediaFilePathForWebContents,
  mediaKindForExt,
  mediaSessionForToken,
  mediaSessionForWebContents,
  mediaStreamUrl,
  mimeForMediaExt,
  parseByteRange,
  registerMediaSession,
  scanDirectoryMedia,
  setMediaFileChangedHook,
  setMediaLibraryPathResolver,
  switchMediaTrackForView,
  unregisterMediaSessionByToken,
  unregisterMediaSessionByWcId,
} from '../src/main/media-main'

const tempDirs: string[] = []

function makeTempDir(prefix = 'genoffice-media-main-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

beforeEach(() => {
  clearMediaSessions()
  setMediaFileChangedHook(null)
})

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
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

describe('directory playlist scanning, track switching, subtitles, and persistence', () => {
  it('scans playable audio/video files naturally while ignoring images and documents', async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'ep10.mp4'), 'v10')
    writeFileSync(join(dir, 'ep2.mp4'), 'v2')
    writeFileSync(join(dir, 'song.mp3'), 'a1')
    writeFileSync(join(dir, 'cover.png'), 'img')
    writeFileSync(join(dir, 'notes.md'), 'txt')

    const scan = await scanDirectoryMedia(dir, 'session')
    expect(scan.missing).toBe(false)
    expect(scan.items.map((i) => i.fileName)).toEqual(['ep2.mp4', 'ep10.mp4', 'song.mp3'])
  })

  it('switches tracks inside authorized session folders, updates tab hook, and rejects unauthorized paths', async () => {
    const root = makeTempDir()
    const allowedDir = join(root, 'album')
    const outsideDir = join(root, 'secret')
    const storePath = join(root, 'media-player.json')
    setMediaLibraryPathResolver(() => storePath)

    const fs = await import('node:fs')
    fs.mkdirSync(allowedDir)
    fs.mkdirSync(outsideDir)
    const track1 = join(allowedDir, '01.wav')
    const track2 = join(allowedDir, '02.mp3')
    const outsideTrack = join(outsideDir, 'private.mp3')
    const escapeLink = join(allowedDir, 'escape.mp3')
    writeFileSync(track1, 'wav')
    writeFileSync(track2, 'mp3')
    writeFileSync(outsideTrack, 'secret')
    try {
      symlinkSync(outsideTrack, escapeLink)
    } catch {
      // Skip symlink creation if platform denies unprivileged symlinks.
    }

    const hook = vi.fn()
    setMediaFileChangedHook(hook)
    const entry = registerMediaSession(77, track1)
    configureMediaViewContext(77, { sessionDir: allowedDir, playerMode: true })

    const initialState = await buildMediaPlayerState(77, entry.token)
    expect(initialState.playerMode).toBe(true)
    expect(initialState.items.map((i) => i.filePath)).toEqual([resolve(track1), resolve(track2)])

    // Unauthorized path outside allowedDir is rejected.
    expect(await isAuthorizedMediaPath(77, outsideTrack)).toBeNull()
    const refused = await switchMediaTrackForView(77, outsideTrack)
    expect(refused.ok).toBe(false)

    // Symlink escaping allowedDir is also rejected.
    if (fs.existsSync(escapeLink)) {
      expect(await isAuthorizedMediaPath(77, escapeLink)).toBeNull()
    }

    // Valid sibling track switches cleanly, replaces token, and notifies tab hook.
    const switched = await switchMediaTrackForView(77, track2)
    expect(switched.ok).toBe(true)
    expect(switched.state?.current?.filePath).toBe(resolve(track2))
    expect(switched.state?.current?.token).not.toBe(entry.token)
    expect(mediaSessionForToken(entry.token)).toBeUndefined()
    expect(hook).toHaveBeenCalledWith(77, resolve(track2))

    // Reopening a fresh view in standalone mode restores lastFilePath automatically.
    const restoredHook = vi.fn()
    setMediaFileChangedHook(restoredHook)
    await addMediaFoldersForView(88, [allowedDir])
    const freshState = await buildMediaPlayerState(88)
    expect(freshState.current?.filePath).toBe(resolve(track2))
    expect(freshState.folders[0]?.persisted).toBe(true)
    expect(restoredHook).toHaveBeenCalledWith(88, resolve(track2))
  })

  it('discovers matching .srt and .vtt sidecar subtitle tracks', async () => {
    const dir = makeTempDir()
    const video = join(dir, 'lesson.mp4')
    writeFileSync(video, 'mp4')
    writeFileSync(join(dir, 'lesson.srt'), '1\n00:00:00,000 --> 00:00:01,000\nhi\n')
    writeFileSync(join(dir, 'lesson.zh.vtt'), 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n你好\n')
    writeFileSync(join(dir, 'other.srt'), 'unrelated')

    const subs = await discoverSidecarSubtitles(video, 'tok-1')
    expect(subs.tracks).toHaveLength(2)
    expect(subs.tracks[0]).toMatchObject({
      ext: 'srt',
      url: 'genoffice-media://sub/tok-1/s1',
    })
    expect(subs.tracks[1]).toMatchObject({
      label: 'zh',
      ext: 'vtt',
      url: 'genoffice-media://sub/tok-1/s2',
    })
  })
})
