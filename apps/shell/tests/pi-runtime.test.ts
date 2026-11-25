import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { defaultAiSettings, type AiSettings } from '@genoffice/ai-provider'
import { addAskRunObserver } from '../src/main/ask-run-observer'
import { resolvePiRuntimePaths } from '../src/main/pi-agent/pi-agent-paths'
import {
  buildSyncedPiModelSpec,
  syncPiProviderAndMagicContextConfig,
} from '../src/main/pi-agent/pi-provider-sync'
import {
  CHIEF_SESSION_MAX_BYTES,
  GENOFFICE_PI_SYSTEM_PROMPT,
  PiAgentRuntimeManager,
  SessionMapStore,
  advanceReasoningDelta,
  appendPiCleanText,
  buildExcludeBuiltinTools,
  buildSessionExcludeBuiltinTools,
  createOrdinalPrefixStripper,
  filterAgentContextFiles,
  isTransientPiSocketError,
  messageUsageDelta,
  prefsReloadKey,
  resolveGenofficeSystemPrompt,
  shouldResetBloatedChiefSession,
  stripOrdinalPrefix,
  syncCachedSessionModelAndThinking,
} from '../src/main/pi-agent/pi-runtime'
import { BUTLER_CHIEF_SESSION_KEY } from '../src/shared/butler-orchestrator-api'
import type { AskRunEvent } from '../src/shared/home-api'
import { appendButlerPersona } from '../src/main/butler/butler-persona'
import {
  STATIC_WORKBENCH_SYSTEM_PROMPT,
  createGenofficeWorkbenchExtension,
  createWorkbenchExtensionCoord,
} from '../src/main/pi-agent/genoffice-workbench-extension'
import type { WorkbenchToolsService } from '../src/main/workbench-tools-service'
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

describe('pi-runtime helpers', () => {
  it('strips §N§ ordinal tags across split streaming chunks without dropping literal § text', () => {
    const stripper = createOrdinalPrefixStripper()
    const chunks = ['§', '12', '§ ', 'Hello ', 'world!\n', '§3§', ' Next', ' line\n§not-tag']
    let out = ''
    for (const c of chunks) {
      out += stripper.push(c)
    }
    out += stripper.flush()

    expect(out).toBe('Hello world!\nNext line\n§not-tag')
    expect(out).not.toMatch(/§\d+§/)
    expect(stripOrdinalPrefix('§1§ First\n§42§ Second\nNormal §100§ inline')).toBe(
      'First\nSecond\nNormal §100§ inline',
    )
  })

  it('handles trailing chunk boundary §N§ followed by space or newline cleanly', () => {
    const stripper = createOrdinalPrefixStripper()
    let out = ''
    out += stripper.push('§7§')
    out += stripper.push(' Line A')
    out += stripper.push('\n§9§\nLine B')
    out += stripper.flush()
    expect(out).toBe('Line A\n\nLine B')

    const literalOnly = createOrdinalPrefixStripper()
    expect(literalOnly.push('§') + literalOnly.flush()).toBe('§')
  })

  it('builds excludeTools cleanly without ever using a tools allowlist', () => {
    expect(buildExcludeBuiltinTools(DEFAULT_PI_AGENT_PREFS)).toEqual([])
    expect(
      buildExcludeBuiltinTools({ enablePiReadTools: false, enablePiWriteTools: true }),
    ).toEqual(['read', 'grep', 'find', 'ls'])
    expect(
      buildExcludeBuiltinTools({ enablePiReadTools: true, enablePiWriteTools: false }),
    ).toEqual(['bash', 'powershell', 'edit', 'write'])
    expect(
      buildExcludeBuiltinTools({ enablePiReadTools: false, enablePiWriteTools: false }),
    ).toEqual(['read', 'grep', 'find', 'ls', 'bash', 'powershell', 'edit', 'write'])
  })

  it('persists, reloads, rebinds, and deletes entries in SessionMapStore', () => {
    const dir = makeTempDir('genoffice-smap-')
    const mapPath = join(dir, 'session-map.json')
    const sessionFileA = join(dir, 'sess-a.jsonl')
    writeFileSync(sessionFileA, '{"type":"session"}\n', 'utf8')

    const store = new SessionMapStore(mapPath)
    store.set('proj-1:temp-1', sessionFileA)
    expect(store.get('proj-1:temp-1')).toBe(sessionFileA)

    store.rebind('proj-1:temp-1', 'proj-1:file-hash-9')
    expect(store.get('proj-1:temp-1')).toBeUndefined()
    expect(store.get('proj-1:file-hash-9')).toBe(sessionFileA)

    // Reload from disk verifies persistence.
    const reloaded = new SessionMapStore(mapPath)
    expect(reloaded.get('proj-1:file-hash-9')).toBe(sessionFileA)

    reloaded.delete('proj-1:file-hash-9')
    expect(reloaded.get('proj-1:file-hash-9')).toBeUndefined()
    const raw = JSON.parse(readFileSync(mapPath, 'utf8'))
    expect(raw.entries).toEqual({})

    // Prunes orphaned mapping if session jsonl was removed externally.
    const orphanFile = join(dir, 'orphan.jsonl')
    writeFileSync(orphanFile, '', 'utf8')
    reloaded.set('proj-1:orphan', orphanFile)
    rmSync(orphanFile)
    expect(reloaded.get('proj-1:orphan')).toBeUndefined()
  })

  it('emits incremental reasoning deltas and per-message usage deltas without double accumulation', () => {
    const state = { accumulatedReasoning: '', reasoningNeedsBreak: false }
    const d1 = advanceReasoningDelta(state, 'Step 1')
    const d2 = advanceReasoningDelta(state, ' detail')
    expect(d1).toBe('Step 1')
    expect(d2).toBe(' detail')
    expect(state.accumulatedReasoning).toBe('Step 1 detail')

    state.reasoningNeedsBreak = true
    const d3 = advanceReasoningDelta(state, 'Step 2')
    expect(d3).toBe('\n\nStep 2')
    expect(state.reasoningNeedsBreak).toBe(false)
    expect(state.accumulatedReasoning).toBe('Step 1 detail\n\nStep 2')

    const u1 = messageUsageDelta({ input: 120, output: 30 })
    const u2 = messageUsageDelta({ input: 80, output: 20 })
    expect(u1).toEqual({ inputTokens: 120, outputTokens: 30 })
    expect(u2).toEqual({ inputTokens: 80, outputTokens: 20 })
  })

  it('isolates per-message clean text while preserving cross-turn accumulated text', () => {
    const state = {
      currentMsgCleanText: '',
      accumulatedCleanText: '',
      textNeedsBreak: false,
    }

    expect(appendPiCleanText(state, 'Checking files...')).toBe('Checking files...')
    expect(state.accumulatedCleanText).toBe('Checking files...')

    // Next assistant message after tool execution starts a clean per-turn broadcast buffer.
    state.currentMsgCleanText = ''
    state.textNeedsBreak = state.accumulatedCleanText.trim().length > 0

    expect(appendPiCleanText(state, 'Final ')).toBe('Final ')
    expect(appendPiCleanText(state, 'summary.')).toBe('Final summary.')
    expect(state.accumulatedCleanText).toBe('Checking files...\n\nFinal summary.')
  })

  it('applies precedence: configured settings prompt > SYSTEM.md > GenOffice default', () => {
    expect(resolveGenofficeSystemPrompt(undefined)).toBe(GENOFFICE_PI_SYSTEM_PROMPT)
    expect(resolveGenofficeSystemPrompt('   \n ')).toBe(GENOFFICE_PI_SYSTEM_PROMPT)
    expect(GENOFFICE_PI_SYSTEM_PROMPT).toContain('GenOffice AI Assistant')
    expect(GENOFFICE_PI_SYSTEM_PROMPT).not.toContain('coding assistant running inside pi')

    expect(resolveGenofficeSystemPrompt('Custom SYSTEM.md prompt')).toBe('Custom SYSTEM.md prompt')
    expect(
      resolveGenofficeSystemPrompt('Custom SYSTEM.md prompt', '  Settings configured prompt  '),
    ).toBe('Settings configured prompt')
    expect(resolveGenofficeSystemPrompt('Custom SYSTEM.md prompt', '   ')).toBe(
      'Custom SYSTEM.md prompt',
    )
  })

  it('keeps only context files located under agentDir and rejects ancestor or sibling paths', () => {
    const root = makeTempDir('genoffice-ctx-filter-')
    const agentDir = join(root, 'userData', 'pi-agent')
    const siblingDir = join(root, 'userData', 'pi-agent-other')
    const ancestorAgents = join(root, 'AGENTS.md')
    const repoClaude = join(root, 'workspace', 'CLAUDE.md')
    const siblingAgents = join(siblingDir, 'AGENTS.md')
    const validAgents = join(agentDir, 'AGENTS.md')
    const nestedAgents = join(agentDir, 'nested', 'AGENTS.md')

    const filtered = filterAgentContextFiles(
      [
        { path: ancestorAgents, content: 'ancestor' },
        { path: repoClaude, content: 'repo' },
        { path: siblingAgents, content: 'sibling' },
        { path: validAgents, content: 'user-global' },
        { path: nestedAgents, content: 'user-nested' },
      ],
      agentDir,
    )
    expect(filtered.map((item) => item.path)).toEqual([validAgents, nestedAgents])
  })

  it('assembles a real Pi AgentSession prompt without coding preamble, Pi docs, or ancestor AGENTS.md while preserving skills and SYSTEM.md override', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const root = makeTempDir('genoffice-pi-sdk-prompt-')
    const repoParent = join(root, 'fake-repo')
    const cwd = join(repoParent, 'workspace')
    const agentDir = join(root, 'userData', 'pi-agent')
    const skillDir = join(agentDir, 'skills', 'office-brief')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(skillDir, { recursive: true })

    // Place a repository AGENTS.md in an ancestor directory and verify it is blocked.
    writeFileSync(join(repoParent, 'AGENTS.md'), 'FORBIDDEN_ANCESTOR_REPO_AGENTS_MD', 'utf8')
    // Place user-controlled context & append files inside agentDir.
    writeFileSync(join(agentDir, 'AGENTS.md'), 'USER_AGENT_DIR_GUIDELINE', 'utf8')
    writeFileSync(join(agentDir, 'APPEND_SYSTEM.md'), 'USER_APPEND_RULE', 'utf8')
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: office-brief\ndescription: Summarize office documents concisely.\n---\nUse bullet points.\n',
      'utf8',
    )

    const noopAsync = async () => ({})
    const workbench: WorkbenchToolsService = {
      kbList: async () => [],
      kbSearch: async () => [],
      kbRead: noopAsync,
      createDocument: noopAsync,
      editFile: noopAsync,
      deleteFile: noopAsync,
      readAttachment: async () => ({ ok: false, error: 'none' }),
      readAttachmentImage: () => ({ ok: false, error: 'none' }),
      cliContext: () => null,
      runCli: noopAsync,
      getAppSkillManifest: async () => ({ windows: [], tools: [] }),
      executeAppSkill: noopAsync as WorkbenchToolsService['executeAppSkill'],
      describeDocumentAgent: async () => ({ error: 'none' }),
      runDocumentAgent: async () => ({ ok: false, error: 'none', edits: [] }),
      cancelDocumentAgent: () => false,
      undoDocumentAgent: async () => ({ ok: false, error: 'none' }),
      executeBrowserSkill: noopAsync,
      listBrowserTabs: async () => [],
      listSurfaceTabs: async () => [],
      recordLineage: () => {},
      lineageFor: () => null,
    }

    const settingsManager = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: true })
    const coord = createWorkbenchExtensionCoord()
    const loader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: [createGenofficeWorkbenchExtension(workbench, coord)],
      systemPromptOverride: (base) => resolveGenofficeSystemPrompt(base),
      agentsFilesOverride: ({ agentsFiles }) => ({
        agentsFiles: filterAgentContextFiles(agentsFiles, agentDir),
      }),
      noThemes: true,
    })
    await loader.reload()

    const modelRuntime = await sdk.ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: join(agentDir, 'models.json'),
    })
    const dummyModel = {
      id: 'mock-office-model',
      name: 'mock-office-model',
      api: 'openai-completions',
      provider: 'openai',
      baseUrl: 'http://127.0.0.1:0/v1',
      input: ['text'],
      reasoning: false,
      contextWindow: 128000,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } as any

    const { session } = await sdk.createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model: dummyModel,
      resourceLoader: loader,
      sessionManager: sdk.SessionManager.inMemory(cwd),
      settingsManager,
    })
    try {
      await session.bindExtensions({
        mode: 'json',
        commandContextActions: {
          waitForIdle: async () => {},
          newSession: async () => ({ cancelled: true }),
          fork: async () => ({ cancelled: true }),
          navigateTree: async () => ({ cancelled: true }),
          switchSession: async () => ({ cancelled: true }),
          reload: async () => {},
        },
      })

      const basePrompt = session.systemPrompt
      expect(basePrompt).toContain('GenOffice AI Assistant')
      expect(basePrompt).not.toContain('coding assistant running inside pi')
      expect(basePrompt).not.toContain('Pi documentation')
      expect(basePrompt).not.toContain('FORBIDDEN_ANCESTOR_REPO_AGENTS_MD')
      expect(basePrompt).toContain('USER_AGENT_DIR_GUIDELINE')
      expect(basePrompt).toContain('USER_APPEND_RULE')
      expect(basePrompt).toContain('office-brief')

      const beforeStart = await session.extensionRunner.emitBeforeAgentStart(
        { type: 'before_agent_start', messageType: 'user', prompt: 'hello' } as any,
        (session as any)._baseSystemPromptOptions,
      )
      expect(beforeStart.systemPromptOptions.forceSystemPrompt).toBeUndefined()
      expect(beforeStart.systemPromptOptions.sections?.genoffice_workbench).toBe(
        STATIC_WORKBENCH_SYSTEM_PROMPT,
      )
    } finally {
      session.dispose()
    }

    // Verify user-supplied agentDir/SYSTEM.md overrides GENOFFICE_PI_SYSTEM_PROMPT cleanly.
    writeFileSync(join(agentDir, 'SYSTEM.md'), 'USER_CUSTOM_SYSTEM_PROMPT', 'utf8')
    const customLoader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      systemPromptOverride: (base) => resolveGenofficeSystemPrompt(base),
      agentsFilesOverride: ({ agentsFiles }) => ({
        agentsFiles: filterAgentContextFiles(agentsFiles, agentDir),
      }),
      noThemes: true,
    })
    await customLoader.reload()
    expect(customLoader.getSystemPrompt()).toBe('USER_CUSTOM_SYSTEM_PROMPT')

    // Verify configured Settings prompt takes precedence over agentDir/SYSTEM.md.
    const settingsLoader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      systemPromptOverride: (base) =>
        resolveGenofficeSystemPrompt(base, 'SETTINGS_CONFIGURED_SYSTEM_PROMPT'),
      agentsFilesOverride: ({ agentsFiles }) => ({
        agentsFiles: filterAgentContextFiles(agentsFiles, agentDir),
      }),
      noThemes: true,
    })
    await settingsLoader.reload()
    expect(settingsLoader.getSystemPrompt()).toBe('SETTINGS_CONFIGURED_SYSTEM_PROMPT')
    expect(settingsLoader.getAppendSystemPrompt()).toEqual(['USER_APPEND_RULE'])
    expect(settingsLoader.getSkills().skills.map((s) => s.name)).toContain('office-brief')
  })

  it('produces distinct prefsReloadKey values when persona changes and keeps empty default compatible', () => {
    const baseDefault = prefsReloadKey(DEFAULT_PI_AGENT_PREFS, 'sqlite')
    const explicitEmpty = prefsReloadKey(DEFAULT_PI_AGENT_PREFS, 'sqlite', '')
    const personaA = prefsReloadKey(
      DEFAULT_PI_AGENT_PREFS,
      'sqlite',
      '## Butler persona\nYou are Jarvis.',
    )
    const personaB = prefsReloadKey(
      DEFAULT_PI_AGENT_PREFS,
      'sqlite',
      '## Butler persona\nYou are Alfred.',
    )

    expect(explicitEmpty).toBe(baseDefault)
    expect(personaA).not.toBe(baseDefault)
    expect(personaB).not.toBe(baseDefault)
    expect(personaA).not.toBe(personaB)
  })

  it('appends non-empty persona deterministically to the resolved system prompt and keeps empty persona byte-identical', () => {
    const resolvedDefault = resolveGenofficeSystemPrompt(undefined)
    const resolvedConfigured = resolveGenofficeSystemPrompt('Custom SYSTEM.md', 'Configured prompt')

    expect(appendButlerPersona(resolvedDefault, '')).toBe(resolvedDefault)
    expect(appendButlerPersona(resolvedConfigured, '')).toBe(resolvedConfigured)

    const persona = '## Butler persona\nYou are Jarvis.'
    const withDefault = appendButlerPersona(resolvedDefault, persona)
    const withConfigured = appendButlerPersona(resolvedConfigured, persona)

    expect(withDefault).toBe(`${resolvedDefault}\n\n${persona}`)
    expect(withDefault.endsWith(persona)).toBe(true)
    expect(withConfigured).toBe(`${resolvedConfigured}\n\n${persona}`)
    expect(withConfigured.endsWith(persona)).toBe(true)
  })

  it('syncs cached session model and opt-in thinkingLevel only when changed without touching unconfigured defaults', async () => {
    const defaults = defaultAiSettings()
    const unsetSpec = buildSyncedPiModelSpec({
      ...defaults,
      provider: 'openai',
      providers: {
        ...defaults.providers,
        openai: { ...defaults.providers.openai, apiKey: 'sk', model: 'gpt-6.1-terra' },
      },
    })
    const lowSpec = buildSyncedPiModelSpec({
      ...defaults,
      provider: 'openai',
      providers: {
        ...defaults.providers,
        openai: {
          ...defaults.providers.openai,
          apiKey: 'sk',
          model: 'gpt-6.1-terra',
          thinking: { 'gpt-6.1-terra': 'low' },
        },
      },
    })
    const mediumSpec = buildSyncedPiModelSpec({
      ...defaults,
      provider: 'openai',
      providers: {
        ...defaults.providers,
        openai: {
          ...defaults.providers.openai,
          apiKey: 'sk',
          model: 'gpt-6.1-terra',
          thinking: { 'gpt-6.1-terra': 'medium' },
        },
      },
    })
    const xhighSpec = buildSyncedPiModelSpec({
      ...defaults,
      provider: 'openai',
      providers: {
        ...defaults.providers,
        openai: {
          ...defaults.providers.openai,
          apiKey: 'sk',
          model: 'gpt-6.1-terra',
          thinking: { 'gpt-6.1-terra': 'xhigh' },
        },
      },
    })

    let liveModel = unsetSpec.piModel
    const setModel = vi.fn(async (next: typeof liveModel) => {
      liveModel = next
    })
    const setThinkingLevel = vi.fn()
    const fakeSession = {
      get model() {
        return liveModel
      },
      setModel,
      setThinkingLevel,
    }

    // 1. Unchanged unconfigured session: no calls emitted.
    await expect(
      syncCachedSessionModelAndThinking(
        {
          lastModelRef: unsetSpec.modelRef,
          lastThinkingLevel: undefined,
          session: fakeSession,
        },
        unsetSpec,
      ),
    ).resolves.toBe(false)
    expect(setModel).not.toHaveBeenCalled()
    expect(setThinkingLevel).not.toHaveBeenCalled()

    // 2. Unset -> low: refreshes model (reasoning: true) then sets thinkingLevel.
    await expect(
      syncCachedSessionModelAndThinking(
        {
          lastModelRef: unsetSpec.modelRef,
          lastThinkingLevel: undefined,
          session: fakeSession,
        },
        lowSpec,
      ),
    ).resolves.toBe(true)
    expect(setModel).toHaveBeenCalledTimes(1)
    expect(setModel).toHaveBeenCalledWith(lowSpec.piModel)
    expect(setThinkingLevel).toHaveBeenCalledWith('low')

    // 3. low -> medium on the same model: updates thinkingLevel without redundant setModel.
    setModel.mockClear()
    setThinkingLevel.mockClear()
    await expect(
      syncCachedSessionModelAndThinking(
        {
          lastModelRef: lowSpec.modelRef,
          lastThinkingLevel: 'low',
          session: fakeSession,
        },
        mediumSpec,
      ),
    ).resolves.toBe(true)
    expect(setModel).not.toHaveBeenCalled()
    expect(setThinkingLevel).toHaveBeenCalledWith('medium')

    // 4. medium -> xhigh: refreshes model so thinkingLevelMap includes xhigh before setThinkingLevel.
    setModel.mockClear()
    setThinkingLevel.mockClear()
    await expect(
      syncCachedSessionModelAndThinking(
        {
          lastModelRef: mediumSpec.modelRef,
          lastThinkingLevel: 'medium',
          session: fakeSession,
        },
        xhighSpec,
      ),
    ).resolves.toBe(true)
    expect(setModel).toHaveBeenCalledTimes(1)
    expect(setThinkingLevel).toHaveBeenCalledWith('xhigh')

    // 5. xhigh -> unset/none: refreshes model back to reasoning: false without forcing setThinkingLevel.
    setModel.mockClear()
    setThinkingLevel.mockClear()
    await expect(
      syncCachedSessionModelAndThinking(
        {
          lastModelRef: xhighSpec.modelRef,
          lastThinkingLevel: 'xhigh',
          session: fakeSession,
        },
        unsetSpec,
      ),
    ).resolves.toBe(true)
    expect(setModel).toHaveBeenCalledTimes(1)
    expect(setModel).toHaveBeenCalledWith(unsetSpec.piModel)
    expect(setThinkingLevel).not.toHaveBeenCalled()
  })

  it('applies opt-in thinkingLevel in createAgentSession and preserves defaults when unset', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const userData = makeTempDir('genoffice-pi-sdk-thinking-')
    const cwd = join(userData, 'workspace')
    mkdirSync(cwd, { recursive: true })
    const paths = resolvePiRuntimePaths({ userDataDir: userData, storageMode: 'isolated' })

    const defaults = defaultAiSettings()
    const xhighSettings: AiSettings = {
      ...defaults,
      provider: 'openai',
      providers: {
        ...defaults.providers,
        openai: {
          ...defaults.providers.openai,
          apiKey: 'sk-test-openai',
          model: 'gpt-6.1-terra',
          thinking: { 'gpt-6.1-terra': 'xhigh' },
        },
      },
    }
    const unsetSettings: AiSettings = {
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

    const xhighSpec = syncPiProviderAndMagicContextConfig(
      paths,
      xhighSettings,
      DEFAULT_PI_AGENT_PREFS,
    )!
    expect(xhighSpec.thinkingLevel).toBe('xhigh')

    const settingsManager = sdk.SettingsManager.create(cwd, paths.agentDir, {
      projectTrusted: true,
    })
    settingsManager.setDefaultThinkingLevel('medium')
    const modelRuntime = await sdk.ModelRuntime.create({
      authPath: paths.authJsonPath,
      modelsPath: paths.modelsJsonPath,
      refreshOnCreate: false,
    })

    const { session } = await sdk.createAgentSession({
      cwd,
      agentDir: paths.agentDir,
      modelRuntime,
      model: xhighSpec.piModel,
      ...(xhighSpec.thinkingLevel !== undefined ? { thinkingLevel: xhighSpec.thinkingLevel } : {}),
      sessionManager: sdk.SessionManager.inMemory(cwd),
      settingsManager,
    })
    try {
      expect(session.model?.api).toBe('openai-responses')
      expect(session.model?.reasoning).toBe(true)
      expect(session.thinkingLevel).toBe('xhigh')
      // Applying per-session thinkingLevel must not overwrite the user's global default.
      expect(settingsManager.getDefaultThinkingLevel()).toBe('medium')

      // Switching across models (openai -> anthropic) updates model, compat, and thinkingLevel.
      const claudeSettings: AiSettings = {
        ...defaults,
        provider: 'anthropic',
        providers: {
          ...defaults.providers,
          anthropic: {
            ...defaults.providers.anthropic,
            apiKey: 'sk-ant-test',
            model: 'claude-opus-5-5',
            thinking: { 'claude-opus-5-5': 'max' },
          },
        },
      }
      const claudeSpec = syncPiProviderAndMagicContextConfig(
        paths,
        claudeSettings,
        DEFAULT_PI_AGENT_PREFS,
      )!
      const switchedToClaude = await syncCachedSessionModelAndThinking(
        {
          lastModelRef: xhighSpec.modelRef,
          lastThinkingLevel: xhighSpec.thinkingLevel,
          session,
        },
        claudeSpec,
      )
      expect(switchedToClaude).toBe(true)
      expect(session.model?.api).toBe('anthropic-messages')
      expect(session.model?.reasoning).toBe(true)
      expect(session.thinkingLevel).toBe('max')

      // Switching via syncCachedSessionModelAndThinking to unset resets reasoning: false and clamps to off.
      const unsetSpec = syncPiProviderAndMagicContextConfig(
        paths,
        unsetSettings,
        DEFAULT_PI_AGENT_PREFS,
      )!
      const changed = await syncCachedSessionModelAndThinking(
        {
          lastModelRef: claudeSpec.modelRef,
          lastThinkingLevel: claudeSpec.thinkingLevel,
          session,
        },
        unsetSpec,
      )
      expect(changed).toBe(true)
      expect(session.model?.reasoning).toBe(false)
      expect(session.thinkingLevel).toBe('off')
      expect(settingsManager.getDefaultThinkingLevel()).toBe('medium')
    } finally {
      session.dispose()
    }

    // Creating a session without an explicit GenOffice thinking pick preserves existing defaults.
    const unsetSpec = syncPiProviderAndMagicContextConfig(
      paths,
      unsetSettings,
      DEFAULT_PI_AGENT_PREFS,
    )!
    const { session: defaultSession } = await sdk.createAgentSession({
      cwd,
      agentDir: paths.agentDir,
      modelRuntime,
      model: unsetSpec.piModel,
      ...(unsetSpec.thinkingLevel !== undefined ? { thinkingLevel: unsetSpec.thinkingLevel } : {}),
      sessionManager: sdk.SessionManager.inMemory(cwd),
      settingsManager,
    })
    try {
      expect(defaultSession.model?.reasoning).toBe(false)
      expect(defaultSession.thinkingLevel).toBe('off')
      expect(settingsManager.getDefaultThinkingLevel()).toBe('medium')
    } finally {
      defaultSession.dispose()
    }
  })
})

describe('chief orchestrator isolation, session rotation, and transient socket retry', () => {
  const savedEnv = { ...process.env }

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key]
      }
    }
    Object.assign(process.env, savedEnv)
  })

  function makeDummyWorkbench(): WorkbenchToolsService {
    const noopAsync = async () => ({})
    return {
      kbList: vi.fn(async () => []),
      kbSearch: vi.fn(async () => []),
      kbRead: noopAsync,
      createDocument: noopAsync,
      editFile: noopAsync,
      deleteFile: noopAsync,
      readAttachment: async () => ({ ok: false, error: 'none' }),
      readAttachmentImage: () => ({ ok: false, error: 'none' }),
      cliContext: () => null,
      runCli: noopAsync,
      getAppSkillManifest: vi.fn(async () => ({ windows: [], tools: [] })),
      executeAppSkill: noopAsync as WorkbenchToolsService['executeAppSkill'],
      describeDocumentAgent: async () => ({ error: 'none' }),
      runDocumentAgent: async () => ({ ok: false, error: 'none', edits: [] }),
      cancelDocumentAgent: () => false,
      undoDocumentAgent: async () => ({ ok: false, error: 'none' }),
      executeBrowserSkill: noopAsync,
      listBrowserTabs: vi.fn(async () => []),
      listSurfaceTabs: vi.fn(async () => []),
      recordLineage: () => {},
      lineageFor: () => null,
    }
  }

  it('excludes all built-in tools for Chief session while preserving worker/chat prefs', () => {
    const allEnabled = { enablePiReadTools: true, enablePiWriteTools: true }
    expect(buildSessionExcludeBuiltinTools(allEnabled, BUTLER_CHIEF_SESSION_KEY)).toEqual([
      'read',
      'grep',
      'find',
      'ls',
      'bash',
      'powershell',
      'edit',
      'write',
    ])
    expect(buildSessionExcludeBuiltinTools(allEnabled, 'default:butler-worker-1')).toEqual([])
    expect(buildSessionExcludeBuiltinTools(allEnabled, 'proj-1:chat-1')).toEqual([])
    expect(
      buildSessionExcludeBuiltinTools(
        { enablePiReadTools: false, enablePiWriteTools: true },
        'default:butler-worker-1',
      ),
    ).toEqual(['read', 'grep', 'find', 'ls'])
  })

  it('detects transient socket errors accurately and ignores non-retryable 400 errors', () => {
    expect(
      isTransientPiSocketError('Connection error.: other side closed (UND_ERR_SOCKET)'),
    ).toBe(true)
    expect(isTransientPiSocketError('read ECONNRESET')).toBe(true)
    expect(isTransientPiSocketError('socket hang up')).toBe(true)
    expect(isTransientPiSocketError('fetch failed')).toBe(true)
    expect(isTransientPiSocketError('request ETIMEDOUT')).toBe(true)

    expect(isTransientPiSocketError('HTTP 400 Invalid argument')).toBe(false)
    expect(isTransientPiSocketError('')).toBe(false)
    expect(isTransientPiSocketError(null)).toBe(false)
    expect(isTransientPiSocketError(undefined)).toBe(false)
  })

  it('identifies bloated or corrupted Chief JSONL sessions while keeping clean sessions intact', () => {
    const dir = makeTempDir('genoffice-chief-bloat-')

    const cleanFile = join(dir, 'clean.jsonl')
    writeFileSync(
      cleanFile,
      [
        JSON.stringify({ type: 'session', id: 's1', timestamp: '2026-11-25T00:00:00Z' }),
        JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: 'hi' } }),
        JSON.stringify({
          type: 'message',
          id: 'm2',
          message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        }),
      ].join('\n') + '\n',
      'utf8',
    )
    expect(shouldResetBloatedChiefSession(cleanFile)).toBe(false)
    expect(shouldResetBloatedChiefSession(join(dir, 'missing.jsonl'))).toBe(false)

    const oversizedFile = join(dir, 'oversized.jsonl')
    writeFileSync(oversizedFile, 'x'.repeat(CHIEF_SESSION_MAX_BYTES + 128), 'utf8')
    expect(shouldResetBloatedChiefSession(oversizedFile)).toBe(true)

    const socketErrFile = join(dir, 'socket-err.jsonl')
    writeFileSync(
      socketErrFile,
      JSON.stringify({
        type: 'message',
        message: { role: 'assistant', stopReason: 'error', errorMessage: 'UND_ERR_SOCKET' },
      }) + '\n',
      'utf8',
    )
    expect(shouldResetBloatedChiefSession(socketErrFile)).toBe(true)

    const contextEditFile = join(dir, 'context-edit.jsonl')
    writeFileSync(
      contextEditFile,
      JSON.stringify({ type: 'context_edit', id: 'e1', targetId: 'm1' }) + '\n',
      'utf8',
    )
    expect(shouldResetBloatedChiefSession(contextEditFile)).toBe(true)

    const hugeToolResultFile = join(dir, 'huge-tool.jsonl')
    writeFileSync(
      hugeToolResultFile,
      JSON.stringify({
        type: 'message',
        id: 't1',
        message: { role: 'toolResult', content: [{ type: 'text', text: 'A'.repeat(5000) }] },
      }) + '\n',
      'utf8',
    )
    expect(shouldResetBloatedChiefSession(hugeToolResultFile)).toBe(true)

    const syntheticBackfillFile = join(dir, 'synthetic-backfill.jsonl')
    writeFileSync(
      syntheticBackfillFile,
      JSON.stringify({
        type: 'message',
        id: 's-backfill',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Opened media player.' }],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          stopReason: 'stop',
        },
      }) + '\n',
      'utf8',
    )
    expect(shouldResetBloatedChiefSession(syntheticBackfillFile)).toBe(true)

    const legacyPromptFile = join(dir, 'legacy-prompt.jsonl')
    writeFileSync(
      legacyPromptFile,
      JSON.stringify({
        type: 'message',
        id: 'legacy-1',
        message: {
          role: 'user',
          content: 'Two-Stage Alignment Instructions for Chief Butler:\nhello',
        },
      }) + '\n',
      'utf8',
    )
    expect(shouldResetBloatedChiefSession(legacyPromptFile)).toBe(true)
  })

  it('isolates Chief session resources, rotates bloated JSONL, skips synthetic backfill, and skips workbench_context', async () => {
    const userData = makeTempDir('genoffice-chief-isolation-')
    const paths = resolvePiRuntimePaths({ userDataDir: userData, storageMode: 'isolated' })
    mkdirSync(paths.sessionsDir, { recursive: true })

    // Seed a bloated Chief session file in session-map.json.
    const bloatedFile = join(paths.sessionsDir, 'old-bloated.jsonl')
    writeFileSync(
      bloatedFile,
      JSON.stringify({ type: 'message', message: { role: 'assistant', errorMessage: 'UND_ERR_SOCKET' } }) + '\n',
      'utf8',
    )
    const mapStore = new SessionMapStore(paths.sessionMapPath)
    mapStore.set(BUTLER_CHIEF_SESSION_KEY, bloatedFile)

    const loaderConfigs: Array<Record<string, unknown>> = []
    const createSessionCalls: Array<Record<string, unknown>> = []
    const appendedMessages: Array<{ role: string; textLength: number }> = []
    const sentPrompts: string[] = []
    const freshFile = join(paths.sessionsDir, 'fresh-chief.jsonl')

    const fakeSdk = {
      DefaultResourceLoader: class {
        constructor(opts: Record<string, unknown>) {
          loaderConfigs.push(opts)
        }
        async reload() {}
        getSkills() {
          return { skills: [] }
        }
      },
      SettingsManager: {
        create: () => ({}),
      },
      SessionManager: {
        open: vi.fn(),
        create: vi.fn(() => {
          writeFileSync(freshFile, '{"type":"session","id":"fresh"}\n', 'utf8')
          return {
            getSessionFile: () => freshFile,
            getSessionId: () => 'fresh-pi-id',
            appendMessage: (msg: { role: string; content: unknown }) => {
              const txt =
                typeof msg.content === 'string'
                  ? msg.content
                  : Array.isArray(msg.content)
                    ? String((msg.content[0] as { text?: string })?.text ?? '')
                    : ''
              appendedMessages.push({ role: msg.role, textLength: txt.length })
            },
          }
        }),
      },
      ModelRuntime: {
        create: vi.fn(async () => ({})),
      },
      createAgentSession: vi.fn(async (opts: Record<string, unknown>) => {
        createSessionCalls.push(opts)
        const listeners: Array<(ev: unknown) => void> = []
        const session = {
          model: opts.model,
          sessionManager: opts.sessionManager,
          extensionRunner: { getToolDefinition: () => undefined, getRegisteredCommands: () => [] },
          getContextUsage: () => ({ tokens: 100, contextWindow: 128_000, percent: 0.1 }),
          subscribe: (fn: (ev: unknown) => void) => listeners.push(fn),
          bindExtensions: async () => {},
          dispose: () => {},
          setModel: async () => {},
          setThinkingLevel: () => {},
          prompt: async (text: string) => {
            sentPrompts.push(text)
            const msg = {
              role: 'assistant',
              stopReason: 'stop',
              content: [{ type: 'text', text: '收到，先生。' }],
            }
            for (const l of listeners) l({ type: 'message_start', message: msg })
            for (const l of listeners)
              l({
                type: 'message_update',
                assistantMessageEvent: { type: 'text_delta', delta: '收到，先生。' },
              })
            for (const l of listeners) l({ type: 'message_end', message: msg })
          },
        }
        return { session }
      }),
    }

    const longHistory = Array.from({ length: 12 }, (_, idx) => ({
      role: idx % 2 === 0 ? 'user' : 'assistant',
      text: `msg-${idx}-` + 'Z'.repeat(800),
      ts: new Date(1_700_000_000_000 + idx * 1000).toISOString(),
    }))

    const defaults = defaultAiSettings()
    const settings: AiSettings = {
      ...defaults,
      provider: 'custom',
      providers: {
        ...defaults.providers,
        custom: {
          ...defaults.providers.custom,
          baseUrl: 'http://127.0.0.1:7000/v1',
          apiKey: '1234',
          model: 'Huihui-Qwen3.8-27B-abliterated-UD-Q4_K_XL',
        },
      },
    }

    const workbench = makeDummyWorkbench()
    const chiefExt: ExtensionFactory = () => {}
    const manager = new PiAgentRuntimeManager({
      userDataDir: userData,
      getDefaultWorkingDir: () => userData,
      isPackaged: false,
      getPrefs: () => ({ ...DEFAULT_PI_AGENT_PREFS, magicContextEnabled: true }),
      getAiSettings: () => settings,
      getGskApiKey: () => '',
      getPermissionMode: () => 'standard',
      sessionAllows: { isAllowed: () => false, allowForSession: () => {} } as never,
      workbench,
      getProjectStore: () =>
        ({
          loadChat: () => longHistory,
          appendChatMessage: () => {},
        }) as never,
      sendConfirmRequest: () => {},
      sendStatusEvent: () => {},
      sendNoticeEvent: () => {},
      resolveSessionExtensions: () => ({ key: 'chief', factories: [chiefExt] }),
      loadPiSdk: async () => fakeSdk as never,
    })

    try {
      const res = await manager.prompt({
        sessionKey: BUTLER_CHIEF_SESSION_KEY,
        projectId: 'default',
        chatId: 'butler-main',
        instruction: '你好贾维斯',
      })

      expect(res).toEqual({ ok: true, finalText: '收到，先生。' })
      // Bloated JSONL must be deleted and bypassed instead of opened.
      expect(existsSync(bloatedFile)).toBe(false)
      expect(fakeSdk.SessionManager.open).not.toHaveBeenCalled()
      expect(fakeSdk.SessionManager.create).toHaveBeenCalledTimes(1)

      // Synthetic tool-less backfill must never be injected into Chief sessions.
      expect(appendedMessages).toHaveLength(0)

      // Chief ResourceLoader skips magicContext, bundled skills, and workbench/permission extensions.
      expect(loaderConfigs[0]?.additionalExtensionPaths).toEqual([])
      expect(loaderConfigs[0]?.additionalSkillPaths).toEqual([])
      expect(loaderConfigs[0]?.extensionFactories).toEqual([chiefExt])

      // All 8 built-in tools are excluded for Chief.
      expect(createSessionCalls[0]?.excludeTools).toEqual([
        'read',
        'grep',
        'find',
        'ls',
        'bash',
        'powershell',
        'edit',
        'write',
      ])

      // Outbound prompt skips <workbench_context> and workbench RPCs.
      expect(sentPrompts).toEqual(['你好贾维斯'])
      expect(workbench.kbList).not.toHaveBeenCalled()
      expect(workbench.listSurfaceTabs).not.toHaveBeenCalled()
    } finally {
      manager.disposeAll()
    }
  })

  it('retries transient UND_ERR_SOCKET error drops cleanly and surfaces unrecoverable errors', async () => {
    const userData = makeTempDir('genoffice-socket-retry-')
    const paths = resolvePiRuntimePaths({ userDataDir: userData, storageMode: 'isolated' })
    mkdirSync(paths.sessionsDir, { recursive: true })
    const sessionFile = join(paths.sessionsDir, 'retry-session.jsonl')

    let script: Array<
      | { kind: 'socket-error'; message: string }
      | { kind: 'fatal-error'; message: string }
      | { kind: 'success'; text: string }
    > = []
    let sessionSeq = 0
    let disposedCount = 0

    const fakeSdk = {
      DefaultResourceLoader: class {
        async reload() {}
        getSkills() {
          return { skills: [] }
        }
      },
      SettingsManager: { create: () => ({}) },
      SessionManager: {
        open: vi.fn((file: string) => ({
          getSessionFile: () => file,
          getSessionId: () => `pi-open-${sessionSeq}`,
        })),
        create: vi.fn(() => {
          writeFileSync(sessionFile, '{"type":"session","id":"s-retry"}\n', 'utf8')
          return {
            getSessionFile: () => sessionFile,
            getSessionId: () => `pi-create-${sessionSeq}`,
            appendMessage: () => {},
          }
        }),
      },
      ModelRuntime: { create: vi.fn(async () => ({})) },
      createAgentSession: vi.fn(async (opts: Record<string, unknown>) => {
        const idx = sessionSeq++
        const listeners: Array<(ev: unknown) => void> = []
        const session = {
          model: opts.model,
          sessionManager: opts.sessionManager,
          extensionRunner: { getToolDefinition: () => undefined, getRegisteredCommands: () => [] },
          getContextUsage: () => null,
          subscribe: (fn: (ev: unknown) => void) => listeners.push(fn),
          bindExtensions: async () => {},
          dispose: () => {
            disposedCount += 1
          },
          setModel: async () => {},
          setThinkingLevel: () => {},
          prompt: async () => {
            const step = script[idx]!
            if (step.kind === 'socket-error' || step.kind === 'fatal-error') {
              // Simulate SessionManager appending dirty failed turn lines before resolving.
              appendFileSync(
                sessionFile,
                JSON.stringify({ type: 'message', role: 'user' }) +
                  '\n' +
                  JSON.stringify({
                    type: 'message',
                    role: 'assistant',
                    stopReason: 'error',
                    errorMessage: step.message,
                  }) +
                  '\n',
                'utf8',
              )
              const errMsg = {
                role: 'assistant',
                stopReason: 'error',
                errorMessage: step.message,
                content: [],
              }
              for (const l of listeners) l({ type: 'message_start', message: errMsg })
              for (const l of listeners) l({ type: 'message_end', message: errMsg })
              return
            }

            const okMsg = {
              role: 'assistant',
              stopReason: 'stop',
              content: [{ type: 'text', text: step.text }],
            }
            for (const l of listeners) l({ type: 'message_start', message: okMsg })
            for (const l of listeners)
              l({
                type: 'message_update',
                assistantMessageEvent: { type: 'text_delta', delta: step.text },
              })
            for (const l of listeners) l({ type: 'message_end', message: okMsg })
          },
        }
        return { session }
      }),
    }

    const defaults = defaultAiSettings()
    const settings: AiSettings = {
      ...defaults,
      provider: 'custom',
      providers: {
        ...defaults.providers,
        custom: {
          ...defaults.providers.custom,
          baseUrl: 'http://127.0.0.1:7000/v1',
          apiKey: '1234',
          model: 'Huihui-Qwen3.8-27B-abliterated-UD-Q4_K_XL',
        },
      },
    }

    const events: AskRunEvent[] = []
    const unsubObserver = addAskRunObserver({
      onEvent: (ev) => events.push(ev),
    })

    const manager = new PiAgentRuntimeManager({
      userDataDir: userData,
      getDefaultWorkingDir: () => userData,
      isPackaged: false,
      getPrefs: () => DEFAULT_PI_AGENT_PREFS,
      getAiSettings: () => settings,
      getGskApiKey: () => '',
      getPermissionMode: () => 'standard',
      sessionAllows: { isAllowed: () => false, allowForSession: () => {} } as never,
      workbench: makeDummyWorkbench(),
      getProjectStore: () => null,
      sendConfirmRequest: () => {},
      sendStatusEvent: () => {},
      sendNoticeEvent: () => {},
      loadPiSdk: async () => fakeSdk as never,
    })

    try {
      // 1. Attempt 1 fails silently with UND_ERR_SOCKET, attempt 2 succeeds cleanly.
      script = [
        { kind: 'socket-error', message: 'Connection error.: other side closed (UND_ERR_SOCKET)' },
        { kind: 'success', text: '已为您整理完毕。' },
      ]
      const resOk = await manager.prompt({
        sessionKey: BUTLER_CHIEF_SESSION_KEY,
        projectId: 'default',
        chatId: 'butler-main',
        instruction: '整理一下汇报',
      })
      expect(resOk).toEqual({ ok: true, finalText: '已为您整理完毕。' })
      expect(disposedCount).toBe(1)
      expect(readFileSync(sessionFile, 'utf8')).not.toContain('UND_ERR_SOCKET')
      expect(events.some((e) => e.type === 'error')).toBe(false)
      expect(events.some((e) => e.type === 'text' && e.payload === '已为您整理完毕。')).toBe(true)
      expect(events.at(-1)?.type).toBe('done')

      // 2. Exhausted transient retries -> must return ok: false and emit 'error' + 'done'.
      events.length = 0
      sessionSeq = 0
      disposedCount = 0
      script = [
        { kind: 'socket-error', message: 'Connection error.: other side closed (UND_ERR_SOCKET)' },
        { kind: 'socket-error', message: 'Connection error.: other side closed (UND_ERR_SOCKET)' },
        { kind: 'socket-error', message: 'Connection error.: other side closed (UND_ERR_SOCKET)' },
      ]
      const resExhausted = await manager.prompt({
        sessionKey: BUTLER_CHIEF_SESSION_KEY,
        projectId: 'default',
        chatId: 'butler-main',
        instruction: '继续整理',
      })
      expect(resExhausted).toEqual({
        ok: false,
        error: 'Connection error.: other side closed (UND_ERR_SOCKET)',
      })
      expect(disposedCount).toBe(2)
      expect(events.filter((e) => e.type === 'error')).toHaveLength(1)
      expect(events.at(-1)?.type).toBe('done')

      // 3. Non-retryable error (HTTP 400) must fail immediately without retrying.
      events.length = 0
      sessionSeq = 0
      disposedCount = 0
      script = [{ kind: 'fatal-error', message: 'HTTP 400 Invalid argument' }]
      const resFatal = await manager.prompt({
        sessionKey: 'default:worker-non-retryable',
        projectId: 'default',
        chatId: 'worker-non-retryable',
        instruction: 'run task',
      })
      expect(resFatal).toEqual({ ok: false, error: 'HTTP 400 Invalid argument' })
      expect(disposedCount).toBe(0)
      expect(events.filter((e) => e.type === 'error')).toHaveLength(1)
      expect(events.at(-1)?.type).toBe('done')
    } finally {
      unsubObserver()
      manager.disposeAll()
    }
  })
})
