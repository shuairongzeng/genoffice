import type { AgentToolDef } from './types'
import type { AgentSkill, ExecutedToolCall } from './skill'

/**
 * The dock's document-agent delegation: the global panel hands a document
 * task to the ACTIVE document tab's own agent — a headless copy of that app's
 * agent loop running inside the tab's renderer against the live document
 * (docs, sheets, slides, pdf, markdown/plain text, html). One confirm card gates
 * the whole delegated task (risk:'high', the card's arguments show the task
 * text); within the task the sub-agent's own write ops run under that mandate
 * because nobody sits at the suppressed in-app panel to answer per-tool cards.
 * Every edit creates a checkpoint (alongside the editor's own undo/revision
 * stack) so the user can revert the run cleanly from the global panel.
 *
 * The main side routes the call to the active document tab (a guiding error
 * when none is active or another task is already running there), relays the
 * sub-agent's live progress to the panel, and aborts it when the global run is
 * cancelled or the tab closes.
 */
export const DOCUMENT_AGENT_TOOL = 'document_agent'

/** document tab kinds that expose a headless in-tab agent via HEADLESS_AGENT_CHANNELS */
export const AGENT_DOCUMENT_KINDS: ReadonlySet<string> = new Set([
  'docs',
  'sheets',
  'slides',
  'pdf',
  'markdown',
  'html',
])

/** unified IPC channels between shell main and every document app's headless agent */
export const HEADLESS_AGENT_CHANNELS = {
  task: 'app:agent-task',
  progress: 'app:agent-task-progress',
  result: 'app:agent-task-result',
  abort: 'app:agent-task-abort',
  ready: 'app:agent-ready',
  undo: 'app:agent-undo',
  undoResult: 'app:agent-undo-result',
} as const

/** longest task text the tool accepts (the whole text rides the card and the channel) */
export const MAX_AGENT_TASK_CHARS = 4_000

/**
 * One live status of the sub-agent's work, as the panel renders it. The kind
 * is semantic (the host localizes it); the raw tool name rides along for
 * hosts that want it.
 */
export type AgentTaskStatusKind =
  | 'thinking'
  | 'reading'
  | 'inserting'
  | 'replacing'
  | 'applying'
  | 'writing'
  | 'image'
  | 'analyzing'
  | 'other'

export interface AgentTaskStatus {
  kind: AgentTaskStatusKind
  /** the sub-agent tool currently running (its raw name) */
  tool?: string
}

/** the sub-agent's answer to one delegated task */
export interface AgentTaskResult {
  ok: boolean
  /** the sub-agent's final summary text (what it did, in its own words) */
  summary: string
  /** the write ops the task applied, as the report of what changed */
  edits?: readonly { tool: string; summary: string }[]
  /** rollback checkpoint id emitted by the app when edits were applied */
  checkpointId?: string
  /** target tab metadata filled by shell main */
  tabId?: string
  kind?: string
  title?: string
}

export interface DocumentAgentDeps {
  /**
   * Run one delegated task on the active document tab. Rejects with the
   * routing and lifetime errors (no document open, non-document tab active,
   * busy, timeout, tab closed mid-task, aborted) — the message is the
   * model-facing tool result.
   */
  runAgentTask(task: string): Promise<AgentTaskResult>
  /**
   * Ask the main side to abort the in-flight delegated task: wired to the
   * bridge's cancel channel and called when the run's abort signal fires, so
   * the global Stop button stops the sub-agent too, not just the wait.
   */
  cancelAgentTask?(): void
  /**
   * Optional hook fired right after a delegated task succeeds so the host panel
   * can attach rollback checkpoints to the active assistant message.
   */
  onTaskResult?(result: AgentTaskResult): void
}

const DOCUMENT_AGENT_SYSTEM_PROMPT = `## Delegating document work (document_agent)
Every open document tab in GenOffice (Word \`docs\`, spreadsheets \`sheets\`,
presentations \`slides\`, PDFs \`pdf\`, Markdown/plain-text \`markdown\`, HTML \`html\`)
has its own live in-app assistant accessible through \`document_agent\`.
The in-app AI sidebar is hidden while hosted in the Shell, so this tool is the
ONLY and DEFAULT way to edit or operate on any open document — NEVER tell the
user to switch to the app's own AI panel, and NEVER rewrite the file on disk
with create_document, edit_file or delete_file (that would fork disk state
from the live editor):
- Target: acts on the currently ACTIVE document tab. If the target document is
  open in another tab, switch to it first with \`shell:switch_tab\` before
  calling \`document_agent\`.
- Write the task as a complete, self-contained instruction: the assistant sees
  only the task text and the live document — none of this conversation. Include
  exact values, formulas, cell addresses, page numbers or section headings you
  already retrieved or computed here.
- Undoable by default: each task that mutates a document captures a rollback
  checkpoint automatically (one click to undo in the panel, plus editor Ctrl+Z).
- One task at a time per document; a second call while it works is refused.
- While it works its live status streams back; the final result carries its
  summary and the edits it made (tools and counts). Report what IT reported —
  never claim document changes this tool did not return.
- Use it for all document edits across all 6 kinds — small or large ("把这份文档的标题改成《神兽研究》",
  "put =SUM(E2:E7) in E8 and format currency", "rename slide 2 title",
  "highlight paragraph 1 in page 3", "update lines 10-12 in notes.txt",
  "change hero background in index.html"). Reading an open document can also use
  the read tools (such as docs:read_document / sheets:read_sheet), or delegate
  directly when reading + editing belong together.`

export function createDocumentAgentSkill(deps: DocumentAgentDeps): AgentSkill {
  const tool: AgentToolDef = {
    name: DOCUMENT_AGENT_TOOL,
    description:
      'Delegate a task to the document assistant working inside the active open ' +
      'document tab (Word docs, spreadsheets, presentations, PDFs, Markdown/plain text, ' +
      'or HTML) — the FIRST choice for any edit, rewrite, formatting, formula, chart, ' +
      'slide change, PDF annotation/page operation, or text update on an open document. ' +
      'All edits create an undoable checkpoint automatically. The task must be ' +
      'self-contained (the assistant sees only the task and the live document). ' +
      'If the target document is not active yet, call shell:switch_tab first. ' +
      'NEVER rewrite or replace a file an app has open behind the editor.',
    // one delegated task = one card: the sub-agent's own writes run under this mandate
    risk: 'high',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'the complete, self-contained instruction for the document assistant',
        },
      },
      required: ['task'],
    },
  }
  return {
    id: 'document-agent',
    systemPrompt: DOCUMENT_AGENT_SYSTEM_PROMPT,
    tools: [tool],
    executeTool: async (call, signal) => {
      if (call.name !== DOCUMENT_AGENT_TOOL) {
        return { output: `unknown tool: ${call.name}`, isError: true, summary: call.name }
      }
      const task = call.input.task
      if (typeof task !== 'string' || !task.trim()) {
        return badInput('`task` must be a non-empty string (a complete instruction)')
      }
      if (task.length > MAX_AGENT_TASK_CHARS) {
        return badInput(`\`task\` must be at most ${MAX_AGENT_TASK_CHARS} characters`)
      }
      // the global run's abort reaches the sub-agent: a Stop mid-task stops
      // the document work too, not only the panel's wait for it
      const offAbort = deps.cancelAgentTask ? abortOn(signal, () => deps.cancelAgentTask?.()) : null
      try {
        const result = await deps.runAgentTask(task)
        if (!result.ok) {
          return {
            output: `the document assistant did not finish the task: ${result.summary}`,
            isError: true,
            summary: 'document task failed',
          }
        }
        deps.onTaskResult?.(result)
        const edits = result.edits ?? []
        const editLines = edits
          .slice(0, 12)
          .map((edit) => `  - ${edit.tool}: ${edit.summary}`)
          .join('\n')
        return {
          output:
            `the document assistant finished the task.\n  summary: ${result.summary}` +
            (edits.length > 0
              ? `\n  edits (${edits.length}):${edits.length > 12 ? '\n  … and more' : ''}\n${editLines}`
              : '\n  edits: none (it only read or analyzed)'),
          summary:
            edits.length > 0 ? `document assistant · ${edits.length} edits` : 'document assistant',
          mutated: edits.length > 0,
        }
      } catch (error) {
        // the routing/lifetime errors (no document, busy, timeout, closed,
        // aborted) are the model-facing reason
        return {
          output: error instanceof Error ? error.message : String(error),
          isError: true,
          summary: 'document task refused',
        }
      } finally {
        offAbort?.()
      }
    },
    verifyResponse: (finalText, executed: readonly ExecutedToolCall[]) => {
      const delegated = executed.some((c) => c.name === DOCUMENT_AGENT_TOOL && c.ok)
      if (delegated) return null
      if (
        !/\b(?:document assistant|sub-agent)\b|文档助手|表格助手|演示助手|PDF\s*助手|Markdown\s*助手|HTML\s*助手/i.test(
          finalText,
        )
      ) {
        return null
      }
      return (
        'The reply describes what the document assistant did, but document_agent did not ' +
        'succeed in this run. Report only what you actually did here, or call document_agent.'
      )
    },
  }
}

/** fire `onAbort` once when the signal aborts; answers the un-listener */
function abortOn(signal: AbortSignal | undefined, onAbort: () => void): (() => void) | null {
  if (!signal) return null
  const listener = (): void => onAbort()
  signal.addEventListener('abort', listener, { once: true })
  return () => signal.removeEventListener('abort', listener)
}

function badInput(message: string) {
  return {
    output: `${message}; the tool was not executed. Call again with the corrected argument.`,
    isError: true,
    summary: 'document_agent input',
  }
}
