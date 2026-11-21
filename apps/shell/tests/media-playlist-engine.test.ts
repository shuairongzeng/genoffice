import { describe, expect, it, vi } from 'vitest'
import type { MediaPlaylistItem } from '../src/shared/home-api'
import {
  buildShuffleOrder,
  filterPlaylistItems,
  nextPlayMode,
  resolveNextTrackIndex,
  resolvePrevTrackIndex,
  stepPlaybackSpeed,
} from '../src/renderer/src/media-playlist-engine'

const sampleItems: MediaPlaylistItem[] = [
  {
    filePath: '/music/01.mp3',
    fileName: '01-Morning.mp3',
    ext: 'mp3',
    mediaKind: 'audio',
    mime: 'audio/mpeg',
    sizeBytes: 100,
    dirPath: '/music',
    dirName: 'music',
    source: 'folder',
  },
  {
    filePath: '/videos/clip.mp4',
    fileName: 'clip-intro.mp4',
    ext: 'mp4',
    mediaKind: 'video',
    mime: 'video/mp4',
    sizeBytes: 200,
    dirPath: '/videos',
    dirName: 'videos',
    source: 'folder',
  },
  {
    filePath: '/music/02.flac',
    fileName: '02-Night.flac',
    ext: 'flac',
    mediaKind: 'audio',
    mime: 'audio/flac',
    sizeBytes: 300,
    dirPath: '/music',
    dirName: 'music',
    source: 'folder',
  },
]

describe('media-playlist-engine', () => {
  it('cycles play modes and playback speed presets cleanly', () => {
    expect(nextPlayMode('list')).toBe('loop-all')
    expect(nextPlayMode('loop-all')).toBe('loop-one')
    expect(nextPlayMode('loop-one')).toBe('shuffle')
    expect(nextPlayMode('shuffle')).toBe('list')

    expect(stepPlaybackSpeed(1, 1)).toBe(1.25)
    expect(stepPlaybackSpeed(1, -1)).toBe(0.75)
    expect(stepPlaybackSpeed(3, 1)).toBe(3)
    expect(stepPlaybackSpeed(0.25, -1)).toBe(0.25)
  })

  it('filters playlist items by folder and search query', () => {
    expect(filterPlaylistItems(sampleItems, 'all', '')).toHaveLength(3)
    expect(filterPlaylistItems(sampleItems, '/music', '')).toHaveLength(2)
    expect(filterPlaylistItems(sampleItems, '/music', 'night').map((i) => i.fileName)).toEqual([
      '02-Night.flac',
    ])
    expect(filterPlaylistItems(sampleItems, 'all', 'videos').map((i) => i.fileName)).toEqual([
      'clip-intro.mp4',
    ])
  })

  it('resolves next and previous tracks across all 4 modes', () => {
    // list mode stops at end automatically, wraps manually
    expect(resolveNextTrackIndex({ count: 3, currentIndex: 2, mode: 'list', reason: 'ended' })).toBeNull()
    expect(resolveNextTrackIndex({ count: 3, currentIndex: 2, mode: 'list', reason: 'manual' })).toBe(0)

    // loop-all wraps both ways
    expect(resolveNextTrackIndex({ count: 3, currentIndex: 2, mode: 'loop-all', reason: 'ended' })).toBe(0)
    expect(resolvePrevTrackIndex({ count: 3, currentIndex: 0, mode: 'loop-all' })).toBe(2)

    // loop-one repeats same index on ended, advances when manually clicked
    expect(resolveNextTrackIndex({ count: 3, currentIndex: 1, mode: 'loop-one', reason: 'ended' })).toBe(1)
    expect(resolveNextTrackIndex({ count: 3, currentIndex: 1, mode: 'loop-one', reason: 'manual' })).toBe(2)

    // shuffle visits every track once in permutation
    const order = buildShuffleOrder(4, 2, () => 0.4)
    expect(order[0]).toBe(2)
    expect(new Set(order).size).toBe(4)
    expect(
      resolveNextTrackIndex({
        count: 4,
        currentIndex: 2,
        mode: 'shuffle',
        reason: 'ended',
        shuffleOrder: order,
      }),
    ).toBe(order[1])
  })

  it('filters safely in a sandboxed renderer without global process', () => {
    vi.stubGlobal('process', undefined)
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
    try {
      const winItems: MediaPlaylistItem[] = [
        { ...sampleItems[0]!, dirPath: 'D:\\Audio' },
        { ...sampleItems[1]!, dirPath: 'D:\\Video' },
      ]
      expect(filterPlaylistItems(winItems, 'd:\\audio', '')).toHaveLength(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
