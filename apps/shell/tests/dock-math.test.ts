import { describe, expect, it } from 'vitest'

import {
  DOCK_BASE_ICON_SIZE,
  DOCK_DEFAULT_MAX_SCALE,
  DOCK_DEFAULT_SIGMA_RATIO,
  DOCK_BOUNCE_PERIOD_MS,
  DOCK_BOUNCE_TIMEOUT_MS,
  DOCK_AUTOHIDE_DELAY_MS,
  DOCK_GHOST_MS,
  DOCK_LAUNCHERS_GROUP,
  DOCK_PARTING_MS,
  DOCK_POP_MS,
  applyDockOrder,
  dockInsertIndex,
  dockOrderOf,
  dockPartingPlan,
  dockReorderAt,
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

  it('the timing constants: a steady ~0.85s bounce, an 8s cap, a short auto-hide grace', () => {
    // the CSS keyframes hard-code the same period (home.css's dock-bounce);
    // this pin is the number the hosts and tests share
    expect(DOCK_BOUNCE_PERIOD_MS).toBe(850)
    expect(DOCK_BOUNCE_TIMEOUT_MS).toBe(8000)
    expect(DOCK_AUTOHIDE_DELAY_MS).toBe(300)
  })
})

describe('the reorder math (drag-to-arrange)', () => {
  // the dock's three groups: nav | launchers | ask — the fixed boundaries
  const GROUPS = [
    ['dock:desktop', 'dock:recent', 'dock:starred'],
    ['dock:settings', 'dock:templates', 'dock:plugins'],
    ['dock:ask'],
  ] as const

  it('dockOrderOf flattens the groups; applyDockOrder round-trips it', () => {
    const order = dockOrderOf(GROUPS)
    expect(order).toEqual([
      'dock:desktop',
      'dock:recent',
      'dock:starred',
      'dock:settings',
      'dock:templates',
      'dock:plugins',
      'dock:ask',
    ])
    // the persisted order reapplied is the identity (whatever the groups)
    expect(applyDockOrder(GROUPS, order)).toEqual(GROUPS)
  })

  it('applyDockOrder permutes WITHIN groups only: boundaries never move', () => {
    // recent before desktop, plugins before settings: each stays in its group
    const reordered = applyDockOrder(GROUPS, [
      'dock:recent',
      'dock:desktop',
      'dock:plugins',
      'dock:settings',
      'dock:templates',
      'dock:starred',
      'dock:ask',
    ])
    expect(reordered).toEqual([
      ['dock:recent', 'dock:desktop', 'dock:starred'],
      ['dock:plugins', 'dock:settings', 'dock:templates'],
      ['dock:ask'],
    ])
    // a sequence that would smuggle an item across a separator cannot: the
    // group membership is decided by the groups, the order only sequences
    expect(reordered[0]).not.toContain('dock:settings')
  })

  it('ids the sequence never names keep their coded place, not the group end', () => {
    // a new item coded between two arranged ids lands between them in the
    // output, wherever the person's arrangement put that pair
    expect(applyDockOrder([['a', 'NEW', 'b']], ['b', 'a'])).toEqual([['b', 'NEW', 'a']])
    // a trailing new id (coded after every arranged one) appends, a leading
    // one leads — its coded place relative to the arranged ids
    expect(applyDockOrder([['a', 'b', 'TAIL']], ['b', 'a'])).toEqual([['b', 'a', 'TAIL']])
    expect(applyDockOrder([['HEAD', 'a', 'b']], ['b', 'a'])).toEqual([['HEAD', 'b', 'a']])
    // entries naming ids the group no longer carries match nothing and drop
    expect(applyDockOrder([['a', 'b']], ['gone', 'b', 'a'])).toEqual([['b', 'a']])
    // an empty sequence is the identity (the reset verb's value)
    expect(applyDockOrder([['a', 'b', 'c']], [])).toEqual([['a', 'b', 'c']])
  })

  it('the dragged-in customs rank inside the launchers group like any other item', () => {
    // the launchers group with two customs coded after plugins: the
    // normalizer's default order (custom ids appended at the end) leaves the
    // coded members first and the customs before the ask tail
    const withCustoms = [
      ['dock:desktop', 'dock:recent', 'dock:starred'],
      [
        'dock:settings',
        'dock:templates',
        'dock:plugins',
        'dock:custom:file:/a.md',
        'dock:custom:app:app:docs',
      ],
      ['dock:ask'],
    ] as const
    const order = ['dock:custom:file:/a.md', 'dock:custom:app:app:docs']
    expect(applyDockOrder(withCustoms, order)).toEqual(withCustoms)
    // the person drags the file launcher left of templates: it ranks there —
    // plugins, unlisted, interpolates between the pair's ranks — and the
    // app launcher keeps its coded place at the group's end
    expect(
      applyDockOrder(withCustoms, [
        'dock:custom:file:/a.md',
        'dock:templates',
        'dock:custom:app:app:docs',
      ]),
    ).toEqual([
      ['dock:desktop', 'dock:recent', 'dock:starred'],
      [
        'dock:settings',
        'dock:custom:file:/a.md',
        'dock:plugins',
        'dock:templates',
        'dock:custom:app:app:docs',
      ],
      ['dock:ask'],
    ])
    // an order naming only builtin ids leaves the customs at their coded
    // places (interpolated after the arranged plugins)
    expect(
      applyDockOrder(withCustoms, ['dock:settings', 'dock:templates', 'dock:plugins']),
    ).toEqual(withCustoms)
  })

  it('dockReorderAt swaps past a neighbor: the neighbor takes the freed spot', () => {
    // pointer over slot 1 (recent) while dragging desktop (slot 0)
    expect(dockReorderAt(GROUPS, 'dock:desktop', 1)).toEqual([
      ['dock:recent', 'dock:desktop', 'dock:starred'],
      ['dock:settings', 'dock:templates', 'dock:plugins'],
      ['dock:ask'],
    ])
    // two slots right, landing on starred
    expect(dockReorderAt(GROUPS, 'dock:desktop', 2)).toEqual([
      ['dock:recent', 'dock:starred', 'dock:desktop'],
      ['dock:settings', 'dock:templates', 'dock:plugins'],
      ['dock:ask'],
    ])
    // and leftward: plugins (slot 5) over settings (slot 4)
    expect(dockReorderAt(GROUPS, 'dock:plugins', 4)).toEqual([
      ['dock:desktop', 'dock:recent', 'dock:starred'],
      ['dock:plugins', 'dock:settings', 'dock:templates'],
      ['dock:ask'],
    ])
  })

  it('refuses the separator slots and anything past the pill', () => {
    // slot 3 is the nav/launchers separator, slot 7 the launchers/ask one,
    // slot 8+ is past the end
    for (const slot of [3, 7, 8, -1, 1.5]) {
      expect(dockReorderAt(GROUPS, 'dock:desktop', slot)).toBeNull()
    }
  })

  it('refuses a cross-group move: the groups are fixed boundaries', () => {
    // dragging desktop (nav) onto the settings slot (launchers)
    expect(dockReorderAt(GROUPS, 'dock:desktop', 4)).toBeNull()
    // dragging ask onto a nav slot
    expect(dockReorderAt(GROUPS, 'dock:ask', 0)).toBeNull()
  })

  it('a no-op move answers null (the caller keeps the arrangement)', () => {
    expect(dockReorderAt(GROUPS, 'dock:desktop', 0)).toBeNull()
    expect(dockReorderAt(GROUPS, 'dock:ask', 7)).toBeNull()
    // an id that is not in the dock at all
    expect(dockReorderAt(GROUPS, 'dock:nope', 1)).toBeNull()
  })
})

describe('the parting FLIP math (dockPartingPlan)', () => {
  const before = new Map([
    ['slot:docs', 0],
    ['slot:sheets', 48],
    ['slot:slides', 96],
    ['sep:1', 144],
  ])

  it('an insert slides the outrun children, never the newcomer', () => {
    // a custom launcher inserted at the row's head: everything after it
    // slides right by one slot, the newcomer itself pops instead of sliding
    const after = new Map([
      ['slot:custom:file:/a.md', 0],
      ['slot:docs', 48],
      ['slot:sheets', 96],
      ['slot:slides', 144],
      ['sep:1', 192],
    ])
    const plan = dockPartingPlan(before, after)
    expect(Object.fromEntries(plan.deltas)).toEqual({
      'slot:docs': -48,
      'slot:sheets': -48,
      'slot:slides': -48,
      'sep:1': -48,
    })
    expect(plan.entering).toEqual(['slot:custom:file:/a.md'])
  })

  it('a removal closes the gap: the tail slides back, the gone id drops', () => {
    const after = new Map([
      ['slot:docs', 0],
      ['slot:slides', 48],
      ['sep:1', 96],
    ])
    const plan = dockPartingPlan(before, after)
    // slides moved (its delta) toward the freed spot; sheets is gone
    expect(Object.fromEntries(plan.deltas)).toEqual({
      'slot:slides': 48,
      'sep:1': 48,
    })
    expect(plan.entering).toEqual([])
  })

  it('a child whose place did not move is not a movement; sub-pixel drift is noise', () => {
    const after = new Map([
      ['slot:docs', 0],
      ['slot:sheets', 48.4],
      ['slot:slides', 96],
      ['sep:1', 144],
    ])
    const plan = dockPartingPlan(before, after)
    // 0.4px is under the epsilon floor: nothing animates
    expect(plan.deltas.size).toBe(0)
    expect(plan.entering).toEqual([])
    // a real move of one full pixel still counts
    const moved = new Map([
      ['slot:docs', 0],
      ['slot:sheets', 49],
      ['slot:slides', 96],
      ['sep:1', 144],
    ])
    expect(Object.fromEntries(dockPartingPlan(before, moved).deltas)).toEqual({
      'slot:sheets': -1,
    })
  })

  it('the timing facts the component, the ghost and the CSS share', () => {
    // the slide, the pop, the flight: the component's settle timer waits out
    // the longer of the first two; the ghost's unmount rides the third
    expect(DOCK_PARTING_MS).toBe(250)
    expect(DOCK_POP_MS).toBe(200)
    expect(DOCK_GHOST_MS).toBe(300)
  })
})

describe('the drag-over insert preview (dockInsertIndex)', () => {
  // three launchers' slot centers, a rest pitch apart
  const CENTERS = [124, 172, 220]

  it('before the first center the gap opens at the group head', () => {
    expect(dockInsertIndex(CENTERS, 0)).toBe(0)
    expect(dockInsertIndex(CENTERS, 123.9)).toBe(0)
  })

  it('between two centers the gap opens between them; on a center, before it', () => {
    expect(dockInsertIndex(CENTERS, 148)).toBe(1)
    expect(dockInsertIndex(CENTERS, 200)).toBe(2)
    // a pointer exactly on a slot's center opens the gap BEFORE the slot
    expect(dockInsertIndex(CENTERS, 124)).toBe(0)
    expect(dockInsertIndex(CENTERS, 172)).toBe(1)
  })

  it('past the last center the gap opens at the group end — before the ask tail', () => {
    expect(dockInsertIndex(CENTERS, 220.1)).toBe(3)
    expect(dockInsertIndex(CENTERS, 5000)).toBe(3)
  })

  it('the answer is bounded by construction: the group is the whole world', () => {
    // the caller passes only the launchers' centers, so even a wild x can
    // never name a position across a separator: 0..centers.length, always
    expect(dockInsertIndex([], 300)).toBe(0)
    expect(dockInsertIndex(CENTERS, Number.NEGATIVE_INFINITY)).toBe(0)
    expect(dockInsertIndex(CENTERS, Number.POSITIVE_INFINITY)).toBe(CENTERS.length)
    // and the launchers group sits at the fixed second position
    expect(DOCK_LAUNCHERS_GROUP).toBe(1)
  })
})
