import { useEffect, useRef, useState } from 'react'
import { Fragment, type ReactNode } from 'react'

import { chromeScale } from './AiDock'
import {
  DOCK_BASE_ICON_SIZE,
  DOCK_DEFAULT_MAX_SCALE,
  DOCK_DEFAULT_SIGMA_RATIO,
  dockScales,
  dockSlotWidth,
} from './dock-math'

/**
 * The macOS-style fisheye dock: a frosted-glass pill fixed to the bottom
 * center of whatever surface hosts it, carrying the workbench's primary
 * launchers. The magnification is the gaussian bump of dock-math.ts — the
 * scale a pure function of the pointer's position, applied with no spring
 * and no lag (the 1:1 macOS feel), collapsed back to rest through a short
 * 120ms transition on the way OUT only.
 *
 * The performance shape is deliberate, and it is the reason the gesture
 * layer is imperative rather than state: per pointer-move the handler only
 * records the latest clientX and schedules one rAF, and the rAF writes each
 * slot's width and each item's transform — writes only, never a read. The
 * geometry the math needs (each slot's un-magnified center) is measured once
 * per pointer-enter, after snapping any half-collapsed widths back to rest —
 * a single forced reflow per gesture, never inside the move path, so ~9 icons
 * magnify without layout-thrashing the frame. Slot widths carry the growth
 * (the slot scales with its icon, which is what makes neighbors shift) and
 * the pill grows symmetrically around its center, which keeps the measured
 * centers meaningful for the whole gesture. A window resize invalidates the
 * measurement (the pill re-centers, the slots re-flow): the gesture snaps to
 * rest and the next enter measures the new geometry instead of magnifying
 * against stale centers.
 *
 * Coordinates: the dock renders inside the `zoom`ed app frame, so its CSS px
 * are chrome px (the interface scale sizes it like every chrome band), while
 * pointer clientX and the measured rects are viewport px. The σ the math
 * wants is therefore scaled by chromeScale() to viewport px — the same
 * conversion the floating pet's drag performs (AiDock's chromeScale), and the
 * same lesson: the viewport delta divided by the zoom lands in the chrome
 * space the layout speaks.
 *
 * Standalone by contract (wave 2 mounts this from a ?view=dock entry): props
 * in, callbacks out, no Home globals at module scope — the only import from
 * the app tree is the chromeScale utility, which reads the root style every
 * renderer shares. The items carry their own icons and labels; the host
 * decides what "active" means and what a click does.
 */

/** one launcher in the dock */
export interface DockItem {
  /** stable identity (React key); unique across the whole dock */
  readonly id: string
  /** the tooltip (data-tip, the app's screentip system) and the a11y label */
  readonly label: string
  /** the icon artwork — the same assets the sidebar nav / desktop tiles use */
  readonly icon: ReactNode
  /**
   * The nav-style active state: shows the indicator dot (macOS style) and
   * aria-current. The host owns the meaning — "the view this item opens is
   * the one showing".
   */
  readonly active?: boolean
  /** run the item: a view switch, a launcher, the drawer's open verb */
  readonly onSelect: () => void
}

export interface DockProps {
  /** item groups in display order; a separator renders between groups */
  readonly groups: readonly (readonly DockItem[])[]
  /** the toolbar's accessible name */
  readonly ariaLabel: string
  /**
   * Disables magnification (a static dock). Defaults to the media query,
   * followed live (the OS setting can flip mid-session); overridable so
   * tests and future hosts can force it — an override never follows the OS.
   */
  readonly reducedMotion?: boolean
  /** physics overrides; defaults M = 1.7, σ = 1.6× the base icon size */
  readonly maxScale?: number
  readonly sigmaRatio?: number
  /** the base icon size in CSS px (the slot pitch at rest) */
  readonly baseSize?: number
}

export function Dock(props: DockProps): React.JSX.Element {
  const baseSize = props.baseSize ?? DOCK_BASE_ICON_SIZE
  const maxScale = props.maxScale ?? DOCK_DEFAULT_MAX_SCALE
  const sigmaRatio = props.sigmaRatio ?? DOCK_DEFAULT_SIGMA_RATIO
  const rootRef = useRef<HTMLDivElement>(null)
  // the media query is a live OS setting, not a boot-time fact: state (not a
  // memo) plus the change subscription below, so flipping "reduce motion"
  // mid-session re-renders — and the gesture effect re-arms on [reducedMotion].
  // An explicit prop still wins outright: a host forcing the mode never
  // follows the OS.
  const [reducedMotion, setReducedMotion] = useState(
    () =>
      props.reducedMotion ??
      (typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false),
  )

  useEffect(() => {
    if (props.reducedMotion !== undefined) return
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (typeof query.addEventListener !== 'function') return
    const onChange = (event: MediaQueryListEvent): void => setReducedMotion(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [props.reducedMotion])
  // the physics, read fresh inside the rAF through a ref so a prop change
  // mid-gesture applies on the next frame without re-arming the listeners
  const physicsRef = useRef({ maxScale, sigmaRatio, baseSize })
  physicsRef.current = { maxScale, sigmaRatio, baseSize }

  useEffect(() => {
    const root = rootRef.current
    if (!root || reducedMotion) return
    /** the slots in display order, collected at gesture start */
    let slots: HTMLDivElement[] = []
    /** each slot's un-magnified center in viewport px, measured at rest */
    let centers: number[] | null = null
    /** the latest pointer x in viewport px; null while no move arrived */
    let pointerX: number | null = null
    /** the pending rAF id; 0 = idle */
    let frame = 0

    const apply = (): void => {
      frame = 0
      if (centers === null || pointerX === null) return
      const { maxScale: m, sigmaRatio: ratio, baseSize: base } = physicsRef.current
      // σ in viewport px: the pill's CSS px render at base × ui-scale, so the
      // influence must grow with the zoom to keep the same visual reach
      const sigma = ratio * base * chromeScale()
      const scales = dockScales(centers, pointerX, { maxScale: m, sigma })
      slots.forEach((slot, index) => {
        const scale = scales[index] ?? 1
        slot.style.width = `${dockSlotWidth(base, scale)}px`
        const item = slot.firstElementChild
        if (item instanceof HTMLElement) item.style.transform = scale === 1 ? '' : `scale(${scale})`
      })
    }

    const schedule = (): void => {
      if (frame) return
      frame = requestAnimationFrame(apply)
    }

    const onEnter = (): void => {
      // a re-entry can land mid-collapse (the leave transition still running):
      // snap to rest before measuring, or the centers would describe the
      // half-magnified layout. Transitions off first, so the snap is instant.
      root.classList.remove('dock-collapsing')
      slots = [...root.querySelectorAll<HTMLDivElement>('.dock-slot')]
      for (const slot of slots) {
        slot.style.width = ''
        const item = slot.firstElementChild
        if (item instanceof HTMLElement) item.style.transform = ''
      }
      // the one measurement of the gesture: the un-scaled slot geometry
      centers = slots.map((slot) => {
        const rect = slot.getBoundingClientRect()
        return rect.left + rect.width / 2
      })
      pointerX = null
    }

    const onMove = (event: PointerEvent): void => {
      if (centers === null) return
      pointerX = event.clientX
      schedule()
    }

    const onLeave = (): void => {
      if (centers === null) return
      if (frame) {
        cancelAnimationFrame(frame)
        frame = 0
      }
      centers = null
      pointerX = null
      // the way OUT gets the short transition (macOS); the way in is direct
      root.classList.add('dock-collapsing')
      for (const slot of slots) {
        slot.style.width = ''
        const item = slot.firstElementChild
        if (item instanceof HTMLElement) item.style.transform = ''
      }
    }

    // a window resize re-centers the pill and re-flows the slots: the
    // measured centers describe a layout the window no longer has, and
    // magnifying against them would jump icons the wrong way. Drop the
    // gesture state, cancel the pending frame, and snap to rest — the next
    // pointerenter re-measures fresh.
    const onResize = (): void => {
      if (frame) {
        cancelAnimationFrame(frame)
        frame = 0
      }
      centers = null
      pointerX = null
      root.classList.remove('dock-collapsing')
      for (const slot of slots) {
        slot.style.width = ''
        const item = slot.firstElementChild
        if (item instanceof HTMLElement) item.style.transform = ''
      }
    }

    root.addEventListener('pointerenter', onEnter)
    root.addEventListener('pointermove', onMove)
    root.addEventListener('pointerleave', onLeave)
    window.addEventListener('resize', onResize)
    return () => {
      root.removeEventListener('pointerenter', onEnter)
      root.removeEventListener('pointermove', onMove)
      root.removeEventListener('pointerleave', onLeave)
      window.removeEventListener('resize', onResize)
      if (frame) cancelAnimationFrame(frame)
      // standing down (reduce motion flipped on mid-gesture, or unmount):
      // the slots must not keep the last frame's inline widths, or the dock
      // would freeze magnified with no listener left to collapse it
      root.classList.remove('dock-collapsing')
      for (const slot of slots) {
        slot.style.width = ''
        const item = slot.firstElementChild
        if (item instanceof HTMLElement) item.style.transform = ''
      }
    }
  }, [reducedMotion])

  return (
    <div
      className="dock"
      ref={rootRef}
      role="toolbar"
      aria-label={props.ariaLabel}
      style={{ '--dock-base': `${baseSize}px` } as React.CSSProperties}
    >
      {props.groups.map((group, groupIndex) => (
        <Fragment key={groupIndex}>
          {groupIndex > 0 && <span className="dock-separator" aria-hidden="true" />}
          {group.map((item) => (
            <div key={item.id} className="dock-slot">
              <button
                type="button"
                className="dock-item"
                data-tip={item.label}
                aria-label={item.label}
                aria-current={item.active ? 'true' : undefined}
                onClick={item.onSelect}
              >
                {item.icon}
              </button>
              {/* the dot rides the slot, not the button: the button carries the
                  magnification transform and the indicator must not grow */}
              {item.active && <span className="dock-dot" aria-hidden="true" />}
            </div>
          ))}
        </Fragment>
      ))}
    </div>
  )
}
