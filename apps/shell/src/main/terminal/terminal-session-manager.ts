import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type {
  TerminalBlock,
  TerminalBlockStatus,
  TerminalColorScheme,
  TerminalCreateOpts,
  TerminalEvent,
  TerminalMode,
  TerminalSessionSnapshot,
  TerminalSessionSummary,
  TerminalShellKind,
  TerminalShellOption,
} from '../../shared/terminal-api'
import {
  loadNodePty,
  type IPtyProcess,
  type PtyDisposable,
  type PtyLoadResult,
  type PtySpawnFn,
} from './pty-loader'
import { PtyReplayBuffer } from './pty-replay-buffer'

const SENTINEL_PREFIX = '__GO_TERM_DONE_'
const INIT_SENTINEL_PREFIX = '__GO_TERM_INIT_'
const CMD_PROMPT_PREFIX = '__GO_CMD_P_'
const DEFAULT_FLUSH_MS = 16
const DEFAULT_MAX_BLOCK_BYTES = 256 * 1024
const DEFAULT_MAX_PTY_BYTES = 256 * 1024
const DEFAULT_MAX_BLOCKS = 100
const STDERR_SETTLE_DELAY_MS = 12
const INTERRUPT_EXIT_CODE = 130
const DEFAULT_PTY_COLS = 100
const DEFAULT_PTY_ROWS = 30
const MIN_PTY_COLS = 2
const MAX_PTY_COLS = 500
const MIN_PTY_ROWS = 1
const MAX_PTY_ROWS = 200
const DEFAULT_EARLY_CRASH_WINDOW_MS = 1200
const DEFAULT_POLICY_PROBE_TIMEOUT_MS = 2500

export interface PowerShellPolicyAssessment {
  gpoBlocked: boolean
  needsProcessRemoteSigned: boolean
  probeFailed: boolean
}

const GPO_BLOCKING_POLICIES = new Set(['restricted', 'allsigned'])
const NEEDS_PROCESS_OVERRIDE_POLICIES = new Set(['restricted', 'allsigned', 'undefined', ''])
const policyProbeCache = new Map<string, PowerShellPolicyAssessment>()

/**
 * Evaluate PowerShell effective vs GPO execution policies.
 */
export function evaluatePowerShellPolicy(
  machinePolicy: string,
  userPolicy: string,
  effectivePolicy: string,
): PowerShellPolicyAssessment {
  const m = machinePolicy.trim().toLowerCase()
  const u = userPolicy.trim().toLowerCase()
  const eff = effectivePolicy.trim().toLowerCase()

  if (GPO_BLOCKING_POLICIES.has(m) || GPO_BLOCKING_POLICIES.has(u)) {
    return { gpoBlocked: true, needsProcessRemoteSigned: false, probeFailed: false }
  }
  if (NEEDS_PROCESS_OVERRIDE_POLICIES.has(eff)) {
    return { gpoBlocked: false, needsProcessRemoteSigned: true, probeFailed: false }
  }
  return { gpoBlocked: false, needsProcessRemoteSigned: false, probeFailed: false }
}

/**
 * Clear the cached PowerShell execution-policy probe results (for unit tests).
 */
export function resetShellProbeCacheForTesting(): void {
  policyProbeCache.clear()
}

// Snapshot host environment at module load before embedded agent startup mutates PATH/XDG/NODE_PATH.
const INITIAL_HOST_ENV: Readonly<Record<string, string | undefined>> = { ...process.env }

function isEmbeddedPiShimDir(entry: string): boolean {
  const normalized = entry
    .trim()
    .replace(/[\\/]+$/, '')
    .replace(/\\/g, '/')
    .toLowerCase()
  return normalized.endsWith('/pi-agent/bin')
}

/**
 * Build an uncluttered host environment for user terminal shells by restoring the
 * pre-agent host snapshot and stripping any embedded `pi-agent/bin` shim entries.
 */
export function buildCleanTerminalEnv(
  baseEnv: NodeJS.ProcessEnv = INITIAL_HOST_ENV,
): Record<string, string | undefined> {
  const cleaned: Record<string, string | undefined> = { ...baseEnv }
  const pathKey = Object.keys(cleaned).find((key) => key.toUpperCase() === 'PATH')
  if (pathKey && typeof cleaned[pathKey] === 'string') {
    cleaned[pathKey] = cleaned[pathKey]!.split(path.delimiter)
      .filter((entry) => entry.trim().length > 0 && !isEmbeddedPiShimDir(entry))
      .join(path.delimiter)
  }
  return cleaned
}

function probePowerShellPolicy(executable: string): PowerShellPolicyAssessment {
  if (process.platform !== 'win32') {
    return { gpoBlocked: false, needsProcessRemoteSigned: false, probeFailed: false }
  }
  const cacheKey = path.normalize(executable).toLowerCase()
  const cached = policyProbeCache.get(cacheKey)
  if (cached) return cached

  let assessment: PowerShellPolicyAssessment
  try {
    const out = execFileSync(
      executable,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$m=Get-ExecutionPolicy -Scope MachinePolicy;$u=Get-ExecutionPolicy -Scope UserPolicy;$e=Get-ExecutionPolicy;Write-Output "$m|$u|$e"',
      ],
      {
        env: buildCleanTerminalEnv(),
        timeout: DEFAULT_POLICY_PROBE_TIMEOUT_MS,
        windowsHide: true,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
    const policyLine = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .reverse()
      .find((line) => line.includes('|'))
    if (!policyLine) {
      assessment = { gpoBlocked: false, needsProcessRemoteSigned: true, probeFailed: true }
    } else {
      const parts = policyLine.split('|')
      if (parts.length < 3) {
        assessment = { gpoBlocked: false, needsProcessRemoteSigned: true, probeFailed: true }
      } else {
        assessment = evaluatePowerShellPolicy(parts[0]!, parts[1]!, parts[2]!)
      }
    }
  } catch {
    assessment = { gpoBlocked: false, needsProcessRemoteSigned: true, probeFailed: true }
  }

  policyProbeCache.set(cacheKey, assessment)
  return assessment
}

export interface TerminalSessionManagerOptions {
  defaultCwd?: () => string
  emit: (event: TerminalEvent) => void
  flushMs?: number
  maxBlockBytes?: number
  maxBlocks?: number
  maxPtyBufferBytes?: number
  ptyLoader?: () => PtyLoadResult
  earlyCrashWindowMs?: number
  shellDetector?: () => TerminalShellOption[]
}

export interface SentinelMatch {
  exitCode: number
  cwd: string
}

export interface SentinelExtractionResult {
  text: string
  remaining: string
  match?: SentinelMatch
}

interface ActiveRunState {
  block: TerminalBlock
  token: string
  silent: boolean
  tempFilePath: string | null
  stdoutRemainder: string
  promptRemainder: string
  pendingStdout: string
  pendingStderr: string
  totalBytes: number
  truncatedNotified: boolean
  pendingTruncatedStream: 'stdout' | 'stderr' | null
  flushTimer: ReturnType<typeof setTimeout> | null
  finishTimer: ReturnType<typeof setTimeout> | null
  pendingSentinel: SentinelMatch | null
  resolveCompletion: () => void
}

interface ProcessState {
  child: ChildProcessWithoutNullStreams
  intentionalExit: boolean
  ready: boolean
  initToken: string
  promptToken: string
  initBuffer: string
  stdoutDecoder: StringDecoder
  stderrDecoder: StringDecoder
  readyPromise: Promise<void>
  resolveReady: () => void
}

interface PtyProcessState {
  term: IPtyProcess
  intentionalExit: boolean
  startedAt: number
  hasUserInput: boolean
  pendingData: string
  flushTimer: ReturnType<typeof setTimeout> | null
  dataSub: PtyDisposable
  exitSub: PtyDisposable
}

interface SessionState {
  id: string
  title: string
  oscTitle?: string
  customTitle: boolean
  shell: TerminalShellKind
  executable: string
  mode: TerminalMode
  colorScheme: TerminalColorScheme
  fallbackReason?: string
  cwd: string
  createdAt: number
  cols: number
  rows: number
  exitCode: number | null
  blocks: TerminalBlock[]
  running: boolean
  createdEmitted: boolean
  triedExecutables: Set<string>
  fallbackChain: TerminalShellOption[]
  activeRun: ActiveRunState | null
  proc: ProcessState | null
  pty: PtyProcessState | null
  ptyBuffer: PtyReplayBuffer
  ptySeq: number
  serialOp: Promise<void>
  pendingCwdSync: string | null
  closed: boolean
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return false
    if (process.platform !== 'win32') {
      fs.accessSync(filePath, fs.constants.X_OK)
    }
    return true
  } catch {
    return false
  }
}

function isValidDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory()
  } catch {
    return false
  }
}

function findInPath(executableName: string): string | null {
  const pathEnv = process.env.PATH ?? ''
  const dirs = pathEnv.split(path.delimiter).filter((dir) => dir.trim().length > 0)
  const isWin = process.platform === 'win32'
  const hasExt = path.extname(executableName).length > 0
  const exts =
    isWin && !hasExt
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
          .split(';')
          .filter((ext) => ext.trim().length > 0)
      : ['']

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, hasExt ? executableName : `${executableName}${ext}`)
      if (isExecutableFile(candidate)) {
        return candidate
      }
    }
  }
  return null
}

function resolveAllCandidateExecutables(candidates: readonly string[]): string[] {
  const results: string[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (!candidate) continue
    let found: string | null = null
    if (path.isAbsolute(candidate)) {
      if (isExecutableFile(candidate)) found = candidate
    } else {
      found = findInPath(candidate)
    }
    if (!found) continue
    const key = path.normalize(found).toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      results.push(found)
    }
  }
  return results
}

function resolveCandidateExecutable(candidates: readonly string[]): string | null {
  const matches = resolveAllCandidateExecutables(candidates)
  return matches[0] ?? null
}

function inferPosixShellKind(shellPath: string): TerminalShellKind | null {
  const base = path.basename(shellPath).toLowerCase()
  if (base === 'zsh' || base.startsWith('zsh')) return 'zsh'
  if (base === 'bash' || base.startsWith('bash')) return 'bash'
  if (base === 'sh' || base === 'dash' || base === 'ash') return 'sh'
  return null
}

function labelForShell(kind: TerminalShellKind): string {
  switch (kind) {
    case 'powershell':
      return 'PowerShell'
    case 'cmd':
      return 'Command Prompt'
    case 'bash':
      return 'Bash'
    case 'zsh':
      return 'Zsh'
    case 'sh':
      return 'Shell'
  }
}

/**
 * Detect available shells on the current platform in priority order.
 * Returns only shells whose executables exist on disk.
 */
export function detectAvailableShells(): TerminalShellOption[] {
  const options: TerminalShellOption[] = []

  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows'
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'

    // Align with VS Code: prefer PowerShell 7 (pwsh.exe) before legacy Windows PowerShell 5.1.
    const psCandidates = resolveAllCandidateExecutables([
      'pwsh.exe',
      path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
      'powershell.exe',
      path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ])
    let chosenPs: string | null = psCandidates[0] ?? null
    let psAssessment: PowerShellPolicyAssessment | null = null
    for (const candidate of psCandidates) {
      const assessment = probePowerShellPolicy(candidate)
      if (!assessment.probeFailed) {
        chosenPs = candidate
        psAssessment = assessment
        break
      }
      if (!psAssessment) psAssessment = assessment
    }
    if (chosenPs) {
      const isPwsh7 = path.basename(chosenPs).toLowerCase().startsWith('pwsh')
      options.push({
        kind: 'powershell',
        label: isPwsh7 ? 'PowerShell 7' : 'PowerShell',
        executable: chosenPs,
        available: true,
      })
    }

    const cmdExe = resolveCandidateExecutable([
      'cmd.exe',
      process.env.ComSpec ?? '',
      path.join(systemRoot, 'System32', 'cmd.exe'),
    ])
    if (cmdExe) {
      options.push({
        kind: 'cmd',
        label: 'Command Prompt',
        executable: cmdExe,
        available: true,
      })
    }

    const bashExe = resolveCandidateExecutable([
      path.join(programFiles, 'Git', 'bin', 'bash.exe'),
      path.join(programFilesX86, 'Git', 'bin', 'bash.exe'),
      'bash.exe',
    ])
    if (bashExe) {
      options.push({
        kind: 'bash',
        label: bashExe.toLowerCase().includes('git') ? 'Git Bash' : 'Bash',
        executable: bashExe,
        available: true,
      })
    }

    // If GPO locks PowerShell script execution or PowerShell fails to probe, elevate CMD to default.
    if (psAssessment && (psAssessment.gpoBlocked || psAssessment.probeFailed)) {
      const cmdIdx = options.findIndex((item) => item.kind === 'cmd')
      if (cmdIdx > 0) {
        const [cmdOption] = options.splice(cmdIdx, 1)
        options.unshift(cmdOption!)
      }
    }

    return options
  }

  const seenKinds = new Set<TerminalShellKind>()
  const envShell = process.env.SHELL?.trim()
  if (envShell && isExecutableFile(envShell)) {
    const kind = inferPosixShellKind(envShell)
    if (kind && !seenKinds.has(kind)) {
      seenKinds.add(kind)
      options.push({
        kind,
        label: labelForShell(kind),
        executable: envShell,
        available: true,
      })
    }
  }

  const posixSpecs: ReadonlyArray<{ kind: TerminalShellKind; paths: string[] }> = [
    { kind: 'zsh', paths: ['/bin/zsh', '/usr/bin/zsh'] },
    { kind: 'bash', paths: ['/bin/bash', '/usr/bin/bash'] },
    { kind: 'sh', paths: ['/bin/sh'] },
  ]

  for (const spec of posixSpecs) {
    if (seenKinds.has(spec.kind)) continue
    const found = resolveCandidateExecutable(spec.paths)
    if (found) {
      seenKinds.add(spec.kind)
      options.push({
        kind: spec.kind,
        label: labelForShell(spec.kind),
        executable: found,
        available: true,
      })
    }
  }

  return options
}

/**
 * Select the preferred default shell kind for the current platform.
 */
export function defaultShellKind(): TerminalShellKind {
  const available = detectAvailableShells()
  if (available.length > 0) {
    return available[0]!.kind
  }
  return process.platform === 'win32' ? 'powershell' : 'sh'
}

/**
 * Extract a command-completion sentinel line from a buffered stdout stream.
 * Holds back incomplete sentinel prefixes or unterminated sentinel lines in `remaining`.
 */
export function extractSentinelFromBuffer(buffer: string, token: string): SentinelExtractionResult {
  if (!buffer) {
    return { text: '', remaining: '' }
  }

  const fullPrefix = `${SENTINEL_PREFIX}${token}__|`
  const sentinelRegex = new RegExp(`\\r?${escapeRegex(fullPrefix)}(-?\\d+)\\|([^\\r\\n]*)\\r?\\n`)
  const regexMatch = sentinelRegex.exec(buffer)

  if (regexMatch && regexMatch.index !== undefined) {
    const text = buffer.slice(0, regexMatch.index)
    const remaining = buffer.slice(regexMatch.index + regexMatch[0].length)
    return {
      text,
      remaining,
      match: {
        exitCode: Number.parseInt(regexMatch[1]!, 10),
        cwd: regexMatch[2]!,
      },
    }
  }

  const fullIdx = buffer.indexOf(fullPrefix)
  if (fullIdx !== -1) {
    const cutIdx = fullIdx > 0 && buffer[fullIdx - 1] === '\r' ? fullIdx - 1 : fullIdx
    return {
      text: buffer.slice(0, cutIdx),
      remaining: buffer.slice(cutIdx),
    }
  }

  const maxPartialLen = Math.min(buffer.length, fullPrefix.length - 1)
  for (let len = maxPartialLen; len >= 1; len -= 1) {
    if (buffer.endsWith(fullPrefix.slice(0, len))) {
      let cutIdx = buffer.length - len
      if (cutIdx > 0 && buffer[cutIdx - 1] === '\r') {
        cutIdx -= 1
      }
      return {
        text: buffer.slice(0, cutIdx),
        remaining: buffer.slice(cutIdx),
      }
    }
  }

  return { text: buffer, remaining: '' }
}

/**
 * Strip synthetic CMD prompt tokens from stdout while holding back partial prompt sequences.
 */
function stripCmdPromptFromBuffer(
  buffer: string,
  promptMarker: string,
): { text: string; remaining: string } {
  const cleaned = buffer.replace(new RegExp(`(?:\\r?\\n)?${escapeRegex(promptMarker)}`, 'g'), '')
  const maxLen = Math.min(cleaned.length, promptMarker.length - 1)
  for (let len = maxLen; len >= 1; len -= 1) {
    if (cleaned.endsWith(promptMarker.slice(0, len))) {
      const cutIdx = cleaned.length - len
      return {
        text: cleaned.slice(0, cutIdx),
        remaining: cleaned.slice(cutIdx),
      }
    }
  }

  return {
    text: cleaned,
    remaining: '',
  }
}

function truncateUtf8ToBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || !value) return ''
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value

  let usedBytes = 0
  let endIndex = 0
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, 'utf8')
    if (usedBytes + charBytes > maxBytes) break
    usedBytes += charBytes
    endIndex += char.length
  }
  return value.slice(0, endIndex)
}

function needsProcessPolicyOverride(executable: string): boolean {
  if (!executable || process.platform !== 'win32') return false
  const assessment = probePowerShellPolicy(executable)
  return !assessment.gpoBlocked && assessment.needsProcessRemoteSigned
}

function getShellArgs(shell: TerminalShellKind, executable = ''): string[] {
  switch (shell) {
    case 'powershell':
      return needsProcessPolicyOverride(executable)
        ? ['-NoLogo', '-NoProfile', '-NoExit', '-ExecutionPolicy', 'RemoteSigned', '-Command', '-']
        : ['-NoLogo', '-NoProfile', '-NoExit', '-Command', '-']
    case 'cmd':
      return ['/Q', '/K', 'chcp 65001 >nul']
    case 'bash':
      return ['--noprofile', '--norc']
    case 'zsh':
    case 'sh':
      return ['-f']
  }
}

function getInteractivePtyArgs(shell: TerminalShellKind, executable: string): string[] {
  switch (shell) {
    case 'powershell':
      return needsProcessPolicyOverride(executable)
        ? ['-NoLogo', '-ExecutionPolicy', 'RemoteSigned']
        : ['-NoLogo']
    case 'cmd':
      return []
    case 'bash':
      return executable.toLowerCase().includes('git') ? ['--login', '-i'] : ['-i']
    case 'zsh':
    case 'sh':
      return ['-i']
  }
}

function buildShellFallbackChain(
  available: readonly TerminalShellOption[],
  primary: TerminalShellOption,
): TerminalShellOption[] {
  return [primary, ...available.filter((opt) => opt.executable !== primary.executable)]
}

function isInteractiveUserInput(data: string): boolean {
  // Ignore terminal query/reply sequences (DSR/OSC/DA) emitted automatically by xterm.
  if (data.startsWith('\x1b') && !data.includes('\r') && !data.includes('\n')) {
    return false
  }
  return data.length > 0
}

function clampPtyCols(raw?: number): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_PTY_COLS
  return Math.min(MAX_PTY_COLS, Math.max(MIN_PTY_COLS, Math.round(raw)))
}

function clampPtyRows(raw?: number): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_PTY_ROWS
  return Math.min(MAX_PTY_ROWS, Math.max(MIN_PTY_ROWS, Math.round(raw)))
}

function buildInitCommand(shell: TerminalShellKind, initToken: string): string {
  const marker = `${INIT_SENTINEL_PREFIX}${initToken}__`
  switch (shell) {
    case 'powershell':
      return (
        '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); ' +
        '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ' +
        '$OutputEncoding = [System.Text.UTF8Encoding]::new($false); ' +
        `[Console]::Out.WriteLine("${marker}")\r\n`
      )
    case 'cmd':
      return `echo ${marker}\r\n`
    case 'bash':
    case 'zsh':
    case 'sh':
      return `printf '${marker}\\n'\n`
  }
}

function buildWrappedCommand(
  shell: TerminalShellKind,
  command: string,
  token: string,
): { input: string; tempFilePath: string | null } {
  if (shell === 'powershell') {
    const b64 = Buffer.from(command, 'utf8').toString('base64')
    const input =
      '. { param($__b64) ' +
      '$global:LASTEXITCODE = 0; $global:__go_ok = $true; ' +
      '$__src = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($__b64)); ' +
      'try { ' +
      '$null = [ScriptBlock]::Create($__src); ' +
      '$__sb = [ScriptBlock]::Create($__src + "`n`$global:__go_ok = `$?"); ' +
      '. $__sb; ' +
      '$__ok = $global:__go_ok; ' +
      '$__ec = if ($null -ne $global:LASTEXITCODE -and $global:LASTEXITCODE -ne 0) { [int]$global:LASTEXITCODE } elseif ($__ok) { 0 } else { 1 } ' +
      '} catch { ' +
      '[Console]::Error.WriteLine($_.ToString()); $__ec = 1 ' +
      '}; ' +
      `try { if ((Get-Location).Provider.Name -eq 'FileSystem') { [System.IO.Directory]::SetCurrentDirectory((Get-Location).Path) } } catch {}; ` +
      `[Console]::Out.WriteLine("${SENTINEL_PREFIX}${token}__|$__ec|$((Get-Location).Path)") ` +
      `} '${b64}'\r\n`
    return { input, tempFilePath: null }
  }

  if (shell === 'cmd') {
    // cmd.exe misparses non-ASCII UTF-8 bytes sent via piped stdin ("More?"), so execute via a temp batch file.
    if (Array.from(command).some((ch) => ch.charCodeAt(0) > 0x7f)) {
      const tempFilePath = path.join(os.tmpdir(), `go-term-${token}.cmd`)
      const normalized = command.replace(/\r?\n/g, '\r\n')
      fs.writeFileSync(tempFilePath, `@echo off\r\n${normalized}\r\n`, 'utf8')
      const input = `(call ) & call "${tempFilePath}"\r\necho ${SENTINEL_PREFIX}${token}__^|%ERRORLEVEL%^|%CD%\r\n`
      return { input, tempFilePath }
    }

    const joined = command
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0)
      .join(' & ')
    const input = `(call ) & ${joined}\r\necho ${SENTINEL_PREFIX}${token}__^|%ERRORLEVEL%^|%CD%\r\n`
    return { input, tempFilePath: null }
  }

  const b64 = Buffer.from(command, 'utf8').toString('base64')
  const input =
    `eval "$(printf '%s' '${b64}' | (base64 -d 2>/dev/null || base64 -D))" ; ` +
    `__go_ec=$? ; ` +
    `printf '${SENTINEL_PREFIX}${token}__|%d|%s\\n' "$__go_ec" "$PWD"\n`
  return { input, tempFilePath: null }
}

function buildCdCommand(shell: TerminalShellKind, dir: string): string {
  switch (shell) {
    case 'powershell':
      return `Set-Location -LiteralPath '${dir.replace(/'/g, "''")}'`
    case 'cmd':
      return `cd /d "${dir.replace(/"/g, '')}"`
    case 'bash':
    case 'zsh':
    case 'sh':
      return `cd '${dir.replace(/'/g, `'\\''`)}'`
  }
}

function killProcessTreeSync(pid: number): void {
  if (!pid || pid <= 0) return
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
    } catch {
      // Ignore if the process already exited.
    }
    return
  }

  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Ignore if the process already exited.
    }
  }
}

function killProcessTreeAsync(pid: number): Promise<void> {
  if (!pid || pid <= 0) return Promise.resolve()
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {
        resolve()
      })
    })
  }

  killProcessTreeSync(pid)
  return Promise.resolve()
}

function cloneBlock(block: TerminalBlock): TerminalBlock {
  return { ...block }
}

/**
 * Manages persistent block-based shell sessions backed by child processes.
 */
export class TerminalSessionManager {
  private readonly defaultCwdFn: (() => string) | undefined
  private readonly rawEmit: (event: TerminalEvent) => void
  private readonly eventListeners = new Set<(event: TerminalEvent) => void>()
  private readonly flushMs: number
  private readonly maxBlockBytes: number
  private readonly maxBlocks: number
  private readonly maxPtyBufferBytes: number
  private readonly ptyLoader: () => PtyLoadResult
  private readonly earlyCrashWindowMs: number
  private readonly shellDetector: () => TerminalShellOption[]
  private readonly sessions = new Map<string, SessionState>()
  private sessionSeq = 0
  private disposed = false

  private readonly emit = (event: TerminalEvent): void => {
    this.rawEmit(event)
    for (const listener of this.eventListeners) {
      listener(event)
    }
  }

  constructor(options: TerminalSessionManagerOptions) {
    this.defaultCwdFn = options.defaultCwd
    this.rawEmit = options.emit
    this.flushMs = options.flushMs ?? DEFAULT_FLUSH_MS
    this.maxBlockBytes = options.maxBlockBytes ?? DEFAULT_MAX_BLOCK_BYTES
    this.maxBlocks = options.maxBlocks ?? DEFAULT_MAX_BLOCKS
    this.maxPtyBufferBytes = options.maxPtyBufferBytes ?? DEFAULT_MAX_PTY_BYTES
    this.ptyLoader = options.ptyLoader ?? loadNodePty
    this.earlyCrashWindowMs = options.earlyCrashWindowMs ?? DEFAULT_EARLY_CRASH_WINDOW_MS
    this.shellDetector = options.shellDetector ?? detectAvailableShells
  }

  onEvent(listener: (event: TerminalEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  isDisposed(): boolean {
    return this.disposed
  }

  defaultCwd(): string {
    return this.resolveInitialCwd()
  }

  renameSession(sessionId: string, title: string): TerminalSessionSummary {
    const session = this.requireSession(sessionId)
    const normalized = title.trim()
    if (!normalized) {
      throw new Error('Session title must not be empty')
    }
    session.title = normalized
    session.customTitle = true
    const summary = this.toSummary(session)
    this.emit({ type: 'session-updated', session: summary })
    return summary
  }

  setOscTitle(sessionId: string, oscTitle: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.closed || this.disposed) return
    const next = oscTitle.trim()
    if ((session.oscTitle ?? '') === next) return
    session.oscTitle = next || undefined
    this.emit({ type: 'session-updated', session: this.toSummary(session) })
  }

  listShells(): TerminalShellOption[] {
    return this.shellDetector()
  }

  listSessions(): TerminalSessionSummary[] {
    return Array.from(this.sessions.values(), (session) => this.toSummary(session))
  }

  getSession(sessionId: string): TerminalSessionSnapshot | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    if (session.mode === 'pty' && session.pty?.pendingData) {
      this.flushPtyOutput(session, session.pty)
    }
    return this.toSnapshot(session)
  }

  createSession(opts?: TerminalCreateOpts): TerminalSessionSnapshot {
    if (this.disposed) {
      throw new Error('TerminalSessionManager has been disposed')
    }

    const available = this.shellDetector().filter((item) => item.available)
    const fallbackDefault =
      available[0]?.kind ?? (process.platform === 'win32' ? 'powershell' : 'sh')
    const requestedKind = opts?.shell ?? fallbackDefault
    const shellOption = available.find((item) => item.kind === requestedKind)
    if (!shellOption) {
      throw new Error(`Shell is not available: ${requestedKind}`)
    }

    const cwd = this.resolveInitialCwd(opts?.cwd)
    const id = `term-${++this.sessionSeq}-${crypto.randomBytes(4).toString('hex')}`
    const customTitle = Boolean(opts?.title?.trim())
    const title = opts?.title?.trim() || shellOption.label
    const requestedMode: TerminalMode = opts?.mode ?? 'pty'
    const colorScheme: TerminalColorScheme = opts?.colorScheme ?? 'dark'
    const fallbackChain = buildShellFallbackChain(available, shellOption)

    const session: SessionState = {
      id,
      title,
      customTitle,
      shell: shellOption.kind,
      executable: shellOption.executable,
      mode: requestedMode,
      colorScheme,
      cwd,
      createdAt: Date.now(),
      cols: clampPtyCols(opts?.cols),
      rows: clampPtyRows(opts?.rows),
      exitCode: null,
      blocks: [],
      running: false,
      createdEmitted: false,
      triedExecutables: new Set<string>(),
      fallbackChain,
      activeRun: null,
      proc: null,
      pty: null,
      ptyBuffer: new PtyReplayBuffer(this.maxPtyBufferBytes),
      ptySeq: 0,
      serialOp: Promise.resolve(),
      pendingCwdSync: null,
      closed: false,
    }

    this.sessions.set(id, session)

    if (requestedMode === 'pty') {
      const loaded = this.ptyLoader()
      if (loaded.available) {
        let lastSpawnErr: unknown = null
        let spawned = false
        for (const candidate of fallbackChain) {
          session.triedExecutables.add(candidate.executable)
          session.shell = candidate.kind
          session.executable = candidate.executable
          if (!session.customTitle) {
            session.title = candidate.label
          }
          try {
            this.spawnPtyProcess(session, loaded.spawn)
            spawned = true
            break
          } catch (err) {
            lastSpawnErr = err
            session.pty = null
            session.running = false
          }
        }
        if (!spawned) {
          session.shell = shellOption.kind
          session.executable = shellOption.executable
          if (!session.customTitle) {
            session.title = shellOption.label
          }
          session.mode = 'block'
          session.running = false
          session.pty = null
          session.fallbackReason =
            lastSpawnErr instanceof Error ? lastSpawnErr.message : String(lastSpawnErr)
          this.spawnShellProcess(session)
        }
      } else {
        session.mode = 'block'
        session.fallbackReason = loaded.reason
        this.spawnShellProcess(session)
      }
    } else {
      this.spawnShellProcess(session)
    }

    const snapshot = this.toSnapshot(session)
    session.createdEmitted = true
    this.emit({ type: 'session-created', session: snapshot })
    if (session.mode === 'pty' && session.pty?.pendingData) {
      this.schedulePtyFlush(session, session.pty)
    }
    return snapshot
  }

  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.closed) return

    session.closed = true
    this.sessions.delete(sessionId)

    const ptyState = session.pty
    session.pty = null
    if (ptyState) {
      this.terminatePtySync(ptyState)
    }

    const active = session.activeRun
    if (active) {
      this.cleanupRunResources(active)
      active.pendingSentinel = null
      this.flushPendingOutput(session, active)
      session.activeRun = null
      session.running = false
      active.resolveCompletion()
    }

    const proc = session.proc
    session.proc = null
    if (proc) {
      this.terminateProcessSync(proc)
    }

    this.emit({ type: 'session-closed', sessionId })
  }

  /**
   * Enqueue a command on the session's persistent shell process.
   * Resolves immediately with the newly created `running` block once written to stdin and
   * `block-started` is emitted; streaming output and completion arrive via `emit` events.
   */
  async runCommand(sessionId: string, command: string): Promise<TerminalBlock> {
    const session = this.requireSession(sessionId)
    if (session.mode === 'pty') {
      throw new Error(`Session ${sessionId} is in PTY mode; use ptyWrite instead`)
    }
    if (!command.trim()) {
      throw new Error('Command must not be empty')
    }
    if (session.running || session.activeRun) {
      throw new Error(`Session ${sessionId} already has a running command`)
    }

    // Wait for any pending silent cwd sync before starting the user block.
    await session.serialOp
    if (session.closed || this.disposed) {
      throw new Error(`Session ${sessionId} is closed`)
    }
    if (session.running || session.activeRun) {
      throw new Error(`Session ${sessionId} already has a running command`)
    }

    if (!session.proc) {
      this.spawnShellProcess(session)
    }
    const proc = session.proc!
    await proc.readyPromise
    if (session.closed || this.disposed) {
      throw new Error(`Session ${sessionId} is closed`)
    }
    if (session.running || session.activeRun) {
      throw new Error(`Session ${sessionId} already has a running command`)
    }

    // Sync deferred cwd change if setCwd was called while a prior command was running.
    if (session.pendingCwdSync) {
      const targetCwd = session.pendingCwdSync
      session.pendingCwdSync = null
      await this.runSilentCd(session, targetCwd)
      if (session.closed || this.disposed) {
        throw new Error(`Session ${sessionId} is closed`)
      }
    }

    const activeProc = session.proc ?? this.spawnShellProcess(session)
    if (!activeProc.ready) {
      await activeProc.readyPromise
      if (session.closed || this.disposed) {
        throw new Error(`Session ${sessionId} is closed`)
      }
    }
    if (session.running || session.activeRun) {
      throw new Error(`Session ${sessionId} already has a running command`)
    }

    const token = crypto.randomBytes(8).toString('hex')
    const block: TerminalBlock = {
      id: `blk-${crypto.randomBytes(6).toString('hex')}`,
      command,
      cwd: session.cwd,
      startedAt: Date.now(),
      status: 'running',
      stdout: '',
      stderr: '',
    }

    if (session.blocks.length >= this.maxBlocks) {
      session.blocks.splice(0, session.blocks.length - this.maxBlocks + 1)
    }
    session.blocks.push(block)
    session.running = true

    const wrapped = buildWrappedCommand(session.shell, command, token)
    const activeRun: ActiveRunState = {
      block,
      token,
      silent: false,
      tempFilePath: wrapped.tempFilePath,
      stdoutRemainder: '',
      promptRemainder: '',
      pendingStdout: '',
      pendingStderr: '',
      totalBytes: 0,
      truncatedNotified: false,
      pendingTruncatedStream: null,
      flushTimer: null,
      finishTimer: null,
      pendingSentinel: null,
      resolveCompletion: () => {},
    }
    session.activeRun = activeRun

    this.emit({ type: 'block-started', sessionId, block: cloneBlock(block) })
    this.emit({ type: 'session-updated', session: this.toSummary(session) })

    activeProc.child.stdin.write(wrapped.input)

    return cloneBlock(block)
  }

  ptyWrite(sessionId: string, data: string): void {
    const session = this.requireSession(sessionId)
    if (session.mode !== 'pty') {
      throw new Error(`Session ${sessionId} is not in PTY mode`)
    }
    if (!data || !session.pty) return
    if (isInteractiveUserInput(data)) {
      session.pty.hasUserInput = true
    }
    session.pty.term.write(data)
  }

  ptyResize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.closed || session.mode !== 'pty' || !session.running) return
    const nextCols = clampPtyCols(cols)
    const nextRows = clampPtyRows(rows)
    if (nextCols === session.cols && nextRows === session.rows) return
    session.cols = nextCols
    session.rows = nextRows
    if (session.pty) {
      try {
        session.pty.term.resize(nextCols, nextRows)
      } catch {
        // Ignore transient resize failures when the PTY handle is tearing down.
      }
    }
  }

  ptyRestart(sessionId: string): void {
    const session = this.requireSession(sessionId)
    if (session.mode !== 'pty') {
      throw new Error(`Session ${sessionId} is not in PTY mode`)
    }

    const oldPty = session.pty
    session.pty = null
    if (oldPty) {
      this.terminatePtySync(oldPty)
    }

    session.ptyBuffer.clear()
    session.exitCode = null
    session.triedExecutables.clear()
    session.triedExecutables.add(session.executable)
    const loaded = this.ptyLoader()
    if (!loaded.available) {
      throw new Error(loaded.reason)
    }

    const spawned = this.spawnPtyProcess(session, loaded.spawn)
    this.emit({ type: 'session-cleared', sessionId: session.id })
    this.emit({ type: 'session-updated', session: this.toSummary(session) })
    if (spawned.pendingData) {
      this.schedulePtyFlush(session, spawned)
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId)
    if (session.mode === 'pty') {
      if (session.pty) {
        session.pty.term.write('\x03')
      }
      return
    }

    const active = session.activeRun
    if (active) {
      this.cleanupRunResources(active)
      active.pendingSentinel = null
      this.flushPendingOutput(session, active)

      const finishedAt = Date.now()
      active.block.status = 'interrupted'
      active.block.exitCode = INTERRUPT_EXIT_CODE
      active.block.finishedAt = finishedAt
      active.block.cwd = session.cwd

      session.activeRun = null
      session.running = false

      if (!active.silent) {
        this.emit({
          type: 'block-finished',
          sessionId: session.id,
          blockId: active.block.id,
          status: 'interrupted',
          exitCode: INTERRUPT_EXIT_CODE,
          cwd: session.cwd,
          finishedAt,
        })
      }
      active.resolveCompletion()
    } else {
      session.running = false
    }

    const oldProc = session.proc
    session.proc = null
    if (oldProc) {
      oldProc.intentionalExit = true
      oldProc.resolveReady()
      oldProc.child.stdin.destroy()
      oldProc.child.stdout.destroy()
      oldProc.child.stderr.destroy()
    }

    // Spawn replacement shell immediately so subsequent commands can queue right away.
    if (!session.closed && !this.disposed) {
      this.spawnShellProcess(session)
    }

    if (oldProc?.child.pid) {
      await killProcessTreeAsync(oldProc.child.pid)
    }

    if (!session.closed && !this.disposed) {
      this.emit({ type: 'session-updated', session: this.toSummary(session) })
    }
  }

  clearSession(sessionId: string): void {
    const session = this.requireSession(sessionId)
    if (session.mode === 'pty') {
      session.ptyBuffer.clear()
      session.pty?.term.clear?.()
      this.emit({ type: 'session-cleared', sessionId })
      this.emit({ type: 'session-updated', session: this.toSummary(session) })
      return
    }
    session.blocks = session.activeRun && !session.activeRun.silent ? [session.activeRun.block] : []
    this.emit({ type: 'session-cleared', sessionId })
    this.emit({ type: 'session-updated', session: this.toSummary(session) })
  }

  async setCwd(sessionId: string, dir: string): Promise<string> {
    const session = this.requireSession(sessionId)
    if (!dir || !isValidDirectory(dir)) {
      throw new Error(`Directory does not exist: ${dir}`)
    }

    const resolvedDir = path.resolve(dir)
    if (session.mode === 'pty') {
      session.cwd = resolvedDir
      if (session.pty) {
        session.pty.hasUserInput = true
        session.pty.term.write(`${buildCdCommand(session.shell, resolvedDir)}\r`)
      }
      this.emit({ type: 'session-updated', session: this.toSummary(session) })
      return session.cwd
    }
    if (session.running || session.activeRun) {
      session.cwd = resolvedDir
      session.pendingCwdSync = resolvedDir
      this.emit({ type: 'session-updated', session: this.toSummary(session) })
      return session.cwd
    }

    const op = session.serialOp.then(async () => {
      if (session.closed || this.disposed) return
      if (session.running || session.activeRun) {
        session.cwd = resolvedDir
        session.pendingCwdSync = resolvedDir
        this.emit({ type: 'session-updated', session: this.toSummary(session) })
        return
      }
      await this.runSilentCd(session, resolvedDir)
      this.emit({ type: 'session-updated', session: this.toSummary(session) })
    })

    session.serialOp = op.catch(() => undefined)
    await op
    return session.cwd
  }

  disposeAll(): void {
    this.disposed = true
    for (const session of this.sessions.values()) {
      session.closed = true
      const ptyState = session.pty
      session.pty = null
      if (ptyState) {
        this.terminatePtySync(ptyState)
      }
      const active = session.activeRun
      if (active) {
        this.cleanupRunResources(active)
        session.activeRun = null
        active.resolveCompletion()
      }
      const proc = session.proc
      session.proc = null
      if (proc) {
        this.terminateProcessSync(proc)
      }
    }
    this.sessions.clear()
  }

  private terminateProcessSync(proc: ProcessState): void {
    proc.intentionalExit = true
    proc.resolveReady()
    proc.child.stdin.destroy()
    proc.child.stdout.destroy()
    proc.child.stderr.destroy()
    if (proc.child.pid) {
      killProcessTreeSync(proc.child.pid)
    }
  }

  private resolveInitialCwd(requestedCwd?: string): string {
    if (requestedCwd !== undefined) {
      if (!requestedCwd.trim() || !isValidDirectory(requestedCwd)) {
        throw new Error(`Invalid working directory: ${requestedCwd}`)
      }
      return path.resolve(requestedCwd)
    }

    const candidate = this.defaultCwdFn?.()?.trim()
    if (candidate && isValidDirectory(candidate)) {
      return path.resolve(candidate)
    }

    const processDir = process.cwd()
    if (isValidDirectory(processDir)) {
      return processDir
    }
    return os.homedir()
  }

  private requireSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId)
    if (!session || session.closed) {
      throw new Error(`Terminal session not found: ${sessionId}`)
    }
    return session
  }

  private toSummary(session: SessionState): TerminalSessionSummary {
    return {
      id: session.id,
      title: session.title,
      ...(session.oscTitle ? { oscTitle: session.oscTitle } : {}),
      shell: session.shell,
      mode: session.mode,
      ...(session.fallbackReason ? { fallbackReason: session.fallbackReason } : {}),
      cwd: session.cwd,
      running: session.running,
      blockCount: session.blocks.length,
      cols: session.cols,
      rows: session.rows,
      exitCode: session.exitCode,
      createdAt: session.createdAt,
    }
  }

  private toSnapshot(session: SessionState): TerminalSessionSnapshot {
    return {
      ...this.toSummary(session),
      blocks: session.blocks.map(cloneBlock),
      ...(session.mode === 'pty'
        ? { ptyBuffer: session.ptyBuffer.snapshot(), ptySeq: session.ptySeq }
        : {}),
    }
  }

  private spawnPtyProcess(session: SessionState, spawnFn: PtySpawnFn): PtyProcessState {
    const env: Record<string, string | undefined> = {
      ...buildCleanTerminalEnv(),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      COLORFGBG: session.colorScheme === 'light' ? '0;15' : '15;0',
      TERM_PROGRAM: 'GenOffice',
    }
    const term = spawnFn(
      session.executable,
      getInteractivePtyArgs(session.shell, session.executable),
      {
        name: 'xterm-256color',
        cols: session.cols,
        rows: session.rows,
        cwd: session.cwd,
        env,
        ...(process.platform === 'win32' ? {} : { encoding: 'utf8' }),
      },
    )

    const ptyState: PtyProcessState = {
      term,
      intentionalExit: false,
      startedAt: Date.now(),
      hasUserInput: false,
      pendingData: '',
      flushTimer: null,
      dataSub: { dispose: () => {} },
      exitSub: { dispose: () => {} },
    }
    session.pty = ptyState
    session.running = true
    session.exitCode = null

    ptyState.dataSub = term.onData((data) => {
      this.handlePtyData(session, ptyState, data)
    })

    ptyState.exitSub = term.onExit(({ exitCode, signal }) => {
      this.handlePtyExit(session, ptyState, exitCode, signal)
    })

    return ptyState
  }

  private handlePtyData(session: SessionState, ptyState: PtyProcessState, data: string): void {
    if (!data || session.pty !== ptyState || session.closed || this.disposed) return
    ptyState.pendingData += data
    if (session.createdEmitted) {
      this.schedulePtyFlush(session, ptyState)
    }
  }

  private schedulePtyFlush(session: SessionState, ptyState: PtyProcessState): void {
    if (this.flushMs <= 0) {
      this.flushPtyOutput(session, ptyState)
      return
    }
    if (ptyState.flushTimer) return
    ptyState.flushTimer = setTimeout(() => {
      ptyState.flushTimer = null
      if (session.pty === ptyState && !session.closed && !this.disposed) {
        this.flushPtyOutput(session, ptyState)
      }
    }, this.flushMs)
  }

  private flushPtyOutput(session: SessionState, ptyState: PtyProcessState): void {
    if (ptyState.flushTimer) {
      clearTimeout(ptyState.flushTimer)
      ptyState.flushTimer = null
    }
    if (!ptyState.pendingData) return
    const chunk = ptyState.pendingData
    ptyState.pendingData = ''
    session.ptyBuffer.append(chunk)
    session.ptySeq += 1
    this.emit({
      type: 'pty-data',
      sessionId: session.id,
      chunk,
      seq: session.ptySeq,
    })
  }

  private handlePtyExit(
    session: SessionState,
    ptyState: PtyProcessState,
    exitCode: number,
    signal?: number,
  ): void {
    if (session.pty !== ptyState) return
    this.flushPtyOutput(session, ptyState)
    ptyState.dataSub.dispose()
    ptyState.exitSub.dispose()
    session.pty = null

    if (ptyState.intentionalExit || session.closed || this.disposed) return

    const elapsedMs = Date.now() - ptyState.startedAt
    const isEarlyCrash =
      !ptyState.hasUserInput && exitCode !== 0 && elapsedMs <= this.earlyCrashWindowMs
    if (isEarlyCrash) {
      const nextOpt = session.fallbackChain.find(
        (candidate) => !session.triedExecutables.has(candidate.executable),
      )
      const loaded = nextOpt ? this.ptyLoader() : null
      if (nextOpt && loaded?.available) {
        const previousTitle = session.title
        session.triedExecutables.add(nextOpt.executable)
        session.shell = nextOpt.kind
        session.executable = nextOpt.executable
        if (!session.customTitle) {
          session.title = nextOpt.label
        }
        try {
          const respawned = this.spawnPtyProcess(session, loaded.spawn)
          const notice = `\r\n\x1b[33m[GenOffice] ${previousTitle} exited early (code ${exitCode}); automatically switched to ${nextOpt.label}.\x1b[0m\r\n`
          this.handlePtyData(session, respawned, notice)
          this.emit({ type: 'session-updated', session: this.toSummary(session) })
          return
        } catch {
          session.pty = null
        }
      }
    }

    session.running = false
    session.exitCode = exitCode
    this.emit({
      type: 'pty-exit',
      sessionId: session.id,
      exitCode,
      ...(signal !== undefined ? { signal } : {}),
    })
    this.emit({ type: 'session-updated', session: this.toSummary(session) })
  }

  private terminatePtySync(ptyState: PtyProcessState): void {
    ptyState.intentionalExit = true
    if (ptyState.flushTimer) {
      clearTimeout(ptyState.flushTimer)
      ptyState.flushTimer = null
    }
    ptyState.pendingData = ''
    ptyState.dataSub.dispose()
    ptyState.exitSub.dispose()
    const pid = ptyState.term.pid
    try {
      ptyState.term.kill()
    } catch {
      // Ignore errors when the PTY already terminated.
    }
    if (pid) {
      killProcessTreeSync(pid)
    }
  }

  private async runSilentCd(session: SessionState, targetDir: string): Promise<void> {
    if (!session.proc) {
      this.spawnShellProcess(session)
    }
    const proc = session.proc!
    await proc.readyPromise
    if (session.closed || this.disposed) return

    const token = crypto.randomBytes(8).toString('hex')
    const dummyBlock: TerminalBlock = {
      id: `silent-${token}`,
      command: '',
      cwd: session.cwd,
      startedAt: Date.now(),
      status: 'running',
      stdout: '',
      stderr: '',
    }

    let resolveCompletion!: () => void
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve
    })

    const cdCommand = buildCdCommand(session.shell, targetDir)
    const wrapped = buildWrappedCommand(session.shell, cdCommand, token)

    session.activeRun = {
      block: dummyBlock,
      token,
      silent: true,
      tempFilePath: wrapped.tempFilePath,
      stdoutRemainder: '',
      promptRemainder: '',
      pendingStdout: '',
      pendingStderr: '',
      totalBytes: 0,
      truncatedNotified: false,
      pendingTruncatedStream: null,
      flushTimer: null,
      finishTimer: null,
      pendingSentinel: null,
      resolveCompletion,
    }

    proc.child.stdin.write(wrapped.input)
    await completion

    if (dummyBlock.status === 'done') {
      session.cwd = dummyBlock.cwd || targetDir
    } else {
      throw new Error(dummyBlock.stderr.trim() || `Failed to change directory to ${targetDir}`)
    }
  }

  private spawnShellProcess(session: SessionState): ProcessState {
    const initToken = crypto.randomBytes(8).toString('hex')
    const promptToken = crypto.randomBytes(6).toString('hex')
    const env: NodeJS.ProcessEnv = {
      ...buildCleanTerminalEnv(),
      TERM: 'xterm-256color',
      FORCE_COLOR: '1',
      CLICOLOR_FORCE: '1',
      ...(session.shell === 'cmd' ? { PROMPT: `${CMD_PROMPT_PREFIX}${promptToken}__` } : {}),
    }

    const child = spawn(session.executable, getShellArgs(session.shell, session.executable), {
      cwd: session.cwd,
      env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let resolveReady!: () => void
    const readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve
    })

    const procState: ProcessState = {
      child,
      intentionalExit: false,
      ready: false,
      initToken,
      promptToken,
      initBuffer: '',
      stdoutDecoder: new StringDecoder('utf8'),
      stderrDecoder: new StringDecoder('utf8'),
      readyPromise,
      resolveReady,
    }

    session.proc = procState

    child.stdout.on('data', (chunk: Buffer) => {
      this.handleStdoutChunk(session, procState, procState.stdoutDecoder.write(chunk))
    })

    child.stderr.on('data', (chunk: Buffer) => {
      this.handleStderrChunk(session, procState, procState.stderrDecoder.write(chunk))
    })

    child.stdin.on('error', () => {
      // Ignore EPIPE when the child exits before a write flushes.
    })

    child.on('error', (err) => {
      if (procState.intentionalExit || session.closed || this.disposed) return
      procState.ready = true
      procState.resolveReady()
      this.handleUnexpectedProcessExit(session, procState, 1, err.message)
    })

    child.on('close', (code) => {
      const tailOut = procState.stdoutDecoder.end()
      const tailErr = procState.stderrDecoder.end()
      if (tailOut) this.handleStdoutChunk(session, procState, tailOut)
      if (tailErr) this.handleStderrChunk(session, procState, tailErr)

      if (procState.intentionalExit || session.closed || this.disposed) {
        procState.resolveReady()
        return
      }

      procState.ready = true
      procState.resolveReady()
      this.handleUnexpectedProcessExit(session, procState, typeof code === 'number' ? code : 1)
    })

    child.stdin.write(buildInitCommand(session.shell, initToken))
    return procState
  }

  private handleStdoutChunk(session: SessionState, proc: ProcessState, decoded: string): void {
    if (!decoded || session.proc !== proc || session.closed || this.disposed) return

    if (!proc.ready) {
      proc.initBuffer += decoded
      const initMarker = `${INIT_SENTINEL_PREFIX}${proc.initToken}__`
      const idx = proc.initBuffer.indexOf(initMarker)
      if (idx === -1) return

      const afterMarker = proc.initBuffer.slice(idx + initMarker.length)
      const newlineMatch = /^\r?\n/.exec(afterMarker)
      if (!newlineMatch) return

      const trailing = afterMarker.slice(newlineMatch[0].length)
      proc.initBuffer = ''
      proc.ready = true
      proc.resolveReady()

      if (!trailing) return
      decoded = trailing
    }

    const active = session.activeRun
    if (!active) return

    let input = decoded
    if (session.shell === 'cmd') {
      const stripped = stripCmdPromptFromBuffer(
        active.promptRemainder + input,
        `${CMD_PROMPT_PREFIX}${proc.promptToken}__`,
      )
      active.promptRemainder = stripped.remaining
      input = stripped.text
      if (!input) return
    }

    const combined = active.stdoutRemainder + input
    const extracted = extractSentinelFromBuffer(combined, active.token)
    active.stdoutRemainder = extracted.remaining

    if (extracted.text) {
      this.appendOutput(session, active, 'stdout', extracted.text)
    }

    if (extracted.match) {
      this.scheduleSentinelCompletion(session, active, extracted.match)
    }
  }

  private handleStderrChunk(session: SessionState, proc: ProcessState, decoded: string): void {
    if (!decoded || session.proc !== proc || session.closed || this.disposed) return
    // Discard startup noise (e.g. PSReadLine warning on Windows PowerShell) before init completes.
    if (!proc.ready) return

    const active = session.activeRun
    if (!active) return

    this.appendOutput(session, active, 'stderr', decoded)
  }

  private appendOutput(
    session: SessionState,
    active: ActiveRunState,
    stream: 'stdout' | 'stderr',
    chunk: string,
  ): void {
    if (!chunk) return

    if (active.silent) {
      if (stream === 'stdout') active.block.stdout += chunk
      else active.block.stderr += chunk
      return
    }

    const remainingBytes = Math.max(0, this.maxBlockBytes - active.totalBytes)
    if (remainingBytes === 0) {
      if (!active.block.truncated) {
        active.block.truncated = true
        active.pendingTruncatedStream = stream
        this.scheduleFlush(session, active)
      }
      return
    }

    const chunkBytes = Buffer.byteLength(chunk, 'utf8')
    let accepted = chunk
    if (chunkBytes > remainingBytes) {
      accepted = truncateUtf8ToBytes(chunk, remainingBytes)
      active.totalBytes += Buffer.byteLength(accepted, 'utf8')
      active.block.truncated = true
      active.pendingTruncatedStream = stream
    } else {
      active.totalBytes += chunkBytes
    }

    if (accepted) {
      if (stream === 'stdout') {
        active.pendingStdout += accepted
      } else {
        active.pendingStderr += accepted
      }
    }

    if (accepted || active.pendingTruncatedStream) {
      this.scheduleFlush(session, active)
    }
  }

  private scheduleFlush(session: SessionState, active: ActiveRunState): void {
    if (this.flushMs <= 0) {
      this.flushPendingOutput(session, active)
      return
    }
    if (active.flushTimer) return
    active.flushTimer = setTimeout(() => {
      active.flushTimer = null
      if (session.activeRun === active && !session.closed) {
        this.flushPendingOutput(session, active)
      }
    }, this.flushMs)
  }

  private flushPendingOutput(session: SessionState, active: ActiveRunState): void {
    if (active.flushTimer) {
      clearTimeout(active.flushTimer)
      active.flushTimer = null
    }
    if (active.silent) return

    const truncatedFlag = active.block.truncated ? { truncated: true as const } : {}
    let emitted = false

    if (active.pendingStdout) {
      const chunk = active.pendingStdout
      active.pendingStdout = ''
      active.block.stdout += chunk
      emitted = true
      this.emit({
        type: 'block-output',
        sessionId: session.id,
        blockId: active.block.id,
        stream: 'stdout',
        chunk,
        ...truncatedFlag,
      })
    }

    if (active.pendingStderr) {
      const chunk = active.pendingStderr
      active.pendingStderr = ''
      active.block.stderr += chunk
      emitted = true
      this.emit({
        type: 'block-output',
        sessionId: session.id,
        blockId: active.block.id,
        stream: 'stderr',
        chunk,
        ...truncatedFlag,
      })
    }

    if (!emitted && active.pendingTruncatedStream && !active.truncatedNotified) {
      const stream = active.pendingTruncatedStream
      this.emit({
        type: 'block-output',
        sessionId: session.id,
        blockId: active.block.id,
        stream,
        chunk: '',
        truncated: true,
      })
    }

    if (active.block.truncated) {
      active.truncatedNotified = true
      active.pendingTruncatedStream = null
    }
  }

  private scheduleSentinelCompletion(
    session: SessionState,
    active: ActiveRunState,
    match: SentinelMatch,
  ): void {
    active.pendingSentinel = match
    if (active.finishTimer) return

    // Brief settle delay allows the independent stderr pipe on Windows to drain before finishing.
    const delay = active.silent ? 0 : STDERR_SETTLE_DELAY_MS
    if (delay === 0) {
      this.finalizeRun(session, active, match.exitCode, match.cwd)
      return
    }

    active.finishTimer = setTimeout(() => {
      active.finishTimer = null
      if (session.activeRun === active && !session.closed) {
        this.finalizeRun(session, active, match.exitCode, match.cwd)
      }
    }, delay)
  }

  private finalizeRun(
    session: SessionState,
    active: ActiveRunState,
    exitCode: number,
    reportedCwd: string,
  ): void {
    this.cleanupRunResources(active)
    this.flushPendingOutput(session, active)

    const resolvedCwd = reportedCwd?.trim() ? reportedCwd.trim() : session.cwd
    const status: TerminalBlockStatus = exitCode === 0 ? 'done' : 'error'
    const finishedAt = Date.now()

    active.block.status = status
    active.block.exitCode = exitCode
    active.block.finishedAt = finishedAt
    if (!session.pendingCwdSync) {
      session.cwd = resolvedCwd
    }
    active.block.cwd = session.cwd

    session.activeRun = null
    session.running = false

    if (!active.silent) {
      this.emit({
        type: 'block-finished',
        sessionId: session.id,
        blockId: active.block.id,
        status,
        exitCode,
        cwd: session.cwd,
        finishedAt,
      })
      this.emit({ type: 'session-updated', session: this.toSummary(session) })
    }

    active.resolveCompletion()
  }

  private handleUnexpectedProcessExit(
    session: SessionState,
    proc: ProcessState,
    exitCode: number,
    errorMessage?: string,
  ): void {
    if (session.proc !== proc) return
    session.proc = null

    const active = session.activeRun
    if (active) {
      if (active.pendingSentinel) {
        this.finalizeRun(
          session,
          active,
          active.pendingSentinel.exitCode,
          active.pendingSentinel.cwd,
        )
      } else {
        if (active.stdoutRemainder) {
          this.appendOutput(session, active, 'stdout', active.stdoutRemainder)
          active.stdoutRemainder = ''
        }
        if (errorMessage) {
          this.appendOutput(session, active, 'stderr', errorMessage)
        }
        this.finalizeRun(session, active, exitCode, session.cwd)
      }
    } else {
      session.running = false
    }

    // Keep the session usable (e.g. after `exit 7`) by respawning a clean shell at session.cwd.
    if (!session.closed && !this.disposed) {
      this.spawnShellProcess(session)
    }
  }

  private cleanupRunResources(active: ActiveRunState): void {
    if (active.flushTimer) {
      clearTimeout(active.flushTimer)
      active.flushTimer = null
    }
    if (active.finishTimer) {
      clearTimeout(active.finishTimer)
      active.finishTimer = null
    }
    if (active.tempFilePath) {
      try {
        fs.unlinkSync(active.tempFilePath)
      } catch {
        // Ignore cleanup failures if the temp file was already removed.
      }
      active.tempFilePath = null
    }
  }
}
