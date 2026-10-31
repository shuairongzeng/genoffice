import { describe, expect, it } from 'vitest'

import {
  AI_DOCK_RAIL_WIDTH,
  AI_DOCK_WIDTH_DEFAULT,
  AI_DOCK_WIDTH_MAX,
  AI_DOCK_WIDTH_MIN,
  DESKTOP_HEADER_HEIGHT,
  aiDockWidth,
  desktopHeaderHeight,
  documentContentBounds,
  normalizeAiDock,
} from '../src/shared/desktop-geometry'

/**
 * Pure geometry of the desktop-host shell (src/shared/desktop-geometry.ts):
 * the fallback an embedded document view gets before the renderer reports its
 * measured stage rect — below the desktop header (44px embedded strip,
 * interface-scaled) and left of the AI dock's footprint (the `aiDock` pref).
 * The constants mirror the renderer's own values (home.css / AiDock.tsx) and
 * must move with them.
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
  it('embeds the document below the header, left of the expanded dock', () => {
    expect(
      documentContentBounds({ width: 800, height: 600 }, { dock: normalizeAiDock(undefined) }),
    ).toEqual({ x: 0, y: 44, width: 800 - 400, height: 600 - 44 })
  })

  it('keeps the rail reserved while the dock is collapsed (the mascot keeps its perch)', () => {
    expect(
      documentContentBounds({ width: 800, height: 600 }, { dock: { width: 400, collapsed: true } }),
    ).toEqual({ x: 0, y: 44, width: 800 - AI_DOCK_RAIL_WIDTH, height: 600 - 44 })
  })

  it('scales both the header footprint and the stored CSS width with the interface scale', () => {
    // a 360 CSS px dock at 150% occupies 540 window px, under a 66px header
    expect(
      documentContentBounds(
        { width: 800, height: 600 },
        { scale: 1.5, dock: { width: 360, collapsed: false } },
      ),
    ).toEqual({ x: 0, y: 66, width: 800 - 540, height: 600 - 66 })
  })

  it('clamps an oversized dock to the same max the renderer commits', () => {
    expect(
      documentContentBounds(
        { width: 800, height: 600 },
        { dock: { width: 2000, collapsed: false } },
      ),
    ).toEqual({ x: 0, y: 44, width: 800 - AI_DOCK_WIDTH_MAX, height: 600 - 44 })
  })

  it('floors a too-narrow dock at the renderer minimum', () => {
    expect(
      documentContentBounds(
        { width: 800, height: 600 },
        { dock: { width: 120, collapsed: false } },
      ),
    ).toEqual({ x: 0, y: 44, width: 800 - AI_DOCK_WIDTH_MIN, height: 600 - 44 })
  })

  it('never returns negative sizes on a degenerate window', () => {
    expect(
      documentContentBounds({ width: 100, height: 30 }, { dock: { width: 400, collapsed: false } }),
    ).toEqual({ x: 0, y: 44, width: 0, height: 0 })
  })
})

describe('aiDockWidth', () => {
  it('is the rail (scaled) while collapsed, whatever the stored width', () => {
    expect(aiDockWidth({ width: 480, collapsed: true })).toBe(AI_DOCK_RAIL_WIDTH)
    expect(aiDockWidth({ width: 480, collapsed: true }, 1.5)).toBe(108)
  })

  it('scales the stored CSS width and rounds to whole pixels', () => {
    expect(aiDockWidth({ width: 400, collapsed: false })).toBe(400)
    expect(aiDockWidth({ width: 400, collapsed: false }, 1.5)).toBe(600)
    expect(aiDockWidth({ width: 400.6, collapsed: false })).toBe(401)
  })

  it('clamps the stored width into [min, max] before scaling, like the renderer drag does', () => {
    expect(aiDockWidth({ width: 100, collapsed: false })).toBe(AI_DOCK_WIDTH_MIN)
    expect(aiDockWidth({ width: 2000, collapsed: false })).toBe(AI_DOCK_WIDTH_MAX)
    // the clamp is on the CSS width: a 400 px dock at 150% legitimately spans 600
    expect(aiDockWidth({ width: 2000, collapsed: false }, 1.5)).toBe(AI_DOCK_WIDTH_MAX * 1.5)
  })
})

describe('normalizeAiDock', () => {
  it('falls back to the expanded default for anything unreadable', () => {
    const fallback = { width: AI_DOCK_WIDTH_DEFAULT, collapsed: false }
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
    })
    expect(normalizeAiDock({ width: 480.4, collapsed: false }).width).toBe(480)
    expect(normalizeAiDock({ width: 9999, collapsed: false }).width).toBe(AI_DOCK_WIDTH_MAX)
    expect(normalizeAiDock({ width: 12, collapsed: false }).width).toBe(AI_DOCK_WIDTH_MIN)
  })

  it('collapses only on an explicit true', () => {
    expect(normalizeAiDock({ width: 480, collapsed: true })).toEqual({
      width: 480,
      collapsed: true,
    })
    expect(normalizeAiDock({ width: 480, collapsed: 1 }).collapsed).toBe(false)
    expect(normalizeAiDock({ width: 480, collapsed: 'yes' }).collapsed).toBe(false)
  })
})
