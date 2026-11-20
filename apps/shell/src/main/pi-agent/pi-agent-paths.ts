import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import type { MagicContextStorageMode } from '../../shared/pi-agent-prefs'

export interface PiRuntimePaths {
  /** Isolated Pi agent config/session root under `<userData>/pi-agent`. */
  readonly agentDir: string
  readonly sessionsDir: string
  readonly binDir: string
  readonly modelsJsonPath: string
  readonly authJsonPath: string
  readonly settingsJsonPath: string
  readonly sessionMapPath: string
  /** Isolated XDG config directory under `<agentDir>/xdg-config`. */
  readonly isolatedXdgConfigHome: string
  /** Isolated Magic Context SQLite directory under `<agentDir>/magic-context`. */
  readonly isolatedStorageDir: string
  /** Resolved Magic Context storage directory (or undefined when using shared OS default). */
  readonly magicContextStorageDir: string
  /** Resolved `magic-context.jsonc` path for current mode. */
  readonly magicContextConfigPath: string
  /** Directory containing externalized `node_modules` (`pi-coding-agent`, `pi-magic-context`). */
  readonly runtimeModulesDir: string | null
  readonly piCodingAgentEntry: string
  readonly piCliPath: string
  readonly magicContextEntry: string
}

export interface ResolvePiPathsOptions {
  readonly userDataDir: string
  readonly storageMode: MagicContextStorageMode
  readonly isPackaged?: boolean
  readonly resourcesPath?: string
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
}

function defaultSharedMagicContextStorageDir(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  const xdgData = env.XDG_DATA_HOME?.trim()
  if (xdgData) return join(xdgData, 'cortexkit', 'magic-context')
  const home = (platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir()
  return join(home, '.local', 'share', 'cortexkit', 'magic-context')
}

function defaultSharedMagicContextConfigPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  const xdgConfig = env.XDG_CONFIG_HOME?.trim()
  if (xdgConfig) return join(xdgConfig, 'cortexkit', 'magic-context.jsonc')
  const home = (platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir()
  return join(home, '.config', 'cortexkit', 'magic-context.jsonc')
}

function unpackAsarPath(p: string): string {
  return p.replace(/app\.asar([\\/])/g, 'app.asar.unpacked$1')
}

function findPackageRoot(pkgName: string, searchFrom: string[]): string | null {
  for (const base of searchFrom) {
    if (!base) continue
    try {
      const req = createRequire(join(base, 'package.json'))
      const pkgJson = req.resolve(`${pkgName}/package.json`)
      return unpackAsarPath(dirname(pkgJson))
    } catch {
      const direct = join(base, 'node_modules', pkgName, 'package.json')
      if (existsSync(direct)) return dirname(direct)
    }
  }
  return null
}

/** Resolve all filesystem paths needed by the embedded Pi Agent and Magic Context. */
export function resolvePiRuntimePaths(opts: ResolvePiPathsOptions): PiRuntimePaths {
  const env = opts.env ?? process.env
  const platform = opts.platform ?? process.platform
  const userData = resolve(opts.userDataDir)
  const agentDir = join(userData, 'pi-agent')
  const sessionsDir = join(agentDir, 'sessions')
  const binDir = join(agentDir, 'bin')
  const isolatedXdgConfigHome = join(agentDir, 'xdg-config')
  const isolatedStorageDir = join(agentDir, 'magic-context')

  const magicContextStorageDir =
    opts.storageMode === 'shared'
      ? defaultSharedMagicContextStorageDir(env, platform)
      : isolatedStorageDir

  const magicContextConfigPath =
    opts.storageMode === 'shared'
      ? defaultSharedMagicContextConfigPath(env, platform)
      : join(isolatedXdgConfigHome, 'cortexkit', 'magic-context.jsonc')

  const packagedModulesDir =
    opts.isPackaged && opts.resourcesPath
      ? join(opts.resourcesPath, 'pi-runtime', 'node_modules')
      : null

  const searchBases: string[] = []
  if (packagedModulesDir && existsSync(packagedModulesDir)) {
    searchBases.push(dirname(packagedModulesDir))
  }
  for (const rel of ['../pi-runtime', '../../out/pi-runtime', '../../../out/pi-runtime']) {
    const candidate = resolve(__dirname, rel)
    if (existsSync(join(candidate, 'node_modules'))) {
      searchBases.push(candidate)
    }
  }
  searchBases.push(process.cwd(), resolve(__dirname, '../../../..'), resolve(__dirname, '../../../../..'))

  const piPkgRoot = findPackageRoot('@earendil-works/pi-coding-agent', searchBases)
  const mcPkgRoot = findPackageRoot('@cortexkit/pi-magic-context', searchBases)

  if (!piPkgRoot) {
    throw new Error('Cannot locate @earendil-works/pi-coding-agent runtime package')
  }
  if (!mcPkgRoot) {
    throw new Error('Cannot locate @cortexkit/pi-magic-context runtime package')
  }

  const piModulesCandidate = dirname(dirname(piPkgRoot))
  const runtimeModulesDir =
    packagedModulesDir && existsSync(packagedModulesDir)
      ? packagedModulesDir
      : existsSync(join(piModulesCandidate, '@earendil-works', 'pi-coding-agent', 'package.json'))
        ? piModulesCandidate
        : null

  return {
    agentDir,
    sessionsDir,
    binDir,
    modelsJsonPath: join(agentDir, 'models.json'),
    authJsonPath: join(agentDir, 'auth.json'),
    settingsJsonPath: join(agentDir, 'settings.json'),
    sessionMapPath: join(agentDir, 'session-map.json'),
    isolatedXdgConfigHome,
    isolatedStorageDir,
    magicContextStorageDir,
    magicContextConfigPath,
    runtimeModulesDir,
    piCodingAgentEntry: join(piPkgRoot, 'dist', 'index.js'),
    piCliPath: join(piPkgRoot, 'dist', 'bundle', 'cli.js'),
    magicContextEntry: join(mcPkgRoot, 'dist', 'index.js'),
  }
}
