/**
 * Speech synthesis and capture engine for Butler briefings, task completion
 * reports, oMLX streaming TTS playback, wake earcons, and VAD-segmented mic
 * capture.
 *
 * Preserves full backward compatibility with `pickVoice`, `speakButler`, and
 * `listVoices` while adding smart oMLX streaming playback + Echo-Guard + mic
 * capture with graceful degradation to `window.speechSynthesis`.
 */

import type { ButlerPrefs } from '../../shared/butler-prefs'
import { mergeButlerVoiceConfig, type ButlerVoiceConfig } from '../../shared/butler-voice-api'
import type { HomeApi } from '../../shared/home-api'
import {
  AdaptiveVadDetector,
  TARGET_AUDIO_SAMPLE_RATE,
  createStreamingWavParser,
  downsampleTo24kMono,
  encodePcm16ToWav,
  sanitizeSpeechText,
  splitSpeechSentences,
} from './butler-audio-dsp'

export interface ButlerVoiceCandidate {
  readonly name: string
  readonly lang: string
  readonly localService?: boolean
}

export interface ButlerSpeechState {
  readonly speaking: boolean
  readonly sourceId: string | null
}

export interface ButlerSmartSpeakOptions {
  readonly prefs: ButlerPrefs
  readonly voiceConfig: ButlerVoiceConfig
  readonly langTag: string
  readonly sourceId?: string
  readonly enqueue?: boolean
  readonly configOverride?: Partial<ButlerVoiceConfig>
}

export interface ButlerMicCaptureOptions {
  readonly silenceMs: number
  readonly maxDurationMs?: number
  readonly continuous?: boolean
  readonly bandpassHumanVoice?: boolean
  readonly shouldSuppress?: () => boolean
  readonly onVoiceActivity?: (speaking: boolean) => void
  readonly onLevel?: (level: number) => void
  readonly onSpeechSegment: (wavBytes: Uint8Array) => void
  readonly onError?: (err: string) => void
}

export interface ButlerMicCaptureHandle {
  stop(flushPending?: boolean): void
}

const VOICES_WAIT_TIMEOUT_MS = 1500
const ECHO_GUARD_TAIL_MS = 180
const BARGE_IN_ECHO_GUARD_MS = 120
const SYSTEM_TTS_POLL_INTERVAL_MS = 200

function getAiOfficeApi(): Partial<HomeApi> | undefined {
  if (typeof window === 'undefined') return undefined
  return window.aiOffice as Partial<HomeApi> | undefined
}

function getAudioContextConstructor(): typeof AudioContext | undefined {
  if (typeof window === 'undefined') return undefined
  const win = window as unknown as {
    AudioContext?: typeof AudioContext
    webkitAudioContext?: typeof AudioContext
  }
  return win.AudioContext ?? win.webkitAudioContext
}

function primaryLanguageSubtag(tag: string): string {
  return tag.trim().toLowerCase().split(/[-_]/)[0] ?? ''
}

function matchesPrimaryLanguage(voiceLang: string, primary: string): boolean {
  if (!primary) return false
  return primaryLanguageSubtag(voiceLang) === primary
}

/**
 * Pick the best system voice for the user's preference and current UI language:
 * 1) Exact match on `preferredName` when provided,
 * 2) Voice matching the primary language subtag (preferring `localService`),
 * 3) `null` when no match exists (let the OS pick its default).
 */
export function pickVoice<T extends ButlerVoiceCandidate>(
  voices: readonly T[],
  uiLangTag: string,
  preferredName: string,
): T | null {
  if (voices.length === 0) return null

  const trimmedName = preferredName.trim()
  if (trimmedName) {
    const exact = voices.find((voice) => voice.name === trimmedName)
    if (exact) return exact
  }

  const primary = primaryLanguageSubtag(uiLangTag)
  if (!primary) return null

  const matching = voices.filter((voice) => matchesPrimaryLanguage(voice.lang, primary))
  if (matching.length === 0) return null

  const local = matching.find((voice) => voice.localService === true)
  return local ?? matching[0] ?? null
}

/** Speak a butler announcement via `window.speechSynthesis`, cancelling any active utterance first. */
export function speakButler(
  text: string,
  opts: { rate: number; voiceName: string; langTag: string },
): void {
  const clean = text.trim()
  if (!clean) return
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
  if (typeof SpeechSynthesisUtterance === 'undefined') return

  const synth = window.speechSynthesis
  if (!synth || typeof synth.speak !== 'function') return

  try {
    synth.cancel()
    const utterance = new SpeechSynthesisUtterance(clean)
    const rate = Number.isFinite(opts.rate) ? Math.min(1.6, Math.max(0.7, opts.rate)) : 1
    utterance.rate = rate
    if (opts.langTag) utterance.lang = opts.langTag
    const voices = typeof synth.getVoices === 'function' ? synth.getVoices() : []
    const chosen = pickVoice(voices, opts.langTag, opts.voiceName)
    if (chosen) utterance.voice = chosen
    synth.speak(utterance)
  } catch {
    // Voice output is strictly best-effort; never surface TTS errors to callers.
  }
}

/** Resolve available system speech synthesis voices, waiting briefly for async population. */
export function listVoices(): Promise<SpeechSynthesisVoice[]> {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    return Promise.resolve([])
  }
  const synth = window.speechSynthesis
  if (!synth || typeof synth.getVoices !== 'function') {
    return Promise.resolve([])
  }

  const initial = synth.getVoices()
  if (initial.length > 0) {
    return Promise.resolve([...initial])
  }

  return new Promise<SpeechSynthesisVoice[]>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      synth.removeEventListener?.('voiceschanged', onChanged)
      try {
        resolve([...synth.getVoices()])
      } catch {
        resolve([])
      }
    }
    const onChanged = (): void => {
      finish()
    }
    const timer = setTimeout(finish, VOICES_WAIT_TIMEOUT_MS)
    synth.addEventListener?.('voiceschanged', onChanged)
  })
}

let sharedPlaybackCtx: AudioContext | null = null
let activeSpeechToken = 0
let activeRequestId: string | null = null
let activeAbortCallback: (() => void) | null = null
const activeAudioSources = new Set<AudioBufferSourceNode>()
let currentSpeechState: ButlerSpeechState = { speaking: false, sourceId: null }
let echoGuardUntilMs = 0
let requestCounter = 0
const speechListeners = new Set<(state: ButlerSpeechState) => void>()
interface QueuedSpeechItem {
  readonly clean: string
  readonly opts: ButlerSmartSpeakOptions
  readonly resolve: () => void
}
const pendingSpeechQueue: QueuedSpeechItem[] = []
let activeQueueToken = 0
let boundGlobalStopApi: Partial<HomeApi> | null = null
let unsubscribeGlobalStop: (() => void) | null = null

function ensureGlobalTtsStopSubscription(): void {
  const api = getAiOfficeApi()
  if (api === boundGlobalStopApi) return
  if (unsubscribeGlobalStop) {
    try {
      unsubscribeGlobalStop()
    } catch {
      // Ignore stale listener cleanup errors.
    }
    unsubscribeGlobalStop = null
  }
  boundGlobalStopApi = api ?? null
  if (!api || typeof api.onButlerVoiceTtsEvent !== 'function') return

  unsubscribeGlobalStop = api.onButlerVoiceTtsEvent((event) => {
    if (event.requestId === '*' && event.type === 'error' && currentSpeechState.speaking) {
      stopSpeechInternal({ applyEchoGuard: true, notifyArbitration: false })
    }
  })
}

function getOrCreatePlaybackAudioContext(): AudioContext | null {
  const Ctor = getAudioContextConstructor()
  if (!Ctor) return null

  if (
    !sharedPlaybackCtx ||
    sharedPlaybackCtx.state === 'closed' ||
    !(sharedPlaybackCtx instanceof Ctor)
  ) {
    try {
      sharedPlaybackCtx = new Ctor()
    } catch {
      return null
    }
  }

  if (sharedPlaybackCtx.state === 'suspended') {
    void sharedPlaybackCtx.resume().catch(() => {})
  }
  return sharedPlaybackCtx
}

function setSpeechState(next: ButlerSpeechState): void {
  if (currentSpeechState.speaking === next.speaking && currentSpeechState.sourceId === next.sourceId) {
    return
  }
  currentSpeechState = next
  for (const listener of [...speechListeners]) {
    try {
      listener(next)
    } catch {
      // Never let a subscriber error break audio state transitions.
    }
  }
}

export function getButlerSpeechState(): ButlerSpeechState {
  return currentSpeechState
}

/** Subscribe to transitions in active butler speech playback state. */
export function subscribeButlerSpeechState(
  listener: (state: ButlerSpeechState) => void,
): () => void {
  speechListeners.add(listener)
  return () => {
    speechListeners.delete(listener)
  }
}

/** True while TTS is actively speaking or within the post-playback Echo-Guard tail. */
export function isButlerSpeakingOrEchoGuard(): boolean {
  return currentSpeechState.speaking || Date.now() < echoGuardUntilMs
}

/** True while TTS is speaking or queued utterances are still pending playback. */
export function isButlerSpeechQueueBusy(): boolean {
  return currentSpeechState.speaking || pendingSpeechQueue.length > 0
}

function stopActiveSources(): void {
  for (const source of [...activeAudioSources]) {
    try {
      source.onended = null
      source.stop()
      source.disconnect()
    } catch {
      // Ignore nodes that have already stopped or disconnected.
    }
  }
  activeAudioSources.clear()
}

function drainSpeechQueue(): void {
  while (pendingSpeechQueue.length > 0) {
    const item = pendingSpeechQueue.shift()
    try {
      item?.resolve()
    } catch {
      // Ignore promise resolution errors.
    }
  }
}

function stopSpeechInternal(options: { applyEchoGuard: boolean; notifyArbitration: boolean }): void {
  activeSpeechToken += 1
  activeQueueToken = 0
  drainSpeechQueue()

  const reqId = activeRequestId
  activeRequestId = null
  if (reqId) {
    try {
      void getAiOfficeApi()?.butlerVoiceTtsStop?.(reqId)
    } catch {
      // Best-effort cancellation.
    }
  }

  const abortCb = activeAbortCallback
  activeAbortCallback = null
  if (abortCb) {
    try {
      abortCb()
    } catch {
      // Ignore waiter teardown errors.
    }
  }

  stopActiveSources()

  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis?.cancel?.()
    } catch {
      // Ignore synthesis cancel errors.
    }
  }

  const wasSpeaking = currentSpeechState.speaking
  if (wasSpeaking && options.applyEchoGuard) {
    echoGuardUntilMs = Math.max(echoGuardUntilMs, Date.now() + BARGE_IN_ECHO_GUARD_MS)
  }
  setSpeechState({ speaking: false, sourceId: null })

  if (wasSpeaking && options.notifyArbitration) {
    try {
      getAiOfficeApi()?.reportButlerVoiceArbitration?.({ ttsSpeaking: false })
    } catch {
      // Best-effort IPC broadcast.
    }
  }
}

/**
 * Stop any active streaming or system TTS playback immediately and clear speech
 * state while applying a brief Echo-Guard tail when interrupting active speech.
 * Also notifies main when stopping playback initiated by another renderer window.
 */
export function stopButlerSpeech(): void {
  ensureGlobalTtsStopSubscription()
  const hadActiveReq = activeRequestId !== null
  stopSpeechInternal({ applyEchoGuard: true, notifyArbitration: true })
  if (!hadActiveReq) {
    try {
      void getAiOfficeApi()?.butlerVoiceTtsStop?.()
    } catch {
      // Best-effort cross-window stop.
    }
  }
}

function clampVoiceRate(rate: number): number {
  return Number.isFinite(rate) ? Math.min(1.6, Math.max(0.7, rate)) : 1
}

function speakWithSystemAsync(
  text: string,
  opts: { rate: number; voiceName: string; langTag: string },
  token: number,
): Promise<void> {
  const clean = text.trim()
  if (!clean || token !== activeSpeechToken) return Promise.resolve()
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return Promise.resolve()
  if (typeof SpeechSynthesisUtterance === 'undefined') return Promise.resolve()

  const synth = window.speechSynthesis
  if (!synth || typeof synth.speak !== 'function') return Promise.resolve()

  return new Promise<void>((resolve) => {
    let settled = false
    let pollTimer: ReturnType<typeof setInterval> | null = null
    let maxTimer: ReturnType<typeof setTimeout> | null = null

    const finish = (): void => {
      if (settled) return
      settled = true
      if (pollTimer !== null) clearInterval(pollTimer)
      if (maxTimer !== null) clearTimeout(maxTimer)
      if (activeAbortCallback === finish) activeAbortCallback = null
      resolve()
    }

    activeAbortCallback = finish

    try {
      synth.cancel()
      const utterance = new SpeechSynthesisUtterance(clean)
      utterance.rate = clampVoiceRate(opts.rate)
      if (opts.langTag) utterance.lang = opts.langTag
      const voices = typeof synth.getVoices === 'function' ? synth.getVoices() : []
      const chosen = pickVoice(voices, opts.langTag, opts.voiceName)
      if (chosen) utterance.voice = chosen

      utterance.onend = () => finish()
      utterance.onerror = () => finish()
      synth.speak(utterance)

      // Guard against mocked or headless speechSynthesis engines that never emit `onend`.
      const maxWaitMs = Math.min(30000, Math.max(2500, clean.length * 350))
      maxTimer = setTimeout(finish, maxWaitMs)
      pollTimer = setInterval(() => {
        if (token !== activeSpeechToken) {
          finish()
          return
        }
        if (!synth.speaking && !synth.pending) {
          finish()
        }
      }, SYSTEM_TTS_POLL_INTERVAL_MS)
    } catch {
      finish()
    }
  })
}

async function waitForAudioDrain(
  audioCtx: AudioContext | null,
  endTimeSec: number,
  token: number,
): Promise<void> {
  if (!audioCtx || token !== activeSpeechToken) return
  const remainingSec = endTimeSec - audioCtx.currentTime
  if (remainingSec <= 0.01) return

  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (activeAbortCallback === finish) activeAbortCallback = null
      resolve()
    }
    activeAbortCallback = finish
    const timer = setTimeout(finish, Math.ceil(remainingSec * 1000) + 20)
  })
}

async function playSingleUtterance(
  clean: string,
  opts: ButlerSmartSpeakOptions,
  myToken: number,
): Promise<boolean> {
  if (myToken !== activeSpeechToken) return false

  const effectiveConfig = opts.configOverride
    ? mergeButlerVoiceConfig(opts.voiceConfig, opts.configOverride)
    : opts.voiceConfig

  const api = getAiOfficeApi()

  const canUseOmlx =
    effectiveConfig.provider === 'omlx' &&
    typeof api?.butlerVoiceTtsStart === 'function' &&
    typeof api?.onButlerVoiceTtsEvent === 'function'

  if (!canUseOmlx) {
    await speakWithSystemAsync(
      clean,
      {
        rate: opts.prefs.voiceRate,
        voiceName: opts.prefs.voiceName,
        langTag: opts.langTag,
      },
      myToken,
    )
    return myToken === activeSpeechToken
  }

  const sentences = splitSpeechSentences(clean)
  if (sentences.length === 0) return myToken === activeSpeechToken

  const rate = clampVoiceRate(opts.prefs.voiceRate)
  const audioCtx = getOrCreatePlaybackAudioContext()
  let nextStartTime = audioCtx ? audioCtx.currentTime + 0.02 : 0
  let scheduledAnyAudio = false

  for (let idx = 0; idx < sentences.length; idx += 1) {
    if (myToken !== activeSpeechToken) return false

    const sentence = sentences[idx]!
    const reqId = `butler-tts-${Date.now()}-${++requestCounter}`
    activeRequestId = reqId

    const parser = createStreamingWavParser()
    let sentenceScheduledAudio = false

    const streamResult = await new Promise<{
      ok: boolean
      fallbackSystem: boolean
    }>((resolve) => {
      let settled = false
      let unsub: (() => void) | null = null

      const finish = (outcome: { ok: boolean; fallbackSystem: boolean }): void => {
        if (settled) return
        settled = true
        if (activeAbortCallback === abortHandler) activeAbortCallback = null
        if (activeRequestId === reqId) activeRequestId = null
        try {
          unsub?.()
        } catch {
          // Ignore unsubscribe failures.
        }
        resolve(outcome)
      }

      const abortHandler = (): void => {
        finish({ ok: false, fallbackSystem: false })
      }
      activeAbortCallback = abortHandler

      unsub = api!.onButlerVoiceTtsEvent!((event) => {
        if (event.requestId !== reqId) return
        if (myToken !== activeSpeechToken) {
          finish({ ok: false, fallbackSystem: false })
          return
        }

        if (event.type === 'chunk' && event.chunk) {
          const decoded = parser.push(event.chunk)
          if (decoded && decoded.samples.length > 0 && audioCtx) {
            try {
              const audioBuffer = audioCtx.createBuffer(
                1,
                decoded.samples.length,
                decoded.sampleRate,
              )
              audioBuffer.getChannelData(0).set(decoded.samples)
              const source = audioCtx.createBufferSource()
              source.buffer = audioBuffer
              source.connect(audioCtx.destination)
              activeAudioSources.add(source)
              source.onended = () => {
                activeAudioSources.delete(source)
              }

              const startAt = Math.max(audioCtx.currentTime + 0.005, nextStartTime)
              source.start(startAt)
              nextStartTime = startAt + audioBuffer.duration
              scheduledAnyAudio = true
              sentenceScheduledAudio = true
            } catch {
              // Keep consuming stream even if Web Audio scheduling fails.
            }
          }
          return
        }

        if (event.type === 'done') {
          finish({ ok: true, fallbackSystem: false })
          return
        }

        if (event.type === 'error') {
          finish({
            ok: false,
            fallbackSystem: event.fallbackSystem === true || effectiveConfig.fallbackToSystem,
          })
        }
      })

      void api!
        .butlerVoiceTtsStart!({
          requestId: reqId,
          text: sentence,
          voice: effectiveConfig.ttsVoice,
          speed: rate,
          instructions: effectiveConfig.ttsInstructions || undefined,
          configOverride: opts.configOverride,
        })
        .then((startRes) => {
          if (myToken !== activeSpeechToken) {
            void api?.butlerVoiceTtsStop?.(reqId)
            finish({ ok: false, fallbackSystem: false })
            return
          }
          if (!startRes.ok) {
            finish({
              ok: false,
              fallbackSystem: startRes.fallbackSystem === true || effectiveConfig.fallbackToSystem,
            })
          }
        })
        .catch(() => {
          finish({
            ok: false,
            fallbackSystem: effectiveConfig.fallbackToSystem,
          })
        })
    })

    if (myToken !== activeSpeechToken) return false

    if (!streamResult.ok) {
      if (streamResult.fallbackSystem && effectiveConfig.fallbackToSystem) {
        if (scheduledAnyAudio && audioCtx) {
          await waitForAudioDrain(audioCtx, nextStartTime, myToken)
        }
        if (myToken !== activeSpeechToken) return false
        const remainingText = sentenceScheduledAudio
          ? sentences.slice(idx + 1).join(' ')
          : sentences.slice(idx).join(' ')
        if (remainingText.trim()) {
          await speakWithSystemAsync(
            remainingText,
            {
              rate: opts.prefs.voiceRate,
              voiceName: opts.prefs.voiceName,
              langTag: opts.langTag,
            },
            myToken,
          )
        }
        return myToken === activeSpeechToken
      }
      break
    }
  }

  if (myToken === activeSpeechToken && scheduledAnyAudio && audioCtx) {
    await waitForAudioDrain(audioCtx, nextStartTime, myToken)
  }
  return myToken === activeSpeechToken
}

async function runSpeechQueueLoop(myToken: number): Promise<void> {
  const api = getAiOfficeApi()
  try {
    api?.reportButlerVoiceArbitration?.({ ttsSpeaking: true })
  } catch {
    // Best-effort arbitration update.
  }

  let completedNaturally = false

  try {
    while (myToken === activeSpeechToken && pendingSpeechQueue.length > 0) {
      const item = pendingSpeechQueue.shift()!
      setSpeechState({ speaking: true, sourceId: item.opts.sourceId ?? null })
      let utteranceNatural = false
      try {
        utteranceNatural = await playSingleUtterance(item.clean, item.opts, myToken)
      } finally {
        try {
          item.resolve()
        } catch {
          // Ignore promise resolution errors.
        }
      }
      if (!utteranceNatural || myToken !== activeSpeechToken) {
        completedNaturally = false
        return
      }
      completedNaturally = true
    }
  } finally {
    if (myToken === activeSpeechToken) {
      if (activeQueueToken === myToken) {
        activeQueueToken = 0
      }
      activeRequestId = null
      activeAbortCallback = null
      drainSpeechQueue()
      if (completedNaturally) {
        echoGuardUntilMs = Math.max(echoGuardUntilMs, Date.now() + ECHO_GUARD_TAIL_MS)
      }
      setSpeechState({ speaking: false, sourceId: null })
      try {
        api?.reportButlerVoiceArbitration?.({ ttsSpeaking: false })
      } catch {
        // Best-effort arbitration clear.
      }
    }
  }
}

/**
 * Speak text using oMLX streaming WAV TTS with gapless Web Audio scheduling
 * when available, falling back cleanly to system speech synthesis on provider
 * opt-out or stream failures. Supports queued sequential playback (`enqueue`)
 * as well as immediate preemption.
 */
export function speakButlerSmart(text: string, opts: ButlerSmartSpeakOptions): Promise<void> {
  const clean = sanitizeSpeechText(text)
  if (!clean) return Promise.resolve()

  ensureGlobalTtsStopSubscription()

  if (opts.enqueue && activeQueueToken !== 0 && activeQueueToken === activeSpeechToken) {
    return new Promise<void>((resolve) => {
      pendingSpeechQueue.push({ clean, opts, resolve })
    })
  }

  // Preempt any prior active speech and start a fresh playback queue loop.
  stopSpeechInternal({ applyEchoGuard: false, notifyArbitration: false })
  const myToken = ++activeSpeechToken
  activeQueueToken = myToken

  return new Promise<void>((resolve) => {
    pendingSpeechQueue.push({ clean, opts, resolve })
    setSpeechState({ speaking: true, sourceId: opts.sourceId ?? null })
    void runSpeechQueueLoop(myToken)
  })
}

/** Play a subtle Web Audio earcon chime (`wake`, `done`, or `cancel`). */
export function playWakeEarcon(kind: 'wake' | 'done' | 'cancel' = 'wake'): void {
  const audioCtx = getOrCreatePlaybackAudioContext()
  if (!audioCtx) return

  try {
    const notes: readonly [number, number][] =
      kind === 'cancel'
        ? [
            [520, 0.06],
            [360, 0.08],
          ]
        : kind === 'done'
          ? [
              [587.33, 0.06],
              [880, 0.09],
            ]
          : [
              [523.25, 0.06],
              [783.99, 0.09],
            ]

    let cursor = audioCtx.currentTime + 0.005
    for (const [freq, dur] of notes) {
      const osc = audioCtx.createOscillator()
      const gain = audioCtx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, cursor)

      gain.gain.setValueAtTime(0.0001, cursor)
      gain.gain.exponentialRampToValueAtTime(0.055, cursor + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, cursor + dur)

      osc.connect(gain)
      gain.connect(audioCtx.destination)
      osc.start(cursor)
      osc.stop(cursor + dur + 0.01)
      cursor += dur * 0.9
    }
  } catch {
    // Earcon playback is purely cosmetic; swallow Web Audio errors silently.
  }
}

/**
 * Capture mono microphone audio, resample to 24 kHz PCM16, run adaptive VAD,
 * and emit WAV-encoded speech segments in either single-turn or continuous
 * wake-sentinel mode.
 */
export function startButlerMicCapture(opts: ButlerMicCaptureOptions): ButlerMicCaptureHandle {
  const hasGetUserMedia =
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  const AudioCtxCtor = getAudioContextConstructor()

  if (!hasGetUserMedia || !AudioCtxCtor) {
    opts.onError?.('Microphone audio capture is unavailable in this environment')
    return {
      stop(): void {
        // No-op when capture could not start.
      },
    }
  }

  let stopped = false
  let stream: MediaStream | null = null
  let captureCtx: AudioContext | null = null
  let sourceNode: MediaStreamAudioSourceNode | null = null
  let highpassNode: BiquadFilterNode | null = null
  let lowpassNode: BiquadFilterNode | null = null
  let processorNode: ScriptProcessorNode | null = null
  let silentGainNode: GainNode | null = null
  let vad: AdaptiveVadDetector | null = null

  const cleanup = (): void => {
    stopped = true
    if (processorNode) {
      try {
        processorNode.onaudioprocess = null
        processorNode.disconnect()
      } catch {
        // Ignore disconnect errors.
      }
      processorNode = null
    }
    for (const node of [highpassNode, lowpassNode, sourceNode, silentGainNode]) {
      if (node) {
        try {
          node.disconnect()
        } catch {
          // Ignore disconnect errors.
        }
      }
    }
    highpassNode = null
    lowpassNode = null
    sourceNode = null
    silentGainNode = null

    if (stream) {
      for (const track of stream.getTracks()) {
        try {
          track.stop()
        } catch {
          // Ignore track stop errors.
        }
      }
      stream = null
    }

    if (captureCtx) {
      const ctx = captureCtx
      captureCtx = null
      void ctx.close().catch(() => {})
    }
  }

  void navigator.mediaDevices
    .getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    .then(async (mediaStream) => {
      if (stopped) {
        for (const track of mediaStream.getTracks()) {
          track.stop()
        }
        return
      }

      stream = mediaStream
      captureCtx = new AudioCtxCtor()
      if (captureCtx.state === 'suspended') {
        await captureCtx.resume().catch(() => {})
      }
      if (stopped) {
        cleanup()
        return
      }

      vad = new AdaptiveVadDetector({
        sampleRate: TARGET_AUDIO_SAMPLE_RATE,
        silenceMs: opts.silenceMs,
        maxSegmentMs: opts.maxDurationMs ?? (opts.continuous ? 6000 : 10000),
      })

      sourceNode = captureCtx.createMediaStreamSource(mediaStream)
      processorNode = captureCtx.createScriptProcessor(4096, 1, 1)
      silentGainNode = captureCtx.createGain()
      silentGainNode.gain.value = 0

      if (opts.bandpassHumanVoice) {
        highpassNode = captureCtx.createBiquadFilter()
        highpassNode.type = 'highpass'
        highpassNode.frequency.value = 280
        highpassNode.Q.value = 0.707

        lowpassNode = captureCtx.createBiquadFilter()
        lowpassNode.type = 'lowpass'
        lowpassNode.frequency.value = 3500
        lowpassNode.Q.value = 0.707

        sourceNode.connect(highpassNode)
        highpassNode.connect(lowpassNode)
        lowpassNode.connect(processorNode)
      } else {
        sourceNode.connect(processorNode)
      }

      processorNode.connect(silentGainNode)
      silentGainNode.connect(captureCtx.destination)

      const inputSampleRate = captureCtx.sampleRate || TARGET_AUDIO_SAMPLE_RATE

      processorNode.onaudioprocess = (event: AudioProcessingEvent) => {
        if (stopped || !vad) return
        if (opts.shouldSuppress?.()) {
          vad.pauseAndClear()
          opts.onLevel?.(0)
          opts.onVoiceActivity?.(false)
          return
        }
        const channelData = event.inputBuffer.getChannelData(0)
        const pcm24k = downsampleTo24kMono(channelData, inputSampleRate)
        const res = vad.pushFrame(pcm24k)
        opts.onVoiceActivity?.(res.speaking)
        opts.onLevel?.(Math.min(1, Math.max(0, res.rms * 5)))

        if (res.completedSegment) {
          const wavBytes = encodePcm16ToWav(res.completedSegment, TARGET_AUDIO_SAMPLE_RATE)
          if (!opts.continuous) {
            cleanup()
          }
          opts.onSpeechSegment(wavBytes)
        }
      }
    })
    .catch((err: unknown) => {
      if (stopped) return
      cleanup()
      opts.onError?.(err instanceof Error ? err.message : String(err))
    })

  return {
    stop(flushPending = false): void {
      if (stopped) return
      const pending = flushPending && vad ? vad.flush() : null
      cleanup()
      if (pending) {
        opts.onSpeechSegment(encodePcm16ToWav(pending, TARGET_AUDIO_SAMPLE_RATE))
      }
    },
  }
}
