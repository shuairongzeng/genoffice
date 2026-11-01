/**
 * The dock's own persisted preferences (app-settings.json `dockPrefs`): the
 * settings-pane surface (设置中心 ▸ 程序坞) and every mount that renders the
 * dock — Home's HTML pill and the doc-mode `?view=dock` overlay — share this
 * shape, so a change one mount writes reaches the others through the store's
 * watcher exactly the way `aiDock` reaches every drawer surface.
 *
 * Pure and main/renderer-shared like desktop-geometry.ts: the clamps and the
 * defaults live once, the store's readers (main) and writers (renderer)
 * normalize on both ends, and a hand-edited settings file can never push a
 * degenerate number into the layout (a `zoom`-adjacent size of 0 or an M of
 * 50 would break the pill math and the overlay's rect alike).
 *
 * `order` is the drag-to-reorder persistence: the flat item-id sequence the
 * person last arranged, applied WITHIN each group (the group boundaries are
 * fixed — nav | launchers | ask — so the sequence only ever permutes a
 * group's own members; applyDockOrder in dock-math.ts is the pure applier).
 */

/** the dock's base icon size in CSS px at rest — the slot pitch */
export const DOCK_BASE_DEFAULT = 48
/** the icon-size slider's range (设置 ▸ 图标大小) */
export const DOCK_BASE_MIN = 40
export const DOCK_BASE_MAX = 64

/** the default peak magnification M (dock-math's own default) */
export const DOCK_MAX_SCALE_DEFAULT = 1.7
/** the magnification-strength slider's range (设置 ▸ 放大强度) */
export const DOCK_MAX_SCALE_MIN = 1.2
export const DOCK_MAX_SCALE_MAX = 2.0

/**
 * The dock's persisted state. `magnify` off is the static dock (a distinct
 * switch from the OS's reduce-motion: both disarm the fisheye, but this one
 * is a preference, and the bounce still obeys only the OS setting).
 * `autoHide` is the Home-mode slide-away (the doc-mode overlay has its own
 * summon-and-hide state machine and ignores it).
 */
export interface DockPrefs {
  /** the fisheye magnification on/off (default on) */
  magnify: boolean
  /** the base icon size, CSS px, [40, 64] (default 48) */
  baseSize: number
  /** the peak magnification M, [1.2, 2.0] (default 1.7) */
  maxScale: number
  /** Home mode: slide the dock away until the stage's bottom edge summons it */
  autoHide: boolean
  /** the person's item order: flat id sequence, applied within groups only */
  order: string[]
}

/**
 * Whole-pixel clamp of a slider value: the pill math rounds to whole px, so
 * a fractional base size would only shimmer it — the store never holds one.
 */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.round(Math.min(max, Math.max(min, value)) * 100) / 100
}

/** the stored `dockPrefs` with defaults filled, every number clamped, the order deduped */
export function normalizeDockPrefs(value: unknown): DockPrefs {
  const raw = (value ?? {}) as Partial<{
    magnify: unknown
    baseSize: unknown
    maxScale: unknown
    autoHide: unknown
    order: unknown
  }>
  const order = Array.isArray(raw.order)
    ? raw.order.filter((id): id is string => typeof id === 'string' && id !== '')
    : []
  return {
    magnify: raw.magnify === false ? false : true,
    baseSize: clampNumber(raw.baseSize, DOCK_BASE_MIN, DOCK_BASE_MAX, DOCK_BASE_DEFAULT),
    maxScale: clampNumber(
      raw.maxScale,
      DOCK_MAX_SCALE_MIN,
      DOCK_MAX_SCALE_MAX,
      DOCK_MAX_SCALE_DEFAULT,
    ),
    autoHide: raw.autoHide === true,
    // ids the store never saw (a fresh item in a newer build) keep their
    // default place after the known ones — see applyDockOrder
    order: [...new Set(order)],
  }
}

/**
 * Two dock prefs are the same prefs: every field counts, the order by exact
 * sequence (a swap always re-broadcasts). The watcher's dedup gate.
 */
export function sameDockPrefs(a: DockPrefs, b: DockPrefs): boolean {
  return (
    a.magnify === b.magnify &&
    a.autoHide === b.autoHide &&
    a.baseSize === b.baseSize &&
    a.maxScale === b.maxScale &&
    a.order.length === b.order.length &&
    a.order.every((id, index) => id === b.order[index])
  )
}

/**
 * The dock's open-target report (`home:dock-open`): which of the dock's
 * targets are open right now, as Home — the surface that owns them — sees
 * it. This is what feeds the running dots on the doc-mode overlay's dock
 * (Home's own dock reads its local state directly) and what ends the
 * overlay's launch bounce ("the target is open" IS the ready signal there).
 *
 * `view` is the Home view currently showing, null while a document covers
 * Home (the overlay only lives in that state, so its nav dots read null —
 * none of those views is showing — while Home's own dock carries the truth).
 * `ask` is the drawer's open state, shared with the aiDock prefs.
 */
export interface DockOpenState {
  view: 'desktop' | 'recent' | 'starred' | null
  /** the settings modal is open (设置中心) */
  settings: boolean
  /** the plugins pane is the settings modal's open section (插件) */
  plugins: boolean
  /** the template gallery is open (模板中心) */
  templates: boolean
  /** the AI drawer is open (AI 问答) */
  ask: boolean
}

/** the report every consumer starts from until Home's first one arrives */
export const DOCK_OPEN_NONE: DockOpenState = {
  view: null,
  settings: false,
  plugins: false,
  templates: false,
  ask: false,
}

/** a DockOpenState, whole: every field present and well-typed, null on anything else */
export function asDockOpenState(value: unknown): DockOpenState | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<Record<keyof DockOpenState, unknown>>
  for (const key of ['view', 'settings', 'plugins', 'templates', 'ask'] as const) {
    if (raw[key] === undefined) return null
  }
  const view = raw.view
  if (view !== null && view !== 'desktop' && view !== 'recent' && view !== 'starred') return null
  if (typeof raw.settings !== 'boolean') return null
  if (typeof raw.plugins !== 'boolean') return null
  if (typeof raw.templates !== 'boolean') return null
  if (typeof raw.ask !== 'boolean') return null
  return {
    view,
    settings: raw.settings,
    plugins: raw.plugins,
    templates: raw.templates,
    ask: raw.ask,
  }
}
