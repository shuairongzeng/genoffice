import { useEffect, useRef, useState } from 'react'
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  ReactNode,
} from 'react'
import type { DesktopBoxColor, DesktopGroupBox as DesktopGroupBoxData } from '../../shared/home-api'
import type { DesktopItem } from './desktop-items'
import type { DesktopStrings } from './desktop-strings'
import {
  BOX_COLLAPSED_HEIGHT,
  clampBoxRect,
  computeBoxResize,
  type BoxBounds,
  type BoxResizeEdge,
} from './desktop-boxes'

const RESIZE_EDGES: readonly BoxResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
const DRAG_THRESHOLD_PX = 4

export interface DesktopGroupBoxProps {
  readonly box: DesktopGroupBoxData
  readonly items: readonly DesktopItem[]
  readonly iconScale: number
  readonly labelStyle?: CSSProperties
  readonly strings: DesktopStrings
  readonly selectedIds: ReadonlySet<string>
  readonly draggingId: string | null
  readonly isDropTarget: boolean
  readonly editingTitle: boolean
  readonly stageBounds: BoxBounds
  readonly renderTile: (icon: DesktopItem) => ReactNode
  readonly onBringToFront: (boxId: string) => void
  readonly onMoveCommit: (boxId: string, x: number, y: number) => void
  readonly onResizeCommit: (
    boxId: string,
    rect: { x: number; y: number; width: number; height: number },
  ) => void
  readonly onToggleCollapse: (boxId: string) => void
  readonly onToggleLock: (boxId: string) => void
  readonly onRenameStart: (boxId: string) => void
  readonly onRenameCommit: (boxId: string, title: string) => void
  readonly onRenameCancel: () => void
  readonly onBoxContextMenu: (
    boxId: string,
    clientX: number,
    clientY: number,
  ) => void
  readonly onIconPointerDown: (
    event: ReactPointerEvent,
    icon: DesktopItem,
    pos: { x: number; y: number },
  ) => void
  readonly onIconClick?: (event: ReactMouseEvent, icon: DesktopItem) => void
  readonly onIconDoubleClick: (icon: DesktopItem) => void
  readonly onIconContextMenu: (
    event: ReactMouseEvent,
    icon: DesktopItem,
  ) => void
  readonly onExternalDrop: (boxId: string, event: ReactDragEvent<HTMLElement>) => void
}

function applyBoxStyle(
  el: HTMLElement | null,
  rect: { x: number; y: number; width: number; height?: number },
): void {
  if (!el) return
  el.style.left = `${Math.round(rect.x)}px`
  el.style.top = `${Math.round(rect.y)}px`
  el.style.width = `${Math.round(rect.width)}px`
  if (typeof rect.height === 'number') {
    el.style.height = `${Math.round(rect.height)}px`
  }
}

export function DesktopGroupBox({
  box,
  items,
  iconScale,
  labelStyle,
  strings: s,
  selectedIds,
  draggingId,
  isDropTarget,
  editingTitle,
  stageBounds,
  renderTile,
  onBringToFront,
  onMoveCommit,
  onResizeCommit,
  onToggleCollapse,
  onToggleLock,
  onRenameStart,
  onRenameCommit,
  onRenameCancel,
  onBoxContextMenu,
  onIconPointerDown,
  onIconClick,
  onIconDoubleClick,
  onIconContextMenu,
  onExternalDrop,
}: DesktopGroupBoxProps): ReactElement {
  const boxRef = useRef<HTMLElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const gestureCleanupRef = useRef<(() => void) | null>(null)
  const [interacting, setInteracting] = useState(false)
  const [draftTitle, setDraftTitle] = useState(box.title)
  const [fileDragOver, setFileDragOver] = useState(false)

  useEffect(() => () => gestureCleanupRef.current?.(), [])

  useEffect(() => {
    if (editingTitle) {
      setDraftTitle(box.title)
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }, [editingTitle, box.title])

  const startHeaderDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || box.locked || editingTitle) return
    const target = event.target as HTMLElement | null
    if (target?.closest('button, input, [data-box-no-drag="true"]')) return
    event.stopPropagation()
    event.preventDefault()
    onBringToFront(box.id)

    const startX = event.clientX
    const startY = event.clientY
    const origin = { x: box.x, y: box.y, width: box.width, height: box.height }
    let latest = { x: origin.x, y: origin.y }
    let moved = false
    setInteracting(true)

    const onMove = (moveEvent: PointerEvent): void => {
      const dx = moveEvent.clientX - startX
      const dy = moveEvent.clientY - startY
      if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
      moved = true
      const clamped = clampBoxRect(
        { x: origin.x + dx, y: origin.y + dy, width: origin.width, height: origin.height },
        stageBounds,
        box.collapsed,
      )
      latest = { x: clamped.x, y: clamped.y }
      applyBoxStyle(boxRef.current, {
        x: clamped.x,
        y: clamped.y,
        width: clamped.width,
        height: box.collapsed ? BOX_COLLAPSED_HEIGHT : clamped.height,
      })
    }

    const cleanup = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('blur', onCancel)
      gestureCleanupRef.current = null
      setInteracting(false)
    }

    const onUp = (): void => {
      cleanup()
      if (moved) onMoveCommit(box.id, latest.x, latest.y)
    }

    const onCancel = (): void => {
      cleanup()
      applyBoxStyle(boxRef.current, {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.collapsed ? BOX_COLLAPSED_HEIGHT : box.height,
      })
    }

    gestureCleanupRef.current?.()
    gestureCleanupRef.current = cleanup
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('blur', onCancel)
  }

  const startResize = (edge: BoxResizeEdge) => (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || box.collapsed || box.locked) return
    event.stopPropagation()
    event.preventDefault()
    onBringToFront(box.id)

    const startX = event.clientX
    const startY = event.clientY
    const startRect = { x: box.x, y: box.y, width: box.width, height: box.height }
    let latest = startRect
    let resized = false
    setInteracting(true)

    const onMove = (moveEvent: PointerEvent): void => {
      resized = true
      latest = computeBoxResize(
        startRect,
        edge,
        moveEvent.clientX - startX,
        moveEvent.clientY - startY,
        stageBounds,
      )
      applyBoxStyle(boxRef.current, latest)
    }

    const cleanup = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('blur', onCancel)
      gestureCleanupRef.current = null
      setInteracting(false)
    }

    const onUp = (): void => {
      cleanup()
      if (resized) onResizeCommit(box.id, latest)
    }

    const onCancel = (): void => {
      cleanup()
      applyBoxStyle(boxRef.current, startRect)
    }

    gestureCleanupRef.current?.()
    gestureCleanupRef.current = cleanup
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('blur', onCancel)
  }

  const submitTitle = (): void => {
    const trimmed = draftTitle.trim()
    onRenameCommit(box.id, trimmed || box.title)
  }

  const classNames = [
    'desktop-box',
    box.collapsed ? 'is-collapsed' : '',
    box.locked ? 'is-locked' : '',
    isDropTarget || fileDragOver ? 'is-drop-target' : '',
    interacting ? 'is-interacting' : '',
  ]
    .filter(Boolean)
    .join(' ')

  const boxHeight = box.collapsed ? BOX_COLLAPSED_HEIGHT : box.height
  const boxStyle: CSSProperties = {
    left: box.x,
    top: box.y,
    width: box.width,
    height: boxHeight,
    '--desktop-icon-scale': String(iconScale),
    ...labelStyle,
  } as CSSProperties

  return (
    <section
      ref={boxRef}
      className={classNames}
      data-box-id={box.id}
      data-box-color={box.color satisfies DesktopBoxColor}
      data-testid={`desktop-box-${box.id}`}
      style={boxStyle}
      aria-label={box.title}
      onPointerDown={(event) => {
        // Keep clicks/drags inside a box from arming the desktop surface rubber-band marquee.
        event.stopPropagation()
        onBringToFront(box.id)
      }}
      onContextMenu={(event) => {
        const target = event.target as HTMLElement | null
        if (target?.closest('.desktop-icon-item')) return
        event.preventDefault()
        event.stopPropagation()
        onBringToFront(box.id)
        onBoxContextMenu(box.id, event.clientX + 2, event.clientY + 2)
      }}
      onDragEnter={(event) => {
        if (!event.dataTransfer?.types.includes('Files')) return
        event.preventDefault()
        event.stopPropagation()
        setFileDragOver(true)
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer?.types.includes('Files')) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'link'
        setFileDragOver(true)
      }}
      onDragLeave={(event) => {
        const related = event.relatedTarget as Node | null
        if (related && event.currentTarget.contains(related)) return
        setFileDragOver(false)
      }}
      onDrop={(event) => {
        if (!event.dataTransfer?.types.includes('Files')) return
        event.preventDefault()
        event.stopPropagation()
        setFileDragOver(false)
        onExternalDrop(box.id, event)
      }}
    >
      <header
        className="desktop-box-header"
        onPointerDown={startHeaderDrag}
        onDoubleClick={(event) => {
          const target = event.target as HTMLElement | null
          if (target?.closest('button, input, .desktop-box-title, [data-box-no-drag="true"]')) {
            return
          }
          onToggleCollapse(box.id)
        }}
      >
        <span className="desktop-box-color-dot" aria-hidden="true" />
        {editingTitle ? (
          <input
            ref={inputRef}
            type="text"
            className="desktop-box-title-input"
            aria-label={s.boxRename}
            value={draftTitle}
            maxLength={80}
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => setDraftTitle(event.currentTarget.value)}
            onBlur={submitTitle}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                submitTitle()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                onRenameCancel()
              }
            }}
          />
        ) : (
          <span
            className="desktop-box-title"
            title={box.title}
            onDoubleClick={(event) => {
              event.stopPropagation()
              onRenameStart(box.id)
            }}
          >
            {box.title}
          </span>
        )}
        <span className="desktop-box-count" aria-hidden="true">
          {items.length}
        </span>
        <div className="desktop-box-controls" data-box-no-drag="true">
          <button
            type="button"
            className="desktop-box-ctrl-btn"
            aria-label={box.collapsed ? s.boxExpand : s.boxCollapse}
            title={box.collapsed ? s.boxExpand : s.boxCollapse}
            onClick={(event) => {
              event.stopPropagation()
              onToggleCollapse(box.id)
            }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path
                d={box.collapsed ? 'M3 4.5 6 7.5l3-3' : 'M3 7.5 6 4.5l3 3'}
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            type="button"
            className={`desktop-box-ctrl-btn${box.locked ? ' active' : ''}`}
            aria-label={box.locked ? s.boxUnlock : s.boxLock}
            title={box.locked ? s.boxUnlock : s.boxLock}
            onClick={(event) => {
              event.stopPropagation()
              onToggleLock(box.id)
            }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              {box.locked ? (
                <path
                  d="M3.5 5.5V4a2.5 2.5 0 0 1 5 0v1.5M2.8 5.5h6.4a.8.8 0 0 1 .8.8v3.9a.8.8 0 0 1-.8.8H2.8a.8.8 0 0 1-.8-.8V6.3a.8.8 0 0 1 .8-.8Z"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ) : (
                <path
                  d="M3.5 5.5V4a2.5 2.5 0 0 1 4.8-1M2.8 5.5h6.4a.8.8 0 0 1 .8.8v3.9a.8.8 0 0 1-.8.8H2.8a.8.8 0 0 1-.8-.8V6.3a.8.8 0 0 1 .8-.8Z"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
            </svg>
          </button>
          <button
            type="button"
            className="desktop-box-ctrl-btn"
            aria-label={box.title}
            title={box.title}
            onClick={(event) => {
              event.stopPropagation()
              const rect = event.currentTarget.getBoundingClientRect()
              onBringToFront(box.id)
              onBoxContextMenu(box.id, rect.right - 140, rect.bottom + 4)
            }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <circle cx="2.5" cy="6" r="1" fill="currentColor" />
              <circle cx="6" cy="6" r="1" fill="currentColor" />
              <circle cx="9.5" cy="6" r="1" fill="currentColor" />
            </svg>
          </button>
        </div>
      </header>
      {!box.collapsed && (
        <div className="desktop-box-body">
          {items.length === 0 ? (
            <div className="desktop-box-empty">{s.boxEmptyHint}</div>
          ) : (
            <ul className="desktop-box-grid" role="listbox" aria-label={box.title}>
              {items.map((item) => {
                const isDragging = draggingId === item.id
                return (
                  <li
                    key={item.id}
                    className={`desktop-box-cell${isDragging ? ' drag-source' : ''}${selectedIds.has(item.id) ? ' selected' : ''}`}
                    role="presentation"
                  >
                    <div
                      className="desktop-icon-item"
                      role="option"
                      aria-selected={selectedIds.has(item.id)}
                      tabIndex={0}
                      aria-label={item.title}
                      title={item.kind === 'folder' ? (item.path ?? item.title) : item.title}
                      onDragStart={(event) => event.preventDefault()}
                      onPointerDown={(event) => {
                        const surface = boxRef.current?.closest('.desktop-surface')
                        const sRect = surface?.getBoundingClientRect()
                        const iRect = event.currentTarget.getBoundingClientRect()
                        const pos = {
                          x: iRect.left - (sRect?.left ?? 0) + (surface?.scrollLeft ?? 0),
                          y: iRect.top - (sRect?.top ?? 0),
                        }
                        onIconPointerDown(event, item, pos)
                      }}
                      onClick={(event) => onIconClick?.(event, item)}
                      onDoubleClick={() => onIconDoubleClick(item)}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        onIconContextMenu(event, item)
                      }}
                    >
                      {renderTile(item)}
                      <span className="desktop-icon-label">{item.title}</span>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
      {!box.collapsed &&
        !box.locked &&
        RESIZE_EDGES.map((edge) => (
          <div
            key={edge}
            className={`desktop-box-resize ${edge}`}
            data-testid={`desktop-box-${box.id}-resize-${edge}`}
            onPointerDown={startResize(edge)}
          />
        ))}
    </section>
  )
}
