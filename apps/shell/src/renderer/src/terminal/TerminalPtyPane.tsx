import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent, KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'
import type {
  TerminalEvent,
  TerminalSessionSnapshot,
  TerminalShellKind,
  TerminalSplitDirection,
} from '../../../shared/terminal-api'
import { useI18n } from '../locale'
import { copyTextToClipboard, readTextFromClipboard } from './terminal-clipboard'
import {
  extractRichCandidateFromPty,
  readSearchDecorationsFromElement,
  readXtermThemeFromElement,
} from './terminal-pty-theme'
import { useTerminalSurfaceTheme } from './terminal-surface-theme'
import { isTerminalResponseSequence } from './terminal-workspace-utils'
import { TerminalPaneBar } from './TerminalPaneBar'
import { TerminalRichOutput, useDarkTheme, type TerminalRichViewMode } from './TerminalRichOutput'

export interface TerminalPtyPaneProps {
  paneId?: string
  sessionId: string
  initialSession?: TerminalSessionSnapshot | null
  compact?: boolean
  focused?: boolean
  broadcastEnabled?: boolean
  isZoomed?: boolean
  canSplitH?: boolean
  canSplitV?: boolean
  canClosePane?: boolean
  draggable?: boolean
  onFocusPane?: () => void
  onSwitchShell?: (shell: TerminalShellKind, cwd?: string) => void
  onBroadcastWrite?: (data: string) => void
  onOscTitleChange?: (oscTitle: string) => void
  onRenameTitle?: (nextTitle: string) => void
  onSplitPane?: (direction: TerminalSplitDirection) => void
  onToggleZoom?: () => void
  onClosePane?: () => void
  onPaneDragStart?: (e: DragEvent<HTMLElement>) => void
  onPaneDragEnd?: () => void
}

const COPIED_RESET_MS = 1800
const RESIZE_DEBOUNCE_MS = 90
const PREVIEW_EXTRACT_LINES = 160
const AI_EXTRACT_LINES = 80
const SAFE_EXTERNAL_URL_RE = /^https?:\/\//i
const MIN_XTERM_CONTRAST_RATIO = 4.5

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
  paneId,
  sessionId,
  initialSession = null,
  compact = false,
  focused = false,
  broadcastEnabled = false,
  isZoomed = false,
  canSplitH = true,
  canSplitV = true,
  canClosePane = false,
  draggable = false,
  onFocusPane,
  onSwitchShell,
  onBroadcastWrite,
  onOscTitleChange,
  onRenameTitle,
  onSplitPane,
  onToggleZoom,
  onClosePane,
  onPaneDragStart,
  onPaneDragEnd,
}: TerminalPtyPaneProps): ReactElement {
  const { t } = useI18n()
  const dark = useDarkTheme()
  const { effectiveSurface } = useTerminalSurfaceTheme()

  const [session, setSession] = useState<TerminalSessionSnapshot | null>(initialSession)
  const [cwdCopied, setCwdCopied] = useState(false)
  const [richPreviewOpen, setRichPreviewOpen] = useState(false)
  const [richPreviewSource, setRichPreviewSource] = useState('')
  const [richViewMode, setRichViewMode] = useState<TerminalRichViewMode>('rendered')
  const [psPolicyHint, setPsPolicyHint] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false)
  const [searchRegex, setSearchRegex] = useState(false)
  const [searchResult, setSearchResult] = useState<{
    resultIndex: number
    resultCount: number
  } | null>(null)

  const paneRef = useRef<HTMLElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const cwdCopyTimerRef = useRef<number | null>(null)
  const lastSizeRef = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 })
  const focusedRef = useRef(focused)
  focusedRef.current = focused
  const broadcastEnabledRef = useRef(broadcastEnabled)
  broadcastEnabledRef.current = broadcastEnabled
  const onBroadcastWriteRef = useRef(onBroadcastWrite)
  onBroadcastWriteRef.current = onBroadcastWrite
  const onOscTitleChangeRef = useRef(onOscTitleChange)
  onOscTitleChangeRef.current = onOscTitleChange
  const onFocusPaneRef = useRef(onFocusPane)
  onFocusPaneRef.current = onFocusPane

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
    let replaying = true
    let replayReady = false
    const pendingDataEvents: Array<{ chunk: string; seq: number }> = []
    let resizeTimer: number | null = null
    let titleTimer: number | null = null
    let lastEmittedOscTitle = ''
    setPsPolicyHint(false)

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      scrollback: 5000,
      minimumContrastRatio: MIN_XTERM_CONTRAST_RATIO,
      fontSize: compact ? 12.5 : 13,
      lineHeight: 1.35,
      fontFamily:
        'ui-monospace, "Cascadia Code", "JetBrains Mono", SFMono-Regular, Menlo, Consolas, monospace',
      theme: readXtermThemeFromElement(hostEl),
    })
    const fitAddon = new FitAddon()
    const searchAddon = new SearchAddon()
    const webLinksAddon = new WebLinksAddon((_event, uri) => {
      if (SAFE_EXTERNAL_URL_RE.test(uri)) {
        window.open(uri, '_blank', 'noopener,noreferrer')
      }
    })

    term.loadAddon(fitAddon)
    term.loadAddon(searchAddon)
    term.loadAddon(webLinksAddon)
    term.open(hostEl)
    termRef.current = term
    fitRef.current = fitAddon
    searchRef.current = searchAddon
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
      // Never intercept active IME composition keystrokes.
      if (ev.isComposing || ev.keyCode === 229) {
        return true
      }

      // Let workbench handle Ctrl+` / Cmd+` for toggling the bottom drawer.
      if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey && ev.code === 'Backquote') {
        return false
      }

      // Let workspace split tree handle split / zoom / snippets shortcuts and Alt+Arrow pane nav.
      const lower = ev.key.toLowerCase()
      if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && !ev.altKey) {
        if (lower === 'd' || lower === 'e' || lower === 'z' || lower === 'k') {
          return false
        }
        if (ev.type === 'keydown' && lower === 'f') {
          ev.preventDefault()
          setSearchOpen(true)
          window.requestAnimationFrame(() => searchInputRef.current?.focus())
          return false
        }
      }
      if (
        ev.altKey &&
        !ev.ctrlKey &&
        !ev.metaKey &&
        !ev.shiftKey &&
        (ev.key === 'ArrowUp' ||
          ev.key === 'ArrowDown' ||
          ev.key === 'ArrowLeft' ||
          ev.key === 'ArrowRight')
      ) {
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
      // Drop stale automatic query responses emitted while replaying historical ptyBuffer.
      if (replaying) return

      const hasDomFocus =
        typeof document !== 'undefined' &&
        term.textarea !== undefined &&
        document.activeElement === term.textarea
      if (
        broadcastEnabledRef.current &&
        onBroadcastWriteRef.current &&
        focusedRef.current &&
        hasDomFocus &&
        !isTerminalResponseSequence(data)
      ) {
        onBroadcastWriteRef.current(data)
        return
      }
      void window.aiOffice?.terminalPtyWrite?.(sessionId, data)
    })

    const searchResultSub = searchAddon.onDidChangeResults((res) => {
      if (!alive) return
      setSearchResult(res)
    })

    const titleSub = term.onTitleChange((rawTitle) => {
      if (!alive) return
      const cleaned = rawTitle
        .replace(/[\x00-\x1f\x7f]/g, '')
        .trim()
        .slice(0, 120)
      if (cleaned === lastEmittedOscTitle) return
      if (titleTimer !== null) {
        window.clearTimeout(titleTimer)
      }
      titleTimer = window.setTimeout(() => {
        titleTimer = null
        if (!alive) return
        lastEmittedOscTitle = cleaned
        onOscTitleChangeRef.current?.(cleaned)
      }, 150)
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

    const finishReplay = (replayedSeq: number): void => {
      if (!alive) return
      replaying = false
      replayReady = true
      for (const pending of pendingDataEvents) {
        if (pending.seq > replayedSeq) {
          term.write(pending.chunk)
        }
      }
      pendingDataEvents.length = 0
      fitIfVisible(true)
      if (focusedRef.current) {
        term.focus()
      }
    }

    void window.aiOffice
      ?.terminalGetSession?.(sessionId)
      .then((snap) => {
        if (!alive) return
        if (snap) {
          setSession(snap)
          const replayedSeq = snap.ptySeq ?? 0
          if (snap.ptyBuffer) {
            if (snap.shell === 'powershell' && isPsPolicyText(snap.ptyBuffer)) {
              setPsPolicyHint(true)
            }
            term.write(snap.ptyBuffer, () => {
              finishReplay(replayedSeq)
            })
            return
          }
          finishReplay(replayedSeq)
          return
        }
        finishReplay(0)
      })
      .catch(() => {
        replaying = false
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
      if (titleTimer !== null) {
        window.clearTimeout(titleTimer)
      }
      resizeObserver.disconnect()
      unsubscribe?.()
      dataSub.dispose()
      searchResultSub.dispose()
      titleSub.dispose()
      term.dispose()
      if (termRef.current === term) termRef.current = null
      if (fitRef.current === fitAddon) fitRef.current = null
      if (searchRef.current === searchAddon) searchRef.current = null
    }
  }, [compact, sessionId])

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
      onFocusPaneRef.current?.()
      term.focus()
      void readTextFromClipboard().then((text) => {
        if (text) term.paste(text)
      })
    }
  }, [])

  const runSearch = useCallback(
    (direction: 'next' | 'prev', incremental: boolean) => {
      const addon = searchRef.current
      if (!addon) return
      if (!searchQuery) {
        addon.clearDecorations()
        setSearchResult(null)
        return
      }
      const decorations = readSearchDecorationsFromElement(hostRef.current ?? paneRef.current)
      const opts: ISearchOptions = {
        caseSensitive: searchCaseSensitive,
        regex: searchRegex,
        incremental,
        ...(decorations ? { decorations } : {}),
      }
      if (direction === 'prev') {
        addon.findPrevious(searchQuery, opts)
      } else {
        addon.findNext(searchQuery, opts)
      }
    },
    [searchCaseSensitive, searchQuery, searchRegex],
  )

  const searchStateRef = useRef({ searchOpen, searchQuery, runSearch })
  searchStateRef.current = { searchOpen, searchQuery, runSearch }

  // Sync xterm color palette and minimum contrast ratio after canvas/host theme updates settle.
  useEffect(() => {
    const rafId = window.requestAnimationFrame(() => {
      const term = termRef.current
      if (!term) return
      const nextTheme = readXtermThemeFromElement(hostRef.current ?? paneRef.current)
      term.options.theme = nextTheme
      term.options.minimumContrastRatio = MIN_XTERM_CONTRAST_RATIO
      if (term.rows > 0) {
        term.refresh(0, term.rows - 1)
      }
      if (searchStateRef.current.searchOpen && searchStateRef.current.searchQuery) {
        searchStateRef.current.runSearch('next', true)
      }
    })
    return () => window.cancelAnimationFrame(rafId)
  }, [effectiveSurface, dark])

  useEffect(() => {
    if (!searchOpen) return
    runSearch('next', true)
  }, [runSearch, searchOpen])

  const handleCloseSearch = useCallback(() => {
    setSearchOpen(false)
    searchRef.current?.clearDecorations()
    setSearchResult(null)
    termRef.current?.focus()
  }, [])

  const handleToggleSearch = useCallback(() => {
    if (searchOpen) {
      handleCloseSearch()
    } else {
      setSearchOpen(true)
      window.requestAnimationFrame(() => searchInputRef.current?.focus())
    }
  }, [handleCloseSearch, searchOpen])

  const handleSearchInputKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        handleCloseSearch()
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        runSearch(e.shiftKey ? 'prev' : 'next', false)
      }
    },
    [handleCloseSearch, runSearch],
  )

  const richCandidate = useMemo(
    () => extractRichCandidateFromPty(richPreviewSource),
    [richPreviewSource],
  )
  const isRich = richCandidate.detection.kind !== 'plain'
  const effectivePreviewMode: TerminalRichViewMode = isRich ? richViewMode : 'raw'

  const searchCountLabel = useMemo(() => {
    if (!searchQuery) return ''
    if (!searchResult || searchResult.resultCount === 0) return '0/0'
    const current = searchResult.resultIndex >= 0 ? searchResult.resultIndex + 1 : 0
    return `${current}/${searchResult.resultCount}`
  }, [searchQuery, searchResult])

  return (
    <section
      ref={paneRef}
      className={`term-pane term-pane-pty${compact ? ' is-compact' : ''}${focused ? ' is-focused' : ''}`}
      data-testid="terminal-pty-pane"
      data-pane-id={paneId}
      data-session-id={sessionId}
      onPointerDown={() => {
        onFocusPane?.()
      }}
    >
      <TerminalPaneBar
        paneId={paneId}
        session={session}
        mode="pty"
        cwdCopied={cwdCopied}
        isZoomed={isZoomed}
        canSplitH={canSplitH}
        canSplitV={canSplitV}
        canClosePane={canClosePane}
        draggable={draggable}
        onPickCwd={handlePickCwd}
        onCopyCwd={handleCopyCwd}
        onRenameTitle={onRenameTitle}
        onSplitPane={onSplitPane}
        onToggleZoom={onToggleZoom}
        onClosePane={onClosePane}
        onPaneDragStart={onPaneDragStart}
        onPaneDragEnd={onPaneDragEnd}
        extraActions={
          <>
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
              className={`term-mini-btn${searchOpen ? ' is-active' : ''}`}
              data-testid="terminal-pty-search-btn"
              title={`${t('termSearchBtn')} (Ctrl+Shift+F)`}
              onClick={handleToggleSearch}
            >
              {t('termSearchBtn')}
            </button>

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
          </>
        }
      />

      {broadcastEnabled && (
        <div
          className="term-broadcast-banner"
          data-testid="terminal-broadcast-banner"
          role="status"
        >
          <span className="term-broadcast-dot" aria-hidden="true" />
          <span>{t('termBroadcastOnTip')}</span>
        </div>
      )}

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
        <div className="term-pty-stage" data-term-canvas={effectiveSurface}>
          {searchOpen && (
            <div
              className="term-pty-search-bar"
              data-testid="terminal-pty-search-bar"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <input
                ref={searchInputRef}
                type="search"
                className="term-pty-search-input"
                data-testid="terminal-pty-search-input"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleSearchInputKeyDown}
                placeholder={t('termSearchPlaceholder')}
                aria-label={t('termSearchPlaceholder')}
              />
              {searchCountLabel && (
                <span className="term-pty-search-count" data-testid="terminal-pty-search-count">
                  {searchCountLabel}
                </span>
              )}
              <button
                type="button"
                className={`term-pty-search-flag${searchCaseSensitive ? ' is-active' : ''}`}
                data-testid="terminal-pty-search-case"
                aria-pressed={searchCaseSensitive}
                title={t('termSearchCase')}
                onClick={() => setSearchCaseSensitive((v) => !v)}
              >
                Aa
              </button>
              <button
                type="button"
                className={`term-pty-search-flag${searchRegex ? ' is-active' : ''}`}
                data-testid="terminal-pty-search-regex"
                aria-pressed={searchRegex}
                title={t('termSearchRegex')}
                onClick={() => setSearchRegex((v) => !v)}
              >
                .*
              </button>
              <button
                type="button"
                className="term-pty-search-nav"
                data-testid="terminal-pty-search-prev"
                title={t('termSearchPrev')}
                onClick={() => runSearch('prev', false)}
              >
                ↑
              </button>
              <button
                type="button"
                className="term-pty-search-nav"
                data-testid="terminal-pty-search-next"
                title={t('termSearchNext')}
                onClick={() => runSearch('next', false)}
              >
                ↓
              </button>
              <button
                type="button"
                className="term-pty-search-nav"
                data-testid="terminal-pty-search-close"
                title={t('termClose')}
                onClick={handleCloseSearch}
              >
                ✕
              </button>
            </div>
          )}

          <div
            className="term-pty-host"
            data-testid="terminal-pty-host"
            ref={hostRef}
            onContextMenu={handleContextMenu}
            onMouseUp={() => {
              if (!searchOpen) termRef.current?.focus()
            }}
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
