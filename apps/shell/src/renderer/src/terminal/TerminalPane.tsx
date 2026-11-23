import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactElement } from 'react'
import type {
  TerminalBlock,
  TerminalEvent,
  TerminalSessionSnapshot,
  TerminalShellKind,
} from '../../../shared/terminal-api'
import { useI18n } from '../locale'
import { stripAnsi } from './terminal-ansi'
import { copyTextToClipboard } from './terminal-clipboard'
import {
  detectRichOutput,
  extractLocalPaths,
  type RichOutputDetection,
} from './terminal-rich-detect'
import { TerminalPtyPane } from './TerminalPtyPane'
import { TerminalRichOutput, useDarkTheme, type TerminalRichViewMode } from './TerminalRichOutput'

export interface TerminalPaneProps {
  sessionId: string
  compact?: boolean
  focused?: boolean
  onFocusPane?: () => void
  onSwitchShell?: (shell: TerminalShellKind, cwd?: string) => void
}

interface SessionComposerMemory {
  draft: string
  history: string[]
}

const COPIED_RESET_MS = 1800
const STICK_BOTTOM_THRESHOLD_PX = 48

function formatDuration(startedAt: number, finishedAt?: number): string | null {
  if (finishedAt === undefined) return null
  const ms = Math.max(0, finishedAt - startedAt)
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

function buildDemoCommands(shell: TerminalShellKind): {
  sysInfo: string
  html: string
  json: string
} {
  const htmlMarkup =
    '<!doctype html><html><body style="font-family:system-ui,sans-serif;padding:16px;margin:0"><div style="border:1px solid #d0d7de;border-radius:10px;padding:16px;max-width:480px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><strong style="font-size:15px">Build Report</strong><span style="background:#dafbe1;color:#116329;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600">PASSED</span></div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;text-align:center"><div style="background:#f6f8fa;padding:8px;border-radius:6px"><div style="font-size:18px;font-weight:700">128</div><div style="font-size:11px;color:#57606a">Tests</div></div><div style="background:#f6f8fa;padding:8px;border-radius:6px"><div style="font-size:18px;font-weight:700">98.4%</div><div style="font-size:11px;color:#57606a">Coverage</div></div><div style="background:#f6f8fa;padding:8px;border-radius:6px"><div style="font-size:18px;font-weight:700">1.4s</div><div style="font-size:11px;color:#57606a">Duration</div></div></div></div></body></html>'
  const jsonPayload =
    '{"status":"ok","metrics":{"uptimeSec":3842,"latencyMs":14,"successRate":0.998},"services":[{"name":"api","healthy":true,"port":3000},{"name":"worker","healthy":true,"port":3001}],"tags":["release","v0.12","canary"]}'

  if (shell === 'powershell') {
    return {
      sysInfo: 'Get-Location; $PSVersionTable.PSVersion.ToString()',
      html: `Write-Output '${htmlMarkup}'`,
      json: `Write-Output '${jsonPayload}'`,
    }
  }

  if (shell === 'cmd') {
    return {
      sysInfo: 'cd & ver',
      html: 'echo ^<!doctype html^>^<html^>^<body style="font-family:sans-serif;padding:16px;margin:0"^>^<div style="border:1px solid #d0d7de;border-radius:10px;padding:16px"^>^<strong style="font-size:15px"^>Build Report^</strong^> ^<span style="color:#116329;font-weight:700"^>PASSED^</span^>^<p style="margin:8px 0 0;color:#57606a"^>Tests: 128 · Coverage: 98.4% · Duration: 1.4s^</p^>^</div^>^</body^>^</html^>',
      json: `echo ${jsonPayload}`,
    }
  }

  return {
    sysInfo: 'pwd && uname -a',
    html: `printf '%s\\n' '${htmlMarkup}'`,
    json: `printf '%s\\n' '${jsonPayload}'`,
  }
}

function applyTerminalEvent(
  prev: TerminalSessionSnapshot | null,
  event: TerminalEvent,
  sessionId: string,
): TerminalSessionSnapshot | null {
  if (event.type === 'session-updated') {
    if (event.session.id !== sessionId || !prev) return prev
    return {
      ...prev,
      ...event.session,
      blocks: prev.blocks,
    }
  }

  if (!('sessionId' in event) || event.sessionId !== sessionId) {
    return prev
  }

  if (!prev) return prev

  switch (event.type) {
    case 'session-cleared':
      return {
        ...prev,
        running: false,
        blockCount: 0,
        blocks: [],
      }

    case 'block-started': {
      const exists = prev.blocks.some((b) => b.id === event.block.id)
      const nextBlocks = exists
        ? prev.blocks.map((b) => (b.id === event.block.id ? event.block : b))
        : [...prev.blocks, event.block]
      return {
        ...prev,
        running: true,
        blockCount: nextBlocks.length,
        blocks: nextBlocks,
      }
    }

    case 'block-output': {
      const idx = prev.blocks.findIndex((b) => b.id === event.blockId)
      if (idx === -1) return prev
      const target = prev.blocks[idx]!
      const updatedBlock: TerminalBlock = {
        ...target,
        stdout: event.stream === 'stdout' ? target.stdout + event.chunk : target.stdout,
        stderr: event.stream === 'stderr' ? target.stderr + event.chunk : target.stderr,
        truncated: Boolean(target.truncated || event.truncated),
      }
      const nextBlocks = prev.blocks.slice()
      nextBlocks[idx] = updatedBlock
      return {
        ...prev,
        blocks: nextBlocks,
      }
    }

    case 'block-finished': {
      const idx = prev.blocks.findIndex((b) => b.id === event.blockId)
      const nextBlocks =
        idx === -1
          ? prev.blocks
          : prev.blocks.map((b, i) =>
              i === idx
                ? {
                    ...b,
                    status: event.status,
                    exitCode: event.exitCode,
                    cwd: event.cwd,
                    finishedAt: event.finishedAt,
                  }
                : b,
            )
      return {
        ...prev,
        cwd: event.cwd || prev.cwd,
        running: false,
        blocks: nextBlocks,
      }
    }

    default:
      return prev
  }
}

function badgeKeyForKind(
  kind: RichOutputDetection['kind'],
):
  | 'termBadgeHtml'
  | 'termBadgeSvg'
  | 'termBadgeJson'
  | 'termBadgeTable'
  | 'termBadgeMarkdown'
  | null {
  switch (kind) {
    case 'html':
      return 'termBadgeHtml'
    case 'svg':
      return 'termBadgeSvg'
    case 'json':
      return 'termBadgeJson'
    case 'table':
      return 'termBadgeTable'
    case 'markdown':
      return 'termBadgeMarkdown'
    default:
      return null
  }
}

interface TerminalBlockCardProps {
  block: TerminalBlock
  dark: boolean
  filterText: string
  sessionRunning: boolean
  viewOverride?: TerminalRichViewMode
  onChangeViewMode: (blockId: string, mode: TerminalRichViewMode) => void
  onRerun: (command: string) => void
}

const TerminalBlockCard = memo(function TerminalBlockCard({
  block,
  dark,
  filterText,
  sessionRunning,
  viewOverride,
  onChangeViewMode,
  onRerun,
}: TerminalBlockCardProps): ReactElement {
  const { t } = useI18n()
  const [copiedTarget, setCopiedTarget] = useState<'cmd' | 'out' | null>(null)
  const copyTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }
    }
  }, [])

  const detection = useMemo(() => detectRichOutput(block.stdout), [block.stdout])

  const detectedPaths = useMemo(() => {
    const combined = [block.stdout, block.stderr].filter(Boolean).join('\n')
    return combined.trim() ? extractLocalPaths(combined) : []
  }, [block.stderr, block.stdout])

  const isRich = detection.kind !== 'plain'
  const effectiveViewMode: TerminalRichViewMode = viewOverride ?? (isRich ? 'rendered' : 'raw')
  const badgeKey = badgeKeyForKind(detection.kind)
  const durationLabel = formatDuration(block.startedAt, block.finishedAt)
  const showAskAi =
    block.status === 'error' || (block.exitCode !== undefined && block.exitCode !== 0)
  const showFooter = Boolean(block.truncated || detectedPaths.length > 0 || showAskAi)

  const markCopied = useCallback((target: 'cmd' | 'out') => {
    setCopiedTarget(target)
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current)
    }
    copyTimerRef.current = window.setTimeout(() => {
      copyTimerRef.current = null
      setCopiedTarget(null)
    }, COPIED_RESET_MS)
  }, [])

  const handleCopyCommand = useCallback(() => {
    void copyTextToClipboard(block.command).then((ok) => {
      if (ok) markCopied('cmd')
    })
  }, [block.command, markCopied])

  const handleCopyOutput = useCallback(() => {
    const rawText = stripAnsi([block.stdout, block.stderr].filter(Boolean).join('\n'))
    void copyTextToClipboard(rawText).then((ok) => {
      if (ok) markCopied('out')
    })
  }, [block.stderr, block.stdout, markCopied])

  const handleAskAi = useCallback(() => {
    const output = stripAnsi([block.stdout, block.stderr].filter(Boolean).join('\n'))
    void window.aiOffice?.terminalAskAi?.({
      command: block.command,
      cwd: block.cwd,
      exitCode: block.exitCode ?? 1,
      output,
    })
  }, [block.command, block.cwd, block.exitCode, block.stderr, block.stdout])

  return (
    <article
      className="term-block"
      data-testid="terminal-block"
      data-rich-kind={detection.kind}
      data-status={block.status}
    >
      <header className="term-block-header">
        <div className="term-block-cmd-wrap" title={block.command}>
          <span className="term-block-prompt">$</span>
          <span className="term-block-command">{block.command}</span>
        </div>

        <div className="term-block-meta">
          {badgeKey && (
            <span className="term-rich-badge" data-testid="terminal-rich-badge">
              {t(badgeKey)}
            </span>
          )}

          {durationLabel && <span className="term-duration-pill">{durationLabel}</span>}

          <span className={`term-status-pill is-${block.status}`}>
            {block.status === 'running'
              ? t('termRunning')
              : block.status === 'interrupted'
                ? t('termInterrupted')
                : t('termExitCode', { code: block.exitCode ?? 0 })}
          </span>

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
                  className={`term-view-tab${effectiveViewMode === mode ? ' is-active' : ''}`}
                  aria-pressed={effectiveViewMode === mode}
                  onClick={() => onChangeViewMode(block.id, mode)}
                >
                  {t(labelKey)}
                </button>
              ))}
            </div>
          )}

          <button
            type="button"
            className={`term-mini-btn${copiedTarget === 'cmd' ? ' is-copied' : ''}`}
            onClick={handleCopyCommand}
          >
            {copiedTarget === 'cmd' ? t('termCopied') : t('termCopyCommand')}
          </button>

          <button
            type="button"
            className={`term-mini-btn${copiedTarget === 'out' ? ' is-copied' : ''}`}
            disabled={!block.stdout && !block.stderr}
            onClick={handleCopyOutput}
          >
            {copiedTarget === 'out' ? t('termCopied') : t('termCopyOutput')}
          </button>

          <button
            type="button"
            className="term-mini-btn"
            disabled={sessionRunning}
            onClick={() => onRerun(block.command)}
          >
            {t('termRerun')}
          </button>
        </div>
      </header>

      {(block.stdout || block.stderr) && (
        <div className="term-block-body">
          <TerminalRichOutput
            stdout={block.stdout}
            stderr={block.stderr}
            detection={detection}
            viewMode={effectiveViewMode}
            dark={dark}
            filterText={filterText}
          />
        </div>
      )}

      {showFooter && (
        <footer className="term-block-footer">
          <div className="term-footer-left">
            {block.truncated && <span className="term-truncated-note">{t('termTruncated')}</span>}
            {detectedPaths.map((file) => (
              <button
                key={file.path}
                type="button"
                className="term-file-pill"
                title={file.path}
                onClick={() => void window.aiOffice?.openPath?.(file.path)}
              >
                {t('termOpenFile', { name: file.name })}
              </button>
            ))}
          </div>

          {showAskAi && (
            <button
              type="button"
              className="term-ask-ai-btn"
              data-testid="terminal-ask-ai-btn"
              onClick={handleAskAi}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M8 1.5l1.6 4.4 4.4 1.6-4.4 1.6L8 13.5l-1.6-4.4L2 7.5l4.4-1.6z"
                  stroke="currentColor"
                  strokeWidth="1.25"
                  strokeLinejoin="round"
                />
              </svg>
              <span>{t('termAskAi')}</span>
            </button>
          )}
        </footer>
      )}
    </article>
  )
})

/**
 * Interactive single-session terminal pane featuring live streaming output,
 * CWD management, search filtering, rich auto-rendering, and command history.
 */
export function TerminalPane({
  sessionId,
  compact = false,
  focused = false,
  onFocusPane,
  onSwitchShell,
}: TerminalPaneProps): ReactElement {
  const { t } = useI18n()
  const dark = useDarkTheme()

  const [session, setSession] = useState<TerminalSessionSnapshot | null>(null)
  const [input, setInput] = useState('')
  const [filterText, setFilterText] = useState('')
  const [cwdCopied, setCwdCopied] = useState(false)
  const [viewOverrides, setViewOverrides] = useState<Record<string, TerminalRichViewMode>>({})

  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const stickToBottomRef = useRef(true)
  const cwdCopyTimerRef = useRef<number | null>(null)
  const memoryBySessionRef = useRef<Map<string, SessionComposerMemory>>(new Map())
  const historyCursorRef = useRef<number>(-1)
  const historyDraftRef = useRef<string>('')
  const prevSessionIdRef = useRef<string>(sessionId)

  useEffect(() => {
    const prevId = prevSessionIdRef.current
    if (prevId !== sessionId) {
      const prevMem = memoryBySessionRef.current.get(prevId) ?? { draft: '', history: [] }
      memoryBySessionRef.current.set(prevId, { ...prevMem, draft: input })

      const nextMem = memoryBySessionRef.current.get(sessionId) ?? { draft: '', history: [] }
      setInput(nextMem.draft)
      historyCursorRef.current = -1
      historyDraftRef.current = nextMem.draft
      prevSessionIdRef.current = sessionId
    }
  }, [input, sessionId])

  useEffect(() => {
    const existing = memoryBySessionRef.current.get(sessionId)
    if (existing) {
      existing.draft = input
    } else {
      memoryBySessionRef.current.set(sessionId, { draft: input, history: [] })
    }
  }, [input, sessionId])

  useEffect(() => {
    return () => {
      if (cwdCopyTimerRef.current !== null) {
        window.clearTimeout(cwdCopyTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    let alive = true
    let snapshotLoaded = false
    const bufferedEvents: TerminalEvent[] = []
    stickToBottomRef.current = true

    const unsubscribe = window.aiOffice?.onTerminalEvent?.((event) => {
      if (!alive) return
      if (!snapshotLoaded) {
        bufferedEvents.push(event)
        return
      }
      setSession((prev) => applyTerminalEvent(prev, event, sessionId))
    })

    void window.aiOffice
      ?.terminalGetSession?.(sessionId)
      .then((snap) => {
        if (!alive) return
        snapshotLoaded = true
        let next = snap
        for (const ev of bufferedEvents) {
          next = applyTerminalEvent(next, ev, sessionId)
        }
        setSession(next)

        if (next && next.blocks.length > 0) {
          const prevMem = memoryBySessionRef.current.get(sessionId)
          if (!prevMem || prevMem.history.length === 0) {
            const cmds = next.blocks.map((b) => b.command).filter(Boolean)
            memoryBySessionRef.current.set(sessionId, {
              draft: prevMem?.draft ?? '',
              history: cmds,
            })
          }
        }
      })
      .catch(() => {
        if (alive) {
          snapshotLoaded = true
          setSession(null)
        }
      })

    return () => {
      alive = false
      unsubscribe?.()
    }
  }, [sessionId])

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !stickToBottomRef.current) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [session?.blocks])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    stickToBottomRef.current = distance <= STICK_BOTTOM_THRESHOLD_PX
  }, [])

  const executeCommand = useCallback(
    (rawCommand: string) => {
      const command = rawCommand.trim()
      if (!command || session?.running) return

      const mem = memoryBySessionRef.current.get(sessionId) ?? { draft: '', history: [] }
      if (mem.history[mem.history.length - 1] !== command) {
        mem.history = [...mem.history, command]
      }
      mem.draft = ''
      memoryBySessionRef.current.set(sessionId, mem)

      historyCursorRef.current = -1
      historyDraftRef.current = ''
      stickToBottomRef.current = true
      setInput('')

      void window.aiOffice?.terminalRunCommand?.(sessionId, command)
    },
    [session?.running, sessionId],
  )

  const handleSubmit = useCallback(() => {
    executeCommand(input)
  }, [executeCommand, input])

  const handleInterrupt = useCallback(() => {
    void window.aiOffice?.terminalInterrupt?.(sessionId)
  }, [sessionId])

  const handleClear = useCallback(() => {
    setFilterText('')
    void window.aiOffice?.terminalClearSession?.(sessionId)
  }, [sessionId])

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

  const handleChangeViewMode = useCallback(
    (blockId: string, mode: TerminalRichViewMode) => {
      setViewOverrides((prev) => ({ ...prev, [`${sessionId}:${blockId}`]: mode }))
    },
    [sessionId],
  )

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault()
        handleSubmit()
        return
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
        e.preventDefault()
        handleClear()
        return
      }

      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'c') {
        if (session?.running) {
          e.preventDefault()
          handleInterrupt()
          return
        }
        const el = e.currentTarget
        if (el.selectionStart === el.selectionEnd && input.length > 0) {
          e.preventDefault()
          setInput('')
          historyCursorRef.current = -1
        }
        return
      }

      const mem = memoryBySessionRef.current.get(sessionId)
      const history = mem?.history ?? []
      if (history.length === 0) return

      const el = e.currentTarget
      if (e.key === 'ArrowUp' && el.selectionStart === el.selectionEnd) {
        const beforeCaret = el.value.slice(0, el.selectionStart)
        if (!beforeCaret.includes('\n')) {
          e.preventDefault()
          if (historyCursorRef.current === -1) {
            historyDraftRef.current = input
            historyCursorRef.current = history.length - 1
          } else if (historyCursorRef.current > 0) {
            historyCursorRef.current -= 1
          }
          const cmd = history[historyCursorRef.current] ?? ''
          setInput(cmd)
        }
        return
      }

      if (e.key === 'ArrowDown' && el.selectionStart === el.selectionEnd) {
        if (historyCursorRef.current === -1) return
        const afterCaret = el.value.slice(el.selectionEnd)
        if (!afterCaret.includes('\n')) {
          e.preventDefault()
          if (historyCursorRef.current < history.length - 1) {
            historyCursorRef.current += 1
            setInput(history[historyCursorRef.current] ?? '')
          } else {
            historyCursorRef.current = -1
            setInput(historyDraftRef.current)
          }
        }
      }
    },
    [handleClear, handleInterrupt, handleSubmit, input, session?.running, sessionId],
  )

  const blocks = useMemo(() => session?.blocks ?? [], [session?.blocks])

  const visibleBlocks = useMemo(() => {
    const q = filterText.trim().toLowerCase()
    if (!q) return blocks
    return blocks.filter(
      (b) =>
        b.command.toLowerCase().includes(q) ||
        stripAnsi(b.stdout).toLowerCase().includes(q) ||
        stripAnsi(b.stderr).toLowerCase().includes(q),
    )
  }, [blocks, filterText])

  const demos = useMemo(() => buildDemoCommands(session?.shell ?? 'powershell'), [session?.shell])

  if (!session) {
    return (
      <section
        className={`term-pane${compact ? ' is-compact' : ''}${focused ? ' is-focused' : ''}`}
        onPointerDown={onFocusPane}
      />
    )
  }

  if (session.mode === 'pty') {
    return (
      <TerminalPtyPane
        sessionId={sessionId}
        initialSession={session}
        compact={compact}
        focused={focused}
        onFocusPane={onFocusPane}
        onSwitchShell={onSwitchShell}
      />
    )
  }

  return (
    <section
      className={`term-pane${compact ? ' is-compact' : ''}${focused ? ' is-focused' : ''}`}
      data-testid="terminal-block-pane"
      onPointerDown={onFocusPane}
    >
      <div className="term-pane-bar">
        <div className="term-pane-bar-left">
          <span className="term-mode-badge is-block" data-testid="terminal-pane-mode-badge">
            {t('termModeBlock')}
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
          <input
            type="search"
            className="term-filter-input"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder={t('termFilterPlaceholder')}
            aria-label={t('termFilterPlaceholder')}
          />
          <button
            type="button"
            className="term-mini-btn"
            disabled={blocks.length === 0}
            onClick={handleClear}
          >
            {t('termClear')}
          </button>
        </div>
      </div>

      {session.fallbackReason && (
        <div className="term-fallback-banner" data-testid="terminal-fallback-banner" role="status">
          <span>{t('termPtyFallbackNotice', { reason: session.fallbackReason })}</span>
        </div>
      )}

      <div className="term-blocks-scroll g-scroll" ref={scrollRef} onScroll={handleScroll}>
        {blocks.length === 0 ? (
          <div className="term-empty-card">
            <div className="term-empty-icon" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
                <path
                  d="M3 4.5l3.5 3.2L3 11M8.5 11.5H13"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <h3 className="term-empty-title">{t('termEmptyTitle')}</h3>
            <p className="term-empty-hint">{t('termEmptyHint')}</p>
            <div className="term-demo-row">
              <button
                type="button"
                className="term-demo-btn"
                data-testid="terminal-demo-sys"
                onClick={() => executeCommand(demos.sysInfo)}
              >
                {t('termDemoSysInfo')}
              </button>
              <button
                type="button"
                className="term-demo-btn"
                data-testid="terminal-demo-html"
                onClick={() => executeCommand(demos.html)}
              >
                {t('termDemoHtml')}
              </button>
              <button
                type="button"
                className="term-demo-btn"
                data-testid="terminal-demo-json"
                onClick={() => executeCommand(demos.json)}
              >
                {t('termDemoJson')}
              </button>
            </div>
          </div>
        ) : (
          visibleBlocks.map((block) => (
            <TerminalBlockCard
              key={block.id}
              block={block}
              dark={dark}
              filterText={filterText}
              sessionRunning={Boolean(session?.running)}
              viewOverride={viewOverrides[`${sessionId}:${block.id}`]}
              onChangeViewMode={handleChangeViewMode}
              onRerun={executeCommand}
            />
          ))
        )}
      </div>

      <div className="term-composer">
        <span className="term-composer-prompt" aria-hidden="true">
          &gt;
        </span>
        <textarea
          ref={inputRef}
          className="term-input"
          data-testid="terminal-input"
          rows={Math.min(5, Math.max(1, input.split('\n').length))}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('termInputPlaceholder')}
        />
        {session?.running ? (
          <button
            type="button"
            className="term-stop-btn"
            data-testid="terminal-stop-btn"
            onClick={handleInterrupt}
          >
            {t('termStop')}
          </button>
        ) : (
          <button
            type="button"
            className="term-run-btn"
            data-testid="terminal-run-btn"
            disabled={!input.trim()}
            onClick={handleSubmit}
          >
            {t('termRun')}
          </button>
        )}
      </div>
    </section>
  )
}
