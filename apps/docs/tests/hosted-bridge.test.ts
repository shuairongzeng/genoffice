import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The hosted-shell bridge contract on the preload side (src/preload/index.ts):
 * `isHostedInShell` reads the shell's answer and reads false standalone (the
 * channel has no handler there, so the invoke rejects), and `openGlobalAi`
 * summons the drawer — forwarding a prompt through the same handoff the
 * command palette uses when one rides the affordance. The preload is imported
 * with Electron mocked; the exposed `desktop` api is captured from the
 * contextBridge mock.
 */

const expose = vi.fn()

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (...args: unknown[]) => void expose(...args) },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(() => () => {}),
    removeListener: vi.fn(),
    send: vi.fn(),
  },
  webUtils: { getPathForFile: vi.fn() },
}))

import { ipcRenderer } from 'electron'

type DesktopApi = {
  isHostedInShell(): Promise<boolean>
  openGlobalAi(question?: string): Promise<boolean>
}

const invoke = ipcRenderer.invoke as ReturnType<typeof vi.fn>

beforeEach(() => {
  expose.mockClear()
  invoke.mockReset()
  vi.resetModules()
})

describe('the hosted-shell bridge', () => {
  it('isHostedInShell answers the shell (true) and degrades standalone (false)', async () => {
    invoke.mockResolvedValueOnce(true)
    const loaded = await loadApi()
    await expect(loaded.isHostedInShell()).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledWith('app:is-hosted-in-shell')
    // standalone dev: no handler on the channel, the invoke rejects
    invoke.mockReset()
    invoke.mockRejectedValueOnce(new Error('No handler registered'))
    await expect(loaded.isHostedInShell()).resolves.toBe(false)
  })

  it('openGlobalAi opens the drawer and forwards the prompt when one rides the affordance', async () => {
    invoke.mockResolvedValueOnce(true).mockResolvedValueOnce(undefined)
    const loaded = await loadApi()
    await expect(loaded.openGlobalAi('proofread this')).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledWith('docs:open-global-ai')
    // the prompt rides the handoff channel with the deep-link origin: the
    // text was INTERPOLATED by the app, so it parks in the composer draft
    // and only an explicit Enter submits it (MED-3)
    const forwarded = invoke.mock.calls.find((c) => c[0] === 'home:ask-forward')
    expect(forwarded).toBeTruthy()
    expect(forwarded![1]).toMatchObject({ text: 'proofread this', origin: 'deep-link' })
    expect(typeof (forwarded![1] as { seq: number }).seq).toBe('number')
  })

  it('a bare toggle summons the drawer with no prompt, and a failed open forwards nothing', async () => {
    invoke.mockResolvedValueOnce(true)
    const loaded = await loadApi()
    await expect(loaded.openGlobalAi()).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledTimes(1)
    // the drawer did not open (standalone): nothing is forwarded
    invoke.mockReset()
    invoke.mockResolvedValueOnce(false)
    await expect(loaded.openGlobalAi('proofread this')).resolves.toBe(false)
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})

/** import the preload fresh and capture the desktop api the contextBridge received */
async function loadApi(): Promise<DesktopApi> {
  await import('../src/preload/index')
  const call = expose.mock.calls.find((c) => c[0] === 'desktop')
  expect(call).toBeTruthy()
  return call![1] as DesktopApi
}
