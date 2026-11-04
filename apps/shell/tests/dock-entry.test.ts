// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { DockEntry, isDockView } from '../src/renderer/src/dock-entry'
import { LocaleProvider } from '../src/renderer/src/locale'
import {
  DOCK_BASE_DEFAULT,
  DOCK_MAX_SCALE_DEFAULT,
  dockCustomId,
  normalizeDockPrefs,
  type DockOpenState,
  type DockPrefs,
} from '../src/shared/dock-prefs'
import { DOCK_BOUNCE_PERIOD_MS } from '../src/renderer/src/dock-math'
import {
  DOCK_ITEM_COUNT,
  DOCK_SEPARATOR_COUNT,
  dockOverlayBounds,
} from '../src/shared/desktop-geometry'
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
/** the dock prefs the mock answers with, and every patch it saw */
let dockPrefsState: DockPrefs = normalizeDockPrefs(undefined)
const dockPrefsPatches: Array<Partial<DockPrefs>> = []
/** the prefs-push handlers the entry subscribed */
const dockPrefsHandlers: Array<(prefs: DockPrefs) => void> = []
/** deliver a prefs push the way main's watcher does */
async function pushDockPrefs(prefs: DockPrefs): Promise<void> {
  dockPrefsState = prefs
  await act(async () => {
    for (const handler of [...dockPrefsHandlers]) handler(prefs)
  })
}
/** the live open-target report the mock answers and pushes */
let dockOpenState: DockOpenState = {
  view: null,
  settings: false,
  plugins: false,
  templates: false,
  ask: false,
}
/** the open-target push handlers the entry subscribed */
const dockOpenHandlers: Array<(state: DockOpenState) => void> = []

/** deliver an open-target report the way main does (a push on the channel) */
async function pushDockOpen(state: DockOpenState): Promise<void> {
  dockOpenState = state
  await act(async () => {
    for (const handler of [...dockOpenHandlers]) handler(state)
  })
}

let root: Root
let container: HTMLDivElement
let readyPings = 0

async function mountEntry(prefs?: DockPrefs): Promise<void> {
  if (prefs) dockPrefsState = prefs
  dockOpenState = { view: null, settings: false, plugins: false, templates: false, ask: false }
  dockOpenHandlers.length = 0
  dockPrefsHandlers.length = 0
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
    // the dock's own prefs + the open-target report (the doc-mode channels)
    getDockPrefs: async () => dockPrefsState,
    setDockPrefs: async (patch: Partial<DockPrefs>) => {
      dockPrefsPatches.push(patch)
      return normalizeDockPrefs({ ...dockPrefsState, ...patch })
    },
    onDockPrefsChanged: (handler: (prefs: DockPrefs) => void) => {
      dockPrefsHandlers.push(handler)
      return () => {
        const index = dockPrefsHandlers.indexOf(handler)
        if (index >= 0) dockPrefsHandlers.splice(index, 1)
      }
    },
    onDockOpen: (handler: (state: DockOpenState) => void) => {
      dockOpenHandlers.push(handler)
      return () => {
        const index = dockOpenHandlers.indexOf(handler)
        if (index >= 0) dockOpenHandlers.splice(index, 1)
      }
    },
    takeDockOpen: async () => dockOpenState,
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
  dockPrefsState = normalizeDockPrefs(undefined)
  dockPrefsPatches.length = 0
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

describe('the dragged-in custom launchers', () => {
  const fileCustom = { id: dockCustomId('file', '/docs/a.md'), kind: 'file', target: '/docs/a.md' }
  const appCustom = { id: dockCustomId('app', 'app:docs'), kind: 'app', target: 'app:docs' }
  const withCustoms = normalizeDockPrefs({ customItems: [fileCustom, appCustom] })

  const dockLabels = (): string[] =>
    [...container.querySelectorAll<HTMLButtonElement>('.dock-item')].map((button) =>
      button.getAttribute('aria-label'),
    )

  it('renders after the coded launchers and before the ask tail: basenames and app words', async () => {
    await mountEntry(withCustoms)
    expect(dockLabels()).toEqual([
      'Desktop',
      'Recent',
      'Starred',
      'Settings',
      'Templates',
      'Plugins',
      'a.md',
      'Docs',
      'Ask AI',
    ])
    // the file custom carries its badge in the carrier tile; the app its
    // squircle, the same registry the desktop's icon reads
    expect(item('a.md').querySelector('.dock-tile-file')?.querySelector('img, svg')).toBeTruthy()
    expect(item('Docs').querySelector('.dock-tile.dock-tile-docs')).toBeTruthy()
  })

  it('a click routes the whole item as a custom intent — Home resolves the verb', async () => {
    await mountEntry(withCustoms)
    await act(async () => item('a.md').click())
    expect(actions).toEqual([{ kind: 'custom', custom: fileCustom }])
  })

  it('the remove (移除) verb drops the definition and its order entry through the prefs write', async () => {
    await mountEntry(withCustoms)
    const contextmenu = (el: Element): void => {
      el.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 560,
        }),
      )
    }
    await act(async () => contextmenu(item('a.md')))
    const entries = [...document.body.querySelectorAll('.dock-menu button')].map(
      (button) => button.textContent,
    )
    expect(entries).toEqual(['Open', 'Remove'])
    const remove = [...document.body.querySelectorAll('.dock-menu button')].at(-1)!
    await act(async () => remove.click())
    expect(dockPrefsPatches).toEqual([{ customItems: [appCustom], order: [appCustom.id] }])
  })

  it('a store push lands a custom live: the watcher broadcast re-renders the pill', async () => {
    await mountEntry()
    expect(item('a.md')).toBeFalsy()
    await pushDockPrefs(withCustoms)
    expect(item('a.md')).toBeTruthy()
    expect(dockLabels()).toContain('Docs')
  })
})

describe('Part A: the dock stays reachable over an open drawer (the stylesheet contract)', () => {
  const css = readFileSync(resolve(__dirname, '../src/renderer/src/home.css'), 'utf8')

  function blockOf(selector: string): string {
    // anchored at a line start: a compound selector's tail (the dark-tone
    // override's `… .dock {`) must not be mistaken for the base rule
    const block = new RegExp(
      `(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*?\\}`,
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

  it('the doc-mode pill is pre-mixed glass: no backdrop sampling, no half-broken glass', () => {
    // backdrop-filter samples this renderer's own backdrop, and over a
    // transparent native view that is nothing (the document behind is a
    // different view) — so the glass is BAKED: the same 46% surface share
    // the Home pill composites live, pre-blended over the wallpaper
    // family's base. One flat color, chromatically honest
    const pill = blockOf('.dock-view .dock')
    expect(pill).toMatch(/background:\s*color-mix\(/)
    expect(pill).toMatch(/var\(--surface\) 46%/)
    expect(pill).toMatch(/color-mix\(in srgb, var\(--bg-content\) 96%, #0f7fff\)/)
    expect(pill).toMatch(/-webkit-backdrop-filter:\s*none\s*;/)
    expect(pill).toMatch(/backdrop-filter:\s*none\s*;/)
  })

  it('the Home pill is real frosted glass: the share, the blur, the sheen', () => {
    // the macOS look: a mid surface share (low enough to transmit the
    // wallpaper's hue, high enough to pastel-ize it — 32% read as a neon
    // bar over colorful wallpapers), a deep blur with only a whisper of
    // saturation, and the top sheen line. The pin holds the constants so a
    // future "fix" cannot quietly turn the glass back into a tinted bar
    const dock = blockOf('.dock')
    expect(dock).toMatch(/--dock-glass-share:\s*46%\s*;/)
    expect(dock).toMatch(/--dock-glass-sheen:\s*rgb\(255 255 255 \/ 25%\)\s*;/)
    expect(dock).toMatch(
      /background:\s*color-mix\(in srgb, var\(--surface\) var\(--dock-glass-share\), transparent\)/,
    )
    expect(dock).toMatch(/-webkit-backdrop-filter:\s*blur\(28px\) saturate\(1\.25\)\s*;/)
    expect(dock).toMatch(/backdrop-filter:\s*blur\(28px\) saturate\(1\.25\)\s*;/)
    // the sheen rides the shadow stack's inset line, ahead of the softened
    // drop shadow; the hairline border stays
    expect(dock).toMatch(/box-shadow:\s*\n?\s*inset 0 1px 0 var\(--dock-glass-sheen\),/)
    expect(dock).toMatch(/0 12px 32px rgb\(0 0 0 \/ 12%\)/)
    expect(dock).toMatch(/border:\s*1px solid/)
    // dark theme dims the sheen (a bright top line glares on dark glass),
    // both the explicit and the system-dark selectors
    const dark = blockOf("[data-theme='dark'] .dock")
    expect(dark).toMatch(/--dock-glass-sheen:\s*rgb\(255 255 255 \/ 18%\)\s*;/)
    const systemDark =
      /:root:not\(\[data-theme='light'\]\):not\(\[data-theme='dark'\]\) \.dock\s*\{[^}]*\}/.exec(
        css,
      )?.[0]
    expect(systemDark, 'the system-dark selector retunes the sheen too').toBeTruthy()
    expect(systemDark ?? '').toMatch(/--dock-glass-sheen:\s*rgb\(255 255 255 \/ 18%\)\s*;/)
  })

  it('the context menu rides the interface scale (chrome px like the pill)', () => {
    // the menu portals to the body — outside the dock's zoomed frame — so
    // its own zoom keeps its CSS px chrome px; the placement math in
    // Dock.tsx divides the viewport anchor by the same scale
    const menu = blockOf('.dock-menu')
    expect(menu).toMatch(/zoom:\s*var\(--ui-scale\)\s*;/)
  })

  it('the bounce keyframes period is pinned to dock-math constant', () => {
    // the steady macOS bounce: dock-math's DOCK_BOUNCE_PERIOD_MS is what
    // the hosts and tests read, and the CSS hard-codes the same number —
    // the two must move together or the contract splits
    const keyframes = /@keyframes dock-bounce\s*\{[^}]*\}/.exec(css)?.[0]
    expect(keyframes, 'the dock-bounce keyframes exist').toBeTruthy()
    expect(css).toMatch(new RegExp(`animation:\\s*dock-bounce\\s+${DOCK_BOUNCE_PERIOD_MS}ms`))
  })

  it('the overlay geometry mirrors the home.css pill chrome exactly', () => {
    // desktop-geometry.ts sizes the native view from home.css's own rules:
    // the padding, the gap, the separator's footprint and the bottom float
    // must agree, or the revealed pill would clip or overshoot its view.
    // The pin parses the stylesheet and re-derives the dock rect from the
    // parsed numbers — the same arithmetic dockOverlayBounds runs.
    const dock = blockOf('.dock')
    const padding = /padding:\s*(\d+)px\s+(\d+)px\s+(\d+)px\s*;/.exec(dock)
    const gap = /gap:\s*(\d+)px\s*;/.exec(dock)
    const border = /border:\s*1px\s+solid/.exec(dock)
    const bottom = /bottom:\s*(\d+)px\s*;/.exec(dock)
    const separator = blockOf('.dock-separator')
    const separatorMargin = /margin:\s*(\d+)px\s+(\d+)px\s*;/.exec(separator)
    const separatorWidth = /width:\s*(\d+)px\s*;/.exec(separator)
    expect(padding, 'the pill padding is the 3-value shorthand').toBeTruthy()
    expect(gap).toBeTruthy()
    expect(border).toBeTruthy()
    expect(bottom).toBeTruthy()
    expect(separatorMargin).toBeTruthy()
    expect(separatorWidth).toBeTruthy()
    // the geometry's constants, re-derived from the parsed CSS: the pill is
    // 22 horizontal + 14 vertical chrome (padding both sides + hairlines),
    // a 7px separator footprint, a 9px float
    const hPad = 2 * Number(padding![2]) + 2
    const vPad = Number(padding![1]) + Number(padding![3]) + 2
    const sep = Number(separatorWidth![1]) + 2 * Number(separatorMargin![2])
    const float = Number(bottom![1])
    // a composition of 7 icons and 2 separators at the default 48 base
    const pillWidth = hPad + DOCK_ITEM_COUNT * DOCK_BASE_DEFAULT + 8 * Number(gap![1]) + 2 * sep
    const pillHeight = DOCK_BASE_DEFAULT + vPad
    const { dock: rect } = dockOverlayBounds(
      { width: 800, height: 600 },
      { itemCount: DOCK_ITEM_COUNT, separatorCount: DOCK_SEPARATOR_COUNT },
    )
    expect(rect.width).toBe(
      Math.round(pillWidth + 2 * (DOCK_MAX_SCALE_DEFAULT - 1) * DOCK_BASE_DEFAULT),
    )
    expect(rect.height).toBe(
      Math.round(pillHeight + float + (DOCK_MAX_SCALE_DEFAULT - 1) * DOCK_BASE_DEFAULT + 28),
    )
  })
})

describe('the running dots (the open-target report)', () => {
  const slotOf = (label: string): Element => item(label).closest('.dock-slot')!

  it('the report lights the launchers whose targets are open; nav dots only for the showing view', async () => {
    await mountEntry()
    await pushDockOpen({
      view: null,
      settings: true,
      plugins: false,
      templates: true,
      ask: false,
    })
    expect(slotOf('Settings').querySelector('.dock-dot')).not.toBeNull()
    expect(slotOf('Templates').querySelector('.dock-dot')).not.toBeNull()
    expect(slotOf('Plugins').querySelector('.dock-dot')).toBeNull()
    // doc mode: no Home view is showing, so no nav dot
    for (const label of ['Desktop', 'Recent', 'Starred']) {
      expect(slotOf(label).querySelector('.dock-dot')).toBeNull()
    }
    // the plugins pane as the modal's open section lights its own tile
    await pushDockOpen({
      view: 'recent',
      settings: true,
      plugins: true,
      templates: false,
      ask: false,
    })
    expect(slotOf('Plugins').querySelector('.dock-dot')).not.toBeNull()
    expect(slotOf('Recent').querySelector('.dock-dot')).not.toBeNull()
  })

  it('the mount pull adopts the cached report (subscribe-then-pull)', async () => {
    // the entry subscribes before pulling, so a report cached in main lands
    // even before the first push — set the cache, then mount
    await act(async () => root.unmount())
    container.remove()
    dockOpenState = { view: null, settings: true, plugins: false, templates: false, ask: true }
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () =>
      root.render(
        createElement(LocaleProvider, { initial: 'en', children: createElement(DockEntry) }),
      ),
    )
    expect(item('Ask AI').closest('.dock-slot')!.querySelector('.dock-dot')).not.toBeNull()
    expect(item('Settings').closest('.dock-slot')!.querySelector('.dock-dot')).not.toBeNull()
  })
})

describe('the ask item launch bounce', () => {
  it('bounces from the click until the drawer reports open', async () => {
    await mountEntry()
    const tile = (): Element | null => item('Ask AI').querySelector('.dock-tile')
    await act(async () => item('Ask AI').click())
    expect(setAiDock).toHaveBeenCalledWith({ collapsed: false })
    expect(tile()!.className).toContain('dock-bouncing')
    // the drawer opened (Home reports, main pushes): ready
    await pushDockOpen({ view: null, settings: false, plugins: false, templates: false, ask: true })
    expect(tile()!.className).not.toContain('dock-bouncing')
  })

  it('a second click on the bouncing tile cancels the demand', async () => {
    await mountEntry()
    await act(async () => item('Ask AI').click())
    await act(async () => item('Ask AI').click())
    expect(item('Ask AI').querySelector('.dock-tile')!.className).not.toContain('dock-bouncing')
    // both clicks still wrote the drawer open verb
    expect(setAiDock).toHaveBeenCalledTimes(2)
  })
})

describe('the right-click menus', () => {
  const contextmenu = (el: Element): void => {
    el.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 120,
        clientY: 560,
      }),
    )
  }
  const menuEntries = (): string[] =>
    [...document.body.querySelectorAll('.dock-menu button')].map((button) => button.textContent)

  it('a closed target offers only the bring-forward verb; an open one adds close', async () => {
    await mountEntry()
    await act(async () => contextmenu(item('Settings')))
    expect(menuEntries()).toEqual(['Open'])
    await act(async () => contextmenu(item('Settings')))
    await pushDockOpen({ view: null, settings: true, plugins: false, templates: false, ask: false })
    await act(async () => contextmenu(item('Settings')))
    expect(menuEntries()).toEqual(['Open', 'Close tab'])
  })

  it('the close verb routes a close intent, not a settings launch', async () => {
    await mountEntry()
    await pushDockOpen({ view: null, settings: true, plugins: false, templates: false, ask: false })
    await act(async () => contextmenu(item('Settings')))
    const close = [...document.body.querySelectorAll('.dock-menu button')].at(-1)!
    await act(async () => close.click())
    expect(actions).toEqual([{ kind: 'close', target: 'settings' }])
  })

  it('the ask item offers the drawer verb, flipping with its state', async () => {
    await mountEntry()
    await act(async () => contextmenu(item('Ask AI')))
    expect(menuEntries()).toEqual(['Open drawer'])
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    await pushDockOpen({ view: null, settings: false, plugins: false, templates: false, ask: true })
    await act(async () => contextmenu(item('Ask AI')))
    expect(menuEntries()).toEqual(['Collapse drawer'])
    // choosing it collapses the drawer through the prefs write
    await act(async () => document.body.querySelector('.dock-menu button')!.click())
    expect(setAiDock).toHaveBeenCalledWith({ collapsed: true })
  })

  it('nav items carry the switch verb alone', async () => {
    await mountEntry()
    await act(async () => contextmenu(item('Recent')))
    expect(menuEntries()).toEqual(['Recent'])
    await act(async () => document.body.querySelector('.dock-menu button')!.click())
    expect(actions).toEqual([{ kind: 'nav', view: 'recent' }])
  })
})

describe('the reveal pin (the menu holds the dock open)', () => {
  const contextmenu = (el: Element): void => {
    el.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 120,
        clientY: 560,
      }),
    )
  }

  it('a leave while the menu is open is deferred, delivered when it closes with the pointer gone', async () => {
    await mountEntry()
    const surface = container.querySelector<HTMLElement>('.dock-entry')!
    const pill = container.querySelector<HTMLElement>('.dock')!
    await act(async () => surface.dispatchEvent(new MouseEvent('pointerenter')))
    // the menu opens: the dock is pinned
    await act(async () => contextmenu(item('Settings')))
    // the pointer leaves the pill for the menu above it: no report yet
    await act(async () => pill.dispatchEvent(new MouseEvent('pointerleave')))
    expect(hotEdge).toEqual([{ enter: true }])
    // the menu closes with the pointer outside the dock: the deferred leave
    // joins the stream, and main hides the dock the usual way
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(hotEdge).toEqual([{ enter: true }, { leave: true }])
  })

  it('a pointer that returns before the menu closes swallows the deferred leave', async () => {
    await mountEntry()
    const surface = container.querySelector<HTMLElement>('.dock-entry')!
    const pill = container.querySelector<HTMLElement>('.dock')!
    await act(async () => surface.dispatchEvent(new MouseEvent('pointerenter')))
    await act(async () => contextmenu(item('Settings')))
    await act(async () => pill.dispatchEvent(new MouseEvent('pointerleave')))
    // back over the pill before the menu closes
    await act(async () => pill.dispatchEvent(new MouseEvent('pointerenter')))
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    // the re-enter already cancelled any hide; no leave was ever owed
    expect(hotEdge).toEqual([{ enter: true }, { enter: true }])
  })
})

describe('the ask launch bounce (already-open guard)', () => {
  it('an already-open drawer is a bring-forward: no bounce', async () => {
    await mountEntry()
    await pushDockOpen({ view: null, settings: false, plugins: false, templates: false, ask: true })
    await act(async () => item('Ask AI').click())
    expect(item('Ask AI').querySelector('.dock-tile')!.className).not.toContain('dock-bouncing')
    // the drawer verb still wrote
    expect(setAiDock).toHaveBeenCalledWith({ collapsed: false })
  })
})

describe('the cloud launcher (login-gated, doc-mode intent)', () => {
  it('is absent while the account is signed out', async () => {
    await mountEntry()
    expect(item('Genspark Projects')).toBeUndefined()
  })

  it('appears signed in, routes the cloud nav intent, and carries the running dot', async () => {
    await mountEntry()
    // the report's loggedIn gate mounts the eighth launcher
    await pushDockOpen({
      view: 'cloud',
      settings: false,
      plugins: false,
      templates: false,
      ask: false,
      loggedIn: true,
    })
    const cloud = item('Genspark Projects')
    expect(cloud).toBeTruthy()
    // the running dot: the cloud view is the showing one
    expect(cloud.closest('.dock-slot')!.querySelector('.dock-dot')).not.toBeNull()
    // the click routes through the dock-action intent (nav cloud)
    await act(async () => cloud.click())
    expect(actions).toEqual([{ kind: 'nav', view: 'cloud' }])
    // the context menu's verb routes the same intent
    await act(async () => {
      cloud.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 560,
        }),
      )
    })
    await act(async () => document.body.querySelector('.dock-menu button')!.click())
    expect(actions).toEqual([
      { kind: 'nav', view: 'cloud' },
      { kind: 'nav', view: 'cloud' },
    ])
  })
})
