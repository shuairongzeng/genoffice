import { describe, expect, it } from 'vitest'
import {
  TOOL_ABORTED_OUTPUT,
  TOOL_DENIED_OUTPUT,
  type AgentToolCall,
  type ToolExecution,
} from '@genoffice/agent-core'
import {
  ASK_TOOL_ACTIVITY_PREVIEW_LIMIT,
  finishAskToolActivity,
  startAskToolActivity,
} from '../src/renderer/src/ask-activity'

const call: AgentToolCall = { id: 'call-1', name: 'shell:read', input: { path: '/tmp/a.md' } }
const execution: ToolExecution = { output: 'contents', summary: 'shell:read' }

describe('ask tool activity', () => {
  it('tracks a running call and settles it without mutating the original list', () => {
    const running = startAskToolActivity([], call)
    expect(running[0]).toMatchObject({ id: 'call-1', status: 'running' })
    expect(running[0]?.inputPreview).toContain('/tmp/a.md')
    const done = finishAskToolActivity(running, call, execution)
    expect(done[0]).toMatchObject({ status: 'done', outputPreview: 'contents' })
    expect(running[0]?.status).toBe('running')
  })

  it('maps errors, denials and cancellation to distinct states', () => {
    expect(finishAskToolActivity([], call, { ...execution, isError: true })[0]?.status).toBe(
      'error',
    )
    expect(
      finishAskToolActivity([], call, {
        output: TOOL_DENIED_OUTPUT,
        summary: call.name,
        isError: true,
        denied: true,
      })[0]?.status,
    ).toBe('denied')
    expect(
      finishAskToolActivity([], call, {
        output: TOOL_ABORTED_OUTPUT,
        summary: call.name,
        isError: true,
      })[0]?.status,
    ).toBe('cancelled')
  })

  it('keeps a completion that arrives without a start event', () => {
    const items = finishAskToolActivity([], call, execution)
    expect(items).toHaveLength(1)
    expect(items[0]?.status).toBe('done')
  })

  it('updates a repeated id in place and keeps other calls in their original order', () => {
    const other = { ...call, id: 'call-2', name: 'shell:write' }
    const started = startAskToolActivity(startAskToolActivity([], call), other)
    const finished = finishAskToolActivity(started, call, execution)
    expect(finished.map((item) => item.id)).toEqual(['call-1', 'call-2'])
    expect(finished[0]?.status).toBe('done')
    expect(finished[1]?.status).toBe('running')
  })

  it('redacts secret-looking input and output before storing previews', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456'
    const items = startAskToolActivity([], { ...call, input: { token: secret } })
    expect(items[0]?.inputPreview).not.toContain(secret)
    expect(items[0]?.inputPreview).toContain('REDACTED_API_KEY')
    const done = finishAskToolActivity(items, call, { ...execution, output: `token=${secret}` })
    expect(done[0]?.outputPreview).not.toContain(secret)
  })

  it('caps long previews and reports the omitted character count', () => {
    const items = finishAskToolActivity([], call, {
      ...execution,
      output: 'x'.repeat(ASK_TOOL_ACTIVITY_PREVIEW_LIMIT + 25),
    })
    expect(items[0]?.outputPreview).toHaveLength(ASK_TOOL_ACTIVITY_PREVIEW_LIMIT + 23)
    expect(items[0]?.outputPreview).toContain('[truncated 25 chars]')
  })

  it('uses a readable fallback for unserializable input and empty output', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const running = startAskToolActivity([], { ...call, input: circular })
    expect(running[0]?.inputPreview).toBe('[unserializable tool input]')
    const done = finishAskToolActivity(running, call, { output: '', summary: call.name })
    expect(done[0]?.outputPreview).toBe(call.name)
  })
})
