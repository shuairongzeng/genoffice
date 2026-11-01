import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { AiDockPrefs } from '../../shared/home-api'
import {
  AI_DOCK_WIDTH_DEFAULT,
  AI_DOCK_WIDTH_MAX,
  AI_DOCK_WIDTH_MIN,
  normalizeAiDock,
  type AiPetPos,
} from '../../shared/desktop-geometry'
import { useI18n } from './locale'

/**
 * The workbench's AI surface, two layers of one state machine:
 *
 * - closed: the whole presence is the floating pet — the hand-drawn bird,
 *   `position: fixed` over the content area's bottom-right corner. It claims
 *   no layout width anywhere (the main process reserves nothing for it — see
 *   desktop-geometry.ts), so the content stage spans the full window right of
 *   the sidebar whether the panel is around or not.
 * - open: the drawer — a right-edge overlay panel that slides in over the
 *   content (`translateX`, instant under prefers-reduced-motion), never
 *   beside it. Esc, the scrim and the pet's click all close it; the width
 *   handle on the drawer's leading edge resizes it (committed to the prefs on
 *   release, never mid-drag; a double-click resets the default width).
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
 * plus 6px button padding), so constants describe it exactly. */

/** the pet button's size in chrome CSS px (the mascot SVG plus its padding) */
export const PET_SIZE = { width: 68, height: 62 } as const
/** the pet's default gap from the window's right and bottom edges */
export const PET_MARGIN = 16
/** pointer travel (viewport px) under which a press counts as a click, not a drag */
export const PET_CLICK_SLOP = 5

/**
 * Clamp a pet position into the window (and out of the open drawer's
 * footprint, via `reservedRight`): the pet never hangs off an edge and never
 * hides under the drawer it opens. Pure so the gesture and the tests share
 * one truth.
 */
export function clampPetPos(
  pos: AiPetPos,
  bounds: { width: number; height: number },
  size: { width: number; height: number },
  reservedRight = 0,
): AiPetPos {
  const maxX = Math.max(0, Math.round(bounds.width - size.width - reservedRight))
  const maxY = Math.max(0, Math.round(bounds.height - size.height))
  return {
    x: Math.min(Math.max(0, Math.round(pos.x)), maxX),
    y: Math.min(Math.max(0, Math.round(pos.y)), maxY),
  }
}

/** the default perch: the content corner (the window's bottom-right, the stage's own) */
function defaultPetPos(bounds: { width: number; height: number }): AiPetPos {
  return {
    x: bounds.width - PET_SIZE.width - PET_MARGIN,
    y: bounds.height - PET_SIZE.height - PET_MARGIN,
  }
}

/**
 * The interface scale as this renderer sees it (`--ui-scale`, an inline style
 * main writes onto `:root`). The pet's drag math converts pointer viewport px
 * into the zoomed chrome space through it; anything unreadable reads as 1.
 */
function chromeScale(): number {
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

  /** the width the open drawer reserves on the pet's right (only while it shows) */
  const reservedRight = open && !docActive ? Math.max(width, dragWidth ?? 0) + PET_MARGIN : 0

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

  const beginPetDrag = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
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

  /** the pet's whole click contract: a click toggles the drawer (open when
   *  closed, retract when open); the trailing click of a real drag is ignored */
  const onPetClick = () => {
    if (petDragMovedRef.current) return
    if (collapsed) onExpandRef.current()
    else onCollapseRef.current()
  }
  /** keyboard activation arrives without pointer events, so the drag flag resets here */
  const onPetKeyDown = () => {
    petDragMovedRef.current = false
  }

  /** Esc retracts the open drawer, the same as the scrim and the pet's click */
  useEffect(() => {
    if (!open || docActive) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCollapseRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, docActive])

  const shownWidth = dragWidth ?? width

  return (
    <>
      <button
        type="button"
        className="ai-pet"
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
        className={`ai-drawer${open ? ' open' : ''}${docActive ? ' doc-covered' : ''}`}
        aria-label={t('navAsk')}
      >
        <div className="ai-drawer-mask" aria-hidden="true" onClick={onCollapse} />
        <div className="ai-drawer-panel" style={{ width: shownWidth }}>
          <header className="ai-drawer-head">
            <span className="ai-drawer-title">{t('navAsk')}</span>
            <button
              type="button"
              className="ai-drawer-collapse"
              aria-label={t('dockCollapse')}
              title={t('dockCollapse')}
              onClick={onCollapse}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M6.2 3.4 10.8 8l-4.6 4.6"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </header>
          <div className="ai-drawer-body">{children}</div>
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
