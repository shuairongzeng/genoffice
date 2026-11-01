// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { defaultAiSettings } from '@genoffice/ai-provider'
import { Home } from '../src/renderer/src/Home'
import { LocaleProvider } from '../src/renderer/src/locale'
import type { PendingAskQuery } from '../src/shared/ask-forward'
import type { HomeTabEntry, RecentEntry } from '../src/shared/home-api'

/**
 * The ask intent's two entry routes into Home: the command palette's Ask AI
 * fallback row, and the `home:deep-link` channel (genoffice://ask?q=…). Both
 * must land in the ask view, but only the palette's user-typed text submits
 * itself — a deep link's web-supplied query parks in the composer and waits
 * for an explicit Enter, so a web page can never inject a prompt that runs.
 * The corpus mock is empty on purpose: the submission then resolves to the
 * panel's guidance answer synchronously after the corpus check, so no AI
 * transport takes part in these tests. Document mode covers the P0-2
 * forwards to the overlay's panel copy — including the order the dock's
 * open write and the forward leave in (FIFO makes the order the routing).
 */

let root: Root
let container: HTMLDivElement
let deepLinkHandler: ((payload: unknown) => void) | null
let paletteHandler: (() => void) | null
let tabsHandler: ((state: { tabs: HomeTabEntry[]; activeId: string }) => void) | null
let browserAskHandler: ((payload: unknown) => void) | null
let forwardedAskHandler: ((query: PendingAskQuery) => void) | null
/** the handoffs Home forwarded to the overlay's panel copy (P0-2) */
const forwardedAsks: PendingAskQuery[] = []
/** the browser annotations Home forwarded to the overlay's panel copy (P0-2) */
const forwardedNotes: unknown[] = []

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

beforeEach(async () => {
  HTMLElement.prototype.scrollTo = vi.fn()
  // this suite starts from the list view: the intent routes must switch away from it
  localStorage.setItem('home.view', 'recent')
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('No network in ask-intent tests'))),
  )
  deepLinkHandler = null
  paletteHandler = null
  tabsHandler = null
  browserAskHandler = null
  forwardedAskHandler = null
  forwardedAsks.length = 0
  forwardedNotes.length = 0
  window.aiOffice = {
    folderRoots: async () => [],
    onFolderChanged: () => () => {},
    recents: async () => ({ entries: files, total: files.length, totalAll: files.length }),
    starred: async () => ({ entries: [], total: 0, totalAll: 0 }),
    starredGroups: async () => [],
    accountStatus: async () => ({ loggedIn: false }),
    onOpenSettings: () => () => {},
    onAccountLogin: () => () => {},
    kbList: async () => [],
    aiGetSettings: async () => defaultAiSettings(),
    // logged in so the composer's setup gate stays open: an explicit Enter
    // must be able to send the parked deep-link draft
    aiGskStatus: async () => ({ loggedIn: true }),
    onAiSettingsChanged: () => () => {},
    onDeepLink: (handler: (payload: unknown) => void) => {
      deepLinkHandler = handler
      return () => {}
    },
    onPaletteOpen: (handler: () => void) => {
      paletteHandler = handler
      return () => {}
    },
    onTabsChanged: (handler: (state: { tabs: HomeTabEntry[]; activeId: string }) => void) => {
      tabsHandler = handler
      return () => {}
    },
    onBrowserAskAbout: (handler: (payload: unknown) => void) => {
      browserAskHandler = handler
      return () => {}
    },
    onForwardedAskQuery: (handler: (query: PendingAskQuery) => void) => {
      forwardedAskHandler = handler
      return () => {}
    },
    forwardAskQuery: async (query: PendingAskQuery) => {
      forwardedAsks.push(query)
    },
    forwardBrowserAskAbout: async (note: unknown) => {
      forwardedNotes.push(note)
    },
    openPath: async () => {},
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
  localStorage.clear()
})

/** a tab push the way the main process sends it: Home first, then a document */
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

/** make a document tab the active one: Home's copy is covered, the overlay is live */
async function activateDocTab(): Promise<void> {
  await act(async () => pushTabs('t1', { id: 't1', kind: 'docs', title: 'brief.docx' }))
  await flush()
}

/** flush the mounted component plus the async submission chain (kbList, state) */
async function flush(times = 6): Promise<void> {
  await act(async () => {
    for (let i = 0; i < times; i++) await Promise.resolve()
  })
}

/** the questions the ask panel shows, in thread order */
const askedMessages = (): string[] =>
  [...container.querySelectorAll('.kb-ask-msg.kb-ask-user')].map((el) => el.textContent ?? '')

/** the ask panel's composer draft */
const composerDraft = (): string =>
  container.querySelector<HTMLTextAreaElement>('.kb-ask textarea')?.value ?? ''

describe('Home ask intent — deep link', () => {
  it('home:deep-link {view:ask, query} opens the ask view and parks the query in the composer', async () => {
    expect(deepLinkHandler).not.toBeNull()
    await act(async () => deepLinkHandler!({ view: 'ask', query: 'hello from a link' }))
    await flush()
    expect(container.querySelector('.kb-ask')).not.toBeNull()
    // web-supplied text never submits itself: it waits in the draft for Enter
    expect(askedMessages()).toEqual([])
    expect(composerDraft()).toBe('hello from a link')
  })

  it('the parked deep-link query is sent only by an explicit Enter', async () => {
    await act(async () => deepLinkHandler!({ view: 'ask', query: 'hello from a link' }))
    await flush()
    expect(askedMessages()).toEqual([])
    const composer = container.querySelector<HTMLTextAreaElement>('.kb-ask textarea')!
    await act(async () => {
      composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Promise.resolve()
    })
    await flush()
    expect(askedMessages()).toEqual(['hello from a link'])
    expect(composerDraft()).toBe('')
  })

  it('a deep link without a query only opens the ask view', async () => {
    await act(async () => deepLinkHandler!({ view: 'ask' }))
    await flush()
    expect(container.querySelector('.kb-ask')).not.toBeNull()
    expect(askedMessages()).toEqual([])
    expect(composerDraft()).toBe('')
  })

  it('a deep link for another view is ignored', async () => {
    await act(async () => deepLinkHandler!({ view: 'recent' }))
    await flush()
    // the dock stays mounted whatever the link; nothing parked a question
    // and the list surface never moved
    expect(container.querySelector('.content')?.textContent).toContain('brief.docx')
    expect(composerDraft()).toBe('')
  })

  it('genoffice://desktop switches Home to the desktop surface and remembers it', async () => {
    await act(async () => deepLinkHandler!({ view: 'desktop' }))
    await flush()
    // the icon desktop takes over the content area, and the launch view
    // remembers it the way the nav item does (a relaunch lands back there)
    expect(container.querySelector('.home')!.className).toContain('desktop-mode')
    expect(container.querySelector('.desktop-surface')).toBeTruthy()
    expect(localStorage.getItem('home.view')).toBe('desktop')

    // leaving through a link works too: the ask route opens the drawer — the
    // desktop surface stays mounted underneath, and the question parks
    await act(async () => deepLinkHandler!({ view: 'ask', query: 'back to ask' }))
    await flush()
    expect(container.querySelector('.home')!.className).toContain('desktop-mode')
    expect(container.querySelector('.ai-drawer')!.className).toContain('open')
    expect(composerDraft()).toBe('back to ask')
  })

  it('an ask deep link opens a closed drawer before parking the question', async () => {
    // the pet state: the drawer starts closed
    localStorage.setItem(
      'home.aiDock',
      JSON.stringify({ width: 400, collapsed: true, petPos: null }),
    )
    await act(async () => root.unmount())
    container.remove()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () =>
      root.render(createElement(LocaleProvider, { initial: 'en', children: createElement(Home) })),
    )
    expect(container.querySelector('.ai-drawer')!.className).not.toContain('open')
    await act(async () => deepLinkHandler!({ view: 'ask', query: 'wake up' }))
    await flush()
    // the ask route is a drawer focus now: the pet gave way to the panel and
    // the composer holds the question
    expect(container.querySelector('.ai-drawer')!.className).toContain('open')
    expect(container.querySelector('.ai-pet')).toBeTruthy()
    expect(composerDraft()).toBe('wake up')
    expect(document.activeElement).toBe(container.querySelector('.kb-ask textarea'))
  })
})

describe('Home ask intent — palette fallback', () => {
  it('the palette Ask AI row routes its query into the ask panel', async () => {
    expect(paletteHandler).not.toBeNull()
    await act(async () => paletteHandler!())
    const input = container.querySelector<HTMLInputElement>('.cmd-input')
    expect(input).not.toBeNull()
    await act(async () => {
      const proto = window.HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(input, 'zzz palette question')
      input!.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    const row = [...container.querySelectorAll<HTMLButtonElement>('.cmd-row')].find((el) =>
      el.textContent?.includes('Ask AI'),
    )
    expect(row).toBeTruthy()
    await act(async () => row!.click())
    await flush()
    // the palette closed and the question is a message in the ask thread
    expect(container.querySelector('.cmd-overlay')).toBeNull()
    expect(container.querySelector('.kb-ask')).not.toBeNull()
    expect(askedMessages()).toEqual(['zzz palette question'])
  })
})

describe('Home ask intent in document mode (P0-2: the overlay drawer)', () => {
  it('forwards a deep-link ask to main instead of parking it in the covered copy', async () => {
    await activateDocTab()
    await act(async () => deepLinkHandler!({ view: 'ask', query: 'ask over the document' }))
    await flush()
    // the overlay view is the drawer the person sees: the handoff left for it
    expect(forwardedAsks).toEqual([{ text: 'ask over the document', seq: 1, origin: 'deep-link' }])
    // Home's own copy is display:none under the document — it must not park
    // or ask anything either
    expect(composerDraft()).toBe('')
    expect(askedMessages()).toEqual([])
    // the drawer's open intent is still recorded, so the overlay shows
    expect(container.querySelector('.ai-drawer')!.className).toContain('open')
  })

  it('numbers the handoffs it forwards, so a second one is still a second handoff', async () => {
    await activateDocTab()
    await act(async () => deepLinkHandler!({ view: 'ask', query: 'first over the doc' }))
    await flush()
    await act(async () => deepLinkHandler!({ view: 'ask', query: 'second over the doc' }))
    await flush()
    expect(forwardedAsks.map((q) => q.seq)).toEqual([1, 2])
  })

  it('consumes a bounced-back handoff exactly like a local one', async () => {
    // main routes by its own live tab state: a handoff sent on a stale
    // docActive bounces back over onForwardedAskQuery — same pending-query
    // semantics, so a deep-link origin parks in this copy's composer
    expect(forwardedAskHandler).not.toBeNull()
    await act(async () =>
      forwardedAskHandler!({ text: 'bounced back', seq: 9, origin: 'deep-link' }),
    )
    await flush()
    expect(composerDraft()).toBe('bounced back')
    expect(askedMessages()).toEqual([])
    expect(forwardedAsks).toEqual([])
  })

  it('submits a bounced palette handoff, the origin the panel may send itself', async () => {
    await act(async () =>
      forwardedAskHandler!({ text: 'typed in the palette', seq: 3, origin: 'palette' }),
    )
    await flush()
    expect(askedMessages()).toEqual(['typed in the palette'])
  })

  it('keeps the handoff local while Home is the active tab', async () => {
    await act(async () => deepLinkHandler!({ view: 'ask', query: 'local ask' }))
    await flush()
    expect(forwardedAsks).toEqual([])
    expect(composerDraft()).toBe('local ask')
  })

  it('forwards a browser annotation to the overlay copy while a document is active', async () => {
    await activateDocTab()
    const note = { id: 'n1', note: 'what does this highlight mean', url: 'https://example.com' }
    await act(async () => browserAskHandler!(note))
    await flush()
    expect(forwardedNotes).toEqual([note])
    // the dock opened for the annotation either way
    expect(container.querySelector('.ai-drawer')!.className).toContain('open')
  })

  it('leaves the browser annotation local while Home is the active tab', async () => {
    await act(async () => browserAskHandler!({ id: 'n1', note: 'on home' }))
    await flush()
    expect(forwardedNotes).toEqual([])
  })

  describe('the dock-open write precedes the forward (P0-2 FIFO)', () => {
    /**
     * Home remounted with the drawer collapsed and a document tab active,
     * with the dock write and the forwards recording their order: main routes
     * a handoff by the prefs it holds when the forward arrives, and IPC is
     * FIFO — a forward that beats the write lands while aiDock still says
     * collapsed, bounces to Home's covered copy, and the overlay mounts
     * empty. The open write has to leave first.
     */
    async function collapsedDocModeHome(recentsEntries?: RecentEntry[]): Promise<string[]> {
      localStorage.setItem(
        'home.aiDock',
        JSON.stringify({ width: 400, collapsed: true, petPos: null }),
      )
      const order: string[] = []
      const api = window.aiOffice as Partial<HomeApi>
      api.setAiDock = async () => {
        order.push('dock-open')
        return { width: 400, collapsed: false, petPos: null }
      }
      api.forwardAskQuery = async () => {
        order.push('forward')
      }
      api.forwardBrowserAskAbout = async () => {
        order.push('forward-note')
      }
      if (recentsEntries) {
        api.recents = async () => ({
          entries: recentsEntries,
          total: recentsEntries.length,
          totalAll: recentsEntries.length,
        })
      }
      await act(async () => root.unmount())
      container.remove()
      container = document.createElement('div')
      document.body.append(container)
      root = createRoot(container)
      await act(async () =>
        root.render(
          createElement(LocaleProvider, { initial: 'en', children: createElement(Home) }),
        ),
      )
      await flush()
      await activateDocTab()
      return order
    }

    it('a deep-link ask opens the dock before the handoff leaves', async () => {
      const order = await collapsedDocModeHome()
      await act(async () => deepLinkHandler!({ view: 'ask', query: 'ordered handoff' }))
      await flush()
      expect(order).toEqual(['dock-open', 'forward'])
      // the write did its own job too: the drawer shows open
      expect(container.querySelector('.ai-drawer')!.className).toContain('open')
    })

    it('a browser annotation opens the dock before the note leaves', async () => {
      const order = await collapsedDocModeHome()
      await act(async () => browserAskHandler!({ id: 'n1', note: 'what is this' }))
      await flush()
      expect(order).toEqual(['dock-open', 'forward-note'])
    })

    it("the desktop's Ask AI action opens the dock before the scope handoff leaves", async () => {
      // two files on the desktop: the multi-select context menu's Ask AI is
      // the route into askAboutPaths
      localStorage.setItem('home.view', 'desktop')
      const entries = [
        files[0]!,
        { ...files[0]!, path: '/fixtures/notes.xlsx', name: 'notes.xlsx', ext: 'xlsx' },
      ]
      const order = await collapsedDocModeHome(entries)
      const icon = (label: string): HTMLElement =>
        container.querySelector<HTMLElement>(`.desktop-icon-item[aria-label="${label}"]`)!
      const at = (label: string): { x: number; y: number } => {
        const li = icon(label).closest('li') as HTMLElement
        return {
          x: Number.parseInt(li.style.left, 10) || 40,
          y: Number.parseInt(li.style.top, 10) || 40,
        }
      }
      const press = async (label: string, metaKey: boolean): Promise<void> => {
        const { x, y } = at(label)
        await act(async () => {
          icon(label).dispatchEvent(
            new MouseEvent('pointerdown', {
              bubbles: true,
              button: 0,
              clientX: x,
              clientY: y,
              metaKey,
            }),
          )
          await Promise.resolve()
        })
        await act(async () => {
          window.dispatchEvent(
            new MouseEvent('pointerup', { bubbles: true, clientX: x, clientY: y }),
          )
          await Promise.resolve()
        })
      }
      await press('brief.docx', false)
      await press('notes.xlsx', true)
      await act(async () => {
        icon('brief.docx').dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 40,
            clientY: 40,
          }),
        )
        await Promise.resolve()
      })
      const ask = [
        ...container.querySelectorAll<HTMLButtonElement>('.desktop-menu-multi button'),
      ].find((button) => button.textContent === 'Ask AI')
      await act(async () => ask!.click())
      await flush()
      expect(order).toEqual(['dock-open', 'forward'])
      expect(container.querySelector('.ai-drawer')!.className).toContain('open')
    })
  })
})
