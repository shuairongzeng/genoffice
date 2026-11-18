import {
  TOOL_ABORTED_OUTPUT,
  sanitizeAgentPayload,
  type AgentToolCall,
  type ToolExecution,
} from '@genoffice/agent-core'

export type AskToolActivityStatus = 'running' | 'done' | 'error' | 'denied' | 'cancelled'

export interface AskToolActivity {
  readonly id: string
  readonly name: string
  readonly call: AgentToolCall
  readonly status: AskToolActivityStatus
  readonly inputPreview: string
  readonly outputPreview?: string
  readonly detail?: string
}

export const ASK_TOOL_ACTIVITY_PREVIEW_LIMIT = 4000

function preview(text: string, limit = ASK_TOOL_ACTIVITY_PREVIEW_LIMIT): string {
  const safe = sanitizeAgentPayload(text)
  if (safe.length <= limit) return safe
  return `${safe.slice(0, limit)}\n… [truncated ${safe.length - limit} chars]`
}

function inputPreview(input: Record<string, unknown>): string {
  try {
    return preview(JSON.stringify(input, null, 2) ?? String(input))
  } catch {
    return '[unserializable tool input]'
  }
}

function activity(
  call: AgentToolCall,
  status: AskToolActivityStatus,
  outputPreview?: string,
): AskToolActivity {
  return {
    id: call.id,
    name: call.name,
    call,
    status,
    inputPreview: inputPreview(call.input),
    ...(outputPreview === undefined ? {} : { outputPreview }),
  }
}

function upsert(items: readonly AskToolActivity[], next: AskToolActivity): AskToolActivity[] {
  const index = items.findIndex((item) => item.id === next.id)
  if (index < 0) return [...items, next]
  return items.map((item, i) => (i === index ? { ...item, ...next } : item))
}

export function startAskToolActivity(
  items: readonly AskToolActivity[],
  call: AgentToolCall,
): AskToolActivity[] {
  return upsert(items, activity(call, 'running'))
}

export function finishAskToolActivity(
  items: readonly AskToolActivity[],
  call: AgentToolCall,
  execution: ToolExecution,
): AskToolActivity[] {
  const status: AskToolActivityStatus = execution.denied
    ? 'denied'
    : execution.output === TOOL_ABORTED_OUTPUT
      ? 'cancelled'
      : execution.isError
        ? 'error'
        : 'done'
  return upsert(items, activity(call, status, preview(execution.output || execution.summary || '')))
}
