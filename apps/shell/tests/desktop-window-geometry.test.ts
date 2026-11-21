// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_MIN_WINDOW_HEIGHT,
  DEFAULT_MIN_WINDOW_WIDTH,
  STAGE_BOTTOM_INSET,
  STAGE_SIDE_INSET,
  STAGE_TOP_INSET,
  clampWindowRect,
  computeResizeRect,
  defaultWindowRect,
  detectSnapZone,
  maximizedWindowRect,
  readWindowPrefs,
  snapPreviewRect,
  writeWindowPrefs,
  type ResizeEdge,
  type StageBounds,
} from '../src/renderer/src/desktop-window-geometry'

const STAGE: StageBounds = { width: 1280, height: 800 }

describe('desktop-window-geometry', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('places the default window inside safe work area and clears left desktop icons when room permits', () => {
    const rect = defaultWindowRect(STAGE, { width: 880, height: 560 })
    expect(rect.width).toBe(880)
    expect(rect.height).toBe(560)
    // Leaves clearance for left-hand icon columns and respects top/bottom insets
    expect(rect.x).toBeGreaterThanOrEqual(STAGE_SIDE_INSET + 200)
    expect(rect.x + rect.width).toBeLessThanOrEqual(STAGE.width - STAGE_SIDE_INSET)
    expect(rect.y).toBeGreaterThanOrEqual(STAGE_TOP_INSET)
    expect(rect.y + rect.height).toBeLessThanOrEqual(STAGE.height - STAGE_BOTTOM_INSET)

    // Small viewports clamp down cleanly inside available work area
    const compact = defaultWindowRect({ width: 520, height: 420 }, { width: 880, height: 560 })
    expect(compact.x).toBeGreaterThanOrEqual(STAGE_SIDE_INSET)
    expect(compact.width).toBeLessThanOrEqual(520 - STAGE_SIDE_INSET * 2)
    expect(compact.height).toBeLessThanOrEqual(420 - STAGE_TOP_INSET - STAGE_BOTTOM_INSET)
  })

  it('clamps out-of-bounds rects so minimum sizes and reachable titlebar stay visible', () => {
    const clamped = clampWindowRect(
      { x: -1000, y: -50, width: 120, height: 100 },
      STAGE,
      { width: 520, height: 360 },
    )
    expect(clamped.width).toBe(520)
    expect(clamped.height).toBe(360)
    expect(clamped.y).toBe(STAGE_TOP_INSET)
    // At least the reachable header segment stays inside the right bound of work area
    expect(clamped.x + clamped.width).toBeGreaterThanOrEqual(STAGE_SIDE_INSET + 140)

    const farRight = clampWindowRect(
      { x: 9999, y: 9999, width: 600, height: 400 },
      STAGE,
    )
    expect(farRight.x).toBeLessThanOrEqual(STAGE.width - STAGE_SIDE_INSET - 140)
    expect(farRight.y).toBeLessThanOrEqual(STAGE.height - STAGE_BOTTOM_INSET - 48)
  })

  it('resizes across all 8 edges while anchoring opposite edges against drift', () => {
    const start = { x: 240, y: 120, width: 600, height: 400 }
    const startRight = start.x + start.width
    const startBottom = start.y + start.height

    const edges: ReadonlyArray<{ edge: ResizeEdge; dx: number; dy: number }> = [
      { edge: 'e', dx: 80, dy: 0 },
      { edge: 's', dx: 0, dy: 90 },
      { edge: 'w', dx: -60, dy: 0 },
      { edge: 'n', dx: 0, dy: -40 },
      { edge: 'se', dx: 50, dy: 60 },
      { edge: 'sw', dx: -50, dy: 60 },
      { edge: 'ne', dx: 50, dy: -40 },
      { edge: 'nw', dx: -50, dy: -40 },
    ]

    for (const item of edges) {
      const next = computeResizeRect(start, item.edge, item.dx, item.dy, STAGE)
      if (!item.edge.includes('w') && !item.edge.includes('e')) {
        expect(next.x).toBe(start.x)
        expect(next.width).toBe(start.width)
      }
      if (item.edge.includes('w')) {
        expect(next.x + next.width).toBe(startRight)
      }
      if (item.edge.includes('n')) {
        expect(next.y + next.height).toBe(startBottom)
      }
    }

    // Pulling west/north past minimum size still keeps right/bottom edges locked
    const shrunkW = computeResizeRect(start, 'w', 500, 0, STAGE)
    expect(shrunkW.width).toBe(DEFAULT_MIN_WINDOW_WIDTH)
    expect(shrunkW.x + shrunkW.width).toBe(startRight)

    const shrunkN = computeResizeRect(start, 'n', 0, 500, STAGE)
    expect(shrunkN.height).toBe(DEFAULT_MIN_WINDOW_HEIGHT)
    expect(shrunkN.y + shrunkN.height).toBe(startBottom)
  })

  it('detects left/right/top snap zones and calculates matching preview rects', () => {
    expect(detectSnapZone(STAGE_SIDE_INSET + 5, 200, STAGE)).toBe('left')
    expect(detectSnapZone(STAGE.width - STAGE_SIDE_INSET - 5, 200, STAGE)).toBe('right')
    expect(detectSnapZone(600, STAGE_TOP_INSET + 4, STAGE)).toBe('top')
    expect(detectSnapZone(600, 260, STAGE)).toBe('none')

    const leftSnap = snapPreviewRect('left', STAGE)!
    const rightSnap = snapPreviewRect('right', STAGE)!
    const topSnap = snapPreviewRect('top', STAGE)!
    expect(snapPreviewRect('none', STAGE)).toBeNull()

    expect(leftSnap.x).toBe(STAGE_SIDE_INSET)
    expect(rightSnap.x).toBeGreaterThan(leftSnap.x + leftSnap.width)
    expect(topSnap).toEqual(maximizedWindowRect(STAGE))
  })

  it('persists window prefs and degrades cleanly on corrupted storage values', () => {
    const key = 'test.window.prefs'
    expect(readWindowPrefs(key)).toBeNull()

    writeWindowPrefs(key, {
      rect: { x: 120, y: 80, width: 700, height: 480 },
      mode: 'mini',
      snap: 'left',
    })
    expect(readWindowPrefs(key)).toEqual({
      rect: { x: 120, y: 80, width: 700, height: 480 },
      mode: 'mini',
      snap: 'left',
    })

    localStorage.setItem(key, '{bad-json')
    expect(readWindowPrefs(key)).toBeNull()

    localStorage.setItem(
      key,
      JSON.stringify({ rect: { x: 'bad', y: 1, width: 2, height: 3 }, mode: 'bogus', snap: 9 }),
    )
    expect(readWindowPrefs(key)).toEqual({})
  })
})
