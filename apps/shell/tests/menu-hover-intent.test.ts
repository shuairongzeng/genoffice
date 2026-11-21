// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  computeSubmenuTopOffset,
  isMovingTowardSubmenu,
  isPointInSafeTriangle,
  type SubmenuRect,
} from '../src/renderer/src/menu-hover-intent'

describe('menu-hover-intent', () => {
  it('checks safe triangle membership including boundary points', () => {
    const a = { x: 100, y: 120 }
    const b = { x: 200, y: 50 }
    const c = { x: 200, y: 260 }

    expect(isPointInSafeTriangle({ x: 150, y: 130 }, a, b, c)).toBe(true)
    expect(isPointInSafeTriangle({ x: 100, y: 120 }, a, b, c)).toBe(true)
    expect(isPointInSafeTriangle({ x: 150, y: 260 }, a, b, c)).toBe(false)
    expect(isPointInSafeTriangle({ x: 80, y: 120 }, a, b, c)).toBe(false)
  })

  it('detects diagonal pointer movement toward the open submenu in both LTR and RTL', () => {
    const ltrRect: SubmenuRect = { left: 260, top: 80, right: 420, bottom: 280 }
    const ltrAnchor = { x: 180, y: 110 }

    // Heading diagonally down-right into the submenu stays protected
    expect(isMovingTowardSubmenu({ x: 230, y: 170 }, ltrAnchor, ltrRect, false)).toBe(true)
    // Dropping vertically straight down onto a sibling row below is outside the triangle
    expect(isMovingTowardSubmenu({ x: 180, y: 195 }, ltrAnchor, ltrRect, false)).toBe(false)

    // Flipped RTL/left-edge submenu swaps edgeX to submenuRect.right
    const rtlRect: SubmenuRect = { left: 40, top: 80, right: 200, bottom: 280 }
    const rtlAnchor = { x: 280, y: 110 }
    expect(isMovingTowardSubmenu({ x: 230, y: 170 }, rtlAnchor, rtlRect, true)).toBe(true)
    expect(isMovingTowardSubmenu({ x: 280, y: 210 }, rtlAnchor, rtlRect, true)).toBe(false)
  })

  it('clamps submenu top offset when near bottom edge of viewport', () => {
    // Enough vertical room -> keeps default -5 offset
    expect(computeSubmenuTopOffset(120, 220, 800)).toBe(-5)

    // Row sits near viewport bottom (y=680), submenu height is 240 in an 800px viewport:
    // maxTop = 800 - 240 - 8 = 552; relative to rowTop (680) => 552 - 680 = -128
    expect(computeSubmenuTopOffset(680, 240, 800)).toBe(-128)
  })
})
