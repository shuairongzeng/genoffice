// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { defaultAiSettings } from '@genoffice/ai-provider'
import { Home } from '../src/renderer/src/Home'
import { LocaleProvider } from '../src/renderer/src/locale'
import type { FolderListing, FolderRoot, RecentEntry } from '../src/shared/home-api'

/**
 * The folder pane's three refresh paths, which the focus dirty-check must not
 * collapse into one: a mutation this renderer made (star toggle) re-lists,
 * because the cached rows embed data no mtime probe can see; a watch event in
 * a never-listed child invalidates its tracked parent (the chevron data); the
 * window-focus refresh alone probes via the cached mtimes.
 */

let root: Root
let container: HTMLDivElement
let asked: { dir: string; knownMtimeMs?: number }[] = []
let folderHandlers: ((dirs: string[]) => void)[] = []
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
  folders: [],
  files: [file(starred)],
})
const listFolder = vi.fn(async (dir: string, knownMtimeMs?: number): Promise<FolderListing> => {
  asked.push({ dir, knownMtimeMs })
  if (knownMtimeMs === 7) {
    return { dir, mtimeMs: 7, folders: [], files: [], unchanged: true }
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
  starred = false
  window.aiOffice = {
    folderRoots: async () => [ROOT],
    onFolderChanged: (handler: (dirs: string[]) => void) => {
      folderHandlers.push(handler)
      return () => {
        folderHandlers = folderHandlers.filter((h) => h !== handler)
      }
    },
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
  // the folder tree lives on the recents surface; the root row selects it
  const recent = [...container.querySelectorAll<HTMLButtonElement>('.sidebar-nav button')].find(
    (b) => b.querySelector('.nav-label')?.textContent === 'Recent',
  )
  await click(recent)
  await click(container.querySelector('.tree-row[title="/root"]'))
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
