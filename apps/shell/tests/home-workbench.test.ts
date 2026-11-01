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
import type { AiDockPrefs, HomeApi, HomeTabEntry } from '../src/shared/home-api'
import type { RecentEntry } from '../src/shared/home-api'

/**
 * The workbench around Home's content column: the AI drawer (its open/closed
 * state, its persisted width, the floating pet's drag, threshold and persisted
 * position, the prefs' degraded localStorage copy while the app-settings
 * channels are absent, the document-mode hiding) and the embedded document tab
 * strip (the pushed contract's list, activate, close, and the fixed desktop
 * item). Everything the main process owns is a mock; the assertions are about
 * what Home does with the pushes and clicks.
 */

let root: Root
let container: HTMLDivElement
let tabsHandler: ((state: { tabs: HomeTabEntry[]; activeId: string }) => void) | null
const tabsActivate = vi.fn(async () => undefined)
const tabsClose = vi.fn(async () => undefined)
const getAiDock = vi.fn(async () => ({
  width: AI_DOCK_WIDTH_DEFAULT,
  collapsed: false,
  petPos: null,
}))
const setAiDock = vi.fn(async () => ({
  width: AI_DOCK_WIDTH_DEFAULT,
  collapsed: false,
  petPos: null,
}))
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

const drawer = (): HTMLElement => container.querySelector<HTMLElement>('.ai-drawer')!
const drawerPanel = (): HTMLElement => container.querySelector<HTMLElement>('.ai-drawer-panel')!
const pet = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>('.ai-pet')!

/** the pet's default perch in the test viewport (1024×768), nudged left of
 *  the open default drawer (400 + 16): the pet never hides under the drawer */
const OPEN_DRAWER_PET_X = 1024 - 68 - AI_DOCK_WIDTH_DEFAULT - 16

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
  getAiDock.mockImplementation(async () => ({
    width: AI_DOCK_WIDTH_DEFAULT,
    collapsed: false,
    petPos: null,
  }))
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

describe('the AI drawer', () => {
  beforeEach(async () => {
    await mountHome(baseApi())
  })

  it('mounts open over the content, at the persisted width, with the pet beside it', () => {
    expect(drawer()).not.toBeNull()
    expect(drawer().className).toContain('open')
    expect(container.querySelector('.kb-ask')).not.toBeNull()
    expect(drawerPanel().style.width).toBe(`${AI_DOCK_WIDTH_DEFAULT}px`)
    // the pet floats (fixed, out of the layout) and stays out of the drawer
    expect(pet()).not.toBeNull()
    expect(pet().style.left).toBe(`${OPEN_DRAWER_PET_X}px`)
    expect(pet().style.top).toBe('690px')
  })

  it('reads the width the prefs channel answers with', async () => {
    getAiDock.mockImplementation(async () => ({ width: 448, collapsed: false, petPos: null }))
    await unmountHome()
    await mountHome(baseApi())
    expect(drawerPanel().style.width).toBe('448px')
  })

  it('follows a dock change broadcast from another surface (the overlay pet)', async () => {
    // the main process broadcasts every settled `aiDock` write; the one that
    // matters here is the native overlay drawer's pet collapsing it while a
    // document is active — Home's copy must not stay stale behind the cover
    let dockHandler: ((prefs: AiDockPrefs) => void) | null = null
    await unmountHome()
    await mountHome({
      ...baseApi(),
      onAiDockChanged: (handler) => {
        dockHandler = handler
        return () => {
          dockHandler = null
        }
      },
    })
    expect(drawer().className).toContain('open')
    await act(async () =>
      dockHandler?.({ width: AI_DOCK_WIDTH_DEFAULT, collapsed: true, petPos: null }),
    )
    expect(drawer().className).not.toContain('open')
    // a broadcast is news, not a write: the store already holds this value
    expect(setAiDock).not.toHaveBeenCalled()
    await act(async () => dockHandler?.({ width: 448, collapsed: false, petPos: null }))
    expect(drawer().className).toContain('open')
    expect(drawerPanel().style.width).toBe('448px')
  })

  it('closes to the pet and opens back, persisting each state', async () => {
    await click(container.querySelector('.ai-drawer-collapse'))
    expect(drawer().className).not.toContain('open')
    expect(setAiDock).toHaveBeenCalledWith({ collapsed: true })
    // the panel itself stays mounted — hidden, not unmounted
    expect(container.querySelector('.kb-ask')).not.toBeNull()
    await click(pet())
    expect(drawer().className).toContain('open')
    expect(setAiDock).toHaveBeenCalledWith({ collapsed: false })
  })

  it('Esc, the scrim and the pet each retract the open drawer', async () => {
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(drawer().className).not.toContain('open')
    expect(setAiDock).toHaveBeenCalledWith({ collapsed: true })
    // back open, then the scrim retracts it too
    await click(pet())
    await click(container.querySelector('.ai-drawer-mask'))
    expect(drawer().className).not.toContain('open')
    expect(setAiDock).toHaveBeenLastCalledWith({ collapsed: true })
  })

  it('a drag on the handle commits the clamped width on release', async () => {
    const handle = container.querySelector<HTMLElement>('.ai-drawer-resize')!
    expect(handle).toBeTruthy()
    await act(async () => {
      handle.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 900 }),
      )
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 840 }))
    })
    // live during the drag: the panel tracks the pointer before any commit
    expect(drawerPanel().style.width).toBe(`${clampDockWidth(AI_DOCK_WIDTH_DEFAULT + 60)}px`)
    expect(setAiDock).not.toHaveBeenCalled()
    await act(async () => {
      window.dispatchEvent(new MouseEvent('pointerup'))
    })
    expect(setAiDock).toHaveBeenCalledWith({ width: clampDockWidth(AI_DOCK_WIDTH_DEFAULT + 60) })
    expect(drawerPanel().style.width).toBe(`${clampDockWidth(AI_DOCK_WIDTH_DEFAULT + 60)}px`)
  })

  it('a drag past the rails clamps to the shared maximum; a press without a move commits nothing', async () => {
    const handle = container.querySelector<HTMLElement>('.ai-drawer-resize')!
    // dragging the leading edge left grows the drawer; a width past the shared
    // maximum is clamped to it
    await act(async () => {
      handle.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 900 }),
      )
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 200 }))
      window.dispatchEvent(new MouseEvent('pointerup'))
    })
    expect(setAiDock).toHaveBeenCalledWith({ width: AI_DOCK_WIDTH_MAX })
    expect(drawerPanel().style.width).toBe(`${AI_DOCK_WIDTH_MAX}px`)

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
    const handle = container.querySelector<HTMLElement>('.ai-drawer-resize')!
    await act(async () => {
      handle.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 900 }),
      )
      // one move past the rail: the pointer may be over a native layer now,
      // where neither further moves nor the release ever reach this
      // renderer — the gesture must have committed itself
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 100 }))
    })
    expect(setAiDock).toHaveBeenCalledWith({ width: AI_DOCK_WIDTH_MAX })
    expect(drawerPanel().style.width).toBe(`${AI_DOCK_WIDTH_MAX}px`)

    // the gesture is over: a release that does arrive re-commits nothing
    setAiDock.mockClear()
    await act(async () => {
      window.dispatchEvent(new MouseEvent('pointerup'))
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 600 }))
    })
    expect(setAiDock).not.toHaveBeenCalled()
  })

  it('a double-click on the handle resets the default width', async () => {
    getAiDock.mockImplementation(async () => ({ width: 552, collapsed: false, petPos: null }))
    await unmountHome()
    await mountHome(baseApi())
    expect(drawerPanel().style.width).toBe('552px')
    await act(async () => {
      container
        .querySelector<HTMLElement>('.ai-drawer-resize')!
        .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(setAiDock).toHaveBeenCalledWith({ width: AI_DOCK_WIDTH_DEFAULT })
    expect(drawerPanel().style.width).toBe(`${AI_DOCK_WIDTH_DEFAULT}px`)
  })

  it('reports the content stage rect for the document views to fill', async () => {
    expect(homeContentRect).toHaveBeenCalledTimes(1)
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(homeContentRect).toHaveBeenCalledTimes(2)
  })

  it('stays hidden while a document tab is active; a recorded open shows when Home returns', async () => {
    // start closed, then let a document take the stage: the drawer's HTML is
    // under the document's native view, so it does not appear
    getAiDock.mockImplementation(async () => ({
      width: AI_DOCK_WIDTH_DEFAULT,
      collapsed: true,
      petPos: null,
    }))
    await unmountHome()
    await mountHome(baseApi())
    await act(async () => pushTabs('t1', { id: 't1', kind: 'docs', title: 'brief.docx' }))
    expect(drawer().className).toContain('doc-covered')
    // the panel stays mounted under the cover — its thread survives
    expect(container.querySelector('.kb-ask')).not.toBeNull()
    // an ask while the document is up (the sidebar's item) records the intent
    await click([...container.querySelectorAll<HTMLButtonElement>('.nav-item-ask')][0])
    expect(setAiDock).toHaveBeenCalledWith({ collapsed: false })
    expect(drawer().className).toContain('open')
    expect(drawer().className).toContain('doc-covered')
    // Home becomes the active tab again: the recorded drawer is there
    await act(async () => pushTabs('home'))
    expect(drawer().className).not.toContain('doc-covered')
    expect(drawer().className).toContain('open')
  })
})

describe('the floating pet', () => {
  beforeEach(async () => {
    await mountHome(baseApi())
  })

  it('parks at the persisted position on mount', async () => {
    getAiDock.mockImplementation(async () => ({
      width: AI_DOCK_WIDTH_DEFAULT,
      collapsed: false,
      petPos: { x: 120, y: 80 },
    }))
    await unmountHome()
    await mountHome(baseApi())
    expect(pet().style.left).toBe('120px')
    expect(pet().style.top).toBe('80px')
  })

  it('a drag past the slop commits the position on release, never mid-drag', async () => {
    await act(async () => {
      pet().dispatchEvent(
        new MouseEvent('pointerdown', {
          bubbles: true,
          button: 0,
          clientX: OPEN_DRAWER_PET_X,
          clientY: 690,
        }),
      )
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 440, clientY: 590 }))
    })
    // live during the drag: the pet tracks the pointer before any commit
    expect(pet().style.left).toBe('440px')
    expect(pet().style.top).toBe('590px')
    expect(setAiDock).not.toHaveBeenCalled()
    await act(async () => {
      window.dispatchEvent(new MouseEvent('pointerup'))
    })
    expect(setAiDock).toHaveBeenCalledWith({ petPos: { x: 440, y: 590 } })
    expect(pet().style.left).toBe('440px')
  })

  it('a drag at a 125% interface scale still tracks the cursor 1:1 on screen', async () => {
    // the same exposure the overlay pet's drag was reviewed for: petPos is
    // zoomed-chrome space (window = petPos × scale), so a pointer moving Δ
    // viewport px moves the stored position by Δ/scale — the pet's on-screen
    // position follows the cursor exactly while the number shrinks by the
    // scale. Live-probed against this Electron build: clientX is viewport
    // px and a chrome left/top renders at chrome × scale, so the division
    // is the correct direction — dropping it would overshoot by ×scale
    try {
      document.documentElement.style.setProperty('--ui-scale', '1.25')
      getAiDock.mockImplementation(async () => ({
        width: AI_DOCK_WIDTH_DEFAULT,
        collapsed: false,
        // clear of the open drawer's reserved right rail (maxX 335 chrome)
        petPos: { x: 120, y: 160 },
      }))
      await unmountHome()
      await mountHome(baseApi())
      // chrome 120,160 renders at viewport 150,200; grab 30,20 into the pet
      await act(async () => {
        pet().dispatchEvent(
          new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 180, clientY: 220 }),
        )
        // the pointer moves +250,+187.5 viewport px (a Δ of +200,+150 chrome)
        window.dispatchEvent(new MouseEvent('pointermove', { clientX: 430, clientY: 407.5 }))
      })
      // live position: chrome start + Δ/scale — the stored number, not the
      // viewport delta
      expect(pet().style.left).toBe('320px')
      expect(pet().style.top).toBe('310px')
      await act(async () => {
        window.dispatchEvent(new MouseEvent('pointerup'))
      })
      expect(setAiDock).toHaveBeenCalledWith({ petPos: { x: 320, y: 310 } })
      // and on screen the pet moved 320×1.25 − 120×1.25 = 250 viewport px —
      // exactly the cursor's travel
    } finally {
      document.documentElement.style.removeProperty('--ui-scale')
    }
  })

  it('a press under the slop is a click: it opens the drawer and persists no position', async () => {
    getAiDock.mockImplementation(async () => ({
      width: AI_DOCK_WIDTH_DEFAULT,
      collapsed: true,
      petPos: null,
    }))
    await unmountHome()
    await mountHome(baseApi())
    expect(drawer().className).not.toContain('open')
    await act(async () => {
      pet().dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 940, clientY: 690 }),
      )
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 943, clientY: 692 }))
      window.dispatchEvent(new MouseEvent('pointerup'))
    })
    // three viewport px of travel is still the press of a click, not a drag
    expect(setAiDock).not.toHaveBeenCalled()
    await click(pet())
    expect(drawer().className).toContain('open')
    expect(setAiDock).toHaveBeenCalledWith({ collapsed: false })
  })

  it('the trailing click of a real drag is swallowed; a keyboard press resets it', async () => {
    await act(async () => {
      pet().dispatchEvent(
        new MouseEvent('pointerdown', {
          bubbles: true,
          button: 0,
          clientX: OPEN_DRAWER_PET_X,
          clientY: 690,
        }),
      )
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 440, clientY: 590 }))
      window.dispatchEvent(new MouseEvent('pointerup'))
    })
    expect(setAiDock).toHaveBeenCalledWith({ petPos: { x: 440, y: 590 } })
    setAiDock.mockClear()
    // the click that follows the drag's release would toggle the drawer — the
    // gesture already ended in a move, so it is ignored
    await click(pet())
    expect(drawer().className).toContain('open')
    expect(setAiDock).not.toHaveBeenCalled()
    // keyboard activation arrives without pointer events and toggles again
    await act(async () => {
      pet().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await click(pet())
    expect(drawer().className).not.toContain('open')
    expect(setAiDock).toHaveBeenCalledWith({ collapsed: true })
  })

  it('clamps a drag inside the window, and out of the open drawer', async () => {
    // while the drawer is open the pet may not cross its leading edge
    await act(async () => {
      pet().dispatchEvent(
        new MouseEvent('pointerdown', {
          bubbles: true,
          button: 0,
          clientX: OPEN_DRAWER_PET_X,
          clientY: 690,
        }),
      )
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 2000, clientY: 2000 }))
      window.dispatchEvent(new MouseEvent('pointerup'))
    })
    expect(setAiDock).toHaveBeenCalledWith({ petPos: { x: OPEN_DRAWER_PET_X, y: 706 } })
    // close the drawer: the whole window is the pet's again, clamped inside
    await click(container.querySelector('.ai-drawer-collapse'))
    setAiDock.mockClear()
    await act(async () => {
      pet().dispatchEvent(
        new MouseEvent('pointerdown', {
          bubbles: true,
          button: 0,
          clientX: OPEN_DRAWER_PET_X,
          clientY: 706,
        }),
      )
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 2000, clientY: 2000 }))
      window.dispatchEvent(new MouseEvent('pointerup'))
    })
    expect(setAiDock).toHaveBeenCalledWith({ petPos: { x: 956, y: 706 } })
    expect(pet().style.left).toBe('956px')
  })

  it('a cancel (a pointercancel) rolls the drag back with no commit', async () => {
    await act(async () => {
      pet().dispatchEvent(
        new MouseEvent('pointerdown', {
          bubbles: true,
          button: 0,
          clientX: OPEN_DRAWER_PET_X,
          clientY: 690,
        }),
      )
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 440, clientY: 590 }))
    })
    await act(async () => {
      window.dispatchEvent(new MouseEvent('pointercancel'))
    })
    expect(setAiDock).not.toHaveBeenCalled()
    // back at the perch the drag started from
    expect(pet().style.left).toBe(`${OPEN_DRAWER_PET_X}px`)
  })
})

describe('the AI drawer without the prefs channels', () => {
  it('degrades to the localStorage copy and remembers it across mounts', async () => {
    const api = baseApi()
    delete api.getAiDock
    delete api.setAiDock
    await mountHome(api)
    await click(container.querySelector('.ai-drawer-collapse'))
    expect(drawer().className).not.toContain('open')
    expect(setAiDock).not.toHaveBeenCalled()
    expect(normalizeAiDockPrefs(JSON.parse(localStorage.getItem('home.aiDock') ?? 'null'))).toEqual(
      {
        width: AI_DOCK_WIDTH_DEFAULT,
        collapsed: true,
        petPos: null,
      },
    )
    await unmountHome()
    await mountHome(api)
    expect(drawer().className).not.toContain('open')
    expect(pet()).not.toBeNull()
  })

  it('remembers a dragged pet position across mounts through the same copy', async () => {
    const api = baseApi()
    delete api.getAiDock
    delete api.setAiDock
    await mountHome(api)
    await act(async () => {
      pet().dispatchEvent(
        new MouseEvent('pointerdown', {
          bubbles: true,
          button: 0,
          clientX: OPEN_DRAWER_PET_X,
          clientY: 690,
        }),
      )
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 300 }))
      window.dispatchEvent(new MouseEvent('pointerup'))
    })
    expect(
      normalizeAiDockPrefs(JSON.parse(localStorage.getItem('home.aiDock') ?? 'null')).petPos,
    ).toEqual({ x: 300, y: 300 })
    await unmountHome()
    await mountHome(api)
    expect(pet().style.left).toBe('300px')
    expect(pet().style.top).toBe('300px')
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
