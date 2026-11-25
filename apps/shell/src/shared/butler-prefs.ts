/**
 * Persisted AI butler preferences shared across main, preload, HUD, and Settings
 * (`app-settings.json` under the `butler` key).
 *
 * Kept Electron-free and DOM-free so main-process stores, preload normalizers,
 * renderer panels, and unit tests all normalize against one exact contract.
 */

export const BUTLER_WORKER_THINKING_EFFORTS = ['follow', 'low', 'medium', 'high'] as const
export type ButlerWorkerThinkingEffort = (typeof BUTLER_WORKER_THINKING_EFFORTS)[number]

/** Check whether `value` is a supported worker thinking effort override. */
export function isButlerWorkerThinkingEffort(value: unknown): value is ButlerWorkerThinkingEffort {
  return (
    typeof value === 'string' &&
    (BUTLER_WORKER_THINKING_EFFORTS as readonly string[]).includes(value)
  )
}

export interface ButlerPrefs {
  readonly enabled: boolean
  readonly name: string
  readonly honorific: string
  readonly userName: string
  readonly persona: boolean
  readonly briefing: boolean
  readonly notifyDone: boolean
  readonly notifyConfirm: boolean
  readonly dnd: boolean
  readonly maxPerHour: number
  readonly voice: boolean
  readonly voiceRate: number
  readonly voiceName: string
  readonly chiefFastMode: boolean
  readonly workerThinkingEffort: ButlerWorkerThinkingEffort
  readonly planConfirmBeforeDispatch: boolean
}

export type ButlerPrefsPatch = Partial<ButlerPrefs>

export const DEFAULT_BUTLER_PREFS: ButlerPrefs = {
  enabled: true,
  name: '贾维斯',
  honorific: '先生',
  userName: '',
  persona: true,
  briefing: true,
  notifyDone: true,
  notifyConfirm: true,
  dnd: false,
  maxPerHour: 6,
  voice: true,
  voiceRate: 1,
  voiceName: '',
  chiefFastMode: true,
  workerThinkingEffort: 'high',
  planConfirmBeforeDispatch: true,
}

const NAME_MAX = 24
const HONORIFIC_MAX = 24
const USER_NAME_MAX = 32
const VOICE_NAME_MAX = 120
const MAX_PER_HOUR_MIN = 1
const MAX_PER_HOUR_MAX = 30
const VOICE_RATE_MIN = 0.7
const VOICE_RATE_MAX = 1.6

/**
 * Normalize a single-line text field for prompt and UI safety:
 * replace CR/LF/TAB with spaces, strip prompt-breaking quotes/delimiters,
 * collapse whitespace, trim, and truncate to `max` characters.
 */
export function sanitizeButlerLine(value: unknown, max: number): string {
  if (typeof value !== 'string' || max <= 0) return ''
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/["'`<>{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function normalizeMaxPerHour(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_BUTLER_PREFS.maxPerHour
  }
  const rounded = Math.round(value)
  return Math.min(MAX_PER_HOUR_MAX, Math.max(MAX_PER_HOUR_MIN, rounded))
}

function normalizeVoiceRate(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_BUTLER_PREFS.voiceRate
  }
  const clamped = Math.min(VOICE_RATE_MAX, Math.max(VOICE_RATE_MIN, value))
  return Math.round(clamped * 10) / 10
}

function normalizeBool(value: unknown, fallback: boolean): boolean {
  if (value === true) return true
  if (value === false) return false
  return fallback
}

/** Normalize raw `butler` settings into a safe, complete `ButlerPrefs` object. */
export function normalizeButlerPrefs(value: unknown): ButlerPrefs {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>

  const cleanName = sanitizeButlerLine(raw.name, NAME_MAX)
  const cleanHonorific =
    raw.honorific === undefined
      ? DEFAULT_BUTLER_PREFS.honorific
      : sanitizeButlerLine(raw.honorific, HONORIFIC_MAX)

  return {
    enabled: normalizeBool(raw.enabled, DEFAULT_BUTLER_PREFS.enabled),
    name: cleanName || DEFAULT_BUTLER_PREFS.name,
    honorific: cleanHonorific,
    userName: sanitizeButlerLine(raw.userName, USER_NAME_MAX),
    persona: normalizeBool(raw.persona, DEFAULT_BUTLER_PREFS.persona),
    briefing: normalizeBool(raw.briefing, DEFAULT_BUTLER_PREFS.briefing),
    notifyDone: normalizeBool(raw.notifyDone, DEFAULT_BUTLER_PREFS.notifyDone),
    notifyConfirm: normalizeBool(raw.notifyConfirm, DEFAULT_BUTLER_PREFS.notifyConfirm),
    dnd: normalizeBool(raw.dnd, DEFAULT_BUTLER_PREFS.dnd),
    maxPerHour: normalizeMaxPerHour(raw.maxPerHour),
    voice: normalizeBool(raw.voice, DEFAULT_BUTLER_PREFS.voice),
    voiceRate: normalizeVoiceRate(raw.voiceRate),
    voiceName: sanitizeButlerLine(raw.voiceName, VOICE_NAME_MAX),
    chiefFastMode: normalizeBool(raw.chiefFastMode, DEFAULT_BUTLER_PREFS.chiefFastMode),
    workerThinkingEffort: isButlerWorkerThinkingEffort(raw.workerThinkingEffort)
      ? raw.workerThinkingEffort
      : DEFAULT_BUTLER_PREFS.workerThinkingEffort,
    planConfirmBeforeDispatch: normalizeBool(
      raw.planConfirmBeforeDispatch,
      DEFAULT_BUTLER_PREFS.planConfirmBeforeDispatch,
    ),
  }
}

/** Merge a partial patch into current prefs and return a newly normalized snapshot. */
export function mergeButlerPrefs(current: ButlerPrefs, patch: unknown): ButlerPrefs {
  const base = normalizeButlerPrefs(current)
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return base
  }
  const p = patch as Record<string, unknown>
  return normalizeButlerPrefs({
    enabled: typeof p.enabled === 'boolean' ? p.enabled : base.enabled,
    name: typeof p.name === 'string' ? p.name : base.name,
    honorific: typeof p.honorific === 'string' ? p.honorific : base.honorific,
    userName: typeof p.userName === 'string' ? p.userName : base.userName,
    persona: typeof p.persona === 'boolean' ? p.persona : base.persona,
    briefing: typeof p.briefing === 'boolean' ? p.briefing : base.briefing,
    notifyDone: typeof p.notifyDone === 'boolean' ? p.notifyDone : base.notifyDone,
    notifyConfirm: typeof p.notifyConfirm === 'boolean' ? p.notifyConfirm : base.notifyConfirm,
    dnd: typeof p.dnd === 'boolean' ? p.dnd : base.dnd,
    maxPerHour: typeof p.maxPerHour === 'number' ? p.maxPerHour : base.maxPerHour,
    voice: typeof p.voice === 'boolean' ? p.voice : base.voice,
    voiceRate: typeof p.voiceRate === 'number' ? p.voiceRate : base.voiceRate,
    voiceName: typeof p.voiceName === 'string' ? p.voiceName : base.voiceName,
    chiefFastMode: typeof p.chiefFastMode === 'boolean' ? p.chiefFastMode : base.chiefFastMode,
    workerThinkingEffort:
      typeof p.workerThinkingEffort === 'string'
        ? p.workerThinkingEffort
        : base.workerThinkingEffort,
    planConfirmBeforeDispatch:
      typeof p.planConfirmBeforeDispatch === 'boolean'
        ? p.planConfirmBeforeDispatch
        : base.planConfirmBeforeDispatch,
  })
}

/** Value equality across all fields of two `ButlerPrefs` objects. */
export function sameButlerPrefs(a: ButlerPrefs, b: ButlerPrefs): boolean {
  return (
    a.enabled === b.enabled &&
    a.name === b.name &&
    a.honorific === b.honorific &&
    a.userName === b.userName &&
    a.persona === b.persona &&
    a.briefing === b.briefing &&
    a.notifyDone === b.notifyDone &&
    a.notifyConfirm === b.notifyConfirm &&
    a.dnd === b.dnd &&
    a.maxPerHour === b.maxPerHour &&
    a.voice === b.voice &&
    a.voiceRate === b.voiceRate &&
    a.voiceName === b.voiceName &&
    a.chiefFastMode === b.chiefFastMode &&
    a.workerThinkingEffort === b.workerThinkingEffort &&
    a.planConfirmBeforeDispatch === b.planConfirmBeforeDispatch
  )
}
