import { useEffect, useRef, useState } from 'react'
import type { DragEvent, KeyboardEvent, ReactElement, ReactNode } from 'react'
import type {
  TerminalMode,
  TerminalSessionSummary,
  TerminalSplitDirection,
} from '../../../shared/terminal-api'
import { useI18n } from '../locale'

export interface TerminalPaneBarProps {
  paneId?: string
  session: TerminalSessionSummary | null
  mode: TerminalMode
  cwdCopied: boolean
  isZoomed?: boolean
  canSplitH?: boolean
  canSplitV?: boolean
  canClosePane?: boolean
  draggable?: boolean
  onPickCwd: () => void
  onCopyCwd: () => void
  onRenameTitle?: (nextTitle: string) => void
  onSplitPane?: (direction: TerminalSplitDirection) => void
  onToggleZoom?: () => void
  onClosePane?: () => void
  onPaneDragStart?: (e: DragEvent<HTMLElement>) => void
  onPaneDragEnd?: () => void
  extraActions?: ReactNode
}

/**
 * Shared top toolbar rendered inside each terminal pane (PTY or Block).
 * Hosts inline title editing, pane drag handle, CWD picker, mode-specific buttons,
 * directional split controls, zoom toggle, and close button.
 */
export function TerminalPaneBar({
  session,
  mode,
  cwdCopied,
  isZoomed = false,
  canSplitH = true,
  canSplitV = true,
  canClosePane = false,
  draggable = false,
  onPickCwd,
  onCopyCwd,
  onRenameTitle,
  onSplitPane,
  onToggleZoom,
  onClosePane,
  onPaneDragStart,
  onPaneDragEnd,
  extraActions,
}: TerminalPaneBarProps): ReactElement {
  const { t } = useI18n()
  const [editingTitle, setEditingTitle] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)

  const displayTitle = session?.oscTitle?.trim() || session?.title || session?.shell || 'Terminal'

  useEffect(() => {
    if (editingTitle) {
      titleInputRef.current?.focus()
      titleInputRef.current?.select()
    }
  }, [editingTitle])

  const commitTitle = (): void => {
    setEditingTitle(false)
    const trimmed = draftTitle.trim()
    if (trimmed && trimmed !== session?.title) {
      onRenameTitle?.(trimmed)
    }
  }

  const handleTitleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      commitTitle()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setEditingTitle(false)
    }
  }

  return (
    <div className="term-pane-bar">
      <div className="term-pane-bar-left">
        {editingTitle ? (
          <input
            ref={titleInputRef}
            type="text"
            className="term-pane-title-input"
            data-testid="terminal-pane-title-input"
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={handleTitleKeyDown}
            onPointerDown={(e) => e.stopPropagation()}
          />
        ) : (
          <div
            className={`term-pane-title-chip${draggable ? ' is-draggable' : ''}`}
            data-testid="terminal-pane-title-chip"
            draggable={draggable}
            title={
              session?.oscTitle
                ? `${session.title} — ${session.oscTitle}\n${t('termRenameHint')}`
                : t('termRenameHint')
            }
            onDragStart={(e) => onPaneDragStart?.(e)}
            onDragEnd={() => onPaneDragEnd?.()}
            onDoubleClick={(e) => {
              if (!onRenameTitle) return
              e.stopPropagation()
              setDraftTitle(session?.title ?? displayTitle)
              setEditingTitle(true)
            }}
          >
            {draggable && (
              <svg
                width="10"
                height="12"
                viewBox="0 0 10 12"
                fill="none"
                aria-hidden="true"
                className="term-pane-drag-grip"
              >
                <circle cx="3" cy="2.5" r="0.9" fill="currentColor" />
                <circle cx="7" cy="2.5" r="0.9" fill="currentColor" />
                <circle cx="3" cy="6" r="0.9" fill="currentColor" />
                <circle cx="7" cy="6" r="0.9" fill="currentColor" />
                <circle cx="3" cy="9.5" r="0.9" fill="currentColor" />
                <circle cx="7" cy="9.5" r="0.9" fill="currentColor" />
              </svg>
            )}
            <span className="term-pane-title-text">{displayTitle}</span>
          </div>
        )}

        <span
          className={`term-mode-badge ${mode === 'pty' ? 'is-pty' : 'is-block'}`}
          data-testid="terminal-pane-mode-badge"
        >
          {mode === 'pty' ? t('termModePty') : t('termModeBlock')}
        </span>

        <span className="term-shell-badge" title={t('termShellLabel')}>
          {session?.shell ?? 'shell'}
        </span>

        <div className="term-cwd-group">
          <button
            type="button"
            className="term-cwd-btn"
            data-testid="terminal-cwd"
            title={`${session?.cwd ?? ''} — ${t('termChangeCwd')}`}
            onClick={onPickCwd}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M2 4.2A1.4 1.4 0 0 1 3.4 2.8h2.9l1.2 1.4h5.1A1.4 1.4 0 0 1 14 5.6v6.2a1.4 1.4 0 0 1-1.4 1.4H3.4A1.4 1.4 0 0 1 2 11.8V4.2Z"
                stroke="currentColor"
                strokeWidth="1.25"
                strokeLinejoin="round"
              />
            </svg>
            <span className="term-cwd-text">{session?.cwd ?? '...'}</span>
          </button>
          <button
            type="button"
            className={`term-cwd-copy-btn${cwdCopied ? ' is-copied' : ''}`}
            title={cwdCopied ? t('termCopied') : t('termCopyCwd')}
            aria-label={cwdCopied ? t('termCopied') : t('termCopyCwd')}
            onClick={onCopyCwd}
          >
            {cwdCopied ? (
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M3 8.5l3.2 3.2L13 4.8"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect
                  x="5.5"
                  y="5.5"
                  width="7.5"
                  height="8"
                  rx="1.2"
                  stroke="currentColor"
                  strokeWidth="1.25"
                />
                <path
                  d="M10.5 5.5V4A1.2 1.2 0 0 0 9.3 2.8H4A1.2 1.2 0 0 0 2.8 4v5.3A1.2 1.2 0 0 0 4 10.5h1.5"
                  stroke="currentColor"
                  strokeWidth="1.25"
                />
              </svg>
            )}
          </button>
        </div>
      </div>

      <div className="term-pane-bar-right">
        {extraActions}

        {onSplitPane && (
          <div className="term-pane-split-actions">
            <button
              type="button"
              className="term-pane-icon-btn"
              data-testid="terminal-pane-split-right-btn"
              disabled={!canSplitH}
              title={canSplitH ? t('termSplitRight') : t('termSplitMinSizeTip')}
              aria-label={t('termSplitRight')}
              onClick={(e) => {
                e.stopPropagation()
                onSplitPane('horizontal')
              }}
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
            </button>
            <button
              type="button"
              className="term-pane-icon-btn"
              data-testid="terminal-pane-split-down-btn"
              disabled={!canSplitV}
              title={canSplitV ? t('termSplitDown') : t('termSplitMinSizeTip')}
              aria-label={t('termSplitDown')}
              onClick={(e) => {
                e.stopPropagation()
                onSplitPane('vertical')
              }}
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
          </div>
        )}

        {onToggleZoom && (
          <button
            type="button"
            className={`term-pane-icon-btn${isZoomed ? ' is-active' : ''}`}
            data-testid="terminal-pane-zoom-btn"
            aria-pressed={isZoomed}
            title={isZoomed ? t('termRestorePane') : t('termZoomPane')}
            aria-label={isZoomed ? t('termRestorePane') : t('termZoomPane')}
            onClick={(e) => {
              e.stopPropagation()
              onToggleZoom()
            }}
          >
            {isZoomed ? (
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M6 2.5v3.5H2.5M10 13.5V10h3.5M10 2.5v3.5h3.5M6 13.5V10H2.5"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M2.5 6V2.5H6M13.5 10v3.5H10M10 2.5h3.5V6M6 13.5H2.5V10"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </button>
        )}

        {canClosePane && onClosePane && (
          <button
            type="button"
            className="term-pane-icon-btn is-danger"
            data-testid="terminal-pane-close-btn"
            title={t('termClosePane')}
            aria-label={t('termClosePane')}
            onClick={(e) => {
              e.stopPropagation()
              onClosePane()
            }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}
