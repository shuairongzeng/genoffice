import { join } from 'node:path'
import { screen, shell, WebContentsView } from 'electron'
import type { BrowserWindow, WebContents } from 'electron'

import { rendererUrl, safeExternalUrl } from '@genoffice/electron-utils'
import { isPointInTopBarBand, topBarOverlayBounds } from '../shared/desktop-geometry'
import type { TopBarHotEdgeReport, WindowChromeState } from '../shared/home-api'
import { applyUiScaleTo } from './ui-scale'

const DEFAULT_HIDE_GRACE_MS = 300
const DEFAULT_RECHECK_INTERVAL_MS = 180

export interface TopBarAutoHideControllerDeps {
  initialMaximized?: boolean
  initialFullScreen?: boolean
  initialAutoHideEnabled?: boolean
  getWindowBounds?: () => { x: number; y: number; width: number; height: number }
  getCursorScreenPoint?: () => { x: number; y: number }
  getHeaderHeight?: () => number
  hideGraceMs?: number
  recheckIntervalMs?: number
  onStateChange: (state: WindowChromeState) => void
}

export interface TopBarAutoHideController {
  getState(): WindowChromeState
  setMaximized(maximized: boolean): void
  setFullScreen(fullScreen: boolean): void
  setAutoHideEnabled(enabled: boolean): void
  reportHotEdge(report: TopBarHotEdgeReport): void
  onBlurOrMinimize(): void
  destroy(): void
}

function sameChromeState(a: WindowChromeState, b: WindowChromeState): boolean {
  return (
    a.maximized === b.maximized &&
    a.fullScreen === b.fullScreen &&
    a.autoHideEnabled === b.autoHideEnabled &&
    a.autoHideActive === b.autoHideActive &&
    a.revealed === b.revealed
  )
}

/**
 * Pure state machine controlling the maximized/fullscreen auto-hide top bar
 * for both Home and document-mode native overlay surfaces. Prevents premature
 * collapse while the pointer hovers OS caption buttons (`isPointInTopBarBand`)
 * or while top-strip menus are open (`pin`).
 */
export function createTopBarAutoHideController(
  deps: TopBarAutoHideControllerDeps,
): TopBarAutoHideController {
  let maximized = deps.initialMaximized === true
  let fullScreen = deps.initialFullScreen === true
  let autoHideEnabled = deps.initialAutoHideEnabled !== false
  let revealed = false
  let pinned = false
  let hideTimer: ReturnType<typeof setTimeout> | null = null
  let destroyed = false

  const hideGraceMs = deps.hideGraceMs ?? DEFAULT_HIDE_GRACE_MS
  const recheckIntervalMs = deps.recheckIntervalMs ?? DEFAULT_RECHECK_INTERVAL_MS

  const computeState = (): WindowChromeState => {
    const autoHideActive = (maximized || fullScreen) && autoHideEnabled
    return {
      maximized,
      fullScreen,
      autoHideEnabled,
      autoHideActive,
      revealed: autoHideActive ? revealed : false,
    }
  }

  let lastNotified = computeState()

  const cancelHideTimer = (): void => {
    if (hideTimer !== null) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
  }

  const emitIfChanged = (): void => {
    if (destroyed) return
    const next = computeState()
    if (sameChromeState(lastNotified, next)) return
    lastNotified = next
    deps.onStateChange(next)
  }

  const isCursorStillInsideBand = (): boolean => {
    const getWinBounds = deps.getWindowBounds
    const getCursor = deps.getCursorScreenPoint
    if (!getWinBounds || !getCursor) return false
    try {
      const point = getCursor()
      // On Windows headless/locked desktops, GetCursorPos returns (0, 0), which is never a caption button.
      if (point.x === 0 && point.y === 0) return false
      const headerHeight = deps.getHeaderHeight?.() ?? 44
      return isPointInTopBarBand(point, getWinBounds(), headerHeight, 8)
    } catch {
      return false
    }
  }

  const scheduleHideCheck = (delayMs: number): void => {
    cancelHideTimer()
    if (destroyed) return
    const state = computeState()
    if (!state.autoHideActive || !revealed || pinned) return
    hideTimer = setTimeout(() => {
      hideTimer = null
      if (destroyed) return
      const current = computeState()
      if (!current.autoHideActive || !revealed || pinned) return
      if (isCursorStillInsideBand()) {
        // Keep the bar open while hovering OS caption buttons outside the DOM strip.
        scheduleHideCheck(recheckIntervalMs)
        return
      }
      revealed = false
      emitIfChanged()
    }, delayMs)
    hideTimer.unref?.()
  }

  const reconcileActiveTransition = (wasActive: boolean): void => {
    const nowActive = (maximized || fullScreen) && autoHideEnabled
    if (!nowActive) {
      cancelHideTimer()
      revealed = false
      pinned = false
    } else if (!wasActive && nowActive) {
      cancelHideTimer()
      revealed = false
      pinned = false
    }
    emitIfChanged()
  }

  return {
    getState: () => computeState(),
    setMaximized(next: boolean): void {
      if (destroyed || next === maximized) return
      const wasActive = (maximized || fullScreen) && autoHideEnabled
      maximized = next
      reconcileActiveTransition(wasActive)
    },
    setFullScreen(next: boolean): void {
      if (destroyed || next === fullScreen) return
      const wasActive = (maximized || fullScreen) && autoHideEnabled
      fullScreen = next
      reconcileActiveTransition(wasActive)
    },
    setAutoHideEnabled(next: boolean): void {
      if (destroyed || next === autoHideEnabled) return
      const wasActive = (maximized || fullScreen) && autoHideEnabled
      autoHideEnabled = next
      reconcileActiveTransition(wasActive)
    },
    reportHotEdge(report: TopBarHotEdgeReport): void {
      if (destroyed) return
      const state = computeState()
      if (!state.autoHideActive) return

      if (typeof report.pin === 'boolean') {
        pinned = report.pin
        if (pinned) {
          cancelHideTimer()
          revealed = true
          emitIfChanged()
        } else if (revealed) {
          scheduleHideCheck(hideGraceMs)
        }
      }

      if (report.enter === true) {
        cancelHideTimer()
        if (!revealed) {
          revealed = true
          emitIfChanged()
        }
        return
      }

      if (report.leave === true && revealed && !pinned) {
        scheduleHideCheck(hideGraceMs)
      }
    },
    onBlurOrMinimize(): void {
      if (destroyed || !revealed || pinned) return
      cancelHideTimer()
      revealed = false
      emitIfChanged()
    },
    destroy(): void {
      destroyed = true
      cancelHideTimer()
    },
  }
}

export interface TopBarOverlayState {
  /** A document/browser/help tab covers the Home base renderer. */
  docActive: boolean
  /** Auto-hide is currently engaged by maximized/fullscreen state + prefs. */
  autoHideActive: boolean
  /** Pointer or menu pin currently holds the floating bar open. */
  revealed: boolean
  /** True during presentation fullscreen / content bleed. */
  suppressed: boolean
  /** Live interface scale (`--ui-scale`). */
  scale: number
  /** Live shell window content area dimensions. */
  window: { width: number; height: number }
}

export interface TopBarOverlay {
  sync(state: TopBarOverlayState): void
  webContents(): WebContents | undefined
  destroy(): void
}

export interface TopBarOverlayOptions {
  /** Called once each time the overlay renderer finishes loading so main can push initial state. */
  onDidFinishLoad?: (wc: WebContents) => void
}

/**
 * Native overlay hosting `?view=topbar` above covering document `WebContentsView`s
 * whenever maximized/fullscreen top-bar auto-hide is active:
 * - Rest state: 4px transparent strip at the very top edge so the document fills 100% height.
 * - Revealed state: 44px frosted tab strip overlapping the document without reflowing it.
 */
export function createTopBarOverlay(
  shellWindow: BrowserWindow,
  options: TopBarOverlayOptions = {},
): TopBarOverlay {
  let view: WebContentsView | null = null
  let bounds: {
    strip: { x: number; y: number; width: number; height: number }
    bar: { x: number; y: number; width: number; height: number }
  } | null = null
  let currentRevealed = false
  let appliedScale = 1

  const applyScale = (wc: WebContents, scale: number): void => {
    appliedScale = scale
    applyUiScaleTo(wc, scale)
  }

  const applyShape = (): void => {
    const live = view
    if (!live || !bounds) return
    live.setBounds(currentRevealed ? bounds.bar : bounds.strip)
  }

  const loadTopBarUrl = (wc: WebContents): void => {
    wc.loadURL(rendererUrl(process.env.ELECTRON_RENDERER_URL, 'help', { view: 'topbar' })).catch(
      () => {
        // Handled by did-fail-load below.
      },
    )
  }

  const createView = (scale: number): WebContentsView => {
    const nextView = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    const wc = nextView.webContents
    wc.setWindowOpenHandler(({ url }) => {
      const target = safeExternalUrl(url)
      if (target) void shell.openExternal(target)
      return { action: 'deny' }
    })
    nextView.setBackgroundColor('#00000000')
    wc.on('will-navigate', (event) => {
      event.preventDefault()
    })
    wc.on('did-finish-load', () => {
      applyScale(wc, appliedScale)
      options.onDidFinishLoad?.(wc)
    })

    let crashRetried = false
    wc.on('render-process-gone', (_event, details) => {
      if (details?.reason === 'clean-exit') return
      if (!shellWindow.isDestroyed()) nextView.setVisible(false)
      if (crashRetried || wc.isDestroyed()) return
      crashRetried = true
      loadTopBarUrl(wc)
    })

    let retried = false
    wc.on(
      'did-fail-load',
      (_event, code: number, description: string, failedUrl: string, isMainFrame: boolean) => {
        if (!isMainFrame) return
        if (code === -3 || retried) {
          if (code !== -3) {
            console.warn(`[shell] top-bar overlay failed to load (${description}): ${failedUrl}`)
            if (!shellWindow.isDestroyed()) nextView.setVisible(false)
          }
          return
        }
        retried = true
        loadTopBarUrl(wc)
      },
    )

    appliedScale = scale
    loadTopBarUrl(wc)
    return nextView
  }

  shellWindow.once('closed', () => {
    view = null
  })

  return {
    sync(state: TopBarOverlayState): void {
      if (shellWindow.isDestroyed()) return
      const { width, height } = state.window
      if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return

      bounds = topBarOverlayBounds({ width, height }, state.scale)
      const show = state.docActive && state.autoHideActive && !state.suppressed
      currentRevealed = show && state.revealed
      if (!show) {
        view?.setVisible(false)
        return
      }

      const live = view ?? (view = createView(state.scale))
      applyShape()
      if (state.scale !== appliedScale && !live.webContents.isDestroyed()) {
        applyScale(live.webContents, state.scale)
      }
      shellWindow.contentView.addChildView(live)
      live.setVisible(true)
    },
    webContents(): WebContents | undefined {
      const live = view
      if (!live || live.webContents.isDestroyed()) return undefined
      return live.webContents
    },
    destroy(): void {
      const live = view
      view = null
      if (shellWindow.isDestroyed() || !live) return
      shellWindow.contentView.removeChildView(live)
      if (!live.webContents.isDestroyed()) live.webContents.close()
    },
  }
}

/** Creates default screen-cursor / window-bounds reader for BrowserWindow hosts. */
export function windowTopBarHostSensors(win: BrowserWindow, uiScale: () => number) {
  return {
    getWindowBounds: () => win.getContentBounds(),
    getCursorScreenPoint: () => screen.getCursorScreenPoint(),
    getHeaderHeight: () => Math.round(44 * Math.max(0.5, uiScale())),
  }
}
