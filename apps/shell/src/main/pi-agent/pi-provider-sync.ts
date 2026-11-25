import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  activeProvider,
  getProviderAdapter,
  resolveProfileCredential,
  resolveThinkingEffort,
  thinkingShapeFor,
  type AiProtocol,
  type AiProviderConfig,
  type AiSettings,
  type ResolvedEndpoint,
  type ThinkingEffort,
} from '@genoffice/ai-provider'
import { endpointSupportsVision } from '@genoffice/ai-provider/browser'
import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import type { Api, Model, ThinkingLevelMap } from '@earendil-works/pi-ai'
import type { PiAgentPrefs } from '../../shared/pi-agent-prefs'
import type { PiRuntimePaths } from './pi-agent-paths'

/** Known context window sizes for common model families (fallback: 128_000). */
const KNOWN_CONTEXT_WINDOWS: ReadonlyArray<[RegExp, number]> = [
  [/claude-(?:opus|sonnet|haiku|fable)-5/i, 1_000_000],
  [/claude-(?:opus|sonnet)-4-[6-9]/i, 1_000_000],
  [/claude-(?:opus|sonnet|haiku)-4/i, 200_000],
  [/claude-3/i, 200_000],
  [/gemini-[34]/i, 1_000_000],
  [/gemini-2\.[05]|gemini-1\.5/i, 1_000_000],
  [/gpt-6/i, 272_000],
  [/gpt-5/i, 400_000],
  [/gpt-4\.1/i, 1_000_000],
  [/gpt-4o|o1|o3|o4/i, 128_000],
  [/deepseek/i, 128_000],
  [/qwen/i, 128_000],
  [/glm-4/i, 128_000],
  [/minimax/i, 200_000],
]

const DEFAULT_CONTEXT_WINDOW = 128_000

/** Infer a positive contextWindow so Magic Context pressure calculations stay accurate. */
export function inferContextWindow(modelId: string, declared?: number): number {
  if (typeof declared === 'number' && Number.isFinite(declared) && declared > 0) {
    return Math.floor(declared)
  }
  for (const [pattern, tokens] of KNOWN_CONTEXT_WINDOWS) {
    if (pattern.test(modelId)) return tokens
  }
  return DEFAULT_CONTEXT_WINDOW
}

function mapProtocolToPiApi(protocol: string): Api {
  switch (protocol) {
    case 'anthropic':
      return 'anthropic-messages'
    case 'gemini':
      return 'google-generative-ai'
    case 'openai-responses':
      return 'openai-responses'
    default:
      return 'openai-completions'
  }
}

export type SessionThinkingOverride =
  | { readonly mode: 'off' }
  | { readonly mode: 'effort'; readonly effort: 'low' | 'medium' | 'high' }

type ResolvedThinkingMode =
  | { readonly mode: 'unset' }
  | { readonly mode: 'off' }
  | { readonly mode: 'effort'; readonly effort: ThinkingEffort }

function mapPiApiToProtocol(api: Api): AiProtocol {
  switch (api) {
    case 'anthropic-messages':
      return 'anthropic'
    case 'google-generative-ai':
      return 'gemini'
    case 'openai-responses':
      return 'openai-responses'
    default:
      return 'openai-compatible'
  }
}

function resolveRawThinkingPick(
  config: AiProviderConfig,
  endpoint: ResolvedEndpoint,
): string | undefined {
  return (
    config.thinking?.[config.model] ??
    (endpoint.model && endpoint.model !== config.model
      ? config.thinking?.[endpoint.model]
      : undefined)
  )
}

/**
 * Resolve global thinking configuration into an explicit mode (`unset`, `off`,
 * or positive `effort`). Preserves `unset` when unconfigured or unsupported,
 * while honoring explicit `'none'` selections so thinking-on-by-default models
 * receive protocol-specific disable parameters.
 */
function resolveGlobalPiThinkingMode(
  config: AiProviderConfig,
  endpoint: ResolvedEndpoint,
): ResolvedThinkingMode {
  let effort = resolveThinkingEffort(config, endpoint.protocol)
  if (!effort && endpoint.model && endpoint.model !== config.model) {
    const rawPick = resolveRawThinkingPick(config, endpoint)
    effort = resolveThinkingEffort(
      {
        model: endpoint.model,
        ...(rawPick ? { thinking: { [endpoint.model]: rawPick } } : {}),
      },
      endpoint.protocol,
    )
  }
  if (effort && effort !== 'none') {
    return { mode: 'effort', effort }
  }
  if (resolveRawThinkingPick(config, endpoint) === 'none') {
    return { mode: 'off' }
  }
  return { mode: 'unset' }
}

function stripThinkingCompatFields(entries: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...entries }
  delete copy.thinkingFormat
  delete copy.forceAdaptiveThinking
  return copy
}

function pickEffortLevel(
  requested: ThinkingEffort,
  supported: readonly ThinkingEffort[],
): ThinkingEffort | undefined {
  if (supported.includes(requested)) return requested
  for (const fallback of ['high', 'medium', 'low'] as const) {
    if (supported.includes(fallback)) return fallback
  }
  return supported.find((lvl) => lvl !== 'none')
}

function applyResolvedThinkingMode(
  baseSpec: SyncedPiModelSpec,
  target: ResolvedThinkingMode,
  protocolOverride?: AiProtocol,
): SyncedPiModelSpec {
  if (target.mode === 'unset') {
    return baseSpec
  }

  const { modelId, providerId, piModel } = baseSpec
  const protocol = protocolOverride ?? mapPiApiToProtocol(piModel.api)
  const shape = thinkingShapeFor(modelId, protocol)
  const isQwen = /(?:^|[/_-])qwen\d/i.test(modelId)
  const isDeepSeek = /(?:^|[/_-])deep-?seek/i.test(modelId)
  const isZai =
    /(?:^|[/_-])glm-/i.test(modelId) ||
    providerId === 'zai' ||
    piModel.baseUrl.includes('bigmodel.cn') ||
    piModel.baseUrl.includes('api.z.ai')
  const isToggleFamily = /(?:^|[/_-])(?:ling-|ring-|spark-x|mimo-)/i.test(modelId)

  const baseCompatEntries = piModel.compat
    ? { ...(piModel.compat as Record<string, unknown>) }
    : {}

  let reasoning = false
  let nextThinkingLevel: ThinkingLevel | undefined
  let nextCompatEntries = stripThinkingCompatFields(baseCompatEntries)
  let nextThinkingLevelMap: ThinkingLevelMap | undefined

  if (target.mode === 'off') {
    nextThinkingLevel = 'off'
    if (piModel.api === 'openai-completions') {
      if (isQwen) {
        reasoning = true
        nextCompatEntries = { ...nextCompatEntries, thinkingFormat: 'qwen' }
      } else if (isDeepSeek || isToggleFamily) {
        reasoning = true
        nextCompatEntries = { ...nextCompatEntries, thinkingFormat: 'deepseek' }
      } else if (isZai) {
        reasoning = true
        nextCompatEntries = { ...nextCompatEntries, thinkingFormat: 'zai' }
      } else if (shape.kind === 'openai-effort' && shape.levels.includes('none')) {
        reasoning = true
        nextThinkingLevelMap = { ...piModel.thinkingLevelMap, off: 'none' }
      } else {
        reasoning = false
      }
    } else if (piModel.api === 'openai-responses') {
      if (shape.levels.includes('none')) {
        reasoning = true
        nextThinkingLevelMap = { ...piModel.thinkingLevelMap, off: 'none' }
      } else {
        reasoning = false
      }
    } else {
      reasoning = false
    }
  } else {
    let targetEffort: ThinkingEffort | undefined
    if (shape.levels.length > 0) {
      targetEffort = pickEffortLevel(target.effort, shape.levels)
    } else if (piModel.api === 'openai-completions' || piModel.api === 'openai-responses') {
      targetEffort = target.effort
    } else {
      targetEffort = undefined
    }

    if (!targetEffort || targetEffort === 'none') {
      reasoning = false
      nextThinkingLevel = undefined
    } else {
      reasoning = true
      nextThinkingLevel = targetEffort
      if (piModel.api === 'openai-completions') {
        if (isQwen) {
          nextCompatEntries = { ...nextCompatEntries, thinkingFormat: 'qwen' }
        } else if (isDeepSeek || isToggleFamily) {
          nextCompatEntries = { ...nextCompatEntries, thinkingFormat: 'deepseek' }
        } else if (isZai) {
          nextCompatEntries = { ...nextCompatEntries, thinkingFormat: 'zai' }
        }
      } else if (
        piModel.api === 'anthropic-messages' &&
        shape.kind === 'anthropic-adaptive' &&
        shape.levels.length > 0
      ) {
        nextCompatEntries = { ...nextCompatEntries, forceAdaptiveThinking: true }
      }

      if (targetEffort === 'xhigh' || targetEffort === 'max') {
        nextThinkingLevelMap = { [targetEffort]: targetEffort }
      }
    }
  }

  const nextCompat =
    Object.keys(nextCompatEntries).length > 0
      ? (nextCompatEntries as NonNullable<Model<Api>['compat']>)
      : undefined
  const { compat: _oldCompat, thinkingLevelMap: _oldMap, ...restPiModel } = piModel
  const nextPiModel: Model<Api> = {
    ...restPiModel,
    reasoning,
    ...(nextThinkingLevelMap ? { thinkingLevelMap: nextThinkingLevelMap } : {}),
    ...(nextCompat ? { compat: nextCompat } : {}),
  }

  const { thinkingLevel: _oldLevel, ...restSpec } = baseSpec
  return {
    ...restSpec,
    piModel: nextPiModel,
    ...(nextThinkingLevel !== undefined ? { thinkingLevel: nextThinkingLevel } : {}),
  }
}

/**
 * Apply a per-session thinking override on top of a base `SyncedPiModelSpec`
 * without mutating the base spec or global `models.json`.
 */
export function applySessionThinkingToModelSpec(
  baseSpec: SyncedPiModelSpec,
  override?: SessionThinkingOverride,
): SyncedPiModelSpec {
  if (!override) return baseSpec
  return applyResolvedThinkingMode(baseSpec, override)
}

export interface SyncedPiModelSpec {
  readonly providerId: string
  readonly modelId: string
  readonly modelRef: string
  readonly piModel: Model<Api>
  readonly apiKey: string | undefined
  readonly thinkingLevel?: ThinkingLevel
}

/**
 * Derive Pi model metadata and credential from GenOffice `AiSettings`.
 * Throws an explicit error when `codex` is active because Pi uses HTTP APIs
 * rather than the local codex-app-server subprocess protocol.
 */
export function buildSyncedPiModelSpec(
  settings: AiSettings,
  gskApiKey?: string,
): SyncedPiModelSpec {
  const providerId = activeProvider(settings)
  if (providerId === 'codex') {
    throw new Error(
      'The codex provider is not supported on the Pi runtime; switch provider or set engine to legacy.',
    )
  }
  const adapter = getProviderAdapter(providerId)
  const rawConfig = settings.providers[providerId]
  let resolvedConfig = resolveProfileCredential(rawConfig)
  if (providerId === 'genspark' && !resolvedConfig.apiKey && gskApiKey?.trim()) {
    resolvedConfig = { ...resolvedConfig, apiKey: gskApiKey.trim() }
  }
  const effectiveSettings: AiSettings =
    resolvedConfig === rawConfig
      ? settings
      : {
          ...settings,
          providers: {
            ...settings.providers,
            [providerId]: resolvedConfig,
          },
        }
  const endpoint = adapter.resolveEndpoint(resolvedConfig)
  const api = mapProtocolToPiApi(endpoint.protocol)
  const modelId = (endpoint.model ?? resolvedConfig.model ?? '').trim() || 'default'

  const declaredCtx = (endpoint as { contextWindow?: unknown }).contextWindow
  const contextWindow = inferContextWindow(
    modelId,
    typeof declaredCtx === 'number' ? declaredCtx : undefined,
  )
  const maxTokens = endpoint.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  const supportsVision = endpointSupportsVision(effectiveSettings)
  const globalMode = resolveGlobalPiThinkingMode(resolvedConfig, endpoint)

  const compatEntries: Record<string, unknown> = {}
  if (api === 'openai-completions') {
    if (endpoint.useMaxCompletionTokens) {
      compatEntries.maxTokensField = 'max_completion_tokens'
    }
    if (endpoint.echoReasoning !== undefined) {
      compatEntries.requiresReasoningContentOnAssistantMessages = endpoint.echoReasoning
    }
  }
  const compat =
    Object.keys(compatEntries).length > 0
      ? (compatEntries as NonNullable<Model<Api>['compat']>)
      : undefined

  const piModel: Model<Api> = {
    id: modelId,
    name: modelId,
    api,
    provider: providerId,
    baseUrl: endpoint.baseUrl,
    input: supportsVision ? ['text', 'image'] : ['text'],
    reasoning: false,
    contextWindow,
    maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(endpoint.headers ? { headers: endpoint.headers } : {}),
    ...(compat ? { compat } : {}),
  }

  const baseSpec: SyncedPiModelSpec = {
    providerId,
    modelId,
    modelRef: `${providerId}/${modelId}`,
    piModel,
    apiKey: resolvedConfig.apiKey || undefined,
  }

  return applyResolvedThinkingMode(baseSpec, globalMode, endpoint.protocol)
}

function readJsonSafe(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function writeJsonEnsuringDir(path: string, data: unknown, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true })
  const text = `${JSON.stringify(data, null, 2)}\n`
  writeFileSync(path, text, mode !== undefined ? { encoding: 'utf8', mode } : 'utf8')
}

function stripJsonCommentsSimple(text: string): string {
  // Strip // line comments outside string literals and trailing commas so existing
  // shared magic-context.jsonc comments/fields survive cleanly when merging.
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const next = text[i + 1]
    if (inString) {
      out += ch
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      out += '\n'
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 1
      continue
    }
    out += ch
  }
  return out.replace(/,\s*([}\]])/g, '$1')
}

function readJsoncSafe(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  try {
    const raw = JSON.parse(stripJsonCommentsSimple(readFileSync(path, 'utf8')))
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * Synchronize GenOffice `AiSettings` and `PiAgentPrefs` into Pi's `models.json`,
 * `auth.json` (`0o600`), `settings.json` (native compaction disabled), and Magic
 * Context's user-level `magic-context.jsonc`.
 */
export function syncPiProviderAndMagicContextConfig(
  paths: PiRuntimePaths,
  settings: AiSettings,
  prefs: PiAgentPrefs,
  gskApiKey?: string,
): SyncedPiModelSpec | null {
  mkdirSync(paths.agentDir, { recursive: true })
  mkdirSync(paths.sessionsDir, { recursive: true })

  let spec: SyncedPiModelSpec | null
  try {
    spec = buildSyncedPiModelSpec(settings, gskApiKey)
  } catch {
    spec = null
  }

  // 1. models.json: merge GenOffice active provider while keeping other user providers intact.
  const modelsDoc = readJsonSafe(paths.modelsJsonPath)
  const existingProviders =
    modelsDoc.providers && typeof modelsDoc.providers === 'object'
      ? (modelsDoc.providers as Record<string, unknown>)
      : {}
  if (spec) {
    existingProviders[spec.providerId] = {
      baseUrl: spec.piModel.baseUrl,
      api: spec.piModel.api,
      ...(spec.piModel.headers ? { headers: spec.piModel.headers } : {}),
      ...(spec.piModel.compat ? { compat: spec.piModel.compat } : {}),
      models: [
        {
          id: spec.piModel.id,
          name: spec.piModel.name,
          api: spec.piModel.api,
          reasoning: spec.piModel.reasoning,
          ...(spec.piModel.thinkingLevelMap
            ? { thinkingLevelMap: spec.piModel.thinkingLevelMap }
            : {}),
          input: spec.piModel.input,
          contextWindow: spec.piModel.contextWindow,
          maxTokens: spec.piModel.maxTokens,
          cost: spec.piModel.cost,
          ...(spec.piModel.headers ? { headers: spec.piModel.headers } : {}),
          ...(spec.piModel.compat ? { compat: spec.piModel.compat } : {}),
        },
      ],
    }
  }
  writeJsonEnsuringDir(paths.modelsJsonPath, { ...modelsDoc, providers: existingProviders })

  // 2. auth.json (0o600): store resolved API key for the active provider.
  const authDoc = readJsonSafe(paths.authJsonPath)
  if (spec) {
    if (spec.apiKey) {
      authDoc[spec.providerId] = { type: 'api_key', key: spec.apiKey }
    } else if (spec.piModel.headers && Object.keys(spec.piModel.headers).length > 0) {
      // Providers authenticated via custom headers still satisfy Pi's credential check.
      authDoc[spec.providerId] = { type: 'api_key', key: 'header-auth' }
    }
  }
  writeJsonEnsuringDir(paths.authJsonPath, authDoc, 0o600)

  // 3. Pi settings.json: disable Pi's built-in compaction so Magic Context owns compaction,
  // and point defaultProvider/defaultModel at GenOffice's active selection when valid.
  const piSettingsDoc = readJsonSafe(paths.settingsJsonPath)
  const existingCompaction =
    piSettingsDoc.compaction && typeof piSettingsDoc.compaction === 'object'
      ? (piSettingsDoc.compaction as Record<string, unknown>)
      : {}
  const nextPiSettings: Record<string, unknown> = {
    ...piSettingsDoc,
    compaction: {
      ...existingCompaction,
      enabled: !prefs.magicContextEnabled,
    },
    ...(spec
      ? {
          defaultProvider: spec.providerId,
          defaultModel: spec.modelId,
        }
      : {}),
  }
  writeJsonEnsuringDir(paths.settingsJsonPath, nextPiSettings)

  // 4. Magic Context user config (`magic-context.jsonc`).
  // In isolated mode GenOffice fully manages this file; in shared mode we preserve
  // existing user preferences and only write if missing or explicitly updated.
  const historianModelRef = prefs.historianModel || spec?.modelRef || ''
  const dreamerModelRef = prefs.dreamerModel || historianModelRef
  const existingMc =
    prefs.magicContextStorageMode === 'shared' ? readJsoncSafe(paths.magicContextConfigPath) : {}

  const historianBlock =
    existingMc.historian && typeof existingMc.historian === 'object'
      ? ({ ...(existingMc.historian as Record<string, unknown>) } as Record<string, unknown>)
      : {}
  if (historianModelRef) {
    const existingPi =
      historianBlock.pi && typeof historianBlock.pi === 'object'
        ? (historianBlock.pi as Record<string, unknown>)
        : {}
    historianBlock.pi = {
      ...existingPi,
      model:
        prefs.magicContextStorageMode === 'shared' &&
        typeof existingPi.model === 'string' &&
        existingPi.model
          ? existingPi.model
          : historianModelRef,
    }
  }

  const dreamerBlock =
    existingMc.dreamer && typeof existingMc.dreamer === 'object'
      ? ({ ...(existingMc.dreamer as Record<string, unknown>) } as Record<string, unknown>)
      : {}
  if (!prefs.dreamerEnabled) {
    if (prefs.magicContextStorageMode === 'isolated' || !Object.hasOwn(dreamerBlock, 'disable')) {
      dreamerBlock.disable = true
    }
  } else {
    dreamerBlock.disable = false
    if (dreamerModelRef) {
      const existingDreamPi =
        dreamerBlock.pi && typeof dreamerBlock.pi === 'object'
          ? (dreamerBlock.pi as Record<string, unknown>)
          : {}
      dreamerBlock.pi = { ...existingDreamPi, model: dreamerModelRef }
    }
  }
  if (prefs.magicContextStorageMode === 'isolated') {
    dreamerBlock.inject_docs = false
  }

  const embeddingBlock =
    prefs.embeddingMode === 'local'
      ? { provider: 'local', local_runtime: 'wasm' }
      : { provider: 'off' }

  const existingMemory =
    existingMc.memory && typeof existingMc.memory === 'object'
      ? (existingMc.memory as Record<string, unknown>)
      : {}
  const existingAutoSearch =
    existingMemory.auto_search && typeof existingMemory.auto_search === 'object'
      ? (existingMemory.auto_search as Record<string, unknown>)
      : {}

  const nextMcConfig: Record<string, unknown> = {
    ...existingMc,
    enabled: prefs.magicContextEnabled,
    allow_home_project: true,
    temporal_awareness: prefs.temporalAwareness,
    historian: historianBlock,
    dreamer: dreamerBlock,
    embedding:
      prefs.magicContextStorageMode === 'shared' && existingMc.embedding
        ? existingMc.embedding
        : embeddingBlock,
    memory: {
      ...existingMemory,
      enabled: true,
      auto_search: {
        ...existingAutoSearch,
        enabled: prefs.autoSearchHints,
      },
    },
  }

  if (prefs.magicContextStorageMode === 'isolated' || !existsSync(paths.magicContextConfigPath)) {
    writeJsonEnsuringDir(paths.magicContextConfigPath, nextMcConfig)
  }

  return spec
}
