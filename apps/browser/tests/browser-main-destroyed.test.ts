import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WebContentsView } from 'electron'

/**
 * The webContents-capture rule around the browser tab's teardown
 * (src/main/browser-main.ts): the chrome view's 'destroyed' handler must
 * close over the webContents CAPTURED AT CREATION — never re-read the view's
 * `webContents` getter at event time. Electron's native side detaches the
 * contents during view teardown, and by the time a 'destroyed' handler runs
 * that getter can already read `undefined` (timing/GC dependent — the
 * user-hit main-process crash this pins), while the captured object stays a
 * valid map key and method host past the destroy. Teardown itself must
 * tolerate nothing-to-tear-down (a falsy argument, an already-removed
 * record) as a no-op, so a reintroduction of the pattern fails soft.
 */

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
    constructor() {
      this.backing = makeWc()
      FakeView.instances.push(this)
    }
    // settable from the test: writing undefined is exactly the detached
    // getter condition the crash reproduced
    get webContents(): FakeWc {
      return this.backing
    }
    set webContents(next: FakeWc) {
      this.backing = next
    }
    setVisible = vi.fn()
    setBounds = vi.fn()
    getBounds = () => ({ x: 0, y: 0, width: 0, height: 0 })
    setBackgroundColor = vi.fn()
  }
  return {
    app: {
      getPath: () => '/tmp/genoffice-browser-destroyed-test',
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

import { createBrowserView, teardownBrowserTab } from '../src/main/browser-main'

/** every view the fake electron constructed, in creation order */
const views = (): FakeView[] => (WebContentsView as unknown as { instances: FakeView[] }).instances

/** the 'destroyed' handler a webContents captured, or null */
const destroyedHandlerOf = (wc: FakeWc): (() => void) | null => {
  const call = wc.once.mock.calls.find(([event]) => event === 'destroyed')
  return call ? (call[1] as () => void) : null
}

beforeEach(() => {
  views().length = 0
})

describe('the browser tab teardown (the webContents-capture rule)', () => {
  it('the destroyed handler passes the webContents CAPTURED at creation, surviving the detached getter', () => {
    const view = createBrowserView()
    const chromeWc = view.webContents
    const pageWc = views()[1]!.webContents
    const handler = destroyedHandlerOf(chromeWc)
    expect(handler, 'the chrome webContents carries a destroyed handler').toBeTruthy()

    // THE CRASH CONDITION: by the time the 'destroyed' handler runs, the
    // view's webContents getter already reads undefined (native detach
    // ordering). The old shape closed over the view and passed exactly this
    // undefined into teardown — `undefined.id` took the process down
    ;(view as unknown as { webContents: unknown }).webContents = undefined

    // the captured webContents survives: the teardown runs, closes the page
    // view's renderer, and never crashes
    expect(() => handler!()).not.toThrow()
    expect(pageWc.close).toHaveBeenCalledTimes(1)

    // and the record is gone: a second teardown of the same wc is a no-op
    expect(() => teardownBrowserTab(chromeWc)).not.toThrow()
    expect(pageWc.close).toHaveBeenCalledTimes(1)
  })

  it('teardown tolerates nothing-to-tear-down: a falsy argument is a no-op', () => {
    // belt-and-braces: a caller that reintroduces the event-time getter read
    // would pass exactly undefined here — the teardown must fail soft
    expect(() => teardownBrowserTab(undefined)).not.toThrow()
    expect(() => teardownBrowserTab(null)).not.toThrow()
  })

  it('teardown with a webContents whose record is already removed is a no-op', () => {
    const view = createBrowserView()
    const chromeWc = view.webContents
    const pageWc = views()[1]!.webContents
    // the first teardown drops the record (and closes the page renderer)
    teardownBrowserTab(chromeWc)
    expect(pageWc.close).toHaveBeenCalledTimes(1)
    // the second — same wc, no record left — touches nothing
    expect(() => teardownBrowserTab(chromeWc)).not.toThrow()
    expect(pageWc.close).toHaveBeenCalledTimes(1)
  })
})
