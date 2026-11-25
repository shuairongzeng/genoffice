import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { defaultAiSettings, type AiSettings } from '@genoffice/ai-provider'
import { resolvePiRuntimePaths } from '../src/main/pi-agent/pi-agent-paths'
import {
  buildSyncedPiModelSpec,
  inferContextWindow,
  syncPiProviderAndMagicContextConfig,
} from '../src/main/pi-agent/pi-provider-sync'
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

describe('pi-provider-sync', () => {
  it('infers known model context windows and falls back safely', () => {
    expect(inferContextWindow('claude-sonnet-4-5')).toBe(200_000)
    expect(inferContextWindow('claude-sonnet-4-6')).toBe(1_000_000)
    expect(inferContextWindow('claude-opus-5-5')).toBe(1_000_000)
    expect(inferContextWindow('claude-sonnet-5')).toBe(1_000_000)
    expect(inferContextWindow('claude-haiku-5-5')).toBe(1_000_000)
    expect(inferContextWindow('claude-fable-5-2')).toBe(1_000_000)
    expect(inferContextWindow('gemini-2.5-pro')).toBe(1_000_000)
    expect(inferContextWindow('gemini-3.8-flash')).toBe(1_000_000)
    expect(inferContextWindow('gemini-4-argon')).toBe(1_000_000)
    expect(inferContextWindow('gpt-5-codex')).toBe(400_000)
    expect(inferContextWindow('gpt-6.1-terra')).toBe(272_000)
    expect(inferContextWindow('gpt-6-astra')).toBe(272_000)
    expect(inferContextWindow('custom-model', 65_536)).toBe(65_536)
    expect(inferContextWindow('unknown-local-model')).toBe(128_000)
  })

  it('rejects codex provider explicitly on Pi runtime', () => {
    const settings: AiSettings = {
      ...defaultAiSettings(),
      provider: 'codex',
    }
    expect(() => buildSyncedPiModelSpec(settings)).toThrow(/codex/i)
  })

  it('injects gskApiKey for genspark provider and honors vision capability checks', () => {
    const defaults = defaultAiSettings()
    const gskSettings: AiSettings = {
      ...defaults,
      provider: 'genspark',
      providers: {
        ...defaults.providers,
        genspark: {
          ...defaults.providers.genspark,
          model: 'claude-sonnet-4-5',
          apiKey: '',
        },
      },
    }
    const spec = buildSyncedPiModelSpec(gskSettings, 'gsk-live-token-123')
    expect(spec.providerId).toBe('genspark')
    expect(spec.apiKey).toBe('gsk-live-token-123')
    expect(spec.piModel.input).toEqual(['text', 'image'])

    const textOnlyDeepseek: AiSettings = {
      ...defaults,
      provider: 'deepseek',
      providers: {
        ...defaults.providers,
        deepseek: {
          ...defaults.providers.deepseek,
          apiKey: 'ds-key',
          model: 'deepseek-v4-flash',
        },
      },
    }
    const dsSpec = buildSyncedPiModelSpec(textOnlyDeepseek)
    expect(dsSpec.piModel.input).toEqual(['text'])
  })

  it('syncs models.json, auth.json, settings.json, and isolated/shared magic-context.jsonc', () => {
    const userData = makeTempDir('genoffice-pi-sync-')
    const defaults = defaultAiSettings()
    const settings: AiSettings = {
      ...defaults,
      provider: 'openai',
      providers: {
        ...defaults.providers,
        openai: {
          ...defaults.providers.openai,
          apiKey: 'sk-test-openai',
          model: 'gpt-4o',
        },
      },
    }

    const isolatedPaths = resolvePiRuntimePaths({
      userDataDir: userData,
      storageMode: 'isolated',
    })
    syncPiProviderAndMagicContextConfig(isolatedPaths, settings, {
      ...DEFAULT_PI_AGENT_PREFS,
      embeddingMode: 'local',
      magicContextStorageMode: 'isolated',
    })

    expect(existsSync(isolatedPaths.modelsJsonPath)).toBe(true)
    expect(existsSync(isolatedPaths.authJsonPath)).toBe(true)
    expect(existsSync(isolatedPaths.settingsJsonPath)).toBe(true)
    expect(existsSync(isolatedPaths.magicContextConfigPath)).toBe(true)

    const auth = JSON.parse(readFileSync(isolatedPaths.authJsonPath, 'utf8'))
    expect(auth.openai).toEqual({ type: 'api_key', key: 'sk-test-openai' })

    const piSettings = JSON.parse(readFileSync(isolatedPaths.settingsJsonPath, 'utf8'))
    expect(piSettings.compaction.enabled).toBe(false)
    expect(piSettings.defaultProvider).toBe('openai')
    expect(piSettings.defaultModel).toBe('gpt-4o')

    const mcConfig = JSON.parse(readFileSync(isolatedPaths.magicContextConfigPath, 'utf8'))
    expect(mcConfig.allow_home_project).toBe(true)
    expect(mcConfig.embedding).toEqual({ provider: 'local', local_runtime: 'wasm' })
    expect(mcConfig.dreamer.disable).toBe(true)

    // Verify shared mode preserves pre-existing magic-context.jsonc without overwriting it.
    const xdgDir = makeTempDir('genoffice-xdg-shared-')
    const sharedMcDir = join(xdgDir, 'cortexkit')
    mkdirSync(sharedMcDir, { recursive: true })
    const customSharedText = '// keep my custom config\n{"enabled": true, "customKey": 42}\n'
    writeFileSync(join(sharedMcDir, 'magic-context.jsonc'), customSharedText, 'utf8')

    const sharedPaths = resolvePiRuntimePaths({
      userDataDir: userData,
      storageMode: 'shared',
      env: { XDG_CONFIG_HOME: xdgDir, XDG_DATA_HOME: join(xdgDir, 'data') },
    })
    syncPiProviderAndMagicContextConfig(sharedPaths, settings, {
      ...DEFAULT_PI_AGENT_PREFS,
      magicContextStorageMode: 'shared',
    })
    expect(readFileSync(sharedPaths.magicContextConfigPath, 'utf8')).toBe(customSharedText)
  })

  it('maps openai-responses and resolves opt-in thinking effort into PiModelSpec and models.json', async () => {
    const defaults = defaultAiSettings()
    const baseOpenAi: AiSettings = {
      ...defaults,
      provider: 'openai',
      providers: {
        ...defaults.providers,
        openai: {
          ...defaults.providers.openai,
          apiKey: 'sk-test-openai',
          model: 'gpt-6.1-terra',
        },
      },
    }

    // Unset leaves reasoning: false and thinkingLevel undefined so Pi defaults stay untouched.
    const unsetSpec = buildSyncedPiModelSpec(baseOpenAi)
    expect(unsetSpec.piModel.api).toBe('openai-responses')
    expect(unsetSpec.piModel.reasoning).toBe(false)
    expect(unsetSpec.piModel.contextWindow).toBe(272_000)
    expect(unsetSpec.thinkingLevel).toBeUndefined()

    // Explicit 'none' on openai-responses sets thinkingLevelMap.off = 'none' and thinkingLevel = 'off'.
    const noneSpec = buildSyncedPiModelSpec({
      ...baseOpenAi,
      providers: {
        ...baseOpenAi.providers,
        openai: {
          ...baseOpenAi.providers.openai,
          thinking: { 'gpt-6.1-terra': 'none' },
        },
      },
    })
    expect(noneSpec.piModel.reasoning).toBe(true)
    expect(noneSpec.piModel.thinkingLevelMap).toEqual({ off: 'none' })
    expect(noneSpec.thinkingLevel).toBe('off')

    // Responses-only xhigh is dropped when routed through an OpenAI-compatible gateway.
    const gatedSpec = buildSyncedPiModelSpec({
      ...defaults,
      provider: 'openrouter',
      providers: {
        ...defaults.providers,
        openrouter: {
          ...defaults.providers.openrouter,
          apiKey: 'or-key',
          model: 'openai/gpt-6.1-terra',
          thinking: { 'openai/gpt-6.1-terra': 'xhigh' },
        },
      },
    })
    expect(gatedSpec.piModel.api).toBe('openai-completions')
    expect(gatedSpec.piModel.reasoning).toBe(false)
    expect(gatedSpec.thinkingLevel).toBeUndefined()

    // Explicit positive effort on openai-responses sets reasoning: true and syncs models.json.
    const xhighSettings: AiSettings = {
      ...baseOpenAi,
      providers: {
        ...baseOpenAi.providers,
        openai: {
          ...baseOpenAi.providers.openai,
          thinking: { 'gpt-6.1-terra': 'xhigh' },
        },
      },
    }
    const xhighSpec = buildSyncedPiModelSpec(xhighSettings)
    expect(xhighSpec.piModel.api).toBe('openai-responses')
    expect(xhighSpec.piModel.reasoning).toBe(true)
    expect(xhighSpec.thinkingLevel).toBe('xhigh')
    expect(xhighSpec.piModel.thinkingLevelMap).toEqual({ xhigh: 'xhigh' })

    const userData = makeTempDir('genoffice-pi-sync-thinking-')
    const paths = resolvePiRuntimePaths({ userDataDir: userData, storageMode: 'isolated' })
    syncPiProviderAndMagicContextConfig(paths, xhighSettings, DEFAULT_PI_AGENT_PREFS)

    const modelsDoc = JSON.parse(readFileSync(paths.modelsJsonPath, 'utf8'))
    expect(modelsDoc.providers.openai.api).toBe('openai-responses')
    expect(modelsDoc.providers.openai.models[0]).toMatchObject({
      id: 'gpt-6.1-terra',
      api: 'openai-responses',
      reasoning: true,
      thinkingLevelMap: { xhigh: 'xhigh' },
      contextWindow: 272_000,
    })

    // Confirm ModelRuntime loads the generated models.json without schema validation errors.
    const sdk = await import('@earendil-works/pi-coding-agent')
    const runtime = await sdk.ModelRuntime.create({
      authPath: paths.authJsonPath,
      modelsPath: paths.modelsJsonPath,
      refreshOnCreate: false,
    })
    expect(runtime.getError()).toBeUndefined()
    const loadedModel = runtime.getModel('openai', 'gpt-6.1-terra')
    expect(loadedModel?.api).toBe('openai-responses')
    expect(loadedModel?.reasoning).toBe(true)
    expect(loadedModel?.thinkingLevelMap).toEqual({ xhigh: 'xhigh' })

    // Re-syncing after clearing thinking resets reasoning back to false in models.json.
    syncPiProviderAndMagicContextConfig(paths, baseOpenAi, DEFAULT_PI_AGENT_PREFS)
    const resetDoc = JSON.parse(readFileSync(paths.modelsJsonPath, 'utf8'))
    expect(resetDoc.providers.openai.models[0].reasoning).toBe(false)
    expect(resetDoc.providers.openai.models[0].thinkingLevelMap).toBeUndefined()

    // Claude 5.x adaptive effort sets forceAdaptiveThinking compat.
    const claudeSpec = buildSyncedPiModelSpec({
      ...defaults,
      provider: 'anthropic',
      providers: {
        ...defaults.providers,
        anthropic: {
          ...defaults.providers.anthropic,
          apiKey: 'sk-ant',
          model: 'claude-opus-5-5',
          thinking: { 'claude-opus-5-5': 'max' },
        },
      },
    })
    expect(claudeSpec.piModel.api).toBe('anthropic-messages')
    expect(claudeSpec.piModel.reasoning).toBe(true)
    expect(claudeSpec.thinkingLevel).toBe('max')
    expect(claudeSpec.piModel.thinkingLevelMap).toEqual({ max: 'max' })
    expect(claudeSpec.piModel.compat).toEqual({ forceAdaptiveThinking: true })
  })
})
