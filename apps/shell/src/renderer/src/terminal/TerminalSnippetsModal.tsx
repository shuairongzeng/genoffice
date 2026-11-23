import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type {
  TerminalCommandSnippet,
  TerminalGroup,
  TerminalSessionSummary,
  TerminalWorkspaceAction,
  TerminalWorkspaceSnapshot,
} from '../../../shared/terminal-api'
import { useI18n } from '../locale'
import { copyTextToClipboard } from './terminal-clipboard'
import { dispatchCommandToGroup } from './terminal-workspace-utils'

export interface TerminalSnippetsModalProps {
  open: boolean
  activeGroup: TerminalGroup | null
  sessionsById: Map<string, TerminalSessionSummary>
  snippets: TerminalCommandSnippet[]
  onClose: () => void
  onRefreshSnippets: () => Promise<void>
  onDispatchAction: (action: TerminalWorkspaceAction) => Promise<TerminalWorkspaceSnapshot | null>
}

/**
 * Quick command palette (Ctrl+Shift+K) combining saved snippets and deduplicated recent
 * block command history across workspace sessions.
 */
export function TerminalSnippetsModal({
  open,
  activeGroup,
  sessionsById,
  snippets,
  onClose,
  onRefreshSnippets,
  onDispatchAction,
}: TerminalSnippetsModalProps): ReactElement | null {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [title, setTitle] = useState('')
  const [command, setCommand] = useState('')
  const [sendEnter, setSendEnter] = useState(true)
  const [recentHistory, setRecentHistory] = useState<string[]>([])
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    window.requestAnimationFrame(() => searchRef.current?.focus())

    let alive = true
    const blockSessions = Array.from(sessionsById.values()).filter((s) => s.mode === 'block')
    if (blockSessions.length === 0) {
      setRecentHistory([])
      return
    }

    void Promise.all(
      blockSessions.map((s) => window.aiOffice?.terminalGetSession?.(s.id).catch(() => null)),
    ).then((snapshots) => {
      if (!alive) return
      const seen = new Set<string>()
      const cmds: string[] = []
      for (const snap of snapshots) {
        if (!snap) continue
        for (let i = snap.blocks.length - 1; i >= 0; i -= 1) {
          const cmd = snap.blocks[i]?.command.trim()
          if (cmd && !seen.has(cmd)) {
            seen.add(cmd)
            cmds.push(cmd)
            if (cmds.length >= 15) break
          }
        }
        if (cmds.length >= 15) break
      }
      setRecentHistory(cmds)
    })

    return () => {
      alive = false
    }
  }, [open, sessionsById])

  const filteredSnippets = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return snippets
    return snippets.filter(
      (s) => s.title.toLowerCase().includes(q) || s.command.toLowerCase().includes(q),
    )
  }, [query, snippets])

  const filteredHistory = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return recentHistory
    return recentHistory.filter((cmd) => cmd.toLowerCase().includes(q))
  }, [query, recentHistory])

  if (!open) return null

  const handleSaveSnippet = async (): Promise<void> => {
    if (!title.trim() || !command.trim()) return
    await window.aiOffice?.terminalSaveSnippet?.({
      title: title.trim(),
      command: command.trim(),
      sendEnter,
    })
    setTitle('')
    setCommand('')
    setShowAdd(false)
    await onRefreshSnippets()
  }

  const handleSendCommand = (cmd: string, autoEnter: boolean): void => {
    void dispatchCommandToGroup(activeGroup, sessionsById, cmd, autoEnter, onDispatchAction)
    onClose()
  }

  return (
    <div className="term-modal-backdrop" data-testid="terminal-snippets-modal" onClick={onClose}>
      <div
        className="term-modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('termSnippetsTitle')}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      >
        <header className="term-modal-header">
          <h3 className="term-modal-title">{t('termSnippetsTitle')}</h3>
          <button
            type="button"
            className="term-icon-btn"
            data-testid="terminal-snippets-close-btn"
            aria-label={t('termClose')}
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        <div className="term-modal-toolbar">
          <input
            ref={searchRef}
            type="search"
            className="term-modal-input"
            data-testid="terminal-snippet-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('termSnippetSearchPlaceholder')}
          />
          <button
            type="button"
            className="term-mini-btn is-active"
            data-testid="terminal-snippet-add-toggle"
            onClick={() => setShowAdd((v) => !v)}
          >
            + {t('termSnippetNew')}
          </button>
        </div>

        <div className="term-modal-body g-scroll">
          {showAdd && (
            <section className="term-snippet-add-box" data-testid="terminal-snippet-add-form">
              <input
                type="text"
                className="term-modal-input"
                data-testid="terminal-snippet-title-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('termSnippetTitlePlaceholder')}
              />
              <textarea
                rows={2}
                className="term-modal-textarea"
                data-testid="terminal-snippet-cmd-input"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder={t('termSnippetCmdPlaceholder')}
              />
              <div className="term-snippet-add-footer">
                <label className="term-snippet-checkbox">
                  <input
                    type="checkbox"
                    checked={sendEnter}
                    onChange={(e) => setSendEnter(e.target.checked)}
                  />
                  <span>{t('termSnippetSendEnter')}</span>
                </label>
                <button
                  type="button"
                  className="term-run-btn"
                  data-testid="terminal-snippet-save-btn"
                  disabled={!title.trim() || !command.trim()}
                  onClick={() => void handleSaveSnippet()}
                >
                  {t('termSnippetSave')}
                </button>
              </div>
            </section>
          )}

          <div className="term-snippet-list">
            {filteredSnippets.map((snippet) => (
              <div
                key={snippet.id}
                className="term-snippet-row"
                data-testid={`terminal-snippet-item-${snippet.id}`}
              >
                <button
                  type="button"
                  className="term-snippet-main-btn"
                  onClick={() => handleSendCommand(snippet.command, snippet.sendEnter)}
                >
                  <strong className="term-snippet-row-title">{snippet.title}</strong>
                  <code className="term-snippet-row-cmd">{snippet.command}</code>
                </button>
                <div className="term-snippet-row-actions">
                  <button
                    type="button"
                    className="term-mini-btn"
                    onClick={() => void copyTextToClipboard(snippet.command)}
                  >
                    {t('termCopyCommand')}
                  </button>
                  <button
                    type="button"
                    className="term-mini-btn"
                    data-testid={`terminal-snippet-delete-${snippet.id}`}
                    onClick={() => {
                      void window.aiOffice
                        ?.terminalDeleteSnippet?.(snippet.id)
                        ?.then(() => onRefreshSnippets())
                    }}
                  >
                    {t('termProfileDelete')}
                  </button>
                </div>
              </div>
            ))}
          </div>

          {filteredHistory.length > 0 && (
            <section className="term-snippet-history">
              <h4 className="term-snippet-history-title">{t('termSnippetRecentHistory')}</h4>
              {filteredHistory.map((cmd, idx) => (
                <div key={idx} className="term-snippet-row">
                  <button
                    type="button"
                    className="term-snippet-main-btn"
                    onClick={() => handleSendCommand(cmd, false)}
                  >
                    <code className="term-snippet-row-cmd">{cmd}</code>
                  </button>
                  <button
                    type="button"
                    className="term-mini-btn"
                    onClick={() => handleSendCommand(cmd, true)}
                  >
                    {t('termSnippetRun')}
                  </button>
                </div>
              ))}
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
