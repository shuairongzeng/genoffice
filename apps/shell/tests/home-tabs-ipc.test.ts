import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WebContents } from 'electron'
import type { HomeTabsState } from '../src/shared/home-api'
import type { OpenDocumentTab, TabSummary } from '../src/shared/tabs-api'
import type { HomeWorkbenchIpcDeps } from '../src/main/home-tabs-ipc'
import type { TabManager } from '../src/main/tab-manager'

/**
 * The desktop tab strip's main-process side (src/main/home-tabs-ipc.ts): the
 * `home:tabs-changed` push (latest-wins + dedup) and the activate/close IPC
 * routing between the shell's tabs and detached editor windows. Electron is
 * faked down to ipcMain.handle capture.
 */

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown

const ipcMainMock = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>()
  const onHandlers = new Map<string, IpcHandler>()
  return {
    handlers,
    onHandlers,
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler)
    }),
    on: vi.fn((channel: string, handler: IpcHandler) => {
      onHandlers.set(channel, handler)
    }),
  }
})

vi.mock('electron', () => ({ ipcMain: { handle: ipcMainMock.handle, on: ipcMainMock.on } }))

/** the injected forward routing spies both registerHomeWorkbenchIpc describes share */
const forwardAskQuery = vi.fn()
const forwardBrowserAskAbout = vi.fn()
const markDrawerOverlayReadyFor = vi.fn()
const applyDrawerOverlayPetDrag = vi.fn()
const reportDockHotEdge = vi.fn()
const dockNavAction = vi.fn()
const takeDockNavPending = vi.fn()

import {
  collectHomeTabsState,
  createHomeTabsBroadcaster,
  installHomeTabsPush,
  notifyHomeTabsChanged,
  registerHomeTabsIpc,
  registerHomeWorkbenchIpc,
} from '../src/main/home-tabs-ipc'
import { readAiDock } from '../src/main/ai-dock'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function stateOf(tabs: Array<Partial<HomeTabsState['tabs'][number]>>): HomeTabsState {
  return {
    tabs: tabs.map((t) => ({
      id: 'x',
      kind: 'docs',
      title: 'x',
      active: false,
      dirty: false,
      detached: false,
      ...t,
    })),
    activeId: 'home',
  }
}

describe('createHomeTabsBroadcaster', () => {
  it('collects and sends the state', async () => {
    const state = stateOf([{ id: 'home' }])
    const send = vi.fn()
    const push = createHomeTabsBroadcaster({ collect: () => Promise.resolve(state), send })
    push.push()
    await Promise.resolve()
    expect(send).toHaveBeenCalledWith(state)
  })

  it('skips a snapshot identical to the last one sent', async () => {
    const states = [stateOf([{ id: 'home' }]), stateOf([{ id: 'home' }])]
    const send = vi.fn()
    const push = createHomeTabsBroadcaster({
      collect: () => Promise.resolve(states.shift()!),
      send,
    })
    push.push()
    push.push()
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('sends again once the state actually differs', async () => {
    const first = stateOf([{ id: 'home', title: 'GenOffice' }])
    const second = stateOf([
      { id: 'home', title: 'GenOffice' },
      { id: 't1', kind: 'sheets' },
    ])
    const send = vi.fn()
    let current = first
    const push = createHomeTabsBroadcaster({ collect: () => Promise.resolve(current), send })
    push.push()
    await Promise.resolve()
    current = second
    push.push()
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith(second)
  })

  it('lets only the newest push land (a slow dirty round-trip cannot resurrect stale state)', async () => {
    const slow = deferred<HomeTabsState>()
    const fast = deferred<HomeTabsState>()
    const sends: HomeTabsState[] = []
    const collect = vi.fn(() => (collect.mock.calls.length === 1 ? slow.promise : fast.promise))
    const push = createHomeTabsBroadcaster({
      collect,
      send: (state) => sends.push(state),
    })
    push.push()
    push.push()
    fast.resolve(stateOf([{ id: 'home', title: 'fresh' }]))
    await Promise.resolve()
    expect(sends).toHaveLength(1)
    // the stale snapshot arrives late and must be dropped, not overwrite
    slow.resolve(stateOf([{ id: 'home', title: 'stale' }]))
    await Promise.resolve()
    await Promise.resolve()
    expect(sends).toHaveLength(1)
    expect(sends[0]!.tabs[0]!.title).toBe('fresh')
  })

  it('force resets the dedup baseline, so a load that changed nothing still sends', async () => {
    const state = stateOf([{ id: 'home' }])
    const send = vi.fn()
    const push = createHomeTabsBroadcaster({ collect: () => Promise.resolve(state), send })
    push.push()
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(1)
    push.push(true)
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('force also lets a concurrent newer push land after it', async () => {
    // a load finishes (force) while a tab opens in the same tick: whichever
    // snapshot lands, the freshly loaded renderer must receive it
    const state = stateOf([{ id: 'home' }])
    const force = deferred<HomeTabsState>()
    const fresh = deferred<HomeTabsState>()
    const sends: HomeTabsState[] = []
    let call = 0
    const push = createHomeTabsBroadcaster({
      collect: () => (call++ === 0 ? force.promise : fresh.promise),
      send: (s) => sends.push(s),
    })
    push.push(true)
    push.push()
    fresh.resolve(state)
    await Promise.resolve()
    expect(sends).toEqual([state])
    force.resolve(state)
    await Promise.resolve()
    await Promise.resolve()
    expect(sends).toEqual([state])
  })

  it('swallows a failed collect and keeps pushing', async () => {
    const state = stateOf([{ id: 'home' }])
    const send = vi.fn()
    let fail = true
    const push = createHomeTabsBroadcaster({
      collect: () => (fail ? Promise.reject(new Error('window gone')) : Promise.resolve(state)),
      send,
    })
    push.push()
    await Promise.resolve()
    expect(send).not.toHaveBeenCalled()
    fail = false
    push.push()
    await Promise.resolve()
    expect(send).toHaveBeenCalledWith(state)
  })
})

describe('collectHomeTabsState', () => {
  it('merges the shell tabs (dirtiness resolved) with the detached editors and the active id', async () => {
    const summary = (over: Partial<TabSummary>): TabSummary => ({
      id: 'x',
      kind: 'docs',
      title: 'x',
      closable: true,
      active: false,
      ...over,
    })
    const manager = {
      listWithDirty: async () => [
        summary({ id: 'home', kind: 'home', title: 'GenOffice', closable: false, active: false }),
        summary({ id: 't1', kind: 'docs', title: 'a.docx', active: true, dirty: true }),
        summary({ id: 't2', kind: 'sheets', title: 'b.xlsx', dormant: true }),
      ],
      activeTabId: () => 't1',
    } as unknown as TabManager
    const detached: OpenDocumentTab[] = [
      {
        id: 'detached:7',
        kind: 'pdf',
        title: 'scan.pdf',
        filePath: '/tmp/scan.pdf',
        active: false,
        dirty: false,
      },
    ]
    const state = await collectHomeTabsState(manager, () => Promise.resolve(detached))
    expect(state).toEqual({
      activeId: 't1',
      tabs: [
        {
          id: 'home',
          kind: 'home',
          title: 'GenOffice',
          active: false,
          dirty: false,
          detached: false,
        },
        { id: 't1', kind: 'docs', title: 'a.docx', active: true, dirty: true, detached: false },
        { id: 't2', kind: 'sheets', title: 'b.xlsx', active: false, dirty: false, detached: false },
        {
          id: 'detached:7',
          kind: 'pdf',
          title: 'scan.pdf',
          active: false,
          dirty: false,
          detached: true,
        },
      ],
    })
  })
})

describe('registerHomeTabsIpc', () => {
  function register(over: Partial<Parameters<typeof registerHomeTabsIpc>[0]> = {}) {
    const activateTab = vi.fn()
    const closeTab = vi.fn(() => Promise.resolve())
    const manager = { activateTab, closeTab } as unknown as TabManager
    const deps = {
      getTabManager: () => manager as TabManager | null,
      listDetached: vi.fn(() => Promise.resolve([])),
      isDetachedTab: (id: string) => id.startsWith('detached:'),
      activateDetachedTab: vi.fn(() => true),
      closeDetachedTab: vi.fn(() => true),
      ...over,
    }
    registerHomeTabsIpc(deps)
    return { activateTab, closeTab, deps }
  }

  const call = (channel: string, ...args: unknown[]): unknown =>
    ipcMainMock.handlers.get(channel)!(undefined, ...args)

  it('activates a shell tab through the tab manager', () => {
    const { activateTab } = register()
    call('home:tabs-activate', 't1')
    expect(activateTab).toHaveBeenCalledWith('t1')
  })

  it('routes a detached id to its window instead of the strip', () => {
    const { activateTab, deps } = register()
    call('home:tabs-activate', 'detached:7')
    expect(deps.activateDetachedTab).toHaveBeenCalledWith('detached:7')
    expect(activateTab).not.toHaveBeenCalled()
  })

  it('closes a shell tab through the same close path as the strip channel', async () => {
    const { closeTab } = register()
    const result = call('home:tabs-close', 't1')
    expect(closeTab).toHaveBeenCalledWith('t1')
    await expect(result).resolves.toBeUndefined()
  })

  it('closes a detached window through its own close guard', async () => {
    const { deps } = register()
    await call('home:tabs-close', 'detached:7')
    expect(deps.closeDetachedTab).toHaveBeenCalledWith('detached:7')
  })

  it('ignores non-string and empty ids', () => {
    const { activateTab, closeTab, deps } = register()
    for (const bad of [123, null, undefined, {}, '', []]) {
      call('home:tabs-activate', bad)
      call('home:tabs-close', bad)
    }
    expect(activateTab).not.toHaveBeenCalled()
    expect(closeTab).not.toHaveBeenCalled()
    expect(deps.activateDetachedTab).not.toHaveBeenCalled()
    expect(deps.closeDetachedTab).not.toHaveBeenCalled()
  })

  it('survives a missing tab manager', () => {
    const deps = {
      getTabManager: () => null,
      listDetached: vi.fn(() => Promise.resolve([])),
      isDetachedTab: () => false,
      activateDetachedTab: vi.fn(),
      closeDetachedTab: vi.fn(),
    }
    registerHomeTabsIpc(deps)
    expect(() => call('home:tabs-activate', 't1')).not.toThrow()
    expect(call('home:tabs-close', 't1')).toBeUndefined()
  })
})

describe('the installed push indirection', () => {
  it('notifyHomeTabsChanged triggers the installed push, and nothing once uninstalled', () => {
    const push = vi.fn()
    installHomeTabsPush({ push })
    notifyHomeTabsChanged()
    expect(push).toHaveBeenCalledTimes(1)
    installHomeTabsPush(null)
    notifyHomeTabsChanged()
    expect(push).toHaveBeenCalledTimes(1)
    // restored for the next test / torn down by the window's close handler
    installHomeTabsPush(null)
  })
})

describe('registerHomeWorkbenchIpc', () => {
  let dir: string

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      dir = undefined as unknown as string
    }
  })

  function registerWorkbench(
    getTabManager: () => unknown = () => ({ setStageRect }),
    contentBounds: () => { width: number; height: number } = () => ({ width: 800, height: 600 }),
  ) {
    dir ??= mkdtempSync(join(tmpdir(), 'genoffice-workbench-'))
    registerHomeWorkbenchIpc({
      appSettingsPath: () => join(dir, 'app-settings.json'),
      getTabManager: getTabManager as HomeWorkbenchIpcDeps['getTabManager'],
      contentBounds,
      forwardAskQuery,
      forwardBrowserAskAbout,
      markDrawerOverlayReadyFor,
      applyDrawerOverlayPetDrag,
      reportDockHotEdge,
      dockNavAction,
      takeDockNavPending,
    })
  }

  const setStageRect = vi.fn()
  const invoke = (channel: string, ...args: unknown[]): unknown =>
    ipcMainMock.handlers.get(channel)!(undefined, ...args)
  const send = (channel: string, ...args: unknown[]): void => {
    ipcMainMock.onHandlers.get(channel)!(undefined, ...args)
  }

  it('answers the stored drawer prefs, defaults on absence', async () => {
    registerWorkbench()
    expect(await invoke('home:ai-dock-get')).toEqual({
      width: 400,
      collapsed: false,
      petPos: null,
    })
  })

  it('merges, clamps and persists a drawer patch, answering the effective prefs', async () => {
    registerWorkbench()
    const effective = await invoke('home:ai-dock-set', { width: 9999, collapsed: true })
    expect(effective).toEqual({ width: 560, collapsed: true, petPos: null })
    expect(readAiDock(join(dir, 'app-settings.json'))).toEqual({
      width: 560,
      collapsed: true,
      petPos: null,
    })
  })

  it('adopts a pet-position patch — null included — and keeps it through other patches', async () => {
    registerWorkbench()
    const moved = await invoke('home:ai-dock-set', { petPos: { x: 120, y: 80 } })
    expect(moved).toEqual({ width: 400, collapsed: false, petPos: { x: 120, y: 80 } })
    // a later patch without petPos keeps the parked pet
    const untouched = await invoke('home:ai-dock-set', { collapsed: true })
    expect(untouched).toEqual({ width: 400, collapsed: true, petPos: { x: 120, y: 80 } })
    // an explicit null returns it to the default corner
    const home = await invoke('home:ai-dock-set', { petPos: null })
    expect(home).toEqual({ width: 400, collapsed: true, petPos: null })
    // a malformed pet position falls back to the corner, keeping the rest
    const bad = await invoke('home:ai-dock-set', { petPos: { x: 'left', y: 2 } })
    expect(bad).toEqual({ width: 400, collapsed: true, petPos: null })
  })

  it('ignores malformed patch fields, keeping the current values', async () => {
    registerWorkbench()
    await invoke('home:ai-dock-set', { width: 'wide', collapsed: 'yes' })
    expect(readAiDock(join(dir, 'app-settings.json'))).toEqual({
      width: 400,
      collapsed: false,
      petPos: null,
    })
  })

  it('bounds the active view to a reported stage rect, rounded to whole pixels', () => {
    registerWorkbench()
    setStageRect.mockClear()
    send('home:content-rect', { x: 208.4, y: 44.2, width: 551.6, height: 555.8 })
    expect(setStageRect).toHaveBeenCalledWith({ x: 208, y: 44, width: 552, height: 556 })
  })

  it('clamps a stage rect that overruns the window into its content area', () => {
    // a report that lands mid-resize can still describe the pre-shrink
    // layout: without the clamp the tab manager would bound the document
    // view partly past the window's right edge
    registerWorkbench(
      () => ({ setStageRect }),
      () => ({ width: 800, height: 600 }),
    )
    setStageRect.mockClear()
    send('home:content-rect', { x: 700, y: 44, width: 552, height: 556 })
    expect(setStageRect).toHaveBeenCalledWith({ x: 248, y: 44, width: 552, height: 556 })
  })

  it('shrinks an over-tall rect to the window height and hugs the edge it overshot', () => {
    registerWorkbench(
      () => ({ setStageRect }),
      () => ({ width: 800, height: 600 }),
    )
    setStageRect.mockClear()
    send('home:content-rect', { x: 0, y: 44, width: 500, height: 700 })
    expect(setStageRect).toHaveBeenCalledWith({ x: 0, y: 0, width: 500, height: 600 })
  })

  it('keeps a rect that already fits the window untouched', () => {
    registerWorkbench(
      () => ({ setStageRect }),
      () => ({ width: 800, height: 600 }),
    )
    setStageRect.mockClear()
    send('home:content-rect', { x: 0, y: 44, width: 380, height: 540 })
    expect(setStageRect).toHaveBeenCalledWith({ x: 0, y: 44, width: 380, height: 540 })
  })

  it('skips the clamp while the window reports a degenerate size', () => {
    // minimized / mid-restore: the tab manager's own settled-rect guard is
    // the protection there, and a 0x0 clamp would mangle the report
    registerWorkbench(
      () => ({ setStageRect }),
      () => ({ width: 0, height: 0 }),
    )
    setStageRect.mockClear()
    send('home:content-rect', { x: 208, y: 44, width: 552, height: 556 })
    expect(setStageRect).toHaveBeenCalledWith({ x: 208, y: 44, width: 552, height: 556 })
  })

  it('drops malformed and degenerate stage reports whole', () => {
    registerWorkbench()
    setStageRect.mockClear()
    for (const bad of [
      null,
      'rect',
      {},
      { x: 'a', y: 44, width: 552, height: 556 },
      { x: -10, y: 44, width: 552, height: 556 },
      { x: 0, y: 44, width: 0, height: 556 },
      { x: 0, y: 44, width: 552, height: Number.NaN },
    ]) {
      send('home:content-rect', bad)
    }
    expect(setStageRect).not.toHaveBeenCalled()
  })

  it('survives a missing tab manager', () => {
    registerWorkbench(() => null)
    expect(() => send('home:content-rect', { x: 0, y: 44, width: 552, height: 556 })).not.toThrow()
  })
})

describe('registerHomeWorkbenchIpc — the ask forward and the ready handshake (P0-2)', () => {
  beforeEach(() => {
    forwardAskQuery.mockClear()
    forwardBrowserAskAbout.mockClear()
    markDrawerOverlayReadyFor.mockClear()
    applyDrawerOverlayPetDrag.mockClear()
    reportDockHotEdge.mockClear()
    dockNavAction.mockClear()
    takeDockNavPending.mockClear()
    registerHomeWorkbenchIpc({
      appSettingsPath: () => '/unused/app-settings.json',
      getTabManager: () => null,
      contentBounds: () => ({ width: 800, height: 600 }),
      forwardAskQuery,
      forwardBrowserAskAbout,
      markDrawerOverlayReadyFor,
      applyDrawerOverlayPetDrag,
      reportDockHotEdge,
      dockNavAction,
      takeDockNavPending,
    })
  })

  const invoke = (channel: string, ...args: unknown[]): unknown =>
    ipcMainMock.handlers.get(channel)!(undefined, ...args)

  it('validates a handoff and hands the routing to the injected dep', () => {
    invoke('home:ask-forward', { text: 'ask over the document', seq: 4, origin: 'palette' })
    expect(forwardAskQuery).toHaveBeenCalledWith({
      text: 'ask over the document',
      seq: 4,
      origin: 'palette',
    })
  })

  it('normalizes the scope paths of a forwarded handoff', () => {
    invoke('home:ask-forward', {
      text: 'about these',
      seq: 5,
      origin: 'palette',
      scopePaths: ['a', 'a', '', 7, 'b'],
    })
    expect(forwardAskQuery).toHaveBeenCalledWith({
      text: 'about these',
      seq: 5,
      origin: 'palette',
      scopePaths: ['a', 'b'],
    })
  })

  it('drops malformed handoffs whole rather than half-keeping them', () => {
    for (const bad of [
      null,
      'ask',
      {},
      { text: 1, seq: 1, origin: 'palette' },
      { text: 'q', seq: 'one', origin: 'palette' },
      { text: 'q', seq: Number.NaN, origin: 'palette' },
      { text: 'q', seq: 1, origin: 'web' },
    ]) {
      invoke('home:ask-forward', bad)
    }
    expect(forwardAskQuery).not.toHaveBeenCalled()
  })

  it('routes a browser note only when the payload is an object', () => {
    invoke('home:browser-ask-about-forward', { id: 'n1', note: 'what is this' })
    expect(forwardBrowserAskAbout).toHaveBeenCalledWith({ id: 'n1', note: 'what is this' })
    invoke('home:browser-ask-about-forward', 'note')
    invoke('home:browser-ask-about-forward', null)
    invoke('home:browser-ask-about-forward', 42)
    expect(forwardBrowserAskAbout).toHaveBeenCalledTimes(1)
  })

  it('routes the panel ready ping to the dep with the event sender', () => {
    // the channel carries no payload: the sender's identity is the whole
    // message, and the overlay (through the dep) checks it against its own
    // view before flushing anything it buffered
    const sender = { id: 202 } as WebContents
    ipcMainMock.onHandlers.get('home:ask-panel-ready')!({ sender })
    expect(markDrawerOverlayReadyFor).toHaveBeenCalledTimes(1)
    expect(markDrawerOverlayReadyFor).toHaveBeenCalledWith(sender)
  })

  it('routes a validated pet-drag surface report to the dep with the event sender', () => {
    // the overlay (through the dep) owns the sender identity check and the
    // pet-only mode gate, so the report passes through whole
    const sender = { id: 202 } as WebContents
    ipcMainMock.onHandlers.get('home:ai-pet-drag')!({ sender }, { start: true })
    expect(applyDrawerOverlayPetDrag).toHaveBeenCalledTimes(1)
    expect(applyDrawerOverlayPetDrag).toHaveBeenCalledWith(sender, { start: true })
    ipcMainMock.onHandlers.get('home:ai-pet-drag')!({ sender }, { end: true })
    expect(applyDrawerOverlayPetDrag).toHaveBeenLastCalledWith(sender, { end: true })
  })

  it('routes a validated hot-edge report to the dep with the event sender', () => {
    // the overlay (through the dep) owns the identity check and the
    // strip/dock state machine; only its own renderer's report moves it
    const sender = { id: 210 } as WebContents
    ipcMainMock.onHandlers.get('home:dock-hot-edge')!({ sender }, { enter: true })
    expect(reportDockHotEdge).toHaveBeenCalledTimes(1)
    expect(reportDockHotEdge).toHaveBeenCalledWith(sender, { enter: true })
    ipcMainMock.onHandlers.get('home:dock-hot-edge')!({ sender }, { leave: true })
    expect(reportDockHotEdge).toHaveBeenLastCalledWith(sender, { leave: true })
  })

  it('drops malformed hot-edge reports whole', () => {
    const sender = { id: 210 } as WebContents
    for (const bad of [null, 'edge', {}, { enter: 'in' }, { leave: 1 }]) {
      ipcMainMock.onHandlers.get('home:dock-hot-edge')!({ sender }, bad)
    }
    expect(reportDockHotEdge).not.toHaveBeenCalled()
  })

  it('routes a validated dock action to the nav-routing dep', () => {
    const invoke = (channel: string, ...args: unknown[]): unknown =>
      ipcMainMock.handlers.get(channel)!(undefined, ...args)
    invoke('home:dock-action', { kind: 'nav', view: 'recent' })
    expect(dockNavAction).toHaveBeenCalledWith({ kind: 'nav', view: 'recent' })
    invoke('home:dock-action', { kind: 'settings', section: 'plugins' })
    expect(dockNavAction).toHaveBeenLastCalledWith({ kind: 'settings', section: 'plugins' })
    invoke('home:dock-action', { kind: 'templates' })
    expect(dockNavAction).toHaveBeenLastCalledWith({ kind: 'templates' })
  })

  it('answers the mount-time dock-nav pull from the injected buffer dep', () => {
    // the cold-boot race: Home pulls the intent that beat its subscription,
    // and the dep (index.ts's buffer) answers and clears in one move
    takeDockNavPending
      .mockReturnValueOnce({ kind: 'nav', view: 'recent' })
      .mockReturnValueOnce(null)
    expect(invoke('home:dock-nav-pending')).toEqual({ kind: 'nav', view: 'recent' })
    expect(invoke('home:dock-nav-pending')).toBeNull()
    expect(takeDockNavPending).toHaveBeenCalledTimes(2)
  })

  it('drops malformed dock actions whole rather than guessing a kind', () => {
    const invoke = (channel: string, ...args: unknown[]): unknown =>
      ipcMainMock.handlers.get(channel)!(undefined, ...args)
    // (extra keys are tolerated like every validator here — only the
    // fields the routing reads are judged)
    for (const bad of [
      null,
      'nav',
      {},
      { kind: 'ask' },
      { kind: 'nav' },
      { kind: 'nav', view: 'cloud' },
      { kind: 'settings' },
      { kind: 'settings', section: 'account' },
    ]) {
      invoke('home:dock-action', bad)
    }
    expect(dockNavAction).not.toHaveBeenCalled()
  })

  it('drops malformed pet-drag reports whole rather than half-keeping them', () => {
    // the report carries no coordinates: the drag's math is renderer-side —
    // only the surface flags ride the channel, and a malformed one must cost
    // the gesture nothing
    const sender = { id: 202 } as WebContents
    for (const bad of [
      null,
      'drag',
      {},
      { x: 60 },
      { start: 'begin' },
      { end: 1 },
      { start: true, end: 'done' },
    ]) {
      ipcMainMock.onHandlers.get('home:ai-pet-drag')!({ sender }, bad)
    }
    expect(applyDrawerOverlayPetDrag).not.toHaveBeenCalled()
  })
})
