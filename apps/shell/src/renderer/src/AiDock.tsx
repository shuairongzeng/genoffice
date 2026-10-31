import { useCallback, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { AiDockPrefs } from '../../shared/home-api'
import {
  AI_DOCK_RAIL_WIDTH,
  AI_DOCK_WIDTH_DEFAULT,
  AI_DOCK_WIDTH_MAX,
  AI_DOCK_WIDTH_MIN,
  normalizeAiDock,
} from '../../shared/desktop-geometry'
import { useI18n } from './locale'

/**
 * The workbench's docked AI panel: the knowledge-base ask panel rides in this
 * column beside the content area, always mounted, instead of taking the
 * content area over as a view. Home owns the prefs; this component owns the
 * shape — a slim header with the collapse control, the panel body, and a drag
 * handle on the leading edge that resizes the column (committed to the prefs
 * on release, never mid-drag; a double-click resets to the default width).
 *
 * The width clamps are the main process's own (shared/desktop-geometry.ts), so
 * the dock's CSS width and the document view's reserved footprint can never
 * disagree about where the divider lands.
 *
 * Collapsed, the column thins to the mascot rail and the panel's whole
 * presence becomes the mascot: a small hand-drawn bird perched at the rail's
 * foot — the content stage's bottom-right corner, reserved in the main
 * process's document bounds so the pet stays clickable beside a document.
 * Clicking it expands the dock again. The panel underneath stays mounted
 * while collapsed (CSS hides it), so a streaming answer keeps streaming and
 * the thread survives.
 */

export { AI_DOCK_WIDTH_DEFAULT, AI_DOCK_WIDTH_MAX, AI_DOCK_WIDTH_MIN, AI_DOCK_RAIL_WIDTH }
export type { AiDockPrefs }

/** where the dock prefs live while the app-settings IPC contract is absent */
const DOCK_PREFS_KEY = 'home.aiDock'

/**
 * Clamp a dragged width into the shared rails: the main process sizes a
 * document view from the same numbers (aiDockWidth), so a width the clamp
 * refuses here would never desync the divider.
 */
export function clampDockWidth(width: number): number {
  return Math.min(
    AI_DOCK_WIDTH_MAX,
    Math.max(AI_DOCK_WIDTH_MIN, Math.round(Number.isFinite(width) ? width : 0)),
  )
}

/** the shared `aiDock` normalizer, aliased for the dock's own call sites */
export const normalizeAiDockPrefs = normalizeAiDock

/** the session-scoped copy the dock reads before the main process answers */
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

export interface AiDockProps {
  /** the persisted collapse state; expanded renders the full column */
  collapsed: boolean
  /** the persisted width, already clamped by the prefs normalizer */
  width: number
  onCollapse: () => void
  onExpand: () => void
  /** a resize gesture ended (or the handle was double-clicked) with this width */
  onWidthCommit: (width: number) => void
  /** the panel itself, mounted by Home so it outlives the dock's collapse */
  children: ReactNode
}

export function AiDock({
  collapsed,
  width,
  onCollapse,
  onExpand,
  onWidthCommit,
  children,
}: AiDockProps): React.JSX.Element {
  const { t } = useI18n()
  /** the width shown while a drag is live; null when the persisted one stands */
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const draggingRef = useRef(false)
  const onWidthCommitRef = useRef(onWidthCommit)
  onWidthCommitRef.current = onWidthCommit

  /**
   * One resize gesture: window-level listeners for the whole drag (the handle
   * keeps no capture, so the pointer may wander off it), the live width
   * updating per move, and the commit landing only on release — the store
   * never sees a mid-drag value. A cancel (a pointercancel or a window blur)
   * rolls back with no commit.
   *
   * One release never arrives: past the maximum rail the handle stops
   * following while the pointer keeps going — into the embedded document
   * view, whose native layer swallows the move and the release alike. So the
   * gesture commits itself at the clamped maximum the moment the pointer
   * demands more than the rail allows, instead of hanging until some later
   * blur cancels it. The minimum rail needs no such exit: shrinking keeps the
   * pointer over this renderer's own dock body, where events still arrive.
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
        // past the maximum rail the pointer is over the document view's
        // native layer: no further moves and no release will arrive here, so
        // the drag commits at the clamped maximum now
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
        document.body.classList.remove('ai-dock-resizing')
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
      document.body.classList.add('ai-dock-resizing')
    },
    [width],
  )

  const shownWidth = dragWidth ?? width

  return (
    <section
      className={`ai-dock${collapsed ? ' collapsed' : ''}`}
      style={{ width: collapsed ? AI_DOCK_RAIL_WIDTH : shownWidth }}
      aria-label={t('navAsk')}
    >
      <header className="ai-dock-head">
        <span className="ai-dock-title">{t('navAsk')}</span>
        <button
          type="button"
          className="ai-dock-collapse"
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
      <div className="ai-dock-body">{children}</div>
      {!collapsed && (
        <div
          className="ai-dock-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('dockResize')}
          title={t('dockResize')}
          onPointerDown={beginResize}
          onDoubleClick={() => onWidthCommitRef.current(AI_DOCK_WIDTH_DEFAULT)}
        />
      )}
      <button
        type="button"
        className="ai-mascot"
        aria-label={t('dockExpand')}
        title={t('dockExpand')}
        onClick={onExpand}
      >
        <MascotSvg />
      </button>
    </section>
  )
}

/**
 * The collapsed dock's whole presence: a round bird drawn with a handful of
 * shapes. Blink and breathing are CSS keyframes (home.css) — a motion-sensitive
 * setup already zeroes every animation, so the bird simply sits still there.
 * Its colors live on custom properties so the chrome stays token-based.
 */
function MascotSvg(): React.JSX.Element {
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
