import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The browser tab's page-view hosting (src/main/browser-main.ts): the page
 * view lives as a SIBLING of the chrome view in the host window's
 * contentView — a page nested under the chrome does not composite on the
 * current Electron/platform combination (the black-screen bug) — so these
 * tests pin the contract that replaced the nesting: the page follows the
 * chrome's window (shell, detached, unparented), its bounds are window
 * coordinates (chrome bounds + the reported content-rect offset), it shows
 * exactly while the chrome does, and it is recycled on tab teardown.
 * Electron is faked: views record their calls, the windows record their
 * contentView edits.
 */

type Rect = { x: number; y: number; width: number; height: number }

interface FakeWebContents {
  id: number
  listeners: Map<string, (...args: never[]) => void>
  onceListeners: Map<string, (...args: never[]) => void>
  on: (event: string, handler: (...args: never[]) => void) => void
  once: (event: string, handler: (...args: never[]) => void) => void
  emit: (event: string, ...args: unknown[]) => void
  loadURL: ReturnType<typeof vi.fn>
  getURL: () => string
  send: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  isDestroyed: () => boolean
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  navigationHistory: { canGoBack: () => boolean; canGoForward: () => boolean }
}

class FakeView {
  webContents: FakeWebContents
  bounds: Rect = { x: 0, y: 0, width: 0, height: 0 }
  visible = true
  setBounds = vi.fn((rect: Rect) => {
    this.bounds = { ...rect }
  })
  getBounds = (): Rect => this.bounds
  setVisible = vi.fn((on: boolean) => {
    this.visible = on
  })
  getVisible = (): boolean => this.visible
  addChildView = vi.fn()
  removeChildView = vi.fn()

  constructor() {
    const listeners = new Map<string, (...args: never[]) => void>()
    const onceListeners = new Map<string, (...args: never[]) => void>()
    let url = ''
    this.webContents = {
      id: nextWebContentsId++,
      listeners,
      onceListeners,
      on: (event, handler) => listeners.set(event, handler),
      once: (event, handler) => onceListeners.set(event, handler),
      emit: (event, ...args) => {
        const once = onceListeners.get(event)
        if (once) {
          onceListeners.delete(event)
          once(...(args as never[]))
        }
        listeners.get(event)?.(...(args as never[]))
      },
      loadURL: vi.fn((target: string) => {
        url = target
        return Promise.resolve()
      }),
      getURL: () => url,
      send: vi.fn(),
      close: vi.fn(() => {
        closed.add(this.webContents.id)
      }),
      focus: vi.fn(),
      isDestroyed: () => closed.has(this.webContents.id),
      setWindowOpenHandler: vi.fn(() => ({ action: 'deny' as const })),
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    }
    views.push(this)
  }
}

let nextWebContentsId = 1
const views: FakeView[] = []
const closed = new Set<number>()

class FakeWindow {
  private winContent = {
    added: [] as FakeView[],
    removed: [] as FakeView[],
    addChildView: vi.fn((view: FakeView) => {
      this.winContent.added.push(view)
    }),
    removeChildView: vi.fn((view: FakeView) => {
      this.winContent.removed.push(view)
    }),
  }
  private handlers = new Map<string, (...args: unknown[]) => void>()
  private assignedContentView: unknown
  destroyed = false
  contentBounds: Rect = { x: 0, y: 0, width: 1200, height: 850 }
  /** the contentView the window would host views in; assigning replaces it (the old standalone bug) */
  get contentView(): typeof this.winContent {
    return this.winContent
  }
  set contentView(value: unknown) {
    this.assignedContentView = value
  }
  on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    this.handlers.set(event, handler)
  })
  emit = (event: string, ...args: unknown[]): void => {
    this.handlers.get(event)?.(...args)
  }
  isDestroyed = (): boolean => this.destroyed
  getContentBounds = (): Rect => this.contentBounds
  get contentViewWasReplaced(): unknown {
    return this.assignedContentView
  }
}

const windows: FakeWindow[] = []

const ipcOn = new Map<string, (...args: unknown[]) => void>()
const ipcHandle = new Map<string, (...args: unknown[]) => unknown>()
let userDataDir = ''

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? userDataDir : `/tmp/${name}`),
    whenReady: () => Promise.resolve(),
    on: vi.fn(),
    quit: vi.fn(),
  },
  BrowserWindow: class {
    constructor() {
      const win = new FakeWindow()
      windows.push(win)
      return win
    }
  },
  ipcMain: {
    on: (channel: string, handler: (...args: unknown[]) => void) => ipcOn.set(channel, handler),
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      ipcHandle.set(channel, handler),
    removeHandler: vi.fn(),
  },
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler: vi.fn(),
      on: vi.fn(),
    }),
  },
  shell: { openExternal: vi.fn() },
  WebContentsView: class {
    constructor() {
      const view = new FakeView()
      return view
    }
  },
}))

import {
  configureBrowserRuntime,
  createBrowserView,
  syncBrowserPageView,
  teardownBrowserTab,
} from '../src/main/browser-main'
import { BROWSER_CHANNELS } from '../src/shared/ipc'

/** the chrome and page views of the tab the module just created */
function lastTab(): { chrome: FakeView; page: FakeView } {
  expect(views.length).toBeGreaterThanOrEqual(2)
  return { chrome: views[views.length - 2]!, page: views[views.length - 1]! }
}

/** drive the chrome renderer's content-rect report like the preload would */
function reportContentRect(chrome: FakeView, rect: Rect): void {
  ipcOn.get(BROWSER_CHANNELS.contentRect)?.({ sender: chrome.webContents }, rect)
}

/** the shell's standard hosting pass: parent, lay out, show, then sync */
function hostIn(win: FakeWindow, chrome: FakeView, bounds: Rect): void {
  win.contentView.addChildView(chrome)
  chrome.setBounds(bounds)
  chrome.setVisible(true)
  syncBrowserPageView(chrome.webContents, win)
}

beforeEach(() => {
  vi.clearAllMocks()
  views.length = 0
  windows.length = 0
  closed.clear()
  // the IPC handlers are registered once per module instance (the
  // ipcRegistered guard) and keyed by the sender's webContents id, so they
  // stay installed across tests — only the per-test view/window state resets
  userDataDir = mkdtempSync(join(tmpdir(), 'browser-page-host-'))
  configureBrowserRuntime({ preloadPath: '/tmp/preload/index.js' })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createBrowserView — the page view is a chrome sibling, never a child', () => {
  it('creates the page unparented and hidden, and does not nest it under the chrome', () => {
    const chrome = createBrowserView() as unknown as FakeView
    const { page } = lastTab()
    expect(chrome.addChildView).not.toHaveBeenCalledWith(page)
    expect(page.getVisible()).toBe(false)
  })
})

describe('syncBrowserPageView — anchoring, bounds and visibility', () => {
  it('anchors the page into the host window above the chrome, hidden until content exists', () => {
    const chrome = createBrowserView() as unknown as FakeView
    const { page } = lastTab()
    const win = new FakeWindow()

    hostIn(win, chrome, { x: 12, y: 48, width: 1188, height: 752 })

    // the chrome is parented first, the page appended after it: the page
    // stacks above, so the toolbar can never cover the page
    expect(win.contentView.added).toEqual([chrome, page])
    expect(page.getVisible()).toBe(false)
  })

  it('bounds the page to chrome bounds + the reported content rect, and shows it on navigation', () => {
    const chrome = createBrowserView() as unknown as FakeView
    const { page } = lastTab()
    const win = new FakeWindow()
    hostIn(win, chrome, { x: 12, y: 48, width: 1188, height: 752 })

    reportContentRect(chrome, { x: 0, y: 44, width: 1188, height: 708 })
    // no navigation yet: the chrome's empty hint owns the stage
    expect(page.getVisible()).toBe(false)

    page.webContents.emit('did-navigate', undefined, 'https://example.com/')
    expect(page.getVisible()).toBe(true)
    expect(page.getBounds()).toEqual({ x: 12, y: 48 + 44, width: 1188, height: 708 })
  })

  it('follows a chrome move or resize immediately, then re-fits when the new rect lands', () => {
    const chrome = createBrowserView() as unknown as FakeView
    const { page } = lastTab()
    const win = new FakeWindow()
    hostIn(win, chrome, { x: 12, y: 48, width: 1188, height: 752 })
    reportContentRect(chrome, { x: 0, y: 44, width: 1188, height: 708 })
    page.webContents.emit('did-navigate', undefined, 'https://example.com/')

    // the shell's layout pass for a resized window
    chrome.setBounds({ x: 0, y: 40, width: 900, height: 600 })
    syncBrowserPageView(chrome.webContents, win)
    // stale content rect: the offset follows the chrome at once, the size
    // waits for the chrome renderer's next report
    expect(page.getBounds()).toEqual({ x: 0, y: 40 + 44, width: 1188, height: 708 })

    reportContentRect(chrome, { x: 0, y: 44, width: 900, height: 556 })
    expect(page.getBounds()).toEqual({ x: 0, y: 40 + 44, width: 900, height: 556 })
  })

  it('shows the page exactly while the chrome view is visible (tab switch)', () => {
    const chrome = createBrowserView() as unknown as FakeView
    const { page } = lastTab()
    const win = new FakeWindow()
    hostIn(win, chrome, { x: 12, y: 48, width: 1188, height: 752 })
    reportContentRect(chrome, { x: 0, y: 44, width: 1188, height: 708 })
    page.webContents.emit('did-navigate', undefined, 'https://example.com/')
    expect(page.getVisible()).toBe(true)

    // the TabManager hides the chrome when another tab takes the stage
    chrome.setVisible(false)
    syncBrowserPageView(chrome.webContents, win)
    expect(page.getVisible()).toBe(false)

    chrome.setVisible(true)
    syncBrowserPageView(chrome.webContents, win)
    expect(page.getVisible()).toBe(true)
  })

  it('ignores junk content-rect reports', () => {
    const chrome = createBrowserView() as unknown as FakeView
    const { page } = lastTab()
    const win = new FakeWindow()
    hostIn(win, chrome, { x: 12, y: 48, width: 1188, height: 752 })
    reportContentRect(chrome, { x: 0, y: 44, width: 1188, height: 708 })
    page.webContents.emit('did-navigate', undefined, 'https://example.com/')

    reportContentRect(chrome, { x: -4, y: 44, width: 0, height: 708 })
    reportContentRect(chrome, { x: 0, y: 'nope' })
    expect(page.getBounds()).toEqual({ x: 12, y: 48 + 44, width: 1188, height: 708 })
  })

  it('HTML fullscreen covers the whole chrome (window coordinates), then restores', () => {
    const chrome = createBrowserView() as unknown as FakeView
    const { page } = lastTab()
    const win = new FakeWindow()
    hostIn(win, chrome, { x: 12, y: 48, width: 1188, height: 752 })
    reportContentRect(chrome, { x: 0, y: 44, width: 1188, height: 708 })
    page.webContents.emit('did-navigate', undefined, 'https://example.com/')

    page.webContents.emit('enter-html-full-screen')
    expect(page.getBounds()).toEqual({ x: 12, y: 48, width: 1188, height: 752 })
    // a layout pass while fullscreen must not clip the page back to the
    // content rect (leave-html-full-screen is the only way back)
    syncBrowserPageView(chrome.webContents, win)
    expect(page.getBounds()).toEqual({ x: 12, y: 48, width: 1188, height: 752 })

    page.webContents.emit('leave-html-full-screen')
    expect(page.getBounds()).toEqual({ x: 12, y: 48 + 44, width: 1188, height: 708 })
  })
})

describe('syncBrowserPageView — the page follows its tab between windows', () => {
  it('unparents the page when the chrome leaves (detach), then re-anchors it in the detached window', () => {
    const chrome = createBrowserView() as unknown as FakeView
    const { page } = lastTab()
    const shell = new FakeWindow()
    hostIn(shell, chrome, { x: 12, y: 48, width: 1188, height: 752 })
    reportContentRect(chrome, { x: 0, y: 44, width: 1188, height: 708 })
    page.webContents.emit('did-navigate', undefined, 'https://example.com/')

    // TabManager.detachTab: the chrome leaves the shell's contentView
    shell.contentView.removeChildView(chrome)
    chrome.setVisible(false)
    syncBrowserPageView(chrome.webContents, null)
    expect(shell.contentView.removed).toEqual([chrome, page])
    expect(page.getVisible()).toBe(false)

    // createDetachedEditorWindow: the chrome joins the new window's
    // contentView, is laid out and shown — the page follows, above it
    const detached = new FakeWindow()
    hostIn(detached, chrome, { x: 0, y: 0, width: 1200, height: 850 })
    reportContentRect(chrome, { x: 0, y: 44, width: 1200, height: 806 })
    expect(detached.contentView.added).toEqual([chrome, page])
    expect(page.getBounds()).toEqual({ x: 0, y: 44, width: 1200, height: 806 })
    expect(page.getVisible()).toBe(true)
  })

  it('teardown takes the page out of its host window and closes its renderer', () => {
    const chrome = createBrowserView() as unknown as FakeView
    const { page } = lastTab()
    const win = new FakeWindow()
    hostIn(win, chrome, { x: 12, y: 48, width: 1188, height: 752 })

    teardownBrowserTab(chrome.webContents)
    expect(win.contentView.removed).toEqual([page])
    expect(page.webContents.close).toHaveBeenCalled()

    // idempotent: the chrome's own 'destroyed' listener re-runs the teardown
    chrome.webContents.emit('destroyed')
    expect(win.contentView.removed).toEqual([page])
    expect(page.webContents.close).toHaveBeenCalledTimes(1)
  })

  it('skips removing the page from a window that is already destroyed', () => {
    const chrome = createBrowserView() as unknown as FakeView
    const { page } = lastTab()
    const win = new FakeWindow()
    hostIn(win, chrome, { x: 0, y: 0, width: 1200, height: 850 })

    win.destroyed = true
    teardownBrowserTab(chrome.webContents)
    expect(win.contentView.removeChildView).not.toHaveBeenCalled()
    expect(page.webContents.close).toHaveBeenCalled()
  })
})

describe('startBrowserStandalone — the chrome is a content child, not the contentView', () => {
  it('hosts the chrome beside the window webContents and re-fits the page on resize', async () => {
    const { startBrowserStandalone } = await import('../src/main/browser-main')
    const viewsBefore = views.length
    startBrowserStandalone()
    await Promise.resolve()
    await Promise.resolve()

    const chrome = views[viewsBefore]!
    const page = views[viewsBefore + 1]!
    const win = windows[0]!
    // the old standalone replaced the window's contentView with the chrome,
    // which re-nested the page under it; the fix keeps the chrome an ordinary
    // child so the page stays its sibling
    expect(win.contentViewWasReplaced).toBeUndefined()
    expect(win.contentView.added).toEqual([chrome, page])
    expect(page.getVisible()).toBe(false)
    expect(chrome.getBounds()).toEqual({ x: 0, y: 0, width: 1200, height: 850 })
    expect(chrome.webContents.loadURL).toHaveBeenCalled()

    reportContentRect(chrome, { x: 0, y: 44, width: 1200, height: 806 })
    page.webContents.emit('did-navigate', undefined, 'https://example.com/')
    expect(page.getBounds()).toEqual({ x: 0, y: 44, width: 1200, height: 806 })
    expect(page.getVisible()).toBe(true)

    win.contentBounds = { x: 0, y: 0, width: 900, height: 700 }
    win.emit('resize')
    expect(chrome.getBounds()).toEqual({ x: 0, y: 0, width: 900, height: 700 })
    // the fit pass re-syncs the page with it (stale rect until the next report)
    expect(page.getBounds()).toEqual({ x: 0, y: 44, width: 1200, height: 806 })
  })
})
