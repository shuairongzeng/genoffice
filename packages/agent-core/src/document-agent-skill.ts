import type { AgentToolDef } from './types'
import type { AgentSkill, ExecutedToolCall } from './skill'

/**
 * The dock's document-agent delegation: the global panel hands a document
 * task to the ACTIVE document tab's own agent — the headless copy of the
 * docs app's loop with its full toolset (insert/replace/ops, charts,
 * comments, notes), running inside that app's renderer against the live
 * editor. One confirm card gates the whole delegated task (risk:'high', the
 * card's arguments show the task text); within the task the sub-agent's own
 * write ops run under that mandate — its loop auto-allows confirms because
 * there is no person at the in-app panel to ask (the app's revision system
 * tracks every change for undo).
 *
 * The main side routes the call to the active docs tab (a guiding error when
 * none is open or another task is already running there), relays the
 * sub-agent's live progress to the panel (the rolling "文档助手：…" status
 * line), and aborts it when the global run is cancelled or the tab closes.
 */
export const DOCUMENT_AGENT_TOOL = 'document_agent'

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
}

export interface DocumentAgentDeps {
  /**
   * Run one delegated task on the active document tab. Rejects with the
   * routing and lifetime errors (no document open, wrong kind, busy,
   * timeout, tab closed mid-task, aborted) — the message is the model-facing
   * tool result.
   */
  runAgentTask(task: string): Promise<AgentTaskResult>
  /**
   * Ask the main side to abort the in-flight delegated task: wired to the
   * bridge's cancel channel and called when the run's abort signal fires, so
   * the global Stop button stops the sub-agent too, not just the wait.
   */
  cancelAgentTask?(): void
}

const DOCUMENT_AGENT_SYSTEM_PROMPT = `## Delegating document work (document_agent)
The active Word document has its own agent — the document assistant — with
the full editing toolset (insert content, replace blocks, apply ops, charts,
comments, notes, long-form writing). Call document_agent to hand it a task
instead of editing the document from here:
- Write the task as a complete, self-contained instruction: the assistant
  sees only the task text and the document — none of this conversation.
- One task at a time per document; a second call while it works is refused.
- While it works its live status streams back; the final result carries its
  summary and the edits it made (tools and counts). Report what IT reported —
  never claim document changes this tool did not return.
- Use it for document-shaped work (draft a section, restructure, fix
  formatting, add a chart or comment). Reading the document is your own
  docs:read_document call; small questions do not need a delegation.`

export function createDocumentAgentSkill(deps: DocumentAgentDeps): AgentSkill {
  const tool: AgentToolDef = {
    name: DOCUMENT_AGENT_TOOL,
    description:
      'Delegate a task to the document assistant working inside the active Word ' +
      'document. It has the full editing toolset and reports a summary plus the edits ' +
      'it made. The task must be self-contained (the assistant sees only the task and ' +
      'the document). One task per document at a time.',
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
      if (!/\b(?:document assistant|sub-agent)\b|文档助手/i.test(finalText)) return null
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
