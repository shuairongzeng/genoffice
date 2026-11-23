import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
} from 'react'
import type {
  TerminalDropZone,
  TerminalGroup,
  TerminalLayoutNode,
  TerminalLeafNode,
  TerminalShellKind,
  TerminalSplitDirection,
  TerminalSplitNode,
  TerminalWorkspaceAction,
} from '../../../shared/terminal-api'
import {
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  clampSplitRatio,
  countLeafPanes,
  findAdjacentPane,
  findLeafByPaneId,
} from '../../../shared/terminal-layout'
import { useI18n } from '../locale'
import { TerminalPane } from './TerminalPane'
import {
  PANE_DRAG_MIME,
  getActivePaneDrag,
  setActivePaneDrag,
  type PaneDragPayload,
} from './terminal-workspace-utils'

const MIN_SPLIT_H_WIDTH_PX = 440
const MIN_SPLIT_V_HEIGHT_PX = 220
const SPLIT_RESIZE_STEP = 0.04

export interface TerminalSplitTreeProps {
  group: TerminalGroup
  compact?: boolean
  onAction: (action: TerminalWorkspaceAction) => Promise<unknown> | void
  onSwitchShell: (sessionId: string, shell: TerminalShellKind, cwd?: string) => void
  onOpenSnippets?: () => void
}

function detectDropZone(rect: DOMRect, clientX: number, clientY: number): TerminalDropZone {
  const w = Math.max(1, rect.width)
  const h = Math.max(1, rect.height)
  const rx = (clientX - rect.left) / w
  const ry = (clientY - rect.top) / h

  if (rx >= 0.25 && rx <= 0.75 && ry >= 0.25 && ry <= 0.75) {
    return 'center'
  }
  const distLeft = rx
  const distRight = 1 - rx
  const distTop = ry
  const distBottom = 1 - ry
  const minDist = Math.min(distLeft, distRight, distTop, distBottom)
  if (minDist === distLeft) return 'left'
  if (minDist === distRight) return 'right'
  if (minDist === distTop) return 'top'
  return 'bottom'
}

function readDragPayload(e: DragEvent<HTMLElement>): PaneDragPayload | null {
  const active = getActivePaneDrag()
  if (active) return active
  try {
    const raw = e.dataTransfer.getData(PANE_DRAG_MIME)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PaneDragPayload>
    if (typeof parsed.groupId === 'string' && typeof parsed.paneId === 'string') {
      return { groupId: parsed.groupId, paneId: parsed.paneId }
    }
  } catch {
    // Ignore restricted dragover dataTransfer access.
  }
  return null
}

interface LeafSlotProps {
  leaf: TerminalLeafNode
  group: TerminalGroup
  compact: boolean
  canClosePane: boolean
  isZoomed: boolean
  activeDrag: PaneDragPayload | null
  onReportCapabilities: (paneId: string, caps: { canSplitH: boolean; canSplitV: boolean }) => void
  onAction: (action: TerminalWorkspaceAction) => Promise<unknown> | void
  onSwitchShell: (sessionId: string, shell: TerminalShellKind, cwd?: string) => void
  onStartDrag: (payload: PaneDragPayload) => void
  onEndDrag: () => void
}

function LeafSlot({
  leaf,
  group,
  compact,
  canClosePane,
  isZoomed,
  activeDrag,
  onReportCapabilities,
  onAction,
  onSwitchShell,
  onStartDrag,
  onEndDrag,
}: LeafSlotProps): ReactElement {
  const { t } = useI18n()
  const slotRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 })
  const [dropZone, setDropZone] = useState<TerminalDropZone | null>(null)

  const canSplitH = size.width === 0 ? true : size.width >= MIN_SPLIT_H_WIDTH_PX
  const canSplitV = size.height === 0 ? true : size.height >= MIN_SPLIT_V_HEIGHT_PX

  useEffect(() => {
    onReportCapabilities(leaf.paneId, { canSplitH, canSplitV })
  }, [canSplitH, canSplitV, leaf.paneId, onReportCapabilities])

  useEffect(() => {
    const el = slotRef.current
    if (!el) return
    const update = (): void => {
      setSize((prev) =>
        prev.width === el.clientWidth && prev.height === el.clientHeight
          ? prev
          : { width: el.clientWidth, height: el.clientHeight },
      )
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!activeDrag) {
      setDropZone(null)
    }
  }, [activeDrag])

  const isDropSelf =
    activeDrag !== null && activeDrag.groupId === group.id && activeDrag.paneId === leaf.paneId

  const handleDragOver = (e: DragEvent<HTMLDivElement>): void => {
    const payload = readDragPayload(e)
    if (!payload) return
    if (payload.groupId === group.id && payload.paneId === leaf.paneId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = slotRef.current?.getBoundingClientRect()
    if (!rect) return
    setDropZone(detectDropZone(rect, e.clientX, e.clientY))
  }

  const handleDragLeave = (e: DragEvent<HTMLDivElement>): void => {
    const nextTarget = e.relatedTarget as Node | null
    if (nextTarget && slotRef.current?.contains(nextTarget)) return
    setDropZone(null)
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>): void => {
    const payload = readDragPayload(e)
    setDropZone(null)
    if (!payload) return
    if (payload.groupId === group.id && payload.paneId === leaf.paneId) return
    e.preventDefault()
    const rect = slotRef.current?.getBoundingClientRect()
    const zone = dropZone ?? (rect ? detectDropZone(rect, e.clientX, e.clientY) : 'center')
    onEndDrag()
    void onAction({
      type: 'drop-pane',
      sourceGroupId: payload.groupId,
      sourcePaneId: payload.paneId,
      targetGroupId: group.id,
      targetPaneId: leaf.paneId,
      zone,
    })
  }

  const dropLabel = useMemo(() => {
    switch (dropZone) {
      case 'top':
        return t('termDropZoneTop')
      case 'bottom':
        return t('termDropZoneBottom')
      case 'left':
        return t('termDropZoneLeft')
      case 'right':
        return t('termDropZoneRight')
      case 'center':
        return t('termDropZoneCenter')
      default:
        return ''
    }
  }, [dropZone, t])

  return (
    <div
      ref={slotRef}
      className="term-split-leaf-host"
      data-testid={`terminal-leaf-${leaf.paneId}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <TerminalPane
        paneId={leaf.paneId}
        sessionId={leaf.sessionId}
        compact={compact}
        focused={group.focusedPaneId === leaf.paneId}
        broadcastEnabled={group.broadcastEnabled}
        isZoomed={isZoomed}
        canSplitH={canSplitH}
        canSplitV={canSplitV}
        canClosePane={canClosePane}
        draggable={!isZoomed}
        onFocusPane={() => {
          if (group.focusedPaneId !== leaf.paneId) {
            void onAction({ type: 'focus-pane', groupId: group.id, paneId: leaf.paneId })
          }
        }}
        onSwitchShell={(shell, cwd) => onSwitchShell(leaf.sessionId, shell, cwd)}
        onBroadcastWrite={(data) => {
          void onAction({ type: 'broadcast-write', groupId: group.id, data })
        }}
        onOscTitleChange={(oscTitle) => {
          void onAction({
            type: 'set-session-osc-title',
            sessionId: leaf.sessionId,
            oscTitle,
          })
        }}
        onRenameTitle={(nextTitle) => {
          void onAction({
            type: 'rename-session',
            sessionId: leaf.sessionId,
            title: nextTitle,
          })
        }}
        onSplitPane={(direction: TerminalSplitDirection) => {
          void onAction({
            type: 'split-pane',
            groupId: group.id,
            targetPaneId: leaf.paneId,
            direction,
          })
        }}
        onToggleZoom={() => {
          void onAction({
            type: 'zoom-pane',
            groupId: group.id,
            paneId: isZoomed ? null : leaf.paneId,
          })
        }}
        onClosePane={() => {
          void onAction({
            type: 'close-pane',
            groupId: group.id,
            paneId: leaf.paneId,
            killSessionIfUnused: true,
          })
        }}
        onPaneDragStart={(e) => {
          const payload: PaneDragPayload = { groupId: group.id, paneId: leaf.paneId }
          try {
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData(PANE_DRAG_MIME, JSON.stringify(payload))
          } catch {
            // Ignore synthetic drag environments.
          }
          onStartDrag(payload)
        }}
        onPaneDragEnd={onEndDrag}
      />

      {dropZone && !isDropSelf && (
        <div
          className={`term-drop-overlay is-zone-${dropZone}`}
          data-testid={`terminal-drop-overlay-${dropZone}`}
          aria-hidden="true"
        >
          <span className="term-drop-overlay-label">{dropLabel}</span>
        </div>
      )}
    </div>
  )
}

interface SplitNodeViewProps {
  node: TerminalSplitNode
  group: TerminalGroup
  compact: boolean
  canClosePane: boolean
  liveRatios: Record<string, number>
  activeDrag: PaneDragPayload | null
  onReportCapabilities: (paneId: string, caps: { canSplitH: boolean; canSplitV: boolean }) => void
  onLiveRatio: (splitId: string, ratio: number, commit: boolean) => void
  onAction: (action: TerminalWorkspaceAction) => Promise<unknown> | void
  onSwitchShell: (sessionId: string, shell: TerminalShellKind, cwd?: string) => void
  onStartDrag: (payload: PaneDragPayload) => void
  onEndDrag: () => void
}

function SplitNodeView({
  node,
  group,
  compact,
  canClosePane,
  liveRatios,
  activeDrag,
  onReportCapabilities,
  onLiveRatio,
  onAction,
  onSwitchShell,
  onStartDrag,
  onEndDrag,
}: SplitNodeViewProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const ratio = liveRatios[node.splitId] ?? node.ratio

  const handleDividerPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const dividerEl = e.currentTarget
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    dividerEl.setPointerCapture(e.pointerId)
    setDragging(true)
    const startRatio = ratio
    const isHorizontal = node.direction === 'horizontal'
    const startCoord = isHorizontal ? e.clientX : e.clientY
    const span = Math.max(1, isHorizontal ? rect.width : rect.height)
    let latestRatio = startRatio

    const onMove = (ev: PointerEvent): void => {
      const delta = (isHorizontal ? ev.clientX : ev.clientY) - startCoord
      latestRatio = clampSplitRatio(startRatio + delta / span)
      onLiveRatio(node.splitId, latestRatio, false)
    }

    const onFinish = (): void => {
      setDragging(false)
      dividerEl.removeEventListener('pointermove', onMove)
      dividerEl.removeEventListener('pointerup', onFinish)
      dividerEl.removeEventListener('pointercancel', onFinish)
      onLiveRatio(node.splitId, latestRatio, true)
    }

    dividerEl.addEventListener('pointermove', onMove)
    dividerEl.addEventListener('pointerup', onFinish)
    dividerEl.addEventListener('pointercancel', onFinish)
  }

  const handleDividerKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const decKey = node.direction === 'horizontal' ? 'ArrowLeft' : 'ArrowUp'
    const incKey = node.direction === 'horizontal' ? 'ArrowRight' : 'ArrowDown'
    if (e.key === decKey) {
      e.preventDefault()
      onLiveRatio(node.splitId, clampSplitRatio(ratio - SPLIT_RESIZE_STEP), true)
    } else if (e.key === incKey) {
      e.preventDefault()
      onLiveRatio(node.splitId, clampSplitRatio(ratio + SPLIT_RESIZE_STEP), true)
    } else if (e.key === 'Home') {
      e.preventDefault()
      onLiveRatio(node.splitId, 0.5, true)
    }
  }

  const renderChild = (child: TerminalLayoutNode): ReactElement => {
    if (child.type === 'leaf') {
      return (
        <LeafSlot
          key={child.paneId}
          leaf={child}
          group={group}
          compact={compact}
          canClosePane={canClosePane}
          isZoomed={false}
          activeDrag={activeDrag}
          onReportCapabilities={onReportCapabilities}
          onAction={onAction}
          onSwitchShell={onSwitchShell}
          onStartDrag={onStartDrag}
          onEndDrag={onEndDrag}
        />
      )
    }
    return (
      <SplitNodeView
        key={child.splitId}
        node={child}
        group={group}
        compact={compact}
        canClosePane={canClosePane}
        liveRatios={liveRatios}
        activeDrag={activeDrag}
        onReportCapabilities={onReportCapabilities}
        onLiveRatio={onLiveRatio}
        onAction={onAction}
        onSwitchShell={onSwitchShell}
        onStartDrag={onStartDrag}
        onEndDrag={onEndDrag}
      />
    )
  }

  return (
    <div
      ref={containerRef}
      className={`term-split-node is-${node.direction}`}
      data-testid={`terminal-split-${node.splitId}`}
    >
      <div className="term-split-branch" style={{ flex: `0 0 calc(${ratio * 100}% - 3px)` }}>
        {renderChild(node.first)}
      </div>

      <div
        className={`term-split-divider is-${node.direction}${dragging ? ' is-dragging' : ''}`}
        data-testid={`terminal-split-divider-${node.splitId}`}
        role="separator"
        aria-orientation={node.direction === 'horizontal' ? 'vertical' : 'horizontal'}
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={Math.round(MIN_SPLIT_RATIO * 100)}
        aria-valuemax={Math.round(MAX_SPLIT_RATIO * 100)}
        tabIndex={0}
        onPointerDown={handleDividerPointerDown}
        onDoubleClick={() => onLiveRatio(node.splitId, 0.5, true)}
        onKeyDown={handleDividerKeyDown}
      />

      <div className="term-split-branch is-trailing">{renderChild(node.second)}</div>
    </div>
  )
}

/**
 * Recursive arbitrary-depth split tree container supporting directional splitting,
 * proportional divider drag, drag-and-drop hot-zone rearranging, single-pane zoom,
 * and Alt+Arrow directional focus navigation.
 */
export function TerminalSplitTree({
  group,
  compact = false,
  onAction,
  onSwitchShell,
  onOpenSnippets,
}: TerminalSplitTreeProps): ReactElement {
  const { t } = useI18n()
  const [liveRatios, setLiveRatios] = useState<Record<string, number>>({})
  const [activeDrag, setActiveDrag] = useState<PaneDragPayload | null>(null)
  const capabilitiesRef = useRef<Map<string, { canSplitH: boolean; canSplitV: boolean }>>(new Map())

  const totalPanes = useMemo(() => countLeafPanes(group.layout), [group.layout])
  const zoomedLeaf = useMemo(
    () => (group.zoomedPaneId ? findLeafByPaneId(group.layout, group.zoomedPaneId) : null),
    [group.layout, group.zoomedPaneId],
  )

  // Clear local optimistic ratio once authoritative layout updates.
  useEffect(() => {
    setLiveRatios({})
  }, [group.layout])

  const handleReportCapabilities = useCallback(
    (paneId: string, caps: { canSplitH: boolean; canSplitV: boolean }) => {
      capabilitiesRef.current.set(paneId, caps)
    },
    [],
  )

  const handleLiveRatio = useCallback(
    (splitId: string, nextRatio: number, commit: boolean) => {
      setLiveRatios((prev) => ({ ...prev, [splitId]: nextRatio }))
      if (commit) {
        void onAction({ type: 'resize-split', groupId: group.id, splitId, ratio: nextRatio })
      }
    },
    [group.id, onAction],
  )

  const handleStartDrag = useCallback((payload: PaneDragPayload) => {
    setActivePaneDrag(payload)
    setActiveDrag(payload)
  }, [])

  const handleEndDrag = useCallback(() => {
    setActivePaneDrag(null)
    setActiveDrag(null)
  }, [])

  const handleKeyDownCapture = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const lower = e.key.toLowerCase()

      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey) {
        if (lower === 'd') {
          e.preventDefault()
          e.stopPropagation()
          const caps = capabilitiesRef.current.get(group.focusedPaneId)
          if (caps?.canSplitH === false) return
          void onAction({
            type: 'split-pane',
            groupId: group.id,
            targetPaneId: group.focusedPaneId,
            direction: 'horizontal',
          })
          return
        }
        if (lower === 'e') {
          e.preventDefault()
          e.stopPropagation()
          const caps = capabilitiesRef.current.get(group.focusedPaneId)
          if (caps?.canSplitV === false) return
          void onAction({
            type: 'split-pane',
            groupId: group.id,
            targetPaneId: group.focusedPaneId,
            direction: 'vertical',
          })
          return
        }
        if (lower === 'z') {
          e.preventDefault()
          e.stopPropagation()
          void onAction({
            type: 'zoom-pane',
            groupId: group.id,
            paneId: zoomedLeaf ? null : group.focusedPaneId,
          })
          return
        }
        if (lower === 'k' && onOpenSnippets) {
          e.preventDefault()
          e.stopPropagation()
          onOpenSnippets()
          return
        }
      }

      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const dirMap: Record<string, 'up' | 'down' | 'left' | 'right' | undefined> = {
          ArrowUp: 'up',
          ArrowDown: 'down',
          ArrowLeft: 'left',
          ArrowRight: 'right',
        }
        const dir = dirMap[e.key]
        if (dir) {
          const nextPaneId = findAdjacentPane(group.layout, group.focusedPaneId, dir)
          if (nextPaneId && nextPaneId !== group.focusedPaneId) {
            e.preventDefault()
            e.stopPropagation()
            void onAction({ type: 'focus-pane', groupId: group.id, paneId: nextPaneId })
          }
        }
      }
    },
    [group.focusedPaneId, group.id, group.layout, onAction, onOpenSnippets, zoomedLeaf],
  )

  return (
    <div
      className="term-split-tree"
      data-testid="terminal-split-tree"
      data-pane-count={totalPanes}
      onKeyDownCapture={handleKeyDownCapture}
    >
      {zoomedLeaf ? (
        <div className="term-zoom-container" data-testid="terminal-zoom-container">
          <div className="term-zoom-banner">
            <span>{t('termRestorePane')}</span>
            <button
              type="button"
              className="term-mini-btn is-active"
              data-testid="terminal-zoom-restore-btn"
              onClick={() => void onAction({ type: 'zoom-pane', groupId: group.id, paneId: null })}
            >
              {t('termRestorePane')}
            </button>
          </div>
          <div className="term-zoom-slot">
            <LeafSlot
              leaf={zoomedLeaf}
              group={group}
              compact={compact}
              canClosePane={totalPanes > 1}
              isZoomed
              activeDrag={null}
              onReportCapabilities={handleReportCapabilities}
              onAction={onAction}
              onSwitchShell={onSwitchShell}
              onStartDrag={handleStartDrag}
              onEndDrag={handleEndDrag}
            />
          </div>
        </div>
      ) : group.layout.type === 'leaf' ? (
        <LeafSlot
          leaf={group.layout}
          group={group}
          compact={compact}
          canClosePane={false}
          isZoomed={false}
          activeDrag={activeDrag}
          onReportCapabilities={handleReportCapabilities}
          onAction={onAction}
          onSwitchShell={onSwitchShell}
          onStartDrag={handleStartDrag}
          onEndDrag={handleEndDrag}
        />
      ) : (
        <SplitNodeView
          node={group.layout}
          group={group}
          compact={compact}
          canClosePane={totalPanes > 1}
          liveRatios={liveRatios}
          activeDrag={activeDrag}
          onReportCapabilities={handleReportCapabilities}
          onLiveRatio={handleLiveRatio}
          onAction={onAction}
          onSwitchShell={onSwitchShell}
          onStartDrag={handleStartDrag}
          onEndDrag={handleEndDrag}
        />
      )}
    </div>
  )
}
