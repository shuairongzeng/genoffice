import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  ATTACHMENT_IMAGE_EXTS,
  type AgentTaskStatus,
  type AgentToolCall,
  type ToolExecution,
} from '@genoffice/agent-core'
import type { AiSettings } from '@genoffice/ai-provider'
import { endpointSupportsVision } from '@genoffice/ai-provider/browser'
import type { ProjectStore } from '@genoffice/project-store'
import type { ImageContent } from '@earendil-works/pi-ai'
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionCommandContextActions,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import type { AiPermissionMode } from '@genoffice/ui/ai-permission-mode'

import {
  type PiAgentCommandInfo,
  type PiAgentConfirmReply,
  type PiAgentConfirmRequest,
  type PiAgentNoticePayload,
  type PiAgentPromptRequest,
  type PiAgentPromptResult,
  type PiAgentStatusPayload,
} from '../../shared/pi-agent-api'
import type { PiAgentPrefs } from '../../shared/pi-agent-prefs'
import type { AiSessionAllows } from '../ai-session-allows'
import { appendButlerPersona } from '../butler/butler-persona'
import {
  beginPiRunInMain,
  broadcastAskRunEventFromMain,
  finishPiRunInMain,
  markPiAssistantPersistedInMain,
  markPiUserPersistedInMain,
  setPiConfirmInMain,
} from '../home-tabs-ipc'
import { skillsRoot } from '../imported-skills'
import type { WorkbenchToolsService } from '../workbench-tools-service'
import {
  createGenofficePermissionExtension,
  type ConfirmPromptResponse,
} from './genoffice-permission-extension'
import {
  GENOFFICE_PI_SYSTEM_PROMPT,
  createGenofficeWorkbenchExtension,
  createWorkbenchExtensionCoord,
  prepareTurnWorkbenchState,
  type GenofficeToolResultDetails,
  type WorkbenchExtensionCoord,
  type WorkbenchTurnRuntimeState,
} from './genoffice-workbench-extension'
import { resolvePiRuntimePaths, type PiRuntimePaths } from './pi-agent-paths'
import { readMagicContextStats } from './pi-memory-store'
import { syncPiProviderAndMagicContextConfig } from './pi-provider-sync'
import {
  applyPiRuntimeEnv,
  ensurePiSubagentShim,
  installPiSubagentSpawnHook,
} from './pi-subagent-shim'

const MAX_CACHED_SESSIONS = 8
const BACKFILL_MESSAGE_LIMIT = 40
const COMMAND_WAIT_IDLE_MS = 10_000

const dynamicImportEsm = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<typeof import('@earendil-works/pi-coding-agent')>

/** Strip Magic Context `§N§ ` ordinal prefixes idempotently at line starts. */
export function stripOrdinalPrefix(text: string): string {
  return text.replace(/(^|\n)§\d+§ ?/g, '$1')
}

export interface OrdinalPrefixStripper {
  push(chunk: string): string
  flush(): string
}

/**
 * Streaming filter that suppresses `§N§ ` ordinal tags emitted by models using
 * Magic Context even when the tag is split across arbitrary SSE token chunks.
 */
export function createOrdinalPrefixStripper(): OrdinalPrefixStripper {
  let atLineStart = true
  let pending = ''

  const consumeChunk = (input: string, isEnd: boolean): string => {
    let out = ''
    let idx = 0
    const s = pending + input
    pending = ''

    while (idx < s.length) {
      if (!atLineStart) {
        const nl = s.indexOf('\n', idx)
        if (nl === -1) {
          out += s.slice(idx)
          idx = s.length
        } else {
          out += s.slice(idx, nl + 1)
          idx = nl + 1
          atLineStart = true
        }
        continue
      }

      const rest = s.slice(idx)
      if (!rest.startsWith('§')) {
        const nl = rest.indexOf('\n')
        if (nl === -1) {
          out += rest
          idx = s.length
          atLineStart = false
        } else {
          out += rest.slice(0, nl + 1)
          idx += nl + 1
          atLineStart = true
        }
        continue
      }

      // Check for complete `§<digits>§ ` or `§<digits>§\n` / `§<digits>§<non-space>`
      const fullSpaceMatch = /^§\d+§ /.exec(rest)
      if (fullSpaceMatch) {
        idx += fullSpaceMatch[0].length
        atLineStart = false
        continue
      }

      const fullNoSpaceMatch = /^§\d+§(?=[^\d ]|$)/.exec(rest)
      if (fullNoSpaceMatch) {
        // Wait if right at chunk end so an upcoming single space is also stripped.
        if (!isEnd && fullNoSpaceMatch[0].length === rest.length) {
          pending = rest
          break
        }
        idx += fullNoSpaceMatch[0].length
        atLineStart = false
        continue
      }

      // Potential incomplete prefix while streaming: `§`, `§12`
      if (!isEnd && /^§\d*$/.test(rest)) {
        pending = rest
        break
      }

      // Check if an immediate newline finishes without closing § (literal text)
      out += '§'
      idx += 1
      atLineStart = false
    }

    return out
  }

  return {
    push: (chunk) => consumeChunk(chunk, false),
    flush: () => consumeChunk('', true),
  }
}

export { GENOFFICE_PI_SYSTEM_PROMPT }

/**
 * Resolve the base Pi system preamble following explicit precedence:
 * 1) user-configured prompt in Settings,
 * 2) user-supplied `SYSTEM.md` override on disk,
 * 3) GenOffice's built-in desktop assistant prompt.
 */
export function resolveGenofficeSystemPrompt(
  base: string | undefined,
  configuredPrompt?: string,
): string {
  const configured = typeof configuredPrompt === 'string' ? configuredPrompt.trim() : ''
  if (configured.length > 0) {
    return configured
  }
  if (typeof base === 'string' && base.trim().length > 0) {
    return base
  }
  return GENOFFICE_PI_SYSTEM_PROMPT
}

/**
 * Filter Pi-discovered context files (`AGENTS.md` / `CLAUDE.md`) down to those
 * living inside GenOffice's dedicated `agentDir`, blocking repository ancestor
 * instructions from leaking into the office assistant prompt.
 */
export function filterAgentContextFiles<T extends { path: string }>(
  files: readonly T[],
  agentDir: string,
): T[] {
  const normalize = (p: string): string => {
    const resolved = resolve(p)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  const root = normalize(agentDir)
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  return files.filter((file) => {
    const target = normalize(file.path)
    return target === root || target.startsWith(prefix)
  })
}

export function buildExcludeBuiltinTools(
  prefs: Pick<PiAgentPrefs, 'enablePiReadTools' | 'enablePiWriteTools'>,
): string[] {
  const excluded: string[] = []
  if (!prefs.enablePiReadTools) {
    excluded.push('read', 'grep', 'find', 'ls')
  }
  if (!prefs.enablePiWriteTools) {
    excluded.push('bash', 'powershell', 'edit', 'write')
  }
  return excluded
}

/**
 * Compute the incremental reasoning chunk to emit over `ask:run-event`,
 * inserting a paragraph break after a tool call when prior reasoning existed.
 */
export function advanceReasoningDelta(
  state: { accumulatedReasoning: string; reasoningNeedsBreak: boolean },
  delta: string,
): string {
  if (!delta) return ''
  let breakPrefix = ''
  if (
    state.reasoningNeedsBreak &&
    state.accumulatedReasoning.length > 0 &&
    !state.accumulatedReasoning.endsWith('\n\n')
  ) {
    breakPrefix = state.accumulatedReasoning.endsWith('\n') ? '\n' : '\n\n'
  }
  state.reasoningNeedsBreak = false
  const deltaChunk = `${breakPrefix}${delta}`
  state.accumulatedReasoning += deltaChunk
  return deltaChunk
}

/** Extract single-message token usage delta for renderer-side accumulation. */
export function messageUsageDelta(usage: { input?: number; output?: number }): {
  inputTokens: number
  outputTokens: number
} {
  return {
    inputTokens: usage.input ?? 0,
    outputTokens: usage.output ?? 0,
  }
}

export interface PiTextAccumState {
  currentMsgCleanText: string
  accumulatedCleanText: string
  textNeedsBreak: boolean
}

/**
 * Append cleaned text from one assistant message chunk, maintaining both the
 * cross-turn transcript (`accumulatedCleanText` for persistence) and the
 * per-message stream text (`currentMsgCleanText` broadcast as `text` events).
 */
export function appendPiCleanText(state: PiTextAccumState, chunk: string): string {
  if (!chunk) return state.currentMsgCleanText
  if (state.textNeedsBreak && !state.accumulatedCleanText.endsWith('\n\n')) {
    state.accumulatedCleanText += state.accumulatedCleanText.endsWith('\n') ? '\n' : '\n\n'
  }
  state.textNeedsBreak = false
  state.currentMsgCleanText += chunk
  state.accumulatedCleanText += chunk
  return state.currentMsgCleanText
}

export class SessionMapStore {
  private readonly path: string
  private entries = new Map<string, string>()

  constructor(sessionMapPath: string) {
    this.path = sessionMapPath
    this.load()
  }

  private load(): void {
    this.entries.clear()
    if (!existsSync(this.path)) return
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as {
        entries?: Record<string, unknown>
      }
      if (parsed && typeof parsed.entries === 'object' && parsed.entries) {
        for (const [key, val] of Object.entries(parsed.entries)) {
          if (typeof val === 'string' && val.trim()) {
            this.entries.set(key, val)
          }
        }
      }
    } catch {
      // Corrupt map falls back to empty cleanly.
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp-${process.pid}`
    const payload = {
      version: 1,
      entries: Object.fromEntries(this.entries.entries()),
    }
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    renameSync(tmp, this.path)
  }

  get(sessionKey: string): string | undefined {
    const target = this.entries.get(sessionKey)
    if (!target) return undefined
    if (!existsSync(target)) {
      this.entries.delete(sessionKey)
      this.save()
      return undefined
    }
    return target
  }

  set(sessionKey: string, sessionFile: string): void {
    if (!sessionFile) return
    if (this.entries.get(sessionKey) === sessionFile) return
    this.entries.set(sessionKey, sessionFile)
    this.save()
  }

  rebind(oldKey: string, newKey: string): string | undefined {
    if (oldKey === newKey) return this.entries.get(oldKey)
    const existing = this.entries.get(oldKey)
    if (!existing) return undefined
    this.entries.delete(oldKey)
    this.entries.set(newKey, existing)
    this.save()
    return existing
  }

  delete(sessionKey: string): string | undefined {
    const existing = this.entries.get(sessionKey)
    if (!existing) return undefined
    this.entries.delete(sessionKey)
    this.save()
    return existing
  }

  has(sessionKey: string): boolean {
    return this.get(sessionKey) !== undefined
  }
}

export interface PiRuntimeManagerDeps {
  readonly userDataDir: string
  readonly getDefaultWorkingDir: () => string
  readonly isPackaged: boolean
  readonly resourcesPath?: string
  readonly execPath?: string
  readonly appRoot?: string
  readonly getPrefs: () => PiAgentPrefs
  readonly getAiSettings: () => AiSettings
  readonly getGskApiKey: () => string
  readonly getPermissionMode: () => AiPermissionMode
  readonly sessionAllows: AiSessionAllows
  readonly workbench: WorkbenchToolsService
  readonly getProjectStore: () => ProjectStore | null
  readonly sendConfirmRequest: (request: PiAgentConfirmRequest) => void
  readonly sendStatusEvent: (status: PiAgentStatusPayload) => void
  readonly sendNoticeEvent: (notice: PiAgentNoticePayload) => void
  readonly resolveSkillPathsByName?: (names: readonly string[]) => readonly string[]
  readonly getPersonaSection?: () => string
}

interface CachedSessionRecord {
  readonly sessionKey: string
  readonly session: AgentSession
  readonly coord: ReturnType<typeof createWorkbenchExtensionCoord>
  readonly lastModelRef: string
  readonly prefsKey: string
  busy: boolean
}

interface ActivePromptRun {
  readonly sessionKey: string
  readonly req: PiAgentPromptRequest
  readonly turnState: WorkbenchTurnRuntimeState
  stripper: OrdinalPrefixStripper
  readonly rawTextChunks: string[]
  readonly capturedNotices: string[]
  readonly capturedCustomTexts: string[]
  readonly toolCallsById: Map<string, AgentToolCall>
  accumulatedCleanText: string
  currentMsgCleanText: string
  textNeedsBreak: boolean
  accumulatedReasoning: string
  reasoningNeedsBreak: boolean
  aborted: boolean
  userPersisted: boolean
  assistantStarted: boolean
  usageTotals: { input: number; output: number }
}

function resolveBundledSkillDirs(opts: {
  userDataDir: string
  isPackaged: boolean
  resourcesPath?: string
  appRoot?: string
}): string[] {
  const dirs: string[] = []
  const userSkills = skillsRoot(opts.userDataDir)
  if (existsSync(userSkills)) dirs.push(userSkills)

  const candidates = [
    ...(opts.isPackaged && opts.resourcesPath
      ? [join(opts.resourcesPath, 'cli', 'skills', 'genoffice')]
      : []),
    ...(opts.appRoot ? [join(opts.appRoot, '..', 'skills', 'genoffice')] : []),
    join(process.cwd(), 'skills', 'genoffice'),
    join(process.cwd(), '..', '..', 'skills', 'genoffice'),
  ]
  for (const dir of candidates) {
    if (existsSync(join(dir, 'SKILL.md'))) {
      dirs.push(dir)
      break
    }
  }
  return dirs
}

export function prefsReloadKey(prefs: PiAgentPrefs, storageMode: string, persona = ''): string {
  return JSON.stringify([
    prefs.magicContextEnabled,
    storageMode,
    prefs.enablePiReadTools,
    prefs.enablePiWriteTools,
    prefs.temporalAwareness,
    prefs.autoSearchHints,
    prefs.dreamerEnabled,
    prefs.embeddingMode,
    prefs.historianModel,
    prefs.dreamerModel,
    prefs.systemPrompt,
    persona,
  ])
}

export class PiAgentRuntimeManager {
  private readonly deps: PiRuntimeManagerDeps
  private readonly cache = new Map<string, CachedSessionRecord>()
  private readonly activeRuns = new Map<string, ActivePromptRun>()
  private readonly pendingConfirms = new Map<
    string,
    { sessionKey: string; resolve: (reply: ConfirmPromptResponse) => void }
  >()
  private sessionMap: SessionMapStore | null = null
  private piSdkPromise: Promise<typeof import('@earendil-works/pi-coding-agent')> | null = null
  private cachedCommands: PiAgentCommandInfo[] = []
  private cachedSkillFileByName = new Map<string, string>()
  private uninstallSpawnHook: (() => void) | null = null

  constructor(deps: PiRuntimeManagerDeps) {
    this.deps = deps
  }

  getPaths(): PiRuntimePaths {
    const prefs = this.deps.getPrefs()
    return resolvePiRuntimePaths({
      userDataDir: this.deps.userDataDir,
      storageMode: prefs.magicContextStorageMode,
      isPackaged: this.deps.isPackaged,
      resourcesPath: this.deps.resourcesPath,
    })
  }

  private getSessionMap(paths: PiRuntimePaths): SessionMapStore {
    if (!this.sessionMap) {
      this.sessionMap = new SessionMapStore(paths.sessionMapPath)
    }
    return this.sessionMap
  }

  /**
   * Ensure Electron Node shims, spawn hooks, env vars, and provider/Magic Context
   * configuration files are synced before dynamically loading Pi SDK or Magic Context.
   */
  syncEnvironmentAndConfig(): {
    paths: PiRuntimePaths
    prefs: PiAgentPrefs
    modelSpec: ReturnType<typeof syncPiProviderAndMagicContextConfig>
  } {
    const prefs = this.deps.getPrefs()
    const paths = this.getPaths()
    const execPath = this.deps.execPath ?? process.execPath

    ensurePiSubagentShim({
      binDir: paths.binDir,
      execPath,
      piCliPath: paths.piCliPath,
      agentDir: paths.agentDir,
      storageMode: prefs.magicContextStorageMode,
      magicContextStorageDir: paths.magicContextStorageDir,
      isolatedXdgConfigHome: paths.isolatedXdgConfigHome,
      runtimeModulesDir: paths.runtimeModulesDir,
    })

    applyPiRuntimeEnv({
      binDir: paths.binDir,
      agentDir: paths.agentDir,
      storageMode: prefs.magicContextStorageMode,
      magicContextStorageDir: paths.magicContextStorageDir,
      isolatedXdgConfigHome: paths.isolatedXdgConfigHome,
      runtimeModulesDir: paths.runtimeModulesDir,
    })

    this.uninstallSpawnHook = installPiSubagentSpawnHook({
      execPath,
      piCliPath: paths.piCliPath,
      agentDir: paths.agentDir,
      storageMode: prefs.magicContextStorageMode,
      magicContextStorageDir: paths.magicContextStorageDir,
      isolatedXdgConfigHome: paths.isolatedXdgConfigHome,
      runtimeModulesDir: paths.runtimeModulesDir,
    })

    const settings = this.deps.getAiSettings()
    const gskKey = this.deps.getGskApiKey()
    const modelSpec = syncPiProviderAndMagicContextConfig(paths, settings, prefs, gskKey)

    return { paths, prefs, modelSpec }
  }

  private async loadPiSdk(paths: PiRuntimePaths) {
    if (!this.piSdkPromise) {
      const entryUrl = pathToFileURL(paths.piCodingAgentEntry).href
      this.piSdkPromise = dynamicImportEsm(entryUrl)
    }
    return this.piSdkPromise
  }

  private evictOldestIfNeeded(): void {
    while (this.cache.size >= MAX_CACHED_SESSIONS) {
      let victimKey: string | undefined
      for (const [key, rec] of this.cache) {
        if (!rec.busy && !this.activeRuns.has(key)) {
          victimKey = key
          break
        }
      }
      if (!victimKey) break
      const victim = this.cache.get(victimKey)
      this.cache.delete(victimKey)
      try {
        victim?.session.dispose()
      } catch {
        // Ignore disposal errors during eviction.
      }
    }
  }

  private touchCache(key: string, rec: CachedSessionRecord): void {
    this.cache.delete(key)
    this.cache.set(key, rec)
  }

  private updateCommandCacheFromSession(session: AgentSession): void {
    try {
      const commands = session.extensionRunner.getRegisteredCommands()
      const list: PiAgentCommandInfo[] = commands.map((cmd) => ({
        name: cmd.invocationName,
        ...(cmd.description ? { description: cmd.description } : {}),
        source: cmd.sourceInfo.source ?? 'extension',
      }))
      this.cachedCommands = list
    } catch {
      // Keep prior cache when runner is unavailable.
    }
  }

  private createResourceLoader(opts: {
    sdk: typeof import('@earendil-works/pi-coding-agent')
    paths: PiRuntimePaths
    prefs: PiAgentPrefs
    cwd: string
    settingsManager: SettingsManager
    coord: WorkbenchExtensionCoord
    getToolAnnotations?: Parameters<typeof createGenofficePermissionExtension>[1]
    persona?: string
  }) {
    const { sdk, paths, prefs, cwd, settingsManager, coord, getToolAnnotations, persona } = opts
    return new sdk.DefaultResourceLoader({
      cwd,
      agentDir: paths.agentDir,
      settingsManager,
      additionalExtensionPaths: prefs.magicContextEnabled ? [paths.magicContextEntry] : [],
      additionalSkillPaths: resolveBundledSkillDirs({
        userDataDir: this.deps.userDataDir,
        isPackaged: this.deps.isPackaged,
        resourcesPath: this.deps.resourcesPath,
        appRoot: this.deps.appRoot,
      }),
      extensionFactories: [
        createGenofficeWorkbenchExtension(this.deps.workbench, coord),
        createGenofficePermissionExtension(
          {
            getPermissionMode: this.deps.getPermissionMode,
            sessionAllows: this.deps.sessionAllows,
            workbench: this.deps.workbench,
            coord,
            requestConfirm: (req) => this.requestPanelConfirm(req),
          },
          getToolAnnotations,
        ),
      ],
      systemPromptOverride: (base) =>
        appendButlerPersona(resolveGenofficeSystemPrompt(base, prefs.systemPrompt), persona ?? ''),
      agentsFilesOverride: ({ agentsFiles }) => ({
        agentsFiles: filterAgentContextFiles(agentsFiles, paths.agentDir),
      }),
      noThemes: true,
    })
  }

  async listCommands(): Promise<PiAgentCommandInfo[]> {
    if (this.cachedCommands.length > 0) return [...this.cachedCommands]
    try {
      const { paths, prefs } = this.syncEnvironmentAndConfig()
      const sdk = await this.loadPiSdk(paths)
      const cwd = this.resolveWorkingDir()
      const settingsManager = sdk.SettingsManager.create(cwd, paths.agentDir, {
        projectTrusted: true,
      })
      const coord = createWorkbenchExtensionCoord()
      const loader = this.createResourceLoader({
        sdk,
        paths,
        prefs,
        cwd,
        settingsManager,
        coord,
      })
      await loader.reload()
      for (const sk of loader.getSkills().skills) {
        this.cachedSkillFileByName.set(sk.name, sk.filePath)
      }
      const extResult = loader.getExtensions()
      const out: PiAgentCommandInfo[] = []
      for (const ext of extResult.extensions) {
        for (const cmd of ext.commands.values()) {
          out.push({
            name: cmd.name,
            ...(cmd.description ? { description: cmd.description } : {}),
            source: ext.sourceInfo.source ?? 'extension',
          })
        }
      }
      this.cachedCommands = out
      return out
    } catch {
      return []
    }
  }

  private resolveWorkingDir(): string {
    const preferred = this.deps.getDefaultWorkingDir()
    if (preferred && existsSync(preferred)) return preferred
    mkdirSync(this.deps.userDataDir, { recursive: true })
    return this.deps.userDataDir
  }

  private requestPanelConfirm(request: PiAgentConfirmRequest): Promise<ConfirmPromptResponse> {
    return new Promise<ConfirmPromptResponse>((resolve) => {
      this.pendingConfirms.set(request.requestId, {
        sessionKey: request.sessionKey,
        resolve,
      })
      setPiConfirmInMain(request.sessionKey, request)
      this.deps.sendConfirmRequest(request)
    })
  }

  resolveConfirm(reply: PiAgentConfirmReply): boolean {
    const pending = this.pendingConfirms.get(reply.requestId)
    if (!pending) return false
    this.pendingConfirms.delete(reply.requestId)
    setPiConfirmInMain(pending.sessionKey, null)
    pending.resolve({
      allowed: reply.allowed === true,
      ...(reply.alwaysAllowSession !== undefined
        ? { alwaysAllowSession: reply.alwaysAllowSession }
        : {}),
    })
    return true
  }

  private cancelConfirmsForSession(sessionKey: string): void {
    setPiConfirmInMain(sessionKey, null)
    for (const [reqId, pending] of [...this.pendingConfirms]) {
      if (pending.sessionKey !== sessionKey) continue
      this.pendingConfirms.delete(reqId)
      pending.resolve({ allowed: false })
    }
  }

  private async getOrCreateSessionRecord(
    req: Pick<PiAgentPromptRequest, 'sessionKey' | 'projectId' | 'chatId'>,
  ): Promise<CachedSessionRecord> {
    const { paths, prefs, modelSpec } = this.syncEnvironmentAndConfig()
    if (!modelSpec) {
      throw new Error(
        'No compatible Pi AI model configuration is available (check provider settings or switch engine to legacy).',
      )
    }

    const persona = this.deps.getPersonaSection?.() ?? ''
    const currentPrefsKey = prefsReloadKey(prefs, prefs.magicContextStorageMode, persona)
    const cached = this.cache.get(req.sessionKey)
    if (cached) {
      if (cached.prefsKey === currentPrefsKey) {
        this.touchCache(req.sessionKey, cached)
        if (cached.lastModelRef !== modelSpec.modelRef) {
          await cached.session.setModel(modelSpec.piModel)
          this.cache.set(req.sessionKey, { ...cached, lastModelRef: modelSpec.modelRef })
        }
        return this.cache.get(req.sessionKey)!
      }
      if (!cached.busy) {
        this.cache.delete(req.sessionKey)
        try {
          cached.session.dispose()
        } catch {
          // Ignore stale session disposal failure.
        }
      }
    }

    this.evictOldestIfNeeded()
    const sdk = await this.loadPiSdk(paths)
    const cwd = this.resolveWorkingDir()
    const settingsManager = sdk.SettingsManager.create(cwd, paths.agentDir, {
      projectTrusted: true,
    })

    const coord = createWorkbenchExtensionCoord()
    let sessionRef: AgentSession | null = null

    const loader = this.createResourceLoader({
      sdk,
      paths,
      prefs,
      cwd,
      settingsManager,
      coord,
      persona,
      getToolAnnotations: (toolName) =>
        sessionRef?.extensionRunner.getToolDefinition(toolName)?.annotations,
    })
    await loader.reload()
    for (const sk of loader.getSkills().skills) {
      this.cachedSkillFileByName.set(sk.name, sk.filePath)
    }

    const mapStore = this.getSessionMap(paths)
    const existingSessionFile = mapStore.get(req.sessionKey)
    let sessionManager: SessionManager
    if (existingSessionFile) {
      sessionManager = sdk.SessionManager.open(existingSessionFile, paths.sessionsDir, cwd)
    } else {
      sessionManager = sdk.SessionManager.create(cwd, paths.sessionsDir)
      const projectStore = this.deps.getProjectStore()
      if (projectStore && req.projectId && req.chatId) {
        try {
          const legacyMessages = projectStore.loadChat(
            req.projectId,
            req.chatId,
            BACKFILL_MESSAGE_LIMIT,
          )
          for (const msg of legacyMessages) {
            const ts = Date.parse(msg.ts) || Date.now()
            if (msg.role === 'user' && msg.text) {
              sessionManager.appendMessage({
                role: 'user',
                content: msg.text,
                timestamp: ts,
              })
            } else if (msg.role === 'assistant' && msg.text) {
              sessionManager.appendMessage({
                role: 'assistant',
                content: [{ type: 'text', text: msg.text }],
                api: modelSpec.piModel.api,
                provider: modelSpec.piModel.provider,
                model: modelSpec.piModel.id,
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: 'stop',
                timestamp: ts,
              })
            }
          }
        } catch {
          // Non-fatal: new Pi session still starts cleanly if history backfill fails.
        }
      }
      const createdFile = sessionManager.getSessionFile()
      if (createdFile) mapStore.set(req.sessionKey, createdFile)
    }

    const excludeTools = buildExcludeBuiltinTools(prefs)
    const authPath = join(paths.agentDir, 'auth.json')
    const modelsPath = join(paths.agentDir, 'models.json')
    const modelRuntime = await sdk.ModelRuntime.create({ authPath, modelsPath })

    const { session } = await sdk.createAgentSession({
      cwd,
      agentDir: paths.agentDir,
      modelRuntime,
      model: modelSpec.piModel,
      ...(excludeTools.length > 0 ? { excludeTools } : {}),
      resourceLoader: loader,
      sessionManager,
      settingsManager,
    })
    sessionRef = session

    const commandActions = this.createCommandActions(session)
    await session.bindExtensions({
      mode: 'json',
      commandContextActions: commandActions,
      onError: (err) => {
        this.deps.sendNoticeEvent({
          sessionKey: req.sessionKey,
          level: 'error',
          message: err.error,
          customType: err.extensionPath,
        })
      },
    })

    const createdFile = session.sessionManager.getSessionFile()
    if (createdFile) mapStore.set(req.sessionKey, createdFile)

    this.attachSessionEventSubscriber(req.sessionKey, session, prefs)
    this.updateCommandCacheFromSession(session)

    const record: CachedSessionRecord = {
      sessionKey: req.sessionKey,
      session,
      coord,
      lastModelRef: modelSpec.modelRef,
      prefsKey: currentPrefsKey,
      busy: false,
    }
    this.touchCache(req.sessionKey, record)
    this.emitSessionStatus(req.sessionKey, session, prefs)

    return record
  }

  private createCommandActions(session: AgentSession): ExtensionCommandContextActions {
    return {
      waitForIdle: async () => {
        const deadline = Date.now() + COMMAND_WAIT_IDLE_MS
        while (Date.now() < deadline) {
          if (!session.isStreaming) return
          await new Promise((r) => setTimeout(r, 50))
        }
      },
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      navigateTree: async () => ({ cancelled: true }),
      switchSession: async () => ({ cancelled: true }),
      reload: async () => {
        await this.reloadAll()
      },
    }
  }

  private emitSessionStatus(
    sessionKey: string,
    session: AgentSession,
    prefs: PiAgentPrefs,
    statusText?: string,
  ): void {
    const usage = session.getContextUsage()
    const paths = this.getPaths()
    const counts = this.readMemorySummaryCount(paths.magicContextStorageDir)
    this.deps.sendStatusEvent({
      sessionKey,
      contextTokens: usage?.tokens ?? null,
      contextWindow: usage?.contextWindow ?? 128_000,
      contextPercent: usage?.percent ?? null,
      ...(counts
        ? { memoryCount: counts.memoryCount, compartmentCount: counts.compartmentCount }
        : {}),
      magicContextActive: prefs.magicContextEnabled,
      ...(statusText !== undefined ? { statusText } : {}),
      engine: 'pi',
    })
  }

  private readMemorySummaryCount(storageDir: string) {
    return readMagicContextStats(storageDir)
  }

  private attachSessionEventSubscriber(
    sessionKey: string,
    session: AgentSession,
    prefs: PiAgentPrefs,
  ): void {
    session.subscribe((event: AgentSessionEvent) => {
      const run = this.activeRuns.get(sessionKey)

      if (event.type === 'entry_appended') {
        const entry = event.entry as {
          type?: string
          customType?: string
          data?: { title?: unknown; text?: unknown }
          content?: unknown
        }
        if (run && entry.type === 'custom' && typeof entry.data?.text === 'string') {
          run.capturedCustomTexts.push(entry.data.text)
        } else if (run && entry.type === 'custom_message') {
          if (typeof entry.content === 'string' && entry.content.trim()) {
            run.capturedCustomTexts.push(entry.content)
          } else if (Array.isArray(entry.content)) {
            const txt = (entry.content as Array<{ type?: string; text?: unknown }>)
              .filter((p) => p?.type === 'text' && typeof p.text === 'string')
              .map((p) => p.text as string)
              .join('\n')
            if (txt.trim()) run.capturedCustomTexts.push(txt)
          }
        }
        return
      }

      if (event.type === 'compaction_start') {
        this.emitSessionStatus(sessionKey, session, prefs, 'Compacting conversation memory...')
        return
      }
      if (event.type === 'compaction_end') {
        this.emitSessionStatus(sessionKey, session, prefs, undefined)
        return
      }

      if (!run) return

      switch (event.type) {
        case 'message_start': {
          const msg = event.message as { role?: string }
          if (msg.role === 'assistant') {
            run.stripper = createOrdinalPrefixStripper()
            run.currentMsgCleanText = ''
            run.textNeedsBreak = run.accumulatedCleanText.trim().length > 0
          }
          break
        }

        case 'message_update': {
          const ame = event.assistantMessageEvent
          if (ame.type === 'text_delta' && ame.delta) {
            run.rawTextChunks.push(ame.delta)
            const filtered = run.stripper.push(ame.delta)
            if (filtered) {
              const turnText = appendPiCleanText(run, filtered)
              broadcastAskRunEventFromMain({
                type: 'text',
                sessionKey,
                payload: turnText,
              })
            }
          } else if (ame.type === 'thinking_delta' && ame.delta) {
            const deltaChunk = advanceReasoningDelta(run, ame.delta)
            if (deltaChunk) {
              broadcastAskRunEventFromMain({
                type: 'reasoning',
                sessionKey,
                payload: deltaChunk,
              })
            }
          }
          break
        }

        case 'tool_execution_start': {
          run.reasoningNeedsBreak = true
          const call: AgentToolCall = {
            id: event.toolCallId,
            name: event.toolName,
            input: (event.args ?? {}) as Record<string, unknown>,
          }
          run.toolCallsById.set(event.toolCallId, call)
          broadcastAskRunEventFromMain({
            type: 'tool-start',
            sessionKey,
            payload: call,
          })
          break
        }

        case 'tool_execution_end': {
          const call = run.toolCallsById.get(event.toolCallId) ?? {
            id: event.toolCallId,
            name: event.toolName,
            input: {},
          }
          const resultObj = (event.result ?? {}) as {
            content?: Array<{ type?: string; text?: string }>
            details?: GenofficeToolResultDetails
          }
          const textOut = Array.isArray(resultObj.content)
            ? resultObj.content
                .filter((c) => c?.type === 'text' && typeof c.text === 'string')
                .map((c) => c.text)
                .join('\n')
            : ''
          const details = resultObj.details
          const execution: ToolExecution = {
            output: textOut,
            isError: event.isError === true || details?.isError === true,
            summary: details?.summary ?? event.toolName,
            ...(details?.mutated !== undefined ? { mutated: details.mutated } : {}),
            ...(details?.denied !== undefined ? { denied: details.denied } : {}),
            ...(details?.display ? { display: details.display } : {}),
          }
          broadcastAskRunEventFromMain({
            type: 'tool-executed',
            sessionKey,
            payload: { call, execution },
          })
          if (details?.checkpoint) {
            broadcastAskRunEventFromMain({
              type: 'checkpoint-added',
              sessionKey,
              payload: details.checkpoint,
            })
          }
          break
        }

        case 'message_end': {
          const msg = event.message as {
            role?: string
            usage?: { input?: number; output?: number }
            stopReason?: string
            errorMessage?: string
            content?: Array<{ type?: string; text?: string }>
          }
          if (msg.role === 'assistant') {
            if (msg.usage) {
              const delta = messageUsageDelta(msg.usage)
              run.usageTotals.input += delta.inputTokens
              run.usageTotals.output += delta.outputTokens
              broadcastAskRunEventFromMain({
                type: 'usage',
                sessionKey,
                payload: delta,
              })
            }
            const flushed = run.stripper.flush()
            if (flushed) {
              appendPiCleanText(run, flushed)
            }
            const finalRaw =
              msg.content
                ?.filter((p) => p?.type === 'text' && typeof p.text === 'string')
                .map((p) => p.text)
                .join('') ?? ''
            if (!run.currentMsgCleanText && finalRaw) {
              const cleaned = stripOrdinalPrefix(finalRaw)
              if (cleaned) {
                appendPiCleanText(run, cleaned)
              }
            }
            run.currentMsgCleanText = stripOrdinalPrefix(run.currentMsgCleanText)
            run.accumulatedCleanText = stripOrdinalPrefix(run.accumulatedCleanText)
            if (run.currentMsgCleanText) {
              broadcastAskRunEventFromMain({
                type: 'text',
                sessionKey,
                payload: run.currentMsgCleanText,
              })
            }
            if (msg.stopReason === 'error' && msg.errorMessage) {
              broadcastAskRunEventFromMain({
                type: 'error',
                sessionKey,
                payload: msg.errorMessage,
              })
            }
          }
          break
        }

        case 'agent_end': {
          this.emitSessionStatus(sessionKey, session, prefs)
          break
        }
      }
    })
  }

  async prompt(req: PiAgentPromptRequest): Promise<PiAgentPromptResult> {
    if (this.activeRuns.has(req.sessionKey)) {
      return { ok: false, error: 'A turn is already running in this session.' }
    }

    let record: CachedSessionRecord
    try {
      record = await this.getOrCreateSessionRecord(req)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    const store = this.deps.getProjectStore()
    const cleanInstruction = req.instruction.trim()
    const isSlashCommand = cleanInstruction.startsWith('/')

    const skillPaths: string[] = []
    if (req.skills && req.skills.length > 0) {
      const fromDeps = this.deps.resolveSkillPathsByName?.(req.skills) ?? []
      const seen = new Set<string>(fromDeps)
      skillPaths.push(...fromDeps)
      for (const name of req.skills) {
        const cachedPath = this.cachedSkillFileByName.get(name)
        if (cachedPath && !seen.has(cachedPath) && existsSync(cachedPath)) {
          seen.add(cachedPath)
          skillPaths.push(cachedPath)
        }
      }
    }

    const prepared = await prepareTurnWorkbenchState(this.deps.workbench, record.coord, {
      sessionKey: req.sessionKey,
      projectId: req.projectId,
      chatId: req.chatId,
      viewer: req.docPath ? 'overlay' : 'home',
      scopePaths: req.scopePaths ?? [],
      attachments: req.attachments ?? [],
      instruction: cleanInstruction,
      lineageSeed: req.lineageSeed,
      lang: req.lang,
      ignoreActiveTabContext: req.ignoreActiveTabContext,
      focusedTabId: req.focusedTabId,
      skillFilePaths: skillPaths,
      onDocumentAgentProgress: (event: {
        taskId: string
        kind: string
        status: AgentTaskStatus
      }) => {
        broadcastAskRunEventFromMain({
          type: 'subagent-progress',
          sessionKey: req.sessionKey,
          payload: { ...event.status, docKind: event.kind },
        })
      },
    })

    const piSessionId = record.session.sessionManager.getSessionId()
    record.coord.bindPiSession(piSessionId, prepared.state)

    const run: ActivePromptRun = {
      sessionKey: req.sessionKey,
      req,
      turnState: prepared.state,
      stripper: createOrdinalPrefixStripper(),
      rawTextChunks: [],
      capturedNotices: [],
      capturedCustomTexts: [],
      toolCallsById: new Map(),
      accumulatedCleanText: '',
      currentMsgCleanText: '',
      textNeedsBreak: false,
      accumulatedReasoning: '',
      reasoningNeedsBreak: false,
      aborted: false,
      userPersisted: false,
      assistantStarted: false,
      usageTotals: { input: 0, output: 0 },
    }
    this.activeRuns.set(req.sessionKey, run)
    record.busy = true
    beginPiRunInMain({
      sessionKey: req.sessionKey,
      projectId: req.projectId,
      chatId: req.chatId,
      docPath: req.docPath ?? null,
      userText: cleanInstruction,
      ...(req.skills ? { skills: req.skills } : {}),
      ...(req.attachments ? { attachments: req.attachments } : {}),
    })

    try {
      // Collect user images (inline + image attachments) when model supports vision.
      const images: ImageContent[] = []
      const supportsVision = endpointSupportsVision(this.deps.getAiSettings())
      if (supportsVision) {
        for (const img of req.images ?? []) {
          images.push({ type: 'image', data: img.base64, mimeType: img.mime })
        }
        for (const att of req.attachments ?? []) {
          if (!ATTACHMENT_IMAGE_EXTS.has(att.ext.toLowerCase())) continue
          const loaded = this.deps.workbench.readAttachmentImage(att.path)
          if (loaded.ok && loaded.base64 && loaded.mime) {
            images.push({ type: 'image', data: loaded.base64, mimeType: loaded.mime })
          }
        }
      }

      if (!isSlashCommand && store && req.projectId && req.chatId) {
        store.appendChatMessage(req.projectId, req.chatId, {
          role: 'user',
          text: cleanInstruction,
          ...(req.skills && req.skills.length > 0 ? { skills: [...req.skills] } : {}),
          ...(req.attachments && req.attachments.length > 0
            ? { attachments: [...req.attachments] }
            : {}),
        })
        run.userPersisted = true
        markPiUserPersistedInMain(req.sessionKey)
      }

      const outbound = isSlashCommand ? cleanInstruction : prepared.outboundPrompt
      await record.coord.runWithTurnState(prepared.state, () =>
        record.session.prompt(outbound, {
          expandPromptTemplates: isSlashCommand,
          ...(images.length > 0 ? { images } : {}),
        }),
      )

      const commandOutput = [...run.capturedCustomTexts, ...run.capturedNotices]
        .filter((s) => s.trim().length > 0)
        .join('\n\n')

      const finalCleanText = stripOrdinalPrefix(
        run.accumulatedCleanText + run.stripper.flush(),
      ).trim()

      if (isSlashCommand && !finalCleanText) {
        if (commandOutput) {
          broadcastAskRunEventFromMain({
            type: 'text',
            sessionKey: req.sessionKey,
            payload: commandOutput,
          })
        }
        broadcastAskRunEventFromMain({
          type: 'done',
          sessionKey: req.sessionKey,
          payload: null,
        })
        return {
          ok: true,
          commandHandled: true,
          ...(commandOutput ? { commandOutput } : {}),
        }
      }

      if (store && req.projectId && req.chatId && finalCleanText) {
        store.appendChatMessage(req.projectId, req.chatId, {
          role: 'assistant',
          text: finalCleanText,
        })
        markPiAssistantPersistedInMain(req.sessionKey)
      }

      for (const candidate of prepared.state.lineageCandidates) {
        const firstLine = finalCleanText.split('\n')[0]?.slice(0, 200) ?? ''
        this.deps.workbench.recordLineage({
          path: candidate.path,
          task: candidate.task,
          summary: firstLine,
        })
      }

      broadcastAskRunEventFromMain({
        type: 'done',
        sessionKey: req.sessionKey,
        payload: null,
      })

      return { ok: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      broadcastAskRunEventFromMain({
        type: 'error',
        sessionKey: req.sessionKey,
        payload: msg,
      })
      broadcastAskRunEventFromMain({
        type: 'done',
        sessionKey: req.sessionKey,
        payload: null,
      })
      return { ok: false, error: msg }
    } finally {
      record.busy = false
      record.coord.unbindPiSession(piSessionId)
      record.coord.setFallbackTurnState(undefined)
      this.activeRuns.delete(req.sessionKey)
      this.cancelConfirmsForSession(req.sessionKey)
      finishPiRunInMain(req.sessionKey)
    }
  }

  async abort(sessionKey: string): Promise<boolean> {
    const run = this.activeRuns.get(sessionKey)
    if (run) run.aborted = true
    this.cancelConfirmsForSession(sessionKey)
    this.deps.workbench.cancelDocumentAgent(`pi:${sessionKey}`)
    const cached = this.cache.get(sessionKey)
    if (!cached) return false
    try {
      await cached.session.abort()
      return true
    } catch {
      return false
    }
  }

  rebindSession(oldKey: string, newKey: string): void {
    if (oldKey === newKey) return
    const paths = this.getPaths()
    this.getSessionMap(paths).rebind(oldKey, newKey)
    const cached = this.cache.get(oldKey)
    if (cached) {
      this.cache.delete(oldKey)
      this.cache.set(newKey, { ...cached, sessionKey: newKey })
    }
  }

  deleteSession(sessionKey: string): void {
    this.cancelConfirmsForSession(sessionKey)
    const cached = this.cache.get(sessionKey)
    if (cached) {
      this.cache.delete(sessionKey)
      try {
        cached.session.dispose()
      } catch {
        // Ignore disposal error.
      }
    }
    const paths = this.getPaths()
    const file = this.getSessionMap(paths).delete(sessionKey)
    if (file && existsSync(file)) {
      try {
        rmSync(file, { force: true })
      } catch {
        // Ignore stale jsonl deletion failure.
      }
    }
  }

  async reloadAll(): Promise<void> {
    this.syncEnvironmentAndConfig()
    this.cachedCommands = []
    this.sessionMap = null
    for (const [key, rec] of [...this.cache]) {
      if (rec.busy || this.activeRuns.has(key)) continue
      this.cache.delete(key)
      try {
        rec.session.dispose()
      } catch {
        // Ignore disposal error.
      }
    }
    await this.listCommands()
  }

  disposeAll(): void {
    for (const key of [...this.activeRuns.keys()]) {
      void this.abort(key)
    }
    for (const [key, rec] of [...this.cache]) {
      this.cache.delete(key)
      try {
        rec.session.dispose()
      } catch {
        // Ignore shutdown disposal error.
      }
    }
    this.uninstallSpawnHook?.()
    this.uninstallSpawnHook = null
  }
}

export function formatExtensionLoadedToolNames(session: AgentSession): string[] {
  return session.getAllTools().map((t) => t.name)
}
