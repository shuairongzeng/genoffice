import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MEDIA_PLAYER_PREFS,
  MAX_SAVED_POSITIONS,
  addLibraryFolders,
  addLibraryPinnedFiles,
  naturalCompareMediaName,
  normalizeMediaLibraryData,
  readMediaLibrary,
  removeLibraryFolder,
  removeLibraryPinnedFile,
  resumePositionForPath,
  srtToWebVtt,
  updateLibraryPlayback,
  writeMediaLibrary,
} from '../src/main/media-library'

describe('media-library store and helpers', () => {
  it('compares filenames naturally (EP2 before EP10)', () => {
    const sorted = ['EP10.mp4', 'EP2.mp4', 'EP1.mp4', 'track12.mp3', 'track3.mp3'].sort(
      naturalCompareMediaName,
    )
    expect(sorted).toEqual(['EP1.mp4', 'EP2.mp4', 'EP10.mp4', 'track3.mp3', 'track12.mp3'])
  })

  it('converts SRT subtitles with BOM and CRLF into WebVTT', () => {
    const srt = '\uFEFF1\r\n00:00:01,250 --> 00:00:04,500\r\nHello world\r\n\r\n2\r\n00:01:02,005 --> 00:01:05,100\r\nSecond cue\r\n'
    const vtt = srtToWebVtt(srt)
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true)
    expect(vtt).toContain('00:00:01.250 --> 00:00:04.500')
    expect(vtt).toContain('00:01:02.005 --> 00:01:05.100')
    expect(vtt).not.toContain('\uFEFF')
    expect(vtt).not.toContain(',250')
  })

  it('persists folders, pinned files, playback prefs, and resumes cleanly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'genoffice-media-lib-'))
    try {
      const storePath = join(dir, 'media-player.json')
      expect(readMediaLibrary(storePath)).toEqual({
        version: 1,
        folders: [],
        pinnedFiles: [],
        lastFilePath: null,
        positions: {},
        prefs: DEFAULT_MEDIA_PLAYER_PREFS,
      })

      let lib = readMediaLibrary(storePath)
      lib = addLibraryFolders(lib, [join(dir, 'Music'), join(dir, 'Music')])
      lib = addLibraryPinnedFiles(lib, [join(dir, 'single.mp3'), join(dir, 'single.mp3')])
      lib = updateLibraryPlayback(
        lib,
        {
          lastFilePath: join(dir, 'Music', '01.flac'),
          position: { filePath: join(dir, 'Music', '01.flac'), sec: 42.5, durationSec: 180 },
          prefs: { playMode: 'shuffle', volume: 0.75, playbackRate: 1.5, muted: true },
        },
        1000,
      )
      writeMediaLibrary(storePath, lib)

      const reloaded = readMediaLibrary(storePath)
      expect(reloaded.folders).toEqual([resolve(join(dir, 'Music'))])
      expect(reloaded.pinnedFiles).toEqual([resolve(join(dir, 'single.mp3'))])
      expect(reloaded.lastFilePath).toBe(resolve(join(dir, 'Music', '01.flac')))
      expect(resumePositionForPath(reloaded, join(dir, 'Music', '01.flac'))).toBe(42.5)
      expect(reloaded.prefs).toEqual({
        playMode: 'shuffle',
        volume: 0.75,
        muted: true,
        playbackRate: 1.5,
        playlistCollapsed: false,
        autoPlay: true,
      })

      // Reaching near-end clears the saved resume position automatically.
      const finished = updateLibraryPlayback(
        reloaded,
        {
          position: { filePath: join(dir, 'Music', '01.flac'), sec: 178, durationSec: 180 },
        },
        2000,
      )
      expect(resumePositionForPath(finished, join(dir, 'Music', '01.flac'))).toBe(0)

      const afterDrop = removeLibraryPinnedFile(
        removeLibraryFolder(finished, join(dir, 'Music')),
        join(dir, 'single.mp3'),
      )
      expect(afterDrop.folders).toEqual([])
      expect(afterDrop.pinnedFiles).toEqual([])

      // Corrupt JSON falls back safely to defaults.
      writeFileSync(storePath, '{broken json', 'utf8')
      expect(readMediaLibrary(storePath).folders).toEqual([])
      expect(readFileSync(storePath, 'utf8')).toBe('{broken json')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('caps stored resume positions to MAX_SAVED_POSITIONS and clamps invalid prefs', () => {
    let lib = normalizeMediaLibraryData({
      prefs: { playMode: 'invalid', volume: 5, playbackRate: 99 },
    })
    expect(lib.prefs.playMode).toBe('list')
    expect(lib.prefs.volume).toBe(1)
    expect(lib.prefs.playbackRate).toBe(3)

    for (let i = 0; i < MAX_SAVED_POSITIONS + 25; i += 1) {
      lib = updateLibraryPlayback(
        lib,
        { position: { filePath: `/media/track-${i}.mp3`, sec: 20, durationSec: 100 } },
        i + 1,
      )
    }
    expect(Object.keys(lib.positions)).toHaveLength(MAX_SAVED_POSITIONS)
    // Oldest entries were evicted, newest retained.
    expect(resumePositionForPath(lib, '/media/track-0.mp3')).toBe(0)
    expect(resumePositionForPath(lib, `/media/track-${MAX_SAVED_POSITIONS + 24}.mp3`)).toBe(20)
  })
})
