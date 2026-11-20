import { execSync } from 'node:child_process'
import { cpSync, existsSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { app, protocol, type CustomScheme } from 'electron'
import { readAppSettings } from './app-settings'

/**
 * Lightweight pre-core boot environment helpers. Kept strictly free of
 * bundled editor apps, AI/MCP, and indexer dependencies so the main entry
 * chunk stays under 80 KB and can raise the splash window on the first tick.
 */

let epipeGuardInstalled = false
let userDataConfigured = false
let schemesRegistered = false

/**
 * Guard inherited stdout/stderr pipes against EPIPE when the spawning CLI or
 * terminal closes early, preventing Electron's uncaught-exception dialog on exit.
 */
export function installStdioEpipeGuard(): void {
  if (epipeGuardInstalled) return
  epipeGuardInstalled = true
  for (const stream of [process.stdout, process.stderr]) {
    stream?.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE') throw err
    })
  }
}

/**
 * Isolate unpacked/dev userData from the packaged app and migrate legacy
 * "AI Office" / "GenOffice Dev" directories once.
 */
export function configureUserDataPath(): void {
  if (userDataConfigured) return
  userDataConfigured = true

  if (!app.isPackaged) {
    if (process.env.GENOFFICE_USER_DATA) {
      app.setPath('userData', process.env.GENOFFICE_USER_DATA)
    } else {
      const appData = app.getPath('appData')
      const devDir = join(appData, 'GenOffice-Dev')
      const oldDevDir = join(appData, 'GenOffice Dev')
      let userData = devDir
      if (existsSync(oldDevDir) && !existsSync(devDir)) {
        try {
          renameSync(oldDevDir, devDir)
        } catch {
          userData = oldDevDir
        }
      }
      app.setPath('userData', userData)
    }
    return
  }

  const oldDir = join(app.getPath('appData'), 'AI Office')
  const newDir = app.getPath('userData')
  const newEmpty = !existsSync(newDir) || readdirSync(newDir).length === 0
  if (newEmpty && existsSync(oldDir)) {
    cpSync(oldDir, newDir, { recursive: true })
  }
}

/**
 * Fast pre-ready check for headless CLI exports so no splash window is created
 * and the macOS dock icon hides before the first frame. Full CLI parsing and
 * error reporting still run inside `index.ts`.
 */
export function isHeadlessExportArgv(argv: readonly string[]): boolean {
  return argv.includes('--headless-export')
}

/**
 * Canonical list of privileged schemes required by the shell and every hosted
 * module renderer (`genoffice-app` keeps `codeCache: true` for V8 bytecode caching).
 * Must stay aligned with `apps/html/src/main/preview-protocol.ts`.
 */
export const SHELL_PRIVILEGED_SCHEMES: readonly CustomScheme[] = [
  {
    scheme: 'genoffice-app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true,
    },
  },
  {
    scheme: 'genoffice-docx-media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
  {
    scheme: 'genoffice-media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
  {
    scheme: 'html-preview',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: 'html-asset',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]

export function registerShellPrivilegedSchemes(): void {
  if (schemesRegistered || app.isReady()) return
  schemesRegistered = true
  protocol.registerSchemesAsPrivileged([...SHELL_PRIVILEGED_SCHEMES])
}

export interface EarlyBootPrefs {
  theme: 'light' | 'dark' | 'system'
  lang: string
  onboardingSeen: boolean
}

export function readEarlyBootPrefs(settingsPath: string, fallbackLocale: string): EarlyBootPrefs {
  const saved = readAppSettings(settingsPath)
  const theme =
    saved.theme === 'light' || saved.theme === 'dark' ? saved.theme : ('system' as const)
  const envLang = process.env.GENOFFICE_LANG?.trim()
  const savedLang = typeof saved.language === 'string' ? saved.language.trim() : ''
  return {
    theme,
    lang: envLang || savedLang || fallbackLocale || 'en',
    onboardingSeen: saved.onboardingSeen === true,
  }
}

export const devPidFilePath = (): string => join(app.getPath('userData'), 'dev-instance.pid')

/**
 * Dev watch restart helper: when an older dev instance holds the lock while
 * shutting down, terminate it and retry briefly before giving up.
 */
export async function reclaimDevSingleInstanceLock(
  acquireLock: () => boolean,
): Promise<boolean> {
  if (app.isPackaged) return false
  try {
    const oldPid = Number(readFileSync(devPidFilePath(), 'utf-8').trim())
    if (Number.isFinite(oldPid) && oldPid > 0 && oldPid !== process.pid) {
      const cmd = execSync(`ps -o command= -p ${oldPid}`).toString()
      if (cmd.includes('Electron')) process.kill(oldPid, 'SIGKILL')
    }
  } catch {
    // no previous instance recorded or ps unavailable on this platform
  }
  let hasLock = false
  for (let i = 0; i < 20 && !hasLock; i++) {
    await new Promise((r) => setTimeout(r, 150))
    hasLock = acquireLock()
  }
  return hasLock
}

export interface BootTelemetry {
  readonly enabled: boolean
  readonly startedAt: number
  mark(key: string): void
  set(key: string, value: string | number | boolean | null): void
  emitIfReady(): void
}

export function createBootTelemetry(startedAt = Date.now()): BootTelemetry {
  const enabled = process.env.GENOFFICE_BOOT_TELEMETRY === '1'
  const marks: Record<string, number> = {}
  const meta: Record<string, string | number | boolean | null> = {}
  let emitted = false

  return {
    enabled,
    startedAt,
    mark(key: string) {
      if (!enabled) return
      if (!(key in marks)) marks[key] = Date.now() - startedAt
    },
    set(key: string, value: string | number | boolean | null) {
      if (!enabled) return
      meta[key] = value
    },
    emitIfReady() {
      if (!enabled || emitted) return
      emitted = true
      const revealed = marks.tShellRevealed
      const ready = marks.tShellReadyToShow
      const paint = marks.tFirstPaintReady
      const gate = Math.max(ready ?? 0, paint ?? 0)
      const whiteFrameMs =
        typeof revealed === 'number' && typeof ready === 'number' && typeof paint === 'number'
          ? Math.max(0, gate - revealed)
          : null
      const payload = { ...marks, ...meta, whiteFrameMs }
      process.stdout.write(`[GENOFFICE_BOOT_TELEMETRY] ${JSON.stringify(payload)}\n`)
    },
  }
}
