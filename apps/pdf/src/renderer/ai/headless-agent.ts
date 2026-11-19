import {
  AgentLoop,
  composeSkills,
  createKnowledgeBaseSkill,
  type AgentSkill,
  type AgentTaskStatus,
  type AgentTaskStatusKind,
  type AgentToolDef,
} from '@genoffice/agent-core'
import { imageGenerationAvailable } from '@genoffice/ai-provider/browser'
import type { EditSnapshot } from '../edit-state'
import { aiLangDirective } from '../i18n/locale'
import { createPdfSkill } from './pdf-skill'
import type { FileOpResult, PdfAiDeps, PdfAppDeps, SplitPdfOutcome } from './tools'
import { createElectronTransport } from './transport'

/**
 * Headless document agent for PDF: executes delegated tasks from the shell's
 * `document_agent` tool against the open PDF without mounting the in-app panel.
 * Supports both in-memory pending edits (markup/text/annotations/apply_ops) and
 * file-level disk operations, with Git-style checkpoint rollback backed by
 * per-view main-process PDF byte snapshots.
 */

const READY_POLL_MS = 80
const READY_SLOW_POLL_MS = 1_000
const READY_FAST_WINDOW_MS = 20_000
const MAX_CHECKPOINTS = 20

const STATUS_KIND_BY_TOOL: Record<string, AgentTaskStatusKind> = {
  read_pages: 'reading',
  search_text: 'reading',
  goto_page: 'reading',
  read_annotations: 'reading',
  list_inserted_text: 'reading',
  list_page_images: 'reading',
  list_form_fields: 'reading',
  get_outline: 'reading',
  markup_text: 'writing',
  add_note: 'writing',
  reply_note: 'writing',
  edit_note: 'writing',
  delete_markup: 'writing',
  delete_note: 'writing',
  edit_text: 'writing',
  edit_block: 'writing',
  move_text_block: 'writing',
  insert_text: 'writing',
  add_form_mark: 'writing',
  edit_inserted_text: 'writing',
  move_inserted_text: 'writing',
  delete_inserted_text: 'writing',
  insert_image: 'writing',
  transform_image: 'writing',
  rotate_image: 'writing',
  replace_image: 'writing',
  flip_image: 'writing',
  set_image_opacity: 'writing',
  crop_image: 'writing',
  remove_image_background: 'writing',
  delete_image: 'writing',
  apply_ops: 'writing',
  insert_blank_page: 'writing',
  set_watermark: 'writing',
  set_header_footer: 'writing',
  set_page_size: 'applying',
  crop_pages: 'applying',
  extract_pages: 'applying',
  split_pdf: 'applying',
  split_pages: 'applying',
  merge_pages: 'applying',
  replace_pages: 'applying',
  image_search: 'image',
  generate_image: 'image',
}

const HEADLESS_EXCLUDED_TOOLS: ReadonlySet<string> = new Set(['create_document'])

const HEADLESS_TOOLS_NOTE = `

## Delegated-session mode
You are running as the PDF assistant delegated from the global AI panel.
Inspect pages with \`search_text\` / \`read_pages\`, then apply markup, text, image,
annotation, structure, or file-level page operations directly.
Every delegated run records a Git-style undo checkpoint automatically (including an
exact backup of the original PDF file bytes on disk before any in-place file-level
rewrite such as \`set_page_size\`, \`crop_pages\`, or \`replace_pages\`). Never tell the user
that a delegated file-level operation is "irreversible" or "cannot be undone" — always
note that the global AI panel's Undo button restores the exact pre-task file and state.
\`create_document\` is unavailable in this delegated session.`

const statusOfTool = (name: string): AgentTaskStatus => ({
  kind: STATUS_KIND_BY_TOOL[name] ?? 'other',
  tool: name,
})

export interface PdfCheckpoint {
  editSnapshotBefore: EditSnapshot
  filePath: string
  fileCheckpointId?: string
}

export interface PdfHeadlessAgentDeps {
  isReady: () => boolean
  getFilePath: () => string
  getAppDeps: () => PdfAppDeps
  captureEditSnapshot: () => EditSnapshot
  restoreEditSnapshot: (snapshot: EditSnapshot) => void
  reloadDoc: () => Promise<number>
  splitPdfHeadless: (pagesPerFile: number) => Promise<SplitPdfOutcome>
  replacePagesHeadless: (visIdxs: number[]) => Promise<FileOpResult>
  onRunDone?: (mutated: boolean) => void
}

interface HeadlessOutcome {
  ok: boolean
  summary: string
  edits: Array<{ tool: string; summary: string }>
  checkpointId?: string
}

function headlessPdfSkill(skillDeps: PdfAiDeps): AgentSkill {
  const skill = createPdfSkill(skillDeps)
  return {
    ...skill,
    get systemPrompt(): string {
      return (
        skill.systemPrompt.replace(
          /and cannot be undone\./g,
          'and can be reverted from the global AI panel Undo checkpoint (original disk bytes are backed up automatically).',
        ) + HEADLESS_TOOLS_NOTE
      )
    },
    get tools(): AgentToolDef[] {
      return skill.tools.filter((tool) => !HEADLESS_EXCLUDED_TOOLS.has(tool.name))
    },
  }
}

async function runTask(
  deps: PdfHeadlessAgentDeps,
  task: string,
  onProgress: (status: AgentTaskStatus) => void,
  registerCancel: (cancel: () => void) => void,
  saveCheckpoint: (cp: PdfCheckpoint) => string,
): Promise<HeadlessOutcome> {
  const filePath = deps.getFilePath()
  if (!deps.isReady() || !filePath) {
    return { ok: false, summary: 'the PDF document is not ready', edits: [] }
  }

  const [settings, gskRes, lang] = await Promise.all([
    window.pdfApi.getAiSettings(),
    window.pdfApi.gskStatus().catch(() => ({ loggedIn: false })),
    window.pdfApi.getLanguage().catch(() => 'en' as const),
  ])
  const gskLoggedIn = Boolean(gskRes?.loggedIn)

  const editSnapshotBefore = deps.captureEditSnapshot()
  let fileCheckpointId: string | undefined
  let fileCheckpointPromise: Promise<string | undefined> | null = null

  // Capture on-disk bytes at most once per delegated run, immediately before the
  // first file-level op runs (since flushThen writes pending edits to disk).
  const ensureDiskBackupOnce = async (): Promise<string | undefined> => {
    if (fileCheckpointId !== undefined) return fileCheckpointId
    if (!fileCheckpointPromise) {
      fileCheckpointPromise = window.pdfApi
        .captureFileCheckpoint(filePath)
        .then((res) => {
          if (res.ok) fileCheckpointId = res.checkpointId
          return fileCheckpointId
        })
        .catch(() => undefined)
    }
    return fileCheckpointPromise
  }

  const appDeps = deps.getAppDeps()
  const skillDeps: PdfAiDeps = {
    ...appDeps,
    confirmFileOp: async () => true,
    imageGenAvailable: () => imageGenerationAvailable(settings, gskLoggedIn),
    setPageSize: async (width, height) => {
      await ensureDiskBackupOnce()
      return deps.getAppDeps().setPageSize(width, height)
    },
    cropPages: async (visIdxs, rect) => {
      await ensureDiskBackupOnce()
      return deps.getAppDeps().cropPages(visIdxs, rect)
    },
    replacePages: async (visIdxs) => {
      await ensureDiskBackupOnce()
      return deps.replacePagesHeadless(visIdxs)
    },
    extractPages: async (visIdxs) => {
      await ensureDiskBackupOnce()
      return deps.getAppDeps().extractPages(visIdxs)
    },
    splitPdf: async (pagesPerFile) => {
      await ensureDiskBackupOnce()
      return deps.splitPdfHeadless(pagesPerFile)
    },
    splitPages: async (perPage) => {
      await ensureDiskBackupOnce()
      return deps.getAppDeps().splitPages(perPage)
    },
    mergePages: async (perSheet, direction, separator) => {
      await ensureDiskBackupOnce()
      return deps.getAppDeps().mergePages(perSheet, direction, separator)
    },
  }

  const edits: Array<{ tool: string; summary: string }> = []
  const loop = new AgentLoop({
    transport: createElectronTransport(() => settings),
    systemSuffix: () => aiLangDirective(lang),
    confirmTool: async () => true,
    skill: composeSkills('pdf-headless', '', [
      ...(typeof window.pdfApi?.kbList === 'function'
        ? [
            createKnowledgeBaseSkill({
              listFiles: () => [],
              search: (query, limit) => window.pdfApi.kbSearch({ q: query, limit }),
              read: (path, offset) => window.pdfApi.kbRead(path, offset),
            }),
          ]
        : []),
      headlessPdfSkill(skillDeps),
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
    const checkpointId =
      edits.length > 0
        ? saveCheckpoint({
            editSnapshotBefore,
            filePath,
            ...(fileCheckpointId ? { fileCheckpointId } : {}),
          })
        : undefined
    if (edits.length > 0) deps.onRunDone?.(true)
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

export function installHeadlessAgentBridge(deps: PdfHeadlessAgentDeps): () => void {
  const api = window.pdfApi
  if (!api?.onAgentTaskCommand || !api.reportAgentTaskResult) return () => {}
  let disposed = false
  let readyTimer: ReturnType<typeof setTimeout> | null = null
  let cancelCurrent: (() => void) | null = null
  let currentTaskId: string | null = null
  let checkpointSeq = 0
  const checkpoints = new Map<string, PdfCheckpoint>()

  const saveCheckpoint = (cp: PdfCheckpoint): string => {
    const id = `pdf-cp-${++checkpointSeq}`
    checkpoints.set(id, cp)
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
        summary: 'this PDF is already running a task',
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

  const unsubscribeUndo = api.onAgentUndo?.(async (message) => {
    if (!message || typeof message.undoId !== 'string' || typeof message.checkpointId !== 'string') {
      return
    }
    if (currentTaskId !== null) {
      api.reportAgentUndoResult?.({
        undoId: message.undoId,
        ok: false,
        error: 'a task is currently running in this PDF',
      })
      return
    }
    const checkpoint = checkpoints.get(message.checkpointId)
    if (!checkpoint) {
      api.reportAgentUndoResult?.({
        undoId: message.undoId,
        ok: false,
        error: 'checkpoint is no longer available',
      })
      return
    }
    try {
      if (checkpoint.fileCheckpointId) {
        const restored = await api.restoreFileCheckpoint(
          checkpoint.fileCheckpointId,
          checkpoint.filePath,
        )
        if (!restored.ok) {
          api.reportAgentUndoResult?.({
            undoId: message.undoId,
            ok: false,
            error: restored.error,
          })
          return
        }
        await deps.reloadDoc()
      }
      deps.restoreEditSnapshot(checkpoint.editSnapshotBefore)
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
