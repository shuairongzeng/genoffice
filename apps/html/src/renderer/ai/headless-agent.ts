import {
  AgentLoop,
  composeSkills,
  createKnowledgeBaseSkill,
  type AgentSkill,
  type AgentTaskStatus,
  type AgentTaskStatusKind,
  type AgentToolDef,
} from '@genoffice/agent-core'
import { aiLangDirective } from '../i18n/locale'
import type { HtmlAiDeps } from './AiPanel'
import { createDocumentSkill } from './html-skill'
import { buildPageWriterRequest, streamPage, type PageWriteResult, type PageWriteSpec } from './page-writer'
import { createSearchSkill } from './search-skill'
import { createElectronTransport } from './transport'

/**
 * Headless document agent for HTML: executes delegated tasks from the shell's
 * `document_agent` tool against the live HTML page source & preview without
 * mounting the in-app panel. Supports both targeted `apply_ops` mutations and
 * whole-document streaming writes via `write_document`, recording a Git-style
 * undo checkpoint for every mutating run.
 */

const READY_POLL_MS = 80
const READY_SLOW_POLL_MS = 1_000
const READY_FAST_WINDOW_MS = 20_000
const MAX_CHECKPOINTS = 20

const STATUS_KIND_BY_TOOL: Record<string, AgentTaskStatusKind> = {
  get_outline: 'reading',
  read_source: 'reading',
  apply_ops: 'writing',
  write_document: 'writing',
  web_search: 'image',
}

const HEADLESS_EXCLUDED_TOOLS: ReadonlySet<string> = new Set(['ask_clarification', 'plan_page'])

const HEADLESS_TOOLS_NOTE = `

## Delegated-session mode
You are running as the HTML page assistant delegated from the global AI panel.
Inspect the document outline/source first with \`get_outline\` and \`read_source\`,
then edit via \`apply_ops\` or author complete content with \`write_document\`.
Interactive confirmation/planning dialogs (\`ask_clarification\`, \`plan_page\`) are
unavailable in this delegated session; apply changes directly. Every run records a
Git-style undo checkpoint automatically.`

const statusOfTool = (name: string): AgentTaskStatus => ({
  kind: STATUS_KIND_BY_TOOL[name] ?? 'other',
  tool: name,
})

export interface HtmlDocSnapshot {
  text: string
}

export interface HtmlHeadlessAgentDeps {
  isReady: () => boolean
  getDeps: () => HtmlAiDeps
}

interface HeadlessOutcome {
  ok: boolean
  summary: string
  edits: Array<{ tool: string; summary: string }>
  checkpointId?: string
}

async function runTask(
  bridgeDeps: HtmlHeadlessAgentDeps,
  task: string,
  onProgress: (status: AgentTaskStatus) => void,
  registerCancel: (cancel: () => void) => void,
  saveCheckpoint: (snapshot: HtmlDocSnapshot) => string,
): Promise<HeadlessOutcome> {
  if (!bridgeDeps.isReady()) {
    return { ok: false, summary: 'the HTML document is not ready', edits: [] }
  }
  const [settings, lang] = await Promise.all([
    window.htmlApi.getAiSettings(),
    window.htmlApi.getLanguage().catch(() => 'en' as const),
  ])
  const docDeps = bridgeDeps.getDeps()
  const snapshotBefore = docDeps.getSnapshot()
  const transport = createElectronTransport(() => settings)

  const writePage = async (
    spec: PageWriteSpec,
    signal?: AbortSignal,
  ): Promise<PageWriteResult> => {
    const { system, user } = buildPageWriterRequest(spec, aiLangDirective(lang))
    let closed = false
    const attempt = () =>
      streamPage({
        transport,
        system,
        user,
        signal,
        onProgress: (html) => {
          if (!closed) bridgeDeps.getDeps().previewDraft(html)
        },
      })
    let outcome = await attempt()
    if (outcome.status === 'empty' && !signal?.aborted) outcome = await attempt()
    closed = true
    bridgeDeps.getDeps().previewDraft(null)
    if (outcome.status === 'complete') return { ok: true, html: outcome.html }
    if (outcome.status === 'empty') return { ok: false, error: outcome.error }
    if (outcome.html.trim()) return { ok: true, html: outcome.html, truncated: true }
    return { ok: false, error: outcome.error ?? outcome.reason }
  }

  const baseSkill = createDocumentSkill({
    getText: () => bridgeDeps.getDeps().access.getText(),
    getVersion: () => bridgeDeps.getDeps().access.getVersion(),
    getMap: () => bridgeDeps.getDeps().access.getMap(),
    getLastManualVersion: () => bridgeDeps.getDeps().access.getLastManualVersion(),
    getFilePath: () => bridgeDeps.getDeps().access.getFilePath(),
    getSelectedSid: () => bridgeDeps.getDeps().access.getSelectedSid(),
    applyOps: (ops, label) => bridgeDeps.getDeps().access.applyOps(ops, label),
    replaceAll: (html, label) => bridgeDeps.getDeps().access.replaceAll(html, label),
    writePage,
    getInstruction: () => task,
  })

  const headlessSkill: AgentSkill = {
    ...baseSkill,
    get systemPrompt(): string {
      return baseSkill.systemPrompt + HEADLESS_TOOLS_NOTE
    },
    get tools(): AgentToolDef[] {
      return baseSkill.tools.filter((tool) => !HEADLESS_EXCLUDED_TOOLS.has(tool.name))
    },
  }

  const edits: Array<{ tool: string; summary: string }> = []
  const loop = new AgentLoop({
    transport,
    systemSuffix: () => aiLangDirective(lang),
    confirmTool: async () => true,
    skill: composeSkills('html-headless', '', [
      ...(typeof window.htmlApi?.kbList === 'function'
        ? [
            createKnowledgeBaseSkill({
              listFiles: () => [],
              search: (query, limit) => window.htmlApi.kbSearch({ q: query, limit }),
              read: (path, offset) => window.htmlApi.kbRead(path, offset),
            }),
          ]
        : []),
      headlessSkill,
      createSearchSkill(),
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
    const checkpointId = edits.length > 0 ? saveCheckpoint(snapshotBefore) : undefined
    if (edits.length > 0) bridgeDeps.getDeps().onRunDone(true)
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

export function installHeadlessAgentBridge(bridgeDeps: HtmlHeadlessAgentDeps): () => void {
  const api = window.htmlApi
  if (!api?.onAgentTaskCommand || !api.reportAgentTaskResult) return () => {}
  let disposed = false
  let readyTimer: ReturnType<typeof setTimeout> | null = null
  let cancelCurrent: (() => void) | null = null
  let currentTaskId: string | null = null
  let checkpointSeq = 0
  const checkpoints = new Map<string, HtmlDocSnapshot>()

  const saveCheckpoint = (snapshot: HtmlDocSnapshot): string => {
    const id = `html-cp-${++checkpointSeq}`
    checkpoints.set(id, snapshot)
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
    if (bridgeDeps.isReady()) {
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
        summary: 'this HTML document is already running a task',
      })
      return
    }
    const taskId = message.taskId
    currentTaskId = taskId
    cancelCurrent = null
    const outcome = await runTask(
      bridgeDeps,
      message.task,
      (status) => api.reportAgentTaskProgress({ taskId, status }),
      (cancel) => (cancelCurrent = cancel),
      saveCheckpoint,
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

  const unsubscribeUndo = api.onAgentUndo?.((message) => {
    if (!message || typeof message.undoId !== 'string' || typeof message.checkpointId !== 'string') {
      return
    }
    if (currentTaskId !== null) {
      api.reportAgentUndoResult?.({
        undoId: message.undoId,
        ok: false,
        error: 'a task is currently running in this HTML document',
      })
      return
    }
    const snapshot = checkpoints.get(message.checkpointId)
    if (!snapshot) {
      api.reportAgentUndoResult?.({
        undoId: message.undoId,
        ok: false,
        error: 'checkpoint is no longer available',
      })
      return
    }
    try {
      bridgeDeps.getDeps().restoreSnapshot(snapshot)
      checkpoints.delete(message.checkpointId)
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
