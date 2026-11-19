import {
  AgentLoop,
  composeSkills,
  createKnowledgeBaseSkill,
  type AgentSkill,
  type AgentTaskStatus,
  type AgentTaskStatusKind,
  type AgentToolDef,
} from '@genoffice/agent-core'
import type { AiSettings } from '@genoffice/ai-provider'
import { aiLangDirective } from '../i18n/locale'
import { createElectronTransport } from './transport'
import { createWorkbookSkill } from './workbook-skill'
import type { SheetsSkillDeps } from './tools'

/**
 * Headless document agent for Sheets: executes tasks delegated from the shell's
 * `document_agent` tool against the live Univer workbook without mounting the
 * in-app panel UI. Reuses `createWorkbookSkill` (with `create_document`
 * excluded) so every mutation lands through the same plan/apply path and
 * undo stack as interactive AI edits.
 */

const READY_POLL_MS = 80
const READY_SLOW_POLL_MS = 1_000
const READY_FAST_WINDOW_MS = 20_000
const STABLE_TIMEOUT_MS = 15_000
const MAX_CHECKPOINTS = 20

const STATUS_KIND_BY_TOOL: Record<string, AgentTaskStatusKind> = {
  get_workbook_context: 'reading',
  read_range: 'reading',
  read_cells: 'reading',
  read_formats: 'reading',
  read_sheet_features: 'reading',
  find_cells: 'reading',
  aggregate_range: 'reading',
  trace_precedents: 'reading',
  trace_dependents: 'reading',
  select_range: 'reading',
  load_guide: 'thinking',
  propose_operations: 'applying',
  image_search: 'image',
  generate_image: 'image',
}

const HEADLESS_EXCLUDED_TOOLS: ReadonlySet<string> = new Set(['create_document'])

const HEADLESS_TOOLS_NOTE = `

## Delegated-session mode
You are running as the spreadsheet assistant delegated from the global AI panel.
Inspect the sheet context/cells first, then apply edits with \`propose_operations\`.
Every batch applies immediately to the live workbook and is recorded in a Git-style
undo checkpoint. \`create_document\` is not available in this delegated session.`

const statusOfTool = (name: string): AgentTaskStatus => ({
  kind: STATUS_KIND_BY_TOOL[name] ?? 'other',
  tool: name,
})

export interface SheetsCheckpoint {
  mode: 'lazy' | 'demo'
  undoDepth: number
  adapterRev: number
}

export interface SheetsUndoPayload {
  mode: 'lazy' | 'demo'
  steps: number
}

export interface SheetsHeadlessAgentDeps {
  isReady: () => boolean
  isOpening?: () => boolean
  getSkillDeps: () => SheetsSkillDeps
  getSettings: () => Promise<AiSettings> | AiSettings
  captureCheckpoint: () => SheetsCheckpoint
  computeRollback: (before: SheetsCheckpoint) => SheetsUndoPayload | null
  restoreCheckpoint: (payload: SheetsUndoPayload) => Promise<{ ok: boolean; error?: string }>
  onMutated?: () => void
}

interface HeadlessOutcome {
  ok: boolean
  summary: string
  edits: Array<{ tool: string; summary: string }>
  checkpointId?: string
}

function headlessWorkbookSkill(deps: SheetsHeadlessAgentDeps): AgentSkill {
  const skill = createWorkbookSkill(deps.getSkillDeps())
  return {
    ...skill,
    get systemPrompt(): string {
      return skill.systemPrompt + HEADLESS_TOOLS_NOTE
    },
    get tools(): AgentToolDef[] {
      return skill.tools.filter((tool) => !HEADLESS_EXCLUDED_TOOLS.has(tool.name))
    },
  }
}

async function waitUntilStable(deps: SheetsHeadlessAgentDeps): Promise<void> {
  if (!deps.isOpening?.() && deps.isReady()) return
  const deadline = Date.now() + STABLE_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!deps.isOpening?.() && deps.isReady()) return
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
}

async function runTask(
  deps: SheetsHeadlessAgentDeps,
  task: string,
  onProgress: (status: AgentTaskStatus) => void,
  registerCancel: (cancel: () => void) => void,
  saveRollback: (payload: SheetsUndoPayload) => string,
): Promise<HeadlessOutcome> {
  await waitUntilStable(deps)
  if (!deps.isReady()) {
    return { ok: false, summary: 'the spreadsheet is not ready', edits: [] }
  }
  const settings = await deps.getSettings()
  const checkpointBefore = deps.captureCheckpoint()
  const edits: Array<{ tool: string; summary: string }> = []
  const loop = new AgentLoop({
    transport: createElectronTransport(() => settings),
    systemSuffix: aiLangDirective,
    confirmTool: async () => true,
    skill: composeSkills('sheets-headless', '', [
      ...(typeof window.desktopApi?.kbList === 'function'
        ? [
            createKnowledgeBaseSkill({
              listFiles: () => [],
              search: (query, limit) => window.desktopApi.kbSearch({ q: query, limit }),
              read: (path, offset) => window.desktopApi.kbRead(path, offset),
            }),
          ]
        : []),
      headlessWorkbookSkill(deps),
    ]),
    events: {
      onToolStart: (call) => onProgress(statusOfTool(call.name)),
      onToolExecuted: ({ call, execution }) => {
        if (execution.mutated) {
          edits.push({ tool: call.name, summary: execution.summary })
        }
        onProgress(statusOfTool(call.name))
      },
    },
  })

  try {
    const handle = loop.run(task)
    registerCancel(() => handle.cancel())
    const result = await handle.done
    const rollback = edits.length > 0 ? deps.computeRollback(checkpointBefore) : null
    const checkpointId = rollback && rollback.steps > 0 ? saveRollback(rollback) : undefined
    if (edits.length > 0) deps.onMutated?.()
    if (result.cancelled) {
      return {
        ok: false,
        summary: 'the task was stopped before it finished',
        edits,
        ...(checkpointId ? { checkpointId } : {}),
      }
    }
    return {
      ok: true,
      summary: result.text,
      edits,
      ...(checkpointId ? { checkpointId } : {}),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, summary: message, edits }
  }
}

export function installHeadlessAgentBridge(deps: SheetsHeadlessAgentDeps): () => void {
  const api = window.desktopApi
  if (!api?.onAgentTaskCommand || !api.reportAgentTaskResult) return () => {}
  let disposed = false
  let readyTimer: ReturnType<typeof setTimeout> | null = null
  let cancelCurrent: (() => void) | null = null
  let currentTaskId: string | null = null
  let checkpointSeq = 0
  const checkpoints = new Map<string, SheetsUndoPayload>()

  const saveRollback = (payload: SheetsUndoPayload): string => {
    const id = `sheets-cp-${++checkpointSeq}`
    checkpoints.set(id, payload)
    while (checkpoints.size > MAX_CHECKPOINTS) {
      const oldest = checkpoints.keys().next().value
      if (oldest === undefined) break
      checkpoints.delete(oldest)
    }
    return id
  }

  const mountedAt = performance.now()
  const announceReady = (): void => {
    readyTimer = null
    if (disposed) return
    if (deps.isReady() && !deps.isOpening?.()) {
      api.signalAgentReady()
      return
    }
    const slow = performance.now() - mountedAt > READY_FAST_WINDOW_MS
    readyTimer = setTimeout(announceReady, slow ? READY_SLOW_POLL_MS : READY_POLL_MS)
  }
  readyTimer = setTimeout(announceReady, READY_POLL_MS)

  const unsubscribeCommands = api.onAgentTaskCommand(async (message) => {
    if (!message || typeof message.taskId !== 'string' || typeof message.task !== 'string') return
    if (currentTaskId !== null) {
      api.reportAgentTaskResult({
        taskId: message.taskId,
        ok: false,
        summary: 'this spreadsheet is already running a task',
      })
      return
    }
    const taskId = message.taskId
    currentTaskId = taskId
    cancelCurrent = null
    const outcome = await runTask(
      deps,
      message.task,
      (status) => api.reportAgentTaskProgress({ taskId, status }),
      (cancel) => (cancelCurrent = cancel),
      saveRollback,
    )
    currentTaskId = null
    cancelCurrent = null
    api.reportAgentTaskResult({
      taskId,
      ok: outcome.ok,
      summary: outcome.summary,
      edits: outcome.edits,
      ...(outcome.checkpointId ? { checkpointId: outcome.checkpointId } : {}),
    })
  })

  const unsubscribeAborts = api.onAgentTaskAbort((message) => {
    if (message && typeof message.taskId === 'string' && message.taskId === currentTaskId) {
      cancelCurrent?.()
    }
  })

  const unsubscribeUndo = api.onAgentUndo?.(async (message) => {
    if (!message || typeof message.undoId !== 'string' || typeof message.checkpointId !== 'string') {
      return
    }
    if (currentTaskId !== null) {
      api.reportAgentUndoResult?.({
        undoId: message.undoId,
        ok: false,
        error: 'a task is currently running in this spreadsheet',
      })
      return
    }
    const payload = checkpoints.get(message.checkpointId)
    if (!payload) {
      api.reportAgentUndoResult?.({
        undoId: message.undoId,
        ok: false,
        error: 'checkpoint is no longer available',
      })
      return
    }
    try {
      const result = await deps.restoreCheckpoint(payload)
      if (result.ok) {
        checkpoints.delete(message.checkpointId)
        api.reportAgentUndoResult?.({ undoId: message.undoId, ok: true })
      } else {
        api.reportAgentUndoResult?.({
          undoId: message.undoId,
          ok: false,
          error: result.error ?? 'failed to undo spreadsheet changes',
        })
      }
    } catch (error) {
      api.reportAgentUndoResult?.({
        undoId: message.undoId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  return () => {
    disposed = true
    if (readyTimer !== null) clearTimeout(readyTimer)
    unsubscribeCommands()
    unsubscribeAborts()
    unsubscribeUndo?.()
    cancelCurrent?.()
  }
}
