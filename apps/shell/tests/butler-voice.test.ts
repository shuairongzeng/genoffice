/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  getButlerSpeechState,
  isButlerSpeakingOrEchoGuard,
  isButlerSpeechQueueBusy,
  pickVoice,
  speakButlerSmart,
  startButlerMicCapture,
  stopButlerSpeech,
  subscribeButlerSpeechState,
  type ButlerSpeechState,
  type ButlerVoiceCandidate,
} from '../src/renderer/src/butler-voice'
import { DEFAULT_BUTLER_PREFS } from '../src/shared/butler-prefs'
import { DEFAULT_BUTLER_VOICE_CONFIG, type ButlerVoiceTtsEvent } from '../src/shared/butler-voice-api'

const SAMPLE_VOICES: ButlerVoiceCandidate[] = [
  { name: 'Google US English', lang: 'en-US', localService: false },
  { name: 'Microsoft David', lang: 'en-US', localService: true },
  { name: 'Google 普通话', lang: 'zh-CN', localService: false },
  { name: 'Microsoft Huihui', lang: 'zh-CN', localService: true },
  { name: 'Kyoko', lang: 'ja-JP', localService: false },
]

describe('pickVoice', () => {
  it('prefers an exact preferredName match over language heuristics', () => {
    const chosen = pickVoice(SAMPLE_VOICES, 'zh-CN', 'Google US English')
    expect(chosen?.name).toBe('Google US English')
  })

  it('matches primary language subtag and prefers localService voices', () => {
    const zh = pickVoice(SAMPLE_VOICES, 'zh-CN', '')
    expect(zh?.name).toBe('Microsoft Huihui')

    const en = pickVoice(SAMPLE_VOICES, 'en-GB', '')
    expect(en?.name).toBe('Microsoft David')
  })

  it('falls back to non-local matching language voice when no localService voice exists', () => {
    const ja = pickVoice(SAMPLE_VOICES, 'ja', 'NonExistentVoice')
    expect(ja?.name).toBe('Kyoko')
  })

  it('returns null when voices list is empty or no language matches', () => {
    expect(pickVoice([], 'zh-CN', '')).toBeNull()
    expect(pickVoice(SAMPLE_VOICES, 'fr-FR', '')).toBeNull()
  })
})

describe('speakButlerSmart queued streaming', () => {
  afterEach(() => {
    stopButlerSpeech()
    vi.restoreAllMocks()
    delete (window as unknown as { aiOffice?: unknown }).aiOffice
  })

  it('keeps speaking true across queued streaming sentences and emits false only after queue drains', async () => {
    const ttsListeners = new Set<(event: ButlerVoiceTtsEvent) => void>()
    const startedRequests: Array<{ requestId: string; text: string }> = []
    const arbitrationCalls: Array<{ ttsSpeaking?: boolean }> = []

    class FakeAudioContext {
      currentTime = 0
      state = 'running'
      sampleRate = 24000
      destination = {}
      createBuffer(_channels: number, length: number, sampleRate: number) {
        const data = new Float32Array(length)
        return {
          duration: length / sampleRate,
          getChannelData: () => data,
        }
      }
      createBufferSource() {
        return {
          buffer: null,
          onended: null as (() => void) | null,
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          disconnect: vi.fn(),
        }
      }
      resume = vi.fn().mockResolvedValue(undefined)
      close = vi.fn().mockResolvedValue(undefined)
    }

    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      writable: true,
      value: FakeAudioContext,
    })
    ;(window as unknown as { aiOffice?: unknown }).aiOffice = {
      onButlerVoiceTtsEvent: (cb: (event: ButlerVoiceTtsEvent) => void) => {
        ttsListeners.add(cb)
        return () => {
          ttsListeners.delete(cb)
        }
      },
      butlerVoiceTtsStart: async (req: { requestId: string; text: string }) => {
        startedRequests.push({ requestId: req.requestId, text: req.text })
        return { ok: true }
      },
      butlerVoiceTtsStop: vi.fn().mockResolvedValue({ ok: true }),
      reportButlerVoiceArbitration: (patch: { ttsSpeaking?: boolean }) => {
        arbitrationCalls.push(patch)
      },
    }

    const states: ButlerSpeechState[] = []
    const unsub = subscribeButlerSpeechState((s) => states.push(s))

    const opts = {
      prefs: { ...DEFAULT_BUTLER_PREFS, voice: true },
      voiceConfig: { ...DEFAULT_BUTLER_VOICE_CONFIG, provider: 'omlx' as const },
      langTag: 'en-US',
      enqueue: true,
      sourceId: 'stream-turn-1',
    }

    const p1 = speakButlerSmart('First sentence.', opts)
    const p2 = speakButlerSmart('Second sentence.', opts)
    const p3 = speakButlerSmart('Third sentence.', opts)

    await Promise.resolve()
    await Promise.resolve()

    expect(startedRequests.map((r) => r.text)).toEqual(['First sentence.'])
    expect(isButlerSpeechQueueBusy()).toBe(true)
    expect(states).toEqual([{ speaking: true, sourceId: 'stream-turn-1' }])
    expect(arbitrationCalls).toEqual([{ ttsSpeaking: true }])

    for (const listener of [...ttsListeners]) {
      listener({ requestId: startedRequests[0]!.requestId, type: 'done' })
    }
    await p1
    await Promise.resolve()
    await Promise.resolve()

    expect(startedRequests.map((r) => r.text)).toEqual(['First sentence.', 'Second sentence.'])
    expect(states.every((s) => s.speaking === true)).toBe(true)
    expect(isButlerSpeechQueueBusy()).toBe(true)
    expect(arbitrationCalls).toEqual([{ ttsSpeaking: true }])

    for (const listener of [...ttsListeners]) {
      listener({ requestId: startedRequests[1]!.requestId, type: 'done' })
    }
    await p2
    await Promise.resolve()
    await Promise.resolve()

    expect(startedRequests.map((r) => r.text)).toEqual([
      'First sentence.',
      'Second sentence.',
      'Third sentence.',
    ])
    expect(states.every((s) => s.speaking === true)).toBe(true)
    expect(isButlerSpeechQueueBusy()).toBe(true)

    for (const listener of [...ttsListeners]) {
      listener({ requestId: startedRequests[2]!.requestId, type: 'done' })
    }
    await p3

    expect(states).toEqual([
      { speaking: true, sourceId: 'stream-turn-1' },
      { speaking: false, sourceId: null },
    ])
    expect(getButlerSpeechState().speaking).toBe(false)
    expect(isButlerSpeechQueueBusy()).toBe(false)
    expect(isButlerSpeakingOrEchoGuard()).toBe(true)
    expect(arbitrationCalls).toEqual([{ ttsSpeaking: true }, { ttsSpeaking: false }])

    unsub()
  })
})

describe('startButlerMicCapture audio constraints', () => {
  it('requests mono echo-cancelled noise-suppressed auto-gain mic constraints', async () => {
    const stopTrack = vi.fn()
    const getUserMedia = vi.fn().mockResolvedValue({
      getTracks: () => [{ stop: stopTrack }],
    })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    })

    class FakeCaptureCtx {
      state = 'running'
      sampleRate = 48000
      destination = {}
      createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }))
      createScriptProcessor = vi.fn(() => ({
        onaudioprocess: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
      }))
      createGain = vi.fn(() => ({
        gain: { value: 0 },
        connect: vi.fn(),
        disconnect: vi.fn(),
      }))
      createBiquadFilter = vi.fn(() => ({
        type: 'highpass',
        frequency: { value: 0 },
        Q: { value: 0 },
        connect: vi.fn(),
        disconnect: vi.fn(),
      }))
      resume = vi.fn().mockResolvedValue(undefined)
      close = vi.fn().mockResolvedValue(undefined)
    }

    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      writable: true,
      value: FakeCaptureCtx,
    })

    const handle = startButlerMicCapture({ onSpeechSegment: vi.fn() })
    await Promise.resolve()
    await Promise.resolve()

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })

    handle.stop()
    expect(stopTrack).toHaveBeenCalledTimes(1)
  })
})
