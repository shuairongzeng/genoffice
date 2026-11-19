import {
  AgentLoop,
  composeSkills,
  createKnowledgeBaseSkill,
  type AgentSkill,
  type AgentTaskStatus,
  type AgentTaskStatusKind,
  type AgentToolDef,
} from '@genoffice/agent-core'
import { imageGenerationAvailable, mediaAnalysisAvailable } from '@genoffice/ai-provider/browser'
import type { RenderSlide } from '@genoffice/pptx-render'
import type { AiSettings } from '../../shared/ipc'
import { aiLangDirective } from '../i18n/locale'
import { createSlidesDeckAccess } from './deck-access-factory'
import { createSlidesSkill } from './slides-skill'
import { createElectronTransport } from './transport'

/**
 * Headless document agent for Slides: executes delegated tasks from the shell's
 * `document_agent` tool against the live presentation without mounting the
 * in-app panel UI. Reuses `createSlidesSkill` (excluding interactive
 * `ask_clarification`) wrapped inside a main-process history batch so every
 * delegated edit lands atomically on the live undo/snapshot stack.
 */

const READY_POLL_MS = 80
const READY_SLOW_POLL_MS = 1_000
const READY_FAST_WINDOW_MS = 20_000
const MAX_CHECKPOINTS = 20

const STATUS_KIND_BY_TOOL: Record<string, AgentTaskStatusKind> = {
  read_slide: 'reading',
  list_style_templates: 'reading',
  load_guide: 'thinking',
  plan_deck: 'thinking',
  execute_slide_script: 'writing',
  execute_layout_script: 'writing',
  apply_ops: 'writing',
  edit_chart: 'writing',
  regenerate_slide: 'writing',
  generate_deck: 'writing',
  save_style_template: 'writing',
  web_search: 'image',
  image_search: 'image',
  generate_image: 'image',
  analyze_media: 'image',
  insert_web_image: 'image',
  replace_image: 'image',
}

const HEADLESS_EXCLUDED_TOOLS: ReadonlySet<string> = new Set(['ask_clarification'])

const HEADLESS_TOOLS_NOTE = `

## Delegated-session mode
You are running as the presentation assistant delegated from the global AI panel.
Inspect the deck outline or slides first, then apply edits using slide tools directly.
Every delegated run executes inside a history batch so all edits apply to the live
presentation and can be undone atomically via a Git-style checkpoint. Interactive
clarification dialogs (\`ask_clarification\`) are unavailable in this delegated session;
choose sensible defaults when details are underspecified.`

const statusOfTool = (name: string): AgentTaskStatus => ({
  kind: STATUS_KIND_BY_TOOL[name] ?? 'other',
  tool: name,
})

export interface SlidesHeadlessAgentDeps {
  isReady: () => boolean
  getSlides: () => RenderSlide[]
  getCurrent: () => number
  getSelectedIds: () => string[]
  applySlide: (slideIndex: number, updated: RenderSlide) => void
  applyDeck: (all: RenderSlide[], goTo?: number) => void
  fitWidthPx: number
  onBeforeRun?: () => Promise<void> | void
  onPathChange?: (path: string) => void
  onMutated?: () => void
}

interface HeadlessOutcome {
  ok: boolean
  summary: string
  edits: Array<{ tool: string; summary: string }>
  checkpointId?: string
}

function headlessSlidesSkill(
  deps: SlidesHeadlessAgentDeps,
  getSettings: () => AiSettings,
  isGskLoggedIn: () => boolean,
): AgentSkill {
  const access = createSlidesDeckAccess({
    getSettings,
    getSlides: deps.getSlides,
    getCurrent: deps.getCurrent,
    getSelectedIds: deps.getSelectedIds,
    applySlide: deps.applySlide,
    applyDeck: deps.applyDeck,
    fitWidthPx: deps.fitWidthPx,
    ...(deps.onPathChange ? { onPathChange: deps.onPathChange } : {}),
    imageGenAvailable: () => imageGenerationAvailable(getSettings(), isGskLoggedIn()),
    mediaAnalysisAvailable: () => mediaAnalysisAvailable(getSettings(), isGskLoggedIn()),
  })
  const skill = createSlidesSkill(access)
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

async function runTask(
  deps: SlidesHeadlessAgentDeps,
  task: string,
  onProgress: (status: AgentTaskStatus) => void,
  registerCancel: (cancel: () => void) => void,
  saveRollback: (snapshotId: number) => string,
): Promise<HeadlessOutcome> {
  if (!deps.isReady()) {
    return { ok: false, summary: 'the presentation is not ready', edits: [] }
  }
  const [settings, gskRes] = await Promise.all([
    window.slidesApi.getAiSettings(),
    window.slidesApi.gskStatus().catch(() => ({ available: false })),
  ])
  const gskLoggedIn = Boolean(gskRes?.available)

  await deps.onBeforeRun?.()
  const batchOpened = await window.slidesApi.beginHistoryBatch().catch(() => false)

  const edits: Array<{ tool: string; summary: string }> = []
  const loop = new AgentLoop({
    transport: createElectronTransport(() => settings),
    systemSuffix: aiLangDirective,
    confirmTool: async () => true,
    skill: composeSkills('slides-headless', '', [
      ...(typeof window.slidesApi?.kbList === 'function'
        ? [
            createKnowledgeBaseSkill({
              listFiles: () => [],
              search: (query, limit) => window.slidesApi.kbSearch({ q: query, limit }),
              read: (path, offset) => window.slidesApi.kbRead(path, offset),
            }),
          ]
        : []),
      headlessSlidesSkill(deps, () => settings, () => gskLoggedIn),
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
    const snapshotId = batchOpened
      ? await window.slidesApi.endHistoryBatch().catch(() => null)
      : null
    const checkpointId =
      edits.length > 0 && typeof snapshotId === 'number' ? saveRollback(snapshotId) : undefined
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
    if (batchOpened) {
      await window.slidesApi.endHistoryBatch().catch(() => null)
    }
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, summary: message, edits }
  }
}

export function installHeadlessAgentBridge(deps: SlidesHeadlessAgentDeps): () => void {
  const api = window.slidesApi
  if (!api?.onAgentTaskCommand || !api.reportAgentTaskResult) return () => {}
  let disposed = false
  let readyTimer: ReturnType<typeof setTimeout> | null = null
  let cancelCurrent: (() => void) | null = null
  let currentTaskId: string | null = null
  let checkpointSeq = 0
  const checkpoints = new Map<string, number>()

  const saveRollback = (snapshotId: number): string => {
    const id = `slides-cp-${++checkpointSeq}`
    checkpoints.set(id, snapshotId)
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
    if (deps.isReady()) {
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
        summary: 'this presentation is already running a task',
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
        error: 'a task is currently running in this presentation',
      })
      return
    }
    const snapshotId = checkpoints.get(message.checkpointId)
    if (snapshotId === undefined) {
      api.reportAgentUndoResult?.({
        undoId: message.undoId,
        ok: false,
        error: 'checkpoint is no longer available',
      })
      return
    }
    try {
      const restored = await api.aiSnapshotRestore(snapshotId)
      if (!restored) {
        checkpoints.delete(message.checkpointId)
        api.reportAgentUndoResult?.({
          undoId: message.undoId,
          ok: false,
          error: 'checkpoint is no longer available',
        })
        return
      }
      deps.applyDeck(restored, Math.min(deps.getCurrent(), restored.length - 1))
      // Snapshot ids are monotonic; rewinding discards this checkpoint and any later ones.
      for (const [key, sid] of checkpoints.entries()) {
        if (sid >= snapshotId) checkpoints.delete(key)
      }
      api.reportAgentUndoResult?.({ undoId: message.undoId, ok: true })
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
