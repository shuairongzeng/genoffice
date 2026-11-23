import { ipcMain } from 'electron'
import type { WebContents } from 'electron'

import {
  isButlerOpenTarget,
  type ButlerHudState,
  type ButlerOpenTarget,
  type ButlerSubmitResult,
} from '../../shared/butler-api'
import {
  BUTLER_CHIEF_SESSION_KEY,
  isButlerOpenDeskPayload,
  isButlerResolveDecisionRequest,
  isButlerSteerTaskRequest,
  type ButlerActionResult,
  type ButlerDelegateResult,
  type ButlerDeskSnapshot,
  type ButlerOpenDeskPayload,
  type ButlerResolveDecisionResult,
} from '../../shared/butler-orchestrator-api'
import { HOME_CHANNELS } from '../../shared/home-api'
import type { ButlerMissionEngine } from './butler-mission-engine'
import { readButlerPrefs, writeButlerPrefs } from './butler-prefs-store'

const EMPTY_DESK_SNAPSHOT: ButlerDeskSnapshot = {
  chiefSessionKey: BUTLER_CHIEF_SESSION_KEY,
  chiefBusy: false,
  missions: [],
  tasks: [],
  decisions: [],
  feed: [],
  concurrency: { running: 0, maxConcurrent: 3, queued: 0 },
}

export interface ButlerIpcDeps {
  settingsPath: () => string
  service: {
    submit(text: string): ButlerSubmitResult
    hudState(opts?: { forceBriefing?: boolean; peek?: boolean }): ButlerHudState
  }
  missionEngine?: ButlerMissionEngine
  openDesk?: (payload?: ButlerOpenDeskPayload) => void
  isHudSender: (wc: WebContents) => boolean
  isShellSender: (wc: WebContents) => boolean
  openTarget: (target: ButlerOpenTarget) => void
  hideHud: () => void
  resizeHud: (height: number) => void
}

/** Register main-process IPC handlers for Butler preferences, HUD, and Chief Desk actions. */
export function registerButlerIpc(deps: ButlerIpcDeps): void {
  const isAuthorizedSender = (wc: WebContents): boolean =>
    deps.isShellSender(wc) || deps.isHudSender(wc)

  ipcMain.handle(HOME_CHANNELS.butlerGet, async () => {
    return readButlerPrefs(deps.settingsPath())
  })

  ipcMain.handle(HOME_CHANNELS.butlerSet, async (event, patch: unknown) => {
    if (!isAuthorizedSender(event.sender)) {
      throw new Error('Unauthorized butler prefs write')
    }
    return writeButlerPrefs(deps.settingsPath(), patch)
  })

  ipcMain.handle(HOME_CHANNELS.butlerHudState, async (event, opts?: unknown) => {
    if (!deps.isHudSender(event.sender)) {
      throw new Error('Unauthorized butler HUD state request')
    }
    const raw = opts !== null && typeof opts === 'object' && !Array.isArray(opts) ? opts : null
    const forceBriefing =
      raw && typeof (raw as { forceBriefing?: unknown }).forceBriefing === 'boolean'
        ? (raw as { forceBriefing: boolean }).forceBriefing
        : undefined
    const peek =
      raw && typeof (raw as { peek?: unknown }).peek === 'boolean'
        ? (raw as { peek: boolean }).peek
        : undefined
    const parsedOpts =
      forceBriefing === undefined && peek === undefined
        ? undefined
        : {
            ...(forceBriefing !== undefined ? { forceBriefing } : {}),
            ...(peek !== undefined ? { peek } : {}),
          }
    const base = deps.service.hudState(parsedOpts)
    if (!deps.missionEngine) return base

    const snap = deps.missionEngine.getSnapshot()
    const pendingDecisions = snap.decisions.filter((d) => d.status === 'pending')
    const activeMissionCount = snap.missions.filter(
      (m) =>
        m.status === 'planning' ||
        m.status === 'running' ||
        m.status === 'waiting_human' ||
        m.status === 'synthesizing',
    ).length
    return {
      ...base,
      pendingDecisions,
      activeMissionCount,
    }
  })

  ipcMain.handle(HOME_CHANNELS.butlerSubmit, async (event, text: unknown) => {
    if (!deps.isHudSender(event.sender)) {
      throw new Error('Unauthorized butler submit')
    }
    if (typeof text !== 'string') {
      throw new Error('Butler instruction must be a string')
    }
    if (!deps.missionEngine) {
      return deps.service.submit(text)
    }
    const prefs = readButlerPrefs(deps.settingsPath())
    if (!prefs.enabled) {
      return { ok: false, error: 'disabled' } satisfies ButlerSubmitResult
    }
    const trimmed = text.trim()
    if (!trimmed) {
      return { ok: false, error: 'empty' } satisfies ButlerSubmitResult
    }
    const res = await deps.missionEngine.delegate(trimmed)
    return {
      ok: res.ok,
      ...(res.ok ? { sessionKey: BUTLER_CHIEF_SESSION_KEY } : { error: 'failed' as const }),
      ...(res.error ? { message: res.error } : {}),
    } satisfies ButlerSubmitResult
  })

  ipcMain.handle(HOME_CHANNELS.butlerOpen, async (event, rawTarget: unknown) => {
    if (!deps.isHudSender(event.sender)) {
      throw new Error('Unauthorized butler open request')
    }
    if (!isButlerOpenTarget(rawTarget)) {
      throw new Error('Invalid butler open target')
    }
    deps.openTarget(rawTarget)
  })

  ipcMain.on(HOME_CHANNELS.butlerHide, (event) => {
    if (!deps.isHudSender(event.sender)) return
    deps.hideHud()
  })

  ipcMain.on(HOME_CHANNELS.butlerResize, (event, height: unknown) => {
    if (!deps.isHudSender(event.sender)) return
    if (typeof height !== 'number' || !Number.isFinite(height)) return
    deps.resizeHud(height)
  })

  ipcMain.handle(HOME_CHANNELS.butlerDeskState, async (event): Promise<ButlerDeskSnapshot> => {
    if (!isAuthorizedSender(event.sender)) {
      throw new Error('Unauthorized butler desk state request')
    }
    return deps.missionEngine ? deps.missionEngine.getSnapshot() : EMPTY_DESK_SNAPSHOT
  })

  ipcMain.handle(
    HOME_CHANNELS.butlerDelegate,
    async (event, goal: unknown): Promise<ButlerDelegateResult> => {
      if (!isAuthorizedSender(event.sender)) {
        throw new Error('Unauthorized butler delegate request')
      }
      if (typeof goal !== 'string') {
        throw new Error('Butler goal must be a string')
      }
      if (!deps.missionEngine) {
        return { ok: false, error: 'Butler orchestrator is unavailable' }
      }
      return deps.missionEngine.delegate(goal)
    },
  )

  ipcMain.handle(
    HOME_CHANNELS.butlerResolveDecision,
    async (event, req: unknown): Promise<ButlerResolveDecisionResult> => {
      if (!isAuthorizedSender(event.sender)) {
        throw new Error('Unauthorized butler decision request')
      }
      if (!isButlerResolveDecisionRequest(req)) {
        throw new Error('Invalid butler resolve decision request')
      }
      if (!deps.missionEngine) {
        return { ok: false, error: 'Butler orchestrator is unavailable' }
      }
      return deps.missionEngine.resolveDecision(req)
    },
  )

  ipcMain.handle(
    HOME_CHANNELS.butlerCancelMission,
    async (event, missionId: unknown): Promise<ButlerActionResult> => {
      if (!isAuthorizedSender(event.sender)) {
        throw new Error('Unauthorized butler cancel mission request')
      }
      if (typeof missionId !== 'string' || missionId.trim().length === 0) {
        throw new Error('Invalid butler missionId')
      }
      if (!deps.missionEngine) {
        return { ok: false, error: 'Butler orchestrator is unavailable' }
      }
      return deps.missionEngine.cancelMission(missionId)
    },
  )

  ipcMain.handle(
    HOME_CHANNELS.butlerCancelTask,
    async (event, taskId: unknown): Promise<ButlerActionResult> => {
      if (!isAuthorizedSender(event.sender)) {
        throw new Error('Unauthorized butler cancel task request')
      }
      if (typeof taskId !== 'string' || taskId.trim().length === 0) {
        throw new Error('Invalid butler taskId')
      }
      if (!deps.missionEngine) {
        return { ok: false, error: 'Butler orchestrator is unavailable' }
      }
      return deps.missionEngine.cancelTask(taskId)
    },
  )

  ipcMain.handle(
    HOME_CHANNELS.butlerSteerTask,
    async (event, req: unknown): Promise<ButlerActionResult> => {
      if (!isAuthorizedSender(event.sender)) {
        throw new Error('Unauthorized butler steer task request')
      }
      if (!isButlerSteerTaskRequest(req)) {
        throw new Error('Invalid butler steer task request')
      }
      if (!deps.missionEngine) {
        return { ok: false, error: 'Butler orchestrator is unavailable' }
      }
      return deps.missionEngine.steerTask(req)
    },
  )

  ipcMain.handle(HOME_CHANNELS.butlerOpenDesk, async (event, payload?: unknown): Promise<void> => {
    if (!isAuthorizedSender(event.sender)) {
      throw new Error('Unauthorized butler open desk request')
    }
    if (!isButlerOpenDeskPayload(payload)) {
      throw new Error('Invalid butler open desk payload')
    }
    deps.openDesk?.(payload ?? {})
  })
}
