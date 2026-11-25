import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { ButlerStep, ButlerStepKind } from '../../shared/butler-api'
import type {
  ButlerArtifactRef,
  ButlerConversationEntry,
  ButlerDecisionItem,
  ButlerDecisionKind,
  ButlerDecisionOption,
  ButlerDecisionResolution,
  ButlerMission,
  ButlerMissionPlan,
  ButlerMissionReport,
  ButlerMissionStatus,
  ButlerProposedTaskStep,
  ButlerSubTask,
  ButlerSubTaskStatus,
  ButlerWorkerRole,
} from '../../shared/butler-orchestrator-api'
import { atomicWriteFile } from '../atomic-write'

const BUTLER_MISSIONS_FILENAME = 'butler-missions.json'
const MAX_PERSISTED_MISSIONS = 30
const MAX_PERSISTED_FEED = 200

const VALID_WORKER_ROLES = new Set<ButlerWorkerRole>([
  'general',
  'research',
  'docs',
  'sheets',
  'slides',
  'browser',
])

const VALID_MISSION_STATUSES = new Set<ButlerMissionStatus>([
  'clarifying',
  'awaiting_plan_approval',
  'planning',
  'running',
  'waiting_human',
  'synthesizing',
  'done',
  'failed',
  'cancelled',
  'interrupted',
])

// Only in-flight execution states with active runtime turns recover as interrupted;
// 'clarifying' and 'awaiting_plan_approval' hold no active child turns and survive restart intact.
const RECOVERABLE_MISSION_STATUSES = new Set<ButlerMissionStatus>([
  'planning',
  'running',
  'waiting_human',
  'synthesizing',
])

const VALID_TASK_STATUSES = new Set<ButlerSubTaskStatus>([
  'queued',
  'running',
  'waiting_human',
  'done',
  'failed',
  'cancelled',
  'interrupted',
])

const NON_TERMINAL_TASK_STATUSES = new Set<ButlerSubTaskStatus>([
  'queued',
  'running',
  'waiting_human',
])

const VALID_DECISION_KINDS = new Set<ButlerDecisionKind>(['permission', 'choice', 'recovery'])

const VALID_DECISION_STATUSES = new Set<ButlerDecisionItem['status']>([
  'pending',
  'resolved',
  'expired',
  'cancelled',
])

const VALID_STEP_KINDS = new Set<ButlerStepKind>([
  'read',
  'search',
  'browse',
  'edit',
  'create',
  'command',
  'think',
  'other',
])

export interface ButlerPersistedMissions {
  readonly version: 1
  readonly missions: readonly ButlerMission[]
  readonly tasks: readonly ButlerSubTask[]
  readonly decisions: readonly ButlerDecisionItem[]
  readonly feed: readonly ButlerConversationEntry[]
  readonly updatedAt: number
}

const EMPTY_PERSISTED_MISSIONS: ButlerPersistedMissions = {
  version: 1,
  missions: [],
  tasks: [],
  decisions: [],
  feed: [],
  updatedAt: 0,
}

/** Resolve the persisted Butler missions state file path inside `userDataDir`. */
export function butlerMissionsPath(userDataDir: string): string {
  return join(userDataDir, BUTLER_MISSIONS_FILENAME)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeStringArray(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function normalizeArtifactRef(raw: unknown): ButlerArtifactRef | null {
  if (!isRecord(raw)) return null
  const path = asNonEmptyString(raw.path)
  if (!path) return null
  const label = typeof raw.label === 'string' && raw.label.trim().length > 0 ? raw.label : path
  return {
    path,
    label,
    existsOnDisk: raw.existsOnDisk === true,
  }
}

function normalizeArtifactArray(raw: unknown): readonly ButlerArtifactRef[] {
  if (!Array.isArray(raw)) return []
  const list: ButlerArtifactRef[] = []
  for (const item of raw) {
    const ref = normalizeArtifactRef(item)
    if (ref) list.push(ref)
  }
  return list
}

function normalizeReport(raw: unknown): ButlerMissionReport | undefined {
  if (!isRecord(raw)) return undefined
  if (typeof raw.headline !== 'string' || typeof raw.summary !== 'string') return undefined
  const generatedAt = asFiniteNumber(raw.generatedAt)
  if (generatedAt === null) return undefined
  return {
    headline: raw.headline,
    summary: raw.summary,
    artifacts: normalizeArtifactArray(raw.artifacts),
    risks: normalizeStringArray(raw.risks),
    ...(typeof raw.nextSuggestion === 'string' && raw.nextSuggestion.trim().length > 0
      ? { nextSuggestion: raw.nextSuggestion }
      : {}),
    generatedAt,
  }
}

function normalizeStep(raw: unknown): ButlerStep | null {
  if (!isRecord(raw)) return null
  const tool = asNonEmptyString(raw.tool)
  if (!tool) return null
  const kind =
    typeof raw.kind === 'string' && VALID_STEP_KINDS.has(raw.kind as ButlerStepKind)
      ? (raw.kind as ButlerStepKind)
      : 'other'
  return { tool, kind }
}

function normalizeProposedStep(raw: unknown): ButlerProposedTaskStep | null {
  if (!isRecord(raw)) return null
  const id = asNonEmptyString(raw.id)
  const title = asNonEmptyString(raw.title)
  const brief = asNonEmptyString(raw.brief)
  if (!id || !title || !brief) return null
  const role: ButlerWorkerRole =
    typeof raw.role === 'string' && VALID_WORKER_ROLES.has(raw.role as ButlerWorkerRole)
      ? (raw.role as ButlerWorkerRole)
      : 'general'
  const scopePaths = Array.isArray(raw.scopePaths)
    ? normalizeStringArray(raw.scopePaths)
    : undefined
  return {
    id,
    title,
    brief,
    role,
    dependsOn: normalizeStringArray(raw.dependsOn),
    ...(scopePaths && scopePaths.length > 0 ? { scopePaths } : {}),
  }
}

function normalizeMissionPlan(raw: unknown): ButlerMissionPlan | undefined {
  if (!isRecord(raw)) return undefined
  const summary = asNonEmptyString(raw.summary)
  const updatedAt = asFiniteNumber(raw.updatedAt)
  if (!summary || updatedAt === null || !Array.isArray(raw.steps)) return undefined

  const steps: ButlerProposedTaskStep[] = []
  for (const item of raw.steps) {
    const step = normalizeProposedStep(item)
    if (step) steps.push(step)
  }
  if (steps.length === 0) return undefined

  const rawRevision = asFiniteNumber(raw.revision)
  const revision = rawRevision !== null && rawRevision >= 1 ? Math.round(rawRevision) : 1
  const approvedAt = asFiniteNumber(raw.approvedAt)

  return {
    summary,
    steps,
    revision,
    updatedAt,
    ...(approvedAt !== null ? { approvedAt } : {}),
  }
}

function normalizeMission(raw: unknown, onRecover: () => void): ButlerMission | null {
  if (!isRecord(raw)) return null
  const id = asNonEmptyString(raw.id)
  const goal = asNonEmptyString(raw.goal)
  const createdAt = asFiniteNumber(raw.createdAt)
  const updatedAt = asFiniteNumber(raw.updatedAt)
  if (!id || !goal || createdAt === null || updatedAt === null) return null

  const rawStatus =
    typeof raw.status === 'string' && VALID_MISSION_STATUSES.has(raw.status as ButlerMissionStatus)
      ? (raw.status as ButlerMissionStatus)
      : null
  if (!rawStatus) return null

  let status: ButlerMissionStatus = rawStatus
  if (RECOVERABLE_MISSION_STATUSES.has(rawStatus)) {
    status = 'interrupted'
    onRecover()
  }

  const title = typeof raw.title === 'string' && raw.title.trim().length > 0 ? raw.title : goal
  const finishedAt = asFiniteNumber(raw.finishedAt)
  const conversationNotes = normalizeStringArray(raw.conversationNotes)
  const plan = normalizeMissionPlan(raw.plan)
  const report = normalizeReport(raw.report)

  return {
    id,
    title,
    goal,
    status,
    createdAt,
    updatedAt,
    ...(finishedAt !== null ? { finishedAt } : {}),
    taskIds: normalizeStringArray(raw.taskIds),
    ...(conversationNotes.length > 0 ? { conversationNotes } : {}),
    ...(plan ? { plan } : {}),
    ...(report ? { report } : {}),
    ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
  }
}

function normalizeSubTask(raw: unknown, onRecover: () => void): ButlerSubTask | null {
  if (!isRecord(raw)) return null
  const id = asNonEmptyString(raw.id)
  const missionId = asNonEmptyString(raw.missionId)
  const sessionKey = asNonEmptyString(raw.sessionKey)
  const createdAt = asFiniteNumber(raw.createdAt)
  if (!id || !missionId || !sessionKey || createdAt === null) return null
  if (typeof raw.title !== 'string' || typeof raw.brief !== 'string') return null

  const rawStatus =
    typeof raw.status === 'string' && VALID_TASK_STATUSES.has(raw.status as ButlerSubTaskStatus)
      ? (raw.status as ButlerSubTaskStatus)
      : null
  if (!rawStatus) return null

  let status: ButlerSubTaskStatus = rawStatus
  let step: ButlerStep | null = normalizeStep(raw.step)
  if (NON_TERMINAL_TASK_STATUSES.has(rawStatus)) {
    status = 'interrupted'
    step = null
    onRecover()
  }

  const role: ButlerWorkerRole =
    typeof raw.role === 'string' && VALID_WORKER_ROLES.has(raw.role as ButlerWorkerRole)
      ? (raw.role as ButlerWorkerRole)
      : 'general'

  const startedAt = asFiniteNumber(raw.startedAt)
  const finishedAt = asFiniteNumber(raw.finishedAt)
  const scopePaths = Array.isArray(raw.scopePaths)
    ? normalizeStringArray(raw.scopePaths)
    : undefined

  return {
    id,
    missionId,
    title: raw.title,
    brief: raw.brief,
    role,
    dependsOn: normalizeStringArray(raw.dependsOn),
    ...(scopePaths !== undefined ? { scopePaths } : {}),
    sessionKey,
    status,
    step,
    ...(typeof raw.progressNote === 'string' ? { progressNote: raw.progressNote } : {}),
    ...(typeof raw.outputSummary === 'string' ? { outputSummary: raw.outputSummary } : {}),
    artifacts: normalizeArtifactArray(raw.artifacts),
    ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
    createdAt,
    ...(startedAt !== null ? { startedAt } : {}),
    ...(finishedAt !== null ? { finishedAt } : {}),
  }
}

function normalizeDecisionOption(raw: unknown): ButlerDecisionOption | null {
  if (!isRecord(raw)) return null
  const id = asNonEmptyString(raw.id)
  if (!id || typeof raw.label !== 'string') return null
  const style =
    raw.style === 'primary' || raw.style === 'default' || raw.style === 'danger'
      ? raw.style
      : undefined
  return {
    id,
    label: raw.label,
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    ...(style ? { style } : {}),
  }
}

function normalizeDecisionResolution(raw: unknown): ButlerDecisionResolution | undefined {
  if (!isRecord(raw)) return undefined
  const optionId = asNonEmptyString(raw.optionId)
  const resolvedAt = asFiniteNumber(raw.resolvedAt)
  if (!optionId || resolvedAt === null) return undefined
  return {
    optionId,
    ...(typeof raw.note === 'string' ? { note: raw.note } : {}),
    resolvedAt,
  }
}

function normalizeDecision(raw: unknown, onRecover: () => void): ButlerDecisionItem | null {
  if (!isRecord(raw)) return null
  const id = asNonEmptyString(raw.id)
  const missionId = asNonEmptyString(raw.missionId)
  const sessionKey = asNonEmptyString(raw.sessionKey)
  const createdAt = asFiniteNumber(raw.createdAt)
  if (!id || !missionId || !sessionKey || createdAt === null) return null
  if (
    typeof raw.taskId !== 'string' ||
    typeof raw.title !== 'string' ||
    typeof raw.summary !== 'string'
  ) {
    return null
  }

  const kind =
    typeof raw.kind === 'string' && VALID_DECISION_KINDS.has(raw.kind as ButlerDecisionKind)
      ? (raw.kind as ButlerDecisionKind)
      : null
  const rawStatus =
    typeof raw.status === 'string' &&
    VALID_DECISION_STATUSES.has(raw.status as ButlerDecisionItem['status'])
      ? (raw.status as ButlerDecisionItem['status'])
      : null
  if (!kind || !rawStatus) return null

  let status = rawStatus
  if (rawStatus === 'pending') {
    status = 'expired'
    onRecover()
  }

  const options: ButlerDecisionOption[] = []
  if (Array.isArray(raw.options)) {
    for (const opt of raw.options) {
      const normalized = normalizeDecisionOption(opt)
      if (normalized) options.push(normalized)
    }
  }

  const resolution = normalizeDecisionResolution(raw.resolution)

  return {
    id,
    missionId,
    taskId: raw.taskId,
    sessionKey,
    kind,
    title: raw.title,
    summary: raw.summary,
    ...(typeof raw.detail === 'string' ? { detail: raw.detail } : {}),
    ...(typeof raw.toolName === 'string' ? { toolName: raw.toolName } : {}),
    ...(typeof raw.confirmRequestId === 'string' ? { confirmRequestId: raw.confirmRequestId } : {}),
    ...(typeof raw.sessionAllowable === 'boolean'
      ? { sessionAllowable: raw.sessionAllowable }
      : {}),
    options,
    status,
    ...(resolution ? { resolution } : {}),
    createdAt,
  }
}

function normalizeFeedEntry(raw: unknown): ButlerConversationEntry | null {
  if (!isRecord(raw)) return null
  const id = asNonEmptyString(raw.id)
  const createdAt = asFiniteNumber(raw.createdAt)
  if (!id || createdAt === null || typeof raw.text !== 'string') return null
  if (raw.role !== 'user' && raw.role !== 'butler' && raw.role !== 'system') return null
  const report = normalizeReport(raw.report)
  return {
    id,
    role: raw.role,
    text: raw.text,
    ...(typeof raw.missionId === 'string' ? { missionId: raw.missionId } : {}),
    ...(report ? { report } : {}),
    ...(typeof raw.decisionId === 'string' ? { decisionId: raw.decisionId } : {}),
    createdAt,
  }
}

function retainNewestByCreatedAt<T extends { readonly createdAt: number }>(
  items: readonly T[],
  limit: number,
): readonly T[] {
  if (items.length <= limit) return items
  const rankedIndices = items
    .map((item, index) => ({ createdAt: item.createdAt, index }))
    .sort((a, b) => (b.createdAt !== a.createdAt ? b.createdAt - a.createdAt : b.index - a.index))
    .slice(0, limit)
    .map((entry) => entry.index)
  const keepIndices = new Set(rankedIndices)
  return items.filter((_, index) => keepIndices.has(index))
}

function trimPersistedState(state: ButlerPersistedMissions): ButlerPersistedMissions {
  const missions = retainNewestByCreatedAt(state.missions, MAX_PERSISTED_MISSIONS)
  const keptMissionIds = new Set(missions.map((m) => m.id))
  const tasks = state.tasks.filter((t) => keptMissionIds.has(t.missionId))
  const decisions = state.decisions.filter((d) => keptMissionIds.has(d.missionId))
  const feed = retainNewestByCreatedAt(state.feed, MAX_PERSISTED_FEED)

  return {
    version: 1,
    missions,
    tasks,
    decisions,
    feed,
    updatedAt: Number.isFinite(state.updatedAt) ? state.updatedAt : 0,
  }
}

/**
 * Read and validate `<userDataDir>/butler-missions.json`.
 * Non-terminal missions/tasks and pending decisions left behind by an unexpected
 * exit are marked `interrupted` / `expired` with `recovered: true`.
 */
export async function readButlerMissionState(
  filePath: string,
): Promise<ButlerPersistedMissions & { readonly recovered: boolean }> {
  let rawText: string
  try {
    rawText = await readFile(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { ...EMPTY_PERSISTED_MISSIONS, recovered: false }
    }
    return { ...EMPTY_PERSISTED_MISSIONS, recovered: false }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch {
    return { ...EMPTY_PERSISTED_MISSIONS, recovered: false }
  }

  if (!isRecord(parsed) || parsed.version !== 1) {
    return { ...EMPTY_PERSISTED_MISSIONS, recovered: false }
  }

  let recovered = false
  const markRecovered = (): void => {
    recovered = true
  }

  const missions: ButlerMission[] = []
  if (Array.isArray(parsed.missions)) {
    for (const item of parsed.missions) {
      const m = normalizeMission(item, markRecovered)
      if (m) missions.push(m)
    }
  }

  const tasks: ButlerSubTask[] = []
  if (Array.isArray(parsed.tasks)) {
    for (const item of parsed.tasks) {
      const t = normalizeSubTask(item, markRecovered)
      if (t) tasks.push(t)
    }
  }

  const decisions: ButlerDecisionItem[] = []
  if (Array.isArray(parsed.decisions)) {
    for (const item of parsed.decisions) {
      const d = normalizeDecision(item, markRecovered)
      if (d) decisions.push(d)
    }
  }

  const feed: ButlerConversationEntry[] = []
  if (Array.isArray(parsed.feed)) {
    for (const item of parsed.feed) {
      const f = normalizeFeedEntry(item)
      if (f) feed.push(f)
    }
  }

  const updatedAt = asFiniteNumber(parsed.updatedAt) ?? 0

  return {
    version: 1,
    missions,
    tasks,
    decisions,
    feed,
    updatedAt,
    recovered,
  }
}

/**
 * Atomically persist Butler missions state, capping retained missions at 30
 * (with their associated tasks/decisions) and conversation feed at 200 entries.
 */
export async function writeButlerMissionState(
  filePath: string,
  state: ButlerPersistedMissions,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const trimmed = trimPersistedState(state)
  await atomicWriteFile(filePath, Buffer.from(JSON.stringify(trimmed, null, 2), 'utf8'))
}
