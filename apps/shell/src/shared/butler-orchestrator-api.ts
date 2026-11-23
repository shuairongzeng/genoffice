/**
 * Shared IPC contracts and pure domain models for the Chief-of-Staff Butler
 * multi-task orchestrator, worker pool, unified HITL decision inbox, and
 * synthesized mission completion reporting.
 */

import type { ButlerStep } from './butler-api'

export const BUTLER_CHIEF_PROJECT_ID = 'default'
export const BUTLER_CHIEF_CHAT_ID = 'butler-main'
export const BUTLER_CHIEF_SESSION_KEY = `${BUTLER_CHIEF_PROJECT_ID}:${BUTLER_CHIEF_CHAT_ID}`
export const BUTLER_WORKER_CHAT_PREFIX = 'butler-worker-'

/** Return true when `sessionKey` identifies the single canonical Chief Butler session. */
export function isButlerChiefSession(sessionKey: string): boolean {
  return sessionKey === BUTLER_CHIEF_SESSION_KEY
}

/** Return true when `sessionKey` belongs to an ephemeral background worker spawned by Butler. */
export function isButlerWorkerSession(sessionKey: string): boolean {
  return (
    sessionKey.startsWith(`${BUTLER_CHIEF_PROJECT_ID}:${BUTLER_WORKER_CHAT_PREFIX}`) ||
    sessionKey.startsWith(BUTLER_WORKER_CHAT_PREFIX)
  )
}

export type ButlerWorkerRole = 'general' | 'research' | 'docs' | 'sheets' | 'slides' | 'browser'

export type ButlerMissionStatus =
  | 'planning'
  | 'running'
  | 'waiting_human'
  | 'synthesizing'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type ButlerSubTaskStatus =
  'queued' | 'running' | 'waiting_human' | 'done' | 'failed' | 'cancelled' | 'interrupted'

export type ButlerDecisionKind = 'permission' | 'choice' | 'recovery'

export interface ButlerArtifactRef {
  readonly path: string
  readonly label: string
  readonly existsOnDisk: boolean
}

export interface ButlerDecisionOption {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly style?: 'primary' | 'default' | 'danger'
}

export interface ButlerDecisionResolution {
  readonly optionId: string
  readonly note?: string
  readonly resolvedAt: number
}

export interface ButlerDecisionItem {
  readonly id: string
  readonly missionId: string
  readonly taskId: string
  readonly sessionKey: string
  readonly kind: ButlerDecisionKind
  readonly title: string
  readonly summary: string
  readonly detail?: string
  readonly toolName?: string
  readonly confirmRequestId?: string
  readonly sessionAllowable?: boolean
  readonly options: readonly ButlerDecisionOption[]
  readonly status: 'pending' | 'resolved' | 'expired' | 'cancelled'
  readonly resolution?: ButlerDecisionResolution
  readonly createdAt: number
}

export interface ButlerSubTask {
  readonly id: string
  readonly missionId: string
  readonly title: string
  readonly brief: string
  readonly role: ButlerWorkerRole
  readonly dependsOn: readonly string[]
  readonly scopePaths?: readonly string[]
  readonly sessionKey: string
  readonly status: ButlerSubTaskStatus
  readonly step: ButlerStep | null
  readonly progressNote?: string
  readonly outputSummary?: string
  readonly artifacts: readonly ButlerArtifactRef[]
  readonly error?: string
  readonly createdAt: number
  readonly startedAt?: number
  readonly finishedAt?: number
}

export interface ButlerMissionReport {
  readonly headline: string
  readonly summary: string
  readonly artifacts: readonly ButlerArtifactRef[]
  readonly risks: readonly string[]
  readonly nextSuggestion?: string
  readonly generatedAt: number
}

export interface ButlerMission {
  readonly id: string
  readonly title: string
  readonly goal: string
  readonly status: ButlerMissionStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly finishedAt?: number
  readonly taskIds: readonly string[]
  readonly report?: ButlerMissionReport
  readonly error?: string
}

export interface ButlerConversationEntry {
  readonly id: string
  readonly role: 'user' | 'butler' | 'system'
  readonly text: string
  readonly missionId?: string
  readonly report?: ButlerMissionReport
  readonly decisionId?: string
  readonly createdAt: number
}

export interface ButlerDeskSnapshot {
  readonly chiefSessionKey: string
  readonly chiefBusy: boolean
  readonly missions: readonly ButlerMission[]
  readonly tasks: readonly ButlerSubTask[]
  readonly decisions: readonly ButlerDecisionItem[]
  readonly feed: readonly ButlerConversationEntry[]
  readonly concurrency: {
    readonly running: number
    readonly maxConcurrent: number
    readonly queued: number
  }
}

export interface ButlerDelegateResult {
  readonly ok: boolean
  readonly missionId?: string
  readonly error?: string
}

export interface ButlerResolveDecisionRequest {
  readonly decisionId: string
  readonly optionId: string
  readonly note?: string
}

export interface ButlerResolveDecisionResult {
  readonly ok: boolean
  readonly error?: string
}

export interface ButlerActionResult {
  readonly ok: boolean
  readonly error?: string
}

export interface ButlerSteerTaskRequest {
  readonly taskId: string
  readonly instruction: string
}

export interface ButlerOpenDeskPayload {
  readonly missionId?: string
  readonly decisionId?: string
}

/** Runtime shape check for decision-inbox resolution requests from renderer or HUD. */
export function isButlerResolveDecisionRequest(
  value: unknown,
): value is ButlerResolveDecisionRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  if (typeof r.decisionId !== 'string' || r.decisionId.trim().length === 0) return false
  if (typeof r.optionId !== 'string' || r.optionId.trim().length === 0) return false
  if (r.note !== undefined && typeof r.note !== 'string') return false
  return true
}

/** Runtime shape check for opening the Chief Butler desk window with optional focus target. */
export function isButlerOpenDeskPayload(value: unknown): value is ButlerOpenDeskPayload {
  if (value === undefined || value === null) return true
  if (typeof value !== 'object' || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  if (r.missionId !== undefined && typeof r.missionId !== 'string') return false
  if (r.decisionId !== undefined && typeof r.decisionId !== 'string') return false
  return true
}

/** Runtime shape check for steering a background worker task. */
export function isButlerSteerTaskRequest(value: unknown): value is ButlerSteerTaskRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  return (
    typeof r.taskId === 'string' &&
    r.taskId.trim().length > 0 &&
    typeof r.instruction === 'string' &&
    r.instruction.trim().length > 0
  )
}
