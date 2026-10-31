/**
 * Pure geometry of the desktop-host shell: the Home renderer is the window's
 * persistent base layer, and document WebContentsViews embed into the
 * desktop's content stage — below its embedded tab strip, beside its docked
 * AI panel. No Electron or DOM imports so the main process, the renderer and
 * unit tests all share it.
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

/**
 * The AI dock's persisted state (app-settings.json `aiDock`): the renderer
 * writes it through `home:ai-dock-set`, the main process reads it. `width` is
 * the dock's CSS width in the `zoom`ed chrome coordinate space, so converting
 * to window pixels multiplies by the interface scale.
 */
export interface AiDockPrefs {
  width: number
  /** true: collapsed to its rail — the mascot strip, not zero width */
  collapsed: boolean
}

/** Fallback dock constants — must stay in sync with the renderer's AiDock.tsx */
export const AI_DOCK_WIDTH_DEFAULT = 400
export const AI_DOCK_WIDTH_MIN = 320
export const AI_DOCK_WIDTH_MAX = 560
/** the collapsed dock's rail width (the mascot's perch) */
export const AI_DOCK_RAIL_WIDTH = 72

/**
 * The dock's fallback footprint in window pixels: the rail while collapsed,
 * otherwise the stored CSS width clamped into the same [min, max] the
 * renderer's own drag commits, then scaled by the interface scale (the dock
 * column is `zoom`ed chrome, so its window footprint grows with the scale).
 */
export function aiDockWidth(dock: AiDockPrefs, scale = 1): number {
  if (dock.collapsed) return Math.round(AI_DOCK_RAIL_WIDTH * scale)
  const css = Math.min(AI_DOCK_WIDTH_MAX, Math.max(AI_DOCK_WIDTH_MIN, Math.round(dock.width)))
  return Math.round(css * scale)
}

/** the stored `aiDock` value with defaults filled in and out-of-range numbers clamped */
export function normalizeAiDock(value: unknown): AiDockPrefs {
  const raw = (value ?? {}) as Partial<{ width: unknown; collapsed: unknown }>
  const width =
    typeof raw.width === 'number' && Number.isFinite(raw.width)
      ? Math.round(raw.width)
      : AI_DOCK_WIDTH_DEFAULT
  return {
    width: Math.min(AI_DOCK_WIDTH_MAX, Math.max(AI_DOCK_WIDTH_MIN, width)),
    collapsed: raw.collapsed === true,
  }
}

export interface DesktopContentLayout {
  /** interface scale, as the shell's uiScale setting defines it */
  scale?: number
  /** the dock's persisted state; its footprint is derived from it */
  dock: AiDockPrefs
}

/**
 * The fallback rect for an embedded document view: below the desktop header
 * and left of the AI dock, in window (content-area) pixels. It approximates
 * the desktop's real layout — the stage rect the renderer reports is the
 * exact answer, and this stands in until it arrives. HTML fullscreen and
 * content-bleed paths never go through here; they keep the whole window.
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
