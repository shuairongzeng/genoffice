import {
  AgentLoop,
  composeSkills,
  createKnowledgeBaseSkill,
  streamText,
  type AgentTaskStatus,
  type AgentTaskStatusKind,
} from '@genoffice/agent-core'
import { imageGenerationAvailable } from '@genoffice/ai-provider/browser'
import type { Lang } from '@genoffice/i18n'
import { aiLangDirective } from '../i18n/locale'
import type { DocSnapshot, MarkdownAiDeps } from './AiPanel'
import {
  buildDocWriterRequest,
  DOC_MAX_CHARS,
  extractMarkdown,
  type AiDocWriter,
  type DocWriteResult,
} from './doc-writer'
import { createMarkdownSkill, MARKDOWN_RULES } from './markdown-skill'
import { createPlainTextSkill } from './plain-text-skill'
import { createSearchSkill } from './search-skill'
import { createElectronTransport } from './transport'

/**
 * Headless document agent for Markdown & plain-text files: executes delegated
 * tasks from the shell's `document_agent` tool against either the live TipTap
 * Markdown editor or the CodeMirror plain-text source editor, recording a
 * Git-style undo checkpoint for every mutating run.
 */

const READY_POLL_MS = 80
const READY_SLOW_POLL_MS = 1_000
const READY_FAST_WINDOW_MS = 20_000
const MAX_CHECKPOINTS = 20

const STATUS_KIND_BY_TOOL: Record<string, AgentTaskStatusKind> = {
  get_document_context: 'reading',
  read_blocks: 'reading',
  read_frontmatter: 'reading',
  read_text: 'reading',
  search_text: 'reading',
  generate_mindmap: 'thinking',
  apply_ops: 'writing',
  write_document: 'writing',
  replace_text: 'writing',
  edit_lines: 'writing',
  write_text: 'writing',
  web_search: 'image',
  image_search: 'image',
  insert_image: 'image',
  generate_image: 'image',
}

const HEADLESS_TOOLS_NOTE = `

## Delegated-session mode
You are running as the document assistant delegated from the global AI panel.
Inspect the document context or content first, then edit directly using the available
tools. Every run records a Git-style undo checkpoint automatically.`

const statusOfTool = (name: string): AgentTaskStatus => ({
  kind: STATUS_KIND_BY_TOOL[name] ?? 'other',
  tool: name,
})

export interface MarkdownHeadlessAgentDeps {
  isReady: () => boolean
  getDeps: () => MarkdownAiDeps
}

interface HeadlessOutcome {
  ok: boolean
  summary: string
  edits: Array<{ tool: string; summary: string }>
  checkpointId?: string
}

function createHeadlessDocWriter(
  transport: ReturnType<typeof createElectronTransport>,
  lang: Lang,
): AiDocWriter {
  return {
    async write(spec, onProgress, signal): Promise<DocWriteResult> {
      const { system, user } = buildDocWriterRequest(spec, MARKDOWN_RULES, aiLangDirective(lang))
      const attempt = () =>
        streamText({
          transport,
          system,
          user,
          signal,
          maxChars: DOC_MAX_CHARS,
          extract: (raw) => ({ text: extractMarkdown(raw) }),
          onProgress,
        })
      let outcome = await attempt()
      if (outcome.status === 'empty' && !signal?.aborted) outcome = await attempt()
      if (outcome.status === 'complete') return { ok: true, markdown: outcome.text }
      if (outcome.status === 'empty') return { ok: false, error: outcome.error }
      if (outcome.text.trim()) return { ok: true, markdown: outcome.text, truncated: true }
      return { ok: false, error: outcome.error ?? outcome.reason }
    },
  }
}

async function runTask(
  bridgeDeps: MarkdownHeadlessAgentDeps,
  task: string,
  onProgress: (status: AgentTaskStatus) => void,
  registerCancel: (cancel: () => void) => void,
  saveCheckpoint: (snapshot: DocSnapshot) => string,
): Promise<HeadlessOutcome> {
  if (!bridgeDeps.isReady()) {
    return { ok: false, summary: 'the document is not ready', edits: [] }
  }
  const [settings, gskRes, lang] = await Promise.all([
    window.markdownApi.getAiSettings(),
    window.markdownApi.aiGskStatus().catch(() => ({ loggedIn: false })),
    window.markdownApi.getLanguage().catch(() => 'en' as const),
  ])
  const gskLoggedIn = Boolean(gskRes?.loggedIn)
  const docDeps = bridgeDeps.getDeps()
  const snapshotBefore = docDeps.getSnapshot()
  const transport = createElectronTransport(() => settings)
  const writer = createHeadlessDocWriter(transport, lang)

  const docSkill = docDeps.isSourceMode?.()
    ? createPlainTextSkill({
        getText: () => docDeps.getSourceText?.() ?? '',
        replaceText: (text) => docDeps.replaceSourceText?.(text),
        fileName: () => docDeps.getFileName?.(),
        textMode: () => docDeps.getTextMode?.() ?? 'plain',
      })
    : createMarkdownSkill(
        () => docDeps.getEditor(),
        {
          read: () => docDeps.getFrontmatter(),
          write: (inner) => docDeps.setFrontmatter(inner),
        },
        () => imageGenerationAvailable(settings, gskLoggedIn),
        () => writer,
      )

  const wrappedSkill = {
    ...docSkill,
    get systemPrompt() {
      return docSkill.systemPrompt + HEADLESS_TOOLS_NOTE
    },
  }

  const edits: Array<{ tool: string; summary: string }> = []
  const loop = new AgentLoop({
    transport,
    systemSuffix: () => aiLangDirective(lang),
    confirmTool: async () => true,
    skill: composeSkills('markdown-headless', '', [
      ...(typeof window.markdownApi?.kbList === 'function'
        ? [
            createKnowledgeBaseSkill({
              listFiles: () => [],
              search: (query, limit) => window.markdownApi.kbSearch({ q: query, limit }),
              read: (path, offset) => window.markdownApi.kbRead(path, offset),
            }),
          ]
        : []),
      wrappedSkill,
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
    if (edits.length > 0) docDeps.onRunDone(true)
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

export function installHeadlessAgentBridge(bridgeDeps: MarkdownHeadlessAgentDeps): () => void {
  const api = window.markdownApi
  if (!api?.onAgentTaskCommand || !api.reportAgentTaskResult) return () => {}
  let disposed = false
  let readyTimer: ReturnType<typeof setTimeout> | null = null
  let cancelCurrent: (() => void) | null = null
  let currentTaskId: string | null = null
  let checkpointSeq = 0
  const checkpoints = new Map<string, DocSnapshot>()

  const saveCheckpoint = (snapshot: DocSnapshot): string => {
    const id = `md-cp-${++checkpointSeq}`
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
        summary: 'this document is already running a task',
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
        error: 'a task is currently running in this document',
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
