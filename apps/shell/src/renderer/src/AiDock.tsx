import { createContext, useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { AiDockPrefs } from '../../shared/home-api'
import {
  AI_DOCK_WIDTH_DEFAULT,
  AI_DOCK_WIDTH_MAX,
  AI_DOCK_WIDTH_MIN,
  aiBubbleAnchor,
  clampPetPos,
  defaultPetPos,
  normalizeAiDock,
  PET_SIZE,
  type AiPetPos,
} from '../../shared/desktop-geometry'
import { useI18n } from './locale'

/** the bubble's drag verb for the panel's header (the bubble hangs off the
 *  pet, so dragging the header IS dragging the pet — the same gesture, the
 *  same commit). The dock provides it; the panel reads it when its own prop
 *  is absent. */
export const BubbleDragContext = createContext<
  ((event: ReactPointerEvent<HTMLElement>) => void) | null
>(null)

/**
 * The workbench's AI surface, two layers of one state machine:
 *
 * - closed: the whole presence is the floating pet — the hand-drawn bird,
 *   `position: fixed` over the content area's bottom-right corner. It claims
 *   no layout width anywhere (the main process reserves nothing for it — see
 *   desktop-geometry.ts), so the content stage spans the full window right of
 *   the sidebar whether the panel is around or not.
 * - open: the drawer — a right-edge overlay panel, never beside the content.
 *   The open/close transformation is the pet ⇄ panel morph: the panel grows
 *   out of the pet's own rect and shrinks back into it (the keyframes in
 *   home.css, the origin computed per toggle from the pet's live position —
 *   see drawerMorphFromPet), instant under prefers-reduced-motion. Esc, the
 *   scrim and the pet's click all close it (each through the same morph,
 *   gated while one runs); the width handle on the drawer's leading edge
 *   resizes it (committed to the prefs on release, never mid-drag; a
 *   double-click resets the default width).
 *
 * The panel body (Home's KbAskPanel) stays mounted in both states and through
 * every transition — closing hides it, it never unmounts, so a streaming
 * answer keeps streaming and the thread survives.
 *
 * The document-mode seam: while a document tab is active its native
 * WebContentsView paints above this whole renderer, drawer and pet included.
 * The drawer still shows there — hosted by a native overlay view
 * (main/ai-drawer-view.ts) sized from the same `aiDock` prefs this component
 * writes, loading the panel's standalone mount plus its own copy of the pet
 * (the overlay's collapse control). This renderer's drawer stays
 * `.doc-covered` — hidden, the panel mounted underneath — and its pet is
 * covered by the document either way; the overlay's pet is the one reachable
 * in that state. The two panels are independent sessions: a thread started
 * over a document is not in Home's thread list (the W1 seam's known
 * simplification).
 *
 * Home owns the prefs; this component owns the shape and the gestures — the
 * pet's drag (pointer events, a sub-5px slop counts as a click, the position
 * clamped inside the window and committed on release) and the width's drag
 * (the same commit-on-release contract the docked column had).
 */

export { AI_DOCK_WIDTH_DEFAULT, AI_DOCK_WIDTH_MAX, AI_DOCK_WIDTH_MIN }
export type { AiDockPrefs, AiPetPos }
// the pet's geometry moved to the shared module: the native overlay's
// pet-only view must size and clamp the bird identically, and its import
// sites (panel-entry) keep reaching for them here
export { PET_SIZE, PET_MARGIN, clampPetPos, defaultPetPos } from '../../shared/desktop-geometry'

/** where the drawer prefs live while the app-settings IPC contract is absent */
const DOCK_PREFS_KEY = 'home.aiDock'

/**
 * Clamp a dragged width into the shared rails: the main process reads the same
 * numbers (aiDockWidth), so a width the clamp refuses here would never desync
 * the drawer's footprint.
 */
export function clampDockWidth(width: number): number {
  return Math.min(
    AI_DOCK_WIDTH_MAX,
    Math.max(AI_DOCK_WIDTH_MIN, Math.round(Number.isFinite(width) ? width : 0)),
  )
}

/** the shared `aiDock` normalizer, aliased for the drawer's own call sites */
export const normalizeAiDockPrefs = normalizeAiDock

/** the session-scoped copy the drawer reads before the main process answers */
export function readLocalAiDockPrefs(): AiDockPrefs {
  try {
    return normalizeAiDock(JSON.parse(localStorage.getItem(DOCK_PREFS_KEY) ?? 'null'))
  } catch {
    return normalizeAiDock(null)
  }
}

export function writeLocalAiDockPrefs(prefs: AiDockPrefs): void {
  try {
    localStorage.setItem(DOCK_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // quota / private mode: the choice lasts this session only
  }
}

/* ── the pet's geometry ──
 * All in the `zoom`ed chrome coordinate space (the same space the drawer
 * width lives in): the pet is a child of the zoomed app frame, so its
 * left/top are CSS px there and its window footprint multiplies by the
 * interface scale. The pet's own box is a fixed-size drawing (56×50 mascot
 * plus 6px button padding), so constants describe it exactly — the size,
 * the margin, the clamp and the default perch live in desktop-geometry.ts
 * now, shared with the native overlay's pet-only view (re-exported above);
 * the slop below is a gesture rule, so it stays with the gestures. */

/** pointer travel (viewport px) under which a press counts as a click, not a drag */
export const PET_CLICK_SLOP = 5

/* ── the pet ⇄ panel morph ──
 * The pet and the drawer are one creature in two forms; the morph makes the
 * transformation visible. The open keyframes grow the panel out of the pet's
 * own rect (scale/opacity/border-radius), the close keyframes shrink it back
 * into the same spot — both anchored at a transform-origin computed at the
 * moment of the toggle, because the pet can be dragged anywhere and the
 * shrink must land where the bird actually is. Pure math, exported so the
 * geometry is testable alone; the CSS (home.css) reads the answer through
 * custom properties. */

/** the pet button's corner rounding (CSS px, .ai-pet's border-radius) */
const PET_CORNER_RADIUS = 14

/** the morph's computed facts, all in the panel's LOCAL (chrome) space */
export interface DrawerMorph {
  /** the transform-origin x (chrome px): the pet's center over the panel */
  readonly originX: number
  /** the transform-origin y (chrome px) */
  readonly originY: number
  /** the from-scale x that renders the panel at the pet's width */
  readonly scaleX: number
  /** the from-scale y that renders the panel at the pet's height */
  readonly scaleY: number
  /** the from border-radius (chrome px) that renders the pet's rounding */
  readonly radius: number
}

/**
 * The morph between the pet's rect and the panel's: the origin is the pet's
 * CENTER expressed in the panel's local space (viewport rects in, chrome px
 * out — the renderer is `zoom`ed, so the division by `scale` lands the
 * origin where the bird actually perches), and the from-scales are the pet's
 * footprint over the panel's box, so the keyframes' `from` state paints the
 * panel exactly as the pet's size and shape. The panel's own x is passed in
 * as its OPEN-position left (the closed panel is translated offscreen, so
 * the caller derives it from the bubble's anchor math — the bubble hangs off
 * the pet, not off the window's right edge). Rects with no box (jsdom, a
 * not-yet-laid-out tree) answer null: no honest morph, the caller falls back
 * to the plain flip.
 */
export function drawerMorphFromPet(
  pet: { x: number; y: number; width: number; height: number },
  panel: { x: number; y: number; width: number; height: number },
  scale = 1,
): DrawerMorph | null {
  if (pet.width <= 0 || pet.height <= 0 || panel.width <= 0 || panel.height <= 0) return null
  const petCx = pet.x + pet.width / 2
  const petCy = pet.y + pet.height / 2
  const scaleX = pet.width / panel.width
  const scaleY = pet.height / panel.height
  return {
    originX: (petCx - panel.x) / scale,
    originY: (petCy - panel.y) / scale,
    scaleX,
    scaleY,
    // the pet's rendered rounding, expressed in the panel's local space: the
    // stronger shrink direction wins (a tall panel shrinks far more in y, so
    // the y curvature is the honest one to match)
    radius: PET_CORNER_RADIUS / Math.min(scaleX, scaleY),
  }
}

/** prefers-reduced-motion, guarded for test DOMs that lack matchMedia */
export function aiMotionReduced(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/** the morph timings (CSS mirrors these; the timers clear the classes) */
export const DRAWER_MORPH_OPEN_MS = 250
export const DRAWER_MORPH_CLOSE_MS = 220
export const PET_GULP_MS = 300

/**
 * The interface scale as this renderer sees it (`--ui-scale`, an inline style
 * main writes onto `:root`). The pet's drag math converts pointer viewport px
 * into the zoomed chrome space through it; anything unreadable reads as 1.
 * Exported for the ask panel's standalone mount (panel-entry.tsx), whose
 * pet-only drag divides by the same scale.
 */
export function chromeScale(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')
  const scale = Number.parseFloat(raw)
  return Number.isFinite(scale) && scale > 0 ? scale : 1
}

export interface AiDockProps {
  /** the persisted drawer state; false renders the overlay panel */
  collapsed: boolean
  /** the persisted width, already clamped by the prefs normalizer */
  width: number
  /** the persisted pet position (chrome CSS px); null anchors the default corner */
  petPos: AiPetPos | null
  /**
   * A document tab is the active tab: its native view covers this renderer, so
   * the drawer stays hidden (display: none — the panel stays mounted) while
   * the native overlay view (main/ai-drawer-view.ts) hosts the drawer's
   * visual over the document, driven by the same recorded open state.
   */
  docActive: boolean
  onCollapse: () => void
  onExpand: () => void
  /** a resize gesture ended (or the handle was double-clicked) with this width */
  onWidthCommit: (width: number) => void
  /** the pet's drag ended with this position (clamped; never mid-drag) */
  onPetPosCommit: (pos: AiPetPos) => void
  /** the panel itself, mounted by Home so it outlives the drawer's closing */
  children: ReactNode
}

export function AiDock({
  collapsed,
  width,
  petPos,
  docActive,
  onCollapse,
  onExpand,
  onWidthCommit,
  onPetPosCommit,
  children,
}: AiDockProps): React.JSX.Element {
  const { t } = useI18n()
  const open = !collapsed

  /** the width shown while a drag is live; null when the persisted one stands */
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const draggingRef = useRef(false)
  const onWidthCommitRef = useRef(onWidthCommit)
  onWidthCommitRef.current = onWidthCommit

  /** the window's size in the zoomed chrome space, tracked across resizes */
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth / chromeScale(),
    height: window.innerHeight / chromeScale(),
  }))
  useEffect(() => {
    const onResize = () =>
      setViewport({
        width: window.innerWidth / chromeScale(),
        height: window.innerHeight / chromeScale(),
      })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  /** the pet needs no drawer clearance: at z 45 it floats ABOVE the open
   *  drawer (40), and while the drawer is open it is hidden (pet-hidden) —
   *  the panel is the bird then; dragging the panel's header carries this
   *  (invisible) position, so the bubble keeps its anchor */
  const reservedRight = 0

  /**
   * One resize gesture: window-level listeners for the whole drag (the handle
   * keeps no capture, so the pointer may wander off it), the live width
   * updating per move, and the commit landing only on release — the store
   * never sees a mid-drag value. A cancel (a pointercancel or a window blur)
   * rolls back with no commit.
   *
   * One release never arrives: past the maximum rail the handle stops
   * following while the pointer keeps going — under the open drawer's scrim
   * the events still arrive, but a native layer above this renderer (a pinned
   * widget, a detached window overlapping the shell) would swallow the move
   * and the release alike. So the gesture commits itself at the clamped
   * maximum the moment the pointer demands more than the rail allows. The
   * minimum rail needs no such exit: shrinking keeps the pointer over this
   * renderer's own chrome.
   */
  const beginResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || draggingRef.current) return
      draggingRef.current = true
      const startX = event.clientX
      const startWidth = width
      let next = startWidth
      let moved = false
      const onMove = (ev: PointerEvent) => {
        const demanded = startWidth + (startX - ev.clientX)
        const w = clampDockWidth(demanded)
        // past the maximum rail the pointer may be over a native layer: no
        // further moves and no release will arrive here, so the drag commits
        // at the clamped maximum now
        const pastMaximum = demanded > AI_DOCK_WIDTH_MAX
        if (moved && w === next && !pastMaximum) return
        moved = true
        next = w
        setDragWidth(w)
        if (pastMaximum) finish(true)
      }
      const finish = (commit: boolean) => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onCancel)
        window.removeEventListener('blur', onCancel)
        document.body.classList.remove('ai-drawer-resizing')
        draggingRef.current = false
        setDragWidth(null)
        if (commit && moved) onWidthCommitRef.current(next)
      }
      const onUp = () => finish(true)
      const onCancel = () => finish(false)
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onCancel)
      window.addEventListener('blur', onCancel)
      document.body.classList.add('ai-drawer-resizing')
    },
    [width],
  )

  /* ── the pet's drag: the same gesture shape the width handle uses ── */
  /** the position shown while a drag is live; null when the persisted one stands */
  const [dragPos, setDragPos] = useState<AiPetPos | null>(null)
  const petDraggingRef = useRef(false)
  /** true from the slop crossing until the next press: the trailing click of a
   *  finished drag must not toggle the drawer (a keyboard press resets it) */
  const petDragMovedRef = useRef(false)
  const onExpandRef = useRef(onExpand)
  onExpandRef.current = onExpand
  const onCollapseRef = useRef(onCollapse)
  onCollapseRef.current = onCollapse
  const onPetPosCommitRef = useRef(onPetPosCommit)
  onPetPosCommitRef.current = onPetPosCommit

  /** the pet's shown position: the drag's live value, else the stored (or
   *  default) one, clamped into the window and out of the open drawer */
  const shownPetPos =
    dragPos ?? clampPetPos(petPos ?? defaultPetPos(viewport), viewport, PET_SIZE, reservedRight)
  const shownPetPosRef = useRef(shownPetPos)
  shownPetPosRef.current = shownPetPos
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport
  const reservedRightRef = useRef(reservedRight)
  reservedRightRef.current = reservedRight

  const beginPetDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || petDraggingRef.current) return
    petDraggingRef.current = true
    petDragMovedRef.current = false
    const scale = chromeScale()
    const startX = event.clientX
    const startY = event.clientY
    const startPos = shownPetPosRef.current
    let next = startPos
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      // under the slop this is still the press that precedes a click, not a drag
      if (!petDragMovedRef.current) {
        if (Math.hypot(dx, dy) < PET_CLICK_SLOP) return
        petDragMovedRef.current = true
        document.body.classList.add('ai-pet-dragging')
      }
      next = clampPetPos(
        { x: startPos.x + dx / scale, y: startPos.y + dy / scale },
        viewportRef.current,
        PET_SIZE,
        reservedRightRef.current,
      )
      setDragPos(next)
    }
    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('blur', onCancel)
      document.body.classList.remove('ai-pet-dragging')
      petDraggingRef.current = false
      setDragPos(null)
      if (commit && petDragMovedRef.current) onPetPosCommitRef.current(next)
    }
    const onUp = () => finish(true)
    const onCancel = () => finish(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('blur', onCancel)
  }, [])

  /* ── the pet ⇄ panel morph ──
   * The prop's edge arms it: whatever flipped the drawer (the pet, the scrim,
   * Esc, a broadcast from the overlay's pet) gets the same transformation,
   * because the morph watches the state, not the gesture. The origin comes
   * from the pet's LIVE rect at the moment of the toggle (the bird may have
   * been dragged anywhere) and the panel's open-position box; reduced motion
   * skips the whole thing (the flip is instant, the CSS global rule would
   * zero the keyframes anyway — this also skips the click gate, so a
   * motion-sensitive setup never eats a toggle). While a morph runs the
   * in-drawer toggles are ignored: a second toggle mid-flight would stutter
   * the transformation (and race its timers). */
  const [morph, setMorph] = useState<DrawerMorph | null>(null)
  const [morphPhase, setMorphPhase] = useState<'open' | 'close' | null>(null)
  const [petGulp, setPetGulp] = useState(false)
  const morphBusyRef = useRef(false)
  const petRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const morphTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const gulpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevOpenRef = useRef(open)

  useEffect(() => {
    if (prevOpenRef.current === open) return
    prevOpenRef.current = open
    if (aiMotionReduced()) return
    const petRect = petRef.current?.getBoundingClientRect()
    const panelRect = panelRef.current?.getBoundingClientRect()
    const scale = chromeScale()
    // the panel's open-position left: the bubble hangs its RIGHT edge off the
    // pet (aiBubbleAnchor), NOT off the window's right edge — the live rect's
    // x is unreadable on the close flip (the closed panel is translateX(100%)
    // offscreen), and the old window-edge assumption flew the close morph
    // across the desktop once the pet had been dragged away from the corner
    const vw = viewportRef.current
    const anchor = aiBubbleAnchor(shownPetPosRef.current, vw, dragWidth ?? width)
    const openLeft = (vw.width - anchor.right - (dragWidth ?? width)) * scale
    const plan =
      petRect && panelRect
        ? drawerMorphFromPet(
            { x: petRect.left, y: petRect.top, width: petRect.width, height: petRect.height },
            {
              x: openLeft,
              y: panelRect.top,
              width: panelRect.width,
              height: panelRect.height,
            },
            scale,
          )
        : null
    if (!plan) return
    const phase = open ? 'open' : 'close'
    morphBusyRef.current = true
    setMorph(plan)
    setMorphPhase(phase)
    if (morphTimerRef.current) clearTimeout(morphTimerRef.current)
    morphTimerRef.current = setTimeout(
      () => {
        morphTimerRef.current = null
        morphBusyRef.current = false
        setMorph(null)
        setMorphPhase(null)
        // the close lands: the pet swallows — the squash-and-settle gulp, the
        // satisfied munch after the panel is eaten
        if (phase === 'close') {
          setPetGulp(true)
          if (gulpTimerRef.current) clearTimeout(gulpTimerRef.current)
          gulpTimerRef.current = setTimeout(() => {
            gulpTimerRef.current = null
            setPetGulp(false)
          }, PET_GULP_MS)
        }
      },
      (open ? DRAWER_MORPH_OPEN_MS : DRAWER_MORPH_CLOSE_MS) + 30,
    )
  }, [open])

  useEffect(
    () => () => {
      if (morphTimerRef.current) clearTimeout(morphTimerRef.current)
      if (gulpTimerRef.current) clearTimeout(gulpTimerRef.current)
    },
    [],
  )

  /** the drawer's own collapse paths (the scrim, the header's ×): gated like
   *  the pet's click so a mid-morph press never stutters the transformation */
  const requestCollapse = (): void => {
    if (morphBusyRef.current) return
    onCollapseRef.current()
  }

  /** the pet's whole click contract: a click toggles the drawer (open when
   *  closed, retract when open); the trailing click of a real drag is ignored,
   *  and so is any click while a morph is still transforming */
  const onPetClick = () => {
    if (petDragMovedRef.current) return
    if (morphBusyRef.current) return
    if (collapsed) onExpandRef.current()
    else onCollapseRef.current()
  }
  /** keyboard activation arrives without pointer events, so the drag flag resets here */
  const onPetKeyDown = () => {
    petDragMovedRef.current = false
  }

  /** Esc retracts the open drawer, the same as the scrim and the pet's click
   *  (and through the same morph, with the same mid-flight gate) */
  useEffect(() => {
    if (!open || docActive) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (morphBusyRef.current) return
      onCollapseRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, docActive])

  const shownWidth = dragWidth ?? width

  /** the bubble's anchor: the panel sizes to its content and hangs off the
   *  pet (bottom-anchored above it, so a growing conversation stretches
   *  upward while the bird stays put — and follows a drag live), clamped
   *  into the window horizontally so a far-left pet never parks the panel
   *  offscreen */
  const bubble = aiBubbleAnchor(shownPetPos, viewport, shownWidth)

  return (
    <>
      <button
        type="button"
        ref={petRef}
        className={`ai-pet${open ? ' pet-hidden' : ''}${morphPhase === 'open' ? ' absorb' : ''}${petGulp ? ' gulp' : ''}`}
        style={{ left: shownPetPos.x, top: shownPetPos.y }}
        aria-label={t(collapsed ? 'dockExpand' : 'dockCollapse')}
        title={t(collapsed ? 'dockExpand' : 'dockCollapse')}
        aria-expanded={open}
        onPointerDown={beginPetDrag}
        onClick={onPetClick}
        onKeyDown={onPetKeyDown}
      >
        <MascotSvg />
      </button>
      {/* doc-covered: the document's native view paints above this whole
       * renderer, and the drawer's visual is hosted by the native overlay
       * view above it (main/ai-drawer-view.ts) — this HTML copy stays hidden
       * (the panel mounted underneath) while that one shows. */}
      <section
        className={`ai-drawer${open ? ' open' : ''}${docActive ? ' doc-covered' : ''}${
          morphPhase ? ` morph-${morphPhase}` : ''
        }`}
        aria-label={t('navAsk')}
      >
        <div className="ai-drawer-mask" aria-hidden="true" onClick={requestCollapse} />
        <div
          ref={panelRef}
          className="ai-drawer-panel"
          style={
            morph
              ? ({
                  width: shownWidth,
                  right: bubble.right,
                  ...(bubble.bottom !== undefined ? { bottom: bubble.bottom } : {}),
                  ...(bubble.top !== undefined ? { top: bubble.top } : {}),
                  maxHeight: bubble.maxHeight,
                  transformOrigin: `${morph.originX}px ${morph.originY}px`,
                  '--morph-sx': morph.scaleX,
                  '--morph-sy': morph.scaleY,
                  '--morph-radius': `${morph.radius}px`,
                } as React.CSSProperties)
              : ({
                  width: shownWidth,
                  right: bubble.right,
                  ...(bubble.bottom !== undefined ? { bottom: bubble.bottom } : {}),
                  ...(bubble.top !== undefined ? { top: bubble.top } : {}),
                  maxHeight: bubble.maxHeight,
                } as React.CSSProperties)
          }
        >
          {/* the bubble's whole chrome is the panel's own merged header (its
              ☰ title ⋯ × row) — the drawer's separate head is gone; the
              collapse verb lives in the panel's ×, threaded back through
              Home as onCollapse */}
          <div className="ai-drawer-body">
            <BubbleDragContext.Provider value={beginPetDrag}>{children}</BubbleDragContext.Provider>
          </div>
          {open && (
            <div
              className="ai-drawer-resize"
              role="separator"
              aria-orientation="vertical"
              aria-label={t('dockResize')}
              title={t('dockResize')}
              onPointerDown={beginResize}
              onDoubleClick={() => onWidthCommitRef.current(AI_DOCK_WIDTH_DEFAULT)}
            />
          )}
        </div>
      </section>
    </>
  )
}

/**
 * The pet's whole presence: a round bird drawn with a handful of shapes.
 * Blink and breathing are CSS keyframes (home.css) — a motion-sensitive
 * setup already zeroes every animation, so the bird simply sits still there.
 * Its colors live on custom properties so the chrome stays token-based.
 *
 * Exported because the ask panel's standalone mount (panel-entry.tsx — the
 * surface the W2 native overlay view loads over a document) renders its own
 * pet as the overlay's collapse control: the same drawing, so the bird is
 * one bird whichever layer it perches on.
 */
export function MascotSvg(): React.JSX.Element {
  return (
    <svg
      className="ai-mascot-svg"
      viewBox="0 0 72 64"
      width="56"
      height="50"
      fill="none"
      aria-hidden="true"
    >
      <g className="ai-mascot-breathe">
        {/* head tuft: two feathers */}
        <path
          className="ai-mascot-tuft"
          d="M31.5 19.5q1.8-6 6.5-6.5"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          className="ai-mascot-tuft"
          d="M36.5 18.5q3-4.5 7.5-3.5"
          strokeWidth="2"
          strokeLinecap="round"
        />
        {/* body and belly */}
        <ellipse className="ai-mascot-shape" cx="36" cy="39" rx="24" ry="20" />
        <ellipse className="ai-mascot-belly" cx="36" cy="46" rx="12.5" ry="8.5" />
        {/* wing */}
        <path className="ai-mascot-wing" d="M14.5 37.5q4.5 8.5 14.5 6.5q-4.5-6.5-14.5-6.5Z" />
        {/* eyes: the inner group is what the blink keyframe folds */}
        <g className="ai-mascot-eye" transform="translate(27.5 33)">
          <g className="ai-mascot-blink">
            <ellipse className="ai-mascot-eyeball" rx="4.7" ry="4.7" />
            <circle className="ai-mascot-pupil" cx="0.9" cy="0.7" r="2.05" />
            <circle className="ai-mascot-glint" cx="-1.6" cy="-1.7" r="0.95" />
          </g>
        </g>
        <g className="ai-mascot-eye" transform="translate(44.5 33)">
          <g className="ai-mascot-blink">
            <ellipse className="ai-mascot-eyeball" rx="4.7" ry="4.7" />
            <circle className="ai-mascot-pupil" cx="-0.9" cy="0.7" r="2.05" />
            <circle className="ai-mascot-glint" cx="1.6" cy="-1.7" r="0.95" />
          </g>
        </g>
        {/* beak and blush */}
        <path className="ai-mascot-beak" d="M33 38.5 36 42.5 39 38.5Z" />
        <ellipse className="ai-mascot-blush" cx="20.5" cy="40.5" rx="3.4" ry="2.2" />
        <ellipse className="ai-mascot-blush" cx="51.5" cy="40.5" rx="3.4" ry="2.2" />
      </g>
    </svg>
  )
}
