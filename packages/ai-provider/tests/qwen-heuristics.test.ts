import { afterEach, describe, expect, it, vi } from 'vitest'
import { modelEchoesReasoning } from '../src/model-heuristics'
import { streamForProvider } from '../src/stream'
import { okResponse, sseStream } from './test-utils'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('modelEchoesReasoning: Qwen3 and Qwen3.8 thinking families', () => {
  it('matches Qwen3 and Qwen3.8 model ids across casings and vendor prefixes', () => {
    for (const model of [
      'Qwen3.8-Flash-Next-4bit',
      'qwen3.8-max',
      'qwen3.8-flash',
      'qwen3.7-plus',
      'qwen3.6-plus',
      'qwen3.5-27b',
      'qwen3-32b',
      'qwen3',
      'qwen/qwen3.8-max',
      'mlx-community/Qwen3.8-Flash-Next-4bit',
    ]) {
      expect(modelEchoesReasoning(model)).toBe(true)
    }
  })

  it('does not over-match legacy Qwen2/unversioned ids or unrelated prefixes', () => {
    for (const model of ['qwen2.5-72b', 'qwen-max', 'qwen-plus', 'qwen30', 'my-qwen3']) {
      expect(modelEchoesReasoning(model)).toBe(false)
    }
  })

  it('preserves reasoning_content on multi-turn tool calls for Qwen3.8-Flash-Next-4bit in legacy OpenAI streams', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        okResponse(
          sseStream([
            'data: {"choices":[{"delta":{"reasoning_content":"next step"}}]}',
            'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}',
            'data: [DONE]',
          ]),
        ),
      )
    vi.stubGlobal('fetch', fetchMock)

    const reasoning: string[] = []
    const deltas: string[] = []
    await streamForProvider(
      'custom',
      {
        baseUrl: 'http://192.168.100.235:7000/v1',
        apiKey: '1234',
        model: 'Qwen3.8-Flash-Next-4bit',
      },
      'sys',
      [
        { role: 'user', text: 'inspect file' },
        {
          role: 'assistant',
          text: '',
          toolCalls: [{ id: 'call_1', name: 'read_file', input: { path: 'a.txt' } }],
          reasoning: 'I should read a.txt first',
        },
        { role: 'tool', results: [{ id: 'call_1', name: 'read_file', output: 'hello' }] },
      ],
      [],
      1024,
      {
        signal: new AbortController().signal,
        onDelta: (text) => deltas.push(text),
        onReasoningDelta: (text) => reasoning.push(text),
        onToolCall: () => {},
      },
    )

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    const assistant = body.messages.find((m: { role: string }) => m.role === 'assistant')
    expect(assistant.reasoning_content).toBe('I should read a.txt first')
    expect(reasoning.join('')).toBe('next step')
    expect(deltas.join('')).toBe('done')
  })
})
