import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TerminalBlock, TerminalEvent } from '../../shared/terminal-api'
import type { IPtyProcess, PtyLoadResult } from './pty-loader'
import {
  TerminalSessionManager,
  buildCleanTerminalEnv,
  defaultShellKind,
  detectAvailableShells,
  evaluatePowerShellPolicy,
  extractSentinelFromBuffer,
} from './terminal-session-manager'

const IS_WINDOWS = process.platform === 'win32'

function waitForEvent<T extends TerminalEvent['type']>(
  events: TerminalEvent[],
  predicate: (event: Extract<TerminalEvent, { type: T }>) => boolean,
  type: T,
  timeoutMs = 15_000,
): Promise<Extract<TerminalEvent, { type: T }>> {
  const existing = events.find(
    (e): e is Extract<TerminalEvent, { type: T }> =>
      e.type === type && predicate(e as Extract<TerminalEvent, { type: T }>),
  )
  if (existing) return Promise.resolve(existing)

  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const timer = setInterval(() => {
      const match = events.find(
        (e): e is Extract<TerminalEvent, { type: T }> =>
          e.type === type && predicate(e as Extract<TerminalEvent, { type: T }>),
      )
      if (match) {
        clearInterval(timer)
        resolve(match)
        return
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`Timed out waiting for event "${type}"`))
      }
    }, 10)
  })
}

async function runAndWait(
  manager: TerminalSessionManager,
  events: TerminalEvent[],
  sessionId: string,
  command: string,
): Promise<{
  block: TerminalBlock
  finished: Extract<TerminalEvent, { type: 'block-finished' }>
}> {
  const started = await manager.runCommand(sessionId, command)
  const finished = await waitForEvent(
    events,
    (e) => e.sessionId === sessionId && e.blockId === started.id,
    'block-finished',
  )
  const snap = manager.getSession(sessionId)
  const finalBlock = snap?.blocks.find((b) => b.id === started.id) ?? started
  return { block: finalBlock, finished }
}

describe('extractSentinelFromBuffer', () => {
  it('passes through plain text without any sentinel prefix', () => {
    const res = extractSentinelFromBuffer('hello\nworld\n', 'deadbeef')
    expect(res).toEqual({
      text: 'hello\nworld\n',
      remaining: '',
    })
  })

  it('extracts sentinel with LF and CRLF line endings and optional preceding CR', () => {
    const lf = extractSentinelFromBuffer('line1\n__GO_TERM_DONE_tok1__|0|/tmp/work\n', 'tok1')
    expect(lf).toEqual({
      text: 'line1\n',
      remaining: '',
      match: { exitCode: 0, cwd: '/tmp/work' },
    })

    const crlf = extractSentinelFromBuffer(
      'line1\r\n__GO_TERM_DONE_tok2__|42|D:\\Projects\\app\r\n',
      'tok2',
    )
    expect(crlf).toEqual({
      text: 'line1\r\n',
      remaining: '',
      match: { exitCode: 42, cwd: 'D:\\Projects\\app' },
    })

    const precedingCr = extractSentinelFromBuffer(
      'progress\r__GO_TERM_DONE_tok3__|1|/home/user\r\n',
      'tok3',
    )
    expect(precedingCr).toEqual({
      text: 'progress',
      remaining: '',
      match: { exitCode: 1, cwd: '/home/user' },
    })
  })

  it('holds back partial prefixes and releases them if they do not form the sentinel', () => {
    const hold1 = extractSentinelFromBuffer('output__GO_TERM_DONE_', 'abc123')
    expect(hold1).toEqual({
      text: 'output',
      remaining: '__GO_TERM_DONE_',
    })

    const hold2 = extractSentinelFromBuffer(`${hold1.remaining}abc123__|7|/dir`, 'abc123')
    expect(hold2).toEqual({
      text: '',
      remaining: '__GO_TERM_DONE_abc123__|7|/dir',
    })

    const completed = extractSentinelFromBuffer(`${hold2.remaining}\r\n`, 'abc123')
    expect(completed).toEqual({
      text: '',
      remaining: '',
      match: { exitCode: 7, cwd: '/dir' },
    })

    const falseAlarmStart = extractSentinelFromBuffer('value__GO_', 'abc123')
    expect(falseAlarmStart).toEqual({
      text: 'value',
      remaining: '__GO_',
    })

    const falseAlarmEnd = extractSentinelFromBuffer(`${falseAlarmStart.remaining}OTHER\n`, 'abc123')
    expect(falseAlarmEnd).toEqual({
      text: '__GO_OTHER\n',
      remaining: '',
    })
  })

  it('handles sentinel split across arbitrary tiny chunks without leaking marker text', () => {
    const token = 'a1b2c3d4e5f60708'
    const fullStream = `alpha\r\nbeta\r\n__GO_TERM_DONE_${token}__|13|C:\\Work\\Sub\r\n`
    let remaining = ''
    let collectedText = ''
    let foundMatch: { exitCode: number; cwd: string } | undefined

    for (let i = 0; i < fullStream.length; i += 2) {
      const chunk = fullStream.slice(i, i + 2)
      const res = extractSentinelFromBuffer(remaining + chunk, token)
      collectedText += res.text
      remaining = res.remaining
      if (res.match) {
        foundMatch = res.match
      }
    }

    expect(collectedText).toBe('alpha\r\nbeta\r\n')
    expect(remaining).toBe('')
    expect(foundMatch).toEqual({ exitCode: 13, cwd: 'C:\\Work\\Sub' })
  })

  it('preserves trailing text after sentinel inside remaining', () => {
    const res = extractSentinelFromBuffer(
      'first output\n__GO_TERM_DONE_tok9__|0|/repo\r\nnext output',
      'tok9',
    )
    expect(res).toEqual({
      text: 'first output\n',
      remaining: 'next output',
      match: { exitCode: 0, cwd: '/repo' },
    })
  })
})

describe('shell detection helpers', () => {
  it('detects available shells and selects a valid default shell kind', () => {
    const shells = detectAvailableShells()
    expect(shells.length).toBeGreaterThan(0)
    for (const option of shells) {
      expect(option.available).toBe(true)
      expect(fs.existsSync(option.executable)).toBe(true)
    }

    const def = defaultShellKind()
    expect(def).toBe(shells[0]!.kind)
    if (IS_WINDOWS) {
      expect(def).toBe('powershell')
    }
  })

  it('strips embedded pi-agent/bin shims from PATH while preserving user host entries', () => {
    const cleaned = buildCleanTerminalEnv({
      PATH: [
        'C:\\Users\\Alice\\AppData\\Local\\Temp\\ud\\pi-agent\\bin',
        'C:\\Windows\\System32',
        '/Users/alice/.pi-agent-user/pi-agent/bin/',
        'C:\\Users\\Alice\\AppData\\Roaming\\npm',
      ].join(path.delimiter),
      CUSTOM_KEEP: 'ok',
    })
    expect(cleaned.CUSTOM_KEEP).toBe('ok')
    expect(cleaned.PATH).toBe(
      ['C:\\Windows\\System32', 'C:\\Users\\Alice\\AppData\\Roaming\\npm'].join(path.delimiter),
    )
  })

  it('evaluates PowerShell Machine/User/Effective execution policies accurately', () => {
    expect(evaluatePowerShellPolicy('Undefined', 'Undefined', 'RemoteSigned')).toEqual({
      gpoBlocked: false,
      needsProcessRemoteSigned: false,
      probeFailed: false,
    })
    expect(evaluatePowerShellPolicy('Undefined', 'Undefined', 'Undefined')).toEqual({
      gpoBlocked: false,
      needsProcessRemoteSigned: true,
      probeFailed: false,
    })
    expect(evaluatePowerShellPolicy('Restricted', 'Undefined', 'Restricted')).toEqual({
      gpoBlocked: true,
      needsProcessRemoteSigned: false,
      probeFailed: false,
    })
    expect(evaluatePowerShellPolicy('Undefined', 'AllSigned', 'AllSigned')).toEqual({
      gpoBlocked: true,
      needsProcessRemoteSigned: false,
      probeFailed: false,
    })
  })

  it.skipIf(!IS_WINDOWS)('prefers pwsh.exe (PowerShell 7) when available on Windows', () => {
    const shells = detectAvailableShells()
    const ps = shells.find((s) => s.kind === 'powershell')
    expect(ps).toBeDefined()
    if (shells[0]?.kind === 'powershell' && ps!.executable.toLowerCase().includes('pwsh')) {
      expect(ps!.label).toBe('PowerShell 7')
    }
  })
})

describe.skipIf(!IS_WINDOWS)('TerminalSessionManager integration (Windows PowerShell)', () => {
  const managers: TerminalSessionManager[] = []
  const tempDirs: string[] = []

  function createManager(opts?: Partial<ConstructorParameters<typeof TerminalSessionManager>[0]>): {
    manager: TerminalSessionManager
    events: TerminalEvent[]
  } {
    const events: TerminalEvent[] = []
    const manager = new TerminalSessionManager({
      emit: (event) => events.push(event),
      ...opts,
    })
    managers.push(manager)
    return { manager, events }
  }

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genoffice-term-test-'))
    tempDirs.push(dir)
    return fs.realpathSync.native(dir)
  }

  afterEach(async () => {
    while (managers.length > 0) {
      managers.pop()!.disposeAll()
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
    }
  })

  it('persists cwd across sequential commands in the same session', async () => {
    const targetDir = makeTempDir()
    const { manager, events } = createManager()
    const session = manager.createSession({ shell: 'powershell', mode: 'block' })

    const first = await runAndWait(
      manager,
      events,
      session.id,
      `Set-Location -LiteralPath '${targetDir.replace(/'/g, "''")}'`,
    )
    expect(first.finished.status).toBe('done')
    expect(first.finished.exitCode).toBe(0)
    expect(fs.realpathSync.native(first.finished.cwd).toLowerCase()).toBe(targetDir.toLowerCase())

    const second = await runAndWait(manager, events, session.id, '(Get-Location).Path')
    expect(second.finished.status).toBe('done')
    expect(second.block.stdout.trim().toLowerCase()).toBe(targetDir.toLowerCase())
    expect(fs.realpathSync.native(manager.getSession(session.id)!.cwd).toLowerCase()).toBe(
      targetDir.toLowerCase(),
    )
  }, 30_000)

  it('preserves UTF-8 text and HTML markup cleanly without startup stderr noise', async () => {
    const { manager, events } = createManager()
    const session = manager.createSession({ shell: 'powershell', mode: 'block' })

    const { block, finished } = await runAndWait(
      manager,
      events,
      session.id,
      'Write-Output \'<div class="card">你好世界 &amp; GenOffice</div>\'',
    )

    expect(finished.status).toBe('done')
    expect(finished.exitCode).toBe(0)
    expect(block.stdout).toContain('<div class="card">你好世界 &amp; GenOffice</div>')
    expect(block.stderr).toBe('')
  }, 30_000)

  it('captures non-zero exit codes and stderr from failing commands and direct exit', async () => {
    const { manager, events } = createManager()
    const session = manager.createSession({ shell: 'powershell', mode: 'block' })

    const nativeErr = await runAndWait(
      manager,
      events,
      session.id,
      `[Console]::Error.WriteLine('custom-stderr-failure'); cmd /c "exit 7"`,
    )
    expect(nativeErr.finished.status).toBe('error')
    expect(nativeErr.finished.exitCode).toBe(7)
    expect(nativeErr.block.stderr).toContain('custom-stderr-failure')

    const cmdletErr = await runAndWait(
      manager,
      events,
      session.id,
      "Get-Item 'C:\\definitely_missing_genoffice_path_987654'",
    )
    expect(cmdletErr.finished.status).toBe('error')
    expect(cmdletErr.finished.exitCode).toBe(1)
    expect(cmdletErr.block.stderr.length).toBeGreaterThan(0)

    const directExit = await runAndWait(manager, events, session.id, 'exit 7')
    expect(directExit.finished.status).toBe('error')
    expect(directExit.finished.exitCode).toBe(7)

    const recovered = await runAndWait(manager, events, session.id, "Write-Output 'alive'")
    expect(recovered.finished.status).toBe('done')
    expect(recovered.finished.exitCode).toBe(0)
    expect(recovered.block.stdout).toContain('alive')
  }, 30_000)

  it('interrupts a sleeping command and keeps the session usable in the same cwd', async () => {
    const targetDir = makeTempDir()
    const { manager, events } = createManager()
    const session = manager.createSession({ shell: 'powershell', mode: 'block', cwd: targetDir })

    const started = await manager.runCommand(session.id, 'Start-Sleep -Seconds 30')
    expect(started.status).toBe('running')

    await manager.interrupt(session.id)

    const finished = await waitForEvent(
      events,
      (e) => e.sessionId === session.id && e.blockId === started.id,
      'block-finished',
    )
    expect(finished.status).toBe('interrupted')
    expect(finished.exitCode).toBe(130)

    const snapAfterInterrupt = manager.getSession(session.id)!
    expect(snapAfterInterrupt.running).toBe(false)
    expect(snapAfterInterrupt.blocks.find((b) => b.id === started.id)?.status).toBe('interrupted')

    const next = await runAndWait(manager, events, session.id, '(Get-Location).Path')
    expect(next.finished.status).toBe('done')
    expect(next.finished.exitCode).toBe(0)
    expect(next.block.stdout.trim().toLowerCase()).toBe(targetDir.toLowerCase())
  }, 30_000)

  it('enforces maxBlockBytes truncation while still matching the completion sentinel', async () => {
    const { manager, events } = createManager({ maxBlockBytes: 512, flushMs: 5 })
    const session = manager.createSession({ shell: 'powershell', mode: 'block' })

    const { block, finished } = await runAndWait(
      manager,
      events,
      session.id,
      "[Console]::Out.WriteLine(('A' * 4096))",
    )

    expect(finished.status).toBe('done')
    expect(finished.exitCode).toBe(0)
    expect(block.truncated).toBe(true)
    expect(Buffer.byteLength(block.stdout + block.stderr, 'utf8')).toBeLessThanOrEqual(512)
    expect(block.stdout.startsWith('AAAA')).toBe(true)
  }, 30_000)

  it('supports setCwd, clearSession, closeSession, and input validation guards', async () => {
    const initialDir = makeTempDir()
    const nextDir = makeTempDir()
    const { manager, events } = createManager()
    const session = manager.createSession({ shell: 'powershell', mode: 'block', cwd: initialDir })

    await expect(manager.runCommand(session.id, '   ')).rejects.toThrow()

    const updatedCwd = await manager.setCwd(session.id, nextDir)
    expect(fs.realpathSync.native(updatedCwd).toLowerCase()).toBe(nextDir.toLowerCase())
    expect(manager.getSession(session.id)!.blockCount).toBe(0)

    const checkCwd = await runAndWait(manager, events, session.id, '(Get-Location).Path')
    expect(checkCwd.block.stdout.trim().toLowerCase()).toBe(nextDir.toLowerCase())

    const slowStarted = await manager.runCommand(session.id, 'Start-Sleep -Seconds 30')
    await expect(manager.runCommand(session.id, 'Write-Output 1')).rejects.toThrow()
    await manager.interrupt(session.id)
    await waitForEvent(
      events,
      (e) => e.sessionId === session.id && e.blockId === slowStarted.id,
      'block-finished',
    )

    manager.clearSession(session.id)
    expect(events.some((e) => e.type === 'session-cleared' && e.sessionId === session.id)).toBe(
      true,
    )
    expect(manager.getSession(session.id)!.blocks).toEqual([])
    expect(manager.getSession(session.id)!.blockCount).toBe(0)

    manager.closeSession(session.id)
    expect(events.some((e) => e.type === 'session-closed' && e.sessionId === session.id)).toBe(true)
    expect(manager.getSession(session.id)).toBeNull()
    expect(manager.listSessions()).toEqual([])
  }, 30_000)

  it('also executes commands cleanly in CMD sessions', async () => {
    const targetDir = makeTempDir()
    const { manager, events } = createManager()
    const session = manager.createSession({ shell: 'cmd', mode: 'block' })

    const cdRes = await runAndWait(manager, events, session.id, `cd /d "${targetDir}"`)
    expect(cdRes.finished.exitCode).toBe(0)
    expect(fs.realpathSync.native(cdRes.finished.cwd).toLowerCase()).toBe(targetDir.toLowerCase())

    const echoRes = await runAndWait(manager, events, session.id, 'echo cmd-utf8-你好')
    expect(echoRes.finished.exitCode).toBe(0)
    expect(echoRes.block.stdout.trim()).toBe('cmd-utf8-你好')

    const errRes = await runAndWait(manager, events, session.id, 'cmd /c "exit 5"')
    expect(errRes.finished.status).toBe('error')
    expect(errRes.finished.exitCode).toBe(5)
  }, 30_000)

  it('trims oldest blocks FIFO when maxBlocks is exceeded', async () => {
    const { manager, events } = createManager({ maxBlocks: 2 })
    const session = manager.createSession({ shell: 'powershell', mode: 'block' })

    await runAndWait(manager, events, session.id, "Write-Output 'cmd-1'")
    await runAndWait(manager, events, session.id, "Write-Output 'cmd-2'")
    await runAndWait(manager, events, session.id, "Write-Output 'cmd-3'")

    const snap = manager.getSession(session.id)!
    expect(snap.blockCount).toBe(2)
    expect(snap.blocks.map((b) => b.command)).toEqual([
      "Write-Output 'cmd-2'",
      "Write-Output 'cmd-3'",
    ])
  }, 30_000)

  it.skipIf(!detectAvailableShells().some((s) => s.kind === 'bash'))(
    'executes commands and single quotes cleanly in bash sessions when available',
    async () => {
      const targetDir = makeTempDir()
      const { manager, events } = createManager()
      const session = manager.createSession({ shell: 'bash', mode: 'block' })

      const outRes = await runAndWait(
        manager,
        events,
        session.id,
        `printf '%s\\n' 'single-quote-safe & 你好'`,
      )
      expect(outRes.finished.exitCode).toBe(0)
      expect(outRes.block.stdout).toContain('single-quote-safe & 你好')

      const cdRes = await runAndWait(
        manager,
        events,
        session.id,
        `cd '${targetDir.replace(/'/g, `'\\''`)}'`,
      )
      expect(cdRes.finished.exitCode).toBe(0)

      const pwdRes = await runAndWait(manager, events, session.id, 'pwd')
      expect(pwdRes.finished.exitCode).toBe(0)
      expect(pwdRes.block.stdout.trim().length).toBeGreaterThan(0)

      const failRes = await runAndWait(manager, events, session.id, '(exit 9)')
      expect(failRes.finished.status).toBe('error')
      expect(failRes.finished.exitCode).toBe(9)
    },
    30_000,
  )
})

interface MockPtyControl {
  file: string
  args: string[]
  env?: Record<string, string | undefined>
  pid: number
  writes: string[]
  resizes: Array<{ cols: number; rows: number }>
  killed: boolean
  cleared: boolean
  emitData: (chunk: string) => void
  emitExit: (exitCode: number, signal?: number) => void
}

function createFakePtyLoader(onSpawnAttempt?: (file: string, attempt: number) => void): {
  loader: () => PtyLoadResult
  controls: MockPtyControl[]
} {
  const controls: MockPtyControl[] = []
  let attempts = 0

  const loader = (): PtyLoadResult => ({
    available: true,
    source: 'mock-pty',
    spawn: (file, args, options) => {
      attempts += 1
      onSpawnAttempt?.(file, attempts)
      let dataListener: ((data: string) => void) | null = null
      let exitListener: ((ev: { exitCode: number; signal?: number }) => void) | null = null
      const control: MockPtyControl = {
        file,
        args,
        env: options?.env,
        pid: 0,
        writes: [],
        resizes: [],
        killed: false,
        cleared: false,
        emitData: (chunk: string) => dataListener?.(chunk),
        emitExit: (exitCode: number, signal?: number) => exitListener?.({ exitCode, signal }),
      }
      controls.push(control)

      const proc: IPtyProcess = {
        pid: 0,
        write: (data: string) => {
          control.writes.push(data)
        },
        resize: (cols: number, rows: number) => {
          control.resizes.push({ cols, rows })
        },
        kill: () => {
          control.killed = true
        },
        clear: () => {
          control.cleared = true
        },
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

describe('TerminalSessionManager dual-mode PTY engine', () => {
  const managers: TerminalSessionManager[] = []

  afterEach(() => {
    while (managers.length > 0) {
      managers.pop()!.disposeAll()
    }
  })

  it('defaults to pty mode, batches VT data, replays snapshots, and handles write/resize/restart', async () => {
    const events: TerminalEvent[] = []
    const { loader, controls } = createFakePtyLoader()
    const manager = new TerminalSessionManager({
      emit: (ev) => events.push(ev),
      flushMs: 5,
      ptyLoader: loader,
    })
    managers.push(manager)

    const created = manager.createSession({ cols: 90, rows: 28 })
    expect(created.mode).toBe('pty')
    expect(created.running).toBe(true)
    expect(created.cols).toBe(90)
    expect(created.rows).toBe(28)
    expect(controls).toHaveLength(1)

    const first = controls[0]!
    first.emitData('chunk-1 ')
    first.emitData('chunk-2')

    const dataEv = await waitForEvent(
      events,
      (e) => e.sessionId === created.id && e.seq === 1,
      'pty-data',
    )
    expect(dataEv.chunk).toBe('chunk-1 chunk-2')

    const snap = manager.getSession(created.id)!
    expect(snap.ptyBuffer).toBe('chunk-1 chunk-2')
    expect(snap.ptySeq).toBe(1)

    manager.ptyWrite(created.id, 'pi\r')
    expect(first.writes).toContain('pi\r')

    await manager.interrupt(created.id)
    expect(first.writes).toContain('\x03')

    manager.ptyResize(created.id, 1, 0)
    expect(first.resizes).toEqual([{ cols: 2, rows: 1 }])
    manager.ptyResize(created.id, 2, 1)
    expect(first.resizes).toHaveLength(1)

    await expect(manager.runCommand(created.id, 'echo hi')).rejects.toThrow(/PTY mode/i)

    first.emitExit(42)
    const exitEv = await waitForEvent(events, (e) => e.sessionId === created.id, 'pty-exit')
    expect(exitEv.exitCode).toBe(42)
    expect(manager.getSession(created.id)!.running).toBe(false)
    expect(manager.getSession(created.id)!.exitCode).toBe(42)

    manager.ptyRestart(created.id)
    expect(controls).toHaveLength(2)
    expect(manager.getSession(created.id)!.running).toBe(true)
    expect(manager.getSession(created.id)!.ptyBuffer).toBe('')

    manager.clearSession(created.id)
    expect(controls[1]!.cleared).toBe(true)

    manager.closeSession(created.id)
    expect(controls[1]!.killed).toBe(true)
  })

  it('gracefully falls back to block mode when native PTY loader is unavailable or spawn throws', async () => {
    const unavailableEvents: TerminalEvent[] = []
    const unavailableManager = new TerminalSessionManager({
      emit: (ev) => unavailableEvents.push(ev),
      ptyLoader: () => ({ available: false, reason: 'native binary missing' }),
    })
    managers.push(unavailableManager)

    const fallback1 = unavailableManager.createSession()
    expect(fallback1.mode).toBe('block')
    expect(fallback1.fallbackReason).toBe('native binary missing')

    const throwEvents: TerminalEvent[] = []
    const throwingManager = new TerminalSessionManager({
      emit: (ev) => throwEvents.push(ev),
      ptyLoader: () => ({
        available: true,
        source: 'broken-pty',
        spawn: () => {
          throw new Error('ConPTY initialization failure')
        },
      }),
    })
    managers.push(throwingManager)

    const fallback2 = throwingManager.createSession()
    expect(fallback2.mode).toBe('block')
    expect(fallback2.fallbackReason).toContain('ConPTY initialization failure')
  })

  it('automatically falls back to the next available shell when primary PTY spawn throws', () => {
    const events: TerminalEvent[] = []
    const { loader, controls } = createFakePtyLoader((file) => {
      if (file.includes('pwsh')) {
        throw new Error('broken primary shell binary')
      }
    })
    const manager = new TerminalSessionManager({
      emit: (ev) => events.push(ev),
      ptyLoader: loader,
      shellDetector: () => [
        { kind: 'powershell', label: 'PowerShell 7', executable: '/fake/pwsh', available: true },
        { kind: 'cmd', label: 'Command Prompt', executable: '/fake/cmd', available: true },
      ],
    })
    managers.push(manager)

    const session = manager.createSession()
    expect(session.mode).toBe('pty')
    expect(session.shell).toBe('cmd')
    expect(session.title).toBe('Command Prompt')
    expect(session.running).toBe(true)
    expect(controls).toHaveLength(1)
    expect(controls[0]!.file).toBe('/fake/cmd')
  })

  it('hot-swaps to fallback shell on early startup crash without user input, then emits pty-exit after user input', async () => {
    const events: TerminalEvent[] = []
    const { loader, controls } = createFakePtyLoader()
    const manager = new TerminalSessionManager({
      emit: (ev) => events.push(ev),
      flushMs: 0,
      earlyCrashWindowMs: 2000,
      ptyLoader: loader,
      shellDetector: () => [
        { kind: 'powershell', label: 'PowerShell 7', executable: '/fake/pwsh', available: true },
        { kind: 'cmd', label: 'Command Prompt', executable: '/fake/cmd', available: true },
      ],
    })
    managers.push(manager)

    const session = manager.createSession()
    expect(session.shell).toBe('powershell')
    expect(controls).toHaveLength(1)

    // Primary shell crashes immediately before any user input -> seamlessly switch to CMD
    controls[0]!.emitExit(1)

    expect(events.some((e) => e.type === 'pty-exit')).toBe(false)
    expect(controls).toHaveLength(2)
    expect(controls[1]!.file).toBe('/fake/cmd')
    const afterSwitch = manager.getSession(session.id)!
    expect(afterSwitch.running).toBe(true)
    expect(afterSwitch.shell).toBe('cmd')
    expect(afterSwitch.ptyBuffer).toContain('switched')

    // Once user writes input, a subsequent non-zero exit must finish normally instead of looping
    manager.ptyWrite(session.id, 'exit 9\r')
    controls[1]!.emitExit(9)

    const exitEv = await waitForEvent(events, (e) => e.sessionId === session.id, 'pty-exit')
    expect(exitEv.exitCode).toBe(9)
    expect(manager.getSession(session.id)!.running).toBe(false)
  })

  it('injects COLORFGBG=15;0 by default and COLORFGBG=0;15 when colorScheme is light', () => {
    const { loader, controls } = createFakePtyLoader()
    const manager = new TerminalSessionManager({
      emit: () => {},
      flushMs: 0,
      ptyLoader: loader,
      shellDetector: () => [
        { kind: 'powershell', label: 'PowerShell 7', executable: '/fake/pwsh', available: true },
      ],
    })
    managers.push(manager)

    manager.createSession()
    expect(controls[0]!.env?.COLORFGBG).toBe('15;0')

    manager.createSession({ colorScheme: 'light' })
    expect(controls[1]!.env?.COLORFGBG).toBe('0;15')
  })
})

describe.skipIf(!IS_WINDOWS)('TerminalSessionManager real ConPTY integration (Windows)', () => {
  const managers: TerminalSessionManager[] = []

  afterEach(() => {
    while (managers.length > 0) {
      managers.pop()!.disposeAll()
    }
  })

  it('spawns a real default PTY session and streams interactive output', async () => {
    const events: TerminalEvent[] = []
    const manager = new TerminalSessionManager({
      emit: (ev) => events.push(ev),
      flushMs: 10,
    })
    managers.push(manager)

    const session = manager.createSession({ shell: 'cmd', cols: 90, rows: 24 })
    expect(session.mode).toBe('pty')
    expect(session.running).toBe(true)

    manager.ptyWrite(session.id, 'echo __GO_REAL_PTY_OK__\r')

    const collected = await waitForEvent(
      events,
      (e) =>
        e.sessionId === session.id &&
        events
          .filter(
            (item): item is Extract<TerminalEvent, { type: 'pty-data' }> =>
              item.type === 'pty-data',
          )
          .map((item) => item.chunk)
          .join('')
          .includes('__GO_REAL_PTY_OK__'),
      'pty-data',
      15_000,
    )
    expect(collected.seq).toBeGreaterThan(0)

    const snap = manager.getSession(session.id)!
    expect(snap.ptyBuffer).toContain('__GO_REAL_PTY_OK__')

    manager.ptyResize(session.id, 110, 32)
    expect(manager.getSession(session.id)!.cols).toBe(110)
    expect(manager.getSession(session.id)!.rows).toBe(32)
  }, 20_000)
})
