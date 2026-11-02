import { useEffect, useRef, useState } from 'react'
import type { Lang } from '@genoffice/i18n'

import { TodoWidget } from './TodoWidget'

/**
 * The todo card's floating home on the desktop (the retired sidebar's
 * quick-capture card, promoted to desktop furniture — the macOS route: the
 * desktop and the dock are the whole chrome, so the card lives on the
 * surface like an icon, not in a column).
 *
 * Why this and not the pinned-widgets system: a pin is a live document
 * WINDOW — its own WebContentsView, its own renderer, a file-path identity
 * and a close/reopen lifecycle — a checkbox list wants none of that; one
 * React card in the desktop's own renderer costs nothing per mount. And
 * why not the desktop's icon-grid positions: the grid quantizes icon cells
 * for the marquee/keyboard math, while a card is a free two-number
 * position. So the card carries its own `left/top`, persisted through the
 * same local-prefs pattern the retired sidebar rail used (no main-process
 * consumer: a failed write costs the placement this session only).
 *
 * The drag follows the codebase's write-only discipline: the move path
 * writes the root's inline position imperatively (one element, no layout
 * reads after the single drag-start measurement), and the release commits
 * the final numbers to state and the store.
 */

/** where the card's placement lives between mounts */
const TODO_CARD_POS_KEY = 'home.todo-card'

/** the card's rendered width (home.css .desktop-todo) */
const CARD_WIDTH = 264
/** the clearance the card keeps from the stage's edges */
const EDGE = 8
/** below the tab strip (44px) — the card never rides under it */
const MIN_TOP = 52

interface TodoCardPos {
  left: number
  top: number
}

/**
 * The stage the card floats in: the nearest positioned ancestor (the
 * desktop-mode Home root). The parentElement fallback is for hosts without
 * layout engines (jsdom) — offsetParent reads null there, while the element
 * tree is still real.
 */
function stageOf(root: HTMLElement): HTMLElement | null {
  const parent = root.offsetParent
  if (parent instanceof HTMLElement) return parent
  const fallback = root.parentElement
  return fallback instanceof HTMLElement ? fallback : null
}

/** the persisted placement; null for anything unreadable (the default perch) */
function readPos(): TodoCardPos | null {
  try {
    const raw = JSON.parse(
      localStorage.getItem(TODO_CARD_POS_KEY) ?? 'null',
    ) as Partial<TodoCardPos> | null
    if (!raw || typeof raw.left !== 'number' || typeof raw.top !== 'number') return null
    if (!Number.isFinite(raw.left) || !Number.isFinite(raw.top)) return null
    return { left: raw.left, top: raw.top }
  } catch {
    return null
  }
}

function writePos(pos: TodoCardPos): void {
  try {
    localStorage.setItem(TODO_CARD_POS_KEY, JSON.stringify(pos))
  } catch {
    // quota / private mode: the placement lasts this session only
  }
}

export function TodoCard({ lang }: { lang: Lang }): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<TodoCardPos | null>(() => readPos())

  // the first mount without a stored placement takes the default perch:
  // the stage's right edge, below the strip (measured once — the parent is
  // the positioned .home, whose size the card cannot know before render)
  useEffect(() => {
    if (pos) return
    const parent = rootRef.current ? stageOf(rootRef.current) : null
    if (!parent) return
    setPos({
      left: Math.max(EDGE, parent.clientWidth - CARD_WIDTH - 16),
      top: MIN_TOP + 12,
    })
  }, [pos])

  // ── the drag: the head band is the handle; the card's inline position is
  // written imperatively per move and committed on release ──
  const drag = useRef<{
    pointerId: number
    startX: number
    startY: number
    baseLeft: number
    baseTop: number
    /** the parent's live size, measured once at drag start for the clamp */
    maxX: number
    maxY: number
    moved: boolean
  } | null>(null)

  const clampPos = (left: number, top: number, maxX: number, maxY: number): TodoCardPos => ({
    left: Math.min(Math.max(EDGE, left), Math.max(EDGE, maxX - CARD_WIDTH)),
    top: Math.min(Math.max(MIN_TOP, top), Math.max(MIN_TOP, maxY - 80)),
  })

  const onHeadPointerDown = (event: React.PointerEvent): void => {
    if (event.button !== 0) return
    const root = rootRef.current
    const head = headRef.current
    if (!root || !head || !pos) return
    const parent = stageOf(root)
    if (!parent) return
    // the one measurement of the drag: the stage's live box, for the clamp
    const maxX = parent.clientWidth
    const maxY = parent.clientHeight
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseLeft: pos.left,
      baseTop: pos.top,
      maxX,
      maxY,
      moved: false,
    }
    head.setPointerCapture(event.pointerId)
  }

  const onHeadPointerMove = (event: React.PointerEvent): void => {
    const state = drag.current
    const root = rootRef.current
    const head = headRef.current
    if (!state || !root || !head) return
    if (event.buttons === 0) {
      // a stale press (the release landed elsewhere): nothing is being dragged
      drag.current = null
      return
    }
    const next = clampPos(
      state.baseLeft + event.clientX - state.startX,
      state.baseTop + event.clientY - state.startY,
      state.maxX,
      state.maxY,
    )
    state.moved = true
    root.classList.add('dragging')
    head.classList.add('dragging')
    root.style.left = `${next.left}px`
    root.style.top = `${next.top}px`
  }

  const onHeadPointerUp = (): void => {
    const state = drag.current
    const root = rootRef.current
    const head = headRef.current
    drag.current = null
    if (!state || !root || !head) return
    root.classList.remove('dragging')
    head.classList.remove('dragging')
    try {
      head.releasePointerCapture(state.pointerId)
    } catch {
      // the capture can be gone already
    }
    // commit the final numbers to state and the store
    const final = clampPos(
      Number.parseFloat(root.style.left) || 0,
      Number.parseFloat(root.style.top) || 0,
      state.maxX,
      state.maxY,
    )
    setPos(final)
    if (state.moved) writePos(final)
  }

  const style: React.CSSProperties | undefined = pos ? { left: pos.left, top: pos.top } : undefined

  return (
    <div className="desktop-todo" ref={rootRef} style={style}>
      <div
        className="desktop-todo-head"
        ref={headRef}
        aria-hidden="true"
        onPointerDown={onHeadPointerDown}
        onPointerMove={onHeadPointerMove}
        onPointerUp={onHeadPointerUp}
        onPointerCancel={onHeadPointerUp}
      >
        {/* the grip: the card's whole head band is the handle (the widget's
            own title head renders below it) */}
        <svg className="desktop-todo-grip" width="28" height="8" viewBox="0 0 28 8" fill="none">
          <circle cx="3" cy="2" r="1.4" fill="currentColor" />
          <circle cx="10" cy="2" r="1.4" fill="currentColor" />
          <circle cx="17" cy="2" r="1.4" fill="currentColor" />
          <circle cx="24" cy="2" r="1.4" fill="currentColor" />
          <circle cx="3" cy="6" r="1.4" fill="currentColor" />
          <circle cx="10" cy="6" r="1.4" fill="currentColor" />
          <circle cx="17" cy="6" r="1.4" fill="currentColor" />
          <circle cx="24" cy="6" r="1.4" fill="currentColor" />
        </svg>
      </div>
      <TodoWidget lang={lang} />
    </div>
  )
}
