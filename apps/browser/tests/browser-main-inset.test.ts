import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain, WebContentsView } from 'electron'

/**
 * The browser page view's drawer inset (src/main/browser-main.ts): the
 * Chrome-side-panel model — while the shell's AI drawer floats over the host
 * window, layoutPage narrows the page view by the drawer's width at its
 * right edge, so the page reflows and the drawer fills the freed strip
 * instead of covering content. The inset comes from the shell hook
 * (`drawerInsetRight(pageHost)`), read per layout pass: a detached host
 * answers 0 there, no hooks at all keep today's full width, and an
 * HTML-fullscreen page never re-fits (its restore rect stands).
 *
 * The shell-side gating (which states answer what) is
 * tab-manager.test.ts's browserDrawerInset; this file pins that whatever the
 * hook answers for the page's host is exactly what layoutPage subtracts,
 * live on every pass.
 */
import { BROWSER_CHANNELS } from '../src/shared/ipc'

/** what the fake electron hands every view as its webContents */
interface FakeWc {
  id: number
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  isDestroyed: () => boolean
  send: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  getURL: () => string
  getTitle: () => string
  navigationHistory: { canGoBack: () => boolean; canGoForward: () => boolean }
}

vi.mock('electron', () => {
  let nextId = 1
  const makeWc = (): FakeWc => ({
    id: nextId++,
    on: vi.fn(),
    once: vi.fn(),
    close: vi.fn(),
    isDestroyed: () => false,
    send: vi.fn(),
    loadURL: vi.fn(() => Promise.resolve()),
    setWindowOpenHandler: vi.fn(),
    getURL: () => 'https://example.com/',
    getTitle: () => 'Example Domain',
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  })
  class FakeView {
    /** every instance, in creation order (chrome first, its page second) */
    static instances: FakeView[] = []
    private backing: FakeWc
    setBounds = vi.fn()
    constructor() {
      this.backing = makeWc()
      FakeView.instances.push(this)
    }
    get webContents(): FakeWc {
      return this.backing
    }
    set webContents(next: FakeWc) {
      this.backing = next
    }
    setVisible = vi.fn()
    getBounds = () => ({ x: 40, y: 0, width: 760, height: 600 })
    setBackgroundColor = vi.fn()
    getVisible = () => true
  }
  return {
    app: {
      getPath: () => '/tmp/genoffice-browser-inset-test',
      isPackaged: true,
      whenReady: () => Promise.resolve(),
    },
    BrowserWindow: class {},
    ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
    session: {
      fromPartition: () => ({
        setPermissionRequestHandler: vi.fn(),
        on: vi.fn(),
      }),
    },
    shell: { openExternal: vi.fn() },
    WebContentsView: FakeView,
  }
})

vi.mock('@genoffice/i18n', () => ({ getUiLang: () => 'en' }))
vi.mock('@genoffice/electron-utils', () => ({
  rendererUrl: () => 'about:blank',
  safeExternalUrl: () => null,
}))

import {
  createBrowserView,
  setBrowserShellHooks,
  syncBrowserPageView,
} from '../src/main/browser-main'

/** every view the fake electron constructed, in creation order */
const views = (): FakeView[] => (WebContentsView as unknown as { instances: FakeView[] }).instances

/** the handler registered for one ipcMain.on channel (registerBrowserIpc armed it) */
const onHandler = (channel: string): ((event: unknown, ...args: unknown[]) => void) | null => {
  const call = ipcMain.on.mock.calls.find(([ch]) => ch === channel)
  return call ? (call[1] as (event: unknown, ...args: unknown[]) => void) : null
}

/** one browser tab fully laid out: chrome + page views, content reported, hosted */
function makeHostedTab(host: {
  isDestroyed: () => boolean
  contentView: {
    addChildView: ReturnType<typeof vi.fn>
    removeChildView: ReturnType<typeof vi.fn>
  }
}): {
  chrome: FakeView
  page: FakeView
} {
  const chrome = createBrowserView()
  const page = views()[1]!
  // the chrome reported its content area (the contentRect channel's handler)
  onHandler(BROWSER_CHANNELS.contentRect)!(
    { sender: chrome.webContents },
    { x: 0, y: 44, width: 760, height: 556 },
  )
  // a navigation landed: the page has content to place
  const didNavigate = page.webContents.on.mock.calls.find(([event]) => event === 'did-navigate')
  ;(didNavigate![1] as (event: unknown, url: string) => void)({}, 'https://example.com/')
  // the shell anchored the page beside its chrome in this host
  syncBrowserPageView(chrome.webContents, host as never)
  return { chrome, page }
}

beforeEach(() => {
  views().length = 0
  setBrowserShellHooks(null)
})

describe('layoutPage drawer inset (the Chrome-side-panel model)', () => {
  const host = (): {
    isDestroyed: () => boolean
    contentView: {
      addChildView: ReturnType<typeof vi.fn>
      removeChildView: ReturnType<typeof vi.fn>
    }
  } => ({
    isDestroyed: () => false,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  })

  it("without shell hooks the page keeps today's full width", () => {
    const { page } = makeHostedTab(host())
    expect(page.setBounds).toHaveBeenCalledWith(
      expect.objectContaining({ x: 40, y: 44, width: 760, height: 556 }),
    )
  })

  it("the hook's answer for the page's host is exactly what the width loses", () => {
    const shellWin = host()
    let inset = 0
    setBrowserShellHooks({
      openTab: vi.fn(),
      setTabTitle: vi.fn(),
      setTabFavicon: vi.fn(),
      summonPalette: vi.fn(),
      askAbout: vi.fn(),
      drawerInsetRight: (h) => (h === (shellWin as never) ? inset : 0),
    })
    inset = 400
    const { page } = makeHostedTab(shellWin)
    // 760 of content minus the drawer's 400: the page reflows beside it
    expect(page.setBounds).toHaveBeenCalledWith(
      expect.objectContaining({ x: 40, y: 44, width: 360, height: 556 }),
    )
  })

  it('a host the hook does not recognize (a detached browser window) insets nothing', () => {
    const shellWin = host()
    setBrowserShellHooks({
      openTab: vi.fn(),
      setTabTitle: vi.fn(),
      setTabFavicon: vi.fn(),
      summonPalette: vi.fn(),
      askAbout: vi.fn(),
      drawerInsetRight: (h) => (h === (shellWin as never) ? 400 : 0),
    })
    const { page } = makeHostedTab(host())
    expect(page.setBounds).toHaveBeenCalledWith(expect.objectContaining({ width: 760 }))
  })

  it('the inset is read per pass: a drawer toggle refits the page live', () => {
    const shellWin = host()
    let inset = 400
    setBrowserShellHooks({
      openTab: vi.fn(),
      setTabTitle: vi.fn(),
      setTabFavicon: vi.fn(),
      summonPalette: vi.fn(),
      askAbout: vi.fn(),
      drawerInsetRight: (h) => (h === (shellWin as never) ? inset : 0),
    })
    const { chrome, page } = makeHostedTab(shellWin)
    expect(page.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ width: 360 }))
    // the drawer closed: the next layout pass (the same one a toggle rides
    // through layout() → syncView) restores the full width
    inset = 0
    syncBrowserPageView(chrome.webContents, shellWin as never)
    expect(page.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ width: 760 }))
    // and reopened again
    inset = 250
    syncBrowserPageView(chrome.webContents, shellWin as never)
    expect(page.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ width: 510 }))
  })

  it('a clamp keeps a drawer wider than the content area from a negative width', () => {
    const shellWin = host()
    setBrowserShellHooks({
      openTab: vi.fn(),
      setTabTitle: vi.fn(),
      setTabFavicon: vi.fn(),
      summonPalette: vi.fn(),
      askAbout: vi.fn(),
      drawerInsetRight: () => 900,
    })
    const { page } = makeHostedTab(shellWin)
    expect(page.setBounds).toHaveBeenCalledWith(expect.objectContaining({ width: 0 }))
  })

  it('an HTML-fullscreen page never re-fits: the restore rect stands, inset or not', () => {
    const shellWin = host()
    let inset = 400
    setBrowserShellHooks({
      openTab: vi.fn(),
      setTabTitle: vi.fn(),
      setTabFavicon: vi.fn(),
      summonPalette: vi.fn(),
      askAbout: vi.fn(),
      drawerInsetRight: (h) => (h === (shellWin as never) ? inset : 0),
    })
    const { chrome, page } = makeHostedTab(shellWin)
    expect(page.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ width: 360 }))
    // the page enters HTML fullscreen: its own handler saves the restore
    // state, and every later layout pass early-returns — the drawer toggling
    // behind a fullscreen page must not resize it
    const enter = page.webContents.on.mock.calls.find(([e]) => e === 'enter-html-full-screen')
    ;(enter![1] as () => void)()
    page.setBounds.mockClear()
    inset = 0
    syncBrowserPageView(chrome.webContents, shellWin as never)
    expect(page.setBounds).not.toHaveBeenCalled()
    // leaving fullscreen re-fits with whatever the drawer answers now
    const leave = page.webContents.on.mock.calls.find(([e]) => e === 'leave-html-full-screen')
    ;(leave![1] as () => void)()
    expect(page.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ width: 760 }))
  })

  it('the chrome keeps its own bounds — only the page narrows', () => {
    const shellWin = host()
    setBrowserShellHooks({
      openTab: vi.fn(),
      setTabTitle: vi.fn(),
      setTabFavicon: vi.fn(),
      summonPalette: vi.fn(),
      askAbout: vi.fn(),
      drawerInsetRight: () => 400,
    })
    const { chrome } = makeHostedTab(shellWin)
    // the omnibox bar is the chrome view: nothing in this path ever bounds it
    expect(chrome.setBounds).not.toHaveBeenCalled()
  })
})
