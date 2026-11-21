import { app, ipcMain, type WebContents } from 'electron'

import {
  PI_AGENT_CHANNELS,
  type PiAgentCommandInfo,
  type PiAgentConfirmReply,
  type PiAgentPromptRequest,
  type PiAgentPromptResult,
  type PiDiagnosticReport,
  type PiEcosystemOverview,
  type PiMagicMemoryEntry,
  type PiPackageActionResult,
} from '../shared/pi-agent-api'
import { mergePiAgentPrefs, type PiAgentPrefs } from '../shared/pi-agent-prefs'
import { PI_AGENT_KEY, readPiAgentPrefs } from './pi-agent/pi-agent-prefs'
import { writeAppSetting } from './app-settings'
import type { PiEcosystemService } from './pi-agent/pi-ecosystem-service'
import type { PiAgentRuntimeManager } from './pi-agent/pi-runtime'

export function isEnvLegacyEngineForced(): boolean {
  return process.env.GENOFFICE_ASK_ENGINE?.trim().toLowerCase() === 'legacy'
}

export interface RegisterPiAgentIpcDeps {
  readonly appSettingsPath: () => string
  readonly panelWebContents: () => readonly WebContents[]
  readonly isShellWindowWebContents: (sender: WebContents) => boolean
  readonly runtime: PiAgentRuntimeManager
  readonly ecosystem: PiEcosystemService
}

function asPromptRequest(raw: unknown): PiAgentPromptRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.sessionKey !== 'string' || !r.sessionKey.trim()) return null
  if (typeof r.projectId !== 'string' || !r.projectId.trim()) return null
  if (typeof r.chatId !== 'string' || !r.chatId.trim()) return null
  if (typeof r.instruction !== 'string' || !r.instruction.trim()) return null
  return {
    sessionKey: r.sessionKey.trim(),
    projectId: r.projectId.trim(),
    chatId: r.chatId.trim(),
    docPath: typeof r.docPath === 'string' && r.docPath ? r.docPath : null,
    instruction: r.instruction,
    ...(Array.isArray(r.skills)
      ? { skills: r.skills.filter((s): s is string => typeof s === 'string') }
      : {}),
    ...(Array.isArray(r.attachments)
      ? { attachments: r.attachments as PiAgentPromptRequest['attachments'] }
      : {}),
    ...(Array.isArray(r.images)
      ? { images: r.images as PiAgentPromptRequest['images'] }
      : {}),
    ...(Array.isArray(r.scopePaths)
      ? { scopePaths: r.scopePaths.filter((p): p is string => typeof p === 'string') }
      : {}),
    ...(typeof r.lineageSeed === 'string' || r.lineageSeed === null
      ? { lineageSeed: r.lineageSeed }
      : {}),
    ...(typeof r.lang === 'string' ? { lang: r.lang as PiAgentPromptRequest['lang'] } : {}),
    ...(typeof r.ignoreActiveTabContext === 'boolean'
      ? { ignoreActiveTabContext: r.ignoreActiveTabContext }
      : {}),
    ...(typeof r.focusedTabId === 'string' || r.focusedTabId === null
      ? { focusedTabId: r.focusedTabId }
      : {}),
  }
}

function asConfirmReply(raw: unknown): PiAgentConfirmReply | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.requestId !== 'string' || !r.requestId.trim()) return null
  return {
    requestId: r.requestId,
    allowed: r.allowed === true,
    ...(typeof r.alwaysAllowSession === 'boolean'
      ? { alwaysAllowSession: r.alwaysAllowSession }
      : {}),
  }
}

export function registerPiAgentIpc(deps: RegisterPiAgentIpcDeps): void {
  const isPanel = (sender: WebContents): boolean =>
    deps.panelWebContents().some((wc) => !wc.isDestroyed() && wc === sender)

  const isTrustedSender = (sender: WebContents): boolean =>
    isPanel(sender) || deps.isShellWindowWebContents(sender)

  const readEffectivePrefs = (): PiAgentPrefs => {
    const stored = readPiAgentPrefs(deps.appSettingsPath())
    return isEnvLegacyEngineForced() ? { ...stored, engine: 'legacy' } : stored
  }

  ipcMain.handle(PI_AGENT_CHANNELS.prefsGet, (): PiAgentPrefs => readEffectivePrefs())

  ipcMain.handle(
    PI_AGENT_CHANNELS.prefsSet,
    async (event, rawPatch: unknown): Promise<PiAgentPrefs> => {
      if (!isTrustedSender(event.sender)) {
        throw new Error('pi-agent:prefs-set is not callable from this sender')
      }
      const settingsPath = deps.appSettingsPath()
      const current = readPiAgentPrefs(settingsPath)
      const next = mergePiAgentPrefs(current, rawPatch)
      writeAppSetting(settingsPath, PI_AGENT_KEY, next)
      await deps.runtime.reloadAll()
      return isEnvLegacyEngineForced() ? { ...next, engine: 'legacy' } : next
    },
  )

  ipcMain.handle(
    PI_AGENT_CHANNELS.prompt,
    async (event, rawReq: unknown): Promise<PiAgentPromptResult> => {
      if (!isPanel(event.sender)) {
        throw new Error('pi-agent:prompt is not callable from this sender')
      }
      if (readEffectivePrefs().engine !== 'pi') {
        return { ok: false, error: 'Pi agent engine is disabled or forced to legacy.' }
      }
      const req = asPromptRequest(rawReq)
      if (!req) {
        return { ok: false, error: 'Invalid Pi prompt payload.' }
      }
      return deps.runtime.prompt(req)
    },
  )

  ipcMain.handle(PI_AGENT_CHANNELS.abort, async (event, sessionKey: unknown): Promise<boolean> => {
    if (!isTrustedSender(event.sender)) return false
    if (typeof sessionKey !== 'string' || !sessionKey.trim()) return false
    return deps.runtime.abort(sessionKey.trim())
  })

  ipcMain.handle(PI_AGENT_CHANNELS.commandsList, async (): Promise<PiAgentCommandInfo[]> => {
    return deps.runtime.listCommands()
  })

  ipcMain.handle(PI_AGENT_CHANNELS.confirmReply, (event, rawReply: unknown): boolean => {
    if (!isTrustedSender(event.sender)) return false
    const reply = asConfirmReply(rawReply)
    if (!reply) return false
    return deps.runtime.resolveConfirm(reply)
  })

  ipcMain.handle(
    PI_AGENT_CHANNELS.ecosystemOverview,
    async (event): Promise<PiEcosystemOverview> => {
      if (!isTrustedSender(event.sender)) {
        throw new Error('pi-agent:ecosystem-overview is not callable from this sender')
      }
      return deps.ecosystem.getOverview()
    },
  )

  ipcMain.handle(
    PI_AGENT_CHANNELS.packageInstall,
    async (event, source: unknown): Promise<PiPackageActionResult> => {
      if (!deps.isShellWindowWebContents(event.sender)) {
        throw new Error('pi-agent:package-install requires the Settings window')
      }
      return deps.ecosystem.installPackage(typeof source === 'string' ? source : '')
    },
  )

  ipcMain.handle(
    PI_AGENT_CHANNELS.packageRemove,
    async (event, source: unknown): Promise<PiPackageActionResult> => {
      if (!deps.isShellWindowWebContents(event.sender)) {
        throw new Error('pi-agent:package-remove requires the Settings window')
      }
      return deps.ecosystem.removePackage(typeof source === 'string' ? source : '')
    },
  )

  ipcMain.handle(
    PI_AGENT_CHANNELS.packageUpdate,
    async (event, source?: unknown): Promise<PiPackageActionResult> => {
      if (!deps.isShellWindowWebContents(event.sender)) {
        throw new Error('pi-agent:package-update requires the Settings window')
      }
      return deps.ecosystem.updatePackages(typeof source === 'string' ? source : undefined)
    },
  )

  ipcMain.handle(PI_AGENT_CHANNELS.reload, async (event): Promise<void> => {
    if (!isTrustedSender(event.sender)) {
      throw new Error('pi-agent:reload is not callable from this sender')
    }
    await deps.runtime.reloadAll()
  })

  ipcMain.handle(
    PI_AGENT_CHANNELS.memoriesList,
    (
      event,
      opts?: { limit?: unknown; category?: unknown; project?: unknown },
    ): PiMagicMemoryEntry[] => {
      if (!isTrustedSender(event.sender)) {
        throw new Error('pi-agent:memories-list is not callable from this sender')
      }
      const cleanOpts =
        opts && typeof opts === 'object'
          ? {
              ...(typeof opts.limit === 'number' ? { limit: opts.limit } : {}),
              ...(typeof opts.category === 'string' ? { category: opts.category } : {}),
              ...(typeof opts.project === 'string' ? { project: opts.project } : {}),
            }
          : undefined
      return deps.ecosystem.listMemories(cleanOpts)
    },
  )

  ipcMain.handle(
    PI_AGENT_CHANNELS.memoryDelete,
    (event, id: unknown): { ok: boolean } => {
      if (!deps.isShellWindowWebContents(event.sender)) {
        throw new Error('pi-agent:memory-delete requires the Settings window')
      }
      return deps.ecosystem.deleteMemory(typeof id === 'number' ? id : -1)
    },
  )

  ipcMain.handle(PI_AGENT_CHANNELS.runDiagnostics, async (event): Promise<PiDiagnosticReport> => {
    if (!isTrustedSender(event.sender)) {
      throw new Error('pi-agent:run-diagnostics is not callable from this sender')
    }
    return deps.ecosystem.runDiagnostics()
  })

  // Keep userData ready in case callers query paths prior to first prompt.
  void app.getPath('userData')
}
