import { runInNewContext } from 'node:vm'
import type { WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildScrollBridgeScript,
  parseScrollRatioMessage,
  parseSplitScrollConsoleMessage,
  ScrollSyncCoordinator,
  SPLIT_SCROLL_MSG_PREFIX,
  SplitScrollSyncController,
} from './split-scroll-sync'

type ListenerFn = (...args: unknown[]) => void

interface MockWebContentsHandle {
  wc: WebContents
  listeners: Map<string, Set<ListenerFn>>
  executeJavaScript: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  removeListener: ReturnType<typeof vi.fn>
  setDestroyed: (destroyed: boolean) => void
  emit: (event: string, ...args: unknown[]) => void
}

function createMockWebContents(
  id: number,
  options: { destroyed?: boolean; rejectExecuteJs?: boolean } = {},
): MockWebContentsHandle {
  let destroyed = options.destroyed ?? false
  const listeners = new Map<string, Set<ListenerFn>>()

  const on = vi.fn((event: string, listener: ListenerFn) => {
    let set = listeners.get(event)
    if (!set) {
      set = new Set()
      listeners.set(event, set)
    }
    set.add(listener)
    return wc
  })

  const removeListener = vi.fn((event: string, listener: ListenerFn) => {
    listeners.get(event)?.delete(listener)
    return wc
  })

  const executeJavaScript = vi.fn((_code: string) => {
    if (options.rejectExecuteJs) {
      return Promise.reject(new Error('WebContents navigated away'))
    }
    return Promise.resolve(undefined)
  })

  const wc = {
    id,
    isDestroyed: vi.fn(() => destroyed),
    on,
    removeListener,
    executeJavaScript,
  } as unknown as WebContents

  return {
    wc,
    listeners,
    executeJavaScript,
    on,
    removeListener,
    setDestroyed: (value: boolean) => {
      destroyed = value
    },
    emit: (event: string, ...args: unknown[]) => {
      const registered = listeners.get(event)
      if (!registered) return
      for (const listener of [...registered]) {
        listener(...args)
      }
    },
  }
}

describe('ScrollSyncCoordinator', () => {
  it('drops reports when disabled, invalid, missing bindings, or from unknown wcId', () => {
    const coord = new ScrollSyncCoordinator()

    expect(coord.handleReport(1, 0.5, 1000)).toBeNull()

    coord.configure({ enabled: true, leftWcId: null, rightWcId: 2 })
    expect(coord.handleReport(2, 0.5, 1000)).toBeNull()

    coord.configure({ enabled: true, leftWcId: 1, rightWcId: 1 })
    expect(coord.handleReport(1, 0.5, 1000)).toBeNull()

    coord.configure({ enabled: false, leftWcId: 1, rightWcId: 2 })
    expect(coord.handleReport(1, 0.5, 1000)).toBeNull()

    coord.configure({ enabled: true, leftWcId: 1, rightWcId: 2 })
    expect(coord.handleReport(999, 0.5, 1000)).toBeNull()
    expect(coord.handleReport(1, Number.NaN, 1000)).toBeNull()
    expect(coord.handleReport(1, Number.POSITIVE_INFINITY, 1000)).toBeNull()
    expect(coord.handleReport(1, Number.NEGATIVE_INFINITY, 1000)).toBeNull()
  })

  it('forwards left->right and right->left and clamps out-of-range ratios to [0, 1]', () => {
    const coord = new ScrollSyncCoordinator()
    coord.configure({ enabled: true, leftWcId: 10, rightWcId: 20 })

    expect(coord.handleReport(10, -0.3, 1000)).toEqual({ targetWcId: 20, ratio: 0 })
    expect(coord.handleReport(10, 1.75, 1010)).toEqual({ targetWcId: 20, ratio: 1 })

    // After cooldown expires, right can drive left.
    expect(coord.handleReport(20, 0.42, 1200)).toEqual({ targetWcId: 10, ratio: 0.42 })
    expect(coord.handleReport(20, -0, 1400)).toEqual({ targetWcId: 10, ratio: 0 })
  })

  it('suppresses follower echoes within the 120ms cooldown window without ping-ponging', () => {
    const coord = new ScrollSyncCoordinator({ cooldownMs: 120, takeoverDelta: 0.025 })
    coord.configure({ enabled: true, leftWcId: 1, rightWcId: 2 })

    expect(coord.handleReport(1, 0.5, 1000)).toEqual({ targetWcId: 2, ratio: 0.5 })

    // Follower echoes at exact ratio and slightly drifted ratio inside cooldown are dropped.
    expect(coord.handleReport(2, 0.5, 1010)).toBeNull()
    expect(coord.handleReport(2, 0.515, 1080)).toBeNull()
    // Inclusive boundary at t = 1000 + 120 = 1120 is still suppressed.
    expect(coord.handleReport(2, 0.5, 1120)).toBeNull()
  })

  it('allows follower to take over as leader after the cooldown window expires', () => {
    const coord = new ScrollSyncCoordinator({ cooldownMs: 120 })
    coord.configure({ enabled: true, leftWcId: 1, rightWcId: 2 })

    expect(coord.handleReport(1, 0.4, 1000)).toEqual({ targetWcId: 2, ratio: 0.4 })
    expect(coord.handleReport(2, 0.4, 1120)).toBeNull()

    // Once cooldown expires (> 1120), follower can become the new leader.
    expect(coord.handleReport(2, 0.4, 1121)).toEqual({ targetWcId: 1, ratio: 0.4 })

    // Former leader is now suppressed inside its own 120ms window.
    expect(coord.handleReport(1, 0.4, 1180)).toBeNull()

    // Verify stale target tracking does not block returning to an earlier ratio after switching leaders.
    expect(coord.handleReport(2, 0.8, 1250)).toEqual({ targetWcId: 1, ratio: 0.8 })
    expect(coord.handleReport(1, 0.4, 1400)).toEqual({ targetWcId: 2, ratio: 0.4 })
  })

  it('allows immediate preemption during cooldown when delta >= takeoverDelta', () => {
    const coord = new ScrollSyncCoordinator({ cooldownMs: 120, takeoverDelta: 0.025 })
    coord.configure({ enabled: true, leftWcId: 1, rightWcId: 2 })

    expect(coord.handleReport(1, 0, 1000)).toEqual({ targetWcId: 2, ratio: 0 })

    // Smaller than takeoverDelta inside cooldown -> dropped.
    expect(coord.handleReport(2, 0.024, 1040)).toBeNull()

    // Equal to takeoverDelta (0.025) inside cooldown -> immediately preempts.
    expect(coord.handleReport(2, 0.025, 1050)).toEqual({ targetWcId: 1, ratio: 0.025 })

    // Former leader (1) is now suppressed, unless it jumps by >= 0.025.
    expect(coord.handleReport(1, 0.03, 1080)).toBeNull()
    expect(coord.handleReport(1, 0.2, 1090)).toEqual({ targetWcId: 2, ratio: 0.2 })
  })

  it('filters micro-jitter smaller than epsilon', () => {
    const coord = new ScrollSyncCoordinator({ epsilon: 0.0005 })
    coord.configure({ enabled: true, leftWcId: 1, rightWcId: 2 })

    expect(coord.handleReport(1, 0.5, 1000)).toEqual({ targetWcId: 2, ratio: 0.5 })
    expect(coord.handleReport(1, 0.5004, 1010)).toBeNull()
    expect(coord.handleReport(1, 0.4996, 1020)).toBeNull()
    expect(coord.handleReport(1, 0.501, 1030)).toEqual({ targetWcId: 2, ratio: 0.501 })

    // Verify exact epsilon boundary using a binary-exact baseline (0 -> 0.0005).
    coord.reset()
    expect(coord.handleReport(1, 0, 1040)).toEqual({ targetWcId: 2, ratio: 0 })
    expect(coord.handleReport(1, 0.00049, 1050)).toBeNull()
    expect(coord.handleReport(1, 0.0005, 1060)).toEqual({ targetWcId: 2, ratio: 0.0005 })
  })

  it('resets state only when configure changes bindings or enabled flag', () => {
    const coord = new ScrollSyncCoordinator({ cooldownMs: 120 })
    coord.configure({ enabled: true, leftWcId: 1, rightWcId: 2 })
    coord.handleReport(1, 0.5, 1000)

    // Identical configure preserves suppression and lastForwardedRatio.
    coord.configure({ enabled: true, leftWcId: 1, rightWcId: 2 })
    expect(coord.getState().suppressed.get(2)).toEqual({ ratio: 0.5, untilMs: 1120 })
    expect(coord.getState().lastForwardedRatio.get(2)).toBe(0.5)

    // Changing rightWcId resets transient state.
    coord.configure({ enabled: true, leftWcId: 1, rightWcId: 3 })
    expect(coord.getState().suppressed.size).toBe(0)
    expect(coord.getState().lastForwardedRatio.size).toBe(0)

    coord.handleReport(1, 0.6, 2000)
    coord.reset()
    expect(coord.getState().suppressed.size).toBe(0)
    expect(coord.getState().lastForwardedRatio.size).toBe(0)
    expect(coord.getState().enabled).toBe(true)
  })
})

describe('console message & ratio parsing', () => {
  it('extracts message from both object event and legacy tuple signatures', () => {
    const payload = `${SPLIT_SCROLL_MSG_PREFIX}0.250000`

    expect(parseSplitScrollConsoleMessage([{ message: payload, level: 'debug' }])).toBe(payload)
    expect(parseSplitScrollConsoleMessage([{}, 0, payload, 12, 'app://docs'])).toBe(payload)
    expect(parseSplitScrollConsoleMessage([{ message: 123 }, 0, payload])).toBe(payload)
    expect(parseSplitScrollConsoleMessage([])).toBeNull()
    expect(parseSplitScrollConsoleMessage([{}, 0, 42])).toBeNull()
  })

  it('parses valid prefixed scroll ratios and rejects malformed messages', () => {
    expect(parseScrollRatioMessage(`${SPLIT_SCROLL_MSG_PREFIX}0.375000`)).toBe(0.375)
    expect(parseScrollRatioMessage(`${SPLIT_SCROLL_MSG_PREFIX}-0.2`)).toBe(0)
    expect(parseScrollRatioMessage(`${SPLIT_SCROLL_MSG_PREFIX}1.8`)).toBe(1)

    expect(parseScrollRatioMessage('unrelated console log')).toBeNull()
    expect(parseScrollRatioMessage(SPLIT_SCROLL_MSG_PREFIX)).toBeNull()
    expect(parseScrollRatioMessage(`${SPLIT_SCROLL_MSG_PREFIX}   `)).toBeNull()
    expect(parseScrollRatioMessage(`${SPLIT_SCROLL_MSG_PREFIX}NaN`)).toBeNull()
    expect(parseScrollRatioMessage(`${SPLIT_SCROLL_MSG_PREFIX}Infinity`)).toBeNull()
    expect(parseScrollRatioMessage(`${SPLIT_SCROLL_MSG_PREFIX}0.5px`)).toBeNull()
  })
})

describe('SplitScrollSyncController', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('injects bridge script, forwards scrolls bidirectionally, and blocks echo', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    const left = createMockWebContents(101)
    const right = createMockWebContents(202)
    const controller = new SplitScrollSyncController()

    controller.sync({
      enabled: true,
      left: { tabId: 'tab-l', kind: 'docs', webContents: left.wc },
      right: { tabId: 'tab-r', kind: 'markdown', webContents: right.wc },
    })

    expect(left.on).toHaveBeenCalledTimes(2)
    expect(right.on).toHaveBeenCalledTimes(2)
    expect(left.executeJavaScript).toHaveBeenCalledTimes(1)
    expect(right.executeJavaScript).toHaveBeenCalledTimes(1)
    expect(left.executeJavaScript.mock.calls[0][0]).toContain('__genofficeScrollSync')

    // Re-syncing identical pair does not duplicate listeners or re-inject redundantly.
    controller.sync({
      enabled: true,
      left: { tabId: 'tab-l', kind: 'docs', webContents: left.wc },
      right: { tabId: 'tab-r', kind: 'markdown', webContents: right.wc },
    })
    expect(left.on).toHaveBeenCalledTimes(2)
    expect(left.executeJavaScript).toHaveBeenCalledTimes(1)

    // Left emits scroll via legacy tuple console-message -> right receives applyRatio.
    left.emit('console-message', {}, 0, `${SPLIT_SCROLL_MSG_PREFIX}0.450000`, 1, 'src')
    expect(right.executeJavaScript).toHaveBeenCalledTimes(2)
    expect(right.executeJavaScript.mock.calls[1][0]).toContain('applyRatio(0.45)')

    // Immediate mirror echo from right via object console-message is dropped.
    vi.spyOn(Date, 'now').mockReturnValue(1050)
    right.emit('console-message', { message: `${SPLIT_SCROLL_MSG_PREFIX}0.450000` })
    expect(left.executeJavaScript).toHaveBeenCalledTimes(1)

    // Non-scroll and malformed console messages are ignored.
    left.emit('console-message', { message: 'normal debug output' })
    left.emit('console-message', { message: `${SPLIT_SCROLL_MSG_PREFIX}invalid` })
    expect(right.executeJavaScript).toHaveBeenCalledTimes(2)

    // After cooldown expires, right drives left.
    vi.spyOn(Date, 'now').mockReturnValue(1200)
    right.emit('console-message', { message: `${SPLIT_SCROLL_MSG_PREFIX}0.600000` })
    expect(left.executeJavaScript).toHaveBeenCalledTimes(2)
    expect(left.executeJavaScript.mock.calls[1][0]).toContain('applyRatio(0.6)')

    // Reloading a bound pane re-injects active bridge script.
    left.emit('did-finish-load')
    expect(left.executeJavaScript).toHaveBeenCalledTimes(3)
    expect(left.executeJavaScript.mock.calls[2][0]).toContain('__genofficeScrollSync')

    controller.dispose()
  })

  it('uses resolveScrollWebContents for browser tabs and skips when unresolved or identical', () => {
    const chromeWc = createMockWebContents(10)
    const pageWc = createMockWebContents(11)
    const docWc = createMockWebContents(12)

    let resolveBrowserPage: WebContents | undefined = pageWc.wc
    const controller = new SplitScrollSyncController({
      resolveScrollWebContents: (_tabId, kind, defaultWc) =>
        kind === 'browser' ? resolveBrowserPage : defaultWc,
    })

    controller.sync({
      enabled: true,
      left: { tabId: 'tab-doc', kind: 'docs', webContents: docWc.wc },
      right: { tabId: 'tab-web', kind: 'browser', webContents: chromeWc.wc },
    })

    // Chrome WebContents is never bound; page WebContents is bound instead.
    expect(chromeWc.on).not.toHaveBeenCalled()
    expect(pageWc.on).toHaveBeenCalledTimes(2)
    expect(docWc.on).toHaveBeenCalledTimes(2)
    expect(controller.getState()).toMatchObject({
      enabled: true,
      leftWcId: 12,
      rightWcId: 11,
    })

    // When resolver returns undefined (e.g., browser page not mounted), old panes unbind and deactivate.
    resolveBrowserPage = undefined
    controller.sync({
      enabled: true,
      left: { tabId: 'tab-doc', kind: 'docs', webContents: docWc.wc },
      right: { tabId: 'tab-web', kind: 'browser', webContents: chromeWc.wc },
    })

    expect(docWc.removeListener).toHaveBeenCalledTimes(2)
    expect(pageWc.removeListener).toHaveBeenCalledTimes(2)
    expect(docWc.executeJavaScript.mock.calls.at(-1)?.[0]).toContain('setActive(false)')
    expect(pageWc.executeJavaScript.mock.calls.at(-1)?.[0]).toContain('setActive(false)')
    expect(controller.getState().enabled).toBe(false)

    // Same WebContents on both sides stays disabled.
    controller.sync({
      enabled: true,
      left: { tabId: 'tab-1', kind: 'docs', webContents: docWc.wc },
      right: { tabId: 'tab-2', kind: 'docs', webContents: docWc.wc },
    })
    expect(controller.getState().enabled).toBe(false)

    controller.dispose()
  })

  it('guards against destroyed WebContents and rejected executeJavaScript calls', async () => {
    const left = createMockWebContents(1, { rejectExecuteJs: true })
    const right = createMockWebContents(2)
    const destroyed = createMockWebContents(3, { destroyed: true })

    const controller = new SplitScrollSyncController()

    // Already-destroyed pane keeps sync disabled without touching destroyed methods.
    controller.sync({
      enabled: true,
      left: { tabId: 'l', kind: 'docs', webContents: left.wc },
      right: { tabId: 'r', kind: 'pdf', webContents: destroyed.wc },
    })
    expect(controller.getState().enabled).toBe(false)
    expect(destroyed.on).not.toHaveBeenCalled()
    expect(destroyed.executeJavaScript).not.toHaveBeenCalled()

    // Bind two live panes, then destroy target mid-session.
    controller.sync({
      enabled: true,
      left: { tabId: 'l', kind: 'docs', webContents: left.wc },
      right: { tabId: 'r', kind: 'pdf', webContents: right.wc },
    })
    expect(controller.getState().enabled).toBe(true)

    right.setDestroyed(true)
    expect(() => {
      left.emit('console-message', { message: `${SPLIT_SCROLL_MSG_PREFIX}0.800000` })
    }).not.toThrow()
    // Right only had the initial injection call before destruction.
    expect(right.executeJavaScript).toHaveBeenCalledTimes(1)

    // Dispose safely unbinds live views and skips destroyed ones.
    expect(() => controller.dispose()).not.toThrow()
    expect(left.removeListener).toHaveBeenCalledTimes(2)
    expect(right.removeListener).not.toHaveBeenCalled()

    // Let rejected promises settle to confirm no unhandled rejections escape.
    await Promise.resolve()
  })

  it('unbinds all listeners and disables coordinator on disable and dispose', () => {
    const left = createMockWebContents(1)
    const right = createMockWebContents(2)
    const controller = new SplitScrollSyncController()

    controller.sync({
      enabled: true,
      left: { tabId: 'l', kind: 'docs', webContents: left.wc },
      right: { tabId: 'r', kind: 'html', webContents: right.wc },
    })
    expect(left.listeners.get('console-message')?.size).toBe(1)
    expect(left.listeners.get('did-finish-load')?.size).toBe(1)

    controller.sync({ enabled: false })
    expect(left.listeners.get('console-message')?.size).toBe(0)
    expect(left.listeners.get('did-finish-load')?.size).toBe(0)
    expect(right.listeners.get('console-message')?.size).toBe(0)
    expect(right.listeners.get('did-finish-load')?.size).toBe(0)
    expect(controller.getState().enabled).toBe(false)

    // Re-enabling rebinds cleanly, then dispose cleans up permanently.
    controller.sync({
      enabled: true,
      left: { tabId: 'l', kind: 'docs', webContents: left.wc },
      right: { tabId: 'r', kind: 'html', webContents: right.wc },
    })
    expect(left.listeners.get('console-message')?.size).toBe(1)

    controller.dispose()
    expect(left.listeners.get('console-message')?.size).toBe(0)
    expect(left.listeners.get('did-finish-load')?.size).toBe(0)
    expect(right.listeners.get('console-message')?.size).toBe(0)
    expect(right.listeners.get('did-finish-load')?.size).toBe(0)
    expect(controller.getState().enabled).toBe(false)

    // Sync after dispose is ignored.
    controller.sync({
      enabled: true,
      left: { tabId: 'l', kind: 'docs', webContents: left.wc },
      right: { tabId: 'r', kind: 'html', webContents: right.wc },
    })
    expect(left.listeners.get('console-message')?.size).toBe(0)
  })
})

describe('buildScrollBridgeScript', () => {
  interface FakeElement {
    clientHeight: number
    scrollHeight: number
    scrollTop: number
    overflowY?: string
  }

  function createBridgeSandbox(options: {
    selectors?: Record<string, FakeElement[]>
    scrollingElement?: FakeElement | null
    fallbackNodes?: FakeElement[]
    iframes?: Array<{ contentWindow?: { postMessage: ReturnType<typeof vi.fn> } | null }>
  }) {
    let now = 5000
    const docListeners = new Map<string, ListenerFn[]>()
    const debugLogs: string[] = []
    let rafQueue: Array<() => void> = []

    const sandboxWindow: Record<string, unknown> = {
      getComputedStyle: (el: FakeElement) => ({ overflowY: el.overflowY ?? 'visible' }),
      requestAnimationFrame: (cb: () => void) => {
        rafQueue.push(cb)
        return rafQueue.length
      },
      cancelAnimationFrame: () => {
        rafQueue = []
      },
    }

    const sandboxDocument = {
      scrollingElement: options.scrollingElement ?? null,
      addEventListener: vi.fn((event: string, fn: ListenerFn) => {
        const list = docListeners.get(event) ?? []
        list.push(fn)
        docListeners.set(event, list)
      }),
      querySelectorAll: (selector: string) => {
        if (selector === 'div, section, main') return options.fallbackNodes ?? []
        if (selector === 'iframe') return options.iframes ?? []
        return options.selectors?.[selector] ?? []
      },
    }

    const context = {
      window: sandboxWindow,
      document: sandboxDocument,
      performance: { now: () => now },
      console: { debug: (msg: string) => debugLogs.push(msg) },
      Number,
      Boolean,
    }

    return {
      runScript: (enabled: boolean) => runInNewContext(buildScrollBridgeScript(enabled), context),
      advanceTime: (ms: number) => {
        now += ms
      },
      dispatchDocEvent: (event: string) => {
        for (const fn of docListeners.get(event) ?? []) {
          fn()
        }
      },
      flushRaf: () => {
        const current = rafQueue
        rafQueue = []
        for (const cb of current) cb()
      },
      docListeners,
      debugLogs,
      getBridge: () =>
        sandboxWindow.__genofficeScrollSync as {
          applyRatio: (ratio: number) => void
          setActive: (flag: boolean) => void
          findPrimaryScroller: () => FakeElement | null
        },
    }
  }

  it('registers once idempotently and tracks user-initiated scroll ratios', () => {
    const editorScroller = { clientHeight: 500, scrollHeight: 1500, scrollTop: 250 }
    const sandbox = createBridgeSandbox({
      selectors: { '.editor-scroll': [editorScroller] },
    })

    sandbox.runScript(true)
    const gestureCountAfterFirst = sandbox.docListeners.get('scroll')?.length ?? 0
    expect(gestureCountAfterFirst).toBe(1)

    // Scroll without prior user gesture is ignored.
    sandbox.dispatchDocEvent('scroll')
    sandbox.flushRaf()
    expect(sandbox.debugLogs).toEqual([])

    // User wheel gesture enables scroll emission via rAF.
    sandbox.dispatchDocEvent('wheel')
    sandbox.dispatchDocEvent('scroll')
    sandbox.flushRaf()
    expect(sandbox.debugLogs).toEqual([`${SPLIT_SCROLL_MSG_PREFIX}0.250000`])

    // Second injection with false flips active off without adding duplicate listeners.
    sandbox.runScript(false)
    expect(sandbox.docListeners.get('scroll')?.length).toBe(1)
    editorScroller.scrollTop = 500
    sandbox.dispatchDocEvent('wheel')
    sandbox.dispatchDocEvent('scroll')
    sandbox.flushRaf()
    expect(sandbox.debugLogs).toHaveLength(1)
  })

  it('suppresses echo on applyRatio and forwards postMessage to iframes safely', () => {
    const scroller = { clientHeight: 400, scrollHeight: 1400, scrollTop: 0 }
    const goodPostMessage = vi.fn()
    const badPostMessage = vi.fn(() => {
      throw new Error('blocked frame')
    })

    const sandbox = createBridgeSandbox({
      selectors: { '.cm-scroller': [scroller] },
      iframes: [
        { contentWindow: { postMessage: goodPostMessage } },
        { contentWindow: { postMessage: badPostMessage } },
      ],
    })

    sandbox.runScript(true)
    const bridge = sandbox.getBridge()

    // User recently gestured, then remote applyRatio arrives -> 150ms suppressUntil blocks echo.
    sandbox.dispatchDocEvent('pointerdown')
    bridge.applyRatio(0.6)
    expect(scroller.scrollTop).toBe(600)
    expect(goodPostMessage).toHaveBeenCalledWith({ type: 'gx:scrollTo', ratio: 0.6 }, '*')
    expect(badPostMessage).toHaveBeenCalledTimes(1)

    sandbox.dispatchDocEvent('scroll')
    sandbox.flushRaf()
    expect(sandbox.debugLogs).toEqual([])

    // After 150ms suppression window expires, a fresh user gesture emits again.
    sandbox.advanceTime(160)
    scroller.scrollTop = 750
    sandbox.dispatchDocEvent('keydown')
    sandbox.dispatchDocEvent('scroll')
    sandbox.flushRaf()
    expect(sandbox.debugLogs).toEqual([`${SPLIT_SCROLL_MSG_PREFIX}0.750000`])
  })

  it('falls back to visible scrollable containers and returns null on fixed canvases', () => {
    const hiddenOverflowDiv = {
      clientHeight: 600,
      scrollHeight: 1800,
      scrollTop: 0,
      overflowY: 'hidden',
    }
    const scrollableDiv = {
      clientHeight: 500,
      scrollHeight: 1500,
      scrollTop: 0,
      overflowY: 'auto',
    }
    const fallbackSandbox = createBridgeSandbox({
      fallbackNodes: [hiddenOverflowDiv, scrollableDiv],
    })
    fallbackSandbox.runScript(true)
    expect(fallbackSandbox.getBridge().findPrimaryScroller()).toBe(scrollableDiv)

    const fixedCanvasSandbox = createBridgeSandbox({
      fallbackNodes: [hiddenOverflowDiv],
    })
    fixedCanvasSandbox.runScript(true)
    expect(fixedCanvasSandbox.getBridge().findPrimaryScroller()).toBeNull()
    expect(() => fixedCanvasSandbox.getBridge().applyRatio(0.5)).not.toThrow()
  })
})
