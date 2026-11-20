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
    expect(inferContextWindow('gemini-2.5-pro')).toBe(1_000_000)
    expect(inferContextWindow('gpt-5-codex')).toBe(400_000)
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
})
