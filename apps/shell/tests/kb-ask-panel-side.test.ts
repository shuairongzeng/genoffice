// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyAiPanelPrefs, DEFAULT_AI_PANEL_PREFS, type AiPanelPrefs } from '@genoffice/ui'
import type { ChatMessage, ProjectApi } from '@genoffice/project-store'
import { KbAskPanel } from '../src/renderer/src/KbAskPanel'
import { LocaleProvider } from '../src/renderer/src/locale'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let currentTabs: Array<{ id: string; kind: string; title: string; filePath?: string; active: boolean }>
let setAiPanelPrefs: ReturnType<typeof vi.fn<(patch: Partial<AiPanelPrefs>) => Promise<AiPanelPrefs>>>

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {}
})

beforeEach(() => {
  applyAiPanelPrefs(DEFAULT_AI_PANEL_PREFS)
  currentTabs = [
    { id: 't1', kind: 'markdown', title: 'notes.md', filePath: 'C:/docs/notes.md', active: true },
  ]
  setAiPanelPrefs = vi.fn(async (patch: Partial<AiPanelPrefs>): Promise<AiPanelPrefs> => {
    const next: AiPanelPrefs = { ...DEFAULT_AI_PANEL_PREFS, ...patch }
    applyAiPanelPrefs(next)
    return next
  })

  const project = {
    resolveChat: async () => ({ projectId: 'default', chatId: 'kb-ask' }),
    loadChat: async () => [] as ChatMessage[],
    appendChat: async () => {},
    deleteChat: async () => {},
    listChats: async () => [],
  } as unknown as ProjectApi
  ;(window as unknown as { projectApi?: unknown }).projectApi = project
  ;(window as unknown as { aiOfficeTabs?: unknown }).aiOfficeTabs = {
    onChanged: () => () => {},
  }
  ;(window as unknown as { aiOffice: unknown }).aiOffice = {
    skillsList: vi.fn(async () => []),
    skillText: vi.fn(async () => ''),
    aiGetSettings: async () => null,
    aiGskStatus: async () => ({ loggedIn: true }),
    onAiSettingsChanged: () => () => {},
    kbList: async () => [],
    kbSearch: async () => [],
    onAiStream: () => () => {},
    aiStream: async () => {},
    aiStreamCancel: async () => {},
    askRunSnapshot: async () => null,
    onAskRunEvent: () => () => {},
    getSurfaceTabs: async () => currentTabs,
    setAiPanelPrefs,
  }

  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  applyAiPanelPrefs(DEFAULT_AI_PANEL_PREFS)
  vi.restoreAllMocks()
  delete (window as unknown as { aiOffice?: unknown }).aiOffice
  delete (window as unknown as { projectApi?: unknown }).projectApi
  delete (window as unknown as { aiOfficeTabs?: unknown }).aiOfficeTabs
})

async function settle(times = 10): Promise<void> {
  await act(async () => {
    for (let i = 0; i < times; i++) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function renderPanel(surfaceRole: 'home' | 'overlay' | 'docked'): void {
  act(() =>
    root.render(
      createElement(
        LocaleProvider,
        { initial: 'en' },
        createElement(KbAskPanel, {
          mirror: true,
          surfaceRole,
          onOpenPath: () => {},
          onGoToRecents: () => {},
          onOpenModelSettings: () => {},
          onOpenScopeSettings: () => {},
          onCollapse: () => {},
        }),
      ),
    ),
  )
}

describe('KbAskPanel header side switch & collapse direction', () => {
  it('renders AiPanelSideButton in docked editor mode, flips side on click, and updates collapse arrow direction', async () => {
    renderPanel('docked')
    await settle()

    const sideButton = host.querySelector<HTMLButtonElement>('.kb-ask-header .ai-panel-side-button')
    expect(sideButton).not.toBeNull()
    const collapseSvg = host.querySelector<SVGSVGElement>('.kb-ask-collapse-button svg')
    expect(collapseSvg).not.toBeNull()
    expect(collapseSvg!.style.transform).toBe('scaleX(-1)')

    await act(async () => {
      sideButton!.click()
      await Promise.resolve()
    })
    await settle()

    expect(setAiPanelPrefs).toHaveBeenCalledWith({ side: 'right' })
    expect(collapseSvg!.style.transform).toBe('')
  })

  it('omits AiPanelSideButton in home bubble mode', async () => {
    renderPanel('home')
    await settle()

    expect(host.querySelector('.kb-ask-header .ai-panel-side-button')).toBeNull()
    const collapseSvg = host.querySelector<SVGSVGElement>('.kb-ask-collapse-button svg')
    expect(collapseSvg).not.toBeNull()
    expect(collapseSvg!.style.transform).toBe('')
  })

  it('omits AiPanelSideButton when active tab is browser', async () => {
    currentTabs = [{ id: 'b1', kind: 'browser', title: 'Example', active: true }]
    renderPanel('docked')
    await settle()

    expect(host.querySelector('.kb-ask-header .ai-panel-side-button')).toBeNull()
    const collapseSvg = host.querySelector<SVGSVGElement>('.kb-ask-collapse-button svg')
    expect(collapseSvg).not.toBeNull()
    expect(collapseSvg!.style.transform).toBe('')
  })
})
