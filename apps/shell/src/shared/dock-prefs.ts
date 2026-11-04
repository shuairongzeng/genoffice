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
 *
 * `customItems` are the launchers the person dragged in from the desktop
 * (desktop icons dropped onto the pill): a file path, a folder path or an
 * app tile id, each with the stable id `dockCustomId` derives from its kind
 * and target. They ride the launchers group and the same `order` sequence —
 * the normalizer keeps the two consistent (every custom's id appears in the
 * order exactly once) so a partial hand-edit of app-settings.json can never
 * strand a definition the pill still renders or vice versa.
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

/** how many dragged-in launchers the dock accepts before a drop is refused */
export const DOCK_CUSTOM_CAP = 12
/** one custom target is capped like every other path the stores accept */
const DOCK_CUSTOM_TARGET_MAX_CHARS = 4096

/** what a custom launcher is: a file, a folder, or a desktop app tile */
export type DockCustomKind = 'file' | 'folder' | 'app'

/**
 * One dragged-in dock launcher. `target` is the file or folder path (kinds
 * file/folder) or the desktop app id (`app:docs`, kinds app) — the same
 * identity the desktop icon carries, so the item's click verb is the icon's
 * own verb resolved live at click time (the path may stop existing; the app
 * set may change between builds). The id is pinned to the pair
 * (`dockCustomId`) so two writes of one drop agree on identity and the
 * stores can dedupe by id alone.
 */
export interface DockCustomItem {
  /** stable identity (React key, the order sequence's entry) */
  readonly id: string
  readonly kind: DockCustomKind
  /** the launch target: the path (file/folder) or the app id (app) */
  readonly target: string
}

/**
 * One dragged-in desktop icon offered to the dock — the payload the desktop
 * view hands its host on a drop over the pill. The host (Home) resolves it
 * into a `DockCustomItem` through `addDockCustom`.
 */
export interface DockCustomCandidate {
  readonly kind: DockCustomKind
  readonly target: string
}

/** the stable id of one custom launcher: derived from its kind and target */
export function dockCustomId(kind: DockCustomKind, target: string): string {
  return `dock:custom:${kind}:${target}`
}

/** a custom launcher, whole: null on anything else, the id pinned to the pair */
export function asDockCustomItem(value: unknown): DockCustomItem | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<{ id: unknown; kind: unknown; target: unknown }>
  if (typeof raw.id !== 'string' || raw.id === '') return null
  if (raw.kind !== 'file' && raw.kind !== 'folder' && raw.kind !== 'app') return null
  if (typeof raw.target !== 'string' || raw.target === '') return null
  if (raw.target.length > DOCK_CUSTOM_TARGET_MAX_CHARS) return null
  if (raw.id !== dockCustomId(raw.kind, raw.target)) return null
  return { id: raw.id, kind: raw.kind, target: raw.target }
}

/** the stored customs: validated, deduped by id, capped at DOCK_CUSTOM_CAP */
function normalizeDockCustomItems(value: unknown): DockCustomItem[] {
  if (!Array.isArray(value)) return []
  const out: DockCustomItem[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    const item = asDockCustomItem(raw)
    if (!item || seen.has(item.id)) continue
    if (out.length >= DOCK_CUSTOM_CAP) break
    seen.add(item.id)
    out.push(item)
  }
  return out
}

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
  /** the dragged-in launchers (desktop icons), capped, ids consistent with order */
  customItems: DockCustomItem[]
}

/**
 * Whole-pixel clamp of a slider value: the pill math rounds to whole px, so
 * a fractional base size would only shimmer it — the store never holds one.
 */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.round(Math.min(max, Math.max(min, value)) * 100) / 100
}

/** the stored `dockPrefs` with defaults filled, every number clamped, the order deduped and kept consistent with the customs */
export function normalizeDockPrefs(value: unknown): DockPrefs {
  const raw = (value ?? {}) as Partial<{
    magnify: unknown
    baseSize: unknown
    maxScale: unknown
    autoHide: unknown
    order: unknown
    customItems: unknown
  }>
  const order = Array.isArray(raw.order)
    ? raw.order.filter((id): id is string => typeof id === 'string' && id !== '')
    : []
  const customItems = normalizeDockCustomItems(raw.customItems)
  // the consistency rule: every custom's id rides the order sequence exactly
  // once — one a partial write (or a hand-edit) dropped appends at the end,
  // while the person's own arrangement of the rest is untouched. Entries
  // naming customs the list no longer carries rank nothing and simply drop
  // out of applyDockOrder; removing a definition is `removeDockCustom`'s
  // business (definition and order entry together), not the normalizer's.
  const known = new Set(order)
  const appended = customItems.filter((item) => !known.has(item.id)).map((item) => item.id)
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
    order: appended.length > 0 ? [...new Set(order), ...appended] : [...new Set(order)],
    customItems,
  }
}

/**
 * Two dock prefs are the same prefs: every field counts, the order by exact
 * sequence (a swap always re-broadcasts), the customs by exact sequence (an
 * added, removed or reordered launcher is a new dock). The watcher's dedup
 * gate.
 */
export function sameDockPrefs(a: DockPrefs, b: DockPrefs): boolean {
  return (
    a.magnify === b.magnify &&
    a.autoHide === b.autoHide &&
    a.baseSize === b.baseSize &&
    a.maxScale === b.maxScale &&
    a.order.length === b.order.length &&
    a.order.every((id, index) => id === b.order[index]) &&
    a.customItems.length === b.customItems.length &&
    a.customItems.every(
      (item, index) =>
        item.id === b.customItems[index]?.id &&
        item.kind === b.customItems[index]?.kind &&
        item.target === b.customItems[index]?.target,
    )
  )
}

/** what a drop onto the dock did — the desktop view's answer to read back */
export type DockCustomAddStatus = 'added' | 'duplicate' | 'full' | 'invalid'

/**
 * Where a positioned insert lands: the launchers group's displayed ids (the
 * arrangement applyDockOrder produces, WITHOUT the newcomer) and the index
 * the newcomer takes among them — 0 is the group's head, `launchers.length`
 * the gap before the ask tail.
 */
export interface DockCustomPlace {
  readonly launchers: readonly string[]
  /** clamped into [0, launchers.length] */
  readonly index: number
}

/**
 * One dragged-in desktop icon joined onto the prefs: the candidate validated
 * (an empty or oversized target answers `invalid`), a repeat of an item the
 * dock already carries answered `duplicate` (nothing changes, nothing
 * writes), a drop past DOCK_CUSTOM_CAP answered `full` (the pill's
 * composition stands).
 *
 * Without a `place` an `added` item lands at the END of the customs list and
 * the END of the order sequence — applyDockOrder places it after the
 * launchers group's coded members, before the ask tail, exactly where the
 * drop released it. With one, the newcomer takes the previewed position: the
 * order is rebuilt so the launchers group is ranked explicitly, in its new
 * sequence, with the newcomer spliced at the index. Ranking the whole group
 * at once is the robust way to express "between THESE two neighbors" —
 * splicing a single id next to a neighbor's rank only works when the
 * sequence already lists both, and a fresh store lists neither. The group's
 * ranks matter only within the group (membership is the groups' own, never
 * the sequence's), so the block may sit anywhere in the flat order — the
 * ids outside it keep their relative arrangement untouched.
 */
export function addDockCustom(
  prefs: DockPrefs,
  candidate: DockCustomCandidate,
  place?: DockCustomPlace,
): { status: DockCustomAddStatus; prefs: DockPrefs } {
  const target = candidate.target.trim()
  const item = asDockCustomItem({
    id: dockCustomId(candidate.kind, target),
    kind: candidate.kind,
    target,
  })
  if (!item) return { status: 'invalid', prefs }
  if (prefs.customItems.some((existing) => existing.id === item.id)) {
    return { status: 'duplicate', prefs }
  }
  if (prefs.customItems.length >= DOCK_CUSTOM_CAP) return { status: 'full', prefs }
  const customItems = [...prefs.customItems, item]
  if (!place) {
    return {
      status: 'added',
      prefs: { ...prefs, customItems, order: [...prefs.order, item.id] },
    }
  }
  const index = Math.min(Math.max(Math.round(place.index), 0), place.launchers.length)
  const block = [...place.launchers.slice(0, index), item.id, ...place.launchers.slice(index)]
  const inBlock = new Set(block)
  const rest = prefs.order.filter((id) => !inBlock.has(id))
  return {
    status: 'added',
    prefs: { ...prefs, customItems, order: [...rest, ...block] },
  }
}

/**
 * Drop one custom launcher: the definition and its order entry go together —
 * "removing from order does not drop the definition" describes the
 * normalizer's tolerance of partial writes, not the remove verb itself. A
 * missing id is a no-op (the prefs come back unchanged).
 */
export function removeDockCustom(prefs: DockPrefs, id: string): DockPrefs {
  if (!prefs.customItems.some((item) => item.id === id)) return prefs
  return {
    ...prefs,
    customItems: prefs.customItems.filter((item) => item.id !== id),
    order: prefs.order.filter((entry) => entry !== id),
  }
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
 * none of those views is showing — while Home's own dock carries the
 * truth); 'cloud' rides the same field for the cloud launcher's running
 * dot. `loggedIn` gates the cloud launcher itself (a signed-in person keeps
 * their way in; the logged-out dock simply has one item fewer — the overlay
 * rect's item count follows it). `ask` is the drawer's open state, shared
 * with the aiDock prefs.
 */
export interface DockOpenState {
  view: 'desktop' | 'recent' | 'starred' | 'cloud' | null
  /** the settings modal is open (设置中心) */
  settings: boolean
  /** the plugins pane is the settings modal's open section (插件) */
  plugins: boolean
  /** the template gallery is open (模板中心) */
  templates: boolean
  /** the AI drawer is open (AI 问答) */
  ask: boolean
  /** the Genspark account is signed in (the cloud launcher's gate) */
  loggedIn: boolean
}

/** the report every consumer starts from until Home's first one arrives */
export const DOCK_OPEN_NONE: DockOpenState = {
  view: null,
  settings: false,
  plugins: false,
  templates: false,
  ask: false,
  loggedIn: false,
}

/** a DockOpenState, whole: every field present and well-typed, null on anything else */
export function asDockOpenState(value: unknown): DockOpenState | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<Record<keyof DockOpenState, unknown>>
  for (const key of ['view', 'settings', 'plugins', 'templates', 'ask', 'loggedIn'] as const) {
    if (raw[key] === undefined) return null
  }
  const view = raw.view
  if (
    view !== null &&
    view !== 'desktop' &&
    view !== 'recent' &&
    view !== 'starred' &&
    view !== 'cloud'
  ) {
    return null
  }
  if (typeof raw.settings !== 'boolean') return null
  if (typeof raw.plugins !== 'boolean') return null
  if (typeof raw.templates !== 'boolean') return null
  if (typeof raw.ask !== 'boolean') return null
  if (typeof raw.loggedIn !== 'boolean') return null
  return {
    view,
    settings: raw.settings,
    plugins: raw.plugins,
    templates: raw.templates,
    ask: raw.ask,
    loggedIn: raw.loggedIn,
  }
}
