import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import {
  applyPiRuntimeEnv,
  ensurePiSubagentShim,
  installPiSubagentSpawnHook,
  resetCapturedXdgForTesting,
} from '../src/main/pi-agent/pi-subagent-shim'

const tempDirs: string[] = []
let uninstallHook: (() => void) | null = null

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  uninstallHook?.()
  uninstallHook = null
  resetCapturedXdgForTesting()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('pi-subagent-shim', () => {
  it('writes quoted Windows and POSIX shims handling paths with spaces', () => {
    const root = makeTempDir('genoffice shim space ')
    const binDirWin = join(root, 'win-bin')
    const resWin = ensurePiSubagentShim({
      binDir: binDirWin,
      execPath: 'C:\\Program Files\\GenOffice\\GenOffice.exe',
      piCliPath: 'C:\\Program Files\\GenOffice\\cli.js',
      agentDir: join(root, 'agent dir'),
      storageMode: 'isolated',
      magicContextStorageDir: join(root, 'mc data'),
      isolatedXdgConfigHome: join(root, 'xdg config'),
      runtimeModulesDir: join(root, 'pi-runtime', 'node_modules'),
      platform: 'win32',
    })
    expect(existsSync(resWin.nodeShimPath)).toBe(true)
    expect(existsSync(resWin.piShimPath)).toBe(true)
    const nodeCmd = readFileSync(resWin.nodeShimPath, 'utf8')
    expect(nodeCmd).toContain('ELECTRON_RUN_AS_NODE=1')
    expect(nodeCmd).toContain('"C:\\Program Files\\GenOffice\\GenOffice.exe" %*')

    const binDirPosix = join(root, 'posix-bin')
    const resPosix = ensurePiSubagentShim({
      binDir: binDirPosix,
      execPath: '/Applications/GenOffice.app/Contents/MacOS/GenOffice',
      piCliPath: '/Applications/GenOffice.app/Contents/Resources/cli.js',
      agentDir: join(root, 'agent dir'),
      storageMode: 'isolated',
      magicContextStorageDir: join(root, 'mc data'),
      isolatedXdgConfigHome: join(root, 'xdg config'),
      platform: 'linux',
    })
    const piSh = readFileSync(resPosix.piShimPath, 'utf8')
    expect(piSh).toContain('#!/bin/sh')
    expect(piSh).toContain("export ELECTRON_RUN_AS_NODE='1'")
    expect(piSh).toContain("'/Applications/GenOffice.app/Contents/Resources/cli.js' \"$@\"")
  })

  it('idempotently applies and restores runtime environment variables', () => {
    const env: NodeJS.ProcessEnv = {
      PATH: ['/usr/local/bin', '/usr/bin'].join(delimiter),
      XDG_CONFIG_HOME: '/user/xdg',
    }
    applyPiRuntimeEnv(
      {
        binDir: '/app/pi-agent/bin',
        agentDir: '/app/pi-agent',
        storageMode: 'isolated',
        magicContextStorageDir: '/app/pi-agent/magic-context',
        isolatedXdgConfigHome: '/app/pi-agent/xdg-config',
      },
      env,
    )
    applyPiRuntimeEnv(
      {
        binDir: '/app/pi-agent/bin',
        agentDir: '/app/pi-agent',
        storageMode: 'isolated',
        magicContextStorageDir: '/app/pi-agent/magic-context',
        isolatedXdgConfigHome: '/app/pi-agent/xdg-config',
      },
      env,
    )
    expect(env.PATH?.split(delimiter).filter((p) => p === '/app/pi-agent/bin')).toHaveLength(1)
    expect(env.XDG_CONFIG_HOME).toBe('/app/pi-agent/xdg-config')
    expect(env.MAGIC_CONTEXT_STORAGE_DIR).toBe('/app/pi-agent/magic-context')

    applyPiRuntimeEnv(
      {
        binDir: '/app/pi-agent/bin',
        agentDir: '/app/pi-agent',
        storageMode: 'shared',
        magicContextStorageDir: '/shared/mc',
        isolatedXdgConfigHome: '/app/pi-agent/xdg-config',
      },
      env,
    )
    expect(env.MAGIC_CONTEXT_STORAGE_DIR).toBeUndefined()
    expect(env.XDG_CONFIG_HOME).toBe('/user/xdg')
  })

  it('intercepts Magic Context subagent spawn("node") even when PATH excludes global node', async () => {
    const root = makeTempDir('genoffice hook space ')
    const agentDir = join(root, 'agent dir')
    const xdgDir = join(root, 'xdg config')
    const mcDir = join(root, 'mc data')

    uninstallHook = installPiSubagentSpawnHook({
      execPath: process.execPath,
      piCliPath: join(root, 'cli.js'),
      agentDir,
      storageMode: 'isolated',
      magicContextStorageDir: mcDir,
      isolatedXdgConfigHome: xdgDir,
    })

    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        'node',
        [
          '-e',
          'process.stdout.write(JSON.stringify({agent: process.env.PI_CODING_AGENT_DIR, mc: process.env.MAGIC_CONTEXT_STORAGE_DIR, xdg: process.env.XDG_CONFIG_HOME}))',
        ],
        {
          env: {
            PATH: '',
            ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
            MAGIC_CONTEXT_PI_SUBAGENT: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk)
      })
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk)
      })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(`exit ${code}: ${stderr}`))
        else resolve(stdout)
      })
    })

    const parsed = JSON.parse(output) as { agent: string; mc: string; xdg: string }
    expect(parsed.agent).toBe(agentDir)
    expect(parsed.mc).toBe(mcDir)
    expect(parsed.xdg).toBe(xdgDir)
  })
})
