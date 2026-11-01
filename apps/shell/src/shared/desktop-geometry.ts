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
