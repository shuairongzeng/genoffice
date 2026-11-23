import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TerminalEvent } from '../../shared/terminal-api'
import { collectLeafPanes } from '../../shared/terminal-layout'
import type { IPtyProcess, PtyLoadResult } from './pty-loader'
import { TerminalPersistence } from './terminal-persistence'
import { TerminalSessionManager } from './terminal-session-manager'
import { TerminalWorkspaceManager } from './terminal-workspace-manager'

interface MockPtyControl {
  writes: string[]
  killed: boolean
  emitData: (chunk: string) => void
  emitExit: (exitCode: number) => void
}

function createFakePtyLoader(): {
  loader: () => PtyLoadResult
  controls: MockPtyControl[]
} {
  const controls: MockPtyControl[] = []
  const loader = (): PtyLoadResult => ({
    available: true,
    source: 'mock-pty',
    spawn: () => {
      let dataListener: ((data: string) => void) | null = null
      let exitListener: ((ev: { exitCode: number; signal?: number }) => void) | null = null
      const control: MockPtyControl = {
        writes: [],
        killed: false,
        emitData: (chunk: string) => dataListener?.(chunk),
        emitExit: (exitCode: number) => exitListener?.({ exitCode }),
      }
      controls.push(control)

      const proc: IPtyProcess = {
        pid: 100 + controls.length,
        write: (data: string) => control.writes.push(data),
        resize: () => undefined,
        kill: () => {
          control.killed = true
        },
        clear: () => undefined,
        onData: (cb) => {
          dataListener = cb
          return {
            dispose: () => {
              if (dataListener === cb) dataListener = null
            },
          }
        },
        onExit: (cb) => {
          exitListener = cb
          return {
            dispose: () => {
              if (exitListener === cb) exitListener = null
            },
          }
        },
      }
      return proc
    },
  })
  return { loader, controls }
}

function createHarness() {
  const events: TerminalEvent[] = []
  const listeners = new Set<(event: TerminalEvent) => void>()
  const { loader, controls } = createFakePtyLoader()
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genoffice-term-ws-'))
  const persistence = new TerminalPersistence(tmpDir)

  const emit = (event: TerminalEvent) => {
    events.push(event)
    for (const cb of listeners) cb(event)
  }

  const sessionManager = new TerminalSessionManager({
    defaultCwd: () => tmpDir,
    emit,
    ptyLoader: loader,
    shellDetector: () => [
      { kind: 'powershell', label: 'PowerShell 7', executable: '/fake/pwsh', available: true },
      { kind: 'cmd', label: 'CMD', executable: '/fake/cmd', available: true },
    ],
  })

  const workspace = new TerminalWorkspaceManager({
    sessionManager,
    persistence,
    emit,
    defaultGroupName: 'Workspace',
  })

  return { events, controls, tmpDir, sessionManager, workspace, persistence }
}

describe('TerminalWorkspaceManager groups, splits, broadcast, alerts, profiles & snippets', () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()!()
    }
  })

  it('manages groups, nested directional splits, zoom reconciliation, and session moves', () => {
    const h = createHarness()
    cleanups.push(() => {
      h.workspace.dispose()
      h.sessionManager.disposeAll()
      fs.rmSync(h.tmpDir, { recursive: true, force: true })
    })

    const initial = h.workspace.getSnapshot()
    expect(initial.groups).toHaveLength(1)
    const g1 = initial.groups[0]!
    expect(g1.color).toBe('blue')
    expect(g1.sessionIds).toHaveLength(1)

    // Create horizontal split then vertical split -> 3 panes in g1
    const sSplitH = h.workspace.dispatch({
      type: 'split-pane',
      groupId: g1.id,
      targetPaneId: g1.focusedPaneId,
      direction: 'horizontal',
    })
    const g1AfterH = sSplitH.groups[0]!
    expect(collectLeafPanes(g1AfterH.layout)).toHaveLength(2)

    const sSplitV = h.workspace.dispatch({
      type: 'split-pane',
      groupId: g1.id,
      targetPaneId: g1AfterH.focusedPaneId,
      direction: 'vertical',
    })
    const g1AfterV = sSplitV.groups[0]!
    expect(collectLeafPanes(g1AfterV.layout)).toHaveLength(3)

    // Zoom into focused pane, then closing it reconciles zoom & focused pointers safely
    h.workspace.dispatch({
      type: 'zoom-pane',
      groupId: g1.id,
      paneId: g1AfterV.focusedPaneId,
    })
    const closedZoomed = h.workspace.dispatch({
      type: 'close-pane',
      groupId: g1.id,
      paneId: g1AfterV.focusedPaneId,
      killSessionIfUnused: true,
    })
    expect(closedZoomed.groups[0]!.zoomedPaneId).toBeNull()
    expect(collectLeafPanes(closedZoomed.groups[0]!.layout)).toHaveLength(2)

    // Create second group and move a session across groups
    const withG2 = h.workspace.dispatch({
      type: 'create-group',
      name: 'Backend',
      color: 'emerald',
      activate: true,
    })
    expect(withG2.groups).toHaveLength(2)
    const g2 = withG2.groups[1]!
    const movableSessionId = withG2.groups[0]!.sessionIds[1]!

    const afterMove = h.workspace.dispatch({
      type: 'move-session-to-group',
      sessionId: movableSessionId,
      targetGroupId: g2.id,
    })
    expect(afterMove.groups[0]!.sessionIds).not.toContain(movableSessionId)
    expect(afterMove.groups[1]!.sessionIds).toContain(movableSessionId)

    // Closing last remaining group always replenishes a clean fallback group
    const onlyOneLeft = h.workspace.dispatch({ type: 'close-group', groupId: g1.id })
    expect(onlyOneLeft.groups).toHaveLength(1)
    const recreated = h.workspace.dispatch({
      type: 'close-group',
      groupId: onlyOneLeft.groups[0]!.id,
    })
    expect(recreated.groups).toHaveLength(1)
    expect(recreated.groups[0]!.sessionIds).toHaveLength(1)
  })

  it('tracks background group failure alerts and broadcasts writes to group PTYs only', () => {
    const h = createHarness()
    cleanups.push(() => {
      h.workspace.dispose()
      h.sessionManager.disposeAll()
      fs.rmSync(h.tmpDir, { recursive: true, force: true })
    })

    const snap1 = h.workspace.getSnapshot()
    const g1 = snap1.groups[0]!
    // Second PTY pane in g1
    h.workspace.dispatch({
      type: 'split-pane',
      groupId: g1.id,
      targetPaneId: g1.focusedPaneId,
      direction: 'horizontal',
    })
    // Also attach a block session in g1 so broadcast ignores non-PTY sessions
    h.workspace.dispatch({
      type: 'add-session-to-group',
      groupId: g1.id,
      opts: { mode: 'block' },
      replaceFocusedPane: false,
    })

    // Switch to g2 while g1 stays in background
    const snap2 = h.workspace.dispatch({
      type: 'create-group',
      name: 'Other',
      activate: true,
    })
    const g2 = snap2.groups[1]!
    expect(h.controls).toHaveLength(3) // 2 in g1, 1 in g2

    // Simulate user input first so exit(2) triggers pty-exit rather than early-crash shell hot-swap.
    h.sessionManager.ptyWrite(g1.sessionIds[0]!, 'failing-cmd\r')
    // Non-zero exit on background g1 raises alert on g1 but not active g2
    h.controls[0]!.emitExit(2)
    expect(h.workspace.getSnapshot().groups.find((g) => g.id === g1.id)?.hasAlert).toBe(true)

    // Activating g1 clears its alert
    const backToG1 = h.workspace.dispatch({ type: 'activate-group', groupId: g1.id })
    expect(backToG1.groups.find((g) => g.id === g1.id)?.hasAlert).toBe(false)

    // Enable broadcast on g1 -> write reaches only running PTYs in g1 (controls[1]; controls[0] exited)
    h.workspace.dispatch({ type: 'update-group', groupId: g1.id, broadcastEnabled: true })
    h.workspace.dispatch({ type: 'broadcast-write', groupId: g1.id, data: 'echo synced\r' })

    expect(h.controls[0]!.writes).not.toContain('echo synced\r')
    expect(h.controls[1]!.writes).toContain('echo synced\r')
    expect(h.controls[2]!.writes).not.toContain('echo synced\r')
  })

  it('persists default snippets, CRUD snippets, and launches multi-pane profiles with startup commands', async () => {
    const h = createHarness()
    cleanups.push(() => {
      h.workspace.dispose()
      h.sessionManager.disposeAll()
      fs.rmSync(h.tmpDir, { recursive: true, force: true })
    })

    // Seeded snippets exist on fresh userData
    const initialSnippets = h.workspace.listSnippets()
    expect(initialSnippets.length).toBeGreaterThanOrEqual(4)

    const savedSnippet = h.workspace.saveSnippet({
      title: 'List Worktree',
      command: 'git status -s',
      sendEnter: true,
    })
    expect(h.workspace.listSnippets().some((s) => s.id === savedSnippet.id)).toBe(true)
    h.workspace.deleteSnippet(savedSnippet.id)
    expect(h.workspace.listSnippets().some((s) => s.id === savedSnippet.id)).toBe(false)

    // Build 2-pane split in active group and save as a profile with a startup command
    const g1 = h.workspace.getSnapshot().groups[0]!
    const afterPreset = h.workspace.dispatch({
      type: 'apply-preset',
      groupId: g1.id,
      preset: 'split-h',
    })
    const targetGroup = afterPreset.groups[0]!
    const firstSessionId = targetGroup.sessionIds[0]!

    const profile = h.workspace.saveProfileFromGroup({
      groupId: targetGroup.id,
      name: 'Dev Stack',
      startupCommandsBySessionId: { [firstSessionId]: 'npm run dev' },
    })
    expect(h.workspace.listProfiles()).toHaveLength(1)

    const launched = h.workspace.launchProfile(profile.id)
    expect(launched.groups).toHaveLength(2)
    const launchedGroup = launched.groups[1]!
    expect(launchedGroup.name).toBe('Dev Stack')
    expect(collectLeafPanes(launchedGroup.layout)).toHaveLength(2)

    // Allow delayed startup command timer (250ms) to write into new spawned PTY
    await new Promise((r) => setTimeout(r, 320))
    expect(h.controls[2]!.writes).toContain('npm run dev\r')

    h.workspace.deleteProfile(profile.id)
    expect(h.workspace.listProfiles()).toHaveLength(0)
  })

  it('opens terminal sessions directly inside resolved target directories, file parents, or fallback defaultCwd', () => {
    const h = createHarness()
    cleanups.push(() => {
      h.workspace.dispose()
      h.sessionManager.disposeAll()
      fs.rmSync(h.tmpDir, { recursive: true, force: true })
    })

    const subDir = path.join(h.tmpDir, 'nested-project')
    fs.mkdirSync(subDir, { recursive: true })
    const filePath = path.join(subDir, 'notes.md')
    fs.writeFileSync(filePath, '# demo', 'utf8')

    // 1. Cold start directly in a target directory avoids creating a wasted default session first
    const cold = h.workspace.openInDirectory(subDir)
    expect(cold.workspace.groups).toHaveLength(1)
    expect(cold.workspace.groups[0]!.sessionIds).toEqual([cold.sessionId])
    expect(h.sessionManager.getSession(cold.sessionId)?.cwd).toBe(path.resolve(subDir))

    // 2. Passing a file path resolves cleanly to its parent directory in the active group
    const otherDir = path.join(h.tmpDir, 'other-folder')
    fs.mkdirSync(otherDir, { recursive: true })
    const otherFile = path.join(otherDir, 'report.docx')
    fs.writeFileSync(otherFile, 'stub', 'utf8')

    const fromFile = h.workspace.openInDirectory(otherFile)
    expect(fromFile.sessionId).not.toBe(cold.sessionId)
    expect(h.sessionManager.getSession(fromFile.sessionId)?.cwd).toBe(path.resolve(otherDir))

    // 3. Missing/non-existent path falls back safely to defaultCwd
    const missing = h.workspace.openInDirectory(path.join(h.tmpDir, 'does-not-exist', 'ghost.txt'))
    expect(h.sessionManager.getSession(missing.sessionId)?.cwd).toBe(path.resolve(h.tmpDir))
  })
})
