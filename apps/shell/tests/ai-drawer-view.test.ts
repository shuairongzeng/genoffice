import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createAiDrawerOverlay, type AiDrawerOverlayState } from '../src/main/ai-drawer-view'
import { AI_DOCK_WIDTH_DEFAULT, type AiDockPrefs } from '../src/shared/desktop-geometry'

/**
 * The AI drawer's native overlay host (src/main/ai-drawer-view.ts): the
 * WebContentsView that carries the drawer above an active document — mounting
 * and geometry from the `aiDock` state, topmost re-assertion, hide-not-
 * destroy transitions, and the lifetime around the shell window. Electron is
 * mocked the way tab-manager.test.ts mocks it; only the controller's own
 * observable behavior is asserted (the TabManager side that drives it lives
 * in tab-manager.test.ts).
 */

/** URLs the mocked shell.openExternal received */
const externalUrls = vi.hoisted(() => [] as string[])
/** set true to make the next panel loadURL reject (the P2 failure paths) */
const loadState = vi.hoisted(() => ({ rejectNext: false }))

vi.mock('electron', () => ({
  shell: {
    openExternal: (url: string) => {
      externalUrls.push(url)
      return Promise.resolve()
    },
  },
  // self-contained like tab-manager.test.ts's WebContentsView mock: the
  // instances are reached through the fake window's addChildView calls
  WebContentsView: class {
    webContents = {
      id: 900001,
      openHandler: null as null | ((details: { url: string }) => { action: string }),
      loadedUrl: '',
      loadURLs: [] as string[],
      onceHandlers: new Map<string, () => void>(),
      onHandlers: new Map<string, (...args: unknown[]) => void>(),
      scripts: [] as string[],
      /** the messages main delivered to this panel copy (deliverToPanel) */
      sent: [] as Array<{ channel: string; payload: unknown }>,
      closeCount: 0,
      setWindowOpenHandler(fn: (details: { url: string }) => { action: string }) {
        this.openHandler = fn
      },
      loadURL(url: string) {
        this.loadedUrl = url
        this.loadURLs.push(url)
        return loadState.rejectNext ? Promise.reject(new Error('load failed')) : Promise.resolve()
      },
      once(event: string, fn: () => void) {
        this.onceHandlers.set(event, fn)
      },
      on(event: string, fn: (...args: unknown[]) => void) {
        this.onHandlers.set(event, fn)
      },
      send(channel: string, payload: unknown) {
        this.sent.push({ channel, payload })
      },
      executeJavaScript(script: string) {
        this.scripts.push(script)
        return Promise.resolve(undefined)
      },
      close() {
        this.closeCount++
      },
      isDestroyed() {
        return false
      },
    }
    bounds: unknown[] = []
    visibles: boolean[] = []
    setBounds(rect: unknown) {
      this.bounds.push(rect)
    }
    setVisible(visible: boolean) {
      this.visibles.push(visible)
    }
  },
}))

interface FakeView {
  webContents: {
    openHandler: null | ((details: { url: string }) => { action: string })
    loadedUrl: string
    loadURLs: string[]
    onceHandlers: Map<string, () => void>
    onHandlers: Map<string, (...args: unknown[]) => void>
    scripts: string[]
    sent: Array<{ channel: string; payload: unknown }>
    closeCount: number
  }
  bounds: unknown[]
  visibles: boolean[]
}

interface FakeShellWindow {
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  onceHandlers: Map<string, () => void>
  isDestroyed: ReturnType<typeof vi.fn>
  getContentBounds: () => { x: number; y: number; width: number; height: number }
  contentView: {
    addChildView: ReturnType<typeof vi.fn>
    removeChildView: ReturnType<typeof vi.fn>
  }
}

const WINDOW = { width: 800, height: 600 }

function makeShellWindow(width = WINDOW.width, height = WINDOW.height): FakeShellWindow {
  const onceHandlers = new Map<string, () => void>()
  return {
    on: vi.fn(),
    once: vi.fn((event: string, fn: () => void) => onceHandlers.set(event, fn)),
    onceHandlers,
    isDestroyed: vi.fn(() => false),
    getContentBounds: () => ({ x: 0, y: 0, width, height }),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  }
}

function overlayView(win: FakeShellWindow): FakeView {
  const calls = win.contentView.addChildView.mock.calls as unknown[][]
  expect(calls.length).toBeGreaterThan(0)
  return calls.at(-1)![0] as FakeView
}

function state(over: Partial<AiDrawerOverlayState> = {}): AiDrawerOverlayState {
  return {
    dock: { width: AI_DOCK_WIDTH_DEFAULT, collapsed: false, petPos: null },
    scale: 1,
    docActive: true,
    suppressed: false,
    window: { ...WINDOW },
    ...over,
  }
}

let win: FakeShellWindow

beforeEach(() => {
  win = makeShellWindow()
  externalUrls.length = 0
})

describe('mounting', () => {
  it('creates no view while the drawer is closed', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state({ dock: { width: 480, collapsed: true, petPos: null } }))
    expect(win.contentView.addChildView).not.toHaveBeenCalled()
  })

  it('creates no view while Home is the active tab', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state({ docActive: false }))
    expect(win.contentView.addChildView).not.toHaveBeenCalled()
  })

  it('loads the shell renderer ask-panel entry at the help scheme root', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    expect(view.webContents.loadedUrl).toBe('genoffice-app://help/index.html?view=ask-panel')
    expect(view.webContents.openHandler).toBeTypeOf('function')
  })

  it("mounts at the content area's right edge, drawer-wide, the full height", () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state({ dock: { width: 480, collapsed: false, petPos: null } }))
    const view = overlayView(win)
    expect(view.bounds.at(-1)).toEqual({ x: 320, y: 0, width: 480, height: 600 })
    expect(view.visibles.at(-1)).toBe(true)
    expect(win.contentView.addChildView).toHaveBeenCalledTimes(1)
  })
})

describe('geometry', () => {
  it('scales the footprint with the interface scale', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state({ dock: { width: 360, collapsed: false, petPos: null }, scale: 1.5 }))
    expect(overlayView(win).bounds.at(-1)).toEqual({ x: 260, y: 0, width: 540, height: 600 })
  })

  it('clamps a drawer wider than the window to the window itself', () => {
    const overlay = createAiDrawerOverlay(win as never)
    // the max rail at 150%: 560 CSS px → 840 window px in an 800 px window
    overlay.sync(state({ dock: { width: 560, collapsed: false, petPos: null }, scale: 1.5 }))
    expect(overlayView(win).bounds.at(-1)).toEqual({ x: 0, y: 0, width: 800, height: 600 })
  })

  it('re-fits the bounds on a later sync (a resize, a stage report)', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    overlay.sync(state({ window: { width: 1000, height: 700 } }))
    expect(view.bounds.at(-1)).toEqual({ x: 600, y: 0, width: 400, height: 700 })
  })

  it('keeps the last bounds when the window reports a degenerate rect', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    view.bounds.length = 0
    view.visibles.length = 0
    overlay.sync(state({ window: { width: 0, height: 0 } }))
    expect(view.bounds).toEqual([])
    // neither hidden nor shown: the stale rect is not a state change
    expect(view.visibles).toEqual([])
  })

  it('applies the interface scale to the overlay renderer, at load and on change', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    expect(view.webContents.scripts).toEqual([])
    // the load-time application (installUiScale-style inline --ui-scale)
    view.webContents.onceHandlers.get('did-finish-load')!()
    expect(view.webContents.scripts).toEqual([
      "document.documentElement.style.setProperty('--ui-scale', '1')",
    ])
    // a later scale change applies immediately, not only at load
    overlay.sync(state({ scale: 1.5 }))
    expect(view.webContents.scripts.at(-1)).toBe(
      "document.documentElement.style.setProperty('--ui-scale', '1.5')",
    )
  })
})

describe('z-order', () => {
  it('re-asserts the topmost position on every shown sync', () => {
    // addChildView re-adds an existing child as the topmost view, so a view
    // added after the drawer opened (a new tab) cannot end up above it
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    expect(win.contentView.addChildView).toHaveBeenCalledTimes(1)
    overlay.sync(state())
    expect(win.contentView.addChildView).toHaveBeenCalledTimes(2)
    expect(win.contentView.addChildView).toHaveBeenLastCalledWith(view)
  })
})

describe('state transitions (hide, never destroy)', () => {
  it('hides when the drawer closes over the document, and reuses the view when it reopens', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    overlay.sync(state({ dock: { width: 480, collapsed: true, petPos: null } }))
    expect(view.visibles.at(-1)).toBe(false)
    expect(win.contentView.removeChildView).not.toHaveBeenCalled()
    expect(view.webContents.closeCount).toBe(0)
    overlay.sync(state({ dock: { width: 480, collapsed: false, petPos: null } }))
    expect(win.contentView.addChildView).toHaveBeenLastCalledWith(view)
    expect(view.visibles.at(-1)).toBe(true)
  })

  it('hides while Home is the active tab, keeping the view', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    overlay.sync(state({ docActive: false }))
    expect(view.visibles.at(-1)).toBe(false)
    expect(win.contentView.removeChildView).not.toHaveBeenCalled()
  })

  it('hides while the active tab presents fullscreen, keeping the view', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    overlay.sync(state({ suppressed: true }))
    expect(view.visibles.at(-1)).toBe(false)
    expect(view.webContents.closeCount).toBe(0)
    overlay.sync(state({ suppressed: false }))
    expect(view.visibles.at(-1)).toBe(true)
  })
})

describe('lifetime', () => {
  it('destroy removes the view from the window and closes its renderer', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    overlay.destroy()
    expect(win.contentView.removeChildView).toHaveBeenCalledWith(view)
    expect(view.webContents.closeCount).toBe(1)
    // a late sync mounts a fresh view rather than acting on the dead one
    overlay.sync(state())
    const calls = win.contentView.addChildView.mock.calls as unknown[][]
    expect(calls.at(-1)![0]).not.toBe(view)
  })

  it('ignores syncs once the shell window is destroyed', () => {
    const overlay = createAiDrawerOverlay(win as never)
    win.isDestroyed.mockReturnValue(true)
    overlay.sync(state())
    expect(win.contentView.addChildView).not.toHaveBeenCalled()
  })

  it('the window closing drops the view reference: destroy becomes a no-op', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    // the contentView dies with the window; the controller only forgets
    win.onceHandlers.get('closed')!()
    overlay.destroy()
    expect(win.contentView.removeChildView).not.toHaveBeenCalled()
    expect(view.webContents.closeCount).toBe(0)
  })
})

describe('external navigation', () => {
  it('denies window opens, forwarding safe targets to the OS', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const handler = overlayView(win).webContents.openHandler!
    expect(handler({ url: 'https://example.com/page' })).toEqual({ action: 'deny' })
    expect(externalUrls).toEqual(['https://example.com/page'])
    expect(handler({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' })
    expect(externalUrls).toEqual(['https://example.com/page'])
  })
})

describe('the dock prefs read', () => {
  it('clamps the width through the shared rails before shaping the bounds', () => {
    const overlay = createAiDrawerOverlay(win as never)
    const dock: AiDockPrefs = { width: 2000, collapsed: false, petPos: null }
    overlay.sync(state({ dock }))
    // 2000 clamps to AI_DOCK_WIDTH_MAX (560) like the renderer's own drag
    expect(overlayView(win).bounds.at(-1)).toEqual({ x: 240, y: 0, width: 560, height: 600 })
  })
})

describe('deliveries to the panel copy (P0-2: the ask-intent forward)', () => {
  const handoff = {
    channel: 'home:ask-forwarded',
    payload: { text: 'asked over a doc', seq: 1, origin: 'palette' },
  }

  it('delivers directly once the view finished loading', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    view.webContents.onceHandlers.get('did-finish-load')!()
    overlay.deliverToPanel(handoff.channel, handoff.payload)
    expect(view.webContents.sent).toEqual([handoff])
  })

  it('buffers a delivery that beats the load, and flushes it on did-finish-load', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    overlay.deliverToPanel(handoff.channel, handoff.payload)
    // not loaded yet: nothing was sent, nothing was lost
    expect(view.webContents.sent).toEqual([])
    view.webContents.onceHandlers.get('did-finish-load')!()
    expect(view.webContents.sent).toEqual([handoff])
  })

  it('buffers a delivery that beats the view itself, and flushes when it loads', () => {
    // the drawer can still be mounting when Home forwards: the very prefs
    // write that expands it is still settling through watchAiDock's debounce
    const overlay = createAiDrawerOverlay(win as never)
    overlay.deliverToPanel(handoff.channel, handoff.payload)
    overlay.sync(state())
    const view = overlayView(win)
    view.webContents.onceHandlers.get('did-finish-load')!()
    expect(view.webContents.sent).toEqual([handoff])
  })

  it('keeps only the newest messages while the renderer never loads', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    for (let i = 0; i < 30; i++) overlay.deliverToPanel('home:ask-forwarded', { seq: i })
    const view = overlayView(win)
    view.webContents.onceHandlers.get('did-finish-load')!()
    // the cap drops the oldest rather than growing without bound
    expect(view.webContents.sent).toHaveLength(25)
    expect((view.webContents.sent.at(-1)!.payload as { seq: number }).seq).toBe(29)
  })
})

describe('focus return on hide (P1-3)', () => {
  it('hands the keyboard back to the active view when the overlay hides', () => {
    const focusActiveView = vi.fn()
    const overlay = createAiDrawerOverlay(win as never, { focusActiveView })
    overlay.sync(state())
    const view = overlayView(win)
    // the pet's collapse write: drawer closed over the document
    overlay.sync(state({ dock: { width: 480, collapsed: true, petPos: null } }))
    expect(view.visibles.at(-1)).toBe(false)
    expect(focusActiveView).toHaveBeenCalledTimes(1)
    // tab switch away and back: each real hide returns the focus once
    overlay.sync(state())
    overlay.sync(state({ docActive: false }))
    expect(focusActiveView).toHaveBeenCalledTimes(2)
  })

  it('leaves focus alone when the overlay was never showing', () => {
    const focusActiveView = vi.fn()
    const overlay = createAiDrawerOverlay(win as never, { focusActiveView })
    // syncs that never showed the view must not move anyone's focus
    overlay.sync(state({ dock: { width: 480, collapsed: true, petPos: null } }))
    overlay.sync(state({ docActive: false }))
    overlay.sync(state({ dock: { width: 480, collapsed: true, petPos: null } }))
    expect(focusActiveView).not.toHaveBeenCalled()
  })

  it('leaves focus alone on the degenerate-rect guard (not a state change)', () => {
    const focusActiveView = vi.fn()
    const overlay = createAiDrawerOverlay(win as never, { focusActiveView })
    overlay.sync(state())
    overlay.sync(state({ window: { width: 0, height: 0 } }))
    // the stale rect is not a hide: the view keeps showing, no focus move
    expect(focusActiveView).not.toHaveBeenCalled()
  })
})

describe('load failures (P2: the failed panel URL)', () => {
  it('retries the panel URL once when the load fails, and gives up after that', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const overlay = createAiDrawerOverlay(win as never)
      overlay.sync(state())
      const view = overlayView(win)
      const fail = (code: number): void => {
        view.webContents.onHandlers.get('did-fail-load')!({}, code, 'ERR', 'https://x', true)
      }
      expect(view.webContents.loadURLs).toHaveLength(1)
      // a real failure (not ERR_ABORTED) retries once
      fail(-21)
      expect(view.webContents.loadURLs).toHaveLength(2)
      // the retry failing too: reported, not looped
      fail(-21)
      expect(view.webContents.loadURLs).toHaveLength(2)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('treats an aborted load (a superseded navigation) as no failure at all', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const overlay = createAiDrawerOverlay(win as never)
      overlay.sync(state())
      const view = overlayView(win)
      view.webContents.onHandlers.get('did-fail-load')!({}, -3, 'ERR_ABORTED', 'https://x', true)
      expect(view.webContents.loadURLs).toHaveLength(1)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('ignores a subframe failure: that is not the panel failing to load', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const overlay = createAiDrawerOverlay(win as never)
      overlay.sync(state())
      const view = overlayView(win)
      // an image inside an answer: same event, not the main frame
      view.webContents.onHandlers.get('did-fail-load')!(
        {},
        -6,
        'ERR_FILE_NOT_FOUND',
        'https://x',
        false,
      )
      expect(view.webContents.loadURLs).toHaveLength(1)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('a rejected loadURL promise is caught, not left unhandled', async () => {
    // the retry machinery belongs to did-fail-load; the promise itself only
    // has to not crash the app as an unhandled rejection (vitest fails a
    // suite on one — this test passing is the assertion)
    loadState.rejectNext = true
    try {
      const overlay = createAiDrawerOverlay(win as never)
      overlay.sync(state())
      expect(overlayView(win).webContents.loadURLs).toHaveLength(1)
      await Promise.resolve()
      await Promise.resolve()
    } finally {
      loadState.rejectNext = false
    }
  })
})
