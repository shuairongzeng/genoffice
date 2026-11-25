// Shared responsive width rule for the apps' AI side panels, replacing the
// copy-pasted per-app constants: the panel auto-grows and auto-shrinks with
// the window but never drops below the default width. The shell window's
// minimum width is 720, so the 60% cap is at least 432 there — the default
// floor is always satisfiable.

/** Default AI panel width, and the floor the panel never shrinks below */
export const AI_PANEL_WIDTH_DEFAULT = 360

/** Minimum width supported by the shared persisted-width helpers */
export const AI_PANEL_WIDTH_MIN = 280

/** Absolute ceiling for the panel width, however wide the window gets */
export const AI_PANEL_WIDTH_MAX = 720

/** Hard cap: the panel never exceeds 60% of the window or 720px */
export function aiPanelWidthCap(windowWidth: number): number {
  const w = saneWindowWidth(windowWidth)
  return Math.max(AI_PANEL_WIDTH_DEFAULT, Math.min(AI_PANEL_WIDTH_MAX, Math.round(w * 0.6)))
}

/** Width when the user has not dragged the divider: grows with the window
 * (~22%), floored at the default, capped by aiPanelWidthCap */
export function aiPanelAutoWidth(windowWidth: number): number {
  const w = saneWindowWidth(windowWidth)
  const cap = aiPanelWidthCap(w)
  return Math.min(cap, Math.max(AI_PANEL_WIDTH_DEFAULT, Math.round(w * 0.22)))
}

/** Clamp a user-dragged width: never below the default, never above the cap */
export function aiPanelClampWidth(width: number, windowWidth: number): number {
  const cap = aiPanelWidthCap(windowWidth)
  return Math.min(cap, Math.max(AI_PANEL_WIDTH_DEFAULT, width))
}

/** NaN, negative or infinite window widths count as a zero-size window, so every rule falls back to the default width */
function saneWindowWidth(windowWidth: number): number {
  return Number.isFinite(windowWidth) && windowWidth > 0 ? windowWidth : 0
}

export function maxAiPanelWidth(): number {
  // The viewport can be transiently tiny (a WebContentsView is 0x0 until the
  // shell lays it out), so never let the ceiling drop below the minimum
  return Math.max(
    AI_PANEL_WIDTH_MIN,
    Math.min(AI_PANEL_WIDTH_MAX, Math.round(window.innerWidth * 0.6)),
  )
}

export function clampAiPanelWidth(w: number): number {
  return Math.min(Math.max(w, AI_PANEL_WIDTH_MIN), maxAiPanelWidth())
}

/**
 * Restores the persisted preference, or null when none is stored. Static
 * bounds only — clamping against the window here would bake a transiently
 * small viewport into the restored preference.
 */
export function loadAiPanelWidth(key: string): number | null {
  const saved = Number(localStorage.getItem(key))
  return Number.isFinite(saved) && saved > 0
    ? Math.min(Math.max(saved, AI_PANEL_WIDTH_MIN), AI_PANEL_WIDTH_MAX)
    : null
}

export function saveAiPanelWidth(key: string, width: number): void {
  localStorage.setItem(key, String(Math.round(width)))
}
