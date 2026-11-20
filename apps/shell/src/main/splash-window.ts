import { BrowserWindow, screen } from 'electron'
import { buildSplashHtml, splashStageLabel } from './splash-html'
import {
  computeSplashBounds,
  SPLASH_EXIT_ANIM_MS,
  SPLASH_HEIGHT,
  SPLASH_STAGE_PROGRESS,
  SPLASH_WIDTH,
  type SplashRect,
  type SplashStage,
} from './splash-state'

export interface SplashHandle {
  readonly window: BrowserWindow
  readonly readyPromise: Promise<void>
  setStage(stage: SplashStage): void
  closeWithFade(): Promise<void>
  destroyImmediate(): void
}

export interface CreateSplashWindowOptions {
  dark: boolean
  lang: string
  savedBounds?: SplashRect | null
  onReadyToShow?: () => void
}

/**
 * Create and display the lightweight frameless splash window centered over the
 * target display work area. Never loads preload scripts or Node integration.
 */
export function createSplashWindow(opts: CreateSplashWindowOptions): SplashHandle {
  const displays = screen.getAllDisplays()
  const workAreas = displays.map((d) => d.workArea)
  const primaryWorkArea = screen.getPrimaryDisplay().workArea
  const bounds = computeSplashBounds(workAreas, primaryWorkArea, opts.savedBounds, {
    width: SPLASH_WIDTH,
    height: SPLASH_HEIGHT,
  })

  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
    },
  })

  let closed = false
  let closing = false
  let readyResolved = false
  let resolveReady: () => void = () => {}

  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = () => {
      if (readyResolved) return
      readyResolved = true
      resolve()
    }
  })

  // Guarantee the splash never stalls startup if Chromium skips ready-to-show,
  // while giving Chromium enough time (~300ms typical) to paint before core JS parses.
  const readyGuard = setTimeout(resolveReady, 450)
  readyGuard.unref?.()

  win.once('ready-to-show', () => {
    clearTimeout(readyGuard)
    if (!win.isDestroyed() && !closed && !closing) {
      win.show()
      opts.onReadyToShow?.()
    }
    setImmediate(resolveReady)
  })

  win.once('closed', () => {
    closed = true
    clearTimeout(readyGuard)
    resolveReady()
  })

  void win.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(buildSplashHtml({ dark: opts.dark, lang: opts.lang })),
  )

  return {
    window: win,
    readyPromise,
    setStage(stage: SplashStage) {
      if (closed || closing || win.isDestroyed()) return
      const label = splashStageLabel(stage, opts.lang)
      const pct = SPLASH_STAGE_PROGRESS[stage]
      const js = `window.__setSplashStage?.(${JSON.stringify(stage)}, ${JSON.stringify(label)}, ${pct})`
      void win.webContents.executeJavaScript(js, true).catch(() => undefined)
    },
    async closeWithFade(): Promise<void> {
      if (closed || closing) return
      closing = true
      if (win.isDestroyed()) {
        closed = true
        return
      }
      await win.webContents.executeJavaScript('window.__exitSplash?.()', true).catch(() => undefined)
      await new Promise<void>((resolve) => setTimeout(resolve, SPLASH_EXIT_ANIM_MS))
      closed = true
      if (!win.isDestroyed()) win.destroy()
    },
    destroyImmediate(): void {
      closing = true
      closed = true
      clearTimeout(readyGuard)
      resolveReady()
      if (!win.isDestroyed()) win.destroy()
    },
  }
}
