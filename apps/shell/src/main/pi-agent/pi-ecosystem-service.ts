import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { pathToFileURL } from 'node:url'

import type {
  PiDiagnosticItem,
  PiDiagnosticReport,
  PiEcosystemOverview,
  PiInstalledPackageInfo,
  PiLoadedExtensionInfo,
  PiLoadedSkillInfo,
  PiMagicMemoryEntry,
  PiPackageActionResult,
} from '../../shared/pi-agent-api'
import type { PiAgentPrefs } from '../../shared/pi-agent-prefs'
import { skillsRoot } from '../imported-skills'
import type { PiRuntimePaths } from './pi-agent-paths'
import {
  deleteMagicContextMemoryFromDb,
  findMagicContextDbPath,
  isNodeSqliteSupported,
  listMagicContextMemoriesFromDb,
  readMagicContextStats,
} from './pi-memory-store'
import type { PiAgentRuntimeManager } from './pi-runtime'

const dynamicImportEsm = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<typeof import('@earendil-works/pi-coding-agent')>

const dynamicImportRaw = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>

function readVersionFromEntry(entryPath: string): string | null {
  try {
    let dir = dirname(entryPath)
    for (let i = 0; i < 4; i += 1) {
      const pkgPath = join(dir, 'package.json')
      if (existsSync(pkgPath)) {
        const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown }
        if (typeof parsed.version === 'string' && parsed.version.trim()) {
          return parsed.version.trim()
        }
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    // Ignore unreadable package manifests.
  }
  return null
}

function classifySkillSourceKind(
  filePath: string,
  userDataDir: string,
  agentDir: string,
): PiLoadedSkillInfo['sourceKind'] {
  const normFile = normalize(filePath).toLowerCase()
  const normUserSkills = normalize(skillsRoot(userDataDir)).toLowerCase()
  const normAgentSkills = normalize(join(agentDir, 'skills')).toLowerCase()
  if (normFile.startsWith(normUserSkills) || normFile.includes('genoffice')) return 'genoffice'
  if (normFile.includes('plugins')) return 'plugin'
  if (normFile.startsWith(normAgentSkills)) return 'pi-local'
  return 'pi-package'
}

export interface PiEcosystemServiceDeps {
  readonly userDataDir: string
  readonly getDefaultWorkingDir: () => string
  readonly isPackaged: boolean
  readonly resourcesPath?: string
  readonly appRoot?: string
  readonly getPrefs: () => PiAgentPrefs
  readonly runtime: PiAgentRuntimeManager
  readonly envOverrideLegacy?: boolean
}

export interface PiEcosystemService {
  getOverview(): Promise<PiEcosystemOverview>
  installPackage(source: string): Promise<PiPackageActionResult>
  removePackage(source: string): Promise<PiPackageActionResult>
  updatePackages(source?: string): Promise<PiPackageActionResult>
  listMemories(opts?: {
    limit?: number
    category?: string
    project?: string
  }): PiMagicMemoryEntry[]
  deleteMemory(id: number): { ok: boolean }
  runDiagnostics(): Promise<PiDiagnosticReport>
}

export function createPiEcosystemService(deps: PiEcosystemServiceDeps): PiEcosystemService {
  const resolveCwd = (): string => {
    const dir = deps.getDefaultWorkingDir()
    return dir && existsSync(dir) ? dir : deps.userDataDir
  }

  const createPackageManager = async (paths: PiRuntimePaths) => {
    const sdk = await dynamicImportEsm(pathToFileURL(paths.piCodingAgentEntry).href)
    const cwd = resolveCwd()
    const settingsManager = sdk.SettingsManager.create(cwd, paths.agentDir, {
      projectTrusted: true,
    })
    const pkgManager = new sdk.DefaultPackageManager({
      cwd,
      agentDir: paths.agentDir,
      settingsManager,
    })
    return { sdk, cwd, settingsManager, pkgManager }
  }

  const runSubagentProbe = async (paths: PiRuntimePaths): Promise<PiDiagnosticItem> => {
    const probeEnv: NodeJS.ProcessEnv = {
      PATH: '',
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      MAGIC_CONTEXT_PI_SUBAGENT: '1',
    }
    return await new Promise<PiDiagnosticItem>((resolveProbe) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (ok: boolean, detail: string) => {
        if (settled) return
        settled = true
        resolveProbe({
          id: 'subagent-shim',
          label: 'Historian/Dreamer Subagent Shim',
          ok,
          detail,
        })
      }

      try {
        const child = spawn('node', ['-e', 'process.stdout.write("SHIM_PROBE_OK")'], {
          env: probeEnv,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        const timer = setTimeout(() => {
          try {
            child.kill()
          } catch {
            // Ignore timeout kill error.
          }
          finish(false, 'Timed out after 5000ms')
        }, 5000)

        child.stdout?.on('data', (chunk) => {
          stdout += String(chunk)
        })
        child.stderr?.on('data', (chunk) => {
          stderr += String(chunk)
        })
        child.on('error', (err) => {
          clearTimeout(timer)
          finish(false, err.message)
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          if (code === 0 && stdout.includes('SHIM_PROBE_OK')) {
            finish(true, `Verified without global node in PATH (${paths.binDir})`)
          } else {
            finish(false, `Exit ${code ?? 'unknown'}: ${stderr.trim() || stdout.trim()}`)
          }
        })
      } catch (err) {
        finish(false, err instanceof Error ? err.message : String(err))
      }
    })
  }

  const runDiagnostics = async (): Promise<PiDiagnosticReport> => {
    const { paths, prefs } = deps.runtime.syncEnvironmentAndConfig()
    const items: PiDiagnosticItem[] = []

    const sqliteOk = isNodeSqliteSupported()
    items.push({
      id: 'node-sqlite',
      label: 'SQLite Native Engine (node:sqlite)',
      ok: sqliteOk,
      detail: sqliteOk ? `Available (Node ${process.versions.node})` : 'node:sqlite unavailable',
    })

    let piOk = false
    let piDetail = 'Missing entry file'
    try {
      const sdk = await dynamicImportEsm(pathToFileURL(paths.piCodingAgentEntry).href)
      piOk = typeof sdk.createAgentSession === 'function' && typeof sdk.DefaultPackageManager === 'function'
      piDetail = piOk
        ? `Loaded v${readVersionFromEntry(paths.piCodingAgentEntry) ?? 'unknown'}`
        : 'Exports incomplete'
    } catch (err) {
      piDetail = err instanceof Error ? err.message : String(err)
    }
    items.push({
      id: 'pi-sdk',
      label: 'Pi Coding Agent SDK',
      ok: piOk,
      detail: piDetail,
    })

    let mcOk = false
    let mcDetail = prefs.magicContextEnabled ? 'Missing entry file' : 'Disabled in preferences'
    if (prefs.magicContextEnabled) {
      try {
        const mod = await dynamicImportRaw(pathToFileURL(paths.magicContextEntry).href)
        mcOk = typeof mod.default === 'function'
        mcDetail = mcOk
          ? `Loaded v${readVersionFromEntry(paths.magicContextEntry) ?? 'unknown'} (${prefs.magicContextStorageMode})`
          : 'Default export missing'
      } catch (err) {
        mcDetail = err instanceof Error ? err.message : String(err)
      }
    } else {
      mcOk = true
    }
    items.push({
      id: 'magic-context',
      label: 'Magic Context Extension',
      ok: mcOk,
      detail: mcDetail,
    })

    items.push(await runSubagentProbe(paths))

    let writableOk = false
    let writableDetail = ''
    try {
      accessSync(paths.agentDir, constants.W_OK)
      const dbDirExists = existsSync(paths.magicContextStorageDir)
      if (dbDirExists) accessSync(paths.magicContextStorageDir, constants.W_OK)
      writableOk = true
      writableDetail = paths.magicContextStorageDir
    } catch (err) {
      writableDetail = err instanceof Error ? err.message : String(err)
    }
    items.push({
      id: 'storage-writable',
      label: 'Agent & Memory Storage Access',
      ok: writableOk,
      detail: writableDetail,
    })

    return {
      ok: items.every((item) => item.ok),
      checkedAt: new Date().toISOString(),
      items,
    }
  }

  return {
    async getOverview(): Promise<PiEcosystemOverview> {
      const { paths, prefs } = deps.runtime.syncEnvironmentAndConfig()
      const commands = await deps.runtime.listCommands()
      const sqliteOk = isNodeSqliteSupported()
      const stats = readMagicContextStats(paths.magicContextStorageDir) ?? {
        memoryCount: 0,
        compartmentCount: 0,
      }

      let packages: PiInstalledPackageInfo[] = []
      const extensions: PiLoadedExtensionInfo[] = []
      const skills: PiLoadedSkillInfo[] = []
      const extensionErrors: Array<{ path: string; error: string }> = []
      let magicContextLoaded = false

      try {
        const { sdk, cwd, settingsManager, pkgManager } = await createPackageManager(paths)
        packages = pkgManager.listConfiguredPackages().map((p) => ({
          source: p.source,
          scope: p.scope,
          filtered: p.filtered,
          ...(p.installedPath ? { installedPath: p.installedPath } : {}),
        }))

        const extraSkillDirs: string[] = []
        const userSkills = skillsRoot(deps.userDataDir)
        if (existsSync(userSkills)) extraSkillDirs.push(userSkills)

        const loader = new sdk.DefaultResourceLoader({
          cwd,
          agentDir: paths.agentDir,
          settingsManager,
          additionalExtensionPaths: prefs.magicContextEnabled ? [paths.magicContextEntry] : [],
          additionalSkillPaths: extraSkillDirs,
          noThemes: true,
        })
        await loader.reload()

        const extResult = loader.getExtensions()
        for (const err of extResult.errors) {
          extensionErrors.push({ path: err.path, error: err.error })
        }
        for (const ext of extResult.extensions) {
          const normPath = normalize(ext.path).toLowerCase()
          if (normPath === normalize(paths.magicContextEntry).toLowerCase()) {
            magicContextLoaded = true
          }
          extensions.push({
            path: ext.path,
            source: ext.sourceInfo.source ?? 'extension',
            toolNames: [...ext.tools.keys()],
            commandNames: [...ext.commands.keys()],
          })
        }

        const skillsRes = loader.getSkills()
        for (const sk of skillsRes.skills) {
          skills.push({
            name: sk.name,
            description: sk.description,
            filePath: sk.filePath,
            sourceKind: classifySkillSourceKind(sk.filePath, deps.userDataDir, paths.agentDir),
          })
        }
      } catch (err) {
        extensionErrors.push({
          path: paths.agentDir,
          error: err instanceof Error ? err.message : String(err),
        })
      }

      const diag = await runDiagnostics()
      const envLegacy = deps.envOverrideLegacy === true
      const activeEngine = envLegacy ? 'legacy' : prefs.engine

      return {
        activeEngine,
        envOverrideLegacy: envLegacy,
        magicContextLoaded,
        magicContextVersion: readVersionFromEntry(paths.magicContextEntry),
        piCodingAgentVersion: readVersionFromEntry(paths.piCodingAgentEntry),
        agentDir: paths.agentDir,
        storageDir: paths.magicContextStorageDir,
        shimPath: paths.binDir,
        nodeSqliteSupported: sqliteOk,
        memoryCount: stats.memoryCount,
        compartmentCount: stats.compartmentCount,
        packages,
        extensions,
        skills,
        commands,
        diagnostics: diag.items,
        extensionErrors,
      }
    },

    async installPackage(rawSource: string): Promise<PiPackageActionResult> {
      const source = typeof rawSource === 'string' ? rawSource.trim() : ''
      if (!source || source.length > 300) {
        return { ok: false, error: 'Package source must be a non-empty string (<= 300 chars).' }
      }
      try {
        const { paths } = deps.runtime.syncEnvironmentAndConfig()
        const { pkgManager } = await createPackageManager(paths)
        const logs: string[] = []
        pkgManager.setProgressCallback((ev) => {
          if (ev.message) logs.push(ev.message)
        })
        await pkgManager.installAndPersist(source)
        await deps.runtime.reloadAll()
        return {
          ok: true,
          message: logs.length > 0 ? logs.join('\n') : `Installed ${source}`,
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },

    async removePackage(rawSource: string): Promise<PiPackageActionResult> {
      const source = typeof rawSource === 'string' ? rawSource.trim() : ''
      if (!source || source.length > 300) {
        return { ok: false, error: 'Package source must be a non-empty string.' }
      }
      try {
        const { paths } = deps.runtime.syncEnvironmentAndConfig()
        const { pkgManager } = await createPackageManager(paths)
        const removed = await pkgManager.removeAndPersist(source)
        if (!removed) {
          return { ok: false, error: `Package "${source}" is not configured.` }
        }
        await deps.runtime.reloadAll()
        return { ok: true, message: `Removed ${source}` }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },

    async updatePackages(rawSource?: string): Promise<PiPackageActionResult> {
      const source = typeof rawSource === 'string' && rawSource.trim() ? rawSource.trim() : undefined
      try {
        const { paths } = deps.runtime.syncEnvironmentAndConfig()
        const { pkgManager } = await createPackageManager(paths)
        const logs: string[] = []
        pkgManager.setProgressCallback((ev) => {
          if (ev.message) logs.push(ev.message)
        })
        await pkgManager.update(source)
        await deps.runtime.reloadAll()
        return {
          ok: true,
          message: logs.length > 0 ? logs.join('\n') : 'Packages updated successfully.',
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },

    listMemories(opts) {
      const paths = deps.runtime.getPaths()
      return listMagicContextMemoriesFromDb(paths.magicContextStorageDir, opts)
    },

    deleteMemory(id: number) {
      const paths = deps.runtime.getPaths()
      return { ok: deleteMagicContextMemoryFromDb(paths.magicContextStorageDir, id) }
    },

    runDiagnostics,
  }
}

export function statDbFileSizeBytes(storageDir: string): number {
  const dbPath = findMagicContextDbPath(storageDir)
  if (!dbPath) return 0
  try {
    return statSync(dbPath).size
  } catch {
    return 0
  }
}
