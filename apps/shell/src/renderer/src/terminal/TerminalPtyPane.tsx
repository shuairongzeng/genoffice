import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type {
  TerminalEvent,
  TerminalSessionSnapshot,
  TerminalShellKind,
} from '../../../shared/terminal-api'
import { useI18n } from '../locale'
import { copyTextToClipboard, readTextFromClipboard } from './terminal-clipboard'
import { extractRichCandidateFromPty, readXtermThemeFromElement } from './terminal-pty-theme'
import { TerminalRichOutput, useDarkTheme, type TerminalRichViewMode } from './TerminalRichOutput'

export interface TerminalPtyPaneProps {
  sessionId: string
  initialSession?: TerminalSessionSnapshot | null
  compact?: boolean
  focused?: boolean
  onFocusPane?: () => void
  onSwitchShell?: (shell: TerminalShellKind, cwd?: string) => void
}

const COPIED_RESET_MS = 1800
const RESIZE_DEBOUNCE_MS = 60
const PREVIEW_EXTRACT_LINES = 160
const AI_EXTRACT_LINES = 80
const SAFE_EXTERNAL_URL_RE = /^https?:\/\//i

function extractRecentBufferLines(term: Terminal, maxLines: number): string {
  const buffer = term.buffer.active
  if (!buffer) return ''
  const end = buffer.length
  const start = Math.max(0, end - maxLines)
  const lines: string[] = []
  for (let i = start; i < end; i += 1) {
    const line = buffer.getLine(i)
    if (line) {
      lines.push(line.translateToString(true))
    }
  }
  while (lines.length > 0 && !lines[0]!.trim()) lines.shift()
  while (lines.length > 0 && !lines[lines.length - 1]!.trim()) lines.pop()
  return lines.join('\n')
}

function isPsPolicyText(text: string): boolean {
  return (
    text.includes('PSSecurityException') ||
    text.includes('UnauthorizedAccess') ||
    text.includes('running scripts is disabled')
  )
}

/**
 * True interactive PTY terminal pane powered by `@xterm/xterm` and node-pty ConPTY/PTY.
 * Preserves running TUI state across drawer/tab handoffs via main-process replay buffer.
 */
export function TerminalPtyPane({
  sessionId,
  initialSession = null,
  compact = false,
  focused = false,
  onFocusPane,
  onSwitchShell,
}: TerminalPtyPaneProps): ReactElement {
  const { t } = useI18n()
  const dark = useDarkTheme()

  const [session, setSession] = useState<TerminalSessionSnapshot | null>(initialSession)
  const [cwdCopied, setCwdCopied] = useState(false)
  const [richPreviewOpen, setRichPreviewOpen] = useState(false)
  const [richPreviewSource, setRichPreviewSource] = useState('')
  const [richViewMode, setRichViewMode] = useState<TerminalRichViewMode>('rendered')
  const [psPolicyHint, setPsPolicyHint] = useState(false)

  const paneRef = useRef<HTMLElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const cwdCopyTimerRef = useRef<number | null>(null)
  const lastSizeRef = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 })
  const focusedRef = useRef(focused)
  focusedRef.current = focused

  useEffect(() => {
    if (initialSession && initialSession.id === sessionId) {
      setSession((prev) =>
        prev?.id === sessionId ? { ...prev, ...initialSession } : initialSession,
      )
    }
  }, [initialSession, sessionId])

  useEffect(() => {
    return () => {
      if (cwdCopyTimerRef.current !== null) {
        window.clearTimeout(cwdCopyTimerRef.current)
      }
    }
  }, [])

  // Initialize xterm instance, subscribe before snapshot replay, and keep theme & size synced.
  useEffect(() => {
    const hostEl = hostRef.current
    if (!hostEl) return

    let alive = true
    let replayReady = false
    const pendingDataEvents: Array<{ chunk: string; seq: number }> = []
    let resizeTimer: number | null = null
    setPsPolicyHint(false)

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      scrollback: 5000,
      fontSize: compact ? 12.5 : 13,
      lineHeight: 1.35,
      fontFamily:
        'ui-monospace, "Cascadia Code", "JetBrains Mono", SFMono-Regular, Menlo, Consolas, monospace',
      theme: readXtermThemeFromElement(paneRef.current ?? hostEl),
    })
    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon((_event, uri) => {
      if (SAFE_EXTERNAL_URL_RE.test(uri)) {
        window.open(uri, '_blank', 'noopener,noreferrer')
      }
    })

    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)
    term.open(hostEl)
    termRef.current = term
    fitRef.current = fitAddon
    lastSizeRef.current = { cols: 0, rows: 0 }

    const fitIfVisible = (syncBackend: boolean): void => {
      if (!alive || hostEl.clientWidth <= 0 || hostEl.clientHeight <= 0) return
      try {
        fitAddon.fit()
      } catch {
        return
      }
      const cols = Math.max(2, term.cols)
      const rows = Math.max(1, term.rows)
      if (syncBackend && (lastSizeRef.current.cols !== cols || lastSizeRef.current.rows !== rows)) {
        lastSizeRef.current = { cols, rows }
        void window.aiOffice?.terminalPtyResize?.(sessionId, cols, rows)
      }
    }

    fitIfVisible(false)

    term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
      // Let workbench handle Ctrl+` / Cmd+` for toggling the bottom drawer.
      if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey && ev.code === 'Backquote') {
        return false
      }

      if (ev.type === 'keydown') {
        // Smart Ctrl+C: copy when selection exists; otherwise send SIGINT (\x03) to PTY.
        if (
          ev.ctrlKey &&
          !ev.shiftKey &&
          !ev.altKey &&
          !ev.metaKey &&
          ev.key.toLowerCase() === 'c'
        ) {
          if (term.hasSelection()) {
            const selected = term.getSelection()
            void copyTextToClipboard(selected)
            term.clearSelection()
            ev.preventDefault()
            return false
          }
          return true
        }

        if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.key.toLowerCase() === 'v') {
          ev.preventDefault()
          void readTextFromClipboard().then((text) => {
            if (text && alive) {
              term.paste(text)
            }
          })
          return false
        }
      }

      return true
    })

    const dataSub = term.onData((data) => {
      void window.aiOffice?.terminalPtyWrite?.(sessionId, data)
    })

    const handleEvent = (event: TerminalEvent): void => {
      if (!alive) return

      if (event.type === 'session-updated') {
        if (event.session.id === sessionId) {
          setSession((prev) =>
            prev ? { ...prev, ...event.session } : { ...event.session, blocks: [] },
          )
        }
        return
      }

      if (!('sessionId' in event) || event.sessionId !== sessionId) return

      if (event.type === 'session-cleared') {
        term.clear()
        setPsPolicyHint(false)
        return
      }

      if (event.type === 'pty-exit') {
        setSession((prev) => (prev ? { ...prev, running: false, exitCode: event.exitCode } : prev))
        return
      }

      if (event.type === 'pty-data') {
        if (isPsPolicyText(event.chunk)) {
          setPsPolicyHint(true)
        }
        if (!replayReady) {
          pendingDataEvents.push({ chunk: event.chunk, seq: event.seq })
        } else {
          term.write(event.chunk)
        }
      }
    }

    const unsubscribe = window.aiOffice?.onTerminalEvent?.(handleEvent)

    void window.aiOffice
      ?.terminalGetSession?.(sessionId)
      .then((snap) => {
        if (!alive) return
        if (snap) {
          setSession(snap)
          const replayedSeq = snap.ptySeq ?? 0
          if (snap.ptyBuffer) {
            term.write(snap.ptyBuffer)
            if (snap.shell === 'powershell' && isPsPolicyText(snap.ptyBuffer)) {
              setPsPolicyHint(true)
            }
          }
          for (const pending of pendingDataEvents) {
            if (pending.seq > replayedSeq) {
              term.write(pending.chunk)
            }
          }
        }
        replayReady = true
        fitIfVisible(true)
        if (focusedRef.current) {
          term.focus()
        }
      })
      .catch(() => {
        replayReady = true
      })

    const resizeObserver = new ResizeObserver(() => {
      if (!alive || hostEl.clientWidth <= 0 || hostEl.clientHeight <= 0) return
      if (resizeTimer !== null) {
        window.clearTimeout(resizeTimer)
      }
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null
        fitIfVisible(true)
      }, RESIZE_DEBOUNCE_MS)
    })
    resizeObserver.observe(hostEl)

    return () => {
      alive = false
      if (resizeTimer !== null) {
        window.clearTimeout(resizeTimer)
      }
      resizeObserver.disconnect()
      unsubscribe?.()
      dataSub.dispose()
      term.dispose()
      if (termRef.current === term) termRef.current = null
      if (fitRef.current === fitAddon) fitRef.current = null
    }
  }, [compact, sessionId])

  // Sync xterm color palette on the next frame after data-theme style recalculation settles.
  useEffect(() => {
    const rafId = window.requestAnimationFrame(() => {
      const term = termRef.current
      if (!term) return
      const nextTheme = readXtermThemeFromElement(paneRef.current ?? hostRef.current)
      term.options.theme = nextTheme
    })
    return () => window.cancelAnimationFrame(rafId)
  }, [dark])

  // Re-fit when toggling the side rich preview drawer changes available width.
  useEffect(() => {
    const hostEl = hostRef.current
    const term = termRef.current
    const fit = fitRef.current
    if (!hostEl || !term || !fit || hostEl.clientWidth <= 0 || hostEl.clientHeight <= 0) return
    const timer = window.setTimeout(() => {
      try {
        fit.fit()
        const cols = Math.max(2, term.cols)
        const rows = Math.max(1, term.rows)
        if (lastSizeRef.current.cols !== cols || lastSizeRef.current.rows !== rows) {
          lastSizeRef.current = { cols, rows }
          void window.aiOffice?.terminalPtyResize?.(sessionId, cols, rows)
        }
      } catch {
        // Ignore transient layout race during unmount.
      }
    }, RESIZE_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [richPreviewOpen, sessionId])

  useEffect(() => {
    if (focused) {
      termRef.current?.focus()
    }
  }, [focused])

  const handlePickCwd = useCallback(() => {
    void window.aiOffice?.terminalPickCwd?.(sessionId).then((nextCwd) => {
      if (!nextCwd) return
      setSession((prev) => (prev ? { ...prev, cwd: nextCwd } : prev))
    })
  }, [sessionId])

  const handleCopyCwd = useCallback(() => {
    const cwd = session?.cwd
    if (!cwd) return
    void copyTextToClipboard(cwd).then((ok) => {
      if (!ok) return
      setCwdCopied(true)
      if (cwdCopyTimerRef.current !== null) {
        window.clearTimeout(cwdCopyTimerRef.current)
      }
      cwdCopyTimerRef.current = window.setTimeout(() => {
        cwdCopyTimerRef.current = null
        setCwdCopied(false)
      }, COPIED_RESET_MS)
    })
  }, [session?.cwd])

  const handleClear = useCallback(() => {
    termRef.current?.clear()
    setPsPolicyHint(false)
    void window.aiOffice?.terminalClearSession?.(sessionId)
  }, [sessionId])

  const handleRestart = useCallback(() => {
    setPsPolicyHint(false)
    void window.aiOffice?.terminalPtyRestart?.(sessionId)
    termRef.current?.focus()
  }, [sessionId])

  const captureCurrentText = useCallback((maxLines: number): string => {
    const term = termRef.current
    if (!term) return ''
    if (term.hasSelection()) {
      const selected = term.getSelection()
      if (selected.trim()) return selected
    }
    return extractRecentBufferLines(term, maxLines)
  }, [])

  const handleOpenRichPreview = useCallback(() => {
    const text = captureCurrentText(PREVIEW_EXTRACT_LINES)
    setRichPreviewSource(text)
    setRichPreviewOpen(true)
  }, [captureCurrentText])

  const handleAskAi = useCallback(() => {
    const output = captureCurrentText(AI_EXTRACT_LINES)
    void window.aiOffice?.terminalAskAi?.({
      command: `${session?.shell ?? 'terminal'} (${session?.title ?? 'PTY'})`,
      cwd: session?.cwd ?? '',
      exitCode: session?.exitCode ?? 0,
      output,
    })
  }, [captureCurrentText, session?.cwd, session?.exitCode, session?.shell, session?.title])

  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const term = termRef.current
    if (!term) return
    e.preventDefault()
    if (term.hasSelection()) {
      void copyTextToClipboard(term.getSelection())
      term.clearSelection()
    } else {
      void readTextFromClipboard().then((text) => {
        if (text) term.paste(text)
      })
    }
  }, [])

  const richCandidate = useMemo(
    () => extractRichCandidateFromPty(richPreviewSource),
    [richPreviewSource],
  )
  const isRich = richCandidate.detection.kind !== 'plain'
  const effectivePreviewMode: TerminalRichViewMode = isRich ? richViewMode : 'raw'

  return (
    <section
      ref={paneRef}
      className={`term-pane term-pane-pty${compact ? ' is-compact' : ''}${focused ? ' is-focused' : ''}`}
      data-testid="terminal-pty-pane"
      onPointerDown={() => {
        onFocusPane?.()
      }}
    >
      <div className="term-pane-bar">
        <div className="term-pane-bar-left">
          <span className="term-mode-badge is-pty" data-testid="terminal-pane-mode-badge">
            {t('termModePty')}
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
              onClick={handlePickCwd}
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
              onClick={handleCopyCwd}
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
          {!session?.running && session?.exitCode !== null && session?.exitCode !== undefined && (
            <button
              type="button"
              className="term-mini-btn term-restart-btn"
              data-testid="terminal-pty-restart-btn"
              onClick={handleRestart}
            >
              {t('termRestartSession')}
            </button>
          )}

          <button
            type="button"
            className={`term-mini-btn${richPreviewOpen ? ' is-active' : ''}`}
            data-testid="terminal-pty-rich-btn"
            onClick={handleOpenRichPreview}
          >
            {t('termRichPreview')}
          </button>

          <button
            type="button"
            className="term-mini-btn"
            data-testid="terminal-pty-ask-ai-btn"
            onClick={handleAskAi}
          >
            {t('termPtyAskAi')}
          </button>

          <button type="button" className="term-mini-btn" onClick={handleClear}>
            {t('termClear')}
          </button>
        </div>
      </div>

      {psPolicyHint && (
        <div className="term-fallback-banner" data-testid="terminal-ps-policy-banner" role="note">
          <span>{t('termPsPolicyTip')}</span>
          {onSwitchShell && (
            <button
              type="button"
              className="term-mini-btn"
              data-testid="terminal-switch-cmd-btn"
              onClick={() => onSwitchShell('cmd', session?.cwd)}
            >
              {t('termSwitchToCmd')}
            </button>
          )}
        </div>
      )}

      {!session?.running && session?.exitCode !== null && session?.exitCode !== undefined && (
        <div className="term-pty-exit-bar" data-testid="terminal-pty-exit-bar">
          <span>{t('termPtyExited', { code: session.exitCode })}</span>
          <button type="button" className="term-mini-btn" onClick={handleRestart}>
            {t('termRestartSession')}
          </button>
        </div>
      )}

      <div className="term-pty-main">
        <div className="term-pty-stage">
          <div
            className="term-pty-host"
            data-testid="terminal-pty-host"
            ref={hostRef}
            onContextMenu={handleContextMenu}
            onMouseUp={() => termRef.current?.focus()}
          />
        </div>

        {richPreviewOpen && (
          <aside className="term-pty-rich-drawer" data-testid="terminal-pty-rich-drawer">
            <header className="term-pty-rich-header">
              <span className="term-pty-rich-title">{t('termRichPreview')}</span>
              <div className="term-pty-rich-actions">
                {isRich && (
                  <div className="term-view-switcher" role="group">
                    {(
                      [
                        ['rendered', 'termViewRendered'],
                        ['raw', 'termViewRaw'],
                        ['split', 'termViewSplit'],
                      ] as const
                    ).map(([mode, labelKey]) => (
                      <button
                        key={mode}
                        type="button"
                        className={`term-view-tab${effectivePreviewMode === mode ? ' is-active' : ''}`}
                        aria-pressed={effectivePreviewMode === mode}
                        onClick={() => setRichViewMode(mode)}
                      >
                        {t(labelKey)}
                      </button>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  className="term-mini-btn"
                  data-testid="terminal-pty-rich-close-btn"
                  onClick={() => setRichPreviewOpen(false)}
                >
                  {t('termClosePreview')}
                </button>
              </div>
            </header>
            <div className="term-pty-rich-body g-scroll">
              {richPreviewSource.trim() ? (
                <TerminalRichOutput
                  stdout={richCandidate.source}
                  stderr=""
                  detection={richCandidate.detection}
                  viewMode={effectivePreviewMode}
                  dark={dark}
                />
              ) : (
                <p className="term-empty-hint">{t('termRichPreviewEmpty')}</p>
              )}
            </div>
          </aside>
        )}
      </div>
    </section>
  )
}
