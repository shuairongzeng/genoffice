import { useCallback, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type {
  TerminalLayoutPreset,
  TerminalMode,
  TerminalShellKind,
} from '../../../shared/terminal-api'
import { findLeafByPaneId } from '../../../shared/terminal-layout'
import { useI18n } from '../locale'
import { TerminalGroupSidebar } from './TerminalGroupSidebar'
import { TerminalProfilesModal } from './TerminalProfilesModal'
import { TerminalSnippetsModal } from './TerminalSnippetsModal'
import { TerminalSplitTree } from './TerminalSplitTree'
import { TerminalSurfaceThemeButton } from './TerminalSurfaceThemeButton'
import { useTerminalSurfaceTheme } from './terminal-surface-theme'
import { switchPaneShell, useTerminalWorkspace } from './terminal-workspace-utils'
import './terminal.css'

function readInitialQuerySessionId(): string | null {
  if (typeof window === 'undefined') return null
  const id = new URLSearchParams(window.location.search).get('session')
  return id && id.trim() ? id.trim() : null
}

const PRESET_OPTIONS: ReadonlyArray<{
  preset: TerminalLayoutPreset
  labelKey:
    | 'termPresetSingle'
    | 'termPresetSplitH'
    | 'termPresetSplitV'
    | 'termPresetLeftRight2'
    | 'termPresetGrid2x2'
}> = [
  { preset: 'single', labelKey: 'termPresetSingle' },
  { preset: 'split-h', labelKey: 'termPresetSplitH' },
  { preset: 'split-v', labelKey: 'termPresetSplitV' },
  { preset: 'left-right2', labelKey: 'termPresetLeftRight2' },
  { preset: 'grid-2x2', labelKey: 'termPresetGrid2x2' },
]

function PresetIcon({ preset }: { preset: TerminalLayoutPreset }): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect
        x="2"
        y="2.5"
        width="12"
        height="11"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      {preset === 'split-h' && <path d="M8 2.5v11" stroke="currentColor" strokeWidth="1.25" />}
      {preset === 'split-v' && <path d="M2 8h12" stroke="currentColor" strokeWidth="1.25" />}
      {preset === 'left-right2' && (
        <>
          <path d="M8 2.5v11" stroke="currentColor" strokeWidth="1.25" />
          <path d="M8 8h6" stroke="currentColor" strokeWidth="1.25" />
        </>
      )}
      {preset === 'grid-2x2' && (
        <>
          <path d="M8 2.5v11" stroke="currentColor" strokeWidth="1.25" />
          <path d="M2 8h12" stroke="currentColor" strokeWidth="1.25" />
        </>
      )}
    </svg>
  )
}

/**
 * Standalone multi-group terminal workbench tab (?view=terminal).
 * Provides collapsible workspace groups sidebar, arbitrary split tree, layout presets,
 * broadcast input, workspace profiles, command snippets, and drawer docking.
 */
export function TerminalView(): ReactElement {
  const { t } = useI18n()
  const { surfaceTheme, cycleSurfaceTheme } = useTerminalSurfaceTheme()
  const [initialSessionId] = useState<string | null>(() => readInitialQuerySessionId())

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
    enabled: true,
    initialSessionId,
  })

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [profilesOpen, setProfilesOpen] = useState(false)
  const [snippetsOpen, setSnippetsOpen] = useState(false)

  const focusedSessionId = useMemo(() => {
    if (!activeGroup) return null
    const leaf = findLeafByPaneId(activeGroup.layout, activeGroup.focusedPaneId)
    return leaf?.sessionId ?? activeGroup.sessionIds[0] ?? null
  }, [activeGroup])

  const handleDockToDrawer = useCallback(() => {
    if (!focusedSessionId) return
    void window.aiOffice?.terminalDockToDrawer?.(focusedSessionId)
  }, [focusedSessionId])

  const handlePickGroupCwd = useCallback(
    (groupId: string) => {
      void window.aiOffice?.terminalPickGroupCwd?.(groupId).then((next) => {
        if (next) void reloadWorkspace()
      })
    },
    [reloadWorkspace],
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

  const handleSwitchShell = useCallback(
    (targetSessionId: string, shell: TerminalShellKind, cwd?: string) => {
      void switchPaneShell(activeGroup, targetSessionId, shell, cwd, dispatchAction)
    },
    [activeGroup, dispatchAction],
  )

  const groups = workspace?.groups ?? []

  return (
    <div className="term-view" data-testid="terminal-view">
      <header className="term-view-header">
        <div className="term-view-header-left">
          <button
            type="button"
            className={`term-icon-btn${!sidebarCollapsed ? ' is-active' : ''}`}
            data-testid="terminal-toggle-sidebar-btn"
            aria-pressed={!sidebarCollapsed}
            title={t('termToggleSidebar')}
            aria-label={t('termToggleSidebar')}
            onClick={() => setSidebarCollapsed((v) => !v)}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect
                x="2"
                y="2.5"
                width="12"
                height="11"
                rx="1.5"
                stroke="currentColor"
                strokeWidth="1.25"
              />
              <path d="M6 2.5v11" stroke="currentColor" strokeWidth="1.25" />
            </svg>
          </button>

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
                  data-testid={`terminal-view-group-tab-${group.id}`}
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
          {activeGroup && (
            <div className="term-preset-group" role="group" aria-label={t('termSplitPane')}>
              {PRESET_OPTIONS.map(({ preset, labelKey }) => (
                <button
                  key={preset}
                  type="button"
                  className="term-preset-btn"
                  data-testid={`terminal-preset-${preset}`}
                  title={t(labelKey)}
                  aria-label={t(labelKey)}
                  onClick={() =>
                    void dispatchAction({
                      type: 'apply-preset',
                      groupId: activeGroup.id,
                      preset,
                      defaultOpts: {
                        ...(selectedShell ? { shell: selectedShell } : {}),
                        mode: selectedMode,
                      },
                    })
                  }
                >
                  <PresetIcon preset={preset} />
                </button>
              ))}
            </div>
          )}

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
            data-testid="terminal-view-profiles-btn"
            title={t('termProfilesBtn')}
            onClick={() => setProfilesOpen(true)}
          >
            {t('termProfilesBtn')}
          </button>

          <button
            type="button"
            className="term-action-btn"
            data-testid="terminal-view-snippets-btn"
            title={`${t('termSnippetsBtn')} (Ctrl+Shift+K)`}
            onClick={() => setSnippetsOpen(true)}
          >
            {t('termSnippetsBtn')}
          </button>

          <TerminalSurfaceThemeButton surfaceTheme={surfaceTheme} onCycle={cycleSurfaceTheme} />

          <button
            type="button"
            className="term-action-btn"
            data-testid="terminal-dock-btn"
            disabled={!focusedSessionId}
            title={t('termDockToDrawer')}
            onClick={handleDockToDrawer}
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
              <path d="M2 9.5h12" stroke="currentColor" strokeWidth="1.25" />
            </svg>
            <span>{t('termDockToDrawer')}</span>
          </button>
        </div>
      </header>

      <div className="term-view-workbench">
        <TerminalGroupSidebar
          groups={groups}
          activeGroupId={activeGroup?.id ?? ''}
          sessionsById={sessionsById}
          collapsed={sidebarCollapsed}
          selectedShell={selectedShell}
          selectedMode={selectedMode}
          onAction={dispatchAction}
          onPickGroupCwd={handlePickGroupCwd}
          onOpenProfiles={() => setProfilesOpen(true)}
          onOpenSnippets={() => setSnippetsOpen(true)}
        />

        <main className="term-view-body">
          {activeGroup && (
            <TerminalSplitTree
              group={activeGroup}
              onAction={dispatchAction}
              onSwitchShell={handleSwitchShell}
              onOpenSnippets={() => setSnippetsOpen(true)}
            />
          )}
        </main>
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
    </div>
  )
}
