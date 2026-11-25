import type { ButlerDecisionItem } from './butler-orchestrator-api'
import type { ButlerPrefs } from './butler-prefs'

export * from './butler-orchestrator-api'
export * from './butler-voice-api'

export type ButlerTaskStatus = 'running' | 'confirm' | 'done' | 'error'

export type ButlerStepKind =
  'read' | 'search' | 'browse' | 'edit' | 'create' | 'command' | 'think' | 'other'

export interface ButlerStep {
  readonly tool: string
  readonly kind: ButlerStepKind
}

export interface ButlerTaskUpdate {
  readonly sessionKey: string
  readonly title: string
  readonly status: ButlerTaskStatus
  readonly step: ButlerStep | null
  readonly summary?: string
  readonly error?: string
  readonly startedAt: number
  readonly fromButler: boolean
}

export type ButlerSubmitError = 'disabled' | 'legacy' | 'empty' | 'failed'

export interface ButlerSubmitResult {
  readonly ok: boolean
  readonly sessionKey?: string
  readonly error?: ButlerSubmitError
  readonly message?: string
}

export type ButlerBriefingRef =
  | { readonly type: 'file'; readonly path: string; readonly label: string }
  | { readonly type: 'todo'; readonly id: string; readonly label: string }
  | { readonly type: 'session'; readonly sessionKey: string; readonly label: string }

export type ButlerBriefingKind =
  'tasks-waiting' | 'tasks-failed' | 'tasks-done' | 'todos-open' | 'recent-docs'

export interface ButlerBriefingItem {
  readonly kind: ButlerBriefingKind
  readonly count: number
  readonly refs: readonly ButlerBriefingRef[]
}

export type ButlerPartOfDay = 'morning' | 'afternoon' | 'evening' | 'night'

export interface ButlerBriefing {
  readonly dayKey: string
  readonly partOfDay: ButlerPartOfDay
  readonly items: readonly ButlerBriefingItem[]
}

export interface ButlerHudState {
  readonly prefs: ButlerPrefs
  readonly hotkey: string | null
  readonly briefing: ButlerBriefing | null
  readonly tasks: readonly ButlerTaskUpdate[]
  readonly pendingDecisions?: readonly ButlerDecisionItem[]
  readonly activeMissionCount?: number
}

export type ButlerOpenTarget =
  | ButlerBriefingRef
  | { readonly type: 'settings' }
  | { readonly type: 'desk'; readonly missionId?: string; readonly decisionId?: string }

export type ButlerSpeakPhase =
  | 'ack'
  | 'clarifying'
  | 'plan_review'
  | 'stream'
  | 'planned'
  | 'decision'
  | 'completed'
  | 'briefing'
  | 'general'

export interface ButlerSpeakRequest {
  readonly text: string
  readonly enqueue?: boolean
  readonly phase?: ButlerSpeakPhase
  readonly openFollowUp?: boolean
  readonly streamTurnId?: string
  readonly streamFinal?: boolean
}

export interface StreamingSpeechChunker {
  push(text: string, mode?: 'cumulative' | 'delta'): string[]
  flush(): string[]
  reset(): void
  readonly emittedCount: number
}

function commonPrefixLen(a: string, b: string): number {
  const limit = Math.min(a.length, b.length)
  let i = 0
  while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) {
    i += 1
  }
  return i
}

function cleanStreamSpeechText(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__|~~)/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function visibleSpeechLength(raw: string): number {
  return raw.replace(/[\s*_`~#>|]/g, '').length
}

function computeUrlRanges(text: string): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = []
  const re = /(?:https?:\/\/|www\.)\S+/gi
  for (const m of text.matchAll(re)) {
    if (m.index !== undefined) {
      ranges.push([m.index, m.index + m[0].length])
    }
  }
  return ranges
}

function indexInRanges(idx: number, ranges: readonly (readonly [number, number])[]): boolean {
  for (const [start, end] of ranges) {
    if (idx >= start && idx < end) return true
  }
  return false
}

function findNextSpeechBoundary(buf: string, eagerClause: boolean, minChars: number): number {
  const urlRanges = computeUrlRanges(buf)
  let visibleCount = 0

  for (let i = 0; i < buf.length; i += 1) {
    const ch = buf[i]!
    if (!/[\s*_`~#>|]/.test(ch)) {
      visibleCount += 1
    }
    if (visibleCount < minChars) continue
    if (indexInRanges(i, urlRanges)) continue

    const prev = i > 0 ? buf[i - 1]! : ''
    const next = i + 1 < buf.length ? buf[i + 1]! : ''

    const isCjkTerminal = ch === '。' || ch === '！' || ch === '？' || ch === '；' || ch === '\n'
    const isAsciiBangOrQuestion = (ch === '!' || ch === '?') && next !== '!' && next !== '?'
    const isAsciiPeriod =
      ch === '.' &&
      prev !== '.' &&
      next !== '.' &&
      !(/\d/.test(prev) && /\d/.test(next)) &&
      (/\s/.test(next) || (next === '' && !/\d/.test(prev)))

    if (isCjkTerminal || isAsciiBangOrQuestion || isAsciiPeriod) {
      return i
    }

    if (eagerClause) {
      const isCjkPause = ch === '，' || ch === '、' || ch === '：' || ch === '—'
      const isAsciiPause = (ch === ',' || ch === ':') && /\s/.test(next)
      if (isCjkPause || isAsciiPause) {
        return i
      }
    }
  }

  return -1
}

/**
 * Create an incremental sentence chunker for low-latency streaming TTS.
 * Cuts the first clause eagerly on natural pauses once `firstMinChars` are
 * buffered, then emits complete sentences once `nextMinChars` are reached.
 */
export function createStreamingSpeechChunker(opts?: {
  readonly firstMinChars?: number
  readonly nextMinChars?: number
}): StreamingSpeechChunker {
  const firstMinChars =
    typeof opts?.firstMinChars === 'number' && Number.isFinite(opts.firstMinChars) && opts.firstMinChars > 0
      ? Math.floor(opts.firstMinChars)
      : 6
  const nextMinChars =
    typeof opts?.nextMinChars === 'number' && Number.isFinite(opts.nextMinChars) && opts.nextMinChars > 0
      ? Math.floor(opts.nextMinChars)
      : 12

  let buffer = ''
  let lastCumulativeRaw = ''
  let consumedRawLength = 0
  let emitted = 0

  return {
    get emittedCount(): number {
      return emitted
    },

    push(text: string, mode: 'cumulative' | 'delta' = 'cumulative'): string[] {
      if (!text) return []

      let delta = ''
      if (mode === 'delta') {
        delta = text
        lastCumulativeRaw += text
        consumedRawLength += text.length
      } else {
        if (text.length <= consumedRawLength && lastCumulativeRaw.startsWith(text)) {
          return []
        }
        if (text.length <= consumedRawLength) {
          return []
        }
        if (text.startsWith(lastCumulativeRaw)) {
          delta = text.slice(lastCumulativeRaw.length)
        } else {
          const cp = commonPrefixLen(lastCumulativeRaw, text)
          if (cp > 0 && cp >= Math.min(lastCumulativeRaw.length, consumedRawLength) - 4) {
            delta = text.slice(cp)
          } else {
            delta = text.slice(consumedRawLength)
          }
        }
        lastCumulativeRaw = text
        consumedRawLength = text.length
      }

      if (!delta) return []
      buffer += delta.replace(/\r\n/g, '\n')

      const out: string[] = []
      while (buffer.length > 0) {
        const eager = emitted === 0
        const minChars = eager ? firstMinChars : nextMinChars
        if (visibleSpeechLength(buffer) < minChars) break

        const splitIdx = findNextSpeechBoundary(buffer, eager, minChars)
        if (splitIdx < 0) break

        const rawSlice = buffer.slice(0, splitIdx + 1)
        buffer = buffer.slice(splitIdx + 1)
        const cleaned = cleanStreamSpeechText(rawSlice)
        if (cleaned) {
          out.push(cleaned)
          emitted += 1
        }
      }
      return out
    },

    flush(): string[] {
      const cleaned = cleanStreamSpeechText(buffer)
      buffer = ''
      if (!cleaned) return []
      emitted += 1
      return [cleaned]
    },

    reset(): void {
      buffer = ''
      lastCumulativeRaw = ''
      consumedRawLength = 0
      emitted = 0
    },
  }
}

export const MAX_BUTLER_INSTRUCTION = 4000

/** Runtime shape check for IPC payloads sent over `home:butler-open`. */
export function isButlerOpenTarget(value: unknown): value is ButlerOpenTarget {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  if (raw.type === 'settings') return true
  if (raw.type === 'desk') {
    if (raw.missionId !== undefined && typeof raw.missionId !== 'string') return false
    if (raw.decisionId !== undefined && typeof raw.decisionId !== 'string') return false
    return true
  }
  if (typeof raw.label !== 'string') return false
  if (raw.type === 'file') {
    return typeof raw.path === 'string' && raw.path.trim().length > 0
  }
  if (raw.type === 'todo') {
    return typeof raw.id === 'string' && raw.id.trim().length > 0
  }
  if (raw.type === 'session') {
    return typeof raw.sessionKey === 'string' && raw.sessionKey.trim().length > 0
  }
  return false
}
