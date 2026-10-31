import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PAINTED_FRAME_FALLBACK_MS,
  PHASE1_BLOCKS,
  PHASE_CHUNK_BLOCKS,
  cancelPhasedContent,
  isPhasedContentPending,
  setContentPhased,
  type PhasedContentHost,
} from '../src/renderer/phased-content'
import type { PmNode } from '../src/renderer/editor/convert'

const blocks = (n: number): PmNode[] =>
  Array.from({ length: n }, (_, i) => ({ type: 'paragraph', attrs: { docxIndex: i } }) as PmNode)

function host(): PhasedContentHost & { mounted: number } {
  const h = {
    mounted: 0,
    setContent(doc: PmNode) {
      h.mounted = doc.content?.length ?? 0
    },
    appendNodes(nodes: PmNode[]) {
      h.mounted += nodes.length
    },
    isDestroyed: () => false,
    resetHistory() {},
    setLoading() {},
    getDirty: () => false,
    setDirty() {},
  }
  return h
}

describe('phased open in a background view', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    cancelPhasedContent()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('keeps streaming on the timer fallback when frames never come', () => {
    // a hidden shell view is handed a frame a second at best; here none at all
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    const h = host()
    const total = PHASE1_BLOCKS + PHASE_CHUNK_BLOCKS * 3
    setContentPhased(h, { type: 'doc', content: blocks(total) } as PmNode)
    expect(h.mounted).toBe(PHASE1_BLOCKS)
    expect(isPhasedContentPending()).toBe(true)
    vi.advanceTimersByTime(PAINTED_FRAME_FALLBACK_MS)
    expect(h.mounted).toBe(PHASE1_BLOCKS + PHASE_CHUNK_BLOCKS)
    vi.advanceTimersByTime(PAINTED_FRAME_FALLBACK_MS * 2)
    expect(h.mounted).toBe(total)
    expect(isPhasedContentPending()).toBe(false)
  })

  it('appends a chunk once when the frame wins the race', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
    vi.stubGlobal('cancelAnimationFrame', () => {})
    const h = host()
    const total = PHASE1_BLOCKS + PHASE_CHUNK_BLOCKS * 2
    setContentPhased(h, { type: 'doc', content: blocks(total) } as PmNode)
    // two frames: the paint frame, then the append
    frames.shift()!(0)
    frames.shift()!(0)
    expect(h.mounted).toBe(PHASE1_BLOCKS + PHASE_CHUNK_BLOCKS)
    // the first chunk's losing timer must not append it again; the timer of
    // the next race lands the last chunk exactly once
    vi.advanceTimersByTime(PAINTED_FRAME_FALLBACK_MS * 3)
    expect(h.mounted).toBe(total)
    expect(isPhasedContentPending()).toBe(false)
  })

  it('streams the whole tail on the message-port lane while the tab is hidden', async () => {
    // issue #27 item 1 removed backgroundThrottling:false from the docs tab
    // view, so a hidden tab's rAF suspends entirely and its timers are
    // clamped — the 80ms fallback would crawl at one chunk a second (then
    // one a minute) while the open gates saves and print. The hidden lane
    // is a MessagePort: delivery is a plain task, not a timer task, so
    // Chromium's throttling cannot touch it. Real timers here — the whole
    // point is that the clock never advances.
    vi.useRealTimers()
    const rafSpy = vi.fn(() => 1)
    vi.stubGlobal('requestAnimationFrame', rafSpy)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    const timerSpy = vi.spyOn(window, 'setTimeout')
    let hidden = true
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
    try {
      const h = host()
      const total = PHASE1_BLOCKS + PHASE_CHUNK_BLOCKS * 3
      setContentPhased(h, { type: 'doc', content: blocks(total) } as PmNode)
      expect(h.mounted).toBe(PHASE1_BLOCKS)
      // the hidden lane takes over immediately: no frame request, no timer
      expect(rafSpy).not.toHaveBeenCalled()

      // macrotask turns deliver the port messages; the tail lands with the
      // clock at zero (a fresh MessageChannel per chunk is gc-able, so the
      // loop is bounded by the chunk count, not by the doc size)
      for (let turn = 0; turn < total && h.mounted < total; turn++) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      expect(h.mounted).toBe(total)
      expect(isPhasedContentPending()).toBe(false)
      expect(rafSpy).not.toHaveBeenCalled()
      // the clamped fallback timer never armed — the one regression this
      // test exists to catch
      expect(timerSpy).not.toHaveBeenCalledWith(expect.any(Function), PAINTED_FRAME_FALLBACK_MS)
    } finally {
      timerSpy.mockRestore()
      hidden = false
      Reflect.deleteProperty(document, 'hidden')
    }
  })

  it('returns to the frame lane once the tab is visible again', async () => {
    vi.useRealTimers()
    const frames: FrameRequestCallback[] = []
    const rafSpy = vi.fn((cb: FrameRequestCallback) => {
      frames.push(cb)
      return 1
    })
    vi.stubGlobal('requestAnimationFrame', rafSpy)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    let hidden = true
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
    try {
      const h = host()
      const total = PHASE1_BLOCKS + PHASE_CHUNK_BLOCKS * 3
      setContentPhased(h, { type: 'doc', content: blocks(total) } as PmNode)
      // the first chunk rides the port lane: no frame request yet
      expect(rafSpy).not.toHaveBeenCalled()
      // the tab becomes visible before that chunk lands: the queued port
      // task still delivers it, and every chunk after schedules on the
      // frame lane — the two lanes hand over on their own
      hidden = false
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(h.mounted).toBeGreaterThan(PHASE1_BLOCKS)
      // drive the double-rAF chain (two frames per chunk) to the end
      for (let guard = 0; guard < 20 && h.mounted < total; guard++) {
        for (const cb of frames.splice(0)) cb(0)
      }
      expect(h.mounted).toBe(total)
      expect(isPhasedContentPending()).toBe(false)
      expect(rafSpy).toHaveBeenCalled()
    } finally {
      hidden = false
      Reflect.deleteProperty(document, 'hidden')
    }
  })
})
