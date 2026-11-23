import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import type {
  TerminalMode,
  TerminalSessionSnapshot,
  TerminalSessionSummary,
  TerminalShellKind,
  TerminalShellOption,
} from '../../../shared/terminal-api'
import { useI18n } from '../locale'
import { TerminalPane } from './TerminalPane'
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
const TOP_VIEWPORT_RESERVE = 160

function clampDrawerHeight(value: number): number {
  const max =
    typeof window !== 'undefined'
      ? Math.max(MIN_DRAWER_HEIGHT, window.innerHeight - TOP_VIEWPORT_RESERVE)
      : 640
  if (!Number.isFinite(value)) return 300
  return Math.min(max, Math.max(MIN_DRAWER_HEIGHT, Math.round(value)))
}

function toSummary(snap: TerminalSessionSnapshot): TerminalSessionSummary {
  return {
    id: snap.id,
    title: snap.title,
    shell: snap.shell,
    mode: snap.mode,
    fallbackReason: snap.fallbackReason,
    cwd: snap.cwd,
    running: snap.running,
    blockCount: snap.blockCount,
    cols: snap.cols,
    rows: snap.rows,
    exitCode: snap.exitCode,
    createdAt: snap.createdAt,
  }
}

/**
 * Bottom collapsible multi-session terminal drawer embedded in Home.
 * Supports vertical edge resizing, shell selection, split panes, and tab pop-out.
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

  const [shells, setShells] = useState<TerminalShellOption[]>([])
  const [selectedShell, setSelectedShell] = useState<TerminalShellKind | ''>('')
  const [selectedMode, setSelectedMode] = useState<TerminalMode>('pty')
  const [sessions, setSessions] = useState<TerminalSessionSummary[]>([])
  const [splitActive, setSplitActive] = useState(false)
  const [splitRightSessionId, setSplitRightSessionId] = useState<string | null>(null)
  const [focusedSide, setFocusedSide] = useState<'left' | 'right'>('left')
  const [resizing, setResizing] = useState(false)

  const creatingInitialRef = useRef(false)
  const closingIdsRef = useRef<Set<string>>(new Set())
  const activeSessionRef = useRef(activeSessionId)
  activeSessionRef.current = activeSessionId

  const splitRightRef = useRef(splitRightSessionId)
  splitRightRef.current = splitRightSessionId

  const selectedShellRef = useRef(selectedShell)
  selectedShellRef.current = selectedShell

  const selectedModeRef = useRef(selectedMode)
  selectedModeRef.current = selectedMode

  const dragStateRef = useRef<{
    active: boolean
    startY: number
    startHeight: number
  }>({ active: false, startY: 0, startHeight: height })

  const createNewSession = useCallback(
    async (
      shellOverride?: TerminalShellKind,
      modeOverride?: TerminalMode,
      cwdOverride?: string,
    ): Promise<TerminalSessionSummary | null> => {
      const create = window.aiOffice?.terminalCreateSession
      if (!create) return null
      const chosenShell = shellOverride || selectedShellRef.current || undefined
      const chosenMode = modeOverride || selectedModeRef.current
      const snap = await create({
        ...(chosenShell ? { shell: chosenShell } : {}),
        ...(cwdOverride ? { cwd: cwdOverride } : {}),
        mode: chosenMode,
      })
      const summary = toSummary(snap)
      setSessions((prev) => (prev.some((s) => s.id === summary.id) ? prev : [...prev, summary]))
      return summary
    },
    [],
  )

  const handleSwitchShell = useCallback(
    (side: 'left' | 'right', targetShell: TerminalShellKind, targetCwd?: string) => {
      void createNewSession(targetShell, 'pty', targetCwd).then((created) => {
        if (!created) return
        if (side === 'right') {
          setSplitRightSessionId(created.id)
          setFocusedSide('right')
        } else {
          onActiveSessionChange(created.id)
          setFocusedSide('left')
        }
      })
    },
    [createNewSession, onActiveSessionChange],
  )

  // Load shells and synchronize live sessions whenever the drawer opens.
  useEffect(() => {
    if (!open) return
    let alive = true

    void window.aiOffice
      ?.terminalListShells?.()
      .then((opts) => {
        if (!alive) return
        setShells(opts)
        if (!selectedShellRef.current && opts.length > 0) {
          const firstAvailable = opts.find((o) => o.available) ?? opts[0]!
          setSelectedShell(firstAvailable.kind)
        }
      })
      .catch(() => undefined)

    void window.aiOffice
      ?.terminalListSessions?.()
      .then(async (list) => {
        if (!alive) return
        if (list.length > 0) {
          setSessions(list)
          const current = activeSessionRef.current
          if (current && list.some((s) => s.id === current)) {
            return
          }
          onActiveSessionChange(list[0]!.id)
          return
        }

        if (creatingInitialRef.current) return
        creatingInitialRef.current = true
        try {
          const created = await createNewSession()
          if (alive && created) {
            onActiveSessionChange(created.id)
          }
        } finally {
          creatingInitialRef.current = false
        }
      })
      .catch(() => undefined)

    return () => {
      alive = false
    }
  }, [createNewSession, onActiveSessionChange, open])

  // Re-sync session list if an external re-dock passes a session not yet listed.
  useEffect(() => {
    if (!open || !activeSessionId) return
    if (sessions.some((s) => s.id === activeSessionId)) return
    let alive = true
    void window.aiOffice
      ?.terminalListSessions?.()
      .then((list) => {
        if (!alive) return
        if (list.length > 0) setSessions(list)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [activeSessionId, open, sessions])

  // Subscribe to session lifecycle events across windows/panes.
  useEffect(() => {
    if (!open) return
    const unsubscribe = window.aiOffice?.onTerminalEvent?.((event) => {
      if (event.type === 'session-created') {
        const summary = toSummary(event.session)
        setSessions((prev) => (prev.some((s) => s.id === summary.id) ? prev : [...prev, summary]))
        return
      }

      if (event.type === 'session-updated') {
        setSessions((prev) =>
          prev.map((s) => (s.id === event.session.id ? { ...s, ...event.session } : s)),
        )
        return
      }

      if (event.type === 'session-closed') {
        const closedId = event.sessionId
        setSessions((prev) => {
          const idx = prev.findIndex((s) => s.id === closedId)
          if (idx === -1) return prev
          const next = prev.filter((s) => s.id !== closedId)
          if (activeSessionRef.current === closedId) {
            const fallback = next[Math.min(idx, next.length - 1)]?.id ?? null
            onActiveSessionChange(fallback)
          }
          if (splitRightRef.current === closedId) {
            const alt = next.find((s) => s.id !== activeSessionRef.current)?.id ?? null
            setSplitRightSessionId(alt)
            if (!alt) setSplitActive(false)
          }
          return next
        })
      }
    })
    return () => {
      unsubscribe?.()
    }
  }, [onActiveSessionChange, open])

  // Handle vertical drawer height dragging via window pointer events.
  useEffect(() => {
    if (!resizing) return

    const handleMove = (e: PointerEvent): void => {
      if (!dragStateRef.current.active) return
      const deltaY = dragStateRef.current.startY - e.clientY
      onHeightChange(clampDrawerHeight(dragStateRef.current.startHeight + deltaY))
    }

    const handleUp = (): void => {
      dragStateRef.current.active = false
      setResizing(false)
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleUp)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
    }
  }, [onHeightChange, resizing])

  const handleResizerPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      dragStateRef.current = {
        active: true,
        startY: e.clientY,
        startHeight: height,
      }
      setResizing(true)
    },
    [height],
  )

  const handleNewSession = useCallback(() => {
    void createNewSession().then((created) => {
      if (created) onActiveSessionChange(created.id)
    })
  }, [createNewSession, onActiveSessionChange])

  const handleCloseSession = useCallback(
    (sessionId: string) => {
      if (closingIdsRef.current.has(sessionId)) return
      closingIdsRef.current.add(sessionId)

      void (async () => {
        try {
          if (sessions.length <= 1) {
            const replacement = await createNewSession()
            if (replacement) {
              onActiveSessionChange(replacement.id)
            }
          }
          await window.aiOffice?.terminalCloseSession?.(sessionId)
        } finally {
          closingIdsRef.current.delete(sessionId)
        }
      })()
    },
    [createNewSession, onActiveSessionChange, sessions.length],
  )

  const handleToggleSplit = useCallback(() => {
    if (splitActive) {
      setSplitActive(false)
      setFocusedSide('left')
      return
    }

    const currentLeft = activeSessionRef.current ?? sessions[0]?.id ?? null
    const existingOther = sessions.find((s) => s.id !== currentLeft)?.id ?? null
    if (existingOther) {
      setSplitRightSessionId(existingOther)
      setSplitActive(true)
      return
    }

    void createNewSession().then((created) => {
      if (!created) return
      setSplitRightSessionId(created.id)
      setSplitActive(true)
    })
  }, [createNewSession, sessions, splitActive])

  const currentActiveId = useMemo(() => {
    if (activeSessionId && sessions.some((s) => s.id === activeSessionId)) {
      return activeSessionId
    }
    return sessions[0]?.id ?? activeSessionId ?? null
  }, [activeSessionId, sessions])

  const canShowSplit =
    splitActive && Boolean(splitRightSessionId && splitRightSessionId !== currentActiveId)

  if (!open) return null

  return (
    <aside
      className="term-drawer"
      data-testid="terminal-drawer"
      style={{ height: `${height}px` }}
      aria-label={t('termTitle')}
    >
      <div
        className={`term-drawer-resizer${resizing ? ' is-dragging' : ''}`}
        data-testid="terminal-drawer-resizer"
        role="separator"
        aria-orientation="horizontal"
        onPointerDown={handleResizerPointerDown}
      />

      <header className="term-drawer-header">
        <div className="term-header-left">
          <span className="term-header-title">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M2.5 4.2l3.5 3.3-3.5 3.3M8 11.2h5.5"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>{t('termTitle')}</span>
          </span>

          <div className="term-tabs-strip" role="tablist" aria-label={t('termTitle')}>
            {sessions.map((s) => {
              const isActive = s.id === currentActiveId
              return (
                <div key={s.id} className={`term-session-tab${isActive ? ' is-active' : ''}`}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    className="term-session-tab-btn"
                    onClick={() => onActiveSessionChange(s.id)}
                  >
                    <span className={`term-tab-dot${s.running ? ' is-running' : ''}`} />
                    <span className="term-session-tab-label">{s.title || s.shell}</span>
                    <span className={`term-tab-mode is-${s.mode}`}>
                      {s.mode === 'pty' ? 'PTY' : 'BLK'}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="term-session-close"
                    title={t('termCloseSession')}
                    aria-label={t('termCloseSession')}
                    onClick={() => handleCloseSession(s.id)}
                  >
                    ×
                  </button>
                </div>
              )
            })}
          </div>

          <button
            type="button"
            className="term-icon-btn"
            data-testid="terminal-new-session-btn"
            title={t('termNewSession')}
            aria-label={t('termNewSession')}
            onClick={handleNewSession}
          >
            +
          </button>

          <select
            className="term-shell-select"
            data-testid="terminal-shell-select"
            aria-label={t('termShellLabel')}
            title={t('termShellLabel')}
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
            title={t('termModeLabel')}
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
            className={`term-action-btn${canShowSplit ? ' is-active' : ''}`}
            data-testid="terminal-drawer-split-btn"
            aria-pressed={canShowSplit}
            title={canShowSplit ? t('termCloseSplitPane') : t('termSplitPane')}
            onClick={handleToggleSplit}
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
            <span>{canShowSplit ? t('termCloseSplitPane') : t('termSplitPane')}</span>
          </button>

          <button
            type="button"
            className="term-action-btn"
            data-testid="terminal-popout-btn"
            disabled={!currentActiveId}
            title={t('termPopOutTab')}
            onClick={() => {
              if (currentActiveId) onPopOutTab(currentActiveId)
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
        {currentActiveId && (
          <div className="term-pane-slot">
            <TerminalPane
              sessionId={currentActiveId}
              compact
              focused={!canShowSplit || focusedSide === 'left'}
              onFocusPane={() => setFocusedSide('left')}
              onSwitchShell={(shell, cwd) => handleSwitchShell('left', shell, cwd)}
            />
          </div>
        )}

        {canShowSplit && splitRightSessionId && (
          <>
            <div className="term-split-separator" />
            <div className="term-pane-slot">
              <TerminalPane
                sessionId={splitRightSessionId}
                compact
                focused={focusedSide === 'right'}
                onFocusPane={() => setFocusedSide('right')}
                onSwitchShell={(shell, cwd) => handleSwitchShell('right', shell, cwd)}
              />
            </div>
          </>
        )}
      </div>
    </aside>
  )
}
