/**
 * Persisted preferences for the embedded Pi Agent runtime and Magic Context
 * integration (`app-settings.json` under the `piAgent` key).
 *
 * Kept free of Electron, Node, and DOM imports so main, preload, renderer, and
 * unit tests normalize against one exact contract.
 */

export type PiAgentEngine = 'pi' | 'legacy'
export type MagicContextStorageMode = 'isolated' | 'shared'
export type MagicContextEmbeddingMode = 'off' | 'local'

export interface PiAgentPrefs {
  readonly engine: PiAgentEngine
  readonly magicContextEnabled: boolean
  readonly magicContextStorageMode: MagicContextStorageMode
  /** Empty means follow the active GenOffice chat model. */
  readonly historianModel: string
  readonly dreamerEnabled: boolean
  /** Empty means follow historianModel / active GenOffice chat model. */
  readonly dreamerModel: string
  /** Local ONNX embedding can be toggled in Settings; 'off' uses FTS immediately without 90 MB download. */
  readonly embeddingMode: MagicContextEmbeddingMode
  readonly enablePiReadTools: boolean
  readonly enablePiWriteTools: boolean
  readonly temporalAwareness: boolean
  readonly autoSearchHints: boolean
}

export type PiAgentPrefsPatch = Partial<PiAgentPrefs>

export const DEFAULT_PI_AGENT_PREFS: PiAgentPrefs = {
  engine: 'pi',
  magicContextEnabled: true,
  magicContextStorageMode: 'isolated',
  historianModel: '',
  dreamerEnabled: false,
  dreamerModel: '',
  embeddingMode: 'off',
  enablePiReadTools: true,
  enablePiWriteTools: true,
  temporalAwareness: true,
  autoSearchHints: true,
}

function normalizeEngine(value: unknown): PiAgentEngine {
  return value === 'legacy' ? 'legacy' : 'pi'
}

function normalizeStorageMode(value: unknown): MagicContextStorageMode {
  return value === 'shared' ? 'shared' : 'isolated'
}

function normalizeEmbeddingMode(value: unknown): MagicContextEmbeddingMode {
  return value === 'local' ? 'local' : 'off'
}

function normalizeModelRef(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 200) : ''
}

/** Normalize raw `piAgent` settings into a safe, complete `PiAgentPrefs` object. */
export function normalizePiAgentPrefs(value: unknown): PiAgentPrefs {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  return {
    engine: normalizeEngine(raw.engine),
    magicContextEnabled: raw.magicContextEnabled !== false,
    magicContextStorageMode: normalizeStorageMode(raw.magicContextStorageMode),
    historianModel: normalizeModelRef(raw.historianModel),
    dreamerEnabled: raw.dreamerEnabled === true,
    dreamerModel: normalizeModelRef(raw.dreamerModel),
    embeddingMode: normalizeEmbeddingMode(raw.embeddingMode),
    enablePiReadTools: raw.enablePiReadTools !== false,
    enablePiWriteTools: raw.enablePiWriteTools !== false,
    temporalAwareness: raw.temporalAwareness !== false,
    autoSearchHints: raw.autoSearchHints !== false,
  }
}

/** Merge a partial patch into existing `PiAgentPrefs`. */
export function mergePiAgentPrefs(current: PiAgentPrefs, rawPatch: unknown): PiAgentPrefs {
  const patch = (typeof rawPatch === 'object' && rawPatch !== null ? rawPatch : {}) as Record<
    string,
    unknown
  >
  return {
    engine: Object.hasOwn(patch, 'engine') ? normalizeEngine(patch.engine) : current.engine,
    magicContextEnabled:
      typeof patch.magicContextEnabled === 'boolean'
        ? patch.magicContextEnabled
        : current.magicContextEnabled,
    magicContextStorageMode: Object.hasOwn(patch, 'magicContextStorageMode')
      ? normalizeStorageMode(patch.magicContextStorageMode)
      : current.magicContextStorageMode,
    historianModel: Object.hasOwn(patch, 'historianModel')
      ? normalizeModelRef(patch.historianModel)
      : current.historianModel,
    dreamerEnabled:
      typeof patch.dreamerEnabled === 'boolean' ? patch.dreamerEnabled : current.dreamerEnabled,
    dreamerModel: Object.hasOwn(patch, 'dreamerModel')
      ? normalizeModelRef(patch.dreamerModel)
      : current.dreamerModel,
    embeddingMode: Object.hasOwn(patch, 'embeddingMode')
      ? normalizeEmbeddingMode(patch.embeddingMode)
      : current.embeddingMode,
    enablePiReadTools:
      typeof patch.enablePiReadTools === 'boolean'
        ? patch.enablePiReadTools
        : current.enablePiReadTools,
    enablePiWriteTools:
      typeof patch.enablePiWriteTools === 'boolean'
        ? patch.enablePiWriteTools
        : current.enablePiWriteTools,
    temporalAwareness:
      typeof patch.temporalAwareness === 'boolean'
        ? patch.temporalAwareness
        : current.temporalAwareness,
    autoSearchHints:
      typeof patch.autoSearchHints === 'boolean'
        ? patch.autoSearchHints
        : current.autoSearchHints,
  }
}

export function samePiAgentPrefs(a: PiAgentPrefs, b: PiAgentPrefs): boolean {
  return (
    a.engine === b.engine &&
    a.magicContextEnabled === b.magicContextEnabled &&
    a.magicContextStorageMode === b.magicContextStorageMode &&
    a.historianModel === b.historianModel &&
    a.dreamerEnabled === b.dreamerEnabled &&
    a.dreamerModel === b.dreamerModel &&
    a.embeddingMode === b.embeddingMode &&
    a.enablePiReadTools === b.enablePiReadTools &&
    a.enablePiWriteTools === b.enablePiWriteTools &&
    a.temporalAwareness === b.temporalAwareness &&
    a.autoSearchHints === b.autoSearchHints
  )
}
