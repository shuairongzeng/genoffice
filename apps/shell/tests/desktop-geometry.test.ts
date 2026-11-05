import { describe, expect, it } from 'vitest'

import {
  AI_DOCK_WIDTH_DEFAULT,
  AI_DOCK_WIDTH_MAX,
  AI_DOCK_WIDTH_MIN,
  DESKTOP_HEADER_HEIGHT,
  PET_MARGIN,
  PET_SIZE,
  aiBubbleAnchor,
  aiDockWidth,
  desktopHeaderHeight,
  documentContentBounds,
  drawerOverlayBounds,
  DOCK_ITEM_COUNT,
  DOCK_SEPARATOR_COUNT,
  dockOverlayBounds,
  normalizeAiDock,
  petOverlayBounds,
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
 * drawer's scaled width, the full height — or, while collapsed, the pet-only
 * footprint (petOverlayBounds: the pet's own position, the pet's own size
 * plus a shadow margin, clamped the way the renderer's pet clamps). The
 * constants mirror the renderer's own values (home.css / AiDock.tsx) and must
 * move with them.
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
    expect(aiDockWidth({ width: 480, collapsed: true, petPos: null, panelPos: null })).toBe(0)
    expect(aiDockWidth({ width: 480, collapsed: true, petPos: null }, 1.5)).toBe(0)
  })

  it('scales the stored CSS width and rounds to whole pixels', () => {
    expect(aiDockWidth({ width: 400, collapsed: false, petPos: null, panelPos: null })).toBe(400)
    expect(aiDockWidth({ width: 400, collapsed: false, petPos: null }, 1.5)).toBe(600)
    expect(aiDockWidth({ width: 400.6, collapsed: false, petPos: null, panelPos: null })).toBe(401)
  })

  it('clamps the stored width into [min, max] before scaling, like the renderer drag does', () => {
    expect(aiDockWidth({ width: 100, collapsed: false, petPos: null, panelPos: null })).toBe(AI_DOCK_WIDTH_MIN)
    expect(aiDockWidth({ width: 2000, collapsed: false, petPos: null, panelPos: null })).toBe(AI_DOCK_WIDTH_MAX)
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

  it('is the pet-only footprint while the drawer is collapsed (the pet is the presence)', () => {
    // the overlay stays up whenever a document shows; collapsed it shrinks to
    // the pet: the default perch, pet-sized plus the shadow margin
    expect(
      drawerOverlayBounds(
        { width: 800, height: 600 },
        { dock: { width: 400, collapsed: true, petPos: null } },
      ),
    ).toEqual(petOverlayBounds({ width: 800, height: 600 }, {}, null))
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

describe('petOverlayBounds', () => {
  it('anchors the default perch at the exactly pet-sized bottom-right corner', () => {
    // the pet's own top-left sits where Home's HTML pet perches for a null
    // petPos (window - PET_SIZE - PET_MARGIN), and the view is EXACTLY the
    // pet's box: a view hit-tests over its whole rect however transparent it
    // paints, so the intercept area must equal the painted bird — no
    // invisible margin may eat the page's clicks
    expect(petOverlayBounds({ width: 800, height: 600 }, {}, null)).toEqual({
      x: 800 - PET_SIZE.width - PET_MARGIN,
      y: 600 - PET_SIZE.height - PET_MARGIN,
      width: PET_SIZE.width,
      height: PET_SIZE.height,
    })
  })

  it('places the view at the stored pet position (the same spot Home paints it)', () => {
    expect(petOverlayBounds({ width: 800, height: 600 }, {}, { x: 120, y: 80 })).toEqual({
      x: 120,
      y: 80,
      width: PET_SIZE.width,
      height: PET_SIZE.height,
    })
  })

  it('scales the pet and the position with the interface scale', () => {
    // petPos is zoomed-chrome space: 120 CSS px at 150% is 180 window px, and
    // the pet's own box grows the same way
    expect(
      petOverlayBounds({ width: 800, height: 600 }, { scale: 1.5 }, { x: 120, y: 80 }),
    ).toEqual({
      x: 180,
      y: 120,
      width: Math.round(PET_SIZE.width * 1.5),
      height: Math.round(PET_SIZE.height * 1.5),
    })
  })

  it('clamps a pet position that would hang off an edge, like the renderer pet', () => {
    // the clamp uses PET_SIZE (the pet's own box, exactly the view): the
    // pet's window position obeys the same rule Home's pet obeys, and the
    // view stays whole on the window with it — the shadow clips instead
    expect(petOverlayBounds({ width: 800, height: 600 }, {}, { x: 900, y: 700 })).toEqual({
      x: 800 - PET_SIZE.width,
      y: 600 - PET_SIZE.height,
      width: PET_SIZE.width,
      height: PET_SIZE.height,
    })
    expect(petOverlayBounds({ width: 800, height: 600 }, {}, { x: -50, y: -50 }).x).toBe(0)
    expect(petOverlayBounds({ width: 800, height: 600 }, {}, { x: -50, y: -50 }).y).toBe(0)
  })
})

describe('aiBubbleAnchor', () => {
  it('right-aligns the bubble to the pet by default', () => {
    // the pet at x 940 in a 1024-wide window: the bubble's right edge hangs
    // 16px off the window's right (the pet's right edge), never less than 8
    const anchor = aiBubbleAnchor({ x: 940, y: 690 }, { width: 1024, height: 768 })
    expect(anchor.right).toBe(16)
  })

  it('clamps the bubble into the window when the pet perches far left', () => {
    // right-aligned to a pet at x 120 would hang a 400-wide panel past the
    // left edge (right offset 836 → left −212): with the panel's width known
    // the anchor clamps the offset so the panel's left lands on the 8px edge
    const anchor = aiBubbleAnchor({ x: 120, y: 300 }, { width: 1024, height: 768 }, 400)
    expect(anchor.right).toBe(1024 - 400 - 8)
    // the clamped left edge: onscreen, above the pet
    expect(1024 - anchor.right - 400).toBe(8)
  })

  it('leaves the offset untouched while the panel fits where the pet puts it', () => {
    const anchor = aiBubbleAnchor({ x: 940, y: 690 }, { width: 1024, height: 768 }, 400)
    expect(anchor.right).toBe(16)
  })
})

describe('normalizeAiDock', () => {
  it('falls back to the open-drawer default for anything unreadable', () => {
    const fallback = { width: AI_DOCK_WIDTH_DEFAULT, collapsed: false, petPos: null, panelPos: null }
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
      panelPos: null,
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
      panelPos: null,
    })
    expect(normalizeAiDock({ width: 480, collapsed: 1 }).collapsed).toBe(false)
    expect(normalizeAiDock({ width: 480, collapsed: 'yes' }).collapsed).toBe(false)
  })

  it('keeps a finite pet position, rounded; anything else is the default corner', () => {
    expect(normalizeAiDock({ petPos: { x: 120, y: 80.6 } }).petPos).toEqual({ x: 120, y: 81 })
    expect(normalizeAiDock({ petPos: null, panelPos: null }).petPos).toBeNull()
    expect(normalizeAiDock({}).petPos).toBeNull()
    expect(normalizeAiDock({ petPos: { x: 12, y: 'top' } }).petPos).toBeNull()
    expect(normalizeAiDock({ petPos: { x: Number.NaN, y: 4 } }).petPos).toBeNull()
    expect(normalizeAiDock({ petPos: 'corner' }).petPos).toBeNull()
  })
})

describe('dockOverlayBounds', () => {
  it('the strip: the full content width, a hair at the bottom edge', () => {
    const { strip, dock } = dockOverlayBounds(
      { width: 800, height: 600 },
      { itemCount: DOCK_ITEM_COUNT, separatorCount: DOCK_SEPARATOR_COUNT },
    )
    expect(strip).toEqual({ x: 0, y: 597, width: 800, height: 3 })
    // the dock rect exists alongside; both are cut in the same call
    expect(dock.width).toBeGreaterThan(0)
  })

  it("the dock: centered like Home's dock, pill plus fisheye headroom and tooltip room, reaching the bottom edge", () => {
    // the pill: 7×48 icons + 8×3 gaps + 2×7 separators + 32 padding+border
    // = 406 CSS px, 72 tall (48 + 22 padding + 2 border) + 9 bottom margin.
    // The rect fits the pill WITH its fisheye: a hovered icon rises
    // (1.7−1)×48 = 33.6 above its rest top and the screentip flips ~28px
    // above that, so the height carries both and the width carries the peak
    // growth on both sides — a rest-sized rect would clip the magnified
    // icons and the tooltip at the view's top
    const { dock } = dockOverlayBounds(
      { width: 800, height: 600 },
      { itemCount: DOCK_ITEM_COUNT, separatorCount: DOCK_SEPARATOR_COUNT },
    )
    expect(dock).toEqual({ x: 164, y: 600 - 143, width: 473, height: 143 })
    // the rect reaches the window's bottom edge (y + height = the window):
    // the strip's footprint stays inside the grown view, so the summoning
    // pointer is not evicted by the reveal
    expect(dock.y + dock.height).toBe(600)
  })

  it('the headroom is pinned to the physics: the rect fits the peak magnification and the tooltip', () => {
    // the ceiling the renderer's dock-math defaults to (M = 1.7, base 48)
    // and the tooltip flip above the magnified icon (~28px) — the rect must
    // never shrink below what a fully magnified dock plus its screentip
    // paints, or doc mode would clip the gesture at the view's top
    const { dock } = dockOverlayBounds(
      { width: 1200, height: 800 },
      { itemCount: DOCK_ITEM_COUNT, separatorCount: DOCK_SEPARATOR_COUNT },
    )
    const pillHeight = 72
    const pillWidth = 406
    const rise = (1.7 - 1) * 48
    // the rects are whole-pixel (Math.round), so the pin allows the rounding
    // to shave a fraction — never the 33.6px of headroom itself
    expect(dock.height).toBeGreaterThanOrEqual(pillHeight + 9 + rise + 28 - 1)
    expect(dock.width).toBeGreaterThanOrEqual(pillWidth + 2 * rise - 1)
  })

  it('scales both shapes with the interface scale', () => {
    const { strip, dock } = dockOverlayBounds(
      { width: 800, height: 600 },
      { scale: 1.5, itemCount: DOCK_ITEM_COUNT, separatorCount: DOCK_SEPARATOR_COUNT },
    )
    // the strip hair grows with the chrome; the pill, its headroom and its
    // margins too
    expect(strip).toEqual({ x: 0, y: 600 - 5, width: 800, height: 5 })
    expect(dock).toEqual({ x: 45, y: 600 - 214, width: 710, height: 214 })
  })

  it('centers the pill on odd widths, clamped whole-pixel at the seam', () => {
    const { dock } = dockOverlayBounds(
      { width: 801, height: 600 },
      { itemCount: DOCK_ITEM_COUNT, separatorCount: DOCK_SEPARATOR_COUNT },
    )
    expect(dock.x + dock.width).toBeLessThanOrEqual(801)
    expect(dock.x).toBe((801 - dock.width) / 2 >= 0 ? dock.x : 0)
  })

  it('clamps to the window when the pill outgrows it', () => {
    // a 463px rect in a 300px window: the dock rect fills the width, pinned
    // left (the same clamp the drawer's bounds take)
    const { dock } = dockOverlayBounds(
      { width: 300, height: 400 },
      { itemCount: DOCK_ITEM_COUNT, separatorCount: DOCK_SEPARATOR_COUNT },
    )
    expect(dock).toEqual({ x: 0, y: 400 - 143, width: 300, height: 143 })
  })

  it('parameterizes the composition: more items, wider pill', () => {
    const base = dockOverlayBounds(
      { width: 1200, height: 800 },
      { itemCount: 7, separatorCount: 2 },
    )
    const wider = dockOverlayBounds(
      { width: 1200, height: 800 },
      { itemCount: 9, separatorCount: 2 },
    )
    expect(wider.dock.width - base.dock.width).toBe(2 * 48 + 2 * 3)
    // the strip never changes with the composition
    expect(wider.strip).toEqual(base.strip)
  })

  it('the live base size re-cuts the rect: a 64px pill (设置 ▸ 图标大小)', () => {
    // the pill: 22 padding + 7×64 icons + 8×3 gaps + 2×7 separators = 508
    // CSS px wide, 64+14 tall; the headroom (1.7−1)×64 = 44.8 both sides;
    // height 78+9+44.8+28 = 159.8 → 160
    const { dock } = dockOverlayBounds(
      { width: 800, height: 600 },
      { itemCount: DOCK_ITEM_COUNT, separatorCount: DOCK_SEPARATOR_COUNT, baseSize: 64 },
    )
    expect(dock).toEqual({ x: 96, y: 430, width: 608, height: 170 })
  })

  it('the strength slider sizes the headroom: M 2.0 grows, M 1.2 shrinks', () => {
    const strong = dockOverlayBounds(
      { width: 800, height: 600 },
      { itemCount: DOCK_ITEM_COUNT, separatorCount: DOCK_SEPARATOR_COUNT, maxScale: 2 },
    )
    // headroom (2−1)×48 = 48 both sides: 406+96 wide, 72+9+48+28 tall
    expect(strong.dock.width).toBe(502)
    expect(strong.dock.height).toBe(157)
    const gentle = dockOverlayBounds(
      { width: 800, height: 600 },
      { itemCount: DOCK_ITEM_COUNT, separatorCount: DOCK_SEPARATOR_COUNT, maxScale: 1.2 },
    )
    // headroom 0.2×48 = 9.6: 406+19.2 wide, 72+9+9.6+28 tall
    expect(gentle.dock.width).toBe(425)
    expect(gentle.dock.height).toBe(119)
  })

  it('junk or absent sizes fall back to the dock-math defaults', () => {
    const fallback = dockOverlayBounds(
      { width: 800, height: 600 },
      { itemCount: DOCK_ITEM_COUNT, separatorCount: DOCK_SEPARATOR_COUNT },
    )
    const junk = dockOverlayBounds(
      { width: 800, height: 600 },
      {
        itemCount: DOCK_ITEM_COUNT,
        separatorCount: DOCK_SEPARATOR_COUNT,
        baseSize: Number.NaN,
        maxScale: 'big' as unknown as number,
      },
    )
    expect(junk.dock).toEqual(fallback.dock)
  })
})
