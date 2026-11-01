// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { Dock, type DockItem } from '../src/renderer/src/Dock'
import {
  DOCK_DEFAULT_MAX_SCALE,
  DOCK_DEFAULT_SIGMA_RATIO,
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
