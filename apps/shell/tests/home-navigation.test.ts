// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { defaultAiSettings } from '@genoffice/ai-provider'
import { Home, dockOpenViewOf } from '../src/renderer/src/Home'
import { DOCK_AUTOHIDE_DELAY_MS } from '../src/renderer/src/dock-math'
import { normalizeDockPrefs } from '../src/shared/dock-prefs'
import { LocaleProvider } from '../src/renderer/src/locale'
import type { HomeTabEntry, RecentEntry } from '../src/shared/home-api'

/**
 * The Home surface's navigation contract (src/renderer/src/Home.tsx): the
 * dock's nav items switch the surface the content stage shows, the Ask AI
 * item opens the drawer instead, and — the doc-mode half — while a document
 * tab's native view covers the stage every view-switching dock click must
 * also raise the home tab (raiseHomeTab), or it flips state underneath the
 * covering document where nobody can see it.
 */

let root: Root
let container: HTMLDivElement
/** the live onTabsChanged subscription, for pushing a doc-tab-active state */
let tabsHandler: ((state: { tabs: HomeTabEntry[]; activeId: string }) => void) | null = null
const tabsActivate = vi.fn(async () => undefined)
const files: RecentEntry[] = [
  {
    path: '/fixtures/brief.docx',
    name: 'brief.docx',
    ext: 'docx',
    mtimeMs: 1,
    sizeBytes: 10,
    starred: true,
  },
  {
    path: '/fixtures/budget.xlsx',
    name: 'budget.xlsx',
    ext: 'xlsx',
    mtimeMs: 2,
    sizeBytes: 20,
    starred: false,
  },
]
const page = (starred: boolean) =>
  vi.fn(async (query: { ext?: string; limit?: number }) => {
    const entries = files.filter(
      (file) => (!starred || file.starred) && (!query.ext || file.ext === query.ext),
    )
    return {
      entries: query.limit === 0 ? [] : entries,
      total: entries.length,
      totalAll: entries.length,
      offset: 0,
    }
  })

beforeEach(async () => {
  HTMLElement.prototype.scrollTo = vi.fn()
  // this suite exercises the list views: land on Recent instead of the desktop
  localStorage.clear()
  localStorage.setItem('home.view', 'recent')
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('No network in navigation tests')
    }),
  )
  tabsHandler = null
  tabsActivate.mockClear()
  window.aiOffice = {
    folderRoots: async () => [],
    onFolderChanged: () => () => {},
    recents: page(false),
    starred: page(true),
    starredGroups: async () => [],
    accountStatus: async () => ({ loggedIn: false }),
    onOpenSettings: () => () => {},
    onAccountLogin: () => () => {},
    kbList: async () => [],
    aiGetSettings: async () => defaultAiSettings(),
    aiGskStatus: async () => ({ loggedIn: false }),
    onAiSettingsChanged: () => () => {},
    onTabsChanged: (handler: (state: { tabs: HomeTabEntry[]; activeId: string }) => void) => {
      tabsHandler = handler
      return () => {
        tabsHandler = null
      }
    },
    tabsActivate,
  } as unknown as Window['aiOffice']
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root.render(createElement(LocaleProvider, { initial: 'en', children: createElement(Home) })),
  )
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
/** the dock item carrying this label — the nav items migrated there */
function nav(label: string): HTMLButtonElement {
  return [...container.querySelectorAll<HTMLButtonElement>('.dock-item')].find(
    (button) => button.getAttribute('aria-label') === label,
  )!
}
async function click(button: HTMLButtonElement) {
  expect(button).toBeTruthy()
  await act(async () => button.click())
}
function selected(): string[] {
  return [...container.querySelectorAll('.dock-item[aria-current="true"]')].map((item) =>
    (item as HTMLElement).getAttribute('aria-label')!,
  )
}

describe('Home dock navigation', () => {
  it.each(['Recent', 'Starred'])('Ask AI opens the drawer without leaving %s', async (from) => {
    await click(nav(from))
    expect(selected()).toEqual([from])
    await click(nav('Ask AI'))
    // the ask panel is the workbench's drawer, not a surface: the list stays
    // selected, the panel is present from launch, and the composer focused
    expect(container.querySelector('.ai-drawer')!.className).toContain('open')
    expect(container.querySelector('.kb-ask')).not.toBeNull()
    expect(selected()).toEqual([from])
    expect(document.activeElement).toBe(container.querySelector('.kb-ask textarea'))
    expect(nav('Ask AI').hasAttribute('aria-current')).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
    await click(nav(from))
    expect(selected()).toEqual([from])
    expect(nav(from).getAttribute('aria-current')).toBe('true')
    expect(container.querySelector('.content')?.textContent).toContain('brief.docx')
    if (from === 'Starred')
      expect(container.querySelector('.content')?.textContent).not.toContain('budget.xlsx')
  })

  it('keeps the file-type filter across an Ask AI focus', async () => {
    const docs = [...container.querySelectorAll<HTMLButtonElement>('.filter-pill')].find(
      (button) => button.textContent === 'Docs',
    )!
    await click(docs)
    expect(container.querySelector('.content')?.textContent).toContain('brief.docx')
    expect(container.querySelector('.content')?.textContent).not.toContain('budget.xlsx')
    await click(nav('Ask AI'))
    // no view switch happened, so the list never re-queried either
    await click(nav('Recent'))
    expect(container.querySelector('.filter-pill.active')?.textContent).toBe('Docs')
    expect(container.querySelector('.content')?.textContent).toContain('brief.docx')
    expect(container.querySelector('.content')?.textContent).not.toContain('budget.xlsx')
    expect(window.aiOffice.recents).toHaveBeenLastCalledWith(
      expect.objectContaining({ ext: 'docx' }),
    )
  })

  it("the folders-scope ask panel's CTA opens settings on the General pane", async () => {
    // the panel reads the scope through the bridge on mount; the drawer mounts
    // with Home, so the bridge carries the folders scope before the render
    const bridge = window.aiOffice as unknown as Record<string, unknown>
    bridge.getKbScope = async () => 'folders'
    bridge.setKbScope = async () => 'folders'
    bridge.aiGskStatus = async () => ({ loggedIn: true })
    await act(async () => root.unmount())
    container.remove()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () =>
      root.render(createElement(LocaleProvider, { initial: 'en', children: createElement(Home) })),
    )
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    const cta = container.querySelector<HTMLButtonElement>('.kb-ask-cta')!
    expect(cta).toBeTruthy()
    expect(cta.textContent).toBe('Pick folders in Settings')
    await click(cta)
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    // the settings modal opened on the pane that holds the scope group, not
    // the account default or the AI panes
    const active = container.querySelector('.set-nav-item.active')
    expect(active?.textContent).toContain('General')
    expect(container.querySelector('[aria-label="Ask AI corpus scope"]')).not.toBeNull()
  })
})

describe('the dock reveals Home under a covering document tab', () => {
  /** a docs tab active over the Home surface, the way the main process pushes it */
  async function pushDocTab(): Promise<void> {
    await act(async () =>
      tabsHandler?.({
        tabs: [
          {
            id: 'home',
            kind: 'home',
            title: 'Home',
            active: false,
            dirty: false,
            detached: false,
          },
          {
            id: 't1',
            kind: 'docs',
            title: 'brief.docx',
            active: true,
            dirty: false,
            detached: false,
          },
        ],
        activeId: 't1',
      }),
    )
    await act(async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve()
    })
  }

  it.each(['Desktop', 'Recent', 'Starred'])(
    '%s raises the home tab when a document covers the surface',
    async (label) => {
      // the bug this closes: the dock is the one Home region a covering
      // document view leaves clickable (its native overlay), so its view
      // switches must raise the home tab or they flip state underneath the
      // document — the person sees nothing change and calls the dock blocked
      await pushDocTab()
      tabsActivate.mockClear()
      await click(nav(label))
      expect(tabsActivate).toHaveBeenCalledTimes(1)
      expect(tabsActivate).toHaveBeenCalledWith('home')
      // the switch still happened underneath, ready for the raised tab
      if (label === 'Desktop') {
        expect(container.querySelector('.home')!.className).toContain('desktop-mode')
      } else {
        expect(selected()).toEqual([label])
      }
    },
  )

  it('Ask AI keeps routing to the drawer, never raising the tab', async () => {
    // the drawer overlays documents through the native overlay (the pet's
    // drawer), so the ask item has no surface to reveal — leave the tab be
    await pushDocTab()
    await click(nav('Ask AI'))
    expect(tabsActivate).not.toHaveBeenCalled()
    expect(container.querySelector('.ai-drawer')!.className).toContain('open')
  })

  it('no redundant raise while Home already is the active tab', async () => {
    // nothing pushed: Home is the active tab, and the click is a plain view
    // switch — the reveal verb no-ops instead of re-activating the tab the
    // person is already on
    await click(nav('Starred'))
    expect(selected()).toEqual(['Starred'])
    expect(tabsActivate).not.toHaveBeenCalled()
  })
})

describe('the sidebar is gone: the desktop and the dock are the whole chrome', () => {
  it('renders no sidebar at all, and the dock carries the full launcher set', async () => {
    // not signed in: the cloud launcher is absent (the login gate), and the
    // retired column left nothing behind — no rail, no logo band, no glass
    expect(container.querySelector('.sidebar')).toBeNull()
    expect(container.querySelector('.sidebar-glass')).toBeNull()
    expect(container.querySelector('.sidebar-logo')).toBeNull()
    expect(container.querySelector('.todo-panel')).toBeNull()
    expect(localStorage.getItem('home.sidebar')).toBeNull()
    // the dock holds the migrated set
    expect(
      [...container.querySelectorAll('.dock-item')].map((i) => i.getAttribute('aria-label')),
    ).toEqual(['Desktop', 'Recent', 'Starred', 'Settings', 'Templates', 'Plugins', 'Ask AI'])
  })

  it('the desktop carries the todo card (and the list views do not)', async () => {
    // the quick-capture card is desktop furniture now — macOS widgets live
    // on the desktop, not in a chrome column
    expect(container.querySelector('.desktop-todo')).toBeNull()
    const desktop = [...container.querySelectorAll<HTMLButtonElement>('.dock-item')].find(
      (b) => b.getAttribute('aria-label') === 'Desktop',
    )
    await click(desktop)
    expect(container.querySelector('.desktop-todo .todo-panel')).toBeTruthy()
    expect(container.querySelector('.desktop-todo .todo-input')).toBeTruthy()
  })
})

describe('the doc-mode dock nav (home:dock-nav)', () => {
  let dockNavHandler:
    | ((intent: {
        kind: 'nav' | 'settings' | 'templates'
        view?: 'desktop' | 'recent' | 'starred'
        section?: 'general' | 'plugins'
      }) => void)
    | null = null

  /**
   * Mount with a stubbed mount-time pull (the cold-boot race: a routed click
   * can beat the subscription, and main answers the buffered intent here);
   * omitted means an empty buffer.
   */
  async function mountWithDockNav(
    pull:
      | (() => Promise<{
          kind: 'nav' | 'settings' | 'templates'
          view?: 'desktop' | 'recent' | 'starred'
          section?: 'general' | 'plugins'
        } | null>)
      | null = null,
  ): Promise<void> {
    const dockNavPull = pull ?? (async () => null)
    window.aiOffice = {
      ...window.aiOffice,
      onDockNav: (
        handler: (intent: {
          kind: 'nav' | 'settings' | 'templates'
          view?: 'desktop' | 'recent' | 'starred'
          section?: 'general' | 'plugins'
        }) => void,
      ) => {
        dockNavHandler = handler
        return () => {
          dockNavHandler = null
        }
      },
      takeDockNavPending: () => dockNavPull(),
      templatesList: async () => [
        {
          id: 't1',
          title: 'Weekly report',
          description: 'A clean start',
          kind: 'docx',
          category: 'business',
        },
      ],
    } as unknown as Window['aiOffice']
    await act(async () => root.unmount())
    container.remove()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () =>
      root.render(createElement(LocaleProvider, { initial: 'en', children: createElement(Home) })),
    )
    expect(dockNavHandler).not.toBeNull()
  }

  it('a nav intent switches the surface, ready for the tab rise', async () => {
    await mountWithDockNav()
    await click(nav('Desktop'))
    await act(async () => dockNavHandler!({ kind: 'nav', view: 'recent' }))
    expect(container.querySelector('.home')!.className).not.toContain('desktop-mode')
    expect(selected()).toEqual(['Recent'])
    await act(async () => dockNavHandler!({ kind: 'nav', view: 'starred' }))
    expect(selected()).toEqual(['Starred'])
    await act(async () => dockNavHandler!({ kind: 'nav', view: 'desktop' }))
    expect(container.querySelector('.home')!.className).toContain('desktop-mode')
    // no tab churn of its own: the activation is main's half of the contract
    expect(tabsActivate).not.toHaveBeenCalled()
  })

  it('a settings intent opens the settings modal on the named section', async () => {
    await mountWithDockNav()
    await act(async () => dockNavHandler!({ kind: 'settings', section: 'plugins' }))
    const active = container.querySelector('.set-nav-item.active')
    expect(active?.textContent).toContain('Plugins')
    await act(async () => dockNavHandler!({ kind: 'settings', section: 'general' }))
    expect(container.querySelector('.set-nav-item.active')?.textContent).toContain('General')
  })

  it('a templates intent opens the template gallery', async () => {
    await mountWithDockNav()
    await act(async () => dockNavHandler!({ kind: 'templates' }))
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    expect(container.querySelector('.tg-card')).toBeTruthy()
    expect(container.querySelector('.tg-card-title')?.textContent).toBe('Weekly report')
  })

  it('pulls a cold-boot intent that beat the subscription', async () => {
    // main buffered the click while this renderer was still loading — the
    // push was lost, and the mount's pull performs it anyway
    await mountWithDockNav(async () => ({ kind: 'nav', view: 'starred' }))
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    expect(selected()).toEqual(['Starred'])
    expect(container.querySelector('.home')!.className).not.toContain('desktop-mode')
  })

  it('arms the subscription before the pull resolves, so nothing in between is lost', async () => {
    let resolvePull!: (
      intent: {
        kind: 'nav' | 'settings' | 'templates'
        view?: 'desktop' | 'recent' | 'starred'
        section?: 'general' | 'plugins'
      } | null,
    ) => void
    const pull = new Promise<{
      kind: 'nav' | 'settings' | 'templates'
      view?: 'desktop' | 'recent' | 'starred'
      section?: 'general' | 'plugins'
    } | null>((resolve) => {
      resolvePull = resolve
    })
    await mountWithDockNav(() => pull)
    // the pull is still pending, the subscription is already armed: a push
    // landing in the gap is heard the ordinary way
    expect(dockNavHandler).not.toBeNull()
    await act(async () => dockNavHandler!({ kind: 'nav', view: 'starred' }))
    expect(selected()).toEqual(['Starred'])
    // and the pull draining the same intent afterwards is idempotent — the
    // worst case of the subscribe-then-pull order is one intent performed
    // twice, never one lost
    resolvePull({ kind: 'nav', view: 'starred' })
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    expect(selected()).toEqual(['Starred'])
  })
})

describe('the dock prefs surface (设置 ▸ 程序坞) and the open-target report', () => {
  /** the prefs the next mount reads; live pushes land through the handlers */
  let dockPrefsValue: Record<string, unknown> = {}
  const dockPrefsHandlers: Array<(prefs: Record<string, unknown>) => void> = []
  const setDockPrefs = vi.fn(async () => undefined)
  const reports: unknown[] = []

  /** remount Home with the dock channels on the face */
  async function mountWithDockFace(): Promise<void> {
    dockPrefsValue = { ...(dockPrefsValue as object) }
    dockPrefsHandlers.length = 0
    window.aiOffice = {
      ...window.aiOffice,
      getDockPrefs: async () => normalizeDockPrefs(dockPrefsValue),
      setDockPrefs,
      onDockPrefsChanged: (handler: (prefs: Record<string, unknown>) => void) => {
        dockPrefsHandlers.push(handler)
        return () => {
          const index = dockPrefsHandlers.indexOf(handler)
          if (index >= 0) dockPrefsHandlers.splice(index, 1)
        }
      },
      reportDockOpen: (state: unknown) => {
        reports.push(state)
      },
    } as unknown as Window['aiOffice']
    await act(async () => root.unmount())
    container.remove()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () =>
      root.render(createElement(LocaleProvider, { initial: 'en', children: createElement(Home) })),
    )
  }

  /** React derives enter/leave from over/out: dispatch those */
  const hover = (el: Element, type: 'pointerover' | 'pointerout'): void => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, relatedTarget: null }))
  }

  it('the prefs shape the pill: the base size, the static switch, the order', async () => {
    dockPrefsValue = {
      baseSize: 64,
      magnify: false,
      order: ['dock:starred', 'dock:recent', 'dock:desktop'],
    }
    await mountWithDockFace()
    const dock = container.querySelector<HTMLElement>('.dock')!
    expect(dock.style.getPropertyValue('--dock-base')).toBe('64px')
    // magnify off: the fisheye never magnifies
    hover(dock, 'pointerover')
    dock.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 200 }))
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    const widths = [...dock.querySelectorAll<HTMLElement>('.dock-slot')].map(
      (slot) => slot.style.width,
    )
    expect(widths.every((width) => width === '')).toBe(true)
    // the persisted order applies within the nav group
    const ids = [...dock.querySelectorAll<HTMLElement>('.dock-slot')].map(
      (slot) => slot.dataset.itemId,
    )
    expect(ids.slice(0, 3)).toEqual(['dock:starred', 'dock:recent', 'dock:desktop'])
  })

  it('auto-hide: the pill rests below the edge, the hot zone summons it, the leave re-hides', async () => {
    vi.useFakeTimers()
    try {
      dockPrefsValue = { autoHide: true }
      await mountWithDockFace()
      const dock = container.querySelector<HTMLElement>('.dock')!
      const zone = container.querySelector<HTMLElement>('.dock-hot-zone')!
      expect(zone).toBeTruthy()
      // the pref landed: the pill is hidden until summoned
      expect(dock.classList.contains('dock-hidden')).toBe(true)
      // the stage's bottom edge summons it
      await act(async () => hover(zone, 'pointerover'))
      expect(dock.classList.contains('dock-hidden')).toBe(false)
      // the pointer leaving the pill arms the short grace; the pill hides
      // when it fires, and stays up during the grace
      hover(dock, 'pointerover')
      await act(async () => hover(dock, 'pointerout'))
      expect(dock.classList.contains('dock-hidden')).toBe(false)
      await act(async () => {
        vi.advanceTimersByTime(DOCK_AUTOHIDE_DELAY_MS)
      })
      expect(dock.classList.contains('dock-hidden')).toBe(true)
      // and the zone brings it back once more
      await act(async () => hover(zone, 'pointerover'))
      expect(dock.classList.contains('dock-hidden')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('auto-hide off mounts no hot zone and keeps the pill up', async () => {
    dockPrefsValue = { autoHide: false }
    await mountWithDockFace()
    expect(container.querySelector('.dock-hot-zone')).toBeNull()
    expect(container.querySelector('.dock')!.classList.contains('dock-hidden')).toBe(false)
  })

  it('Home reports the open targets, and the settings modal flips the report', async () => {
    localStorage.setItem('home.aiDock', JSON.stringify({ width: 400, collapsed: true }))
    reports.length = 0
    await mountWithDockFace()
    // the mounted truth: Recent showing (the suite lands there), drawer
    // collapsed, nothing open
    expect(reports.at(-1)).toEqual({
      view: 'recent',
      settings: false,
      plugins: false,
      templates: false,
      ask: false,
      loggedIn: false,
    })
    // opening the settings modal (the dock's own launcher) flips the report,
    // and the plugins SECTION is the pane it opened on
    await act(async () => nav('Settings').click())
    expect(reports.at(-1)).toMatchObject({ settings: true, plugins: false })
    await act(async () => nav('Plugins').click())
    expect(reports.at(-1)).toMatchObject({ settings: true, plugins: true })
  })

  it('a store push re-shapes the mounted pill (the watcher broadcast)', async () => {
    await mountWithDockFace()
    const dock = container.querySelector<HTMLElement>('.dock')!
    expect(dock.style.getPropertyValue('--dock-base')).toBe('48px')
    await act(async () => {
      for (const handler of [...dockPrefsHandlers]) {
        handler(normalizeDockPrefs({ baseSize: 56, order: ['dock:recent', 'dock:desktop'] }))
      }
    })
    expect(dock.style.getPropertyValue('--dock-base')).toBe('56px')
    const ids = [...dock.querySelectorAll<HTMLElement>('.dock-slot')].map(
      (slot) => slot.dataset.itemId,
    )
    expect(ids.slice(0, 2)).toEqual(['dock:recent', 'dock:desktop'])
  })
})

describe('the dock surface fixes (gallery refetch, auto-hide pin, zone click)', () => {
  const templatesList = vi.fn(async () => [])

  /** remount Home with the dock channels and a counting gallery bridge */
  async function mountWithDockFace(prefs: Record<string, unknown> = {}): Promise<void> {
    templatesList.mockClear()
    window.aiOffice = {
      ...window.aiOffice,
      templatesList,
      getDockPrefs: async () => normalizeDockPrefs(prefs),
      onDockPrefsChanged: () => () => undefined,
      reportDockOpen: () => undefined,
    } as unknown as Window['aiOffice']
    await act(async () => root.unmount())
    container.remove()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () =>
      root.render(createElement(LocaleProvider, { initial: 'en', children: createElement(Home) })),
    )
  }

  /** React derives enter/leave from over/out: dispatch those */
  const hover = (el: Element, type: 'pointerover' | 'pointerout'): void => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, relatedTarget: null }))
  }

  it('a parent re-render never refetches the template gallery list', async () => {
    await mountWithDockFace()
    await act(async () => nav('Templates').click())
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    expect(templatesList).toHaveBeenCalledTimes(1)
    // the bounce settled (the gallery answered) — now force Home to
    // re-render (a tabs push) and the list must not flash back to loading
    await act(async () => {
      tabsHandler?.({
        tabs: [
          { id: 't1', kind: 'docs', title: 'a.docx', active: false, dirty: false, detached: false },
        ],
        activeId: 'home',
      })
    })
    await act(async () => {
      tabsHandler?.({
        tabs: [
          { id: 't1', kind: 'docs', title: 'a.docx', active: true, dirty: false, detached: false },
        ],
        activeId: 't1',
      })
    })
    expect(templatesList).toHaveBeenCalledTimes(1)
    // and a bounce settled long ago: no tile still bounces
    expect(container.querySelector('.dock-bouncing')).toBeNull()
  })

  it('an already-open gallery does not bounce: the click brings it forward', async () => {
    await mountWithDockFace()
    await act(async () => nav('Templates').click())
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    // the gallery is open; clicking again is a bring-forward
    await act(async () => nav('Templates').click())
    expect(container.querySelector('.dock-bouncing')).toBeNull()
  })

  it('the auto-hide pin: an open menu holds the pill up through a pill leave', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await mountWithDockFace({ autoHide: true })
      const dock = container.querySelector<HTMLElement>('.dock')!
      const zone = container.querySelector<HTMLElement>('.dock-hot-zone')!
      expect(dock.classList.contains('dock-hidden')).toBe(true)
      // summon, then open the settings item's menu (its rect anchors it)
      await act(async () => hover(zone, 'pointerover'))
      expect(dock.classList.contains('dock-hidden')).toBe(false)
      await act(async () => {
        nav('Settings').dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 120,
            clientY: 560,
          }),
        )
      })
      expect(document.body.querySelector('.dock-menu')).toBeTruthy()
      // the pointer leaves the pill for the menu above it: the dock stays
      hover(dock, 'pointerover')
      await act(async () => hover(dock, 'pointerout'))
      await act(async () => {
        vi.advanceTimersByTime(DOCK_AUTOHIDE_DELAY_MS * 2)
      })
      expect(dock.classList.contains('dock-hidden')).toBe(false)
      // the menu closes with the pointer gone: the grace hides the pill
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      })
      await act(async () => {
        vi.advanceTimersByTime(DOCK_AUTOHIDE_DELAY_MS)
      })
      expect(dock.classList.contains('dock-hidden')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a click on the hot zone summons the dock (the click is not eaten)', async () => {
    await mountWithDockFace({ autoHide: true })
    const dock = container.querySelector<HTMLElement>('.dock')!
    const zone = container.querySelector<HTMLElement>('.dock-hot-zone')!
    expect(dock.classList.contains('dock-hidden')).toBe(true)
    await act(async () => zone.click())
    expect(dock.classList.contains('dock-hidden')).toBe(false)
  })
})

describe('the cloud launcher on the Home dock', () => {
  const DESKTOP = (): HTMLButtonElement =>
    [...container.querySelectorAll<HTMLButtonElement>('.dock-item')].find(
      (b) => b.getAttribute('aria-label') === 'Genspark Projects',
    )!

  it('is gated by the login state: absent signed out, present signed in', async () => {
    await act(async () => root.unmount())
    container.remove()
    window.aiOffice = {
      ...window.aiOffice,
      accountStatus: async () => ({ loggedIn: false }),
    } as unknown as Window['aiOffice']
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () =>
      root.render(createElement(LocaleProvider, { initial: 'en', children: createElement(Home) })),
    )
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    expect(container.querySelectorAll('.dock-item')).toHaveLength(7)
    // signed in: the eighth launcher joins, and the switch shows the view
    const status = {
      ...window.aiOffice,
      accountStatus: async () => ({ loggedIn: true }),
    } as unknown as Window['aiOffice']
    await act(async () => root.unmount())
    container.remove()
    window.aiOffice = status
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () =>
      root.render(createElement(LocaleProvider, { initial: 'en', children: createElement(Home) })),
    )
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    expect(container.querySelectorAll('.dock-item')).toHaveLength(8)
    await act(async () => DESKTOP().click())
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    // the cloud surface took over the stage: its sync/cache bridge answers
    // and the view renders its body (the error card here — no network)
    expect(container.querySelector('.cloud-rows, .proj-empty, .load-more')).toBeTruthy()
  })
})

describe('dockOpenViewOf (the report view derivation)', () => {
  it('names the showing surface, null while a document covers Home', () => {
    const view = dockOpenViewOf
    // the list views and the desktop name themselves
    expect(view('recent', false)).toBe('recent')
    expect(view('starred', false)).toBe('starred')
    expect(view('desktop', false)).toBe('desktop')
    expect(view('cloud', false)).toBe('cloud')
    // covered: whatever Home shows, the overlay's dots read null
    expect(view('recent', true)).toBeNull()
    expect(view('cloud', true)).toBeNull()
    // no surface: null
    expect(view(null, false)).toBeNull()
  })
})
