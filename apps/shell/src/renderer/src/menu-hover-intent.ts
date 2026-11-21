/**
 * Safe-triangle pointer intent & viewport clamping for hover-driven desktop submenus.
 *
 * When a user opens a submenu row (e.g. "New" / "Sort" / "View") and moves their
 * pointer diagonally toward the flyout panel, their path briefly crosses neighboring
 * menu rows. Checking whether the current pointer lies inside the triangle spanned by
 * the entry point and the flyout's near vertical edge prevents premature submenu flips.
 */

export interface Point2D {
  readonly x: number
  readonly y: number
}

export interface SubmenuRect {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

function crossSign(p1: Point2D, p2: Point2D, p3: Point2D): number {
  return (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y)
}

/** Return true if point `p` lies inside or on the boundary of triangle (a, b, c). */
export function isPointInSafeTriangle(p: Point2D, a: Point2D, b: Point2D, c: Point2D): boolean {
  const d1 = crossSign(p, a, b)
  const d2 = crossSign(p, b, c)
  const d3 = crossSign(p, c, a)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

/**
 * Return true when pointer movement from `anchor` to `current` heads toward the
 * currently displayed flyout `submenuRect` rather than away from it.
 */
export function isMovingTowardSubmenu(
  current: Point2D,
  anchor: Point2D,
  submenuRect: SubmenuRect,
  flipped: boolean,
  pad = 10,
): boolean {
  const edgeX = flipped ? submenuRect.right : submenuRect.left
  const cornerTop: Point2D = { x: edgeX, y: submenuRect.top - pad }
  const cornerBottom: Point2D = { x: edgeX, y: submenuRect.bottom + pad }
  return isPointInSafeTriangle(current, anchor, cornerTop, cornerBottom)
}

/**
 * Clamp the flyout submenu's CSS `top` offset relative to its parent `.desktop-menu-row`
 * so tall submenus near the bottom of the viewport stay completely visible.
 */
export function computeSubmenuTopOffset(
  rowTop: number,
  submenuHeight: number,
  viewportHeight: number,
  defaultOffset = -5,
  margin = 8,
): number {
  if (!Number.isFinite(rowTop) || !Number.isFinite(submenuHeight) || !Number.isFinite(viewportHeight)) {
    return defaultOffset
  }
  const idealTop = rowTop + defaultOffset
  const maxTop = Math.max(margin, viewportHeight - submenuHeight - margin)
  const clampedViewportTop = Math.min(idealTop, maxTop)
  return Math.round(Math.max(margin - rowTop, clampedViewportTop - rowTop))
}
