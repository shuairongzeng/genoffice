import { describe, expect, it } from 'vitest'

import {
  DOCK_BASE_ICON_SIZE,
  DOCK_DEFAULT_MAX_SCALE,
  DOCK_DEFAULT_SIGMA_RATIO,
  dockScales,
  dockSlotWidth,
  fisheyeScale,
} from '../src/renderer/src/dock-math'

/**
 * The dock's fisheye physics (src/renderer/src/dock-math.ts): the gaussian
 * magnification curve — peak at the pointer, rest outside the influence,
 * monotonic falloff between — its parameterization (M, σ), the clamps that
 * keep degenerate configs from ever producing NaN widths, the reduced-motion
 * and no-pointer overrides, and the slot-width projection the gesture layer
 * writes. Pure numbers in and out; the component's frame handling lives in
 * its own tests.
 */

/** a mid-size physics so the numbers stay readable */
const PHYSICS = { maxScale: 1.7, sigma: 76.8 } as const

describe('fisheyeScale', () => {
  it('peaks at M directly under the pointer and rests at 1 far away', () => {
    expect(fisheyeScale(0, PHYSICS)).toBe(1.7)
    // three sigma out the bump is exp(-4.5) ≈ 0.011: visually rest
    expect(fisheyeScale(3 * PHYSICS.sigma, PHYSICS)).toBeCloseTo(1.0077, 3)
    expect(fisheyeScale(10 * PHYSICS.sigma, PHYSICS)).toBeCloseTo(1, 6)
  })

  it('mirrors the distance: the curve is symmetric around the pointer', () => {
    expect(fisheyeScale(-48, PHYSICS)).toBe(fisheyeScale(48, PHYSICS))
  })

  it('falls off monotonically with distance', () => {
    let previous = Number.POSITIVE_INFINITY
    for (let d = 0; d <= 4 * PHYSICS.sigma; d += 8) {
      const scale = fisheyeScale(d, PHYSICS)
      expect(scale).toBeLessThanOrEqual(previous)
      previous = scale
    }
  })

  it('is parameterized by M and σ: the peak, and the width of the falloff', () => {
    // a bigger M lifts the peak and only the peak
    expect(fisheyeScale(0, { ...PHYSICS, maxScale: 2.2 })).toBe(2.2)
    expect(fisheyeScale(60, { ...PHYSICS, maxScale: 2.2 })).toBeGreaterThan(
      fisheyeScale(60, PHYSICS),
    )
    // a bigger σ widens the influence: the same distance magnifies more
    expect(fisheyeScale(60, { ...PHYSICS, sigma: 120 })).toBeGreaterThan(fisheyeScale(60, PHYSICS))
    expect(fisheyeScale(60, { ...PHYSICS, sigma: 40 })).toBeLessThan(fisheyeScale(60, PHYSICS))
    // one σ away carries 1 + (M−1)·e^(−1/2) — the curve's own definition
    expect(fisheyeScale(PHYSICS.sigma, PHYSICS)).toBeCloseTo(1 + 0.7 * Math.exp(-0.5), 6)
  })

  it('clamps: never above M, never below rest', () => {
    // a fractional distance lands inside the range, not at its ends
    const mid = fisheyeScale(30, PHYSICS)
    expect(mid).toBeGreaterThan(1)
    expect(mid).toBeLessThan(1.7)
  })

  it('degenerate parameters read back as a static dock, never NaN', () => {
    expect(fisheyeScale(0, { maxScale: 1, sigma: 76.8 })).toBe(1)
    expect(fisheyeScale(0, { maxScale: 0.5, sigma: 76.8 })).toBe(1)
    expect(fisheyeScale(0, { maxScale: Number.NaN, sigma: 76.8 })).toBe(1)
    expect(fisheyeScale(0, { maxScale: 1.7, sigma: 0 })).toBe(1)
    expect(fisheyeScale(0, { maxScale: 1.7, sigma: -10 })).toBe(1)
    expect(fisheyeScale(0, { maxScale: 1.7, sigma: Number.NaN })).toBe(1)
    expect(fisheyeScale(Number.NaN, PHYSICS)).toBe(1)
  })

  it('reduced motion pins every scale to 1, whatever the pointer', () => {
    expect(fisheyeScale(0, { ...PHYSICS, reducedMotion: true })).toBe(1)
    expect(fisheyeScale(10, { ...PHYSICS, reducedMotion: true })).toBe(1)
  })
})

describe('dockScales', () => {
  it('a null pointer is the identity: every icon at rest', () => {
    expect(dockScales([100, 148, 196], null, PHYSICS)).toEqual([1, 1, 1])
  })

  it('a non-finite pointer is treated as no pointer', () => {
    expect(dockScales([100, 148, 196], Number.NaN, PHYSICS)).toEqual([1, 1, 1])
  })

  it('peaks at the icon the pointer sits on and falls off on both sides', () => {
    const centers = [100, 148, 196, 244]
    const scales = dockScales(centers, 148, PHYSICS)
    expect(scales[1]).toBe(1.7)
    expect(scales[0]).toBe(scales[2]) // equidistant neighbors magnify alike
    expect(scales[3]).toBeLessThan(scales[2])
    expect(scales.every((s) => s >= 1 && s <= 1.7)).toBe(true)
  })

  it('reduced motion collapses the whole vector', () => {
    expect(dockScales([100, 148], 148, { ...PHYSICS, reducedMotion: true })).toEqual([1, 1])
  })
})

describe('dockSlotWidth', () => {
  it('is the base scaled in place, rounded to whole px', () => {
    expect(dockSlotWidth(48, 1)).toBe(48)
    expect(dockSlotWidth(48, 1.7)).toBe(82) // 81.6 → 82
    expect(dockSlotWidth(48, 1.25)).toBe(60)
  })

  it('guards degenerate inputs: the base, never NaN', () => {
    expect(dockSlotWidth(48, Number.NaN)).toBe(48)
    expect(dockSlotWidth(48, 0.9)).toBe(48)
    expect(dockSlotWidth(-1, 1.5)).toBe(0)
  })
})

describe('the shipped defaults', () => {
  it('are the spec pair: M ≈ 1.7, σ ≈ 1.6× the base icon size', () => {
    expect(DOCK_DEFAULT_MAX_SCALE).toBe(1.7)
    expect(DOCK_DEFAULT_SIGMA_RATIO).toBe(1.6)
    expect(DOCK_BASE_ICON_SIZE).toBe(48)
    // the rendered σ the Dock derives: 1.6 × 48 = 76.8 px at scale 1
    expect(DOCK_DEFAULT_SIGMA_RATIO * DOCK_BASE_ICON_SIZE).toBeCloseTo(76.8, 6)
  })
})
