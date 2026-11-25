/**
 * Shared IPC contracts, configuration defaults, normalizers, and WAV header
 * helpers for GenOffice Butler Voice (oMLX STT/TTS, voice cloning, wake-word
 * sentinel, and mic arbitration).
 *
 * Kept Electron-free and DOM-free so main-process services, preload bridges,
 * renderer surfaces, and unit tests normalize against one exact contract.
 */

export const BUTLER_VOICE_SETTINGS_KEY = 'butlerVoice'

export const DEFAULT_OMLX_BASE_URL = 'http://192.168.100.235:7000/v1'
export const DEFAULT_OMLX_API_KEY = '1234'
export const DEFAULT_OMLX_TTS_MODEL = 'Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit'
export const DEFAULT_OMLX_STT_MODEL = 'Qwen3-ASR-1.7B-8bit'
export const DEFAULT_OMLX_TTS_VOICE = 'serena'

export const PRESET_OMLX_VOICES = [
  'aiden',
  'dylan',
  'eric',
  'ono_anna',
  'ryan',
  'serena',
  'sohee',
  'uncle_fu',
  'vivian',
] as const

export const DEFAULT_WAKE_ALIASES = 'Jarvis,佳维斯,贾维思,小贾'

export type ButlerVoiceProvider = 'omlx' | 'system'
export type ButlerSttLanguage = 'auto' | 'zh' | 'en' | 'ja' | 'ko'

export interface ButlerVoiceConfig {
  readonly provider: ButlerVoiceProvider
  readonly baseUrl: string
  readonly apiKey: string
  readonly ttsModel: string
  readonly sttModel: string
  readonly ttsVoice: string
  readonly ttsInstructions: string
  readonly sttLanguage: ButlerSttLanguage
  readonly fallbackToSystem: boolean
  readonly cloneEnabled: boolean
  readonly cloneRefText: string
  readonly cloneAudioName: string
  readonly cloneHasAudio: boolean
  readonly wakeWordEnabled: boolean
  readonly wakeAliases: string
  readonly hotkeyAutoListen: boolean
  readonly vadSilenceMs: number
  readonly autoSpeakReplies: boolean
}

export type ButlerVoiceConfigPatch = Partial<ButlerVoiceConfig>

export const DEFAULT_BUTLER_VOICE_CONFIG: ButlerVoiceConfig = {
  provider: 'omlx',
  baseUrl: DEFAULT_OMLX_BASE_URL,
  apiKey: DEFAULT_OMLX_API_KEY,
  ttsModel: DEFAULT_OMLX_TTS_MODEL,
  sttModel: DEFAULT_OMLX_STT_MODEL,
  ttsVoice: DEFAULT_OMLX_TTS_VOICE,
  ttsInstructions: '',
  sttLanguage: 'auto',
  fallbackToSystem: true,
  cloneEnabled: false,
  cloneRefText: '',
  cloneAudioName: '',
  cloneHasAudio: false,
  wakeWordEnabled: true,
  wakeAliases: DEFAULT_WAKE_ALIASES,
  hotkeyAutoListen: true,
  vadSilenceMs: 750,
  autoSpeakReplies: true,
}

export interface ButlerVoiceProbeRequest {
  readonly baseUrl?: string
  readonly apiKey?: string
  readonly ttsModel?: string
}

export interface ButlerVoiceProbeResult {
  readonly ok: boolean
  readonly latencyMs: number
  readonly sttModels: readonly string[]
  readonly ttsModels: readonly string[]
  readonly voices: readonly string[]
  readonly error?: string
}

export interface ButlerSttTranscribeRequest {
  readonly wavBytes?: Uint8Array
  readonly wavBase64?: string
  readonly language?: string
  readonly prompt?: string
  readonly purpose?: 'command' | 'wake'
}

export interface ButlerSttTranscribeResult {
  readonly ok: boolean
  readonly text: string
  readonly language?: string
  readonly duration?: number
  readonly latencyMs: number
  readonly error?: string
}

export interface ButlerTtsStartRequest {
  readonly requestId: string
  readonly text: string
  readonly voice?: string
  readonly speed?: number
  readonly instructions?: string
  readonly configOverride?: Partial<ButlerVoiceConfig>
}

export interface ButlerTtsStartResult {
  readonly ok: boolean
  readonly requestId: string
  readonly fallbackSystem?: boolean
  readonly error?: string
}

export interface ButlerTtsStreamEvent {
  readonly requestId: string
  readonly type: 'chunk' | 'done' | 'error'
  readonly chunk?: Uint8Array
  readonly fallbackSystem?: boolean
  readonly error?: string
}

export interface ButlerVoiceCloneUploadRequest {
  readonly audioBase64: string
  readonly fileName: string
  readonly refText?: string
}

export interface ButlerVoiceCloneState {
  readonly hasAudio: boolean
  readonly fileName: string
  readonly byteLength: number
  readonly updatedAt: number | null
}

export interface ButlerWakeSummonRequest {
  readonly mode: 'listen' | 'command'
  readonly rawText: string
  readonly commandText?: string
}

export interface ButlerWakeSummonResult {
  readonly ok: boolean
  readonly submitted?: boolean
  readonly error?: string
}

export interface ButlerWakePromptPayload {
  readonly autoListen: boolean
  readonly wakeAck: boolean
}

export interface ButlerMicArbitrationState {
  readonly deskMicActive: boolean
  readonly ttsSpeaking: boolean
  readonly updatedAt: number
}

export type ButlerMicArbitrationPatch = Partial<
  Pick<ButlerMicArbitrationState, 'deskMicActive' | 'ttsSpeaking'>
>

const BASE_URL_MAX = 512
const API_KEY_MAX = 256
const MODEL_NAME_MAX = 160
const VOICE_NAME_MAX = 120
const INSTRUCTIONS_MAX = 400
const CLONE_REF_TEXT_MAX = 500
const CLONE_AUDIO_NAME_MAX = 160
const WAKE_ALIASES_MAX = 240
const VAD_SILENCE_MIN_MS = 450
const VAD_SILENCE_MAX_MS = 3000

const VALID_STT_LANGUAGES: readonly ButlerSttLanguage[] = ['auto', 'zh', 'en', 'ja', 'ko']

// Strip control characters and collapse whitespace for bounded single-line fields.
function sanitizeVoiceLine(value: unknown, max: number): string {
  if (typeof value !== 'string' || max <= 0) return ''
  return value
    .replace(/[\r\n\t\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function sanitizeCompactToken(value: unknown, max: number): string {
  if (typeof value !== 'string' || max <= 0) return ''
  return value
    .replace(/[\r\n\t\x00-\x1f\x7f]+/g, '')
    .trim()
    .slice(0, max)
}

function normalizeBool(value: unknown, fallback: boolean): boolean {
  if (value === true) return true
  if (value === false) return false
  return fallback
}

function normalizeProvider(value: unknown): ButlerVoiceProvider {
  return value === 'system' || value === 'omlx' ? value : DEFAULT_BUTLER_VOICE_CONFIG.provider
}

function normalizeSttLanguage(value: unknown): ButlerSttLanguage {
  return VALID_STT_LANGUAGES.includes(value as ButlerSttLanguage)
    ? (value as ButlerSttLanguage)
    : DEFAULT_BUTLER_VOICE_CONFIG.sttLanguage
}

function normalizeVadSilenceMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_BUTLER_VOICE_CONFIG.vadSilenceMs
  }
  const rounded = Math.round(value)
  return Math.min(VAD_SILENCE_MAX_MS, Math.max(VAD_SILENCE_MIN_MS, rounded))
}

function normalizeBaseUrl(value: unknown, provider: ButlerVoiceProvider): string {
  if (typeof value !== 'string') {
    return DEFAULT_OMLX_BASE_URL
  }
  const cleaned = sanitizeCompactToken(value, BASE_URL_MAX).replace(/\/+$/, '')
  if (!cleaned) {
    return provider === 'omlx' ? DEFAULT_OMLX_BASE_URL : ''
  }
  try {
    const parsed = new URL(cleaned)
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.length > 0) {
      return cleaned
    }
  } catch {
    // Invalid URL falls back below.
  }
  return DEFAULT_OMLX_BASE_URL
}

/** Normalize raw `butlerVoice` settings into a safe, complete `ButlerVoiceConfig` snapshot. */
export function normalizeButlerVoiceConfig(value: unknown): ButlerVoiceConfig {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>

  const provider = normalizeProvider(raw.provider)
  const baseUrl = normalizeBaseUrl(raw.baseUrl, provider)
  const apiKey =
    typeof raw.apiKey === 'string'
      ? sanitizeCompactToken(raw.apiKey, API_KEY_MAX)
      : DEFAULT_OMLX_API_KEY
  const ttsModel = sanitizeVoiceLine(raw.ttsModel, MODEL_NAME_MAX) || DEFAULT_OMLX_TTS_MODEL
  const sttModel = sanitizeVoiceLine(raw.sttModel, MODEL_NAME_MAX) || DEFAULT_OMLX_STT_MODEL
  const ttsVoice = sanitizeVoiceLine(raw.ttsVoice, VOICE_NAME_MAX) || DEFAULT_OMLX_TTS_VOICE
  const ttsInstructions = sanitizeVoiceLine(raw.ttsInstructions, INSTRUCTIONS_MAX)
  const sttLanguage = normalizeSttLanguage(raw.sttLanguage)
  const fallbackToSystem = normalizeBool(
    raw.fallbackToSystem,
    DEFAULT_BUTLER_VOICE_CONFIG.fallbackToSystem,
  )
  const cloneEnabled = normalizeBool(raw.cloneEnabled, DEFAULT_BUTLER_VOICE_CONFIG.cloneEnabled)
  const cloneRefText = sanitizeVoiceLine(raw.cloneRefText, CLONE_REF_TEXT_MAX)
  const cloneAudioName = sanitizeVoiceLine(raw.cloneAudioName, CLONE_AUDIO_NAME_MAX)
  const cloneHasAudio = normalizeBool(raw.cloneHasAudio, DEFAULT_BUTLER_VOICE_CONFIG.cloneHasAudio)
  const wakeWordEnabled = normalizeBool(
    raw.wakeWordEnabled,
    DEFAULT_BUTLER_VOICE_CONFIG.wakeWordEnabled,
  )
  const wakeAliases =
    typeof raw.wakeAliases === 'string'
      ? sanitizeVoiceLine(raw.wakeAliases, WAKE_ALIASES_MAX)
      : DEFAULT_WAKE_ALIASES
  const hotkeyAutoListen = normalizeBool(
    raw.hotkeyAutoListen,
    DEFAULT_BUTLER_VOICE_CONFIG.hotkeyAutoListen,
  )
  const vadSilenceMs = normalizeVadSilenceMs(raw.vadSilenceMs)
  const autoSpeakReplies = normalizeBool(
    raw.autoSpeakReplies,
    DEFAULT_BUTLER_VOICE_CONFIG.autoSpeakReplies,
  )

  return {
    provider,
    baseUrl,
    apiKey,
    ttsModel,
    sttModel,
    ttsVoice,
    ttsInstructions,
    sttLanguage,
    fallbackToSystem,
    cloneEnabled,
    cloneRefText,
    cloneAudioName,
    cloneHasAudio,
    wakeWordEnabled,
    wakeAliases,
    hotkeyAutoListen,
    vadSilenceMs,
    autoSpeakReplies,
  }
}

/** Merge a partial patch into an existing config and return a normalized snapshot. */
export function mergeButlerVoiceConfig(
  current: ButlerVoiceConfig,
  patch: unknown,
): ButlerVoiceConfig {
  const base = normalizeButlerVoiceConfig(current)
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return base
  }
  const p = patch as Record<string, unknown>
  return normalizeButlerVoiceConfig({
    provider: typeof p.provider === 'string' ? p.provider : base.provider,
    baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : base.baseUrl,
    apiKey: typeof p.apiKey === 'string' ? p.apiKey : base.apiKey,
    ttsModel: typeof p.ttsModel === 'string' ? p.ttsModel : base.ttsModel,
    sttModel: typeof p.sttModel === 'string' ? p.sttModel : base.sttModel,
    ttsVoice: typeof p.ttsVoice === 'string' ? p.ttsVoice : base.ttsVoice,
    ttsInstructions: typeof p.ttsInstructions === 'string' ? p.ttsInstructions : base.ttsInstructions,
    sttLanguage: typeof p.sttLanguage === 'string' ? p.sttLanguage : base.sttLanguage,
    fallbackToSystem:
      typeof p.fallbackToSystem === 'boolean' ? p.fallbackToSystem : base.fallbackToSystem,
    cloneEnabled: typeof p.cloneEnabled === 'boolean' ? p.cloneEnabled : base.cloneEnabled,
    cloneRefText: typeof p.cloneRefText === 'string' ? p.cloneRefText : base.cloneRefText,
    cloneAudioName: typeof p.cloneAudioName === 'string' ? p.cloneAudioName : base.cloneAudioName,
    cloneHasAudio: typeof p.cloneHasAudio === 'boolean' ? p.cloneHasAudio : base.cloneHasAudio,
    wakeWordEnabled:
      typeof p.wakeWordEnabled === 'boolean' ? p.wakeWordEnabled : base.wakeWordEnabled,
    wakeAliases: typeof p.wakeAliases === 'string' ? p.wakeAliases : base.wakeAliases,
    hotkeyAutoListen:
      typeof p.hotkeyAutoListen === 'boolean' ? p.hotkeyAutoListen : base.hotkeyAutoListen,
    vadSilenceMs: typeof p.vadSilenceMs === 'number' ? p.vadSilenceMs : base.vadSilenceMs,
    autoSpeakReplies:
      typeof p.autoSpeakReplies === 'boolean' ? p.autoSpeakReplies : base.autoSpeakReplies,
  })
}

/** Value equality across all fields of two `ButlerVoiceConfig` objects. */
export function sameButlerVoiceConfig(a: ButlerVoiceConfig, b: ButlerVoiceConfig): boolean {
  return (
    a.provider === b.provider &&
    a.baseUrl === b.baseUrl &&
    a.apiKey === b.apiKey &&
    a.ttsModel === b.ttsModel &&
    a.sttModel === b.sttModel &&
    a.ttsVoice === b.ttsVoice &&
    a.ttsInstructions === b.ttsInstructions &&
    a.sttLanguage === b.sttLanguage &&
    a.fallbackToSystem === b.fallbackToSystem &&
    a.cloneEnabled === b.cloneEnabled &&
    a.cloneRefText === b.cloneRefText &&
    a.cloneAudioName === b.cloneAudioName &&
    a.cloneHasAudio === b.cloneHasAudio &&
    a.wakeWordEnabled === b.wakeWordEnabled &&
    a.wakeAliases === b.wakeAliases &&
    a.hotkeyAutoListen === b.hotkeyAutoListen &&
    a.vadSilenceMs === b.vadSilenceMs &&
    a.autoSpeakReplies === b.autoSpeakReplies
  )
}

/**
 * Patch streaming WAV placeholder sizes (`0xFFFFFFFF` in RIFF and data chunk
 * headers) with concrete byte counts derived from the complete buffer length.
 * Always returns a new `Uint8Array` copy without mutating the input buffer.
 */
export function patchStreamingWavHeader(buf: Uint8Array): Uint8Array {
  const out = new Uint8Array(buf)
  if (out.length < 44) return out

  // Check for ASCII "RIFF" at offset 0 and "WAVE" at offset 8.
  const isRiff =
    out[0] === 0x52 && out[1] === 0x49 && out[2] === 0x46 && out[3] === 0x46
  const isWave =
    out[8] === 0x57 && out[9] === 0x41 && out[10] === 0x56 && out[11] === 0x45
  if (!isRiff || !isWave) return out

  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint32(4, out.length - 8, true)
  view.setUint32(40, out.length - 44, true)
  return out
}
