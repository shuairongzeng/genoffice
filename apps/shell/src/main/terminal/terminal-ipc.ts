import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  TERMINAL_CHANNELS,
  type TerminalAskAiPayload,
  type TerminalColorScheme,
  type TerminalCreateOpts,
  type TerminalDrawerRequest,
  type TerminalDropZone,
  type TerminalGroupColor,
  type TerminalLayoutPreset,
  type TerminalMode,
  type TerminalOpenTabOpts,
  type TerminalSaveProfileInput,
  type TerminalSaveSnippetInput,
  type TerminalShellKind,
  type TerminalSplitDirection,
  type TerminalWorkspaceAction,
} from '../../shared/terminal-api'
import type { TerminalSessionManager } from './terminal-session-manager'
import type { TerminalWorkspaceManager } from './terminal-workspace-manager'

const VALID_SHELL_KINDS = new Set<TerminalShellKind>(['powershell', 'cmd', 'bash', 'zsh', 'sh'])
const VALID_TERMINAL_MODES = new Set<TerminalMode>(['pty', 'block'])
const VALID_COLOR_SCHEMES = new Set<TerminalColorScheme>(['dark', 'light'])
const VALID_DRAWER_ACTIONS = new Set<TerminalDrawerRequest['action']>(['open', 'close', 'toggle'])
const VALID_GROUP_COLORS = new Set<TerminalGroupColor>([
  'blue',
  'emerald',
  'amber',
  'purple',
  'rose',
  'slate',
])
const VALID_SPLIT_DIRECTIONS = new Set<TerminalSplitDirection>(['horizontal', 'vertical'])
const VALID_LAYOUT_PRESETS = new Set<TerminalLayoutPreset>([
  'single',
  'split-h',
  'split-v',
  'left-right2',
  'grid-2x2',
])
const VALID_DROP_ZONES = new Set<TerminalDropZone>(['top', 'bottom', 'left', 'right', 'center'])

export interface TerminalIpcDeps {
  manager: TerminalSessionManager
  workspace: TerminalWorkspaceManager
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
  if (raw.colorScheme !== undefined) {
    if (
      typeof raw.colorScheme !== 'string' ||
      !VALID_COLOR_SCHEMES.has(raw.colorScheme as TerminalColorScheme)
    ) {
      throw new Error('Invalid terminal colorScheme')
    }
    opts.colorScheme = raw.colorScheme as TerminalColorScheme
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
  if (raw.path !== undefined) {
    if (typeof raw.path !== 'string') {
      throw new Error('Invalid terminal drawer path')
    }
    if (raw.path.trim()) {
      req.path = raw.path
    }
  }
  if (raw.createNew !== undefined) {
    if (typeof raw.createNew !== 'boolean') {
      throw new Error('Invalid terminal drawer createNew flag')
    }
    req.createNew = raw.createNew
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

function parseNonEmptyId(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(`Invalid terminal ${label}`)
  }
  return raw
}

function parseGroupColor(raw: unknown): TerminalGroupColor {
  if (typeof raw !== 'string' || !VALID_GROUP_COLORS.has(raw as TerminalGroupColor)) {
    throw new Error('Invalid terminal group color')
  }
  return raw as TerminalGroupColor
}

function parseSplitDirection(raw: unknown): TerminalSplitDirection {
  if (typeof raw !== 'string' || !VALID_SPLIT_DIRECTIONS.has(raw as TerminalSplitDirection)) {
    throw new Error('Invalid terminal split direction')
  }
  return raw as TerminalSplitDirection
}

function parseOptionalString(raw: unknown, label: string): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'string') throw new Error(`Invalid terminal ${label}`)
  return raw
}

function parseOptionalBool(raw: unknown, label: string): boolean | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'boolean') throw new Error(`Invalid terminal ${label}`)
  return raw
}

function parseWorkspaceAction(raw: unknown): TerminalWorkspaceAction {
  if (!isPlainRecord(raw) || typeof raw.type !== 'string') {
    throw new Error('Invalid terminal workspace action')
  }
  switch (raw.type) {
    case 'create-group': {
      const name = parseOptionalString(raw.name, 'group name')
      const defaultCwd = parseOptionalString(raw.defaultCwd, 'group defaultCwd')
      const color = raw.color !== undefined ? parseGroupColor(raw.color) : undefined
      const activate = parseOptionalBool(raw.activate, 'activate flag')
      let shell: TerminalShellKind | undefined
      if (raw.shell !== undefined) {
        if (
          typeof raw.shell !== 'string' ||
          !VALID_SHELL_KINDS.has(raw.shell as TerminalShellKind)
        ) {
          throw new Error('Invalid terminal shell kind')
        }
        shell = raw.shell as TerminalShellKind
      }
      let mode: TerminalMode | undefined
      if (raw.mode !== undefined) {
        if (typeof raw.mode !== 'string' || !VALID_TERMINAL_MODES.has(raw.mode as TerminalMode)) {
          throw new Error('Invalid terminal mode')
        }
        mode = raw.mode as TerminalMode
      }
      let colorScheme: TerminalColorScheme | undefined
      if (raw.colorScheme !== undefined) {
        if (
          typeof raw.colorScheme !== 'string' ||
          !VALID_COLOR_SCHEMES.has(raw.colorScheme as TerminalColorScheme)
        ) {
          throw new Error('Invalid terminal colorScheme')
        }
        colorScheme = raw.colorScheme as TerminalColorScheme
      }
      return {
        type: 'create-group',
        ...(name !== undefined ? { name } : {}),
        ...(color !== undefined ? { color } : {}),
        ...(defaultCwd !== undefined ? { defaultCwd } : {}),
        ...(shell !== undefined ? { shell } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(colorScheme !== undefined ? { colorScheme } : {}),
        ...(activate !== undefined ? { activate } : {}),
      }
    }
    case 'activate-group':
      return { type: 'activate-group', groupId: parseNonEmptyId(raw.groupId, 'groupId') }
    case 'update-group': {
      const name = parseOptionalString(raw.name, 'group name')
      const color = raw.color !== undefined ? parseGroupColor(raw.color) : undefined
      let defaultCwd: string | null | undefined
      if (raw.defaultCwd !== undefined) {
        if (raw.defaultCwd !== null && typeof raw.defaultCwd !== 'string') {
          throw new Error('Invalid terminal group defaultCwd')
        }
        defaultCwd = raw.defaultCwd
      }
      const collapsed = parseOptionalBool(raw.collapsed, 'collapsed flag')
      const broadcastEnabled = parseOptionalBool(raw.broadcastEnabled, 'broadcast flag')
      return {
        type: 'update-group',
        groupId: parseNonEmptyId(raw.groupId, 'groupId'),
        ...(name !== undefined ? { name } : {}),
        ...(color !== undefined ? { color } : {}),
        ...(defaultCwd !== undefined ? { defaultCwd } : {}),
        ...(collapsed !== undefined ? { collapsed } : {}),
        ...(broadcastEnabled !== undefined ? { broadcastEnabled } : {}),
      }
    }
    case 'close-group':
      return { type: 'close-group', groupId: parseNonEmptyId(raw.groupId, 'groupId') }
    case 'split-pane': {
      let position: 'before' | 'after' | undefined
      if (raw.position !== undefined) {
        if (raw.position !== 'before' && raw.position !== 'after') {
          throw new Error('Invalid split position')
        }
        position = raw.position
      }
      return {
        type: 'split-pane',
        groupId: parseNonEmptyId(raw.groupId, 'groupId'),
        targetPaneId: parseNonEmptyId(raw.targetPaneId, 'targetPaneId'),
        direction: parseSplitDirection(raw.direction),
        ...(position ? { position } : {}),
        ...(raw.sessionId !== undefined ? { sessionId: parseSessionId(raw.sessionId) } : {}),
        ...(raw.createOpts !== undefined ? { createOpts: parseCreateOpts(raw.createOpts) } : {}),
      }
    }
    case 'close-pane':
      return {
        type: 'close-pane',
        groupId: parseNonEmptyId(raw.groupId, 'groupId'),
        paneId: parseNonEmptyId(raw.paneId, 'paneId'),
        ...(raw.killSessionIfUnused !== undefined
          ? { killSessionIfUnused: parseOptionalBool(raw.killSessionIfUnused, 'kill flag') }
          : {}),
      }
    case 'focus-pane':
      return {
        type: 'focus-pane',
        groupId: parseNonEmptyId(raw.groupId, 'groupId'),
        paneId: parseNonEmptyId(raw.paneId, 'paneId'),
      }
    case 'zoom-pane':
      return {
        type: 'zoom-pane',
        groupId: parseNonEmptyId(raw.groupId, 'groupId'),
        paneId: raw.paneId === null ? null : parseNonEmptyId(raw.paneId, 'paneId'),
      }
    case 'resize-split': {
      if (typeof raw.ratio !== 'number' || !Number.isFinite(raw.ratio)) {
        throw new Error('Invalid split ratio')
      }
      return {
        type: 'resize-split',
        groupId: parseNonEmptyId(raw.groupId, 'groupId'),
        splitId: parseNonEmptyId(raw.splitId, 'splitId'),
        ratio: raw.ratio,
      }
    }
    case 'swap-panes':
      return {
        type: 'swap-panes',
        groupId: parseNonEmptyId(raw.groupId, 'groupId'),
        paneAId: parseNonEmptyId(raw.paneAId, 'paneAId'),
        paneBId: parseNonEmptyId(raw.paneBId, 'paneBId'),
      }
    case 'drop-pane': {
      if (typeof raw.zone !== 'string' || !VALID_DROP_ZONES.has(raw.zone as TerminalDropZone)) {
        throw new Error('Invalid drop zone')
      }
      return {
        type: 'drop-pane',
        sourceGroupId: parseNonEmptyId(raw.sourceGroupId, 'sourceGroupId'),
        sourcePaneId: parseNonEmptyId(raw.sourcePaneId, 'sourcePaneId'),
        targetGroupId: parseNonEmptyId(raw.targetGroupId, 'targetGroupId'),
        targetPaneId: parseNonEmptyId(raw.targetPaneId, 'targetPaneId'),
        zone: raw.zone as TerminalDropZone,
      }
    }
    case 'apply-preset': {
      if (
        typeof raw.preset !== 'string' ||
        !VALID_LAYOUT_PRESETS.has(raw.preset as TerminalLayoutPreset)
      ) {
        throw new Error('Invalid layout preset')
      }
      return {
        type: 'apply-preset',
        groupId: parseNonEmptyId(raw.groupId, 'groupId'),
        preset: raw.preset as TerminalLayoutPreset,
        ...(raw.defaultOpts !== undefined ? { defaultOpts: parseCreateOpts(raw.defaultOpts) } : {}),
      }
    }
    case 'add-session-to-group':
      return {
        type: 'add-session-to-group',
        groupId: parseNonEmptyId(raw.groupId, 'groupId'),
        ...(raw.opts !== undefined ? { opts: parseCreateOpts(raw.opts) } : {}),
        ...(raw.replaceFocusedPane !== undefined
          ? { replaceFocusedPane: parseOptionalBool(raw.replaceFocusedPane, 'replaceFocusedPane') }
          : {}),
      }
    case 'select-group-session':
      return {
        type: 'select-group-session',
        groupId: parseNonEmptyId(raw.groupId, 'groupId'),
        sessionId: parseSessionId(raw.sessionId),
        ...(raw.targetPaneId !== undefined
          ? { targetPaneId: parseNonEmptyId(raw.targetPaneId, 'targetPaneId') }
          : {}),
      }
    case 'move-session-to-group':
      return {
        type: 'move-session-to-group',
        sessionId: parseSessionId(raw.sessionId),
        targetGroupId: parseNonEmptyId(raw.targetGroupId, 'targetGroupId'),
      }
    case 'rename-session': {
      if (typeof raw.title !== 'string') {
        throw new Error('Invalid session title')
      }
      return {
        type: 'rename-session',
        sessionId: parseSessionId(raw.sessionId),
        title: raw.title,
      }
    }
    case 'set-session-osc-title': {
      if (typeof raw.oscTitle !== 'string') {
        throw new Error('Invalid session oscTitle')
      }
      return {
        type: 'set-session-osc-title',
        sessionId: parseSessionId(raw.sessionId),
        oscTitle: raw.oscTitle,
      }
    }
    case 'broadcast-write': {
      if (typeof raw.data !== 'string') {
        throw new Error('Invalid broadcast payload')
      }
      return {
        type: 'broadcast-write',
        groupId: parseNonEmptyId(raw.groupId, 'groupId'),
        data: raw.data,
      }
    }
    default:
      throw new Error(`Unsupported workspace action: ${raw.type}`)
  }
}

function parseSaveProfileInput(raw: unknown): TerminalSaveProfileInput {
  if (!isPlainRecord(raw)) {
    throw new Error('Invalid terminal save profile payload')
  }
  const groupId = parseNonEmptyId(raw.groupId, 'groupId')
  const name = parseNonEmptyId(raw.name, 'profile name')
  let startupCommandsBySessionId: Record<string, string> | undefined
  if (raw.startupCommandsBySessionId !== undefined) {
    if (!isPlainRecord(raw.startupCommandsBySessionId)) {
      throw new Error('Invalid profile startup commands map')
    }
    startupCommandsBySessionId = {}
    for (const [k, v] of Object.entries(raw.startupCommandsBySessionId)) {
      if (typeof v !== 'string') {
        throw new Error('Invalid startup command value')
      }
      startupCommandsBySessionId[k] = v
    }
  }
  return {
    groupId,
    name,
    ...(startupCommandsBySessionId ? { startupCommandsBySessionId } : {}),
  }
}

function parseSaveSnippetInput(raw: unknown): TerminalSaveSnippetInput {
  if (!isPlainRecord(raw)) {
    throw new Error('Invalid terminal save snippet payload')
  }
  const id = raw.id !== undefined ? parseNonEmptyId(raw.id, 'snippet id') : undefined
  const title = parseNonEmptyId(raw.title, 'snippet title')
  const command = parseNonEmptyId(raw.command, 'snippet command')
  if (typeof raw.sendEnter !== 'boolean') {
    throw new Error('Invalid snippet sendEnter flag')
  }
  return {
    ...(id ? { id } : {}),
    title,
    command,
    sendEnter: raw.sendEnter,
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

  registerIdempotentHandler(TERMINAL_CHANNELS.pickGroupCwd, async (_event, rawGroupId) => {
    const groupId = parseNonEmptyId(rawGroupId, 'groupId')
    const snapshot = deps.workspace.getSnapshot()
    const group = snapshot.groups.find((g) => g.id === groupId)
    if (!group) {
      throw new Error(`Terminal group not found: ${groupId}`)
    }
    const firstSessionId = group.sessionIds[0]
    const fallbackCwd = firstSessionId ? deps.manager.getSession(firstSessionId)?.cwd : undefined
    const picked = await deps.pickDirectory(group.defaultCwd ?? fallbackCwd)
    if (!picked) return null
    return deps.workspace.updateGroupDefaultCwd(groupId, picked)
  })

  registerIdempotentHandler(TERMINAL_CHANNELS.workspaceGet, () => deps.workspace.getSnapshot())

  registerIdempotentHandler(TERMINAL_CHANNELS.workspaceAction, (_event, rawAction) =>
    deps.workspace.dispatch(parseWorkspaceAction(rawAction)),
  )

  registerIdempotentHandler(TERMINAL_CHANNELS.listProfiles, () => deps.workspace.listProfiles())

  registerIdempotentHandler(TERMINAL_CHANNELS.saveProfile, (_event, rawInput) =>
    deps.workspace.saveProfileFromGroup(parseSaveProfileInput(rawInput)),
  )

  registerIdempotentHandler(TERMINAL_CHANNELS.deleteProfile, (_event, rawProfileId) => {
    deps.workspace.deleteProfile(parseNonEmptyId(rawProfileId, 'profileId'))
  })

  registerIdempotentHandler(TERMINAL_CHANNELS.launchProfile, (_event, rawProfileId) =>
    deps.workspace.launchProfile(parseNonEmptyId(rawProfileId, 'profileId')),
  )

  registerIdempotentHandler(TERMINAL_CHANNELS.listSnippets, () => deps.workspace.listSnippets())

  registerIdempotentHandler(TERMINAL_CHANNELS.saveSnippet, (_event, rawInput) =>
    deps.workspace.saveSnippet(parseSaveSnippetInput(rawInput)),
  )

  registerIdempotentHandler(TERMINAL_CHANNELS.deleteSnippet, (_event, rawSnippetId) => {
    deps.workspace.deleteSnippet(parseNonEmptyId(rawSnippetId, 'snippetId'))
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
