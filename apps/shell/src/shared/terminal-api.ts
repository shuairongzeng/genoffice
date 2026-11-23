export type TerminalShellKind = 'powershell' | 'cmd' | 'bash' | 'zsh' | 'sh'

export type TerminalMode = 'pty' | 'block'

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
  cols?: number
  rows?: number
  cwd?: string
  title?: string
}

export interface TerminalOpenTabOpts {
  sessionId?: string
}

export interface TerminalDrawerRequest {
  action: 'open' | 'close' | 'toggle'
  sessionId?: string
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
  openTab: 'terminal:open-tab',
  dockToDrawer: 'terminal:dock-to-drawer',
  requestDrawer: 'terminal:request-drawer',
  drawerCommand: 'terminal:drawer-command',
  askAi: 'terminal:ask-ai',
  event: 'terminal:event',
  tabSessionUpdated: 'terminal:tab-session-updated',
} as const
