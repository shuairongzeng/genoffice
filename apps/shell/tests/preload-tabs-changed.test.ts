import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { HomeApi, HomeTabsState } from '../src/shared/home-api'
import { HOME_CHANNELS } from '../src/shared/home-api'

/**
 * The preload's face of the desktop tab strip (src/preload/index.ts):
 * `onTabsChanged` buffers the latest pre-attach snapshot for replay and
 * validates every entry of every payload; `tabsActivate`/`tabsClose` guard
 * their id the way the rest of the home API does. Electron is faked to a
 * listener registry the tests can emit into.
 */

type RendererListener = (event: unknown, ...args: unknown[]) => void

const electronMocks = vi.hoisted(() => {
  const listeners = new Map<string, Set<RendererListener>>()
  return {
    exposed: new Map<string, unknown>(),
    invoke: vi.fn(),
    send: vi.fn(),
    on: vi.fn((channel: string, listener: RendererListener) => {
      const set = listeners.get(channel) ?? new Set()
      set.add(listener)
      listeners.set(channel, set)
    }),
    removeListener: vi.fn((channel: string, listener: RendererListener) => {
      listeners.get(channel)?.delete(listener)
    }),
    listenerCount: vi.fn((channel: string) => listeners.get(channel)?.size ?? 0),
    /** deliver a main-process send on a channel to every current listener */
    emit: (channel: string, ...args: unknown[]) => {
      for (const listener of [...(listeners.get(channel) ?? [])]) listener({}, ...args)
    },
  }
})

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: unknown) => electronMocks.exposed.set(name, api),
  },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    send: electronMocks.send,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
    listenerCount: electronMocks.listenerCount,
  },
  // the preload imports @genoffice/electron-utils (drop-open bridge), which
  // binds webUtils at module scope even though node env never installs it
  webUtils: { getPathForFile: () => '' },
}))

import '../src/preload/index'

const homeApi = electronMocks.exposed.get('aiOffice') as HomeApi

beforeEach(() => {
  electronMocks.invoke.mockClear()
})

/** run the currently queued microtasks (the replay is queueMicrotask'd) */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 't1',
  kind: 'docs',
  title: 'a.docx',
  active: false,
  dirty: false,
  detached: false,
  ...over,
})

const state = (tabs: Record<string, unknown>[], activeId = 'home'): Record<string, unknown> => ({
  tabs,
  activeId,
})

describe('onTabsChanged buffering', () => {
  it('replays the latest pre-attach snapshot, once, however many arrived', async () => {
    electronMocks.emit(
      HOME_CHANNELS.tabsChanged,
      state([entry({ id: 'home', kind: 'home', title: 'GenOffice', active: true })]),
    )
    electronMocks.emit(
      HOME_CHANNELS.tabsChanged,
      state([entry({ id: 'home', kind: 'home', title: 'GenOffice', active: true })], 'home'),
    )
    const seen: HomeTabsState[] = []
    const off = homeApi.onTabsChanged((payload) => seen.push(payload))
    expect(seen).toEqual([]) // asynchronous, never inside the attach call stack
    await flushMicrotasks()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({
      activeId: 'home',
      tabs: [
        {
          id: 'home',
          kind: 'home',
          title: 'GenOffice',
          active: true,
          dirty: false,
          detached: false,
        },
      ],
    })
    off()
  })

  it('delivers directly while attached and buffers the newest again after detach', async () => {
    const seen: HomeTabsState[] = []
    const off = homeApi.onTabsChanged((payload) => seen.push(payload))
    await flushMicrotasks()
    electronMocks.emit(HOME_CHANNELS.tabsChanged, state([entry({ title: 'live' })]))
    expect(seen).toHaveLength(1)
    off()
    expect(electronMocks.listenerCount(HOME_CHANNELS.tabsChanged)).toBe(1)
    electronMocks.emit(HOME_CHANNELS.tabsChanged, state([entry({ title: 'buffered' })]))
    const seen2: HomeTabsState[] = []
    const off2 = homeApi.onTabsChanged((payload) => seen2.push(payload))
    await flushMicrotasks()
    expect(seen2).toHaveLength(1)
    expect(seen2[0]!.tabs[0]!.title).toBe('buffered')
    expect(seen).toHaveLength(1) // no double delivery
    off2()
  })
})

describe('onTabsChanged payload validation', () => {
  it('drops whole malformed payloads instead of delivering them', async () => {
    for (const bad of [
      null,
      'tabs',
      {},
      { tabs: [] }, // no activeId
      { tabs: [], activeId: '' },
      { tabs: 'home', activeId: 'home' },
    ]) {
      electronMocks.emit(HOME_CHANNELS.tabsChanged, bad)
    }
    const seen: HomeTabsState[] = []
    const off = homeApi.onTabsChanged((payload) => seen.push(payload))
    await flushMicrotasks()
    expect(seen).toEqual([])
    off()
  })

  it('drops malformed entries whole and keeps the well-formed ones', async () => {
    electronMocks.emit(
      HOME_CHANNELS.tabsChanged,
      state([
        entry({ id: 'home', kind: 'home', title: 'GenOffice', active: true }),
        { id: 't1', kind: 'docs', title: 42, active: false, dirty: false, detached: false },
        { id: '', kind: 'docs', title: 'no id', active: false, dirty: false, detached: false },
        {
          id: 't2',
          kind: 'terminal',
          title: 'unknown kind',
          active: false,
          dirty: false,
          detached: false,
        },
        { id: 't3', kind: 'sheets', title: 'b.xlsx', active: false, dirty: 'yes', detached: false },
        null,
      ]),
    )
    const seen: HomeTabsState[] = []
    const off = homeApi.onTabsChanged((payload) => seen.push(payload))
    await flushMicrotasks()
    expect(seen).toEqual([
      {
        activeId: 'home',
        tabs: [
          {
            id: 'home',
            kind: 'home',
            title: 'GenOffice',
            active: true,
            dirty: false,
            detached: false,
          },
        ],
      },
    ])
    off()
  })

  it('keeps detached entries with their flag', async () => {
    const detached = entry({ id: 'detached:7', kind: 'pdf', title: 'scan.pdf', detached: true })
    electronMocks.emit(HOME_CHANNELS.tabsChanged, state([detached]))
    const seen: HomeTabsState[] = []
    const off = homeApi.onTabsChanged((payload) => seen.push(payload))
    await flushMicrotasks()
    expect(seen[0]!.tabs[0]).toEqual({
      id: 'detached:7',
      kind: 'pdf',
      title: 'scan.pdf',
      active: false,
      dirty: false,
      detached: true,
    })
    off()
  })
})

describe('tabsActivate / tabsClose', () => {
  it('invoke their channel with the id', async () => {
    await homeApi.tabsActivate('t1')
    expect(electronMocks.invoke).toHaveBeenCalledWith(HOME_CHANNELS.tabsActivate, 't1')
    await homeApi.tabsClose('detached:7')
    expect(electronMocks.invoke).toHaveBeenCalledWith(HOME_CHANNELS.tabsClose, 'detached:7')
  })

  it('reject non-string and empty ids without invoking', async () => {
    for (const bad of [123, null, undefined, {}, '', []]) {
      await expect(homeApi.tabsActivate(bad as never)).rejects.toThrow('Invalid id.')
      await expect(homeApi.tabsClose(bad as never)).rejects.toThrow('Invalid id.')
    }
    expect(electronMocks.invoke).not.toHaveBeenCalled()
  })
})

describe('getAiDock / setAiDock / homeContentRect', () => {
  it('persist a dock patch and read the prefs back through their channels', async () => {
    await homeApi.setAiDock({ width: 480, collapsed: true })
    expect(electronMocks.invoke).toHaveBeenCalledWith(HOME_CHANNELS.aiDockSet, {
      width: 480,
      collapsed: true,
    })
    await homeApi.getAiDock()
    expect(electronMocks.invoke).toHaveBeenCalledWith(HOME_CHANNELS.aiDockGet)
  })

  it('normalizes whatever the main process answers, like the renderer does', async () => {
    electronMocks.invoke.mockResolvedValueOnce({ width: 9999, collapsed: 1 })
    expect(await homeApi.getAiDock()).toEqual({ width: 560, collapsed: false })
  })

  it('sends the measured stage rect fire-and-forget', () => {
    homeApi.homeContentRect({ x: 208, y: 44, width: 552, height: 556 })
    expect(electronMocks.send).toHaveBeenCalledWith(HOME_CHANNELS.contentRect, {
      x: 208,
      y: 44,
      width: 552,
      height: 556,
    })
  })
})
