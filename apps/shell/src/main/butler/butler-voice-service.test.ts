import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (event: { sender: unknown }, ...args: unknown[]) => unknown

const ipcMock = vi.hoisted(() => {
  const handles = new Map<string, IpcHandler>()
  const ons = new Map<string, IpcHandler>()
  return {
    handles,
    ons,
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handles.set(channel, handler)
    }),
    on: vi.fn((channel: string, handler: IpcHandler) => {
      ons.set(channel, handler)
    }),
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: ipcMock.handle,
    on: ipcMock.on,
  },
}))

import { writeAppSetting, writeAppSettings } from '../app-settings'
import { registerButlerIpc } from './butler-ipc'
import { writeButlerPrefs } from './butler-prefs-store'
import {
  BUTLER_VOICE_SETTINGS_KEY,
  DEFAULT_BUTLER_VOICE_CONFIG,
  DEFAULT_OMLX_TTS_VOICE,
  PRESET_OMLX_VOICES,
  type ButlerTtsStreamEvent,
  type ButlerVoiceConfig,
} from '../../shared/butler-voice-api'
import { DEFAULT_BUTLER_PREFS } from '../../shared/butler-prefs'
import { HOME_CHANNELS } from '../../shared/home-api'
import {
  butlerVoiceClonePath,
  createButlerVoiceService,
  readButlerVoiceConfig,
  watchButlerVoiceConfig,
  writeButlerVoiceConfig,
} from './butler-voice-service'

let tempRoot: string
let settingsPath: string
let clonePath: string

function createValidWavBase64(extraPayload = '1234'): string {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + extraPayload.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(24000, 24)
  header.writeUInt32LE(48000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(extraPayload.length, 40)
  return Buffer.concat([header, Buffer.from(extraPayload, 'utf8')]).toString('base64')
}

function createStreamResponse(chunks: Uint8Array[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk)
      }
      controller.close()
    },
  })
  return new Response(stream, { status })
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'genoffice-butler-voice-'))
  settingsPath = join(tempRoot, 'app-settings.json')
  clonePath = butlerVoiceClonePath(tempRoot)
  ipcMock.handles.clear()
  ipcMock.ons.clear()
  ipcMock.handle.mockClear()
  ipcMock.on.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(tempRoot, { recursive: true, force: true })
})

describe('butler voice config persistence & watcher', () => {
  const settle = (probe: () => void): Promise<void> =>
    vi.waitFor(probe, { timeout: 5000, interval: 50 })

  const armed = (): Promise<void> =>
    new Promise((resolve) =>
      setImmediate(() => {
        setTimeout(resolve, 25)
      }),
    )

  it('reads defaults and persists normalized patches', () => {
    expect(readButlerVoiceConfig(settingsPath)).toEqual(DEFAULT_BUTLER_VOICE_CONFIG)

    const updated = writeButlerVoiceConfig(settingsPath, {
      baseUrl: 'http://192.168.100.235:7000/v1///',
      vadSilenceMs: 9999,
      sttLanguage: 'zh',
    })

    expect(updated.baseUrl).toBe('http://192.168.100.235:7000/v1')
    expect(updated.vadSilenceMs).toBe(3000)
    expect(updated.sttLanguage).toBe('zh')

    const raw = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect(raw[BUTLER_VOICE_SETTINGS_KEY]).toEqual(updated)
  })

  it('watches config changes with debounce and ignores unrelated rewrites', async () => {
    const seen: ButlerVoiceConfig[] = []
    const stop = watchButlerVoiceConfig(settingsPath, (cfg) => seen.push(cfg))
    try {
      await armed()
      writeButlerVoiceConfig(settingsPath, { ttsVoice: 'vivian', autoSpeakReplies: false })
      await settle(() => {
        expect(seen).toHaveLength(1)
        expect(seen[0]!.ttsVoice).toBe('vivian')
        expect(seen[0]!.autoSpeakReplies).toBe(false)
      })

      writeAppSetting(settingsPath, 'language', 'en')
      writeAppSettings(settingsPath, {
        [BUTLER_VOICE_SETTINGS_KEY]: seen[0],
      })
      await new Promise((resolve) => setTimeout(resolve, 350))
      expect(seen).toHaveLength(1)
    } finally {
      stop()
    }
  })
})

describe('butler voice clone store', () => {
  it('validates RIFF/WAVE header, enforces 10MB limit, strips data URI, and clears cleanly', async () => {
    const svc = createButlerVoiceService({
      settingsPath: () => settingsPath,
      cloneStorePath: () => clonePath,
      now: () => 123456789,
    })

    expect(svc.getCloneState()).toEqual({
      hasAudio: false,
      fileName: '',
      byteLength: 0,
      updatedAt: null,
    })

    await expect(
      svc.setCloneAudio({
        audioBase64: Buffer.from('NOT_A_WAV_FILE').toString('base64'),
        fileName: 'bad.wav',
      }),
    ).rejects.toThrow(/RIFF\/WAVE/)

    const huge = Buffer.alloc(10 * 1024 * 1024 + 1)
    huge.write('RIFF', 0, 'ascii')
    huge.write('WAVE', 8, 'ascii')
    await expect(
      svc.setCloneAudio({
        audioBase64: huge.toString('base64'),
        fileName: 'huge.wav',
      }),
    ).rejects.toThrow(/10MB/)

    const rawBase64 = createValidWavBase64('voice-sample')
    const cfgAfterSet = await svc.setCloneAudio({
      audioBase64: `data:audio/wav;base64,${rawBase64}`,
      fileName: 'C:\\clips\\jarvis-ref.wav',
      refText: '你好，我是贾维斯。',
    })

    expect(cfgAfterSet.cloneHasAudio).toBe(true)
    expect(cfgAfterSet.cloneAudioName).toBe('jarvis-ref.wav')
    expect(cfgAfterSet.cloneRefText).toBe('你好，我是贾维斯。')
    expect(existsSync(clonePath)).toBe(true)

    const stored = JSON.parse(readFileSync(clonePath, 'utf8')) as { audioBase64: string }
    expect(stored.audioBase64).toBe(rawBase64)
    expect(svc.getCloneState()).toEqual({
      hasAudio: true,
      fileName: 'jarvis-ref.wav',
      byteLength: Buffer.from(rawBase64, 'base64').byteLength,
      updatedAt: 123456789,
    })

    const cfgAfterClear = await svc.clearCloneAudio()
    expect(cfgAfterClear.cloneHasAudio).toBe(false)
    expect(cfgAfterClear.cloneAudioName).toBe('')
    expect(cfgAfterClear.cloneEnabled).toBe(false)
    expect(existsSync(clonePath)).toBe(false)
    expect(svc.getCloneState().hasAudio).toBe(false)
  })
})

describe('oMLX probe, STT serial queue, and streaming TTS', () => {
  it('probes models and voices with auth header and merges preset voices', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      expect(init?.headers).toEqual({ Authorization: 'Bearer secret-key' })
      if (url.endsWith('/models')) {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'Qwen3-ASR-1.7B-8bit', model_type: 'audio_stt' },
              { id: 'Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit', model_type: 'audio_tts' },
              { id: 'heuristic-whisper-large-v3' },
              { id: 'heuristic-kokoro-tts' },
              { id: 'Qwen3-32B-Instruct', model_type: 'llm' },
            ],
          }),
          { status: 200 },
        )
      }
      if (url.includes('/audio/voices')) {
        return new Response(JSON.stringify({ voices: ['custom_voice', 'serena'] }), { status: 200 })
      }
      return new Response('Not Found', { status: 404 })
    })

    const svc = createButlerVoiceService({
      settingsPath: () => settingsPath,
      cloneStorePath: () => clonePath,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    const res = await svc.probe({
      baseUrl: 'http://127.0.0.1:7000/v1/',
      apiKey: 'secret-key',
      ttsModel: 'Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit',
    })

    expect(res.ok).toBe(true)
    expect(res.sttModels).toEqual(['Qwen3-ASR-1.7B-8bit', 'heuristic-whisper-large-v3'])
    expect(res.ttsModels).toEqual([
      'Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit',
      'heuristic-kokoro-tts',
    ])
    expect(res.voices[0]).toBe('custom_voice')
    for (const preset of PRESET_OMLX_VOICES) {
      expect(res.voices).toContain(preset)
    }
  })

  it('serializes STT calls, prioritizes command over wake, and drops stale queued wake jobs', async () => {
    const executionOrder: string[] = []
    let activeCount = 0
    let maxConcurrent = 0
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const seenLanguages: Array<string | null> = []

    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      activeCount += 1
      maxConcurrent = Math.max(maxConcurrent, activeCount)
      const form = init?.body as FormData
      const prompt = form.get('prompt')
      seenLanguages.push(form.get('language') as string | null)
      const label = typeof prompt === 'string' ? prompt : 'unknown'
      executionOrder.push(label)

      if (label === 'first-wake') {
        await firstGate
      } else {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }

      activeCount -= 1
      return new Response(JSON.stringify({ text: `ok:${label}`, language: 'zh', duration: 1.2 }), {
        status: 200,
      })
    })

    const svc = createButlerVoiceService({
      settingsPath: () => settingsPath,
      cloneStorePath: () => clonePath,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    const wavBytes = Buffer.from(createValidWavBase64('speech'), 'base64')

    const pWake1 = svc.transcribe({ wavBytes, purpose: 'wake', prompt: 'first-wake' })
    const pWakeOld = svc.transcribe({ wavBytes, purpose: 'wake', prompt: 'stale-wake' })
    const pCmd = svc.transcribe({
      wavBytes,
      purpose: 'command',
      language: 'zh',
      prompt: 'priority-command',
    })
    const pWakeNew = svc.transcribe({ wavBytes, purpose: 'wake', prompt: 'fresh-wake' })

    // Let first-wake hit fetchMock before releasing.
    await new Promise((resolve) => setTimeout(resolve, 15))
    releaseFirst()

    const [rWake1, rWakeOld, rCmd, rWakeNew] = await Promise.all([
      pWake1,
      pWakeOld,
      pCmd,
      pWakeNew,
    ])

    expect(maxConcurrent).toBe(1)
    expect(rWake1.ok).toBe(true)
    expect(rWake1.text).toBe('ok:first-wake')
    expect(rWakeOld.ok).toBe(false)
    expect(rWakeOld.error).toMatch(/Superseded/)
    expect(rCmd.ok).toBe(true)
    expect(rCmd.text).toBe('ok:priority-command')
    expect(rWakeNew.ok).toBe(true)
    expect(rWakeNew.text).toBe('ok:fresh-wake')
    expect(executionOrder).toEqual(['first-wake', 'priority-command', 'fresh-wake'])
    expect(seenLanguages).toEqual([null, 'zh', null])
  })

  it('enforces Voice Clone Guard and system fallback in startTts', async () => {
    const sentPayloads: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      sentPayloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return createStreamResponse([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])])
    })

    const svc = createButlerVoiceService({
      settingsPath: () => settingsPath,
      cloneStorePath: () => clonePath,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    // System provider immediately triggers system fallback.
    writeButlerVoiceConfig(settingsPath, { provider: 'system' })
    const sysRes = await svc.startTts({ requestId: 'tts-sys', text: 'hello' }, () => {})
    expect(sysRes).toEqual({ ok: false, requestId: 'tts-sys', fallbackSystem: true })
    expect(fetchMock).not.toHaveBeenCalled()

    // Clone enabled without clone audio or refText must NOT send ref_audio/ref_text, and always keeps voice non-empty.
    writeButlerVoiceConfig(settingsPath, {
      provider: 'omlx',
      cloneEnabled: true,
      cloneRefText: '',
      ttsVoice: '',
    })

    const events1: ButlerTtsStreamEvent[] = []
    const res1 = await svc.startTts({ requestId: 'tts-1', text: '你好', speed: 1.1 }, (ev) =>
      events1.push(ev),
    )
    expect(res1).toEqual({ ok: true, requestId: 'tts-1' })
    await vi.waitFor(() => {
      expect(events1.some((e) => e.type === 'done')).toBe(true)
    })
    expect(sentPayloads[0]).toMatchObject({
      voice: DEFAULT_OMLX_TTS_VOICE,
      stream: true,
      response_format: 'wav',
      streaming_interval: 0.3,
      speed: 1.1,
    })
    expect(sentPayloads[0]!.ref_audio).toBeUndefined()
    expect(sentPayloads[0]!.ref_text).toBeUndefined()

    // Now upload valid WAV + refText -> ref_audio (pure base64) and ref_text MUST be attached along with non-empty voice.
    const rawWav = createValidWavBase64('clone-ref')
    await svc.setCloneAudio({
      audioBase64: `data:audio/wav;base64,${rawWav}`,
      fileName: 'ref.wav',
      refText: '参考音频文本',
    })

    const events2: ButlerTtsStreamEvent[] = []
    await svc.startTts(
      { requestId: 'tts-2', text: '收到', instructions: '平静温和' },
      (ev) => events2.push(ev),
    )
    await vi.waitFor(() => {
      expect(events2.some((e) => e.type === 'done')).toBe(true)
    })

    expect(sentPayloads[1]).toMatchObject({
      voice: DEFAULT_OMLX_TTS_VOICE,
      instructions: '平静温和',
      ref_audio: rawWav,
      ref_text: '参考音频文本',
    })
    expect(events2.map((e) => e.type)).toEqual(['chunk', 'chunk', 'done'])
  })

  it('aborts older TTS silently when superseded or stopped, and emits error with fallbackSystem on failure', async () => {
    const eventsOld: ButlerTtsStreamEvent[] = []
    const eventsNew: ButlerTtsStreamEvent[] = []
    let callIdx = 0

    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      callIdx += 1
      if (callIdx === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'))
          })
        })
      }
      return Promise.resolve(new Response('Server crashed', { status: 500 }))
    })

    const svc = createButlerVoiceService({
      settingsPath: () => settingsPath,
      cloneStorePath: () => clonePath,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    writeButlerVoiceConfig(settingsPath, { fallbackToSystem: true })

    await svc.startTts({ requestId: 'old-tts', text: 'First utterance' }, (ev) => eventsOld.push(ev))
    await new Promise((resolve) => setTimeout(resolve, 15))

    await svc.startTts({ requestId: 'new-tts', text: 'Second utterance' }, (ev) =>
      eventsNew.push(ev),
    )
    await vi.waitFor(() => {
      expect(eventsNew).toHaveLength(1)
    })

    expect(eventsOld).toEqual([])
    expect(eventsNew[0]).toMatchObject({
      requestId: 'new-tts',
      type: 'error',
      fallbackSystem: true,
    })
  })

  it('enforces 8s first-byte timeout on stalled TTS stream', async () => {
    vi.useFakeTimers()
    const events: ButlerTtsStreamEvent[] = []

    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        })
      })
    })

    const svc = createButlerVoiceService({
      settingsPath: () => settingsPath,
      cloneStorePath: () => clonePath,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    await svc.startTts({ requestId: 'timeout-tts', text: 'Testing timeout' }, (ev) =>
      events.push(ev),
    )

    await vi.advanceTimersByTimeAsync(8100)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      requestId: 'timeout-tts',
      type: 'error',
      fallbackSystem: true,
      error: 'TTS first-byte timeout',
    })
  })

  it('enforces 45s total stream timeout and keeps stopTts silent', async () => {
    vi.useFakeTimers()
    const totalEvents: ButlerTtsStreamEvent[] = []
    const stopEvents: ButlerTtsStreamEvent[] = []
    let callIdx = 0

    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      callIdx += 1
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3, 4]))
          init?.signal?.addEventListener('abort', () => {
            controller.error(new DOMException('Aborted', 'AbortError'))
          })
        },
      })
      return Promise.resolve(new Response(stream, { status: 200 }))
    })

    const svc = createButlerVoiceService({
      settingsPath: () => settingsPath,
      cloneStorePath: () => clonePath,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    await svc.startTts({ requestId: 'total-timeout-tts', text: 'Long stream' }, (ev) =>
      totalEvents.push(ev),
    )

    await vi.advanceTimersByTimeAsync(45100)
    expect(callIdx).toBe(1)
    expect(totalEvents.map((e) => e.type)).toEqual(['chunk', 'error'])
    expect(totalEvents[1]).toMatchObject({
      requestId: 'total-timeout-tts',
      type: 'error',
      fallbackSystem: true,
      error: 'TTS total stream timeout',
    })

    await svc.startTts({ requestId: 'manual-stop-tts', text: 'Cancel me' }, (ev) =>
      stopEvents.push(ev),
    )
    await vi.advanceTimersByTimeAsync(20)
    svc.stopTts('manual-stop-tts')
    await vi.advanceTimersByTimeAsync(500)
    expect(stopEvents.map((e) => e.type)).toEqual(['chunk'])
  })
})

describe('registerButlerIpc voice & wake channels', () => {
  const hudSender = { id: 101, send: vi.fn(), isDestroyed: () => false } as never
  const shellSender = { id: 202, send: vi.fn(), isDestroyed: () => false } as never
  const strangerSender = { id: 303, send: vi.fn(), isDestroyed: () => false } as never

  it('gates voice IPC channels, streams TTS events, handles wake summon, and broadcasts arbitration', async () => {
    const showHud = vi.fn()
    const focusHud = vi.fn()
    const broadcastShell = vi.fn()
    const broadcastHud = vi.fn()
    const delegate = vi.fn(async () => ({ ok: true, missionId: 'm-1' }))

    const svc = createButlerVoiceService({
      settingsPath: () => settingsPath,
      cloneStorePath: () => clonePath,
      fetchImpl: vi.fn(async () =>
        createStreamResponse([new Uint8Array([9, 8, 7])]),
      ) as unknown as typeof fetch,
    })

    registerButlerIpc({
      settingsPath: () => settingsPath,
      service: {
        submit: vi.fn(() => ({ ok: true, sessionKey: 'default:butler-1' })),
        hudState: vi.fn(() => ({
          prefs: DEFAULT_BUTLER_PREFS,
          hotkey: 'Alt+Space',
          briefing: null,
          tasks: [],
        })),
      },
      missionEngine: {
        getSnapshot: vi.fn(),
        delegate,
      } as never,
      voiceService: svc,
      showHud,
      focusHud,
      broadcastShell,
      broadcastHud,
      isHudSender: (wc) => wc === (hudSender as unknown),
      isShellSender: (wc) => wc === (shellSender as unknown),
      openTarget: vi.fn(),
      hideHud: vi.fn(),
      resizeHud: vi.fn(),
    })

    const invoke = (channel: string, sender: unknown, ...args: unknown[]) =>
      ipcMock.handles.get(channel)!({ sender }, ...args)
    const emit = (channel: string, sender: unknown, ...args: unknown[]) =>
      ipcMock.ons.get(channel)!({ sender }, ...args)

    await expect(invoke(HOME_CHANNELS.butlerVoiceGet, strangerSender)).rejects.toThrow(/Unauthorized/)
    await expect(
      invoke(HOME_CHANNELS.butlerVoiceSet, strangerSender, { ttsVoice: 'ryan' }),
    ).rejects.toThrow(/Unauthorized/)

    const updated = await invoke(HOME_CHANNELS.butlerVoiceSet, shellSender, { ttsVoice: 'ryan' })
    expect((updated as ButlerVoiceConfig).ttsVoice).toBe('ryan')
    const fetched = await invoke(HOME_CHANNELS.butlerVoiceGet, hudSender)
    expect((fetched as ButlerVoiceConfig).ttsVoice).toBe('ryan')

    // Probe & transcribe & clone IPC round-trip.
    const transRes = await invoke(HOME_CHANNELS.butlerVoiceTranscribe, hudSender, {
      wavBase64: createValidWavBase64('ipc-stt'),
      purpose: 'command',
    })
    expect(transRes).toMatchObject({ ok: false })

    const cloneInit = await invoke(HOME_CHANNELS.butlerVoiceCloneGet, shellSender)
    expect(cloneInit).toEqual({ hasAudio: false, fileName: '', byteLength: 0, updatedAt: null })

    const cloneCfg = await invoke(HOME_CHANNELS.butlerVoiceCloneSet, shellSender, {
      audioBase64: createValidWavBase64('ipc-clone'),
      fileName: 'ipc.wav',
      refText: '测试克隆',
    })
    expect((cloneCfg as ButlerVoiceConfig).cloneHasAudio).toBe(true)

    const clearedCfg = await invoke(HOME_CHANNELS.butlerVoiceCloneClear, shellSender)
    expect((clearedCfg as ButlerVoiceConfig).cloneHasAudio).toBe(false)

    // TTS stream events forward to sender via butlerVoiceTtsEvent.
    const hudWc = hudSender as unknown as { send: ReturnType<typeof vi.fn> }
    hudWc.send.mockClear()
    const ttsRes = await invoke(HOME_CHANNELS.butlerVoiceTtsStart, hudSender, {
      requestId: 'ipc-tts-1',
      text: 'Hello',
    })
    expect(ttsRes).toEqual({ ok: true, requestId: 'ipc-tts-1' })
    await vi.waitFor(() => {
      expect(hudWc.send).toHaveBeenCalledWith(HOME_CHANNELS.butlerVoiceTtsEvent, {
        requestId: 'ipc-tts-1',
        type: 'done',
      })
    })
    await invoke(HOME_CHANNELS.butlerVoiceTtsStop, hudSender, 'ipc-tts-1')

    // Wake summon in listen mode raises and focuses HUD and emits wake prompt.
    const wakeListen = await invoke(HOME_CHANNELS.butlerVoiceWakeSummon, hudSender, {
      mode: 'listen',
      rawText: '贾维斯',
    })
    expect(wakeListen).toEqual({ ok: true, submitted: false })
    expect(showHud).toHaveBeenCalledTimes(1)
    expect(focusHud).toHaveBeenCalledTimes(1)
    expect(broadcastHud).toHaveBeenCalledWith(HOME_CHANNELS.butlerVoiceWakePrompt, {
      autoListen: true,
      wakeAck: true,
    })

    // Wake summon in command mode reveals HUD and delegates command.
    const wakeCmd = await invoke(HOME_CHANNELS.butlerVoiceWakeSummon, hudSender, {
      mode: 'command',
      rawText: '贾维斯 写周报',
      commandText: '写周报',
    })
    expect(wakeCmd).toEqual({ ok: true, submitted: true })
    expect(delegate).toHaveBeenCalledWith('写周报')

    // Disabled butler rejects wake summon cleanly.
    writeButlerPrefs(settingsPath, { enabled: false })
    const wakeDisabled = await invoke(HOME_CHANNELS.butlerVoiceWakeSummon, hudSender, {
      mode: 'listen',
      rawText: '贾维斯',
    })
    expect(wakeDisabled).toEqual({ ok: false, submitted: false, error: 'disabled' })

    // Arbitration broadcasts merged state to both Shell and HUD and ignores unauthorized callers.
    emit(HOME_CHANNELS.butlerVoiceArbitration, strangerSender, { deskMicActive: true })
    expect(broadcastShell).not.toHaveBeenCalled()

    emit(HOME_CHANNELS.butlerVoiceArbitration, shellSender, { deskMicActive: true })
    expect(broadcastShell).toHaveBeenLastCalledWith(
      HOME_CHANNELS.butlerVoiceArbitration,
      expect.objectContaining({ deskMicActive: true, ttsSpeaking: false }),
    )
    expect(broadcastHud).toHaveBeenLastCalledWith(
      HOME_CHANNELS.butlerVoiceArbitration,
      expect.objectContaining({ deskMicActive: true, ttsSpeaking: false }),
    )

    emit(HOME_CHANNELS.butlerVoiceArbitration, hudSender, { ttsSpeaking: true })
    expect(broadcastHud).toHaveBeenLastCalledWith(
      HOME_CHANNELS.butlerVoiceArbitration,
      expect.objectContaining({ deskMicActive: true, ttsSpeaking: true }),
    )
  })

  it('falls back to service.submit on wake command when missionEngine is absent', async () => {
    const submit = vi.fn(() => ({ ok: true, sessionKey: 'default:butler-fallback' }))
    const showHud = vi.fn()

    registerButlerIpc({
      settingsPath: () => settingsPath,
      service: {
        submit,
        hudState: vi.fn(() => ({
          prefs: DEFAULT_BUTLER_PREFS,
          hotkey: 'Alt+Space',
          briefing: null,
          tasks: [],
        })),
      },
      showHud,
      isHudSender: (wc) => wc === (hudSender as unknown),
      isShellSender: (wc) => wc === (shellSender as unknown),
      openTarget: vi.fn(),
      hideHud: vi.fn(),
      resizeHud: vi.fn(),
    })

    const res = await ipcMock.handles.get(HOME_CHANNELS.butlerVoiceWakeSummon)!(
      { sender: hudSender },
      { mode: 'command', rawText: '贾维斯 打开设置', commandText: '打开设置' },
    )
    expect(res).toEqual({ ok: true, submitted: true })
    expect(showHud).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith('打开设置')
  })
})
