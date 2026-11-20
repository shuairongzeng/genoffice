import { AsyncLocalStorage } from 'node:async_hooks'
import type { ImageContent, TextContent } from '@earendil-works/pi-ai'
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionFactory,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import {
  BROWSER_CLEAR_ANNOTATIONS_TOOL,
  BROWSER_CLICK_TOOL,
  BROWSER_DOWNLOAD_TOOL,
  BROWSER_FILL_FIELD_TOOL,
  BROWSER_GO_BACK_TOOL,
  BROWSER_GO_FORWARD_TOOL,
  BROWSER_LIST_ANNOTATIONS_TOOL,
  BROWSER_PRESS_KEY_TOOL,
  BROWSER_READ_ANNOTATION_SHOT_TOOL,
  BROWSER_READ_PAGE_TOOL,
  BROWSER_RELOAD_TOOL,
  BROWSER_SCREENSHOT_TOOL,
  BROWSER_SCROLL_TOOL,
  BROWSER_WAIT_FOR_TOOL,
  CREATE_DOCUMENT_TOOL,
  DELETE_FILE_TOOL,
  DOCUMENT_AGENT_TOOL,
  EDIT_FILE_TOOL,
  RUN_GENOFFICE_TOOL,
  SHELL_ADD_TODO_TOOL,
  SHELL_CLOSE_TAB_TOOL,
  SHELL_CREATE_FOLDER_TOOL,
  SHELL_LIST_DIRECTORY_TOOL,
  SHELL_MOVE_FILE_TOOL,
  SHELL_NAVIGATE_TOOL,
  SHELL_OPEN_BROWSER_TOOL,
  SHELL_OPEN_FOLDER_TOOL,
  SHELL_OPEN_PATH_TOOL,
  SHELL_RENAME_FILE_TOOL,
  SHELL_STAR_FILE_TOOL,
  SHELL_SWITCH_TAB_TOOL,
  SHELL_UNSTAR_FILE_TOOL,
  SHELL_WRITE_TEXT_FILE_TOOL,
  composeSkills,
  createAttachmentsSkill,
  createBrowserSkill,
  createCliSkill,
  createDocumentAgentSkill,
  createDocumentSkill,
  createFileOpsSkill,
  createKnowledgeBaseSkill,
  createProxiedAppsSkill,
  createShellSkill,
  formatSurfaceSection,
  parseSkillFrontmatter,
  skillContextVars,
  withAttachedSkills,
  type AgentTaskResult,
  type AgentTaskStatus,
  type AgentToolDef,
  type AttachedSkill,
  type AttachmentInfo,
  type BrowserActionResult,
  type BrowserAnnotationShot,
  type BrowserClearAnnotationsResult,
  type BrowserDownloadResult,
  type BrowserPageAnnotation,
  type BrowserPageRead,
  type BrowserScreenshot,
  type BrowserTabSnapshot,
  type CliContext,
  type CreateDocumentRequest,
  type KbFileInfo,
  type KbSearchHit,
  type ProxiedAppManifest,
  type SurfaceTab,
  type SurfaceViewer,
  type ToolDisplay,
  type ToolExecution,
} from '@genoffice/agent-core'
import { readFile } from 'node:fs/promises'
import type { PiDocCheckpoint } from '../../shared/pi-agent-api'
import { STATIC_PROXIED_APP_TOOLS } from '../mcp/app-skill-catalog'
import type { WorkbenchToolsService } from '../workbench-tools-service'

/** Tools whose execution has a visible side effect and must card under paranoid mode. */
export const PARANOID_SIDE_EFFECT_TOOLS: ReadonlySet<string> = new Set([
  CREATE_DOCUMENT_TOOL,
  EDIT_FILE_TOOL,
  DELETE_FILE_TOOL,
  DOCUMENT_AGENT_TOOL,
  RUN_GENOFFICE_TOOL,
  BROWSER_FILL_FIELD_TOOL,
  BROWSER_CLICK_TOOL,
  BROWSER_DOWNLOAD_TOOL,
  BROWSER_CLEAR_ANNOTATIONS_TOOL,
  BROWSER_SCROLL_TOOL,
  BROWSER_GO_BACK_TOOL,
  BROWSER_GO_FORWARD_TOOL,
  BROWSER_RELOAD_TOOL,
  BROWSER_WAIT_FOR_TOOL,
  BROWSER_PRESS_KEY_TOOL,
  SHELL_OPEN_BROWSER_TOOL,
  SHELL_NAVIGATE_TOOL,
  SHELL_SWITCH_TAB_TOOL,
  SHELL_OPEN_PATH_TOOL,
  SHELL_CLOSE_TAB_TOOL,
  SHELL_OPEN_FOLDER_TOOL,
  SHELL_CREATE_FOLDER_TOOL,
  SHELL_WRITE_TEXT_FILE_TOOL,
  SHELL_MOVE_FILE_TOOL,
  SHELL_RENAME_FILE_TOOL,
  SHELL_STAR_FILE_TOOL,
  SHELL_UNSTAR_FILE_TOOL,
  SHELL_ADD_TODO_TOOL,
])

export interface WorkbenchTurnRuntimeState {
  sessionKey: string
  projectId: string
  chatId: string
  viewer: SurfaceViewer
  scopePaths: readonly string[]
  scopeNotIndexed: string[]
  attachments: readonly AttachmentInfo[]
  instruction: string
  corpus: readonly KbFileInfo[]
  surfaceTabs: readonly SurfaceTab[]
  browserTabs: readonly BrowserTabSnapshot[]
  appManifest: ProxiedAppManifest | null
  cliContext: CliContext | null
  docCheckpoints: PiDocCheckpoint[]
  lineageCandidates: Array<{ path: string; task: string }>
  onCheckpoint?: (checkpoint: PiDocCheckpoint) => void
  onDocumentAgentProgress?: (event: { taskId: string; kind: string; status: AgentTaskStatus }) => void
}

export interface GenofficeToolResultDetails {
  readonly summary: string
  readonly mutated?: boolean
  readonly denied?: boolean
  readonly isError?: boolean
  readonly display?: ToolDisplay
  readonly checkpoint?: PiDocCheckpoint
}

/**
 * Coordinates security grants, target pinning, and per-turn runtime context
 * between `genoffice-workbench-extension` and `genoffice-permission-extension`.
 */
export interface WorkbenchExtensionCoord {
  /** Tracks delete_file toolCallIds explicitly permitted by the permission hook. */
  readonly approvedDeleteCallIds: Set<string>
  /** Maps document_agent toolCallId -> tabId captured during permission confirmation. */
  readonly pinnedDocumentTabByCallId: Map<string, string>
  /** Declared risk grades for static GenOffice workbench tools. */
  readonly toolRisks: Map<string, 'low' | 'high' | 'always-ask'>
  /** Associates a Pi internal session id with the owning GenOffice turn state. */
  bindPiSession(piSessionId: string, state: WorkbenchTurnRuntimeState): void
  unbindPiSession(piSessionId: string): void
  setFallbackTurnState(state: WorkbenchTurnRuntimeState | undefined): void
  runWithTurnState<T>(state: WorkbenchTurnRuntimeState, fn: () => Promise<T>): Promise<T>
  resolveTurnState(piSessionId?: string): WorkbenchTurnRuntimeState | undefined
}

export function createWorkbenchExtensionCoord(): WorkbenchExtensionCoord {
  const byPiSessionId = new Map<string, WorkbenchTurnRuntimeState>()
  const als = new AsyncLocalStorage<WorkbenchTurnRuntimeState>()
  let fallbackState: WorkbenchTurnRuntimeState | undefined

  return {
    approvedDeleteCallIds: new Set<string>(),
    pinnedDocumentTabByCallId: new Map<string, string>(),
    toolRisks: new Map<string, 'low' | 'high' | 'always-ask'>(),
    bindPiSession(piSessionId, state) {
      byPiSessionId.set(piSessionId, state)
      fallbackState = state
    },
    unbindPiSession(piSessionId) {
      byPiSessionId.delete(piSessionId)
    },
    setFallbackTurnState(state) {
      fallbackState = state
    },
    runWithTurnState(state, fn) {
      fallbackState = state
      return als.run(state, fn)
    },
    resolveTurnState(piSessionId) {
      const store = als.getStore()
      if (store) return store
      if (piSessionId) {
        const mapped = byPiSessionId.get(piSessionId)
        if (mapped) return mapped
      }
      return fallbackState
    },
  }
}

interface ActiveCallContext {
  toolCallId: string
}

const activeCallAls = new AsyncLocalStorage<ActiveCallContext>()

const SENTINEL_CORPUS: readonly KbFileInfo[] = [
  {
    name: '__sentinel__.md',
    folder: '',
    ext: 'md',
    sizeBytes: 0,
    path: '/__sentinel__.md',
  },
]
const SENTINEL_BROWSER_TABS: readonly BrowserTabSnapshot[] = [
  { id: '__sentinel__', title: '__sentinel__', active: true },
]
const SENTINEL_APP_MANIFEST: ProxiedAppManifest = {
  windows: [],
  tools: [...STATIC_PROXIED_APP_TOOLS],
}

function buildStaticCatalogSkill() {
  const noop = async () => {
    throw new Error('Static catalog skill is non-executable')
  }
  return composeSkills('home-ask', '', [
    createKnowledgeBaseSkill({
      listFiles: () => [...SENTINEL_CORPUS],
      search: noop,
      read: noop,
    }),
    createAttachmentsSkill({
      list: () => [],
      read: noop,
      pathsInContext: true,
    }),
    createDocumentSkill({
      create: noop,
      alsoSaves: [RUN_GENOFFICE_TOOL],
    }),
    createFileOpsSkill({
      editFile: noop,
      deleteFile: noop,
    }),
    createDocumentAgentSkill({
      runAgentTask: noop,
    }),
    createCliSkill({
      context: () => null,
      run: noop,
    }),
    createProxiedAppsSkill({
      manifest: () => SENTINEL_APP_MANIFEST,
      execute: noop,
    }),
    createBrowserSkill({
      openTabs: () => SENTINEL_BROWSER_TABS,
      readPage: noop,
      screenshotPage: noop,
      readAnnotationShot: noop,
      fillField: noop,
      clickElement: noop,
      scrollPage: noop,
      downloadFile: noop,
      navigateHistory: noop,
      waitFor: noop,
      pressKey: noop,
      listAnnotations: noop,
      clearAnnotations: noop,
    }),
    createShellSkill({
      surfaceTabs: () => [],
      viewer: 'home',
      execute: noop,
    }),
  ])
}

function buildExecutableWorkbenchSkill(
  workbench: WorkbenchToolsService,
  coord: WorkbenchExtensionCoord,
  getState: () => WorkbenchTurnRuntimeState | undefined,
) {
  const browserBridge = (tool: string, input: Record<string, unknown>, skipMainConfirm: boolean) =>
    workbench.executeBrowserSkill(tool, input, { skipMainConfirm })

  const docSkill = createDocumentSkill({
    create: (request: CreateDocumentRequest) =>
      workbench.createDocument(request) as Promise<{ path: string }>,
    alsoSaves: [RUN_GENOFFICE_TOOL],
  })

  const cliSkill = createCliSkill({
    context: () => getState()?.cliContext ?? null,
    run: (request) => {
      const state = getState()
      const chatId = state?.chatId || state?.sessionKey || 'pi-ask'
      const sources = (state?.attachments ?? []).map((a) => a.path)
      return workbench.runCli(chatId, {
        ...request,
        sources,
      }) as ReturnType<Parameters<typeof createCliSkill>[0]['run']>
    },
  })

  const filesSkill = createAttachmentsSkill({
    list: () => getState()?.attachments ?? [],
    read: async (path, offset, maxChars) => {
      const result = await workbench.readAttachment(path, offset, maxChars)
      if (!result.ok) throw new Error(result.error ?? 'read failed')
      return {
        text: result.text ?? '',
        totalChars: result.totalChars ?? 0,
        offset: result.offset ?? 0,
      }
    },
    pathsInContext: true,
  })

  const fileOpsSkill = createFileOpsSkill({
    editFile: (request) =>
      workbench.editFile({
        path: request.path,
        old_string: request.oldString,
        new_string: request.newString,
        ...(request.replaceAll ? { replace_all: true } : {}),
      }) as ReturnType<Parameters<typeof createFileOpsSkill>[0]['editFile']>,
    deleteFile: async (path) => {
      const callId = activeCallAls.getStore()?.toolCallId
      if (!callId || !coord.approvedDeleteCallIds.delete(callId)) {
        throw new Error('delete refused: this call was not authorized by the confirmation gate')
      }
      return (await workbench.deleteFile({ path, confirmed: true })) as { path: string }
    },
  })

  const documentAgentSkill = createDocumentAgentSkill({
    runAgentTask: (task) => {
      const state = getState()
      const callId = activeCallAls.getStore()?.toolCallId
      const expectedTabId = callId ? coord.pinnedDocumentTabByCallId.get(callId) : undefined
      if (callId) coord.pinnedDocumentTabByCallId.delete(callId)
      const callerKey = state ? `pi:${state.sessionKey}` : 'main'
      return workbench.runDocumentAgent(
        { task, ...(expectedTabId ? { expectedTabId } : {}) },
        state?.onDocumentAgentProgress,
        callerKey,
      )
    },
    cancelAgentTask: () => {
      const state = getState()
      const callerKey = state ? `pi:${state.sessionKey}` : 'main'
      workbench.cancelDocumentAgent(callerKey)
    },
    onTaskResult: (result: AgentTaskResult) => {
      const state = getState()
      if (!state || !result.ok || !result.checkpointId || !result.tabId) return
      const editCount = result.edits?.length ?? 0
      if (editCount === 0) return
      const summary = state.instruction.trim().replace(/\s+/g, ' ').slice(0, 60)
      const checkpoint: PiDocCheckpoint = {
        tabId: result.tabId,
        kind: result.kind ?? 'docs',
        title: result.title ?? '',
        checkpointId: result.checkpointId,
        editCount,
        createdAt: Date.now(),
        ...(summary ? { summary } : {}),
      }
      state.docCheckpoints.push(checkpoint)
      state.onCheckpoint?.(checkpoint)
    },
  })

  const appSkill = createProxiedAppsSkill({
    manifest: () => getState()?.appManifest ?? SENTINEL_APP_MANIFEST,
    execute: (tool, input) => workbench.executeAppSkill(tool, input),
  })

  const browserSkill = createBrowserSkill({
    openTabs: () => getState()?.browserTabs ?? [],
    readPage: () => browserBridge(BROWSER_READ_PAGE_TOOL, {}, false) as Promise<BrowserPageRead>,
    screenshotPage: () =>
      browserBridge(BROWSER_SCREENSHOT_TOOL, {}, false) as Promise<BrowserScreenshot>,
    readAnnotationShot: (id) =>
      browserBridge(
        BROWSER_READ_ANNOTATION_SHOT_TOOL,
        { id },
        false,
      ) as Promise<BrowserAnnotationShot | null>,
    fillField: (selector, value) =>
      browserBridge(
        BROWSER_FILL_FIELD_TOOL,
        { selector, value, confirmed: true },
        true,
      ) as Promise<BrowserActionResult>,
    clickElement: (selector) =>
      browserBridge(
        BROWSER_CLICK_TOOL,
        { selector, confirmed: true },
        true,
      ) as Promise<BrowserActionResult>,
    scrollPage: (direction, amount, selector) =>
      browserBridge(
        BROWSER_SCROLL_TOOL,
        {
          ...(direction !== undefined ? { direction } : {}),
          ...(amount !== undefined ? { amount } : {}),
          ...(selector !== undefined ? { selector } : {}),
        },
        true,
      ) as Promise<BrowserActionResult>,
    downloadFile: (url, selector) =>
      browserBridge(
        BROWSER_DOWNLOAD_TOOL,
        {
          ...(url !== undefined ? { url } : {}),
          ...(selector !== undefined ? { selector } : {}),
        },
        true,
      ) as Promise<BrowserDownloadResult>,
    navigateHistory: (action) =>
      browserBridge(
        action === 'back'
          ? BROWSER_GO_BACK_TOOL
          : action === 'forward'
            ? BROWSER_GO_FORWARD_TOOL
            : BROWSER_RELOAD_TOOL,
        {},
        true,
      ) as Promise<BrowserActionResult>,
    waitFor: (selector, timeoutMs) =>
      browserBridge(
        BROWSER_WAIT_FOR_TOOL,
        {
          ...(selector !== undefined ? { selector } : {}),
          timeoutMs,
        },
        true,
      ) as Promise<BrowserActionResult>,
    pressKey: (key) =>
      browserBridge(BROWSER_PRESS_KEY_TOOL, { key }, true) as Promise<BrowserActionResult>,
    listAnnotations: () =>
      browserBridge(BROWSER_LIST_ANNOTATIONS_TOOL, {}, false) as Promise<BrowserPageAnnotation[]>,
    clearAnnotations: (url) =>
      browserBridge(
        BROWSER_CLEAR_ANNOTATIONS_TOOL,
        { ...(url !== undefined ? { url } : {}) },
        true,
      ) as Promise<BrowserClearAnnotationsResult>,
  })

  const shellSkill = createShellSkill({
    surfaceTabs: () => getState()?.surfaceTabs ?? [],
    viewer: () => getState()?.viewer ?? 'home',
    execute: (tool, input) => browserBridge(tool, input, true),
    onBrowserTabOpened: (tabId) => {
      const state = getState()
      if (!state) return
      if (!state.browserTabs.some((t) => t.id === tabId)) {
        state.browserTabs = [...state.browserTabs, { id: tabId, title: '', active: true }]
      }
    },
  })

  const kbSkill = createKnowledgeBaseSkill({
    listFiles: () => [...(getState()?.corpus ?? [])],
    search: async (query, limit, opts) => {
      const state = getState()
      const scopePaths = opts?.scopePaths ?? []
      const raw = await workbench.kbSearch(
        scopePaths.length > 0 ? { q: query, limit, onlyPaths: [...scopePaths] } : { q: query, limit },
      )
      if (Array.isArray(raw)) return raw as KbSearchHit[]
      const scoped = (raw ?? {}) as { hits?: KbSearchHit[]; notIndexed?: string[] }
      if (state && Array.isArray(scoped.notIndexed)) {
        state.scopeNotIndexed = [...scoped.notIndexed]
      }
      return Array.isArray(scoped.hits) ? scoped.hits : []
    },
    read: (path, offset, opts) =>
      workbench.kbRead({
        path,
        offset,
        ...(opts?.scopePaths?.length ? { onlyPaths: [...opts.scopePaths] } : {}),
      }) as ReturnType<Parameters<typeof createKnowledgeBaseSkill>[0]['read']>,
    scopePaths: () => getState()?.scopePaths ?? [],
    alsoCitable: () => [
      ...docSkill.createdPaths(),
      ...cliSkill.createdPaths(),
      ...(getState()?.attachments ?? []).map((a) => a.path),
    ],
  })

  return composeSkills('home-ask', '', [
    kbSkill,
    filesSkill,
    docSkill,
    fileOpsSkill,
    documentAgentSkill,
    cliSkill,
    appSkill,
    browserSkill,
    shellSkill,
  ])
}

/**
 * Snapshot static tool schemas and static system guidance once so Pi's system
 * prompt stays byte-identical across turns (preserving Magic Context M0 cache).
 */
const STATIC_CATALOG = buildStaticCatalogSkill()
export const STATIC_WORKBENCH_SYSTEM_PROMPT = STATIC_CATALOG.systemPrompt

function buildStaticToolRiskMap(): Map<string, 'low' | 'high' | 'always-ask'> {
  const map = new Map<string, 'low' | 'high' | 'always-ask'>()
  for (const tool of STATIC_CATALOG.tools) {
    const base = tool.risk ?? 'low'
    map.set(
      tool.name,
      base === 'low' && PARANOID_SIDE_EFFECT_TOOLS.has(tool.name) ? 'high' : base,
    )
  }
  return map
}

function mapToolExecutionToPiResult(
  execution: ToolExecution,
  checkpoint?: PiDocCheckpoint,
): AgentToolResult<GenofficeToolResultDetails> {
  const content: (TextContent | ImageContent)[] = [
    { type: 'text', text: execution.output || '' },
  ]
  if (execution.images && execution.images.length > 0) {
    for (const img of execution.images) {
      content.push({
        type: 'image',
        data: img.base64,
        mimeType: img.mime,
      })
    }
  }
  const details: GenofficeToolResultDetails = {
    summary: execution.summary,
    ...(execution.mutated !== undefined ? { mutated: execution.mutated } : {}),
    ...(execution.denied !== undefined ? { denied: execution.denied } : {}),
    ...(execution.isError !== undefined ? { isError: execution.isError } : {}),
    ...(execution.display ? { display: execution.display } : {}),
    ...(checkpoint ? { checkpoint } : {}),
  }
  return {
    content,
    details,
    ...(execution.isError ? { isError: true } : {}),
  }
}

export interface TurnWorkbenchContextResult {
  readonly state: WorkbenchTurnRuntimeState
  /** Dynamic per-turn context + prompt prefix ready to submit to `session.prompt`. */
  readonly outboundPrompt: string
}

/**
 * Refresh live workbench state for a turn and produce the dynamic context
 * prefix placed before the user prompt (never inside the system prompt).
 */
export async function prepareTurnWorkbenchState(
  workbench: WorkbenchToolsService,
  coord: WorkbenchExtensionCoord,
  input: {
    sessionKey: string
    projectId: string
    chatId: string
    viewer: SurfaceViewer
    scopePaths: readonly string[]
    attachments: readonly AttachmentInfo[]
    instruction: string
    lineageSeed?: string | null
    lang?: string
    skillFilePaths?: readonly string[]
    onCheckpoint?: (checkpoint: PiDocCheckpoint) => void
    onDocumentAgentProgress?: (event: { taskId: string; kind: string; status: AgentTaskStatus }) => void
  },
): Promise<TurnWorkbenchContextResult> {
  const [rawCorpus, rawSurfaceTabs, rawBrowserTabs, appManifest] = await Promise.all([
    workbench.kbList().catch(() => []),
    workbench.listSurfaceTabs().catch(() => []),
    workbench.listBrowserTabs().catch(() => []),
    workbench.getAppSkillManifest().catch(() => null),
  ])

  const state: WorkbenchTurnRuntimeState = {
    sessionKey: input.sessionKey,
    projectId: input.projectId,
    chatId: input.chatId,
    viewer: input.viewer,
    scopePaths: [...input.scopePaths],
    scopeNotIndexed: [],
    attachments: [...input.attachments],
    instruction: input.instruction,
    corpus: Array.isArray(rawCorpus) ? (rawCorpus as KbFileInfo[]) : [],
    surfaceTabs: Array.isArray(rawSurfaceTabs) ? (rawSurfaceTabs as SurfaceTab[]) : [],
    browserTabs: Array.isArray(rawBrowserTabs)
      ? (rawBrowserTabs as BrowserTabSnapshot[]).map((b) => ({
          id: b.id,
          title: b.title ?? '',
          active: Boolean(b.active),
        }))
      : [],
    appManifest,
    cliContext: workbench.cliContext(input.chatId || input.sessionKey) as CliContext | null,
    docCheckpoints: [],
    lineageCandidates: [],
    onCheckpoint: input.onCheckpoint,
    onDocumentAgentProgress: input.onDocumentAgentProgress,
  }

  const ephemeralSkill = buildExecutableWorkbenchSkill(workbench, coord, () => state)
  const sections: string[] = []

  const surfaceSection = formatSurfaceSection(state.surfaceTabs, state.viewer)
  if (surfaceSection) sections.push(surfaceSection)

  const skillCtx = ephemeralSkill.buildContext?.() ?? ''
  if (skillCtx.trim()) sections.push(skillCtx.trim())

  if (state.scopePaths.length > 0) {
    sections.push(
      `## Round corpus selection\nThis turn is explicitly scoped to ${state.scopePaths.length} selected file(s):\n` +
        state.scopePaths.map((p) => `- ${p}`).join('\n'),
    )
  }

  const attachedSkills: AttachedSkill[] = []
  if (input.skillFilePaths && input.skillFilePaths.length > 0) {
    for (const filePath of input.skillFilePaths) {
      try {
        const rawSkill = await readFile(filePath, 'utf8')
        const parsed = parseSkillFrontmatter(rawSkill)
        const name =
          parsed?.name || filePath.split(/[\\/]/).slice(-2, -1)[0] || filePath
        attachedSkills.push({ name, body: parsed?.body ?? rawSkill })
      } catch {
        // Ignore unreadable optional attached skill files.
      }
    }
  }

  const questionCore = input.lineageSeed
    ? `${input.lineageSeed}\n${input.instruction}`
    : input.instruction

  const promptWithSkills =
    attachedSkills.length > 0
      ? withAttachedSkills(
          questionCore,
          attachedSkills,
          skillContextVars({
            lang: input.lang ?? 'zh',
            app: 'GenOffice',
          }),
        )
      : questionCore

  const contextHeader =
    sections.length > 0
      ? `<workbench_context>\n${sections.join('\n\n')}\n</workbench_context>\n\n`
      : ''

  return {
    state,
    outboundPrompt: `${contextHeader}${promptWithSkills}`,
  }
}

/**
 * Create a Pi ExtensionFactory exposing all 9 GenOffice workbench tool domains
 * with a byte-stable system prompt and live per-session state resolution.
 */
export function createGenofficeWorkbenchExtension(
  workbench: WorkbenchToolsService,
  coord: WorkbenchExtensionCoord,
): ExtensionFactory {
  const declaredRisks = buildStaticToolRiskMap()
  for (const [name, grade] of declaredRisks) {
    coord.toolRisks.set(name, grade)
  }

  return (pi: ExtensionAPI) => {
    pi.on('before_agent_start', (event) => {
      if (!STATIC_WORKBENCH_SYSTEM_PROMPT.trim()) return undefined
      return {
        systemPrompt: event.systemPrompt
          ? `${event.systemPrompt}\n\n${STATIC_WORKBENCH_SYSTEM_PROMPT}`
          : STATIC_WORKBENCH_SYSTEM_PROMPT,
      }
    })

    for (const toolDef of STATIC_CATALOG.tools) {
      const riskGrade = coord.toolRisks.get(toolDef.name) ?? 'low'
      const piTool: ToolDefinition<ToolDefinition['parameters'], GenofficeToolResultDetails> = {
        name: toolDef.name,
        label: toolDef.name,
        description: toolDef.description,
        parameters: toolDef.inputSchema as unknown as ToolDefinition['parameters'],
        annotations:
          riskGrade === 'low'
            ? { readOnlyHint: true }
            : toolDef.name === DELETE_FILE_TOOL
              ? { readOnlyHint: false, destructiveHint: true }
              : { readOnlyHint: false, destructiveHint: false },
        execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
          const piSessionId = ctx.sessionManager.getSessionId()
          const state = coord.resolveTurnState(piSessionId)
          const checkpointsBefore = state?.docCheckpoints.length ?? 0
          const liveSkill = buildExecutableWorkbenchSkill(workbench, coord, () =>
            coord.resolveTurnState(piSessionId),
          )
          const execution = await activeCallAls.run({ toolCallId }, () =>
            liveSkill.executeTool(
              {
                id: toolCallId,
                name: toolDef.name,
                input: (params ?? {}) as Record<string, unknown>,
              },
              signal,
            ),
          )

          if (
            state &&
            (toolDef.name === CREATE_DOCUMENT_TOOL || toolDef.name === RUN_GENOFFICE_TOOL) &&
            !execution.isError
          ) {
            const pathMatch = /^\s*(?:path|output_path): (.+)$/m.exec(execution.output)?.[1]?.trim()
            if (pathMatch) {
              state.lineageCandidates.push({ path: pathMatch, task: state.instruction })
            }
          }

          const latestCheckpoint =
            state && state.docCheckpoints.length > checkpointsBefore
              ? state.docCheckpoints[state.docCheckpoints.length - 1]
              : undefined

          return mapToolExecutionToPiResult(execution, latestCheckpoint)
        },
      }
      pi.registerTool(piTool)
    }
  }
}

export function getStaticWorkbenchToolDefs(): readonly AgentToolDef[] {
  return STATIC_CATALOG.tools
}
