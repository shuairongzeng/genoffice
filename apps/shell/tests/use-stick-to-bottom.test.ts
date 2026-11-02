// @vitest-environment jsdom
/**
 * The chat-standard stick-to-bottom state machine
 * (src/renderer/src/use-stick-to-bottom.ts): the view follows its content's
 * growth while the reader sits at the bottom; only a DELIBERATE upward
 * scroll unfollows (growth pushing the view up is not the reader leaving —
 * the bug the previous position-only guard had); scrolling back within the
 * tight band refollows; content arriving while unfollowed flags "new"; the
 * explicit jump resumes following. The scroller is faked with controllable
 * scrollTop/scrollHeight/clientHeight (own properties on the real element),
 * the ResizeObserver with a captured callback, and rAF with a manual queue.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStickToBottom } from '../src/renderer/src/use-stick-to-bottom'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** the fake scroller's live geometry (controllable per test) */
const geo = {
  scrollTop: 0,
  scrollHeight: 1000,
  clientHeight: 400,
}
const scrollTo = vi.fn((to: { top: number }) => {
  geo.scrollTop = Math.max(0, Math.min(to.top, geo.scrollHeight - geo.clientHeight))
  // the browser fires a scroll event on a programmatic scrollTo too — the
  // state machine's delta math depends on seeing it
  scrollerEl()?.dispatchEvent(new Event('scroll'))
})

/** the mounted fake scroller element (geometry lives on it) */
const scrollerEl = (): HTMLElement | null => host.querySelector<HTMLElement>('[data-scroller]')

let roCallback: (() => void) | null = null
const roObserve = vi.fn()
const roDisconnect = vi.fn()
/** simulate the content's growth (ResizeObserver fire) */
const grow = (by: number): void => {
  geo.scrollHeight += by
  act(() => roCallback?.())
}

let rafQueue: Array<() => void> = []
/** run the scheduled follow scrolls */
const flushRaf = (): void => {
  const pending = rafQueue
  rafQueue = []
  for (const cb of pending) cb()
}

let host: HTMLDivElement
let root: Root
let hook: ReturnType<typeof useStickToBottom>

function Harness(): React.JSX.Element {
  hook = useStickToBottom()
  return createElement(
    'div',
    null,
    createElement(
      'div',
      { ref: hook.scrollerRef, 'data-scroller': '' },
      createElement('div', {
        ref: hook.contentRef,
        'data-content': '',
      }),
    ),
  )
}

/** the reader's scroll: set scrollTop and fire the native event */
const userScroll = (top: number): void => {
  geo.scrollTop = Math.max(0, Math.min(top, geo.scrollHeight))
  act(() => {
    host.querySelector('[data-scroller]')!.dispatchEvent(new Event('scroll'))
  })
}

/** the bottom the current geometry admits */
const bottom = (): number => geo.scrollHeight - geo.clientHeight

beforeEach(() => {
  geo.scrollTop = 0
  geo.scrollHeight = 1000
  geo.clientHeight = 400
  scrollTo.mockClear()
  rafQueue = []
  roCallback = null
  roObserve.mockClear()
  roDisconnect.mockClear()
  ;(window as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = (
    cb: () => void,
  ) => {
    rafQueue.push(cb)
    return rafQueue.length
  }
  ;(window as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame = () => {}
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(callback: () => void) {
      roCallback = callback
    }
    observe = roObserve
    disconnect = roDisconnect
    unobserve = () => {}
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(createElement(Harness)))
  // the fake scroller's geometry and scroll verb live on the real element
  const el = host.querySelector<HTMLElement>('[data-scroller]')!
  Object.defineProperty(el, 'scrollTop', { get: () => geo.scrollTop, set: () => {} })
  Object.defineProperty(el, 'scrollHeight', { get: () => geo.scrollHeight })
  Object.defineProperty(el, 'clientHeight', { get: () => geo.clientHeight })
  el.scrollTo = scrollTo as never
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const settle = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('useStickToBottom', () => {
  it("follows by default: the observer's initial fire lands at the bottom, growth follows", async () => {
    await settle()
    // ResizeObserver's observe contract: one initial fire — the opened panel
    // starts at the latest message
    act(() => roCallback?.())
    flushRaf()
    expect(scrollTo).toHaveBeenCalledWith({ top: geo.scrollHeight })
    expect(hook.following).toBe(true)
    // content grows (a streaming burst): one coalesced scroll per frame,
    // reading the FRESH height at flush time
    scrollTo.mockClear()
    grow(200)
    grow(50)
    expect(scrollTo).not.toHaveBeenCalled() // coalesced
    flushRaf()
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenCalledWith({ top: geo.scrollHeight })
    expect(hook.following).toBe(true)
    expect(hook.hasNew).toBe(false)
  })

  it('a deliberate upward scroll unfollows; growth then keeps the view put and flags new', async () => {
    await settle()
    act(() => roCallback?.())
    flushRaf()
    // the reader scrolls up 300px (well past the unfollow band)
    userScroll(bottom() - 300)
    expect(hook.following).toBe(false)
    // the transcript keeps growing: the view stays put, "new" is flagged
    scrollTo.mockClear()
    grow(400)
    flushRaf()
    expect(scrollTo).not.toHaveBeenCalled()
    expect(hook.following).toBe(false)
    expect(hook.hasNew).toBe(true)
  })

  it("growth-induced distance (no scroll event) never unfollows — the old guard's bug", async () => {
    await settle()
    act(() => roCallback?.())
    flushRaf()
    // the browser keeps scrollTop while content grows: no scroll event, the
    // distance balloons — the follow must hold, and the next growth scrolls
    geo.scrollHeight += 600
    expect(hook.following).toBe(true)
    scrollTo.mockClear()
    grow(10)
    flushRaf()
    expect(scrollTo).toHaveBeenCalledWith({ top: geo.scrollHeight })
  })

  it('scrolling back within the tight band refollows and clears the new flag', async () => {
    await settle()
    act(() => roCallback?.())
    flushRaf()
    userScroll(bottom() - 300)
    expect(hook.following).toBe(false)
    grow(100)
    expect(hook.hasNew).toBe(true)
    // back to the bottom: the band refollows
    userScroll(bottom())
    expect(hook.following).toBe(true)
    expect(hook.hasNew).toBe(false)
  })

  it('hysteresis: a 20px upward nudge stays followed, a 30px one unfollows', async () => {
    await settle()
    act(() => roCallback?.())
    flushRaf()
    // below the unfollow band (24px): still following
    userScroll(bottom() - 20)
    expect(hook.following).toBe(true)
    // past the band: unfollowed
    userScroll(bottom() - 30)
    expect(hook.following).toBe(false)
  })

  it("scrollToLatest jumps, resumes following, and the jump's own event stays followed", async () => {
    await settle()
    act(() => roCallback?.())
    flushRaf()
    userScroll(bottom() - 400)
    expect(hook.following).toBe(false)
    grow(150)
    act(() => hook.scrollToLatest())
    expect(hook.following).toBe(true)
    expect(hook.hasNew).toBe(false)
    expect(scrollTo).toHaveBeenCalledWith({ top: geo.scrollHeight })
    // the jump's own scroll event lands at the bottom: still following
    userScroll(bottom())
    expect(hook.following).toBe(true)
  })

  it('the content element is observed (the growth source), and detaches on clear', async () => {
    await settle()
    expect(roObserve).toHaveBeenCalled()
    expect(roDisconnect).not.toHaveBeenCalled()
    // the content node clearing (an unmount) detaches the observer
    act(() => {
      hook.contentRef(null)
    })
    await settle()
    expect(roDisconnect).toHaveBeenCalled()
  })

  it('a downward scroll that stops short of the band changes nothing', async () => {
    await settle()
    act(() => roCallback?.())
    flushRaf()
    userScroll(bottom() - 400)
    expect(hook.following).toBe(false)
    // the reader scrolls down 300px but stops 100px short of the bottom
    userScroll(bottom() - 100)
    expect(hook.following).toBe(false)
    expect(hook.hasNew).toBe(false)
  })

  it('notifyGrowth (the React-shaped twin) scrolls synchronously after the commit', async () => {
    await settle()
    act(() => roCallback?.())
    flushRaf()
    scrollTo.mockClear()
    // the transcript model grew: the DOM commit already landed, the follow
    // scroll is immediate — no frame to pump
    geo.scrollHeight += 120
    act(() => hook.notifyGrowth())
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenCalledWith({ top: geo.scrollHeight })
    // unfollowed, the same signal flags new content instead
    userScroll(bottom() - 300)
    scrollTo.mockClear()
    geo.scrollHeight += 50
    act(() => hook.notifyGrowth())
    expect(scrollTo).not.toHaveBeenCalled()
    expect(hook.hasNew).toBe(true)
  })

  it('the follow scroll reads the fresh height at flush, not the scheduled one', async () => {
    await settle()
    act(() => roCallback?.())
    flushRaf()
    scrollTo.mockClear()
    // growth schedules a scroll; MORE growth lands before the frame flushes
    grow(100)
    geo.scrollHeight += 250
    flushRaf()
    // the single frame's scroll went to the height as it stood at flush
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenCalledWith({ top: geo.scrollHeight })
  })
})
