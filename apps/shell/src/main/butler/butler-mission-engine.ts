import { randomBytes } from 'node:crypto'
import { stat } from 'node:fs/promises'

import type { ButlerStep } from '../../shared/butler-api'
import {
  BUTLER_CHIEF_PROJECT_ID,
  BUTLER_CHIEF_SESSION_KEY,
  BUTLER_WORKER_CHAT_PREFIX,
  isButlerWorkerSession,
  type ButlerActionResult,
  type ButlerArtifactRef,
  type ButlerConversationEntry,
  type ButlerDecisionItem,
  type ButlerDecisionOption,
  type ButlerDecisionResolution,
  type ButlerDelegateResult,
  type ButlerDeskSnapshot,
  type ButlerMission,
  type ButlerMissionReport,
  type ButlerMissionStatus,
  type ButlerResolveDecisionRequest,
  type ButlerResolveDecisionResult,
  type ButlerSteerTaskRequest,
  type ButlerSubTask,
  type ButlerSubTaskStatus,
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
  readonly onDecisionCreated?: (decision: ButlerDecisionItem, task: ButlerSubTask | null) => void
  readonly onMissionCompleted?: (mission: ButlerMission, report: ButlerMissionReport) => void
  readonly now?: () => number
}

export interface ButlerMissionEngine {
  init(): Promise<ButlerDeskSnapshot>
  dispose(): Promise<void>
  getSnapshot(): ButlerDeskSnapshot
  delegate(goal: string, workdir?: string): Promise<ButlerDelegateResult>
  dispatchTask(input: {
    readonly id?: string
    readonly missionId?: string
    readonly title: string
    readonly brief: string
    readonly role?: ButlerWorkerRole
    readonly dependsOn?: readonly string[]
    readonly scopePaths?: readonly string[]
    readonly workdir?: string
  }): Promise<{ readonly ok: boolean; readonly task?: ButlerSubTask; readonly error?: string }>
  listTasks(missionId?: string): readonly ButlerSubTask[]
  inspectTask(
    taskId: string,
  ): { readonly task: ButlerSubTask; readonly decisions: readonly ButlerDecisionItem[] } | null
  steerTask(req: ButlerSteerTaskRequest): Promise<ButlerActionResult>
  cancelTask(taskId: string): Promise<ButlerActionResult>
  cancelMission(missionId: string): Promise<ButlerActionResult>
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

function cloneMission(m: ButlerMission): ButlerMission {
  return {
    ...m,
    taskIds: [...m.taskIds],
    ...(m.report ? { report: cloneReport(m.report) } : {}),
  }
}

function cloneTask(t: ButlerSubTask): ButlerSubTask {
  return {
    ...t,
    dependsOn: [...t.dependsOn],
    ...(t.scopePaths ? { scopePaths: [...t.scopePaths] } : {}),
    step: t.step ? { ...t.step } : null,
    artifacts: t.artifacts.map(cloneArtifact),
  }
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
  const planningMissions = new Set<string>()
  const synthesizingMissions = new Set<string>()
  const activeWorkers = new Map<string, ActiveWorkerRun>()
  const pendingWaiters = new Map<string, PendingDecisionWaiter>()
  const trackedBackgroundOps = new Map<symbol, Promise<void>>()

  let chiefBusy = false
  let chiefPendingCount = 0
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

  const findTaskBySession = (sessionKey: string): ButlerSubTask | undefined => {
    for (let i = tasks.length - 1; i >= 0; i -= 1) {
      const t = tasks[i]!
      if (t.sessionKey === sessionKey) return t
    }
    return undefined
  }

  const buildSnapshot = (): ButlerDeskSnapshot => ({
    chiefSessionKey: BUTLER_CHIEF_SESSION_KEY,
    chiefBusy,
    missions: missions.map(cloneMission),
    tasks: tasks.map(cloneTask),
    decisions: decisions.map(cloneDecision),
    feed: feed.map(cloneFeedEntry),
    concurrency: {
      running: tasks.filter((t) => t.status === 'running').length,
      maxConcurrent,
      queued: tasks.filter((t) => t.status === 'queued').length,
    },
  })

  const notifySnapshot = (): void => {
    if (disposed) return
    deps.onSnapshotUpdated?.(buildSnapshot())
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

          updateTask(taskSnapshot.id, (prev) => ({
            ...prev,
            status: 'done',
            step: null,
            outputSummary,
            artifacts,
            error: undefined,
            finishedAt: nowFn(),
          }))
        } else {
          const errorText =
            res.error?.trim() || (res.aborted ? 'Task aborted' : 'Worker execution failed')
          updateTask(taskSnapshot.id, (prev) => ({
            ...prev,
            status: 'failed',
            step: null,
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

      const started = updateTask(task.id, (prev) => ({
        ...prev,
        status: 'running',
        step: null,
        startedAt: prev.startedAt ?? nowFn(),
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

  return {
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
      const missionId = newId('mission')
      const mission: ButlerMission = {
        id: missionId,
        title: deriveTitle(trimmedGoal, missionId),
        goal: trimmedGoal,
        status: 'planning',
        createdAt: ts,
        updatedAt: ts,
        taskIds: [],
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

      enqueueChiefOp(missionId, async () => {
        try {
          const current = missions.find((m) => m.id === missionId)
          if (!current || current.status === 'cancelled' || disposed) return

          const prompt = buildPlanningPrompt(missionId, trimmedGoal, resolvedWorkdir)
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

      return { ok: true, missionId }
    },

    async dispatchTask(input): Promise<{
      readonly ok: boolean
      readonly task?: ButlerSubTask
      readonly error?: string
    }> {
      if (disposed) {
        return { ok: false, error: 'Engine disposed' }
      }

      const title = input.title?.trim() ?? ''
      const brief = input.brief?.trim() ?? ''
      if (!title || !brief) {
        return { ok: false, error: 'Task title and brief are required' }
      }

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
        mission = findLatestNonTerminalMission()
        if (!mission) {
          const ts = nowFn()
          const implicitId = newId('mission')
          mission = {
            id: implicitId,
            title: deriveTitle(title, implicitId),
            goal: brief,
            status: 'running',
            createdAt: ts,
            updatedAt: ts,
            taskIds: [],
          }
          missionWorkdirById.set(implicitId, input.workdir?.trim() || deps.defaultWorkdir?.())
          missions.push(mission)
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
        role: input.role ?? 'general',
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
        task: cloneTask(task),
        decisions: decisions.filter((d) => d.taskId === taskId).map(cloneDecision),
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

        updateTask(taskId, (prev) => ({
          ...prev,
          status: 'queued',
          step: null,
          error: undefined,
          finishedAt: undefined,
        }))
        syncMissionStatus(task.missionId)
        commitState()
        scheduleReadyTasks()
        return { ok: true }
      }

      if (task.status === 'interrupted' || task.status === 'failed') {
        updateTask(taskId, (prev) => ({
          ...prev,
          status: 'queued',
          step: null,
          error: undefined,
          finishedAt: undefined,
        }))

        if (
          mission &&
          (mission.status === 'failed' ||
            mission.status === 'interrupted' ||
            mission.status === 'done')
        ) {
          updateMission(mission.id, (prev) => ({
            ...prev,
            status: 'running',
            error: undefined,
            finishedAt: undefined,
            report: undefined,
            updatedAt: nowFn(),
          }))
        } else {
          syncMissionStatus(task.missionId)
        }

        commitState()
        scheduleReadyTasks()
        return { ok: true }
      }

      // 'queued' or 'waiting_human': steer instruction is saved and broadcast;
      // waiting_human tasks resume with the updated context once the decision resolves.
      commitState()
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

      updateTask(taskId, (prev) => ({
        ...prev,
        status: 'cancelled',
        step: null,
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
      const mission = missions.find((m) => m.id === missionId)
      if (!mission) {
        return { ok: false, error: `Mission not found: ${missionId}` }
      }
      if (mission.status === 'cancelled') {
        return { ok: true }
      }

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

        tasks[i] = {
          ...t,
          status: 'cancelled',
          step: null,
          finishedAt: ts,
        }
      }

      resolvePendingWaitersFor((d) => d.missionId === missionId, 'cancelled', 'Mission cancelled')

      if (currentChiefMissionId === missionId) {
        sessionsToAbort.push(BUTLER_CHIEF_SESSION_KEY)
      }

      updateMission(missionId, (prev) => ({
        ...prev,
        status: 'cancelled',
        finishedAt: ts,
        updatedAt: ts,
      }))

      for (const sk of sessionsToAbort) {
        await Promise.resolve(deps.abortSession(sk)).catch(() => {})
      }

      appendFeedEntry({
        role: 'system',
        text: `Cancelled mission "${mission.title}".`,
        missionId,
        createdAt: ts,
      })

      commitState()
      return { ok: true }
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

      updateTask(task.id, (prev) => ({
        ...prev,
        step: step ? { ...step } : null,
        ...(progressNote !== undefined ? { progressNote } : {}),
      }))
      commitState()
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
}
