import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Fragment, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { chromeScale } from './AiDock'
import {
  DOCK_BASE_ICON_SIZE,
  DOCK_DEFAULT_MAX_SCALE,
  DOCK_DEFAULT_SIGMA_RATIO,
  DOCK_DRAG_IDLE_MS,
  DOCK_PARTING_MS,
  DOCK_POP_MS,
  applyDockOrder,
  dockOrderOf,
  dockPartingPlan,
  dockReorderAt,
  dockScales,
  dockSlotWidth,
} from './dock-math'
import { placeFolderMenu } from './folder-menu-position'
import { useDismissablePopover } from '@genoffice/ui'

/** one verb in a dock item's right-click menu */
export interface DockMenuEntry {
  /** the row's label (already localized by the host) */
  readonly label: string
  /** run the verb: the switch, the open/bring-forward, the close */
  readonly onSelect: () => void
  /** the destructive styling (a close) */
  readonly danger?: boolean
}

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
 * against stale centers — and so does a reorder (the drag permutes the
 * slots) and a drag in progress (the fisheye stands down while the pointer
 * belongs to the arrangement, re-measuring on release).
 *
 * Coordinates: the dock renders inside the `zoom`ed app frame, so its CSS
 * px are chrome px (the interface scale sizes it like every chrome band), while
 * pointer clientX and the measured rects are viewport px. The σ the math
 * wants is therefore scaled by chromeScale() to viewport px — the same
 * conversion the floating pet's drag performs (AiDock's chromeScale), and the
 * same lesson: the viewport delta divided by the zoom lands in the chrome
 * space the layout speaks.
 *
 * The macOS operability layer rides the same component: squircle icon tiles
 * (the desktop tiles' colored artwork, `tile`), the running indicator (the
 * dot under an item whose target is OPEN, not just the current view,
 * `running`), the launch bounce (`bouncing` — the host owns the lifecycle,
 * the component owns the steady 850ms keyframes and the reduced-motion
 * gate), the right-click context menu (`menu` on an item — portaled to the
 * body so the transformed pill cannot capture its fixed coordinates, but
 * still the SAME document: the doc-mode overlay's own renderer, with the
 * entry's reveal pin holding the dock open under it; opened above the
 * item, Esc/outside-dismissed, keyboard-reachable through the contextmenu
 * event the focused button already produces), and the drag-to-reorder
 * (`order`/`onReorder` — within a group only, the separators are fixed
 * boundaries). The hosts own everything that needs their state: which
 * targets are open, when a launch is ready, what the menu's verbs do,
 * where the order persists.
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
  /** the icon artwork — the same assets the desktop tiles / nav rows use */
  readonly icon: ReactNode
  /**
   * The squircle tile's color key (the desktop tiles' own: 'settings',
   * 'templates', …). Absent = the plain line-icon slot (no tile chrome) —
   * the nav glyphs keep their un-tiled look when a host opts out.
   */
  readonly tile?: string
  /**
   * The nav-style active state: shows the indicator dot (macOS style) and
   * aria-current. The host owns the meaning — "the view this item opens is
   * the one showing".
   */
  readonly active?: boolean
  /**
   * The running indicator: the dot under an item whose target is OPEN but
   * not necessarily showing (a covered settings modal, an open drawer).
   * Same dot as `active` — macOS draws one indicator, whatever it vouches.
   */
  readonly running?: boolean
  /** run the item: a view switch, a launcher, the drawer's open verb */
  readonly onSelect: () => void
  /** the right-click menu's verbs; absent = no context menu on this item */
  readonly menu?: readonly DockMenuEntry[]
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
  /**
   * The magnification preference (设置 ▸ 程序坞): false is the static dock
   * by choice rather than by accessibility — distinct from reducedMotion,
   * which also stands the bounce down.
   */
  readonly magnify?: boolean
  /** physics overrides; defaults M = 1.7, σ = 1.6× the base icon size */
  readonly maxScale?: number
  readonly sigmaRatio?: number
  /** the base icon size in CSS px (the slot pitch at rest) */
  readonly baseSize?: number
  /**
   * The item id whose launch is in flight: its tile bounces (the steady
   * macOS keyframes) until the host clears it. The lifecycle — ready,
   * second-click cancel, the 8s cap — belongs to the host (dock-bounce.ts).
   */
  readonly bouncing?: string | null
  /**
   * The persisted item order (app-settings.json `dockPrefs.order`): applied
   * WITHIN each group, the group boundaries never moving (applyDockOrder).
   * Absent = the groups' own order.
   */
  readonly order?: readonly string[]
  /** the drag committed a new arrangement: the flat id sequence to persist */
  readonly onReorder?: (order: readonly string[]) => void
  /**
   * The host's handle on the pill's own element — Home threads the same ref
   * into the desktop view so its icon drag can hit-test a release against
   * the painted pill (the drop-onto-dock gesture). The dock keeps its own
   * internal ref live alongside this one.
   */
  readonly pillRef?: { current: HTMLElement | null }
  /**
   * An interaction that must hold the dock open (the context menu is open,
   * a drag is in progress) — the doc-mode entry pins its reveal on this so
   * the pill's own pointerleave cannot hide the dock under the menu.
   */
  readonly onInteractionChange?: (active: boolean) => void
  /** the pointer entered the pill — the Home auto-hide machine's show cue */
  readonly onPointerEnter?: () => void
  /** the pointer left the pill — the Home auto-hide machine's hide cue */
  readonly onPointerLeave?: () => void
  /** the auto-hide rest state: the pill slides below the window edge */
  readonly hidden?: boolean
}

/** the pointer travel that separates a drag from a click */
const DOCK_DRAG_THRESHOLD_PX = 6

/**
 * Snap every slot to rest: the inline widths and item transforms cleared,
 * the collapse transition class dropped. The fisheye's stand-down paths
 * (enter, leave, resize, cleanup) and the drag start all need the same
 * rest — a measurement taken while any inline width survives describes a
 * magnified layout, and the drag would reorder against phantom centers.
 * The slot being dragged is skipped: its transform belongs to the drag
 * layer, and the fisheye's cleanup (which runs when the drag starts) must
 * not wipe the tile the pointer is carrying.
 */
function snapSlotsToRest(root: HTMLElement): void {
  root.classList.remove('dock-collapsing')
  for (const slot of root.querySelectorAll<HTMLElement>('.dock-slot')) {
    if (slot.classList.contains('dock-dragging')) continue
    slot.style.width = ''
    const item = slot.firstElementChild
    if (item instanceof HTMLElement) item.style.transform = ''
  }
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

  // ── the arrangement: the persisted order applied within the groups, with
  // a live override while a drag is mid-flight (the swaps the person has
  // already passed land immediately; the commit is the drag's end) ──
  const groupIds = useMemo(
    () => props.groups.map((group) => group.map((item) => item.id)),
    [props.groups],
  )
  const [liveOrder, setLiveOrder] = useState<string[] | null>(null)
  const displayedIds = useMemo(
    () => applyDockOrder(groupIds, liveOrder ?? props.order ?? []),
    [groupIds, liveOrder, props.order],
  )
  const [draggingId, setDraggingId] = useState<string | null>(null)
  // the order the gesture layer re-arms on: any permutation (a live swap, a
  // committed drag, the host's persisted order changing) invalidates the
  // measured centers the same way a resize does
  const orderSignature = displayedIds.flat().join('|')

  // ── the parting FLIP: a composition change parts the row ──
  // The insert/remove half of the drop-into-dock moment: the row children
  // that keep their identity (slots AND separators) slide to their new
  // places — inline translateX from the old layout, transitioned home —
  // while a newcomer pops from the baseline instead (dockPartingPlan is the
  // pure planner). The first mount lays out still, and the drag's own live
  // swaps stay instant: the drag is the arrangement's authority while it
  // runs. During the parting the fisheye stands down (its measured centers
  // would fight mid-flight transforms); the settle timer clears the inline
  // styles and the fisheye re-arms, its next pointerenter measuring the
  // settled geometry. The doc-mode overlay gets the same parting for free
  // — its prefs push is a composition change like any other.
  const [parting, setParting] = useState(false)
  /** the pill's row children by key: `slot:<itemId>` / `sep:<groupIndex>` */
  const rowEls = useRef(new Map<string, HTMLElement>())
  /** the last layout pass's untransformed lefts, by the same keys */
  const rowLefts = useRef<Map<string, number> | null>(null)
  /** the signature the cached lefts describe */
  const rowSignature = useRef<string | null>(null)
  const partingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** end any in-flight parting: jump to the settled layout, clear the styles */
  const endParting = useCallback((): void => {
    if (partingTimer.current) {
      clearTimeout(partingTimer.current)
      partingTimer.current = null
    }
    const root = rootRef.current
    if (root) {
      for (const child of root.children) {
        if (!(child instanceof HTMLElement)) continue
        child.classList.remove('dock-slot-entering')
        child.style.transition = ''
        child.style.transform = ''
      }
    }
    setParting((was) => (was ? false : was))
  }, [])
  /** track one row child (ref callback) so the FLIP can measure it */
  const trackRowEl =
    (key: string) =>
    (el: HTMLElement | null): void => {
      if (el) rowEls.current.set(key, el)
      else rowEls.current.delete(key)
    }
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    // the fresh layout's lefts: offset metrics, immune to the transforms
    // the previous parting may still be painting
    const lefts = new Map<string, number>()
    for (const [key, el] of rowEls.current) lefts.set(key, el.offsetLeft)
    const prevLefts = rowLefts.current
    const prevSignature = rowSignature.current
    rowSignature.current = orderSignature
    rowLefts.current = lefts
    // still rows: the first mount, an unchanged composition (a slider pass,
    // an auto-hide flip), a drag in flight (its swaps are instant by
    // design), reduced motion (the insert is instant)
    const settled =
      prevSignature === null ||
      prevSignature === orderSignature ||
      draggingId !== null ||
      liveOrder !== null ||
      reducedMotion ||
      !prevLefts
    if (settled) {
      endParting()
      return
    }
    const plan = dockPartingPlan(prevLefts, lefts)
    if (plan.deltas.size === 0 && plan.entering.length === 0) {
      endParting()
      return
    }
    // anything still in flight describes a layout that no longer exists:
    // jump it to its end before the row parts again
    endParting()
    for (const [key, delta] of plan.deltas) {
      const el = rowEls.current.get(key)
      if (el) el.style.transform = `translateX(${delta}px)`
    }
    for (const key of plan.entering) {
      rowEls.current.get(key)?.classList.add('dock-slot-entering')
    }
    setParting(true)
    partingTimer.current = setTimeout(
      () => endParting(),
      Math.max(DOCK_PARTING_MS, DOCK_POP_MS) + 60,
    )
    // the slide begins on the next frame: the FLIP's starting transforms
    // must commit first, then the transition carries each slot home
    const frame = requestAnimationFrame(() => {
      for (const key of plan.deltas.keys()) {
        const el = rowEls.current.get(key)
        if (!el) continue
        el.style.transition = `transform ${DOCK_PARTING_MS}ms cubic-bezier(0.22, 0.61, 0.36, 1)`
        el.style.transform = ''
      }
    })
    return () => {
      cancelAnimationFrame(frame)
      endParting()
    }
  }, [orderSignature, draggingId, liveOrder, reducedMotion, endParting])

  // ── the context menu (right-click / Shift+F10 on a focused item) ──
  // anchored to the ITEM's own rect, not the pointer: the pointer's y is
  // inside the pill, so clamping "above the pointer" would land the menu on
  // the tiles — and the dock's rendered room above the pill is exactly the
  // headroom both mounts already reserve (the fisheye + tooltip band in the
  // doc-mode overlay's rect). The keyboard contextmenu (Shift+F10 / the
  // Menu key) carries no pointer coordinates at all; the focused button's
  // rect is a real anchor either way, with the item's center standing in
  // for the pointer's x.
  const [menu, setMenu] = useState<{ itemId: string; x: number; top: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useDismissablePopover(menu !== null, () => setMenu(null), {
    inside: () => [menuRef.current],
  })
  useEffect(() => {
    if (menu === null) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [menu])
  // place above the item, clamped into the viewport. The menu is portaled
  // to the body (the transformed pill would capture its fixed coordinates)
  // and zoomed with the interface scale (home.css), so the placement runs
  // in the pill's own chrome space: the anchor and the viewport divided by
  // the live scale, the rendered offsets multiplied back by it.
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!menu || !el) return
    const scale = chromeScale()
    const { left, top } = placeFolderMenu(
      { x: menu.x / scale, y: menu.top / scale, above: menu.top / scale },
      { width: el.offsetWidth, height: el.offsetHeight },
      {
        width: document.documentElement.clientWidth / scale,
        height: window.innerHeight / scale,
      },
    )
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }, [menu])
  // one interaction signal covers both pin cases (menu open, drag active):
  // the doc-mode entry holds its reveal while either runs. Destructured so
  // the effect's dependency is the callback itself, not the props object
  const onInteractionChange = props.onInteractionChange
  const interacting = menu !== null || draggingId !== null
  useEffect(() => {
    onInteractionChange?.(interacting)
    // the cleanup reports the end of every interaction, unmount included
    return () => onInteractionChange?.(false)
  }, [interacting, onInteractionChange])

  // ── the fisheye gesture layer ──
  useEffect(() => {
    const root = rootRef.current
    // a parting in flight stands the fisheye down: its measured centers
    // would fight mid-flight slot transforms, and the settle timer re-arms
    // this effect the moment the row lands (the next enter re-measures)
    if (!root || reducedMotion || props.magnify === false || draggingId || parting) return
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
      snapSlotsToRest(root)
      slots = [...root.querySelectorAll<HTMLDivElement>('.dock-slot')]
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
      snapSlotsToRest(root)
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
      // standing down (reduce motion flipped on mid-gesture, a drag started,
      // the order changed, or unmount): the slots must not keep the last
      // frame's inline widths, or the dock would freeze magnified with no
      // listener left to collapse it
      snapSlotsToRest(root)
    }
  }, [reducedMotion, props.magnify, draggingId, parting, orderSignature])

  // ── the drag layer (reorder within a group) ──
  // Pointer-only and threshold-gated, so an ordinary click never feels a
  // drag and the dock never becomes an HTML5 drag source (the desktop's
  // drop handlers keep the whole MIME channel — nothing here overlaps it).
  // The per-move path is write-only like the fisheye's: the slot rects are
  // measured ONCE at drag start (plus once after each swap), and the moves
  // only translate the dragged tile and compare the cached centers. The
  // move/up handlers live on the ROOT: once the drag captures the pointer
  // on the pill, every subsequent pointer event retargets there, so the
  // children's own handlers would go silent mid-drag.
  // Abandonment is handled three ways, because a pointer that crosses into
  // another native view (the document under the doc-mode overlay) delivers
  // no pointerup here: the root's pointerleave ends the drag, a move with
  // no buttons ends it, and the inactivity failsafe ends it — all without
  // a commit (the release point is unknown, so the arrangement stands).
  const dragState = useRef<{
    itemId: string
    pointerId: number
    startX: number
    started: boolean
    /** every pill child's center at rest (slots + separators), by child order */
    centers: number[]
  } | null>(null)
  /** the inactivity failsafe's timer; armed while a drag runs */
  const dragIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // a completed drag suppresses the click that pointerup synthesizes
  const suppressedClick = useRef(false)

  /** the pill's item/separator children in DOM order — the drag's slot model */
  const dragSlots = (): HTMLElement[] => {
    const root = rootRef.current
    if (!root) return []
    return [...root.children].filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement &&
        (child.classList.contains('dock-slot') || child.classList.contains('dock-separator')),
    )
  }

  const measureDragCenters = (): number[] =>
    dragSlots().map((child) => {
      const rect = child.getBoundingClientRect()
      return rect.left + rect.width / 2
    })

  const endDrag = (commit: boolean): void => {
    const state = dragState.current
    const root = rootRef.current
    dragState.current = null
    if (dragIdleTimer.current) {
      clearTimeout(dragIdleTimer.current)
      dragIdleTimer.current = null
    }
    if (root) {
      root.classList.remove('dock-drag-live')
      for (const child of dragSlots()) {
        child.classList.remove('dock-dragging')
        const item = child.firstElementChild
        if (item instanceof HTMLElement) item.style.transform = ''
      }
    }
    setDraggingId(null)
    if (state && commit && liveOrder) {
      props.onReorder?.(liveOrder)
      // the pointerup synthesizes a click on release — swallow it so the
      // arrangement does not also fire the item's verb (the click handler
      // consumes the flag; the timer is the safety for a release that
      // synthesizes nothing)
      suppressedClick.current = true
      setTimeout(() => {
        suppressedClick.current = false
      }, 0)
    }
    // the live order becomes the persisted order's business: drop it (the
    // host's write round-trips through the store and back as props.order —
    // or the arrangement falls back to the last persisted one)
    setLiveOrder(null)
  }

  /** arm/reset the inactivity failsafe: a drag that goes quiet ends itself */
  const armDragIdle = (): void => {
    if (dragIdleTimer.current) clearTimeout(dragIdleTimer.current)
    dragIdleTimer.current = setTimeout(() => {
      if (dragState.current?.started) endDrag(false)
    }, DOCK_DRAG_IDLE_MS)
  }

  const onSlotPointerDown = (event: React.PointerEvent, itemId: string): void => {
    if (event.button !== 0) return
    dragState.current = {
      itemId,
      pointerId: event.pointerId,
      startX: event.clientX,
      started: false,
      centers: [],
    }
  }

  const onRootPointerMove = (event: React.PointerEvent): void => {
    const state = dragState.current
    const root = rootRef.current
    if (!state || !root) return
    // a move with no buttons is a stale or abandoned press: a press whose
    // release landed elsewhere, or a pointer that came back after leaving
    // the renderer — either way nothing is being dragged anymore
    if (event.buttons === 0) {
      if (state.started) endDrag(false)
      else dragState.current = null
      return
    }
    if (!state.started) {
      // horizontal intent past the threshold begins the drag; a click or a
      // vertical escape (the desktop's drag-and-drop gestures live there)
      // never does
      const dx = event.clientX - state.startX
      if (Math.abs(dx) < DOCK_DRAG_THRESHOLD_PX) return
      state.started = true
      setDraggingId(state.itemId)
      // capture the pointer on the pill so the drag survives leaving any
      // single child, snap the fisheye to rest (the drag must measure the
      // REST geometry — inline magnification widths would feed it phantom
      // centers), end any parting still in flight (its slot transforms
      // would feed the same measurement phantoms), then measure
      root.setPointerCapture(state.pointerId)
      root.classList.add('dock-drag-live')
      endParting()
      snapSlotsToRest(root)
      state.centers = measureDragCenters()
      armDragIdle()
    } else {
      armDragIdle()
    }
    // the tile follows the pointer horizontally (the write-only move path).
    // The pointer delta is viewport px; the item's transform speaks the
    // pill's zoomed CSS px, so the delta lands in that space through the
    // same chromeScale the fisheye's σ uses — without it the tile outruns
    // the pointer at every scale above 1
    const slots = dragSlots()
    const own = slots.find((child) => child.dataset.itemId === state.itemId)
    if (own) {
      own.classList.add('dock-dragging')
      const center = state.centers[slots.indexOf(own)] ?? 0
      const item = own.firstElementChild
      if (item instanceof HTMLElement) {
        const dx = (event.clientX - center) / chromeScale()
        item.style.transform = `translateX(${dx}px) scale(1.06)`
      }
    }
    // the slot under the pointer: nearest cached center
    let nearest = -1
    let best = Number.POSITIVE_INFINITY
    state.centers.forEach((center, index) => {
      const distance = Math.abs(event.clientX - center)
      if (distance < best) {
        best = distance
        nearest = index
      }
    })
    if (nearest < 0) return
    const next = dockReorderAt(displayedIds, state.itemId, nearest)
    if (!next) return
    setLiveOrder(dockOrderOf(next))
    // the swap re-flowed the pill: re-measure on the next frame so the
    // pointer-to-slot math keeps speaking the new geometry
    requestAnimationFrame(() => {
      const live = dragState.current
      if (live?.started) live.centers = measureDragCenters()
    })
  }

  const onRootPointerUp = (event: React.PointerEvent): void => {
    const state = dragState.current
    const root = rootRef.current
    if (!state || !root) return
    if (state.started) {
      try {
        root.releasePointerCapture(state.pointerId)
      } catch {
        // the capture can be gone already (a cancel between events)
      }
      endDrag(true)
      event.preventDefault()
    } else {
      dragState.current = null
    }
  }

  const onRootPointerCancel = (): void => {
    if (dragState.current?.started) endDrag(false)
    else dragState.current = null
  }

  /** the pointer left the pill: an in-flight drag ends without a commit
   *  (the release point is unknown), and a mere press forgets itself */
  const onRootLeave = (): void => {
    if (dragState.current?.started) endDrag(false)
    else dragState.current = null
  }

  const itemsById = useMemo(() => {
    const map = new Map<string, DockItem>()
    for (const group of props.groups) for (const item of group) map.set(item.id, item)
    return map
  }, [props.groups])
  // the displayed arrangement: each group's items re-sequenced by the
  // (live or persisted) order, separators never moving
  const displayedGroups = useMemo(
    () =>
      displayedIds.map((ids) =>
        ids.map((id) => itemsById.get(id)).filter((item): item is DockItem => item !== undefined),
      ),
    [displayedIds, itemsById],
  )

  const menuEntries = menu ? (itemsById.get(menu.itemId)?.menu ?? null) : null
  const menuLabel = menu ? itemsById.get(menu.itemId)?.label : undefined

  /**
   * The root's ref callback, hoisted and memoized: an inline closure would
   * change identity every render, and React answers that with the full
   * detach/attach cycle — old(null) then new(node) — per re-render, leaving
   * the host's pill handle null for the commit's duration and churning
   * nothing but risk (a release that lands inside that window reads a null
   * ref). One stable callback (keyed on the host's ref object, itself
   * stable) keeps both refs live across every re-render.
   */
  const pillRef = props.pillRef
  const rootRefCallback = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node
      if (pillRef) pillRef.current = node
    },
    [pillRef],
  )

  return (
    <div
      className={`dock${props.hidden ? ' dock-hidden' : ''}`}
      ref={rootRefCallback}
      role="toolbar"
      aria-label={props.ariaLabel}
      style={{ '--dock-base': `${baseSize}px` } as React.CSSProperties}
      onPointerEnter={props.onPointerEnter}
      onPointerLeave={() => {
        onRootLeave()
        props.onPointerLeave?.()
      }}
      onPointerMove={onRootPointerMove}
      onPointerUp={onRootPointerUp}
      onPointerCancel={onRootPointerCancel}
    >
      {displayedGroups.map((group, groupIndex) => (
        <Fragment key={groupIndex}>
          {groupIndex > 0 && (
            <span
              className="dock-separator"
              aria-hidden="true"
              data-sep={groupIndex}
              ref={trackRowEl(`sep:${groupIndex}`)}
            />
          )}
          {group.map((item) => (
            <div
              key={item.id}
              className="dock-slot"
              data-item-id={item.id}
              ref={trackRowEl(`slot:${item.id}`)}
              onPointerDown={(event) => onSlotPointerDown(event, item.id)}
            >
              <button
                type="button"
                className="dock-item"
                data-tip={item.label}
                aria-label={item.label}
                aria-current={item.active ? 'true' : undefined}
                aria-haspopup={item.menu ? 'menu' : undefined}
                onClick={(event) => {
                  if (suppressedClick.current) {
                    suppressedClick.current = false
                    event.preventDefault()
                    return
                  }
                  item.onSelect()
                }}
                onContextMenu={
                  item.menu
                    ? (event) => {
                        event.preventDefault()
                        // the item's own rect anchors the menu (above it),
                        // and the keyboard contextmenu — which arrives with
                        // no pointer coordinates — falls back to the focused
                        // button's rect center; a real right-click steers
                        // the horizontal placement with its pointer x
                        const rect = event.currentTarget.getBoundingClientRect()
                        const keyboard = event.clientX === 0 && event.clientY === 0
                        setMenu({
                          itemId: item.id,
                          x: keyboard ? rect.left + rect.width / 2 : event.clientX,
                          top: rect.top,
                        })
                      }
                    : undefined
                }
              >
                {item.tile ? (
                  <span
                    className={[
                      'dock-tile',
                      `dock-tile-${item.tile}`,
                      props.bouncing === item.id && !reducedMotion ? 'dock-bouncing' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {item.icon}
                  </span>
                ) : (
                  item.icon
                )}
              </button>
              {/* the dot rides the slot, not the button: the button carries the
                  magnification transform and the indicator must not grow */}
              {(item.active || item.running) && <span className="dock-dot" aria-hidden="true" />}
            </div>
          ))}
        </Fragment>
      ))}
      {menuEntries &&
        menu &&
        createPortal(
          <div className="dock-menu" ref={menuRef} role="menu" aria-label={menuLabel}>
            {menuEntries.map((entry, index) => (
              <button
                key={index}
                type="button"
                role="menuitem"
                className={entry.danger ? 'danger' : undefined}
                onClick={() => {
                  setMenu(null)
                  entry.onSelect()
                }}
              >
                {entry.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  )
}
