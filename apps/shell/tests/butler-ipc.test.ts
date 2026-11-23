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

  it('routes Chief Butler desk IPC channels and enriches HUD state when missionEngine is wired', async () => {
    const fakeSnapshot = {
      chiefSessionKey: 'default:butler-main',
      chiefBusy: true,
      missions: [
        {
          id: 'mission-1',
          title: 'Weekly sync',
          goal: 'Prepare weekly sync',
          status: 'waiting_human' as const,
          createdAt: 1,
          updatedAt: 2,
          taskIds: ['task-1'],
        },
      ],
      tasks: [],
      decisions: [
        {
          id: 'dec-1',
          missionId: 'mission-1',
          taskId: 'task-1',
          sessionKey: 'default:butler-worker-task-1',
          kind: 'permission' as const,
          title: 'Write file',
          summary: 'Write weekly.md',
          options: [{ id: 'allow', label: 'Allow', style: 'primary' as const }],
          status: 'pending' as const,
          createdAt: 2,
        },
      ],
      feed: [],
      concurrency: { running: 1, maxConcurrent: 3, queued: 0 },
    }
    const delegate = vi.fn().mockResolvedValue({ ok: true, missionId: 'mission-2' })
    const resolveDecision = vi.fn().mockResolvedValue({ ok: true })
    const cancelMission = vi.fn().mockResolvedValue({ ok: true })
    const cancelTask = vi.fn().mockResolvedValue({ ok: true })
    const steerTask = vi.fn().mockResolvedValue({ ok: true })
    const openDesk = vi.fn()

    registerButlerIpc({
      settingsPath: () => settingsPath,
      service: {
        submit: vi.fn(),
        hudState: () => ({
          prefs: { ...DEFAULT_BUTLER_PREFS, enabled: true },
          hotkey: 'Alt+Space',
          briefing: null,
          tasks: [],
        }),
      },
      missionEngine: {
        getSnapshot: () => fakeSnapshot,
        delegate,
        resolveDecision,
        cancelMission,
        cancelTask,
        steerTask,
      } as never,
      openDesk,
      isHudSender: (wc) => wc === (hudSender as unknown),
      isShellSender: (wc) => wc === (shellSender as unknown),
      openTarget: vi.fn(),
      hideHud: vi.fn(),
      resizeHud: vi.fn(),
    })

    const invoke = (channel: string, sender: unknown, ...args: unknown[]) =>
      ipcMock.handles.get(channel)!({ sender }, ...args)

    const hudState = await invoke(HOME_CHANNELS.butlerHudState, hudSender)
    expect(hudState).toMatchObject({
      activeMissionCount: 1,
      pendingDecisions: [expect.objectContaining({ id: 'dec-1' })],
    })

    const hudSub = await invoke(HOME_CHANNELS.butlerSubmit, hudSender, 'Organize release notes')
    expect(hudSub).toEqual({ ok: true, sessionKey: 'default:butler-main' })
    expect(delegate).toHaveBeenCalledWith('Organize release notes')

    await expect(invoke(HOME_CHANNELS.butlerDeskState, strangerSender)).rejects.toThrow(
      /Unauthorized/,
    )
    expect(await invoke(HOME_CHANNELS.butlerDeskState, shellSender)).toEqual(fakeSnapshot)

    await invoke(HOME_CHANNELS.butlerResolveDecision, hudSender, {
      decisionId: 'dec-1',
      optionId: 'allow',
    })
    expect(resolveDecision).toHaveBeenCalledWith({ decisionId: 'dec-1', optionId: 'allow' })

    await invoke(HOME_CHANNELS.butlerSteerTask, shellSender, {
      taskId: 'task-1',
      instruction: 'Focus on risk items',
    })
    expect(steerTask).toHaveBeenCalledWith({
      taskId: 'task-1',
      instruction: 'Focus on risk items',
    })

    await invoke(HOME_CHANNELS.butlerCancelTask, shellSender, 'task-1')
    expect(cancelTask).toHaveBeenCalledWith('task-1')

    await invoke(HOME_CHANNELS.butlerCancelMission, shellSender, 'mission-1')
    expect(cancelMission).toHaveBeenCalledWith('mission-1')

    await invoke(HOME_CHANNELS.butlerOpenDesk, hudSender, {
      missionId: 'mission-1',
      decisionId: 'dec-1',
    })
    expect(openDesk).toHaveBeenCalledWith({ missionId: 'mission-1', decisionId: 'dec-1' })
  })
})
