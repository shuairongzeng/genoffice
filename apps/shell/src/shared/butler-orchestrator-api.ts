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
  | 'clarifying'
  | 'awaiting_plan_approval'
  | 'planning'
  | 'running'
  | 'waiting_human'
  | 'synthesizing'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface ButlerProposedTaskStep {
  readonly id: string
  readonly title: string
  readonly brief: string
  readonly role: ButlerWorkerRole
  readonly dependsOn: readonly string[]
  readonly scopePaths?: readonly string[]
}

export interface ButlerMissionPlan {
  readonly summary: string
  readonly steps: readonly ButlerProposedTaskStep[]
  readonly revision: number
  readonly updatedAt: number
  readonly approvedAt?: number
}

export interface ButlerApproveMissionPlanRequest {
  readonly missionId: string
  readonly comment?: string
}

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
  readonly conversationNotes?: readonly string[]
  readonly plan?: ButlerMissionPlan
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

export const BUTLER_DESKTOP_ACTION_TARGETS = [
  'media-player',
  'browser',
  'settings',
  'butler-desk',
  'file',
] as const
export type ButlerDesktopActionTarget = (typeof BUTLER_DESKTOP_ACTION_TARGETS)[number]

export const BUTLER_MEDIA_COMMANDS = [
  'list',
  'play',
  'pause',
  'toggle-play',
  'next',
  'prev',
  'close',
] as const
export type ButlerMediaCommand = (typeof BUTLER_MEDIA_COMMANDS)[number]

export interface ButlerDesktopActionRequest {
  readonly target: ButlerDesktopActionTarget
  readonly pathOrUrl?: string
  readonly query?: string
  readonly mediaCommand?: ButlerMediaCommand
}

export interface ButlerDesktopActionResult extends ButlerActionResult {
  readonly openedPath?: string
  readonly matchedTitle?: string
  readonly tracks?: readonly string[]
}

export const BUTLER_MISSION_LIST_FILTERS = [
  'active',
  'done',
  'failed',
  'cancelled',
  'all',
] as const
export type ButlerMissionListFilter = (typeof BUTLER_MISSION_LIST_FILTERS)[number]

export interface ButlerRetryTaskRequest {
  readonly taskId: string
  readonly instruction?: string
}

/** Runtime shape check for retrying a failed, cancelled, or interrupted worker task. */
export function isButlerRetryTaskRequest(value: unknown): value is ButlerRetryTaskRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  if (typeof r.taskId !== 'string' || r.taskId.trim().length === 0) return false
  if (r.instruction !== undefined && typeof r.instruction !== 'string') return false
  return true
}

/** Runtime shape check for approving a proposed mission execution plan. */
export function isButlerApproveMissionPlanRequest(
  value: unknown,
): value is ButlerApproveMissionPlanRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  if (typeof r.missionId !== 'string' || r.missionId.trim().length === 0) return false
  if (r.comment !== undefined && typeof r.comment !== 'string') return false
  return true
}

const PLAN_REVISE_CN_RE =
  /但是|不过|改成|修改|调整|换成|加上|再加|去掉|删掉|不对|先别|不要|不是|等一下|稍微/
const PLAN_REVISE_EN_RE =
  /\b(?:but|change|modify|instead|wait|except|add|remove)\b/i

const PLAN_CLAUSE_LEADING_POLITE_RE =
  /^(?:先生|女士|老板|管家|贾维斯|佳维斯|贾维思|小贾|jarvis|please|pls|sir|butler)(?:[\s]+|$)/i
const PLAN_CLAUSE_TRAILING_HONORIFIC_RE =
  /(?:[\s]*(?:先生|女士|老板|管家|贾维斯|佳维斯|贾维思|小贾|谢谢|多谢|感谢|jarvis|please|pls|thanks|thank\s+you|sir|butler))+$/i
const PLAN_CLAUSE_TRAILING_PARTICLE_RE = /(?:吧|呀|啦|啊|哦|呢|哈|了)+$/

const PLAN_POLITE_ONLY_RE =
  /^(?:先生|女士|老板|管家|贾维斯|佳维斯|贾维思|小贾|吧|呀|啦|啊|哦|呢|哈|了|谢谢|多谢|感谢|jarvis|please|pls|thanks|thank\s+you|sir|butler)$/i

const PLAN_CANCEL_CN_RE =
  /^(?:取消|取消任务|算了|不用做了|不用做|停止任务|放弃任务|放弃|停止执行|先取消)$/
const PLAN_CANCEL_EN_RE =
  /^(?:cancel|cancel\s+(?:the\s+)?(?:mission|plan|task)|abort|abort\s+(?:the\s+)?(?:mission|plan|task)|never\s*mind|nevermind|stop|forget\s+it)$/i

const PLAN_APPROVE_CN_RE =
  /^(?:好|好的|可以|没问题|行|行吧|恩|嗯|确认|同意|批准|通过|准奏|开始|开始吧|开始执行|立即执行|执行吧|确认执行|确认派发|派发|按这个办|按这个来|就按这个办|就按这个来|照这个办|照这个来|安排|安排吧|安排下去|派发吧|去办吧|没意见|可以开始)$/
const PLAN_APPROVE_EN_RE =
  /^(?:ok|okay|yes|yep|yeah|yup|sure|go\s+ahead|looks\s+good|sounds\s+good|lgtm|approve|approved|confirm|confirmed|proceed|start|do\s+it|ship\s+it|let'?s\s+go)$/i

type PlanClauseKind = 'approve' | 'cancel' | 'polite' | 'other'

function matchCorePlanToken(core: string): 'approve' | 'cancel' | null {
  if (!core) return null
  if (PLAN_CANCEL_CN_RE.test(core) || PLAN_CANCEL_EN_RE.test(core)) return 'cancel'
  if (PLAN_APPROVE_CN_RE.test(core) || PLAN_APPROVE_EN_RE.test(core)) return 'approve'
  return null
}

function classifySingleTokenOrPhrase(rawClause: string): PlanClauseKind {
  const cleaned = rawClause.replace(/\s+/g, ' ').trim()
  if (!cleaned) return 'polite'
  if (PLAN_POLITE_ONLY_RE.test(cleaned)) return 'polite'

  // First check after stripping outer honorifics/politeness while keeping lexical particles intact.
  const withoutHonorifics = cleaned
    .replace(PLAN_CLAUSE_LEADING_POLITE_RE, '')
    .replace(PLAN_CLAUSE_TRAILING_HONORIFIC_RE, '')
    .trim()
  if (!withoutHonorifics || PLAN_POLITE_ONLY_RE.test(withoutHonorifics)) return 'polite'

  const direct = matchCorePlanToken(withoutHonorifics)
  if (direct) return direct

  // Fall back to stripping trailing modal particles (also removing any trailing honorifics).
  const withoutParticles = withoutHonorifics
    .replace(PLAN_CLAUSE_TRAILING_PARTICLE_RE, '')
    .replace(PLAN_CLAUSE_TRAILING_HONORIFIC_RE, '')
    .trim()
  if (!withoutParticles || PLAN_POLITE_ONLY_RE.test(withoutParticles)) return 'polite'

  return matchCorePlanToken(withoutParticles) ?? 'other'
}

function classifyPlanClause(rawClause: string): PlanClauseKind {
  const direct = classifySingleTokenOrPhrase(rawClause)
  if (direct !== 'other') return direct

  // Fallback for space-separated multi-word clauses such as "ok go ahead" or "yes start".
  const words = rawClause.trim().split(/\s+/).filter(Boolean)
  if (words.length <= 1) return 'other'

  let sawApprove = false
  let sawCancel = false
  for (const word of words) {
    const kind = classifySingleTokenOrPhrase(word)
    if (kind === 'other') return 'other'
    if (kind === 'approve') sawApprove = true
    if (kind === 'cancel') sawCancel = true
  }
  if (sawApprove && sawCancel) return 'other'
  if (sawCancel) return 'cancel'
  if (sawApprove) return 'approve'
  return 'polite'
}

/**
 * Classify a short user reply during plan review as approval, cancellation, or
 * a revision/clarification instruction. Defaults to `'revise'` whenever any
 * adversative/edit qualifier appears or when intent is ambiguous.
 */
export function classifyButlerPlanReplyIntent(text: string): 'approve' | 'cancel' | 'revise' {
  const trimmed = text.trim()
  if (!trimmed) return 'revise'

  const stripped = trimmed
    .replace(/^[\s\u3000.,!?;:~'"`()（）【】「」『』、。，！？；：…—-]+/, '')
    .replace(/[\s\u3000.,!?;:~'"`()（）【】「」『』、。，！？；：…—-]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!stripped) return 'revise'

  if (PLAN_REVISE_CN_RE.test(stripped) || PLAN_REVISE_EN_RE.test(stripped)) {
    return 'revise'
  }

  if (trimmed.length > 36) {
    return 'revise'
  }

  const clauses = stripped
    .split(/[,，、;；.。!！~]+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
  if (clauses.length === 0) return 'revise'

  let sawApprove = false
  let sawCancel = false
  for (const clause of clauses) {
    const kind = classifyPlanClause(clause)
    if (kind === 'other') return 'revise'
    if (kind === 'approve') sawApprove = true
    if (kind === 'cancel') sawCancel = true
  }

  if (sawCancel && !sawApprove) return 'cancel'
  if (sawApprove && !sawCancel) return 'approve'
  return 'revise'
}
