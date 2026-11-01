/**
 * Pure geometry of the desktop-host shell: the Home renderer is the window's
 * persistent base layer, and document WebContentsViews embed into the
 * desktop's content stage — below its embedded tab strip. The AI panel is no
 * longer a layout column beside that stage: it is a floating pet plus a
 * right-edge drawer that overlays the content, so it reserves no width in any
 * state and nothing here subtracts space for the pet. While a document tab is
 * active the drawer's host is a native overlay view (main/ai-drawer-view.ts),
 * shaped by drawerOverlayBounds below. No Electron or DOM imports so the main
 * process, the renderer and unit tests all share it.
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
  /** the pet's window position; null = the default bottom-right corner */
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

/**
 * The W2 native overlay drawer's bounds in window (content-area) pixels: the
 * right edge, `aiDockWidth` wide, the full height — the same footprint the
 * renderer's HTML drawer paints when Home is the active tab (its panel is
 * `position: fixed; top: 0; right: 0; bottom: 0`, covering the embedded strip
 * too), so the drawer reads as one surface whichever layer hosts it. A drawer
 * wider than the window fills it (the HTML drawer would spill past the left
 * edge; a native view clamps instead of painting off-window). Zero while
 * collapsed — the caller decides visibility, this only shapes the footprint.
 */
export function drawerOverlayBounds(
  window: { width: number; height: number },
  layout: DesktopContentLayout,
): Rect {
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
