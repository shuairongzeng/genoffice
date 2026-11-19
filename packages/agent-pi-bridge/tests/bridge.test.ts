// Unit tests for the pi bridge's capability backfills: onActivity mapping
// during tool-argument streaming, the GenOffice watchdog wrapped around pi's
// streamSimple, and the typed error mapping onto the legacy error classes.
// The pi stream is faked with a scripted event generator; no network involved.
import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  AI_CONNECT_TIMEOUT_MS,
  AI_IDLE_TIMEOUT_MS,
  AiCreditsError,
  AiTimeoutError,
  isAiNetworkError,
  isAiOverloadedError,
  isAiRegionBlockedError,
  type AiSettings,
  type StreamCallbacks,
} from '@genoffice/ai-provider'
import { mapPiErrorEvent, streamViaPi, chatViaPi } from '../src/index'

type MockProviderInput = {
  id: string
  baseUrl?: string
  headers?: Record<string, string>
  models: Array<Record<string, unknown>>
  auth?: {
    apiKey?: {
      resolve: () => Promise<{ auth: { apiKey?: string } } | undefined>
    }
  }
}

// Scripted pi-side state: `events` is what the fake streamSimple yields; a
// `{ type: 'hang' }` marker stalls until the request signal aborts, then ends
// with the abort-shaped error event the real adapters emit.
const pi = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
  lastModel: undefined as Record<string, unknown> | undefined,
  lastContext: undefined as { messages?: Array<Record<string, unknown>> } | undefined,
  lastOptions: undefined as { signal?: AbortSignal; maxTokens?: number } | undefined,
  providers: new Map<string, MockProviderInput>(),
  setProviderCalls: [] as MockProviderInput[],
  createProviderCalls: [] as MockProviderInput[],
}))

vi.mock('@earendil-works/pi-ai', () => ({
  createModels: () => ({
    getProvider: (id: string) => pi.providers.get(id),
    setProvider: (provider: MockProviderInput) => {
      pi.setProviderCalls.push(provider)
      pi.providers.set(provider.id, provider)
    },
    streamSimple: (model: unknown, context: unknown, options: unknown) => {
      pi.lastModel = model as Record<string, unknown>
      pi.lastContext = context as { messages?: Array<Record<string, unknown>> }
      pi.lastOptions = options as { signal?: AbortSignal; maxTokens?: number }
      return fakePiStream(pi.lastOptions?.signal)
    },
  }),
  createProvider: (input: MockProviderInput) => {
    pi.createProviderCalls.push(input)
    return input
  },
}))
vi.mock('@earendil-works/pi-ai/api/anthropic-messages.lazy', () => ({
  anthropicMessagesApi: () => ({}),
}))
vi.mock('@earendil-works/pi-ai/api/google-generative-ai.lazy', () => ({
  googleGenerativeAIApi: () => ({}),
}))
vi.mock('@earendil-works/pi-ai/api/openai-completions.lazy', () => ({
  openAICompletionsApi: () => ({}),
}))

function fakePiStream(signal?: AbortSignal) {
  return (async function* () {
    for (const ev of pi.events) {
      if (ev.type === 'hang') {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve()
          signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        yield { type: 'error', reason: 'aborted', error: { errorMessage: 'Request aborted' } }
        return
      }
      yield ev
    }
  })()
}

const settings = {
  provider: 'custom',
  providers: {
    custom: {
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'test-key',
      model: 'test-model',
      profile: { compat: { vision: true } },
    },
  },
} as unknown as AiSettings

const userTurn = [{ role: 'user', text: 'hi' }] as Parameters<typeof streamViaPi>[2]

function makeCallbacks(): StreamCallbacks & { recorded: Record<string, unknown[]> } {
  const recorded: Record<string, unknown[]> = {
    delta: [],
    reasoningDelta: [],
    toolCall: [],
    activity: [],
    usage: [],
    stopReason: [],
  }
  const cb: StreamCallbacks = {
    onDelta: (t) => recorded.delta.push(t),
    onToolCall: (c) => recorded.toolCall.push(c),
    onActivity: () => recorded.activity.push(null),
    onReasoningDelta: (t) => recorded.reasoningDelta.push(t),
    onUsage: (u) => recorded.usage.push(u),
    onStopReason: (r) => recorded.stopReason.push(r),
    signal: new AbortController().signal,
  }
  return Object.assign(cb, { recorded })
}

beforeEach(() => {
  pi.events = []
  pi.lastModel = undefined
  pi.lastContext = undefined
  pi.lastOptions = undefined
  pi.providers.clear()
  pi.setProviderCalls = []
  pi.createProviderCalls = []
})

describe('onActivity mapping', () => {
  it('pings on stream start and during tool-argument streaming, not on text deltas', async () => {
    pi.events = [
      { type: 'start', partial: {} },
      { type: 'text_delta', contentIndex: 0, delta: 'He', partial: {} },
      { type: 'text_delta', contentIndex: 0, delta: 'llo', partial: {} },
      { type: 'toolcall_start', contentIndex: 1, partial: {} },
      { type: 'toolcall_delta', contentIndex: 1, delta: '{"path":"', partial: {} },
      { type: 'toolcall_delta', contentIndex: 1, delta: 'a.txt"}', partial: {} },
      {
        type: 'toolcall_end',
        contentIndex: 1,
        toolCall: {
          type: 'toolCall',
          id: 'call_1',
          name: 'read_file',
          arguments: { path: 'a.txt' },
        },
        partial: {},
      },
      { type: 'done', reason: 'toolUse', message: { usage: { input: 3, output: 5 } } },
    ]
    const cb = makeCallbacks()
    await streamViaPi(settings, 'sys', userTurn, [], 1024, cb)

    // start (headers arrived) + toolcall_start + 2 argument deltas
    expect(cb.recorded.activity).toHaveLength(4)
    // text and tool callbacks keep their existing semantics
    expect(cb.recorded.delta).toEqual(['He', 'llo'])
    expect(cb.recorded.toolCall).toEqual([
      { id: 'call_1', name: 'read_file', input: { path: 'a.txt' } },
    ])
    expect(cb.recorded.usage).toEqual([{ inputTokens: 3, outputTokens: 5 }])
    expect(cb.recorded.stopReason).toEqual(['toolUse'])
  })

  it('forwards the clamped output cap and an abortable signal to pi', async () => {
    pi.events = [{ type: 'done', reason: 'stop', message: {} }]
    await streamViaPi(settings, 'sys', userTurn, [], 4096, makeCallbacks())
    expect(pi.lastOptions?.maxTokens).toBe(4096)
    expect(pi.lastOptions?.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('watchdog alignment', () => {
  it('trips the legacy connect watchdog on a stalled stream and throws AiTimeoutError', async () => {
    vi.useFakeTimers()
    try {
      pi.events = [{ type: 'hang' }]
      const promise = streamViaPi(settings, 'sys', userTurn, [], 1024, makeCallbacks())
      // attach the handler before the timer fires so the rejection is never unhandled
      const expectation = expect(promise).rejects.toBeInstanceOf(AiTimeoutError)
      await vi.advanceTimersByTimeAsync(AI_CONNECT_TIMEOUT_MS + 5_000)
      await expectation
    } finally {
      vi.useRealTimers()
    }
  })

  it('routes caller cancellation through the watchdog signal and stays an untyped abort', async () => {
    pi.events = [{ type: 'hang' }]
    const controller = new AbortController()
    const cb = makeCallbacks()
    const promise = streamViaPi(settings, 'sys', userTurn, [], 1024, {
      ...cb,
      signal: controller.signal,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    // the IPC layer recognizes cancellations via the request signal before
    // error classes, so the bridge must not disguise them as typed failures
    await expect(promise).rejects.toThrow('Request aborted')
  })
})

describe('pi error event mapping', () => {
  it('maps a credits-exhaustion notice to AiCreditsError', async () => {
    pi.events = [
      {
        type: 'error',
        reason: 'error',
        error: {
          errorMessage: '402: {"error":{"message":"Your Genspark credits have been exhausted"}}',
        },
      },
    ]
    const promise = streamViaPi(settings, 'sys', userTurn, [], 1024, makeCallbacks())
    await expect(promise).rejects.toBeInstanceOf(AiCreditsError)
    await expect(promise).rejects.toThrow(/credits have been exhausted/)
  })

  it('rewrites the HTTP status prefix so the overloaded classifier matches', async () => {
    pi.events = [
      {
        type: 'error',
        reason: 'error',
        error: { errorMessage: '429: {"error":{"message":"Too many requests, slow down."}}' },
      },
    ]
    const promise = streamViaPi(settings, 'sys', userTurn, [], 1024, makeCallbacks())
    const rejection = await promise.then(
      () => undefined,
      (err) => err,
    )
    expect(rejection).toBeInstanceOf(Error)
    expect(rejection.message).toMatch(/^HTTP 429: /)
    expect(isAiOverloadedError(rejection)).toBe(true)
  })

  it('classifies the OpenAI SDK connection-error wording as a network failure', async () => {
    pi.events = [{ type: 'error', reason: 'error', error: { errorMessage: 'Connection error.' } }]
    const promise = streamViaPi(settings, 'sys', userTurn, [], 1024, makeCallbacks())
    const rejection = await promise.then(
      () => undefined,
      (err) => err,
    )
    expect(isAiNetworkError(rejection)).toBe(true)
  })

  it('keeps region-blocked bodies classifiable', async () => {
    pi.events = [
      {
        type: 'error',
        reason: 'error',
        error: {
          errorMessage: '403: {"error":{"message":"Country, region, or territory not supported"}}',
        },
      },
    ]
    const promise = streamViaPi(settings, 'sys', userTurn, [], 1024, makeCallbacks())
    const rejection = await promise.then(
      () => undefined,
      (err) => err,
    )
    expect(isAiRegionBlockedError(rejection)).toBe(true)
  })

  it('passes provider-specific failures through as plain errors', () => {
    expect(mapPiErrorEvent('Stream ended without finish_reason').message).toBe(
      'Stream ended without finish_reason',
    )
    expect(mapPiErrorEvent('Request was aborted.').message).toBe('Request was aborted.')
    expect(mapPiErrorEvent('418: teapot').message).toBe('HTTP 418: teapot')
    expect(mapPiErrorEvent('418 teapot').message).toBe('HTTP 418: teapot')
    // the shape a plain-text body produces on the local gateway (verified live)
    expect(mapPiErrorEvent('401 "Invalid API key"').message).toBe('HTTP 401: "Invalid API key"')
    expect(mapPiErrorEvent().message).toBe('stream error')
    expect(mapPiErrorEvent('402: insufficient credits')).toBeInstanceOf(AiCreditsError)
  })
})

describe('chatViaPi', () => {
  it('collects text and reports mapped stream failures as ok:false', async () => {
    pi.events = [
      { type: 'start', partial: {} },
      { type: 'text_delta', contentIndex: 0, delta: 'Hi ', partial: {} },
      { type: 'text_delta', contentIndex: 0, delta: 'there', partial: {} },
      { type: 'done', reason: 'stop', message: {} },
    ]
    await expect(chatViaPi(settings, 'sys', 'hello')).resolves.toEqual({
      ok: true,
      content: 'Hi there',
    })

    pi.events = [
      {
        type: 'error',
        reason: 'error',
        error: { errorMessage: '503: {"error":{"message":"overloaded"}}' },
      },
    ]
    const result = await chatViaPi(settings, 'sys', 'hello')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/^HTTP 503: /)
    expect(isAiOverloadedError(result.error)).toBe(true)
  })
})

describe('frozen codex protocol gap', () => {
  it('throws an explicit error instead of attempting an HTTP codex call', async () => {
    const codexSettings = {
      provider: 'codex',
      providers: { codex: { model: 'gpt-5-codex' } },
    } as unknown as AiSettings
    await expect(
      streamViaPi(codexSettings, 'sys', userTurn, [], 1024, makeCallbacks()),
    ).rejects.toThrow(/codex.*GENOFFICE_AI_BACKEND=legacy/)
  })
})

describe('dynamic custom endpoint updates and compatibility', () => {
  it('updates models.setProvider and auth on every call instead of caching the first provider', async () => {
    pi.events = [{ type: 'done', reason: 'stop', message: {} }]
    await streamViaPi(settings, 'sys', userTurn, [], 1024, makeCallbacks())

    const qwenSettings = {
      provider: 'custom',
      providers: {
        custom: {
          baseUrl: 'http://192.168.100.235:7000/v1',
          apiKey: '1234',
          model: 'Qwen3.8-Flash-Next-4bit',
          profile: {
            headers: { 'X-Tenant': 'local-qwen' },
          },
        },
      },
    } as unknown as AiSettings

    pi.events = [{ type: 'done', reason: 'stop', message: {} }]
    await streamViaPi(qwenSettings, 'sys', userTurn, [], 1024, makeCallbacks())

    expect(pi.createProviderCalls).toHaveLength(2)
    expect(pi.setProviderCalls).toHaveLength(2)

    const secondProvider = pi.providers.get('custom')!
    expect(secondProvider.baseUrl).toBe('http://192.168.100.235:7000/v1')
    expect(secondProvider.models[0]?.id).toBe('Qwen3.8-Flash-Next-4bit')
    expect(secondProvider.models[0]?.headers).toEqual({ 'X-Tenant': 'local-qwen' })
    await expect(secondProvider.auth?.apiKey?.resolve()).resolves.toEqual({
      auth: { apiKey: '1234' },
    })

    expect(pi.lastModel?.baseUrl).toBe('http://192.168.100.235:7000/v1')
    expect(pi.lastModel?.id).toBe('Qwen3.8-Flash-Next-4bit')
    expect(pi.lastModel?.headers).toEqual({ 'X-Tenant': 'local-qwen' })
    expect(pi.lastModel?.compat).toBeUndefined()
  })

  it('maps supported compat flags, model maxTokens ceiling, and endpoint protocol', async () => {
    const compatSettings = {
      provider: 'custom',
      providers: {
        custom: {
          baseUrl: 'http://192.168.100.235:7000/v1',
          apiKey: '1234',
          model: 'Qwen3.8-Flash-Next-4bit',
          profile: {
            compat: { useMaxCompletionTokens: true, echoReasoning: true },
            modelProfiles: [{ id: 'Qwen3.8-Flash-Next-4bit', maxTokens: 8192 }],
          },
        },
      },
    } as unknown as AiSettings

    pi.events = [{ type: 'done', reason: 'stop', message: {} }]
    await streamViaPi(compatSettings, 'sys', userTurn, [], 32768, makeCallbacks())

    expect(pi.lastModel?.api).toBe('openai-completions')
    expect(pi.lastModel?.compat).toEqual({
      maxTokensField: 'max_completion_tokens',
      requiresReasoningContentOnAssistantMessages: true,
    })
    expect(pi.lastOptions?.maxTokens).toBe(8192)

    const anthropicCustom = {
      provider: 'custom',
      providers: {
        custom: {
          baseUrl: 'https://gw.example.com/v1',
          apiKey: 'k',
          model: 'claude-sonnet-5',
          profile: { api: 'anthropic' },
        },
      },
    } as unknown as AiSettings
    pi.events = [{ type: 'done', reason: 'stop', message: {} }]
    await streamViaPi(anthropicCustom, 'sys', userTurn, [], 2048, makeCallbacks())
    expect(pi.lastModel?.api).toBe('anthropic-messages')
  })

  it('forwards thinking_delta to onReasoningDelta and echoes reasoning in multi-turn messages unless disabled', async () => {
    pi.events = [
      { type: 'start', partial: {} },
      { type: 'thinking_delta', contentIndex: 0, delta: 'Step 1. ', partial: {} },
      { type: 'thinking_delta', contentIndex: 0, delta: 'Step 2.', partial: {} },
      { type: 'text_delta', contentIndex: 1, delta: 'Done.', partial: {} },
      { type: 'done', reason: 'stop', message: {} },
    ]
    const cb = makeCallbacks()
    const history: Parameters<typeof streamViaPi>[2] = [
      { role: 'user', text: 'check' },
      {
        role: 'assistant',
        text: '',
        reasoning: 'prior thinking',
        toolCalls: [{ id: 'tc1', name: 'read_file', input: { path: 'x.txt' } }],
      },
      { role: 'tool', results: [{ id: 'tc1', name: 'read_file', output: 'ok' }] },
    ]
    await streamViaPi(settings, 'sys', history, [], 1024, cb)

    expect(cb.recorded.reasoningDelta).toEqual(['Step 1. ', 'Step 2.'])
    expect(cb.recorded.delta).toEqual(['Done.'])
    const assistantMsg = pi.lastContext?.messages?.find((m) => m.role === 'assistant') as {
      api?: string
      provider?: string
      model?: string
      content?: Array<{ type: string; thinking?: string; thinkingSignature?: string }>
    }
    expect(assistantMsg.provider).toBe('custom')
    expect(assistantMsg.api).toBe('openai-completions')
    expect(assistantMsg.model).toBe('test-model')
    expect(assistantMsg.content?.[0]).toEqual({
      type: 'thinking',
      thinking: 'prior thinking',
      thinkingSignature: 'reasoning_content',
    })

    const noEchoSettings = {
      provider: 'custom',
      providers: {
        custom: {
          baseUrl: 'http://127.0.0.1:9/v1',
          apiKey: 'test-key',
          model: 'test-model',
          profile: { compat: { echoReasoning: false } },
        },
      },
    } as unknown as AiSettings
    pi.events = [{ type: 'done', reason: 'stop', message: {} }]
    await streamViaPi(noEchoSettings, 'sys', history, [], 1024, makeCallbacks())
    const mutedAssistant = pi.lastContext?.messages?.find((m) => m.role === 'assistant') as {
      content?: Array<{ type: string }>
    }
    expect(mutedAssistant.content?.some((b) => b.type === 'thinking')).toBe(false)
  })

  it('honors endpoint.idleTimeoutMs after stream start (both longer and shorter than default)', async () => {
    vi.useFakeTimers()
    try {
      const slowSettings = {
        provider: 'custom',
        providers: {
          custom: {
            baseUrl: 'http://192.168.100.235:7000/v1',
            apiKey: '1234',
            model: 'Qwen3.8-Flash-Next-4bit',
            profile: { idleTimeoutMs: 250_000 },
          },
        },
      } as unknown as AiSettings

      pi.events = [{ type: 'start', partial: {} }, { type: 'hang' }]
      let settled = false
      const slowPromise = streamViaPi(slowSettings, 'sys', userTurn, [], 1024, makeCallbacks())
      const slowExpectation = slowPromise.then(
        () => {
          settled = true
        },
        (err) => {
          settled = true
          throw err
        },
      )
      const slowCheck = expect(slowExpectation).rejects.toBeInstanceOf(AiTimeoutError)

      await vi.advanceTimersByTimeAsync(AI_IDLE_TIMEOUT_MS + 5_000)
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(70_000)
      await slowCheck

      const fastSettings = {
        provider: 'custom',
        providers: {
          custom: {
            baseUrl: 'http://192.168.100.235:7000/v1',
            apiKey: '1234',
            model: 'Qwen3.8-Flash-Next-4bit',
            profile: { idleTimeoutMs: 5_000 },
          },
        },
      } as unknown as AiSettings

      pi.events = [{ type: 'start', partial: {} }, { type: 'hang' }]
      const fastPromise = streamViaPi(fastSettings, 'sys', userTurn, [], 1024, makeCallbacks())
      const fastCheck = expect(fastPromise).rejects.toBeInstanceOf(AiTimeoutError)
      await vi.advanceTimersByTimeAsync(5_000)
      await fastCheck
    } finally {
      vi.useRealTimers()
    }
  })
})
