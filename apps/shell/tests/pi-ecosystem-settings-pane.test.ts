/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PiEcosystemSettingsPane,
  collectMemoryCategories,
  filterMagicMemories,
  formatMemoryDate,
} from '../src/renderer/src/PiEcosystemSettingsPane'
import { getPiEcosystemStrings } from '../src/renderer/src/pi-ecosystem-strings'
import {
  DEFAULT_PI_AGENT_PREFS,
  GENOFFICE_PI_SYSTEM_PROMPT,
  MAX_PI_SYSTEM_PROMPT_CHARS,
  mergePiAgentPrefs,
  normalizePiAgentPrefs,
  normalizePiSystemPrompt,
  type PiAgentPrefs,
} from '../src/shared/pi-agent-prefs'
import type { PiEcosystemOverview, PiMagicMemoryEntry } from '../src/shared/pi-agent-api'
import { LocaleProvider, type TFunc } from '../src/renderer/src/locale'

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('pi-ecosystem-settings-pane helpers & component', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (root) {
      act(() => root!.unmount())
      root = null
    }
    container?.remove()
    container = null
    delete (window as unknown as { aiOffice?: unknown }).aiOffice
  })

  it('localizes strings cleanly with English fallback for unsupported locales', () => {
    const zh = getPiEcosystemStrings('zh')
    const tw = getPiEcosystemStrings('zh-TW')
    const en = getPiEcosystemStrings('en')
    const frFallback = getPiEcosystemStrings('fr')

    expect(zh.title).toContain('Pi')
    expect(tw.title).toContain('Pi')
    expect(en.title).toBe('Memory & Pi Ecosystem')
    expect(frFallback).toEqual(en)
    for (const [k, v] of Object.entries(zh)) {
      expect(typeof v, `zh.${k}`).toBe('string')
      expect(v.trim().length, `zh.${k}`).toBeGreaterThan(0)
    }
  })

  it('filters memories by category, collects sorted categories, and formats dates safely', () => {
    const sample: PiMagicMemoryEntry[] = [
      {
        id: 1,
        projectIdentity: 'p1',
        category: 'preference',
        content: 'Prefers concise answers',
        createdAt: '2026-11-20 10:00:00',
      },
      {
        id: 2,
        projectIdentity: 'p1',
        category: 'decision',
        content: 'Use sqlite isolated storage',
        createdAt: '2026-11-20T12:30:00Z',
      },
      {
        id: 3,
        projectIdentity: 'p1',
        category: 'preference',
        content: 'Avoid emojis',
      },
    ]

    expect(collectMemoryCategories(sample)).toEqual(['decision', 'preference'])
    expect(filterMagicMemories(sample, 'all')).toHaveLength(3)
    expect(filterMagicMemories(sample, 'decision').map((m) => m.id)).toEqual([2])
    expect(formatMemoryDate(undefined)).toBe('—')
    expect(formatMemoryDate('invalid-date')).toBe('invalid-date')
    expect(formatMemoryDate('2026-11-20T12:30:00Z')).not.toBe('—')
  })

  it('normalizes and merges PiAgentPrefs consistently', () => {
    expect(DEFAULT_PI_AGENT_PREFS.engine).toBe('pi')
    expect(DEFAULT_PI_AGENT_PREFS.embeddingMode).toBe('off')
    const normalized = normalizePiAgentPrefs({
      engine: 'legacy',
      dreamerEnabled: true,
      embeddingMode: 'local',
      historianModel: '  gpt-4o-mini  ',
    })
    expect(normalized.engine).toBe('legacy')
    expect(normalized.dreamerEnabled).toBe(true)
    expect(normalized.embeddingMode).toBe('local')
    expect(normalized.historianModel).toBe('gpt-4o-mini')

    const merged = mergePiAgentPrefs(normalized, {
      engine: 'pi',
      magicContextStorageMode: 'shared',
    })
    expect(merged.engine).toBe('pi')
    expect(merged.magicContextStorageMode).toBe('shared')
    expect(merged.dreamerEnabled).toBe(true)

    expect(DEFAULT_PI_AGENT_PREFS.systemPrompt).toBe('')
    expect(normalizePiSystemPrompt('   \r\n ')).toBe('')
    expect(normalizePiSystemPrompt(GENOFFICE_PI_SYSTEM_PROMPT)).toBe('')
    expect(normalizePiSystemPrompt('  Custom line 1\r\nLine 2  ')).toBe('Custom line 1\nLine 2')
    expect(normalizePiSystemPrompt('x'.repeat(MAX_PI_SYSTEM_PROMPT_CHARS + 50))).toHaveLength(
      MAX_PI_SYSTEM_PROMPT_CHARS,
    )
  })

  it('renders PiEcosystemSettingsPane, commits engine toggles, installs packages, and runs diagnostics', async () => {
    let currentPrefs: PiAgentPrefs = { ...DEFAULT_PI_AGENT_PREFS }
    const overview: PiEcosystemOverview = {
      activeEngine: 'pi',
      envOverrideLegacy: false,
      magicContextLoaded: true,
      magicContextVersion: '0.49.67',
      piCodingAgentVersion: '1.5.2',
      agentDir: '/tmp/agent',
      storageDir: '/tmp/storage',
      shimPath: '/tmp/shim',
      nodeSqliteSupported: true,
      memoryCount: 1,
      compartmentCount: 2,
      packages: [],
      extensions: [
        {
          path: '/ext/workbench.ts',
          source: 'workbench',
          toolNames: ['search_kb', 'document_agent'],
          commandNames: ['ctx-status'],
        },
      ],
      skills: [
        {
          name: 'summary',
          description: 'Summarize active document',
          filePath: '/skills/summary/SKILL.md',
          sourceKind: 'genoffice',
        },
      ],
      commands: [{ name: 'ctx-status', description: 'Show status', source: 'magic-context' }],
      diagnostics: [{ id: 'sqlite', label: 'node:sqlite', ok: true, detail: 'ready' }],
      extensionErrors: [],
    }
    const memories: PiMagicMemoryEntry[] = [
      {
        id: 11,
        projectIdentity: 'proj-a',
        category: 'fact',
        content: 'Alpha token is 42',
        createdAt: '2026-11-20T09:00:00Z',
      },
    ]

    const piAgentPrefsSet = vi.fn(async (patch: Partial<PiAgentPrefs>) => {
      currentPrefs = mergePiAgentPrefs(currentPrefs, patch)
      return currentPrefs
    })
    const piAgentPackageInstall = vi.fn(async (source: string) => ({
      ok: true,
      message: `Installed ${source}`,
    }))
    const piAgentRunDiagnostics = vi.fn(async () => ({
      ok: true,
      checkedAt: '2026-11-20T10:00:00Z',
      items: [{ id: 'shim', label: 'Subagent Shim', ok: true, detail: 'node-free ok' }],
    }))

    ;(window as unknown as { aiOffice: Record<string, unknown> }).aiOffice = {
      piAgentPrefsGet: vi.fn(async () => currentPrefs),
      piAgentPrefsSet,
      onPiAgentPrefsChanged: vi.fn(() => () => {}),
      piAgentEcosystemOverview: vi.fn(async () => overview),
      piAgentMemoriesList: vi.fn(async () => memories),
      piAgentPackageInstall,
      piAgentRunDiagnostics,
    }

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const t: TFunc = (key) => String(key)

    await act(async () => {
      root!.render(
        createElement(
          LocaleProvider,
          { lang: 'en', setLang: () => {} },
          createElement(PiEcosystemSettingsPane, { t }),
        ),
      )
      await flushMicrotasks()
    })

    const pane = container.querySelector('[data-testid="pi-ecosystem-settings-pane"]')
    expect(pane).not.toBeNull()
    expect(container.textContent).toContain('1.5.2')
    expect(container.textContent).toContain('Alpha token is 42')

    const legacyBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent === 'Legacy Loop',
    )
    expect(legacyBtn).toBeDefined()
    await act(async () => {
      legacyBtn!.click()
      await flushMicrotasks()
    })
    expect(piAgentPrefsSet).toHaveBeenCalledWith({ engine: 'legacy' })

    const pkgInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Pi Community Packages"]',
    )
    const installBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent === 'Install',
    )
    expect(pkgInput).not.toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(pkgInput, 'npm:pi-web-access')
      pkgInput!.dispatchEvent(new Event('input', { bubbles: true }))
      pkgInput!.dispatchEvent(new Event('change', { bubbles: true }))
      await flushMicrotasks()
    })
    await act(async () => {
      installBtn!.click()
      await flushMicrotasks()
    })
    expect(piAgentPackageInstall).toHaveBeenCalledWith('npm:pi-web-access')

    const diagBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent === 'Run Diagnostics',
    )
    await act(async () => {
      diagBtn!.click()
      await flushMicrotasks()
    })
    expect(piAgentRunDiagnostics).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Subagent Shim')

    // System prompt customization: prefilled default -> edit & save -> reset to default.
    const promptTextarea = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="pi-system-prompt-textarea"]',
    )
    const promptBadge = container.querySelector('[data-testid="pi-system-prompt-badge"]')
    const savePromptBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="pi-system-prompt-save"]',
    )
    const resetPromptBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="pi-system-prompt-reset"]',
    )
    expect(promptTextarea).not.toBeNull()
    expect(promptTextarea!.value).toBe(GENOFFICE_PI_SYSTEM_PROMPT)
    expect(promptBadge?.getAttribute('data-custom')).toBe('false')
    expect(savePromptBtn?.disabled).toBe(true)
    expect(resetPromptBtn?.disabled).toBe(true)

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(promptTextarea, 'Custom executive assistant instructions')
      promptTextarea!.dispatchEvent(new Event('input', { bubbles: true }))
      promptTextarea!.dispatchEvent(new Event('change', { bubbles: true }))
      await flushMicrotasks()
    })
    expect(savePromptBtn?.disabled).toBe(false)

    await act(async () => {
      savePromptBtn!.click()
      await flushMicrotasks()
    })
    expect(piAgentPrefsSet).toHaveBeenCalledWith({
      systemPrompt: 'Custom executive assistant instructions',
    })
    expect(promptBadge?.getAttribute('data-custom')).toBe('true')
    expect(resetPromptBtn?.disabled).toBe(false)

    await act(async () => {
      resetPromptBtn!.click()
      await flushMicrotasks()
    })
    expect(piAgentPrefsSet).toHaveBeenCalledWith({ systemPrompt: '' })
    expect(promptBadge?.getAttribute('data-custom')).toBe('false')
    expect(promptTextarea!.value).toBe(GENOFFICE_PI_SYSTEM_PROMPT)
  })
})
