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

/** the base icon size in CSS px — the dock's slot pitch at rest */
export const DOCK_BASE_ICON_SIZE = 48

/** the default peak magnification M (spec: ~1.7) */
export const DOCK_DEFAULT_MAX_SCALE = 1.7

/** the default influence radius as a multiple of the base icon size (spec: ~1.6×) */
export const DOCK_DEFAULT_SIGMA_RATIO = 1.6

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
