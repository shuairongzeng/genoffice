import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createAiDrawerOverlay, type AiDrawerOverlayState } from '../src/main/ai-drawer-view'
import { AI_DOCK_WIDTH_DEFAULT, type AiDockPrefs } from '../src/shared/desktop-geometry'

/**
 * The AI drawer's native overlay host (src/main/ai-drawer-view.ts): the
 * WebContentsView that carries the drawer's whole document-mode presence —
 * the drawer's footprint while open, the pet-only footprint while collapsed —
 * with mounting and geometry from the `aiDock` state, topmost re-assertion,
 * hide-not-destroy transitions, the transparent surface the pet-only state
 * needs, the buffered panel deliveries and the ready handshake that releases
 * them, the pet drag's window-wide surface (hosted on request, re-fitted on
 * release or crash), the navigation and crash hardening around the view's
 * own renderer, and the lifetime around the shell window. Electron is mocked
 * the way tab-manager.test.ts mocks it; only the controller's own observable
 * behavior is asserted (the TabManager side that drives it lives in
 * tab-manager.test.ts).
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
    /** the surface color the view last carried (the transparent pet-only view) */
    backgroundColor = ''
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
  backgroundColor: string
  getBounds: () => { x: number; y: number; width: number; height: number }
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

/**
 * A shell-window-like renderer: the realistic shape of another webContents
 * that shares the preload and could send the ready channel — identity, not
 * the shape, is what must separate it from the overlay's own view.
 */
function otherWebContents(): {
  id: number
  sent: Array<{ channel: string; payload: unknown }>
  isDestroyed: () => boolean
  send: (channel: string, payload: unknown) => void
} {
  return {
    id: 900002,
    sent: [],
    isDestroyed: () => false,
    send(channel: string, payload: unknown) {
      this.sent.push({ channel, payload })
    },
  }
}

function state(over: Partial<AiDrawerOverlayState> = {}): AiDrawerOverlayState {
  return {
    dock: { width: AI_DOCK_WIDTH_DEFAULT, collapsed: false, petPos: null, panelPos: null },
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
  it('shows an exactly pet-sized view while the drawer is collapsed over a document', () => {
    // the bug this closes: Home's HTML pet is painted under the document, so
    // the overlay pet is the only way back into the panel — it must exist
    // exactly while the drawer is collapsed, at the pet's own footprint.
    // EXACTLY pet-sized: a view hit-tests over its whole rect however
    // transparent it paints, so a single invisible margin would eat the
    // clicks meant for the page below — the intercept area is the painted
    // bird, and the shadow clips at the edges instead
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state({ dock: { width: 400, collapsed: true, petPos: null } }))
    const view = overlayView(win)
    // the default perch: the pet's top-left where Home's pet perches, the
    // view exactly the pet's own box
    expect(view.bounds.at(-1)).toEqual({
      x: 800 - 68 - 16,
      y: 600 - 62 - 16,
      width: 68,
      height: 62,
    })
    // hidden until the entry signals its shape: an unknown shape paints a
    // transparent blank, and a blank must never eat clicks
    expect(view.visibles.at(-1)).toBe(false)
    overlay.markPanelReadyFor(view.webContents as never)
    expect(view.visibles.at(-1)).toBe(true)
  })

  it('stays hidden through the whole boot until the panel copy signals its shape', () => {
    // the ready ping is the shape-known gate: the view mounts on the sync
    // but paints nothing until the entry knows whether it is the drawer or
    // the pet — a wrong guess is a transparent full-drawer or full-window
    // rect of dead clicks
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    expect(view.visibles).toEqual([false])
    // a foreign renderer's ping changes nothing (identity check)
    overlay.markPanelReadyFor(otherWebContents() as never)
    expect(view.visibles).toEqual([false])
    overlay.markPanelReadyFor(view.webContents as never)
    expect(view.visibles.at(-1)).toBe(true)
  })

  it('a reload re-hides the view until the replacement renderer re-signals', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    overlay.markPanelReadyFor(view.webContents as never)
    expect(view.visibles.at(-1)).toBe(true)
    // the main-frame navigation of a reload: the old shape is gone, a blank
    // must not eat clicks while the new entry boots
    view.webContents.onHandlers.get('did-start-navigation')!(
      {},
      'genoffice-app://help/index.html?view=ask-panel',
      false,
      true,
    )
    expect(view.visibles.at(-1)).toBe(false)
    overlay.markPanelReadyFor(view.webContents as never)
    expect(view.visibles.at(-1)).toBe(true)
  })

  it('places the pet-only view at the stored pet position', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state({ dock: { width: 400, collapsed: true, petPos: { x: 120, y: 80 } } }))
    expect(overlayView(win).bounds.at(-1)).toEqual({ x: 120, y: 80, width: 68, height: 62 })
  })

  it('carries a transparent surface: only the pet may paint over the page', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state({ dock: { width: 400, collapsed: true, petPos: null } }))
    expect(overlayView(win).backgroundColor).toBe('#00000000')
  })

  it('creates no view while Home is the active tab', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state({ docActive: false }))
    expect(win.contentView.addChildView).not.toHaveBeenCalled()
    // collapsed or not: no document, no overlay
    overlay.sync(state({ dock: { width: 400, collapsed: true, petPos: null }, docActive: false }))
    expect(win.contentView.addChildView).not.toHaveBeenCalled()
  })

  it('loads the shell renderer ask-panel entry at the help scheme root', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    expect(view.webContents.loadedUrl).toBe('genoffice-app://help/index.html?view=ask-panel')
    expect(view.webContents.openHandler).toBeTypeOf('function')
  })

  it('exposes the live view webContents for the sender gates that serve the panel copy', () => {
    const overlay = createAiDrawerOverlay(win as never)
    expect(overlay.panelWebContents()).toBeUndefined()
    overlay.sync(state())
    expect(overlay.panelWebContents()).toBe(overlayView(win).webContents)
    overlay.destroy()
    expect(overlay.panelWebContents()).toBeUndefined()
  })

  it("mounts at the content area's right edge, drawer-wide, the full height", () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state({ dock: { width: 480, collapsed: false, petPos: null } }))
    const view = overlayView(win)
    expect(view.bounds.at(-1)).toEqual({ x: 320, y: 48, width: 480, height: 504 })
    overlay.markPanelReadyFor(view.webContents as never)
    expect(view.visibles.at(-1)).toBe(true)
    expect(win.contentView.addChildView).toHaveBeenCalledTimes(1)
  })
})

describe('geometry', () => {
  it('scales the footprint with the interface scale', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state({ dock: { width: 360, collapsed: false, petPos: null }, scale: 1.5 }))
    expect(overlayView(win).bounds.at(-1)).toEqual({ x: 260, y: 48, width: 540, height: 504 })
  })

  it('scales the pet-only footprint with the interface scale', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(
      state({ dock: { width: 400, collapsed: true, petPos: { x: 100, y: 80 } }, scale: 1.5 }),
    )
    // the pet's chrome position and its own box both grow with the zoom
    expect(overlayView(win).bounds.at(-1)).toEqual({ x: 150, y: 120, width: 102, height: 93 })
  })

  it('clamps a drawer wider than the window to the window itself', () => {
    const overlay = createAiDrawerOverlay(win as never)
    // the max rail at 150%: 560 CSS px → 840 window px in an 800 px window
    overlay.sync(state({ dock: { width: 560, collapsed: false, petPos: null }, scale: 1.5 }))
    expect(overlayView(win).bounds.at(-1)).toEqual({ x: 0, y: 48, width: 800, height: 504 })
  })

  it('re-fits the bounds on a later sync (a resize, a stage report)', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    overlay.sync(state({ window: { width: 1000, height: 700 } }))
    expect(view.bounds.at(-1)).toEqual({ x: 600, y: 48, width: 400, height: 604 })
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

  it('fits the app-reported slot EXACTLY while expanded, in preference to the right edge', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    // the docs app reserved this space in its own layout — the drawer docks
    // into it, whatever the right-edge geometry would say
    const slot = { x: 300, y: 44, width: 420, height: 512 }
    overlay.sync(state({ slot }))
    expect(view.bounds.at(-1)).toEqual(slot)
    // and the slot is refitted on a later sync like the edge geometry is
    overlay.sync(state({ slot: { x: 320, y: 60, width: 400, height: 500 } }))
    expect(view.bounds.at(-1)).toEqual({ x: 320, y: 60, width: 400, height: 500 })
  })

  it('the pet-only shape ignores the slot (the pet keeps its own footprint)', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(
      state({
        dock: { width: 400, collapsed: true, petPos: null },
        slot: { x: 300, y: 44, width: 420, height: 512 },
      }),
    )
    const view = overlayView(win)
    expect(view.bounds.at(-1)).toEqual({
      x: 800 - 68 - 16,
      y: 600 - 62 - 16,
      width: 68,
      height: 62,
    })
  })

  it('a sync without a slot falls back to the window-edge geometry', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state({ slot: { x: 300, y: 44, width: 420, height: 512 } }))
    const view = overlayView(win)
    // the slot went stale (the tab hid, the scale changed) or the active tab
    // is not a docs tab: the right edge is the geometry, exactly as before
    overlay.sync(state())
    expect(view.bounds.at(-1)).toEqual({ x: 400, y: 48, width: 400, height: 504 })
  })

  it('the pet drag ends back at the slot it started from', () => {
    const overlay = createAiDrawerOverlay(win as never)
    const slot = { x: 300, y: 44, width: 420, height: 512 }
    overlay.sync(state({ dock: { width: 400, collapsed: true, petPos: null } }))
    const view = overlayView(win)
    overlay.markPanelReadyFor(view.webContents as never)
    // the pet drags from the pet-only shape; the drawer opens mid-drag into a
    // docked sync, and the drag's end must re-fit the DOCKED footprint, not
    // the window edge
    overlay.applyPetDragReport(view.webContents as never, { start: true })
    expect(view.bounds.at(-1)).toEqual({ x: 0, y: 0, width: 800, height: 600 })
    overlay.sync(state({ slot }))
    overlay.applyPetDragReport(view.webContents as never, { end: true })
    expect(view.bounds.at(-1)).toEqual(slot)
  })

  it('docked flips push the embedded chrome flag to the panel copy; floating does not', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    overlay.markPanelReadyFor(view.webContents as never)
    const embeddedPushes = () =>
      view.webContents.sent.filter((m) => m.channel === 'home:ask-panel-embedded')
    expect(embeddedPushes()).toEqual([])
    // docking into the app's slot: the panel's chrome reads as the app's own
    overlay.sync(state({ slot: { x: 300, y: 44, width: 420, height: 512 } }))
    expect(embeddedPushes().at(-1)).toEqual({ channel: 'home:ask-panel-embedded', payload: true })
    // the same slot again: no duplicate push
    overlay.sync(state({ slot: { x: 300, y: 44, width: 420, height: 512 } }))
    expect(embeddedPushes()).toHaveLength(1)
    // back to floating: the flag flips back
    overlay.sync(state())
    expect(embeddedPushes().at(-1)).toEqual({ channel: 'home:ask-panel-embedded', payload: false })
    // pet-only is floating chrome too (the pet is never "docked")
    overlay.sync(state({ dock: { width: 400, collapsed: true, petPos: null } }))
    expect(embeddedPushes().at(-1)).toEqual({ channel: 'home:ask-panel-embedded', payload: false })
  })

  it('a docked flip that BEATS the ready handshake waits in the buffer, then lands', () => {
    // the flip is main-side truth about the view's shape, and it can land
    // while the panel's listeners are still booting (the entry mounts behind
    // an await chain) — it must ride the same buffer the forwarded asks do,
    // not vanish into a renderer with no listener yet
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    // pre-ready: the docking sync's flip is buffered, nothing was sent
    overlay.sync(state({ slot: { x: 300, y: 44, width: 420, height: 512 } }))
    const embeddedPushes = () =>
      view.webContents.sent.filter((m) => m.channel === 'home:ask-panel-embedded')
    expect(embeddedPushes()).toEqual([])
    // the panel's own ready ping flushes it — the chrome class lands with it
    overlay.markPanelReadyFor(view.webContents as never)
    expect(embeddedPushes()).toEqual([{ channel: 'home:ask-panel-embedded', payload: true }])
  })
})

describe('z-order', () => {
  it('re-asserts the topmost position on every shown sync', () => {
    // addChildView re-adds an existing child as the topmost view, so a view
    // added after the overlay showed (a new tab, a browser page's annotate
    // layer) cannot end up above it — the pet stays clickable mid-annotation
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    expect(win.contentView.addChildView).toHaveBeenCalledTimes(1)
    overlay.sync(state())
    expect(win.contentView.addChildView).toHaveBeenCalledTimes(2)
    expect(win.contentView.addChildView).toHaveBeenLastCalledWith(view)
  })
})

describe('state transitions (resize, never destroy)', () => {
  it('shrinks to the pet when the drawer closes over the document, keeping the view', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    overlay.markPanelReadyFor(view.webContents as never)
    overlay.sync(state({ dock: { width: 480, collapsed: true, petPos: null } }))
    // pet-only, never destroyed: the panel's session outlives the collapse
    expect(view.visibles.at(-1)).toBe(true)
    expect(view.bounds.at(-1)).toEqual({
      x: 800 - 68 - 16,
      y: 600 - 62 - 16,
      width: 68,
      height: 62,
    })
    expect(win.contentView.removeChildView).not.toHaveBeenCalled()
    expect(view.webContents.closeCount).toBe(0)
    overlay.sync(state({ dock: { width: 480, collapsed: false, petPos: null } }))
    expect(win.contentView.addChildView).toHaveBeenLastCalledWith(view)
    expect(view.bounds.at(-1)).toEqual({ x: 320, y: 48, width: 480, height: 504 })
    expect(view.visibles.at(-1)).toBe(true)
  })

  it('hides while Home is the active tab, keeping the view', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    overlay.markPanelReadyFor(view.webContents as never)
    overlay.sync(state({ docActive: false }))
    expect(view.visibles.at(-1)).toBe(false)
    expect(win.contentView.removeChildView).not.toHaveBeenCalled()
  })

  it('hides while the active tab presents fullscreen, keeping the view', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    overlay.markPanelReadyFor(view.webContents as never)
    overlay.sync(state({ suppressed: true }))
    expect(view.visibles.at(-1)).toBe(false)
    expect(view.webContents.closeCount).toBe(0)
    overlay.sync(state({ suppressed: false }))
    expect(view.visibles.at(-1)).toBe(true)
  })

  it('a degenerate-rect collapse applies nothing: the next good sync still hands the keyboard back', () => {
    // a minimized/mid-restore window reports a degenerate rect exactly when
    // the drawer is collapsing — a sync that flipped the mode state while
    // skipping the bounds would eat the collapse's focus hand-back on the
    // next good sync (it would see the transition as already made). The
    // guard must apply the whole state or none of it
    const focusActiveView = vi.fn()
    const overlay = createAiDrawerOverlay(win as never, { focusActiveView })
    overlay.sync(state())
    const view = overlayView(win)
    overlay.markPanelReadyFor(view.webContents as never)
    // the collapse lands with a degenerate window: nothing applies
    overlay.sync(
      state({
        dock: { width: 480, collapsed: true, petPos: null },
        window: { width: 0, height: 0 },
      }),
    )
    expect(view.bounds.at(-1)).toEqual({ x: 400, y: 48, width: 400, height: 504 })
    expect(focusActiveView).not.toHaveBeenCalled()
    // the next good sync completes the transition, focus hand-back included
    overlay.sync(state({ dock: { width: 480, collapsed: true, petPos: null } }))
    expect(view.bounds.at(-1)).toEqual({
      x: 800 - 68 - 16,
      y: 600 - 62 - 16,
      width: 68,
      height: 62,
    })
    expect(focusActiveView).toHaveBeenCalledTimes(1)
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

  it('prevents the view from navigating itself: its URL is main-authored', () => {
    // the panel entry is a mounted React tree, not a page of links — any
    // navigation attempt is a hostile renderer, and staying on the panel
    // entry is what lets the widened browserskill gate trust this view
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    const prevented = vi.fn()
    view.webContents.onHandlers.get('will-navigate')!(
      { preventDefault: prevented },
      'https://evil.example/',
    )
    expect(prevented).toHaveBeenCalledTimes(1)
  })
})

describe('the dock prefs read', () => {
  it('clamps the width through the shared rails before shaping the bounds', () => {
    const overlay = createAiDrawerOverlay(win as never)
    const dock: AiDockPrefs = { width: 2000, collapsed: false, petPos: null }
    overlay.sync(state({ dock }))
    // 2000 clamps to AI_DOCK_WIDTH_MAX (560) like the renderer's own drag
    expect(overlayView(win).bounds.at(-1)).toEqual({ x: 240, y: 48, width: 560, height: 504 })
  })
})

describe('deliveries to the panel copy (P0-2: the ask-intent forward)', () => {
  const handoff = {
    channel: 'home:ask-forwarded',
    payload: { text: 'asked over a doc', seq: 1, origin: 'palette' },
  }

  it('holds the buffer at did-finish-load: the load is not the panel listening', () => {
    // the delivery race: the panel entry boots behind an await chain (language,
    // theme, dictionary) before its first render, so its subscriptions arm
    // after the load event — a flush keyed on the load alone would drop the
    // message in a renderer nobody is listening in
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    view.webContents.onceHandlers.get('did-finish-load')!()
    overlay.deliverToPanel(handoff.channel, handoff.payload)
    expect(view.webContents.sent).toEqual([])
  })

  it('flushes the buffer once the panel signals ready with its own webContents', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    overlay.deliverToPanel(handoff.channel, handoff.payload)
    expect(view.webContents.sent).toEqual([])
    overlay.markPanelReadyFor(view.webContents as never)
    expect(view.webContents.sent).toEqual([handoff])
  })

  it('delivers directly once the panel signaled ready', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    overlay.markPanelReadyFor(view.webContents as never)
    overlay.deliverToPanel(handoff.channel, handoff.payload)
    expect(view.webContents.sent).toEqual([handoff])
  })

  it('ignores a ready ping from a webContents that is not the overlay view', () => {
    // the ready channel is fire-and-forget and any renderer sharing the shell
    // preload can send it (the shell window's own renderer included), so
    // identity — not the arrival — vouches the sender
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    overlay.deliverToPanel(handoff.channel, handoff.payload)
    const other = otherWebContents()
    overlay.markPanelReadyFor(other as never)
    expect(view.webContents.sent).toEqual([])
    // nothing was flushed to the imposter either
    expect(other.sent).toEqual([])
    // the buffer stayed armed: the view's own ping still flushes it
    overlay.markPanelReadyFor(view.webContents as never)
    expect(view.webContents.sent).toEqual([handoff])
  })

  it('buffers again after a reload until the new renderer signals ready', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    overlay.markPanelReadyFor(view.webContents as never)
    overlay.deliverToPanel(handoff.channel, handoff.payload)
    expect(view.webContents.sent).toEqual([handoff])
    // a reload: the navigation's start clears the armed flag, because the
    // renderer that follows has its own boot to finish before it listens
    view.webContents.onHandlers.get('did-start-navigation')!(
      {},
      'genoffice-app://help/index.html?view=ask-panel',
      false,
      true,
    )
    overlay.deliverToPanel(handoff.channel, handoff.payload)
    expect(view.webContents.sent).toEqual([handoff])
    overlay.markPanelReadyFor(view.webContents as never)
    expect(view.webContents.sent).toEqual([handoff, handoff])
  })

  it('keeps the flag through an in-place navigation (a fragment, a pushState)', () => {
    // the same React app keeps running: it already signaled, and no second
    // ping would ever come to re-arm a wrongly cleared flag
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    overlay.markPanelReadyFor(view.webContents as never)
    view.webContents.onHandlers.get('did-start-navigation')!(
      {},
      'genoffice-app://help/index.html?view=ask-panel#section',
      true,
      true,
    )
    overlay.deliverToPanel(handoff.channel, handoff.payload)
    expect(view.webContents.sent).toEqual([handoff])
  })

  it('keeps the flag through a subframe navigation (an image inside an answer)', () => {
    // only the main frame's document swap replaces the page and its
    // listeners; a subframe navigating is not the panel going anywhere
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    overlay.markPanelReadyFor(view.webContents as never)
    view.webContents.onHandlers.get('did-start-navigation')!(
      {},
      'https://example.com/frame',
      false,
      false,
    )
    overlay.deliverToPanel(handoff.channel, handoff.payload)
    expect(view.webContents.sent).toEqual([handoff])
  })

  it('resets the armed flag and retries the load once when the renderer crashes', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    overlay.markPanelReadyFor(view.webContents as never)
    overlay.deliverToPanel(handoff.channel, handoff.payload)
    expect(view.webContents.sent).toEqual([handoff])
    const crash = (): void => {
      view.webContents.onHandlers.get('render-process-gone')!({}, { reason: 'crashed' })
    }
    expect(view.webContents.loadURLs).toHaveLength(1)
    crash()
    // the crash's own recovery: one retry, and the armed flag went with the
    // dead process — a delivery waits for the replacement's ping
    expect(view.webContents.loadURLs).toHaveLength(2)
    overlay.deliverToPanel(handoff.channel, handoff.payload)
    expect(view.webContents.sent).toEqual([handoff])
    // a second crash does not loop the retry
    crash()
    expect(view.webContents.loadURLs).toHaveLength(2)
    // the replacement renderer signals: the waiting message flushes into it
    overlay.markPanelReadyFor(view.webContents as never)
    expect(view.webContents.sent).toEqual([handoff, handoff])
  })

  it('treats a clean exit as nothing to recover: our own teardown caused it', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    const view = overlayView(win)
    view.webContents.onHandlers.get('render-process-gone')!({}, { reason: 'clean-exit' })
    expect(view.webContents.loadURLs).toHaveLength(1)
  })

  it('buffers a delivery that beats the view itself, until the panel signals ready', () => {
    // the drawer can still be mounting when Home forwards: the very prefs
    // write that expands it is still settling through watchAiDock's debounce
    const overlay = createAiDrawerOverlay(win as never)
    overlay.deliverToPanel(handoff.channel, handoff.payload)
    overlay.sync(state())
    const view = overlayView(win)
    view.webContents.onceHandlers.get('did-finish-load')!()
    expect(view.webContents.sent).toEqual([])
    overlay.markPanelReadyFor(view.webContents as never)
    expect(view.webContents.sent).toEqual([handoff])
  })

  it('keeps only the newest messages while the panel never signals ready', () => {
    const overlay = createAiDrawerOverlay(win as never)
    overlay.sync(state())
    for (let i = 0; i < 30; i++) overlay.deliverToPanel('home:ask-forwarded', { seq: i })
    const view = overlayView(win)
    view.webContents.onceHandlers.get('did-finish-load')!()
    expect(view.webContents.sent).toEqual([])
    overlay.markPanelReadyFor(view.webContents as never)
    // the cap drops the oldest rather than growing without bound
    expect(view.webContents.sent).toHaveLength(25)
    expect((view.webContents.sent.at(-1)!.payload as { seq: number }).seq).toBe(29)
  })
})

describe('focus return on hide and pet-only shrink (P1-3)', () => {
  it('hands the keyboard back when the drawer collapses under the person, and on hide', () => {
    const focusActiveView = vi.fn()
    const overlay = createAiDrawerOverlay(win as never, { focusActiveView })
    // a first pet-only mount strands no keyboard: nothing showed before it
    overlay.sync(state({ dock: { width: 480, collapsed: true, petPos: null } }))
    expect(focusActiveView).not.toHaveBeenCalled()
    const view = overlayView(win)
    overlay.markPanelReadyFor(view.webContents as never)
    // the pet's collapse write after a real drawer: the view shrinks to the
    // pet but stays up — the composer's keyboard must not stay stranded in it
    overlay.sync(state())
    overlay.sync(state({ dock: { width: 480, collapsed: true, petPos: null } }))
    expect(view.visibles.at(-1)).toBe(true)
    expect(focusActiveView).toHaveBeenCalledTimes(1)
    // a pet-only sync that stays pet-only (a petPos write) moves nobody
    overlay.sync(state({ dock: { width: 480, collapsed: true, petPos: { x: 10, y: 10 } } }))
    expect(focusActiveView).toHaveBeenCalledTimes(1)
    // re-expand: the composer takes the focus when clicked, none moved
    overlay.sync(state())
    expect(focusActiveView).toHaveBeenCalledTimes(1)
    // the real hide (Home tab): focus returns once more
    overlay.sync(state({ docActive: false }))
    expect(focusActiveView).toHaveBeenCalledTimes(2)
  })

  it('leaves focus alone when the overlay was never showing', () => {
    const focusActiveView = vi.fn()
    const overlay = createAiDrawerOverlay(win as never, { focusActiveView })
    // syncs that never showed the view (Home active, a presentation) must
    // not move anyone's focus
    overlay.sync(state({ docActive: false }))
    overlay.sync(state({ suppressed: true }))
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

describe('the pet drag surface (home:ai-pet-drag → applyPetDragReport)', () => {
  const petState = (over: Partial<AiDrawerOverlayState> = {}): AiDrawerOverlayState =>
    state({ dock: { width: 400, collapsed: true, petPos: { x: 100, y: 100 } }, ...over })

  it('hosts the gesture on a window-wide surface, and re-fits it on the end report', () => {
    const overlay = createAiDrawerOverlay(win as never, { focusActiveView: () => undefined })
    overlay.sync(petState())
    const view = overlayView(win)
    const wc = view.webContents as never
    // the surface: the whole window, transparent, for the gesture's duration.
    // Static and window-wide is the whole point — every event's client
    // position is the pointer's window position whatever the input device,
    // so the renderer's drag math (pointer minus grab) is exact for all of
    // them; a view that followed the pointer would make it device-dependent
    overlay.applyPetDragReport(wc, { start: true })
    expect(view.bounds.at(-1)).toEqual({ x: 0, y: 0, width: 800, height: 600 })
    // mid-gesture the surface does not move: no report can shift it, so no
    // input model's coordinates can be invalidated by main's own movement
    overlay.applyPetDragReport(wc, { end: false })
    expect(view.bounds.at(-1)).toEqual({ x: 0, y: 0, width: 800, height: 600 })
    // the end report re-fits the synced footprint (the release's own prefs
    // write would too, but only when the position actually changed)
    overlay.applyPetDragReport(wc, { end: true })
    expect(view.bounds.at(-1)).toEqual({ x: 100, y: 100, width: 68, height: 62 })
  })

  it('the end report re-fits whatever the synced shape is, not only the pet', () => {
    // a drawer-shaped view (an expansion mid-gesture, say) is restored to
    // the drawer's footprint, not to a pet rect
    const overlay = createAiDrawerOverlay(win as never, { focusActiveView: () => undefined })
    overlay.sync(state({ dock: { width: 400, collapsed: false, petPos: null } }))
    const view = overlayView(win)
    overlay.applyPetDragReport(view.webContents as never, { end: true })
    expect(view.bounds.at(-1)).toEqual({ x: 400, y: 48, width: 400, height: 504 })
  })

  it('a sync mid-gesture re-fits the surface too (the prefs write landing)', () => {
    // the release persists the position through the ordinary aiDock write,
    // whose watcher lays out the view — the drag surface must not outlive
    // that: the sync re-fits to the new petPos
    const overlay = createAiDrawerOverlay(win as never, { focusActiveView: () => undefined })
    overlay.sync(petState())
    const view = overlayView(win)
    overlay.applyPetDragReport(view.webContents as never, { start: true })
    expect(view.bounds.at(-1)).toEqual({ x: 0, y: 0, width: 800, height: 600 })
    overlay.sync(petState({ dock: { width: 400, collapsed: true, petPos: { x: 300, y: 200 } } }))
    expect(view.bounds.at(-1)).toEqual({ x: 300, y: 200, width: 68, height: 62 })
  })

  it('ignores a surface report from a webContents that is not the overlay view', () => {
    const overlay = createAiDrawerOverlay(win as never, { focusActiveView: () => undefined })
    overlay.sync(petState())
    const view = overlayView(win)
    const other = otherWebContents()
    overlay.applyPetDragReport(other as never, { start: true })
    // not grown, not shrunk — identity, not the arrival, vouches the sender
    expect(view.bounds.at(-1)).toEqual({ x: 100, y: 100, width: 68, height: 62 })
  })

  it('ignores a start report while the drawer is expanded (no window-wide drawer)', () => {
    const overlay = createAiDrawerOverlay(win as never, { focusActiveView: () => undefined })
    overlay.sync(state())
    const view = overlayView(win)
    overlay.applyPetDragReport(view.webContents as never, { start: true })
    expect(view.bounds.at(-1)).toEqual({ x: 400, y: 48, width: 400, height: 504 })
  })

  it('a crashed renderer collapses a window-wide drag surface with it', () => {
    // the gesture's listeners (and its end report) die with the process: a
    // full-window transparent view left behind would eat every click over
    // the document, so the crash re-fits the synced footprint itself
    const overlay = createAiDrawerOverlay(win as never, { focusActiveView: () => undefined })
    overlay.sync(petState())
    const view = overlayView(win)
    overlay.applyPetDragReport(view.webContents as never, { start: true })
    expect(view.bounds.at(-1)).toEqual({ x: 0, y: 0, width: 800, height: 600 })
    view.webContents.onHandlers.get('render-process-gone')!({}, { reason: 'crashed' })
    expect(view.bounds.at(-1)).toEqual({ x: 100, y: 100, width: 68, height: 62 })
  })
})

describe('the panel drag surface (home:ask-panel-drag → applyPanelDragReport)', () => {
  it('hosts the floating expanded panel gesture on a window-wide surface, re-fit on end', () => {
    const overlay = createAiDrawerOverlay(win as never, { focusActiveView: () => undefined })
    overlay.sync(state())
    const view = overlayView(win)
    overlay.markPanelReadyFor(view.webContents as never)
    // the floating card at its default right-edge perch
    expect(view.bounds.at(-1)).toEqual({ x: 400, y: 48, width: 400, height: 504 })
    overlay.applyPanelDragReport(view.webContents as never, { start: true })
    // the same window-wide static surface as the pet drag's: exact client
    // coordinates for every input model, and the release always arrives
    expect(view.bounds.at(-1)).toEqual({ x: 0, y: 0, width: 800, height: 600 })
    // the release's prefs write parked the card: the end report re-fits it
    overlay.sync(
      state({ dock: { width: 400, collapsed: false, petPos: null, panelPos: { x: 40, y: 60 } } }),
    )
    overlay.applyPanelDragReport(view.webContents as never, { end: true })
    expect(view.bounds.at(-1)).toEqual({ x: 40, y: 60, width: 400, height: 504 })
  })

  it('ignores a start report while the panel is docked into the host slot', () => {
    // a slotted panel is the host app's own layout — it does not move
    const overlay = createAiDrawerOverlay(win as never, { focusActiveView: () => undefined })
    const slot = { x: 300, y: 44, width: 420, height: 512 }
    overlay.sync(state({ slot }))
    const view = overlayView(win)
    overlay.markPanelReadyFor(view.webContents as never)
    overlay.applyPanelDragReport(view.webContents as never, { start: true })
    expect(view.bounds.at(-1)).toEqual(slot)
  })

  it('ignores a start report while collapsed (the pet-only state has its own drag)', () => {
    const overlay = createAiDrawerOverlay(win as never, { focusActiveView: () => undefined })
    overlay.sync(
      state({ dock: { width: 400, collapsed: true, petPos: { x: 100, y: 100 }, panelPos: null } }),
    )
    const view = overlayView(win)
    overlay.applyPanelDragReport(view.webContents as never, { start: true })
    expect(view.bounds.at(-1)).toEqual({ x: 100, y: 100, width: 68, height: 62 })
  })

  it('ignores a report from a webContents that is not the overlay view', () => {
    const overlay = createAiDrawerOverlay(win as never, { focusActiveView: () => undefined })
    overlay.sync(state())
    const view = overlayView(win)
    overlay.applyPanelDragReport(otherWebContents() as never, { start: true })
    // not grown — identity, not the arrival, vouches the sender
    expect(view.bounds.at(-1)).toEqual({ x: 400, y: 48, width: 400, height: 504 })
  })

  it('parks the card where the drag left it, clamped into the window', () => {
    const overlay = createAiDrawerOverlay(win as never, { focusActiveView: () => undefined })
    // past the right and bottom edges: the clamp pulls it back inside
    overlay.sync(
      state({
        dock: { width: 400, collapsed: false, petPos: null, panelPos: { x: 9999, y: 9999 } },
      }),
    )
    expect(overlayView(win).bounds.at(-1)).toEqual({ x: 400, y: 96, width: 400, height: 504 })
  })

  it('scales the parked spot with the interface scale', () => {
    const overlay = createAiDrawerOverlay(win as never, { focusActiveView: () => undefined })
    overlay.sync(
      state({
        dock: { width: 360, collapsed: false, petPos: null, panelPos: { x: 40, y: 60 } },
        scale: 1.5,
      }),
    )
    // 360 css → 540 window px wide; the spot multiplies like the pet's
    expect(overlayView(win).bounds.at(-1)).toEqual({ x: 60, y: 90, width: 540, height: 504 })
  })
})

describe('load failures (P2: the failed panel URL)', () => {
  it('retries the panel URL once when the load fails, then reports and hides', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const overlay = createAiDrawerOverlay(win as never)
      overlay.sync(state())
      const view = overlayView(win)
      const fail = (code: number): void => {
        view.webContents.onHandlers.get('did-fail-load')!({}, code, 'ERR', 'https://x', true)
      }
      // never loaded, never signaled: the shape-known gate already keeps it
      // hidden — a transparent dead view must not eat the document's clicks
      expect(view.visibles).toEqual([false])
      expect(view.webContents.loadURLs).toHaveLength(1)
      // a real failure (not ERR_ABORTED) retries once
      fail(-21)
      expect(view.webContents.loadURLs).toHaveLength(2)
      // the retry failing too: reported, not looped — and the stand-down
      // hides the dead surface; only a successful load (whose ping re-shows)
      // or the view's recreation brings it back
      fail(-21)
      expect(view.webContents.loadURLs).toHaveLength(2)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(view.visibles.at(-1)).toBe(false)
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
