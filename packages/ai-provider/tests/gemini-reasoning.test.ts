import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentToolCall } from '@genoffice/agent-core'
import { streamGemini } from '../src/protocols/gemini'

function callbacks(events: string[]) {
  return {
    signal: new AbortController().signal,
    onDelta: (text: string) => events.push(`text:${text}`),
    onReasoningDelta: (text: string) => events.push(`reasoning:${text}`),
    onToolCall: (call: AgentToolCall) => events.push(`tool:${call.name}:${call.signature ?? ''}`),
  }
}

function mockResponse(body: string, contentType: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => new Response(body, { status: 200, headers: { 'content-type': contentType } }),
    ),
  )
}

async function run(events: string[]): Promise<void> {
  await streamGemini(
    { apiKey: 'test-key', model: 'gemini-3.8-flash' },
    'system',
    [{ role: 'user', text: 'inspect this' }],
    [],
    1024,
    callbacks(events),
    'https://gemini.example.test/v1beta',
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('Gemini thought summaries', () => {
  it('keeps streamed thoughts out of the answer while preserving text and tool order', async () => {
    const chunks = [
      { candidates: [{ content: { parts: [{ text: 'Compare the ranges.', thought: true }] } }] },
      { candidates: [{ content: { parts: [{ text: 'I will inspect the sheet.' }] } }] },
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { name: 'sheets:read_range', args: { range: 'A1:B2' } },
                  thoughtSignature: 'signature-1',
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      },
    ]
    mockResponse(
      chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(''),
      'text/event-stream',
    )
    const events: string[] = []
    await run(events)
    expect(events).toEqual([
      'reasoning:Compare the ranges.',
      'text:I will inspect the sheet.',
      'tool:sheets:read_range:signature-1',
    ])
  })

  it('routes thoughts in a complete JSON body to reasoning without duplicating them', async () => {
    mockResponse(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { text: 'First inspect the selection.', thought: true },
                { text: 'The selection contains two rows.' },
                { functionCall: { name: 'sheets:read_range', args: { range: 'A8:A9' } } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      }),
      'application/json',
    )
    const events: string[] = []
    await run(events)
    expect(events).toEqual([
      'reasoning:First inspect the selection.',
      'text:The selection contains two rows.',
      'tool:sheets:read_range:',
    ])
    expect(events.filter((event) => event.includes('First inspect'))).toHaveLength(1)
  })
})
