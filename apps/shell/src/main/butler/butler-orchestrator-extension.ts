import type { AgentToolResult, ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type {
  ButlerDecisionItem,
  ButlerDecisionOption,
  ButlerDecisionResolution,
  ButlerMissionReport,
  ButlerSubTask,
  ButlerWorkerRole,
} from '../../shared/butler-orchestrator-api'
import type { ButlerPrefs } from '../../shared/butler-prefs'
import {
  appendButlerPersona,
  buildButlerChiefRolePrompt,
  buildButlerWorkerRolePrompt,
} from './butler-persona'

export const BUTLER_CHIEF_TOOL_NAMES = [
  'butler_dispatch_task',
  'butler_list_tasks',
  'butler_inspect_task',
  'butler_steer_task',
  'butler_cancel_task',
  'butler_request_decision',
  'butler_publish_report',
] as const

export const BUTLER_WORKER_TOOL_NAMES = ['butler_worker_request_decision'] as const

const VALID_WORKER_ROLES: readonly ButlerWorkerRole[] = [
  'general',
  'research',
  'docs',
  'sheets',
  'slides',
  'browser',
]
const VALID_OPTION_STYLES: ReadonlySet<NonNullable<ButlerDecisionOption['style']>> = new Set([
  'primary',
  'default',
  'danger',
])

export interface ButlerChiefToolBridge {
  readonly dispatchTask: (input: {
    readonly missionId?: string
    readonly title: string
    readonly brief: string
    readonly role?: ButlerWorkerRole
    readonly dependsOn?: string[]
    readonly scopePaths?: string[]
    readonly workdir?: string
  }) => Promise<{ readonly ok: boolean; readonly task?: ButlerSubTask; readonly error?: string }>
  readonly listTasks: (
    missionId?: string,
  ) => readonly ButlerSubTask[] | Promise<readonly ButlerSubTask[]>
  readonly inspectTask: (taskId: string) =>
    | { readonly task: ButlerSubTask; readonly decisions: readonly ButlerDecisionItem[] }
    | null
    | Promise<{
        readonly task: ButlerSubTask
        readonly decisions: readonly ButlerDecisionItem[]
      } | null>
  readonly steerTask: (req: {
    readonly taskId: string
    readonly instruction: string
  }) => Promise<{ readonly ok: boolean; readonly error?: string }>
  readonly cancelTask: (
    taskId: string,
  ) => Promise<{ readonly ok: boolean; readonly error?: string }>
  readonly requestChiefDecision: (input: {
    readonly missionId?: string
    readonly taskId?: string
    readonly title: string
    readonly summary: string
    readonly detail?: string
    readonly options: readonly ButlerDecisionOption[]
  }) => Promise<ButlerDecisionResolution>
  readonly publishReport: (input: {
    readonly missionId?: string
    readonly headline: string
    readonly summary: string
    readonly artifactPaths?: readonly { readonly path: string; readonly label?: string }[]
    readonly risks?: readonly string[]
    readonly nextSuggestion?: string
  }) => Promise<{
    readonly ok: boolean
    readonly report?: ButlerMissionReport
    readonly error?: string
  }>
}

export interface ButlerWorkerToolBridge {
  readonly requestWorkerChoice: (
    sessionKey: string,
    input: {
      readonly title: string
      readonly summary: string
      readonly detail?: string
      readonly options: readonly ButlerDecisionOption[]
    },
  ) => Promise<ButlerDecisionResolution>
}

export type ButlerToolResultDetails = Record<string, unknown>

type ParseResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function jsonToolResult(
  payload: unknown,
  isError = false,
): AgentToolResult<ButlerToolResultDetails> {
  const details: ButlerToolResultDetails = isPlainObject(payload) ? payload : { value: payload }
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    details: isError ? { ...details, isError: true } : details,
    ...(isError ? { isError: true } : {}),
  }
}

function errorToolResult(message: string): AgentToolResult<ButlerToolResultDetails> {
  return jsonToolResult({ ok: false, error: message }, true)
}

async function runToolSafely(
  fn: () => Promise<AgentToolResult<ButlerToolResultDetails>>,
): Promise<AgentToolResult<ButlerToolResultDetails>> {
  try {
    return await fn()
  } catch (err) {
    return errorToolResult(err instanceof Error ? err.message : String(err))
  }
}

function readRequiredString(obj: Record<string, unknown>, key: string): ParseResult<string> {
  const raw = obj[key]
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, error: `"${key}" must be a non-empty string` }
  }
  return { ok: true, value: raw.trim() }
}

function readOptionalNonEmptyString(
  obj: Record<string, unknown>,
  key: string,
): ParseResult<string | undefined> {
  const raw = obj[key]
  if (raw === undefined) return { ok: true, value: undefined }
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, error: `"${key}" must be a non-empty string when provided` }
  }
  return { ok: true, value: raw.trim() }
}

function readOptionalTextString(
  obj: Record<string, unknown>,
  key: string,
): ParseResult<string | undefined> {
  const raw = obj[key]
  if (raw === undefined) return { ok: true, value: undefined }
  if (typeof raw !== 'string') {
    return { ok: false, error: `"${key}" must be a string when provided` }
  }
  const trimmed = raw.trim()
  return { ok: true, value: trimmed.length > 0 ? trimmed : undefined }
}

function readOptionalStringArray(
  obj: Record<string, unknown>,
  key: string,
): ParseResult<string[] | undefined> {
  const raw = obj[key]
  if (raw === undefined) return { ok: true, value: undefined }
  if (!Array.isArray(raw)) {
    return { ok: false, error: `"${key}" must be an array of strings when provided` }
  }
  const out: string[] = []
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i]
    if (typeof item !== 'string' || item.trim().length === 0) {
      return { ok: false, error: `"${key}[${i}]" must be a non-empty string` }
    }
    out.push(item.trim())
  }
  return { ok: true, value: out }
}

function parseDecisionOptions(raw: unknown): ParseResult<ButlerDecisionOption[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: '"options" must be a non-empty array with at least 1 option' }
  }
  const seenIds = new Set<string>()
  const parsed: ButlerDecisionOption[] = []
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i]
    if (!isPlainObject(item)) {
      return { ok: false, error: `"options[${i}]" must be an object` }
    }
    const idRes = readRequiredString(item, 'id')
    if (!idRes.ok) return { ok: false, error: `options[${i}]: ${idRes.error}` }
    if (seenIds.has(idRes.value)) {
      return { ok: false, error: `options[${i}]: duplicate option id "${idRes.value}"` }
    }
    seenIds.add(idRes.value)

    const labelRes = readRequiredString(item, 'label')
    if (!labelRes.ok) return { ok: false, error: `options[${i}]: ${labelRes.error}` }

    const descRes = readOptionalTextString(item, 'description')
    if (!descRes.ok) return { ok: false, error: `options[${i}]: ${descRes.error}` }

    let style: ButlerDecisionOption['style'] | undefined
    if (item.style !== undefined) {
      if (
        typeof item.style !== 'string' ||
        !VALID_OPTION_STYLES.has(item.style as NonNullable<ButlerDecisionOption['style']>)
      ) {
        return {
          ok: false,
          error: `options[${i}]: "style" must be one of primary, default, danger`,
        }
      }
      style = item.style as ButlerDecisionOption['style']
    }

    parsed.push({
      id: idRes.value,
      label: labelRes.value,
      ...(descRes.value !== undefined ? { description: descRes.value } : {}),
      ...(style !== undefined ? { style } : {}),
    })
  }
  return { ok: true, value: parsed }
}

function parseDecisionBaseInput(params: unknown): ParseResult<{
  readonly title: string
  readonly summary: string
  readonly detail?: string
  readonly options: ButlerDecisionOption[]
}> {
  if (!isPlainObject(params)) {
    return { ok: false, error: 'Arguments must be an object' }
  }
  const titleRes = readRequiredString(params, 'title')
  if (!titleRes.ok) return titleRes
  const summaryRes = readRequiredString(params, 'summary')
  if (!summaryRes.ok) return summaryRes
  const detailRes = readOptionalTextString(params, 'detail')
  if (!detailRes.ok) return detailRes
  const optionsRes = parseDecisionOptions(params.options)
  if (!optionsRes.ok) return optionsRes

  return {
    ok: true,
    value: {
      title: titleRes.value,
      summary: summaryRes.value,
      ...(detailRes.value !== undefined ? { detail: detailRes.value } : {}),
      options: optionsRes.value,
    },
  }
}

function parseArtifactPaths(
  raw: unknown,
): ParseResult<Array<{ readonly path: string; readonly label?: string }> | undefined> {
  if (raw === undefined) return { ok: true, value: undefined }
  if (!Array.isArray(raw)) {
    return { ok: false, error: '"artifactPaths" must be an array when provided' }
  }
  const parsed: Array<{ readonly path: string; readonly label?: string }> = []
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i]
    if (!isPlainObject(item)) {
      return { ok: false, error: `"artifactPaths[${i}]" must be an object` }
    }
    const pathRes = readRequiredString(item, 'path')
    if (!pathRes.ok) return { ok: false, error: `artifactPaths[${i}]: ${pathRes.error}` }
    const labelRes = readOptionalTextString(item, 'label')
    if (!labelRes.ok) return { ok: false, error: `artifactPaths[${i}]: ${labelRes.error}` }
    parsed.push({
      path: pathRes.value,
      ...(labelRes.value !== undefined ? { label: labelRes.value } : {}),
    })
  }
  return { ok: true, value: parsed }
}

function attachRolePromptHook(
  pi: ExtensionAPI,
  sectionName: 'butler_chief' | 'butler_worker',
  rolePrompt: string,
): void {
  pi.on('before_agent_start', (event) => {
    if (!rolePrompt.trim()) return undefined
    const sections = (event as { systemPromptOptions?: { sections?: Record<string, string> } })
      .systemPromptOptions?.sections
    if (sections) {
      sections[sectionName] = rolePrompt
      return undefined
    }
    return {
      systemPrompt: appendButlerPersona(event.systemPrompt, rolePrompt),
    }
  })
}

const DECISION_OPTIONS_SCHEMA = {
  type: 'array',
  minItems: 1,
  description: 'Structured options presented to the user (at least 1 option required).',
  items: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Unique option identifier.' },
      label: { type: 'string', description: 'Concise choice label shown to the user.' },
      description: {
        type: 'string',
        description: 'Optional explanatory subtitle for this option.',
      },
      style: {
        type: 'string',
        enum: ['primary', 'default', 'danger'],
        description: 'Optional button emphasis style.',
      },
    },
    required: ['id', 'label'],
    additionalProperties: false,
  },
}

const DECISION_BASE_PROPERTIES = {
  title: { type: 'string', description: 'Short decision prompt headline.' },
  summary: { type: 'string', description: 'Clear summary explaining why human input is needed.' },
  detail: { type: 'string', description: 'Optional additional context or tradeoffs.' },
  options: DECISION_OPTIONS_SCHEMA,
}

function registerToolDef(
  pi: ExtensionAPI,
  def: {
    readonly name: string
    readonly label: string
    readonly description: string
    readonly parameters: Record<string, unknown>
    readonly readOnly: boolean
    readonly execute: (
      toolCallId: string,
      params: unknown,
    ) => Promise<AgentToolResult<ButlerToolResultDetails>>
  },
): void {
  const tool: ToolDefinition<ToolDefinition['parameters'], ButlerToolResultDetails> = {
    name: def.name,
    label: def.label,
    description: def.description,
    parameters: def.parameters as unknown as ToolDefinition['parameters'],
    annotations: def.readOnly
      ? { readOnlyHint: true }
      : { readOnlyHint: false, destructiveHint: false },
    execute: (toolCallId, params) => runToolSafely(() => def.execute(toolCallId, params)),
  }
  pi.registerTool(tool)
}

/**
 * Create the Chief-of-Staff Butler Pi extension registering the 7 orchestration
 * tools (`BUTLER_CHIEF_TOOL_NAMES`) and attaching the Chief role guidance.
 */
export function createButlerChiefExtension(
  bridge: ButlerChiefToolBridge,
  opts?: { readonly prefs?: Pick<ButlerPrefs, 'name' | 'userName' | 'honorific'> },
): (pi: ExtensionAPI) => void {
  const chiefPrompt = buildButlerChiefRolePrompt(opts?.prefs)

  return (pi: ExtensionAPI) => {
    attachRolePromptHook(pi, 'butler_chief', chiefPrompt)

    registerToolDef(pi, {
      name: 'butler_dispatch_task',
      label: 'Dispatch Butler Task',
      description:
        'Create and schedule a background specialist task with optional role, DAG dependencies, and scope paths.',
      parameters: {
        type: 'object',
        properties: {
          missionId: { type: 'string', description: 'Optional target mission ID.' },
          title: { type: 'string', description: 'Short task title.' },
          brief: {
            type: 'string',
            description:
              'Detailed specialist brief specifying objectives, inputs, and expected outputs.',
          },
          role: {
            type: 'string',
            enum: [...VALID_WORKER_ROLES],
            description: 'Specialist worker role (defaults to "general").',
          },
          dependsOn: {
            type: 'array',
            items: { type: 'string' },
            description: 'Upstream task IDs that must finish before this task starts.',
          },
          scopePaths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional workspace or file paths restricting the specialist.',
          },
          workdir: { type: 'string', description: 'Optional working directory override.' },
        },
        required: ['title', 'brief'],
        additionalProperties: false,
      },
      readOnly: false,
      execute: async (_toolCallId, params) => {
        if (!isPlainObject(params)) return errorToolResult('Arguments must be an object')
        const missionIdRes = readOptionalNonEmptyString(params, 'missionId')
        if (!missionIdRes.ok) return errorToolResult(missionIdRes.error)
        const titleRes = readRequiredString(params, 'title')
        if (!titleRes.ok) return errorToolResult(titleRes.error)
        const briefRes = readRequiredString(params, 'brief')
        if (!briefRes.ok) return errorToolResult(briefRes.error)

        let role: ButlerWorkerRole | undefined
        if (params.role !== undefined) {
          if (
            typeof params.role !== 'string' ||
            !VALID_WORKER_ROLES.includes(params.role as ButlerWorkerRole)
          ) {
            return errorToolResult(`"role" must be one of: ${VALID_WORKER_ROLES.join(', ')}`)
          }
          role = params.role as ButlerWorkerRole
        }

        const dependsOnRes = readOptionalStringArray(params, 'dependsOn')
        if (!dependsOnRes.ok) return errorToolResult(dependsOnRes.error)
        const scopePathsRes = readOptionalStringArray(params, 'scopePaths')
        if (!scopePathsRes.ok) return errorToolResult(scopePathsRes.error)
        const workdirRes = readOptionalNonEmptyString(params, 'workdir')
        if (!workdirRes.ok) return errorToolResult(workdirRes.error)

        const res = await bridge.dispatchTask({
          ...(missionIdRes.value !== undefined ? { missionId: missionIdRes.value } : {}),
          title: titleRes.value,
          brief: briefRes.value,
          ...(role !== undefined ? { role } : {}),
          ...(dependsOnRes.value !== undefined ? { dependsOn: dependsOnRes.value } : {}),
          ...(scopePathsRes.value !== undefined ? { scopePaths: scopePathsRes.value } : {}),
          ...(workdirRes.value !== undefined ? { workdir: workdirRes.value } : {}),
        })
        return jsonToolResult(res, !res.ok)
      },
    })

    registerToolDef(pi, {
      name: 'butler_list_tasks',
      label: 'List Butler Tasks',
      description: 'List background tasks for the active mission or a specified mission ID.',
      parameters: {
        type: 'object',
        properties: {
          missionId: { type: 'string', description: 'Optional mission ID filter.' },
        },
        additionalProperties: false,
      },
      readOnly: true,
      execute: async (_toolCallId, params) => {
        if (params !== undefined && !isPlainObject(params)) {
          return errorToolResult('Arguments must be an object')
        }
        const missionIdRes = readOptionalNonEmptyString(params ?? {}, 'missionId')
        if (!missionIdRes.ok) return errorToolResult(missionIdRes.error)
        const tasks = await bridge.listTasks(missionIdRes.value)
        return jsonToolResult({ ok: true, count: tasks.length, tasks })
      },
    })

    registerToolDef(pi, {
      name: 'butler_inspect_task',
      label: 'Inspect Butler Task',
      description:
        'Inspect full task metadata, output summary, artifacts, and decision items by task ID.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Target task ID to inspect.' },
        },
        required: ['taskId'],
        additionalProperties: false,
      },
      readOnly: true,
      execute: async (_toolCallId, params) => {
        if (!isPlainObject(params)) return errorToolResult('Arguments must be an object')
        const taskIdRes = readRequiredString(params, 'taskId')
        if (!taskIdRes.ok) return errorToolResult(taskIdRes.error)
        const found = await bridge.inspectTask(taskIdRes.value)
        if (!found) {
          return errorToolResult(`Task not found: ${taskIdRes.value}`)
        }
        return jsonToolResult({ ok: true, task: found.task, decisions: found.decisions })
      },
    })

    registerToolDef(pi, {
      name: 'butler_steer_task',
      label: 'Steer Butler Task',
      description:
        'Send a corrective or updated instruction to a queued or running background task.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Target task ID.' },
          instruction: { type: 'string', description: 'Steering instruction for the worker.' },
        },
        required: ['taskId', 'instruction'],
        additionalProperties: false,
      },
      readOnly: false,
      execute: async (_toolCallId, params) => {
        if (!isPlainObject(params)) return errorToolResult('Arguments must be an object')
        const taskIdRes = readRequiredString(params, 'taskId')
        if (!taskIdRes.ok) return errorToolResult(taskIdRes.error)
        const instructionRes = readRequiredString(params, 'instruction')
        if (!instructionRes.ok) return errorToolResult(instructionRes.error)
        const res = await bridge.steerTask({
          taskId: taskIdRes.value,
          instruction: instructionRes.value,
        })
        return jsonToolResult(res, !res.ok)
      },
    })

    registerToolDef(pi, {
      name: 'butler_cancel_task',
      label: 'Cancel Butler Task',
      description: 'Cancel a queued, running, or waiting background task.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Target task ID to cancel.' },
        },
        required: ['taskId'],
        additionalProperties: false,
      },
      readOnly: false,
      execute: async (_toolCallId, params) => {
        if (!isPlainObject(params)) return errorToolResult('Arguments must be an object')
        const taskIdRes = readRequiredString(params, 'taskId')
        if (!taskIdRes.ok) return errorToolResult(taskIdRes.error)
        const res = await bridge.cancelTask(taskIdRes.value)
        return jsonToolResult(res, !res.ok)
      },
    })

    registerToolDef(pi, {
      name: 'butler_request_decision',
      label: 'Request Human Decision',
      description:
        'Present a structured multi-option decision to the human user and wait for their resolution.',
      parameters: {
        type: 'object',
        properties: {
          missionId: { type: 'string', description: 'Optional mission ID.' },
          taskId: { type: 'string', description: 'Optional related task ID.' },
          ...DECISION_BASE_PROPERTIES,
        },
        required: ['title', 'summary', 'options'],
        additionalProperties: false,
      },
      readOnly: true,
      execute: async (_toolCallId, params) => {
        const baseRes = parseDecisionBaseInput(params)
        if (!baseRes.ok) return errorToolResult(baseRes.error)
        const obj = params as Record<string, unknown>
        const missionIdRes = readOptionalNonEmptyString(obj, 'missionId')
        if (!missionIdRes.ok) return errorToolResult(missionIdRes.error)
        const taskIdRes = readOptionalNonEmptyString(obj, 'taskId')
        if (!taskIdRes.ok) return errorToolResult(taskIdRes.error)

        const resolution = await bridge.requestChiefDecision({
          ...(missionIdRes.value !== undefined ? { missionId: missionIdRes.value } : {}),
          ...(taskIdRes.value !== undefined ? { taskId: taskIdRes.value } : {}),
          ...baseRes.value,
        })
        return jsonToolResult(resolution)
      },
    })

    registerToolDef(pi, {
      name: 'butler_publish_report',
      label: 'Publish Mission Report',
      description:
        'Publish the final executive completion report for a mission with verified deliverable paths, risks, and suggested next step.',
      parameters: {
        type: 'object',
        properties: {
          missionId: { type: 'string', description: 'Optional mission ID.' },
          headline: { type: 'string', description: 'Short executive summary headline.' },
          summary: { type: 'string', description: 'Concise factual report of completed work.' },
          artifactPaths: {
            type: 'array',
            description: 'Verified output files produced during the mission.',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Verified file path.' },
                label: { type: 'string', description: 'Optional human-readable label.' },
              },
              required: ['path'],
              additionalProperties: false,
            },
          },
          risks: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional remaining risks or caveats.',
          },
          nextSuggestion: {
            type: 'string',
            description: 'Optional single best next step recommendation.',
          },
        },
        required: ['headline', 'summary'],
        additionalProperties: false,
      },
      readOnly: false,
      execute: async (_toolCallId, params) => {
        if (!isPlainObject(params)) return errorToolResult('Arguments must be an object')
        const missionIdRes = readOptionalNonEmptyString(params, 'missionId')
        if (!missionIdRes.ok) return errorToolResult(missionIdRes.error)
        const headlineRes = readRequiredString(params, 'headline')
        if (!headlineRes.ok) return errorToolResult(headlineRes.error)
        const summaryRes = readRequiredString(params, 'summary')
        if (!summaryRes.ok) return errorToolResult(summaryRes.error)
        const artifactsRes = parseArtifactPaths(params.artifactPaths)
        if (!artifactsRes.ok) return errorToolResult(artifactsRes.error)
        const risksRes = readOptionalStringArray(params, 'risks')
        if (!risksRes.ok) return errorToolResult(risksRes.error)
        const nextRes = readOptionalTextString(params, 'nextSuggestion')
        if (!nextRes.ok) return errorToolResult(nextRes.error)

        const res = await bridge.publishReport({
          ...(missionIdRes.value !== undefined ? { missionId: missionIdRes.value } : {}),
          headline: headlineRes.value,
          summary: summaryRes.value,
          ...(artifactsRes.value !== undefined ? { artifactPaths: artifactsRes.value } : {}),
          ...(risksRes.value !== undefined ? { risks: risksRes.value } : {}),
          ...(nextRes.value !== undefined ? { nextSuggestion: nextRes.value } : {}),
        })
        return jsonToolResult(res, !res.ok)
      },
    })
  }
}

/**
 * Create the isolated background worker Pi extension.
 * Security boundary: registers ONLY `butler_worker_request_decision` and never
 * exposes mission dispatch, steering, cancellation, or report publishing tools.
 */
export function createButlerWorkerExtension(
  bridge: ButlerWorkerToolBridge,
  role: ButlerWorkerRole,
  opts: {
    readonly sessionKey: string
    readonly title?: string
    readonly scopePaths?: readonly string[]
  },
): (pi: ExtensionAPI) => void {
  const workerPrompt = buildButlerWorkerRolePrompt(role, {
    title: opts.title,
    scopePaths: opts.scopePaths,
  })

  return (pi: ExtensionAPI) => {
    attachRolePromptHook(pi, 'butler_worker', workerPrompt)

    registerToolDef(pi, {
      name: 'butler_worker_request_decision',
      label: 'Request Chief Decision',
      description:
        'Escalate a blocking ambiguity or multi-option choice to the Chief Butler for human resolution.',
      parameters: {
        type: 'object',
        properties: DECISION_BASE_PROPERTIES,
        required: ['title', 'summary', 'options'],
        additionalProperties: false,
      },
      readOnly: true,
      execute: async (_toolCallId, params) => {
        if (typeof opts.sessionKey !== 'string' || opts.sessionKey.trim().length === 0) {
          return errorToolResult('Worker sessionKey is missing')
        }
        const baseRes = parseDecisionBaseInput(params)
        if (!baseRes.ok) return errorToolResult(baseRes.error)

        const resolution = await bridge.requestWorkerChoice(opts.sessionKey, baseRes.value)
        return jsonToolResult(resolution)
      },
    })
  }
}
