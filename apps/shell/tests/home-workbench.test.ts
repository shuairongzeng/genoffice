// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { defaultAiSettings } from '@genoffice/ai-provider'
import { Home } from '../src/renderer/src/Home'
import { LocaleProvider } from '../src/renderer/src/locale'
import {
  AI_DOCK_WIDTH_DEFAULT,
  AI_DOCK_WIDTH_MAX,
  clampDockWidth,
  normalizeAiDockPrefs,
} from '../src/renderer/src/AiDock'
import type { HomeApi, HomeTabEntry } from '../src/shared/home-api'
import type { RecentEntry } from '../src/shared/home-api'

/**
 * The workbench around Home's content column: the docked AI panel (its
 * collapse to the mascot, its persisted width, the prefs' degraded
 * localStorage copy while the app-settings channels are absent) and the
 * embedded document tab strip (the pushed contract's list, activate, close,
 * and the fixed desktop item). Everything the main process owns is a mock;
 * the assertions are about what Home does with the pushes and clicks.
 */

let root: Root
let container: HTMLDivElement
let tabsHandler: ((state: { tabs: HomeTabEntry[]; activeId: string }) => void) | null
const tabsActivate = vi.fn(async () => undefined)
const tabsClose = vi.fn(async () => undefined)
const getAiDock = vi.fn(async () => ({ width: AI_DOCK_WIDTH_DEFAULT, collapsed: false }))
const setAiDock = vi.fn(async () => ({ width: AI_DOCK_WIDTH_DEFAULT, collapsed: false }))
const homeContentRect = vi.fn()

const files: RecentEntry[] = [
  {
    path: '/fixtures/brief.docx',
    name: 'brief.docx',
    ext: 'docx',
    mtimeMs: 1,
    sizeBytes: 10,
    starred: false,
  },
]

/** the aiOffice face the workbench consumes; per-test overrides land on it */
function baseApi(): Partial<HomeApi> {
  const page = () => ({
    entries: files,
    total: files.length,
    totalAll: files.length,
  })
  return {
    folderRoots: async () => [],
    onFolderChanged: () => () => {},
    recents: async () => page(),
    starred: async () => ({ entries: [], total: 0, totalAll: 0 }),
    starredGroups: async () => [],
    accountStatus: async () => ({ loggedIn: false }),
    onOpenSettings: () => () => {},
    onAccountLogin: () => () => {},
    kbList: async () => [],
    aiGetSettings: async () => defaultAiSettings(),
    aiGskStatus: async () => ({ loggedIn: false }),
    onAiSettingsChanged: () => () => {},
    desktopLayout: async () => ({ positions: {} }),
    desktopLayoutSave: async () => undefined,
    onRecentsChanged: () => () => {},
    onTabsChanged: (handler: (state: { tabs: HomeTabEntry[]; activeId: string }) => void) => {
      tabsHandler = handler
      return () => {
        tabsHandler = null
      }
    },
    tabsActivate,
    tabsClose,
    getAiDock,
    setAiDock,
    homeContentRect,
    openPath: async () => undefined,
  }
}

async function mountHome(api: Partial<HomeApi>, launchView = 'recent'): Promise<void> {
  window.aiOffice = api as unknown as Window['aiOffice']
  localStorage.setItem('home.view', launchView)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root.render(createElement(LocaleProvider, { initial: 'en', children: createElement(Home) })),
  )
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve()
  })
}

async function unmountHome(): Promise<void> {
  await act(async () => root.unmount())
  container.remove()
}

/** a tab push the way the main process sends it: Home first, then documents */
function pushTabs(activeId: string, ...tabs: Array<Partial<HomeTabEntry>>): void {
  const home: HomeTabEntry = {
    id: 'home',
    kind: 'home',
    title: 'Home',
    active: activeId === 'home',
    dirty: false,
    detached: false,
  }
  const rest = tabs.map((tab) => ({
    id: tab.id ?? 't1',
    kind: tab.kind ?? 'docs',
    title: tab.title ?? 'Untitled',
    active: tab.active ?? false,
    dirty: tab.dirty ?? false,
    detached: tab.detached ?? false,
  }))
  tabsHandler?.({ tabs: [home, ...rest], activeId })
}

const tabTitle = (text: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll<HTMLButtonElement>('.work-tab-main')].find(
    (button) => button.querySelector('.work-tab-title')?.textContent === text,
  )

async function click(el: Element | undefined): Promise<void> {
  expect(el).toBeTruthy()
  await act(async () => (el as HTMLElement).click())
}

const dock = (): HTMLElement => container.querySelector<HTMLElement>('.ai-dock')!

beforeEach(() => {
  HTMLElement.prototype.scrollTo = vi.fn()
  localStorage.clear()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  tabsHandler = null
  tabsActivate.mockClear()
  tabsClose.mockClear()
  getAiDock.mockClear()
  setAiDock.mockClear()
  homeContentRect.mockClear()
  getAiDock.mockImplementation(async () => ({ width: AI_DOCK_WIDTH_DEFAULT, collapsed: false }))
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('No network in workbench tests')
    }),
  )
})

afterEach(async () => {
  await unmountHome()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('the AI dock', () => {
  beforeEach(async () => {
    await mountHome(baseApi())
  })

  it('mounts with the panel beside the content column, at the persisted width', () => {
    expect(dock()).not.toBeNull()
    expect(container.querySelector('.kb-ask')).not.toBeNull()
    expect(dock().style.width).toBe(`${AI_DOCK_WIDTH_DEFAULT}px`)
    // the mascot exists but stays hidden until the dock collapses
    expect(container.querySelector('.ai-mascot')).not.toBeNull()
    expect(dock().className).not.toContain('collapsed')
  })

  it('reads the width the prefs channel answers with', async () => {
    getAiDock.mockImplementation(async () => ({ width: 448, collapsed: false }))
    await unmountHome()
    await mountHome(baseApi())
    expect(dock().style.width).toBe('448px')
  })

  it('collapses to the mascot and expands back, persisting each state', async () => {
    await click(container.querySelector('.ai-dock-collapse'))
    expect(dock().className).toContain('collapsed')
    expect(setAiDock).toHaveBeenCalledWith({ collapsed: true })
    // the panel itself stays mounted — hidden, not unmounted
    expect(container.querySelector('.kb-ask')).not.toBeNull()
    await click(container.querySelector('.ai-mascot'))
    expect(dock().className).not.toContain('collapsed')
    expect(setAiDock).toHaveBeenCalledWith({ collapsed: false })
  })

  it('a drag on the handle commits the clamped width on release', async () => {
    const handle = container.querySelector<HTMLElement>('.ai-dock-resize')!
    expect(handle).toBeTruthy()
    await act(async () => {
      handle.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 900 }),
      )
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 840 }))
    })
    // live during the drag: the panel tracks the pointer before any commit
    expect(dock().style.width).toBe(`${clampDockWidth(AI_DOCK_WIDTH_DEFAULT + 60)}px`)
    expect(setAiDock).not.toHaveBeenCalled()
    await act(async () => {
      window.dispatchEvent(new MouseEvent('pointerup'))
    })
    expect(setAiDock).toHaveBeenCalledWith({ width: clampDockWidth(AI_DOCK_WIDTH_DEFAULT + 60) })
    expect(dock().style.width).toBe(`${clampDockWidth(AI_DOCK_WIDTH_DEFAULT + 60)}px`)
  })

  it('a drag past the rails clamps to the shared maximum; a press without a move commits nothing', async () => {
    const handle = container.querySelector<HTMLElement>('.ai-dock-resize')!
    // dragging the leading edge left grows the dock; a width past the shared
    // maximum is clamped to it
    await act(async () => {
      handle.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 900 }),
      )
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 200 }))
      window.dispatchEvent(new MouseEvent('pointerup'))
    })
    expect(setAiDock).toHaveBeenCalledWith({ width: AI_DOCK_WIDTH_MAX })
    expect(dock().style.width).toBe(`${AI_DOCK_WIDTH_MAX}px`)

    // a press that never moved is a click on the handle, not a resize
    await act(async () => {
      handle.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 900 }),
      )
      window.dispatchEvent(new MouseEvent('pointerup'))
    })
    expect(setAiDock).toHaveBeenCalledTimes(1)
  })

  it('a drag past the maximum commits at the clamp without waiting for a release', async () => {
    const handle = container.querySelector<HTMLElement>('.ai-dock-resize')!
    await act(async () => {
      handle.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 900 }),
      )
      // one move past the rail: the pointer is over the embedded document
      // view's native layer now, where neither further moves nor the release
      // ever reach this renderer — the gesture must have committed itself
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 100 }))
    })
    expect(setAiDock).toHaveBeenCalledWith({ width: AI_DOCK_WIDTH_MAX })
    expect(dock().style.width).toBe(`${AI_DOCK_WIDTH_MAX}px`)

    // the gesture is over: a release that does arrive re-commits nothing
    setAiDock.mockClear()
    await act(async () => {
      window.dispatchEvent(new MouseEvent('pointerup'))
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 600 }))
    })
    expect(setAiDock).not.toHaveBeenCalled()
  })

  it('a double-click on the handle resets the default width', async () => {
    getAiDock.mockImplementation(async () => ({ width: 552, collapsed: false }))
    await unmountHome()
    await mountHome(baseApi())
    expect(dock().style.width).toBe('552px')
    await act(async () => {
      container
        .querySelector<HTMLElement>('.ai-dock-resize')!
        .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(setAiDock).toHaveBeenCalledWith({ width: AI_DOCK_WIDTH_DEFAULT })
    expect(dock().style.width).toBe(`${AI_DOCK_WIDTH_DEFAULT}px`)
  })

  it('reports the content stage rect for the document views to fill', async () => {
    expect(homeContentRect).toHaveBeenCalledTimes(1)
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(homeContentRect).toHaveBeenCalledTimes(2)
  })
})

describe('the AI dock without the prefs channels', () => {
  it('degrades to the localStorage copy and remembers it across mounts', async () => {
    const api = baseApi()
    delete api.getAiDock
    delete api.setAiDock
    await mountHome(api)
    await click(container.querySelector('.ai-dock-collapse'))
    expect(dock().className).toContain('collapsed')
    expect(setAiDock).not.toHaveBeenCalled()
    expect(normalizeAiDockPrefs(JSON.parse(localStorage.getItem('home.aiDock') ?? 'null'))).toEqual(
      {
        width: AI_DOCK_WIDTH_DEFAULT,
        collapsed: true,
      },
    )
    await unmountHome()
    await mountHome(api)
    expect(dock().className).toContain('collapsed')
    expect(container.querySelector('.ai-mascot')).not.toBeNull()
  })
})

describe('the embedded tab strip', () => {
  beforeEach(async () => {
    await mountHome(baseApi())
  })

  it('renders the desktop item alone until a push arrives', () => {
    const items = [...container.querySelectorAll('.work-tab')].map((el) => el.className)
    expect(items).toEqual(['work-tab work-tab-desktop active'])
    expect(container.querySelector('.work-tab-close')).toBeNull()
  })

  it('renders the pushed tabs: titles, dirty dots, close buttons, detached dimmed', async () => {
    await act(async () =>
      pushTabs(
        't2',
        { id: 't1', kind: 'docs', title: 'brief.docx', active: false, dirty: true },
        { id: 't2', kind: 'sheets', title: 'budget.xlsx', active: true },
        { id: 'd9', kind: 'pdf', title: 'scan.pdf', detached: true },
      ),
    )
    const titles = [...container.querySelectorAll('.work-tab-title')].map((t) => t.textContent)
    expect(titles).toEqual(['Desktop', 'brief.docx', 'budget.xlsx', 'scan.pdf'])
    // the dirty dot rides the tab it belongs to
    expect(tabTitle('brief.docx')!.querySelector('.work-tab-dirty')).not.toBeNull()
    expect(tabTitle('budget.xlsx')!.querySelector('.work-tab-dirty')).toBeNull()
    // one close button per document tab, none on the desktop item
    expect(container.querySelectorAll('.work-tab-close')).toHaveLength(3)
    // the shell's active tab is the strip's active tab; the desktop item is not
    expect(tabTitle('budget.xlsx')!.closest('.work-tab')!.className).toContain('active')
    expect(container.querySelector('.work-tab-desktop')!.className).not.toContain('active')
    // a detached document stays listed, dimmed
    expect(tabTitle('scan.pdf')!.closest('.work-tab')!.className).toContain('detached')
  })

  it('a tab click activates through the contract; the × closes through it', async () => {
    await act(async () =>
      pushTabs('t2', { id: 't1', kind: 'docs', title: 'brief.docx', active: true }),
    )
    await click(tabTitle('brief.docx'))
    expect(tabsActivate).toHaveBeenCalledWith('t1')
    await click(container.querySelector('.work-tab-close'))
    expect(tabsClose).toHaveBeenCalledWith('t1')
  })

  it('the desktop item shows the desktop surface and raises the home tab', async () => {
    await act(async () => pushTabs('t1', { id: 't1', kind: 'docs', title: 'brief.docx' }))
    expect(container.querySelector('.desktop-surface')).toBeNull()
    await click(tabTitle('Desktop'))
    expect(tabsActivate).toHaveBeenCalledWith('home')
    expect(container.querySelector('.desktop-surface')).not.toBeNull()
    // the pushed state says a document is active again: the item yields
    await act(async () => pushTabs('t1', { id: 't1', kind: 'docs', title: 'brief.docx' }))
    expect(container.querySelector('.work-tab-desktop')!.className).not.toContain('active')
  })
})

describe('the strip without the push channel', () => {
  it('falls back to the tab strip bridge and skips the home entry', async () => {
    const api = baseApi()
    delete api.onTabsChanged
    const list = vi.fn(async () => [
      { id: 'home', kind: 'home', title: 'Home', closable: false, active: false },
      { id: 't1', kind: 'docs', title: 'brief.docx', closable: true, active: true },
    ])
    window.aiOfficeTabs = {
      list,
      onChanged: () => () => {},
      activate: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    } as unknown as Window['aiOfficeTabs']
    await mountHome(api)
    const titles = [...container.querySelectorAll('.work-tab-title')].map((t) => t.textContent)
    expect(titles).toEqual(['Desktop', 'brief.docx'])
    expect(container.querySelector('.work-tab-desktop')!.className).not.toContain('active')
    window.aiOfficeTabs = undefined as unknown as Window['aiOfficeTabs']
  })
})
