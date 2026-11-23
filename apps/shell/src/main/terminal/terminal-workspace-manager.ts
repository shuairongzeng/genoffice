import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type {
  TerminalCommandSnippet,
  TerminalCreateOpts,
  TerminalEvent,
  TerminalGroup,
  TerminalGroupColor,
  TerminalLayoutNode,
  TerminalProfileLayoutNode,
  TerminalSaveProfileInput,
  TerminalSaveSnippetInput,
  TerminalSessionSummary,
  TerminalWorkspaceAction,
  TerminalWorkspaceProfile,
  TerminalWorkspaceSnapshot,
} from '../../shared/terminal-api'
import {
  buildPresetLayout,
  collectLeafPanes,
  collectSessionIds,
  countLeafPanes,
  createLeaf,
  findLeafByPaneId,
  findLeafBySessionId,
  movePaneToDropTarget,
  removeLeafPane,
  removeSessionFromLayout,
  replacePaneSession,
  requiredPanesForPreset,
  splitLeafPane,
  swapPaneSessions,
  updateSplitRatio,
  type LayoutIdGenerator,
} from '../../shared/terminal-layout'
import type { TerminalPersistence } from './terminal-persistence'
import type { TerminalSessionManager } from './terminal-session-manager'

const GROUP_COLORS: readonly TerminalGroupColor[] = [
  'blue',
  'emerald',
  'amber',
  'purple',
  'rose',
  'slate',
]

function cloneNode(node: TerminalLayoutNode): TerminalLayoutNode {
  if (node.type === 'leaf') {
    return { ...node }
  }
  return {
    ...node,
    first: cloneNode(node.first),
    second: cloneNode(node.second),
  }
}

function cloneGroup(group: TerminalGroup): TerminalGroup {
  return {
    ...group,
    layout: cloneNode(group.layout),
    sessionIds: [...group.sessionIds],
  }
}

function isValidDir(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory()
  } catch {
    return false
  }
}

function toProfileLayoutNode(
  node: TerminalLayoutNode,
  sessionsById: Map<string, TerminalSessionSummary>,
  startupCommandsBySessionId?: Record<string, string>,
): TerminalProfileLayoutNode {
  if (node.type === 'leaf') {
    const summary = sessionsById.get(node.sessionId)
    const cmd = startupCommandsBySessionId?.[node.sessionId]?.trim()
    return {
      type: 'leaf',
      shell: summary?.shell ?? 'powershell',
      mode: summary?.mode ?? 'pty',
      ...(summary?.cwd ? { cwd: summary.cwd } : {}),
      ...(summary?.title ? { title: summary.title } : {}),
      ...(cmd ? { startupCommand: cmd } : {}),
    }
  }
  return {
    type: 'split',
    direction: node.direction,
    ratio: node.ratio,
    first: toProfileLayoutNode(node.first, sessionsById, startupCommandsBySessionId),
    second: toProfileLayoutNode(node.second, sessionsById, startupCommandsBySessionId),
  }
}

export interface TerminalWorkspaceManagerOptions {
  sessionManager: TerminalSessionManager
  persistence: TerminalPersistence
  emit: (event: TerminalEvent) => void
  defaultGroupName?: string
}

/**
 * Coordinates terminal session groups, arbitrary recursive split trees,
 * cross-view drawer/tab state sync, broadcast writes, profiles, and snippets.
 */
export class TerminalWorkspaceManager {
  private readonly sessionManager: TerminalSessionManager
  private readonly persistence: TerminalPersistence
  private readonly emit: (event: TerminalEvent) => void
  private readonly defaultGroupName: string
  private readonly idGen: LayoutIdGenerator
  private readonly unsubscribeSessionEvents: () => void

  private groups: TerminalGroup[] = []
  private activeGroupId = ''
  private groupSeq = 0
  private paneSeq = 0
  private splitSeq = 0
  private internalCreateDepth = 0
  private internalCloseIds = new Set<string>()
  private disposed = false

  constructor(options: TerminalWorkspaceManagerOptions) {
    this.sessionManager = options.sessionManager
    this.persistence = options.persistence
    this.emit = options.emit
    this.defaultGroupName = options.defaultGroupName ?? 'Workspace'
    this.idGen = {
      nextPaneId: () => `pane-${++this.paneSeq}`,
      nextSplitId: () => `split-${++this.splitSeq}`,
    }

    this.unsubscribeSessionEvents = this.sessionManager.onEvent((event) => {
      this.handleManagerEvent(event)
    })
  }

  getSnapshot(): TerminalWorkspaceSnapshot {
    this.ensureInitialized()
    return this.buildSnapshot()
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribeSessionEvents()
  }

  updateGroupDefaultCwd(groupId: string, dir: string): TerminalWorkspaceSnapshot {
    this.ensureInitialized()
    const group = this.requireGroup(groupId)
    if (!dir || !isValidDir(dir)) {
      throw new Error(`Directory does not exist: ${dir}`)
    }
    group.defaultCwd = path.resolve(dir)
    return this.publishWorkspace()
  }

  /**
   * Open a new terminal session in the resolved directory for a path (directory itself or
   * parent folder of a file, falling back to defaultCwd), ensuring cold startup creates
   * only that target session without spawning a redundant default session first.
   */
  openInDirectory(targetPath?: string): {
    workspace: TerminalWorkspaceSnapshot
    sessionId: string
  } {
    const dir = this.resolveTargetDirectory(targetPath)
    if (this.groups.length === 0) {
      const group = this.createGroupInternal({
        name: `${this.defaultGroupName} 1`,
        defaultCwd: dir,
        mode: 'pty',
        activate: true,
      })
      const workspace = this.publishWorkspace()
      return { workspace, sessionId: group.sessionIds[0]! }
    }

    const group = this.groups.find((g) => g.id === this.activeGroupId) ?? this.groups[0]!
    const spawned = this.createManagedSession({ mode: 'pty', cwd: dir })
    group.sessionIds.push(spawned.id)

    const targetLeaf =
      findLeafByPaneId(group.layout, group.focusedPaneId) ?? collectLeafPanes(group.layout)[0]
    if (targetLeaf) {
      group.focusedPaneId = targetLeaf.paneId
      group.layout = replacePaneSession(group.layout, targetLeaf.paneId, spawned.id)
    } else {
      const leaf = createLeaf(this.idGen.nextPaneId(), spawned.id)
      group.layout = leaf
      group.focusedPaneId = leaf.paneId
    }
    group.zoomedPaneId = null
    this.activeGroupId = group.id
    group.hasAlert = false

    const workspace = this.publishWorkspace()
    return { workspace, sessionId: spawned.id }
  }

  private resolveTargetDirectory(targetPath?: string): string {
    const trimmed = targetPath?.trim()
    if (trimmed) {
      try {
        const resolved = path.resolve(trimmed)
        const stat = fs.statSync(resolved)
        if (stat.isDirectory()) return resolved
        const parent = path.dirname(resolved)
        if (isValidDir(parent)) return parent
      } catch {
        // Fall through to default workspace directory when path is inaccessible.
      }
    }
    return this.sessionManager.defaultCwd()
  }

  dispatch(action: TerminalWorkspaceAction): TerminalWorkspaceSnapshot {
    this.ensureInitialized()

    switch (action.type) {
      case 'create-group': {
        this.createGroupInternal({
          name: action.name,
          color: action.color,
          defaultCwd: action.defaultCwd,
          shell: action.shell,
          mode: action.mode,
          colorScheme: action.colorScheme,
          activate: action.activate ?? true,
        })
        return this.publishWorkspace()
      }

      case 'activate-group': {
        const group = this.requireGroup(action.groupId)
        this.activeGroupId = group.id
        group.hasAlert = false
        return this.publishWorkspace()
      }

      case 'update-group': {
        const group = this.requireGroup(action.groupId)
        if (action.name !== undefined && action.name.trim()) {
          group.name = action.name.trim()
        }
        if (action.color !== undefined && GROUP_COLORS.includes(action.color)) {
          group.color = action.color
        }
        if (action.defaultCwd !== undefined) {
          if (action.defaultCwd === null || !action.defaultCwd.trim()) {
            delete group.defaultCwd
          } else if (isValidDir(action.defaultCwd)) {
            group.defaultCwd = path.resolve(action.defaultCwd)
          }
        }
        if (action.collapsed !== undefined) {
          group.collapsed = Boolean(action.collapsed)
        }
        if (action.broadcastEnabled !== undefined) {
          group.broadcastEnabled = Boolean(action.broadcastEnabled)
        }
        return this.publishWorkspace()
      }

      case 'close-group': {
        this.closeGroupInternal(action.groupId)
        return this.publishWorkspace()
      }

      case 'split-pane': {
        const group = this.requireGroup(action.groupId)
        const targetLeaf = findLeafByPaneId(group.layout, action.targetPaneId)
        if (!targetLeaf) {
          throw new Error(`Pane not found in group ${group.id}: ${action.targetPaneId}`)
        }

        const existingSessions = new Map(this.sessionManager.listSessions().map((s) => [s.id, s]))
        let childSessionId = action.sessionId
        if (!childSessionId || !existingSessions.has(childSessionId)) {
          const targetSummary = existingSessions.get(targetLeaf.sessionId)
          const spawned = this.createManagedSession({
            shell: action.createOpts?.shell ?? targetSummary?.shell,
            mode: action.createOpts?.mode ?? targetSummary?.mode,
            cwd: action.createOpts?.cwd ?? targetSummary?.cwd ?? group.defaultCwd,
            cols: action.createOpts?.cols,
            rows: action.createOpts?.rows,
            title: action.createOpts?.title,
          })
          childSessionId = spawned.id
        }

        if (!group.sessionIds.includes(childSessionId)) {
          group.sessionIds.push(childSessionId)
        }

        const newLeaf = createLeaf(this.idGen.nextPaneId(), childSessionId)
        const splitRes = splitLeafPane(
          group.layout,
          action.targetPaneId,
          newLeaf,
          this.idGen.nextSplitId(),
          action.direction,
          action.position ?? 'after',
        )
        if (splitRes.inserted) {
          group.layout = splitRes.node
          group.focusedPaneId = newLeaf.paneId
          group.zoomedPaneId = null
        }
        return this.publishWorkspace()
      }

      case 'close-pane': {
        const group = this.requireGroup(action.groupId)
        const targetLeaf = findLeafByPaneId(group.layout, action.paneId)
        if (!targetLeaf) return this.buildSnapshot()

        const leafCount = countLeafPanes(group.layout)
        if (leafCount <= 1) {
          // Closing the final pane of a group removes the group cleanly when others exist,
          // or replaces the single session cleanly when it's the final group.
          this.closeSessionManaged(targetLeaf.sessionId)
          return this.publishWorkspace()
        }

        const nextLayout = removeLeafPane(group.layout, action.paneId)
        if (nextLayout) {
          group.layout = nextLayout
          this.reconcileGroupPointers(group)
          const stillVisible = collectSessionIds(group.layout).includes(targetLeaf.sessionId)
          if (!stillVisible && action.killSessionIfUnused !== false) {
            group.sessionIds = group.sessionIds.filter((id) => id !== targetLeaf.sessionId)
            if (!this.isSessionReferencedElsewhere(targetLeaf.sessionId, group.id)) {
              this.closeSessionManaged(targetLeaf.sessionId)
            }
          }
        }
        return this.publishWorkspace()
      }

      case 'focus-pane': {
        const group = this.requireGroup(action.groupId)
        if (findLeafByPaneId(group.layout, action.paneId)) {
          group.focusedPaneId = action.paneId
        }
        return this.publishWorkspace()
      }

      case 'zoom-pane': {
        const group = this.requireGroup(action.groupId)
        if (action.paneId === null) {
          group.zoomedPaneId = null
        } else if (findLeafByPaneId(group.layout, action.paneId)) {
          group.zoomedPaneId = action.paneId
          group.focusedPaneId = action.paneId
        }
        return this.publishWorkspace()
      }

      case 'resize-split': {
        const group = this.requireGroup(action.groupId)
        group.layout = updateSplitRatio(group.layout, action.splitId, action.ratio)
        return this.publishWorkspace()
      }

      case 'swap-panes': {
        const group = this.requireGroup(action.groupId)
        group.layout = swapPaneSessions(group.layout, action.paneAId, action.paneBId)
        return this.publishWorkspace()
      }

      case 'drop-pane': {
        const sourceGroup = this.requireGroup(action.sourceGroupId)
        const targetGroup = this.requireGroup(action.targetGroupId)

        if (sourceGroup.id === targetGroup.id) {
          const moved = movePaneToDropTarget(
            sourceGroup.layout,
            action.sourcePaneId,
            action.targetPaneId,
            action.zone,
            () => this.idGen.nextSplitId(),
          )
          if (moved.changed) {
            sourceGroup.layout = moved.node
            sourceGroup.focusedPaneId = action.sourcePaneId
            sourceGroup.zoomedPaneId = null
          }
          return this.publishWorkspace()
        }

        const sourceLeaf = findLeafByPaneId(sourceGroup.layout, action.sourcePaneId)
        const targetLeaf = findLeafByPaneId(targetGroup.layout, action.targetPaneId)
        if (!sourceLeaf || !targetLeaf) return this.buildSnapshot()

        const movedSessionId = sourceLeaf.sessionId
        if (!targetGroup.sessionIds.includes(movedSessionId)) {
          targetGroup.sessionIds.push(movedSessionId)
        }
        sourceGroup.sessionIds = sourceGroup.sessionIds.filter((id) => id !== movedSessionId)

        // Prune source pane from source group (closing source group if it now has zero sessions).
        const nextSourceLayout = removeLeafPane(sourceGroup.layout, action.sourcePaneId)
        if (nextSourceLayout) {
          sourceGroup.layout = nextSourceLayout
          this.reconcileGroupPointers(sourceGroup)
        } else if (sourceGroup.sessionIds.length > 0) {
          sourceGroup.layout = createLeaf(this.idGen.nextPaneId(), sourceGroup.sessionIds[0]!)
          this.reconcileGroupPointers(sourceGroup)
        } else {
          this.groups = this.groups.filter((g) => g.id !== sourceGroup.id)
        }

        if (action.zone === 'center') {
          targetGroup.layout = replacePaneSession(
            targetGroup.layout,
            action.targetPaneId,
            movedSessionId,
          )
          targetGroup.focusedPaneId = action.targetPaneId
        } else {
          const direction =
            action.zone === 'left' || action.zone === 'right' ? 'horizontal' : 'vertical'
          const position = action.zone === 'left' || action.zone === 'top' ? 'before' : 'after'
          const newLeaf = createLeaf(this.idGen.nextPaneId(), movedSessionId)
          const res = splitLeafPane(
            targetGroup.layout,
            action.targetPaneId,
            newLeaf,
            this.idGen.nextSplitId(),
            direction,
            position,
          )
          if (res.inserted) {
            targetGroup.layout = res.node
            targetGroup.focusedPaneId = newLeaf.paneId
          }
        }
        targetGroup.zoomedPaneId = null
        this.activeGroupId = targetGroup.id
        targetGroup.hasAlert = false
        return this.publishWorkspace()
      }

      case 'apply-preset': {
        const group = this.requireGroup(action.groupId)
        const needed = requiredPanesForPreset(action.preset)
        const focusedLeaf = findLeafByPaneId(group.layout, group.focusedPaneId)
        const focusedSessionId = focusedLeaf?.sessionId

        const visibleOrder = collectSessionIds(group.layout)
        const orderedPool: string[] = [
          ...visibleOrder,
          ...group.sessionIds.filter((id) => !visibleOrder.includes(id)),
        ]

        // When collapsing to single view, prioritize keeping the focused session visible.
        if (
          action.preset === 'single' &&
          focusedSessionId &&
          orderedPool.includes(focusedSessionId)
        ) {
          orderedPool.splice(orderedPool.indexOf(focusedSessionId), 1)
          orderedPool.unshift(focusedSessionId)
        }

        while (orderedPool.length < needed) {
          const spawned = this.createManagedSession({
            shell: action.defaultOpts?.shell,
            mode: action.defaultOpts?.mode ?? 'pty',
            cwd: action.defaultOpts?.cwd ?? group.defaultCwd,
          })
          orderedPool.push(spawned.id)
          group.sessionIds.push(spawned.id)
        }

        group.layout = buildPresetLayout(action.preset, orderedPool.slice(0, needed), this.idGen)
        group.zoomedPaneId = null
        const matchingFocused = focusedSessionId
          ? findLeafBySessionId(group.layout, focusedSessionId)
          : null
        const firstLeaf = collectLeafPanes(group.layout)[0]!
        group.focusedPaneId = matchingFocused?.paneId ?? firstLeaf.paneId
        return this.publishWorkspace()
      }

      case 'add-session-to-group': {
        const group = this.requireGroup(action.groupId)
        const spawned = this.createManagedSession({
          ...action.opts,
          cwd: action.opts?.cwd ?? group.defaultCwd,
        })
        group.sessionIds.push(spawned.id)
        if (action.replaceFocusedPane !== false) {
          group.layout = replacePaneSession(group.layout, group.focusedPaneId, spawned.id)
          group.zoomedPaneId = null
        }
        return this.publishWorkspace()
      }

      case 'select-group-session': {
        const group = this.requireGroup(action.groupId)
        if (!group.sessionIds.includes(action.sessionId)) {
          const exists = this.sessionManager.getSession(action.sessionId)
          if (!exists) return this.buildSnapshot()
          group.sessionIds.push(action.sessionId)
        }

        const existingLeaf = findLeafBySessionId(group.layout, action.sessionId)
        if (existingLeaf) {
          group.focusedPaneId = existingLeaf.paneId
          return this.publishWorkspace()
        }

        const targetPaneId = action.targetPaneId ?? group.focusedPaneId
        if (findLeafByPaneId(group.layout, targetPaneId)) {
          group.layout = replacePaneSession(group.layout, targetPaneId, action.sessionId)
          group.focusedPaneId = targetPaneId
          group.zoomedPaneId = null
        }
        return this.publishWorkspace()
      }

      case 'move-session-to-group': {
        const targetGroup = this.requireGroup(action.targetGroupId)
        if (!this.sessionManager.getSession(action.sessionId)) {
          return this.buildSnapshot()
        }
        const sourceGroup = this.groups.find((g) => g.sessionIds.includes(action.sessionId))
        if (sourceGroup && sourceGroup.id === targetGroup.id) {
          return this.buildSnapshot()
        }

        if (sourceGroup) {
          sourceGroup.sessionIds = sourceGroup.sessionIds.filter((id) => id !== action.sessionId)
          const remainingLayout = removeSessionFromLayout(sourceGroup.layout, action.sessionId)
          if (remainingLayout) {
            sourceGroup.layout = remainingLayout
            this.reconcileGroupPointers(sourceGroup)
          } else if (sourceGroup.sessionIds.length > 0) {
            sourceGroup.layout = createLeaf(this.idGen.nextPaneId(), sourceGroup.sessionIds[0]!)
            this.reconcileGroupPointers(sourceGroup)
          } else if (this.groups.length > 1) {
            this.groups = this.groups.filter((g) => g.id !== sourceGroup.id)
          } else {
            const replacement = this.createManagedSession({ cwd: sourceGroup.defaultCwd })
            sourceGroup.sessionIds.push(replacement.id)
            sourceGroup.layout = createLeaf(this.idGen.nextPaneId(), replacement.id)
            this.reconcileGroupPointers(sourceGroup)
          }
        }

        if (!targetGroup.sessionIds.includes(action.sessionId)) {
          targetGroup.sessionIds.push(action.sessionId)
        }
        targetGroup.layout = replacePaneSession(
          targetGroup.layout,
          targetGroup.focusedPaneId,
          action.sessionId,
        )
        this.activeGroupId = targetGroup.id
        targetGroup.hasAlert = false
        return this.publishWorkspace()
      }

      case 'rename-session': {
        this.sessionManager.renameSession(action.sessionId, action.title)
        return this.buildSnapshot()
      }

      case 'set-session-osc-title': {
        this.sessionManager.setOscTitle(action.sessionId, action.oscTitle)
        return this.buildSnapshot()
      }

      case 'broadcast-write': {
        const group = this.requireGroup(action.groupId)
        if (!group.broadcastEnabled || !action.data) {
          return this.buildSnapshot()
        }
        const sessionsById = new Map(this.sessionManager.listSessions().map((s) => [s.id, s]))
        for (const sid of collectSessionIds(group.layout)) {
          const summary = sessionsById.get(sid)
          if (summary?.mode === 'pty' && summary.running) {
            this.sessionManager.ptyWrite(sid, action.data)
          }
        }
        return this.buildSnapshot()
      }
    }
  }

  listProfiles(): TerminalWorkspaceProfile[] {
    return this.persistence.listProfiles()
  }

  saveProfileFromGroup(input: TerminalSaveProfileInput): TerminalWorkspaceProfile {
    this.ensureInitialized()
    const group = this.requireGroup(input.groupId)
    const name = input.name.trim()
    if (!name) {
      throw new Error('Workspace profile name must not be empty')
    }
    const sessionsById = new Map(this.sessionManager.listSessions().map((s) => [s.id, s]))
    const now = Date.now()
    const profile: TerminalWorkspaceProfile = {
      id: `prof-${crypto.randomBytes(4).toString('hex')}`,
      name,
      color: group.color,
      ...(group.defaultCwd ? { defaultCwd: group.defaultCwd } : {}),
      layout: toProfileLayoutNode(group.layout, sessionsById, input.startupCommandsBySessionId),
      createdAt: now,
      updatedAt: now,
    }
    return this.persistence.saveProfile(profile)
  }

  deleteProfile(profileId: string): void {
    this.persistence.deleteProfile(profileId)
  }

  launchProfile(profileId: string): TerminalWorkspaceSnapshot {
    this.ensureInitialized()
    const profile = this.persistence.listProfiles().find((p) => p.id === profileId)
    if (!profile) {
      throw new Error(`Workspace profile not found: ${profileId}`)
    }

    const spawnedSessionIds: string[] = []
    const startupTasks: Array<{ sessionId: string; mode: 'pty' | 'block'; command: string }> = []

    const materializeNode = (node: TerminalProfileLayoutNode): TerminalLayoutNode => {
      if (node.type === 'leaf') {
        const cwd =
          node.cwd && isValidDir(node.cwd)
            ? node.cwd
            : profile.defaultCwd && isValidDir(profile.defaultCwd)
              ? profile.defaultCwd
              : undefined
        const snap = this.createManagedSession({
          shell: node.shell,
          mode: node.mode,
          cwd,
          title: node.title,
        })
        spawnedSessionIds.push(snap.id)
        if (node.startupCommand?.trim()) {
          startupTasks.push({
            sessionId: snap.id,
            mode: snap.mode,
            command: node.startupCommand.trim(),
          })
        }
        return createLeaf(this.idGen.nextPaneId(), snap.id)
      }

      return {
        type: 'split',
        splitId: this.idGen.nextSplitId(),
        direction: node.direction,
        ratio: node.ratio,
        first: materializeNode(node.first),
        second: materializeNode(node.second),
      }
    }

    const layout = materializeNode(profile.layout)
    const firstLeaf = collectLeafPanes(layout)[0]!
    const group: TerminalGroup = {
      id: `grp-${++this.groupSeq}-${crypto.randomBytes(3).toString('hex')}`,
      name: profile.name,
      color: profile.color,
      ...(profile.defaultCwd && isValidDir(profile.defaultCwd)
        ? { defaultCwd: path.resolve(profile.defaultCwd) }
        : {}),
      collapsed: false,
      broadcastEnabled: false,
      hasAlert: false,
      layout,
      focusedPaneId: firstLeaf.paneId,
      zoomedPaneId: null,
      sessionIds: spawnedSessionIds,
      createdAt: Date.now(),
    }

    this.groups.push(group)
    this.activeGroupId = group.id

    const snapshot = this.publishWorkspace()

    for (const task of startupTasks) {
      if (task.mode === 'pty') {
        // Brief delay lets interactive ConPTY/PowerShell print its initial prompt cleanly first.
        setTimeout(() => {
          if (!this.disposed && !this.sessionManager.isDisposed()) {
            try {
              this.sessionManager.ptyWrite(task.sessionId, `${task.command}\r`)
            } catch {
              // Ignore if session closed before startup command fired.
            }
          }
        }, 250)
      } else {
        void this.sessionManager.runCommand(task.sessionId, task.command).catch(() => undefined)
      }
    }

    return snapshot
  }

  listSnippets(): TerminalCommandSnippet[] {
    return this.persistence.listSnippets()
  }

  saveSnippet(input: TerminalSaveSnippetInput): TerminalCommandSnippet {
    return this.persistence.saveSnippet(input)
  }

  deleteSnippet(snippetId: string): void {
    this.persistence.deleteSnippet(snippetId)
  }

  private ensureInitialized(): void {
    if (this.groups.length > 0 || this.disposed || this.sessionManager.isDisposed()) return

    const existing = this.sessionManager.listSessions()
    if (existing.length > 0) {
      const first = existing[0]!
      const leaf = createLeaf(this.idGen.nextPaneId(), first.id)
      const group: TerminalGroup = {
        id: `grp-${++this.groupSeq}-${crypto.randomBytes(3).toString('hex')}`,
        name: `${this.defaultGroupName} 1`,
        color: GROUP_COLORS[0]!,
        defaultCwd: first.cwd,
        collapsed: false,
        broadcastEnabled: false,
        hasAlert: false,
        layout: leaf,
        focusedPaneId: leaf.paneId,
        zoomedPaneId: null,
        sessionIds: existing.map((s) => s.id),
        createdAt: Date.now(),
      }
      this.groups = [group]
      this.activeGroupId = group.id
      return
    }

    this.createGroupInternal({ name: `${this.defaultGroupName} 1`, activate: true })
  }

  private createGroupInternal(opts: {
    name?: string
    color?: TerminalGroupColor
    defaultCwd?: string
    shell?: TerminalCreateOpts['shell']
    mode?: TerminalCreateOpts['mode']
    colorScheme?: TerminalCreateOpts['colorScheme']
    activate?: boolean
  }): TerminalGroup {
    const color =
      opts.color && GROUP_COLORS.includes(opts.color)
        ? opts.color
        : GROUP_COLORS[this.groupSeq % GROUP_COLORS.length]!
    const seqNum = ++this.groupSeq
    const name = opts.name?.trim() || `${this.defaultGroupName} ${seqNum}`
    const resolvedCwd =
      opts.defaultCwd && isValidDir(opts.defaultCwd) ? path.resolve(opts.defaultCwd) : undefined

    const session = this.createManagedSession({
      shell: opts.shell,
      mode: opts.mode ?? 'pty',
      ...(opts.colorScheme ? { colorScheme: opts.colorScheme } : {}),
      cwd: resolvedCwd,
    })
    const leaf = createLeaf(this.idGen.nextPaneId(), session.id)
    const group: TerminalGroup = {
      id: `grp-${seqNum}-${crypto.randomBytes(3).toString('hex')}`,
      name,
      color,
      defaultCwd: resolvedCwd ?? session.cwd,
      collapsed: false,
      broadcastEnabled: false,
      hasAlert: false,
      layout: leaf,
      focusedPaneId: leaf.paneId,
      zoomedPaneId: null,
      sessionIds: [session.id],
      createdAt: Date.now(),
    }

    this.groups.push(group)
    if (opts.activate || !this.activeGroupId) {
      this.activeGroupId = group.id
    }
    return group
  }

  private closeGroupInternal(groupId: string): void {
    const idx = this.groups.findIndex((g) => g.id === groupId)
    if (idx === -1) return
    const [removed] = this.groups.splice(idx, 1)
    if (!removed) return

    if (this.groups.length === 0) {
      this.createGroupInternal({
        name: `${this.defaultGroupName} ${this.groupSeq + 1}`,
        activate: true,
      })
    } else if (this.activeGroupId === groupId) {
      const next = this.groups[Math.min(idx, this.groups.length - 1)]!
      this.activeGroupId = next.id
      next.hasAlert = false
    }

    for (const sid of removed.sessionIds) {
      if (!this.isSessionReferencedElsewhere(sid)) {
        this.closeSessionManaged(sid)
      }
    }
  }

  private createManagedSession(opts?: TerminalCreateOpts) {
    this.internalCreateDepth += 1
    try {
      return this.sessionManager.createSession(opts)
    } finally {
      this.internalCreateDepth -= 1
    }
  }

  private closeSessionManaged(sessionId: string): void {
    this.internalCloseIds.add(sessionId)
    try {
      this.sessionManager.closeSession(sessionId)
    } finally {
      this.internalCloseIds.delete(sessionId)
    }
  }

  private handleManagerEvent(event: TerminalEvent): void {
    if (this.disposed || this.sessionManager.isDisposed()) return

    if (event.type === 'session-created') {
      if (this.internalCreateDepth > 0 || this.groups.length === 0) return
      const sid = event.session.id
      if (this.groups.some((g) => g.sessionIds.includes(sid))) return
      const active = this.groups.find((g) => g.id === this.activeGroupId) ?? this.groups[0]!
      active.sessionIds.push(sid)
      if (findLeafByPaneId(active.layout, active.focusedPaneId)) {
        active.layout = replacePaneSession(active.layout, active.focusedPaneId, sid)
      }
      this.publishWorkspace()
      return
    }

    if (event.type === 'session-closed') {
      if (this.internalCloseIds.has(event.sessionId)) return
      let changed = false
      for (let i = this.groups.length - 1; i >= 0; i -= 1) {
        const group = this.groups[i]!
        if (!group.sessionIds.includes(event.sessionId)) continue
        changed = true
        group.sessionIds = group.sessionIds.filter((id) => id !== event.sessionId)
        const nextLayout = removeSessionFromLayout(group.layout, event.sessionId)
        if (nextLayout) {
          group.layout = nextLayout
          this.reconcileGroupPointers(group)
        } else if (group.sessionIds.length > 0) {
          group.layout = createLeaf(this.idGen.nextPaneId(), group.sessionIds[0]!)
          this.reconcileGroupPointers(group)
        } else if (this.groups.length > 1) {
          this.groups.splice(i, 1)
          if (this.activeGroupId === group.id) {
            this.activeGroupId = this.groups[Math.min(i, this.groups.length - 1)]!.id
          }
        } else {
          const replacement = this.createManagedSession({ cwd: group.defaultCwd })
          group.sessionIds = [replacement.id]
          group.layout = createLeaf(this.idGen.nextPaneId(), replacement.id)
          this.reconcileGroupPointers(group)
        }
      }
      if (changed) {
        this.publishWorkspace()
      }
      return
    }

    if (event.type === 'session-updated') {
      if (this.groups.length > 0) {
        this.publishWorkspace()
      }
      return
    }

    if (
      (event.type === 'pty-exit' && event.exitCode !== 0) ||
      (event.type === 'block-finished' && event.status === 'error')
    ) {
      const owner = this.groups.find((g) => g.sessionIds.includes(event.sessionId))
      if (owner && owner.id !== this.activeGroupId && !owner.hasAlert) {
        owner.hasAlert = true
        this.publishWorkspace()
      }
    }
  }

  private reconcileGroupPointers(group: TerminalGroup): void {
    const leaves = collectLeafPanes(group.layout)
    if (leaves.length === 0) return
    if (!leaves.some((leaf) => leaf.paneId === group.focusedPaneId)) {
      group.focusedPaneId = leaves[0]!.paneId
    }
    if (
      group.zoomedPaneId &&
      (leaves.length <= 1 || !leaves.some((leaf) => leaf.paneId === group.zoomedPaneId))
    ) {
      group.zoomedPaneId = null
    }
  }

  private isSessionReferencedElsewhere(sessionId: string, excludeGroupId?: string): boolean {
    return this.groups.some(
      (g) =>
        g.id !== excludeGroupId &&
        (g.sessionIds.includes(sessionId) || Boolean(findLeafBySessionId(g.layout, sessionId))),
    )
  }

  private requireGroup(groupId: string): TerminalGroup {
    const group = this.groups.find((g) => g.id === groupId)
    if (!group) {
      throw new Error(`Terminal group not found: ${groupId}`)
    }
    return group
  }

  private buildSnapshot(): TerminalWorkspaceSnapshot {
    const sessions = this.sessionManager.listSessions()
    return {
      activeGroupId: this.activeGroupId,
      groups: this.groups.map(cloneGroup),
      sessions,
    }
  }

  private publishWorkspace(): TerminalWorkspaceSnapshot {
    const snapshot = this.buildSnapshot()
    this.emit({ type: 'workspace-updated', workspace: snapshot })
    return snapshot
  }
}
