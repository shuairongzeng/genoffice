import type { ButlerDecisionItem } from './butler-orchestrator-api'
import type { ButlerPrefs } from './butler-prefs'

export * from './butler-orchestrator-api'

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

export interface ButlerSpeakRequest {
  readonly text: string
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
