// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { defaultAiSettings } from '@genoffice/ai-provider'
import { AskPanelEntry, isAskPanelView, panelApiReady } from '../src/renderer/src/panel-entry'
import { LocaleProvider } from '../src/renderer/src/locale'
import { loadStrings } from '../src/renderer/src/strings'
import type { PendingAskQuery } from '../src/shared/ask-forward'
import type { AiDockPrefs } from '../src/shared/home-api'

/**
 * The ask panel's standalone mount (src/renderer/src/panel-entry.tsx, the
 * shell renderer at ?view=ask-panel): the entry self-checks its context —
 * the aiOffice face and the loaded dictionary — and renders the panel alone
 * when both hold, a plain explanation when they do not. W2's native overlay
 * view above documents loads exactly this surface, so these checks are the
 * contract that view relies on — including the entry's floating pet, the
 * overlay's only click affordance while a document is active. The overlay's
 * own behaviors ride here too: the forwarded ask handoffs Home routes
 * through main while a document is active (P0-2 — consumed with the same
 * pending-query semantics Home's panel applies), the ready ping that
 * releases the messages main buffered for this view (P0-2 delivery — the
 * overlay flushes nothing before it), the pet's live
 * aria-expanded state (P1-4), and Esc's ladder — clear the draft first,
 * then collapse the drawer (P1-4).
 */

let root: Root | null = null
let container: HTMLDivElement | null = null
const openPath = vi.fn(async () => undefined)
const tabsActivate = vi.fn(async () => undefined)
const openAiModelSettings = vi.fn(async () => undefined)
const setAiDock = vi.fn(async () => undefined)
let forwardedAskHandler: ((query: PendingAskQuery) => void) | null = null
let dockChangedHandler: ((prefs: AiDockPrefs) => void) | null = null

/** the aiOffice face the standalone panel needs at mount (the ask paths only) */
function panelApi(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    folderRoots: async () => [],
    onFolderChanged: () => () => {},
    recents: async () => ({ entries: [], total: 0, totalAll: 0 }),
    starred: async () => ({ entries: [], total: 0, totalAll: 0 }),
    starredGroups: async () => [],
    accountStatus: async () => ({ loggedIn: false }),
    onOpenSettings: () => () => {},
    onAccountLogin: () => () => {},
    kbList: async () => [],
    kbSearch: async () => [],
    kbRead: async () => ({ text: '', offset: 0, total: 0 }),
    aiStream: async () => undefined,
    aiStreamCancel: async () => undefined,
    onAiStream: () => () => {},
    aiGetSettings: async () => defaultAiSettings(),
    aiGskStatus: async () => ({ loggedIn: true }),
    onAiSettingsChanged: () => () => {},
    openPath,
    tabsActivate,
    openAiModelSettings,
    setAiDock,
    // the entry demands it (REQUIRED_API): the browser annotation pushes the
    // panel parks are this mount's own traffic
    onBrowserAskAbout: () => () => {},
    ...extra,
  }
}

/** the extra channels the overlay's own behaviors consume (P0-2, P1-4) */
function overlayChannels(): Record<string, unknown> {
  return {
    onForwardedAskQuery: (handler: (query: PendingAskQuery) => void) => {
      forwardedAskHandler = handler
      return () => {
        forwardedAskHandler = null
      }
    },
    getAiDock: async () => ({ width: 400, collapsed: false, petPos: null }),
    onAiDockChanged: (handler: (prefs: AiDockPrefs) => void) => {
      dockChangedHandler = handler
      return () => {
        dockChangedHandler = null
      }
    },
  }
}

async function mountEntry(api: Record<string, unknown> | undefined): Promise<void> {
  window.aiOffice = api as unknown as Window['aiOffice']
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root!.render(
      createElement(LocaleProvider, { initial: 'en', children: createElement(AskPanelEntry) }),
    ),
  )
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve()
  })
}

/** the overlay panel's composer draft */
const composerDraft = (): string =>
  container!.querySelector<HTMLTextAreaElement>('.kb-ask textarea')?.value ?? ''

/** the questions the overlay panel shows, in thread order */
const askedMessages = (): string[] =>
  [...container!.querySelectorAll('.kb-ask-msg.kb-ask-user')].map((el) => el.textContent ?? '')

beforeEach(async () => {
  HTMLElement.prototype.scrollTo = vi.fn()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('No network in panel-entry tests')
    }),
  )
  forwardedAskHandler = null
  dockChangedHandler = null
  openPath.mockClear()
  tabsActivate.mockClear()
  openAiModelSettings.mockClear()
  setAiDock.mockClear()
  // the shared boot's half of the contract: the dictionary is in place before
  // the first render, the same way main.tsx awaits it
  await loadStrings('en')
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  container?.remove()
  container = null
  vi.unstubAllGlobals()
})

describe('isAskPanelView', () => {
  it('answers true only for the ask-panel view param', () => {
    expect(isAskPanelView('?view=ask-panel')).toBe(true)
    expect(isAskPanelView('?view=ask-panel&lang=en')).toBe(true)
    expect(isAskPanelView('?mode=help')).toBe(false)
    expect(isAskPanelView('?view=other')).toBe(false)
    expect(isAskPanelView('')).toBe(false)
    // no argument reads this window's own search (jsdom carries none)
    expect(isAskPanelView()).toBe(false)
  })
})

describe('panelApiReady', () => {
  it('demands the aiOffice face and every method the panel needs at mount', () => {
    expect(panelApiReady(undefined)).toBe(false)
    expect(panelApiReady(null)).toBe(false)
    expect(panelApiReady({})).toBe(false)
    expect(panelApiReady(panelApi() as never)).toBe(true)
    // each required method missing alone flips the answer
    for (const name of [
      'kbList',
      'kbSearch',
      'aiStream',
      'onAiStream',
      'aiGetSettings',
      'setAiDock',
      'onBrowserAskAbout',
    ]) {
      const partial = { ...panelApi() }
      delete partial[name]
      expect(panelApiReady(partial as never)).toBe(false)
    }
  })
})

describe('AskPanelEntry', () => {
  it('renders the panel alone when the context holds', async () => {
    await mountEntry(panelApi())
    expect(container!.querySelector('.ask-panel-entry')).not.toBeNull()
    expect(container!.querySelector('.kb-ask')).not.toBeNull()
    // the panel alone: no workbench chrome came with it
    expect(container!.querySelector('.app-frame')).toBeNull()
    expect(container!.querySelector('.sidebar')).toBeNull()
  })

  it("renders the floating pet, the overlay view's collapse control", async () => {
    await mountEntry(panelApi())
    const pet = container!.querySelector<HTMLButtonElement>('.ai-pet')!
    expect(pet).not.toBeNull()
    // the same bird Home's drawer perches (the shared MascotSvg drawing)
    expect(pet.querySelector('.ai-mascot-svg')).not.toBeNull()
    // perched at the view's bottom-right corner, click-only
    expect(pet.style.right).toBe('16px')
    expect(pet.style.bottom).toBe('16px')
    // expanded by default: this view is only on screen while the drawer is
    // open, and a bridge without the prefs channels cannot say otherwise
    expect(pet.getAttribute('aria-expanded')).toBe('true')
  })

  it("the pet's click collapses the drawer through the prefs channel", async () => {
    await mountEntry(panelApi())
    const pet = container!.querySelector<HTMLButtonElement>('.ai-pet')!
    await act(async () => pet.click())
    // the same write Home's pet makes: main's watchAiDock tears the overlay
    // down and every prefs copy follows
    expect(setAiDock).toHaveBeenCalledWith({ collapsed: true })
  })

  it('explains instead of mounting when the aiOffice face is partial', async () => {
    const partial = panelApi()
    delete partial.kbSearch
    await mountEntry(partial)
    expect(container!.querySelector('.kb-ask')).toBeNull()
    const error = container!.querySelector('.ask-panel-entry-error')!
    expect(error).not.toBeNull()
    expect(error.textContent).toBe(
      'The ask panel needs APIs this window does not expose. Try restarting the app.',
    )
  })

  it('explains when no aiOffice face exists at all', async () => {
    await mountEntry(undefined)
    expect(container!.querySelector('.kb-ask')).toBeNull()
    expect(container!.querySelector('.ask-panel-entry-error')).not.toBeNull()
  })

  it('the empty-corpus CTA routes through the entry: raise Home, not a view switch', async () => {
    await mountEntry(panelApi())
    const cta = container!.querySelector<HTMLButtonElement>('.kb-ask-cta')!
    expect(cta).toBeTruthy()
    await act(async () => cta.click())
    expect(tabsActivate).toHaveBeenCalledWith('home')
    // the entry has no list of its own to switch to — nothing else moved
    expect(container!.querySelector('.content')).toBeNull()
  })
})

describe('the ready handshake (the buffered deliveries flush on it)', () => {
  it('pings askPanelReady on mount, after the panel armed its subscriptions', async () => {
    // React runs child effects before parent ones, so the panel's
    // subscriptions (the one the browser annotations ride) exist by the time
    // the ping tells main it may flush what it buffered for this view
    const order: string[] = []
    await mountEntry(
      panelApi({
        askPanelReady: () => {
          order.push('ready')
        },
        onBrowserAskAbout: () => {
          order.push('subscribe')
          return () => {}
        },
      }),
    )
    expect(order).toEqual(['subscribe', 'ready'])
  })

  it('pings once, not on every re-render', async () => {
    const askPanelReady = vi.fn()
    await mountEntry(panelApi({ ...overlayChannels(), askPanelReady }))
    // the forwarded-ask handler bumps state the entry re-renders on
    await act(async () => forwardedAskHandler!({ text: 'again', seq: 9, origin: 'palette' }))
    expect(askPanelReady).toHaveBeenCalledTimes(1)
  })

  it('mounts without the channel (a stale preload): the missing ping is not fatal', async () => {
    // main then keeps its buffered messages, the pre-handshake behavior —
    // degraded, never a dead panel
    await mountEntry(panelApi())
    expect(container!.querySelector('.kb-ask')).not.toBeNull()
  })

  it('does not ping from the error state: there is no panel to flush into', async () => {
    // a partial aiOffice face renders the explanation, not the panel — its
    // mount has no listeners, so arming the flush there would drop the
    // buffered messages into a renderer nobody is listening in
    const askPanelReady = vi.fn()
    const partial = panelApi({ askPanelReady })
    delete partial.kbSearch
    await mountEntry(partial)
    expect(container!.querySelector('.ask-panel-entry-error')).not.toBeNull()
    expect(askPanelReady).not.toHaveBeenCalled()
  })
})

describe('the forwarded ask handoffs (P0-2: the overlay consumes them)', () => {
  it("parks a deep-link handoff in the composer and focuses it, like Home's panel", async () => {
    await mountEntry(panelApi(overlayChannels()))
    expect(forwardedAskHandler).not.toBeNull()
    await act(async () =>
      forwardedAskHandler!({ text: 'asked over a document', seq: 1, origin: 'deep-link' }),
    )
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    // web-supplied text never submits itself: it waits in the draft for Enter
    expect(composerDraft()).toBe('asked over a document')
    expect(askedMessages()).toEqual([])
    // the handoff bumped the composer's focus, the way openAskDock does at Home
    expect(document.activeElement).toBe(container!.querySelector('.kb-ask textarea'))
  })

  it('submits a palette handoff into the overlay thread', async () => {
    await mountEntry(panelApi(overlayChannels()))
    await act(async () =>
      forwardedAskHandler!({ text: 'typed in the palette', seq: 2, origin: 'palette' }),
    )
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    // the corpus mock is empty, so the submission resolves to the panel's
    // guidance answer — the question itself is the overlay thread's first turn
    expect(askedMessages()).toEqual(['typed in the palette'])
    expect(composerDraft()).toBe('')
  })
})

describe("the pet's live drawer state (P1-4: aria-expanded)", () => {
  it('follows the prefs channel and its broadcast, not a hardcoded value', async () => {
    await mountEntry(panelApi(overlayChannels()))
    const pet = container!.querySelector<HTMLButtonElement>('.ai-pet')!
    expect(pet.getAttribute('aria-expanded')).toBe('true')
    // the overlay pet's own collapse write lands as a broadcast: the control
    // then honestly says the drawer is closed
    await act(async () => dockChangedHandler!({ width: 400, collapsed: true, petPos: null }))
    expect(pet.getAttribute('aria-expanded')).toBe('false')
    await act(async () => dockChangedHandler!({ width: 448, collapsed: false, petPos: null }))
    expect(pet.getAttribute('aria-expanded')).toBe('true')
  })
})

describe("Esc's ladder (P1-4: the overlay answers the key itself)", () => {
  const pressEscape = (): void =>
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })

  function typeDraft(text: string): void {
    act(() => {
      const ta = container!.querySelector<HTMLTextAreaElement>('.kb-ask textarea')!
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(ta, text)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('clears a non-empty draft first, and collapses only once it is empty', async () => {
    await mountEntry(panelApi(overlayChannels()))
    typeDraft('half written')
    await pressEscape()
    // the first Esc belongs to the draft: the drawer stays open
    expect(container!.querySelector<HTMLTextAreaElement>('.kb-ask textarea')!.value).toBe('')
    expect(setAiDock).not.toHaveBeenCalled()
    await pressEscape()
    // the second Esc, on an empty composer, collapses through the prefs channel
    expect(setAiDock).toHaveBeenCalledWith({ collapsed: true })
  })

  it('collapses straight away when the composer was already empty', async () => {
    await mountEntry(panelApi(overlayChannels()))
    await pressEscape()
    expect(setAiDock).toHaveBeenCalledWith({ collapsed: true })
  })

  it("leaves a key another surface consumed alone (the busy composer's stop)", async () => {
    await mountEntry(panelApi(overlayChannels()))
    typeDraft('mid-answer draft')
    // the composer's Esc-stop while a run streams calls preventDefault: the
    // ladder must see the key as taken and neither clear nor collapse
    await act(async () => {
      const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
      event.preventDefault()
      window.dispatchEvent(event)
    })
    expect(container!.querySelector<HTMLTextAreaElement>('.kb-ask textarea')!.value).toBe(
      'mid-answer draft',
    )
    expect(setAiDock).not.toHaveBeenCalled()
  })

  it("leaves the slash palette's own Escape alone: the draft survives", async () => {
    await mountEntry(panelApi(overlayChannels()))
    // typing a leading slash opens the palette above the composer; its Escape
    // is consumed in the panel root's capture gate before the ladder sees it
    typeDraft('/tone')
    await act(async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve()
    })
    const textarea = container!.querySelector<HTMLTextAreaElement>('.kb-ask textarea')!
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(container!.querySelector('.ai-slash-pop')).toBeNull()
    expect(textarea.value).toBe('/tone')
    expect(setAiDock).not.toHaveBeenCalled()
  })
})
