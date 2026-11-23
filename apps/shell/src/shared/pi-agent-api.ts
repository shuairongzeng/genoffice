/**
 * Shared IPC contracts between shell main, preload, and renderer for the
 * embedded Pi Agent runtime, Magic Context memory/context status, and
 * community extension/skill ecosystem management.
 */

import type { AgentImage, AgentToolCall, AttachmentInfo } from '@genoffice/agent-core'
import type { Lang } from '@genoffice/i18n'

export const PI_AGENT_CHANNELS = {
  prefsGet: 'pi-agent:prefs-get',
  prefsSet: 'pi-agent:prefs-set',
  prefsChanged: 'pi-agent:prefs-changed',
  prompt: 'pi-agent:prompt',
  abort: 'pi-agent:abort',
  commandsList: 'pi-agent:commands-list',
  confirmRequest: 'pi-agent:confirm-request',
  confirmReply: 'pi-agent:confirm-reply',
  statusEvent: 'pi-agent:status-event',
  noticeEvent: 'pi-agent:notice-event',
  ecosystemOverview: 'pi-agent:ecosystem-overview',
  packageInstall: 'pi-agent:package-install',
  packageRemove: 'pi-agent:package-remove',
  packageUpdate: 'pi-agent:package-update',
  reload: 'pi-agent:reload',
  memoriesList: 'pi-agent:memories-list',
  memoryDelete: 'pi-agent:memory-delete',
  runDiagnostics: 'pi-agent:run-diagnostics',
  sessionRebind: 'pi-agent:session-rebind',
  sessionDelete: 'pi-agent:session-delete',
} as const

export interface PiAgentPromptRequest {
  readonly sessionKey: string
  readonly projectId: string
  readonly chatId: string
  readonly docPath: string | null
  /** Clean user text persisted in project-store. */
  readonly instruction: string
  /** Optional attached skill names (expanded in main / runtime). */
  readonly skills?: readonly string[]
  readonly attachments?: readonly AttachmentInfo[]
  readonly images?: readonly AgentImage[]
  readonly scopePaths?: readonly string[]
  readonly lineageSeed?: string | null
  readonly lang?: Lang
  /** Explicitly detaches the currently active shell tab from this turn's focus context. */
  readonly ignoreActiveTabContext?: boolean
  /** Optional shell tab id currently focused in the UI when the prompt was submitted. */
  readonly focusedTabId?: string | null
}

export interface PiAgentPromptResult {
  readonly ok: boolean
  readonly commandHandled?: boolean
  readonly commandOutput?: string
  readonly finalText?: string
  readonly error?: string
}

export interface PiAgentConfirmRequest {
  readonly requestId: string
  readonly sessionKey: string
  readonly call: AgentToolCall
  readonly argsSummary?: string
  readonly sessionAllowable: boolean
  readonly sourceLabel?: string
}

export interface PiAgentConfirmReply {
  readonly requestId: string
  readonly allowed: boolean
  readonly alwaysAllowSession?: boolean
}

export interface PiAgentStatusPayload {
  readonly sessionKey: string
  readonly contextTokens: number | null
  readonly contextWindow: number
  readonly contextPercent: number | null
  readonly memoryCount?: number
  readonly compartmentCount?: number
  readonly magicContextActive: boolean
  readonly statusText?: string
  readonly engine: 'pi' | 'legacy'
}

export interface PiAgentNoticePayload {
  readonly sessionKey?: string
  readonly level: 'info' | 'warning' | 'error'
  readonly message: string
  readonly customType?: string
}

export interface PiAgentCommandInfo {
  readonly name: string
  readonly description?: string
  readonly source: string
}

export interface PiInstalledPackageInfo {
  readonly source: string
  readonly scope: 'user' | 'project'
  readonly filtered: boolean
  readonly installedPath?: string
}

export interface PiLoadedExtensionInfo {
  readonly path: string
  readonly source: string
  readonly toolNames: readonly string[]
  readonly commandNames: readonly string[]
}

export interface PiLoadedSkillInfo {
  readonly name: string
  readonly description: string
  readonly filePath: string
  readonly sourceKind: 'genoffice' | 'plugin' | 'pi-package' | 'pi-local'
}

export interface PiDiagnosticItem {
  readonly id: string
  readonly label: string
  readonly ok: boolean
  readonly detail: string
}

export interface PiDiagnosticReport {
  readonly ok: boolean
  readonly checkedAt: string
  readonly items: readonly PiDiagnosticItem[]
}

export interface PiEcosystemOverview {
  readonly activeEngine: 'pi' | 'legacy'
  readonly envOverrideLegacy: boolean
  readonly magicContextLoaded: boolean
  readonly magicContextVersion: string | null
  readonly piCodingAgentVersion: string | null
  readonly agentDir: string
  readonly storageDir: string
  readonly shimPath: string
  readonly nodeSqliteSupported: boolean
  readonly memoryCount: number
  readonly compartmentCount: number
  readonly packages: readonly PiInstalledPackageInfo[]
  readonly extensions: readonly PiLoadedExtensionInfo[]
  readonly skills: readonly PiLoadedSkillInfo[]
  readonly commands: readonly PiAgentCommandInfo[]
  readonly diagnostics: readonly PiDiagnosticItem[]
  readonly extensionErrors: readonly { path: string; error: string }[]
}

export interface PiMagicMemoryEntry {
  readonly id: number
  readonly projectIdentity: string
  readonly category: string
  readonly content: string
  readonly importance?: number
  readonly createdAt?: string
  readonly updatedAt?: string
}

export interface PiPackageActionResult {
  readonly ok: boolean
  readonly message?: string
  readonly error?: string
}

export interface PiDocCheckpoint {
  readonly tabId: string
  readonly kind: string
  readonly title: string
  readonly checkpointId: string
  readonly editCount: number
  readonly createdAt: number
  readonly summary?: string
}
