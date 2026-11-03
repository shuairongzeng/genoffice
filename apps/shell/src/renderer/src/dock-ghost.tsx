import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

import type { DockCustomItem } from '../../shared/dock-prefs'
import { DOCK_GHOST_MS } from './dock-math'
import { dockCustomIcon, dockCustomTile } from './dock-custom'

/**
 * The fly-in ghost — the first half of the drop-into-dock moment (the
 * second is the dock's parting FLIP, Dock.tsx): when a dropped desktop icon
 * becomes a custom launcher, its dock artwork — the exact tile the new slot
 * will carry — flies from the release point to the slot's rest center,
 * scaling from the desktop icon's size down to the dock base and fading
 * slightly at the end so the popped-in item reads as the landing. The ghost
 * is Home's to own: the drop happens on its desktop, the destination is
 * its dock, and the flight stays inside one renderer (the doc-mode overlay
 * dock cannot see the drop at all — it only re-renders with the new item
 * and takes the parting FLIP for free).
 *
 * The flight itself is CSS (home.css's `dock-ghost-fly` keyframes, the
 * duration mirroring dock-math's DOCK_GHOST_MS): the element is pinned at
 * the DESTINATION and the keyframes carry the from-transform as custom
 * properties, so the animation starts at mount regardless of paint timing.
 * The host unmounts the ghost shortly after the flight. Reduced motion
 * skips the ghost outright — the insert is instant, honestly so.
 */

/** prefers-reduced-motion, guarded for test DOMs that lack matchMedia */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/** where the flight starts: the release point and the icon's visual size */
export interface DockGhostFrom {
  readonly x: number
  readonly y: number
  /** the dragged desktop icon's visual footprint, CSS px */
  readonly size: number
}

/** one flight in progress: the launcher, its start, its destination */
export interface DockGhost {
  readonly custom: DockCustomItem
  readonly from: DockGhostFrom
  /** the destination slot's rest center in viewport px; null until measured */
  readonly target: { readonly x: number; readonly y: number } | null
  /** the dock base size the flight was sized against */
  readonly baseSize: number
}

/**
 * The ghost's lifecycle. `beginFly` arms one flight — a drop while another
 * is mid-flight REPLACES it (the old ghost unmounts with its animation;
 * nothing stacks) — and answers false under reduced motion so the caller
 * can treat the insert as instant. The destination resolves in a layout
 * effect once the newcomer's slot exists: the drop's prefs write and the
 * ghost state land in the same commit, so the slot is already there —
 * measured through offset metrics, not rects, because the slot is mid-pop
 * (a transform) at that moment and offset metrics ignore transforms: the
 * rest center is the honest destination.
 */
export function useDockFlyGhost(pillRef: { current: HTMLElement | null }): {
  ghost: DockGhost | null
  /** arm a flight; false when reduced motion refuses it */
  beginFly: (custom: DockCustomItem, from: DockGhostFrom, baseSize: number) => boolean
} {
  const [ghost, setGhost] = useState<DockGhost | null>(null)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const beginFly = useCallback(
    (custom: DockCustomItem, from: DockGhostFrom, baseSize: number): boolean => {
      if (prefersReducedMotion()) return false
      window.clearTimeout(timer.current)
      setGhost({ custom, from, target: null, baseSize })
      // the flight ends with the ghost still slightly faded over the landed
      // item; a breath later it is gone (the real item has been there since
      // the pop)
      timer.current = window.setTimeout(() => setGhost(null), DOCK_GHOST_MS + 80)
      return true
    },
    [],
  )
  useLayoutEffect(() => {
    if (!ghost || ghost.target !== null) return
    const pill = pillRef.current
    if (!pill) return
    const slot = pill.querySelector<HTMLElement>(`.dock-slot[data-item-id="${ghost.custom.id}"]`)
    if (!slot) return
    const root = pill.getBoundingClientRect()
    const target = {
      x: root.left + slot.offsetLeft + slot.offsetWidth / 2,
      y: root.top + slot.offsetTop + slot.offsetHeight / 2,
    }
    setGhost((prev) => (prev && prev.target === null ? { ...prev, target } : prev))
  }, [ghost, pillRef])
  return { ghost, beginFly }
}

/**
 * The flying visual: the dock item's own artwork (tile chrome and glyph),
 * pinned at the destination and carried home by the keyframes. Renders
 * nothing until the destination is measured — a flight without a landing
 * is no flight. Fixed (the drop's own viewport frame), pointer-transparent,
 * above the desktop's content and under the pill itself (home.css: the
 * ghost crosses beneath the frosted glass and merges into the row).
 */
export function DockFlyGhost({ ghost }: { ghost: DockGhost }): React.JSX.Element | null {
  const target = ghost.target
  if (target === null) return null
  const half = ghost.baseSize / 2
  const style = {
    left: target.x - half,
    top: target.y - half,
    width: ghost.baseSize,
    height: ghost.baseSize,
    '--ghost-dx': `${ghost.from.x - target.x}px`,
    '--ghost-dy': `${ghost.from.y - target.y}px`,
    '--ghost-scale': `${ghost.from.size / ghost.baseSize}`,
  } as CSSProperties
  return (
    <div className="dock-ghost" style={style} aria-hidden="true">
      <span className={`dock-tile dock-tile-${dockCustomTile(ghost.custom)}`}>
        {dockCustomIcon(ghost.custom)}
      </span>
    </div>
  )
}
