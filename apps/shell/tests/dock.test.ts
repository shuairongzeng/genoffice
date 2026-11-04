// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { Dock, type DockItem } from '../src/renderer/src/Dock'
import {
  DOCK_DEFAULT_MAX_SCALE,
  DOCK_DEFAULT_SIGMA_RATIO,
  DOCK_DRAG_IDLE_MS,
  dockSlotWidth,
  fisheyeScale,
} from '../src/renderer/src/dock-math'

/** a minimal icon node: the component renders whatever the host passes */
const icon = (): React.JSX.Element => createElement('svg')

/**
 * The dock component (src/renderer/src/Dock.tsx): the launcher contract —
 * groups and separators, tooltips, the active indicator dot, click routing —
 * and the gesture layer's performance shape. jsdom lays out nothing
 * (getBoundingClientRect is all zeros), so the slot geometry is stubbed per
 * test and requestAnimationFrame is replaced with a manual queue the test
 * flushes: the fisheye's numbers themselves are pinned in dock-math.test.ts,
 * these tests pin that the component measures once per enter, writes only
 * (never reads) per frame, coalesces moves into one frame, and stands down
 * through the 120ms collapse on leave — and that a window resize or a
 * mid-session reduce-motion flip stands the gesture down cleanly (the
 * matchMedia stub gives the flip test a controllable media query).
 */

let root: Root
let container: HTMLDivElement

/** the manual rAF queue: the test flushes frames when it chooses */
let rafQueue: FrameRequestCallback[] = []
let rafId = 0

const threeItems = (): DockItem[] => [
  { id: 'recent', label: 'Recent', icon: icon(), onSelect: vi.fn() },
  { id: 'starred', label: 'Starred', icon: icon(), onSelect: vi.fn() },
  { id: 'ask', label: 'Ask AI', icon: icon(), onSelect: vi.fn() },
]

async function mountDock(props: Partial<Parameters<typeof Dock>[0]> = {}): Promise<void> {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      createElement(Dock, {
        groups: [threeItems()],
        ariaLabel: 'Dock',
        ...props,
      } as Parameters<typeof Dock>[0]),
    ),
  )
}

/** re-render the mounted dock with fresh props (the FLIP's second pass) */
async function rerenderDock(props: Partial<Parameters<typeof Dock>[0]> = {}): Promise<void> {
  await act(async () =>
    root.render(
      createElement(Dock, {
        groups: [threeItems()],
        ariaLabel: 'Dock',
        ...props,
      } as Parameters<typeof Dock>[0]),
    ),
  )
}

/**
 * The row's "layout" for FLIP tests: jsdom lays out nothing (offsetLeft is
 * 0 everywhere), so the property is answered from a live map keyed the way
 * the dock keys its row children (`slot:<itemId>` / `sep:<groupIndex>`) —
 * the test edits the map between passes to move the "layout". The getter is
 * defined on the prototype, the only place jsdom carries it, and restored
 * whole afterwards.
 */
function stubRowLefts(): { lefts: Map<string, number>; restore: () => void } {
  const lefts = new Map<string, number>()
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetLeft')!
  Object.defineProperty(HTMLElement.prototype, 'offsetLeft', {
    get(this: HTMLElement): number {
      const key =
        this.dataset?.itemId !== undefined
          ? `slot:${this.dataset.itemId}`
          : this.dataset?.sep !== undefined
            ? `sep:${this.dataset.sep}`
            : undefined
      return key === undefined ? ((original.get?.call(this) as number) ?? 0) : (lefts.get(key) ?? 0)
    },
    configurable: true,
  })
  return {
    lefts,
    restore: () => Object.defineProperty(HTMLElement.prototype, 'offsetLeft', original),
  }
}

/** patch each slot's rect with a synthetic base geometry, macOS pitch apart */
function stubSlots(widths: number[], left = 100): void {
  const slots = [...container.querySelectorAll<HTMLElement>('.dock-slot')]
  expect(slots.length).toBe(widths.length)
  let x = left
  slots.forEach((slot, index) => {
    const rect = {
      left: x,
      right: x + widths[index],
      width: widths[index],
      top: 0,
      bottom: 48,
      height: 48,
    }
    Object.defineProperty(slot, 'getBoundingClientRect', { value: () => rect, configurable: true })
    x += widths[index]
  })
}

/** the slot's center under the stubbed geometry */
const centerX = (index: number, pitch = 48, left = 100): number => left + index * pitch + pitch / 2

const dispatch = (type: string, x?: number): void => {
  const dockEl = container.querySelector<HTMLElement>('.dock')!
  dockEl.dispatchEvent(new MouseEvent(type, { bubbles: type === 'pointermove', clientX: x ?? 0 }))
}

const flushFrames = async (): Promise<void> => {
  const queue = rafQueue
  rafQueue = []
  await act(async () => {
    queue.forEach((cb) => cb(performance.now()))
  })
}

const slotWidths = (): string[] =>
  [...container.querySelectorAll<HTMLElement>('.dock-slot')].map((slot) => slot.style.width)

const slotAt = (index: number): HTMLElement =>
  [...container.querySelectorAll<HTMLElement>('.dock-slot')][index]!

const itemAt = (index: number): HTMLElement =>
  [...container.querySelectorAll<HTMLElement>('.dock-item')][index]!

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  rafQueue = []
  rafId = 0
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    rafQueue.push(cb)
    return ++rafId
  })
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('the launcher contract', () => {
  it('renders the groups with separators between them, never before the first', async () => {
    await mountDock({
      groups: [threeItems().slice(0, 2), threeItems().slice(2)],
    })
    expect(container.querySelectorAll('.dock-item')).toHaveLength(3)
    expect(container.querySelectorAll('.dock-separator')).toHaveLength(1)
  })

  it('carries the label as the tooltip and the a11y name', async () => {
    await mountDock()
    const item = itemAt(0)
    expect(item.getAttribute('data-tip')).toBe('Recent')
    expect(item.getAttribute('aria-label')).toBe('Recent')
    expect(container.querySelector('.dock')!.getAttribute('role')).toBe('toolbar')
    expect(container.querySelector('.dock')!.getAttribute('aria-label')).toBe('Dock')
  })

  it('the active item carries the indicator dot and aria-current; others none', async () => {
    const items = threeItems()
    items[1] = { ...items[1], active: true }
    await mountDock({ groups: [items] })
    // the dot rides the slot (outside the magnified button — see Dock.tsx)
    expect(slotAt(1).querySelector('.dock-dot')).not.toBeNull()
    expect(itemAt(1).getAttribute('aria-current')).toBe('true')
    expect(slotAt(0).querySelector('.dock-dot')).toBeNull()
    expect(itemAt(0).getAttribute('aria-current')).toBeNull()
  })

  it('routes a click to its item handler, mid-magnification included', async () => {
    const items = threeItems()
    await mountDock({ groups: [items] })
    stubSlots([48, 48, 48])
    dispatch('pointerenter')
    dispatch('pointermove', centerX(1))
    await flushFrames()
    // magnified, not resting — and still clickable
    expect(slotWidths()[1]).not.toBe('')
    await act(async () => itemAt(2).click())
    expect(items[2].onSelect).toHaveBeenCalledTimes(1)
    expect(items[0].onSelect).not.toHaveBeenCalled()
  })

  it('the pillRef prop hands the host the pill element, kept live through the mount', async () => {
    const pillRef = { current: null as HTMLElement | null }
    await mountDock({ pillRef })
    expect(pillRef.current).toBe(container.querySelector('.dock'))
    await act(async () => root.unmount())
    expect(pillRef.current).toBeNull()
  })

  it('a re-render never detaches the pillRef: the callback is stable, no null window', async () => {
    // an inline ref closure would churn identity per render, and React
    // answers with old(null) then new(node) — a window where the host's
    // drop hit-test would read a null ref. The memoized callback keeps the
    // handle live across every re-render, composition changes included.
    const pillRef = { current: null as HTMLElement | null }
    await mountDock({ pillRef })
    const node = pillRef.current
    expect(node).toBeTruthy()
    const extra: DockItem = { id: 'extra', label: 'Extra', icon: icon(), onSelect: vi.fn() }
    await rerenderDock({ pillRef, groups: [[...threeItems(), extra]] })
    expect(pillRef.current).toBe(node)
    await rerenderDock({ pillRef, baseSize: 56 })
    expect(pillRef.current).toBe(node)
  })
})

describe('the fisheye gesture layer', () => {
  it('magnifies by actual slot width: the peak at the pointer, falloff beside it', async () => {
    await mountDock()
    stubSlots([48, 48, 48])
    dispatch('pointerenter')
    dispatch('pointermove', centerX(1))
    await flushFrames()
    const sigma = DOCK_DEFAULT_SIGMA_RATIO * 48
    const beside = fisheyeScale(48, { maxScale: DOCK_DEFAULT_MAX_SCALE, sigma })
    expect(slotWidths()).toEqual([
      `${dockSlotWidth(48, beside)}px`,
      `${dockSlotWidth(48, DOCK_DEFAULT_MAX_SCALE)}px`,
      `${dockSlotWidth(48, beside)}px`,
    ])
    // the icon's transform carries the same scale, anchored bottom center
    expect(itemAt(1).style.transform).toBe(`scale(${DOCK_DEFAULT_MAX_SCALE})`)
    expect(itemAt(1).style.transformOrigin).toBe('')
  })

  it('coalesces moves into one frame: two moves, one application', async () => {
    await mountDock()
    stubSlots([48, 48, 48])
    dispatch('pointerenter')
    dispatch('pointermove', centerX(0))
    dispatch('pointermove', centerX(2))
    // still exactly one scheduled frame for both moves
    expect(rafQueue).toHaveLength(1)
    await flushFrames()
    // the frame applied the LATEST position only
    expect(slotWidths()[2]).not.toBe('')
    expect(rafQueue).toHaveLength(0)
  })

  it('leaves through the collapse: inline widths cleared, transition class on', async () => {
    await mountDock()
    stubSlots([48, 48, 48])
    dispatch('pointerenter')
    dispatch('pointermove', centerX(1))
    await flushFrames()
    expect(slotWidths()[1]).not.toBe('')
    const dockEl = container.querySelector('.dock')!
    dispatch('pointerleave')
    expect(dockEl.classList.contains('dock-collapsing')).toBe(true)
    expect(slotWidths()).toEqual(['', '', ''])
    expect(itemAt(1).style.transform).toBe('')
  })

  it('re-enters mid-collapse by snapping to rest before measuring', async () => {
    // a leave mid-transition leaves the class behind; the re-entry must drop
    // it (the snap is instant, not transitioned) and re-measure the base
    // geometry — the centers may not describe a half-magnified layout
    await mountDock()
    stubSlots([48, 48, 48])
    dispatch('pointerenter')
    dispatch('pointermove', centerX(1))
    await flushFrames()
    dispatch('pointerleave')
    dispatch('pointerenter')
    const dockEl = container.querySelector('.dock')!
    expect(dockEl.classList.contains('dock-collapsing')).toBe(false)
    expect(slotWidths()).toEqual(['', '', ''])
    // and the fresh gesture works against the snapped geometry
    dispatch('pointermove', centerX(0))
    await flushFrames()
    expect(slotWidths()[0]).toBe(`${dockSlotWidth(48, DOCK_DEFAULT_MAX_SCALE)}px`)
  })

  it('reduced motion is a static dock: no magnification, no listeners', async () => {
    await mountDock({ reducedMotion: true })
    stubSlots([48, 48, 48])
    dispatch('pointerenter')
    dispatch('pointermove', centerX(1))
    await flushFrames()
    expect(slotWidths()).toEqual(['', '', ''])
    expect(rafQueue).toHaveLength(0)
  })

  it('a window resize invalidates the gesture: snaps to rest, re-measures next enter', async () => {
    await mountDock()
    stubSlots([48, 48, 48])
    dispatch('pointerenter')
    dispatch('pointermove', centerX(1))
    await flushFrames()
    expect(slotWidths()[1]).not.toBe('')
    // the window resized under the dock: the measured centers went stale
    window.dispatchEvent(new Event('resize'))
    expect(slotWidths()).toEqual(['', '', ''])
    // the centers are gone: a move without a fresh enter must not magnify
    dispatch('pointermove', centerX(1))
    await flushFrames()
    expect(slotWidths()).toEqual(['', '', ''])
    // the next enter re-measures the new geometry and the gesture works
    dispatch('pointerenter')
    dispatch('pointermove', centerX(0))
    await flushFrames()
    expect(slotWidths()[0]).toBe(`${dockSlotWidth(48, DOCK_DEFAULT_MAX_SCALE)}px`)
  })

  it('follows a mid-session flip of the OS reduce-motion setting', async () => {
    let matches = false
    const listeners = new Set<(event: { matches: boolean }) => void>()
    const query = {
      get matches() {
        return matches
      },
      addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => {
        listeners.add(listener)
      },
      removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => {
        listeners.delete(listener)
      },
    }
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => query),
    )
    await mountDock()
    stubSlots([48, 48, 48])
    dispatch('pointerenter')
    dispatch('pointermove', centerX(1))
    await flushFrames()
    expect(slotWidths()[1]).not.toBe('')
    // reduce motion enabled with the dock open: the gesture layer stands
    // down without a remount, and snaps to rest rather than freezing
    // magnified with no listener left to collapse it
    matches = true
    await act(async () => {
      for (const listener of [...listeners]) listener({ matches: true })
    })
    expect(slotWidths()).toEqual(['', '', ''])
    dispatch('pointermove', centerX(1))
    expect(rafQueue).toHaveLength(0)
    // and back off: the gesture layer re-arms and magnifies again
    matches = false
    await act(async () => {
      for (const listener of [...listeners]) listener({ matches: false })
    })
    dispatch('pointerenter')
    dispatch('pointermove', centerX(1))
    await flushFrames()
    expect(slotWidths()[1]).toBe(`${dockSlotWidth(48, DOCK_DEFAULT_MAX_SCALE)}px`)
  })
})

describe('the squircle tiles and indicators', () => {
  it('a tile item wraps its glyph in the colored rounded-square', async () => {
    const items = threeItems()
    items[0] = { ...items[0], tile: 'ask' }
    await mountDock({ groups: [items] })
    const tile = itemAt(0).querySelector('.dock-tile')!
    expect(tile.className).toBe('dock-tile dock-tile-ask')
    expect(tile.querySelector('svg')).toBeTruthy()
    // an item without a tile keeps the bare line icon
    expect(itemAt(1).querySelector('.dock-tile')).toBeNull()
  })

  it('the running dot shows without the active flag, and both flags share one dot', async () => {
    const items = threeItems()
    items[0] = { ...items[0], running: true }
    items[1] = { ...items[1], active: true, running: true }
    await mountDock({ groups: [items] })
    expect(slotAt(0).querySelector('.dock-dot')).not.toBeNull()
    expect(slotAt(1).querySelectorAll('.dock-dot')).toHaveLength(1)
    expect(slotAt(2).querySelector('.dock-dot')).toBeNull()
  })

  it('the bouncing item bounces; reduce motion refuses the class', async () => {
    const items = threeItems()
    items[0] = { ...items[0], tile: 'ask' }
    await mountDock({ groups: [items], bouncing: 'recent' })
    expect(itemAt(0).querySelector('.dock-tile')!.className).toContain('dock-bouncing')
    // a fresh mount under reduced motion renders no bounce at all
    await act(async () => root.unmount())
    container.remove()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () =>
      root.render(
        createElement(Dock, {
          groups: [items],
          ariaLabel: 'Dock',
          bouncing: 'recent',
          reducedMotion: true,
        } as Parameters<typeof Dock>[0]),
      ),
    )
    expect(itemAt(0).querySelector('.dock-tile')!.className).not.toContain('dock-bouncing')
  })
})

describe('the magnification preference', () => {
  it('magnify false is a static dock by choice, like reduced motion', async () => {
    await mountDock({ magnify: false })
    stubSlots([48, 48, 48])
    dispatch('pointerenter')
    dispatch('pointermove', centerX(1))
    await flushFrames()
    expect(slotWidths()).toEqual(['', '', ''])
    expect(rafQueue).toHaveLength(0)
  })
})

describe('the context menu', () => {
  const menuItems = (): DockItem[] => [
    {
      id: 'recent',
      label: 'Recent',
      icon: icon(),
      menu: [
        { label: 'Show', onSelect: vi.fn() },
        { label: 'Close tab', onSelect: vi.fn(), danger: true },
      ],
      onSelect: vi.fn(),
    },
    { id: 'starred', label: 'Starred', icon: icon(), onSelect: vi.fn() },
  ]

  const contextmenu = (el: Element, x = 120, y = 560): void => {
    el.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }),
    )
  }

  it('right-click opens the verbs above the dock, portal-rendered at the body level', async () => {
    const items = menuItems()
    await mountDock({ groups: [items] })
    await act(async () => contextmenu(itemAt(0)))
    const menu = document.body.querySelector('.dock-menu')!
    expect(menu.getAttribute('role')).toBe('menu')
    // the menu escapes the transformed pill (its fixed coordinates must
    // not be captured by the dock's translate)
    expect(container.contains(menu)).toBe(false)
    // placed by the layout effect, flipped above the pointer
    expect(menu.style.left).toMatch(/px$/)
    expect(menu.style.top).toMatch(/px$/)
    const entries = [...menu.querySelectorAll('button')]
    expect(entries.map((entry) => entry.textContent)).toEqual(['Show', 'Close tab'])
    expect(entries[1]!.className).toContain('danger')
    // an item without a menu offers none
    await act(async () => contextmenu(itemAt(1)))
    expect(document.body.querySelectorAll('.dock-menu')).toHaveLength(1)
  })

  it('choosing a verb runs it and closes the menu', async () => {
    const items = menuItems()
    await mountDock({ groups: [items] })
    await act(async () => contextmenu(itemAt(0)))
    const entries = [...document.body.querySelectorAll('.dock-menu button')]
    await act(async () => entries[0]!.click())
    expect(items[0]!.menu![0]!.onSelect).toHaveBeenCalledTimes(1)
    expect(items[0]!.menu![1]!.onSelect).not.toHaveBeenCalled()
    expect(document.body.querySelector('.dock-menu')).toBeNull()
  })

  it('Escape closes, and a press outside closes', async () => {
    const items = menuItems()
    await mountDock({ groups: [items] })
    await act(async () => contextmenu(itemAt(0)))
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(document.body.querySelector('.dock-menu')).toBeNull()
    // reopen, then a pointer press outside the menu dismisses it
    await act(async () => contextmenu(itemAt(0)))
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(document.body.querySelector('.dock-menu')).toBeNull()
  })

  it('the interaction pin reports open and closed with the menu', async () => {
    const onInteractionChange = vi.fn()
    const items = menuItems()
    await mountDock({ groups: [items], onInteractionChange })
    onInteractionChange.mockClear()
    await act(async () => contextmenu(itemAt(0)))
    expect(onInteractionChange).toHaveBeenLastCalledWith(true)
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(onInteractionChange).toHaveBeenLastCalledWith(false)
  })
})

describe('drag-to-reorder', () => {
  // jsdom has no pointer capture API: the drag layer's calls are stubbed
  beforeEach(() => {
    Element.prototype.setPointerCapture = () => undefined
    Element.prototype.releasePointerCapture = () => undefined
  })

  const dispatchOn = (el: Element, type: string, x: number, buttons = 1): void => {
    el.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        button: 0,
        buttons,
      }),
    )
  }

  const rootEl = (): HTMLElement => container.querySelector<HTMLElement>('.dock')!

  const itemIds = (): string[] =>
    [...rootEl().querySelectorAll<HTMLElement>('.dock-slot')].map((slot) => slot.dataset.itemId!)

  it('a horizontal drag swaps past a neighbor and commits the order', async () => {
    const onReorder = vi.fn()
    await mountDock({ onReorder })
    stubSlots([48, 48, 48])
    // the pointer grabs the first item and travels past the neighbor
    await act(async () => dispatchOn(slotAt(0), 'pointerdown', centerX(0)))
    await act(async () => dispatchOn(rootEl(), 'pointermove', centerX(1)))
    expect(rootEl().classList.contains('dock-drag-live')).toBe(true)
    expect(itemIds()).toEqual(['starred', 'recent', 'ask'])
    await act(async () => dispatchOn(rootEl(), 'pointerup', centerX(1)))
    expect(onReorder).toHaveBeenCalledWith(['starred', 'recent', 'ask'])
    // the drag ended: the pill leaves the live-arrangement mode
    expect(rootEl().classList.contains('dock-drag-live')).toBe(false)
  })

  it('a sub-threshold wiggle stays a click; the drag suppresses the release click', async () => {
    const items = threeItems()
    await mountDock({ groups: [items] })
    stubSlots([48, 48, 48])
    const onSelect = items[0].onSelect
    // a 2px wiggle never begins a drag, and the click fires as usual
    await act(async () => dispatchOn(slotAt(0), 'pointerdown', centerX(0)))
    await act(async () => dispatchOn(rootEl(), 'pointermove', centerX(0) + 2))
    await act(async () => dispatchOn(rootEl(), 'pointerup', centerX(0) + 2))
    await act(async () => itemAt(0).click())
    expect(onSelect).toHaveBeenCalledTimes(1)
    // a real drag: the release synthesizes no click of its own
    const onReorder = vi.fn()
    await act(async () =>
      root.render(
        createElement(Dock, {
          groups: [threeItems()],
          ariaLabel: 'Dock',
          onReorder,
        } as Parameters<typeof Dock>[0]),
      ),
    )
    await act(async () => dispatchOn(slotAt(0), 'pointerdown', centerX(0)))
    await act(async () => dispatchOn(rootEl(), 'pointermove', centerX(2)))
    await act(async () => dispatchOn(rootEl(), 'pointerup', centerX(2)))
    expect(onReorder).toHaveBeenCalledTimes(1)
    for (const item of threeItems()) expect(item.onSelect).not.toHaveBeenCalled()
  })

  it('the group boundary refuses a cross-group drop: separators never move', async () => {
    const onReorder = vi.fn()
    await mountDock({
      groups: [threeItems().slice(0, 2), threeItems().slice(2)],
      onReorder,
    })
    stubSlots([48, 48, 48])
    // drag the first item over the second GROUP (past the separator)
    await act(async () => dispatchOn(slotAt(0), 'pointerdown', centerX(0)))
    await act(async () => dispatchOn(rootEl(), 'pointermove', centerX(2)))
    await act(async () => dispatchOn(rootEl(), 'pointerup', centerX(2)))
    expect(onReorder).not.toHaveBeenCalled()
    expect(itemIds()).toEqual(['recent', 'starred', 'ask'])
  })

  it('the arrangement persists through the order prop and the gesture re-measures it', async () => {
    const onReorder = vi.fn()
    await mountDock({ onReorder })
    stubSlots([48, 48, 48])
    await act(async () => dispatchOn(slotAt(0), 'pointerdown', centerX(0)))
    await act(async () => dispatchOn(rootEl(), 'pointermove', centerX(1)))
    await act(async () => dispatchOn(rootEl(), 'pointerup', centerX(1)))
    expect(onReorder).toHaveBeenCalledWith(['starred', 'recent', 'ask'])
    // the host persisted it and the prop flows back: the new arrangement
    // renders, and a fresh gesture measures ITS geometry (stubbed at a new
    // left so stale centers would point at nothing)
    await act(async () =>
      root.render(
        createElement(Dock, {
          groups: [threeItems()],
          ariaLabel: 'Dock',
          order: ['starred', 'recent', 'ask'],
        } as Parameters<typeof Dock>[0]),
      ),
    )
    expect(itemIds()).toEqual(['starred', 'recent', 'ask'])
    stubSlots([48, 48, 48], 200)
    dispatch('pointerenter')
    // the pointer sits on the SECOND slot (recent, the dragged item's new
    // neighbor arrangement) — only fresh centers magnify it to the peak
    dispatch('pointermove', centerX(1, 48, 200))
    await flushFrames()
    expect(slotWidths()[1]).toBe(`${dockSlotWidth(48, DOCK_DEFAULT_MAX_SCALE)}px`)
  })

  it('a drag pins the interaction (the doc-mode reveal holder)', async () => {
    const onInteractionChange = vi.fn()
    await mountDock({ onInteractionChange })
    stubSlots([48, 48, 48])
    onInteractionChange.mockClear()
    await act(async () => dispatchOn(slotAt(0), 'pointerdown', centerX(0)))
    await act(async () => dispatchOn(rootEl(), 'pointermove', centerX(1)))
    expect(onInteractionChange).toHaveBeenLastCalledWith(true)
    await act(async () => dispatchOn(rootEl(), 'pointerup', centerX(1)))
    expect(onInteractionChange).toHaveBeenLastCalledWith(false)
  })
})

describe('drag abandonment and scale tracking', () => {
  beforeEach(() => {
    Element.prototype.setPointerCapture = () => undefined
    Element.prototype.releasePointerCapture = () => undefined
  })

  const dispatchOn = (el: Element, type: string, x: number, buttons = 1): void => {
    el.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        button: 0,
        buttons,
      }),
    )
  }

  const rootEl = (): HTMLElement => container.querySelector<HTMLElement>('.dock')!

  it('the tile follows the pointer in the pill chrome space (uiScale 1.5)', async () => {
    // the interface scale: the pill's CSS px are chrome px, so the viewport
    // delta lands in that space through chromeScale — without the division
    // the tile outruns the pointer at every scale above 1
    document.documentElement.style.setProperty('--ui-scale', '1.5')
    try {
      await mountDock()
      stubSlots([48, 48, 48])
      await act(async () => dispatchOn(slotAt(0), 'pointerdown', centerX(0)))
      // a 48 viewport-px travel past the neighbor: 48 / 1.5 = 32 chrome px
      await act(async () => dispatchOn(rootEl(), 'pointermove', centerX(0) + 48))
      const dragged = rootEl().querySelector<HTMLElement>('[data-item-id="recent"] .dock-item')!
      expect(dragged.style.transform).toBe('translateX(32px) scale(1.06)')
      await act(async () => dispatchOn(rootEl(), 'pointerup', centerX(0) + 48))
    } finally {
      document.documentElement.style.removeProperty('--ui-scale')
    }
  })

  it('a move with no buttons drops the stale press: no phantom drag', async () => {
    const onReorder = vi.fn()
    await mountDock({ onReorder })
    stubSlots([48, 48, 48])
    // the press, then a move whose buttons read 0 (a release that landed
    // elsewhere, or a pointer that came back without a button)
    await act(async () => dispatchOn(slotAt(0), 'pointerdown', centerX(0)))
    await act(async () => dispatchOn(rootEl(), 'pointermove', centerX(1), 0))
    expect(rootEl().classList.contains('dock-drag-live')).toBe(false)
    expect(onReorder).not.toHaveBeenCalled()
    // and the stale state is gone: a later real move does not resurrect it
    await act(async () => dispatchOn(rootEl(), 'pointermove', centerX(1)))
    expect(rootEl().classList.contains('dock-drag-live')).toBe(false)
  })

  it('a press forgotten on leave never drags: the leave clears the press', async () => {
    const onReorder = vi.fn()
    await mountDock({ onReorder })
    stubSlots([48, 48, 48])
    await act(async () => dispatchOn(slotAt(0), 'pointerdown', centerX(0)))
    // the pointer left the pill before any threshold: the press is void
    await act(async () => {
      rootEl().dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: null }))
    })
    await act(async () => dispatchOn(rootEl(), 'pointermove', centerX(1)))
    expect(rootEl().classList.contains('dock-drag-live')).toBe(false)
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('the drag ends without a commit when the pointer leaves the pill', async () => {
    const onReorder = vi.fn()
    await mountDock({ onReorder })
    stubSlots([48, 48, 48])
    await act(async () => dispatchOn(slotAt(0), 'pointerdown', centerX(0)))
    await act(async () => dispatchOn(rootEl(), 'pointermove', centerX(1)))
    expect(rootEl().classList.contains('dock-drag-live')).toBe(true)
    // the pointer crossed into another native view: no pointerup will ever
    // arrive here — the leave ends the arrangement where it stands
    await act(async () => {
      rootEl().dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: null }))
    })
    expect(rootEl().classList.contains('dock-drag-live')).toBe(false)
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('the inactivity failsafe ends an abandoned drag (no pointerup ever comes)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const onReorder = vi.fn()
      await mountDock({ onReorder })
      stubSlots([48, 48, 48])
      await act(async () => dispatchOn(slotAt(0), 'pointerdown', centerX(0)))
      await act(async () => dispatchOn(rootEl(), 'pointermove', centerX(1)))
      expect(rootEl().classList.contains('dock-drag-live')).toBe(true)
      // the pointer crossed out of the renderer without a leave: quiet for
      // the failsafe window, the drag ends itself
      await act(async () => {
        vi.advanceTimersByTime(DOCK_DRAG_IDLE_MS)
      })
      expect(rootEl().classList.contains('dock-drag-live')).toBe(false)
      expect(onReorder).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a drag mid-magnification measures the REST geometry, not the magnified one', async () => {
    // a live stub: each slot's rect is computed at READ time from the
    // current inline widths, so the magnified layout — and the snap that
    // clears it — are both visible to the measurement
    const stubLive = (): void => {
      const slots = [...container.querySelectorAll<HTMLElement>('.dock-slot')]
      slots.forEach((slot, index) => {
        Object.defineProperty(slot, 'getBoundingClientRect', {
          value: () => {
            let left = 100
            for (let i = 0; i < index; i += 1) {
              left += Number.parseFloat(slots[i]!.style.width) || 48
            }
            const width = Number.parseFloat(slot.style.width) || 48
            return { left, right: left + width, width, top: 0, bottom: 48, height: 48 }
          },
          configurable: true,
        })
      })
    }
    const onReorder = vi.fn()
    await mountDock({ onReorder })
    stubLive()
    // magnify at the middle slot: its width grows to 82 and shifts the rest
    dispatch('pointerenter')
    dispatch('pointermove', centerX(1))
    await flushFrames()
    expect(slotWidths()[1]).not.toBe('')
    // drag the LAST slot: with rest centers it travels from 220; against
    // the magnified layout it would start from 254 (the grown neighbor
    // shifted it) — the snap must feed the measurement the rest geometry
    await act(async () => dispatchOn(slotAt(2), 'pointerdown', 244))
    await act(async () => dispatchOn(rootEl(), 'pointermove', 260))
    const dragged = rootEl().querySelector<HTMLElement>('[data-item-id="ask"] .dock-item')!
    expect(dragged.style.transform).toBe('translateX(40px) scale(1.06)')
    await act(async () => dispatchOn(rootEl(), 'pointerup', 260))
  })
})

describe('the menu anchoring (the item rect, the keyboard, the view)', () => {
  const menuEl = (): HTMLElement => document.body.querySelector<HTMLElement>('.dock-menu')!

  const openMenu = async (
    keyboard: boolean,
    itemRect: { top: number; left: number; width: number },
    menuSize: { width: number; height: number },
    view: { width: number; height: number },
  ): Promise<void> => {
    const button = itemAt(0)
    Object.defineProperty(button, 'getBoundingClientRect', {
      value: () => ({
        top: itemRect.top,
        left: itemRect.left,
        right: itemRect.left + itemRect.width,
        bottom: itemRect.top + 40,
        width: itemRect.width,
        height: 40,
      }),
      configurable: true,
    })
    await act(async () => {
      button.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: keyboard ? 0 : 160,
          clientY: keyboard ? 0 : 560,
        }),
      )
    })
    const menu = menuEl()
    Object.defineProperty(menu, 'offsetWidth', { value: menuSize.width, configurable: true })
    Object.defineProperty(menu, 'offsetHeight', { value: menuSize.height, configurable: true })
    // force the placement effect to re-run with the stubbed sizes
    await act(async () => {
      button.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: keyboard ? 0 : 160,
          clientY: keyboard ? 0 : 560,
        }),
      )
    })
    Object.defineProperty(menu, 'offsetWidth', { value: menuSize.width, configurable: true })
    Object.defineProperty(menu, 'offsetHeight', { value: menuSize.height, configurable: true })
    void view
  }

  /** stub the viewport the placement clamps into */
  const stubViewport = (width: number, height: number): void => {
    Object.defineProperty(document.documentElement, 'clientWidth', {
      value: width,
      configurable: true,
    })
    Object.defineProperty(window, 'innerHeight', { value: height, configurable: true })
  }

  afterEach(() => {
    // jsdom's real (zero) geometry back for the other tests
    Object.defineProperty(document.documentElement, 'clientWidth', {
      value: 0,
      configurable: true,
    })
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true })
  })

  it('anchors above the item inside the doc-mode overlay rect (no pointer clamp)', async () => {
    // the overlay view's own viewport: 463 wide, 133 tall (the dock rect),
    // the item near the bottom like the real pill
    stubViewport(463, 133)
    const items = threeItems()
    items[0] = { ...items[0], menu: [{ label: 'Show', onSelect: vi.fn() }] }
    await mountDock({ groups: [items] })
    await openMenu(
      false,
      { top: 90, left: 100, width: 48 },
      { width: 160, height: 44 },
      {
        width: 463,
        height: 133,
      },
    )
    const menu = menuEl()
    // above the item's top, and inside the view — the headroom band the
    // rect reserves above the pill is exactly this room
    expect(Number.parseFloat(menu.style.top)).toBe(90 - 44)
    expect(Number.parseFloat(menu.style.top)).toBeGreaterThanOrEqual(0)
    expect(Number.parseFloat(menu.style.left)).toBeGreaterThanOrEqual(0)
    expect(Number.parseFloat(menu.style.left)).toBeLessThanOrEqual(463 - 160)
  })

  it('the keyboard contextmenu (no pointer coords) anchors to the focused item', async () => {
    stubViewport(800, 600)
    const items = threeItems()
    items[0] = { ...items[0], menu: [{ label: 'Show', onSelect: vi.fn() }] }
    await mountDock({ groups: [items] })
    // Shift+F10 / the Menu key: clientX and clientY both 0; the item sits
    // low enough that the menu must flip above it
    await openMenu(
      true,
      { top: 560, left: 200, width: 48 },
      { width: 160, height: 44 },
      {
        width: 800,
        height: 600,
      },
    )
    const menu = menuEl()
    // horizontally at the item's center, not at the viewport's 0
    expect(Number.parseFloat(menu.style.left)).toBe(200 + 48 / 2)
    expect(Number.parseFloat(menu.style.top)).toBe(560 - 44)
  })
})

describe('the parting FLIP (a composition change parts the row)', () => {
  // jsdom has no pointer capture API: the drag-start path's calls are stubbed
  beforeEach(() => {
    Element.prototype.setPointerCapture = () => undefined
    Element.prototype.releasePointerCapture = () => undefined
  })

  const dispatchOn = (el: Element, type: string, x: number, buttons = 1): void => {
    el.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, button: 0, buttons }),
    )
  }
  const rootEl = (): HTMLElement => container.querySelector<HTMLElement>('.dock')!
  const slotOf = (id: string): HTMLElement =>
    container.querySelector<HTMLElement>(`.dock-slot[data-item-id="${id}"]`)!

  /** the newcomer that parts the row, landing between recent and starred */
  const custom = (): DockItem => ({ id: 'custom', label: 'a.md', icon: icon(), onSelect: vi.fn() })
  const rowWithCustom = (): DockItem[] => {
    const items = threeItems()
    return [items[0]!, custom(), items[1]!, items[2]!]
  }

  let lefts: Map<string, number>
  let restoreLefts: () => void
  beforeEach(() => {
    const stub = stubRowLefts()
    lefts = stub.lefts
    restoreLefts = stub.restore
  })
  afterEach(() => restoreLefts())

  /** the md-pitch layout of the base row, before the insert */
  const seedBaseRow = (): void => {
    lefts.set('slot:recent', 0)
    lefts.set('slot:starred', 48)
    lefts.set('slot:ask', 96)
  }
  /** the same row with the newcomer landed between recent and starred */
  const seedPartedRow = (): void => {
    lefts.set('slot:recent', 0)
    lefts.set('slot:custom', 48)
    lefts.set('slot:starred', 96)
    lefts.set('slot:ask', 144)
  }

  it('an insert slides the outrun slots and pops the newcomer', async () => {
    seedBaseRow()
    await mountDock()
    seedPartedRow()
    await rerenderDock({ groups: [rowWithCustom()] })
    // the FLIP's starting transforms: the outrun slots paint where they
    // were, the untouched slot stays, the newcomer pops (never slides)
    expect(slotOf('recent').style.transform).toBe('')
    expect(slotOf('starred').style.transform).toBe('translateX(-48px)')
    expect(slotOf('ask').style.transform).toBe('translateX(-48px)')
    expect(slotOf('custom').style.transform).toBe('')
    expect(slotOf('custom').classList.contains('dock-slot-entering')).toBe(true)
    // the next frame carries them home
    await flushFrames()
    expect(slotOf('starred').style.transform).toBe('')
    expect(slotOf('starred').style.transition).toContain('transform 250ms')
    expect(slotOf('custom').style.transition).toBe('')
  })

  it('a removal closes the gap the same way: the tail slides, nothing pops', async () => {
    seedPartedRow()
    await mountDock({ groups: [rowWithCustom()] })
    seedBaseRow()
    await rerenderDock()
    expect(slotOf('starred').style.transform).toBe('translateX(48px)')
    expect(slotOf('ask').style.transform).toBe('translateX(48px)')
    expect(container.querySelectorAll('.dock-slot-entering')).toHaveLength(0)
  })

  it('the fisheye stands down while the row parts; the settle clears it and re-arms', async () => {
    // only the timers fake (the drag-idle test's pattern): the rAF queue is
    // this suite's own manual stub and must stay real
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      seedBaseRow()
      await mountDock()
      seedPartedRow()
      await rerenderDock({ groups: [rowWithCustom()] })
      stubSlots([48, 48, 48, 48])
      // mid-parting: the gesture layer is disarmed — a hover magnifies
      // nothing (its measured centers would fight the mid-flight slots)
      dispatch('pointerenter')
      dispatch('pointermove', centerX(1))
      await flushFrames()
      expect(slotWidths().every((width) => width === '')).toBe(true)
      // the settle timer: the inline styles drop, the pop ends
      await act(async () => {
        vi.advanceTimersByTime(310)
      })
      expect(slotOf('starred').style.transform).toBe('')
      expect(slotOf('starred').style.transition).toBe('')
      expect(slotOf('custom').classList.contains('dock-slot-entering')).toBe(false)
      // the fisheye re-armed: the same hover now magnifies
      dispatch('pointerenter')
      dispatch('pointermove', centerX(1))
      await flushFrames()
      expect(slotWidths()[1]).not.toBe('')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reduced motion inserts instantly: no slide, no pop', async () => {
    seedBaseRow()
    await mountDock({ reducedMotion: true })
    seedPartedRow()
    await rerenderDock({ groups: [rowWithCustom()], reducedMotion: true })
    expect(slotOf('starred').style.transform).toBe('')
    expect(slotOf('ask').style.transform).toBe('')
    expect(slotOf('custom').classList.contains('dock-slot-entering')).toBe(false)
  })

  it('a drag in flight owns the arrangement: its composition changes never part', async () => {
    seedBaseRow()
    await mountDock()
    stubSlots([48, 48, 48])
    // a drag begins (threshold crossed, the pointer captured on the pill)
    await act(async () => dispatchOn(slotOf('recent'), 'pointerdown', centerX(0)))
    await act(async () => dispatchOn(rootEl(), 'pointermove', centerX(0) + 10))
    // an insert lands while the drag runs: instant, the same snap the
    // drag's own live swaps take
    seedPartedRow()
    await rerenderDock({ groups: [rowWithCustom()] })
    expect(slotOf('starred').style.transform).toBe('')
    expect(slotOf('custom').classList.contains('dock-slot-entering')).toBe(false)
  })
})

describe('the drag-over insert preview (the gap that opens before the drop)', () => {
  // the dock's three fixed groups: nav | launchers | ask — the preview lives
  // in the launchers group only
  const groups = (): readonly (readonly DockItem[])[] => [
    [threeItems()[0]!, threeItems()[1]!],
    [
      { id: 'settings', label: 'Settings', icon: icon(), onSelect: vi.fn() },
      { id: 'templates', label: 'Templates', icon: icon(), onSelect: vi.fn() },
      { id: 'plugins', label: 'Plugins', icon: icon(), onSelect: vi.fn() },
    ],
    [threeItems()[2]!],
  ]

  /** the launchers' slot DOM indices: after the two nav slots */
  const spacer = (): HTMLElement | null =>
    container.querySelector<HTMLElement>('.dock-slot-preview')
  /** every dock-slot in DOM order, the spacer included (it carries the class) */
  const slotOrder = (): string[] =>
    [...container.querySelectorAll<HTMLElement>('.dock-slot')].map(
      (slot) => slot.dataset.itemId ?? 'PREVIEW',
    )
  const onInsertPreview = vi.fn()

  beforeEach(async () => {
    onInsertPreview.mockClear()
    await mountDock({ groups: groups(), onInsertPreview })
    // the launchers' slots sit at DOM indices 2..4 under the stubbed pitch
    stubSlots([48, 48, 48, 48, 48, 48])
  })

  it('reports null while no drag is over the pill, and no spacer renders', async () => {
    expect(onInsertPreview).toHaveBeenCalledWith(null)
    expect(spacer()).toBeNull()
  })

  it('a pointer between two centers opens the gap between them', async () => {
    // centers: settings 220, templates 268, plugins 316
    await rerenderDock({ groups: groups(), onInsertPreview, insertPreview: 250 })
    expect(onInsertPreview).toHaveBeenLastCalledWith(1)
    expect(slotOrder()).toEqual([
      'recent',
      'starred',
      'settings',
      'PREVIEW',
      'templates',
      'plugins',
      'ask',
    ])
  })

  it('the gap follows the pointer: a new x moves it, the report follows', async () => {
    await rerenderDock({ groups: groups(), onInsertPreview, insertPreview: 250 })
    await rerenderDock({ groups: groups(), onInsertPreview, insertPreview: 300 })
    expect(onInsertPreview).toHaveBeenLastCalledWith(2)
    expect(slotOrder()).toEqual([
      'recent',
      'starred',
      'settings',
      'templates',
      'PREVIEW',
      'plugins',
      'ask',
    ])
  })

  it('before the first center the gap opens at the group head, past the last before the ask separator', async () => {
    await rerenderDock({ groups: groups(), onInsertPreview, insertPreview: 0 })
    expect(onInsertPreview).toHaveBeenLastCalledWith(0)
    expect(slotOrder()).toEqual([
      'recent',
      'starred',
      'PREVIEW',
      'settings',
      'templates',
      'plugins',
      'ask',
    ])
    await rerenderDock({ groups: groups(), onInsertPreview, insertPreview: 5000 })
    expect(onInsertPreview).toHaveBeenLastCalledWith(3)
    expect(slotOrder()).toEqual([
      'recent',
      'starred',
      'settings',
      'templates',
      'plugins',
      'PREVIEW',
      'ask',
    ])
    // the boundary holds: no preview ever lands in the nav or the ask group
    const ids = slotOrder().filter((id) => id !== 'PREVIEW')
    expect(ids.slice(0, 2)).toEqual(['recent', 'starred'])
    expect(ids.at(-1)).toBe('ask')
  })

  it('the preview ends: the spacer unmounts and the report goes null', async () => {
    await rerenderDock({ groups: groups(), onInsertPreview, insertPreview: 250 })
    expect(spacer()).toBeTruthy()
    await rerenderDock({ groups: groups(), onInsertPreview, insertPreview: null })
    expect(onInsertPreview).toHaveBeenLastCalledWith(null)
    expect(spacer()).toBeNull()
  })

  it('the fisheye stands down while the preview is live: no magnification under the carried icon', async () => {
    await rerenderDock({ groups: groups(), onInsertPreview, insertPreview: 250 })
    dispatch('pointerenter')
    dispatch('pointermove', centerX(3))
    await flushFrames()
    expect(slotWidths().every((width) => width === '')).toBe(true)
  })

  it('a held-button move disarms an armed fisheye (the drag crossing onto the pill mid-hover)', async () => {
    await mountDock({ groups: groups() })
    stubSlots([48, 48, 48, 48, 48, 48])
    dispatch('pointerenter')
    dispatch('pointermove', centerX(3))
    await flushFrames()
    expect(slotWidths()[3]).not.toBe('')
    // the icon's drag arrives: the move carries buttons=1 — the magnified
    // widths collapse and nothing further magnifies
    const dock = container.querySelector<HTMLElement>('.dock')!
    dock.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: centerX(3), buttons: 1 }),
    )
    await flushFrames()
    expect(slotWidths().every((width) => width === '')).toBe(true)
    dock.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: centerX(2), buttons: 1 }),
    )
    await flushFrames()
    expect(slotWidths().every((width) => width === '')).toBe(true)
  })

  it('a held-button enter never arms the fisheye (the drag arriving over the pill)', async () => {
    await mountDock({ groups: groups() })
    stubSlots([48, 48, 48, 48, 48, 48])
    const dock = container.querySelector<HTMLElement>('.dock')!
    dock.dispatchEvent(
      new MouseEvent('pointerenter', { bubbles: true, clientX: centerX(3), buttons: 1 }),
    )
    dock.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: centerX(3), buttons: 1 }),
    )
    await flushFrames()
    expect(slotWidths().every((width) => width === '')).toBe(true)
  })
})
