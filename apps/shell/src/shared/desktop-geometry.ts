/**
 * Pure geometry of the desktop-host shell: the Home renderer is the window's
 * persistent base layer, and document WebContentsViews embed into the
 * desktop's content stage — below its embedded tab strip. The AI panel is no
 * longer a layout column beside that stage: it is a floating pet plus a
 * right-edge drawer that overlays the content, so it reserves no width in any
 * state and nothing here subtracts space for the pet. While a document tab is
 * active the drawer's host is a native overlay view (main/ai-drawer-view.ts),
 * shaped by drawerOverlayBounds below — and while the drawer is collapsed
 * that view shrinks to the pet itself (petOverlayBounds), the drawer's whole
 * presence then. The pet's own geometry (size, margin, clamp) lives here for
 * the same reason: two layers perch the bird and must agree on it. No
 * Electron or DOM imports so the main process, the renderer and unit tests
 * all share it.
 *
 * The renderer's measured stage rect (reported over `home:content-rect`) is
 * the primary source for where a document view sits — the desktop's own
 * layout owns that truth. The constants here are the fallback used until a
 * report lands (early boot, or a renderer without the channel), so they
 * mirror the renderer's own values and must move with them.
 */

import type { Rect } from './tab-drag-geometry'
import { DOCK_BASE_DEFAULT, DOCK_MAX_SCALE_DEFAULT } from './dock-prefs'

/** Fallback height of the desktop's header band — the embedded tab strip. Must
 *  stay in sync with `.work-tabs` in the renderer's home.css (44px today). */
export const DESKTOP_HEADER_HEIGHT = 44

/**
 * The fallback header height at an interface scale: the strip is `zoom`ed
 * chrome, so its footprint grows with the scale (genoffice#1913).
 */
export function desktopHeaderHeight(scale = 1): number {
  return Math.round(DESKTOP_HEADER_HEIGHT * scale)
}

/** the floating pet's persisted window position (CSS px, see AiDockPrefs) */
export interface AiPetPos {
  x: number
  y: number
}

/**
 * The AI drawer's persisted state (app-settings.json `aiDock`): the renderer
 * writes it through `home:ai-dock-set`, the main process reads it. `width` is
 * the drawer panel's CSS width in the `zoom`ed chrome coordinate space, so
 * converting to window pixels multiplies by the interface scale. `collapsed`
 * is the drawer's open/closed state — closed, the floating pet is the panel's
 * whole presence. `petPos` is the pet's top-left corner in the same `zoom`ed
 * chrome space; null anchors it at the content corner (its default perch).
 */
export interface AiDockPrefs {
  width: number
  /** true: the drawer is closed — the pet floats alone, no panel showing */
  collapsed: boolean
  /**
   * The pet's top-left corner in the `zoom`ed chrome coordinate space — NOT
   * window pixels: the pet's window position is petPos × interface scale
   * (petOverlayBounds does that multiplication). A drag that moves the
   * pointer Δ window px therefore moves petPos by Δ/scale — the pet follows
   * the cursor 1:1 on screen while the stored number stays chrome-space.
   * Null anchors the default bottom-right perch.
   */
  petPos: AiPetPos | null
}

/** Fallback drawer constants — must stay in sync with the renderer's AiDock.tsx */
export const AI_DOCK_WIDTH_DEFAULT = 400
export const AI_DOCK_WIDTH_MIN = 320
export const AI_DOCK_WIDTH_MAX = 560

/**
 * The drawer's footprint in window pixels: zero while closed (the pet floats
 * over the content and reserves no layout width anywhere), otherwise the
 * stored CSS width clamped into the same [min, max] the renderer's own drag
 * commits, then scaled by the interface scale (the drawer is `zoom`ed chrome,
 * so its window footprint grows with the scale).
 *
 * The drawer overlays content rather than docking beside it, so an open
 * drawer no longer shrinks a document's runtime bounds — the renderer's stage
 * report (the primary source for document bounds) is full-width now. This
 * number survives for the boot-time fallback geometry and as the width the
 * W2 native overlay view is sized from (drawerOverlayBounds).
 */
export function aiDockWidth(dock: AiDockPrefs, scale = 1): number {
  if (dock.collapsed) return 0
  const css = Math.min(AI_DOCK_WIDTH_MAX, Math.max(AI_DOCK_WIDTH_MIN, Math.round(dock.width)))
  return Math.round(css * scale)
}

/* ── the pet's geometry ──
 * All in the `zoom`ed chrome coordinate space (the same space the drawer
 * width lives in): the pet is content of a `zoom`ed root, so its left/top
 * are CSS px there and its window footprint multiplies by the interface
 * scale. The pet's own box is a fixed-size drawing (56×50 mascot plus 6px
 * button padding), so constants describe it exactly. These live here — not
 * in the renderer's AiDock.tsx — because two layers perch the same bird
 * (Home's HTML pet and the native overlay's pet-only view) and both must
 * size and clamp it identically; AiDock re-exports them so its own import
 * sites keep working. */

/** the pet button's size in chrome CSS px (the mascot SVG plus its padding) */
export const PET_SIZE = { width: 68, height: 62 } as const

/** the pet's default gap from the window's right and bottom edges */
export const PET_MARGIN = 16

/**
 * Clamp a pet position into the window (and out of the open drawer's
 * footprint, via `reservedRight`): the pet never hangs off an edge and never
 * hides under the drawer it opens. Pure so the gesture, the geometry and the
 * tests share one truth.
 */
export function clampPetPos(
  pos: AiPetPos,
  bounds: { width: number; height: number },
  size: { width: number; height: number },
  reservedRight = 0,
): AiPetPos {
  const maxX = Math.max(0, Math.round(bounds.width - size.width - reservedRight))
  const maxY = Math.max(0, Math.round(bounds.height - size.height))
  return {
    x: Math.min(Math.max(0, Math.round(pos.x)), maxX),
    y: Math.min(Math.max(0, Math.round(pos.y)), maxY),
  }
}

/** the default perch: the content corner (the window's bottom-right, the stage's own) */
export function defaultPetPos(bounds: { width: number; height: number }): AiPetPos {
  return {
    x: bounds.width - PET_SIZE.width - PET_MARGIN,
    y: bounds.height - PET_SIZE.height - PET_MARGIN,
  }
}

/**
 * The overlay's pet-only rect in window (content-area) pixels: the view's
 * origin is the pet's clamped top-left — the same window spot Home's HTML
 * pet paints for the same `petPos`, so the bird does not jump between modes
 * — and its size is EXACTLY the pet's own box. No slack is added on purpose:
 * a WebContentsView hit-tests over its whole rect however transparent it
 * paints, so a single margin of invisible view would sit over the page's
 * scrollbar or the editor's status bar eating their clicks — the intercept
 * area must equal the painted bird. The cost is the drop shadow clipping
 * when the perch is clamped hard against an edge: a cosmetic clip nobody
 * clicks on. This is what the collapsed drawer's overlay shrinks to: the
 * pet is the drawer's whole presence then, and the only way back into the
 * panel. During a pet drag the view is temporarily expanded to the whole
 * window instead (the drag's surface — see home:ai-pet-drag), and this is
 * what it returns to.
 */
export function petOverlayBounds(
  window: { width: number; height: number },
  layout: { scale?: number },
  petPos: AiPetPos | null,
): Rect {
  const scale = layout.scale ?? 1
  const chrome = { width: window.width / scale, height: window.height / scale }
  const pos = clampPetPos(petPos ?? defaultPetPos(chrome), chrome, PET_SIZE)
  return {
    x: Math.round(pos.x * scale),
    y: Math.round(pos.y * scale),
    width: Math.round(PET_SIZE.width * scale),
    height: Math.round(PET_SIZE.height * scale),
  }
}

/**
 * The W2 native overlay drawer's bounds in window (content-area) pixels:
 * while the drawer is open, the right edge, `aiDockWidth` wide, the full
 * height — the same footprint the renderer's HTML drawer paints when Home is
 * the active tab (its panel is `position: fixed; top: 0; right: 0; bottom:
 * 0`, covering the embedded strip too), so the drawer reads as one surface
 * whichever layer hosts it. While the drawer is collapsed, the pet-only
 * footprint above — the overlay is the pet's host whenever a document tab is
 * active, so the caller shows it in both states and this only shapes the
 * footprint. A drawer wider than the window fills it (the HTML drawer would
 * spill past the left edge; a native view clamps instead of painting
 * off-window).
 */
export function drawerOverlayBounds(
  window: { width: number; height: number },
  layout: DesktopContentLayout,
): Rect {
  if (layout.dock.collapsed) return petOverlayBounds(window, layout, layout.dock.petPos)
  const scale = layout.scale ?? 1
  const width = Math.min(aiDockWidth(layout.dock, scale), Math.max(0, Math.round(window.width)))
  return {
    x: Math.max(0, Math.round(window.width) - width),
    y: 0,
    width,
    height: Math.max(0, Math.round(window.height)),
  }
}

/** a stored pet position: both coordinates finite numbers, rounded to whole px */
function normalizePetPos(value: unknown): AiPetPos | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Partial<{ x: unknown; y: unknown }>
  const { x, y } = raw
  if (typeof x !== 'number' || !Number.isFinite(x)) return null
  if (typeof y !== 'number' || !Number.isFinite(y)) return null
  return { x: Math.round(x), y: Math.round(y) }
}

/** the stored `aiDock` value with defaults filled in and out-of-range numbers clamped */
export function normalizeAiDock(value: unknown): AiDockPrefs {
  const raw = (value ?? {}) as Partial<{ width: unknown; collapsed: unknown; petPos: unknown }>
  const width =
    typeof raw.width === 'number' && Number.isFinite(raw.width)
      ? Math.round(raw.width)
      : AI_DOCK_WIDTH_DEFAULT
  return {
    width: Math.min(AI_DOCK_WIDTH_MAX, Math.max(AI_DOCK_WIDTH_MIN, width)),
    collapsed: raw.collapsed === true,
    petPos: normalizePetPos(raw.petPos),
  }
}

export interface DesktopContentLayout {
  /** interface scale, as the shell's uiScale setting defines it */
  scale?: number
  /** the drawer's persisted state; its footprint is derived from it */
  dock: AiDockPrefs
}

/**
 * The fallback rect for an embedded document view: below the desktop header,
 * left of the drawer's footprint, in window (content-area) pixels. It
 * approximates the desktop's real layout — the stage rect the renderer
 * reports is the exact answer, and this stands in until it arrives. The pet
 * never subtracts from this: it floats. HTML fullscreen and content-bleed
 * paths never go through here; they keep the whole window.
 */
export function documentContentBounds(
  window: { width: number; height: number },
  layout: DesktopContentLayout,
): Rect {
  const scale = layout.scale ?? 1
  const header = desktopHeaderHeight(scale)
  const dock = aiDockWidth(layout.dock, scale)
  return {
    x: 0,
    y: header,
    width: Math.max(0, Math.round(window.width - dock)),
    height: Math.max(0, Math.round(window.height - header)),
  }
}

// ── the doc-mode dock overlay (the hot strip that grows into the dock) ──

/**
 * The dock overlay's shape constants, mirroring the dock's own chrome so the
 * native view frames the pill exactly: home.css's `.dock` rules (padding,
 * gap, separator, border, the bottom margin) and the renderer dock-math's
 * base icon size. Must move with them — the entry renders the real Dock
 * inside the view these numbers size, so a drift shows as a clipped or
 * overshooting pill.
 */

/** the dock pill's icon pitch at rest (dock-prefs' single-sourced default) */
const DOCK_OVERLAY_BASE = DOCK_BASE_DEFAULT
/** the pill's horizontal padding + hairline borders, CSS px */
const DOCK_OVERLAY_H_PADDING = 10 + 10 + 1 + 1
/** the pill's vertical padding + borders, CSS px (above + below the row) */
const DOCK_OVERLAY_V_PADDING = 5 + 7 + 1 + 1
/** the flex gap between the pill's children, CSS px */
const DOCK_OVERLAY_GAP = 3
/** one separator's footprint: 1px rule + 3px margins each side, CSS px */
const DOCK_OVERLAY_SEPARATOR = 3 + 1 + 3
/** the pill's float above the window's bottom edge, CSS px (home.css margin) */
const DOCK_OVERLAY_BOTTOM = 9
/** the hot strip's thickness, CSS px */
const DOCK_OVERLAY_STRIP = 3
/**
 * The dock's peak magnification M (dock-prefs' single-sourced default): the
 * rect must fit the pill WITH its fisheye, so the physics' ceiling sizes the
 * headroom.
 */
const DOCK_OVERLAY_MAX_SCALE = DOCK_MAX_SCALE_DEFAULT
/**
 * Room above a magnified icon for the screentip, CSS px: the tooltip flips
 * above the hovered item, and a rect that ends at the icon's scaled top
 * would clip it out of the view — invisible in doc mode.
 */
const DOCK_OVERLAY_TOOLTIP_ROOM = 28

/**
 * The dock's item count — 3 nav + 3 launchers + the ask tail. Mirrors the
 * renderer's dock groups (Home's and the doc-mode entry's, which share the
 * composition); the overlay's pill math sizes the view from it.
 */
export const DOCK_ITEM_COUNT = 7

/** the separators between those groups (nav | launchers | ask) */
export const DOCK_SEPARATOR_COUNT = 2

/** the pill's size in CSS px for a given composition and base icon size */
function dockPillSize(
  itemCount: number,
  separatorCount: number,
  baseSize = DOCK_OVERLAY_BASE,
): {
  width: number
  height: number
} {
  const children = itemCount + separatorCount
  const gaps = Math.max(0, children - 1) * DOCK_OVERLAY_GAP
  const width =
    DOCK_OVERLAY_H_PADDING + itemCount * baseSize + gaps + separatorCount * DOCK_OVERLAY_SEPARATOR
  return { width, height: baseSize + DOCK_OVERLAY_V_PADDING }
}

/**
 * The doc-mode dock overlay's two rects in window (content-area) pixels:
 *
 * - `strip`: the hot edge — the full content width, a hair over the window's
 *   bottom, invisible (the entry's surface is transparent) and 3px thin. It
 *   exists only to catch a pointer-enter along the bottom and report it; the
 *   3px band it intercepts is the last 3px of the document, a tradeoff
 *   accepted in exchange for a summonable dock (documented in
 *   dock-overlay-view.ts).
 * - `dock`: the revealed dock — horizontally centered like Home's dock
 *   (left 50% + translateX(-50%)), the pill floating `DOCK_OVERLAY_BOTTOM`
 *   above the bottom edge, and the rect extending DOWN TO the window's
 *   bottom edge so it contains the strip's footprint: the pointer that
 *   summoned the dock stays inside the grown view instead of tripping a
 *   leave-and-flicker the moment the reveal lands.
 *
 * The rect fits the pill WITH its fisheye, not the pill at rest: a hovered
 * icon rises (M−1)·base above its rest top (the slot anchors the baseline,
 * the transform grows upward only), the pill's ends widen as neighbors
 * shift, and the screentip flips ~28px above the magnified icon — a
 * rest-sized rect would clip all three at the view's top. So the height
 * carries the magnification headroom and the tooltip room above the pill,
 * and the width carries the peak growth on both sides. The cost is honest:
 * the extra margin is transparent but still hit-tests (a native view eats
 * clicks over its whole rect), so the entry reports leave from the pill's
 * actual painted box rather than the rect — see dock-entry.tsx.
 *
 * Both scale by the interface scale like every chrome band; a window
 * narrower than the pill clamps the dock rect to the window (the pill then
 * centers over a clipped view — the same clamp the drawer's bounds take).
 *
 * `baseSize` and `maxScale` are the live dock settings (the icon-size and
 * magnification-strength sliders in 设置 ▸ 程序坞); both default to the
 * dock-math defaults, so a caller without prefs (tests, a fallback) still
 * gets the canonical pill.
 */
export function dockOverlayBounds(
  window: { width: number; height: number },
  layout: {
    scale?: number
    itemCount: number
    separatorCount: number
    /** the dock's base icon size, CSS px (设置 ▸ 图标大小; default 48) */
    baseSize?: number
    /** the dock's peak magnification M (设置 ▸ 放大强度; default 1.7) */
    maxScale?: number
  },
): { strip: Rect; dock: Rect } {
  const scale = layout.scale ?? 1
  const baseSize = Number.isFinite(layout.baseSize) ? layout.baseSize! : DOCK_OVERLAY_BASE
  const maxScale = Number.isFinite(layout.maxScale) ? layout.maxScale! : DOCK_OVERLAY_MAX_SCALE
  const pill = dockPillSize(layout.itemCount, layout.separatorCount, baseSize)
  // how far a magnified icon rises above its rest top, CSS px
  const magnifyHeadroom = (maxScale - 1) * baseSize
  const stripHeight = Math.max(1, Math.round(DOCK_OVERLAY_STRIP * scale))
  const pillWidth = Math.min(
    Math.round((pill.width + 2 * magnifyHeadroom) * scale),
    Math.max(0, Math.round(window.width)),
  )
  const dockHeight = Math.round(
    (pill.height + DOCK_OVERLAY_BOTTOM + magnifyHeadroom + DOCK_OVERLAY_TOOLTIP_ROOM) * scale,
  )
  return {
    strip: {
      x: 0,
      y: Math.max(0, Math.round(window.height) - stripHeight),
      width: Math.max(0, Math.round(window.width)),
      height: stripHeight,
    },
    dock: {
      x: Math.max(0, Math.round((window.width - pillWidth) / 2)),
      y: Math.max(0, Math.round(window.height) - dockHeight),
      width: pillWidth,
      height: dockHeight,
    },
  }
}
