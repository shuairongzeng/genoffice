import { describe, expect, it } from 'vitest'

import {
  AI_DOCK_WIDTH_DEFAULT,
  AI_DOCK_WIDTH_MAX,
  AI_DOCK_WIDTH_MIN,
  DESKTOP_HEADER_HEIGHT,
  aiDockWidth,
  desktopHeaderHeight,
  documentContentBounds,
  drawerOverlayBounds,
  normalizeAiDock,
} from '../src/shared/desktop-geometry'

/**
 * Pure geometry of the desktop-host shell (src/shared/desktop-geometry.ts):
 * the fallback an embedded document view gets before the renderer reports its
 * measured stage rect — below the desktop header (44px embedded strip,
 * interface-scaled) and left of the AI drawer's footprint (the `aiDock` pref).
 * The drawer overlays rather than docks, so the pet reserves nothing (zero
 * while closed) and only the boot-time fallback subtracts an open drawer.
 * While a document is active the drawer's host is the W2 native overlay view,
 * whose bounds drawerOverlayBounds shapes: the window's right edge, the
 * drawer's scaled width, the full height. The constants mirror the
 * renderer's own values (home.css / AiDock.tsx) and must move with them.
 */

describe('desktopHeaderHeight', () => {
  it('is the embedded strip height, growing with the interface scale', () => {
    expect(DESKTOP_HEADER_HEIGHT).toBe(44)
    expect(desktopHeaderHeight()).toBe(44)
    expect(desktopHeaderHeight(1)).toBe(44)
    expect(desktopHeaderHeight(1.5)).toBe(66)
  })
})

describe('documentContentBounds', () => {
  it('embeds the document below the header, left of the open drawer footprint', () => {
    expect(
      documentContentBounds({ width: 800, height: 600 }, { dock: normalizeAiDock(undefined) }),
    ).toEqual({ x: 0, y: 44, width: 800 - 400, height: 600 - 44 })
  })

  it('reserves nothing while the drawer is closed (the pet floats, it takes no width)', () => {
    expect(
      documentContentBounds(
        { width: 800, height: 600 },
        { dock: { width: 400, collapsed: true, petPos: null } },
      ),
    ).toEqual({ x: 0, y: 44, width: 800, height: 600 - 44 })
  })

  it('scales both the header footprint and the stored CSS width with the interface scale', () => {
    // a 360 CSS px drawer at 150% occupies 540 window px, under a 66px header
    expect(
      documentContentBounds(
        { width: 800, height: 600 },
        { scale: 1.5, dock: { width: 360, collapsed: false, petPos: null } },
      ),
    ).toEqual({ x: 0, y: 66, width: 800 - 540, height: 600 - 66 })
  })

  it('clamps an oversized drawer to the same max the renderer commits', () => {
    expect(
      documentContentBounds(
        { width: 800, height: 600 },
        { dock: { width: 2000, collapsed: false, petPos: null } },
      ),
    ).toEqual({ x: 0, y: 44, width: 800 - AI_DOCK_WIDTH_MAX, height: 600 - 44 })
  })

  it('floors a too-narrow drawer at the renderer minimum', () => {
    expect(
      documentContentBounds(
        { width: 800, height: 600 },
        { dock: { width: 120, collapsed: false, petPos: null } },
      ),
    ).toEqual({ x: 0, y: 44, width: 800 - AI_DOCK_WIDTH_MIN, height: 600 - 44 })
  })

  it('never returns negative sizes on a degenerate window', () => {
    expect(
      documentContentBounds(
        { width: 100, height: 30 },
        { dock: { width: 400, collapsed: false, petPos: null } },
      ),
    ).toEqual({ x: 0, y: 44, width: 0, height: 0 })
  })
})

describe('aiDockWidth', () => {
  it('is zero while the drawer is closed, whatever the stored width', () => {
    expect(aiDockWidth({ width: 480, collapsed: true, petPos: null })).toBe(0)
    expect(aiDockWidth({ width: 480, collapsed: true, petPos: null }, 1.5)).toBe(0)
  })

  it('scales the stored CSS width and rounds to whole pixels', () => {
    expect(aiDockWidth({ width: 400, collapsed: false, petPos: null })).toBe(400)
    expect(aiDockWidth({ width: 400, collapsed: false, petPos: null }, 1.5)).toBe(600)
    expect(aiDockWidth({ width: 400.6, collapsed: false, petPos: null })).toBe(401)
  })

  it('clamps the stored width into [min, max] before scaling, like the renderer drag does', () => {
    expect(aiDockWidth({ width: 100, collapsed: false, petPos: null })).toBe(AI_DOCK_WIDTH_MIN)
    expect(aiDockWidth({ width: 2000, collapsed: false, petPos: null })).toBe(AI_DOCK_WIDTH_MAX)
    // the clamp is on the CSS width: a 400 px drawer at 150% legitimately spans 600
    expect(aiDockWidth({ width: 2000, collapsed: false, petPos: null }, 1.5)).toBe(
      AI_DOCK_WIDTH_MAX * 1.5,
    )
  })
})

describe('drawerOverlayBounds', () => {
  it('pins the overlay to the right edge, drawer-wide, the full content height', () => {
    expect(
      drawerOverlayBounds({ width: 800, height: 600 }, { dock: normalizeAiDock(undefined) }),
    ).toEqual({ x: 800 - AI_DOCK_WIDTH_DEFAULT, y: 0, width: AI_DOCK_WIDTH_DEFAULT, height: 600 })
  })

  it('is zero-wide at the right edge while the drawer is closed', () => {
    // the caller decides visibility from the same pref; a collapsed drawer
    // just shapes nothing
    expect(
      drawerOverlayBounds(
        { width: 800, height: 600 },
        { dock: { width: 400, collapsed: true, petPos: null } },
      ),
    ).toEqual({ x: 800, y: 0, width: 0, height: 600 })
  })

  it('scales the stored CSS width with the interface scale', () => {
    expect(
      drawerOverlayBounds(
        { width: 800, height: 600 },
        { scale: 1.5, dock: { width: 360, collapsed: false, petPos: null } },
      ),
    ).toEqual({ x: 260, y: 0, width: 540, height: 600 })
  })

  it('clamps the width through the shared rails like the renderer drag does', () => {
    expect(
      drawerOverlayBounds(
        { width: 800, height: 600 },
        { dock: { width: 2000, collapsed: false, petPos: null } },
      ),
    ).toEqual({ x: 800 - AI_DOCK_WIDTH_MAX, y: 0, width: AI_DOCK_WIDTH_MAX, height: 600 })
    expect(
      drawerOverlayBounds(
        { width: 800, height: 600 },
        { dock: { width: 120, collapsed: false, petPos: null } },
      ),
    ).toEqual({ x: 800 - AI_DOCK_WIDTH_MIN, y: 0, width: AI_DOCK_WIDTH_MIN, height: 600 })
  })

  it('fills the window when the scaled drawer outgrows it', () => {
    // the HTML drawer would spill past the left edge; a native view clamps
    expect(
      drawerOverlayBounds(
        { width: 500, height: 400 },
        { scale: 1.5, dock: { width: 400, collapsed: false, petPos: null } },
      ),
    ).toEqual({ x: 0, y: 0, width: 500, height: 400 })
  })

  it('never returns negative sizes on a degenerate window', () => {
    expect(
      drawerOverlayBounds(
        { width: 0, height: 0 },
        { dock: { width: 400, collapsed: false, petPos: null } },
      ),
    ).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })
})

describe('normalizeAiDock', () => {
  it('falls back to the open-drawer default for anything unreadable', () => {
    const fallback = { width: AI_DOCK_WIDTH_DEFAULT, collapsed: false, petPos: null }
    expect(normalizeAiDock(undefined)).toEqual(fallback)
    expect(normalizeAiDock(null)).toEqual(fallback)
    expect(normalizeAiDock('400')).toEqual(fallback)
    expect(normalizeAiDock({ width: 'wide' })).toEqual(fallback)
    expect(normalizeAiDock({ width: Number.NaN })).toEqual(fallback)
    expect(normalizeAiDock({ width: Number.POSITIVE_INFINITY })).toEqual(fallback)
  })

  it('keeps a valid width, rounded, clamped to [min, max]', () => {
    expect(normalizeAiDock({ width: 480, collapsed: false })).toEqual({
      width: 480,
      collapsed: false,
      petPos: null,
    })
    expect(normalizeAiDock({ width: 480.4, collapsed: false }).width).toBe(480)
    expect(normalizeAiDock({ width: 9999, collapsed: false }).width).toBe(AI_DOCK_WIDTH_MAX)
    expect(normalizeAiDock({ width: 12, collapsed: false }).width).toBe(AI_DOCK_WIDTH_MIN)
  })

  it('collapses only on an explicit true', () => {
    expect(normalizeAiDock({ width: 480, collapsed: true })).toEqual({
      width: 480,
      collapsed: true,
      petPos: null,
    })
    expect(normalizeAiDock({ width: 480, collapsed: 1 }).collapsed).toBe(false)
    expect(normalizeAiDock({ width: 480, collapsed: 'yes' }).collapsed).toBe(false)
  })

  it('keeps a finite pet position, rounded; anything else is the default corner', () => {
    expect(normalizeAiDock({ petPos: { x: 120, y: 80.6 } }).petPos).toEqual({ x: 120, y: 81 })
    expect(normalizeAiDock({ petPos: null }).petPos).toBeNull()
    expect(normalizeAiDock({}).petPos).toBeNull()
    expect(normalizeAiDock({ petPos: { x: 12, y: 'top' } }).petPos).toBeNull()
    expect(normalizeAiDock({ petPos: { x: Number.NaN, y: 4 } }).petPos).toBeNull()
    expect(normalizeAiDock({ petPos: 'corner' }).petPos).toBeNull()
  })
})
