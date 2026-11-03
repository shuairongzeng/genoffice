// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DockFlyGhost, useDockFlyGhost, type DockGhostFrom } from '../src/renderer/src/dock-ghost'
import { DOCK_GHOST_MS } from '../src/renderer/src/dock-math'
import type { DockCustomItem } from '../src/shared/dock-prefs'

/**
 * The fly-in ghost (src/renderer/src/dock-ghost.tsx): the first half of the
 * drop-into-dock moment. The hook's lifecycle against a stubbed dock — the
 * flight arms on a drop, resolves the destination slot's rest center
 * (offset metrics, so a mid-pop transform cannot poison it), pins the
 * ghost there with the from-deltas as custom properties, and unmounts a
 * breath after the flight. Reduced motion refuses to fly; a drop while
 * another is mid-flight replaces it, nothing stacks.
 */

const fileCustom: DockCustomItem = {
  id: 'dock:custom:file:/docs/a.md',
  kind: 'file',
  target: '/docs/a.md',
}
const appCustom: DockCustomItem = {
  id: 'dock:custom:app:app:docs',
  kind: 'app',
  target: 'app:docs',
}

/** the pill's rect in viewport px (the drop's own frame) */
const PILL = { left: 500, top: 700, width: 200, height: 60 }

let root: Root
let container: HTMLDivElement
let beginFly: ((custom: DockCustomItem, from: DockGhostFrom, baseSize: number) => boolean) | null =
  null

/** the host's shape: a pill carrying the customs' slots, plus the ghost */
function Harness({ pillRef }: { pillRef: { current: HTMLElement | null } }): React.JSX.Element {
  const fly = useDockFlyGhost(pillRef)
  beginFly = fly.beginFly
  return createElement(
    'div',
    { className: 'dock', ref: pillRef },
    createElement('div', { className: 'dock-slot', 'data-item-id': fileCustom.id }),
    createElement('div', { className: 'dock-slot', 'data-item-id': appCustom.id }),
    fly.ghost ? createElement(DockFlyGhost, { ghost: fly.ghost }) : null,
  )
}

const pillRef = { current: null as HTMLElement | null }

/** pin one slot's layout metrics (own properties: transform-immune by construction) */
function stubSlot(id: string, left: number): void {
  const slot = container.querySelector<HTMLElement>(`.dock-slot[data-item-id="${id}"]`)!
  Object.defineProperty(slot, 'offsetLeft', { value: left })
  Object.defineProperty(slot, 'offsetTop', { value: 10 })
  Object.defineProperty(slot, 'offsetWidth', { value: 48 })
  Object.defineProperty(slot, 'offsetHeight', { value: 48 })
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  beginFly = null
  pillRef.current = null
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(createElement(Harness, { pillRef })))
  // the pill's rect rides an own property, not a spy: a spy on an instance
  // method only the prototype carries patches the PROTOTYPE itself
  const pill = container.querySelector<HTMLElement>('.dock')!
  Object.defineProperty(pill, 'getBoundingClientRect', {
    value: () => ({
      left: PILL.left,
      top: PILL.top,
      width: PILL.width,
      height: PILL.height,
      right: PILL.left + PILL.width,
      bottom: PILL.top + PILL.height,
      x: PILL.left,
      y: PILL.top,
      toJSON: () => ({}),
    }),
  })
  stubSlot(fileCustom.id, 48)
  stubSlot(appCustom.id, 96)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

/** the ghost element, if one is flying */
const ghostEl = (): HTMLElement | null => container.querySelector<HTMLElement>('.dock-ghost')

/** the slot's rest center under the stubs: pill + offset metrics */
const restCenter = (left: number): { x: number; y: number } => ({
  x: PILL.left + left + 24,
  y: PILL.top + 10 + 24,
})

describe('the fly-in ghost', () => {
  it('mounts pinned at the slot and carries the drop point as the from-deltas', async () => {
    expect(beginFly).not.toBeNull()
    await act(async () => {
      beginFly!(fileCustom, { x: 600, y: 730, size: 64 }, 48)
    })
    const ghost = ghostEl()!
    expect(ghost).toBeTruthy()
    // pinned at the destination: the rest center is the box's center
    const center = restCenter(48)
    expect(ghost.style.left).toBe(`${center.x - 24}px`)
    expect(ghost.style.top).toBe(`${center.y - 24}px`)
    expect(ghost.style.width).toBe('48px')
    expect(ghost.style.height).toBe('48px')
    // the flight: from the release point, scaled from the desktop icon's
    // size down to the dock base
    expect(ghost.style.getPropertyValue('--ghost-dx')).toBe(`${600 - center.x}px`)
    expect(ghost.style.getPropertyValue('--ghost-dy')).toBe(`${730 - center.y}px`)
    expect(Number(ghost.style.getPropertyValue('--ghost-scale'))).toBeCloseTo(64 / 48, 5)
    // the artwork is the dock item's own: the tile the new slot carries
    expect(ghost.querySelector('.dock-tile.dock-tile-file')).toBeTruthy()
    // the ghost is pointer-transparent by stylesheet (home.css pins
    // pointer-events: none) — the flight never blocks the dock beneath
  })

  it('unmounts a breath after the flight lands', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await act(async () => {
        beginFly!(appCustom, { x: 10, y: 10, size: 64 }, 48)
      })
      expect(ghostEl()).toBeTruthy()
      await act(async () => {
        vi.advanceTimersByTime(DOCK_GHOST_MS + 80 - 1)
      })
      expect(ghostEl()).toBeTruthy()
      await act(async () => {
        vi.advanceTimersByTime(1)
      })
      expect(ghostEl()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reduced motion refuses the flight: nothing mounts, the insert is instant', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} })),
    )
    let flew = true
    await act(async () => {
      flew = beginFly!(fileCustom, { x: 600, y: 730, size: 64 }, 48)
    })
    expect(flew).toBe(false)
    expect(ghostEl()).toBeNull()
  })

  it('a drop while one is mid-flight replaces it: one ghost, the old timer cleared', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await act(async () => {
        beginFly!(fileCustom, { x: 600, y: 730, size: 64 }, 48)
      })
      // 100ms into the first flight, a second drop lands
      await act(async () => {
        vi.advanceTimersByTime(100)
      })
      await act(async () => {
        beginFly!(appCustom, { x: 20, y: 40, size: 64 }, 48)
      })
      // one ghost, and it is the newcomer's flight (its own from-deltas)
      expect(container.querySelectorAll('.dock-ghost')).toHaveLength(1)
      const ghost = ghostEl()!
      expect(ghost.style.getPropertyValue('--ghost-dx')).toBe(`${20 - restCenter(96).x}px`)
      // the FIRST flight's timer was cleared with the replacement: past
      // its own would-be deadline (t=380) the second flight is still going…
      await act(async () => {
        vi.advanceTimersByTime(281)
      })
      expect(ghostEl()).toBeTruthy()
      // …and it ends only at its own deadline (t=480, 380 from its drop)
      await act(async () => {
        vi.advanceTimersByTime(98)
      })
      expect(ghostEl()).toBeTruthy()
      await act(async () => {
        vi.advanceTimersByTime(1)
      })
      expect(ghostEl()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
