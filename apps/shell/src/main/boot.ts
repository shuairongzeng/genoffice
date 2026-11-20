import { join } from 'node:path'
import { app, nativeTheme, screen } from 'electron'
import {
  configureUserDataPath,
  createBootTelemetry,
  installStdioEpipeGuard,
  isHeadlessExportArgv,
  readEarlyBootPrefs,
  reclaimDevSingleInstanceLock,
  registerShellPrivilegedSchemes,
} from './boot-env'
import { collectLaunchPaths } from './launch-paths'
import { shouldShowSplash } from './splash-state'
import { createSplashWindow, type SplashHandle } from './splash-window'
import { readShellWindowState } from './window-bounds'

/**
 * Thin main-process entrypoint. Keeps heavy editor modules, AI SDKs, MCP,
 * and workers behind a dynamic `import('./index')` so the process acquires the
 * single-instance lock and presents the brand splash window within the first
 * event-loop turns after `app.whenReady()`.
 */

const bootTelemetry = createBootTelemetry(Date.now())
bootTelemetry.mark('tProcess')

installStdioEpipeGuard()
configureUserDataPath()

const headless = isHeadlessExportArgv(process.argv)
if (headless) {
  app.dock?.hide()
}

registerShellPrivilegedSchemes()

const earlyOpenFiles: string[] = []
const earlyOpenUrls: string[] = []
const earlySecondInstances: Array<{
  argv: string[]
  cwd: string
  additionalData: unknown
}> = []

const onEarlyOpenFile = (event: Electron.Event, filePath: string): void => {
  event.preventDefault()
  if (!earlyOpenFiles.includes(filePath)) earlyOpenFiles.push(filePath)
}

const onEarlyOpenUrl = (event: Electron.Event, url: string): void => {
  event.preventDefault()
  earlyOpenUrls.push(url)
}

const onEarlySecondInstance = (
  _event: Electron.Event,
  argv: string[],
  cwd: string,
  additionalData: unknown,
): void => {
  earlySecondInstances.push({ argv, cwd, additionalData })
}

app.on('open-file', onEarlyOpenFile)
app.on('open-url', onEarlyOpenUrl)
app.on('second-instance', onEarlySecondInstance)

let listenersDetached = false
function detachEarlyListeners(): void {
  if (listenersDetached) return
  listenersDetached = true
  app.removeListener('open-file', onEarlyOpenFile)
  app.removeListener('open-url', onEarlyOpenUrl)
  app.removeListener('second-instance', onEarlySecondInstance)
}

void app.whenReady().then(async () => {
  bootTelemetry.mark('tWhenReady')

  if (headless) {
    ;(globalThis as { __genofficeBootDriven?: boolean }).__genofficeBootDriven = true
    const core = await import('./index')
    await core.bootShellCore({
      hasSingleInstanceLock: false,
      splash: null,
      earlyOpenFiles,
      earlyOpenUrls,
      earlySecondInstances,
      detachEarlyListeners,
      telemetry: bootTelemetry,
    })
    return
  }

  const initialPaths = [...new Set([...collectLaunchPaths(process.argv), ...earlyOpenFiles])]
  const lockData = (): Record<string, unknown> =>
    initialPaths.length > 0 ? { launchPath: initialPaths[0], launchPaths: initialPaths } : {}

  let hasLock = app.requestSingleInstanceLock(lockData())
  if (!hasLock && !app.isPackaged) {
    hasLock = await reclaimDevSingleInstanceLock(() => app.requestSingleInstanceLock(lockData()))
  }
  if (!hasLock) {
    detachEarlyListeners()
    app.quit()
    return
  }
  bootTelemetry.mark('tLockAcquired')

  const settingsPath = join(app.getPath('userData'), 'app-settings.json')
  const earlyPrefs = readEarlyBootPrefs(settingsPath, app.getLocale())
  nativeTheme.themeSource = earlyPrefs.theme

  let splash: SplashHandle | null = null
  const showSplash = shouldShowSplash({
    headless,
    hasSingleInstanceLock: true,
    disabledByEnv: process.env.GENOFFICE_NO_SPLASH === '1',
  })

  if (showSplash) {
    const savedBounds = readShellWindowState(
      settingsPath,
      screen.getAllDisplays().map((d) => d.workArea),
    )
    bootTelemetry.mark('tSplashCreated')
    splash = createSplashWindow({
      dark: nativeTheme.shouldUseDarkColors,
      lang: earlyPrefs.lang,
      savedBounds,
      onReadyToShow: () => bootTelemetry.mark('tSplashShown'),
    })
    // Let Chromium paint the splash frame before heavy synchronous require/import work starts.
    await splash.readyPromise
    await new Promise<void>((resolve) => setImmediate(resolve))
    splash.setStage('core')
  }

  ;(globalThis as { __genofficeBootDriven?: boolean }).__genofficeBootDriven = true
  const core = await import('./index')
  bootTelemetry.mark('tCoreLoaded')
  await core.bootShellCore({
    hasSingleInstanceLock: true,
    splash,
    earlyOpenFiles,
    earlyOpenUrls,
    earlySecondInstances,
    detachEarlyListeners,
    telemetry: bootTelemetry,
  })
})
