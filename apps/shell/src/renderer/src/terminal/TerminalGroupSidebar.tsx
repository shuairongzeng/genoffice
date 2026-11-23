import { useState } from 'react'
import type { KeyboardEvent, ReactElement } from 'react'
import type {
  TerminalGroup,
  TerminalGroupColor,
  TerminalMode,
  TerminalSessionSummary,
  TerminalShellKind,
  TerminalWorkspaceAction,
} from '../../../shared/terminal-api'
import { useI18n } from '../locale'
import { GROUP_COLOR_OPTIONS } from './terminal-workspace-utils'

export interface TerminalGroupSidebarProps {
  groups: TerminalGroup[]
  activeGroupId: string
  sessionsById: Map<string, TerminalSessionSummary>
  collapsed: boolean
  selectedShell: TerminalShellKind | ''
  selectedMode: TerminalMode
  onAction: (action: TerminalWorkspaceAction) => Promise<unknown> | void
  onPickGroupCwd: (groupId: string) => void
  onOpenProfiles: () => void
  onOpenSnippets: () => void
}

/**
 * Collapsible workspace sidebar shown in standalone terminal tab mode.
 * Manages named/colored terminal groups, group default directories, session movement,
 * background alerts, and workspace templates/snippets entry points.
 */
export function TerminalGroupSidebar({
  groups,
  activeGroupId,
  sessionsById,
  collapsed,
  selectedShell,
  selectedMode,
  onAction,
  onPickGroupCwd,
  onOpenProfiles,
  onOpenSnippets,
}: TerminalGroupSidebarProps): ReactElement | null {
  const { t } = useI18n()

  const [creatingGroup, setCreatingGroup] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [newGroupColor, setNewGroupColor] = useState<TerminalGroupColor>('emerald')
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [draftGroupName, setDraftGroupName] = useState('')
  const [paletteGroupId, setPaletteGroupId] = useState<string | null>(null)

  if (collapsed) return null

  const submitNewGroup = (): void => {
    const trimmed = newGroupName.trim()
    setCreatingGroup(false)
    setNewGroupName('')
    void onAction({
      type: 'create-group',
      ...(trimmed ? { name: trimmed } : {}),
      color: newGroupColor,
      ...(selectedShell ? { shell: selectedShell } : {}),
      mode: selectedMode,
      activate: true,
    })
  }

  const commitRenameGroup = (group: TerminalGroup): void => {
    setEditingGroupId(null)
    const trimmed = draftGroupName.trim()
    if (trimmed && trimmed !== group.name) {
      void onAction({ type: 'update-group', groupId: group.id, name: trimmed })
    }
  }

  const handleRenameKeyDown = (e: KeyboardEvent<HTMLInputElement>, group: TerminalGroup): void => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      commitRenameGroup(group)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setEditingGroupId(null)
    }
  }

  return (
    <aside className="term-group-sidebar" data-testid="terminal-group-sidebar">
      <header className="term-sidebar-header">
        <span className="term-sidebar-title">{t('termGroupsTitle')}</span>
        <button
          type="button"
          className="term-sidebar-add-btn"
          data-testid="terminal-new-group-btn"
          title={t('termNewGroup')}
          onClick={() => setCreatingGroup((v) => !v)}
        >
          + {t('termNewGroup')}
        </button>
      </header>

      {creatingGroup && (
        <div className="term-sidebar-create-box" data-testid="terminal-create-group-form">
          <input
            type="text"
            className="term-sidebar-input"
            data-testid="terminal-create-group-name-input"
            autoFocus
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submitNewGroup()
              } else if (e.key === 'Escape') {
                setCreatingGroup(false)
              }
            }}
            placeholder={t('termGroupNamePlaceholder')}
          />
          <div className="term-color-picker-row">
            {GROUP_COLOR_OPTIONS.map((c) => (
              <button
                key={c}
                type="button"
                className={`term-color-swatch is-color-${c}${newGroupColor === c ? ' is-selected' : ''}`}
                aria-label={`${t('termGroupColor')} ${c}`}
                onClick={() => setNewGroupColor(c)}
              />
            ))}
          </div>
          <div className="term-sidebar-create-actions">
            <button
              type="button"
              className="term-mini-btn is-active"
              data-testid="terminal-create-group-submit"
              onClick={submitNewGroup}
            >
              {t('termAdd')}
            </button>
            <button type="button" className="term-mini-btn" onClick={() => setCreatingGroup(false)}>
              {t('termCancel')}
            </button>
          </div>
        </div>
      )}

      <div className="term-sidebar-groups g-scroll">
        {groups.map((group) => {
          const isActive = group.id === activeGroupId
          const otherGroups = groups.filter((g) => g.id !== group.id)

          return (
            <section
              key={group.id}
              className={`term-group-card is-color-${group.color}${isActive ? ' is-active' : ''}`}
              data-testid={`terminal-group-card-${group.id}`}
            >
              <div
                className="term-group-header"
                onClick={() => {
                  if (!isActive) {
                    void onAction({ type: 'activate-group', groupId: group.id })
                  }
                }}
              >
                <div className="term-group-header-left">
                  <button
                    type="button"
                    className="term-group-collapse-btn"
                    title={t('termCollapseGroup')}
                    aria-label={t('termCollapseGroup')}
                    onClick={(e) => {
                      e.stopPropagation()
                      void onAction({
                        type: 'update-group',
                        groupId: group.id,
                        collapsed: !group.collapsed,
                      })
                    }}
                  >
                    {group.collapsed ? '▸' : '▾'}
                  </button>

                  <button
                    type="button"
                    className={`term-group-dot-btn is-color-${group.color}`}
                    title={t('termGroupColor')}
                    aria-label={t('termGroupColor')}
                    onClick={(e) => {
                      e.stopPropagation()
                      setPaletteGroupId((cur) => (cur === group.id ? null : group.id))
                    }}
                  />

                  {editingGroupId === group.id ? (
                    <input
                      type="text"
                      className="term-sidebar-rename-input"
                      autoFocus
                      value={draftGroupName}
                      onChange={(e) => setDraftGroupName(e.target.value)}
                      onBlur={() => commitRenameGroup(group)}
                      onKeyDown={(e) => handleRenameKeyDown(e, group)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span
                      className="term-group-name"
                      onDoubleClick={(e) => {
                        e.stopPropagation()
                        setDraftGroupName(group.name)
                        setEditingGroupId(group.id)
                      }}
                    >
                      {group.name}
                    </span>
                  )}

                  {!isActive && group.hasAlert && (
                    <span
                      className="term-group-alert-dot"
                      data-testid={`terminal-group-alert-${group.id}`}
                      title={t('termGroupAlertTip')}
                    />
                  )}
                </div>

                <div className="term-group-actions">
                  <button
                    type="button"
                    className="term-group-icon-btn"
                    data-testid={`terminal-group-cwd-${group.id}`}
                    title={
                      group.defaultCwd
                        ? `${group.defaultCwd} — ${t('termGroupDefaultCwd')}`
                        : t('termGroupDefaultCwd')
                    }
                    onClick={(e) => {
                      e.stopPropagation()
                      onPickGroupCwd(group.id)
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path
                        d="M2 4.2A1.4 1.4 0 0 1 3.4 2.8h2.9l1.2 1.4h5.1A1.4 1.4 0 0 1 14 5.6v6.2a1.4 1.4 0 0 1-1.4 1.4H3.4A1.4 1.4 0 0 1 2 11.8V4.2Z"
                        stroke="currentColor"
                        strokeWidth="1.25"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>

                  <button
                    type="button"
                    className="term-group-icon-btn"
                    data-testid={`terminal-group-add-session-${group.id}`}
                    title={t('termNewSessionInGroup')}
                    onClick={(e) => {
                      e.stopPropagation()
                      void onAction({
                        type: 'add-session-to-group',
                        groupId: group.id,
                        opts: {
                          ...(selectedShell ? { shell: selectedShell } : {}),
                          mode: selectedMode,
                        },
                        replaceFocusedPane: true,
                      })
                    }}
                  >
                    +
                  </button>

                  <button
                    type="button"
                    className="term-group-icon-btn is-danger"
                    data-testid={`terminal-close-group-${group.id}`}
                    title={t('termGroupClose')}
                    onClick={(e) => {
                      e.stopPropagation()
                      void onAction({ type: 'close-group', groupId: group.id })
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>

              {paletteGroupId === group.id && (
                <div className="term-group-palette">
                  {GROUP_COLOR_OPTIONS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={`term-color-swatch is-color-${c}${group.color === c ? ' is-selected' : ''}`}
                      onClick={() => {
                        setPaletteGroupId(null)
                        void onAction({ type: 'update-group', groupId: group.id, color: c })
                      }}
                    />
                  ))}
                </div>
              )}

              {!group.collapsed && (
                <div className="term-group-sessions">
                  {group.defaultCwd && (
                    <div className="term-group-cwd-caption" title={group.defaultCwd}>
                      {group.defaultCwd}
                    </div>
                  )}

                  {group.sessionIds.map((sid) => {
                    const summary = sessionsById.get(sid)
                    if (!summary) return null
                    const label = summary.oscTitle?.trim() || summary.title
                    return (
                      <div
                        key={sid}
                        className="term-sidebar-session"
                        data-testid={`terminal-sidebar-session-${sid}`}
                        onClick={() => {
                          void onAction({ type: 'activate-group', groupId: group.id })
                          void onAction({
                            type: 'select-group-session',
                            groupId: group.id,
                            sessionId: sid,
                          })
                        }}
                      >
                        <span
                          className={`term-tab-dot${summary.running ? ' is-running' : ''}`}
                          aria-hidden="true"
                        />
                        <span className="term-sidebar-session-label" title={label}>
                          {label}
                        </span>
                        <span className="term-sidebar-session-badge">{summary.shell}</span>

                        {otherGroups.length > 0 && (
                          <select
                            className="term-session-move-select"
                            aria-label={t('termMoveToGroup')}
                            title={t('termMoveToGroup')}
                            value=""
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => {
                              e.stopPropagation()
                              const targetGroupId = e.target.value
                              if (targetGroupId) {
                                void onAction({
                                  type: 'move-session-to-group',
                                  sessionId: sid,
                                  targetGroupId,
                                })
                              }
                            }}
                          >
                            <option value="">⇄</option>
                            {otherGroups.map((og) => (
                              <option key={og.id} value={og.id}>
                                → {og.name}
                              </option>
                            ))}
                          </select>
                        )}

                        <button
                          type="button"
                          className="term-sidebar-session-close"
                          aria-label={t('termCloseSession')}
                          onClick={(e) => {
                            e.stopPropagation()
                            void window.aiOffice?.terminalCloseSession?.(sid)
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          )
        })}
      </div>

      <footer className="term-sidebar-footer">
        <button
          type="button"
          className="term-sidebar-footer-btn"
          data-testid="terminal-profiles-open-btn"
          onClick={onOpenProfiles}
        >
          {t('termProfilesBtn')}
        </button>
        <button
          type="button"
          className="term-sidebar-footer-btn"
          data-testid="terminal-snippets-open-btn"
          onClick={onOpenSnippets}
        >
          {t('termSnippetsBtn')}
        </button>
      </footer>
    </aside>
  )
}
