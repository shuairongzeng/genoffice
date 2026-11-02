import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'

/**
 * The document-agent bridge (src/main/document-agent.ts): the dock panel's
 * document_agent tool lands over `document-agent:run` and routes to the
 * ACTIVE docs tab's renderer — one task per document, progress relayed to
 * the calling panel, a 3-minute cap, an abort channel, and honest failures
 * for a closed tab. The sender gate serves the same panel copies the browser
 * skill's channel does. Electron is faked; the tab list and webContents are
 * injected per test.
 *
 * The bridge installs once for the whole file (its own guard), so the deps
 * close over `let` bindings the beforeEach re-points, and every test reads
 * the task id the tab actually received instead of guessing the sequence.
 */

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
const onListeners = new Map<string, Array<(event: unknown, ...args: unknown[]) => void>>()
/** destroyed-listener captures, by webContents id */
const destroyedOnce = new Map<number, (event: unknown) => void>()

interface FakeWc {
  id: number
  send: ReturnType<typeof vi.fn>
  isDestroyed: () => boolean
}

const wcs = new Map<number, FakeWc>()

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    },
    on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
      const list = onListeners.get(channel) ?? []
      list.push(listener)
      onListeners.set(channel, list)
    },
  },
  webContents: {
    fromId: (id: number) => wcs.get(id),
  },
}))

import {
  DOCUMENT_AGENT_CHANNELS,
  installDocumentAgentBridge,
  isAgentTaskStatus,
  documentAgentTargetError,
  type DocumentAgentTab,
} from '../src/main/document-agent'

/** a fake webContents: the panel caller or the docs tab (the id is stable per role) */
function makeWc(id: number): FakeWc {
  const wc: FakeWc = { id, send: vi.fn(), isDestroyed: () => false }
  // the bridge's destroyed-watcher registers through once('destroyed')
  ;(wc as FakeWc & { once: unknown }).once = (
    channel: string,
    listener: (event: unknown) => void,
  ) => {
    if (channel === 'destroyed') destroyedOnce.set(wc.id, listener)
  }
  wcs.set(id, wc)
  return wc
}

/** the event shape ipcMain hands a handler: the sender IS the webContents (identity matters to the gate) */
const eventOf = (wc: FakeWc): { sender: FakeWc } => ({ sender: wc })

const TAB = (over: Partial<DocumentAgentTab> = {}): DocumentTab => ({
  id: 't1',
  kind: 'docs',
  title: 'Report.docx',
  active: true,
  ...over,
})

let panel: FakeWc
let docsTab: FakeWc
let tabs: DocumentTab[]

installDocumentAgentBridge({
  listDocumentTabs: () => tabs,
  webContentsFor: (tabId) => (tabId === 't1' ? (docsTab as unknown as WebContents) : undefined),
  panelWebContents: () => [panel as unknown as WebContents],
})

beforeEach(() => {
  destroyedOnce.clear()
  panel = makeWc(900)
  docsTab = makeWc(901)
  tabs = [TAB()]
  // the headless agent's readiness handshake (MED-6): a tab announces itself
  // once its renderer is live; tests announce up front so runs route
  announceReady(docsTab)
})

/** fire the renderer's readiness announce for one webContents */
const announceReady = (wc: FakeWc): void => {
  for (const listener of onListeners.get('docs:agent-ready') ?? []) listener(eventOf(wc))
}

const invokeRun = (task: string, sender = panel) =>
  handlers.get(DOCUMENT_AGENT_CHANNELS.run)!(eventOf(sender), { task })

/** a macrotask boundary: every microtask the async handler chains runs first */
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const invokeCancel = (sender = panel) =>
  handlers.get(DOCUMENT_AGENT_CHANNELS.cancel)!(eventOf(sender))

const fireTask = (channel: string, sender: FakeWc, payload: unknown) => {
  for (const listener of onListeners.get(channel) ?? []) listener(eventOf(sender), payload)
}

/** the task id of the command the docs tab received (its LATEST send — a test may run two) */
const taskIdOf = (wc: FakeWc): string => {
  const calls = wc.send.mock.calls.filter((c) => c[0] === 'docs:agent-task')
  const call = calls.at(-1)
  expect(call).toBeTruthy()
  return (call![1] as { taskId: string }).taskId
}

describe('document-agent:run — the routing', () => {
  it('routes the task to the active docs tab and resolves its result', async () => {
    const pending = invokeRun('add a summary section')
    await flush()
    expect(docsTab.send).toHaveBeenCalledWith('docs:agent-task', {
      taskId: taskIdOf(docsTab),
      task: 'add a summary section',
    })
    fireTask('docs:agent-task-result', docsTab, {
      taskId: taskIdOf(docsTab),
      ok: true,
      summary: 'inserted the section',
      edits: [{ tool: 'insert_content', summary: 'inserted 2 blocks' }],
    })
    await expect(pending).resolves.toEqual({
      ok: true,
      summary: 'inserted the section',
      edits: [{ tool: 'insert_content', summary: 'inserted 2 blocks' }],
    })
  })

  it('refuses a sender that is not a panel copy', async () => {
    const stranger = makeWc(902)
    await expect(invokeRun('x', stranger)).rejects.toThrow(/not callable from this sender/)
    expect(docsTab.send).not.toHaveBeenCalled()
  })

  it('guides the model when no document, a wrong-kind tab, or no active tab', async () => {
    tabs = []
    await expect(invokeRun('x')).rejects.toThrow(/no Word document is open/)
    tabs = [TAB({ kind: 'sheets', id: 't9' })]
    await expect(invokeRun('x')).rejects.toThrow(/active tab is a spreadsheet/)
    tabs = [TAB({ active: false })]
    await expect(invokeRun('x')).rejects.toThrow(/no Word document tab is active/)
    // the pure routing decision is directly checkable
    expect(documentAgentTargetError([TAB({ kind: 'pdf', active: true })])).toMatch(/PDF/)
    expect(documentAgentTargetError([TAB()])).toBeUndefined()
  })

  it('rejects a malformed task outright', async () => {
    await expect(invokeRun('')).rejects.toThrow(/`task` must be/)
    await expect(invokeRun('x'.repeat(4001))).rejects.toThrow(/at most 4000/)
    expect(docsTab.send).not.toHaveBeenCalled()
  })

  it('one task per document: a second delegation answers the busy error', async () => {
    const first = invokeRun('first')
    await flush()
    await expect(invokeRun('second')).rejects.toThrow(/already working in this document/)
    // settle the first so the tab is free again
    const taskId = taskIdOf(docsTab)
    fireTask('docs:agent-task-result', docsTab, { taskId, ok: true, summary: 'done' })
    await expect(first).resolves.toEqual({ ok: true, summary: 'done' })
    const retry = invokeRun('after')
    await flush()
    fireTask('docs:agent-task-result', docsTab, {
      taskId: taskIdOf(docsTab),
      ok: true,
      summary: 'done',
    })
    await expect(retry).resolves.toEqual({ ok: true, summary: 'done' })
  })

  it('a failed task rejects with its reason', async () => {
    const pending = invokeRun('x')
    await flush()
    fireTask('docs:agent-task-result', docsTab, {
      taskId: taskIdOf(docsTab),
      ok: false,
      summary: 'the document is protected',
    })
    await expect(pending).rejects.toThrow('the document is protected')
  })

  it('a reply from the wrong tab is ignored (the task stays pending)', async () => {
    const pending = invokeRun('x')
    await flush()
    const other = makeWc(903)
    const taskId = taskIdOf(docsTab)
    fireTask('docs:agent-task-result', other, { taskId, ok: false, summary: 'forged' })
    // still pending: only the target tab's reply settles it
    fireTask('docs:agent-task-result', docsTab, { taskId, ok: true, summary: 'real' })
    await expect(pending).resolves.toEqual({ ok: true, summary: 'real' })
  })
})

describe('the live progress relay', () => {
  it('relays well-formed statuses from the target tab to the calling panel', async () => {
    const pending = invokeRun('x')
    await flush()
    const taskId = taskIdOf(docsTab)
    fireTask('docs:agent-task-progress', docsTab, {
      taskId,
      status: { kind: 'inserting', tool: 'insert_content' },
    })
    expect(panel.send).toHaveBeenCalledWith(DOCUMENT_AGENT_CHANNELS.progress, {
      taskId,
      status: { kind: 'inserting', tool: 'insert_content' },
    })
    // junk never reaches the panel
    fireTask('docs:agent-task-progress', docsTab, { taskId, status: { kind: 'bogus' } })
    fireTask('docs:agent-task-progress', docsTab, { taskId, status: 7 })
    expect(panel.send).toHaveBeenCalledTimes(1)
    fireTask('docs:agent-task-result', docsTab, { taskId, ok: true, summary: 'ok' })
    await expect(pending).resolves.toEqual({ ok: true, summary: 'ok' })
  })

  it('progress from another tab is not relayed', async () => {
    const pending = invokeRun('x')
    await flush()
    const other = makeWc(904)
    const taskId = taskIdOf(docsTab)
    fireTask('docs:agent-task-progress', other, { taskId, status: { kind: 'writing' } })
    expect(panel.send).not.toHaveBeenCalled()
    fireTask('docs:agent-task-result', docsTab, { taskId, ok: true, summary: 'ok' })
    await expect(pending).resolves.toEqual({ ok: true, summary: 'ok' })
  })

  it('the status kind is the contract (the pure check)', () => {
    expect(isAgentTaskStatus({ kind: 'thinking' })).toBe(true)
    expect(isAgentTaskStatus({ kind: 'inserting', tool: 'insert_content' })).toBe(true)
    expect(isAgentTaskStatus({ kind: 'walking' })).toBe(false)
    expect(isAgentTaskStatus('thinking')).toBe(false)
    expect(isAgentTaskStatus(null)).toBe(false)
  })
})

describe('abort, timeout, and the closed tab', () => {
  it("cancel forwards the abort to the tab running the caller's task", async () => {
    const pending = invokeRun('x')
    await flush()
    const taskId = taskIdOf(docsTab)
    invokeCancel()
    expect(docsTab.send).toHaveBeenCalledWith('docs:agent-task-abort', { taskId })
    // the renderer's aborted reply settles the run
    fireTask('docs:agent-task-result', docsTab, {
      taskId,
      ok: false,
      summary: 'the task was stopped before it finished',
    })
    await expect(pending).rejects.toThrow('stopped before it finished')
  })

  it('a task that never ends hits the 3-minute cap and is aborted', async () => {
    vi.useFakeTimers()
    try {
      const assertion = (async () => {
        try {
          await invokeRun('endless')
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      })()
      const settle = vi.advanceTimersByTimeAsync(3 * 60_000)
      const message = await Promise.all([settle, assertion]).then(([, m]) => m)
      expect(message).toMatch(/timed out after 3 minutes/)
      expect(docsTab.send).toHaveBeenCalledWith('docs:agent-task-abort', expect.anything())
    } finally {
      vi.useRealTimers()
    }
  })

  it('a tab closed mid-task fails its run honestly', async () => {
    // a tab id no earlier test watched: the destroyed watcher attaches to
    // THIS webContents (ids are never reused in production; the test needs
    // a fresh one because it fakes them per test)
    docsTab = makeWc(950)
    announceReady(docsTab)
    const pending = invokeRun('x')
    await flush()
    const destroyed = destroyedOnce.get(docsTab.id)
    expect(destroyed).toBeTruthy()
    ;(destroyed as unknown as () => void)()
    await expect(pending).rejects.toThrow(/tab was closed mid-task/)
  })
})

describe('the card-time describe and the target pin', () => {
  it('describe answers the active docs tab read-only (title + tab id)', async () => {
    tabs = [TAB({ id: 't7', title: 'Contract v2.docx' })]
    const answer = (await handlers.get(DOCUMENT_AGENT_CHANNELS.describe)!(eventOf(panel))) as {
      tabId: string
      title: string
    }
    expect(answer).toEqual({ tabId: 't7', title: 'Contract v2.docx' })
    // read-only: no task command ever left
    expect(docsTab.send).not.toHaveBeenCalled()
    // and it is gated like the run channel
    const stranger = makeWc(960)
    await expect(
      handlers.get(DOCUMENT_AGENT_CHANNELS.describe)!(eventOf(stranger)),
    ).rejects.toThrow(/not callable from this sender/)
  })

  it('describe carries the routing error when nothing is delegatable', async () => {
    tabs = [TAB({ kind: 'sheets', id: 't9' })]
    const answer = (await handlers.get(DOCUMENT_AGENT_CHANNELS.describe)!(eventOf(panel))) as {
      error: string
    }
    expect(answer.error).toMatch(/active tab is a spreadsheet/)
  })

  it('a run pinned to a different tab refuses instead of retargeting (MED-5)', async () => {
    const pending = handlers.get(DOCUMENT_AGENT_CHANNELS.run)!(eventOf(panel), {
      task: 'add a summary',
      expectedTabId: 'the-tab-the-card-showed',
    })
    await expect(pending).rejects.toThrow(/active document changed since the confirmation/)
    expect(docsTab.send).not.toHaveBeenCalled()
  })

  it('a run pinned to the card-time tab proceeds', async () => {
    const pending = handlers.get(DOCUMENT_AGENT_CHANNELS.run)!(eventOf(panel), {
      task: 'add a summary',
      expectedTabId: 't1',
    })
    await flush()
    const taskId = taskIdOf(docsTab)
    fireTask('docs:agent-task-result', docsTab, { taskId, ok: true, summary: 'done' })
    await expect(pending).resolves.toEqual({ ok: true, summary: 'done' })
  })
})

describe('the cancel race and the readiness handshake', () => {
  it('a cancel that precedes registration refuses the run at registration (MED-4)', async () => {
    // the cancel lands while the run is still in its awaits: no active task
    // to abort, so the bridge buffers it per caller
    invokeCancel()
    await expect(invokeRun('too late')).rejects.toThrow(/cancelled before it started/)
    expect(docsTab.send).not.toHaveBeenCalled()
  })

  it('a stale buffered cancel (nothing followed it) does not poison the next run', async () => {
    vi.useFakeTimers()
    try {
      invokeCancel()
      // drift past the buffer's expiry; nothing followed the cancel
      await vi.advanceTimersByTimeAsync(3_000)
      const pending = invokeRun('fresh task')
      // flush the handler's microtask chain under the fake clock
      await vi.advanceTimersByTimeAsync(0)
      fireTask('docs:agent-task-result', docsTab, {
        taskId: taskIdOf(docsTab),
        ok: true,
        summary: 'done',
      })
      await expect(pending).resolves.toEqual({ ok: true, summary: 'done' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancel from a non-panel sender is ignored entirely (LOW-8)', async () => {
    const pending = invokeRun('x')
    await flush()
    const stranger = makeWc(961)
    const cancelled = handlers.get(DOCUMENT_AGENT_CHANNELS.cancel)!(eventOf(stranger))
    expect(cancelled).toBe(false)
    // the task was NOT aborted: it settles by its own result
    fireTask('docs:agent-task-result', docsTab, {
      taskId: taskIdOf(docsTab),
      ok: true,
      summary: 'done',
    })
    await expect(pending).resolves.toEqual({ ok: true, summary: 'done' })
  })

  it('a task for a not-ready tab waits for the announce, then routes (MED-6)', async () => {
    vi.useFakeTimers()
    try {
      // a docs tab whose renderer has NOT announced yet (the deps read the
      // live docsTab binding, so re-pointing it re-points the route)
      docsTab = makeWc(962)
      const pending = handlers.get(DOCUMENT_AGENT_CHANNELS.run)!(eventOf(panel), { task: 'x' })
      await vi.advanceTimersByTimeAsync(0)
      // while it waits, no task command has left
      expect(docsTab.send).not.toHaveBeenCalled()
      // the announce arrives 300ms in: the wait ends and the task routes
      await vi.advanceTimersByTimeAsync(300)
      announceReady(docsTab)
      await vi.advanceTimersByTimeAsync(100)
      fireTask('docs:agent-task-result', docsTab, {
        taskId: taskIdOf(docsTab),
        ok: true,
        summary: 'done',
      })
      await expect(pending).resolves.toEqual({ ok: true, summary: 'done' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a tab that never announces fails the run after the ready cap, not the task cap', async () => {
    vi.useFakeTimers()
    try {
      // fresh, never-announced docs tab (the ready set does not contain it)
      docsTab = makeWc(963)
      const assertion = (async () => {
        try {
          await handlers.get(DOCUMENT_AGENT_CHANNELS.run)!(eventOf(panel), { task: 'x' })
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      })()
      const message = await Promise.all([vi.advanceTimersByTimeAsync(10_500), assertion]).then(
        ([, m]) => m,
      )
      expect(message).toMatch(/still loading its agent/)
      // and no task command was ever sent to the booting tab
      expect(docsTab.send).not.toHaveBeenCalledWith('docs:agent-task', expect.anything())
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('LOW-10: the result report caps', () => {
  it('an oversized summary and edit list truncate to the bridge caps', async () => {
    const pending = invokeRun('x')
    await flush()
    const taskId = taskIdOf(docsTab)
    const edits = Array.from({ length: 250 }, (_, i) => ({
      tool: `t${'x'.repeat(200)}-${i}`,
      summary: 'y'.repeat(600),
    }))
    fireTask('docs:agent-task-result', docsTab, {
      taskId,
      ok: true,
      summary: 'z'.repeat(30_000),
      edits,
    })
    const result = await pending
    expect(result.summary.length).toBe(20_000)
    expect(result.edits).toHaveLength(100)
    expect(result.edits![0]!.tool.length).toBe(100)
    expect(result.edits![0]!.summary.length).toBe(400)
    // junk entries are dropped, not half-kept
    const withJunk = invokeRun('junk')
    await flush()
    fireTask('docs:agent-task-result', docsTab, {
      taskId: taskIdOf(docsTab),
      ok: true,
      summary: 'ok',
      edits: [{ tool: 'insert_content', summary: 'fine' }, 'junk', { tool: 7 }],
    })
    await expect(withJunk).resolves.toMatchObject({
      edits: [{ tool: 'insert_content', summary: 'fine' }],
    })
  })
})
