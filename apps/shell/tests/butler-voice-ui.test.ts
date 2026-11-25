/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ButlerHudState, ButlerSpeakRequest } from '../src/shared/butler-api'
import type { ButlerDeskSnapshot } from '../src/shared/butler-orchestrator-api'
import { DEFAULT_AI_PANEL_PREFS } from '@genoffice/ui'
import { defaultAiSettings, type AiSettings } from '@genoffice/ai-provider'
import { normalizeButlerPrefs, type ButlerPrefs } from '../src/shared/butler-prefs'
import {
  mergeButlerVoiceConfig,
  normalizeButlerVoiceConfig,
  type ButlerMicArbitrationPatch,
  type ButlerMicArbitrationState,
  type ButlerVoiceConfig,
  type ButlerVoiceConfigPatch,
  type ButlerWakePromptPayload,
} from '../src/shared/butler-voice-api'
import type { HomeApi } from '../src/shared/home-api'
import { LocaleProvider, type TFunc } from '../src/renderer/src/locale'
import { loadStrings, translate } from '../src/renderer/src/strings'

const mockVoiceState = vi.hoisted(() => {
  type SpeechState = { speaking: boolean; sourceId: string | null }
  type CaptureOpts = {
    silenceMs: number
    maxDurationMs?: number
    continuous?: boolean
    bandpassHumanVoice?: boolean
    onLevel?: (level: number) => void
    onSpeechSegment: (wavBytes: Uint8Array) => void
    onError?: (err: string) => void
  }

  let currentSpeech: SpeechState = { speaking: false, sourceId: null }
  const speechListeners = new Set<(s: SpeechState) => void>()
  const activeCaptures: Array<{
    opts: CaptureOpts
    stop: ReturnType<typeof vi.fn>
  }> = []

  const setSpeech = (next: SpeechState): void => {
    currentSpeech = next
    for (const listener of [...speechListeners]) {
      listener(next)
    }
  }

  return {
    getSpeech: () => currentSpeech,
    setSpeech,
    speechListeners,
    activeCaptures,
    speakButler: vi.fn(),
    speakButlerSmart: vi.fn(async (_text: string, opts: { sourceId?: string }) => {
      setSpeech({ speaking: true, sourceId: opts?.sourceId ?? null })
    }),
    stopButlerSpeech: vi.fn(() => {
      setSpeech({ speaking: false, sourceId: null })
    }),
    isButlerSpeakingOrEchoGuard: vi.fn(() => currentSpeech.speaking),
    playWakeEarcon: vi.fn(),
    startButlerMicCapture: vi.fn((opts: CaptureOpts) => {
      const stop = vi.fn((flushPending?: boolean) => {
        if (flushPending) {
          opts.onSpeechSegment(new Uint8Array([0x52, 0x49, 0x46, 0x46]))
        }
      })
      activeCaptures.push({ opts, stop })
      return { stop }
    }),
    resetAll(): void {
      currentSpeech = { speaking: false, sourceId: null }
      speechListeners.clear()
      activeCaptures.length = 0
      this.speakButler.mockClear()
      this.speakButlerSmart.mockClear()
      this.stopButlerSpeech.mockClear()
      this.isButlerSpeakingOrEchoGuard.mockClear()
      this.playWakeEarcon.mockClear()
      this.startButlerMicCapture.mockClear()
    },
  }
})

vi.mock('../src/renderer/src/butler-voice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/butler-voice')>()
  return {
    ...actual,
    listVoices: vi.fn(async () => []),
    speakButler: mockVoiceState.speakButler,
    speakButlerSmart: mockVoiceState.speakButlerSmart,
    stopButlerSpeech: mockVoiceState.stopButlerSpeech,
    isButlerSpeakingOrEchoGuard: mockVoiceState.isButlerSpeakingOrEchoGuard,
    isButlerSpeechQueueBusy: () => mockVoiceState.getSpeech().speaking,
    playWakeEarcon: mockVoiceState.playWakeEarcon,
    getButlerSpeechState: () => mockVoiceState.getSpeech(),
    subscribeButlerSpeechState: (listener: (s: { speaking: boolean; sourceId: string | null }) => void) => {
      mockVoiceState.speechListeners.add(listener)
      return () => {
        mockVoiceState.speechListeners.delete(listener)
      }
    },
    startButlerMicCapture: mockVoiceState.startButlerMicCapture,
  }
})

import { ButlerDeskView } from '../src/renderer/src/ButlerDeskView'
import { ButlerSettingsPane } from '../src/renderer/src/ButlerSettingsPane'
import { ButlerHudEntry } from '../src/renderer/src/butler-hud-entry'
import { SettingsModal } from '../src/renderer/src/SettingsModal'

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const enT: TFunc = (key, params) => translate('en', key, params)

let host: HTMLDivElement
let root: Root
let storedPrefs: ButlerPrefs
let storedVoiceConfig: ButlerVoiceConfig
let voicePatches: ButlerVoiceConfigPatch[]
let voiceConfigListeners: Array<(next: ButlerVoiceConfig) => void>
let wakePromptListeners: Array<(payload: ButlerWakePromptPayload) => void>
let arbitrationListeners: Array<(state: ButlerMicArbitrationState) => void>
let deskListeners: Array<(snap: ButlerDeskSnapshot) => void>

function makeEmptySnapshot(overrides?: Partial<ButlerDeskSnapshot>): ButlerDeskSnapshot {
  return {
    chiefSessionKey: 'default:butler-main',
    chiefBusy: false,
    missions: [],
    tasks: [],
    decisions: [],
    feed: [],
    concurrency: { running: 0, maxConcurrent: 3, queued: 0 },
    ...overrides,
  }
}

function setControlValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function switchByLabel(label: string): HTMLButtonElement {
  const el = [...host.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find(
    (sw) => sw.getAttribute('aria-label') === label,
  )
  expect(el, `switch "${label}"`).toBeTruthy()
  return el!
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeAll(async () => {
  await Promise.all([loadStrings('en'), loadStrings('zh')])
})

beforeEach(() => {
  mockVoiceState.resetAll()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)

  storedPrefs = normalizeButlerPrefs(undefined)
  storedVoiceConfig = normalizeButlerVoiceConfig(undefined)
  voicePatches = []
  voiceConfigListeners = []
  wakePromptListeners = []
  arbitrationListeners = []
  deskListeners = []
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('ButlerSettingsPane voice UI', () => {
  let probeMock: ReturnType<typeof vi.fn>
  let cloneSetMock: ReturnType<typeof vi.fn>
  let cloneClearMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    probeMock = vi.fn(async () => ({
      ok: true,
      latencyMs: 24,
      sttModels: ['Qwen3-ASR-1.7B-8bit', 'Qwen3-ASR-Custom'],
      ttsModels: ['Qwen3-TTS-Custom-Pro'],
      voices: ['vivian', 'ryan'],
    }))
    cloneSetMock = vi.fn(async (req: { fileName: string; refText?: string }) => {
      storedVoiceConfig = mergeButlerVoiceConfig(storedVoiceConfig, {
        cloneHasAudio: true,
        cloneAudioName: req.fileName,
        ...(req.refText !== undefined ? { cloneRefText: req.refText } : {}),
      })
      return storedVoiceConfig
    })
    cloneClearMock = vi.fn(async () => {
      storedVoiceConfig = mergeButlerVoiceConfig(storedVoiceConfig, {
        cloneHasAudio: false,
        cloneAudioName: '',
        cloneEnabled: false,
      })
      return storedVoiceConfig
    })

    window.aiOffice = {
      getButlerPrefs: vi.fn(async () => storedPrefs),
      setButlerPrefs: vi.fn(async () => storedPrefs),
      onButlerPrefsChanged: vi.fn(() => () => {}),
      getButlerVoiceConfig: vi.fn(async () => storedVoiceConfig),
      setButlerVoiceConfig: vi.fn(async (patch: ButlerVoiceConfigPatch) => {
        voicePatches.push(patch)
        storedVoiceConfig = mergeButlerVoiceConfig(storedVoiceConfig, patch)
        return storedVoiceConfig
      }),
      onButlerVoiceConfigChanged: vi.fn((handler: (next: ButlerVoiceConfig) => void) => {
        voiceConfigListeners.push(handler)
        return () => {}
      }),
      butlerVoiceProbe: probeMock,
      butlerVoiceCloneGet: vi.fn(async () => ({
        hasAudio: false,
        fileName: '',
        byteLength: 0,
        updatedAt: null,
      })),
      butlerVoiceCloneSet: cloneSetMock,
      butlerVoiceCloneClear: cloneClearMock,
      butlerVoiceTtsStart: vi.fn(async () => ({ ok: true, requestId: 'req-1' })),
    } as unknown as HomeApi
  })

  async function renderSettings(): Promise<void> {
    await act(async () => {
      root.render(
        createElement(
          LocaleProvider,
          { initial: 'en' },
          createElement(ButlerSettingsPane, { t: enT }),
        ),
      )
      await flushMicrotasks()
    })
  }

  it('probes oMLX endpoint and updates STT/TTS models and preset voices', async () => {
    await renderSettings()

    const probeBtn = host.querySelector<HTMLButtonElement>('[data-testid="butler-voice-probe-btn"]')!
    await act(async () => {
      probeBtn.click()
      await flushMicrotasks()
    })

    expect(probeMock).toHaveBeenCalledTimes(1)
    const status = host.querySelector('[data-testid="butler-voice-probe-status"]')!
    expect(status.textContent).toContain('24ms')

    const sttSelect = host.querySelector<HTMLSelectElement>('#butler-voice-stt-model')!
    const ttsSelect = host.querySelector<HTMLSelectElement>('#butler-voice-tts-model')!
    const voiceSelect = host.querySelector<HTMLSelectElement>('#butler-voice-preset')!

    expect([...sttSelect.options].map((o) => o.value)).toContain('Qwen3-ASR-Custom')
    expect([...ttsSelect.options].map((o) => o.value)).toContain('Qwen3-TTS-Custom-Pro')
    expect([...voiceSelect.options].map((o) => o.value)).toEqual(['vivian', 'ryan'])
    // Current ttsModel/ttsVoice were absent from probed list, so settings synced automatically.
    expect(ttsSelect.value).toBe('Qwen3-TTS-Custom-Pro')
    expect(voiceSelect.value).toBe('vivian')
  })

  it('shows incomplete clone warning until audio and refText are provided, and clears cleanly', async () => {
    await renderSettings()

    const cloneToggle = switchByLabel(enT('setButlerVoiceCloneTitle'))
    await act(async () => {
      cloneToggle.click()
      await flushMicrotasks()
    })

    expect(voicePatches.at(-1)).toEqual({ cloneEnabled: true })
    expect(host.querySelector('[data-testid="butler-voice-clone-warning"]')?.textContent).toBe(
      enT('setButlerVoiceCloneWarnIncomplete'),
    )

    // Upload a minimal WAV file via the hidden file input
    const fileInput = host.querySelector<HTMLInputElement>(
      '[data-testid="butler-voice-clone-file-input"]',
    )!
    const wavBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])
    const file = new File([wavBytes], 'jarvis-ref.wav', { type: 'audio/wav' })
    Object.defineProperty(file, 'arrayBuffer', {
      configurable: true,
      value: async () => wavBytes.buffer,
    })
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: [file],
    })
    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
      await flushMicrotasks()
    })

    expect(cloneSetMock).toHaveBeenCalledTimes(1)
    // Still missing refText -> warning remains visible
    expect(host.querySelector('[data-testid="butler-voice-clone-warning"]')).toBeTruthy()

    const refTextInput = host.querySelector<HTMLInputElement>('#butler-voice-clone-ref-text')!
    await act(async () => {
      refTextInput.focus()
      setControlValue(refTextInput, 'At your service, Sir.')
      refTextInput.blur()
      await flushMicrotasks()
    })

    expect(host.querySelector('[data-testid="butler-voice-clone-warning"]')).toBeNull()

    const clearBtn = host.querySelector<HTMLButtonElement>(
      '[data-testid="butler-voice-clone-clear-btn"]',
    )!
    await act(async () => {
      clearBtn.click()
      await flushMicrotasks()
    })
    expect(cloneClearMock).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain(enT('setButlerVoiceCloneNoAudio'))
  })

  it('persists wake-word switches, aliases, VAD silence slider, and previews via speakButlerSmart', async () => {
    await renderSettings()

    const wakeSwitch = switchByLabel(enT('setButlerWakeEnabled'))
    const autoListenSwitch = switchByLabel(enT('setButlerHotkeyAutoListen'))
    const autoSpeakSwitch = switchByLabel(enT('setButlerAutoSpeakReplies'))

    await act(async () => {
      wakeSwitch.click()
      autoListenSwitch.click()
      autoSpeakSwitch.click()
      await flushMicrotasks()
    })

    expect(voicePatches).toContainEqual({ wakeWordEnabled: false })
    expect(voicePatches).toContainEqual({ hotkeyAutoListen: false })
    expect(voicePatches).toContainEqual({ autoSpeakReplies: false })

    const aliasesInput = host.querySelector<HTMLInputElement>('#butler-wake-aliases')!
    await act(async () => {
      aliasesInput.focus()
      setControlValue(aliasesInput, 'Alfred,Jarvis')
      aliasesInput.blur()
      await flushMicrotasks()
    })
    expect(voicePatches).toContainEqual({ wakeAliases: 'Alfred,Jarvis' })

    const vadSlider = host.querySelector<HTMLInputElement>('#butler-vad-silence')!
    await act(async () => {
      setControlValue(vadSlider, '1800')
      vadSlider.dispatchEvent(new Event('change', { bubbles: true }))
      await flushMicrotasks()
    })
    expect(voicePatches).toContainEqual({ vadSilenceMs: 1800 })

    const previewBtn = host.querySelector<HTMLButtonElement>(
      '[data-testid="butler-voice-preview-btn"]',
    )!
    await act(async () => {
      previewBtn.click()
      await flushMicrotasks()
    })
    expect(mockVoiceState.speakButlerSmart).toHaveBeenCalledTimes(1)

    // Switching engine to 'system' hides oMLX panel while keeping system controls
    const engineSelect = host.querySelector<HTMLSelectElement>('#butler-voice-engine')!
    await act(async () => {
      engineSelect.value = 'system'
      engineSelect.dispatchEvent(new Event('change', { bubbles: true }))
      await flushMicrotasks()
    })
    expect(voicePatches).toContainEqual({ provider: 'system' })
    expect(host.querySelector('[data-testid="butler-voice-omlx-panel"]')).toBeNull()
    expect(host.querySelector('#butler-voice-rate')).toBeTruthy()
    expect(host.querySelector('#butler-voice-name')).toBeTruthy()
  })
})

describe('ButlerDeskView voice controls', () => {
  let currentSnapshot: ButlerDeskSnapshot
  let delegateMock: ReturnType<typeof vi.fn>
  let transcribeMock: ReturnType<typeof vi.fn>
  let arbitrationPatches: ButlerMicArbitrationPatch[]

  beforeEach(() => {
    currentSnapshot = makeEmptySnapshot({
      feed: [
        {
          id: 'hist-1',
          role: 'butler',
          text: 'Historical greeting should not auto-speak on mount.',
          createdAt: 1000,
        },
      ],
    })
    delegateMock = vi.fn(async () => ({ ok: true, missionId: 'm-voice' }))
    transcribeMock = vi.fn(async () => ({
      ok: true,
      text: 'Summarize today work items',
      latencyMs: 110,
    }))
    arbitrationPatches = []

    window.aiOffice = {
      butlerDeskState: vi.fn(async () => currentSnapshot),
      onButlerDeskUpdated: vi.fn((handler: (next: ButlerDeskSnapshot) => void) => {
        deskListeners.push(handler)
        return () => {}
      }),
      butlerDelegate: delegateMock,
      getButlerPrefs: vi.fn(async () => storedPrefs),
      onButlerPrefsChanged: vi.fn(() => () => {}),
      getButlerVoiceConfig: vi.fn(async () => storedVoiceConfig),
      onButlerVoiceConfigChanged: vi.fn(() => () => {}),
      butlerVoiceTranscribe: transcribeMock,
      onButlerVoiceArbitration: vi.fn((handler: (state: ButlerMicArbitrationState) => void) => {
        arbitrationListeners.push(handler)
        return () => {}
      }),
      reportButlerVoiceArbitration: vi.fn((patch: ButlerMicArbitrationPatch) => {
        arbitrationPatches.push(patch)
      }),
    } as unknown as HomeApi
  })

  async function renderDesk(): Promise<void> {
    await act(async () => {
      root.render(createElement(LocaleProvider, { initial: 'en' }, createElement(ButlerDeskView)))
      await flushMicrotasks()
    })
  }

  it('handles mic barge-in, arbitration, STT delegation, and manual/auto entry speech', async () => {
    await renderDesk()
    // Historical entry must NOT trigger auto-speak on initial hydration.
    expect(mockVoiceState.speakButlerSmart).not.toHaveBeenCalled()

    // Click mic button: triggers barge-in stopButlerSpeech + deskMicActive: true + capture.
    const micBtn = host.querySelector<HTMLButtonElement>('[data-testid="butler-desk-mic-btn"]')!
    await act(async () => {
      micBtn.click()
      await flushMicrotasks()
    })

    expect(mockVoiceState.stopButlerSpeech).toHaveBeenCalledTimes(1)
    expect(arbitrationPatches).toContainEqual({ deskMicActive: true })
    expect(mockVoiceState.activeCaptures).toHaveLength(1)
    expect(host.querySelector('[data-testid="butler-desk-mic-meter"]')).toBeTruthy()

    // Deliver captured speech segment -> STT transcribes & auto-delegates when composer was empty.
    await act(async () => {
      mockVoiceState.activeCaptures[0]!.opts.onSpeechSegment(new Uint8Array([1, 2, 3, 4]))
      await flushMicrotasks()
    })

    expect(transcribeMock).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'command', language: 'auto' }),
    )
    expect(delegateMock).toHaveBeenCalledWith('Summarize today work items')
    expect(arbitrationPatches.at(-1)).toEqual({ deskMicActive: false })

    // Click speak button on feed entry -> speaks via speakButlerSmart and displays header stop button.
    const speakBtn = host.querySelector<HTMLButtonElement>(
      '[data-testid="butler-entry-speak-btn"]',
    )!
    await act(async () => {
      speakBtn.click()
      await flushMicrotasks()
    })

    expect(mockVoiceState.speakButlerSmart).toHaveBeenCalledWith(
      'Historical greeting should not auto-speak on mount.',
      expect.objectContaining({ sourceId: 'hist-1' }),
    )

    const headerStopBtn = host.querySelector<HTMLButtonElement>(
      '[data-testid="butler-desk-stop-speech-btn"]',
    )!
    expect(headerStopBtn).toBeTruthy()
    await act(async () => {
      headerStopBtn.click()
      await flushMicrotasks()
    })
    expect(mockVoiceState.stopButlerSpeech).toHaveBeenCalledTimes(2)

    // Pushing a new plain butler reply auto-speaks it.
    await act(async () => {
      for (const listener of deskListeners) {
        listener(
          makeEmptySnapshot({
            feed: [
              ...currentSnapshot.feed,
              {
                id: 'butler-new-1',
                role: 'butler',
                text: 'All weekly metrics are ready.',
                createdAt: 2000,
              },
            ],
          }),
        )
      }
      await flushMicrotasks()
    })

    expect(mockVoiceState.speakButlerSmart).toHaveBeenLastCalledWith(
      'All weekly metrics are ready.',
      expect.objectContaining({ sourceId: 'butler-new-1' }),
    )
  })

  it('appends dictated speech to an existing draft without auto-delegating and renders one speak button per ReportCard', async () => {
    currentSnapshot = makeEmptySnapshot({
      feed: [
        {
          id: 'report-entry-1',
          role: 'butler',
          text: 'Summary ready.',
          createdAt: 1000,
          report: {
            headline: 'Q1 Overview',
            summary: 'All milestones met.',
            risks: [],
            artifacts: [],
            generatedAt: 1000,
          },
        },
      ],
    })
    await renderDesk()

    // Entry with both text and report renders exactly one speak button inside the report card
    const speakBtns = host.querySelectorAll('[data-testid="butler-entry-speak-btn"]')
    expect(speakBtns).toHaveLength(1)

    const textarea = host.querySelector<HTMLTextAreaElement>('[data-testid="butler-desk-input"]')!
    await act(async () => {
      setControlValue(textarea, 'Draft prefix:')
      await flushMicrotasks()
    })

    const micBtn = host.querySelector<HTMLButtonElement>('[data-testid="butler-desk-mic-btn"]')!
    await act(async () => {
      micBtn.click()
      await flushMicrotasks()
    })

    transcribeMock.mockResolvedValueOnce({
      ok: true,
      text: 'check quarterly revenue',
      latencyMs: 90,
    })
    await act(async () => {
      mockVoiceState.activeCaptures.at(-1)!.opts.onSpeechSegment(new Uint8Array([5, 6, 7, 8]))
      await flushMicrotasks()
    })

    expect(delegateMock).not.toHaveBeenCalled()
    expect(textarea.value).toBe('Draft prefix: check quarterly revenue')
  })

  it('auto-resumes 20s hands-free follow-up mic in DeskView after cross-window TTS finishes', async () => {
    vi.useFakeTimers()
    try {
      await renderDesk()

      const micBtn = host.querySelector<HTMLButtonElement>('[data-testid="butler-desk-mic-btn"]')!
      await act(async () => {
        micBtn.click()
        await flushMicrotasks()
      })

      transcribeMock.mockResolvedValueOnce({
        ok: true,
        text: 'Open Q4 budget sheet',
        latencyMs: 80,
      })
      await act(async () => {
        mockVoiceState.activeCaptures[0]!.opts.onSpeechSegment(new Uint8Array([1, 2, 3]))
        await flushMicrotasks()
      })
      expect(delegateMock).toHaveBeenCalledWith('Open Q4 budget sheet')
      expect(micBtn.getAttribute('aria-pressed')).toBe('false')

      // Simulate HUD speaking the response and finishing across windows.
      await act(async () => {
        for (const listener of arbitrationListeners) {
          listener({ deskMicActive: false, ttsSpeaking: true, updatedAt: Date.now() })
        }
        await flushMicrotasks()
      })
      expect(host.querySelector('[data-testid="butler-desk-stop-speech-btn"]')).toBeTruthy()

      await act(async () => {
        for (const listener of arbitrationListeners) {
          listener({ deskMicActive: false, ttsSpeaking: false, updatedAt: Date.now() })
        }
        await flushMicrotasks()
      })
      await act(async () => {
        vi.advanceTimersByTime(300)
        await flushMicrotasks()
      })

      // DeskView automatically reopened follow-up listening without clicking the mic button again.
      expect(micBtn.getAttribute('aria-pressed')).toBe('true')

      // Second utterance without wake word directly delegates.
      transcribeMock.mockResolvedValueOnce({
        ok: true,
        text: 'Also highlight total revenue',
        latencyMs: 75,
      })
      await act(async () => {
        mockVoiceState.activeCaptures.at(-1)!.opts.onSpeechSegment(new Uint8Array([4, 5, 6]))
        await flushMicrotasks()
      })
      expect(delegateMock).toHaveBeenLastCalledWith('Also highlight total revenue')

      // After another reply ends, user speaks a dismiss phrase to exit Desk follow-up conversation.
      await act(async () => {
        for (const listener of arbitrationListeners) {
          listener({ deskMicActive: false, ttsSpeaking: true, updatedAt: Date.now() })
        }
        await flushMicrotasks()
      })
      await act(async () => {
        for (const listener of arbitrationListeners) {
          listener({ deskMicActive: false, ttsSpeaking: false, updatedAt: Date.now() })
        }
        await flushMicrotasks()
      })
      await act(async () => {
        vi.advanceTimersByTime(300)
        await flushMicrotasks()
      })
      expect(micBtn.getAttribute('aria-pressed')).toBe('true')

      transcribeMock.mockResolvedValueOnce({
        ok: true,
        text: '退下吧',
        latencyMs: 60,
      })
      await act(async () => {
        mockVoiceState.activeCaptures.at(-1)!.opts.onSpeechSegment(new Uint8Array([7, 8, 9]))
        await flushMicrotasks()
      })
      expect(mockVoiceState.playWakeEarcon).toHaveBeenCalledWith('cancel')
      expect(micBtn.getAttribute('aria-pressed')).toBe('false')
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows 5-minute live session badge and hang-up control in DeskView and guards against duplicate TTS auto-speak', async () => {
    vi.useFakeTimers()
    try {
      await renderDesk()

      expect(host.querySelector('[data-testid="butler-desk-live-bar"]')).toBeNull()

      const micBtn = host.querySelector<HTMLButtonElement>('[data-testid="butler-desk-mic-btn"]')!
      await act(async () => {
        micBtn.click()
        await flushMicrotasks()
      })

      const liveBar = host.querySelector<HTMLElement>('[data-testid="butler-desk-live-bar"]')!
      expect(liveBar).toBeTruthy()
      expect(liveBar.textContent).toContain(enT('butlerDeskLiveActive'))
      expect(micBtn.getAttribute('aria-pressed')).toBe('true')

      // Advance past the legacy 20s timeout: Desk live call stays open across the 5-minute window.
      await act(async () => {
        vi.advanceTimersByTime(25_000)
        await flushMicrotasks()
      })
      expect(micBtn.getAttribute('aria-pressed')).toBe('true')
      expect(host.querySelector('[data-testid="butler-desk-live-bar"]')).toBeTruthy()

      // Duplicate TTS guard: skip Desk auto-speak when speech is already active or queued.
      mockVoiceState.speakButlerSmart.mockClear()
      await act(async () => {
        mockVoiceState.setSpeech({ speaking: true, sourceId: 'hud-stream-turn' })
        for (const listener of deskListeners) {
          listener(
            makeEmptySnapshot({
              feed: [
                ...currentSnapshot.feed,
                {
                  id: 'butler-dup-guard-1',
                  role: 'butler',
                  text: 'Already streaming from gateway.',
                  createdAt: 2500,
                },
              ],
            }),
          )
        }
        await flushMicrotasks()
      })
      expect(mockVoiceState.speakButlerSmart).not.toHaveBeenCalled()

      // Hang-up button terminates live session immediately, clears badge, and releases arbitration.
      const hangupBtn = host.querySelector<HTMLButtonElement>(
        '[data-testid="butler-desk-hangup-btn"]',
      )!
      expect(hangupBtn.textContent).toBe(enT('butlerLiveSessionHangup'))
      await act(async () => {
        hangupBtn.click()
        await flushMicrotasks()
      })

      expect(mockVoiceState.playWakeEarcon).toHaveBeenCalledWith('cancel')
      expect(host.querySelector('[data-testid="butler-desk-live-bar"]')).toBeNull()
      expect(micBtn.getAttribute('aria-pressed')).toBe('false')
      expect(arbitrationPatches).toContainEqual({ deskMicActive: false })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ButlerHudEntry voice & wake sentinel', () => {
  let hudState: ButlerHudState
  let submitMock: ReturnType<typeof vi.fn>
  let transcribeMock: ReturnType<typeof vi.fn>
  let wakeSummonMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    hudState = {
      prefs: storedPrefs,
      hotkey: 'Alt+Space',
      briefing: null,
      tasks: [],
      pendingDecisions: [],
    }
    submitMock = vi.fn(async () => ({ ok: true, sessionKey: 'default:butler' }))
    transcribeMock = vi.fn(async () => ({
      ok: true,
      text: 'Open weekly report',
      latencyMs: 95,
    }))
    wakeSummonMock = vi.fn(async () => ({ ok: true, submitted: true }))

    window.aiOffice = {
      butlerHudState: vi.fn(async () => hudState),
      butlerSubmit: submitMock,
      butlerHide: vi.fn(),
      butlerResize: vi.fn(),
      onButlerShown: vi.fn(() => () => {}),
      onButlerTaskUpdate: vi.fn(() => () => {}),
      onButlerSpeak: vi.fn(() => () => {}),
      onButlerPrefsChanged: vi.fn(() => () => {}),
      onButlerDeskUpdated: vi.fn(() => () => {}),
      getButlerVoiceConfig: vi.fn(async () => storedVoiceConfig),
      onButlerVoiceConfigChanged: vi.fn(() => () => {}),
      butlerVoiceTranscribe: transcribeMock,
      butlerVoiceWakeSummon: wakeSummonMock,
      onButlerVoiceWakePrompt: vi.fn((handler: (payload: ButlerWakePromptPayload) => void) => {
        wakePromptListeners.push(handler)
        return () => {}
      }),
      onButlerVoiceArbitration: vi.fn((handler: (state: ButlerMicArbitrationState) => void) => {
        arbitrationListeners.push(handler)
        return () => {}
      }),
    } as unknown as HomeApi
  })

  async function renderHud(): Promise<void> {
    await act(async () => {
      root.render(createElement(LocaleProvider, { initial: 'en' }, createElement(ButlerHudEntry)))
      await flushMicrotasks()
    })
  }

  it('mounts wake sentinel, handles two-level wake command, and responds to wake prompt active listen', async () => {
    await renderHud()

    // Wake sentinel mounts continuously with human-voice bandpass.
    expect(host.querySelector('[data-testid="butler-hud-sentinel-badge"]')).toBeTruthy()
    const sentinelCapture = mockVoiceState.activeCaptures[0]!
    expect(sentinelCapture.opts.continuous).toBe(true)
    expect(sentinelCapture.opts.bandpassHumanVoice).toBe(true)

    // Sentinel recognizes direct wake + command from mixed greeting and Chinese instruction
    transcribeMock.mockResolvedValueOnce({
      ok: true,
      text: '你好，贾维斯，帮我整理周报',
      latencyMs: 120,
    })
    await act(async () => {
      sentinelCapture.opts.onSpeechSegment(new Uint8Array([1, 2, 3, 4]))
      await flushMicrotasks()
    })

    expect(mockVoiceState.playWakeEarcon).toHaveBeenCalledWith('done')
    expect(wakeSummonMock).toHaveBeenCalledWith({
      mode: 'command',
      rawText: '你好，贾维斯，帮我整理周报',
      commandText: '帮我整理周报',
    })

    // Wake prompt activates active listening, pauses sentinel, and auto-submits command.
    await act(async () => {
      for (const listener of wakePromptListeners) {
        listener({ autoListen: true, wakeAck: false })
      }
      await flushMicrotasks()
    })

    expect(sentinelCapture.stop).toHaveBeenCalled()
    expect(mockVoiceState.playWakeEarcon).toHaveBeenCalledWith('wake')
    const hudMicBtn = host.querySelector<HTMLButtonElement>('[data-testid="butler-hud-mic-btn"]')!
    expect(hudMicBtn.getAttribute('aria-pressed')).toBe('true')
    expect(host.querySelector('[data-testid="butler-hud-mic-meter"]')).toBeTruthy()

    const activeListenCapture = mockVoiceState.activeCaptures.at(-1)!
    expect(activeListenCapture.opts.continuous).toBe(false)

    transcribeMock.mockResolvedValueOnce({
      ok: true,
      text: 'Prepare Q4 slides',
      latencyMs: 85,
    })
    await act(async () => {
      activeListenCapture.opts.onSpeechSegment(new Uint8Array([9, 8, 7, 6]))
      await flushMicrotasks()
    })

    expect(submitMock).toHaveBeenCalledWith('Prepare Q4 slides')
    expect(hudMicBtn.getAttribute('aria-pressed')).toBe('false')

    // Manual mic toggle turns listening on and flushing stop turns it off.
    await act(async () => {
      hudMicBtn.click()
      await flushMicrotasks()
    })
    expect(hudMicBtn.getAttribute('aria-pressed')).toBe('true')

    await act(async () => {
      hudMicBtn.click()
      await flushMicrotasks()
    })
    expect(hudMicBtn.getAttribute('aria-pressed')).toBe('false')
  })

  it('pauses wake sentinel during desk mic arbitration and triggers listen-mode summon on bare wake word', async () => {
    await renderHud()

    const initialSentinel = mockVoiceState.activeCaptures[0]!
    expect(host.querySelector('[data-testid="butler-hud-sentinel-badge"]')).toBeTruthy()

    // Bare wake word triggers listen-mode summon
    transcribeMock.mockResolvedValueOnce({
      ok: true,
      text: '贾维斯',
      latencyMs: 70,
    })
    await act(async () => {
      initialSentinel.opts.onSpeechSegment(new Uint8Array([1, 2, 3, 4]))
      await flushMicrotasks()
    })
    expect(wakeSummonMock).toHaveBeenCalledWith({
      mode: 'listen',
      rawText: '贾维斯',
    })

    // Desk mic arbitration pauses sentinel and clears it when released
    await act(async () => {
      for (const listener of arbitrationListeners) {
        listener({ deskMicActive: true, ttsSpeaking: false, updatedAt: Date.now() })
      }
      await flushMicrotasks()
    })
    expect(initialSentinel.stop).toHaveBeenCalled()
    expect(host.querySelector('[data-testid="butler-hud-sentinel-badge"]')).toBeNull()

    await act(async () => {
      for (const listener of arbitrationListeners) {
        listener({ deskMicActive: false, ttsSpeaking: false, updatedAt: Date.now() })
      }
      await flushMicrotasks()
    })
    expect(host.querySelector('[data-testid="butler-hud-sentinel-badge"]')).toBeTruthy()
  })

  it('auto-resumes 20s hands-free follow-up listening after butler speaks and exits on dismiss or timeout', async () => {
    vi.useFakeTimers()
    try {
      const speakListeners: Array<(req: { text: string }) => void> = []
      let resolveSpeechPromise: (() => void) | null = null
      mockVoiceState.speakButlerSmart.mockImplementation(async (_text, opts) => {
        mockVoiceState.setSpeech({ speaking: true, sourceId: opts?.sourceId ?? null })
        await new Promise<void>((resolve) => {
          resolveSpeechPromise = () => {
            mockVoiceState.setSpeech({ speaking: false, sourceId: null })
            resolve()
          }
        })
      })

      const hideSpy = vi.fn()
      const api = window.aiOffice as unknown as {
        onButlerSpeak: (cb: (req: { text: string }) => void) => () => void
        butlerHide: ReturnType<typeof vi.fn>
      }
      api.butlerHide = hideSpy
      api.onButlerSpeak = vi.fn((cb: (req: { text: string }) => void) => {
        speakListeners.push(cb)
        return () => {}
      })

      await renderHud()

      // Step 1: User wakes Butler with a direct command -> HUD enters active conversation wait.
      const sentinelCapture = mockVoiceState.activeCaptures[0]!
      transcribeMock.mockResolvedValueOnce({
        ok: true,
        text: '贾维斯，今天有哪些日程？',
        latencyMs: 90,
      })
      await act(async () => {
        sentinelCapture.opts.onSpeechSegment(new Uint8Array([1, 2, 3]))
        await flushMicrotasks()
      })
      expect(wakeSummonMock).toHaveBeenCalledWith({
        mode: 'command',
        rawText: '贾维斯，今天有哪些日程？',
        commandText: '今天有哪些日程？',
      })

      // Step 2: Butler speaks response, then finishes -> follow-up listen auto-opens after 220ms.
      await act(async () => {
        for (const listener of speakListeners) {
          listener({ text: '今天下午两点有季度评审。' })
        }
        await flushMicrotasks()
      })
      expect(mockVoiceState.speakButlerSmart).toHaveBeenCalledTimes(1)
      await act(async () => {
        resolveSpeechPromise?.()
        await flushMicrotasks()
      })
      await act(async () => {
        vi.advanceTimersByTime(300)
        await flushMicrotasks()
      })

      const hudMicBtn = host.querySelector<HTMLButtonElement>('[data-testid="butler-hud-mic-btn"]')!
      expect(hudMicBtn.getAttribute('aria-pressed')).toBe('true')

      // Step 3: User speaks follow-up WITHOUT saying the wake word -> directly submits.
      const followUpCapture = mockVoiceState.activeCaptures.at(-1)!
      transcribeMock.mockResolvedValueOnce({
        ok: true,
        text: '把会议纪要模板打开',
        latencyMs: 85,
      })
      await act(async () => {
        followUpCapture.opts.onSpeechSegment(new Uint8Array([4, 5, 6]))
        await flushMicrotasks()
      })
      expect(submitMock).toHaveBeenCalledWith('把会议纪要模板打开')

      // Step 4: Butler finishes second reply -> auto-resumes 20s follow-up listen -> user speaks dismiss phrase -> dismisses HUD.
      await act(async () => {
        for (const listener of speakListeners) {
          listener({ text: '好的，已经为您打开。' })
        }
        await flushMicrotasks()
      })
      await act(async () => {
        resolveSpeechPromise?.()
        await flushMicrotasks()
      })
      await act(async () => {
        vi.advanceTimersByTime(300)
        await flushMicrotasks()
      })
      expect(hudMicBtn.getAttribute('aria-pressed')).toBe('true')

      const dismissCapture = mockVoiceState.activeCaptures.at(-1)!
      transcribeMock.mockResolvedValueOnce({
        ok: true,
        text: '没事了',
        latencyMs: 60,
      })
      await act(async () => {
        dismissCapture.opts.onSpeechSegment(new Uint8Array([7, 8]))
        await flushMicrotasks()
      })
      expect(mockVoiceState.playWakeEarcon).toHaveBeenCalledWith('cancel')
      expect(hideSpy).toHaveBeenCalledTimes(1)
      expect(hudMicBtn.getAttribute('aria-pressed')).toBe('false')

      // Step 5: Verify 5-minute live window stays open past 20s and exits after 300s inactivity.
      await act(async () => {
        for (const listener of wakePromptListeners) {
          listener({ autoListen: true, wakeAck: false })
        }
        await flushMicrotasks()
      })
      expect(hudMicBtn.getAttribute('aria-pressed')).toBe('true')
      expect(host.querySelector('[data-testid="butler-hud-live-bar"]')).toBeTruthy()
      await act(async () => {
        vi.advanceTimersByTime(20_500)
        await flushMicrotasks()
      })
      expect(hudMicBtn.getAttribute('aria-pressed')).toBe('true')
      await act(async () => {
        vi.advanceTimersByTime(280_000)
        await flushMicrotasks()
      })
      expect(hudMicBtn.getAttribute('aria-pressed')).toBe('false')
      expect(host.querySelector('[data-testid="butler-hud-live-bar"]')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not reopen follow-up mic on phase=ack and automatically opens 20s follow-up after phase=planned and phase=completed', async () => {
    vi.useFakeTimers()
    try {
      const speakListeners: Array<
        (req: {
          text: string
          enqueue?: boolean
          phase?: 'ack' | 'planned' | 'decision' | 'completed'
          openFollowUp?: boolean
        }) => void
      > = []
      const pendingSpeechResolvers: Array<() => void> = []
      mockVoiceState.speakButlerSmart.mockImplementation(async (_text, opts) => {
        mockVoiceState.setSpeech({ speaking: true, sourceId: opts?.sourceId ?? null })
        await new Promise<void>((resolve) => {
          pendingSpeechResolvers.push(() => {
            mockVoiceState.setSpeech({ speaking: false, sourceId: null })
            resolve()
          })
        })
      })

      const api = window.aiOffice as unknown as {
        onButlerSpeak: (cb: (req: { text: string }) => void) => () => void
      }
      api.onButlerSpeak = vi.fn((cb) => {
        speakListeners.push(cb as never)
        return () => {}
      })

      await renderHud()

      const sentinelCapture = mockVoiceState.activeCaptures[0]!
      transcribeMock.mockResolvedValueOnce({
        ok: true,
        text: '贾维斯，帮我做一份季度汇报PPT',
        latencyMs: 90,
      })
      await act(async () => {
        sentinelCapture.opts.onSpeechSegment(new Uint8Array([1, 2, 3]))
        await flushMicrotasks()
      })

      // Phase 1: ack arrives and finishes -> mic must STAY OFF while chief still plans.
      await act(async () => {
        for (const listener of speakListeners) {
          listener({
            text: '先生，收到，马上为您安排。',
            enqueue: false,
            phase: 'ack',
            openFollowUp: false,
          })
        }
        await flushMicrotasks()
      })
      await act(async () => {
        pendingSpeechResolvers.shift()?.()
        await flushMicrotasks()
      })
      await act(async () => {
        vi.advanceTimersByTime(350)
        await flushMicrotasks()
      })

      const hudMicBtn = host.querySelector<HTMLButtonElement>('[data-testid="butler-hud-mic-btn"]')!
      expect(hudMicBtn.getAttribute('aria-pressed')).toBe('false')

      // Phase 2: planned arrives and finishes -> follow-up mic opens for user additions!
      await act(async () => {
        for (const listener of speakListeners) {
          listener({
            text: '先生，已安排文档与演示专家同步推进。',
            enqueue: true,
            phase: 'planned',
            openFollowUp: true,
          })
        }
        await flushMicrotasks()
      })
      expect(mockVoiceState.speakButlerSmart).toHaveBeenLastCalledWith(
        '先生，已安排文档与演示专家同步推进。',
        expect.objectContaining({ enqueue: true }),
      )
      await act(async () => {
        pendingSpeechResolvers.shift()?.()
        await flushMicrotasks()
      })
      await act(async () => {
        vi.advanceTimersByTime(300)
        await flushMicrotasks()
      })
      expect(hudMicBtn.getAttribute('aria-pressed')).toBe('true')

      // Live window persists past 20s and expires after 300s back to sentinel,
      // then async Phase 4 completion re-activates follow-up listening after reporting.
      await act(async () => {
        vi.advanceTimersByTime(20_500)
        await flushMicrotasks()
      })
      expect(hudMicBtn.getAttribute('aria-pressed')).toBe('true')
      await act(async () => {
        vi.advanceTimersByTime(280_000)
        await flushMicrotasks()
      })
      expect(hudMicBtn.getAttribute('aria-pressed')).toBe('false')

      await act(async () => {
        for (const listener of speakListeners) {
          listener({
            text: '先生，季度汇报PPT已生成完毕。',
            enqueue: true,
            phase: 'completed',
            openFollowUp: true,
          })
        }
        await flushMicrotasks()
      })
      await act(async () => {
        pendingSpeechResolvers.shift()?.()
        await flushMicrotasks()
      })
      await act(async () => {
        vi.advanceTimersByTime(300)
        await flushMicrotasks()
      })
      expect(hudMicBtn.getAttribute('aria-pressed')).toBe('true')
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders HUD pending plan card, approves via butlerApproveMissionPlan, and opens 20s follow-up on clarifying/plan_review', async () => {
    vi.useFakeTimers()
    try {
      const speakListeners: Array<(req: ButlerSpeakRequest) => void> = []
      const pendingSpeechResolvers: Array<() => void> = []
      mockVoiceState.speakButlerSmart.mockImplementation(async (_text, opts) => {
        mockVoiceState.setSpeech({ speaking: true, sourceId: opts?.sourceId ?? null })
        await new Promise<void>((resolve) => {
          pendingSpeechResolvers.push(() => {
            mockVoiceState.setSpeech({ speaking: false, sourceId: null })
            resolve()
          })
        })
      })

      const approvePlanMock = vi.fn(async () => ({ ok: true }))
      const deskPushListeners: Array<(snap: ButlerDeskSnapshot) => void> = []
      const api = window.aiOffice as unknown as {
        onButlerSpeak: (cb: (req: ButlerSpeakRequest) => void) => () => void
        onButlerDeskUpdated: (cb: (snap: ButlerDeskSnapshot) => void) => () => void
        butlerDeskState: () => Promise<ButlerDeskSnapshot>
        butlerApproveMissionPlan: typeof approvePlanMock
      }
      api.butlerApproveMissionPlan = approvePlanMock
      api.butlerDeskState = vi.fn(async () => makeEmptySnapshot())
      api.onButlerDeskUpdated = vi.fn((cb: (snap: ButlerDeskSnapshot) => void) => {
        deskPushListeners.push(cb)
        return () => {}
      })
      api.onButlerSpeak = vi.fn((cb: (req: ButlerSpeakRequest) => void) => {
        speakListeners.push(cb)
        return () => {}
      })

      await renderHud()

      // Push a mission awaiting plan approval -> HUD displays compact pending-plan card.
      await act(async () => {
        for (const listener of deskPushListeners) {
          listener(
            makeEmptySnapshot({
              missions: [
                {
                  id: 'm-hud-plan',
                  title: 'Quarterly Review',
                  goal: 'Prepare quarterly review deck',
                  status: 'awaiting_plan_approval',
                  createdAt: 1000,
                  updatedAt: 2000,
                  taskIds: [],
                  plan: {
                    summary: 'Analyze Q4 numbers and build 8 slides.',
                    revision: 1,
                    updatedAt: 2000,
                    steps: [
                      {
                        id: 's1',
                        title: 'Analyze numbers',
                        brief: 'Read sheet',
                        role: 'sheets',
                        dependsOn: [],
                      },
                      {
                        id: 's2',
                        title: 'Build slides',
                        brief: 'Create PPTX',
                        role: 'slides',
                        dependsOn: ['s1'],
                      },
                    ],
                  },
                },
              ],
            }),
          )
        }
        await flushMicrotasks()
      })

      const planCard = host.querySelector('[data-testid="butler-hud-plan-card"]')!
      expect(planCard).toBeTruthy()
      expect(planCard.textContent).toContain(enT('butlerHudPlanPendingTitle', { count: 2 }))
      expect(planCard.textContent).toContain('Analyze Q4 numbers and build 8 slides.')

      const hudApproveBtn = host.querySelector<HTMLButtonElement>(
        '[data-testid="butler-hud-approve-plan-btn"]',
      )!
      await act(async () => {
        hudApproveBtn.click()
        await flushMicrotasks()
      })
      expect(approvePlanMock).toHaveBeenCalledWith({ missionId: 'm-hud-plan' })

      const hudMicBtn = host.querySelector<HTMLButtonElement>('[data-testid="butler-hud-mic-btn"]')!

      // Clarifying phase with openFollowUp=true enters 20s follow-up listening after TTS finishes.
      await act(async () => {
        for (const listener of speakListeners) {
          listener({
            text: '请问演示文稿需要包含几页？',
            enqueue: true,
            phase: 'clarifying',
            openFollowUp: true,
          })
        }
        await flushMicrotasks()
      })
      await act(async () => {
        pendingSpeechResolvers.shift()?.()
        await flushMicrotasks()
      })
      await act(async () => {
        vi.advanceTimersByTime(350)
        await flushMicrotasks()
      })
      expect(hudMicBtn.getAttribute('aria-pressed')).toBe('true')

      // Close active listen and test plan_review phase as well.
      await act(async () => {
        hudMicBtn.click()
        await flushMicrotasks()
      })
      expect(hudMicBtn.getAttribute('aria-pressed')).toBe('false')

      await act(async () => {
        for (const listener of speakListeners) {
          listener({
            text: '先生，已拟好两步执行计划。',
            enqueue: true,
            phase: 'plan_review',
            openFollowUp: true,
          })
        }
        await flushMicrotasks()
      })
      await act(async () => {
        pendingSpeechResolvers.shift()?.()
        await flushMicrotasks()
      })
      await act(async () => {
        vi.advanceTimersByTime(350)
        await flushMicrotasks()
      })
      expect(hudMicBtn.getAttribute('aria-pressed')).toBe('true')
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders 5-minute live bar, supports hang-up button, and resumes follow-up only after queued phase=stream finishes', async () => {
    vi.useFakeTimers()
    try {
      const speakListeners: Array<(req: ButlerSpeakRequest) => void> = []
      const pendingSpeechResolvers: Array<() => void> = []
      mockVoiceState.speakButlerSmart.mockImplementation(async (_text, opts) => {
        mockVoiceState.setSpeech({ speaking: true, sourceId: opts?.sourceId ?? null })
        await new Promise<void>((resolve) => {
          pendingSpeechResolvers.push(() => {
            if (pendingSpeechResolvers.length === 0) {
              mockVoiceState.setSpeech({ speaking: false, sourceId: null })
            }
            resolve()
          })
        })
      })

      const api = window.aiOffice as unknown as {
        onButlerSpeak: (cb: (req: ButlerSpeakRequest) => void) => () => void
      }
      api.onButlerSpeak = vi.fn((cb) => {
        speakListeners.push(cb)
        return () => {}
      })

      await renderHud()
      expect(host.querySelector('[data-testid="butler-hud-live-bar"]')).toBeNull()

      await act(async () => {
        for (const listener of speakListeners) {
          listener({
            text: 'First streamed clause.',
            phase: 'stream',
            streamTurnId: 'turn-stream-1',
            streamFinal: false,
          })
          listener({
            text: 'Second streamed clause.',
            phase: 'stream',
            streamTurnId: 'turn-stream-1',
            streamFinal: true,
          })
        }
        await flushMicrotasks()
      })

      expect(mockVoiceState.speakButlerSmart).toHaveBeenNthCalledWith(
        1,
        'First streamed clause.',
        expect.objectContaining({ enqueue: true, sourceId: 'turn-stream-1' }),
      )
      expect(mockVoiceState.speakButlerSmart).toHaveBeenNthCalledWith(
        2,
        'Second streamed clause.',
        expect.objectContaining({ enqueue: true, sourceId: 'turn-stream-1' }),
      )

      const liveBar = host.querySelector<HTMLElement>('[data-testid="butler-hud-live-bar"]')!
      expect(liveBar).toBeTruthy()
      expect(liveBar.textContent).toContain(enT('butlerLiveSessionBadge'))
      expect(liveBar.textContent).toContain(enT('butlerHudLiveHint'))

      const hudMicBtn = host.querySelector<HTMLButtonElement>('[data-testid="butler-hud-mic-btn"]')!

      // Resolving only the first chunk leaves the second chunk in queue -> mic must stay closed.
      await act(async () => {
        pendingSpeechResolvers.shift()?.()
        await flushMicrotasks()
      })
      await act(async () => {
        vi.advanceTimersByTime(350)
        await flushMicrotasks()
      })
      expect(hudMicBtn.getAttribute('aria-pressed')).toBe('false')

      // Resolving the final queued chunk drains the queue -> follow-up mic opens.
      await act(async () => {
        pendingSpeechResolvers.shift()?.()
        await flushMicrotasks()
      })
      await act(async () => {
        vi.advanceTimersByTime(300)
        await flushMicrotasks()
      })
      expect(hudMicBtn.getAttribute('aria-pressed')).toBe('true')

      // Clicking hang-up ends the 5-minute live session cleanly without closing HUD.
      const hangupBtn = host.querySelector<HTMLButtonElement>('[data-testid="butler-hud-hangup-btn"]')!
      expect(hangupBtn.textContent).toBe(enT('butlerLiveSessionHangup'))
      await act(async () => {
        hangupBtn.click()
        await flushMicrotasks()
      })
      expect(mockVoiceState.playWakeEarcon).toHaveBeenCalledWith('cancel')
      expect(hudMicBtn.getAttribute('aria-pressed')).toBe('false')
      expect(host.querySelector('[data-testid="butler-hud-live-bar"]')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers follow-up mic in live session after failed butlerSubmit or 500ms silent chief turn', async () => {
    vi.useFakeTimers()
    try {
      const deskPushListeners: Array<(snap: ButlerDeskSnapshot) => void> = []
      const api = window.aiOffice as unknown as {
        onButlerDeskUpdated: (cb: (snap: ButlerDeskSnapshot) => void) => () => void
        butlerDeskState: () => Promise<ButlerDeskSnapshot>
      }
      api.butlerDeskState = vi.fn(async () => makeEmptySnapshot())
      api.onButlerDeskUpdated = vi.fn((cb) => {
        deskPushListeners.push(cb)
        return () => {}
      })

      await renderHud()

      // Enter live conversation via wake prompt.
      await act(async () => {
        for (const listener of wakePromptListeners) {
          listener({ autoListen: true, wakeAck: false })
        }
        await flushMicrotasks()
      })
      const hudMicBtn = host.querySelector<HTMLButtonElement>('[data-testid="butler-hud-mic-btn"]')!
      expect(hudMicBtn.getAttribute('aria-pressed')).toBe('true')

      // Case A: butlerSubmit returns { ok: false } -> auto-recovers mic instead of hanging.
      submitMock.mockResolvedValueOnce({ ok: false, error: 'failed', message: 'Temporary error' })
      transcribeMock.mockResolvedValueOnce({ ok: true, text: 'Open sales file', latencyMs: 60 })
      await act(async () => {
        mockVoiceState.activeCaptures.at(-1)!.opts.onSpeechSegment(new Uint8Array([1, 2]))
        await flushMicrotasks()
      })
      expect(hudMicBtn.getAttribute('aria-pressed')).toBe('false')

      await act(async () => {
        vi.advanceTimersByTime(250)
        await flushMicrotasks()
      })
      expect(hudMicBtn.getAttribute('aria-pressed')).toBe('true')
      expect(host.querySelector('[data-testid="butler-hud-live-bar"]')).toBeTruthy()

      // Case B: butlerSubmit succeeds, chief becomes busy then idle without any TTS within 500ms.
      submitMock.mockResolvedValueOnce({ ok: true, sessionKey: 'default:butler' })
      transcribeMock.mockResolvedValueOnce({ ok: true, text: 'Run silent check', latencyMs: 60 })
      await act(async () => {
        mockVoiceState.activeCaptures.at(-1)!.opts.onSpeechSegment(new Uint8Array([3, 4]))
        await flushMicrotasks()
      })
      expect(hudMicBtn.getAttribute('aria-pressed')).toBe('false')

      await act(async () => {
        for (const listener of deskPushListeners) {
          listener(makeEmptySnapshot({ chiefBusy: true }))
        }
        await flushMicrotasks()
      })
      await act(async () => {
        for (const listener of deskPushListeners) {
          listener(makeEmptySnapshot({ chiefBusy: false }))
        }
        await flushMicrotasks()
      })

      // Before 500ms silent-turn guard expires, mic waits for possible TTS arrival.
      await act(async () => {
        vi.advanceTimersByTime(300)
        await flushMicrotasks()
      })
      expect(hudMicBtn.getAttribute('aria-pressed')).toBe('false')

      // After 500ms guard + 180ms resume delay, mic cleanly reopens.
      await act(async () => {
        vi.advanceTimersByTime(450)
        await flushMicrotasks()
      })
      expect(hudMicBtn.getAttribute('aria-pressed')).toBe('true')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('SettingsModal AI thinking effort picker', () => {
  it('renders #ai-thinking-effort for Qwen3.8 models and saves selected effort via setAiSettings', async () => {
    const baseSettings = defaultAiSettings()
    const customId = 'ep-qwen-local'
    const initialSettings: AiSettings = {
      ...baseSettings,
      provider: 'custom',
      customEndpoint: customId,
      customEndpoints: [
        {
          id: customId,
          name: 'Local oMLX',
          baseUrl: 'http://127.0.0.1:7000/v1',
          apiKey: '1234',
          model: 'Huihui-Qwen3.8-27B-abliterated-UD-Q4_K_XL',
        },
      ],
      providers: {
        ...baseSettings.providers,
        custom: {
          apiKey: '1234',
          baseUrl: 'http://127.0.0.1:7000/v1',
          model: 'Huihui-Qwen3.8-27B-abliterated-UD-Q4_K_XL',
        },
      },
    }
    const setAiSettingsMock = vi.fn(async () => undefined)
    window.aiOffice = {
      getTheme: async () => 'system',
      getDefaultSaveDir: async () => '',
      getAnalyticsEnabled: async () => true,
      setAnalyticsEnabled: async () => true,
      getAiPanelPrefs: async () => DEFAULT_AI_PANEL_PREFS,
      setAiPanelPrefs: async () => DEFAULT_AI_PANEL_PREFS,
      getUpdateChannel: async () => 'stable',
      getAppVersion: async () => '1.0.0',
      githubStars: async () => null,
      getAiProviders: () => [
        {
          id: 'custom',
          label: 'Custom',
          models: [],
          defaultModel: '',
          keyPlaceholder: 'API Key',
          needsBaseUrl: true,
        },
      ],
      getAiSettings: async () => initialSettings,
      setAiSettings: setAiSettingsMock,
    } as unknown as HomeApi

    await act(async () => {
      root.render(
        createElement(
          LocaleProvider,
          { initial: 'en' },
          createElement(SettingsModal, {
            status: null,
            loggingOut: false,
            loginWaiting: false,
            loginUrl: null,
            urlCopied: false,
            onOpenLoginUrl: vi.fn(),
            onCopyLoginUrl: vi.fn(),
            onClose: vi.fn(),
            onLogin: vi.fn(),
            onLogout: vi.fn(),
          }),
        ),
      )
      await flushMicrotasks()
    })

    const aiModelBtn = Array.from(host.querySelectorAll<HTMLButtonElement>('.set-nav-item')).find(
      (btn) => btn.textContent?.includes('AI Model'),
    )!
    await act(async () => {
      aiModelBtn.click()
      await flushMicrotasks()
    })

    const thinkingSelect = host.querySelector<HTMLSelectElement>('#ai-thinking-effort')!
    expect(thinkingSelect).toBeTruthy()
    expect([...thinkingSelect.options].map((o) => o.value)).toEqual([
      '',
      'none',
      'low',
      'medium',
      'high',
    ])

    await act(async () => {
      thinkingSelect.value = 'none'
      thinkingSelect.dispatchEvent(new Event('change', { bubbles: true }))
      await flushMicrotasks()
    })

    const saveBtn = Array.from(host.querySelectorAll<HTMLButtonElement>('.set-btn.primary')).find(
      (btn) => btn.textContent?.trim() === 'Save',
    )!
    await act(async () => {
      saveBtn.click()
      await flushMicrotasks()
    })

    expect(setAiSettingsMock).toHaveBeenCalledTimes(1)
    const savedArg = setAiSettingsMock.mock.calls[0]![0] as AiSettings
    expect(savedArg.providers.custom?.thinking).toEqual({
      'Huihui-Qwen3.8-27B-abliterated-UD-Q4_K_XL': 'none',
    })
  })
})
