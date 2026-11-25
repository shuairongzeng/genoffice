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
  isButlerApproveMissionPlanRequest,
  isButlerOpenDeskPayload,
  isButlerResolveDecisionRequest,
  isButlerRetryTaskRequest,
  isButlerSteerTaskRequest,
  type ButlerActionResult,
  type ButlerDelegateResult,
  type ButlerDeskSnapshot,
  type ButlerOpenDeskPayload,
  type ButlerResolveDecisionResult,
} from '../../shared/butler-orchestrator-api'
import type {
  ButlerMicArbitrationState,
  ButlerSttTranscribeRequest,
  ButlerSttTranscribeResult,
  ButlerTtsStartRequest,
  ButlerTtsStartResult,
  ButlerTtsStreamEvent,
  ButlerVoiceCloneState,
  ButlerVoiceCloneUploadRequest,
  ButlerVoiceConfig,
  ButlerVoiceConfigPatch,
  ButlerVoiceProbeRequest,
  ButlerVoiceProbeResult,
  ButlerWakePromptPayload,
  ButlerWakeSummonRequest,
  ButlerWakeSummonResult,
} from '../../shared/butler-voice-api'
import { HOME_CHANNELS } from '../../shared/home-api'
import type { ButlerMissionEngine } from './butler-mission-engine'
import { readButlerPrefs, writeButlerPrefs } from './butler-prefs-store'
import {
  readButlerVoiceConfig,
  writeButlerVoiceConfig,
  type ButlerVoiceService,
} from './butler-voice-service'

const EMPTY_DESK_SNAPSHOT: ButlerDeskSnapshot = {
  chiefSessionKey: BUTLER_CHIEF_SESSION_KEY,
  chiefBusy: false,
  missions: [],
  tasks: [],
  decisions: [],
  feed: [],
  concurrency: { running: 0, maxConcurrent: 3, queued: 0 },
}

const EMPTY_CLONE_STATE: ButlerVoiceCloneState = {
  hasAudio: false,
  fileName: '',
  byteLength: 0,
  updatedAt: null,
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseProbeRequest(raw: unknown): ButlerVoiceProbeRequest {
  if (raw === undefined) return {}
  if (!isPlainObject(raw)) {
    throw new Error('Invalid butler voice probe request')
  }
  if (raw.baseUrl !== undefined && typeof raw.baseUrl !== 'string') {
    throw new Error('Invalid butler voice probe baseUrl')
  }
  if (raw.apiKey !== undefined && typeof raw.apiKey !== 'string') {
    throw new Error('Invalid butler voice probe apiKey')
  }
  if (raw.ttsModel !== undefined && typeof raw.ttsModel !== 'string') {
    throw new Error('Invalid butler voice probe ttsModel')
  }
  return {
    ...(raw.baseUrl !== undefined ? { baseUrl: raw.baseUrl } : {}),
    ...(raw.apiKey !== undefined ? { apiKey: raw.apiKey } : {}),
    ...(raw.ttsModel !== undefined ? { ttsModel: raw.ttsModel } : {}),
  }
}

function parseTranscribeRequest(raw: unknown): ButlerSttTranscribeRequest {
  if (!isPlainObject(raw)) {
    throw new Error('Invalid butler voice transcribe request')
  }
  let wavBytes: Uint8Array | undefined
  if (raw.wavBytes !== undefined) {
    if (raw.wavBytes instanceof Uint8Array) {
      wavBytes = raw.wavBytes
    } else if (raw.wavBytes instanceof ArrayBuffer) {
      wavBytes = new Uint8Array(raw.wavBytes)
    } else if (ArrayBuffer.isView(raw.wavBytes)) {
      wavBytes = new Uint8Array(
        raw.wavBytes.buffer,
        raw.wavBytes.byteOffset,
        raw.wavBytes.byteLength,
      )
    } else {
      throw new Error('Invalid butler voice transcribe wavBytes')
    }
  }
  const wavBase64 = typeof raw.wavBase64 === 'string' ? raw.wavBase64 : undefined
  if (raw.wavBase64 !== undefined && typeof raw.wavBase64 !== 'string') {
    throw new Error('Invalid butler voice transcribe wavBase64')
  }
  if ((!wavBytes || wavBytes.byteLength === 0) && (!wavBase64 || wavBase64.trim().length === 0)) {
    throw new Error('Butler voice transcribe requires non-empty audio')
  }
  if (raw.language !== undefined && typeof raw.language !== 'string') {
    throw new Error('Invalid butler voice transcribe language')
  }
  if (raw.prompt !== undefined && typeof raw.prompt !== 'string') {
    throw new Error('Invalid butler voice transcribe prompt')
  }
  if (raw.purpose !== undefined && raw.purpose !== 'command' && raw.purpose !== 'wake') {
    throw new Error('Invalid butler voice transcribe purpose')
  }
  return {
    ...(wavBytes ? { wavBytes } : {}),
    ...(wavBase64 !== undefined ? { wavBase64 } : {}),
    ...(raw.language !== undefined ? { language: raw.language } : {}),
    ...(raw.prompt !== undefined ? { prompt: raw.prompt } : {}),
    ...(raw.purpose !== undefined ? { purpose: raw.purpose } : {}),
  }
}

function parseTtsStartRequest(raw: unknown): ButlerTtsStartRequest {
  if (!isPlainObject(raw)) {
    throw new Error('Invalid butler voice TTS request')
  }
  if (typeof raw.requestId !== 'string' || raw.requestId.trim().length === 0) {
    throw new Error('Invalid butler voice TTS requestId')
  }
  if (typeof raw.text !== 'string') {
    throw new Error('Invalid butler voice TTS text')
  }
  if (raw.voice !== undefined && typeof raw.voice !== 'string') {
    throw new Error('Invalid butler voice TTS voice')
  }
  if (raw.speed !== undefined && (typeof raw.speed !== 'number' || !Number.isFinite(raw.speed))) {
    throw new Error('Invalid butler voice TTS speed')
  }
  if (raw.instructions !== undefined && typeof raw.instructions !== 'string') {
    throw new Error('Invalid butler voice TTS instructions')
  }
  if (raw.configOverride !== undefined && !isPlainObject(raw.configOverride)) {
    throw new Error('Invalid butler voice TTS configOverride')
  }
  return {
    requestId: raw.requestId,
    text: raw.text,
    ...(raw.voice !== undefined ? { voice: raw.voice } : {}),
    ...(raw.speed !== undefined ? { speed: raw.speed } : {}),
    ...(raw.instructions !== undefined ? { instructions: raw.instructions } : {}),
    ...(raw.configOverride !== undefined
      ? { configOverride: raw.configOverride as ButlerVoiceConfigPatch }
      : {}),
  }
}

function parseCloneUploadRequest(raw: unknown): ButlerVoiceCloneUploadRequest {
  if (!isPlainObject(raw)) {
    throw new Error('Invalid butler voice clone upload request')
  }
  if (typeof raw.audioBase64 !== 'string' || raw.audioBase64.trim().length === 0) {
    throw new Error('Invalid butler voice clone audioBase64')
  }
  if (typeof raw.fileName !== 'string') {
    throw new Error('Invalid butler voice clone fileName')
  }
  if (raw.refText !== undefined && typeof raw.refText !== 'string') {
    throw new Error('Invalid butler voice clone refText')
  }
  return {
    audioBase64: raw.audioBase64,
    fileName: raw.fileName,
    ...(raw.refText !== undefined ? { refText: raw.refText } : {}),
  }
}

function parseWakeSummonRequest(raw: unknown): ButlerWakeSummonRequest {
  if (!isPlainObject(raw)) {
    throw new Error('Invalid butler voice wake summon request')
  }
  if (raw.mode !== 'listen' && raw.mode !== 'command') {
    throw new Error('Invalid butler voice wake summon mode')
  }
  if (typeof raw.rawText !== 'string') {
    throw new Error('Invalid butler voice wake summon rawText')
  }
  if (raw.commandText !== undefined && typeof raw.commandText !== 'string') {
    throw new Error('Invalid butler voice wake summon commandText')
  }
  return {
    mode: raw.mode,
    rawText: raw.rawText,
    ...(raw.commandText !== undefined ? { commandText: raw.commandText } : {}),
  }
}

export interface ButlerIpcDeps {
  settingsPath: () => string
  service: {
    submit(text: string): ButlerSubmitResult
    hudState(opts?: { forceBriefing?: boolean; peek?: boolean }): ButlerHudState
  }
  missionEngine?: ButlerMissionEngine
  openDesk?: (payload?: ButlerOpenDeskPayload) => void
  voiceService?: ButlerVoiceService
  showHud?: () => void
  focusHud?: () => void
  broadcastShell?: (channel: string, payload?: unknown) => void
  broadcastHud?: (channel: string, payload?: unknown) => void
  isHudSender: (wc: WebContents) => boolean
  isShellSender: (wc: WebContents) => boolean
  openTarget: (target: ButlerOpenTarget) => void
  hideHud: () => void
  resizeHud: (height: number) => void
}

/** Register main-process IPC handlers for Butler preferences, HUD, voice gateway, and Chief Desk actions. */
export function registerButlerIpc(deps: ButlerIpcDeps): void {
  const isAuthorizedSender = (wc: WebContents): boolean =>
    deps.isShellSender(wc) || deps.isHudSender(wc)

  let arbitrationState: ButlerMicArbitrationState = {
    deskMicActive: false,
    ttsSpeaking: false,
    updatedAt: 0,
  }

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
        m.status === 'clarifying' ||
        m.status === 'awaiting_plan_approval' ||
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

  ipcMain.handle(
    HOME_CHANNELS.butlerApprovePlan,
    async (event, req: unknown): Promise<ButlerActionResult> => {
      if (!isAuthorizedSender(event.sender)) {
        throw new Error('Unauthorized butler approve plan request')
      }
      if (!isButlerApproveMissionPlanRequest(req)) {
        throw new Error('Invalid butler approve plan request')
      }
      if (!deps.missionEngine) {
        return { ok: false, error: 'Butler orchestrator is unavailable' }
      }
      return deps.missionEngine.approveMissionPlan(req)
    },
  )

  ipcMain.handle(
    HOME_CHANNELS.butlerDeleteMission,
    async (event, missionId: unknown): Promise<ButlerActionResult> => {
      if (!isAuthorizedSender(event.sender)) {
        throw new Error('Unauthorized butler delete mission request')
      }
      if (typeof missionId !== 'string' || missionId.trim().length === 0) {
        throw new Error('Invalid butler missionId')
      }
      if (!deps.missionEngine) {
        return { ok: false, error: 'Butler orchestrator is unavailable' }
      }
      return deps.missionEngine.deleteMission(missionId)
    },
  )

  ipcMain.handle(
    HOME_CHANNELS.butlerRetryTask,
    async (event, req: unknown): Promise<ButlerActionResult> => {
      if (!isAuthorizedSender(event.sender)) {
        throw new Error('Unauthorized butler retry task request')
      }
      if (!isButlerRetryTaskRequest(req)) {
        throw new Error('Invalid butler retry task request')
      }
      if (!deps.missionEngine) {
        return { ok: false, error: 'Butler orchestrator is unavailable' }
      }
      return deps.missionEngine.retryTask(req)
    },
  )

  ipcMain.handle(HOME_CHANNELS.butlerVoiceGet, async (event): Promise<ButlerVoiceConfig> => {
    if (!isAuthorizedSender(event.sender)) {
      throw new Error('Unauthorized butler voice config request')
    }
    return deps.voiceService
      ? deps.voiceService.getConfig()
      : readButlerVoiceConfig(deps.settingsPath())
  })

  ipcMain.handle(
    HOME_CHANNELS.butlerVoiceSet,
    async (event, patch: unknown): Promise<ButlerVoiceConfig> => {
      if (!isAuthorizedSender(event.sender)) {
        throw new Error('Unauthorized butler voice config write')
      }
      if (!isPlainObject(patch)) {
        throw new Error('Invalid butler voice config patch')
      }
      return deps.voiceService
        ? deps.voiceService.setConfig(patch)
        : writeButlerVoiceConfig(deps.settingsPath(), patch)
    },
  )

  ipcMain.handle(
    HOME_CHANNELS.butlerVoiceProbe,
    async (event, rawReq?: unknown): Promise<ButlerVoiceProbeResult> => {
      if (!isAuthorizedSender(event.sender)) {
        throw new Error('Unauthorized butler voice probe request')
      }
      const req = parseProbeRequest(rawReq)
      if (!deps.voiceService) {
        return {
          ok: false,
          latencyMs: 0,
          sttModels: [],
          ttsModels: [],
          voices: [],
          error: 'Butler voice service is unavailable',
        }
      }
      return deps.voiceService.probe(req)
    },
  )

  ipcMain.handle(
    HOME_CHANNELS.butlerVoiceTranscribe,
    async (event, rawReq: unknown): Promise<ButlerSttTranscribeResult> => {
      if (!isAuthorizedSender(event.sender)) {
        throw new Error('Unauthorized butler voice transcribe request')
      }
      const req = parseTranscribeRequest(rawReq)
      if (!deps.voiceService) {
        return {
          ok: false,
          text: '',
          latencyMs: 0,
          error: 'Butler voice service is unavailable',
        }
      }
      return deps.voiceService.transcribe(req)
    },
  )

  ipcMain.handle(
    HOME_CHANNELS.butlerVoiceTtsStart,
    async (event, rawReq: unknown): Promise<ButlerTtsStartResult> => {
      if (!isAuthorizedSender(event.sender)) {
        throw new Error('Unauthorized butler voice TTS start request')
      }
      const req = parseTtsStartRequest(rawReq)
      if (!deps.voiceService) {
        return {
          ok: false,
          requestId: req.requestId,
          fallbackSystem: true,
          error: 'Butler voice service is unavailable',
        }
      }
      const sender = event.sender as WebContents & { isDestroyed?: () => boolean }
      const emitEvent = (streamEvent: ButlerTtsStreamEvent): void => {
        if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) return
        if (typeof sender.send === 'function') {
          sender.send(HOME_CHANNELS.butlerVoiceTtsEvent, streamEvent)
        }
      }
      return deps.voiceService.startTts(req, emitEvent)
    },
  )

  ipcMain.handle(
    HOME_CHANNELS.butlerVoiceTtsStop,
    async (event, requestId?: unknown): Promise<void> => {
      if (!isAuthorizedSender(event.sender)) {
        throw new Error('Unauthorized butler voice TTS stop request')
      }
      if (requestId !== undefined && typeof requestId !== 'string') {
        throw new Error('Invalid butler voice TTS requestId')
      }
      deps.voiceService?.stopTts(requestId)
      if (!requestId) {
        arbitrationState = {
          ...arbitrationState,
          ttsSpeaking: false,
          updatedAt: Date.now(),
        }
        const stopEvent: ButlerTtsStreamEvent = {
          requestId: '*',
          type: 'error',
          fallbackSystem: false,
        }
        deps.broadcastShell?.(HOME_CHANNELS.butlerVoiceTtsEvent, stopEvent)
        deps.broadcastHud?.(HOME_CHANNELS.butlerVoiceTtsEvent, stopEvent)
        deps.broadcastShell?.(HOME_CHANNELS.butlerVoiceArbitration, arbitrationState)
        deps.broadcastHud?.(HOME_CHANNELS.butlerVoiceArbitration, arbitrationState)
      }
    },
  )

  ipcMain.handle(HOME_CHANNELS.butlerVoiceCloneGet, async (event): Promise<ButlerVoiceCloneState> => {
    if (!isAuthorizedSender(event.sender)) {
      throw new Error('Unauthorized butler voice clone get request')
    }
    return deps.voiceService ? deps.voiceService.getCloneState() : EMPTY_CLONE_STATE
  })

  ipcMain.handle(
    HOME_CHANNELS.butlerVoiceCloneSet,
    async (event, rawReq: unknown): Promise<ButlerVoiceConfig> => {
      if (!isAuthorizedSender(event.sender)) {
        throw new Error('Unauthorized butler voice clone set request')
      }
      const req = parseCloneUploadRequest(rawReq)
      if (!deps.voiceService) {
        throw new Error('Butler voice service is unavailable')
      }
      return deps.voiceService.setCloneAudio(req)
    },
  )

  ipcMain.handle(HOME_CHANNELS.butlerVoiceCloneClear, async (event): Promise<ButlerVoiceConfig> => {
    if (!isAuthorizedSender(event.sender)) {
      throw new Error('Unauthorized butler voice clone clear request')
    }
    if (!deps.voiceService) {
      return readButlerVoiceConfig(deps.settingsPath())
    }
    return deps.voiceService.clearCloneAudio()
  })

  ipcMain.handle(
    HOME_CHANNELS.butlerVoiceWakeSummon,
    async (event, rawReq: unknown): Promise<ButlerWakeSummonResult> => {
      if (!isAuthorizedSender(event.sender)) {
        throw new Error('Unauthorized butler voice wake summon request')
      }
      const req = parseWakeSummonRequest(rawReq)
      const prefs = readButlerPrefs(deps.settingsPath())
      if (!prefs.enabled) {
        return { ok: false, submitted: false, error: 'disabled' }
      }

      if (req.mode === 'command') {
        const command = req.commandText?.trim() ?? ''
        if (!command) {
          return { ok: false, submitted: false, error: 'Command text is empty' }
        }
        deps.showHud?.()
        if (deps.missionEngine) {
          const res = await deps.missionEngine.delegate(command)
          return {
            ok: res.ok,
            submitted: res.ok,
            ...(res.error ? { error: res.error } : {}),
          }
        }
        const res = deps.service.submit(command)
        return {
          ok: res.ok,
          submitted: res.ok,
          ...(res.message ? { error: res.message } : res.error ? { error: res.error } : {}),
        }
      }

      deps.showHud?.()
      deps.focusHud?.()
      deps.broadcastHud?.(HOME_CHANNELS.butlerVoiceWakePrompt, {
        autoListen: true,
        wakeAck: true,
      } satisfies ButlerWakePromptPayload)
      return { ok: true, submitted: false }
    },
  )

  ipcMain.on(HOME_CHANNELS.butlerVoiceArbitration, (event, patch: unknown) => {
    if (!isAuthorizedSender(event.sender)) return
    if (!isPlainObject(patch)) return
    const hasDeskMic = typeof patch.deskMicActive === 'boolean'
    const hasTtsSpeaking = typeof patch.ttsSpeaking === 'boolean'
    if (!hasDeskMic && !hasTtsSpeaking) return

    arbitrationState = {
      deskMicActive: hasDeskMic ? (patch.deskMicActive as boolean) : arbitrationState.deskMicActive,
      ttsSpeaking: hasTtsSpeaking
        ? (patch.ttsSpeaking as boolean)
        : arbitrationState.ttsSpeaking,
      updatedAt: Date.now(),
    }
    deps.broadcastShell?.(HOME_CHANNELS.butlerVoiceArbitration, arbitrationState)
    deps.broadcastHud?.(HOME_CHANNELS.butlerVoiceArbitration, arbitrationState)
  })
}
