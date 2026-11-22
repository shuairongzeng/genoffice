import { ipcMain } from 'electron'
import type { WebContents } from 'electron'

import {
  isButlerOpenTarget,
  type ButlerHudState,
  type ButlerOpenTarget,
  type ButlerSubmitResult,
} from '../../shared/butler-api'
import { HOME_CHANNELS } from '../../shared/home-api'
import { readButlerPrefs, writeButlerPrefs } from './butler-prefs-store'

export interface ButlerIpcDeps {
  settingsPath: () => string
  service: {
    submit(text: string): ButlerSubmitResult
    hudState(opts?: { forceBriefing?: boolean; peek?: boolean }): ButlerHudState
  }
  isHudSender: (wc: WebContents) => boolean
  isShellSender: (wc: WebContents) => boolean
  openTarget: (target: ButlerOpenTarget) => void
  hideHud: () => void
  resizeHud: (height: number) => void
}

/** Register main-process IPC handlers for Butler preferences and HUD actions. */
export function registerButlerIpc(deps: ButlerIpcDeps): void {
  ipcMain.handle(HOME_CHANNELS.butlerGet, async () => {
    return readButlerPrefs(deps.settingsPath())
  })

  ipcMain.handle(HOME_CHANNELS.butlerSet, async (event, patch: unknown) => {
    if (!deps.isShellSender(event.sender) && !deps.isHudSender(event.sender)) {
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
    return deps.service.hudState(parsedOpts)
  })

  ipcMain.handle(HOME_CHANNELS.butlerSubmit, async (event, text: unknown) => {
    if (!deps.isHudSender(event.sender)) {
      throw new Error('Unauthorized butler submit')
    }
    if (typeof text !== 'string') {
      throw new Error('Butler instruction must be a string')
    }
    return deps.service.submit(text)
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
}
