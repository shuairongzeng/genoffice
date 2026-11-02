import {
  AgentLoop,
  composeSkills,
  createKnowledgeBaseSkill,
  streamText,
  type AgentSkill,
  type AgentTaskStatus,
  type AgentTaskStatusKind,
  type AgentToolDef,
} from '@genoffice/agent-core'
import { BLANK_BULLET_NUM_ID, BLANK_ORDERED_NUM_ID } from '@genoffice/docx-engine'
import type { AiSettings, AttachmentMeta } from '../../shared/ipc'
import type { FileActionContext } from '../file-actions'
import { aiLangDirective } from '../i18n/locale'
import { createElectronTransport } from './transport'
import { createDocsSkill } from './docs-skill'
import { createFilesSkill } from './files-skill'
import { findNumId, type NumIds } from './protocol'
import { type AiCommentsAccess, type AiDocExtras, type AiHeaderFooterAccess } from './tools'
import { announceWhenLoaded } from '../mcp-bridge'
import type { AiPageSetupAccess } from './page-setup'
import type { AiNotesAccess } from './note-ops'
import { AI_REVISION_AUTHOR } from './AiPanel'
import type { AiDocWriter, DocWriteResult, DocWriteSpec } from './doc-writer'
import { buildDocWriterRequest, DOC_MAX_CHARS, extractFragment } from './doc-writer'
import {
  endpointSupportsVision,
  imageGenerationAvailable,
  mediaAnalysisAvailable,
} from '@genoffice/ai-provider/browser'

/**
 * The headless document agent (W2): the global dock's `document_agent` tool
 * delegates a task, the shell main routes it here over `docs:agent-task`,
 * and this module runs the docs agent loop WITHOUT the panel UI — the docs
 * skill (the revision-expressible editor toolset), the same transport, a
 * one-shot loop whose whole conversation is the task.
 *
 * Headless policies, all deliberate:
 * - Confirms auto-allow. Within a delegated task the write ops run under the
 *   delegation's mandate — the ONE confirm card the person approved in the
 *   global panel. Nobody sits at this (suppressed) in-app panel to answer a
 *   card.
 * - EVERY sub-agent edit lands as a PENDING revision authored
 *   {@link AI_REVISION_AUTHOR}, regardless of the document's track-changes
 *   state: nobody watched the edit happen, so undo-by-default is the honest
 *   grade — the person reviews in the Review tab, the doc's existing surface.
 *   Nothing here ever accepts, rejects or clears revisions (the Review tab
 *   is the person's surface, not the sub-agent's).
 * - A truncated long-form write keeps its partial (as pending revisions) and
 *   says so through the result.
 * - Tool set: only reads, the revision-expressible writes (insert / replace
 *   / apply_ops / write_document), and non-destructive comment/notes reads +
 *   comment add/reply. Everything else is EXCLUDED (see
 *   {@link HEADLESS_EXCLUDED_TOOLS}): the revision-surface tools
 *   (accept/reject — self-laundering), create_document (a disk write outside
 *   the mandate), and every write that cannot be expressed as a pending
 *   revision — image/chart insertion, note and header/footer writes, comment
 *   resolution/deletion — because an unreviewed, unrevisioned write is
 *   exactly the destructive op the delegation must not make invisible.
 *
 * Live progress: the loop's own events (onToolStart / onToolExecuted) are
 * mapped to a semantic status and pushed over `docs:agent-task-progress`;
 * the shell relays it to the panel, which renders the rolling
 * "文档助手：…" line. Readiness is announced like the MCP bridge's
 * (`docs:agent-ready`), so the shell never routes a task at a tab whose
 * editor has not loaded.
 */

/** the sub-agent's tool name → the status kind the panel renders */
const STATUS_KIND_BY_TOOL: Record<string, AgentTaskStatusKind> = {
  get_document_context: 'reading',
  insert_content: 'inserting',
  replace_blocks: 'replacing',
  apply_ops: 'applying',
  write_document: 'writing',
  generate_image: 'image',
  image_search: 'image',
  analyze_media: 'analyzing',
}

const statusOfTool = (name: string): AgentTaskStatus => ({
  kind: STATUS_KIND_BY_TOOL[name] ?? 'other',
  tool: name,
})

/**
 * Tools the headless session EXCLUDES, with the reason each cannot run
 * unattended (see the module doc):
 * - accept_changes / reject_changes: the revision surface is the person's
 *   Review tab — accepting its own revisions is self-laundering, rejecting
 *   can destroy the person's pending work
 * - create_document: writes a new file to disk, outside the delegation's
 *   document mandate
 * - insert_image / generate_image: async image insertions that bypass the
 *   tracked-revision pipeline (no pending-revision form exists for them)
 * - insert_chart / edit_chart: direct chart-block writes, untracked
 * - insert_footnote / insert_endnote / delete_note / edit_note: note writes
 *   bypass the revision pipeline
 * - set_header_footer: header/footer writes bypass the revision pipeline
 * - resolve_comment / delete_comment: erase review artifacts (comments);
 *   resolving/deleting is the person's call in the comments pane
 */
const HEADLESS_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  'accept_changes',
  'reject_changes',
  'create_document',
  'insert_image',
  'generate_image',
  'insert_chart',
  'edit_chart',
  'insert_footnote',
  'insert_endnote',
  'delete_note',
  'edit_note',
  'set_header_footer',
  'resolve_comment',
  'delete_comment',
])

const HEADLESS_TOOLS_NOTE = `

## Delegated-session limits (read this)
You are running as a delegated document assistant: every edit you make lands
as a PENDING tracked revision the document owner reviews afterwards — never
accept or clear changes yourself, and do not expect to: the revision, image,
chart, note, header/footer and file-creation tools are not available in this
session. Comment reads, adds and replies are available. Finish the task,
report exactly what you changed, and leave the reviewing to the owner.`

export interface HeadlessAgentDeps {
  /** live file-action context (refreshed every render by App) */
  getCtx: () => FileActionContext
  /** the AI settings the transport reads */
  getSettings: () => AiSettings
  getComments: () => AiCommentsAccess | undefined
  getHf: () => AiHeaderFooterAccess | undefined
  getPageSetup: () => AiPageSetupAccess | undefined
  getExtras: () => AiDocExtras | undefined
  getNotes: () => AiNotesAccess | undefined
  /** the staged-attachment list — always empty headless (the in-app panel owns staging) */
  attachments: () => readonly AttachmentMeta[]
}

export interface HeadlessAgentOutcome {
  ok: boolean
  summary: string
  edits: Array<{ tool: string; summary: string }>
}

function numIdsFor(ctx: FileActionContext): NumIds {
  const blocks = ctx.doc?.parsed.blocks ?? []
  const isBlank = ctx.doc?.isBlank === true
  return {
    bullet: findNumId(blocks, 'bullet') ?? (isBlank ? BLANK_BULLET_NUM_ID : null),
    ordered: findNumId(blocks, 'ordered') ?? (isBlank ? BLANK_ORDERED_NUM_ID : null),
  }
}

/**
 * The long-form writer, headless: same request shape and stream, but a
 * truncated draft KEEPS itself (tracked for undo) instead of parking on a
 * keep-or-discard card nobody can answer, and the truncation rides the
 * result so the task's summary can say so.
 */
const headlessWriter = (getSettings: () => AiSettings): AiDocWriter => ({
  write: async (
    spec: DocWriteSpec,
    onProgress: (html: string) => void,
    signal?: AbortSignal,
  ): Promise<DocWriteResult> => {
    const { system, user } = buildDocWriterRequest(spec, aiLangDirective())
    const outcome = await streamText({
      transport: createElectronTransport(getSettings),
      system,
      user,
      signal,
      maxChars: DOC_MAX_CHARS,
      extract: (raw) => ({ text: extractFragment(raw) }),
      onProgress: (html) => onProgress(html),
    })
    if (outcome.status === 'complete') return { ok: true, html: outcome.text }
    if (outcome.status === 'empty') return { ok: false, error: outcome.error }
    // truncated: keep the partial (the task's mandate covers the write,
    // the revision system tracks it) and say so through the result
    return {
      ok: true,
      html: outcome.text,
      truncated: true,
    }
  },
})

/** the docs skill with the headless session's tool set and its limits note */
function headlessDocsSkill(build: () => AgentSkill): AgentSkill {
  const skill = build()
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

/** run one delegated task; progress reports ride `onProgress`, abort rides `registerCancel` */
async function runTask(
  deps: HeadlessAgentDeps,
  task: string,
  onProgress: (status: AgentTaskStatus) => void,
  gskLoggedIn: boolean,
  registerCancel: (cancel: () => void) => void,
): Promise<HeadlessAgentOutcome> {
  const ctx = deps.getCtx()
  const editor = ctx.editor
  if (!editor || !ctx.doc) {
    return { ok: false, summary: 'the document is not ready', edits: [] }
  }
  const getSettings = deps.getSettings
  const edits: Array<{ tool: string; summary: string }> = []
  const numIds = () => numIdsFor(deps.getCtx())
  const loop = new AgentLoop({
    transport: createElectronTransport(getSettings),
    systemSuffix: aiLangDirective,
    // HEADLESS CONFIRM POLICY — see the module doc. The one card the person
    // answered lives in the global panel; this loop's writes run under it.
    confirmTool: async () => true,
    skill: composeSkills('docs-headless', '', [
      ...(typeof window.desktop?.kbList === 'function'
        ? [
            createKnowledgeBaseSkill({
              listFiles: () => [],
              search: (query, limit) => window.desktop.kbSearch({ q: query, limit }),
              read: (path, offset) => window.desktop.kbRead(path, offset),
            }),
          ]
        : []),
      headlessDocsSkill(() =>
        createDocsSkill(
          () => editor,
          numIds,
          // ALWAYS a pending revision under the AI author — nobody watched
          // this edit happen, so undo-by-default is the grade; the Review
          // tab is where the owner decides (independent of the document's
          // own track-changes setting)
          () => ({ author: AI_REVISION_AUTHOR }),
          () => deps.getComments(),
          () => deps.getHf(),
          () => imageGenerationAvailable(getSettings(), gskLoggedIn),
          () => headlessWriter(getSettings),
          () => deps.getPageSetup(),
          () => deps.getExtras(),
          () => deps.getNotes(),
          () => mediaAnalysisAvailable(getSettings(), gskLoggedIn),
          () => getSettings() != null && endpointSupportsVision(getSettings()),
        ),
      ),
      createFilesSkill(() => [...deps.attachments()]),
    ]),
    captureSnapshot: () => editor.getJSON() as never,
    events: {
      onToolStart: (call) => onProgress(statusOfTool(call.name)),
      onToolExecuted: ({ call, execution }) => {
        // edits stay PENDING (never cleared here): the Review tab owns the
        // accept/reject decision — see the module doc
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
    if (result.cancelled) {
      return { ok: false, summary: 'the task was stopped before it finished', edits }
    }
    return { ok: true, summary: result.text, edits }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, summary: message, edits }
  }
}

/**
 * Subscribe the live editor to delegated tasks. One task at a time (the
 * shell's busy rule is the outer gate; this guard is defense in depth).
 * Readiness is announced once the editor and document exist, mirroring the
 * MCP bridge, so the shell routes only at a tab that can actually run.
 * Returns the unsubscribe function.
 */
export function installHeadlessAgentBridge(deps: HeadlessAgentDeps): () => void {
  const desktop = window.desktop
  if (!desktop?.onAgentTaskCommand || !desktop.reportAgentTaskResult) return () => {}
  let cancelled = false
  let cancelCurrent: (() => void) | null = null
  let currentTaskId: string | null = null
  // the readiness twin of the MCP bridge's announce: the shell keeps a
  // ready-set per tab and refuses (fast, with a wait hint) otherwise
  void announceWhenLoaded(
    { getCtx: deps.getCtx },
    () => desktop.signalAgentReady?.(),
    () => cancelled,
  )

  const unsubscribeCommands = desktop.onAgentTaskCommand(async (message) => {
    if (!message || typeof message.taskId !== 'string' || typeof message.task !== 'string') {
      return
    }
    if (currentTaskId !== null) {
      desktop.reportAgentTaskResult({
        taskId: message.taskId,
        ok: false,
        summary: 'this document is already running a task',
      })
      return
    }
    const taskId = message.taskId
    currentTaskId = taskId
    // the gsk verdict is read per task: the login can change between tasks
    let gskLoggedIn: boolean
    try {
      gskLoggedIn = !!(await window.desktop.aiGskStatus?.())?.loggedIn
    } catch {
      gskLoggedIn = false
    }
    // the loop's cancel stops the model stream AND the in-flight tool; the
    // run settles as cancelled and its (partial) edits still report
    cancelCurrent = null
    const outcome = await runTask(
      deps,
      message.task,
      (status) => desktop.reportAgentTaskProgress({ taskId, status }),
      gskLoggedIn,
      (cancel) => (cancelCurrent = cancel),
    )
    currentTaskId = null
    cancelCurrent = null
    desktop.reportAgentTaskResult({
      taskId,
      ok: outcome.ok,
      summary: outcome.summary,
      edits: outcome.edits,
    })
  })

  const unsubscribeAborts = desktop.onAgentTaskAbort((message) => {
    if (message && typeof message.taskId === 'string' && message.taskId === currentTaskId) {
      cancelCurrent?.()
    }
  })

  return () => {
    cancelled = true
    unsubscribeCommands()
    unsubscribeAborts()
    cancelCurrent?.()
  }
}
