import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  TERMINAL_CHANNELS,
  type TerminalAskAiPayload,
  type TerminalCreateOpts,
  type TerminalDrawerRequest,
  type TerminalMode,
  type TerminalOpenTabOpts,
  type TerminalShellKind,
} from '../../shared/terminal-api'
import type { TerminalSessionManager } from './terminal-session-manager'

const VALID_SHELL_KINDS = new Set<TerminalShellKind>(['powershell', 'cmd', 'bash', 'zsh', 'sh'])
const VALID_TERMINAL_MODES = new Set<TerminalMode>(['pty', 'block'])
const VALID_DRAWER_ACTIONS = new Set<TerminalDrawerRequest['action']>(['open', 'close', 'toggle'])

export interface TerminalIpcDeps {
  manager: TerminalSessionManager
  openTerminalTab: (opts?: TerminalOpenTabOpts) => string | Promise<string>
  dockToDrawer: (sessionId: string) => void | Promise<void>
  requestDrawer: (req: TerminalDrawerRequest) => void | Promise<void>
  pickDirectory: (defaultPath?: string) => Promise<string | null>
  askAi: (payload: TerminalAskAiPayload) => void | Promise<void>
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseSessionId(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('Invalid terminal session id')
  }
  return raw
}

function parseCommand(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('Invalid terminal command')
  }
  return raw
}

function parseCreateOpts(raw: unknown): TerminalCreateOpts | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!isPlainRecord(raw)) {
    throw new Error('Invalid terminal create options')
  }

  const opts: TerminalCreateOpts = {}
  if (raw.shell !== undefined) {
    if (typeof raw.shell !== 'string' || !VALID_SHELL_KINDS.has(raw.shell as TerminalShellKind)) {
      throw new Error('Invalid terminal shell kind')
    }
    opts.shell = raw.shell as TerminalShellKind
  }
  if (raw.mode !== undefined) {
    if (typeof raw.mode !== 'string' || !VALID_TERMINAL_MODES.has(raw.mode as TerminalMode)) {
      throw new Error('Invalid terminal mode')
    }
    opts.mode = raw.mode as TerminalMode
  }
  if (raw.cols !== undefined) {
    if (typeof raw.cols !== 'number' || !Number.isFinite(raw.cols)) {
      throw new Error('Invalid terminal cols')
    }
    opts.cols = Math.round(raw.cols)
  }
  if (raw.rows !== undefined) {
    if (typeof raw.rows !== 'number' || !Number.isFinite(raw.rows)) {
      throw new Error('Invalid terminal rows')
    }
    opts.rows = Math.round(raw.rows)
  }
  if (raw.cwd !== undefined) {
    if (typeof raw.cwd !== 'string') {
      throw new Error('Invalid terminal working directory')
    }
    if (raw.cwd.trim()) {
      opts.cwd = raw.cwd
    }
  }
  if (raw.title !== undefined) {
    if (typeof raw.title !== 'string') {
      throw new Error('Invalid terminal title')
    }
    if (raw.title.trim()) {
      opts.title = raw.title
    }
  }
  return opts
}

function parsePtyData(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new Error('Invalid PTY write payload')
  }
  return raw
}

function parsePtyDimension(raw: unknown, label: string): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new Error(`Invalid PTY ${label}`)
  }
  return Math.round(raw)
}

function parseOpenTabOpts(raw: unknown): TerminalOpenTabOpts | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!isPlainRecord(raw)) {
    throw new Error('Invalid terminal open-tab options')
  }
  if (raw.sessionId === undefined) return {}
  return { sessionId: parseSessionId(raw.sessionId) }
}

function parseDrawerRequest(raw: unknown): TerminalDrawerRequest {
  if (!isPlainRecord(raw)) {
    throw new Error('Invalid terminal drawer request')
  }
  if (
    typeof raw.action !== 'string' ||
    !VALID_DRAWER_ACTIONS.has(raw.action as TerminalDrawerRequest['action'])
  ) {
    throw new Error('Invalid terminal drawer action')
  }
  const req: TerminalDrawerRequest = {
    action: raw.action as TerminalDrawerRequest['action'],
  }
  if (raw.sessionId !== undefined) {
    req.sessionId = parseSessionId(raw.sessionId)
  }
  return req
}

function parseAskAiPayload(raw: unknown): TerminalAskAiPayload {
  if (!isPlainRecord(raw)) {
    throw new Error('Invalid terminal AI payload')
  }
  if (
    typeof raw.command !== 'string' ||
    typeof raw.cwd !== 'string' ||
    typeof raw.exitCode !== 'number' ||
    !Number.isFinite(raw.exitCode) ||
    typeof raw.output !== 'string'
  ) {
    throw new Error('Terminal AI payload requires command, cwd, exitCode, and output')
  }
  return {
    command: raw.command,
    cwd: raw.cwd,
    exitCode: raw.exitCode,
    output: raw.output,
  }
}

function registerIdempotentHandler(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, handler)
}

/**
 * Register idempotent main-process IPC invoke handlers for all terminal channels.
 */
export function registerTerminalIpc(deps: TerminalIpcDeps): void {
  registerIdempotentHandler(TERMINAL_CHANNELS.listShells, () => deps.manager.listShells())

  registerIdempotentHandler(TERMINAL_CHANNELS.listSessions, () => deps.manager.listSessions())

  registerIdempotentHandler(TERMINAL_CHANNELS.getSession, (_event, rawSessionId) =>
    deps.manager.getSession(parseSessionId(rawSessionId)),
  )

  registerIdempotentHandler(TERMINAL_CHANNELS.createSession, (_event, rawOpts) =>
    deps.manager.createSession(parseCreateOpts(rawOpts)),
  )

  registerIdempotentHandler(TERMINAL_CHANNELS.closeSession, (_event, rawSessionId) =>
    deps.manager.closeSession(parseSessionId(rawSessionId)),
  )

  registerIdempotentHandler(TERMINAL_CHANNELS.runCommand, (_event, rawSessionId, rawCommand) =>
    deps.manager.runCommand(parseSessionId(rawSessionId), parseCommand(rawCommand)),
  )

  registerIdempotentHandler(TERMINAL_CHANNELS.ptyWrite, (_event, rawSessionId, rawData) =>
    deps.manager.ptyWrite(parseSessionId(rawSessionId), parsePtyData(rawData)),
  )

  registerIdempotentHandler(TERMINAL_CHANNELS.ptyResize, (_event, rawSessionId, rawCols, rawRows) =>
    deps.manager.ptyResize(
      parseSessionId(rawSessionId),
      parsePtyDimension(rawCols, 'cols'),
      parsePtyDimension(rawRows, 'rows'),
    ),
  )

  registerIdempotentHandler(TERMINAL_CHANNELS.ptyRestart, (_event, rawSessionId) =>
    deps.manager.ptyRestart(parseSessionId(rawSessionId)),
  )

  registerIdempotentHandler(TERMINAL_CHANNELS.interrupt, (_event, rawSessionId) =>
    deps.manager.interrupt(parseSessionId(rawSessionId)),
  )

  registerIdempotentHandler(TERMINAL_CHANNELS.clearSession, (_event, rawSessionId) =>
    deps.manager.clearSession(parseSessionId(rawSessionId)),
  )

  registerIdempotentHandler(TERMINAL_CHANNELS.pickCwd, async (_event, rawSessionId) => {
    const sessionId = parseSessionId(rawSessionId)
    const session = deps.manager.getSession(sessionId)
    if (!session) {
      throw new Error(`Terminal session not found: ${sessionId}`)
    }
    const picked = await deps.pickDirectory(session.cwd)
    if (!picked) return null
    return deps.manager.setCwd(sessionId, picked)
  })

  registerIdempotentHandler(TERMINAL_CHANNELS.openTab, (_event, rawOpts) =>
    deps.openTerminalTab(parseOpenTabOpts(rawOpts)),
  )

  registerIdempotentHandler(TERMINAL_CHANNELS.dockToDrawer, (_event, rawSessionId) =>
    deps.dockToDrawer(parseSessionId(rawSessionId)),
  )

  registerIdempotentHandler(TERMINAL_CHANNELS.requestDrawer, (_event, rawReq) =>
    deps.requestDrawer(parseDrawerRequest(rawReq)),
  )

  registerIdempotentHandler(TERMINAL_CHANNELS.askAi, (_event, rawPayload) =>
    deps.askAi(parseAskAiPayload(rawPayload)),
  )
}
