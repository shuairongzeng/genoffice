import type { AgentTaskResult, AgentTaskStatus } from '@genoffice/agent-core'
import { readAttachmentImageFromMain, readAttachmentTextFromMain } from './app-registry'
import {
  executeBrowserSkillFromMain,
  listBrowserTabsFromMain,
  listSurfaceTabsFromMain,
} from './browser-agent'
import {
  cancelDocumentAgentFromMain,
  describeDocumentAgentFromMain,
  runDocumentAgentFromMain,
  undoDocumentAgentFromMain,
  type DocumentAgentTarget,
  type DocumentAgentUndoResult,
} from './document-agent'
import { getRegisteredKbWorkbenchHandlers, type KbWorkbenchHandlers } from './home-ipc'
import {
  executeAppSkillFromMain,
  getAppSkillManifestFromMain,
  STATIC_PROXIED_APP_TOOLS,
} from './mcp/app-skill-proxy'
import type { AiLineageEntry, AiLineageStore } from './ai-lineage'

export { STATIC_PROXIED_APP_TOOLS }

export interface WorkbenchToolsService {
  kbList(): Promise<unknown>
  kbSearch(raw: { q: string; limit?: number; onlyPaths?: string[] }): Promise<unknown>
  kbRead(raw: { path: string; offset?: number; onlyPaths?: string[] }): Promise<unknown>
  createDocument(raw: unknown): Promise<unknown>
  editFile(raw: unknown): Promise<unknown>
  deleteFile(raw: unknown): Promise<unknown>
  readAttachment(
    filePath: string,
    offset: number,
    maxChars: number,
  ): ReturnType<typeof readAttachmentTextFromMain>
  readAttachmentImage(filePath: string): ReturnType<typeof readAttachmentImageFromMain>
  cliContext(sessionId: string): unknown
  runCli(
    sessionId: string,
    raw: {
      args: string[]
      files?: { name: string; content: string }[]
      sources?: string[]
    },
  ): Promise<unknown>
  getAppSkillManifest(): ReturnType<typeof getAppSkillManifestFromMain>
  executeAppSkill(
    tool: string,
    input: Record<string, unknown>,
  ): ReturnType<typeof executeAppSkillFromMain>
  describeDocumentAgent(tabId?: string): Promise<DocumentAgentTarget | { error: string }>
  runDocumentAgent(
    req: { task: string; tabId?: string; expectedTabId?: string },
    onProgress?: (event: { taskId: string; kind: string; status: AgentTaskStatus }) => void,
    callerKey?: string,
  ): Promise<AgentTaskResult>
  cancelDocumentAgent(callerKey?: string): boolean
  undoDocumentAgent(tabId: string, checkpointId: string): Promise<DocumentAgentUndoResult>
  executeBrowserSkill(
    tool: string,
    input: Record<string, unknown>,
    opts?: { skipMainConfirm?: boolean },
  ): Promise<unknown>
  listBrowserTabs(): ReturnType<typeof listBrowserTabsFromMain>
  listSurfaceTabs(): ReturnType<typeof listSurfaceTabsFromMain>
  recordLineage(entry: Omit<AiLineageEntry, 'at'> & { at?: string }): void
  lineageFor(path: string): AiLineageEntry | null
}

export interface WorkbenchToolsServiceDeps {
  kbHandlers?: () => KbWorkbenchHandlers | null
  aiLineage?: () => Pick<AiLineageStore, 'record' | 'lineageFor'> | null
}

/**
 * In-process facade over GenOffice's desktop workbench capabilities so the
 * main-process Pi runtime invokes the exact same validation, scope, and tab
 * safety checks as legacy renderer IPC without extra serialization hops.
 */
export function createWorkbenchToolsService(
  deps: WorkbenchToolsServiceDeps = {},
): WorkbenchToolsService {
  const requireKb = (): KbWorkbenchHandlers => {
    const handlers = deps.kbHandlers?.() ?? getRegisteredKbWorkbenchHandlers()
    if (!handlers) throw new Error('home workbench handlers are not initialized')
    return handlers
  }

  return {
    kbList: () => requireKb().list(),
    kbSearch: (raw) => requireKb().search(raw),
    kbRead: (raw) => requireKb().read(raw),
    createDocument: (raw) => requireKb().createDocument(raw),
    editFile: (raw) => requireKb().editFile(raw),
    deleteFile: (raw) => requireKb().deleteFile(raw),
    readAttachment: (filePath, offset, maxChars) =>
      readAttachmentTextFromMain(filePath, offset, maxChars),
    readAttachmentImage: (filePath) => readAttachmentImageFromMain(filePath),
    cliContext: (sessionId) => requireKb().cliContext(sessionId),
    runCli: (sessionId, raw) => requireKb().runCli({ sessionId, ...raw }),
    getAppSkillManifest: () => getAppSkillManifestFromMain(),
    executeAppSkill: (tool, input) => executeAppSkillFromMain(tool, input),
    describeDocumentAgent: (tabId) => describeDocumentAgentFromMain(tabId),
    runDocumentAgent: (req, onProgress, callerKey) =>
      runDocumentAgentFromMain(req, onProgress, callerKey),
    cancelDocumentAgent: (callerKey) => cancelDocumentAgentFromMain(callerKey),
    undoDocumentAgent: (tabId, checkpointId) => undoDocumentAgentFromMain(tabId, checkpointId),
    executeBrowserSkill: (tool, input, opts) => executeBrowserSkillFromMain(tool, input, opts),
    listBrowserTabs: () => listBrowserTabsFromMain(),
    listSurfaceTabs: () => listSurfaceTabsFromMain(),
    recordLineage: (entry) => {
      try {
        deps.aiLineage?.()?.record(entry)
      } catch {
        // Lineage capture failure must never fail document creation.
      }
    },
    lineageFor: (path) => deps.aiLineage?.()?.lineageFor(path) ?? null,
  }
}
