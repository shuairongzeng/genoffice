import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type {
  TerminalGroup,
  TerminalProfileLayoutNode,
  TerminalSessionSummary,
  TerminalWorkspaceProfile,
} from '../../../shared/terminal-api'
import { collectLeafPanes } from '../../../shared/terminal-layout'
import { useI18n } from '../locale'

export interface TerminalProfilesModalProps {
  open: boolean
  activeGroup: TerminalGroup | null
  sessionsById: Map<string, TerminalSessionSummary>
  profiles: TerminalWorkspaceProfile[]
  onClose: () => void
  onRefreshProfiles: () => Promise<void>
  onReloadWorkspace: () => Promise<void>
}

function collectProfileStartupCommands(node: TerminalProfileLayoutNode): string[] {
  if (node.type === 'leaf') {
    const cmd = node.startupCommand?.trim()
    return cmd ? [cmd] : []
  }
  return [
    ...collectProfileStartupCommands(node.first),
    ...collectProfileStartupCommands(node.second),
  ]
}

function countProfilePanes(node: TerminalProfileLayoutNode): number {
  if (node.type === 'leaf') return 1
  return countProfilePanes(node.first) + countProfilePanes(node.second)
}

/**
 * Modal dialog for saving the active group's layout as a reusable workspace template
 * and launching saved multi-pane profiles with explicit confirmation for auto-run commands.
 */
export function TerminalProfilesModal({
  open,
  activeGroup,
  sessionsById,
  profiles,
  onClose,
  onRefreshProfiles,
  onReloadWorkspace,
}: TerminalProfilesModalProps): ReactElement | null {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [startupMap, setStartupMap] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [confirmProfileId, setConfirmProfileId] = useState<string | null>(null)

  const activeLeaves = useMemo(
    () => (activeGroup ? collectLeafPanes(activeGroup.layout) : []),
    [activeGroup],
  )

  if (!open) return null

  const handleSave = async (): Promise<void> => {
    const api = window.aiOffice
    if (!api?.terminalSaveProfile || !activeGroup) return
    const finalName = name.trim() || activeGroup.name
    setSaving(true)
    try {
      await api.terminalSaveProfile({
        groupId: activeGroup.id,
        name: finalName,
        startupCommandsBySessionId: startupMap,
      })
      setName('')
      setStartupMap({})
      await onRefreshProfiles()
    } finally {
      setSaving(false)
    }
  }

  const executeLaunch = async (profileId: string): Promise<void> => {
    const api = window.aiOffice
    if (!api?.terminalLaunchProfile) return
    setConfirmProfileId(null)
    await api.terminalLaunchProfile(profileId)
    onClose()
    void onReloadWorkspace()
  }

  return (
    <div className="term-modal-backdrop" data-testid="terminal-profiles-modal" onClick={onClose}>
      <div
        className="term-modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('termProfilesTitle')}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="term-modal-header">
          <h3 className="term-modal-title">{t('termProfilesTitle')}</h3>
          <button
            type="button"
            className="term-icon-btn"
            data-testid="terminal-profiles-close-btn"
            aria-label={t('termClose')}
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        <div className="term-modal-body g-scroll">
          {activeGroup && (
            <section className="term-profile-save-box">
              <div className="term-profile-save-row">
                <input
                  type="text"
                  className="term-modal-input"
                  data-testid="terminal-profile-name-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={`${t('termProfileNamePlaceholder')} (${activeGroup.name})`}
                />
                <button
                  type="button"
                  className="term-run-btn"
                  data-testid="terminal-profile-save-btn"
                  disabled={saving}
                  onClick={() => void handleSave()}
                >
                  {t('termProfileSave')}
                </button>
              </div>

              {activeLeaves.length > 0 && (
                <div className="term-profile-pane-cmds">
                  {activeLeaves.map((leaf, idx) => {
                    const summary = sessionsById.get(leaf.sessionId)
                    return (
                      <div key={leaf.paneId} className="term-profile-pane-cmd-row">
                        <span className="term-profile-pane-label">
                          #{idx + 1} {summary?.shell ?? 'shell'} ({summary?.title ?? leaf.paneId})
                        </span>
                        <input
                          type="text"
                          className="term-modal-input"
                          value={startupMap[leaf.sessionId] ?? ''}
                          onChange={(e) =>
                            setStartupMap((prev) => ({
                              ...prev,
                              [leaf.sessionId]: e.target.value,
                            }))
                          }
                          placeholder={t('termProfileStartupCmdLabel')}
                        />
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          )}

          <section className="term-profile-list">
            {profiles.length === 0 ? (
              <p className="term-empty-hint">{t('termProfileEmpty')}</p>
            ) : (
              profiles.map((profile) => {
                const paneCount = countProfilePanes(profile.layout)
                const startupCmds = collectProfileStartupCommands(profile.layout)
                const needsConfirm = confirmProfileId === profile.id
                return (
                  <div
                    key={profile.id}
                    className="term-profile-card"
                    data-testid={`terminal-profile-card-${profile.id}`}
                  >
                    <div className="term-profile-card-main">
                      <span
                        className={`term-group-dot-btn is-color-${profile.color}`}
                        aria-hidden="true"
                      />
                      <div className="term-profile-card-info">
                        <strong className="term-profile-card-name">{profile.name}</strong>
                        <span className="term-profile-card-meta">
                          {t('termProfilePaneCount', { count: paneCount })}
                          {profile.defaultCwd ? ` · ${profile.defaultCwd}` : ''}
                        </span>
                      </div>
                      <div className="term-profile-card-actions">
                        <button
                          type="button"
                          className="term-mini-btn is-active"
                          data-testid={`terminal-profile-launch-${profile.id}`}
                          onClick={() => {
                            if (startupCmds.length > 0) {
                              setConfirmProfileId(profile.id)
                            } else {
                              void executeLaunch(profile.id)
                            }
                          }}
                        >
                          {t('termProfileLaunch')}
                        </button>
                        <button
                          type="button"
                          className="term-mini-btn"
                          data-testid={`terminal-profile-delete-${profile.id}`}
                          onClick={() => {
                            void window.aiOffice
                              ?.terminalDeleteProfile?.(profile.id)
                              ?.then(() => onRefreshProfiles())
                          }}
                        >
                          {t('termProfileDelete')}
                        </button>
                      </div>
                    </div>

                    {needsConfirm && (
                      <div
                        className="term-profile-confirm-bar"
                        data-testid={`terminal-profile-confirm-${profile.id}`}
                      >
                        <p className="term-profile-confirm-text">{t('termProfileConfirmRun')}</p>
                        <ul className="term-profile-confirm-cmds">
                          {startupCmds.map((cmd, i) => (
                            <li key={i}>
                              <code>{cmd}</code>
                            </li>
                          ))}
                        </ul>
                        <div className="term-profile-confirm-actions">
                          <button
                            type="button"
                            className="term-mini-btn is-active"
                            data-testid={`terminal-profile-confirm-launch-${profile.id}`}
                            onClick={() => void executeLaunch(profile.id)}
                          >
                            {t('termConfirm')}
                          </button>
                          <button
                            type="button"
                            className="term-mini-btn"
                            onClick={() => setConfirmProfileId(null)}
                          >
                            {t('termCancel')}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
