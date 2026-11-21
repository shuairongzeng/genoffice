import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  clampWindowRect,
  computeResizeRect,
  detectSnapZone,
  maximizedWindowRect,
  snapPreviewRect,
  type DesktopWindowMode,
  type DesktopWindowSnap,
  type ResizeEdge,
  type StageBounds,
  type WindowRect,
} from './desktop-window-geometry'
import './desktop-window.css'

const RESIZE_EDGES: readonly ResizeEdge[] = ['n', 's', 'e', 'w', 'nw', 'ne', 'se', 'sw']
const DRAG_RESTORE_THRESHOLD_PX = 4

export interface DesktopWindowLabels {
  readonly minimize: string
  readonly maximize: string
  readonly restore: string
  readonly close: string
}

export interface DesktopWindowProps {
  readonly title: string
  readonly icon?: ReactNode
  readonly mode: DesktopWindowMode
  readonly snap: DesktopWindowSnap
  readonly rect: WindowRect
  readonly miniPos?: { readonly x: number; readonly y: number }
  readonly miniWidth?: number
  readonly miniHeight?: number
  readonly stage: StageBounds
  readonly focused: boolean
  readonly visualHidden?: boolean
  readonly minWidth?: number
  readonly minHeight?: number
  readonly labels: DesktopWindowLabels
  readonly headerActions?: ReactNode
  readonly onFocus: () => void
  readonly onRectChange: (rect: WindowRect, snap?: DesktopWindowSnap) => void
  readonly onMiniPosChange?: (pos: { x: number; y: number }) => void
  readonly onModeChange: (mode: DesktopWindowMode, snap?: DesktopWindowSnap) => void
  readonly onClose: () => void
  readonly testId?: string
  readonly children: ReactNode
}

function applyRectStyle(el: HTMLDivElement | null, r: WindowRect): void {
  if (!el) return
  el.style.left = `${Math.round(r.x)}px`
  el.style.top = `${Math.round(r.y)}px`
  el.style.width = `${Math.round(r.width)}px`
  el.style.height = `${Math.round(r.height)}px`
}

export function DesktopWindow({
  title,
  icon,
  mode,
  snap,
  rect,
  miniPos,
  miniWidth = 376,
  miniHeight = 104,
  stage,
  focused,
  visualHidden = false,
  minWidth,
  minHeight,
  labels,
  headerActions,
  onFocus,
  onRectChange,
  onMiniPosChange,
  onModeChange,
  onClose,
  testId = 'desktop-window',
  children,
}: DesktopWindowProps): ReactElement {
  const winRef = useRef<HTMLDivElement | null>(null)
  const [interacting, setInteracting] = useState(false)
  const [snapPreview, setSnapPreview] = useState<WindowRect | null>(null)

  const minSize = { width: minWidth, height: minHeight }
  const miniRect = clampWindowRect(
    {
      x: miniPos?.x ?? Math.max(24, Math.round(((stage.width || 1200) - miniWidth) / 2)),
      y: miniPos?.y ?? Math.max(64, (stage.height || 800) - miniHeight - 108),
      width: miniWidth,
      height: miniHeight,
    },
    stage,
    { width: miniWidth, height: miniHeight },
  )
  const activeRect =
    mode === 'mini'
      ? miniRect
      : mode === 'maximized'
        ? maximizedWindowRect(stage)
        : snap !== 'none'
          ? (snapPreviewRect(snap, stage) ?? clampWindowRect(rect, stage, minSize))
          : clampWindowRect(rect, stage, minSize)

  const dragCleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => () => dragCleanupRef.current?.(), [])

  const startTitleDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement | null
    if (target?.closest('button, input, a, [data-window-no-drag="true"]')) return
    event.preventDefault()
    onFocus()

    const startClientX = event.clientX
    const startClientY = event.clientY
    const wasMaxOrSnap = mode === 'maximized' || snap !== 'none'
    const baseRect = wasMaxOrSnap ? clampWindowRect(rect, stage, minSize) : activeRect
    let originRect = activeRect
    let restored = !wasMaxOrSnap
    let latestRect = activeRect
    let latestSnap: DesktopWindowSnap = snap
    let moved = false

    const pointerId = typeof event.pointerId === 'number' ? event.pointerId : 1
    try {
      event.currentTarget.setPointerCapture?.(pointerId)
    } catch {
      // Ignore synthetic events in unit tests.
    }

    setInteracting(true)

    const onMove = (moveEvent: PointerEvent): void => {
      const dx = moveEvent.clientX - startClientX
      const dy = moveEvent.clientY - startClientY
      if (!moved && Math.hypot(dx, dy) < DRAG_RESTORE_THRESHOLD_PX) return
      moved = true

      if (!restored) {
        restored = true
        const ratio =
          activeRect.width > 0
            ? Math.min(Math.max((startClientX - activeRect.x) / activeRect.width, 0.15), 0.85)
            : 0.5
        originRect = {
          x: Math.round(startClientX - baseRect.width * ratio),
          y: startClientY - 18,
          width: baseRect.width,
          height: baseRect.height,
        }
      }

      latestRect = clampWindowRect(
        {
          x: originRect.x + (moveEvent.clientX - startClientX),
          y: originRect.y + (moveEvent.clientY - startClientY),
          width: originRect.width,
          height: originRect.height,
        },
        stage,
        minSize,
      )
      applyRectStyle(winRef.current, latestRect)

      const zone = detectSnapZone(moveEvent.clientX, moveEvent.clientY, stage)
      latestSnap = zone
      setSnapPreview(snapPreviewRect(zone, stage))
    }

    const cleanup = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('blur', onCancel)
      dragCleanupRef.current = null
      setInteracting(false)
      setSnapPreview(null)
    }

    const onUp = (): void => {
      cleanup()
      if (!moved) return
      if (latestSnap === 'top') {
        onModeChange('maximized', 'none')
        return
      }
      if (latestSnap === 'left' || latestSnap === 'right') {
        onModeChange('normal', latestSnap)
        return
      }
      if (mode === 'maximized' || snap !== 'none') {
        onModeChange('normal', 'none')
      }
      onRectChange(latestRect, 'none')
    }

    const onCancel = (): void => {
      cleanup()
      applyRectStyle(winRef.current, activeRect)
    }

    dragCleanupRef.current?.()
    dragCleanupRef.current = cleanup
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('blur', onCancel)
  }

  const startResize = (edge: ResizeEdge) => (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || mode === 'maximized') return
    event.preventDefault()
    event.stopPropagation()
    onFocus()

    const startClientX = event.clientX
    const startClientY = event.clientY
    const startRect = activeRect
    let latestRect = startRect
    let resized = false

    const pointerId = typeof event.pointerId === 'number' ? event.pointerId : 1
    try {
      event.currentTarget.setPointerCapture?.(pointerId)
    } catch {
      // Ignore synthetic events in unit tests.
    }

    setInteracting(true)

    const onMove = (moveEvent: PointerEvent): void => {
      resized = true
      latestRect = computeResizeRect(
        startRect,
        edge,
        moveEvent.clientX - startClientX,
        moveEvent.clientY - startClientY,
        stage,
        minSize,
      )
      applyRectStyle(winRef.current, latestRect)
    }

    const cleanup = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('blur', onCancel)
      dragCleanupRef.current = null
      setInteracting(false)
    }

    const onUp = (): void => {
      cleanup()
      if (!resized) return
      if (snap !== 'none') onModeChange('normal', 'none')
      onRectChange(latestRect, 'none')
    }

    const onCancel = (): void => {
      cleanup()
      applyRectStyle(winRef.current, activeRect)
    }

    dragCleanupRef.current?.()
    dragCleanupRef.current = cleanup
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('blur', onCancel)
  }

  const toggleMaximize = (): void => {
    if (mode === 'maximized') {
      onModeChange('normal', 'none')
    } else {
      onModeChange('maximized', 'none')
    }
  }

  const startMiniDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    if (mode !== 'mini' || event.button !== 0) return
    const target = event.target as HTMLElement | null
    if (target?.closest('button, input, a, [data-window-no-drag="true"]')) return
    event.preventDefault()
    onFocus()

    const startClientX = event.clientX
    const startClientY = event.clientY
    const origin = miniRect
    let latestPos = { x: origin.x, y: origin.y }
    let moved = false

    const pointerId = typeof event.pointerId === 'number' ? event.pointerId : 1
    try {
      event.currentTarget.setPointerCapture?.(pointerId)
    } catch {
      // Ignore synthetic events in unit tests.
    }

    setInteracting(true)

    const onMove = (moveEvent: PointerEvent): void => {
      const dx = moveEvent.clientX - startClientX
      const dy = moveEvent.clientY - startClientY
      if (!moved && Math.hypot(dx, dy) < DRAG_RESTORE_THRESHOLD_PX) return
      moved = true
      const next = clampWindowRect(
        {
          x: origin.x + dx,
          y: origin.y + dy,
          width: miniWidth,
          height: miniHeight,
        },
        stage,
        { width: miniWidth, height: miniHeight },
      )
      latestPos = { x: next.x, y: next.y }
      applyRectStyle(winRef.current, next)
    }

    const cleanup = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('blur', onCancel)
      dragCleanupRef.current = null
      setInteracting(false)
    }

    const onUp = (): void => {
      cleanup()
      if (moved) onMiniPosChange?.(latestPos)
    }

    const onCancel = (): void => {
      cleanup()
      applyRectStyle(winRef.current, origin)
    }

    dragCleanupRef.current?.()
    dragCleanupRef.current = cleanup
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('blur', onCancel)
  }

  const isHidden = visualHidden || mode === 'minimized'
  const classNames = [
    'desktop-window',
    focused ? 'is-focused' : '',
    mode === 'maximized' ? 'is-maximized' : '',
    mode === 'mini' ? 'is-mini' : '',
    isHidden ? 'is-minimized' : '',
    interacting ? 'is-interacting' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <>
      {snapPreview !== null &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="desktop-window-snap-preview"
            aria-hidden="true"
            style={{
              left: snapPreview.x,
              top: snapPreview.y,
              width: snapPreview.width,
              height: snapPreview.height,
            }}
          />,
          document.body,
        )}
      <section
        ref={winRef}
        className={classNames}
        data-testid={testId}
        role="dialog"
        aria-label={title}
        aria-hidden={isHidden || undefined}
        style={
          isHidden
            ? undefined
            : {
                left: activeRect.x,
                top: activeRect.y,
                width: activeRect.width,
                height: mode === 'mini' ? undefined : activeRect.height,
              }
        }
        onPointerDown={(event) => {
          onFocus()
          if (mode === 'mini') startMiniDrag(event)
        }}
      >
        {mode !== 'mini' && (
          <header
            key="titlebar"
            className="desktop-window-titlebar"
            onPointerDown={startTitleDrag}
            onDoubleClick={(event) => {
              const target = event.target as HTMLElement | null
              if (target?.closest('button, input, a, [data-window-no-drag="true"]')) return
              toggleMaximize()
            }}
          >
            <div className="desktop-window-lights" data-window-no-drag="true">
              <button
                type="button"
                className="desktop-window-light close"
                aria-label={labels.close}
                title={labels.close}
                data-testid={`${testId}-close`}
                onClick={(event) => {
                  event.stopPropagation()
                  onClose()
                }}
              >
                <svg width="7" height="7" viewBox="0 0 8 8" fill="none" aria-hidden="true">
                  <path
                    d="M1.5 1.5l5 5M6.5 1.5l-5 5"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                className="desktop-window-light min"
                aria-label={labels.minimize}
                title={labels.minimize}
                data-testid={`${testId}-minimize`}
                onClick={(event) => {
                  event.stopPropagation()
                  onModeChange('minimized', snap)
                }}
              >
                <svg width="7" height="7" viewBox="0 0 8 8" fill="none" aria-hidden="true">
                  <path
                    d="M1.3 4h5.4"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                className="desktop-window-light max"
                aria-label={mode === 'maximized' ? labels.restore : labels.maximize}
                title={mode === 'maximized' ? labels.restore : labels.maximize}
                data-testid={`${testId}-maximize`}
                onClick={(event) => {
                  event.stopPropagation()
                  toggleMaximize()
                }}
              >
                <svg width="7" height="7" viewBox="0 0 8 8" fill="none" aria-hidden="true">
                  {mode === 'maximized' ? (
                    <path
                      d="M2 5h3V2M6 3H3v3"
                      stroke="currentColor"
                      strokeWidth="1.2"
                      strokeLinejoin="round"
                    />
                  ) : (
                    <path
                      d="M4 1.3v5.4M1.3 4h5.4"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                    />
                  )}
                </svg>
              </button>
            </div>
            <div className="desktop-window-title-wrap">
              {icon && <span className="desktop-window-title-icon">{icon}</span>}
              <span className="desktop-window-title" title={title}>
                {title}
              </span>
            </div>
            <div className="desktop-window-actions" data-window-no-drag="true">
              {headerActions}
            </div>
          </header>
        )}
        <div key="body" className="desktop-window-body">
          {children}
        </div>
        {mode === 'normal' &&
          !isHidden &&
          RESIZE_EDGES.map((edge) => (
            <div
              key={edge}
              className={`desktop-window-resize ${edge}`}
              data-testid={`${testId}-resize-${edge}`}
              onPointerDown={startResize(edge)}
            />
          ))}
      </section>
    </>
  )
}
