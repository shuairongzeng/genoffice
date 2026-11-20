import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { delimiter, join, resolve } from 'node:path'

import type { SpawnOptions } from 'node:child_process'
import type { MagicContextStorageMode } from '../../shared/pi-agent-prefs'

export interface PiSubagentShimOptions {
  readonly binDir: string
  readonly execPath: string
  readonly piCliPath: string
  readonly agentDir: string
  readonly storageMode: MagicContextStorageMode
  readonly magicContextStorageDir: string
  readonly isolatedXdgConfigHome: string
  readonly runtimeModulesDir?: string | null
  readonly platform?: NodeJS.Platform
}

export interface PiSubagentShimResult {
  readonly binDir: string
  readonly piShimPath: string
  readonly nodeShimPath: string
}

function escapeBatchValue(value: string): string {
  return value.replace(/%/g, '%%').replace(/"/g, '')
}

function escapePosixSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Generate cross-platform `pi` and `node` shims inside `<agentDir>/bin` backed
 * by the running Electron binary with `ELECTRON_RUN_AS_NODE=1`. This ensures
 * Magic Context historian/dreamer subprocesses succeed even on machines without
 * a global Node.js installation, and preserves isolated config/storage paths.
 */
export function ensurePiSubagentShim(opts: PiSubagentShimOptions): PiSubagentShimResult {
  const platform = opts.platform ?? process.platform
  mkdirSync(opts.binDir, { recursive: true })

  const envEntries: Array<[string, string]> = [
    ['ELECTRON_RUN_AS_NODE', '1'],
    ['PI_CODING_AGENT_DIR', opts.agentDir],
  ]
  if (opts.storageMode === 'isolated') {
    envEntries.push(['MAGIC_CONTEXT_STORAGE_DIR', opts.magicContextStorageDir])
    envEntries.push(['XDG_CONFIG_HOME', opts.isolatedXdgConfigHome])
  }
  if (opts.runtimeModulesDir) {
    envEntries.push(['NODE_PATH', opts.runtimeModulesDir])
  }

  if (platform === 'win32') {
    const piShimPath = join(opts.binDir, 'pi.cmd')
    const nodeShimPath = join(opts.binDir, 'node.cmd')
    const setLines = envEntries
      .map(([k, v]) => `set "${k}=${escapeBatchValue(v)}"`)
      .join('\r\n')
    const exe = escapeBatchValue(opts.execPath)
    const cli = escapeBatchValue(opts.piCliPath)

    const nodeCmd = [
      '@echo off',
      'setlocal',
      setLines,
      `"${exe}" %*`,
      '',
    ].join('\r\n')
    const piCmd = [
      '@echo off',
      'setlocal',
      setLines,
      `"${exe}" "${cli}" %*`,
      '',
    ].join('\r\n')

    writeFileSync(nodeShimPath, nodeCmd, 'utf8')
    writeFileSync(piShimPath, piCmd, 'utf8')
    return { binDir: opts.binDir, piShimPath, nodeShimPath }
  }

  const piShimPath = join(opts.binDir, 'pi')
  const nodeShimPath = join(opts.binDir, 'node')
  const exportLines = envEntries
    .map(([k, v]) => `export ${k}=${escapePosixSingleQuote(v)}`)
    .join('\n')
  const exe = escapePosixSingleQuote(opts.execPath)
  const cli = escapePosixSingleQuote(opts.piCliPath)

  const nodeSh = ['#!/bin/sh', exportLines, `exec ${exe} "$@"`, ''].join('\n')
  const piSh = ['#!/bin/sh', exportLines, `exec ${exe} ${cli} "$@"`, ''].join('\n')

  writeFileSync(nodeShimPath, nodeSh, { encoding: 'utf8', mode: 0o755 })
  writeFileSync(piShimPath, piSh, { encoding: 'utf8', mode: 0o755 })
  chmodSync(nodeShimPath, 0o755)
  chmodSync(piShimPath, 0o755)

  return { binDir: opts.binDir, piShimPath, nodeShimPath }
}

let initialXdgConfigHomeCaptured = false
let initialXdgConfigHomeValue: string | undefined

function ensureCapturedInitialXdg(env: NodeJS.ProcessEnv): void {
  if (initialXdgConfigHomeCaptured) return
  initialXdgConfigHomeCaptured = true
  initialXdgConfigHomeValue = env.XDG_CONFIG_HOME
}

/**
 * Apply isolated/shared Pi & Magic Context environment variables to `targetEnv`
 * (idempotently prepending `binDir` onto `PATH`).
 */
export function applyPiRuntimeEnv(
  opts: {
    readonly binDir: string
    readonly agentDir: string
    readonly storageMode: MagicContextStorageMode
    readonly magicContextStorageDir: string
    readonly isolatedXdgConfigHome: string
    readonly runtimeModulesDir?: string | null
  },
  targetEnv: NodeJS.ProcessEnv = process.env,
): void {
  ensureCapturedInitialXdg(targetEnv)

  const pathKey =
    Object.keys(targetEnv).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const currentPath = targetEnv[pathKey] ?? ''
  const parts = currentPath.split(delimiter).filter(Boolean)
  const deduped = parts.filter((entry) => entry !== opts.binDir)
  targetEnv[pathKey] = [opts.binDir, ...deduped].join(delimiter)

  targetEnv.PI_CODING_AGENT_DIR = opts.agentDir

  if (opts.storageMode === 'isolated') {
    targetEnv.MAGIC_CONTEXT_STORAGE_DIR = opts.magicContextStorageDir
    targetEnv.XDG_CONFIG_HOME = opts.isolatedXdgConfigHome
  } else {
    delete targetEnv.MAGIC_CONTEXT_STORAGE_DIR
    if (initialXdgConfigHomeValue !== undefined) {
      targetEnv.XDG_CONFIG_HOME = initialXdgConfigHomeValue
    } else {
      delete targetEnv.XDG_CONFIG_HOME
    }
  }

  if (opts.runtimeModulesDir) {
    const existingNodePath = targetEnv.NODE_PATH ?? ''
    const nodeParts = existingNodePath.split(delimiter).filter(Boolean)
    if (!nodeParts.includes(opts.runtimeModulesDir)) {
      targetEnv.NODE_PATH = [opts.runtimeModulesDir, ...nodeParts].join(delimiter)
    }
  }
}

export function resetCapturedXdgForTesting(): void {
  initialXdgConfigHomeCaptured = false
  initialXdgConfigHomeValue = undefined
}

export interface PiSubagentSpawnHookOptions {
  readonly execPath: string
  readonly piCliPath: string
  readonly agentDir: string
  readonly storageMode: MagicContextStorageMode
  readonly magicContextStorageDir: string
  readonly isolatedXdgConfigHome: string
  readonly runtimeModulesDir?: string | null
}

type ChildProcessSpawnFn = typeof import('node:child_process').spawn
type MutableChildProcessModule = { spawn: ChildProcessSpawnFn }

let activeHookConfig: PiSubagentSpawnHookOptions | null = null
let originalChildProcessSpawn: ChildProcessSpawnFn | null = null
let installedHookTarget: MutableChildProcessModule | null = null

function shouldInterceptSubagentSpawn(
  command: string,
  args: readonly string[] | undefined,
  options: SpawnOptions | undefined,
  cfg: PiSubagentSpawnHookOptions,
): 'node' | 'pi' | null {
  if (command !== 'node' && command !== 'pi') return null
  const isMagicContextSubagent = options?.env?.MAGIC_CONTEXT_PI_SUBAGENT === '1'
  const firstArg = Array.isArray(args) ? args[0] : undefined
  const invokesPiCli = typeof firstArg === 'string' && firstArg === cfg.piCliPath
  if (!isMagicContextSubagent && !invokesPiCli) return null
  return command
}

function buildInjectedSubagentEnv(
  baseEnv: NodeJS.ProcessEnv | undefined,
  cfg: PiSubagentSpawnHookOptions,
): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = {
    ...(baseEnv ?? process.env),
    ELECTRON_RUN_AS_NODE: '1',
    PI_CODING_AGENT_DIR: cfg.agentDir,
  }
  if (cfg.storageMode === 'isolated') {
    nextEnv.MAGIC_CONTEXT_STORAGE_DIR = cfg.magicContextStorageDir
    nextEnv.XDG_CONFIG_HOME = cfg.isolatedXdgConfigHome
  }
  if (cfg.runtimeModulesDir) {
    const existing = nextEnv.NODE_PATH ?? ''
    const parts = existing.split(delimiter).filter(Boolean)
    if (!parts.includes(cfg.runtimeModulesDir)) {
      nextEnv.NODE_PATH = [cfg.runtimeModulesDir, ...parts].join(delimiter)
    }
  }
  return nextEnv
}

/**
 * Intercept bare `spawn('node', ...)` / `spawn('pi', ...)` calls emitted by
 * Magic Context's `PiSubagentRunner` (historian/dreamer child processes) and
 * route them directly through Electron's Node runtime (`ELECTRON_RUN_AS_NODE=1`).
 * Necessary on Windows where `child_process.spawn('node', ..., { shell: false })`
 * cannot resolve `.cmd` batch shims. Idempotent; returns an uninstall callback.
 */
export function installPiSubagentSpawnHook(opts: PiSubagentSpawnHookOptions): () => void {
  activeHookConfig = opts

  if (!installedHookTarget) {
    const anchor =
      typeof __filename === 'string' ? __filename : resolve(process.cwd(), 'package.json')
    const req = createRequire(anchor)
    const cp = req('node:child_process') as MutableChildProcessModule
    const orig = cp.spawn
    originalChildProcessSpawn = orig
    installedHookTarget = cp

    cp.spawn = function hookedPiSubagentSpawn(
      this: unknown,
      command: string,
      argsOrOptions?: readonly string[] | SpawnOptions,
      maybeOptions?: SpawnOptions,
    ) {
      const cfg = activeHookConfig
      let args: readonly string[] = []
      let options: SpawnOptions | undefined
      if (Array.isArray(argsOrOptions)) {
        args = argsOrOptions
        options = maybeOptions
      } else if (argsOrOptions && typeof argsOrOptions === 'object') {
        options = argsOrOptions as SpawnOptions
      }

      if (cfg) {
        const match = shouldInterceptSubagentSpawn(command, args, options, cfg)
        if (match) {
          const rewrittenArgs = match === 'pi' ? [cfg.piCliPath, ...args] : [...args]
          const nextOptions: SpawnOptions = {
            ...(options ?? {}),
            env: buildInjectedSubagentEnv(options?.env, cfg),
          }
          return orig.call(this, cfg.execPath, rewrittenArgs, nextOptions)
        }
      }

      return orig.apply(this, arguments as unknown as Parameters<ChildProcessSpawnFn>)
    } as ChildProcessSpawnFn

    syncBuiltinESMExports()
  }

  return () => {
    activeHookConfig = null
    if (installedHookTarget && originalChildProcessSpawn) {
      installedHookTarget.spawn = originalChildProcessSpawn
      syncBuiltinESMExports()
      installedHookTarget = null
      originalChildProcessSpawn = null
    }
  }
}
