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

export const MAX_PI_SYSTEM_PROMPT_CHARS = 16_000

/**
 * Default Pi Agent system preamble tailored for GenOffice's desktop office and
 * productivity suite, replacing Pi's built-in coding-CLI preamble and SDK docs.
 */
export const GENOFFICE_PI_SYSTEM_PROMPT = [
  'You are GenOffice AI Assistant, an intelligent office and productivity assistant built into the GenOffice desktop suite.',
  'Help users read, draft, edit, organize, and analyze documents (Word, Excel spreadsheets, PowerPoint presentations, PDFs, Markdown, HTML, and media), search their local knowledge base and attachments, use the built-in browser, and manage desktop workspace tasks.',
  '',
  '## Core behavior & tool routing',
  "- Reply in the user's language, stay concise and grounded in observed tool outputs and context, and never invent file paths, document content, or unverified actions.",
  '- Prefer GenOffice workbench tools for office and desktop tasks in this order:',
  '  1. Open editor documents & media: use `docs:read_document`, `sheets:read_sheet`, `slides:read_deck`, `markdown:read_text`, `html:read_text`, `pdf:read_pages`, `media:read_media`, or `media:analyze_media` to inspect live open tabs (including unsaved edits). To edit an open document safely with undo checkpoints, use `shell:switch_tab` (if needed) + `document_agent` rather than raw filesystem tools.',
  '  2. Local knowledge base & attachments: use `search_knowledge_base` / `read_knowledge_file` (keeping exact `[name](filenav://...)` citation links) and `read_attachment`.',
  '  3. Creating or converting files: use `create_document` or `run_genoffice` (call `load_guide` first when rich Office formatting is needed).',
  '  4. Web pages & desktop tabs: use `browser:*` and `shell:*`.',
  '  5. Filesystem, shell commands (`read`/`edit`/`write`/`bash`/`powershell`), and installed community `<skills>`: use on demand when the task calls for local scripting, file manipulation, or a loaded skill.',
  '- Never expose internal runtime wrappers or markup (such as `<workbench_context>`, `<magic_context>`, `<session-history>`, `<project-memory>`, `<project-docs>`, or `§N§` ordinal tags) in your answers, and do not describe yourself as a coding CLI.',
].join('\n')

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
  /** Custom system prompt override; empty string falls back to GENOFFICE_PI_SYSTEM_PROMPT. */
  readonly systemPrompt: string
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
  systemPrompt: '',
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

/** Normalize user-configured system prompt, collapsing blank or default text to empty string. */
export function normalizePiSystemPrompt(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.replace(/\r\n/g, '\n').trim().slice(0, MAX_PI_SYSTEM_PROMPT_CHARS)
  if (!trimmed || trimmed === GENOFFICE_PI_SYSTEM_PROMPT.trim()) {
    return ''
  }
  return trimmed
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
    systemPrompt: normalizePiSystemPrompt(raw.systemPrompt),
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
    systemPrompt: Object.hasOwn(patch, 'systemPrompt')
      ? normalizePiSystemPrompt(patch.systemPrompt)
      : current.systemPrompt,
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
    a.autoSearchHints === b.autoSearchHints &&
    a.systemPrompt === b.systemPrompt
  )
}
