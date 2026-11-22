import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  shell: { openExternal: vi.fn() },
  WebContentsView: class {},
}))

import {
  TOP_BAR_OVERLAY_STRIP,
  desktopHeaderHeight,
  isPointInTopBarBand,
  topBarOverlayBounds,
} from '../src/shared/desktop-geometry'
import { tabStripOverlay } from '../src/main/title-bar-overlay'
import { createTopBarAutoHideController } from '../src/main/top-bar-overlay-view'
import type { WindowChromeState } from '../src/shared/home-api'

describe('top-bar geometry & title bar overlay', () => {
  it('computes strip and expanded bar overlay bounds across UI scales', () => {
    expect(TOP_BAR_OVERLAY_STRIP).toBe(4)
    expect(topBarOverlayBounds({ width: 1200, height: 800 }, 1)).toEqual({
      strip: { x: 0, y: 0, width: 1200, height: 4 },
      bar: { x: 0, y: 0, width: 1200, height: 44 },
    })
    expect(topBarOverlayBounds({ width: 1200, height: 800 }, 1.25)).toEqual({
      strip: { x: 0, y: 0, width: 1200, height: Math.round(TOP_BAR_OVERLAY_STRIP * 1.25) },
      bar: { x: 0, y: 0, width: 1200, height: desktopHeaderHeight(1.25) },
    })
  })

  it('checks whether a screen point falls inside the top bar hover band', () => {
    const content = { x: 100, y: 50, width: 1200, height: 800 }
    // Inside header band
    expect(isPointInTopBarBand({ x: 250, y: 60 }, content, 44, 8)).toBe(true)
    // Inside caption buttons side & vertical slack
    expect(isPointInTopBarBand({ x: 1280, y: 98 }, content, 44, 8)).toBe(true)
    // Below header band + slack (50 + 44 + 8 = 102)
    expect(isPointInTopBarBand({ x: 250, y: 110 }, content, 44, 8)).toBe(false)
    // Outside horizontal bounds
    expect(isPointInTopBarBand({ x: 90, y: 60 }, content, 44, 8)).toBe(false)
  })

  it('collapses title bar overlay to 1px transparent strip when hidden is true', () => {
    expect(tabStripOverlay(false, 1, true)).toEqual({
      color: '#00000000',
      symbolColor: '#00000000',
      height: 1,
    })
    expect(tabStripOverlay(true, 1.5, true)).toEqual({
      color: '#00000000',
      symbolColor: '#00000000',
      height: 1,
    })
  })
})

describe('createTopBarAutoHideController', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('activates only when maximized or fullScreen with autoHideEnabled', () => {
    const events: WindowChromeState[] = []
    const ctrl = createTopBarAutoHideController({
      initialMaximized: false,
      initialFullScreen: false,
      initialAutoHideEnabled: true,
      onStateChange: (state) => events.push(state),
    })

    expect(ctrl.getState()).toEqual({
      maximized: false,
      fullScreen: false,
      autoHideEnabled: true,
      autoHideActive: false,
      revealed: false,
    })

    // Ignored when window is normal size
    ctrl.reportHotEdge({ enter: true })
    expect(ctrl.getState().revealed).toBe(false)
    expect(events).toEqual([])

    ctrl.setMaximized(true)
    expect(ctrl.getState()).toMatchObject({
      maximized: true,
      autoHideActive: true,
      revealed: false,
    })

    ctrl.reportHotEdge({ enter: true })
    expect(ctrl.getState().revealed).toBe(true)

    ctrl.setMaximized(false)
    expect(ctrl.getState()).toMatchObject({
      maximized: false,
      autoHideActive: false,
      revealed: false,
    })

    // FullScreen activates independently of maximized
    ctrl.setFullScreen(true)
    expect(ctrl.getState().autoHideActive).toBe(true)
    ctrl.reportHotEdge({ enter: true })
    expect(ctrl.getState().revealed).toBe(true)

    ctrl.destroy()
  })

  it('delays collapse by 300ms on leave and keeps open while cursor stays over caption band', () => {
    vi.useFakeTimers()
    let cursor = { x: 600, y: 20 }
    const ctrl = createTopBarAutoHideController({
      initialMaximized: true,
      initialAutoHideEnabled: true,
      getWindowBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
      getCursorScreenPoint: () => cursor,
      getHeaderHeight: () => 44,
      hideGraceMs: 300,
      recheckIntervalMs: 180,
      onStateChange: () => undefined,
    })

    ctrl.reportHotEdge({ enter: true })
    expect(ctrl.getState().revealed).toBe(true)

    // Pointer leaves DOM strip toward OS caption buttons at (1180, 20)
    cursor = { x: 1180, y: 20 }
    ctrl.reportHotEdge({ leave: true })
    vi.advanceTimersByTime(310)
    // Still hovering inside header band -> remains revealed
    expect(ctrl.getState().revealed).toBe(true)

    // Pointer moves down into workspace content at y=200
    cursor = { x: 600, y: 200 }
    vi.advanceTimersByTime(200)
    expect(ctrl.getState().revealed).toBe(false)

    ctrl.destroy()
  })

  it('keeps bar pinned while menus are open and collapses on blur or minimize', () => {
    vi.useFakeTimers()
    const ctrl = createTopBarAutoHideController({
      initialMaximized: true,
      initialAutoHideEnabled: true,
      getWindowBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
      getCursorScreenPoint: () => ({ x: 500, y: 500 }),
      hideGraceMs: 300,
      onStateChange: () => undefined,
    })

    ctrl.reportHotEdge({ pin: true })
    expect(ctrl.getState().revealed).toBe(true)

    // Leave while pinned does not hide even after grace period
    ctrl.reportHotEdge({ leave: true })
    vi.advanceTimersByTime(500)
    expect(ctrl.getState().revealed).toBe(true)

    // Unpin triggers grace collapse when cursor is outside band
    ctrl.reportHotEdge({ pin: false })
    expect(ctrl.getState().revealed).toBe(true)
    vi.advanceTimersByTime(310)
    expect(ctrl.getState().revealed).toBe(false)

    // Pinned bar survives blur while native app menu holds OS focus
    ctrl.reportHotEdge({ pin: true })
    expect(ctrl.getState().revealed).toBe(true)
    ctrl.onBlurOrMinimize()
    expect(ctrl.getState().revealed).toBe(true)

    // Unpinned revealed bar collapses immediately on blur or minimize
    ctrl.reportHotEdge({ pin: false })
    ctrl.reportHotEdge({ enter: true })
    expect(ctrl.getState().revealed).toBe(true)
    ctrl.onBlurOrMinimize()
    expect(ctrl.getState().revealed).toBe(false)

    // Disabling autoHide clears active state immediately
    ctrl.setAutoHideEnabled(false)
    expect(ctrl.getState().autoHideActive).toBe(false)

    ctrl.destroy()
  })

  it('ignores (0, 0) fallback cursor origin returned when desktop input is unavailable', () => {
    vi.useFakeTimers()
    const ctrl = createTopBarAutoHideController({
      initialMaximized: true,
      initialAutoHideEnabled: true,
      getWindowBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      hideGraceMs: 300,
      onStateChange: () => undefined,
    })

    ctrl.reportHotEdge({ enter: true })
    expect(ctrl.getState().revealed).toBe(true)
    ctrl.reportHotEdge({ leave: true })
    vi.advanceTimersByTime(310)
    expect(ctrl.getState().revealed).toBe(false)

    ctrl.destroy()
  })
})
