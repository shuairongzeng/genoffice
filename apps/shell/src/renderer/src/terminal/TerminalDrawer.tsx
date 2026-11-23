import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import type {
  TerminalGroupColor,
  TerminalMode,
  TerminalShellKind,
} from '../../../shared/terminal-api'
import { findLeafByPaneId } from '../../../shared/terminal-layout'
import { useI18n } from '../locale'
import { TerminalProfilesModal } from './TerminalProfilesModal'
import { TerminalSnippetsModal } from './TerminalSnippetsModal'
import { TerminalSplitTree } from './TerminalSplitTree'
import {
  GROUP_COLOR_OPTIONS,
  switchPaneShell,
  useTerminalWorkspace,
} from './terminal-workspace-utils'
import './terminal.css'

export interface TerminalDrawerProps {
  open: boolean
  height: number
  activeSessionId: string | null
  onHeightChange: (height: number) => void
  onActiveSessionChange: (sessionId: string | null) => void
  onClose: () => void
  onPopOutTab: (sessionId: string) => void
}

const MIN_DRAWER_HEIGHT = 180
const AUTO_VERTICAL_SPLIT_HEIGHT = 420
const TOP_VIEWPORT_RESERVE = 160

function clampDrawerHeight(value: number): number {
  const max =
    typeof window !== 'undefined'
      ? Math.max(MIN_DRAWER_HEIGHT, window.innerHeight - TOP_VIEWPORT_RESERVE)
      : 640
  if (!Number.isFinite(value)) return 300
  return Math.min(max, Math.max(MIN_DRAWER_HEIGHT, Math.round(value)))
}

/**
 * Bottom collapsible multi-group, arbitrary-split terminal drawer embedded in Home.
 * Shares authoritative workspace state and layouts with standalone terminal tabs.
 */
export function TerminalDrawer({
  open,
  height,
  activeSessionId,
  onHeightChange,
  onActiveSessionChange,
  onClose,
  onPopOutTab,
}: TerminalDrawerProps): ReactElement | null {
  const { t } = useI18n()

  const {
    workspace,
    activeGroup,
    sessionsById,
    shells,
    selectedShell,
    setSelectedShell,
    selectedMode,
    setSelectedMode,
    profiles,
    snippets,
    refreshProfiles,
    refreshSnippets,
    dispatchAction,
    reloadWorkspace,
  } = useTerminalWorkspace({
    enabled: open,
    preferFocusedSessionId: activeSessionId,
  })

  const [resizing, setResizing] = useState(false)
  const [profilesOpen, setProfilesOpen] = useState(false)
  const [snippetsOpen, setSnippetsOpen] = useState(false)

  const dragStateRef = useRef<{
    active: boolean
    startY: number
    startHeight: number
  }>({ active: false, startY: 0, startHeight: height })

  const focusedSessionId = useMemo(() => {
    if (!activeGroup) return null
    const leaf = findLeafByPaneId(activeGroup.layout, activeGroup.focusedPaneId)
    return leaf?.sessionId ?? activeGroup.sessionIds[0] ?? null
  }, [activeGroup])

  useEffect(() => {
    if (open && focusedSessionId && focusedSessionId !== activeSessionId) {
      onActiveSessionChange(focusedSessionId)
    }
  }, [activeSessionId, focusedSessionId, onActiveSessionChange, open])

  const handleResizePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      const handle = e.currentTarget
      handle.setPointerCapture(e.pointerId)
      dragStateRef.current = { active: true, startY: e.clientY, startHeight: height }
      setResizing(true)

      const onMove = (ev: PointerEvent): void => {
        if (!dragStateRef.current.active) return
        const delta = dragStateRef.current.startY - ev.clientY
        onHeightChange(clampDrawerHeight(dragStateRef.current.startHeight + delta))
      }

      const onEnd = (): void => {
        dragStateRef.current.active = false
        setResizing(false)
        handle.removeEventListener('pointermove', onMove)
        handle.removeEventListener('pointerup', onEnd)
        handle.removeEventListener('pointercancel', onEnd)
      }

      handle.addEventListener('pointermove', onMove)
      handle.addEventListener('pointerup', onEnd)
      handle.addEventListener('pointercancel', onEnd)
    },
    [height, onHeightChange],
  )

  const handleCreateSession = useCallback(() => {
    if (!activeGroup) return
    void dispatchAction({
      type: 'add-session-to-group',
      groupId: activeGroup.id,
      opts: {
        ...(selectedShell ? { shell: selectedShell } : {}),
        mode: selectedMode,
      },
      replaceFocusedPane: true,
    })
  }, [activeGroup, dispatchAction, selectedMode, selectedShell])

  const handleCreateGroup = useCallback(() => {
    const nextIdx = workspace?.groups.length ?? 0
    const nextColor: TerminalGroupColor =
      GROUP_COLOR_OPTIONS[nextIdx % GROUP_COLOR_OPTIONS.length] ?? 'blue'
    void dispatchAction({
      type: 'create-group',
      color: nextColor,
      ...(selectedShell ? { shell: selectedShell } : {}),
      mode: selectedMode,
      activate: true,
    })
  }, [dispatchAction, selectedMode, selectedShell, workspace?.groups.length])

  const handleSplitDirection = useCallback(
    (direction: 'horizontal' | 'vertical') => {
      if (!activeGroup) return
      if (direction === 'vertical' && height < 380) {
        onHeightChange(clampDrawerHeight(Math.max(AUTO_VERTICAL_SPLIT_HEIGHT, height)))
      }
      void dispatchAction({
        type: 'split-pane',
        groupId: activeGroup.id,
        targetPaneId: activeGroup.focusedPaneId,
        direction,
        createOpts: {
          ...(selectedShell ? { shell: selectedShell } : {}),
          mode: selectedMode,
        },
      })
    },
    [activeGroup, dispatchAction, height, onHeightChange, selectedMode, selectedShell],
  )

  const handleSwitchShell = useCallback(
    (targetSessionId: string, shell: TerminalShellKind, cwd?: string) => {
      void switchPaneShell(activeGroup, targetSessionId, shell, cwd, dispatchAction)
    },
    [activeGroup, dispatchAction],
  )

  if (!open) return null

  const groups = workspace?.groups ?? []

  return (
    <aside
      className={`term-drawer${resizing ? ' is-resizing' : ''}`}
      data-testid="terminal-drawer"
      style={{ height: `${clampDrawerHeight(height)}px` }}
      aria-label={t('termTitle')}
    >
      <div
        className="term-drawer-resize-handle"
        data-testid="terminal-drawer-resize"
        onPointerDown={handleResizePointerDown}
        role="separator"
        aria-orientation="horizontal"
        aria-valuenow={Math.round(height)}
      />

      <header className="term-drawer-header">
        <div className="term-drawer-header-left">
          <span className="term-brand">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M2.5 4.2l3.8 3.3-3.8 3.3M8 11.5h5.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="term-brand-title">{t('termTitle')}</span>
          </span>

          <div className="term-group-pills" role="tablist" aria-label={t('termGroupsTitle')}>
            {groups.map((group) => {
              const isActive = group.id === activeGroup?.id
              return (
                <button
                  key={group.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className={`term-group-pill is-color-${group.color}${isActive ? ' is-active' : ''}`}
                  data-testid={`terminal-group-tab-${group.id}`}
                  onClick={() => void dispatchAction({ type: 'activate-group', groupId: group.id })}
                >
                  <span
                    className={`term-group-pill-dot is-color-${group.color}`}
                    aria-hidden="true"
                  />
                  <span className="term-group-pill-name">{group.name}</span>
                  {!isActive && group.hasAlert && (
                    <span className="term-group-alert-dot" aria-hidden="true" />
                  )}
                </button>
              )
            })}

            <button
              type="button"
              className="term-new-session-btn"
              data-testid="terminal-drawer-new-group-btn"
              title={t('termNewGroup')}
              aria-label={t('termNewGroup')}
              onClick={handleCreateGroup}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M2 4.2A1.4 1.4 0 0 1 3.4 2.8h2.8l1.1 1.3h5.3A1.4 1.4 0 0 1 14 5.5v6.3a1.4 1.4 0 0 1-1.4 1.4H3.4A1.4 1.4 0 0 1 2 11.8V4.2Z"
                  stroke="currentColor"
                  strokeWidth="1.25"
                  strokeLinejoin="round"
                />
                <path
                  d="M8 7.2v3.6M6.2 9h3.6"
                  stroke="currentColor"
                  strokeWidth="1.25"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>

          <button
            type="button"
            className="term-new-session-btn"
            data-testid="terminal-new-session-btn"
            title={t('termNewSession')}
            aria-label={t('termNewSession')}
            onClick={handleCreateSession}
          >
            +
          </button>

          <select
            className="term-shell-select"
            data-testid="terminal-shell-select"
            aria-label={t('termShellLabel')}
            value={selectedShell}
            onChange={(e) => setSelectedShell(e.target.value as TerminalShellKind)}
          >
            {shells.map((opt) => (
              <option key={opt.kind} value={opt.kind} disabled={!opt.available}>
                {opt.label}
              </option>
            ))}
          </select>

          <select
            className="term-mode-select"
            data-testid="terminal-mode-select"
            aria-label={t('termModeLabel')}
            value={selectedMode}
            onChange={(e) => setSelectedMode(e.target.value as TerminalMode)}
          >
            <option value="pty">{t('termModePty')}</option>
            <option value="block">{t('termModeBlock')}</option>
          </select>
        </div>

        <div className="term-header-right">
          <button
            type="button"
            className="term-action-btn"
            data-testid="terminal-drawer-split-btn"
            title={t('termSplitRight')}
            onClick={() => handleSplitDirection('horizontal')}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect
                x="2"
                y="2.5"
                width="12"
                height="11"
                rx="1.5"
                stroke="currentColor"
                strokeWidth="1.25"
              />
              <path d="M8 2.5v11" stroke="currentColor" strokeWidth="1.25" />
            </svg>
            <span>{t('termSplitRight').split(' ')[0]}</span>
          </button>

          <button
            type="button"
            className="term-action-btn"
            data-testid="terminal-drawer-split-v-btn"
            title={t('termSplitDown')}
            onClick={() => handleSplitDirection('vertical')}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect
                x="2"
                y="2.5"
                width="12"
                height="11"
                rx="1.5"
                stroke="currentColor"
                strokeWidth="1.25"
              />
              <path d="M2 8h12" stroke="currentColor" strokeWidth="1.25" />
            </svg>
          </button>

          {activeGroup && (
            <button
              type="button"
              className={`term-action-btn${activeGroup.broadcastEnabled ? ' is-broadcast' : ''}`}
              data-testid="terminal-broadcast-toggle-btn"
              aria-pressed={activeGroup.broadcastEnabled}
              title={t('termBroadcastBtn')}
              onClick={() =>
                void dispatchAction({
                  type: 'update-group',
                  groupId: activeGroup.id,
                  broadcastEnabled: !activeGroup.broadcastEnabled,
                })
              }
            >
              {t('termBroadcastBtn')}
            </button>
          )}

          <button
            type="button"
            className="term-action-btn"
            data-testid="terminal-drawer-snippets-btn"
            title={`${t('termSnippetsBtn')} (Ctrl+Shift+K)`}
            onClick={() => setSnippetsOpen(true)}
          >
            {t('termSnippetsBtn')}
          </button>

          <button
            type="button"
            className="term-action-btn"
            data-testid="terminal-drawer-profiles-btn"
            title={t('termProfilesBtn')}
            onClick={() => setProfilesOpen(true)}
          >
            {t('termProfilesBtn')}
          </button>

          <button
            type="button"
            className="term-action-btn"
            data-testid="terminal-popout-btn"
            disabled={!focusedSessionId}
            title={t('termPopOutTab')}
            onClick={() => {
              if (focusedSessionId) onPopOutTab(focusedSessionId)
            }}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M9.5 2.5h4v4M13.5 2.5L7.5 8.5M13 9.5v3a1.2 1.2 0 0 1-1.2 1.2H3.7A1.2 1.2 0 0 1 2.5 12.5V4.2A1.2 1.2 0 0 1 3.7 3h3"
                stroke="currentColor"
                strokeWidth="1.25"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>{t('termPopOutTab')}</span>
          </button>

          <button
            type="button"
            className="term-icon-btn"
            data-testid="terminal-drawer-close-btn"
            aria-label={t('termTitle')}
            onClick={onClose}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </header>

      <div className="term-drawer-body">
        {activeGroup && (
          <TerminalSplitTree
            group={activeGroup}
            compact
            onAction={dispatchAction}
            onSwitchShell={handleSwitchShell}
            onOpenSnippets={() => setSnippetsOpen(true)}
          />
        )}
      </div>

      <TerminalProfilesModal
        open={profilesOpen}
        activeGroup={activeGroup}
        sessionsById={sessionsById}
        profiles={profiles}
        onClose={() => setProfilesOpen(false)}
        onRefreshProfiles={refreshProfiles}
        onReloadWorkspace={reloadWorkspace}
      />

      <TerminalSnippetsModal
        open={snippetsOpen}
        activeGroup={activeGroup}
        sessionsById={sessionsById}
        snippets={snippets}
        onClose={() => setSnippetsOpen(false)}
        onRefreshSnippets={refreshSnippets}
        onDispatchAction={dispatchAction}
      />
    </aside>
  )
}
