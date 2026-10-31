import type {
  FileSearchHit,
  FileSearchPage,
  FileSearchRerank,
  HomeApi,
  RecentEntry,
  UserSkillEntry,
} from '../../shared/home-api'
import type { InstalledPlugin } from '../../shared/found-skill'
import type { DocumentTabKind, TabKind, TabSummary } from '../../shared/tabs-api'
import { editorCommandsFor, type EditorCommandId } from '../../shared/editor-commands'
import type { Lang } from '@genoffice/i18n'
import { SECTIONS, type SettingsTarget } from './SettingsModal'
import { translate, type StringKey } from './strings'
import type { CommandPaletteStrings } from './command-palette-strings'

/** recents pulled once on open; the palette filters this page client-side */
const RECENT_LOAD_LIMIT = 100
/** rows shown before the query narrows anything (recent files top 5 + the create actions) */
const RECENT_EMPTY_LIMIT = 5
/** overall row cap, applied after the provider priority order */
const RESULT_CAP = 50
/** the file index contributes at most this many hits per query */
const FILES_ROW_LIMIT = 5
/** the pool the provider asks the index for — the same candidate depth Home's
 *  rerank judges (its top 20), so both entries pick from one ordering */
const FILES_POOL = 20
/** the file search waits this long for the query to settle before hitting the index */
const FILES_DEBOUNCE_MS = 200
/** the decision model's verdict needs a beat to be worth its call; Home's
 *  rerank waits the same settle window after its results land */
const FILES_RERANK_SETTLE_MS = 600
/** while the index is still scanning, re-ask at Home's poll cadence so both
 *  entries show the same growing answer for the same query */
const FILES_BUSY_POLL_MS = 1500

export type GroupId =
  | 'create'
  | 'tabs'
  | 'recent'
  | 'files'
  | 'skills'
  | 'commands'
  | 'settings'
  | 'help'
  | 'plugins'
  | 'ask'

/** one selectable palette row; `run` performs the bridge action */
export interface PaletteRow {
  readonly id: string
  readonly group: GroupId
  readonly title: string
  /** secondary line, also searched (folder, description, app name + extension) */
  readonly detail: string
  readonly icon:
    | { kind: 'file'; ext: string }
    | { kind: 'folder' | 'pen' | 'gear' | 'plug' | 'sparkle' | 'book' | 'command' }
  /** the file failed to stat; the row dims but still tries to open */
  readonly missing: boolean
  /** plugins: the chip naming what Enter does (Disable / Enable) */
  readonly chip: string
  /** file-backed rows (recents, file-index hits) carry their path for cross-source dedupe */
  readonly path?: string
  readonly run: () => void
}

/** the sources a provider reads and the routes a row can take out of the palette */
export interface PaletteContext {
  readonly strings: CommandPaletteStrings
  /** the shell's UI language — settings and help rows read the home/manual
   *  dictionaries, whose words must not drift from the panes they open */
  readonly lang: Lang
  readonly recents: readonly RecentEntry[] | null
  readonly skills: readonly UserSkillEntry[] | null
  readonly plugins: readonly InstalledPlugin[] | null
  /** the Ask AI fallback hands its query to the host (Home switches to the ask view) */
  readonly onAskAi: (query: string) => void
  /** settings rows route through the host's settings modal (Home's
   *  SettingsTarget state) — the modal itself is a Home internal, not a bridge */
  readonly openSettings: (target: SettingsTarget) => void
}

/**
 * One source of palette rows. `priority` fixes the group order (lower sorts
 * earlier); `getRows` answers synchronously when the source is local and as a
 * promise when it queries the bridge — the palette publishes the sync rows
 * first and folds async rows in as they land.
 */
export interface PaletteProvider {
  readonly id: string
  readonly priority: number
  getRows(query: string, ctx: PaletteContext): PaletteRow[] | Promise<PaletteRow[]>
  /** optional: fires when an already-answered query's rows improved (the
   *  files source reorders once the decision model's judgement lands) — the
   *  palette re-queries so the better answer shows while it stays open */
  readonly subscribe?: (listener: () => void) => () => void
  /** optional: release background work (pending timers) when the palette closes */
  readonly dispose?: () => void
}

// ── the default registry ──

export const PRIORITY = {
  create: 10,
  /** switching to what is already open outranks opening something new */
  tabs: 15,
  recent: 20,
  files: 30,
  skills: 40,
  commands: 45,
  settings: 50,
  help: 55,
  plugins: 60,
  /** the natural-language fallback always sorts last */
  ask: 100,
} as const

/** the palette's full source set, in display order */
export function defaultPaletteProviders(): PaletteProvider[] {
  return [
    createActionsProvider(),
    createTabsProvider(),
    createRecentsProvider(),
    createFilesProvider(),
    createSkillsProvider(),
    createEditorCommandsProvider(),
    createSettingsProvider(),
    createHelpTopicsProvider(),
    createPluginsProvider(),
    createAskAiProvider(),
  ]
}

function createActionsProvider(): PaletteProvider {
  return {
    id: 'create',
    priority: PRIORITY.create,
    getRows(query, ctx) {
      const rows = buildCreateRows(ctx.strings)
      const q = query.trim()
      return q ? rankRows(q, rows) : rows
    },
  }
}

function createRecentsProvider(): PaletteProvider {
  return {
    id: 'recent',
    priority: PRIORITY.recent,
    getRows(query, ctx) {
      const rows = (ctx.recents ?? []).map((entry) =>
        plainRow(
          'recent',
          `recent:${entry.path}`,
          entry.name,
          entry.missing ? ctx.strings.missingFile : folderOf(entry.path),
          { kind: 'file', ext: entry.ext },
          () => void window.aiOffice.openPath(entry.path),
          '',
          entry.missing,
          entry.path,
        ),
      )
      const q = query.trim()
      return q ? rankRows(q, rows) : rows.slice(0, RECENT_EMPTY_LIMIT)
    },
  }
}

function createSkillsProvider(): PaletteProvider {
  return {
    id: 'skills',
    priority: PRIORITY.skills,
    getRows(query, ctx) {
      const q = query.trim()
      if (!q) return []
      // the ask view keeps its attached skills in its own state with no bridge
      // to it from a self-contained component; the skills settings page is the
      // one skill surface the palette can reach
      const openSkillsSettings = () => void window.aiOffice.openSkillsSettings()
      const rows: PaletteRow[] = []
      const seen = new Set<string>()
      for (const skill of ctx.skills ?? []) {
        if (seen.has(skill.name)) continue
        seen.add(skill.name)
        rows.push(
          plainRow(
            'skills',
            `skill:${skill.name}`,
            skill.name,
            skill.description,
            { kind: 'pen' },
            () => openSkillsSettings(),
          ),
        )
      }
      for (const plugin of ctx.plugins ?? []) {
        for (const component of [...plugin.components.skills, ...plugin.components.commands]) {
          const name = `${plugin.name}:${component}`
          if (seen.has(name)) continue
          seen.add(name)
          rows.push(
            plainRow('skills', `skill:${name}`, name, plugin.description, { kind: 'pen' }, () =>
              openSkillsSettings(),
            ),
          )
        }
      }
      return rankRows(q, rows)
    },
  }
}

/**
 * Searchable settings rows beyond the section nav: the settings people look
 * for by their own words (the issue #56 acceptance gate is literally "type
 * the localized word for auto-save, land on the row"). Label keys are the
 * settings pane's own, so the palette's words and the pane's can never drift
 * apart.
 */
const SETTINGS_ROWS: readonly { labelKey: StringKey; section: SettingsTarget['section'] }[] = [
  { labelKey: 'setAutoSave', section: 'general' },
  { labelKey: 'setTabSleep', section: 'general' },
  { labelKey: 'setAnalytics', section: 'general' },
  { labelKey: 'setLoginItem', section: 'general' },
  { labelKey: 'setCloseToTray', section: 'general' },
  { labelKey: 'setGlobalHotkey', section: 'general' },
  { labelKey: 'setKbScope', section: 'general' },
  { labelKey: 'setAuthorName', section: 'general' },
  { labelKey: 'setDefaultApp', section: 'general' },
  { labelKey: 'saveLocation', section: 'general' },
  { labelKey: 'language', section: 'general' },
  { labelKey: 'documentTheme', section: 'general' },
  { labelKey: 'setAiPanelSide', section: 'general' },
  { labelKey: 'setAiFontSize', section: 'general' },
  { labelKey: 'setAiSpellcheck', section: 'general' },
  { labelKey: 'setAiApiKey', section: 'aiModel' },
  { labelKey: 'setAiBaseUrl', section: 'aiModel' },
  { labelKey: 'setAiEndpoint', section: 'aiModel' },
]

/** the two sections with curated palette copy (title + hint); the rest use the
 *  home dict's own section label, the same word the modal's nav shows */
const CURATED_SECTIONS: Partial<
  Record<
    SettingsTarget['section'],
    { titleKey: keyof CommandPaletteStrings; hintKey: keyof CommandPaletteStrings }
  >
> = {
  aiModel: { titleKey: 'setAiModel', hintKey: 'hintAiModel' },
  skills: { titleKey: 'setSkills', hintKey: 'hintSkills' },
}

/**
 * The settings catalog (issue #56 P0 #2): every section plus the notable rows
 * inside them. Every row routes through `ctx.openSettings` — the modal is a
 * Home internal, and Home's `setSettingsRequest` state is the one path to it.
 */
export function createSettingsProvider(): PaletteProvider {
  return {
    id: 'settings',
    priority: PRIORITY.settings,
    getRows(query, ctx) {
      const q = query.trim()
      if (!q) return []
      const rows: PaletteRow[] = []
      for (const section of SECTIONS) {
        const curated = CURATED_SECTIONS[section.id]
        rows.push(
          plainRow(
            'settings',
            `settings:section:${section.id}`,
            curated ? ctx.strings[curated.titleKey] : translate(ctx.lang, section.labelKey),
            curated ? ctx.strings[curated.hintKey] : '',
            { kind: 'gear' },
            () => ctx.openSettings({ section: section.id }),
          ),
        )
      }
      for (const row of SETTINGS_ROWS) {
        rows.push(
          plainRow(
            'settings',
            `settings:${row.labelKey}`,
            translate(ctx.lang, row.labelKey),
            translate(ctx.lang, sectionLabelKey(row.section)),
            { kind: 'gear' },
            () => ctx.openSettings({ section: row.section }),
          ),
        )
      }
      return rankRows(q, rows)
    },
  }
}

/** the home-dict label key of a settings section (the modal nav's own words) */
function sectionLabelKey(section: SettingsTarget['section']): StringKey {
  return SECTIONS.find((s) => s.id === section)?.labelKey ?? 'settings'
}

/** the most recently used tab of an editor family, by the activation stamps
 *  every activateTab writes — Home holds the active slot while the palette is
 *  open, so `active` cannot pick the editor; its lastActiveAt can. Chrome-free
 *  presentation views are skipped: they render a document but own no editor
 *  surface, so the owning editor tab is the thing commands can run on. */
function newestEditorTab(tabs: readonly TabSummary[]): TabSummary | undefined {
  let newest: TabSummary | undefined
  for (const tab of tabs) {
    if (tab.kind === 'home' || tab.kind === 'help' || tab.present) continue
    if (!newest || (tab.lastActiveAt ?? 0) > (newest.lastActiveAt ?? 0)) newest = tab
  }
  return newest
}

/** the strip's own per-kind file badge, so a tab row reads as its document */
function tabIcon(kind: TabKind): PaletteRow['icon'] {
  const ext: Partial<Record<TabKind, string>> = {
    docs: 'docx',
    sheets: 'xlsx',
    slides: 'pptx',
    markdown: 'md',
    html: 'html',
    pdf: 'pdf',
  }
  return kind === 'help' ? { kind: 'book' } : { kind: 'file', ext: ext[kind] ?? 'app' }
}

/**
 * The open-tab switcher (issue #56 P0 #2): one row per open tab, Enter
 * activates it. Rows carry the tab's `filePath` so a file-index hit for the
 * same document shadows the tab row exactly as it shadows the recent — both
 * rows end at the same tab, and the hit matched the query against the file's
 * content, not just its title. Home itself is filtered: the palette is
 * summoned on Home, so its row would always point at where you already are.
 *
 * Detached windows are out of scope — `tabs:list` is the strip only — which
 * the PR declares rather than half-covers.
 */
export function createTabsProvider(): PaletteProvider {
  return {
    id: 'tabs',
    priority: PRIORITY.tabs,
    async getRows(query) {
      const tabs = await listTabs()
      const rows = tabs
        .filter((tab) => tab.kind !== 'home')
        // MRU: the switcher's natural order is most-recently-used, which is
        // the strip order's shuffle, not the strip order itself
        .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))
        .map((tab) =>
          plainRow(
            'tabs',
            `tab:${tab.id}`,
            tab.title,
            tab.filePath ? folderOf(tab.filePath) : '',
            tabIcon(tab.kind),
            () => void window.aiOfficeTabs?.activate(tab.id),
            '',
            false,
            tab.filePath,
          ),
        )
      const q = query.trim()
      return q ? rankRows(q, rows) : rows
    },
  }
}

/**
 * The editor-command rows (issue #56 P0 #2): the palette vocabulary is the
 * shared `editorCommandsFor` table, and Enter runs `home:run-command`, which
 * main dispatches to the same family rail the app's own menu uses — so a
 * listed command is runnable by construction, never a promise the shell
 * cannot keep. Rows are offered for the most recently used editor only (its
 * title rides the detail line) and pin that tab's id on the run, so Enter
 * executes on the document the row named even if the family's MRU moved while
 * the palette was open. Presentation views are never targets (they own no
 * editor surface); a preload that predates the rail offers no rows at all —
 * listing without a way to run would be the promise the shell cannot keep.
 */
export function createEditorCommandsProvider(): PaletteProvider {
  return {
    id: 'commands',
    priority: PRIORITY.commands,
    async getRows(query, ctx) {
      const q = query.trim()
      if (!q) return []
      if (typeof (window.aiOffice as Partial<HomeApi> | undefined)?.runEditorCommand !== 'function')
        return []
      const target = newestEditorTab(await listTabs())
      if (!target) return []
      const kind = target.kind as DocumentTabKind
      const rows = editorCommandsFor(kind).map((command) =>
        plainRow(
          'commands',
          `command:${kind}:${command}`,
          ctx.strings[COMMAND_LABEL_KEY[command]],
          target.title,
          { kind: 'command' },
          () => void window.aiOffice.runEditorCommand(kind, command, target.id),
        ),
      )
      return rankRows(q, rows)
    },
  }
}

/** palette label key for each shared editor command verb */
const COMMAND_LABEL_KEY: Record<EditorCommandId, keyof CommandPaletteStrings> = {
  save: 'cmdSave',
  'save-as': 'cmdSaveAs',
  print: 'cmdPrint',
  'export-pdf': 'cmdExportPdf',
  undo: 'cmdUndo',
  redo: 'cmdRedo',
  'zoom-in': 'cmdZoomIn',
  'zoom-out': 'cmdZoomOut',
  'zoom-reset': 'cmdZoomReset',
  find: 'cmdFind',
}

/**
 * The in-app manual as a palette corpus (issue #56 P0 #2, acceptance gate:
 * typing a help question lands on the topic). The topic tables load lazily —
 * the same chunks the help tab uses — so the palette's entry pays nothing
 * until a help-shaped query arrives; the module promise is cached by the
 * runtime, so only the first query sees a fetch. A preload that predates the
 * openHelp bridge offers no rows — deep-linking is the whole point of a help
 * row, and an older rail cannot keep that promise.
 *
 * Matching is token-based rather than the whole-query `scoreMatch`: help
 * queries arrive as questions (the issue's acceptance example is a Chinese
 * "how do I merge PDFs" phrase), whose filler words would drown a
 * whole-string match. CJK questions are typed without spaces, so the token
 * is often the whole question: a token also hits when a keyword is *inside*
 * it (the question contains the word "merge" in either language), not only
 * when the token is inside the haystack. Ranking prefers more matching
 * tokens, then title hits.
 */
export function createHelpTopicsProvider(): PaletteProvider {
  return {
    id: 'help',
    priority: PRIORITY.help,
    async getRows(query, ctx) {
      const q = query.trim()
      if (!q) return []
      if (typeof (window.aiOffice as Partial<HomeApi> | undefined)?.openHelp !== 'function')
        return []
      const { HELP_TOPICS } = await import('./i18n/help/help-registry')
      const { groupTitle, topicTitle } = await import('./i18n/help/help-titles')
      // edge punctuation (ASCII and full-width) is question grammar, not content
      const tokens = q
        .toLowerCase()
        .split(/\s+/)
        .map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
        .filter(Boolean)
      const scored: { row: PaletteRow; score: number }[] = []
      for (const topic of HELP_TOPICS) {
        const title = topicTitle(topic.id, ctx.lang)
        const group = groupTitle(topic.group, ctx.lang)
        const haystack = `${title} ${group} ${topic.keywords.join(' ')}`.toLowerCase()
        // the reverse-containment probe: an unsegmented question contains
        // its search words (the registry's keywords, or a word of the title
        // or group) rather than being contained by the haystack. Spaced-
        // language tokens are already segmented words, so the probe would
        // only fire on substrings ("outline" contains "line") — it runs for
        // tokens that still carry a non-Latin letter (see probeHit)
        const probeWords = [
          ...topic.keywords.map((word) => word.toLowerCase()),
          ...wordsOf(title),
          ...wordsOf(group),
        ]
        let hits = 0
        let titleHit = false
        for (const token of tokens) {
          if (title.toLowerCase().includes(token)) {
            hits += 1
            titleHit = true
          } else if (haystack.includes(token) || probeHit(token, probeWords)) {
            hits += 1
          }
        }
        if (hits === 0) continue
        const row = plainRow(
          'help',
          `help:${topic.id}`,
          title,
          group,
          { kind: 'book' },
          () => void window.aiOffice.openHelp(topic.id),
        )
        // every token matched is worth more than where it matched; the title
        // bonus then keeps a titled topic above a keyword-only one
        scored.push({ row, score: hits * 10 + (titleHit ? 5 : 0) })
      }
      return scored.sort((a, b) => b.score - a.score).map((s) => s.row)
    },
  }
}

/** tabs:list with the soft degradation every bridge read here shares: an
 *  older preload (or a failed read) is "no tabs", never a broken palette */
async function listTabs(): Promise<TabSummary[]> {
  try {
    return (await window.aiOfficeTabs?.list()) ?? []
  } catch {
    return []
  }
}

/** the words of a display string, for the help matcher's reverse probe: runs
 *  of letters/digits split on everything else; one-character runs are noise */
function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2)
}

/** the reverse-containment probe for an unsegmented CJK question token: a
 *  Han keyword matches anywhere inside it (CJK text has no word boundaries),
 *  while a Latin keyword must be one of the token's whole Latin runs — "ai"
 *  is a word of a question that embeds it as its own run, but only a
 *  substring of a run like "airdrop", and "form" is not "format" */
function probeHit(token: string, probeWords: readonly string[]): boolean {
  // a token whose LETTERS are not all Latin-script reaches the probe: the
  // space-less writing systems (Han, Hangul, kana, Thai) are the reason it
  // exists — one token can hold a whole question. Spaced non-Latin scripts
  // (Cyrillic, Arabic, ...) reach it too, where the substring branch behaves
  // like loose stemming (an inflected or prefixed form still contains the
  // word) — harmless on the current vocabularies. Punctuation does not
  // count: a hyphenated Latin compound is still a segmented word
  const letters = token.replace(/[^\p{L}]/gu, '')
  if (!letters || /^\p{Script=Latin}+$/u.test(letters)) return false
  // digits are separators here: a question glues them to a keyword ("2024"
  // before "pdf"), and the keyword still has to stand as its own run
  const latinRuns = token.split(/[^\p{Script=Latin}]+/u).filter(Boolean)
  return probeWords.some((word) => {
    // a keyword with no Latin letter matches anywhere inside the token —
    // no spaces bound it; a Latin-bearing keyword must appear as its own
    // run of letters (a hyphenated keyword as its run sequence)
    if (!/\p{Script=Latin}/u.test(word)) return token.includes(word)
    const pieces = word.split(/[^\p{Script=Latin}]+/u).filter(Boolean)
    return pieces.length > 0 && includesRunSequence(latinRuns, pieces)
  })
}

/** does `pieces` appear in `runs` as one contiguous sequence? */
function includesRunSequence(runs: readonly string[], pieces: readonly string[]): boolean {
  if (pieces.length > runs.length) return false
  outer: for (let i = 0; i + pieces.length <= runs.length; i++) {
    for (let j = 0; j < pieces.length; j++) {
      if (runs[i + j] !== pieces[j]) continue outer
    }
    return true
  }
  return false
}

function createPluginsProvider(): PaletteProvider {
  return {
    id: 'plugins',
    priority: PRIORITY.plugins,
    getRows(query, ctx) {
      const q = query.trim()
      if (!q) return []
      // the plugins settings section has no renderer-invokable open path; the
      // one per-plugin action the bridge offers is the (reversible) toggle
      return rankRows(
        q,
        (ctx.plugins ?? []).map((plugin) =>
          plainRow(
            'plugins',
            `plugin:${plugin.name}`,
            plugin.name,
            plugin.description,
            { kind: 'plug' },
            () => void window.aiOffice.pluginsSetEnabled(plugin.name, !plugin.enabled),
            plugin.enabled ? ctx.strings.pluginDisable : ctx.strings.pluginEnable,
          ),
        ),
      )
    },
  }
}

/**
 * The file index as a palette source. The search debounces so a fast typist
 * costs one index query, not one per keystroke; a query already in flight (or
 * answered) is reused verbatim, so the palette re-rendering for an unrelated
 * source never re-searches. Any failure — the bridge predating `searchFiles`,
 * an index still scanning — settles to no rows: the other sources still
 * answer, which is what a launcher degrading gracefully means.
 *
 * Ranking parity with the Home search: the provider asks for the same
 * candidate depth Home judges and then runs the same decision-model rerank
 * (skipped — null — when reranking is off), ordering hits exactly as Home's
 * results list does. The local order shows first (a launcher must answer
 * fast); the judged order replaces it once the model's verdict lands, and
 * `subscribe` wakes the palette to re-query for the improved rows. While the
 * index is still scanning, the provider re-asks at Home's poll cadence so
 * the rows grow the same way Home's results do.
 */
export function createFilesProvider(options?: {
  readonly search?: (q: string) => Promise<FileSearchPage>
  readonly rerank?: (q: string, paths: string[]) => Promise<FileSearchRerank | null>
  readonly open?: (path: string) => void
  readonly debounceMs?: number
  readonly rerankSettleMs?: number
  readonly busyPollMs?: number
  readonly limit?: number
}): PaletteProvider {
  const limit = options?.limit ?? FILES_ROW_LIMIT
  const pool = Math.max(limit, FILES_POOL)
  const debounceMs = options?.debounceMs ?? FILES_DEBOUNCE_MS
  const rerankSettleMs = options?.rerankSettleMs ?? FILES_RERANK_SETTLE_MS
  const busyPollMs = options?.busyPollMs ?? FILES_BUSY_POLL_MS
  const search =
    options?.search ??
    ((q: string) => {
      const request =
        typeof window === 'undefined'
          ? undefined
          : (window.aiOffice as Partial<HomeApi> | undefined)?.searchFiles?.({ q, limit: pool })
      return (
        request ??
        Promise.resolve<FileSearchPage>({
          hits: [],
          total: 0,
          index: { indexed: 0, pending: 0, scanning: false },
        })
      )
    })
  const rerank =
    options?.rerank ??
    ((q: string, paths: string[]) => {
      const request =
        typeof window === 'undefined'
          ? undefined
          : (window.aiOffice as Partial<HomeApi> | undefined)?.rerankSearch?.({ q, paths })
      return request ?? Promise.resolve<FileSearchRerank | null>(null)
    })
  const open =
    options?.open ??
    ((path: string) => void (window.aiOffice as Partial<HomeApi> | undefined)?.openPath?.(path))
  let timer: ReturnType<typeof setTimeout> | null = null
  /** the settle timer holding the decision-model call back until the query quiets */
  let rerankTimer: ReturnType<typeof setTimeout> | null = null
  /** the catch-up poll timer while the index is still scanning */
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  /** resolves the superseded query's promise with no rows, so it never contributes */
  let abandon: (() => void) | null = null
  let lastQuery = ''
  let lastPromise: Promise<PaletteRow[]> = Promise.resolve([])
  const listeners = new Set<() => void>()
  /**
   * Search generation. Every supersede (a new query, a cleared query, dispose)
   * bumps it, and every continuation — a late search answer, the rerank settle
   * timer, the model's verdict, a catch-up poll — captures the generation it
   * belongs to and drops itself when the number moved. A string comparison on
   * the query alone cannot do this: typing "repo", then "re", then back to
   * "repo" would let the stale first verdict land on the fresh answer.
   */
  let gen = 0
  /**
   * Latched when the palette closes so no continuation may re-arm after it.
   * Not a tombstone: a StrictMode double-mount runs the palette's effects as
   * setup -> cleanup (dispose) -> setup on this same instance (the palette
   * keeps it in a useMemo), and the live mount's first real query revives it
   * below — a closed palette never queries again, so the latch holds for the
   * one case it exists for.
   */
  let disposed = false

  /** publish improved rows for the current query and wake the palette */
  const publishRows = (rows: PaletteRow[]) => {
    lastPromise = Promise.resolve(rows)
    for (const listener of listeners) listener()
  }

  /** ask the decision model to order the pool, Home's settle window later */
  const scheduleRerank = (q: string, hits: readonly FileSearchHit[], ctx: PaletteContext) => {
    if (rerankTimer) clearTimeout(rerankTimer)
    const paths = hits.slice(0, FILES_POOL).map((h) => h.path)
    if (paths.length < 2) return // one candidate has nothing to order
    const myGen = gen
    rerankTimer = setTimeout(() => {
      rerankTimer = null
      if (gen !== myGen || disposed) return
      rerank(q, paths).then(
        (result) => {
          if (!result || gen !== myGen || disposed) return
          // Home's ordering rule exactly: judged hits in the model's order,
          // then the unjudged rest in local order
          const rank = new Map(result.order.map((path, i) => [path, i]))
          const ordered = [...hits].sort(
            (a, b) => (rank.get(a.path) ?? Infinity) - (rank.get(b.path) ?? Infinity),
          )
          publishRows(fileRows(ctx, ordered.slice(0, limit), open))
        },
        () => undefined, // a failed judgement keeps the local order
      )
    }, rerankSettleMs)
  }

  /**
   * Everything after an answer lands: judge the pool, and while the index is
   * still scanning keep re-asking like Home does (its results grow during a
   * scan; the palette's must too, or the two entries show different answers
   * for the same query). The loop ends with the index, the query, or the
   * palette — whichever moves first.
   */
  const afterAnswer = (q: string, ctx: PaletteContext, myGen: number, page: FileSearchPage) => {
    if (gen !== myGen || disposed) return
    scheduleRerank(q, page.hits, ctx)
    if (page.index.pending > 0 || page.index.scanning) {
      if (pollTimer) clearTimeout(pollTimer)
      pollTimer = setTimeout(() => {
        pollTimer = null
        if (gen !== myGen || disposed) return
        search(q).then(
          (next) => {
            if (gen !== myGen || disposed) return
            publishRows(fileRows(ctx, next.hits.slice(0, limit), open))
            afterAnswer(q, ctx, myGen, next)
          },
          () => undefined, // a failed catch-up keeps the rows it has
        )
      }, busyPollMs)
    }
  }

  const cancelPending = () => {
    if (timer) clearTimeout(timer)
    if (rerankTimer) clearTimeout(rerankTimer)
    if (pollTimer) clearTimeout(pollTimer)
    timer = null
    rerankTimer = null
    pollTimer = null
  }

  return {
    id: 'files',
    priority: PRIORITY.files,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      // the generation bump drops every in-flight continuation: a search that
      // resolves after close must not re-arm the rerank or the catch-up poll
      disposed = true
      gen += 1
      cancelPending()
      // settle the in-flight promise so a late consumer never hangs
      abandon?.()
      abandon = null
      listeners.clear()
    },
    getRows(query, ctx) {
      const q = query.trim()
      if (!q) {
        gen += 1
        cancelPending()
        abandon?.()
        abandon = null
        lastQuery = ''
        lastPromise = Promise.resolve([])
        return []
      }
      if (q === lastQuery) return lastPromise
      // a new non-empty query means the palette is alive and asking again (the
      // StrictMode remount case): unlatch. Every continuation captured before
      // this point is dropped by the generation bump, so nothing latched-era
      // can spend a model call on the revived query's behalf
      disposed = false
      gen += 1
      const myGen = gen
      if (timer) clearTimeout(timer)
      if (rerankTimer) clearTimeout(rerankTimer)
      if (pollTimer) clearTimeout(pollTimer)
      rerankTimer = null
      pollTimer = null
      abandon?.()
      lastQuery = q
      lastPromise = new Promise<PaletteRow[]>((resolve) => {
        abandon = () => resolve([])
        timer = setTimeout(() => {
          timer = null
          abandon = null
          // the debounce is a continuation too: a disposed provider must not
          // spend the search either (the timers are cleared on dispose, this
          // guard is the same latch every other continuation checks)
          if (disposed) {
            resolve([])
            return
          }
          search(q).then(
            (page) => {
              resolve(fileRows(ctx, page.hits.slice(0, limit), open))
              afterAnswer(q, ctx, myGen, page)
            },
            () => resolve([]),
          )
        }, debounceMs)
      })
      return lastPromise
    },
  }
}

function fileRows(
  ctx: PaletteContext,
  hits: readonly { path: string; name: string; ext: string; missing?: boolean }[],
  open: (path: string) => void,
): PaletteRow[] {
  return hits.map((hit) =>
    plainRow(
      'files',
      `file:${hit.path}`,
      hit.name,
      hit.missing ? ctx.strings.missingFile : folderOf(hit.path),
      { kind: 'file', ext: hit.ext },
      () => open(hit.path),
      '',
      hit.missing ?? false,
      hit.path,
    ),
  )
}

/**
 * The natural-language fallback: whenever the query is non-empty there is
 * exactly one Ask AI row, no matter what else matched. Picking it hands the
 * query to the host's ask view — the palette is the intent bus, and an
 * unmatched intent is a question.
 */
export function createAskAiProvider(): PaletteProvider {
  return {
    id: 'ask',
    priority: PRIORITY.ask,
    getRows(query, ctx) {
      const q = query.trim()
      if (!q) return []
      return [
        plainRow(
          'ask',
          'ask:ai',
          `${ctx.strings.askAi}: ${q}`,
          ctx.strings.hintAskAi,
          { kind: 'sparkle' },
          () => ctx.onAskAi(q),
        ),
      ]
    },
  }
}

// ── merging ──

/**
 * Folds every provider's rows into the flat list the palette renders:
 * priority order, then three cross-source rules —
 *
 * 1. A file-index hit shadows the recents row and the open-tab row of the same
 *    path. All three rows end at the same tab, and the hit earned its slot by
 *    matching the live query against the file's content while the others only
 *    repeat its name or title, so they yield.
 * 2. An open tab shadows the recents row of the same path: an open document
 *    is by definition recently used, so the recents row would repeat the
 *    switcher row on every empty query. The switcher (higher priority) keeps
 *    the slot.
 * 3. The Ask AI fallback survives the row cap: it is the one row that always
 *    answers, so the cap applies to everything else and the fallback appends.
 */
export function mergePaletteRows(
  parts: ReadonlyArray<{ readonly priority: number; readonly rows: readonly PaletteRow[] }>,
): PaletteRow[] {
  const ordered = [...parts].sort((a, b) => a.priority - b.priority)
  const filePaths = new Set<string>()
  const tabPaths = new Set<string>()
  for (const part of ordered) {
    for (const row of part.rows) {
      if (row.group === 'files' && row.path) filePaths.add(row.path)
      if (row.group === 'tabs' && row.path) tabPaths.add(row.path)
    }
  }
  const askRows: PaletteRow[] = []
  const rest: PaletteRow[] = []
  for (const part of ordered) {
    for (const row of part.rows) {
      if (row.group === 'ask') {
        askRows.push(row)
        continue
      }
      if ((row.group === 'recent' || row.group === 'tabs') && row.path && filePaths.has(row.path)) {
        continue
      }
      // an open document is by definition recently used, so its recents row
      // would always repeat its switcher row; the switcher (higher priority)
      // keeps the slot, exactly as a files hit does
      if (row.group === 'recent' && row.path && tabPaths.has(row.path)) continue
      rest.push(row)
    }
  }
  return [...rest.slice(0, Math.max(0, RESULT_CAP - askRows.length)), ...askRows]
}

export { RECENT_LOAD_LIMIT }

// ── row helpers ──

function buildCreateRows(strings: CommandPaletteStrings): PaletteRow[] {
  return [
    commandRow(
      'doc',
      strings.cmdNewDoc,
      strings.hintNewDoc,
      'docx',
      () => void window.aiOffice.newDoc(),
    ),
    commandRow(
      'sheet',
      strings.cmdNewSheet,
      strings.hintNewSheet,
      'xlsx',
      () => void window.aiOffice.newSheet(),
    ),
    commandRow(
      'slide',
      strings.cmdNewSlide,
      strings.hintNewSlide,
      'pptx',
      () => void window.aiOffice.newSlide(),
    ),
    commandRow(
      'markdown',
      strings.cmdNewMarkdown,
      strings.hintNewMarkdown,
      'md',
      () => void window.aiOffice.newMarkdown(),
    ),
    commandRow(
      'html',
      strings.cmdNewHtml,
      strings.hintNewHtml,
      'html',
      () => void window.aiOffice.newHtml(),
    ),
    commandRow(
      'pdf',
      strings.cmdNewPdf,
      strings.hintNewPdf,
      'pdf',
      () => void window.aiOffice.newPdf(),
    ),
    commandRow(
      'browse',
      strings.cmdBrowse,
      strings.hintBrowse,
      'folder',
      () => void window.aiOffice.browse(),
    ),
  ]
}

function commandRow(
  key: string,
  title: string,
  detail: string,
  ext: string,
  run: () => void,
): PaletteRow {
  return {
    id: `create:${key}`,
    group: 'create',
    title,
    detail,
    icon: ext === 'folder' ? { kind: 'folder' } : { kind: 'file', ext },
    missing: false,
    chip: '',
    run,
  }
}

function plainRow(
  group: GroupId,
  id: string,
  title: string,
  detail: string,
  icon: PaletteRow['icon'],
  run: () => void,
  chip = '',
  missing = false,
  path?: string,
): PaletteRow {
  return { id, group, title, detail, icon, missing, chip, path, run }
}

/** keep the rows whose title or detail matches, best first, source order on ties */
function rankRows(query: string, rows: readonly PaletteRow[]): PaletteRow[] {
  return rows
    .map((row, index) => ({ row, index, score: scoreMatch(query, row.title, row.detail) }))
    .filter((entry) => entry.score !== null)
    .sort((a, b) => b.score! - a.score! || a.index - b.index)
    .map((entry) => entry.row)
}

/**
 * Case-insensitive substring + subsequence score, higher = better; null means
 * "no match". A substring beats a subsequence, the title beats the detail line,
 * and an earlier hit beats a later one; equal scores keep the source order
 * (`rankRows` sorts stably by construction).
 */
export function scoreMatch(query: string, title: string, detail = ''): number | null {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const t = title.toLowerCase()
  const d = detail.toLowerCase()
  const inTitle = t.indexOf(q)
  if (inTitle === 0) return 1000
  if (inTitle > 0) return 900 - Math.min(inTitle, 100)
  const inDetail = d.indexOf(q)
  if (inDetail === 0) return 800
  if (inDetail > 0) return 700 - Math.min(inDetail, 100)
  const titleSpread = subsequenceSpread(q, t)
  if (titleSpread !== null) return 600 - Math.min(titleSpread, 200)
  const detailSpread = subsequenceSpread(q, d)
  if (detailSpread !== null) return 500 - Math.min(detailSpread, 200)
  return null
}

/** how far apart the query's characters sit in `text` when matched in order
 *  (0 = contiguous), or null when they do not all appear in order */
function subsequenceSpread(query: string, text: string): number | null {
  let from = 0
  let spread = 0
  for (const ch of query) {
    const at = text.indexOf(ch, from)
    if (at === -1) return null
    spread += at - from
    from = at + 1
  }
  return spread
}

/** the directory part of a path, both separators honored; '' at the root */
export function folderOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut > 0 ? path.slice(0, cut) : ''
}
