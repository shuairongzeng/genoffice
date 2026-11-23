import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  TerminalCommandSnippet,
  TerminalEvent,
  TerminalGroup,
  TerminalGroupColor,
  TerminalMode,
  TerminalSessionSummary,
  TerminalShellKind,
  TerminalShellOption,
  TerminalWorkspaceAction,
  TerminalWorkspaceProfile,
  TerminalWorkspaceSnapshot,
} from '../../../shared/terminal-api'
import { findLeafByPaneId } from '../../../shared/terminal-layout'

export const GROUP_COLOR_OPTIONS: readonly TerminalGroupColor[] = [
  'blue',
  'emerald',
  'amber',
  'purple',
  'rose',
  'slate',
]

export const PANE_DRAG_MIME = 'application/x-genoffice-terminal-pane'

export interface PaneDragPayload {
  groupId: string
  paneId: string
}

let activePaneDrag: PaneDragPayload | null = null

export function setActivePaneDrag(payload: PaneDragPayload | null): void {
  activePaneDrag = payload
}

export function getActivePaneDrag(): PaneDragPayload | null {
  return activePaneDrag
}

/**
 * Filter xterm automatic terminal query responses (DA1/DA2, CPR, DSR, OSC color replies)
 * so group broadcast never echoes control replies into sibling shells.
 */
export function isTerminalResponseSequence(data: string): boolean {
  if (!data.startsWith('\x1b')) return false
  // CSI DA / CPR / DSR replies e.g. ESC [ ? 1 ; 2 c, ESC [ 12 ; 1 R, ESC [ 0 n
  if (/^\x1b\[[?>=]?[\d;]*[cRn]/.test(data)) return true
  // OSC color/clipboard replies ending with BEL or ST
  if (/^\x1b\][\d]+;/.test(data)) return true
  // DCS / APC replies
  if (/^\x1b[PX^_]/.test(data)) return true
  return false
}

export interface UseTerminalWorkspaceOptions {
  enabled?: boolean
  initialSessionId?: string | null
  preferFocusedSessionId?: string | null
}

export interface UseTerminalWorkspaceResult {
  workspace: TerminalWorkspaceSnapshot | null
  activeGroup: TerminalGroup | null
  sessionsById: Map<string, TerminalSessionSummary>
  shells: TerminalShellOption[]
  selectedShell: TerminalShellKind | ''
  setSelectedShell: (shell: TerminalShellKind) => void
  selectedMode: TerminalMode
  setSelectedMode: (mode: TerminalMode) => void
  profiles: TerminalWorkspaceProfile[]
  snippets: TerminalCommandSnippet[]
  refreshProfiles: () => Promise<void>
  refreshSnippets: () => Promise<void>
  dispatchAction: (action: TerminalWorkspaceAction) => Promise<TerminalWorkspaceSnapshot | null>
  reloadWorkspace: () => Promise<void>
}

/**
 * Shared terminal workspace hook backing both the bottom drawer and standalone tab view.
 * Keeps authoritative main-process state synchronized in real time via `workspace-updated`.
 */
export function useTerminalWorkspace(
  options: UseTerminalWorkspaceOptions = {},
): UseTerminalWorkspaceResult {
  const { enabled = true, initialSessionId = null, preferFocusedSessionId = null } = options

  const [workspace, setWorkspace] = useState<TerminalWorkspaceSnapshot | null>(null)
  const [shells, setShells] = useState<TerminalShellOption[]>([])
  const [selectedShell, setSelectedShell] = useState<TerminalShellKind | ''>('')
  const [selectedMode, setSelectedMode] = useState<TerminalMode>('pty')
  const [profiles, setProfiles] = useState<TerminalWorkspaceProfile[]>([])
  const [snippets, setSnippets] = useState<TerminalCommandSnippet[]>([])

  const selectedShellRef = useRef(selectedShell)
  selectedShellRef.current = selectedShell

  const initialSessionIdRef = useRef(initialSessionId)
  initialSessionIdRef.current = initialSessionId

  const preferFocusedSessionIdRef = useRef(preferFocusedSessionId)
  preferFocusedSessionIdRef.current = preferFocusedSessionId

  const appliedInitialFocusRef = useRef<string | null>(null)

  const focusSpecificSession = useCallback(
    async (snap: TerminalWorkspaceSnapshot, targetSessionId: string): Promise<void> => {
      if (appliedInitialFocusRef.current === targetSessionId) return
      const targetGroup = snap.groups.find((g) => g.sessionIds.includes(targetSessionId))
      if (!targetGroup) return
      appliedInitialFocusRef.current = targetSessionId
      const targetLeaf =
        targetGroup.layout.type === 'leaf'
          ? targetGroup.layout.sessionId === targetSessionId
            ? targetGroup.layout
            : null
          : findLeafBySessionIdSafe(targetGroup, targetSessionId)

      if (snap.activeGroupId !== targetGroup.id) {
        await window.aiOffice?.terminalWorkspaceAction?.({
          type: 'activate-group',
          groupId: targetGroup.id,
        })
      }
      if (targetLeaf && targetGroup.focusedPaneId !== targetLeaf.paneId) {
        await window.aiOffice?.terminalWorkspaceAction?.({
          type: 'focus-pane',
          groupId: targetGroup.id,
          paneId: targetLeaf.paneId,
        })
      }
    },
    [],
  )

  const reloadWorkspace = useCallback(async (): Promise<void> => {
    const api = window.aiOffice
    if (!api?.terminalWorkspaceGet) return
    const snap = await api.terminalWorkspaceGet()
    setWorkspace(snap)
    const targetSid = initialSessionIdRef.current || preferFocusedSessionIdRef.current
    if (targetSid) {
      void focusSpecificSession(snap, targetSid)
    }
  }, [focusSpecificSession])

  const refreshProfiles = useCallback(async (): Promise<void> => {
    const list = await window.aiOffice?.terminalListProfiles?.()
    if (list) setProfiles(list)
  }, [])

  const refreshSnippets = useCallback(async (): Promise<void> => {
    const list = await window.aiOffice?.terminalListSnippets?.()
    if (list) setSnippets(list)
  }, [])

  useEffect(() => {
    if (!enabled) return
    let alive = true
    const api = window.aiOffice
    if (!api) return

    void api.terminalListShells?.().then((list) => {
      if (!alive) return
      setShells(list)
      const firstAvail = list.find((s) => s.available) ?? list[0]
      if (firstAvail && !selectedShellRef.current) {
        setSelectedShell(firstAvail.kind)
      }
    })

    void reloadWorkspace()
    void refreshProfiles()
    void refreshSnippets()

    const unsubscribe = api.onTerminalEvent?.((event: TerminalEvent) => {
      if (!alive) return
      if (event.type === 'workspace-updated') {
        setWorkspace(event.workspace)
        return
      }
      if (event.type === 'session-updated') {
        setWorkspace((prev) => {
          if (!prev) return prev
          const exists = prev.sessions.some((s) => s.id === event.session.id)
          if (!exists) return prev
          return {
            ...prev,
            sessions: prev.sessions.map((s) =>
              s.id === event.session.id ? { ...s, ...event.session } : s,
            ),
          }
        })
      }
    })

    return () => {
      alive = false
      unsubscribe?.()
    }
  }, [enabled, refreshProfiles, refreshSnippets, reloadWorkspace])

  const dispatchAction = useCallback(
    async (action: TerminalWorkspaceAction): Promise<TerminalWorkspaceSnapshot | null> => {
      const api = window.aiOffice
      if (!api?.terminalWorkspaceAction) return null
      const next = await api.terminalWorkspaceAction(action)
      setWorkspace(next)
      return next
    },
    [],
  )

  const activeGroup = useMemo(() => {
    if (!workspace) return null
    return (
      workspace.groups.find((g) => g.id === workspace.activeGroupId) ?? workspace.groups[0] ?? null
    )
  }, [workspace])

  const sessionsById = useMemo(() => {
    const map = new Map<string, TerminalSessionSummary>()
    for (const s of workspace?.sessions ?? []) {
      map.set(s.id, s)
    }
    return map
  }, [workspace?.sessions])

  return {
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
  }
}

function findLeafBySessionIdSafe(
  group: TerminalGroup,
  sessionId: string,
): { paneId: string } | null {
  const stack = [group.layout]
  while (stack.length > 0) {
    const cur = stack.pop()!
    if (cur.type === 'leaf') {
      if (cur.sessionId === sessionId) return { paneId: cur.paneId }
    } else {
      stack.push(cur.first, cur.second)
    }
  }
  return null
}

/**
 * Send a command snippet (or history command) to the active focused terminal pane.
 */
export async function dispatchCommandToGroup(
  group: TerminalGroup | null,
  sessionsById: Map<string, TerminalSessionSummary>,
  command: string,
  sendEnter: boolean,
  dispatchAction: (action: TerminalWorkspaceAction) => Promise<TerminalWorkspaceSnapshot | null>,
): Promise<void> {
  if (!group) return
  const leaf = findLeafByPaneId(group.layout, group.focusedPaneId)
  if (!leaf) return
  const summary = sessionsById.get(leaf.sessionId)
  if (!summary) return

  if (summary.mode === 'pty') {
    const payload = sendEnter ? `${command}\r` : command
    if (group.broadcastEnabled) {
      await dispatchAction({ type: 'broadcast-write', groupId: group.id, data: payload })
    } else {
      await window.aiOffice?.terminalPtyWrite?.(summary.id, payload)
    }
    return
  }

  if (sendEnter) {
    await window.aiOffice?.terminalRunCommand?.(summary.id, command)
  } else {
    window.dispatchEvent(
      new CustomEvent('genoffice:terminal-insert-snippet', {
        detail: { sessionId: summary.id, command },
      }),
    )
  }
}

/**
 * Focus the pane holding `targetSessionId` and replace it with a new shell session.
 */
export async function switchPaneShell(
  group: TerminalGroup | null,
  targetSessionId: string,
  shell: TerminalShellKind,
  cwd: string | undefined,
  dispatchAction: (action: TerminalWorkspaceAction) => Promise<TerminalWorkspaceSnapshot | null>,
): Promise<void> {
  if (!group) return
  let targetPaneId = group.focusedPaneId
  const stack = [group.layout]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.type === 'leaf') {
      if (node.sessionId === targetSessionId) {
        targetPaneId = node.paneId
        break
      }
    } else {
      stack.push(node.first, node.second)
    }
  }
  await dispatchAction({ type: 'focus-pane', groupId: group.id, paneId: targetPaneId })
  await dispatchAction({
    type: 'add-session-to-group',
    groupId: group.id,
    opts: { shell, mode: 'pty', ...(cwd ? { cwd } : {}) },
    replaceFocusedPane: true,
  })
}
