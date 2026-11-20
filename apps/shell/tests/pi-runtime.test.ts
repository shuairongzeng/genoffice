import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import {
  GENOFFICE_PI_SYSTEM_PROMPT,
  SessionMapStore,
  advanceReasoningDelta,
  appendPiCleanText,
  buildExcludeBuiltinTools,
  createOrdinalPrefixStripper,
  filterAgentContextFiles,
  messageUsageDelta,
  resolveGenofficeSystemPrompt,
  stripOrdinalPrefix,
} from '../src/main/pi-agent/pi-runtime'
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
})
