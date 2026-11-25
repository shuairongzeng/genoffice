import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectPlayableMediaFiles,
  listSampleMediaTracks,
  normalizeTrackSearchText,
  searchLocalMediaTracks,
  type ButlerMediaTrackCandidate,
} from '../src/main/butler/butler-media-search'

const SAMPLE_TRACKS: ButlerMediaTrackCandidate[] = [
  {
    path: 'D:\\G\\KwDownload\\mp3\\068. 买辣椒也用券 - 起风了.flac',
    title: '068. 买辣椒也用券 - 起风了',
    folder: 'D:\\G\\KwDownload\\mp3',
  },
  {
    path: 'D:\\G\\KwDownload\\mp3\\20.孤勇者 - 陈奕迅.flac',
    title: '20.孤勇者 - 陈奕迅',
    folder: 'D:\\G\\KwDownload\\mp3',
  },
  {
    path: 'D:\\G\\KwDownload\\mp3\\07.童话镇 - 小野来了.flac',
    title: '07.童话镇 - 小野来了',
    folder: 'D:\\G\\KwDownload\\mp3',
  },
  {
    path: 'D:\\G\\KwDownload\\mp3\\12.爱的初体验 - 张震岳.flac',
    title: '12.爱的初体验 - 张震岳',
    folder: 'D:\\G\\KwDownload\\mp3',
  },
]

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'genoffice-media-search-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('butler-media-search', () => {
  it('normalizes Chinese book-title marks, punctuation, and spoken request prefixes/suffixes', () => {
    expect(normalizeTrackSearchText('《起风了》（买辣椒也用券）')).toBe('起风了 买辣椒也用券')
    expect(normalizeTrackSearchText('请帮我打开《孤勇者》')).toBe('孤勇者')
    expect(normalizeTrackSearchText('起风了吧')).toBe('起风了')
    expect(normalizeTrackSearchText('播放孤勇者这首歌')).toBe('孤勇者')
    expect(normalizeTrackSearchText('《走吧》')).toBe('走吧')
  })

  it('matches song title, bracketed song + artist, artist + song, and possessive phrasing accurately', () => {
    const q1 = searchLocalMediaTracks(SAMPLE_TRACKS, '起风了')
    expect(q1.bestMatch?.path).toBe('D:\\G\\KwDownload\\mp3\\068. 买辣椒也用券 - 起风了.flac')

    const q2 = searchLocalMediaTracks(SAMPLE_TRACKS, '《起风了》（买辣椒也用券）')
    expect(q2.bestMatch?.path).toBe('D:\\G\\KwDownload\\mp3\\068. 买辣椒也用券 - 起风了.flac')

    const q3 = searchLocalMediaTracks(SAMPLE_TRACKS, '陈奕迅 孤勇者')
    expect(q3.bestMatch?.path).toBe('D:\\G\\KwDownload\\mp3\\20.孤勇者 - 陈奕迅.flac')

    const q4 = searchLocalMediaTracks(SAMPLE_TRACKS, '陈奕迅的孤勇者')
    expect(q4.bestMatch?.path).toBe('D:\\G\\KwDownload\\mp3\\20.孤勇者 - 陈奕迅.flac')

    const q5 = searchLocalMediaTracks(SAMPLE_TRACKS, '爱的初体验')
    expect(q5.bestMatch?.path).toBe('D:\\G\\KwDownload\\mp3\\12.爱的初体验 - 张震岳.flac')

    const q6 = searchLocalMediaTracks(SAMPLE_TRACKS, '起风了吧')
    expect(q6.bestMatch?.path).toBe('D:\\G\\KwDownload\\mp3\\068. 买辣椒也用券 - 起风了.flac')

    const q7 = searchLocalMediaTracks(SAMPLE_TRACKS, '播放孤勇者这首歌')
    expect(q7.bestMatch?.path).toBe('D:\\G\\KwDownload\\mp3\\20.孤勇者 - 陈奕迅.flac')
  })

  it('returns null bestMatch for tracks not present in the local library', () => {
    const res = searchLocalMediaTracks(SAMPLE_TRACKS, '根本不存在的火星交响曲')
    expect(res.bestMatch).toBeNull()
    expect(res.matches).toEqual([])
  })

  it('scans nested folders, pinned files, and lastFilePath while skipping non-media files', () => {
    const root = makeTempDir()
    const subDir = join(root, 'nested')
    const pinnedDir = makeTempDir()
    mkdirSync(subDir, { recursive: true })

    const flacPath = join(root, '068. 买辣椒也用券 - 起风了.flac')
    const mp3Path = join(subDir, '20.孤勇者 - 陈奕迅.mp3')
    const pinnedPath = join(pinnedDir, 'live.mp4')
    const txtPath = join(root, 'notes.txt')

    writeFileSync(flacPath, 'fake-flac')
    writeFileSync(mp3Path, 'fake-mp3')
    writeFileSync(pinnedPath, 'fake-mp4')
    writeFileSync(txtPath, 'not-media')

    const tracks = collectPlayableMediaFiles({
      folders: [root],
      pinnedFiles: [pinnedPath],
      lastFilePath: flacPath,
    })

    expect(tracks.map((t) => t.title)).toEqual([
      '20.孤勇者 - 陈奕迅',
      '068. 买辣椒也用券 - 起风了',
      'live',
    ])
    expect(listSampleMediaTracks(tracks, 2)).toHaveLength(2)

    const match = searchLocalMediaTracks(tracks, '起风了')
    expect(match.bestMatch?.path).toBe(flacPath)
  })
})
