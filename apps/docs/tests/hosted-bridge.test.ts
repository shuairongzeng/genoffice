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
    on: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(),
  },
  webUtils: { getPathForFile: vi.fn() },
}))

import { ipcRenderer } from 'electron'

type DesktopApi = {
  isHostedInShell(): Promise<boolean>
  openGlobalAi(question?: string): Promise<boolean>
  onAutosaveRecoveryAsk(handler: (ask: unknown) => void): () => void
  answerAutosaveRecovery(requestId: string, restore: boolean): void
  getAiDockState(): Promise<{ width: number; collapsed: boolean } | null>
  onAiDockChanged(handler: (state: { width: number; collapsed: boolean }) => void): () => void
  reportAiSlotRect(rect: { x: number; y: number; width: number; height: number }): void
  onAiSlotRectRequest(handler: () => void): () => void
}

const invoke = ipcRenderer.invoke as ReturnType<typeof vi.fn>
const on = ipcRenderer.on as ReturnType<typeof vi.fn>
const send = ipcRenderer.send as ReturnType<typeof vi.fn>

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

describe('the autosave-recovery bridge (hosted open flow)', () => {
  it('subscribes the ask channel and answers over the answer channel', async () => {
    on.mockClear()
    send.mockClear()
    const loaded = await loadApi()
    const asked: unknown[] = []
    const off = loaded.onAutosaveRecoveryAsk((ask) => asked.push(ask))
    expect(on).toHaveBeenCalledWith('docs:autosave-recovery-ask', expect.any(Function))
    // main pushes the ask (with its localized strings): the handler sees it whole
    const push = on.mock.calls[0]![1] as (event: unknown, ask: unknown) => void
    push(undefined, { requestId: 'recovery-3', title: '发现自动恢复版本' })
    expect(asked).toEqual([{ requestId: 'recovery-3', title: '发现自动恢复版本' }])
    // the card's answer rides the answer channel verbatim
    loaded.answerAutosaveRecovery('recovery-3', true)
    expect(send).toHaveBeenCalledWith('docs:autosave-recovery-answer', {
      requestId: 'recovery-3',
      restore: true,
    })
    // and the unsubscribe detaches the listener
    off()
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      'docs:autosave-recovery-ask',
      expect.any(Function),
    )
  })
})

describe('the hosted AI-slot bridge', () => {
  it("pulls the drawer state over the shell's aiDock get and follows its broadcast", async () => {
    invoke.mockReset()
    invoke.mockResolvedValueOnce({ width: 420, collapsed: false })
    on.mockClear()
    const loaded = await loadApi()
    await expect(loaded.getAiDockState()).resolves.toEqual({ width: 420, collapsed: false })
    expect(invoke).toHaveBeenCalledWith('home:ai-dock-get')
    // the broadcast (the shell's watchAiDock sends it to the docs tabs)
    const states: Array<{ width: number; collapsed: boolean }> = []
    const off = loaded.onAiDockChanged((state) => states.push(state))
    expect(on).toHaveBeenCalledWith('home:ai-dock-changed', expect.any(Function))
    const push = on.mock.calls.find((c) => c[0] === 'home:ai-dock-changed')![1] as (
      event: unknown,
      prefs: unknown,
    ) => void
    push(undefined, { width: 420, collapsed: true })
    expect(states).toEqual([{ width: 420, collapsed: true }])
    // a malformed broadcast is dropped whole, never half-kept
    push(undefined, { width: 'wide' })
    push(undefined, null)
    expect(states).toHaveLength(1)
    off()
    // standalone dev: no handler on the get, the invoke rejects → null
    invoke.mockReset()
    invoke.mockRejectedValueOnce(new Error('No handler registered'))
    await expect(loaded.getAiDockState()).resolves.toBeNull()
  })

  it("reports the slot rect and answers main's re-measure request", async () => {
    on.mockClear()
    send.mockClear()
    const loaded = await loadApi()
    loaded.reportAiSlotRect({ x: 500, y: 0, width: 320, height: 600 })
    expect(send).toHaveBeenCalledWith('docs:ai-slot-rect', {
      x: 500,
      y: 0,
      width: 320,
      height: 600,
    })
    // main asks for a fresh measurement (activation, scale change)
    const requests: number[] = []
    const off = loaded.onAiSlotRectRequest(() => requests.push(1))
    expect(on).toHaveBeenCalledWith('docs:ai-slot-rect-request', expect.any(Function))
    const request = on.mock.calls.find(
      (c) => c[0] === 'docs:ai-slot-rect-request',
    )![1] as () => void
    request()
    expect(requests).toHaveLength(1)
    off()
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      'docs:ai-slot-rect-request',
      expect.any(Function),
    )
  })
})

/** import the preload fresh and capture the desktop api the contextBridge received */
async function loadApi(): Promise<DesktopApi> {
  await import('../src/preload/index')
  const call = expose.mock.calls.find((c) => c[0] === 'desktop')
  expect(call).toBeTruthy()
  return call![1] as DesktopApi
}
