export type TerminalShellKind = 'powershell' | 'cmd' | 'bash' | 'zsh' | 'sh'

export type TerminalMode = 'pty' | 'block'

export type TerminalColorScheme = 'dark' | 'light'

export type TerminalGroupColor = 'blue' | 'emerald' | 'amber' | 'purple' | 'rose' | 'slate'

export type TerminalSplitDirection = 'horizontal' | 'vertical'

export type TerminalLayoutPreset = 'single' | 'split-h' | 'split-v' | 'left-right2' | 'grid-2x2'

export type TerminalDropZone = 'top' | 'bottom' | 'left' | 'right' | 'center'

export interface TerminalShellOption {
  kind: TerminalShellKind
  label: string
  executable: string
  available: boolean
}

export type TerminalBlockStatus = 'running' | 'done' | 'error' | 'interrupted'

export interface TerminalBlock {
  id: string
  command: string
  cwd: string
  startedAt: number
  finishedAt?: number
  status: TerminalBlockStatus
  exitCode?: number
  stdout: string
  stderr: string
  truncated?: boolean
}

export interface TerminalSessionSummary {
  id: string
  title: string
  oscTitle?: string
  shell: TerminalShellKind
  mode: TerminalMode
  fallbackReason?: string
  cwd: string
  running: boolean
  blockCount: number
  cols?: number
  rows?: number
  exitCode?: number | null
  createdAt: number
}

export interface TerminalSessionSnapshot extends TerminalSessionSummary {
  blocks: TerminalBlock[]
  ptyBuffer?: string
  ptySeq?: number
}

export interface TerminalCreateOpts {
  shell?: TerminalShellKind
  mode?: TerminalMode
  colorScheme?: TerminalColorScheme
  cols?: number
  rows?: number
  cwd?: string
  title?: string
}

export interface TerminalLeafNode {
  type: 'leaf'
  paneId: string
  sessionId: string
}

export interface TerminalSplitNode {
  type: 'split'
  splitId: string
  direction: TerminalSplitDirection
  ratio: number
  first: TerminalLayoutNode
  second: TerminalLayoutNode
}

export type TerminalLayoutNode = TerminalLeafNode | TerminalSplitNode

export interface TerminalGroup {
  id: string
  name: string
  color: TerminalGroupColor
  defaultCwd?: string
  collapsed: boolean
  broadcastEnabled: boolean
  hasAlert: boolean
  layout: TerminalLayoutNode
  focusedPaneId: string
  zoomedPaneId: string | null
  sessionIds: string[]
  createdAt: number
}

export interface TerminalWorkspaceSnapshot {
  activeGroupId: string
  groups: TerminalGroup[]
  sessions: TerminalSessionSummary[]
}

export type TerminalProfileLayoutNode =
  | {
      type: 'leaf'
      shell: TerminalShellKind
      mode: TerminalMode
      cwd?: string
      title?: string
      startupCommand?: string
    }
  | {
      type: 'split'
      direction: TerminalSplitDirection
      ratio: number
      first: TerminalProfileLayoutNode
      second: TerminalProfileLayoutNode
    }

export interface TerminalWorkspaceProfile {
  id: string
  name: string
  color: TerminalGroupColor
  defaultCwd?: string
  layout: TerminalProfileLayoutNode
  createdAt: number
  updatedAt: number
}

export interface TerminalSaveProfileInput {
  groupId: string
  name: string
  startupCommandsBySessionId?: Record<string, string>
}

export interface TerminalCommandSnippet {
  id: string
  title: string
  command: string
  sendEnter: boolean
  createdAt: number
  updatedAt: number
}

export interface TerminalSaveSnippetInput {
  id?: string
  title: string
  command: string
  sendEnter: boolean
}

export type TerminalWorkspaceAction =
  | {
      type: 'create-group'
      name?: string
      color?: TerminalGroupColor
      defaultCwd?: string
      shell?: TerminalShellKind
      mode?: TerminalMode
      colorScheme?: TerminalColorScheme
      activate?: boolean
    }
  | { type: 'activate-group'; groupId: string }
  | {
      type: 'update-group'
      groupId: string
      name?: string
      color?: TerminalGroupColor
      defaultCwd?: string | null
      collapsed?: boolean
      broadcastEnabled?: boolean
    }
  | { type: 'close-group'; groupId: string }
  | {
      type: 'split-pane'
      groupId: string
      targetPaneId: string
      direction: TerminalSplitDirection
      position?: 'before' | 'after'
      sessionId?: string
      createOpts?: TerminalCreateOpts
    }
  | { type: 'close-pane'; groupId: string; paneId: string; killSessionIfUnused?: boolean }
  | { type: 'focus-pane'; groupId: string; paneId: string }
  | { type: 'zoom-pane'; groupId: string; paneId: string | null }
  | { type: 'resize-split'; groupId: string; splitId: string; ratio: number }
  | { type: 'swap-panes'; groupId: string; paneAId: string; paneBId: string }
  | {
      type: 'drop-pane'
      sourceGroupId: string
      sourcePaneId: string
      targetGroupId: string
      targetPaneId: string
      zone: TerminalDropZone
    }
  | {
      type: 'apply-preset'
      groupId: string
      preset: TerminalLayoutPreset
      defaultOpts?: TerminalCreateOpts
    }
  | {
      type: 'add-session-to-group'
      groupId: string
      opts?: TerminalCreateOpts
      replaceFocusedPane?: boolean
    }
  | {
      type: 'select-group-session'
      groupId: string
      sessionId: string
      targetPaneId?: string
    }
  | { type: 'move-session-to-group'; sessionId: string; targetGroupId: string }
  | { type: 'rename-session'; sessionId: string; title: string }
  | { type: 'set-session-osc-title'; sessionId: string; oscTitle: string }
  | { type: 'broadcast-write'; groupId: string; data: string }

export interface TerminalOpenTabOpts {
  sessionId?: string
}

export interface TerminalDrawerRequest {
  action: 'open' | 'close' | 'toggle'
  sessionId?: string
  path?: string
  createNew?: boolean
}

export interface TerminalAskAiPayload {
  command: string
  cwd: string
  exitCode: number
  output: string
}

export type TerminalEvent =
  | { type: 'session-created'; session: TerminalSessionSnapshot }
  | { type: 'session-updated'; session: TerminalSessionSummary }
  | { type: 'session-closed'; sessionId: string }
  | { type: 'session-cleared'; sessionId: string }
  | { type: 'block-started'; sessionId: string; block: TerminalBlock }
  | {
      type: 'block-output'
      sessionId: string
      blockId: string
      stream: 'stdout' | 'stderr'
      chunk: string
      truncated?: boolean
    }
  | {
      type: 'block-finished'
      sessionId: string
      blockId: string
      status: TerminalBlockStatus
      exitCode: number
      cwd: string
      finishedAt: number
    }
  | { type: 'pty-data'; sessionId: string; chunk: string; seq: number }
  | { type: 'pty-exit'; sessionId: string; exitCode: number; signal?: number }
  | { type: 'workspace-updated'; workspace: TerminalWorkspaceSnapshot }

export const TERMINAL_CHANNELS = {
  listShells: 'terminal:list-shells',
  listSessions: 'terminal:list-sessions',
  getSession: 'terminal:get-session',
  createSession: 'terminal:create-session',
  closeSession: 'terminal:close-session',
  runCommand: 'terminal:run-command',
  ptyWrite: 'terminal:pty-write',
  ptyResize: 'terminal:pty-resize',
  ptyRestart: 'terminal:pty-restart',
  interrupt: 'terminal:interrupt',
  clearSession: 'terminal:clear-session',
  pickCwd: 'terminal:pick-cwd',
  pickGroupCwd: 'terminal:pick-group-cwd',
  openTab: 'terminal:open-tab',
  dockToDrawer: 'terminal:dock-to-drawer',
  requestDrawer: 'terminal:request-drawer',
  drawerCommand: 'terminal:drawer-command',
  askAi: 'terminal:ask-ai',
  workspaceGet: 'terminal:workspace-get',
  workspaceAction: 'terminal:workspace-action',
  listProfiles: 'terminal:list-profiles',
  saveProfile: 'terminal:save-profile',
  deleteProfile: 'terminal:delete-profile',
  launchProfile: 'terminal:launch-profile',
  listSnippets: 'terminal:list-snippets',
  saveSnippet: 'terminal:save-snippet',
  deleteSnippet: 'terminal:delete-snippet',
  event: 'terminal:event',
  tabSessionUpdated: 'terminal:tab-session-updated',
} as const
