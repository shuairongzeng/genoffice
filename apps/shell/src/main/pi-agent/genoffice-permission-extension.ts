import type { AgentToolCall } from '@genoffice/agent-core'
import {
  BROWSER_LIST_ANNOTATIONS_TOOL,
  BROWSER_READ_ANNOTATION_SHOT_TOOL,
  BROWSER_READ_PAGE_TOOL,
  BROWSER_SCREENSHOT_TOOL,
  DELETE_FILE_TOOL,
  DOCUMENT_AGENT_TOOL,
  EDIT_FILE_TOOL,
  LOAD_GUIDE_TOOL,
  READ_ATTACHMENT_TOOL,
  SHELL_LIST_DIRECTORY_TOOL,
  SHELL_LIST_TABS_TOOL,
} from '@genoffice/agent-core'
import type { AiPermissionMode } from '@genoffice/ui/ai-permission-mode'
import type { ExtensionAPI, ExtensionFactory, ToolCallEvent } from '@earendil-works/pi-coding-agent'
import type { PiAgentConfirmRequest } from '../../shared/pi-agent-api'
import type { AiSessionAllows } from '../ai-session-allows'
import type { WorkbenchToolsService } from '../workbench-tools-service'
import {
  PARANOID_SIDE_EFFECT_TOOLS,
  type WorkbenchExtensionCoord,
} from './genoffice-workbench-extension'

/** Pure read-only tools across GenOffice, Pi core, and Magic Context (never ask). */
const ALWAYS_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  // GenOffice KB & attachments & read-only tools
  'search_knowledge_base',
  'read_knowledge_file',
  READ_ATTACHMENT_TOOL,
  LOAD_GUIDE_TOOL,
  SHELL_LIST_TABS_TOOL,
  SHELL_LIST_DIRECTORY_TOOL,
  BROWSER_READ_PAGE_TOOL,
  BROWSER_SCREENSHOT_TOOL,
  BROWSER_READ_ANNOTATION_SHOT_TOOL,
  BROWSER_LIST_ANNOTATIONS_TOOL,
  'docs:read_document',
  'sheets:read_sheet',
  'slides:read_deck',
  'markdown:read_text',
  'html:read_text',
  'pdf:read_pages',
  'media:read_media',
  'media:analyze_media',
  // Pi built-in read tools
  'read',
  'grep',
  'find',
  'ls',
  // Magic Context memory & context recall/compaction tools
  'ctx_search',
  'ctx_expand',
  'ctx_memory',
  'ctx_memory_list',
  'ctx_note',
  'ctx_reduce',
])

/** Pi built-in mutating / execution tools (require permission under smart & paranoid). */
const PI_SIDE_EFFECT_TOOLS: ReadonlySet<string> = new Set([
  'bash',
  'powershell',
  'edit',
  'write',
])

export type ToolPermissionGrade = 'read' | 'side-effect' | 'destructive'

export interface ClassifyToolPermissionInput {
  readonly toolName: string
  readonly coord?: Pick<WorkbenchExtensionCoord, 'toolRisks'>
  readonly annotations?: {
    readonly readOnlyHint?: boolean
    readonly destructiveHint?: boolean
  }
}

/**
 * Classify a tool call into read-only, recoverable side-effect, or destructive.
 * Unknown third-party extension tools default to `side-effect` (or `destructive`
 * when `annotations.destructiveHint === true`), only skipping confirmation if
 * explicitly declared `annotations.readOnlyHint === true`.
 */
export function classifyToolPermissionGrade(
  input: ClassifyToolPermissionInput,
): ToolPermissionGrade {
  const { toolName, coord, annotations } = input
  if (toolName === DELETE_FILE_TOOL || annotations?.destructiveHint === true) {
    return 'destructive'
  }
  const declared = coord?.toolRisks.get(toolName)
  if (declared === 'always-ask') return 'destructive'
  if (declared === 'high') return 'side-effect'

  if (ALWAYS_READ_ONLY_TOOLS.has(toolName)) return 'read'
  if (PI_SIDE_EFFECT_TOOLS.has(toolName) || PARANOID_SIDE_EFFECT_TOOLS.has(toolName)) {
    return 'side-effect'
  }
  if (declared === 'low') return 'read'
  if (annotations?.readOnlyHint === true) return 'read'

  // Unknown third-party community extension tool: treat as side-effect by default.
  return 'side-effect'
}

export interface ConfirmPromptResponse {
  readonly allowed: boolean
  readonly alwaysAllowSession?: boolean
}

export interface GenofficePermissionExtensionDeps {
  readonly getPermissionMode: () => AiPermissionMode
  readonly sessionAllows: AiSessionAllows
  readonly workbench: WorkbenchToolsService
  readonly coord: WorkbenchExtensionCoord
  readonly requestConfirm: (request: PiAgentConfirmRequest) => Promise<ConfirmPromptResponse>
}

async function computeEditFileSummary(
  workbench: WorkbenchToolsService,
  input: Record<string, unknown>,
): Promise<string> {
  const oldLen = typeof input.old_string === 'string' ? input.old_string.length : 0
  const newLen = typeof input.new_string === 'string' ? input.new_string.length : 0
  const path = typeof input.path === 'string' ? input.path : ''
  let total: number | undefined
  if (path) {
    try {
      const page = (await workbench.kbRead({ path, offset: 0 })) as { totalChars?: unknown }
      if (typeof page?.totalChars === 'number') total = page.totalChars
    } catch {
      // Omit total file length when unreadable before edit validation.
    }
  }
  const removed = Math.max(0, oldLen - newLen)
  const added = Math.max(0, newLen - oldLen)
  return (
    `removes ${removed} characters, adds ${added} characters` +
    (total !== undefined ? `, file: ${total} characters` : '')
  )
}

async function prepareDocumentAgentPin(
  workbench: WorkbenchToolsService,
  coord: WorkbenchExtensionCoord,
  toolCallId: string,
): Promise<string> {
  try {
    const described = await workbench.describeDocumentAgent()
    if ('tabId' in described) {
      coord.pinnedDocumentTabByCallId.set(toolCallId, described.tabId)
      return `works in "${described.title}"`
    }
  } catch {
    // Fall through to honest guidance when bridge cannot describe active tab.
  }
  coord.pinnedDocumentTabByCallId.delete(toolCallId)
  return 'no document is targeted — the run will refuse until one is active'
}

export function createGenofficePermissionExtension(
  deps: GenofficePermissionExtensionDeps,
  resolveAnnotations?: (
    toolName: string,
  ) => { readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean } | undefined,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on('tool_call', async (event: ToolCallEvent, ctx) => {
      const mode = deps.getPermissionMode()
      const toolName = event.toolName
      const rawInput = (event.input ?? {}) as Record<string, unknown>

      if (toolName === DOCUMENT_AGENT_TOOL) {
        // Clear any stale pin for this toolCallId before evaluating target.
        deps.coord.pinnedDocumentTabByCallId.delete(event.toolCallId)
      }

      if (mode === 'auto') {
        if (toolName === DELETE_FILE_TOOL) {
          deps.coord.approvedDeleteCallIds.add(event.toolCallId)
        }
        return undefined
      }

      const annotations = resolveAnnotations?.(toolName)
      const grade = classifyToolPermissionGrade({
        toolName,
        coord: deps.coord,
        annotations,
      })

      if (grade === 'read') {
        return undefined
      }

      const isDestructive = grade === 'destructive'
      const sessionAllowable = mode === 'smart' && !isDestructive

      if (sessionAllowable && deps.sessionAllows.has(toolName)) {
        return undefined
      }

      const piSessionId = ctx.sessionManager.getSessionId()
      const state = deps.coord.resolveTurnState(piSessionId)
      const sessionKey = state?.sessionKey ?? piSessionId

      let argsSummary: string | undefined
      if (toolName === EDIT_FILE_TOOL) {
        argsSummary = await computeEditFileSummary(deps.workbench, rawInput)
      } else if (toolName === DOCUMENT_AGENT_TOOL) {
        argsSummary = await prepareDocumentAgentPin(deps.workbench, deps.coord, event.toolCallId)
      }

      const call: AgentToolCall = {
        id: event.toolCallId,
        name: toolName,
        input: rawInput,
      }

      const reply = await deps.requestConfirm({
        requestId: event.toolCallId,
        sessionKey,
        call,
        ...(argsSummary !== undefined ? { argsSummary } : {}),
        sessionAllowable,
      })

      if (!reply.allowed) {
        deps.coord.pinnedDocumentTabByCallId.delete(event.toolCallId)
        deps.coord.approvedDeleteCallIds.delete(event.toolCallId)
        return {
          block: true,
          reason: `User declined execution of "${toolName}".`,
        }
      }

      if (sessionAllowable && reply.alwaysAllowSession) {
        deps.sessionAllows.add(toolName)
      }

      if (toolName === DELETE_FILE_TOOL) {
        deps.coord.approvedDeleteCallIds.add(event.toolCallId)
      }

      return undefined
    })
  }
}
