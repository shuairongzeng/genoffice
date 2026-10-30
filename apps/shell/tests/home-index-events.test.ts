// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { defaultAiSettings } from '@genoffice/ai-provider'
import { Home } from '../src/renderer/src/Home'
import { LocaleProvider } from '../src/renderer/src/locale'
import type { FileSearchPage } from '../src/shared/home-api'

/**
 * The search's event-driven refresh: while a query is live the results
 * re-query when the main process pushes index-updated, and nothing else does
 * — the old 1.5 s re-poll while the index was busy is gone.
 */

let root: Root
let container: HTMLDivElement
let searchFiles: ReturnType<typeof vi.fn>
let indexHandlers: (() => void)[]

const page = (q: string): FileSearchPage => ({
  hits: [
    {
      path: `/root/${q.replace(/\s+/g, '-')}.md`,
      name: `${q.replace(/\s+/g, '-')}.md`,
      ext: 'md',
      mtimeMs: 1,
      sizeBytes: 1,
      starred: false,
      snippet: null,
      needles: [],
    },
  ],
  total: 1,
  // busy: this is the state the old code re-polled on a 1.5 s timer
  index: { indexed: 10, pending: 3, scanning: true },
})

/** the settled index: nothing left to wait for */
const quietPage = (q: string): FileSearchPage => ({
  ...page(q),
  index: { indexed: 13, pending: 0, scanning: false },
})

beforeEach(async () => {
  HTMLElement.prototype.scrollTo = vi.fn()
  localStorage.clear()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('No network in search event tests')
    }),
  )
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  searchFiles = vi.fn(async ({ q }: { q: string }) => page(q))
  indexHandlers = []
  window.aiOffice = {
    folderRoots: async () => [],
    onFolderChanged: () => () => {},
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
    listFolder: async (dir: string) => ({ dir, mtimeMs: 0, folders: [], files: [] }),
    searchFiles,
    rerankSearch: async () => null,
    onIndexUpdated: (handler: () => void) => {
      indexHandlers.push(handler)
      return () => {
        indexHandlers = indexHandlers.filter((h) => h !== handler)
      }
    },
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
  localStorage.clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function searchInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('.file-search input[type="search"]')
  expect(input).toBeTruthy()
  return input!
}

async function typeQuery(text: string) {
  const input = searchInput()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function clickNav(label: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('.sidebar-nav button')].find(
    (b) => b.querySelector('.nav-label')?.textContent === label,
  )
  expect(button).toBeTruthy()
  await act(async () => button!.click())
}

describe('search refresh on index-updated', () => {
  it('re-queries on the push and no longer re-polls while the index is busy', async () => {
    // the search box lives on the recents view
    await clickNav('Recent')

    await typeQuery('report')
    // debounce fired the one query…
    await act(async () => {
      vi.advanceTimersByTime(150)
    })
    expect(searchFiles).toHaveBeenCalledTimes(1)
    expect(searchFiles.mock.calls[0]![0]).toMatchObject({ q: 'report' })
    // …and the effect subscribed to the main process's push
    expect(indexHandlers).toHaveLength(1)

    // a busy index used to trigger a 1.5 s re-poll; two ticks past that with
    // no push must not re-query
    await act(async () => {
      vi.advanceTimersByTime(3200)
    })
    expect(searchFiles).toHaveBeenCalledTimes(1)

    // the push itself re-queries immediately
    await act(async () => {
      indexHandlers[0]!()
    })
    expect(searchFiles).toHaveBeenCalledTimes(2)
    expect(searchFiles.mock.calls[1]![0]).toMatchObject({ q: 'report' })

    // no push, no queries: another long quiet stretch stays at two
    await act(async () => {
      vi.advanceTimersByTime(3200)
    })
    expect(searchFiles).toHaveBeenCalledTimes(2)
  })

  it('unsubscribes when the query clears', async () => {
    await clickNav('Recent')

    await typeQuery('budget')
    await act(async () => {
      vi.advanceTimersByTime(150)
    })
    expect(indexHandlers).toHaveLength(1)

    await typeQuery('')
    await act(async () => {
      vi.advanceTimersByTime(150)
    })
    expect(indexHandlers).toHaveLength(0)
    // the cleared query never re-subscribes on a later timer tick
    await act(async () => {
      vi.advanceTimersByTime(3200)
    })
    expect(indexHandlers).toHaveLength(0)
    expect(searchFiles).toHaveBeenCalledTimes(1)
  })

  it('queues a push that lands while a query is in flight instead of discarding the reply', async () => {
    await clickNav('Recent')
    // a busy index makes each query slow (it waits out the settle cap): gate
    // the first reply the way a real mid-build query behaves
    let release!: (value: FileSearchPage) => void
    const gate = new Promise<FileSearchPage>((resolve) => {
      release = resolve
    })
    searchFiles.mockImplementationOnce(() => gate)

    await typeQuery('report')
    await act(async () => {
      vi.advanceTimersByTime(150)
    })
    expect(searchFiles).toHaveBeenCalledTimes(1)

    // two pushes while the query is outstanding: neither may start a second
    // query — bumping the sequence would discard the in-flight reply and
    // freeze the results mid-build
    await act(async () => {
      indexHandlers[0]!()
    })
    await act(async () => {
      indexHandlers[0]!()
    })
    expect(searchFiles).toHaveBeenCalledTimes(1)

    // the reply lands and renders; exactly one chained re-query follows
    await act(async () => {
      release(page('report'))
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(searchFiles).toHaveBeenCalledTimes(2)
    expect(searchFiles.mock.calls[1]![0]).toMatchObject({ q: 'report' })

    // no push, no further queries
    await act(async () => {
      vi.advanceTimersByTime(3200)
    })
    expect(searchFiles).toHaveBeenCalledTimes(2)
  })

  it('an old preload without the push channel keeps the busy-index re-poll', async () => {
    // one launch after an app update can pair a new renderer with the old
    // preload: no onIndexUpdated exists, so the slow poll must stay
    delete (window.aiOffice as Record<string, unknown>).onIndexUpdated
    await clickNav('Recent')

    await typeQuery('report')
    await act(async () => {
      vi.advanceTimersByTime(150)
    })
    expect(searchFiles).toHaveBeenCalledTimes(1)
    expect(indexHandlers).toHaveLength(0)

    // the reply said busy: the 1.5 s re-poll re-arms
    await act(async () => {
      vi.advanceTimersByTime(1500)
    })
    expect(searchFiles).toHaveBeenCalledTimes(2)

    // the index goes quiet on the next reply: the poll stops
    searchFiles.mockImplementationOnce(async () => quietPage('report'))
    await act(async () => {
      vi.advanceTimersByTime(1500)
    })
    expect(searchFiles).toHaveBeenCalledTimes(3)
    await act(async () => {
      vi.advanceTimersByTime(3200)
    })
    expect(searchFiles).toHaveBeenCalledTimes(3)
  })
})
