// @vitest-environment jsdom
/**
 * The hosted AI slot (src/renderer/hosted-ai-slot.ts): the app's own panel
 * slot re-purposed for the global drawer while the shell hosts this app. The
 * hook pulls the drawer state (get + push), and reports the slot element's
 * live rect to the shell main on mount, on resize, and whenever main asks
 * (activation / scale change) — the drawer docks exactly there.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useHostedAiSlot } from '../src/renderer/hosted-ai-slot'
import type { HostedAiDockState, AiSlotRect } from '../src/shared/ipc'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let dockState: HostedAiDockState | null = null
let dockListener: ((state: HostedAiDockState) => void) | null = null
const reportAiSlotRect = vi.fn()
let requestListener: (() => void) | null = null
/** the rects getBoundingClientRect answers with (view-local px) */
let measured: AiSlotRect = { x: 500, y: 0, width: 320, height: 600 }

beforeEach(() => {
  dockState = null
  dockListener = null
  requestListener = null
  reportAiSlotRect.mockClear()
  measured = { x: 500, y: 0, width: 320, height: 600 }
  Element.prototype.getBoundingClientRect = () =>
    ({ ...measured, toJSON: () => measured }) as DOMRect
  ;(window as unknown as { desktop: unknown }).desktop = {
    getAiDockState: vi.fn(async () => dockState),
    onAiDockChanged: (handler: (state: HostedAiDockState) => void) => {
      dockListener = handler
      return () => {
        dockListener = null
      }
    },
    reportAiSlotRect,
    onAiSlotRectRequest: (handler: () => void) => {
      requestListener = handler
      return () => {
        requestListener = null
      }
    },
  }
})

afterEach(() => {
  delete (window as unknown as { desktop?: unknown }).desktop
  document.documentElement.style.removeProperty('--ui-scale')
})

let host: HTMLDivElement
let root: Root
/** the latest hook capture (reassigned on each Harness render) */
let captured: {
  dock: HostedAiDockState | null
  width: number
  slotRef: (n: HTMLDivElement | null) => void
}

const mount = (enabled: boolean): void => {
  function Harness(): React.JSX.Element {
    captured = useHostedAiSlot(enabled)
    // App.tsx's wiring: the slot element reserves the returned width while
    // the drawer is open, nothing while it is closed
    const open = captured.dock !== null && !captured.dock.collapsed
    return createElement(
      'div',
      null,
      createElement(
        'div',
        { ref: captured.slotRef, 'data-slot': '', style: { width: open ? captured.width : 0 } },
        'slot',
      ),
    )
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(createElement(Harness)))
}

/** the slot element the harness rendered */
const slotEl = (): HTMLElement => host.querySelector<HTMLElement>('[data-slot]')!

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve()
  })
}

describe('useHostedAiSlot', () => {
  it('pulls the drawer state once and follows its changes', async () => {
    dockState = { width: 400, collapsed: false }
    mount(true)
    await settle()
    expect(captured.dock).toEqual({ width: 400, collapsed: false })
    act(() => dockListener?.({ width: 400, collapsed: true }))
    await settle()
    expect(captured.dock).toEqual({ width: 400, collapsed: true })
    act(() => dockListener?.({ width: 480, collapsed: false }))
    expect(captured.dock).toEqual({ width: 480, collapsed: false })
  })

  it('standalone (no shell answer) reads as null and the bridge stays quiet', async () => {
    dockState = null
    mount(true)
    await settle()
    expect(captured.dock).toBeNull()
    expect(reportAiSlotRect).not.toHaveBeenCalled()
  })

  it('disabled (not hosted) touches no bridge at all', async () => {
    mount(false)
    await settle()
    expect(reportAiSlotRect).not.toHaveBeenCalled()
    expect(dockListener).toBeNull()
    expect(requestListener).toBeNull()
  })

  it('reports the slot rect on mount and on every re-measure request', async () => {
    dockState = { width: 400, collapsed: false }
    mount(true)
    await settle()
    // the mount report (the ref callback) and the effect's own report both
    // carry the same live measurement
    expect(reportAiSlotRect).toHaveBeenCalled()
    const first = reportAiSlotRect.mock.calls[0]![0] as AiSlotRect
    expect(first).toEqual({ x: 500, y: 0, width: 320, height: 600 })
    // main asks (the tab activated, the scale changed): a fresh report lands
    measured = { x: 460, y: 20, width: 340, height: 560 }
    act(() => requestListener?.())
    expect(reportAiSlotRect.mock.calls.at(-1)![0]).toEqual({
      x: 460,
      y: 20,
      width: 340,
      height: 560,
    })
  })

  it('a resize of the window re-reports the slot', async () => {
    dockState = { width: 400, collapsed: false }
    mount(true)
    await settle()
    const before = reportAiSlotRect.mock.calls.length
    measured = { x: 420, y: 0, width: 380, height: 540 }
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(reportAiSlotRect.mock.calls.length).toBeGreaterThan(before)
    expect(reportAiSlotRect.mock.calls.at(-1)![0]).toEqual({
      x: 420,
      y: 0,
      width: 380,
      height: 540,
    })
  })

  it('reserves the drawer width × the interface scale (the overlay paints zoomed)', async () => {
    // the overlay renders the drawer inside `zoom: var(--ui-scale)`, so one
    // CSS px of drawer is scale window px on screen while this app's own
    // layout is unzoomed — a raw width would under-reserve and the panel
    // would cover the document's edge by (scale − 1) × width
    document.documentElement.style.setProperty('--ui-scale', '1.25')
    dockState = { width: 400, collapsed: false }
    mount(true)
    await settle()
    expect(captured.width).toBe(500)
    expect(slotEl().style.width).toBe('500px')
  })

  it('a re-measure request under a new scale re-renders the width before reporting', async () => {
    document.documentElement.style.setProperty('--ui-scale', '1.25')
    dockState = { width: 400, collapsed: false }
    mount(true)
    await settle()
    expect(slotEl().style.width).toBe('500px')
    // the View menu dropped the scale and main asked for a fresh report: the
    // request's own measurement is skipped (the width style must commit
    // first), and the report effect re-fires after the re-render
    document.documentElement.style.setProperty('--ui-scale', '1')
    measured = { x: 460, y: 0, width: 400, height: 600 }
    const before = reportAiSlotRect.mock.calls.length
    act(() => requestListener?.())
    expect(reportAiSlotRect.mock.calls.length).toBe(before + 1)
    expect(reportAiSlotRect.mock.calls.at(-1)![0]).toEqual(measured)
    expect(slotEl().style.width).toBe('400px')
  })

  it('a scale write landing after mount re-renders the reservation and re-reports it', async () => {
    // main writes the inline --ui-scale on did-finish-load, which can
    // postdate this tree's first render — no signal orders the write, so the
    // root's style attribute change is what the renderer observes
    dockState = { width: 400, collapsed: false }
    mount(true)
    await settle()
    expect(slotEl().style.width).toBe('400px')
    measured = { x: 300, y: 0, width: 600, height: 600 }
    document.documentElement.style.setProperty('--ui-scale', '1.5')
    await settle()
    expect(captured.width).toBe(600)
    expect(slotEl().style.width).toBe('600px')
    expect(reportAiSlotRect.mock.calls.at(-1)![0]).toEqual(measured)
  })
})
