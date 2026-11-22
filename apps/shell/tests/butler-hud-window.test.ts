import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindowConstructorOptions, Rectangle, WebContents } from 'electron'
import { HOME_CHANNELS } from '../src/shared/home-api'

type Listener = (...args: unknown[]) => void

const mocks = vi.hoisted(() => {
  const openedExternalUrls: string[] = []
  const createdWindows: FakeBrowserWindow[] = []
  const ctorOptions: BrowserWindowConstructorOptions[] = []

  class FakeWebContents {
    sent: Array<{ channel: string; args: unknown[] }> = []
    openHandler: ((details: { url: string }) => { action: string }) | null = null
    devToolsOpened = false
    private listeners = new Map<string, Listener[]>()

    on(event: string, listener: Listener): this {
      const list = this.listeners.get(event) ?? []
      list.push(listener)
      this.listeners.set(event, list)
      return this
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(...args)
      }
    }

    setWindowOpenHandler(handler: (details: { url: string }) => { action: string }): void {
      this.openHandler = handler
    }

    isDevToolsOpened(): boolean {
      return this.devToolsOpened
    }

    send(channel: string, ...args: unknown[]): void {
      this.sent.push({ channel, args })
    }
  }

  class FakeBrowserWindow {
    webContents = new FakeWebContents()
    boundsHistory: Rectangle[] = []
    alwaysOnTopCalls: Array<{ flag: boolean; level?: string }> = []
    visibleOnAllWorkspacesCalls: Array<{ visible: boolean; options?: unknown }> = []
    loadedUrls: string[] = []
    visible = false
    destroyed = false
    showCount = 0
    hideCount = 0
    focusCount = 0
    destroyCount = 0
    private listeners = new Map<string, Listener[]>()

    constructor(opts: BrowserWindowConstructorOptions) {
      ctorOptions.push(opts)
      createdWindows.push(this)
    }

    on(event: string, listener: Listener): this {
      const list = this.listeners.get(event) ?? []
      list.push(listener)
      this.listeners.set(event, list)
      return this
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) {
        listener(...args)
      }
    }

    setAlwaysOnTop(flag: boolean, level?: string): void {
      this.alwaysOnTopCalls.push({ flag, level })
    }

    setVisibleOnAllWorkspaces(visible: boolean, options?: unknown): void {
      this.visibleOnAllWorkspacesCalls.push({ visible, options })
    }

    setBounds(rect: Rectangle): void {
      this.boundsHistory.push(rect)
    }

    loadURL(url: string): Promise<void> {
      this.loadedUrls.push(url)
      return Promise.resolve()
    }

    show(): void {
      this.visible = true
      this.showCount++
    }

    hide(): void {
      this.visible = false
      this.hideCount++
    }

    focus(): void {
      this.focusCount++
    }

    isVisible(): boolean {
      return this.visible
    }

    isDestroyed(): boolean {
      return this.destroyed
    }

    destroy(): void {
      this.destroyed = true
      this.visible = false
      this.destroyCount++
      this.emit('closed')
    }
  }

  return {
    openedExternalUrls,
    createdWindows,
    ctorOptions,
    FakeWebContents,
    FakeBrowserWindow,
  }
})

vi.mock('electron', () => ({
  BrowserWindow: mocks.FakeBrowserWindow,
  shell: {
    openExternal: vi.fn((url: string) => {
      mocks.openedExternalUrls.push(url)
      return Promise.resolve()
    }),
  },
}))

import { createButlerHudWindow, hudBounds } from '../src/main/butler/butler-hud-window'

const PRIMARY_WORK_AREA: Rectangle = { x: 0, y: 0, width: 1440, height: 900 }

function makeHud(overrides?: { workArea?: () => Rectangle; onShown?: () => void }) {
  return createButlerHudWindow({
    url: () => 'help://shell/index.html?view=butler-hud',
    workArea: overrides?.workArea ?? (() => PRIMARY_WORK_AREA),
    onShown: overrides?.onShown,
  })
}

beforeEach(() => {
  mocks.openedExternalUrls.length = 0
  mocks.createdWindows.length = 0
  mocks.ctorOptions.length = 0
})

describe('hudBounds', () => {
  it('centers horizontally and places at 20% top offset on standard screens', () => {
    const rect = hudBounds({ x: 100, y: 50, width: 1920, height: 1080 }, 240)
    expect(rect).toEqual({
      x: 100 + Math.round((1920 - 680) / 2),
      y: 50 + Math.round(1080 * 0.2),
      width: 680,
      height: 240,
    })
  })

  it('shrinks width proportionally on narrow screens down to minimum 320px', () => {
    expect(hudBounds({ x: 0, y: 0, width: 500, height: 800 }, 100).width).toBe(452)
    expect(hudBounds({ x: 0, y: 0, width: 300, height: 800 }, 100).width).toBe(320)
  })

  it('clamps height between 64 and 560 and handles non-finite heights', () => {
    expect(hudBounds(PRIMARY_WORK_AREA, 10).height).toBe(64)
    expect(hudBounds(PRIMARY_WORK_AREA, 999).height).toBe(560)
    expect(hudBounds(PRIMARY_WORK_AREA, 123.6).height).toBe(124)
    expect(hudBounds(PRIMARY_WORK_AREA, Number.NaN).height).toBe(64)
  })
})

describe('createButlerHudWindow', () => {
  it('constructs frameless transparent always-on-top window with hardened webPreferences', () => {
    const hud = makeHud()
    hud.prewarm()

    expect(mocks.createdWindows).toHaveLength(1)
    const opts = mocks.ctorOptions[0]!
    expect(opts).toMatchObject({
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
    })
    expect(opts.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    })
    expect(opts.webPreferences?.preload).toMatch(/preload[\\/]+index\.js$/)

    const win = mocks.createdWindows[0]!
    expect(win.alwaysOnTopCalls).toEqual([{ flag: true, level: 'floating' }])
    expect(win.loadedUrls).toEqual(['help://shell/index.html?view=butler-hud'])
    expect(hud.isVisible()).toBe(false)
    expect(win.showCount).toBe(0)

    // Repeated prewarm reuses the same window.
    hud.prewarm()
    expect(mocks.createdWindows).toHaveLength(1)
  })

  it('sets visibleOnAllWorkspaces on darwin only', () => {
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    try {
      const hud = makeHud()
      hud.prewarm()
      expect(mocks.createdWindows[0]!.visibleOnAllWorkspacesCalls).toEqual([
        { visible: true, options: { visibleOnFullScreen: true } },
      ])
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true })
    }
  })

  it('denies window.open and forwards only safe external URLs', () => {
    const hud = makeHud()
    hud.prewarm()
    const wc = mocks.createdWindows[0]!.webContents
    expect(wc.openHandler).toBeTypeOf('function')

    expect(wc.openHandler!({ url: 'https://example.com/docs' })).toEqual({ action: 'deny' })
    expect(mocks.openedExternalUrls).toEqual(['https://example.com/docs'])

    expect(wc.openHandler!({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' })
    expect(wc.openHandler!({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' })
    expect(mocks.openedExternalUrls).toEqual(['https://example.com/docs'])
  })

  it('toggles visibility, calls onShown, and waits for did-finish-load before sending butlerShown', () => {
    const onShown = vi.fn()
    const hud = makeHud({ onShown })

    hud.toggle()
    expect(mocks.createdWindows).toHaveLength(1)
    const win = mocks.createdWindows[0]!
    expect(hud.isVisible()).toBe(true)
    expect(win.showCount).toBe(1)
    expect(win.focusCount).toBe(1)
    expect(onShown).toHaveBeenCalledTimes(1)
    expect(win.webContents.sent).toEqual([])

    win.webContents.emit('did-finish-load')
    expect(win.webContents.sent).toEqual([{ channel: HOME_CHANNELS.butlerShown, args: [] }])

    // Toggling while visible hides it.
    hud.toggle()
    expect(hud.isVisible()).toBe(false)
    expect(win.hideCount).toBe(1)

    // Showing again after load emits butlerShown immediately.
    hud.show()
    expect(hud.isVisible()).toBe(true)
    expect(win.webContents.sent).toHaveLength(2)
    expect(win.webContents.sent[1]).toEqual({ channel: HOME_CHANNELS.butlerShown, args: [] })
  })

  it('hides on blur unless DevTools is open', () => {
    const hud = makeHud()
    hud.show()
    const win = mocks.createdWindows[0]!
    expect(hud.isVisible()).toBe(true)

    win.webContents.devToolsOpened = true
    win.emit('blur')
    expect(hud.isVisible()).toBe(true)

    win.webContents.devToolsOpened = false
    win.emit('blur')
    expect(hud.isVisible()).toBe(false)
  })

  it('updates bounds on setHeight without showing a hidden window', () => {
    const hud = makeHud()
    hud.setHeight(300)
    hud.prewarm()
    const win = mocks.createdWindows[0]!

    hud.setHeight(420)
    expect(hud.isVisible()).toBe(false)
    expect(win.showCount).toBe(0)
    expect(win.boundsHistory.at(-1)).toEqual(hudBounds(PRIMARY_WORK_AREA, 420))

    hud.setHeight(900)
    hud.show()
    expect(win.boundsHistory.at(-1)).toEqual(hudBounds(PRIMARY_WORK_AREA, 560))
  })

  it('identifies HUD webContents via isHudSender and clears references after closed', () => {
    const hud = makeHud()
    const otherWc = new mocks.FakeWebContents() as unknown as WebContents
    expect(hud.webContents()).toBeNull()
    expect(hud.isHudSender(otherWc)).toBe(false)

    hud.prewarm()
    const win = mocks.createdWindows[0]!
    const ownWc = win.webContents as unknown as WebContents
    expect(hud.webContents()).toBe(ownWc)
    expect(hud.isHudSender(ownWc)).toBe(true)
    expect(hud.isHudSender(otherWc)).toBe(false)

    win.destroyed = true
    win.emit('closed')
    expect(hud.webContents()).toBeNull()
    expect(hud.isHudSender(ownWc)).toBe(false)

    // Rebuilds cleanly on next show.
    hud.show()
    expect(mocks.createdWindows).toHaveLength(2)
    expect(hud.isVisible()).toBe(true)
  })

  it('buffers send() while loading, flushes on did-finish-load, and cleans up on dispose()', () => {
    const hud = makeHud()
    // Ignored before creation.
    hud.send('home:butler-task-update', { sessionKey: 's0' })
    expect(mocks.createdWindows).toHaveLength(0)

    hud.prewarm()
    const win = mocks.createdWindows[0]!
    hud.send('home:butler-task-update', { sessionKey: 's1' })
    expect(win.webContents.sent).toEqual([])

    win.webContents.emit('did-finish-load')
    expect(win.webContents.sent).toEqual([
      { channel: 'home:butler-task-update', args: [{ sessionKey: 's1' }] },
    ])

    hud.send('home:butler-speak', { text: 'Done' })
    expect(win.webContents.sent).toHaveLength(2)

    hud.dispose()
    expect(win.destroyCount).toBe(1)
    expect(hud.webContents()).toBeNull()
    hud.show()
    expect(mocks.createdWindows).toHaveLength(1)
  })
})
