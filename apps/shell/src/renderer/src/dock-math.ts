/**
 * Pure fisheye math for the macOS-style dock (renderer/src/Dock.tsx): the
 * magnification curve, its parameters, and nothing DOM-shaped. Kept a module
 * of its own so the physics is testable alone and so the next wave can mount
 * the dock from a standalone entry (?view=dock) without dragging the Home
 * renderer with it — the component feeds centers and pointer positions in
 * whatever single coordinate frame it measured, and takes scales back.
 *
 * The curve is the gaussian bump macOS popularized: an icon's scale is
 * 1 + (M−1)·exp(−d²/(2σ²)) with d the pointer's horizontal distance from the
 * icon's center — 1 at rest, M directly under the pointer, a smooth falloff
 * through σ. Direct and memory-free by design: the scale at any moment is a
 * pure function of the pointer's current position, which is what gives the
 * dock its 1:1 macOS feel (no spring, no lag, nothing to tune) and what
 * makes the same math safe for both input models — a synthetic trajectory
 * and a live pointer produce identical scales.
 */

/** the dock's physics: two numbers, in the same px frame as the centers */
export interface FisheyeOptions {
  /**
   * The peak magnification M: the scale an icon carries directly under the
   * pointer. Values below 1 are degenerate (a dock that shrinks) and read
   * back as a static dock, never as a negative magnification.
   */
  readonly maxScale: number
  /**
   * The influence radius σ in px: the falloff's width. At one σ from the
   * pointer an icon carries ~61% of the magnification, at two σ ~14%, at
   * three σ it is back at rest. Non-positive or non-finite values are
   * degenerate and read back as a static dock — the math must never produce
   * NaN widths.
   */
  readonly sigma: number
  /**
   * The reduced-motion override: true pins every scale to 1 (a static dock).
   * The component derives it from the media query; the flag rides the
   * options so the pure function is testable and so a host can force it.
   */
  readonly reducedMotion?: boolean
}

// The base size and the peak magnification are single-sourced from
// shared/dock-prefs.ts (the settings store's own clamps and defaults): the
// store, the physics, and the overlay geometry all read the same numbers,
// re-exported here under the names the component and its tests import.
export {
  DOCK_BASE_DEFAULT as DOCK_BASE_ICON_SIZE,
  DOCK_MAX_SCALE_DEFAULT as DOCK_DEFAULT_MAX_SCALE,
} from '../../shared/dock-prefs'

/** the default influence radius as a multiple of the base icon size (spec: ~1.6×) */
export const DOCK_DEFAULT_SIGMA_RATIO = 1.6

// ── the launch bounce ──
// macOS's dock bounces a launching icon STEADILY: the same height, the same
// period, until the app answers — an ease-out decay would read as "it gave
// up". The keyframes live in home.css; these are the timing facts the hosts
// and the tests share.

/** one full up-down cycle of the launch bounce (macOS ≈ 0.85s) */
export const DOCK_BOUNCE_PERIOD_MS = 850
/** the bounce's hard cap: a ready signal that never arrives must not bounce forever */
export const DOCK_BOUNCE_TIMEOUT_MS = 8000
/**
 * The auto-hide grace (设置 ▸ 自动隐藏程序坞): how long the pointer may be
 * off the pill before Home slides it away — short enough to feel like the
 * dock's own reveal grace, long enough to forgive diagonal travel toward
 * the stage's bottom edge.
 */
export const DOCK_AUTOHIDE_DELAY_MS = 300
/**
 * The drag inactivity failsafe: a pointer that crossed out of the renderer
 * (another native view) mid-drag delivers no pointerup here, so a drag that
 * goes quiet this long ends itself without a commit. Generous enough that
 * a slow human drag never trips it.
 */
export const DOCK_DRAG_IDLE_MS = 1500

// ── the parting FLIP (a composition change parts the row) ──
// The insert/remove half of the drop-into-dock moment: the slots that keep
// their identity slide to their new places, the newcomer pops in. The
// keyframes live in home.css; these are the timing facts the component and
// the tests share, and the component's settle timer waits out the longer
// of the two before it clears the inline styles and re-arms the fisheye.

/** one moved slot's slide, ease-out */
export const DOCK_PARTING_MS = 250
/** the newcomer's pop, ease-out-back */
export const DOCK_POP_MS = 200
/** the fly-in ghost's flight, ease-out (Home's half of the moment) */
export const DOCK_GHOST_MS = 300

/**
 * The parting FLIP's plan, pure: given each row child's (slots and
 * separators alike, keyed however the caller keys them) position BEFORE the
 * composition change and AFTER it — the layout's own lefts, transform-free
 * (offset metrics, not rects) — answer the per-child delta each persisting
 * child must start translated by to land home (`before − after`), plus the
 * children that just entered the row (in `after` only): they pop, never
 * slide. Children the change removed match nothing and drop. A child whose
 * delta rounds to zero is no movement at all and is left out — sub-pixel
 * drift must not shimmer the row.
 */
export interface DockPartingPlan {
  /** child key → the px translateX its slot starts from */
  readonly deltas: ReadonlyMap<string, number>
  /** the child keys present only in `after`: the pop-ins */
  readonly entering: readonly string[]
}

/** the sub-pixel floor under which a delta is not a movement */
const DOCK_PARTING_EPSILON_PX = 1

export function dockPartingPlan(
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
): DockPartingPlan {
  const deltas = new Map<string, number>()
  const entering: string[] = []
  for (const [key, left] of after) {
    const was = before.get(key)
    if (was === undefined) {
      entering.push(key)
      continue
    }
    const delta = was - left
    if (Math.abs(delta) >= DOCK_PARTING_EPSILON_PX) deltas.set(key, delta)
  }
  return { deltas, entering }
}

// ── the reorder math (drag-to-arrange) ──

/**
 * The flat item-id sequence of the dock's groups — the persisted `order` of
 * the dock prefs. Round-trips through applyDockOrder: what a drag commits,
 * what the store holds, what the next mount reads back.
 */
export function dockOrderOf(groups: readonly (readonly string[])[]): string[] {
  return groups.flatMap((group) => [...group])
}

/**
 * Apply a persisted order WITHIN each group. The contract:
 *
 * - an id the sequence names is ranked by its index in the sequence;
 * - an id the sequence never names keeps its CODED place, interpolated
 *   between its nearest coded neighbors that the sequence does name — a
 *   new item in a newer build lands where the code put it, not shoved to
 *   the group's end (an id with no coded listed neighbor after it appends,
 *   one with none before it leads — its coded place relative to the
 *   arranged ids);
 * - an entry naming an id the group no longer carries matches nothing and
 *   simply drops;
 * - the group boundaries never move: membership is the groups' own, the
 *   sequence only ranks.
 */
export function applyDockOrder(
  groups: readonly (readonly string[])[],
  order: readonly string[],
): readonly (readonly string[])[] {
  if (order.length === 0) return groups
  const rank = new Map(order.map((id, index) => [id, index]))
  return groups.map((group) => {
    if (!group.some((id) => rank.has(id))) return [...group]
    // bracket each unlisted id with its nearest LISTED coded neighbors:
    // the pair's own ranks interpolate where the unlisted id belongs
    const lastListedBefore: number[] = []
    const nextListedAfter: number[] = []
    let seen = -1
    for (let index = 0; index < group.length; index += 1) {
      lastListedBefore[index] = seen
      if (rank.has(group[index]!)) seen = index
    }
    let next = -1
    for (let index = group.length - 1; index >= 0; index -= 1) {
      nextListedAfter[index] = next
      if (rank.has(group[index]!)) next = index
    }
    return group
      .map((id, index) => {
        const listed = rank.get(id)
        if (listed !== undefined) return { id, index, r: listed as number }
        const before = lastListedBefore[index]!
        const after = nextListedAfter[index]!
        // both brackets: strictly between their ranks, wherever the person
        // put them; ties (several unlisted between the same pair) keep
        // coded order through the sort's tiebreak below
        let r: number
        if (before !== -1 && after !== -1) {
          r = (rank.get(group[before]!)! + rank.get(group[after]!)!) / 2
        } else if (before !== -1) {
          // every listed id is coded before this one: its coded place is
          // after them all
          r = order.length + index
        } else {
          // every listed id is coded after this one: its coded place is
          // before them all
          r = -1
        }
        return { id, index, r }
      })
      .sort((a, b) => (a.r !== b.r ? a.r - b.r : a.index - b.index))
      .map((entry) => entry.id)
  })
}

/**
 * Where a global slot sits: the (group, index-in-group) of the item it
 * holds, or null when it is a separator (or past the end) — the caller
 * refuses both, the separator because the groups are fixed boundaries.
 * Slot indices count every child of the pill, separators included, matching
 * the DOM order the drag measures.
 */
function dockSlotLocation(
  groups: readonly (readonly string[])[],
  slotIndex: number,
): { group: number; index: number } | null {
  if (!Number.isInteger(slotIndex) || slotIndex < 0) return null
  let offset = 0
  for (let group = 0; group < groups.length; group += 1) {
    const count = groups[group].length
    if (slotIndex < offset + count) return { group, index: slotIndex - offset }
    offset += count + 1 // step over the group's separator slot
    if (slotIndex === offset - 1) return null // the separator itself
  }
  return null
}

/**
 * Move `itemId` to the in-group position under global slot `slotIndex` —
 * the macOS drag semantics: passing a neighbor swaps the two (the neighbor
 * slides into the freed spot, the item takes the neighbor's), and the
 * measurement frame is the live dock (the dragged item still occupies its
 * slot while the pointer travels). Returns the new groups, or null when the
 * move is a no-op, lands on a separator, or would cross a group boundary —
 * the drag layer keeps the current arrangement in every refused case.
 */
export function dockReorderAt(
  groups: readonly (readonly string[])[],
  itemId: string,
  slotIndex: number,
): readonly (readonly string[])[] | null {
  let sourceGroup = -1
  let sourceIndex = -1
  groups.forEach((group, groupIndex) => {
    const index = group.indexOf(itemId)
    if (index !== -1) {
      sourceGroup = groupIndex
      sourceIndex = index
    }
  })
  if (sourceGroup === -1) return null
  const target = dockSlotLocation(groups, slotIndex)
  if (!target || target.group !== sourceGroup) return null
  if (target.index === sourceIndex) return null
  const group = [...groups[sourceGroup]]
  group.splice(sourceIndex, 1)
  group.splice(target.index, 0, itemId)
  return groups.map((each, groupIndex) => (groupIndex === sourceGroup ? group : [...each]))
}

/**
 * One icon's scale for its distance d from the pointer. The distance is
 * mirrored (|d|), the curve clamped to [1, M] on both ends — the gaussian
 * bump never exceeds M and never shrinks below rest — and every degenerate
 * parameter (reduced motion, M ≤ 1, σ ≤ 0 or non-finite) answers 1 so the
 * caller can write the width blind.
 */
export function fisheyeScale(distance: number, options: FisheyeOptions): number {
  if (options.reducedMotion) return 1
  const maxScale = Number.isFinite(options.maxScale) ? options.maxScale : 1
  if (!(maxScale > 1)) return 1
  const sigma = options.sigma
  if (!Number.isFinite(sigma) || !(sigma > 0)) return 1
  const d = Number.isFinite(distance) ? Math.abs(distance) : Number.POSITIVE_INFINITY
  const bump = Math.exp(-(d * d) / (2 * sigma * sigma))
  const scale = 1 + (maxScale - 1) * bump
  return Math.min(maxScale, Math.max(1, scale))
}

/**
 * The whole dock's scale vector: one scale per center, in center order, for a
 * pointer at `pointerX` in the centers' own frame. A null pointer (no hover,
 * or the gesture layer standing down) is the identity — every icon at rest —
 * which is also the reduced-motion and degenerate-parameter answer, so the
 * component only ever branches on "is there a pointer".
 */
export function dockScales(
  centers: readonly number[],
  pointerX: number | null,
  options: FisheyeOptions,
): number[] {
  if (pointerX === null || !Number.isFinite(pointerX)) return centers.map(() => 1)
  return centers.map((center) =>
    fisheyeScale(pointerX - center, {
      maxScale: options.maxScale,
      sigma: options.sigma,
      reducedMotion: options.reducedMotion,
    }),
  )
}

/**
 * The width a dock slot carries at `scale`: the base slot scaled in place.
 * Whole-slot widths are what make neighbors shift (the slot grows with its
 * icon), so this is the single number the gesture layer writes per icon.
 * Rounding to whole px keeps sub-pixel scales from shimmering the layout;
 * the scale itself is already clamped by the curve, so this only guards the
 * degenerate inputs (a non-finite scale or base reads back as the base).
 */
export function dockSlotWidth(baseSize: number, scale: number): number {
  if (!Number.isFinite(baseSize) || baseSize <= 0) return 0
  const s = Number.isFinite(scale) && scale >= 1 ? scale : 1
  return Math.round(baseSize * s)
}
