import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent, ReactElement, RefObject } from 'react'
import {
  SPLIT_DEFAULT_RATIO,
  SPLIT_MAX_RATIO,
  SPLIT_MIN_RATIO,
  type SplitPaneSide,
} from '../../shared/split-api'
import { useI18n } from './locale'

export interface SplitDividerProps {
  ratio: number
  activePane: SplitPaneSide
  containerRef: RefObject<HTMLDivElement | null>
  onRatioChange: (ratio: number, commit: boolean) => void
  onFocusPane?: (side: SplitPaneSide) => void
}

const KEYBOARD_STEP = 0.02

function clampSplitRatio(value: number): number {
  if (!Number.isFinite(value)) return SPLIT_DEFAULT_RATIO
  return Math.min(SPLIT_MAX_RATIO, Math.max(SPLIT_MIN_RATIO, value))
}

/**
 * Stage-level chrome overlay for split view: renders the active-pane accent
 * bar at the top edge and the draggable center separator between panes.
 */
export function SplitDivider({
  ratio,
  activePane,
  containerRef,
  onRatioChange,
  onFocusPane,
}: SplitDividerProps): ReactElement {
  const { t } = useI18n()
  const clampedPropRatio = clampSplitRatio(ratio)
  const [dragging, setDragging] = useState(false)
  const [dragRatio, setDragRatio] = useState<number | null>(null)
  const draggingRef = useRef(false)
  const latestRatioRef = useRef(clampedPropRatio)
  const rafIdRef = useRef<number | null>(null)

  if (!draggingRef.current) {
    latestRatioRef.current = clampedPropRatio
  }

  const cancelScheduledFrame = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }
  }, [])

  useEffect(() => cancelScheduledFrame, [cancelScheduledFrame])

  const displayRatio = dragging && dragRatio !== null ? dragRatio : clampedPropRatio
  const pct = displayRatio * 100

  const handlePointerDown = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    draggingRef.current = true
    setDragging(true)
    setDragRatio(latestRatioRef.current)
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // Ignore environments where pointer capture is unavailable.
    }
  }, [])

  const handlePointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect || rect.width <= 0) return
      const rawRatio = (e.clientX - rect.left) / rect.width
      const clamped = clampSplitRatio(rawRatio)
      latestRatioRef.current = clamped
      if (rafIdRef.current === null) {
        rafIdRef.current = requestAnimationFrame(() => {
          rafIdRef.current = null
          const next = latestRatioRef.current
          setDragRatio(next)
          onRatioChange(next, false)
        })
      }
    },
    [containerRef, onRatioChange],
  )

  const finishDrag = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return
      draggingRef.current = false
      cancelScheduledFrame()
      setDragging(false)
      setDragRatio(null)
      try {
        if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId)
        }
      } catch {
        // Ignore capture release errors on detached targets.
      }
      onRatioChange(latestRatioRef.current, true)
    },
    [cancelScheduledFrame, onRatioChange],
  )

  const handleDoubleClick = useCallback(() => {
    draggingRef.current = false
    cancelScheduledFrame()
    setDragging(false)
    setDragRatio(null)
    latestRatioRef.current = SPLIT_DEFAULT_RATIO
    onRatioChange(SPLIT_DEFAULT_RATIO, true)
  }, [cancelScheduledFrame, onRatioChange])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      let next: number | null = null
      if (e.key === 'ArrowLeft') {
        next = clampSplitRatio(latestRatioRef.current - KEYBOARD_STEP)
      } else if (e.key === 'ArrowRight') {
        next = clampSplitRatio(latestRatioRef.current + KEYBOARD_STEP)
      } else if (e.key === 'Home') {
        next = SPLIT_DEFAULT_RATIO
      }
      if (next === null) return
      e.preventDefault()
      latestRatioRef.current = next
      onRatioChange(next, true)
    },
    [onRatioChange],
  )

  return (
    <div className="split-stage-chrome">
      <div
        className={`split-pane-focus-bar is-left${activePane === 'left' ? ' is-active' : ''}`}
        style={{ left: 0, width: `calc(${pct}% - 4px)` }}
        onClick={onFocusPane ? () => onFocusPane('left') : undefined}
        aria-hidden="true"
      />
      <div
        className={`split-pane-focus-bar is-right${activePane === 'right' ? ' is-active' : ''}`}
        style={{ left: `calc(${pct}% + 4px)`, right: 0 }}
        onClick={onFocusPane ? () => onFocusPane('right') : undefined}
        aria-hidden="true"
      />
      <div
        className={`split-divider${dragging ? ' is-dragging' : ''}`}
        data-testid="split-divider"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('splitDividerAria')}
        title={t('splitDividerDoubleClickHint')}
        aria-valuenow={Math.round(displayRatio * 100)}
        aria-valuemin={Math.round(SPLIT_MIN_RATIO * 100)}
        aria-valuemax={Math.round(SPLIT_MAX_RATIO * 100)}
        tabIndex={0}
        style={{ left: `calc(${pct}% - 4px)` }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
      >
        <div className="split-divider-handle" />
      </div>
    </div>
  )
}
