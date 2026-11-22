import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (event: { sender: unknown }, ...args: unknown[]) => unknown

const ipcMock = vi.hoisted(() => {
  const handles = new Map<string, IpcHandler>()
  const ons = new Map<string, IpcHandler>()
  return {
    handles,
    ons,
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handles.set(channel, handler)
    }),
    on: vi.fn((channel: string, handler: IpcHandler) => {
      ons.set(channel, handler)
    }),
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: ipcMock.handle,
    on: ipcMock.on,
  },
}))

import { registerButlerIpc } from '../src/main/butler/butler-ipc'
import type { ButlerHudState, ButlerOpenTarget, ButlerSubmitResult } from '../src/shared/butler-api'
import { DEFAULT_BUTLER_PREFS } from '../src/shared/butler-prefs'
import { HOME_CHANNELS } from '../src/shared/home-api'

let dir: string
let settingsPath: string

const hudSender = { id: 100 } as never
const shellSender = { id: 200 } as never
const strangerSender = { id: 300 } as never

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-butler-ipc-'))
  settingsPath = join(dir, 'app-settings.json')
  ipcMock.handles.clear()
  ipcMock.ons.clear()
  ipcMock.handle.mockClear()
  ipcMock.on.mockClear()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function setupIpc() {
  const submitSpy = vi.fn((): ButlerSubmitResult => ({ ok: true, sessionKey: 'default:butler-1' }))
  const hudStateSpy = vi.fn((): ButlerHudState => ({
    prefs: DEFAULT_BUTLER_PREFS,
    hotkey: 'Alt+Space',
    briefing: null,
    tasks: [],
  }))
  const openTargetSpy = vi.fn()
  const hideHudSpy = vi.fn()
  const resizeHudSpy = vi.fn()

  registerButlerIpc({
    settingsPath: () => settingsPath,
    service: {
      submit: submitSpy,
      hudState: hudStateSpy,
    },
    isHudSender: (wc) => wc === (hudSender as unknown),
    isShellSender: (wc) => wc === (shellSender as unknown),
    openTarget: openTargetSpy,
    hideHud: hideHudSpy,
    resizeHud: resizeHudSpy,
  })

  const invoke = (channel: string, sender: unknown, ...args: unknown[]) =>
    ipcMock.handles.get(channel)!({ sender }, ...args)

  const emit = (channel: string, sender: unknown, ...args: unknown[]) =>
    ipcMock.ons.get(channel)!({ sender }, ...args)

  return {
    submitSpy,
    hudStateSpy,
    openTargetSpy,
    hideHudSpy,
    resizeHudSpy,
    invoke,
    emit,
  }
}

describe('registerButlerIpc', () => {
  it('allows any sender to read prefs via butlerGet', async () => {
    const { invoke } = setupIpc()
    await expect(invoke(HOME_CHANNELS.butlerGet, strangerSender)).resolves.toEqual(
      DEFAULT_BUTLER_PREFS,
    )
  })

  it('gates butlerSet to shell or HUD senders and persists patches', async () => {
    const { invoke } = setupIpc()

    await expect(invoke(HOME_CHANNELS.butlerSet, strangerSender, { name: 'Evil' })).rejects.toThrow(
      /Unauthorized/,
    )

    const afterShell = await invoke(HOME_CHANNELS.butlerSet, shellSender, { name: 'Alfred' })
    expect(afterShell).toEqual({ ...DEFAULT_BUTLER_PREFS, name: 'Alfred' })

    const afterHud = await invoke(HOME_CHANNELS.butlerSet, hudSender, { dnd: true })
    expect(afterHud).toEqual({ ...DEFAULT_BUTLER_PREFS, name: 'Alfred', dnd: true })
  })

  it('gates butlerHudState strictly to the HUD sender', async () => {
    const { invoke, hudStateSpy } = setupIpc()

    await expect(invoke(HOME_CHANNELS.butlerHudState, shellSender)).rejects.toThrow(/Unauthorized/)
    await expect(invoke(HOME_CHANNELS.butlerHudState, strangerSender)).rejects.toThrow(
      /Unauthorized/,
    )

    await invoke(HOME_CHANNELS.butlerHudState, hudSender)
    expect(hudStateSpy).toHaveBeenLastCalledWith(undefined)

    await invoke(HOME_CHANNELS.butlerHudState, hudSender, { forceBriefing: true })
    expect(hudStateSpy).toHaveBeenLastCalledWith({ forceBriefing: true })

    await invoke(HOME_CHANNELS.butlerHudState, hudSender, { peek: true })
    expect(hudStateSpy).toHaveBeenLastCalledWith({ peek: true })

    await invoke(HOME_CHANNELS.butlerHudState, hudSender, { peek: 'x' })
    expect(hudStateSpy).toHaveBeenLastCalledWith(undefined)
  })

  it('gates butlerSubmit to the HUD sender and requires string instruction', async () => {
    const { invoke, submitSpy } = setupIpc()

    await expect(invoke(HOME_CHANNELS.butlerSubmit, shellSender, 'hi')).rejects.toThrow(
      /Unauthorized/,
    )
    await expect(invoke(HOME_CHANNELS.butlerSubmit, hudSender, 123)).rejects.toThrow(/string/)
    await expect(invoke(HOME_CHANNELS.butlerSubmit, hudSender, null)).rejects.toThrow(/string/)

    const res = await invoke(HOME_CHANNELS.butlerSubmit, hudSender, '总结文档')
    expect(res).toEqual({ ok: true, sessionKey: 'default:butler-1' })
    expect(submitSpy).toHaveBeenCalledWith('总结文档')
  })

  it('gates butlerOpen to the HUD sender and validates target payload', async () => {
    const { invoke, openTargetSpy } = setupIpc()

    await expect(
      invoke(HOME_CHANNELS.butlerOpen, shellSender, { type: 'settings' }),
    ).rejects.toThrow(/Unauthorized/)

    await expect(invoke(HOME_CHANNELS.butlerOpen, hudSender, { type: 'invalid' })).rejects.toThrow(
      /Invalid/,
    )
    await expect(
      invoke(HOME_CHANNELS.butlerOpen, hudSender, { type: 'file', path: '  ', label: 'x' }),
    ).rejects.toThrow(/Invalid/)

    const target: ButlerOpenTarget = {
      type: 'session',
      sessionKey: 'default:butler-1',
      label: 'Task 1',
    }
    await invoke(HOME_CHANNELS.butlerOpen, hudSender, target)
    expect(openTargetSpy).toHaveBeenCalledWith(target)
  })

  it('gates butlerHide and butlerResize one-way channels to valid HUD messages', () => {
    const { emit, hideHudSpy, resizeHudSpy } = setupIpc()

    emit(HOME_CHANNELS.butlerHide, shellSender)
    emit(HOME_CHANNELS.butlerHide, strangerSender)
    expect(hideHudSpy).not.toHaveBeenCalled()

    emit(HOME_CHANNELS.butlerHide, hudSender)
    expect(hideHudSpy).toHaveBeenCalledTimes(1)

    emit(HOME_CHANNELS.butlerResize, shellSender, 240)
    emit(HOME_CHANNELS.butlerResize, hudSender, '240')
    emit(HOME_CHANNELS.butlerResize, hudSender, Number.NaN)
    emit(HOME_CHANNELS.butlerResize, hudSender, Number.POSITIVE_INFINITY)
    expect(resizeHudSpy).not.toHaveBeenCalled()

    emit(HOME_CHANNELS.butlerResize, hudSender, 240)
    expect(resizeHudSpy).toHaveBeenCalledWith(240)
  })
})
