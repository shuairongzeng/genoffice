import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as butlerApi from '../src/shared/butler-api'
import {
  BUTLER_VOICE_SETTINGS_KEY,
  DEFAULT_BUTLER_VOICE_CONFIG,
  DEFAULT_OMLX_API_KEY,
  DEFAULT_OMLX_BASE_URL,
  DEFAULT_OMLX_STT_MODEL,
  DEFAULT_OMLX_TTS_MODEL,
  DEFAULT_OMLX_TTS_VOICE,
  DEFAULT_WAKE_ALIASES,
  PRESET_OMLX_VOICES,
  mergeButlerVoiceConfig,
  normalizeButlerVoiceConfig,
  patchStreamingWavHeader,
  sameButlerVoiceConfig,
} from '../src/shared/butler-voice-api'
import { HOME_CHANNELS, type HomeApi } from '../src/shared/home-api'

type RendererListener = (event: unknown, ...args: unknown[]) => void

const electronMocks = vi.hoisted(() => {
  const listeners = new Map<string, Set<RendererListener>>()
  return {
    exposed: new Map<string, unknown>(),
    invoke: vi.fn(),
    send: vi.fn(),
    on: vi.fn((channel: string, listener: RendererListener) => {
      const set = listeners.get(channel) ?? new Set()
      set.add(listener)
      listeners.set(channel, set)
    }),
    removeListener: vi.fn((channel: string, listener: RendererListener) => {
      listeners.get(channel)?.delete(listener)
    }),
    listenerCount: vi.fn((channel: string) => listeners.get(channel)?.size ?? 0),
    emit: (channel: string, ...args: unknown[]) => {
      for (const listener of [...(listeners.get(channel) ?? [])]) listener({}, ...args)
    },
  }
})

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: unknown) => electronMocks.exposed.set(name, api),
  },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    send: electronMocks.send,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
    listenerCount: electronMocks.listenerCount,
  },
  webUtils: { getPathForFile: () => '' },
}))

import '../src/preload/index'

const homeApi = electronMocks.exposed.get('aiOffice') as HomeApi

beforeEach(() => {
  electronMocks.invoke.mockReset()
  electronMocks.send.mockReset()
})

describe('butler-voice-api constants and re-exports', () => {
  it('re-exports butler-voice-api symbols from butler-api', () => {
    expect(butlerApi.BUTLER_VOICE_SETTINGS_KEY).toBe('butlerVoice')
    expect(butlerApi.DEFAULT_BUTLER_VOICE_CONFIG).toEqual(DEFAULT_BUTLER_VOICE_CONFIG)
    expect(butlerApi.normalizeButlerVoiceConfig).toBe(normalizeButlerVoiceConfig)
    expect(butlerApi.patchStreamingWavHeader).toBe(patchStreamingWavHeader)
  })

  it('defines expected defaults and 9 preset oMLX voices', () => {
    expect(BUTLER_VOICE_SETTINGS_KEY).toBe('butlerVoice')
    expect(DEFAULT_OMLX_BASE_URL).toBe('http://192.168.100.235:7000/v1')
    expect(DEFAULT_OMLX_API_KEY).toBe('1234')
    expect(DEFAULT_OMLX_TTS_MODEL).toBe('Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit')
    expect(DEFAULT_OMLX_STT_MODEL).toBe('Qwen3-ASR-1.7B-8bit')
    expect(DEFAULT_OMLX_TTS_VOICE).toBe('serena')
    expect(PRESET_OMLX_VOICES).toEqual([
      'aiden',
      'dylan',
      'eric',
      'ono_anna',
      'ryan',
      'serena',
      'sohee',
      'uncle_fu',
      'vivian',
    ])
    expect(DEFAULT_WAKE_ALIASES).toBe('Jarvis,佳维斯,贾维思,小贾')
  })
})

describe('normalizeButlerVoiceConfig', () => {
  it('returns defaults on missing or non-object inputs', () => {
    for (const bad of [undefined, null, 'bad', 123, []]) {
      expect(normalizeButlerVoiceConfig(bad)).toEqual(DEFAULT_BUTLER_VOICE_CONFIG)
    }
  })

  it('normalizes baseUrl trailing slashes and falls back when invalid or empty under omlx', () => {
    expect(normalizeButlerVoiceConfig({ baseUrl: 'http://192.168.100.235:7000/v1///' }).baseUrl).toBe(
      'http://192.168.100.235:7000/v1',
    )
    expect(normalizeButlerVoiceConfig({ baseUrl: 'https://voice.example.com/api/' }).baseUrl).toBe(
      'https://voice.example.com/api',
    )
    expect(normalizeButlerVoiceConfig({ provider: 'omlx', baseUrl: '   ' }).baseUrl).toBe(
      DEFAULT_OMLX_BASE_URL,
    )
    expect(
      normalizeButlerVoiceConfig({ provider: 'omlx', baseUrl: 'ftp://invalid.host/v1' }).baseUrl,
    ).toBe(DEFAULT_OMLX_BASE_URL)
    expect(
      normalizeButlerVoiceConfig({ provider: 'omlx', baseUrl: 'javascript:alert(1)' }).baseUrl,
    ).toBe(DEFAULT_OMLX_BASE_URL)
    expect(normalizeButlerVoiceConfig({ provider: 'system', baseUrl: '' }).baseUrl).toBe('')
    expect(
      normalizeButlerVoiceConfig({ provider: 'system', baseUrl: 'not-a-valid-url' }).baseUrl,
    ).toBe(DEFAULT_OMLX_BASE_URL)
  })

  it('validates provider and sttLanguage enums with safe defaults', () => {
    expect(normalizeButlerVoiceConfig({ provider: 'system' }).provider).toBe('system')
    expect(normalizeButlerVoiceConfig({ provider: 'unknown' }).provider).toBe('omlx')

    for (const lang of ['auto', 'zh', 'en', 'ja', 'ko'] as const) {
      expect(normalizeButlerVoiceConfig({ sttLanguage: lang }).sttLanguage).toBe(lang)
    }
    expect(normalizeButlerVoiceConfig({ sttLanguage: 'fr' }).sttLanguage).toBe('auto')
  })

  it('clamps vadSilenceMs to 450..3000 step-free integer and falls back on non-finite', () => {
    expect(normalizeButlerVoiceConfig({ vadSilenceMs: 200 }).vadSilenceMs).toBe(450)
    expect(normalizeButlerVoiceConfig({ vadSilenceMs: 5000 }).vadSilenceMs).toBe(3000)
    expect(normalizeButlerVoiceConfig({ vadSilenceMs: 1456.6 }).vadSilenceMs).toBe(1457)
    expect(normalizeButlerVoiceConfig({ vadSilenceMs: 912.2 }).vadSilenceMs).toBe(912)
    expect(normalizeButlerVoiceConfig({ vadSilenceMs: Number.NaN }).vadSilenceMs).toBe(750)
    expect(normalizeButlerVoiceConfig({ vadSilenceMs: Number.POSITIVE_INFINITY }).vadSilenceMs).toBe(
      750,
    )
    expect(normalizeButlerVoiceConfig({ vadSilenceMs: '1500' }).vadSilenceMs).toBe(750)
  })

  it('sanitizes strings, enforces bounds, and preserves explicit empty apiKey or wakeAliases', () => {
    const cfg = normalizeButlerVoiceConfig({
      apiKey: '  key\nwith\tspaces  ',
      ttsModel: '   ',
      sttModel: '',
      ttsVoice: '',
      ttsInstructions: '  Calm\n\tand   polite  ',
      cloneRefText: `  你好，贾维斯！${'a'.repeat(600)}`,
      cloneAudioName: '  my\tsample.wav  ',
      wakeAliases: '',
    })
    expect(cfg.apiKey).toBe('keywithspaces')
    expect(cfg.ttsModel).toBe(DEFAULT_OMLX_TTS_MODEL)
    expect(cfg.sttModel).toBe(DEFAULT_OMLX_STT_MODEL)
    expect(cfg.ttsVoice).toBe(DEFAULT_OMLX_TTS_VOICE)
    expect(cfg.ttsInstructions).toBe('Calm and polite')
    expect(cfg.cloneRefText).toHaveLength(500)
    expect(cfg.cloneRefText.startsWith('你好，贾维斯！')).toBe(true)
    expect(cfg.cloneAudioName).toBe('my sample.wav')
    expect(cfg.wakeAliases).toBe('')
  })

  it('treats boolean switches strictly', () => {
    const weird = normalizeButlerVoiceConfig({
      fallbackToSystem: 'false',
      cloneEnabled: 1,
      cloneHasAudio: 'yes',
      wakeWordEnabled: 0,
      hotkeyAutoListen: null,
      autoSpeakReplies: 'true',
    })
    expect(weird).toEqual(DEFAULT_BUTLER_VOICE_CONFIG)

    const toggled = normalizeButlerVoiceConfig({
      fallbackToSystem: false,
      cloneEnabled: true,
      cloneHasAudio: true,
      wakeWordEnabled: false,
      hotkeyAutoListen: false,
      autoSpeakReplies: false,
    })
    expect(toggled.fallbackToSystem).toBe(false)
    expect(toggled.cloneEnabled).toBe(true)
    expect(toggled.cloneHasAudio).toBe(true)
    expect(toggled.wakeWordEnabled).toBe(false)
    expect(toggled.hotkeyAutoListen).toBe(false)
    expect(toggled.autoSpeakReplies).toBe(false)
  })
})

describe('mergeButlerVoiceConfig & sameButlerVoiceConfig', () => {
  it('merges valid patch fields and detects value differences', () => {
    const next = mergeButlerVoiceConfig(DEFAULT_BUTLER_VOICE_CONFIG, {
      provider: 'system',
      ttsVoice: 'vivian',
      vadSilenceMs: 1850,
      wakeWordEnabled: false,
    })
    expect(next.provider).toBe('system')
    expect(next.ttsVoice).toBe('vivian')
    expect(next.vadSilenceMs).toBe(1850)
    expect(next.wakeWordEnabled).toBe(false)
    expect(next.baseUrl).toBe(DEFAULT_OMLX_BASE_URL)

    expect(
      sameButlerVoiceConfig(DEFAULT_BUTLER_VOICE_CONFIG, { ...DEFAULT_BUTLER_VOICE_CONFIG }),
    ).toBe(true)
    expect(sameButlerVoiceConfig(DEFAULT_BUTLER_VOICE_CONFIG, next)).toBe(false)
  })

  it('ignores non-object patches and restores omlx default url when switching back', () => {
    expect(mergeButlerVoiceConfig(DEFAULT_BUTLER_VOICE_CONFIG, null)).toEqual(
      DEFAULT_BUTLER_VOICE_CONFIG,
    )
    expect(mergeButlerVoiceConfig(DEFAULT_BUTLER_VOICE_CONFIG, ['bad'])).toEqual(
      DEFAULT_BUTLER_VOICE_CONFIG,
    )

    const sysEmpty = mergeButlerVoiceConfig(DEFAULT_BUTLER_VOICE_CONFIG, {
      provider: 'system',
      baseUrl: '',
    })
    expect(sysEmpty.baseUrl).toBe('')

    const backToOmlx = mergeButlerVoiceConfig(sysEmpty, { provider: 'omlx' })
    expect(backToOmlx.baseUrl).toBe(DEFAULT_OMLX_BASE_URL)
  })
})

describe('patchStreamingWavHeader', () => {
  function makeStreamingWav(payloadBytes: number): Uint8Array {
    const buf = new Uint8Array(44 + payloadBytes)
    buf.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
    buf.set([0xff, 0xff, 0xff, 0xff], 4) // placeholder file size
    buf.set([0x57, 0x41, 0x56, 0x45], 8) // WAVE
    buf.set([0x66, 0x6d, 0x74, 0x20], 12) // fmt
    buf.set([0x64, 0x61, 0x74, 0x61], 36) // data
    buf.set([0xff, 0xff, 0xff, 0xff], 40) // placeholder data size
    return buf
  }

  it('writes exact RIFF and data chunk sizes without mutating the source buffer', () => {
    const source = makeStreamingWav(1024)
    const patched = patchStreamingWavHeader(source)

    expect(patched).not.toBe(source)
    expect(patched.length).toBe(1068)

    const patchedView = new DataView(patched.buffer, patched.byteOffset, patched.byteLength)
    expect(patchedView.getUint32(4, true)).toBe(1060)
    expect(patchedView.getUint32(40, true)).toBe(1024)

    // Source buffer keeps original 0xFFFFFFFF placeholders.
    const sourceView = new DataView(source.buffer, source.byteOffset, source.byteLength)
    expect(sourceView.getUint32(4, true)).toBe(0xffffffff)
    expect(sourceView.getUint32(40, true)).toBe(0xffffffff)
  })

  it('handles offset views and leaves short or non-WAV buffers unchanged', () => {
    const backing = new Uint8Array(128)
    const wav = makeStreamingWav(16)
    backing.set(wav, 10)
    const sliceView = backing.subarray(10, 10 + wav.length)
    const patchedSlice = patchStreamingWavHeader(sliceView)
    const view = new DataView(patchedSlice.buffer, patchedSlice.byteOffset, patchedSlice.byteLength)
    expect(view.getUint32(4, true)).toBe(52)
    expect(view.getUint32(40, true)).toBe(16)

    const shortBuf = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0xff, 0xff])
    expect(patchStreamingWavHeader(shortBuf)).toEqual(shortBuf)

    const nonWav = new Uint8Array(64).fill(0xab)
    expect(patchStreamingWavHeader(nonWav)).toEqual(nonWav)
  })
})

describe('HOME_CHANNELS and preload butlerVoice bridge', () => {
  it('wires config, probe, STT, TTS stream events, clone, wake, and arbitration IPC channels', async () => {
    electronMocks.invoke.mockResolvedValueOnce({ provider: 'system', vadSilenceMs: 900 })
    const loaded = await homeApi.getButlerVoiceConfig?.()
    expect(electronMocks.invoke).toHaveBeenCalledWith(HOME_CHANNELS.butlerVoiceGet)
    expect(loaded?.provider).toBe('system')
    expect(loaded?.vadSilenceMs).toBe(900)

    electronMocks.invoke.mockResolvedValueOnce({ ttsVoice: 'vivian' })
    const saved = await homeApi.setButlerVoiceConfig?.({ ttsVoice: 'vivian' })
    expect(electronMocks.invoke).toHaveBeenCalledWith(HOME_CHANNELS.butlerVoiceSet, {
      ttsVoice: 'vivian',
    })
    expect(saved?.ttsVoice).toBe('vivian')

    const cfgUpdates: unknown[] = []
    const offCfg = homeApi.onButlerVoiceConfigChanged?.((cfg) => cfgUpdates.push(cfg))
    electronMocks.emit(HOME_CHANNELS.butlerVoiceChanged, { vadSilenceMs: 5000 })
    offCfg?.()
    expect(cfgUpdates).toHaveLength(1)
    expect((cfgUpdates[0] as { vadSilenceMs: number }).vadSilenceMs).toBe(3000)

    await homeApi.butlerVoiceProbe?.({ baseUrl: 'http://127.0.0.1:7000/v1' })
    expect(electronMocks.invoke).toHaveBeenCalledWith(HOME_CHANNELS.butlerVoiceProbe, {
      baseUrl: 'http://127.0.0.1:7000/v1',
    })

    await homeApi.butlerVoiceTranscribe?.({ wavBase64: 'AAAA', purpose: 'wake' })
    expect(electronMocks.invoke).toHaveBeenCalledWith(HOME_CHANNELS.butlerVoiceTranscribe, {
      wavBase64: 'AAAA',
      purpose: 'wake',
    })

    await homeApi.butlerVoiceTtsStart?.({ requestId: 'req-1', text: 'hello' })
    expect(electronMocks.invoke).toHaveBeenCalledWith(HOME_CHANNELS.butlerVoiceTtsStart, {
      requestId: 'req-1',
      text: 'hello',
    })

    await homeApi.butlerVoiceTtsStop?.('req-1')
    expect(electronMocks.invoke).toHaveBeenCalledWith(HOME_CHANNELS.butlerVoiceTtsStop, 'req-1')

    const ttsEvents: unknown[] = []
    const offTts = homeApi.onButlerVoiceTtsEvent?.((ev) => ttsEvents.push(ev))
    electronMocks.emit(HOME_CHANNELS.butlerVoiceTtsEvent, {
      requestId: 'req-1',
      type: 'chunk',
      chunk: new Uint8Array([1, 2, 3]).buffer,
    })
    electronMocks.emit(HOME_CHANNELS.butlerVoiceTtsEvent, { invalid: true })
    offTts?.()
    expect(ttsEvents).toHaveLength(1)
    expect((ttsEvents[0] as { chunk: Uint8Array }).chunk).toEqual(new Uint8Array([1, 2, 3]))

    await homeApi.butlerVoiceCloneGet?.()
    expect(electronMocks.invoke).toHaveBeenCalledWith(HOME_CHANNELS.butlerVoiceCloneGet)

    electronMocks.invoke.mockResolvedValueOnce({ cloneHasAudio: true, cloneAudioName: 'ref.wav' })
    const afterSetClone = await homeApi.butlerVoiceCloneSet?.({
      audioBase64: 'UklGRg==',
      fileName: 'ref.wav',
    })
    expect(electronMocks.invoke).toHaveBeenCalledWith(HOME_CHANNELS.butlerVoiceCloneSet, {
      audioBase64: 'UklGRg==',
      fileName: 'ref.wav',
    })
    expect(afterSetClone?.cloneHasAudio).toBe(true)

    electronMocks.invoke.mockResolvedValueOnce({ cloneHasAudio: false })
    await homeApi.butlerVoiceCloneClear?.()
    expect(electronMocks.invoke).toHaveBeenCalledWith(HOME_CHANNELS.butlerVoiceCloneClear)

    await homeApi.butlerVoiceWakeSummon?.({
      mode: 'command',
      rawText: '贾维斯打开设置',
      commandText: '打开设置',
    })
    expect(electronMocks.invoke).toHaveBeenCalledWith(HOME_CHANNELS.butlerVoiceWakeSummon, {
      mode: 'command',
      rawText: '贾维斯打开设置',
      commandText: '打开设置',
    })

    const wakePrompts: unknown[] = []
    const offWake = homeApi.onButlerVoiceWakePrompt?.((p) => wakePrompts.push(p))
    electronMocks.emit(HOME_CHANNELS.butlerVoiceWakePrompt, { autoListen: true, wakeAck: false })
    offWake?.()
    expect(wakePrompts).toEqual([{ autoListen: true, wakeAck: false }])

    homeApi.reportButlerVoiceArbitration?.({ deskMicActive: true })
    expect(electronMocks.send).toHaveBeenCalledWith(HOME_CHANNELS.butlerVoiceArbitration, {
      deskMicActive: true,
    })

    const arbStates: unknown[] = []
    const offArb = homeApi.onButlerVoiceArbitration?.((s) => arbStates.push(s))
    electronMocks.emit(HOME_CHANNELS.butlerVoiceArbitration, {
      deskMicActive: true,
      ttsSpeaking: false,
      updatedAt: 42,
    })
    offArb?.()
    expect(arbStates).toEqual([{ deskMicActive: true, ttsSpeaking: false, updatedAt: 42 }])

    const speakPayloads: unknown[] = []
    const offSpeak = homeApi.onButlerSpeak?.((req) => speakPayloads.push(req))
    electronMocks.emit(HOME_CHANNELS.butlerSpeak, {
      text: 'All done.',
      enqueue: true,
      phase: 'completed',
      openFollowUp: true,
    })
    offSpeak?.()
    expect(speakPayloads).toEqual([
      {
        text: 'All done.',
        enqueue: true,
        phase: 'completed',
        openFollowUp: true,
      },
    ])
  })
})
