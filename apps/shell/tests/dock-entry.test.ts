// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { DockEntry, isDockView } from '../src/renderer/src/dock-entry'
import { LocaleProvider } from '../src/renderer/src/locale'
import type { DockNavIntent } from '../src/shared/home-api'

/**
 * The dock's standalone mount (src/renderer/src/dock-entry.tsx, the shell
 * renderer at ?view=dock): the surface the doc-mode native overlay loads —
 * only the dock, transparent, reporting the pointer's transitions over
 * `home:dock-hot-edge` so main grows the strip into the dock, and routing
 * the clicks (`home:dock-action` for nav and launchers, the prefs write for
 * the ask tail). Deliberately no panel-entry logic: no ready ping, no prefs
 * subscription. The layering pin at the foot asserts Part A's contract from
 * the stylesheet itself: the dock sits above the drawer's scrim (the open
 * drawer must not swallow dock input) and below the pet.
 */

/** the routed dock actions the mock face recorded */
const actions: DockNavIntent[] = []
/** the hot-edge reports the mock face recorded */
const hotEdge: Array<Record<string, unknown>> = []
const setAiDock = vi.fn(async () => undefined)

let root: Root
let container: HTMLDivElement
let readyPings = 0

async function mountEntry(): Promise<void> {
  window.aiOffice = {
    dockHotEdge: (report: Record<string, unknown>) => {
      hotEdge.push(report)
    },
    dockAction: async (intent: DockNavIntent) => {
      actions.push(intent)
    },
    setAiDock,
    // the ask panel's ready channel: this entry must never touch it
    askPanelReady: () => {
      readyPings++
    },
  } as unknown as Window['aiOffice']
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      createElement(LocaleProvider, { initial: 'en', children: createElement(DockEntry) }),
    ),
  )
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  actions.length = 0
  hotEdge.length = 0
  readyPings = 0
  setAiDock.mockClear()
  await mountEntry()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.documentElement.classList.remove('dock-view')
  vi.unstubAllGlobals()
})

/** the dock item carrying this label */
function item(label: string): HTMLButtonElement {
  return [...container.querySelectorAll<HTMLButtonElement>('.dock-item')].find(
    (button) => button.getAttribute('aria-label') === label,
  )!
}

describe('isDockView', () => {
  it('answers true only for the dock view param', () => {
    expect(isDockView('?view=dock')).toBe(true)
    expect(isDockView('?view=dock&lang=en')).toBe(true)
    expect(isDockView('?view=ask-panel')).toBe(false)
    expect(isDockView('?mode=help')).toBe(false)
    expect(isDockView('')).toBe(false)
  })
})

describe('the surface', () => {
  it('renders only the dock: no panel, no pet, no workbench', () => {
    expect(container.querySelectorAll('.dock-item')).toHaveLength(7)
    expect(container.querySelector('.kb-ask')).toBeNull()
    expect(container.querySelector('.ai-pet')).toBeNull()
    expect(container.querySelector('.app-frame')).toBeNull()
    expect(container.querySelector('.sidebar')).toBeNull()
  })

  it('never pings the ask panel ready handshake', () => {
    // the buffered-message handshake is the ask panel entry's contract; a
    // stray ping from this surface would arm the drawer overlay's flush for
    // a renderer that has nothing listening
    expect(readyPings).toBe(0)
  })

  it('the html carries the transparent dock-view class', () => {
    expect(document.documentElement.classList.contains('dock-view')).toBe(true)
  })
})

describe('the hot-edge reports', () => {
  it('pointer enter and leave on the root report over the channel', async () => {
    const surface = container.querySelector<HTMLElement>('.dock-entry')!
    await act(async () => {
      surface.dispatchEvent(new MouseEvent('pointerenter'))
      surface.dispatchEvent(new MouseEvent('pointerleave'))
    })
    expect(hotEdge).toEqual([{ enter: true }, { leave: true }])
  })

  it('the pill itself reports enter and leave (the painted box, not just the root)', async () => {
    const pill = container.querySelector<HTMLElement>('.dock')!
    await act(async () => {
      pill.dispatchEvent(new MouseEvent('pointerenter'))
      pill.dispatchEvent(new MouseEvent('pointerleave'))
    })
    expect(hotEdge).toEqual([{ enter: true }, { leave: true }])
  })

  it('a leave from the pill reports while the root still holds the pointer (the margin case)', async () => {
    // the revealed rect is deliberately larger than the pill (fisheye
    // headroom + tooltip room, see dockOverlayBounds): a pointer idling in
    // the transparent margin must read as off the dock, not hold it open —
    // the pill's own pointerleave is that report, the root's stays the
    // fallback for a pointer that exits the whole rect without ever
    // touching the pill
    const surface = container.querySelector<HTMLElement>('.dock-entry')!
    const pill = container.querySelector<HTMLElement>('.dock')!
    await act(async () => {
      surface.dispatchEvent(new MouseEvent('pointerenter'))
      pill.dispatchEvent(new MouseEvent('pointerenter'))
      pill.dispatchEvent(new MouseEvent('pointerleave'))
    })
    // the root never left: only the pill's reports landed
    expect(hotEdge).toEqual([{ enter: true }, { enter: true }, { leave: true }])
  })

  it('a stale preload without the channel keeps the surface alive', async () => {
    await act(async () => root.unmount())
    container.remove()
    window.aiOffice = {} as unknown as Window['aiOffice']
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () =>
      root.render(
        createElement(LocaleProvider, { initial: 'en', children: createElement(DockEntry) }),
      ),
    )
    const surface = container.querySelector<HTMLElement>('.dock-entry')!
    await act(async () => surface.dispatchEvent(new MouseEvent('pointerenter')))
    // the strip stays the strip forever: no report, never a crash
    expect(container.querySelector('.dock')).toBeTruthy()
  })
})

describe('the routed clicks', () => {
  it('the nav items route their view intents', async () => {
    await act(async () => item('Desktop').click())
    await act(async () => item('Recent').click())
    await act(async () => item('Starred').click())
    expect(actions).toEqual([
      { kind: 'nav', view: 'desktop' },
      { kind: 'nav', view: 'recent' },
      { kind: 'nav', view: 'starred' },
    ])
  })

  it('the launchers route settings (both sections) and templates', async () => {
    await act(async () => item('Settings').click())
    await act(async () => item('Templates').click())
    await act(async () => item('Plugins').click())
    expect(actions).toEqual([
      { kind: 'settings', section: 'general' },
      { kind: 'templates' },
      { kind: 'settings', section: 'plugins' },
    ])
  })

  it('the ask item writes the drawer open prefs, routing nothing', async () => {
    await act(async () => item('Ask AI').click())
    expect(setAiDock).toHaveBeenCalledWith({ collapsed: false })
    expect(actions).toEqual([])
  })
})

describe('Part A: the dock stays reachable over an open drawer (the stylesheet contract)', () => {
  const css = readFileSync(resolve(__dirname, '../src/renderer/src/home.css'), 'utf8')

  function blockOf(selector: string): string {
    const block = new RegExp(
      `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*?\\}`,
    ).exec(css)?.[0]
    expect(block, `${selector} has a rule block`).toBeTruthy()
    return block ?? ''
  }

  function zIndexOf(selector: string): number {
    const z = /z-index:\s*(\d+)\s*;/.exec(blockOf(selector))?.[1]
    expect(z, `${selector} carries a z-index`).toBeTruthy()
    return Number(z)
  }

  it('the dock sits above the drawer whole context (scrim and panel), below the pet', () => {
    const dock = zIndexOf('.dock')
    const drawer = zIndexOf('.ai-drawer')
    const pet = zIndexOf('.ai-pet')
    // the open drawer's full-window mask must not swallow dock input; the
    // pet remains the drawer's own topmost affordance
    expect(dock).toBeGreaterThan(drawer)
    expect(dock).toBeLessThan(pet)
    // and clear of the first-run overlays (star prompt 60, modal 70)
    expect(dock).toBeLessThan(60)
  })

  it('the entry root covers the whole viewport in both shapes (the hot strip contract)', () => {
    // verified live the hard way: a root that does not cover the strip's 3px
    // hit-tests nothing (elementFromPoint over it returns null), the
    // hot-edge report never fires and the dock never reveals — while the
    // native view still swallows those 3px of document clicks. Hit-testing
    // needs geometry, not pixels, so the pin is the geometry itself: fixed
    // at the viewport's origin, stretched by the longhand insets AND sized
    // by the vw/vh pair (belt and braces — each covers the other), with
    // html/body filling the viewport behind it. jsdom lays nothing out, so
    // the stylesheet is the honest place to pin the contract; the live
    // elementFromPoint re-run is the final proof
    const root = blockOf('.dock-entry')
    expect(root).toMatch(/position:\s*fixed\s*;/)
    for (const side of ['top', 'left', 'right', 'bottom']) {
      expect(root).toMatch(new RegExp(`${side}:\\s*0\\s*;`))
    }
    expect(root).toMatch(/width:\s*100vw\s*;/)
    expect(root).toMatch(/height:\s*100vh\s*;/)
    // the interface scale: the entry opts into the chrome's zoom (the ask
    // panel's contract), so the pill's CSS px are chrome px and the native
    // rect math and the painted pill agree at every scale
    expect(root).toMatch(/zoom:\s*var\(--ui-scale\)\s*;/)
    // the grouped selector (html + body share the block)
    const fill = /html\.dock-view,\s*html\.dock-view body\s*\{[^}]*\}/.exec(css)?.[0]
    expect(fill, 'html.dock-view / body share a fill rule block').toBeTruthy()
    expect(fill ?? '').toMatch(/height:\s*100%\s*;/)
    expect(fill ?? '').toMatch(/background:\s*transparent\s*;/)
  })

  it('the doc-mode pill is opaque: the glass cannot frost over a transparent view', () => {
    // backdrop-filter samples this renderer's own backdrop, and over a
    // transparent native view that is nothing (the document behind is a
    // different view) — the glass would render as a bare translucent tint
    // over live text, so the entry pins the pill to the surface token with
    // the filter off (Home's own glass is untouched)
    const pill = blockOf('.dock-view .dock')
    expect(pill).toMatch(/background:\s*var\(--surface\)\s*;/)
    expect(pill).toMatch(/-webkit-backdrop-filter:\s*none\s*;/)
    expect(pill).toMatch(/backdrop-filter:\s*none\s*;/)
  })
})
