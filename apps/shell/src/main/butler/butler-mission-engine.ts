import { randomBytes } from 'node:crypto'
import { stat } from 'node:fs/promises'

import type { ButlerStep } from '../../shared/butler-api'
import {
  BUTLER_CHIEF_PROJECT_ID,
  BUTLER_CHIEF_SESSION_KEY,
  BUTLER_WORKER_CHAT_PREFIX,
  classifyButlerPlanReplyIntent,
  evaluateWorkerHealth,
  extractWorkerProgressNote,
  inferButlerWorkerRole,
  isButlerWorkerSession,
  redactTelemetrySecrets,
  summarizeWorkerToolCall,
  type ButlerActionResult,
  type ButlerApproveMissionPlanRequest,
  type ButlerArtifactRef,
  type ButlerConversationEntry,
  type ButlerDecisionItem,
  type ButlerDecisionOption,
  type ButlerDecisionResolution,
  type ButlerDelegateResult,
  type ButlerDeskSnapshot,
  type ButlerDesktopActionRequest,
  type ButlerDesktopActionResult,
  type ButlerDesktopActionTarget,
  type ButlerDesktopTodoRequest,
  type ButlerDesktopTodoResult,
  type ButlerMission,
  type ButlerMissionListFilter,
  type ButlerMissionPlan,
  type ButlerMissionReport,
  type ButlerMissionStatus,
  type ButlerProposedTaskStep,
  type ButlerResolveDecisionRequest,
  type ButlerResolveDecisionResult,
  type ButlerRetryTaskRequest,
  type ButlerSteerTaskRequest,
  type ButlerSubTask,
  type ButlerSubTaskStatus,
  type ButlerWorkerActivityEntry,
  type ButlerWorkerHealth,
  type ButlerWorkerRole,
} from '../../shared/butler-orchestrator-api'
import type { PiAgentConfirmReply, PiAgentConfirmRequest } from '../../shared/pi-agent-api'
import {
  readButlerMissionState,
  writeButlerMissionState,
  type ButlerPersistedMissions,
} from './butler-mission-store'

const DEFAULT_MAX_CONCURRENT = 3
const MAX_TITLE_LEN = 60
const MAX_OUTPUT_SUMMARY_LEN = 800
const MAX_LIVE_STATE_CHARS = 1100
const MAX_ACTIVITY_LOG_ENTRIES = 8
const TELEMETRY_NOTIFY_THROTTLE_MS = 150
const STEER_ABORT_SETTLE_MS = 25

const TERMINAL_MISSION_STATUSES = new Set<ButlerMissionStatus>([
  'done',
  'failed',
  'cancelled',
  'interrupted',
])

const TERMINAL_TASK_STATUSES = new Set<ButlerSubTaskStatus>([
  'done',
  'failed',
  'cancelled',
  'interrupted',
])

const FAILURE_TASK_STATUSES = new Set<ButlerSubTaskStatus>(['failed', 'cancelled', 'interrupted'])

export interface ButlerMissionEngineDeps {
  readonly statePath: string
  readonly maxConcurrent?: number
  readonly defaultWorkdir?: () => string
  readonly runPrompt: (
    sessionKey: string,
    prompt: string,
    opts?: {
      readonly workdir?: string
      readonly source?: 'butler'
      readonly modelId?: string
    },
  ) => Promise<{
    readonly ok: boolean
    readonly runId?: string
    readonly finalText?: string
    readonly error?: string
    readonly aborted?: boolean
  }>
  readonly abortSession: (sessionKey: string) => Promise<void>
  readonly resolvePermissionConfirm?: (
    confirmRequestId: string,
    reply: PiAgentConfirmReply,
  ) => Promise<boolean>
  readonly pathExists?: (filePath: string) => Promise<boolean>
  readonly onSnapshotUpdated?: (snapshot: ButlerDeskSnapshot) => void
  readonly onMissionAccepted?: (mission: ButlerMission) => void
  readonly onMissionPlanned?: (
    mission: ButlerMission,
    tasks: readonly ButlerSubTask[],
    chiefReplyText?: string,
  ) => void
  readonly onPlanProposed?: (
    mission: ButlerMission,
    plan: ButlerMissionPlan,
    chiefReplyText?: string,
  ) => void
  readonly onClarificationAsked?: (mission: ButlerMission, replyText: string) => void
  readonly onDecisionCreated?: (decision: ButlerDecisionItem, task: ButlerSubTask | null) => void
  readonly onMissionCompleted?: (mission: ButlerMission, report: ButlerMissionReport) => void
  readonly onConversationalReply?: (replyText: string, mission?: ButlerMission) => void
  readonly executeDesktopAction?: (
    req: ButlerDesktopActionRequest,
  ) => Promise<ButlerDesktopActionResult>
  readonly manageDesktopTodos?: (req: ButlerDesktopTodoRequest) => Promise<ButlerDesktopTodoResult>
  readonly requirePlanApproval?: () => boolean
  readonly conversationalMode?: () => boolean
  readonly now?: () => number
}

export interface ButlerPlanStepInput {
  readonly id?: string
  readonly title: string
  readonly brief: string
  readonly role?: ButlerWorkerRole
  readonly dependsOn?: readonly string[]
  readonly scopePaths?: readonly string[]
}

export type ButlerWorkerObservedEvent =
  | {
      readonly type: 'tool-start'
      readonly toolName: string
      readonly input?: Record<string, unknown> | null
      readonly kind?: ButlerStep['kind']
    }
  | {
      readonly type: 'tool-executed'
      readonly toolName: string
      readonly isError?: boolean
      readonly summary?: string
    }
  | {
      readonly type: 'text'
      readonly text: string
    }
  | {
      readonly type: 'reasoning'
    }

export interface ButlerMissionEngine {
  init(): Promise<ButlerDeskSnapshot>
  dispose(): Promise<void>
  getSnapshot(): ButlerDeskSnapshot
  delegate(goal: string, workdir?: string): Promise<ButlerDelegateResult>
  proposePlan(input: {
    readonly missionId?: string
    readonly title?: string
    readonly summary: string
    readonly steps: readonly ButlerPlanStepInput[]
  }): Promise<{
    readonly ok: boolean
    readonly plan?: ButlerMissionPlan
    readonly mission?: ButlerMission
    readonly error?: string
  }>
  approveMissionPlan(req: ButlerApproveMissionPlanRequest): Promise<ButlerActionResult>
  dispatchTask(input: {
    readonly id?: string
    readonly missionId?: string
    readonly title: string
    readonly brief: string
    readonly role?: ButlerWorkerRole
    readonly dependsOn?: readonly string[]
    readonly scopePaths?: readonly string[]
    readonly workdir?: string
  }): Promise<{
    readonly ok: boolean
    readonly task?: ButlerSubTask
    readonly stagedForApproval?: boolean
    readonly note?: string
    readonly error?: string
  }>
  listMissions(filter?: ButlerMissionListFilter): readonly ButlerMission[]
  listTasks(missionId?: string): readonly ButlerSubTask[]
  inspectTask(
    taskId: string,
  ): { readonly task: ButlerSubTask; readonly decisions: readonly ButlerDecisionItem[] } | null
  updateMissionDetails(input: {
    readonly missionId: string
    readonly title?: string
    readonly goal?: string
    readonly summary?: string
    readonly steps?: readonly ButlerPlanStepInput[]
  }): Promise<{
    readonly ok: boolean
    readonly mission?: ButlerMission
    readonly error?: string
  }>
  steerTask(req: ButlerSteerTaskRequest): Promise<ButlerActionResult>
  retryTask(req: ButlerRetryTaskRequest): Promise<ButlerActionResult>
  cancelTask(taskId: string): Promise<ButlerActionResult>
  cancelMission(missionId: string): Promise<ButlerActionResult>
  deleteMission(missionId: string): Promise<ButlerActionResult>
  executeDesktopAction(req: ButlerDesktopActionRequest): Promise<ButlerDesktopActionResult>
  manageDesktopTodos(req: ButlerDesktopTodoRequest): Promise<ButlerDesktopTodoResult>
  interceptWorkerConfirm(req: PiAgentConfirmRequest): Promise<PiAgentConfirmReply | null>
  requestWorkerChoice(
    sessionKey: string,
    input: {
      readonly title: string
      readonly summary: string
      readonly detail?: string
      readonly options: readonly ButlerDecisionOption[]
    },
  ): Promise<ButlerDecisionResolution>
  requestChiefDecision(input: {
    readonly missionId?: string
    readonly taskId?: string
    readonly title: string
    readonly summary: string
    readonly detail?: string
    readonly options: readonly ButlerDecisionOption[]
  }): Promise<ButlerDecisionResolution>
  resolveDecision(req: ButlerResolveDecisionRequest): Promise<ButlerResolveDecisionResult>
  publishReport(input: {
    readonly missionId?: string
    readonly headline: string
    readonly summary: string
    readonly artifactPaths?: readonly { readonly path: string; readonly label?: string }[]
    readonly risks?: readonly string[]
    readonly nextSuggestion?: string
  }): Promise<{
    readonly ok: boolean
    readonly report?: ButlerMissionReport
    readonly error?: string
  }>
  recordWorkerStep(sessionKey: string, step: ButlerStep | null, progressNote?: string): void
  recordWorkerEvent(sessionKey: string, event: ButlerWorkerObservedEvent): void
  recoverWorkerRoleForSession(sessionKey: string): ButlerWorkerRole | null
  whenIdle(): Promise<void>
}

interface ActiveWorkerRun {
  readonly tokenId: symbol
  readonly taskId: string
  readonly sessionKey: string
  opId?: symbol
  superseded: boolean
  steered: boolean
  readonly settled: Promise<void>
  resolveSettled: () => void
}

interface PendingDecisionWaiter {
  readonly decisionId: string
  readonly resolve: (resolution: ButlerDecisionResolution) => void
}

async function defaultPathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

function fileLabel(filePath: string): string {
  const parts = filePath.split(/[\\/]+/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1]! : filePath
}

function deriveTitle(text: string, fallback: string): string {
  const firstLine = text.trim().split(/\r?\n/)[0]?.replace(/\s+/g, ' ').trim() ?? ''
  if (!firstLine) return fallback
  return firstLine.length <= MAX_TITLE_LEN ? firstLine : `${firstLine.slice(0, MAX_TITLE_LEN - 1)}…`
}

function extractOutputSummary(finalText?: string): string {
  const trimmed = finalText?.trim() ?? ''
  if (!trimmed) return ''
  return trimmed.length <= MAX_OUTPUT_SUMMARY_LEN
    ? trimmed
    : `${trimmed.slice(0, MAX_OUTPUT_SUMMARY_LEN - 1)}…`
}

function extractCandidateArtifactPaths(text: string): readonly string[] {
  if (!text.trim()) return []
  const withoutUrls = text.replace(/https?:\/\/[^\s"'`<>()[\]]+/gi, ' ')
  const backtickRegex =
    /`((?:[A-Za-z]:[\\/]|(?:\.{1,2}[\\/]|\/)|(?:[\w.-]+[\\/]))[^`\r\n]+?\.[A-Za-z0-9]{1,10})`/g
  const patterns = [
    /[A-Za-z]:[\\/][^\s"'`<>|*?()[\],;，。！？]+?\.[A-Za-z0-9]{1,10}(?=[\s"'`<>|*?()[\],;，。！？]|$)/g,
    /(?<![\w/\\])(?:\.{1,2}[\\/]|\/)(?:[^\s"'`<>|*?()[\],;，。！？]+[\\/])*[^\s"'`<>|*?()[\],;，。！？]+\.[A-Za-z0-9]{1,10}(?=[\s"'`<>|*?()[\],;，。！？]|$)/g,
    /(?<![\w:/\\.-])(?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z0-9]{1,10}(?=[\s"'`<>|*?()[\],;，。！？]|$)/g,
  ]

  const seen = new Set<string>()
  const results: string[] = []
  for (const match of withoutUrls.matchAll(backtickRegex)) {
    const candidate = match[1]!.trim()
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)
    results.push(candidate)
  }
  for (const regex of patterns) {
    for (const match of withoutUrls.matchAll(regex)) {
      const candidate = match[0].trim()
      if (!candidate || seen.has(candidate)) continue
      seen.add(candidate)
      results.push(candidate)
    }
  }
  return results
}

/** Detect cycles in a task dependency adjacency map (`taskId -> dependsOn`) using 3-color DFS. */
export function hasCycleInDependencyGraph(
  adjacency: ReadonlyMap<string, readonly string[]>,
): boolean {
  // Three-color DFS: 0 = unvisited, 1 = visiting, 2 = visited
  const state = new Map<string, 0 | 1 | 2>()

  const dfs = (nodeId: string): boolean => {
    const cur = state.get(nodeId) ?? 0
    if (cur === 1) return true
    if (cur === 2) return false
    state.set(nodeId, 1)
    const deps = adjacency.get(nodeId) ?? []
    for (const depId of deps) {
      if (!adjacency.has(depId)) continue
      if (dfs(depId)) return true
    }
    state.set(nodeId, 2)
    return false
  }

  for (const nodeId of adjacency.keys()) {
    if ((state.get(nodeId) ?? 0) === 0 && dfs(nodeId)) {
      return true
    }
  }
  return false
}

function cloneArtifact(ref: ButlerArtifactRef): ButlerArtifactRef {
  return { ...ref }
}

function cloneReport(report: ButlerMissionReport): ButlerMissionReport {
  return {
    ...report,
    artifacts: report.artifacts.map(cloneArtifact),
    risks: [...report.risks],
  }
}

function cloneProposedStep(step: ButlerProposedTaskStep): ButlerProposedTaskStep {
  return {
    ...step,
    dependsOn: [...step.dependsOn],
    ...(step.scopePaths ? { scopePaths: [...step.scopePaths] } : {}),
  }
}

function clonePlan(plan: ButlerMissionPlan): ButlerMissionPlan {
  return {
    ...plan,
    steps: plan.steps.map(cloneProposedStep),
  }
}

function cloneMission(m: ButlerMission): ButlerMission {
  return {
    ...m,
    taskIds: [...m.taskIds],
    ...(m.conversationNotes ? { conversationNotes: [...m.conversationNotes] } : {}),
    ...(m.plan ? { plan: clonePlan(m.plan) } : {}),
    ...(m.report ? { report: cloneReport(m.report) } : {}),
  }
}

const CLARIFYING_CN_RE = /(?:请问|哪|什么|哪种|哪个|如何|是否需要|补充|确认一下|告诉我)/
const CLARIFYING_EN_RE =
  /\b(?:please clarify|could you clarify|which|what|where|how would you|let me know)\b/i

function isClarifyingQuestion(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  return /[?？]/.test(trimmed) || CLARIFYING_CN_RE.test(trimmed) || CLARIFYING_EN_RE.test(trimmed)
}

function cloneTask(t: ButlerSubTask): ButlerSubTask {
  return {
    ...t,
    dependsOn: [...t.dependsOn],
    ...(t.scopePaths ? { scopePaths: [...t.scopePaths] } : {}),
    step: t.step ? { ...t.step } : null,
    artifacts: t.artifacts.map(cloneArtifact),
    ...(t.activityLog
      ? { activityLog: t.activityLog.map((entry) => ({ ...entry })) }
      : {}),
  }
}

function inferStepKindFallback(toolName: string): ButlerStep['kind'] {
  const lower = toolName.trim().toLowerCase()
  if (lower.includes('read') || lower === 'ls') return 'read'
  if (lower.includes('search') || lower.includes('find') || lower.includes('grep')) return 'search'
  if (lower.startsWith('browser')) return 'browse'
  if (lower.includes('write') || lower.includes('create')) return 'create'
  if (lower.includes('edit')) return 'edit'
  if (
    lower === 'bash' ||
    lower === 'powershell' ||
    lower === 'pwsh' ||
    lower === 'exec' ||
    lower.includes('command')
  ) {
    return 'command'
  }
  if (lower === 'thinking') return 'think'
  return 'other'
}

function cloneDecision(d: ButlerDecisionItem): ButlerDecisionItem {
  return {
    ...d,
    options: d.options.map((o) => ({ ...o })),
    ...(d.resolution ? { resolution: { ...d.resolution } } : {}),
  }
}

function cloneFeedEntry(e: ButlerConversationEntry): ButlerConversationEntry {
  return {
    ...e,
    ...(e.report ? { report: cloneReport(e.report) } : {}),
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Create the Chief-of-Staff Butler mission orchestrator engine: manages Chief
 * planning/synthesis turns, DAG worker scheduling with bounded concurrency,
 * unified HITL confirm/choice gating, and crash-safe atomic persistence.
 */
export function createButlerMissionEngine(deps: ButlerMissionEngineDeps): ButlerMissionEngine {
  const maxConcurrent = Math.max(1, deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT)
  const nowFn = deps.now ?? (() => Date.now())
  const checkPathExists = deps.pathExists ?? defaultPathExists

  let missions: ButlerMission[] = []
  let tasks: ButlerSubTask[] = []
  let decisions: ButlerDecisionItem[] = []
  let feed: ButlerConversationEntry[] = []

  const missionWorkdirById = new Map<string, string | undefined>()
  const taskWorkdirById = new Map<string, string | undefined>()
  const steerNotesByTaskId = new Map<string, string[]>()
  const taskStepStartedAt = new Map<string, number>()
  const planningMissions = new Set<string>()
  const synthesizingMissions = new Set<string>()
  const activeWorkers = new Map<string, ActiveWorkerRun>()
  const pendingWaiters = new Map<string, PendingDecisionWaiter>()
  const trackedBackgroundOps = new Map<symbol, Promise<void>>()

  let telemetryNotifyTimer: ReturnType<typeof setTimeout> | null = null
  let telemetryLastNotifiedAt = 0
  let chiefBusy = false
  let chiefPendingCount = 0
  let chiefGeneration = 0
  let inConversationalTurn = false
  let pendingTurnPlannedMissionId: string | null = null
  let pendingTurnPlannedTasks: ButlerSubTask[] = []
  let lastConversationalUserText = ''
  let lastConversationalWorkdir: string | undefined
  let currentChiefMissionId: string | null = null
  let chiefChain: Promise<void> = Promise.resolve()
  let persistChain: Promise<void> = Promise.resolve()
  let disposed = false
  let disposePromise: Promise<void> | null = null

  const usedIds = new Set<string>()
  const newId = (prefix: string): string => {
    let candidate = ''
    do {
      candidate = `${prefix}-${randomBytes(4).toString('hex')}`
    } while (usedIds.has(candidate))
    usedIds.add(candidate)
    return candidate
  }

  const getMissionIndex = (id: string): number => missions.findIndex((m) => m.id === id)
  const getTaskIndex = (id: string): number => tasks.findIndex((t) => t.id === id)
  const getDecisionIndex = (id: string): number => decisions.findIndex((d) => d.id === id)

  const findLatestNonTerminalMission = (): ButlerMission | undefined => {
    for (let i = missions.length - 1; i >= 0; i -= 1) {
      const m = missions[i]!
      if (!TERMINAL_MISSION_STATUSES.has(m.status)) return m
    }
    return undefined
  }

  const findActiveDraftMission = (): ButlerMission | undefined => {
    for (let i = missions.length - 1; i >= 0; i -= 1) {
      const m = missions[i]!
      if (m.status === 'clarifying' || m.status === 'awaiting_plan_approval') return m
    }
    return undefined
  }

  const resolveTargetMission = (
    rawMissionId: string,
    mode: 'draft' | 'nonTerminal' | 'any' = 'any',
  ): ButlerMission | undefined => {
    const cleanId = rawMissionId.trim()
    if (!cleanId) return undefined
    if (cleanId === 'latest') {
      if (mode === 'draft') {
        for (let i = missions.length - 1; i >= 0; i -= 1) {
          if (missions[i]!.status === 'awaiting_plan_approval') return missions[i]
        }
        return findActiveDraftMission() ?? findLatestNonTerminalMission()
      }
      if (mode === 'nonTerminal') {
        return findLatestNonTerminalMission()
      }
      return findLatestNonTerminalMission() ?? missions[missions.length - 1]
    }
    return missions.find((m) => m.id === cleanId)
  }

  const validateAndNormalizePlanSteps = (
    rawSteps: readonly ButlerPlanStepInput[] | undefined,
  ):
    | { readonly ok: true; readonly steps: ButlerProposedTaskStep[] }
    | { readonly ok: false; readonly error: string } => {
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
      return { ok: false, error: 'Plan must contain at least 1 step' }
    }

    const assignedIds: string[] = []
    const seenStepIds = new Set<string>()
    let autoIndex = 1
    for (const rawStep of rawSteps) {
      const title = rawStep.title?.trim() ?? ''
      const brief = rawStep.brief?.trim() ?? ''
      if (!title || !brief) {
        return { ok: false, error: 'Each plan step requires non-empty title and brief' }
      }
      let stepId = rawStep.id?.trim() ?? ''
      if (stepId) {
        if (seenStepIds.has(stepId)) {
          return { ok: false, error: `Duplicate step id in plan: ${stepId}` }
        }
      } else {
        do {
          stepId = `step-${autoIndex}`
          autoIndex += 1
        } while (seenStepIds.has(stepId))
      }
      seenStepIds.add(stepId)
      assignedIds.push(stepId)
    }

    const normalizedSteps: ButlerProposedTaskStep[] = []
    const adjacency = new Map<string, readonly string[]>()
    for (let i = 0; i < rawSteps.length; i += 1) {
      const rawStep = rawSteps[i]!
      const stepId = assignedIds[i]!
      const dependsOn = Array.from(
        new Set<string>(
          (rawStep.dependsOn ?? []).map((id: string) => id.trim()).filter(Boolean),
        ),
      )
      if (dependsOn.includes(stepId)) {
        return { ok: false, error: 'Cyclic task dependency detected in plan' }
      }
      for (const depId of dependsOn) {
        if (!seenStepIds.has(depId)) {
          return { ok: false, error: `Unknown dependency step in plan: ${depId}` }
        }
      }
      const scopePaths = rawStep.scopePaths?.map((p: string) => p.trim()).filter(Boolean)
      const cleanTitle = rawStep.title.trim()
      const cleanBrief = rawStep.brief.trim()
      normalizedSteps.push({
        id: stepId,
        title: cleanTitle,
        brief: cleanBrief,
        role: inferButlerWorkerRole({ role: rawStep.role, title: cleanTitle, brief: cleanBrief }),
        dependsOn,
        ...(scopePaths && scopePaths.length > 0 ? { scopePaths } : {}),
      })
      adjacency.set(stepId, dependsOn)
    }

    if (hasCycleInDependencyGraph(adjacency)) {
      return { ok: false, error: 'Cyclic task dependency detected in plan' }
    }

    return { ok: true, steps: normalizedSteps }
  }

  const reactivateMissionForTask = (missionId: string, includeCancelled = false): void => {
    const mission = missions.find((m) => m.id === missionId)
    if (
      mission &&
      (mission.status === 'failed' ||
        mission.status === 'interrupted' ||
        mission.status === 'done' ||
        (includeCancelled && mission.status === 'cancelled'))
    ) {
      updateMission(mission.id, (prev) => ({
        ...prev,
        status: 'running',
        error: undefined,
        finishedAt: undefined,
        report: undefined,
        updatedAt: nowFn(),
      }))
      return
    }
    syncMissionStatus(missionId)
  }

  const stopMissionExecution = async (
    missionId: string,
    opts: { readonly markTasksCancelled: boolean; readonly waiterNote: string },
  ): Promise<void> => {
    const ts = nowFn()
    const sessionsToAbort: string[] = []

    for (let i = 0; i < tasks.length; i += 1) {
      const t = tasks[i]!
      if (t.missionId !== missionId || TERMINAL_TASK_STATUSES.has(t.status)) continue

      const activeRun = activeWorkers.get(t.id)
      if (activeRun) {
        activeRun.superseded = true
        if (activeRun.opId) untrackBackgroundOp(activeRun.opId)
        activeWorkers.delete(t.id)
        activeRun.resolveSettled()
      }

      if (t.status === 'running' || t.status === 'waiting_human') {
        sessionsToAbort.push(t.sessionKey)
      }

      taskStepStartedAt.delete(t.id)
      if (opts.markTasksCancelled) {
        tasks[i] = {
          ...t,
          status: 'cancelled',
          step: null,
          health: 'normal',
          finishedAt: ts,
        }
      }
    }

    resolvePendingWaitersFor((d) => d.missionId === missionId, 'cancelled', opts.waiterNote)

    if (currentChiefMissionId === missionId) {
      sessionsToAbort.push(BUTLER_CHIEF_SESSION_KEY)
    }

    for (const sk of sessionsToAbort) {
      await Promise.resolve(deps.abortSession(sk)).catch(() => {})
    }
  }

  const hydrateTaskWithLiveHealth = (t: ButlerSubTask, now: number): ButlerSubTask => {
    const cloned = cloneTask(t)
    if (cloned.status !== 'running') return cloned
    const liveHealth = evaluateWorkerHealth({
      status: cloned.status,
      startedAt: cloned.startedAt,
      stepStartedAt: taskStepStartedAt.get(cloned.id) ?? cloned.lastActiveAt ?? cloned.startedAt,
      consecutiveErrors: cloned.consecutiveErrors,
      now,
    })
    return { ...cloned, health: liveHealth }
  }

  const buildButlerLiveStateBlock = (): string => {
    const now = nowFn()
    const gateOn = deps.requirePlanApproval?.() === true
    const activeMissions = missions.filter((m) => !TERMINAL_MISSION_STATUSES.has(m.status))
    const pendingDecs = decisions.filter((d) => d.status === 'pending')
    const lines: string[] = [
      `approvalGate=${gateOn ? 'on' : 'off'}; activeMissions=${activeMissions.length}; pendingDecisions=${pendingDecs.length}`,
    ]

    const listedMissions =
      activeMissions.length > 0 ? activeMissions.slice(-4) : missions.slice(-2)
    for (const m of listedMissions) {
      const planTag = m.plan
        ? ` planRev=${m.plan.revision} steps=${m.plan.steps.length}${m.plan.approvedAt ? '(approved)' : '(pending)'}`
        : ''
      lines.push(
        `M ${m.id} [${m.status}] "${m.title.slice(0, 32)}" tasks=${m.taskIds.length}${planTag}`,
      )
    }

    const relevantTasks = tasks
      .filter((t) => t.status !== 'done')
      .slice(-5)
    for (const rawTask of relevantTasks) {
      const t = hydrateTaskWithLiveHealth(rawTask, now)
      const elapsedSec =
        t.startedAt !== undefined ? Math.max(0, Math.floor((now - t.startedAt) / 1000)) : 0
      const latestLogSummary =
        t.activityLog && t.activityLog.length > 0
          ? t.activityLog[t.activityLog.length - 1]!.summary
          : ''
      const rawAction = t.progressNote?.trim() || latestLogSummary || t.step?.tool || ''
      const latestAction = rawAction.length > 64 ? `${rawAction.slice(0, 63).trimEnd()}…` : rawAction
      const actionSuffix = latestAction ? ` -> ${latestAction}` : ''
      const statusTag = `${t.status}|${t.role}|step=${t.stepCount ?? 0}|${elapsedSec}s|${t.health ?? 'normal'}`
      lines.push(
        `T ${t.id} [${statusTag}] "${t.title.slice(0, 28)}"${actionSuffix} (m=${t.missionId})`,
      )
    }

    for (const d of pendingDecs.slice(-3)) {
      lines.push(`D ${d.id} "${d.title.slice(0, 28)}" (m=${d.missionId})`)
    }

    let body = lines.join('\n')
    const maxBodyLen = MAX_LIVE_STATE_CHARS - '<butler_live_state>\n\n</butler_live_state>'.length
    if (body.length > maxBodyLen) {
      body = `${body.slice(0, Math.max(0, maxBodyLen - 20)).trimEnd()}\n...`
    }
    return `<butler_live_state>\n${body}\n</butler_live_state>`
  }

  const buildConversationalPrompt = (userText: string, workdir: string | undefined): string => {
    const parts = [buildButlerLiveStateBlock()]
    if (workdir) parts.push(`Working Directory: ${workdir}`)
    parts.push(`User: ${userText}`)
    return parts.join('\n')
  }

  const findTaskBySession = (sessionKey: string): ButlerSubTask | undefined => {
    for (let i = tasks.length - 1; i >= 0; i -= 1) {
      const t = tasks[i]!
      if (t.sessionKey === sessionKey) return t
    }
    return undefined
  }

  const buildSnapshot = (): ButlerDeskSnapshot => {
    const now = nowFn()
    return {
      chiefSessionKey: BUTLER_CHIEF_SESSION_KEY,
      chiefBusy,
      missions: missions.map(cloneMission),
      tasks: tasks.map((t) => hydrateTaskWithLiveHealth(t, now)),
      decisions: decisions.map(cloneDecision),
      feed: feed.map(cloneFeedEntry),
      concurrency: {
        running: tasks.filter((t) => t.status === 'running').length,
        maxConcurrent,
        queued: tasks.filter((t) => t.status === 'queued').length,
      },
    }
  }

  const clearTelemetryNotifyTimer = (): void => {
    if (telemetryNotifyTimer !== null) {
      clearTimeout(telemetryNotifyTimer)
      telemetryNotifyTimer = null
    }
  }

  const notifySnapshot = (): void => {
    if (disposed) return
    telemetryLastNotifiedAt = Date.now()
    deps.onSnapshotUpdated?.(buildSnapshot())
  }

  const scheduleThrottledNotifySnapshot = (): void => {
    if (disposed) return
    const now = Date.now()
    const elapsed = now - telemetryLastNotifiedAt
    if (elapsed >= TELEMETRY_NOTIFY_THROTTLE_MS && telemetryNotifyTimer === null) {
      notifySnapshot()
      return
    }
    if (telemetryNotifyTimer !== null) return
    const waitMs = Math.max(10, TELEMETRY_NOTIFY_THROTTLE_MS - Math.max(0, elapsed))
    telemetryNotifyTimer = setTimeout(() => {
      telemetryNotifyTimer = null
      notifySnapshot()
    }, waitMs)
    telemetryNotifyTimer.unref?.()
  }

  const buildPersistedPayload = (): ButlerPersistedMissions => ({
    version: 1,
    missions: missions.map(cloneMission),
    tasks: tasks.map(cloneTask),
    decisions: decisions.map(cloneDecision),
    feed: feed.map(cloneFeedEntry),
    updatedAt: nowFn(),
  })

  const enqueuePersist = (): Promise<void> => {
    const payload = buildPersistedPayload()
    persistChain = persistChain
      .then(() => writeButlerMissionState(deps.statePath, payload))
      .catch(() => {
        // Persistence failures must not break in-memory scheduling or HITL resolution.
      })
    return persistChain
  }

  const commitState = (): void => {
    clearTelemetryNotifyTimer()
    void enqueuePersist()
    notifySnapshot()
  }

  const trackBackgroundOp = (opPromise: Promise<void>): symbol => {
    const opId = Symbol('butler-op')
    const safePromise = opPromise
      .catch(() => {})
      .finally(() => {
        trackedBackgroundOps.delete(opId)
      })
    trackedBackgroundOps.set(opId, safePromise)
    return opId
  }

  const untrackBackgroundOp = (opId: symbol): void => {
    trackedBackgroundOps.delete(opId)
  }

  const resolveWorkdirForMission = (missionId: string): string | undefined => {
    return missionWorkdirById.get(missionId) ?? deps.defaultWorkdir?.()
  }

  const resolveWorkdirForTask = (task: ButlerSubTask): string | undefined => {
    return taskWorkdirById.get(task.id) ?? resolveWorkdirForMission(task.missionId)
  }

  const updateMission = (
    missionId: string,
    updater: (prev: ButlerMission) => ButlerMission,
  ): ButlerMission | undefined => {
    const idx = getMissionIndex(missionId)
    if (idx < 0) return undefined
    const next = updater(missions[idx]!)
    missions[idx] = next
    return next
  }

  const updateTask = (
    taskId: string,
    updater: (prev: ButlerSubTask) => ButlerSubTask,
  ): ButlerSubTask | undefined => {
    const idx = getTaskIndex(taskId)
    if (idx < 0) return undefined
    const next = updater(tasks[idx]!)
    tasks[idx] = next
    return next
  }

  const updateDecision = (
    decisionId: string,
    updater: (prev: ButlerDecisionItem) => ButlerDecisionItem,
  ): ButlerDecisionItem | undefined => {
    const idx = getDecisionIndex(decisionId)
    if (idx < 0) return undefined
    const next = updater(decisions[idx]!)
    decisions[idx] = next
    return next
  }

  const syncMissionStatus = (missionId: string): void => {
    const mIdx = getMissionIndex(missionId)
    if (mIdx < 0) return
    const mission = missions[mIdx]!
    if (TERMINAL_MISSION_STATUSES.has(mission.status) || mission.status === 'synthesizing') {
      return
    }

    const missionTasks = tasks.filter((t) => t.missionId === missionId)
    const hasPendingDecision = decisions.some(
      (d) => d.missionId === missionId && d.status === 'pending',
    )
    const hasWaitingTask = missionTasks.some((t) => t.status === 'waiting_human')

    let nextStatus: ButlerMissionStatus = mission.status
    if (hasPendingDecision || hasWaitingTask) {
      nextStatus = 'waiting_human'
    } else if (planningMissions.has(missionId)) {
      nextStatus = 'planning'
    } else if (missionTasks.some((t) => t.status === 'running' || t.status === 'queued')) {
      nextStatus = 'running'
    } else if (
      missionTasks.length === 0 &&
      mission.plan &&
      mission.plan.approvedAt === undefined
    ) {
      nextStatus = 'awaiting_plan_approval'
    }

    if (nextStatus !== mission.status) {
      missions[mIdx] = {
        ...mission,
        status: nextStatus,
        updatedAt: nowFn(),
      }
    }
  }

  const appendFeedEntry = (
    entry: Omit<ButlerConversationEntry, 'id' | 'createdAt'> & { readonly createdAt?: number },
  ): ButlerConversationEntry => {
    const created: ButlerConversationEntry = {
      id: newId('entry'),
      role: entry.role,
      text: entry.text,
      ...(entry.missionId ? { missionId: entry.missionId } : {}),
      ...(entry.report ? { report: cloneReport(entry.report) } : {}),
      ...(entry.decisionId ? { decisionId: entry.decisionId } : {}),
      createdAt: entry.createdAt ?? nowFn(),
    }
    feed.push(created)
    return created
  }

  const resolvePendingWaitersFor = (
    predicate: (d: ButlerDecisionItem) => boolean,
    nextStatus: 'cancelled' | 'expired',
    note: string,
  ): boolean => {
    let changed = false
    const ts = nowFn()
    for (let i = 0; i < decisions.length; i += 1) {
      const d = decisions[i]!
      if (d.status !== 'pending' || !predicate(d)) continue
      decisions[i] = {
        ...d,
        status: nextStatus,
      }
      changed = true
      const waiter = pendingWaiters.get(d.id)
      if (waiter) {
        pendingWaiters.delete(d.id)
        waiter.resolve({
          optionId: nextStatus === 'cancelled' ? 'cancelled' : 'expired',
          note,
          resolvedAt: ts,
        })
      }
    }
    return changed
  }

  const enqueueChiefOp = (missionId: string, fn: () => Promise<void>): void => {
    chiefPendingCount += 1
    const runOp = async (): Promise<void> => {
      if (disposed) return
      chiefBusy = true
      currentChiefMissionId = missionId
      notifySnapshot()
      try {
        await fn()
      } finally {
        currentChiefMissionId = null
        chiefPendingCount = Math.max(0, chiefPendingCount - 1)
        chiefBusy = chiefPendingCount > 0
        notifySnapshot()
      }
    }

    const chained = chiefChain.then(runOp, runOp)
    chiefChain = chained
    trackBackgroundOp(chained)
  }

  const buildPlanningPrompt = (
    missionId: string,
    goal: string,
    workdir: string | undefined,
  ): string => {
    const lines = [
      `Mission ID: ${missionId}`,
      `Goal: ${goal}`,
      ...(workdir ? [`Working Directory: ${workdir}`] : []),
      '',
      'Instructions for Chief Butler:',
      '- For multi-step or parallelizable work, decompose into subtasks by calling `butler_dispatch_task` (with `missionId`, `title`, `brief`, optional `role`, `dependsOn`, `scopePaths`).',
      '- If human judgment is needed on ambiguity before proceeding, call `butler_request_decision`.',
      '- For simple direct answers or single-turn completions, answer concisely or call `butler_publish_report`.',
    ]
    return lines.join('\n')
  }

  const buildTwoStageAlignmentPrompt = (
    mission: ButlerMission,
    workdir: string | undefined,
  ): string => {
    const notes =
      mission.conversationNotes && mission.conversationNotes.length > 0
        ? mission.conversationNotes
        : [mission.goal]
    const lines = [
      `Mission ID: ${mission.id}`,
      `Original Goal: ${mission.goal}`,
      ...(workdir ? [`Working Directory: ${workdir}`] : []),
      '',
      'Conversation History:',
      ...notes.map((entry, idx) => `${idx + 1}. User: ${entry}`),
    ]

    if (mission.plan) {
      lines.push(
        '',
        `Current Draft Plan (revision ${mission.plan.revision}, awaiting user approval):`,
        `Summary: ${mission.plan.summary}`,
        'Steps:',
        ...mission.plan.steps.map(
          (step) =>
            `- [${step.id}] (${step.role}) ${step.title} — ${step.brief}` +
            (step.dependsOn.length > 0 ? ` [dependsOn: ${step.dependsOn.join(', ')}]` : '') +
            (step.scopePaths && step.scopePaths.length > 0
              ? ` [scopePaths: ${step.scopePaths.join(', ')}]`
              : ''),
        ),
      )
    }

    lines.push(
      '',
      'Two-Stage Alignment Instructions for Chief Butler:',
      '- Greetings or simple single-turn questions: reply directly in 1-2 natural declarative sentences without creating a background plan.',
      '- Compound or multi-step goals with missing or ambiguous context: ask 1-2 brief clarifying questions instead of guessing or dispatching tasks prematurely.',
      '- Once requirements are clear (or when revising an existing draft): call `butler_propose_plan` with `missionId`, `summary`, and ordered `steps`, then summarize the draft concisely and ask for confirmation.',
      '- Do NOT call `butler_dispatch_task` before the user approves the plan.',
    )
    return lines.join('\n')
  }

  const buildWorkerPrompt = (task: ButlerSubTask): string => {
    const lines: string[] = [
      `Task ID: ${task.id}`,
      `Mission ID: ${task.missionId}`,
      `Role: ${task.role}`,
      `Title: ${task.title}`,
      '',
      'Brief:',
      task.brief,
    ]

    if (task.scopePaths && task.scopePaths.length > 0) {
      lines.push('', 'Scope Paths:')
      for (const p of task.scopePaths) {
        lines.push(`- ${p}`)
      }
    }

    if (task.dependsOn.length > 0) {
      lines.push('', 'Upstream Completed Dependencies:')
      for (const depId of task.dependsOn) {
        const dep = tasks.find((t) => t.id === depId)
        if (!dep) continue
        lines.push(`- [${dep.id}] ${dep.title} (status: ${dep.status})`)
        if (dep.outputSummary) {
          lines.push(`  Summary: ${dep.outputSummary}`)
        }
        if (dep.artifacts.length > 0) {
          lines.push('  Artifacts:')
          for (const artifact of dep.artifacts) {
            const diskTag = artifact.existsOnDisk ? 'existsOnDisk=true' : 'existsOnDisk=false'
            lines.push(`    * ${artifact.label}: ${artifact.path} (${diskTag})`)
          }
        }
      }
    }

    const steerNotes = steerNotesByTaskId.get(task.id)
    if (steerNotes && steerNotes.length > 0) {
      lines.push('', 'Steering Updates:')
      for (const note of steerNotes) {
        lines.push(`- ${note}`)
      }
    }

    return lines.join('\n')
  }

  const buildSynthesisPrompt = (
    mission: ButlerMission,
    missionTasks: readonly ButlerSubTask[],
  ): string => {
    const workdir = resolveWorkdirForMission(mission.id)
    const lines = [
      `Mission ID: ${mission.id}`,
      `Title: ${mission.title}`,
      `Goal: ${mission.goal}`,
      ...(workdir ? [`Working Directory: ${workdir}`] : []),
      '',
      'Subtask Outcomes:',
    ]

    for (const t of missionTasks) {
      lines.push(`- [${t.id}] ${t.title} | status=${t.status}`)
      if (t.outputSummary) lines.push(`  summary: ${t.outputSummary}`)
      if (t.error) lines.push(`  error: ${t.error}`)
      if (t.artifacts.length > 0) {
        lines.push(
          `  artifacts: ${t.artifacts
            .map((a) => `${a.path} (existsOnDisk=${String(a.existsOnDisk)})`)
            .join(', ')}`,
        )
      }
    }

    lines.push(
      '',
      'Please synthesize the final outcome and call `butler_publish_report` with headline, summary, artifactPaths, risks, and nextSuggestion.',
    )
    return lines.join('\n')
  }

  const buildDeterministicReport = async (
    mission: ButlerMission,
    missionTasks: readonly ButlerSubTask[],
    chiefText?: string,
    chiefError?: string,
  ): Promise<{
    readonly report: ButlerMissionReport
    readonly finalStatus: 'done' | 'failed'
  }> => {
    const doneTasks = missionTasks.filter((t) => t.status === 'done')
    const failedTasks = missionTasks.filter((t) => FAILURE_TASK_STATUSES.has(t.status))

    const artifactMap = new Map<string, ButlerArtifactRef>()
    for (const t of missionTasks) {
      for (const a of t.artifacts) {
        if (!artifactMap.has(a.path)) {
          const verified = await checkPathExists(a.path)
          artifactMap.set(a.path, {
            path: a.path,
            label: a.label,
            existsOnDisk: verified,
          })
        }
      }
    }

    const risks: string[] = []
    for (const t of failedTasks) {
      risks.push(`${t.title} (${t.status}): ${t.error ?? t.status}`)
    }
    if (chiefError) {
      risks.push(`Synthesis note: ${chiefError}`)
    }

    const allFailed = doneTasks.length === 0 && failedTasks.length > 0
    const finalStatus: 'done' | 'failed' = allFailed ? 'failed' : 'done'

    const headline = allFailed
      ? `${mission.title} — Failed`
      : failedTasks.length > 0
        ? `${mission.title} — Completed with issues`
        : `${mission.title} — Completed`

    const taskSummaries = missionTasks.map((t) => {
      const detail = t.outputSummary || t.error || t.status
      return `- ${t.title} (${t.status}): ${detail}`
    })

    const summary = chiefText?.trim()
      ? `${chiefText.trim()}\n\n${taskSummaries.join('\n')}`
      : taskSummaries.join('\n') || mission.goal

    return {
      finalStatus,
      report: {
        headline,
        summary,
        artifacts: [...artifactMap.values()],
        risks,
        generatedAt: nowFn(),
      },
    }
  }

  const maybeTriggerSynthesis = (missionId: string): void => {
    if (disposed) return
    if (planningMissions.has(missionId) || synthesizingMissions.has(missionId)) return

    const mIdx = getMissionIndex(missionId)
    if (mIdx < 0) return
    const mission = missions[mIdx]!
    if (TERMINAL_MISSION_STATUSES.has(mission.status) || mission.status === 'synthesizing') {
      return
    }
    if (mission.report) return
    if (mission.taskIds.length === 0) return

    const missionTasks = mission.taskIds
      .map((id) => tasks.find((t) => t.id === id))
      .filter((t): t is ButlerSubTask => t !== undefined)

    if (missionTasks.length === 0) return
    if (!missionTasks.every((t) => TERMINAL_TASK_STATUSES.has(t.status))) return

    synthesizingMissions.add(missionId)
    missions[mIdx] = {
      ...mission,
      status: 'synthesizing',
      updatedAt: nowFn(),
    }
    commitState()

    enqueueChiefOp(missionId, async () => {
      try {
        const latestMission = missions.find((m) => m.id === missionId)
        if (!latestMission || latestMission.status === 'cancelled' || disposed) return
        if (latestMission.report) return

        const currentTasks = latestMission.taskIds
          .map((id) => tasks.find((t) => t.id === id))
          .filter((t): t is ButlerSubTask => t !== undefined)

        const prompt = buildSynthesisPrompt(latestMission, currentTasks)
        const res = await deps
          .runPrompt(BUTLER_CHIEF_SESSION_KEY, prompt, {
            workdir: resolveWorkdirForMission(missionId),
            source: 'butler',
          })
          .catch((err: unknown) => ({
            ok: false as const,
            error: err instanceof Error ? err.message : String(err ?? 'Synthesis failed'),
          }))

        const postMission = missions.find((m) => m.id === missionId)
        if (!postMission || postMission.status === 'cancelled' || disposed) return
        if (postMission.report) return

        const postTasks = postMission.taskIds
          .map((id) => tasks.find((t) => t.id === id))
          .filter((t): t is ButlerSubTask => t !== undefined)

        const { report, finalStatus } = await buildDeterministicReport(
          postMission,
          postTasks,
          res.ok ? res.finalText : undefined,
          !res.ok ? (res.error ?? 'Chief synthesis failed') : undefined,
        )

        const ts = nowFn()
        const updated = updateMission(missionId, (prev) => ({
          ...prev,
          status: finalStatus,
          report,
          finishedAt: ts,
          updatedAt: ts,
          ...(finalStatus === 'failed' && risksFirstError(report.risks)
            ? { error: risksFirstError(report.risks) }
            : {}),
        }))

        if (updated) {
          appendFeedEntry({
            role: 'butler',
            text: report.summary,
            missionId,
            report,
            createdAt: ts,
          })
          commitState()
          deps.onMissionCompleted?.(cloneMission(updated), cloneReport(report))
        }
      } finally {
        synthesizingMissions.delete(missionId)
      }
    })
  }

  const risksFirstError = (risks: readonly string[]): string | undefined =>
    risks.length > 0 ? risks[0] : undefined

  const cascadeUpstreamFailures = (): boolean => {
    let changed = false
    let progressed = true

    while (progressed) {
      progressed = false
      const adjacency = new Map<string, readonly string[]>()
      for (const t of tasks) {
        adjacency.set(t.id, t.dependsOn)
      }
      const hasAnyCycle = hasCycleInDependencyGraph(adjacency)

      for (let i = 0; i < tasks.length; i += 1) {
        const task = tasks[i]!
        if (task.status !== 'queued') continue

        let failureReason: string | null = null
        for (const depId of task.dependsOn) {
          const dep = tasks.find((t) => t.id === depId)
          if (!dep) {
            failureReason = `Missing upstream task "${depId}"`
            break
          }
          if (FAILURE_TASK_STATUSES.has(dep.status)) {
            failureReason = `Upstream task "${dep.title}" ended as ${dep.status}`
            break
          }
        }

        if (!failureReason && hasAnyCycle) {
          // Only fail tasks actually reachable from a cycle to prevent deadlocks on corrupted disk state.
          const subAdj = new Map<string, readonly string[]>()
          for (const t of tasks) {
            if (t.missionId === task.missionId) subAdj.set(t.id, t.dependsOn)
          }
          if (taskInCycle(task.id, subAdj)) {
            failureReason = 'Cyclic task dependency detected'
          }
        }

        if (failureReason) {
          tasks[i] = {
            ...task,
            status: 'failed',
            step: null,
            error: failureReason,
            finishedAt: nowFn(),
          }
          changed = true
          progressed = true
        }
      }
    }

    return changed
  }

  const taskInCycle = (
    startId: string,
    adjacency: ReadonlyMap<string, readonly string[]>,
  ): boolean => {
    const visited = new Set<string>()
    const stack = [...(adjacency.get(startId) ?? [])]
    while (stack.length > 0) {
      const cur = stack.pop()!
      if (cur === startId) return true
      if (visited.has(cur)) continue
      visited.add(cur)
      for (const next of adjacency.get(cur) ?? []) {
        stack.push(next)
      }
    }
    return false
  }

  const runWorkerTask = (taskSnapshot: ButlerSubTask, runToken: ActiveWorkerRun): void => {
    const opPromise = (async (): Promise<void> => {
      try {
        const promptText = buildWorkerPrompt(taskSnapshot)
        const workdir = resolveWorkdirForTask(taskSnapshot)

        const res = await deps
          .runPrompt(taskSnapshot.sessionKey, promptText, {
            workdir,
            source: 'butler',
          })
          .catch((err: unknown) => ({
            ok: false as const,
            error: err instanceof Error ? err.message : String(err ?? 'Worker execution failed'),
            finalText: undefined,
            aborted: false,
          }))

        if (runToken.superseded || disposed) return

        const currentTask = tasks.find((t) => t.id === taskSnapshot.id)
        const currentMission = missions.find((m) => m.id === taskSnapshot.missionId)
        if (
          !currentTask ||
          !currentMission ||
          currentTask.status === 'cancelled' ||
          currentMission.status === 'cancelled'
        ) {
          return
        }

        // Resolve any leftover pending decision on this worker defensively if run exited abnormally.
        resolvePendingWaitersFor(
          (d) => d.taskId === currentTask.id,
          res.ok ? 'expired' : 'cancelled',
          'Worker exited before decision completed',
        )

        if (res.ok) {
          const finalText = res.finalText ?? ''
          const outputSummary = extractOutputSummary(finalText)
          const candidatePaths = extractCandidateArtifactPaths(finalText)
          const artifacts: ButlerArtifactRef[] = []

          for (const candidatePath of candidatePaths) {
            const existsOnDisk = await checkPathExists(candidatePath)
            artifacts.push({
              path: candidatePath,
              label: fileLabel(candidatePath),
              existsOnDisk,
            })
          }

          if (runToken.superseded || disposed) return
          const latest = tasks.find((t) => t.id === taskSnapshot.id)
          if (!latest || latest.status === 'cancelled') return

          taskStepStartedAt.delete(taskSnapshot.id)
          updateTask(taskSnapshot.id, (prev) => ({
            ...prev,
            status: 'done',
            step: null,
            health: 'normal',
            outputSummary,
            artifacts,
            error: undefined,
            finishedAt: nowFn(),
          }))
        } else {
          taskStepStartedAt.delete(taskSnapshot.id)
          const errorText =
            res.error?.trim() || (res.aborted ? 'Task aborted' : 'Worker execution failed')
          updateTask(taskSnapshot.id, (prev) => ({
            ...prev,
            status: 'failed',
            step: null,
            health: 'normal',
            error: errorText,
            finishedAt: nowFn(),
          }))
        }

        syncMissionStatus(taskSnapshot.missionId)
        commitState()
      } finally {
        const active = activeWorkers.get(taskSnapshot.id)
        if (active?.tokenId === runToken.tokenId) {
          activeWorkers.delete(taskSnapshot.id)
        }
        runToken.resolveSettled()
        if (!disposed && !runToken.superseded) {
          scheduleReadyTasks()
        }
      }
    })()

    runToken.opId = trackBackgroundOp(opPromise)
  }

  const scheduleReadyTasks = (): void => {
    if (disposed) return

    let changed = cascadeUpstreamFailures()

    for (const task of tasks) {
      if (activeWorkers.size >= maxConcurrent) break
      if (task.status !== 'queued') continue

      const parentMission = missions.find((m) => m.id === task.missionId)
      if (!parentMission || parentMission.status === 'cancelled') continue

      const allDepsDone = task.dependsOn.every((depId) => {
        const dep = tasks.find((t) => t.id === depId)
        return dep?.status === 'done'
      })
      if (!allDepsDone) continue

      let resolveSettled!: () => void
      const settled = new Promise<void>((resolve) => {
        resolveSettled = resolve
      })

      const runToken: ActiveWorkerRun = {
        tokenId: Symbol('worker-run'),
        taskId: task.id,
        sessionKey: task.sessionKey,
        superseded: false,
        steered: false,
        settled,
        resolveSettled,
      }

      const startTs = nowFn()
      taskStepStartedAt.set(task.id, startTs)
      const started = updateTask(task.id, (prev) => ({
        ...prev,
        status: 'running',
        step: null,
        health: 'normal',
        lastActiveAt: prev.lastActiveAt ?? startTs,
        startedAt: prev.startedAt ?? startTs,
      }))

      if (!started) continue
      activeWorkers.set(task.id, runToken)
      syncMissionStatus(task.missionId)
      changed = true

      runWorkerTask(cloneTask(started), runToken)
    }

    if (changed) {
      commitState()
    }

    for (const mission of missions) {
      maybeTriggerSynthesis(mission.id)
    }
  }

  const waitForDecision = (decisionId: string): Promise<ButlerDecisionResolution> => {
    return new Promise<ButlerDecisionResolution>((resolve) => {
      pendingWaiters.set(decisionId, { decisionId, resolve })
    })
  }

  const createPendingDecision = (input: {
    readonly missionId: string
    readonly taskId: string
    readonly sessionKey: string
    readonly kind: ButlerDecisionItem['kind']
    readonly title: string
    readonly summary: string
    readonly detail?: string
    readonly toolName?: string
    readonly confirmRequestId?: string
    readonly sessionAllowable?: boolean
    readonly options: readonly ButlerDecisionOption[]
  }): ButlerDecisionItem => {
    const decision: ButlerDecisionItem = {
      id: newId('decision'),
      missionId: input.missionId,
      taskId: input.taskId,
      sessionKey: input.sessionKey,
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
      ...(input.confirmRequestId !== undefined ? { confirmRequestId: input.confirmRequestId } : {}),
      ...(input.sessionAllowable !== undefined ? { sessionAllowable: input.sessionAllowable } : {}),
      options: input.options.map((o) => ({ ...o })),
      status: 'pending',
      createdAt: nowFn(),
    }
    decisions.push(decision)
    return decision
  }

  const approveMissionPlanInternal = async (
    missionId: string,
    opts?: { readonly comment?: string; readonly skipCommentFeed?: boolean },
  ): Promise<ButlerActionResult> => {
    if (disposed) {
      return { ok: false, error: 'Engine disposed' }
    }
    const cleanId = missionId.trim()
    if (!cleanId) {
      return { ok: false, error: 'Mission ID is required' }
    }

    const mission = resolveTargetMission(cleanId, 'draft')
    if (!mission) {
      return {
        ok: false,
        error:
          cleanId === 'latest'
            ? 'No mission awaiting plan approval'
            : `Mission not found: ${cleanId}`,
      }
    }
    if (TERMINAL_MISSION_STATUSES.has(mission.status)) {
      return { ok: false, error: `Mission is already ${mission.status}` }
    }
    if (!mission.plan || mission.plan.steps.length === 0) {
      return { ok: false, error: 'Mission has no proposed plan to approve' }
    }
    if (mission.plan.approvedAt !== undefined) {
      return { ok: true }
    }

    const ts = nowFn()
    const stepIdToTaskId = new Map<string, string>()
    for (const step of mission.plan.steps) {
      stepIdToTaskId.set(step.id, newId('task'))
    }

    const createdTasks: ButlerSubTask[] = []
    const createdTaskIds: string[] = []

    for (const step of mission.plan.steps) {
      const taskId = stepIdToTaskId.get(step.id)!
      const remappedDeps = Array.from(
        new Set(
          step.dependsOn
            .map((depStepId) => stepIdToTaskId.get(depStepId))
            .filter((id): id is string => Boolean(id)),
        ),
      )
      const sessionKey = `${BUTLER_CHIEF_PROJECT_ID}:${BUTLER_WORKER_CHAT_PREFIX}${taskId}`
      const scopePaths = step.scopePaths?.map((p) => p.trim()).filter(Boolean)

      const newTask: ButlerSubTask = {
        id: taskId,
        missionId: mission.id,
        title: step.title,
        brief: step.brief,
        role: step.role,
        dependsOn: remappedDeps,
        ...(scopePaths && scopePaths.length > 0 ? { scopePaths } : {}),
        sessionKey,
        status: 'queued',
        step: null,
        artifacts: [],
        createdAt: ts,
      }

      tasks.push(newTask)
      createdTasks.push(newTask)
      createdTaskIds.push(taskId)
    }

    const updated = updateMission(mission.id, (prev) => ({
      ...prev,
      plan: prev.plan ? { ...prev.plan, approvedAt: ts } : undefined,
      taskIds: [...prev.taskIds, ...createdTaskIds],
      status: 'running',
      updatedAt: ts,
    }))

    const trimmedComment = opts?.comment?.trim()
    if (trimmedComment && !opts?.skipCommentFeed) {
      appendFeedEntry({
        role: 'user',
        text: trimmedComment,
        missionId: mission.id,
        createdAt: ts,
      })
    }

    commitState()
    if (updated) {
      if (inConversationalTurn) {
        pendingTurnPlannedMissionId = updated.id
        pendingTurnPlannedTasks = createdTasks
      } else {
        deps.onMissionPlanned?.(cloneMission(updated), createdTasks.map(cloneTask))
      }
    }
    scheduleReadyTasks()
    return { ok: true }
  }

  const enqueueChiefPlanningTurn = (
    missionId: string,
    goalText: string,
    resolvedWorkdir: string | undefined,
    requireApproval: boolean,
  ): void => {
    enqueueChiefOp(missionId, async () => {
      try {
        const current = missions.find((m) => m.id === missionId)
        if (!current || current.status === 'cancelled' || disposed) return

        const prompt = requireApproval
          ? buildTwoStageAlignmentPrompt(current, resolvedWorkdir)
          : buildPlanningPrompt(missionId, goalText, resolvedWorkdir)
        const res = await deps
          .runPrompt(BUTLER_CHIEF_SESSION_KEY, prompt, {
            workdir: resolvedWorkdir,
            source: 'butler',
          })
          .catch((err: unknown) => ({
            ok: false as const,
            error: err instanceof Error ? err.message : String(err ?? 'Chief planning failed'),
            finalText: undefined,
            aborted: false,
          }))

        const latest = missions.find((m) => m.id === missionId)
        if (!latest || latest.status === 'cancelled' || disposed) return

        if (latest.report) {
          return
        }

        if (latest.taskIds.length > 0) {
          const hasWaiting = tasks.some(
            (t) => t.missionId === missionId && t.status === 'waiting_human',
          )
          const hasPendingDecision = decisions.some(
            (d) => d.missionId === missionId && d.status === 'pending',
          )
          updateMission(missionId, (prev) => ({
            ...prev,
            status:
              hasWaiting || hasPendingDecision
                ? 'waiting_human'
                : prev.status === 'planning'
                  ? 'running'
                  : prev.status,
            updatedAt: nowFn(),
          }))

          if (res.finalText?.trim()) {
            appendFeedEntry({
              role: 'butler',
              text: res.finalText.trim(),
              missionId,
            })
          }
          commitState()
          const plannedMission = missions.find((m) => m.id === missionId)
          if (plannedMission) {
            const plannedTasks = plannedMission.taskIds
              .map((id) => tasks.find((t) => t.id === id))
              .filter((t): t is ButlerSubTask => t !== undefined)
              .map(cloneTask)
            deps.onMissionPlanned?.(
              cloneMission(plannedMission),
              plannedTasks,
              res.finalText?.trim() || undefined,
            )
          }
          return
        }

        if (!res.ok) {
          const errorMsg =
            res.error?.trim() ||
            (res.aborted ? 'Mission planning aborted' : 'Mission planning failed')
          const endTs = nowFn()
          updateMission(missionId, (prev) => ({
            ...prev,
            status: 'failed',
            error: errorMsg,
            finishedAt: endTs,
            updatedAt: endTs,
          }))
          appendFeedEntry({
            role: 'system',
            text: `Mission failed: ${errorMsg}`,
            missionId,
            createdAt: endTs,
          })
          commitState()
          return
        }

        const endTs = nowFn()
        if (requireApproval) {
          if (latest.plan && latest.plan.approvedAt === undefined) {
            const replyText = res.finalText?.trim() || latest.plan.summary
            const updatedPlanMission = updateMission(missionId, (prev) => ({
              ...prev,
              status: 'awaiting_plan_approval',
              updatedAt: endTs,
            }))
            appendFeedEntry({
              role: 'butler',
              text: replyText,
              missionId,
              createdAt: endTs,
            })
            commitState()
            if (updatedPlanMission && updatedPlanMission.plan) {
              deps.onPlanProposed?.(
                cloneMission(updatedPlanMission),
                clonePlan(updatedPlanMission.plan),
                res.finalText?.trim() || undefined,
              )
            }
            return
          }

          const rawReply = res.finalText?.trim() || ''
          if (isClarifyingQuestion(rawReply)) {
            const clarifyingMission = updateMission(missionId, (prev) => ({
              ...prev,
              status: 'clarifying',
              updatedAt: endTs,
            }))
            appendFeedEntry({
              role: 'butler',
              text: rawReply,
              missionId,
              createdAt: endTs,
            })
            commitState()
            if (clarifyingMission) {
              deps.onClarificationAsked?.(cloneMission(clarifyingMission), rawReply)
            }
            return
          }
        }

        const replyText = res.finalText?.trim() || 'Completed.'
        const report: ButlerMissionReport = {
          headline: latest.title,
          summary: replyText,
          artifacts: [],
          risks: [],
          generatedAt: endTs,
        }
        const completed = updateMission(missionId, (prev) => ({
          ...prev,
          status: 'done',
          report,
          finishedAt: endTs,
          updatedAt: endTs,
        }))
        appendFeedEntry({
          role: 'butler',
          text: replyText,
          missionId,
          report,
          createdAt: endTs,
        })
        commitState()
        if (completed) {
          deps.onMissionCompleted?.(cloneMission(completed), cloneReport(report))
        }
      } finally {
        planningMissions.delete(missionId)
        if (!disposed) {
          scheduleReadyTasks()
        }
      }
    })
  }

  const enqueueConversationalTurn = (
    userText: string,
    resolvedWorkdir: string | undefined,
    generation: number,
  ): void => {
    enqueueChiefOp('__conversational__', async () => {
      if (disposed || generation !== chiefGeneration) return

      const beforeTaskIds = new Set(tasks.map((t) => t.id))
      const beforePlanRevs = new Map(missions.map((m) => [m.id, m.plan?.revision ?? 0]))
      const beforeReportAt = new Map(missions.map((m) => [m.id, m.report?.generatedAt ?? 0]))

      pendingTurnPlannedMissionId = null
      pendingTurnPlannedTasks = []
      inConversationalTurn = true

      let res: {
        readonly ok: boolean
        readonly runId?: string
        readonly finalText?: string
        readonly error?: string
        readonly aborted?: boolean
      }
      try {
        const prompt = buildConversationalPrompt(userText, resolvedWorkdir)
        res = await deps
          .runPrompt(BUTLER_CHIEF_SESSION_KEY, prompt, {
            workdir: resolvedWorkdir,
            source: 'butler',
          })
          .catch((err: unknown) => ({
            ok: false as const,
            error: err instanceof Error ? err.message : String(err ?? 'Chief turn failed'),
            finalText: undefined,
            aborted: false,
          }))
      } finally {
        inConversationalTurn = false
      }

      const deferredMissionId = pendingTurnPlannedMissionId
      const deferredTasks = pendingTurnPlannedTasks
      pendingTurnPlannedMissionId = null
      pendingTurnPlannedTasks = []

      const flushDeferredMissionPlanned = (reply?: string): void => {
        if (!deferredMissionId) return
        const approvedMission = missions.find((m) => m.id === deferredMissionId)
        if (approvedMission) {
          deps.onMissionPlanned?.(
            cloneMission(approvedMission),
            deferredTasks.map(cloneTask),
            reply,
          )
        }
      }

      if (disposed || generation !== chiefGeneration || res.aborted) {
        flushDeferredMissionPlanned()
        return
      }

      if (!res.ok) {
        flushDeferredMissionPlanned()
        if (!deferredMissionId) {
          const errorMsg = res.error?.trim() || 'Chief reply failed'
          appendFeedEntry({
            role: 'system',
            text: `Butler reply failed: ${errorMsg}`,
            createdAt: nowFn(),
          })
          commitState()
        }
        return
      }

      const endTs = nowFn()
      const replyText = res.finalText?.trim() || ''

      // 1. Check whether new tasks were approved or dispatched during this turn.
      const createdTasks = tasks.filter((t) => !beforeTaskIds.has(t.id))
      if (createdTasks.length > 0 || deferredMissionId) {
        const targetMissionId =
          deferredMissionId ?? createdTasks[createdTasks.length - 1]!.missionId
        const targetMission = missions.find((m) => m.id === targetMissionId)
        if (targetMission && !TERMINAL_MISSION_STATUSES.has(targetMission.status)) {
          const hasWaiting = tasks.some(
            (t) => t.missionId === targetMissionId && t.status === 'waiting_human',
          )
          const hasPendingDecision = decisions.some(
            (d) => d.missionId === targetMissionId && d.status === 'pending',
          )
          updateMission(targetMissionId, (prev) => ({
            ...prev,
            status:
              hasWaiting || hasPendingDecision
                ? 'waiting_human'
                : prev.status === 'planning'
                  ? 'running'
                  : prev.status,
            updatedAt: endTs,
          }))
        }

        if (replyText) {
          appendFeedEntry({
            role: 'butler',
            text: replyText,
            missionId: targetMissionId,
            createdAt: endTs,
          })
        }
        commitState()

        if (deferredMissionId) {
          flushDeferredMissionPlanned(replyText || undefined)
        } else {
          const refreshedMission = missions.find((m) => m.id === targetMissionId)
          if (refreshedMission) {
            deps.onMissionPlanned?.(
              cloneMission(refreshedMission),
              createdTasks.map(cloneTask),
              replyText || undefined,
            )
          }
        }
        if (!disposed) scheduleReadyTasks()
        return
      }

      // 2. Check whether a draft mission plan was proposed or updated during this turn.
      const proposedMission = [...missions]
        .reverse()
        .find(
          (m) =>
            m.plan &&
            m.plan.approvedAt === undefined &&
            m.status === 'awaiting_plan_approval' &&
            m.plan.revision > (beforePlanRevs.get(m.id) ?? 0),
        )
      if (proposedMission?.plan) {
        const displayReply = replyText || proposedMission.plan.summary
        appendFeedEntry({
          role: 'butler',
          text: displayReply,
          missionId: proposedMission.id,
          createdAt: endTs,
        })
        commitState()
        deps.onPlanProposed?.(
          cloneMission(proposedMission),
          clonePlan(proposedMission.plan),
          replyText || undefined,
        )
        return
      }

      // 3. Skip duplicate reply emission if publishReport already finalized a mission this turn.
      const reportedMission = missions.find(
        (m) => (m.report?.generatedAt ?? 0) > (beforeReportAt.get(m.id) ?? 0),
      )
      if (reportedMission) {
        return
      }

      // 4. Pure chat, desktop actions, or CRUD queries: never create fake missions or reports.
      if (replyText) {
        appendFeedEntry({
          role: 'butler',
          text: replyText,
          createdAt: endTs,
        })
        commitState()
        deps.onConversationalReply?.(replyText)
      }
    })
  }

  const engine: ButlerMissionEngine = {
    async init(): Promise<ButlerDeskSnapshot> {
      const loaded = await readButlerMissionState(deps.statePath)
      missions = loaded.missions.map(cloneMission)
      tasks = loaded.tasks.map(cloneTask)
      decisions = loaded.decisions.map(cloneDecision)
      feed = loaded.feed.map(cloneFeedEntry)

      for (const m of missions) usedIds.add(m.id)
      for (const t of tasks) usedIds.add(t.id)
      for (const d of decisions) usedIds.add(d.id)
      for (const f of feed) usedIds.add(f.id)

      if (loaded.recovered) {
        await enqueuePersist()
        notifySnapshot()
      }

      return buildSnapshot()
    },

    async dispose(): Promise<void> {
      if (disposePromise) return disposePromise
      disposePromise = (async () => {
        disposed = true
        clearTelemetryNotifyTimer()
        taskStepStartedAt.clear()

        resolvePendingWaitersFor(() => true, 'cancelled', 'Engine disposed')

        for (const [taskId, runToken] of [...activeWorkers]) {
          runToken.superseded = true
          activeWorkers.delete(taskId)
          runToken.resolveSettled()
        }
        trackedBackgroundOps.clear()

        await enqueuePersist()
      })()
      return disposePromise
    },

    getSnapshot(): ButlerDeskSnapshot {
      return buildSnapshot()
    },

    async delegate(goal: string, workdir?: string): Promise<ButlerDelegateResult> {
      if (disposed) {
        return { ok: false, error: 'Engine disposed' }
      }
      const trimmedGoal = goal.trim()
      if (!trimmedGoal) {
        return { ok: false, error: 'Goal must not be empty' }
      }

      const ts = nowFn()
      if (deps.conversationalMode?.() === true) {
        const generation = (chiefGeneration += 1)
        const resolvedWorkdir = workdir?.trim() || deps.defaultWorkdir?.()
        lastConversationalUserText = trimmedGoal
        lastConversationalWorkdir = resolvedWorkdir

        // Preempt only the Chief conversational session; keep background workers running.
        if (chiefBusy || chiefPendingCount > 0) {
          void Promise.resolve(deps.abortSession(BUTLER_CHIEF_SESSION_KEY)).catch(() => {})
        }

        appendFeedEntry({
          role: 'user',
          text: trimmedGoal,
          createdAt: ts,
        })
        commitState()
        enqueueConversationalTurn(trimmedGoal, resolvedWorkdir, generation)
        return { ok: true }
      }

      const requireApproval = deps.requirePlanApproval?.() === true
      const activeDraft = requireApproval ? findActiveDraftMission() : undefined

      if (activeDraft) {
        const replyIntent = classifyButlerPlanReplyIntent(trimmedGoal)

        if (activeDraft.status === 'awaiting_plan_approval' && replyIntent === 'approve') {
          updateMission(activeDraft.id, (prev) => ({
            ...prev,
            conversationNotes: [...(prev.conversationNotes ?? [prev.goal]), trimmedGoal],
            updatedAt: ts,
          }))
          appendFeedEntry({
            role: 'user',
            text: trimmedGoal,
            missionId: activeDraft.id,
            createdAt: ts,
          })
          const approvedRes = await approveMissionPlanInternal(activeDraft.id, {
            skipCommentFeed: true,
          })
          if (!approvedRes.ok) {
            return { ok: false, missionId: activeDraft.id, error: approvedRes.error }
          }
          return { ok: true, missionId: activeDraft.id }
        }

        if (replyIntent === 'cancel') {
          appendFeedEntry({
            role: 'user',
            text: trimmedGoal,
            missionId: activeDraft.id,
            createdAt: ts,
          })
          const cancelRes = await engine.cancelMission(activeDraft.id)
          if (!cancelRes.ok) {
            return { ok: false, missionId: activeDraft.id, error: cancelRes.error }
          }
          return { ok: true, missionId: activeDraft.id }
        }

        const resolvedWorkdir = workdir?.trim() || resolveWorkdirForMission(activeDraft.id)
        if (workdir?.trim()) {
          missionWorkdirById.set(activeDraft.id, resolvedWorkdir)
        }

        const updatedDraft = updateMission(activeDraft.id, (prev) => ({
          ...prev,
          conversationNotes: [...(prev.conversationNotes ?? [prev.goal]), trimmedGoal],
          status: 'planning',
          updatedAt: ts,
        }))
        planningMissions.add(activeDraft.id)

        appendFeedEntry({
          role: 'user',
          text: trimmedGoal,
          missionId: activeDraft.id,
          createdAt: ts,
        })

        commitState()
        if (updatedDraft) {
          deps.onMissionAccepted?.(cloneMission(updatedDraft))
        }

        enqueueChiefPlanningTurn(activeDraft.id, trimmedGoal, resolvedWorkdir, true)
        return { ok: true, missionId: activeDraft.id }
      }

      const missionId = newId('mission')
      const mission: ButlerMission = {
        id: missionId,
        title: deriveTitle(trimmedGoal, missionId),
        goal: trimmedGoal,
        status: 'planning',
        createdAt: ts,
        updatedAt: ts,
        taskIds: [],
        ...(requireApproval ? { conversationNotes: [trimmedGoal] } : {}),
      }

      const resolvedWorkdir = workdir?.trim() || deps.defaultWorkdir?.()
      missionWorkdirById.set(missionId, resolvedWorkdir)
      missions.push(mission)
      planningMissions.add(missionId)

      appendFeedEntry({
        role: 'user',
        text: trimmedGoal,
        missionId,
        createdAt: ts,
      })

      commitState()
      deps.onMissionAccepted?.(cloneMission(mission))

      enqueueChiefPlanningTurn(missionId, trimmedGoal, resolvedWorkdir, requireApproval)
      return { ok: true, missionId }
    },

    async proposePlan(input: Parameters<ButlerMissionEngine['proposePlan']>[0]) {
      if (disposed) {
        return { ok: false, error: 'Engine disposed' }
      }
      const summary = input.summary?.trim() ?? ''
      if (!summary) {
        return { ok: false, error: 'Plan summary is required' }
      }
      const validated = validateAndNormalizePlanSteps(input.steps)
      if (!validated.ok) {
        return { ok: false, error: validated.error }
      }

      const rawTitle = input.title?.trim() ?? ''
      const isConversational = deps.conversationalMode?.() === true
      let mission: ButlerMission | undefined
      let createdNewMission = false

      if (input.missionId !== undefined && input.missionId.trim() !== 'latest') {
        mission = missions.find((m) => m.id === input.missionId!.trim())
        if (!mission) {
          return { ok: false, error: `Mission not found: ${input.missionId}` }
        }
      } else {
        mission = findActiveDraftMission() ?? (isConversational ? undefined : findLatestNonTerminalMission())
        if (!mission && isConversational) {
          const ts = nowFn()
          const missionId = newId('mission')
          mission = {
            id: missionId,
            title: deriveTitle(rawTitle || summary, missionId),
            goal: lastConversationalUserText || summary,
            status: 'awaiting_plan_approval',
            createdAt: ts,
            updatedAt: ts,
            taskIds: [],
          }
          missionWorkdirById.set(missionId, lastConversationalWorkdir ?? deps.defaultWorkdir?.())
          missions.push(mission)
          createdNewMission = true
        }
      }

      if (!mission) {
        return { ok: false, error: 'No active mission found for plan' }
      }
      if (TERMINAL_MISSION_STATUSES.has(mission.status)) {
        return { ok: false, error: `Mission is already in terminal state: ${mission.status}` }
      }
      if (mission.plan?.approvedAt !== undefined || mission.taskIds.length > 0) {
        return { ok: false, error: 'Mission plan is already approved and dispatched' }
      }

      const ts = nowFn()
      const plan: ButlerMissionPlan = {
        summary,
        steps: validated.steps,
        revision: (mission.plan?.revision ?? 0) + 1,
        updatedAt: ts,
      }

      const updated = updateMission(mission.id, (prev) => ({
        ...prev,
        ...(rawTitle && !createdNewMission ? { title: deriveTitle(rawTitle, prev.id) } : {}),
        plan,
        status: 'awaiting_plan_approval',
        updatedAt: ts,
      }))

      commitState()
      return {
        ok: true,
        plan: clonePlan(plan),
        ...(updated ? { mission: cloneMission(updated) } : {}),
      }
    },

    async approveMissionPlan(req: ButlerApproveMissionPlanRequest): Promise<ButlerActionResult> {
      return approveMissionPlanInternal(req.missionId, { comment: req.comment })
    },

    async dispatchTask(input) {
      if (disposed) {
        return { ok: false, error: 'Engine disposed' }
      }

      const title = input.title?.trim() ?? ''
      const brief = input.brief?.trim() ?? ''
      if (!title || !brief) {
        return { ok: false, error: 'Task title and brief are required' }
      }

      const isConversational = deps.conversationalMode?.() === true
      const requireApproval = deps.requirePlanApproval?.() === true
      let mission: ButlerMission | undefined
      if (input.missionId !== undefined) {
        mission = missions.find((m) => m.id === input.missionId)
        if (!mission) {
          return { ok: false, error: `Mission not found: ${input.missionId}` }
        }
        if (TERMINAL_MISSION_STATUSES.has(mission.status)) {
          return { ok: false, error: `Mission is already in terminal state: ${mission.status}` }
        }
      } else {
        mission =
          isConversational && requireApproval
            ? findActiveDraftMission()
            : findLatestNonTerminalMission()
        if (!mission) {
          const ts = nowFn()
          const implicitId = newId('mission')
          const implicitGoal =
            isConversational && lastConversationalUserText ? lastConversationalUserText : brief
          mission = {
            id: implicitId,
            title: deriveTitle(title, implicitId),
            goal: implicitGoal,
            status: requireApproval ? 'awaiting_plan_approval' : 'running',
            createdAt: ts,
            updatedAt: ts,
            taskIds: [],
          }
          missionWorkdirById.set(
            implicitId,
            input.workdir?.trim() ||
              (isConversational ? lastConversationalWorkdir : undefined) ||
              deps.defaultWorkdir?.(),
          )
          missions.push(mission)
        }
      }

      // Hard Critic Gate: stage unapproved dispatch calls into the draft plan instead of spawning workers.
      if (requireApproval && mission.plan?.approvedAt === undefined) {
        const existingSteps = mission.plan?.steps ?? []
        const existingStepIds = new Set(existingSteps.map((s) => s.id))
        let stepId = input.id?.trim() ?? ''
        if (stepId) {
          if (existingStepIds.has(stepId)) {
            return { ok: false, error: `Task already staged in draft plan: ${stepId}` }
          }
        } else {
          let nextIdx = existingSteps.length + 1
          do {
            stepId = `step-${nextIdx}`
            nextIdx += 1
          } while (existingStepIds.has(stepId))
        }

        const dependsOn = Array.from(
          new Set((input.dependsOn ?? []).map((id) => id.trim()).filter(Boolean)),
        )
        if (dependsOn.includes(stepId)) {
          return { ok: false, error: 'Cyclic task dependency detected' }
        }
        for (const depId of dependsOn) {
          if (!existingStepIds.has(depId)) {
            return { ok: false, error: `Unknown dependency task: ${depId}` }
          }
        }

        const draftAdjacency = new Map<string, readonly string[]>()
        for (const existingStep of existingSteps) {
          draftAdjacency.set(existingStep.id, existingStep.dependsOn)
        }
        draftAdjacency.set(stepId, dependsOn)
        if (hasCycleInDependencyGraph(draftAdjacency)) {
          return { ok: false, error: 'Cyclic task dependency detected' }
        }

        const inferredRole = inferButlerWorkerRole({ role: input.role, title, brief })
        const scopePaths = input.scopePaths?.map((p) => p.trim()).filter(Boolean)
        const stagedStep: ButlerProposedTaskStep = {
          id: stepId,
          title,
          brief,
          role: inferredRole,
          dependsOn,
          ...(scopePaths && scopePaths.length > 0 ? { scopePaths } : {}),
        }

        const ts = nowFn()
        const stagedPlan: ButlerMissionPlan = {
          summary: mission.plan?.summary || mission.title,
          steps: [...existingSteps, stagedStep],
          revision: (mission.plan?.revision ?? 0) + 1,
          updatedAt: ts,
        }

        updateMission(mission.id, (prev) => ({
          ...prev,
          plan: stagedPlan,
          status: 'awaiting_plan_approval',
          updatedAt: ts,
        }))
        commitState()
        return {
          ok: true,
          stagedForApproval: true,
          note: 'Plan approval is required before dispatch. Staged into draft plan awaiting user confirmation.',
        }
      }

      const taskId = input.id?.trim() || newId('task')
      if (tasks.some((t) => t.id === taskId)) {
        return { ok: false, error: `Task already exists: ${taskId}` }
      }

      const dependsOn = Array.from(
        new Set((input.dependsOn ?? []).map((id) => id.trim()).filter(Boolean)),
      )

      if (dependsOn.includes(taskId)) {
        return { ok: false, error: 'Cyclic task dependency detected' }
      }

      const missionTasks = tasks.filter((t) => t.missionId === mission.id)
      const knownMissionTaskIds = new Set(missionTasks.map((t) => t.id))
      for (const depId of dependsOn) {
        if (!knownMissionTaskIds.has(depId)) {
          return { ok: false, error: `Unknown dependency task: ${depId}` }
        }
      }

      const adjacency = new Map<string, readonly string[]>()
      for (const existing of missionTasks) {
        adjacency.set(existing.id, existing.dependsOn)
      }
      adjacency.set(taskId, dependsOn)

      if (hasCycleInDependencyGraph(adjacency)) {
        return { ok: false, error: 'Cyclic task dependency detected' }
      }

      usedIds.add(taskId)
      const ts = nowFn()
      const sessionKey = `${BUTLER_CHIEF_PROJECT_ID}:${BUTLER_WORKER_CHAT_PREFIX}${taskId}`
      const scopePaths = input.scopePaths?.map((p) => p.trim()).filter(Boolean)

      const newTask: ButlerSubTask = {
        id: taskId,
        missionId: mission.id,
        title,
        brief,
        role: inferButlerWorkerRole({ role: input.role, title, brief }),
        dependsOn,
        ...(scopePaths && scopePaths.length > 0 ? { scopePaths } : {}),
        sessionKey,
        status: 'queued',
        step: null,
        artifacts: [],
        createdAt: ts,
      }

      if (input.workdir?.trim()) {
        taskWorkdirById.set(taskId, input.workdir.trim())
      }

      tasks.push(newTask)
      updateMission(mission.id, (prev) => ({
        ...prev,
        taskIds: [...prev.taskIds, taskId],
        updatedAt: ts,
      }))

      commitState()
      scheduleReadyTasks()

      const persistedTask = tasks.find((t) => t.id === taskId) ?? newTask
      return { ok: true, task: cloneTask(persistedTask) }
    },

    listMissions(filter?: ButlerMissionListFilter): readonly ButlerMission[] {
      const filtered = missions.filter((m) => {
        if (!filter || filter === 'all') return true
        if (filter === 'active') return !TERMINAL_MISSION_STATUSES.has(m.status)
        if (filter === 'done') return m.status === 'done'
        if (filter === 'failed') return m.status === 'failed' || m.status === 'interrupted'
        if (filter === 'cancelled') return m.status === 'cancelled'
        return true
      })
      return [...filtered].reverse().sort((a, b) => b.updatedAt - a.updatedAt).map(cloneMission)
    },

    listTasks(missionId?: string): readonly ButlerSubTask[] {
      if (missionId !== undefined) {
        return tasks.filter((t) => t.missionId === missionId).map(cloneTask)
      }
      return tasks.map(cloneTask)
    },

    inspectTask(taskId: string) {
      const task = tasks.find((t) => t.id === taskId)
      if (!task) return null
      return {
        task: hydrateTaskWithLiveHealth(task, nowFn()),
        decisions: decisions.filter((d) => d.taskId === taskId).map(cloneDecision),
      }
    },

    async updateMissionDetails(input: Parameters<ButlerMissionEngine['updateMissionDetails']>[0]) {
      if (disposed) {
        return { ok: false, error: 'Engine disposed' }
      }
      const mission = resolveTargetMission(input.missionId, 'any')
      if (!mission) {
        return {
          ok: false,
          error:
            input.missionId.trim() === 'latest'
              ? 'No missions found'
              : `Mission not found: ${input.missionId}`,
        }
      }

      const nextTitle = input.title?.trim()
      const nextGoal = input.goal?.trim()
      const nextSummary = input.summary?.trim()
      const hasStepsUpdate = input.steps !== undefined
      if (!nextTitle && !nextGoal && !nextSummary && !hasStepsUpdate) {
        return { ok: false, error: 'At least one mission field must be provided to update' }
      }

      const ts = nowFn()
      let updatedPlan: ButlerMissionPlan | undefined
      if (nextSummary !== undefined || hasStepsUpdate) {
        if (
          TERMINAL_MISSION_STATUSES.has(mission.status) ||
          mission.plan?.approvedAt !== undefined ||
          mission.taskIds.length > 0
        ) {
          return { ok: false, error: 'Cannot modify plan after mission approval or completion' }
        }
        if (hasStepsUpdate) {
          const validated = validateAndNormalizePlanSteps(input.steps)
          if (!validated.ok) {
            return { ok: false, error: validated.error }
          }
          updatedPlan = {
            summary: nextSummary || mission.plan?.summary || nextGoal || mission.goal,
            steps: validated.steps,
            revision: (mission.plan?.revision ?? 0) + 1,
            updatedAt: ts,
          }
        } else {
          if (!mission.plan) {
            return { ok: false, error: 'Plan steps are required when creating a new draft plan' }
          }
          updatedPlan = {
            ...mission.plan,
            summary: nextSummary!,
            revision: mission.plan.revision + 1,
            updatedAt: ts,
          }
        }
      }

      const updated = updateMission(mission.id, (prev) => ({
        ...prev,
        ...(nextTitle ? { title: deriveTitle(nextTitle, prev.id) } : {}),
        ...(nextGoal ? { goal: nextGoal } : {}),
        ...(updatedPlan ? { plan: updatedPlan } : {}),
        updatedAt: ts,
      }))

      commitState()
      return {
        ok: true,
        ...(updated ? { mission: cloneMission(updated) } : {}),
      }
    },

    async steerTask(req: ButlerSteerTaskRequest): Promise<ButlerActionResult> {
      if (disposed) {
        return { ok: false, error: 'Engine disposed' }
      }
      const taskId = req.taskId?.trim() ?? ''
      const instruction = req.instruction?.trim() ?? ''
      if (!taskId || !instruction) {
        return { ok: false, error: 'Task ID and steer instruction are required' }
      }

      const task = tasks.find((t) => t.id === taskId)
      if (!task) {
        return { ok: false, error: `Task not found: ${taskId}` }
      }
      if (task.status === 'cancelled') {
        return { ok: false, error: 'Cannot steer a cancelled task' }
      }
      if (task.status === 'done') {
        return { ok: false, error: 'Task is already completed' }
      }

      const mission = missions.find((m) => m.id === task.missionId)
      if (mission?.status === 'cancelled') {
        return { ok: false, error: 'Cannot steer a task in a cancelled mission' }
      }

      const existingNotes = steerNotesByTaskId.get(taskId) ?? []
      existingNotes.push(instruction)
      steerNotesByTaskId.set(taskId, existingNotes)

      updateTask(taskId, (prev) => ({
        ...prev,
        brief: `${prev.brief}\n\n[Steer] ${instruction}`,
      }))

      appendFeedEntry({
        role: 'system',
        text: `Steered task "${task.title}": ${instruction}`,
        missionId: task.missionId,
      })

      if (task.status === 'running') {
        const activeRun = activeWorkers.get(taskId)
        if (activeRun) {
          activeRun.steered = true
          await Promise.resolve(deps.abortSession(task.sessionKey)).catch(() => {})
          await Promise.race([activeRun.settled, delay(STEER_ABORT_SETTLE_MS)])
          activeRun.superseded = true
          if (activeRun.opId) untrackBackgroundOp(activeRun.opId)
          if (activeWorkers.get(taskId)?.tokenId === activeRun.tokenId) {
            activeWorkers.delete(taskId)
          }
          activeRun.resolveSettled()
        }

        taskStepStartedAt.delete(taskId)
        updateTask(taskId, (prev) => ({
          ...prev,
          status: 'queued',
          step: null,
          health: 'normal',
          error: undefined,
          finishedAt: undefined,
        }))
        syncMissionStatus(task.missionId)
        commitState()
        scheduleReadyTasks()
        return { ok: true }
      }

      if (task.status === 'interrupted' || task.status === 'failed') {
        taskStepStartedAt.delete(taskId)
        updateTask(taskId, (prev) => ({
          ...prev,
          status: 'queued',
          step: null,
          health: 'normal',
          error: undefined,
          finishedAt: undefined,
        }))

        reactivateMissionForTask(task.missionId)
        commitState()
        scheduleReadyTasks()
        return { ok: true }
      }

      // 'queued' or 'waiting_human': steer instruction is saved and broadcast;
      // waiting_human tasks resume with the updated context once the decision resolves.
      commitState()
      return { ok: true }
    },

    async retryTask(req: ButlerRetryTaskRequest): Promise<ButlerActionResult> {
      if (disposed) {
        return { ok: false, error: 'Engine disposed' }
      }
      const taskId = req.taskId?.trim() ?? ''
      if (!taskId) {
        return { ok: false, error: 'Task ID is required' }
      }

      const task = tasks.find((t) => t.id === taskId)
      if (!task) {
        return { ok: false, error: `Task not found: ${taskId}` }
      }
      if (!FAILURE_TASK_STATUSES.has(task.status)) {
        return {
          ok: false,
          error: `Only failed, cancelled, or interrupted tasks can be retried (current: ${task.status})`,
        }
      }

      const mission = missions.find((m) => m.id === task.missionId)
      if (!mission) {
        return { ok: false, error: `Mission not found: ${task.missionId}` }
      }

      for (const depId of task.dependsOn) {
        const dep = tasks.find((t) => t.id === depId)
        if (!dep) {
          return { ok: false, error: `Missing upstream task "${depId}"` }
        }
        if (FAILURE_TASK_STATUSES.has(dep.status)) {
          return {
            ok: false,
            error: `Cannot retry task while upstream dependency "${dep.title}" is ${dep.status}`,
          }
        }
      }

      const instruction = req.instruction?.trim()
      if (instruction) {
        const existingNotes = steerNotesByTaskId.get(taskId) ?? []
        existingNotes.push(instruction)
        steerNotesByTaskId.set(taskId, existingNotes)
      }

      taskStepStartedAt.delete(taskId)
      updateTask(taskId, (prev) => ({
        ...prev,
        status: 'queued',
        step: null,
        health: 'normal',
        consecutiveErrors: 0,
        stepCount: 0,
        activityLog: undefined,
        error: undefined,
        outputSummary: undefined,
        startedAt: undefined,
        finishedAt: undefined,
        ...(instruction ? { brief: `${prev.brief}\n\n[Retry] ${instruction}` } : {}),
      }))

      appendFeedEntry({
        role: 'system',
        text: instruction
          ? `Retried task "${task.title}": ${instruction}`
          : `Retried task "${task.title}".`,
        missionId: task.missionId,
      })

      reactivateMissionForTask(task.missionId, true)
      commitState()
      scheduleReadyTasks()
      return { ok: true }
    },

    async cancelTask(taskId: string): Promise<ButlerActionResult> {
      const task = tasks.find((t) => t.id === taskId)
      if (!task) {
        return { ok: false, error: `Task not found: ${taskId}` }
      }
      if (task.status === 'cancelled') {
        return { ok: true }
      }
      if (TERMINAL_TASK_STATUSES.has(task.status)) {
        return { ok: false, error: `Task is already ${task.status}` }
      }

      const activeRun = activeWorkers.get(taskId)
      if (activeRun) {
        activeRun.superseded = true
        if (activeRun.opId) untrackBackgroundOp(activeRun.opId)
        activeWorkers.delete(taskId)
        activeRun.resolveSettled()
      }

      taskStepStartedAt.delete(taskId)
      updateTask(taskId, (prev) => ({
        ...prev,
        status: 'cancelled',
        step: null,
        health: 'normal',
        finishedAt: nowFn(),
      }))

      resolvePendingWaitersFor((d) => d.taskId === taskId, 'cancelled', 'Task cancelled')

      await Promise.resolve(deps.abortSession(task.sessionKey)).catch(() => {})

      appendFeedEntry({
        role: 'system',
        text: `Cancelled task "${task.title}".`,
        missionId: task.missionId,
      })

      syncMissionStatus(task.missionId)
      commitState()
      scheduleReadyTasks()
      return { ok: true }
    },

    async cancelMission(missionId: string): Promise<ButlerActionResult> {
      const cleanId = missionId.trim()
      const mission = resolveTargetMission(cleanId, 'nonTerminal')
      if (!mission) {
        return {
          ok: false,
          error:
            cleanId === 'latest'
              ? 'No active mission to cancel'
              : `Mission not found: ${missionId}`,
        }
      }
      if (mission.status === 'cancelled') {
        return { ok: true }
      }

      const ts = nowFn()
      await stopMissionExecution(mission.id, {
        markTasksCancelled: true,
        waiterNote: 'Mission cancelled',
      })

      updateMission(mission.id, (prev) => ({
        ...prev,
        status: 'cancelled',
        finishedAt: ts,
        updatedAt: ts,
      }))

      appendFeedEntry({
        role: 'system',
        text: `Cancelled mission "${mission.title}".`,
        missionId: mission.id,
        createdAt: ts,
      })

      commitState()
      return { ok: true }
    },

    async deleteMission(missionId: string): Promise<ButlerActionResult> {
      if (disposed) {
        return { ok: false, error: 'Engine disposed' }
      }
      const cleanId = missionId.trim()
      if (!cleanId) {
        return { ok: false, error: 'Mission ID is required' }
      }

      const mission = missions.find((m) => m.id === cleanId)
      if (!mission) {
        return { ok: false, error: `Mission not found: ${cleanId}` }
      }

      await stopMissionExecution(mission.id, {
        markTasksCancelled: false,
        waiterNote: 'Mission deleted',
      })

      planningMissions.delete(mission.id)
      synthesizingMissions.delete(mission.id)
      missionWorkdirById.delete(mission.id)

      for (const t of tasks) {
        if (t.missionId === mission.id) {
          taskWorkdirById.delete(t.id)
          steerNotesByTaskId.delete(t.id)
        }
      }

      missions = missions.filter((m) => m.id !== mission.id)
      tasks = tasks.filter((t) => t.missionId !== mission.id)
      decisions = decisions.filter((d) => d.missionId !== mission.id)
      feed = feed.filter((f) => f.missionId !== mission.id)

      commitState()
      return { ok: true }
    },

    async executeDesktopAction(
      req: ButlerDesktopActionRequest,
    ): Promise<ButlerDesktopActionResult> {
      if (disposed) {
        return { ok: false, error: 'Engine disposed' }
      }
      if (req.target === 'file' && !req.pathOrUrl?.trim()) {
        return { ok: false, error: 'pathOrUrl is required when target is "file"' }
      }
      if (!deps.executeDesktopAction) {
        return { ok: false, error: 'Desktop actions are not configured' }
      }
      try {
        return await deps.executeDesktopAction(req)
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err ?? 'Desktop action failed'),
        }
      }
    },

    async manageDesktopTodos(req: ButlerDesktopTodoRequest): Promise<ButlerDesktopTodoResult> {
      if (disposed) {
        return { ok: false, error: 'Engine disposed' }
      }
      if (!deps.manageDesktopTodos) {
        return { ok: false, error: 'Desktop todo controls are not configured' }
      }
      try {
        return await deps.manageDesktopTodos(req)
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err ?? 'Desktop todo operation failed'),
        }
      }
    },

    async interceptWorkerConfirm(req: PiAgentConfirmRequest): Promise<PiAgentConfirmReply | null> {
      if (!isButlerWorkerSession(req.sessionKey)) {
        return null
      }

      const task = findTaskBySession(req.sessionKey)
      if (!task || TERMINAL_TASK_STATUSES.has(task.status)) {
        return null
      }

      const options: ButlerDecisionOption[] = [
        { id: 'allow', label: 'Allow once', style: 'primary' },
        ...(req.sessionAllowable
          ? [{ id: 'allow-session', label: 'Allow for task', style: 'default' as const }]
          : []),
        { id: 'deny', label: 'Deny', style: 'danger' },
      ]

      const toolName = req.call.name
      const decision = createPendingDecision({
        missionId: task.missionId,
        taskId: task.id,
        sessionKey: req.sessionKey,
        kind: 'permission',
        title: `Permission required: ${toolName}`,
        summary: req.argsSummary?.trim() || `Tool ${toolName} requires confirmation`,
        detail: JSON.stringify(req.call.input ?? {}, null, 2),
        toolName,
        confirmRequestId: req.requestId,
        sessionAllowable: req.sessionAllowable,
        options,
      })

      updateTask(task.id, (prev) => ({
        ...prev,
        status: 'waiting_human',
      }))
      syncMissionStatus(task.missionId)
      commitState()

      const updatedTask = tasks.find((t) => t.id === task.id) ?? task
      deps.onDecisionCreated?.(cloneDecision(decision), cloneTask(updatedTask))

      const waitPromise = waitForDecision(decision.id)
      const resolution = await waitPromise

      const reply: PiAgentConfirmReply =
        resolution.optionId === 'allow-session'
          ? { requestId: req.requestId, allowed: true, alwaysAllowSession: true }
          : resolution.optionId === 'allow'
            ? { requestId: req.requestId, allowed: true }
            : { requestId: req.requestId, allowed: false }

      const latestTask = tasks.find((t) => t.id === task.id)
      if (latestTask && latestTask.status === 'waiting_human' && !disposed) {
        const stillWaiting = decisions.some((d) => d.taskId === task.id && d.status === 'pending')
        if (!stillWaiting) {
          updateTask(task.id, (prev) => ({
            ...prev,
            status: 'running',
          }))
          syncMissionStatus(task.missionId)
          commitState()
        }
      }

      if (deps.resolvePermissionConfirm) {
        await Promise.resolve(deps.resolvePermissionConfirm(req.requestId, reply)).catch(
          () => false,
        )
      }

      return reply
    },

    async requestWorkerChoice(sessionKey: string, input): Promise<ButlerDecisionResolution> {
      if (!isButlerWorkerSession(sessionKey)) {
        throw new Error(`Not a Butler worker session: ${sessionKey}`)
      }
      const task = findTaskBySession(sessionKey)
      if (!task) {
        throw new Error(`No Butler task found for session: ${sessionKey}`)
      }

      const decision = createPendingDecision({
        missionId: task.missionId,
        taskId: task.id,
        sessionKey,
        kind: 'choice',
        title: input.title,
        summary: input.summary,
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        options: input.options,
      })

      updateTask(task.id, (prev) => ({
        ...prev,
        status: 'waiting_human',
      }))
      syncMissionStatus(task.missionId)
      commitState()

      const updatedTask = tasks.find((t) => t.id === task.id) ?? task
      deps.onDecisionCreated?.(cloneDecision(decision), cloneTask(updatedTask))

      const resolution = await waitForDecision(decision.id)

      const latestTask = tasks.find((t) => t.id === task.id)
      if (latestTask && latestTask.status === 'waiting_human' && !disposed) {
        const stillWaiting = decisions.some((d) => d.taskId === task.id && d.status === 'pending')
        if (!stillWaiting) {
          updateTask(task.id, (prev) => ({
            ...prev,
            status: 'running',
          }))
          syncMissionStatus(task.missionId)
          commitState()
        }
      }

      return resolution
    },

    async requestChiefDecision(input): Promise<ButlerDecisionResolution> {
      const targetMission = input.missionId
        ? missions.find((m) => m.id === input.missionId)
        : findLatestNonTerminalMission()
      if (!targetMission) {
        throw new Error('No active Butler mission for Chief decision')
      }

      const targetTask = input.taskId ? (tasks.find((t) => t.id === input.taskId) ?? null) : null
      const priorMissionStatus = targetMission.status

      const decision = createPendingDecision({
        missionId: targetMission.id,
        taskId: targetTask?.id ?? '',
        sessionKey: BUTLER_CHIEF_SESSION_KEY,
        kind: 'choice',
        title: input.title,
        summary: input.summary,
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        options: input.options,
      })

      if (!TERMINAL_MISSION_STATUSES.has(targetMission.status)) {
        updateMission(targetMission.id, (prev) => ({
          ...prev,
          status: 'waiting_human',
          updatedAt: nowFn(),
        }))
      }
      commitState()

      deps.onDecisionCreated?.(cloneDecision(decision), targetTask ? cloneTask(targetTask) : null)

      const resolution = await waitForDecision(decision.id)

      const latestMission = missions.find((m) => m.id === targetMission.id)
      if (latestMission && !TERMINAL_MISSION_STATUSES.has(latestMission.status) && !disposed) {
        if (priorMissionStatus === 'synthesizing') {
          updateMission(targetMission.id, (prev) => ({
            ...prev,
            status: 'synthesizing',
            updatedAt: nowFn(),
          }))
        } else {
          syncMissionStatus(targetMission.id)
        }
        commitState()
      }

      return resolution
    },

    async resolveDecision(req: ButlerResolveDecisionRequest): Promise<ButlerResolveDecisionResult> {
      const decisionId = req.decisionId?.trim() ?? ''
      const optionId = req.optionId?.trim() ?? ''
      if (!decisionId || !optionId) {
        return { ok: false, error: 'decisionId and optionId are required' }
      }

      const dIdx = getDecisionIndex(decisionId)
      if (dIdx < 0) {
        return { ok: false, error: `Decision not found: ${decisionId}` }
      }

      const decision = decisions[dIdx]!
      if (decision.status !== 'pending') {
        return { ok: false, error: `Decision is already ${decision.status}` }
      }

      if (!decision.options.some((opt) => opt.id === optionId)) {
        return { ok: false, error: `Invalid optionId "${optionId}" for decision ${decisionId}` }
      }

      const ts = nowFn()
      const trimmedNote = req.note?.trim()
      const resolution: ButlerDecisionResolution = {
        optionId,
        ...(trimmedNote ? { note: trimmedNote } : {}),
        resolvedAt: ts,
      }

      decisions[dIdx] = {
        ...decision,
        status: 'resolved',
        resolution,
      }

      if (decision.taskId) {
        const task = tasks.find((t) => t.id === decision.taskId)
        if (task && task.status === 'waiting_human') {
          const otherPending = decisions.some((d) => d.taskId === task.id && d.status === 'pending')
          if (!otherPending) {
            updateTask(task.id, (prev) => ({
              ...prev,
              status: 'running',
            }))
          }
        }
      }

      syncMissionStatus(decision.missionId)

      const chosenOption = decision.options.find((opt) => opt.id === optionId)
      const optionLabel = chosenOption?.label ?? optionId
      appendFeedEntry({
        role: 'system',
        text: trimmedNote
          ? `Decision resolved (${decision.title}): ${optionLabel} — ${trimmedNote}`
          : `Decision resolved (${decision.title}): ${optionLabel}`,
        missionId: decision.missionId,
        decisionId: decision.id,
        createdAt: ts,
      })

      commitState()

      const waiter = pendingWaiters.get(decision.id)
      if (waiter) {
        pendingWaiters.delete(decision.id)
        waiter.resolve(resolution)
      }

      return { ok: true }
    },

    async publishReport(input) {
      const headline = input.headline?.trim() ?? ''
      const summary = input.summary?.trim() ?? ''
      if (!headline || !summary) {
        return { ok: false, error: 'Report headline and summary are required' }
      }

      const mission = input.missionId
        ? missions.find((m) => m.id === input.missionId)
        : ((currentChiefMissionId
            ? missions.find((m) => m.id === currentChiefMissionId)
            : undefined) ??
          missions.find((m) => m.status === 'synthesizing') ??
          findLatestNonTerminalMission())

      if (!mission) {
        return { ok: false, error: 'Mission not found' }
      }
      if (mission.status === 'cancelled') {
        return { ok: false, error: 'Cannot publish report for a cancelled mission' }
      }

      const uniquePaths = new Map<string, string | undefined>()
      for (const item of input.artifactPaths ?? []) {
        const p = item.path?.trim()
        if (!p || uniquePaths.has(p)) continue
        uniquePaths.set(p, item.label?.trim())
      }

      const artifacts: ButlerArtifactRef[] = []
      for (const [artifactPath, customLabel] of uniquePaths) {
        const existsOnDisk = await checkPathExists(artifactPath)
        artifacts.push({
          path: artifactPath,
          label: customLabel || fileLabel(artifactPath),
          existsOnDisk,
        })
      }

      const ts = nowFn()
      const nextSuggestion = input.nextSuggestion?.trim()
      const report: ButlerMissionReport = {
        headline,
        summary,
        artifacts,
        risks: (input.risks ?? []).map((r) => r.trim()).filter(Boolean),
        ...(nextSuggestion ? { nextSuggestion } : {}),
        generatedAt: ts,
      }

      const updated = updateMission(mission.id, (prev) => ({
        ...prev,
        status: 'done',
        report,
        finishedAt: ts,
        updatedAt: ts,
      }))

      appendFeedEntry({
        role: 'butler',
        text: summary,
        missionId: mission.id,
        report,
        createdAt: ts,
      })

      commitState()
      if (updated) {
        deps.onMissionCompleted?.(cloneMission(updated), cloneReport(report))
      }
      return { ok: true, report: cloneReport(report) }
    },

    recordWorkerStep(sessionKey: string, step: ButlerStep | null, progressNote?: string): void {
      if (!isButlerWorkerSession(sessionKey)) return
      const task = findTaskBySession(sessionKey)
      if (!task || TERMINAL_TASK_STATUSES.has(task.status)) return

      const ts = nowFn()
      if (step === null) {
        taskStepStartedAt.delete(task.id)
      } else {
        taskStepStartedAt.set(task.id, ts)
      }

      updateTask(task.id, (prev) => ({
        ...prev,
        step: step ? { ...step } : null,
        lastActiveAt: ts,
        ...(step === null ? { health: 'normal' as const } : {}),
        ...(progressNote !== undefined ? { progressNote } : {}),
      }))
      commitState()
    },

    recordWorkerEvent(sessionKey: string, event: ButlerWorkerObservedEvent): void {
      if (!isButlerWorkerSession(sessionKey)) return
      const task = findTaskBySession(sessionKey)
      if (!task || TERMINAL_TASK_STATUSES.has(task.status)) return

      const ts = nowFn()
      const appendActivity = (
        prevLog: readonly ButlerWorkerActivityEntry[] | undefined,
        entry: Omit<ButlerWorkerActivityEntry, 'seq'>,
      ): readonly ButlerWorkerActivityEntry[] => {
        const lastSeq = prevLog && prevLog.length > 0 ? prevLog[prevLog.length - 1]!.seq : 0
        const nextEntry: ButlerWorkerActivityEntry = { seq: lastSeq + 1, ...entry }
        return [...(prevLog ?? []), nextEntry].slice(-MAX_ACTIVITY_LOG_ENTRIES)
      }

      if (event.type === 'tool-start') {
        const toolName = event.toolName.trim()
        if (!toolName) return
        const kind = event.kind ?? inferStepKindFallback(toolName)
        const callSummary = summarizeWorkerToolCall(toolName, event.input)
        const summary = callSummary || toolName
        taskStepStartedAt.set(task.id, ts)
        updateTask(task.id, (prev) => {
          const health: ButlerWorkerHealth = evaluateWorkerHealth({
            status: prev.status,
            startedAt: prev.startedAt,
            stepStartedAt: ts,
            consecutiveErrors: prev.consecutiveErrors,
            now: ts,
          })
          return {
            ...prev,
            step: { tool: toolName, kind },
            stepCount: (prev.stepCount ?? 0) + 1,
            lastActiveAt: ts,
            health,
            activityLog: appendActivity(prev.activityLog, {
              at: ts,
              kind,
              tool: toolName,
              summary,
            }),
          }
        })
        scheduleThrottledNotifySnapshot()
        return
      }

      if (event.type === 'tool-executed') {
        const toolName = event.toolName.trim()
        const isError = event.isError === true
        updateTask(task.id, (prev) => {
          const consecutiveErrors = isError ? (prev.consecutiveErrors ?? 0) + 1 : 0
          const stepStartedAt = taskStepStartedAt.get(prev.id) ?? prev.lastActiveAt ?? prev.startedAt
          const health: ButlerWorkerHealth = evaluateWorkerHealth({
            status: prev.status,
            startedAt: prev.startedAt,
            stepStartedAt,
            consecutiveErrors,
            now: ts,
          })
          const rawErr = redactTelemetrySecrets(event.summary?.trim() || `${toolName} failed`).replace(
            /\s+/g,
            ' ',
          )
          const errSummary =
            rawErr.length > 110 ? `${rawErr.slice(0, 109).trimEnd()}…` : rawErr
          return {
            ...prev,
            consecutiveErrors,
            lastActiveAt: ts,
            health,
            ...(isError
              ? {
                  activityLog: appendActivity(prev.activityLog, {
                    at: ts,
                    kind: 'error',
                    ...(toolName ? { tool: toolName } : {}),
                    summary: errSummary || 'Tool execution failed',
                    isError: true,
                  }),
                }
              : {}),
          }
        })
        scheduleThrottledNotifySnapshot()
        return
      }

      if (event.type === 'text') {
        const note = extractWorkerProgressNote(event.text)
        if (!note && task.lastActiveAt === ts) return
        updateTask(task.id, (prev) => {
          const stepStartedAt = taskStepStartedAt.get(prev.id) ?? prev.lastActiveAt ?? prev.startedAt
          const health: ButlerWorkerHealth = evaluateWorkerHealth({
            status: prev.status,
            startedAt: prev.startedAt,
            stepStartedAt,
            consecutiveErrors: prev.consecutiveErrors,
            now: ts,
          })
          return {
            ...prev,
            lastActiveAt: ts,
            health,
            ...(note ? { progressNote: note } : {}),
          }
        })
        scheduleThrottledNotifySnapshot()
        return
      }

      if (event.type === 'reasoning') {
        if (!taskStepStartedAt.has(task.id)) {
          taskStepStartedAt.set(task.id, ts)
        }
        const stepStartedAt = taskStepStartedAt.get(task.id)!
        updateTask(task.id, (prev) => ({
          ...prev,
          step: { tool: 'thinking', kind: 'think' },
          lastActiveAt: ts,
          health: evaluateWorkerHealth({
            status: prev.status,
            startedAt: prev.startedAt,
            stepStartedAt,
            consecutiveErrors: prev.consecutiveErrors,
            now: ts,
          }),
        }))
        scheduleThrottledNotifySnapshot()
      }
    },

    recoverWorkerRoleForSession(sessionKey: string): ButlerWorkerRole | null {
      const task = findTaskBySession(sessionKey)
      return task ? task.role : null
    },

    async whenIdle(): Promise<void> {
      while (true) {
        const busyNow =
          trackedBackgroundOps.size > 0 ||
          activeWorkers.size > 0 ||
          chiefBusy ||
          chiefPendingCount > 0 ||
          synthesizingMissions.size > 0

        if (!busyNow) {
          await persistChain
          const stillBusy =
            trackedBackgroundOps.size > 0 ||
            activeWorkers.size > 0 ||
            chiefBusy ||
            chiefPendingCount > 0 ||
            synthesizingMissions.size > 0
          if (!stillBusy) return
        }

        const ops = [...trackedBackgroundOps.values()]
        if (ops.length > 0) {
          await Promise.allSettled(ops)
        } else {
          await persistChain
          await Promise.resolve()
        }
      }
    },
  }

  return engine
}
