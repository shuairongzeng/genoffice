import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createDockOverlay, type DockOverlayState } from '../src/main/dock-overlay-view'
import { DOCK_ITEM_COUNT, DOCK_SEPARATOR_COUNT } from '../src/shared/desktop-geometry'

/**
 * The doc-mode dock overlay's host (src/main/dock-overlay-view.ts): the
 * one-view state machine that is a 3px hot strip along the window's bottom
 * edge while a document covers Home and grows into the dock rect on the
 * entry renderer's hot-edge report. Electron is mocked the way
 * ai-drawer-view.test.ts mocks it; only the controller's own observable
 * behavior is asserted — the strip/dock shapes, the summon, the grace-timed
 * hide and its cancellation, the identity gate, suppression, the interface
 * scale's inline writes, the load/crash hardening, the shrink when the
 * window blurs or minimizes, and the lifetime around the shell window. The
 * TabManager side that drives it lives in tab-manager.test.ts.
 */

vi.mock('electron', () => ({
  shell: { openExternal: () => Promise.resolve() },
  WebContentsView: class {
    webContents = {
      id: 900010,
      openHandler: null as null | ((details: { url: string }) => { action: string }),
      loadedUrl: '',
      loadURLs: [] as string[],
      onHandlers: new Map<string, (...args: unknown[]) => void>(),
      onceHandlers: new Map<string, (...args: unknown[]) => void>(),
      /** the inline styles main applied (ui-scale, transparency) */
      scripts: [] as string[],
      sent: [] as Array<{ channel: string; payload: unknown }>,
      closeCount: 0,
      setWindowOpenHandler(fn: (details: { url: string }) => { action: string }) {
        this.openHandler = fn
      },
      loadURL(url: string) {
        this.loadedUrl = url
        this.loadURLs.push(url)
        return Promise.resolve()
      },
      on(event: string, fn: (...args: unknown[]) => void) {
        this.onHandlers.set(event, fn)
      },
      once(event: string, fn: (...args: unknown[]) => void) {
        this.onceHandlers.set(event, fn)
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
    /** the surface color the view last carried (the transparent strip) */
    backgroundColor = ''
    bounds: Array<{ x: number; y: number; width: number; height: number }> = []
    visibles: boolean[] = []
    lastBounds: { x: number; y: number; width: number; height: number } | null = null
    setBounds(rect: { x: number; y: number; width: number; height: number }) {
      this.bounds.push(rect)
      this.lastBounds = rect
    }
    getBounds(): { x: number; y: number; width: number; height: number } {
      return this.lastBounds ?? { x: 0, y: 0, width: 0, height: 0 }
    }
    setVisible(visible: boolean) {
      this.visibles.push(visible)
    }
    setBackgroundColor(color: string) {
      this.backgroundColor = color
    }
  },
}))

interface FakeShellWindow {
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  onHandlers: Map<string, (...args: unknown[]) => void>
  onceHandlers: Map<string, () => void>
  removeListener: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  getContentBounds: () => { width: number; height: number }
  contentView: {
    addChildView: ReturnType<typeof vi.fn>
    removeChildView: ReturnType<typeof vi.fn>
  }
}

const WINDOW = { width: 800, height: 600 }

function makeShellWindow(width = WINDOW.width, height = WINDOW.height): FakeShellWindow {
  const onHandlers = new Map<string, (...args: unknown[]) => void>()
  const onceHandlers = new Map<string, () => void>()
  return {
    on: vi.fn((event: string, fn: (...args: unknown[]) => void) => onHandlers.set(event, fn)),
    once: vi.fn((event: string, fn: () => void) => onceHandlers.set(event, fn)),
    onHandlers,
    onceHandlers,
    removeListener: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      if (onHandlers.get(event) === fn) onHandlers.delete(event)
    }),
    isDestroyed: vi.fn(() => false),
    getContentBounds: () => ({ x: 0, y: 0, width, height }),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  }
}

function overlayView(win: FakeShellWindow): {
  webContents: {
    id: number
    loadURLs: string[]
    scripts: string[]
    onHandlers: Map<string, (...args: unknown[]) => void>
    onceHandlers: Map<string, (...args: unknown[]) => void>
  }
  bounds: Array<{ x: number; y: number; width: number; height: number }>
  visibles: boolean[]
  backgroundColor: string
} {
  const calls = win.contentView.addChildView.mock.calls as unknown[][]
  expect(calls.length).toBeGreaterThan(0)
  return calls.at(-1)![0] as never
}

function state(over: Partial<DockOverlayState> = {}): DockOverlayState {
  return {
    docActive: true,
    suppressed: false,
    scale: 1,
    window: { ...WINDOW },
    itemCount: DOCK_ITEM_COUNT,
    separatorCount: DOCK_SEPARATOR_COUNT,
    baseSize: 48,
    maxScale: 1.7,
    ...over,
  }
}

/** the strip shape for the default window */
const STRIP = { x: 0, y: 597, width: 800, height: 3 }
/** the dock shape for the default window: the 406×72 pill plus its fisheye
 *  headroom (33.6 both sides) and tooltip room (28 above), reaching the
 *  bottom edge — 473×143, centered */
const DOCK = { x: 164, y: 457, width: 473, height: 143 }

let win: FakeShellWindow

beforeEach(() => {
  win = makeShellWindow()
})

describe('mounting and shapes', () => {
  it('shows only the 3px strip while a document is active', () => {
    const overlay = createDockOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    // the standalone dock entry, not the ask panel
    expect(view.webContents.loadURLs).toEqual(['genoffice-app://help/index.html?view=dock'])
    expect(view.backgroundColor).toBe('#00000000')
    expect(view.bounds.at(-1)).toEqual(STRIP)
    expect(view.visibles.at(-1)).toBe(true)
  })

  it('creates no view over the Home tab or while suppressed', () => {
    const overlay = createDockOverlay(win as never)
    overlay.sync(state({ docActive: false }))
    overlay.sync(state({ suppressed: true }))
    expect(win.contentView.addChildView).not.toHaveBeenCalled()
  })

  it('hides an existing strip when the state stands down, keeping the view', () => {
    const overlay = createDockOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    overlay.sync(state({ docActive: false }))
    expect(view.visibles.at(-1)).toBe(false)
    expect(win.contentView.removeChildView).not.toHaveBeenCalled()
    // and it comes back with the tab
    overlay.sync(state())
    expect(view.visibles.at(-1)).toBe(true)
    expect(view.bounds.at(-1)).toEqual(STRIP)
  })

  it('re-fits both shapes on a later sync (a resize, a scale change)', () => {
    const overlay = createDockOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    overlay.sync(state({ window: { width: 1000, height: 700 } }))
    expect(view.bounds.at(-1)).toEqual({ x: 0, y: 697, width: 1000, height: 3 })
    // a revealed dock re-fits to its own shape, not the strip's
    overlay.reportHotEdge(view.webContents as never, { enter: true })
    overlay.sync(state({ window: { width: 1000, height: 700 } }))
    expect(view.bounds.at(-1)).toEqual({ x: 264, y: 557, width: 473, height: 143 })
    // the scale grows the pill with the chrome
    overlay.sync(state({ window: { width: 1000, height: 700 }, scale: 1.5 }))
    expect(view.bounds.at(-1)).toEqual({ x: 145, y: 486, width: 710, height: 214 })
  })

  it('the pill follows the live dock settings (设置 ▸ 程序坞): a 64px base re-cuts the rect', () => {
    const overlay = createDockOverlay(win as never)
    overlay.sync(state({ baseSize: 64 }))
    const view = overlayView(win)
    // the strip is the settings-blind rest state
    expect(view.bounds.at(-1)).toEqual(STRIP)
    overlay.reportHotEdge(view.webContents as never, { enter: true })
    // the pill: 32 + 7×64 + 24 + 14 = 518 CSS px + 2×44.8 headroom = 608;
    // the height 88+9+44.8+28 = 169.8 → 170
    expect(view.bounds.at(-1)).toEqual({ x: 96, y: 430, width: 608, height: 170 })
    // the strength slider shrinks the headroom: M 1.2 → 415 × 109
    overlay.sync(state({ maxScale: 1.2 }))
    expect(view.bounds.at(-1)).toEqual({ x: 188, y: 481, width: 425, height: 119 })
  })

  it('exposes its live webContents for the prefs/open-target pushes', () => {
    const overlay = createDockOverlay(win as never)
    expect(overlay.webContents()).toBeUndefined()
    overlay.sync(state())
    const view = overlayView(win)
    expect(overlay.webContents()).toBe(view.webContents)
    overlay.destroy()
    expect(overlay.webContents()).toBeUndefined()
  })

  it('keeps the last good bounds on a degenerate rect (a mid-restore window)', () => {
    const overlay = createDockOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    const applied = view.bounds.length
    overlay.sync(state({ window: { width: 0, height: 0 } }))
    expect(view.bounds.length).toBe(applied)
    expect(view.visibles.at(-1)).toBe(true)
  })

  it('ignores syncs once the shell window is destroyed', () => {
    const overlay = createDockOverlay(win as never)
    win.isDestroyed.mockReturnValue(true)
    overlay.sync(state())
    expect(win.contentView.addChildView).not.toHaveBeenCalled()
  })
})

describe('the reveal state machine', () => {
  it('enter from the strip reveals the dock rect', () => {
    const overlay = createDockOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    overlay.reportHotEdge(view.webContents as never, { enter: true })
    expect(view.bounds.at(-1)).toEqual(DOCK)
    // an extra enter while revealed changes nothing
    overlay.reportHotEdge(view.webContents as never, { enter: true })
    expect(view.bounds.at(-1)).toEqual(DOCK)
  })

  it('leave arms the grace: the dock hides back to the strip after ~250ms', () => {
    vi.useFakeTimers()
    try {
      const overlay = createDockOverlay(win as never)
      overlay.sync(state())
      const view = overlayView(win)
      overlay.reportHotEdge(view.webContents as never, { enter: true })
      overlay.reportHotEdge(view.webContents as never, { leave: true })
      // still revealed during the grace — diagonal travel toward an icon
      expect(view.bounds.at(-1)).toEqual(DOCK)
      vi.advanceTimersByTime(249)
      expect(view.bounds.at(-1)).toEqual(DOCK)
      vi.advanceTimersByTime(1)
      expect(view.bounds.at(-1)).toEqual(STRIP)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a re-enter during the grace cancels the hide', () => {
    vi.useFakeTimers()
    try {
      const overlay = createDockOverlay(win as never)
      overlay.sync(state())
      const view = overlayView(win)
      overlay.reportHotEdge(view.webContents as never, { enter: true })
      overlay.reportHotEdge(view.webContents as never, { leave: true })
      vi.advanceTimersByTime(100)
      overlay.reportHotEdge(view.webContents as never, { enter: true })
      vi.advanceTimersByTime(1000)
      // the grace was cancelled: the dock never hid
      expect(view.bounds.at(-1)).toEqual(DOCK)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leave from the strip itself arms nothing', () => {
    vi.useFakeTimers()
    try {
      const overlay = createDockOverlay(win as never)
      overlay.sync(state())
      const view = overlayView(win)
      overlay.reportHotEdge(view.webContents as never, { leave: true })
      vi.advanceTimersByTime(1000)
      expect(view.bounds.at(-1)).toEqual(STRIP)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a stand-down sync disarms a pending hide', () => {
    vi.useFakeTimers()
    try {
      const overlay = createDockOverlay(win as never)
      overlay.sync(state())
      const view = overlayView(win)
      overlay.reportHotEdge(view.webContents as never, { enter: true })
      overlay.reportHotEdge(view.webContents as never, { leave: true })
      // the Home tab rises while the grace runs
      overlay.sync(state({ docActive: false }))
      vi.advanceTimersByTime(1000)
      // no timer fired after the teardown; a fresh doc mode starts at rest
      overlay.sync(state())
      expect(view.bounds.at(-1)).toEqual(STRIP)
    } finally {
      vi.useRealTimers()
    }
  })

  it('the reveal is an instant bounds swap in both motion modes (nothing animates main-side)', () => {
    // the reduced-motion contract is the renderer's (the fisheye and its
    // 120ms collapse); the state machine's shapes are the same rects and
    // the transitions are setBounds calls — asserted by the shape tests above
    const overlay = createDockOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    overlay.reportHotEdge(view.webContents as never, { enter: true })
    expect(view.bounds.at(-1)).toEqual(DOCK)
  })

  it('the reveal re-asserts topmost: the view is re-added between syncs', () => {
    const overlay = createDockOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    const added = win.contentView.addChildView.mock.calls.length
    overlay.reportHotEdge(view.webContents as never, { enter: true })
    // a summons between layout passes immediately sits above the drawer
    // overlay (the TabManager's own sync order settles the steady state;
    // this closes the between-passes gap), like the HTML dock over the
    // drawer's scrim
    expect(win.contentView.addChildView.mock.calls.length).toBe(added + 1)
    expect(win.contentView.addChildView.mock.calls.at(-1)![0]).toBe(view)
    // an extra enter while already revealed adds nothing more
    overlay.reportHotEdge(view.webContents as never, { enter: true })
    expect(win.contentView.addChildView.mock.calls.length).toBe(added + 1)
  })
})

describe('the identity gate', () => {
  it('a report from a webContents that is not the overlay view moves nothing', () => {
    const overlay = createDockOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    const other = { id: 900002, isDestroyed: () => false } as never
    overlay.reportHotEdge(other, { enter: true })
    expect(view.bounds.at(-1)).toEqual(STRIP)
  })
})

describe('the interface scale', () => {
  it('applies the synced scale once the entry finished loading', () => {
    const overlay = createDockOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    // the entry is a zoomed chrome frame: the scale rides an inline
    // --ui-scale write at load, so the pill never paints at the wrong size
    view.webContents.onceHandlers.get('did-finish-load')!()
    expect(view.webContents.scripts).toEqual([
      "document.documentElement.style.setProperty('--ui-scale', '1')",
    ])
  })

  it('a fresh mount carries the scale the sync that created it handed', () => {
    const overlay = createDockOverlay(win as never)
    overlay.sync(state({ scale: 1.5 }))
    const view = overlayView(win)
    view.webContents.onceHandlers.get('did-finish-load')!()
    // two writes land: the sync's change-detection write (pre-load, a no-op
    // on the blank document — appliedScale started at the default 1) and the
    // unconditional load-time one, the ask-panel pattern both sharing the
    // same inline value so the pair is harmless by construction
    expect(view.webContents.scripts).toEqual([
      "document.documentElement.style.setProperty('--ui-scale', '1.5')",
      "document.documentElement.style.setProperty('--ui-scale', '1.5')",
    ])
  })

  it('re-applies on a scale change only, never per sync', () => {
    const overlay = createDockOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    view.webContents.onceHandlers.get('did-finish-load')!()
    // the same scale on a later sync writes nothing
    overlay.sync(state())
    expect(view.webContents.scripts).toHaveLength(1)
    // a change writes exactly once more, then stops
    overlay.sync(state({ scale: 1.5 }))
    overlay.sync(state({ scale: 1.5 }))
    expect(view.webContents.scripts).toEqual([
      "document.documentElement.style.setProperty('--ui-scale', '1')",
      "document.documentElement.style.setProperty('--ui-scale', '1.5')",
    ])
  })
})

describe('load and crash hardening', () => {
  it('retries a failed load once, then stands the strip down', () => {
    const overlay = createDockOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    expect(view.webContents.loadURLs).toHaveLength(1)
    const fail = view.webContents.onHandlers.get('did-fail-load')!
    // the common failure is a dev server still booting: one retry
    fail(undefined, -6, 'ERR_CONNECTION_REFUSED', 'http://localhost:5173/', true)
    expect(view.webContents.loadURLs).toHaveLength(2)
    // the retry failed too: the invisible 3px band is stood down instead of
    // eating document clicks forever
    fail(undefined, -6, 'ERR_CONNECTION_REFUSED', 'http://localhost:5173/', true)
    expect(view.webContents.loadURLs).toHaveLength(2)
    expect(view.visibles.at(-1)).toBe(false)
  })

  it('never retries ERR_ABORTED — a superseded navigation would loop', () => {
    const overlay = createDockOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    view.webContents.onHandlers.get('did-fail-load')!(undefined, -3, 'ERR_ABORTED', 'url', true)
    expect(view.webContents.loadURLs).toHaveLength(1)
    expect(view.visibles.at(-1)).toBe(true)
  })

  it('ignores sub-frame failures', () => {
    const overlay = createDockOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    view.webContents.onHandlers.get('did-fail-load')!(undefined, -6, 'ERR_FAILED', 'url', false)
    expect(view.webContents.loadURLs).toHaveLength(1)
    expect(view.visibles.at(-1)).toBe(true)
  })

  it('a crashed renderer shrinks to the strip, hides, and reloads once', () => {
    const overlay = createDockOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    overlay.reportHotEdge(view.webContents as never, { enter: true })
    expect(view.bounds.at(-1)).toEqual(DOCK)
    view.webContents.onHandlers.get('render-process-gone')!(undefined, { reason: 'crashed' })
    // the dead surface is stood down (its 3px would still eat clicks) …
    expect(view.bounds.at(-1)).toEqual(STRIP)
    expect(view.visibles.at(-1)).toBe(false)
    // … and the load is retried exactly once, never a loop
    expect(view.webContents.loadURLs).toHaveLength(2)
    view.webContents.onHandlers.get('render-process-gone')!(undefined, { reason: 'crashed' })
    expect(view.webContents.loadURLs).toHaveLength(2)
  })

  it('a clean exit is the window closing on its own: nothing to recover', () => {
    const overlay = createDockOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    const applied = view.bounds.length
    view.webContents.onHandlers.get('render-process-gone')!(undefined, { reason: 'clean-exit' })
    expect(view.bounds.length).toBe(applied)
    expect(view.webContents.loadURLs).toHaveLength(1)
  })

  it('a main-frame navigation disarms the grace timer (a reload is coming)', () => {
    vi.useFakeTimers()
    try {
      const overlay = createDockOverlay(win as never)
      overlay.sync(state())
      const view = overlayView(win)
      overlay.reportHotEdge(view.webContents as never, { enter: true })
      overlay.reportHotEdge(view.webContents as never, { leave: true })
      // the crash retry navigates: the renderer whose reports armed the
      // timer is going away
      view.webContents.onHandlers.get('did-start-navigation')!(
        undefined,
        'genoffice-app://help/index.html?view=dock',
        false,
        true,
      )
      vi.advanceTimersByTime(1000)
      // the hide never fired: resizing a view mid-reload serves nobody
      expect(view.bounds.at(-1)).toEqual(DOCK)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the window going hidden (blur, minimize)', () => {
  it('a revealed dock shrinks to the strip when the window blurs', () => {
    const overlay = createDockOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    overlay.reportHotEdge(view.webContents as never, { enter: true })
    expect(view.bounds.at(-1)).toEqual(DOCK)
    // a summon nobody can interact with is dead weight
    win.onHandlers.get('blur')!()
    expect(view.bounds.at(-1)).toEqual(STRIP)
  })

  it('the same for a minimize, and only while revealed', () => {
    const overlay = createDockOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    const applied = view.bounds.length
    // the strip at rest has nothing to shrink: no extra bounds write
    win.onHandlers.get('minimize')!()
    expect(view.bounds.length).toBe(applied)
    overlay.reportHotEdge(view.webContents as never, { enter: true })
    win.onHandlers.get('minimize')!()
    expect(view.bounds.at(-1)).toEqual(STRIP)
  })

  it('destroy unregisters the window hooks', () => {
    const overlay = createDockOverlay(win as never)
    overlay.sync(state())
    overlay.destroy()
    expect(win.onHandlers.has('blur')).toBe(false)
    expect(win.onHandlers.has('minimize')).toBe(false)
  })
})

describe('lifetime', () => {
  it('destroy removes the view; the window closing forgets it', () => {
    const overlay = createDockOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    overlay.destroy()
    expect(win.contentView.removeChildView).toHaveBeenCalledWith(expect.anything())
    expect(view.webContents.closeCount).toBe(1)
    // a late sync mounts a fresh view rather than acting on the dead one
    overlay.sync(state())
    const calls = win.contentView.addChildView.mock.calls as unknown[][]
    expect(calls.at(-1)![0]).not.toBe(view)
    // the window's own teardown only forgets: destroy after it is a no-op
    win.onceHandlers.get('closed')!()
    overlay.destroy()
    expect(view.webContents.closeCount).toBe(1)
  })
})
