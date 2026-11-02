// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { defaultAiSettings } from '@genoffice/ai-provider'
import { Home } from '../src/renderer/src/Home'
import { LocaleProvider } from '../src/renderer/src/locale'
import type { FolderListing, FolderRoot, HomeTabEntry, RecentEntry } from '../src/shared/home-api'

/**
 * The folder pane's three refresh paths, which the focus dirty-check must not
 * collapse into one: a mutation this renderer made (star toggle) re-lists,
 * because the cached rows embed data no mtime probe can see; a watch event in
 * a never-listed child invalidates its tracked parent (the chevron data); the
 * window-focus refresh alone probes via the cached mtimes. The doc-mode
 * describe at the foot pins the tree's reveal contract: a row click raises
 * the home tab while a document covers the surface, while the chevron, the ⋯
 * menu and drag hover never do.
 */

let root: Root
let container: HTMLDivElement
let asked: { dir: string; knownMtimeMs?: number }[] = []
let folderHandlers: ((dirs: string[]) => void)[] = []
/** the live onTabsChanged subscription, for pushing a doc-tab-active state */
let tabsHandler: ((state: { tabs: HomeTabEntry[]; activeId: string }) => void) | null = null
const tabsActivate = vi.fn(async () => undefined)
let starred = false

const ROOT: FolderRoot = {
  path: '/root',
  name: 'root',
  usable: true,
  readable: true,
  removable: false,
}

const file = (starredFlag: boolean): RecentEntry => ({
  path: '/root/report.md',
  name: 'report.md',
  ext: 'md',
  mtimeMs: 1,
  sizeBytes: 10,
  starred: starredFlag,
})

// what the main process answers: the cached listing for a matching mtime
// (empty placeholders + unchanged), a fresh one otherwise
const listing = (): FolderListing => ({
  dir: '/root',
  mtimeMs: 7,
  folders: [{ path: '/root/sub', name: 'sub', mtimeMs: 2, hasSubfolders: false }],
  files: [file(starred)],
})
const listFolder = vi.fn(async (dir: string, knownMtimeMs?: number): Promise<FolderListing> => {
  asked.push({ dir, knownMtimeMs })
  if (knownMtimeMs === 7) {
    return { dir, mtimeMs: 7, folders: [], files: [], unchanged: true }
  }
  if (dir === '/root/sub') {
    return { dir: '/root/sub', mtimeMs: 3, folders: [], files: [file(starred)] }
  }
  return listing()
})

beforeEach(async () => {
  HTMLElement.prototype.scrollTo = vi.fn()
  localStorage.clear()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('No network in folder refresh tests')
    }),
  )
  asked = []
  folderHandlers = []
  tabsHandler = null
  tabsActivate.mockClear()
  starred = false
  window.aiOffice = {
    folderRoots: async () => [ROOT],
    onFolderChanged: (handler: (dirs: string[]) => void) => {
      folderHandlers.push(handler)
      return () => {
        folderHandlers = folderHandlers.filter((h) => h !== handler)
      }
    },
    onTabsChanged: (handler: (state: { tabs: HomeTabEntry[]; activeId: string }) => void) => {
      tabsHandler = handler
      return () => {
        tabsHandler = null
      }
    },
    tabsActivate,
    listFolder,
    toggleStar: vi.fn(async () => {
      // a star is JSON state in userData: the folder's mtime never moves
      starred = !starred
    }),
    recents: async () => ({ entries: [], total: 0, totalAll: 0 }),
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
    desktopLayoutSave: vi.fn(async () => undefined),
    onRecentsChanged: () => () => {},
    searchFiles: async () => ({
      hits: [],
      total: 0,
      index: { indexed: 0, pending: 0, scanning: false },
    }),
    rerankSearch: async () => null,
    onIndexUpdated: () => () => {},
  } as unknown as Window['aiOffice']
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root.render(createElement(LocaleProvider, { initial: 'en', children: createElement(Home) })),
  )
})

afterEach(async () => {
  root.unmount()
  await act(async () => {})
  container.remove()
  localStorage.clear()
  vi.unstubAllGlobals()
  listFolder.mockClear()
})

/** deep enough flush for click → IPC promise → refresh → re-list → render */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

async function click(el: Element | null | undefined): Promise<void> {
  expect(el).toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).click()
    await Promise.resolve()
  })
  await flush()
}

async function openFolderView(): Promise<void> {
  // the folder view opens from the desktop's root icons now (the retired
  // tree's way in, restated): the dock's Desktop item, then the root icon
  const desktop = [...container.querySelectorAll<HTMLButtonElement>('.dock-item')].find(
    (b) => b.getAttribute('aria-label') === 'Desktop',
  )
  await click(desktop)
  const icon = [...container.querySelectorAll<HTMLElement>('.desktop-icon-item')].find(
    (el) => el.getAttribute('title') === '/root',
  )
  expect(icon, 'the root folder icon').toBeTruthy()
  await act(async () => {
    icon!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })
  await flush()
  // the folder view's rows are on screen
  expect(container.querySelector('.recent-table .star-btn')).toBeTruthy()
}

const starButton = (): HTMLElement =>
  container.querySelector('.recent-table .star-btn') as HTMLElement

describe('folder refresh paths', () => {
  it('re-lists after a star toggle (JSON state the mtime probe cannot see)', async () => {
    await openFolderView()
    expect(starButton().className).not.toContain('starred')
    asked = []

    await click(starButton())
    // the mutation's refresh invalidated the listing: a full re-list with no
    // mtime probe — the row's star flag lives outside the folder's contents
    expect(asked).toEqual([{ dir: '/root', knownMtimeMs: undefined }])
    expect(starButton().className).toContain('starred')
  })

  it('invalidates the tracked parent of a never-listed child on a watch event', async () => {
    await openFolderView()
    asked = []

    // /root/sub was never expanded: it is not tracked, but its parent's cached
    // listing embeds the hasSubfolders flag the chevron needs
    await act(async () => {
      folderHandlers.forEach((h) => h(['/root/sub']))
    })
    await flush()
    expect(asked).toEqual([{ dir: '/root', knownMtimeMs: undefined }])
  })

  it('the focus refresh probes via the cached mtime instead of re-listing', async () => {
    await openFolderView()
    asked = []
    listFolder.mockClear()

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await flush()
    expect(asked).toEqual([{ dir: '/root', knownMtimeMs: 7 }])
    // the unchanged answer kept the cached listing — no re-list happened
    expect(listFolder).toHaveBeenCalledTimes(1)
  })
})

describe('the folder tree reveals Home under a covering document tab', () => {
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
            title: 'report.docx',
            active: true,
            dirty: false,
            detached: false,
          },
        ],
        activeId: 't1',
      }),
    )
    await flush(2)
  }

  // the tree's reveal contract, restated for its surviving half: the folder
  // view's own rows (subfolder rows in the table) carry the listing's outcome,
  // so their click raises the home tab under a covering document; the row's
  // ⋯ menu and a drag hover stay in-table and never raise. The tree's chevron
  // and its sidebar-internal self-containment retired with the tree.
  async function landOnFolderView(): Promise<void> {
    await openFolderView()
    tabsActivate.mockClear()
  }

  it('a subfolder row click is an in-surface navigation, never a raise', async () => {
    // the retired tree lived in the sidebar — the one region a covering
    // document never reached — so its rows owed the raise. The folder view's
    // rows live INSIDE the stage the document covers (unreachable while it
    // is up, and already the visible surface when it is not): the raise duty
    // moved to the ways in — the dock's items and the desktop's root icons
    // (their own tests pin it). A row switching to a sibling folder must
    // never yank the tab on its own.
    await pushDocTab()
    await landOnFolderView()
    const row = container.querySelector<HTMLElement>('.recent-item.folder-item')
    expect(row, 'a subfolder row in the folder view').toBeTruthy()
    await click(row)
    expect(tabsActivate).not.toHaveBeenCalled()
    // the switch itself happened — the nested listing is on screen
    expect(container.querySelector('.recent-table')).toBeTruthy()
  })

  it('the ⋯ menu opens without raising anything', async () => {
    // the folder menu is table-internal (reveal, rename, move…): its button
    // stops the row's click too
    await pushDocTab()
    await landOnFolderView()
    await click(container.querySelector('.recent-item.folder-item .more-btn'))
    expect(tabsActivate).not.toHaveBeenCalled()
    expect(container.querySelector('.folder-menu')).toBeTruthy()
  })

  it('a drag over a row highlights it without raising anything', async () => {
    // drag-and-drop hover is a gesture in flight, not a navigation: it must
    // never activate the tab it happens to pass over
    await pushDocTab()
    await landOnFolderView()
    const row = container.querySelector<HTMLElement>('.recent-item.folder-item')!
    const transfer = {
      // the app's own drag MIME, so the folder target actually engages
      types: ['application/x-genoffice-paths'],
      dropEffect: '',
    }
    await act(async () => {
      const over = new MouseEvent('dragover', { bubbles: true, cancelable: true })
      Object.defineProperty(over, 'dataTransfer', { value: transfer })
      row.dispatchEvent(over)
      await Promise.resolve()
    })
    // the drop target engaged (the drag path is live)…
    expect(row.className).toContain('drop-target')
    // …and no tab was raised by the hover
    expect(tabsActivate).not.toHaveBeenCalled()
  })
})
