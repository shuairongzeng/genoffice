// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  MediaInfo,
  MediaPlayerStateSnapshot,
  MediaPlaylistItem,
} from '../src/shared/home-api'
import { LocaleProvider } from '../src/renderer/src/locale'
import {
  MediaViewer,
  type MediaExternalCommand,
  type MediaPlaybackReport,
} from '../src/renderer/src/MediaViewer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function makeTrack(name: string, kind: 'audio' | 'video' = 'audio'): MediaPlaylistItem {
  const ext = kind === 'audio' ? 'mp3' : 'mp4'
  return {
    filePath: `/media/${name}`,
    fileName: name,
    ext,
    mediaKind: kind,
    mime: kind === 'audio' ? 'audio/mpeg' : 'video/mp4',
    sizeBytes: 2048,
    dirPath: '/media',
    dirName: 'media',
    source: 'folder',
  }
}

function makeInfo(name: string, token: string, kind: 'audio' | 'video' | 'image' = 'audio'): MediaInfo {
  const ext = kind === 'audio' ? 'mp3' : kind === 'video' ? 'mp4' : 'png'
  return {
    token,
    streamUrl: `genoffice-media://view/${token}`,
    filePath: `/media/${name}`,
    fileName: name,
    ext,
    mediaKind: kind,
    mime: kind === 'audio' ? 'audio/mpeg' : kind === 'video' ? 'video/mp4' : 'image/png',
    sizeBytes: 2048,
  }
}

describe('MediaViewer full player UI & interactions', () => {
  let host: HTMLDivElement
  let root: Root
  let playSpy: ReturnType<typeof vi.fn>
  let mediaSwitchTrack: ReturnType<typeof vi.fn>
  let mediaAddFolder: ReturnType<typeof vi.fn>
  let mediaSavePrefs: ReturnType<typeof vi.fn>

  const trackA = makeTrack('01-Alpha.mp3', 'audio')
  const trackB = makeTrack('02-Beta.mp3', 'audio')

  const baseSnapshot = (): MediaPlayerStateSnapshot => ({
    current: makeInfo('01-Alpha.mp3', 'tok-a', 'audio'),
    subtitles: [],
    items: [trackA, trackB],
    folders: [{ path: '/media', name: 'media', count: 2, persisted: true }],
    prefs: {
      playMode: 'list',
      volume: 0.9,
      muted: false,
      playbackRate: 1,
      playlistCollapsed: false,
      autoPlay: true,
    },
    resumePositionSec: 0,
    playerMode: true,
  })

  async function renderViewer(): Promise<void> {
    await act(async () => {
      root.render(
        createElement(
          LocaleProvider,
          { initial: 'en' },
          createElement(MediaViewer),
        ),
      )
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)

    playSpy = vi.fn(async () => undefined)
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      configurable: true,
      writable: true,
      value: playSpy,
    })
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    })

    mediaSwitchTrack = vi.fn(async (filePath: string) => {
      const nextName = filePath.endsWith('02-Beta.mp3') ? '02-Beta.mp3' : '01-Alpha.mp3'
      const tok = nextName === '02-Beta.mp3' ? 'tok-b' : 'tok-a'
      return {
        ok: true,
        state: {
          ...baseSnapshot(),
          current: makeInfo(nextName, tok, 'audio'),
        },
      }
    })
    mediaAddFolder = vi.fn(async () => ({
      ok: true,
      state: baseSnapshot(),
    }))
    mediaSavePrefs = vi.fn(async () => ({ ok: true }))

    ;(window as unknown as { aiOffice: Record<string, unknown> }).aiOffice = {
      mediaGetInfo: vi.fn(async () => makeInfo('01-Alpha.mp3', 'tok-a', 'audio')),
      mediaGetPlayerState: vi.fn(async () => baseSnapshot()),
      mediaSwitchTrack,
      mediaAddFolder,
      mediaAddFiles: vi.fn(async () => ({ ok: false, cancelled: true })),
      mediaPinFolder: vi.fn(async () => ({ ok: true })),
      mediaRemoveFolder: vi.fn(async () => ({ ok: true })),
      mediaRemovePinnedFile: vi.fn(async () => ({ ok: true })),
      mediaImportDropped: vi.fn(async () => ({ ok: true })),
      mediaSavePrefs,
      mediaOpenSystem: vi.fn(async () => ({ ok: true })),
      onMediaReadSnapshotRequest: vi.fn(() => () => undefined),
      sendMediaReadSnapshotReply: vi.fn(),
    }
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
    vi.restoreAllMocks()
  })

  it('auto-loads directory playlist, autoplays on open, and switches tracks on double-click', async () => {
    await renderViewer()

    expect(host.querySelector('.media-title')?.textContent).toBe('01-Alpha.mp3')
    const rows = host.querySelectorAll('[data-testid="media-playlist-item"]')
    expect(rows).toHaveLength(2)

    const audio = host.querySelector('audio')!
    expect(audio).toBeTruthy()
    expect(audio.getAttribute('crossorigin')).toBe('anonymous')
    await act(async () => {
      audio.dispatchEvent(new Event('loadedmetadata'))
    })
    expect(playSpy).toHaveBeenCalledTimes(1)

    // Double-clicking the second item calls mediaSwitchTrack and updates title
    await act(async () => {
      rows[1]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(mediaSwitchTrack).toHaveBeenCalledWith('/media/02-Beta.mp3')
    expect(host.querySelector('.media-title')?.textContent).toBe('02-Beta.mp3')
  })

  it('filters playlist by search query and cycles play modes cleanly', async () => {
    await renderViewer()

    const searchInput = host.querySelector('[data-testid="media-playlist-search"]') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(searchInput, 'Beta')
      searchInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(host.querySelectorAll('[data-testid="media-playlist-item"]')).toHaveLength(1)

    const modeBtn = host.querySelector('[data-testid="media-playmode-btn"]') as HTMLButtonElement
    expect(modeBtn.textContent).toBe('Order')
    await act(async () => {
      modeBtn.click()
    })
    expect(modeBtn.textContent).toBe('Loop All')
    expect(mediaSavePrefs).toHaveBeenCalledWith({ prefs: { playMode: 'loop-all' } })
  })

  it('shows empty library onboarding when no media exists and handles decode errors without infinite loop', async () => {
    ;(window as unknown as { aiOffice: { mediaGetPlayerState: unknown } }).aiOffice.mediaGetPlayerState =
      vi.fn(async () => ({
        current: null,
        subtitles: [],
        items: [],
        folders: [],
        prefs: baseSnapshot().prefs,
        resumePositionSec: 0,
        playerMode: true,
      }))
    await renderViewer()

    expect(host.querySelector('[data-testid="media-empty-library"]')).toBeTruthy()
    const addBtn = host.querySelector('[data-testid="media-empty-add-folder"]') as HTMLButtonElement
    await act(async () => {
      addBtn.click()
    })
    expect(mediaAddFolder).toHaveBeenCalledTimes(1)

    // Trigger an error event on audio and verify it does NOT auto-skip infinitely
    const audio = host.querySelector('audio')!
    mediaSwitchTrack.mockClear()
    await act(async () => {
      audio.dispatchEvent(new Event('error'))
    })
    expect(host.querySelector('[data-testid="media-decode-error"]')).toBeTruthy()
    expect(mediaSwitchTrack).not.toHaveBeenCalled()
  })

  it('keeps image inspection UI free of playlist chrome', async () => {
    ;(window as unknown as { aiOffice: { mediaGetPlayerState: unknown } }).aiOffice.mediaGetPlayerState =
      vi.fn(async () => ({
        current: makeInfo('photo.png', 'tok-img', 'image'),
        subtitles: [],
        items: [],
        folders: [],
        prefs: baseSnapshot().prefs,
        resumePositionSec: 0,
        playerMode: false,
      }))
    await renderViewer()

    expect(host.querySelector('[data-testid="media-playlist-aside"]')).toBeNull()
    expect(host.querySelector('.media-stage-img')).toBeTruthy()
  })

  const makeFakeCanvas2dContext = (): CanvasRenderingContext2D =>
    ({
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
      closePath: vi.fn(),
      stroke: vi.fn(),
      fill: vi.fn(),
      roundRect: vi.fn(),
      rect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      setTransform: vi.fn(),
      createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
      createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
      fillStyle: '',
      strokeStyle: '',
      globalAlpha: 1,
    }) as unknown as CanvasRenderingContext2D

  it('guards Web Audio visualizer against suspended AudioContext muting, reuses context on track switch, and closes on unmount', async () => {
    const getCtxSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(makeFakeCanvas2dContext)

    let ctxState: 'suspended' | 'running' | 'closed' = 'suspended'
    const closeSpy = vi.fn(async () => {
      ctxState = 'closed'
    })
    const resumeSpy = vi.fn(async () => undefined)
    const sourceDisconnectSpy = vi.fn()
    const sourceConnectSpy = vi.fn()
    const createMediaElementSourceSpy = vi.fn(() => ({
      connect: sourceConnectSpy,
      disconnect: sourceDisconnectSpy,
    }))
    const analyserConnectSpy = vi.fn()
    const analyserDisconnectSpy = vi.fn()
    const createAnalyserSpy = vi.fn(() => ({
      fftSize: 64,
      smoothingTimeConstant: 0.78,
      frequencyBinCount: 32,
      connect: analyserConnectSpy,
      disconnect: analyserDisconnectSpy,
      getByteFrequencyData: vi.fn(),
    }))
    let ctorCount = 0
    class FakeAudioContext {
      constructor() {
        ctorCount += 1
      }
      get state() {
        return ctxState
      }
      destination = {}
      resume = resumeSpy
      close = closeSpy
      createAnalyser = createAnalyserSpy
      createMediaElementSource = createMediaElementSourceSpy
    }
    vi.stubGlobal('AudioContext', FakeAudioContext)

    try {
      await renderViewer()
      const audio1 = host.querySelector('audio')!
      expect(audio1.getAttribute('crossorigin')).toBe('anonymous')

      // While AudioContext remains suspended, createMediaElementSource must NOT hijack audio output.
      await act(async () => {
        audio1.dispatchEvent(new Event('play'))
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(resumeSpy).toHaveBeenCalled()
      expect(createMediaElementSourceSpy).not.toHaveBeenCalled()

      // Once resume succeeds into 'running', a user gesture connects the shared graph safely.
      ctxState = 'running'
      await act(async () => {
        window.dispatchEvent(new Event('pointerdown'))
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(ctorCount).toBe(1)
      expect(createMediaElementSourceSpy).toHaveBeenCalledTimes(1)
      expect(createMediaElementSourceSpy).toHaveBeenCalledWith(audio1)
      expect(sourceConnectSpy).toHaveBeenCalledTimes(1)

      // Switching track reuses the same single AudioContext and disconnects the old source.
      const rows = host.querySelectorAll('[data-testid="media-playlist-item"]')
      await act(async () => {
        rows[1]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        await Promise.resolve()
        await Promise.resolve()
      })
      const audio2 = host.querySelector('audio')!
      await act(async () => {
        audio2.dispatchEvent(new Event('play'))
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(ctorCount).toBe(1)
      expect(sourceDisconnectSpy).toHaveBeenCalled()
      expect(createMediaElementSourceSpy).toHaveBeenCalledTimes(2)
      expect(createMediaElementSourceSpy).toHaveBeenLastCalledWith(audio2)

      // Unmounting closes the shared AudioContext cleanly.
      await act(async () => {
        root.unmount()
      })
      expect(closeSpy).toHaveBeenCalledTimes(1)
    } finally {
      getCtxSpy.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('switches 3 visualizer modes cleanly, syncs vinyl disc/tonearm & LRC lyrics, and pauses rAF when document is hidden', async () => {
    const getCtxSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(makeFakeCanvas2dContext)

    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 42)
    const cancelRafSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)

    ;(window as unknown as { aiOffice: { mediaGetPlayerState: unknown } }).aiOffice.mediaGetPlayerState =
      vi.fn(async () => ({
        ...baseSnapshot(),
        audioMeta: {
          title: 'Twilight Echo',
          artist: 'Angela',
          album: 'Skyline',
          sampleRateHz: 96000,
          bitDepth: 24,
          coverUrl: 'genoffice-media://cover/tok-a',
          lyrics: [
            { timeSec: 1.5, text: 'First synced verse' },
            { timeSec: 8.2, text: 'Second chorus line' },
          ],
        },
      }))

    try {
      await renderViewer()

      expect(host.querySelector('[data-testid="media-audio-stage"]')?.getAttribute('data-viz-mode')).toBe('vinyl')
      expect(host.querySelector('.media-audio-title')?.textContent).toBe('Twilight Echo')
      expect(host.querySelector('[data-testid="media-audio-cover"]')?.getAttribute('src')).toBe(
        'genoffice-media://cover/tok-a',
      )

      const audio = host.querySelector('audio')!
      await act(async () => {
        audio.dispatchEvent(new Event('play'))
      })
      expect(host.querySelector('[data-testid="media-vinyl-disc"]')?.classList.contains('spinning')).toBe(true)
      expect(host.querySelector('[data-testid="media-vinyl-arm"]')?.classList.contains('engaged')).toBe(true)

      // Click second lyric line to seek playback directly
      const lyricBtns = host.querySelectorAll('[data-testid="media-lyric-line"]')
      expect(lyricBtns).toHaveLength(2)
      await act(async () => {
        ;(lyricBtns[1] as HTMLButtonElement).click()
      })
      expect(audio.currentTime).toBeCloseTo(8.2, 2)

      // Cycle through bars & wave visualizer modes and persist preference
      await act(async () => {
        ;(host.querySelector('[data-testid="media-viz-mode-bars"]') as HTMLButtonElement).click()
      })
      expect(mediaSavePrefs).toHaveBeenCalledWith({ prefs: { visualizerMode: 'bars' } })
      expect(host.querySelector('[data-testid="media-audio-stage"]')?.getAttribute('data-viz-mode')).toBe('bars')

      await act(async () => {
        ;(host.querySelector('[data-testid="media-viz-mode-wave"]') as HTMLButtonElement).click()
      })
      expect(mediaSavePrefs).toHaveBeenCalledWith({ prefs: { visualizerMode: 'wave' } })
      expect(host.querySelector('[data-testid="media-audio-stage"]')?.getAttribute('data-viz-mode')).toBe('wave')

      // Hiding document stops scheduled animation loops cleanly
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'))
      })
      expect(cancelRafSpy).toHaveBeenCalled()
    } finally {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      rafSpy.mockRestore()
      cancelRafSpy.mockRestore()
      getCtxSpy.mockRestore()
    }
  })

  it('supports embedded mode without touching URL history, honors keyboardActive, preserves the audio node across mini transitions, and accepts external commands', async () => {
    const replaceSpy = vi.spyOn(window.history, 'replaceState')
    const reports: MediaPlaybackReport[] = []
    const onPlaybackReport = (report: MediaPlaybackReport) => {
      reports.push(report)
    }

    async function renderEmbedded(opts: {
      keyboardActive: boolean
      compactMini: boolean
      externalCommand?: MediaExternalCommand | null
    }): Promise<void> {
      await act(async () => {
        root.render(
          createElement(
            LocaleProvider,
            { initial: 'en' },
            createElement(MediaViewer, {
              embedded: true,
              keyboardActive: opts.keyboardActive,
              compactMini: opts.compactMini,
              externalCommand: opts.externalCommand ?? null,
              onPlaybackReport,
            }),
          ),
        )
      })
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
    }

    await renderEmbedded({ keyboardActive: false, compactMini: false })
    expect(replaceSpy).not.toHaveBeenCalled()

    const audioInitial = host.querySelector('audio')!
    expect(audioInitial).toBeTruthy()
    audioInitial.currentTime = 12

    // Space / ArrowRight do nothing when keyboardActive is false
    playSpy.mockClear()
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space' }))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    })
    expect(playSpy).not.toHaveBeenCalled()
    expect(audioInitial.currentTime).toBe(12)

    // Switching to compactMini keeps the exact same <audio> DOM element alive
    await renderEmbedded({ keyboardActive: true, compactMini: true })
    expect(host.querySelector('[data-testid="media-mini-card"]')).toBeTruthy()
    expect(host.querySelector('audio')).toBe(audioInitial)

    // Expanding back to normal still retains the same <audio> element
    await renderEmbedded({ keyboardActive: true, compactMini: false })
    expect(host.querySelector('[data-testid="media-mini-card"]')).toBeNull()
    expect(host.querySelector('audio')).toBe(audioInitial)

    // External commands trigger playback and next-track switching without rewriting window.history
    await renderEmbedded({
      keyboardActive: true,
      compactMini: false,
      externalCommand: { seq: 1, type: 'next' },
    })
    expect(mediaSwitchTrack).toHaveBeenCalledWith('/media/02-Beta.mp3')
    expect(replaceSpy).not.toHaveBeenCalled()
    expect(reports.length).toBeGreaterThan(0)
  })
})
