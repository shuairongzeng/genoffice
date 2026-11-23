import { join } from 'node:path'
import {
  BrowserWindow,
  shell,
  type BrowserWindowConstructorOptions,
  type Rectangle,
  type WebContents,
} from 'electron'
import { safeExternalUrl } from '@genoffice/electron-utils'
import type { ButlerDeskSnapshot } from '../../shared/butler-orchestrator-api'
import { HOME_CHANNELS } from '../../shared/home-api'

const HUD_MAX_WIDTH = 680
const HUD_MIN_WIDTH = 320
const HUD_HORIZONTAL_MARGIN = 48
const HUD_TOP_RATIO = 0.2
const HUD_MIN_HEIGHT = 64
const HUD_MAX_HEIGHT = 560
const HUD_DEFAULT_HEIGHT = 88
const MAX_PENDING_MESSAGES = 32

/** Compute centered upper-third HUD bounds clamped to the active display work area. */
export function hudBounds(workArea: Rectangle, height: number): Rectangle {
  const width = Math.min(
    HUD_MAX_WIDTH,
    Math.max(HUD_MIN_WIDTH, workArea.width - HUD_HORIZONTAL_MARGIN),
  )
  const x = workArea.x + Math.round((workArea.width - width) / 2)
  const y = workArea.y + Math.round(workArea.height * HUD_TOP_RATIO)
  const safeHeight = Number.isFinite(height) ? Math.round(height) : HUD_MIN_HEIGHT
  const clampedHeight = Math.min(HUD_MAX_HEIGHT, Math.max(HUD_MIN_HEIGHT, safeHeight))
  return { x, y, width, height: clampedHeight }
}

export interface ButlerHudWindowDeps {
  createWindow?: (opts: BrowserWindowConstructorOptions) => BrowserWindow
  url: () => string
  workArea: () => Rectangle
  onShown?: () => void
}

export interface ButlerHudWindow {
  prewarm(): void
  show(): void
  hide(): void
  toggle(): void
  isVisible(): boolean
  setHeight(h: number): void
  webContents(): WebContents | null
  isHudSender(wc: WebContents): boolean
  send(channel: string, payload?: unknown): void
  sendDeskUpdated(snapshot: ButlerDeskSnapshot): void
  dispose(): void
}

function deliverToWebContents(wc: WebContents, channel: string, payload: unknown): void {
  if (payload === undefined) {
    wc.send(channel)
  } else {
    wc.send(channel, payload)
  }
}

/**
 * Manage the Butler floating HUD window lifecycle: lazy/prewarmed creation,
 * auto-hiding on blur, dynamic content-driven resizing, and safe IPC delivery.
 */
export function createButlerHudWindow(deps: ButlerHudWindowDeps): ButlerHudWindow {
  let win: BrowserWindow | null = null
  let loaded = false
  let pendingShownNotify = false
  let pendingMessages: Array<{ channel: string; payload: unknown }> = []
  let currentHeight = HUD_DEFAULT_HEIGHT
  let disposed = false

  const buildWindowOptions = (): BrowserWindowConstructorOptions => {
    const initialBounds = hudBounds(deps.workArea(), currentHeight)
    return {
      x: initialBounds.x,
      y: initialBounds.y,
      width: initialBounds.width,
      height: initialBounds.height,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    }
  }

  const hide = (): void => {
    pendingShownNotify = false
    if (!win || win.isDestroyed()) return
    if (win.isVisible()) {
      win.hide()
    }
  }

  const ensureWindow = (): BrowserWindow => {
    if (win && !win.isDestroyed()) return win

    loaded = false
    pendingShownNotify = false
    pendingMessages = []

    const factory = deps.createWindow ?? ((opts) => new BrowserWindow(opts))
    const created = factory(buildWindowOptions())
    win = created

    created.setAlwaysOnTop(true, 'floating')
    if (process.platform === 'darwin') {
      created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    }

    const wc = created.webContents
    wc.setWindowOpenHandler(({ url }) => {
      const target = safeExternalUrl(url)
      if (target) void shell.openExternal(target)
      return { action: 'deny' }
    })

    wc.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (win !== created || created.isDestroyed()) return
      if (!isInPlace && isMainFrame) {
        loaded = false
      }
    })

    wc.on('did-finish-load', () => {
      if (win !== created || created.isDestroyed()) return
      loaded = true
      if (pendingMessages.length > 0) {
        const queued = pendingMessages
        pendingMessages = []
        for (const msg of queued) {
          deliverToWebContents(wc, msg.channel, msg.payload)
        }
      }
      if (pendingShownNotify) {
        pendingShownNotify = false
        wc.send(HOME_CHANNELS.butlerShown)
      }
    })

    created.on('blur', () => {
      if (win !== created || created.isDestroyed()) return
      if (!wc.isDevToolsOpened()) {
        hide()
      }
    })

    created.on('closed', () => {
      if (win !== created) return
      win = null
      loaded = false
      pendingShownNotify = false
      pendingMessages = []
    })

    void created.loadURL(deps.url()).catch(() => undefined)
    return created
  }

  const prewarm = (): void => {
    if (disposed) return
    ensureWindow()
  }

  const show = (): void => {
    if (disposed) return
    const target = ensureWindow()
    target.setBounds(hudBounds(deps.workArea(), currentHeight))
    target.show()
    target.focus()
    if (loaded) {
      pendingShownNotify = false
      target.webContents.send(HOME_CHANNELS.butlerShown)
    } else {
      pendingShownNotify = true
    }
    deps.onShown?.()
  }

  const isVisible = (): boolean => {
    return Boolean(win && !win.isDestroyed() && win.isVisible())
  }

  const toggle = (): void => {
    if (isVisible()) {
      hide()
    } else {
      show()
    }
  }

  const setHeight = (h: number): void => {
    if (!Number.isFinite(h)) return
    currentHeight = Math.min(HUD_MAX_HEIGHT, Math.max(HUD_MIN_HEIGHT, Math.round(h)))
    if (win && !win.isDestroyed()) {
      win.setBounds(hudBounds(deps.workArea(), currentHeight))
    }
  }

  const webContents = (): WebContents | null => {
    if (!win || win.isDestroyed()) return null
    return win.webContents
  }

  const isHudSender = (wc: WebContents): boolean => {
    return Boolean(win && !win.isDestroyed() && win.webContents === wc)
  }

  const send = (channel: string, payload?: unknown): void => {
    if (disposed || !win || win.isDestroyed()) return
    if (!loaded) {
      if (pendingMessages.length >= MAX_PENDING_MESSAGES) {
        pendingMessages.shift()
      }
      pendingMessages.push({ channel, payload })
      return
    }
    deliverToWebContents(win.webContents, channel, payload)
  }

  const sendDeskUpdated = (snapshot: ButlerDeskSnapshot): void => {
    send(HOME_CHANNELS.butlerDeskUpdated, snapshot)
  }

  const dispose = (): void => {
    disposed = true
    pendingShownNotify = false
    pendingMessages = []
    loaded = false
    const target = win
    win = null
    if (target && !target.isDestroyed()) {
      target.destroy()
    }
  }

  return {
    prewarm,
    show,
    hide,
    toggle,
    isVisible,
    setHeight,
    webContents,
    isHudSender,
    send,
    sendDeskUpdated,
    dispose,
  }
}
