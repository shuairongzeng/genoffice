import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { streamSimple as streamOpenAiCompletions } from '@earendil-works/pi-ai/api/openai-completions'
import { streamSimple as streamOpenAiResponses } from '@earendil-works/pi-ai/api/openai-responses'
import { defaultAiSettings, type AiProviderId, type AiSettings } from '@genoffice/ai-provider'
import { resolvePiRuntimePaths } from '../src/main/pi-agent/pi-agent-paths'
import {
  applySessionThinkingToModelSpec,
  buildSyncedPiModelSpec,
  syncPiProviderAndMagicContextConfig,
} from '../src/main/pi-agent/pi-provider-sync'
import { syncCachedSessionModelAndThinking } from '../src/main/pi-agent/pi-runtime'
import { DEFAULT_PI_AGENT_PREFS } from '../src/shared/pi-agent-prefs'

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function makeSettings(
  provider: Exclude<AiProviderId, 'codex'>,
  model: string,
  extra?: Partial<AiSettings['providers'][Exclude<AiProviderId, 'codex'>]>,
): AiSettings {
  const defaults = defaultAiSettings()
  return {
    ...defaults,
    provider,
    providers: {
      ...defaults.providers,
      [provider]: {
        ...defaults.providers[provider],
        apiKey: 'test-key',
        model,
        ...extra,
      },
    },
  }
}

describe('session-tiered thinking engine', () => {
  it('applies per-session off/high overrides for Huihui-Qwen3.8-27B-abliterated-UD-Q4_K_XL', () => {
    const baseSpec = buildSyncedPiModelSpec(
      makeSettings('custom', 'Huihui-Qwen3.8-27B-abliterated-UD-Q4_K_XL', {
        baseUrl: 'http://127.0.0.1:7000/v1',
      }),
    )
    expect(baseSpec.piModel.reasoning).toBe(false)
    expect(baseSpec.thinkingLevel).toBeUndefined()

    const offSpec = applySessionThinkingToModelSpec(baseSpec, { mode: 'off' })
    expect(offSpec.piModel.reasoning).toBe(true)
    expect(offSpec.thinkingLevel).toBe('off')
    expect((offSpec.piModel.compat as Record<string, unknown>)?.thinkingFormat).toBe('qwen')

    const highSpec = applySessionThinkingToModelSpec(baseSpec, {
      mode: 'effort',
      effort: 'high',
    })
    expect(highSpec.piModel.reasoning).toBe(true)
    expect(highSpec.thinkingLevel).toBe('high')
    expect((highSpec.piModel.compat as Record<string, unknown>)?.thinkingFormat).toBe('qwen')
  })

  it('handles gpt-5, deepseek-chat, glm-4.5, claude-sonnet-4-6, claude-3-5-sonnet, and o3-mini safely', () => {
    // 1. gpt-5 on openai-completions supports 'none' -> thinkingLevelMap.off = 'none'
    const gpt5Base = buildSyncedPiModelSpec(makeSettings('openai', 'gpt-5'))
    expect(gpt5Base.piModel.api).toBe('openai-completions')
    const gpt5Off = applySessionThinkingToModelSpec(gpt5Base, { mode: 'off' })
    expect(gpt5Off.piModel.reasoning).toBe(true)
    expect(gpt5Off.piModel.thinkingLevelMap).toEqual({ off: 'none' })
    expect(gpt5Off.thinkingLevel).toBe('off')
    const gpt5High = applySessionThinkingToModelSpec(gpt5Base, { mode: 'effort', effort: 'high' })
    expect(gpt5High.piModel.reasoning).toBe(true)
    expect(gpt5High.thinkingLevel).toBe('high')

    // 2. deepseek-chat uses thinkingFormat: 'deepseek'
    const dsBase = buildSyncedPiModelSpec(makeSettings('deepseek', 'deepseek-chat'))
    const dsOff = applySessionThinkingToModelSpec(dsBase, { mode: 'off' })
    expect(dsOff.piModel.reasoning).toBe(true)
    expect((dsOff.piModel.compat as Record<string, unknown>)?.thinkingFormat).toBe('deepseek')
    expect(dsOff.thinkingLevel).toBe('off')
    const dsHigh = applySessionThinkingToModelSpec(dsBase, { mode: 'effort', effort: 'high' })
    expect(dsHigh.piModel.reasoning).toBe(true)
    expect((dsHigh.piModel.compat as Record<string, unknown>)?.thinkingFormat).toBe('deepseek')
    expect(dsHigh.thinkingLevel).toBe('high')

    // 3. glm-4.5 uses thinkingFormat: 'zai'
    const glmBase = buildSyncedPiModelSpec(makeSettings('glm', 'glm-4.5'))
    const glmOff = applySessionThinkingToModelSpec(glmBase, { mode: 'off' })
    expect(glmOff.piModel.reasoning).toBe(true)
    expect((glmOff.piModel.compat as Record<string, unknown>)?.thinkingFormat).toBe('zai')
    expect(glmOff.thinkingLevel).toBe('off')
    const glmHigh = applySessionThinkingToModelSpec(glmBase, { mode: 'effort', effort: 'high' })
    expect(glmHigh.piModel.reasoning).toBe(true)
    expect((glmHigh.piModel.compat as Record<string, unknown>)?.thinkingFormat).toBe('zai')
    expect(glmHigh.thinkingLevel).toBe('high')

    // 4. claude-sonnet-4-6 supports adaptive thinking
    const claude46Base = buildSyncedPiModelSpec(makeSettings('anthropic', 'claude-sonnet-4-6'))
    const claude46Off = applySessionThinkingToModelSpec(claude46Base, { mode: 'off' })
    expect(claude46Off.piModel.reasoning).toBe(false)
    expect(claude46Off.thinkingLevel).toBe('off')
    expect(
      (claude46Off.piModel.compat as Record<string, unknown> | undefined)?.forceAdaptiveThinking,
    ).toBeUndefined()
    const claude46High = applySessionThinkingToModelSpec(claude46Base, {
      mode: 'effort',
      effort: 'high',
    })
    expect(claude46High.piModel.reasoning).toBe(true)
    expect((claude46High.piModel.compat as Record<string, unknown>)?.forceAdaptiveThinking).toBe(
      true,
    )
    expect(claude46High.thinkingLevel).toBe('high')

    // 5. claude-3-5-sonnet has no adaptive surface -> effort keeps reasoning false to avoid HTTP 400
    const claude35Base = buildSyncedPiModelSpec(makeSettings('anthropic', 'claude-3-5-sonnet'))
    const claude35Off = applySessionThinkingToModelSpec(claude35Base, { mode: 'off' })
    expect(claude35Off.piModel.reasoning).toBe(false)
    expect(claude35Off.thinkingLevel).toBe('off')
    const claude35High = applySessionThinkingToModelSpec(claude35Base, {
      mode: 'effort',
      effort: 'high',
    })
    expect(claude35High.piModel.reasoning).toBe(false)
    expect(claude35High.thinkingLevel).toBeUndefined()

    // 6. o3-mini rejects 'none' -> off keeps reasoning false to avoid HTTP 400
    const o3Base = buildSyncedPiModelSpec(makeSettings('openai', 'o3-mini'))
    const o3Off = applySessionThinkingToModelSpec(o3Base, { mode: 'off' })
    expect(o3Off.piModel.reasoning).toBe(false)
    expect(o3Off.thinkingLevel).toBe('off')
    const o3High = applySessionThinkingToModelSpec(o3Base, { mode: 'effort', effort: 'high' })
    expect(o3High.piModel.reasoning).toBe(true)
    expect(o3High.thinkingLevel).toBe('high')

    // 7. toggle family clamps requested 'high' to supported 'medium'
    const lingBase = buildSyncedPiModelSpec(makeSettings('ling', 'ling-3.0-flash'))
    const lingHigh = applySessionThinkingToModelSpec(lingBase, { mode: 'effort', effort: 'high' })
    expect(lingHigh.piModel.reasoning).toBe(true)
    expect(lingHigh.thinkingLevel).toBe('medium')
    expect((lingHigh.piModel.compat as Record<string, unknown>)?.thinkingFormat).toBe('deepseek')
  })

  it("applies global explicit 'none' in buildSyncedPiModelSpec while leaving unset untouched", () => {
    const qwenNone = buildSyncedPiModelSpec(
      makeSettings('custom', 'Huihui-Qwen3.8-27B-abliterated-UD-Q4_K_XL', {
        baseUrl: 'http://127.0.0.1:7000/v1',
        thinking: { 'Huihui-Qwen3.8-27B-abliterated-UD-Q4_K_XL': 'none' },
      }),
    )
    expect(qwenNone.piModel.reasoning).toBe(true)
    expect(qwenNone.thinkingLevel).toBe('off')
    expect((qwenNone.piModel.compat as Record<string, unknown>)?.thinkingFormat).toBe('qwen')

    const glmNone = buildSyncedPiModelSpec(
      makeSettings('glm', 'glm-4.5', {
        thinking: { 'glm-4.5': 'none' },
      }),
    )
    expect(glmNone.piModel.reasoning).toBe(true)
    expect(glmNone.thinkingLevel).toBe('off')
    expect((glmNone.piModel.compat as Record<string, unknown>)?.thinkingFormat).toBe('zai')

    const responsesNone = buildSyncedPiModelSpec(
      makeSettings('openai', 'gpt-6.1-terra', {
        thinking: { 'gpt-6.1-terra': 'none' },
      }),
    )
    expect(responsesNone.piModel.api).toBe('openai-responses')
    expect(responsesNone.piModel.reasoning).toBe(true)
    expect(responsesNone.piModel.thinkingLevelMap).toEqual({ off: 'none' })
    expect(responsesNone.thinkingLevel).toBe('off')

    const unsetCustom = buildSyncedPiModelSpec(
      makeSettings('custom', 'Huihui-Qwen3.8-27B-abliterated-UD-Q4_K_XL', {
        baseUrl: 'http://127.0.0.1:7000/v1',
      }),
    )
    expect(unsetCustom.piModel.reasoning).toBe(false)
    expect(unsetCustom.thinkingLevel).toBeUndefined()
  })

  it('hot-switches cached session between off and high and detects compat/off-map changes', async () => {
    const baseSpec = buildSyncedPiModelSpec(
      makeSettings('custom', 'Huihui-Qwen3.8-27B-abliterated-UD-Q4_K_XL', {
        baseUrl: 'http://127.0.0.1:7000/v1',
      }),
    )
    const offSpec = applySessionThinkingToModelSpec(baseSpec, { mode: 'off' })
    const highSpec = applySessionThinkingToModelSpec(baseSpec, { mode: 'effort', effort: 'high' })

    let currentModel = baseSpec.piModel
    const setModel = vi.fn(async (next: typeof currentModel) => {
      currentModel = next
    })
    const setThinkingLevel = vi.fn()
    const fakeSession = {
      get model() {
        return currentModel
      },
      setModel,
      setThinkingLevel,
    }

    // 1. Unset -> off: updates model with qwen compat and sets thinkingLevel to 'off'
    await expect(
      syncCachedSessionModelAndThinking(
        {
          lastModelRef: baseSpec.modelRef,
          lastThinkingLevel: undefined,
          session: fakeSession,
        },
        offSpec,
      ),
    ).resolves.toBe(true)
    expect(setModel).toHaveBeenCalledTimes(1)
    expect(setModel).toHaveBeenCalledWith(offSpec.piModel)
    expect(setThinkingLevel).toHaveBeenCalledWith('off')

    // 2. off -> high: sets thinkingLevel to 'high'
    setModel.mockClear()
    setThinkingLevel.mockClear()
    await expect(
      syncCachedSessionModelAndThinking(
        {
          lastModelRef: offSpec.modelRef,
          lastThinkingLevel: 'off',
          session: fakeSession,
        },
        highSpec,
      ),
    ).resolves.toBe(true)
    expect(setThinkingLevel).toHaveBeenCalledWith('high')

    // 3. high -> off: switches back to 'off'
    setModel.mockClear()
    setThinkingLevel.mockClear()
    await expect(
      syncCachedSessionModelAndThinking(
        {
          lastModelRef: highSpec.modelRef,
          lastThinkingLevel: 'high',
          session: fakeSession,
        },
        offSpec,
      ),
    ).resolves.toBe(true)
    expect(setThinkingLevel).toHaveBeenCalledWith('off')

    // 4. Even if lastModelRef & lastThinkingLevel match, a change in thinkingLevelMap.off triggers refresh
    const gptBase = buildSyncedPiModelSpec(makeSettings('openai', 'gpt-5'))
    const gptOff = applySessionThinkingToModelSpec(gptBase, { mode: 'off' })
    let gptLiveModel = gptBase.piModel
    const gptSetModel = vi.fn(async (m: typeof gptLiveModel) => {
      gptLiveModel = m
    })
    const gptSetThinking = vi.fn()
    await expect(
      syncCachedSessionModelAndThinking(
        {
          lastModelRef: gptOff.modelRef,
          lastThinkingLevel: 'off',
          session: {
            get model() {
              return gptLiveModel
            },
            setModel: gptSetModel,
            setThinkingLevel: gptSetThinking,
          },
        },
        gptOff,
      ),
    ).resolves.toBe(true)
    expect(gptSetModel).toHaveBeenCalledWith(gptOff.piModel)
    expect(gptSetThinking).toHaveBeenCalledWith('off')
  })

  it('hot-switches a real Pi AgentSession between off and high cleanly', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const userData = makeTempDir('genoffice-pi-session-thinking-')
    const cwd = join(userData, 'workspace')
    mkdirSync(cwd, { recursive: true })
    const paths = resolvePiRuntimePaths({ userDataDir: userData, storageMode: 'isolated' })

    const settings = makeSettings('custom', 'Huihui-Qwen3.8-27B-abliterated-UD-Q4_K_XL', {
      baseUrl: 'http://127.0.0.1:7000/v1',
    })
    const baseSpec = syncPiProviderAndMagicContextConfig(paths, settings, DEFAULT_PI_AGENT_PREFS)!
    const offSpec = applySessionThinkingToModelSpec(baseSpec, { mode: 'off' })
    const highSpec = applySessionThinkingToModelSpec(baseSpec, { mode: 'effort', effort: 'high' })

    const settingsManager = sdk.SettingsManager.create(cwd, paths.agentDir, {
      projectTrusted: true,
    })
    const modelRuntime = await sdk.ModelRuntime.create({
      authPath: paths.authJsonPath,
      modelsPath: paths.modelsJsonPath,
      refreshOnCreate: false,
    })

    const { session } = await sdk.createAgentSession({
      cwd,
      agentDir: paths.agentDir,
      modelRuntime,
      model: offSpec.piModel,
      thinkingLevel: offSpec.thinkingLevel,
      sessionManager: sdk.SessionManager.inMemory(cwd),
      settingsManager,
    })

    try {
      expect(session.model?.reasoning).toBe(true)
      expect(session.thinkingLevel).toBe('off')

      const toHigh = await syncCachedSessionModelAndThinking(
        {
          lastModelRef: offSpec.modelRef,
          lastThinkingLevel: offSpec.thinkingLevel,
          session,
        },
        highSpec,
      )
      expect(toHigh).toBe(true)
      expect(session.thinkingLevel).toBe('high')

      const toOff = await syncCachedSessionModelAndThinking(
        {
          lastModelRef: highSpec.modelRef,
          lastThinkingLevel: highSpec.thinkingLevel,
          session,
        },
        offSpec,
      )
      expect(toOff).toBe(true)
      expect(session.thinkingLevel).toBe('off')
    } finally {
      session.dispose()
    }
  }, 45_000)

  it('emits exact wire parameters through pi-ai streamSimple for off and high overrides', async () => {
    const captureWirePayload = async (
      spec: ReturnType<typeof applySessionThinkingToModelSpec>,
    ): Promise<Record<string, unknown>> => {
      const controller = new AbortController()
      let captured: Record<string, unknown> | undefined
      const streamFn =
        spec.piModel.api === 'openai-responses' ? streamOpenAiResponses : streamOpenAiCompletions

      const s = streamFn(
        spec.piModel as never,
        {
          messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }],
        },
        {
          apiKey: spec.apiKey ?? 'test-key',
          reasoning: spec.thinkingLevel,
          signal: controller.signal,
          onPayload: (payload: unknown) => {
            captured = payload as Record<string, unknown>
            controller.abort()
          },
        },
      )
      await s.result()
      return captured!
    }

    const qwenBase = buildSyncedPiModelSpec(
      makeSettings('custom', 'Huihui-Qwen3.8-27B-abliterated-UD-Q4_K_XL', {
        baseUrl: 'http://127.0.0.1:7000/v1',
      }),
    )
    const qwenOffPayload = await captureWirePayload(
      applySessionThinkingToModelSpec(qwenBase, { mode: 'off' }),
    )
    expect(qwenOffPayload.enable_thinking).toBe(false)

    const qwenHighPayload = await captureWirePayload(
      applySessionThinkingToModelSpec(qwenBase, { mode: 'effort', effort: 'high' }),
    )
    expect(qwenHighPayload.enable_thinking).toBe(true)

    const dsBase = buildSyncedPiModelSpec(makeSettings('deepseek', 'deepseek-chat'))
    const dsOffPayload = await captureWirePayload(
      applySessionThinkingToModelSpec(dsBase, { mode: 'off' }),
    )
    expect(dsOffPayload.thinking).toEqual({ type: 'disabled' })

    const glmBase = buildSyncedPiModelSpec(makeSettings('glm', 'glm-4.5'))
    const glmOffPayload = await captureWirePayload(
      applySessionThinkingToModelSpec(glmBase, { mode: 'off' }),
    )
    expect(glmOffPayload.thinking).toEqual({ type: 'disabled' })

    const gpt5Base = buildSyncedPiModelSpec(makeSettings('openai', 'gpt-5'))
    const gpt5OffPayload = await captureWirePayload(
      applySessionThinkingToModelSpec(gpt5Base, { mode: 'off' }),
    )
    expect(gpt5OffPayload.reasoning_effort).toBe('none')

    const gpt6None = buildSyncedPiModelSpec(
      makeSettings('openai', 'gpt-6.1-terra', {
        thinking: { 'gpt-6.1-terra': 'none' },
      }),
    )
    const gpt6OffPayload = await captureWirePayload(gpt6None)
    expect(gpt6OffPayload.reasoning).toEqual({ effort: 'none' })
  })
})
