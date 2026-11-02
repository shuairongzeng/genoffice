// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { defaultAiSettings } from '@genoffice/ai-provider'
import {
  AskPanelEntry,
  isAskPanelView,
  panelApiReady,
  petDragPosition,
} from '../src/renderer/src/panel-entry'
import { PET_SIZE } from '../src/renderer/src/AiDock'
import { LocaleProvider } from '../src/renderer/src/locale'
import { loadStrings } from '../src/renderer/src/strings'
import type { PendingAskQuery } from '../src/shared/ask-forward'
import type { AiDockPrefs } from '../src/shared/home-api'

/**
 * The ask panel's standalone mount (src/renderer/src/panel-entry.tsx, the
 * shell renderer at ?view=ask-panel): the surface the W2 native overlay view
 * loads over an active document, in the two shapes the `aiDock` prefs pick —
 * the drawer (panel plus pet) or the pet alone (the panel hidden behind it,
 * never unmounted). The entry self-checks its context — the aiOffice face
 * and the loaded dictionary — and renders the panel when both hold, a plain
 * explanation when they do not. W2's native overlay view above documents
 * loads exactly this surface, so these checks are the contract that view
 * relies on. The overlay's own behaviors ride here too: the forwarded ask
 * handoffs Home routes through main while a document is active (P0-2 —
 * consumed with the same pending-query semantics Home's panel applies), the
 * ready ping that releases the messages main buffered for this view (P0-2
 * delivery — the overlay flushes nothing before it), the shape flips on the
 * prefs broadcast, the pet-only pet's drag (a window-wide surface main hosts
 * over `home:ai-pet-drag` — static, so the pointer-minus-grab math is exact
 * for real pointers and synthetic input alike; the release commits through
 * the ordinary aiDock write), the pet's click toggle, the pet's live
 * aria-expanded state (P1-4), and Esc's ladder — clear the draft first, then
 * collapse the drawer (P1-4).
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

/** the extra channels the overlay's own behaviors consume (P0-2, P1-4, the two shapes) */
function overlayChannels(
  dock: AiDockPrefs = { width: 400, collapsed: false, petPos: null },
): Record<string, unknown> {
  return {
    onForwardedAskQuery: (handler: (query: PendingAskQuery) => void) => {
      forwardedAskHandler = handler
      return () => {
        forwardedAskHandler = null
      }
    },
    getAiDock: async () => dock,
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

describe('the two shapes (the drawer and the pet-only view)', () => {
  it('expanded: the panel and the pet at the drawer foot, an opaque root', async () => {
    await mountEntry(panelApi(overlayChannels()))
    const root = container!.querySelector<HTMLElement>('.ask-panel-entry')!
    expect(root.classList.contains('ask-panel-pet-only')).toBe(false)
    expect(container!.querySelector('.kb-ask')).not.toBeNull()
    expect(container!.querySelector('.ask-panel-panel')!.hasAttribute('hidden')).toBe(false)
    // html and body keep their backgrounds: the view's surface paints opaque
    expect(document.documentElement.classList.contains('ask-panel-pet-only')).toBe(false)
    const pet = container!.querySelector<HTMLButtonElement>('.ai-pet')!
    expect(pet.style.right).toBe('16px')
    expect(pet.style.bottom).toBe('16px')
  })

  it('collapsed: the pet alone at the view origin, the panel hidden but mounted', async () => {
    // the view has shrunk to the bird: nothing but the pet may paint, and the
    // panel's session and subscriptions survive the collapse (the streaming
    // contract) — hidden, never unmounted
    await mountEntry(panelApi(overlayChannels({ width: 400, collapsed: true, petPos: null })))
    const root = container!.querySelector<HTMLElement>('.ask-panel-entry')!
    expect(root.classList.contains('ask-panel-pet-only')).toBe(true)
    expect(document.documentElement.classList.contains('ask-panel-pet-only')).toBe(true)
    const pet = container!.querySelector<HTMLButtonElement>('.ai-pet')!
    // main sized the view around the bird: the pet perches at its own origin
    expect(pet.style.left).toBe('0px')
    expect(pet.style.top).toBe('0px')
    // the panel is hidden, not gone — and the pet is still the toggle
    const panel = container!.querySelector('.ask-panel-panel')!
    expect(panel.hasAttribute('hidden')).toBe(true)
    expect(container!.querySelector('.kb-ask')).not.toBeNull()
    expect(pet.getAttribute('aria-expanded')).toBe('false')
  })

  it('the not-yet-known state paints nothing: neither shape guessed at', async () => {
    // the view may be pet-sized or drawer-sized before the store answers, and
    // either guess is garbage pixels — a transparent blank is the only safe
    // paint (the html class keeps the backgrounds off meanwhile)
    let answer: (prefs: AiDockPrefs) => void = () => undefined
    const dockPromise = new Promise<AiDockPrefs>((resolve) => {
      answer = resolve
    })
    await mountEntry(panelApi({ ...overlayChannels(), getAiDock: () => dockPromise }))
    expect(container!.querySelector('.ask-panel-entry')).toBeNull()
    expect(document.documentElement.classList.contains('ask-panel-pet-only')).toBe(true)
    await act(async () => answer({ width: 400, collapsed: false, petPos: null }))
    await act(async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve()
    })
    expect(container!.querySelector('.kb-ask')).not.toBeNull()
    expect(document.documentElement.classList.contains('ask-panel-pet-only')).toBe(false)
  })

  it('a stale preload without the prefs channels falls back to the drawer shape', async () => {
    await mountEntry(panelApi())
    // the pet-only state cannot be known without them, so the drawer is the
    // only expressible shape — degraded, never a dead panel
    expect(container!.querySelector('.kb-ask')).not.toBeNull()
    expect(document.documentElement.classList.contains('ask-panel-pet-only')).toBe(false)
  })

  it("the docked shape wears the embedded chrome class (the app's own panel), and only expanded", async () => {
    // main pushes home:ask-panel-embedded when the view fits the docs app's
    // reserved slot: the panel then reads as the app's own — flat against
    // the app's layout — and back to floating chrome when it leaves
    let embeddedHandler: ((embedded: boolean) => void) | null = null
    const api = panelApi({
      ...overlayChannels(),
      onAskPanelEmbedded: (handler: (embedded: boolean) => void) => {
        embeddedHandler = handler
        return () => {
          embeddedHandler = null
        }
      },
    })
    await mountEntry(api)
    const root = container!.querySelector<HTMLElement>('.ask-panel-entry')!
    expect(root.classList.contains('ask-panel-embedded')).toBe(false)
    // docked into the slot: the class lands
    await act(async () => embeddedHandler?.(true))
    expect(root.classList.contains('ask-panel-embedded')).toBe(true)
    // back to floating: it lifts
    await act(async () => embeddedHandler?.(false))
    expect(root.classList.contains('ask-panel-embedded')).toBe(false)
  })

  it('embedded while collapsed wears no class (the pet is never docked chrome)', async () => {
    let embeddedHandler: ((embedded: boolean) => void) | null = null
    const api = panelApi({
      ...overlayChannels({ width: 400, collapsed: true, petPos: null }),
      onAskPanelEmbedded: (handler: (embedded: boolean) => void) => {
        embeddedHandler = handler
        return () => {
          embeddedHandler = null
        }
      },
    })
    await mountEntry(api)
    const root = container!.querySelector<HTMLElement>('.ask-panel-entry')!
    await act(async () => embeddedHandler?.(true))
    expect(root.classList.contains('ask-panel-embedded')).toBe(false)
  })

  it('the broadcast flips the shape with the view, both ways', async () => {
    await mountEntry(panelApi(overlayChannels({ width: 400, collapsed: true, petPos: null })))
    expect(container!.querySelector('.ask-panel-panel')!.hasAttribute('hidden')).toBe(true)
    await act(async () => dockChangedHandler!({ width: 400, collapsed: false, petPos: null }))
    expect(container!.querySelector('.ask-panel-panel')!.hasAttribute('hidden')).toBe(false)
    expect(
      container!.querySelector('.ask-panel-entry')!.classList.contains('ask-panel-pet-only'),
    ).toBe(false)
    await act(async () => dockChangedHandler!({ width: 400, collapsed: true, petPos: null }))
    expect(container!.querySelector('.ask-panel-panel')!.hasAttribute('hidden')).toBe(true)
  })

  it("the pet-only pet's click expands the drawer, the expanded pet's collapses it", async () => {
    await mountEntry(panelApi(overlayChannels({ width: 400, collapsed: true, petPos: null })))
    const pet = container!.querySelector<HTMLButtonElement>('.ai-pet')!
    await act(async () => pet.click())
    expect(setAiDock).toHaveBeenCalledWith({ collapsed: false })
    // the optimistic flip: the tree is already the drawer, broadcast pending
    expect(container!.querySelector('.ask-panel-panel')!.hasAttribute('hidden')).toBe(false)
    setAiDock.mockClear()
    await act(async () => dockChangedHandler!({ width: 400, collapsed: false, petPos: null }))
    const petAgain = container!.querySelector<HTMLButtonElement>('.ai-pet')!
    await act(async () => petAgain.click())
    expect(setAiDock).toHaveBeenCalledWith({ collapsed: true })
  })

  it('a failed toggle write rolls the optimistic flip back', async () => {
    // the optimistic flip renders the drawer into a pet-sized view — if the
    // write fails, that is a panel crammed into the pet's rect, and only the
    // rollback keeps the tree honest (guarded: a broadcast that landed in
    // the meantime is the truth, whatever it says)
    await mountEntry(panelApi(overlayChannels({ width: 400, collapsed: true, petPos: null })))
    const pet = container!.querySelector<HTMLButtonElement>('.ai-pet')!
    setAiDock.mockImplementationOnce(() => Promise.reject(new Error('store gone')))
    // a synchronous act: the rejection is still a pending microtask, so the
    // optimistic flip is what renders
    act(() => pet.click())
    expect(setAiDock).toHaveBeenCalledWith({ collapsed: false })
    expect(container!.querySelector('.ask-panel-panel')!.hasAttribute('hidden')).toBe(false)
    await act(async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve()
    })
    // the rejected write rolled the flip back: pet-only again
    expect(container!.querySelector('.ask-panel-panel')!.hasAttribute('hidden')).toBe(true)
    expect(
      container!.querySelector('.ask-panel-entry')!.classList.contains('ask-panel-pet-only'),
    ).toBe(true)
  })
})

describe("the pet-only pet's drag (home:ai-pet-drag)", () => {
  /** the entry mounted pet-only, with the surface reports recorded */
  const petOnly = async (): Promise<{
    pet: HTMLButtonElement
    reports: Array<Record<string, unknown>>
    /** simulate the window-wide surface landing (its resize event) */
    surface: () => void
    /** the pet's live inline position, the drag's own truth */
    petAt: () => { left: string; top: string }
  }> => {
    const reports: Array<Record<string, unknown>> = []
    await mountEntry(
      panelApi({
        ...overlayChannels({ width: 400, collapsed: true, petPos: null }),
        aiPetDrag: (report: Record<string, unknown>) => {
          reports.push(report)
        },
      }),
    )
    const pet = container!.querySelector<HTMLButtonElement>('.ai-pet')!
    return {
      pet,
      reports,
      surface: () => window.dispatchEvent(new Event('resize')),
      petAt: () => ({ left: pet.style.left, top: pet.style.top }),
    }
  }

  const press = (pet: HTMLButtonElement, x = 30, y = 30): void => {
    pet.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: x, clientY: y }),
    )
  }

  const move = (x: number, y: number): void => {
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y }))
  }

  const release = (): void => {
    window.dispatchEvent(new MouseEvent('pointerup'))
  }

  it('the synthetic model: a fixed client trajectory lands the pet exactly at pointer − grab', async () => {
    // CDP/assistive input dispatches fixed viewport coordinates that do not
    // shift when the view changes — on the static window-wide surface those
    // coordinates ARE the intended window positions, so the pet lands at
    // trajectory − grab with no accumulation to compound
    const { pet, reports, surface, petAt } = await petOnly()
    await act(async () => {
      press(pet, 30, 30)
      // under the slop: the press that precedes a click
      move(33, 31)
      // past it: the surface is requested, and the move itself is gated off
      // (it still carries the pet-sized view's frame)
      move(60, 45)
    })
    expect(petAt()).toEqual({ left: '0px', top: '0px' })
    // the surface landed: every client position is window-true now
    await act(async () => {
      surface()
      move(130, 115)
    })
    expect(petAt()).toEqual({ left: '100px', top: '85px' })
    await act(async () => move(230, 215))
    expect(petAt()).toEqual({ left: '200px', top: '185px' })
    await act(async () => release())
    // only the surface transitions ride the channel — never a position
    expect(reports).toEqual([{ start: true }, { end: true }])
    // the release commits through the ordinary prefs write (Home's pet's
    // contract), in petPos's own chrome space
    expect(setAiDock).toHaveBeenCalledWith({ petPos: { x: 200, y: 185 } })
  })

  it('the real-user model: a live pointer tracks 1:1, back and forth, exactly', async () => {
    // a real pointer's client coordinates are measured against the view it
    // is over — and the surface is the whole window and never moves, so
    // they are its window positions too: the two input models produce the
    // same stream by construction, and the wiggle below (out, back, out
    // again) must track exactly in both
    const { pet, reports, surface, petAt } = await petOnly()
    await act(async () => {
      press(pet, 40, 40)
      move(46, 43)
      surface()
    })
    await act(async () => move(140, 140))
    expect(petAt()).toEqual({ left: '100px', top: '100px' })
    await act(async () => move(90, 90))
    expect(petAt()).toEqual({ left: '50px', top: '50px' })
    await act(async () => move(540, 440))
    expect(petAt()).toEqual({ left: '500px', top: '400px' })
    await act(async () => release())
    expect(reports).toEqual([{ start: true }, { end: true }])
    expect(setAiDock).toHaveBeenCalledWith({ petPos: { x: 500, y: 400 } })
  })

  it('clamps a drag that would carry the pet off the window', async () => {
    // the shared clamp (PET_SIZE, the renderer viewport = the window) — the
    // stored value is the clamped one, like Home's pet commits
    const { pet, surface } = await petOnly()
    await act(async () => {
      press(pet, 30, 30)
      move(60, 45)
      surface()
      // far past the bottom-right corner of the 1024×768 test viewport
      move(2000, 2000)
      release()
    })
    expect(setAiDock).toHaveBeenCalledWith({
      petPos: { x: 1024 - PET_SIZE.width, y: 768 - PET_SIZE.height },
    })
  })

  it('the pure math at 1 / 1.25 / 1.5: petPos lands at start + delta/scale, the RENDERED position tracks the cursor 1:1', () => {
    // petPos is zoomed-chrome space (window = petPos × scale — see
    // AiDockPrefs.petPos), so a pointer moving Δ window px moves petPos by
    // Δ/scale: the STORED number shrinks by the scale while the pet's
    // on-screen position follows the cursor exactly — reading petPos as a
    // window-space number is the classic misread this test pins against.
    // Verified against this Electron build with a live probe: clientX is
    // viewport px and a chrome-space left/top renders at chrome × scale, for
    // real pointers (Chromium reports the viewport position) and synthetic
    // input (CDP dispatches viewport DIP) alike — both input models produce
    // the same client stream, so one formula serves both.
    const grab = { x: 30, y: 20 }
    const start = { x: 120, y: 90 }
    const delta = { x: 200, y: 150 }
    for (const scale of [1, 1.25, 1.5]) {
      const petWindowStart = { x: start.x * scale, y: start.y * scale }
      // the client position IS the pointer's window position (both models)
      const pointer = {
        x: petWindowStart.x + grab.x + delta.x,
        y: petWindowStart.y + grab.y + delta.y,
      }
      const pos = petDragPosition(pointer, grab, scale, { width: 1024, height: 768 })
      // the stored value is chrome-space: start + delta/scale, rounded
      expect(pos.x).toBe(Math.round(start.x + delta.x / scale))
      expect(pos.y).toBe(Math.round(start.y + delta.y / scale))
      // and the rendered window position (pos × scale) tracks the pointer's
      // travel to the whole-px rounding of the shared clamp
      expect(Math.abs(pos.x * scale - (petWindowStart.x + delta.x))).toBeLessThanOrEqual(scale / 2)
      expect(Math.abs(pos.y * scale - (petWindowStart.y + delta.y))).toBeLessThanOrEqual(scale / 2)
    }
  })

  it('the pure math clamps at the chrome viewport rails at a non-default scale too', () => {
    // the caller passes the viewport already divided by the zoom (the chrome
    // viewport), so the rails judge in chrome px whatever the scale — the
    // clamp itself never multiplies or divides
    expect(
      petDragPosition({ x: 4000, y: 3000 }, { x: 0, y: 0 }, 1.25, { width: 1024, height: 768 }),
    ).toEqual({ x: 1024 - PET_SIZE.width, y: 768 - PET_SIZE.height })
    expect(
      petDragPosition({ x: -40, y: -40 }, { x: 0, y: 0 }, 1, { width: 200, height: 150 }),
    ).toEqual({
      x: 0,
      y: 0,
    })
  })

  it('a press without a move is a click: no surface, the drawer expands', async () => {
    const { pet, reports } = await petOnly()
    await act(async () => {
      press(pet)
      release()
      // jsdom does not synthesize the click a real browser would
      pet.click()
    })
    expect(reports).toEqual([])
    expect(setAiDock).toHaveBeenCalledWith({ collapsed: false })
  })

  it('the trailing click of a real drag toggles nothing', async () => {
    const { pet, surface } = await petOnly()
    await act(async () => {
      press(pet)
      move(60, 45)
      surface()
      move(130, 115)
      release()
    })
    expect(setAiDock).toHaveBeenCalledTimes(1)
    expect(setAiDock).toHaveBeenCalledWith({ petPos: { x: 100, y: 85 } })
  })

  it('a lost gesture (the window blurred mid-drag) commits where it stands', async () => {
    const { pet, surface, reports } = await petOnly()
    await act(async () => {
      press(pet)
      move(60, 45)
      surface()
      move(130, 115)
      // the release will never arrive: end the gesture where it stands
      window.dispatchEvent(new Event('blur'))
    })
    expect(reports).toEqual([{ start: true }, { end: true }])
    expect(setAiDock).toHaveBeenCalledWith({ petPos: { x: 100, y: 85 } })
    // a late release after the loss re-commits nothing and toggles nothing
    await act(async () => {
      release()
      pet.click()
    })
    expect(setAiDock).toHaveBeenCalledTimes(1)
  })

  it('the view wrapping the pet again settles the live position back to its origin', async () => {
    // after the release the pet keeps its live position until the view
    // shrinks around it (the settle resize), so the bird never jumps at the
    // hand-off between the drag surface and the pet-only bounds
    const { pet, surface, petAt } = await petOnly()
    await act(async () => {
      press(pet)
      move(60, 45)
      surface()
      move(130, 115)
      release()
    })
    expect(petAt()).toEqual({ left: '100px', top: '85px' })
    await act(async () => window.dispatchEvent(new Event('resize')))
    expect(petAt()).toEqual({ left: '0px', top: '0px' })
  })

  it('the drag only arms with the surface channel: a stale preload keeps the pet click-only', async () => {
    await mountEntry(panelApi(overlayChannels({ width: 400, collapsed: true, petPos: null })))
    const pet = container!.querySelector<HTMLButtonElement>('.ai-pet')!
    await act(async () => {
      press(pet)
      move(60, 45)
      release()
    })
    // nothing moved, nothing committed — and the pet still toggles
    expect(pet.style.left).toBe('0px')
    expect(setAiDock).not.toHaveBeenCalled()
    await act(async () => pet.click())
    expect(setAiDock).toHaveBeenCalledWith({ collapsed: false })
  })

  it('the drag only arms while collapsed: the expanded pet is click-only', async () => {
    const reports: Array<Record<string, unknown>> = []
    await mountEntry(
      panelApi({
        ...overlayChannels(),
        aiPetDrag: (report: Record<string, unknown>) => {
          reports.push(report)
        },
      }),
    )
    const pet = container!.querySelector<HTMLButtonElement>('.ai-pet')!
    await act(async () => {
      press(pet)
      move(60, 45)
      window.dispatchEvent(new Event('resize'))
      move(130, 115)
      release()
    })
    expect(reports).toEqual([])
    expect(setAiDock).not.toHaveBeenCalled()
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

  it('a handoff that arrived while collapsed lands in the composer when the drawer expands', async () => {
    // the handoff is held at the entry while the panel is hidden — parking
    // and focusing a display:none composer is a silent no-op, so the
    // question waits — and lands (draft AND focus) on the expand, which the
    // handoff's own dock-open write triggered
    await mountEntry(panelApi(overlayChannels({ width: 400, collapsed: true, petPos: null })))
    await act(async () =>
      forwardedAskHandler!({ text: 'asked while hidden', seq: 8, origin: 'deep-link' }),
    )
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    // held: nothing parked while the panel cannot show it
    expect(composerDraft()).toBe('')
    // the drawer expands: the handoff lands in the now-visible composer
    await act(async () => dockChangedHandler!({ width: 400, collapsed: false, petPos: null }))
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    // web-supplied text never submits itself: it waits in the draft for Enter
    expect(composerDraft()).toBe('asked while hidden')
    expect(askedMessages()).toEqual([])
    expect(document.activeElement).toBe(container!.querySelector('.kb-ask textarea'))
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
