import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

export interface PtyDisposable {
  dispose(): void
}

export interface IPtyProcess {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  clear?(): void
  onData(listener: (data: string) => void): PtyDisposable
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): PtyDisposable
}

export interface PtySpawnOptions {
  name?: string
  cols?: number
  rows?: number
  cwd?: string
  env?: Record<string, string | undefined>
  encoding?: string
  useConptyDll?: boolean
}

export type PtySpawnFn = (file: string, args: string[], options: PtySpawnOptions) => IPtyProcess

export type PtyLoadResult =
  { available: true; spawn: PtySpawnFn; source: string } | { available: false; reason: string }

interface RawNodePtyModule {
  spawn?: PtySpawnFn
}

const NODE_PTY_PKG = '@lydell/node-pty'

function unpackAsarPath(targetPath: string): string {
  return targetPath.replace(/app\.asar([\\/])/g, 'app.asar.unpacked$1')
}

function collectCandidateRoots(): string[] {
  const roots: string[] = []
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resourcesPath) {
    roots.push(join(resourcesPath, 'pi-runtime', 'node_modules', NODE_PTY_PKG))
  }

  for (const rel of [
    '../pi-runtime/node_modules/@lydell/node-pty',
    '../../pi-runtime/node_modules/@lydell/node-pty',
    '../../out/pi-runtime/node_modules/@lydell/node-pty',
    '../../../out/pi-runtime/node_modules/@lydell/node-pty',
  ]) {
    roots.push(resolve(__dirname, rel))
  }

  const cwd = process.cwd()
  roots.push(join(cwd, 'out', 'pi-runtime', 'node_modules', NODE_PTY_PKG))
  roots.push(join(cwd, 'node_modules', NODE_PTY_PKG))
  roots.push(join(cwd, 'apps', 'shell', 'out', 'pi-runtime', 'node_modules', NODE_PTY_PKG))
  roots.push(resolve(__dirname, '../../../..', 'node_modules', NODE_PTY_PKG))

  const seen = new Set<string>()
  const unique: string[] = []
  for (const candidate of roots) {
    const normalized = unpackAsarPath(candidate)
    if (!seen.has(normalized)) {
      seen.add(normalized)
      unique.push(normalized)
    }
  }
  return unique
}

/**
 * Load `@lydell/node-pty` safely across packaged pi-runtime resources and workspace dev paths.
 * Never throws; returns a structured unavailable result so callers can degrade gracefully.
 */
export function loadNodePty(): PtyLoadResult {
  const req = createRequire(import.meta.url)
  const errors: string[] = []

  for (const pkgDir of collectCandidateRoots()) {
    if (!existsSync(join(pkgDir, 'package.json'))) continue
    try {
      const mod = req(pkgDir) as RawNodePtyModule
      if (typeof mod?.spawn === 'function') {
        return { available: true, spawn: mod.spawn, source: pkgDir }
      }
      errors.push(`${pkgDir}: missing spawn export`)
    } catch (err) {
      errors.push(`${pkgDir}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  try {
    const mod = req(NODE_PTY_PKG) as RawNodePtyModule
    if (typeof mod?.spawn === 'function') {
      return { available: true, spawn: mod.spawn, source: NODE_PTY_PKG }
    }
    errors.push(`${NODE_PTY_PKG}: missing spawn export`)
  } catch (err) {
    errors.push(`${NODE_PTY_PKG}: ${err instanceof Error ? err.message : String(err)}`)
  }

  return {
    available: false,
    reason: errors.length > 0 ? errors[0]! : `${NODE_PTY_PKG} is unavailable`,
  }
}
