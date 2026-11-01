// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { defaultAiSettings } from '@genoffice/ai-provider'
import { Home } from '../src/renderer/src/Home'
import { LocaleProvider } from '../src/renderer/src/locale'
import type { HomeTabEntry, RecentEntry } from '../src/shared/home-api'

/**
 * The Home sidebar's navigation contract (src/renderer/src/Home.tsx): the nav
 * items and the folder tree switch the surface the content stage shows, the
 * Ask AI item opens the drawer instead, and — the doc-mode half — while a
 * document tab's native view covers the stage every view-switching sidebar
 * click must also raise the home tab (raiseHomeTab), or it flips state
 * underneath the covering document where nobody can see it.
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
function nav(label: string): HTMLButtonElement {
  return [...container.querySelectorAll<HTMLButtonElement>('.sidebar-nav button')].find(
    (button) => button.querySelector('.nav-label')?.textContent === label,
  )!
}
async function click(button: HTMLButtonElement) {
  expect(button).toBeTruthy()
  await act(async () => button.click())
}
function selected(): string[] {
  return [...container.querySelectorAll('.sidebar-nav .active .nav-label')].map(
    (label) => label.textContent!,
  )
}

describe('Home sidebar navigation', () => {
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
    expect(nav(from).getAttribute('aria-current')).toBe('page')
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

describe('the sidebar reveals Home under a covering document tab', () => {
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
      // the bug this closes: the sidebar is the one Home region a covering
      // document view leaves clickable, so its view switches must raise the
      // home tab or they flip state underneath the document — the person
      // sees nothing change and calls the left panel blocked
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
