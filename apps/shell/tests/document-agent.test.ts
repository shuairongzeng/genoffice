import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { AGENT_DOCUMENT_KINDS, HEADLESS_AGENT_CHANNELS } from '@genoffice/agent-core'

/**
 * The document-agent bridge (src/main/document-agent.ts): the dock panel's
 * document_agent tool lands over `document-agent:run` and routes to the
 * ACTIVE document tab's renderer across all 6 supported document kinds —
 * one task per document, progress relayed to the calling panel, a 3-minute
 * cap, an abort channel, an undo checkpoint relay, and honest failures for
 * a closed tab.
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
  DOCUMENT_AGENT_UNDO_TIMEOUT_MS,
  installDocumentAgentBridge,
  isAgentTaskStatus,
  documentAgentTargetError,
  type DocumentAgentTab,
} from '../src/main/document-agent'

/** a fake webContents: the panel caller or the document tab */
function makeWc(id: number): FakeWc {
  const wc: FakeWc = { id, send: vi.fn(), isDestroyed: () => false }
  ;(wc as FakeWc & { once: unknown }).once = (
    channel: string,
    listener: (event: unknown) => void,
  ) => {
    if (channel === 'destroyed') destroyedOnce.set(wc.id, listener)
  }
  wcs.set(id, wc)
  return wc
}

/** the event shape ipcMain hands a handler */
const eventOf = (wc: FakeWc): { sender: FakeWc } => ({ sender: wc })

const TAB = (over: Partial<DocumentAgentTab> = {}): DocumentAgentTab => ({
  id: 't1',
  kind: 'docs',
  title: 'Report.docx',
  active: true,
  ...over,
})

let panel: FakeWc
let docsTab: FakeWc
let tabs: DocumentAgentTab[]
let activateTabSpy: ReturnType<typeof vi.fn<(tabId: string) => boolean>>

installDocumentAgentBridge({
  listDocumentTabs: () => tabs,
  webContentsFor: (tabId) => (tabId === 't1' ? (docsTab as unknown as WebContents) : undefined),
  activateTab: (tabId) => activateTabSpy(tabId),
  panelWebContents: () => [panel as unknown as WebContents],
})

beforeEach(() => {
  destroyedOnce.clear()
  panel = makeWc(900)
  docsTab = makeWc(901)
  tabs = [TAB()]
  activateTabSpy = vi.fn((tabId: string) => {
    const target = tabs.find((t) => t.id === tabId)
    if (!target) return false
    tabs = tabs.map((t) => ({ ...t, active: t.id === tabId }))
    return true
  })
  announceReady(docsTab)
})

/** fire the renderer's readiness announce for one webContents */
const announceReady = (wc: FakeWc): void => {
  for (const listener of onListeners.get(HEADLESS_AGENT_CHANNELS.ready) ?? []) {
    listener(eventOf(wc))
  }
}

const invokeRun = (task: string, sender = panel) =>
  handlers.get(DOCUMENT_AGENT_CHANNELS.run)!(eventOf(sender), { task })

/** a macrotask boundary: every microtask the async handler chains runs first */
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const invokeCancel = (sender = panel) =>
  handlers.get(DOCUMENT_AGENT_CHANNELS.cancel)!(eventOf(sender))

const invokeUndo = (tabId: string, checkpointId: string, sender = panel) =>
  handlers.get(DOCUMENT_AGENT_CHANNELS.undo)!(eventOf(sender), { tabId, checkpointId })

const fireTask = (channel: string, sender: FakeWc, payload: unknown) => {
  for (const listener of onListeners.get(channel) ?? []) listener(eventOf(sender), payload)
}

/** the task id of the command the document tab received (its LATEST send) */
const taskIdOf = (wc: FakeWc): string => {
  const calls = wc.send.mock.calls.filter((c) => c[0] === HEADLESS_AGENT_CHANNELS.task)
  const call = calls.at(-1)
  expect(call).toBeTruthy()
  return (call![1] as { taskId: string }).taskId
}

/** the undo id of the command the document tab received */
const undoIdOf = (wc: FakeWc): string => {
  const calls = wc.send.mock.calls.filter((c) => c[0] === HEADLESS_AGENT_CHANNELS.undo)
  const call = calls.at(-1)
  expect(call).toBeTruthy()
  return (call![1] as { undoId: string }).undoId
}

describe('document-agent:run — the routing', () => {
  it('routes the task to the active document tab across all 6 kinds and resolves result + checkpoint', async () => {
    for (const kind of AGENT_DOCUMENT_KINDS) {
      tabs = [TAB({ id: 't1', kind, title: `sample.${kind}`, active: true })]
      const pending = invokeRun(`edit in ${kind}`)
      await flush()
      const taskId = taskIdOf(docsTab)
      expect(docsTab.send).toHaveBeenCalledWith(HEADLESS_AGENT_CHANNELS.task, {
        taskId,
        task: `edit in ${kind}`,
      })
      fireTask(HEADLESS_AGENT_CHANNELS.result, docsTab, {
        taskId,
        ok: true,
        summary: 'updated content',
        edits: [{ tool: 'edit', summary: 'changed item' }],
        checkpointId: `cp-${kind}`,
      })
      await expect(pending).resolves.toEqual({
        ok: true,
        summary: 'updated content',
        edits: [{ tool: 'edit', summary: 'changed item' }],
        checkpointId: `cp-${kind}`,
        tabId: 't1',
        kind,
        title: `sample.${kind}`,
      })
    }
  })

  it('auto-switches when tabId targets a background document tab and rejects invalid targets', async () => {
    tabs = [
      TAB({ id: 'home', kind: 'home', title: 'Home', active: true }),
      TAB({ id: 't1', kind: 'markdown', title: 'Notes.md', active: false }),
      TAB({ id: 'b1', kind: 'browser', title: 'Example', active: false }),
    ]

    const pending = handlers.get(DOCUMENT_AGENT_CHANNELS.run)!(eventOf(panel), {
      task: 'append a paragraph',
      tabId: 't1',
    })
    await flush()
    expect(activateTabSpy).toHaveBeenCalledWith('t1')
    expect(tabs.find((t) => t.id === 't1')?.active).toBe(true)
    const taskId = taskIdOf(docsTab)
    fireTask(HEADLESS_AGENT_CHANNELS.result, docsTab, { taskId, ok: true, summary: 'appended' })
    await expect(pending).resolves.toMatchObject({
      ok: true,
      summary: 'appended',
      tabId: 't1',
      kind: 'markdown',
    })

    // Non-existent or non-document explicit tabId fails with clear guidance.
    await expect(
      handlers.get(DOCUMENT_AGENT_CHANNELS.run)!(eventOf(panel), {
        task: 'x',
        tabId: 'missing',
      }),
    ).rejects.toThrow(/no open tab has the id "missing"/)
    await expect(
      handlers.get(DOCUMENT_AGENT_CHANNELS.run)!(eventOf(panel), {
        task: 'x',
        tabId: 'b1',
      }),
    ).rejects.toThrow(/not a document/)

    // Refuses if activateTab returns false.
    tabs = [
      TAB({ id: 'home', kind: 'home', title: 'Home', active: true }),
      TAB({ id: 't1', kind: 'markdown', title: 'Notes.md', active: false }),
    ]
    activateTabSpy.mockReturnValueOnce(false)
    await expect(
      handlers.get(DOCUMENT_AGENT_CHANNELS.run)!(eventOf(panel), {
        task: 'x',
        tabId: 't1',
      }),
    ).rejects.toThrow(/could not switch to document tab "t1"/)

    // Pure seam supports optional tabId too.
    expect(documentAgentTargetError(tabs, 't1')).toBeUndefined()
    expect(documentAgentTargetError(tabs, 'missing')).toMatch(/no open tab has the id "missing"/)
  })

  it('refuses a sender that is not a panel copy', async () => {
    const stranger = makeWc(902)
    await expect(invokeRun('x', stranger)).rejects.toThrow(/not callable from this sender/)
    expect(docsTab.send).not.toHaveBeenCalled()
  })

  it('guides the model when no document, a non-document tab, or no active tab', async () => {
    tabs = []
    await expect(invokeRun('x')).rejects.toThrow(/no document is open/)
    tabs = [TAB({ kind: 'browser', id: 'b1' }), TAB({ kind: 'sheets', id: 't9', active: false })]
    await expect(invokeRun('x')).rejects.toThrow(/active tab is the browser, not a document/)
    tabs = [TAB({ active: false })]
    await expect(invokeRun('x')).rejects.toThrow(/no document tab is active/)
    // all 6 document kinds pass the pure routing decision
    for (const kind of AGENT_DOCUMENT_KINDS) {
      expect(documentAgentTargetError([TAB({ kind, active: true })])).toBeUndefined()
    }
    expect(
      documentAgentTargetError([TAB({ kind: 'browser', active: true }), TAB({ active: false })]),
    ).toMatch(/browser/)
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
    const taskId = taskIdOf(docsTab)
    fireTask(HEADLESS_AGENT_CHANNELS.result, docsTab, { taskId, ok: true, summary: 'done' })
    await expect(first).resolves.toMatchObject({ ok: true, summary: 'done', tabId: 't1' })
    const retry = invokeRun('after')
    await flush()
    fireTask(HEADLESS_AGENT_CHANNELS.result, docsTab, {
      taskId: taskIdOf(docsTab),
      ok: true,
      summary: 'done',
    })
    await expect(retry).resolves.toMatchObject({ ok: true, summary: 'done', tabId: 't1' })
  })

  it('a failed task rejects with its reason', async () => {
    const pending = invokeRun('x')
    await flush()
    fireTask(HEADLESS_AGENT_CHANNELS.result, docsTab, {
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
    fireTask(HEADLESS_AGENT_CHANNELS.result, other, { taskId, ok: false, summary: 'forged' })
    fireTask(HEADLESS_AGENT_CHANNELS.result, docsTab, { taskId, ok: true, summary: 'real' })
    await expect(pending).resolves.toMatchObject({ ok: true, summary: 'real', tabId: 't1' })
  })
})

describe('the live progress relay', () => {
  it('relays well-formed statuses with tab kind from the target tab to the calling panel', async () => {
    tabs = [TAB({ id: 't1', kind: 'sheets', title: 'budget.xlsx', active: true })]
    const pending = invokeRun('x')
    await flush()
    const taskId = taskIdOf(docsTab)
    fireTask(HEADLESS_AGENT_CHANNELS.progress, docsTab, {
      taskId,
      status: { kind: 'applying', tool: 'propose_operations' },
    })
    expect(panel.send).toHaveBeenCalledWith(DOCUMENT_AGENT_CHANNELS.progress, {
      taskId,
      kind: 'sheets',
      status: { kind: 'applying', tool: 'propose_operations' },
    })
    // junk never reaches the panel
    fireTask(HEADLESS_AGENT_CHANNELS.progress, docsTab, { taskId, status: { kind: 'bogus' } })
    fireTask(HEADLESS_AGENT_CHANNELS.progress, docsTab, { taskId, status: 7 })
    expect(panel.send).toHaveBeenCalledTimes(1)
    fireTask(HEADLESS_AGENT_CHANNELS.result, docsTab, { taskId, ok: true, summary: 'ok' })
    await expect(pending).resolves.toMatchObject({ ok: true, summary: 'ok', kind: 'sheets' })
  })

  it('progress from another tab is not relayed', async () => {
    const pending = invokeRun('x')
    await flush()
    const other = makeWc(904)
    const taskId = taskIdOf(docsTab)
    fireTask(HEADLESS_AGENT_CHANNELS.progress, other, { taskId, status: { kind: 'writing' } })
    expect(panel.send).not.toHaveBeenCalled()
    fireTask(HEADLESS_AGENT_CHANNELS.result, docsTab, { taskId, ok: true, summary: 'ok' })
    await expect(pending).resolves.toMatchObject({ ok: true, summary: 'ok' })
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
    expect(docsTab.send).toHaveBeenCalledWith(HEADLESS_AGENT_CHANNELS.abort, { taskId })
    fireTask(HEADLESS_AGENT_CHANNELS.result, docsTab, {
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
      expect(docsTab.send).toHaveBeenCalledWith(HEADLESS_AGENT_CHANNELS.abort, expect.anything())
    } finally {
      vi.useRealTimers()
    }
  })

  it('a tab closed mid-task fails its run honestly', async () => {
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
  it('describe answers the active document tab read-only (tabId + kind + title)', async () => {
    tabs = [TAB({ id: 't7', kind: 'slides', title: 'Deck.pptx' })]
    const answer = (await handlers.get(DOCUMENT_AGENT_CHANNELS.describe)!(eventOf(panel))) as {
      tabId: string
      kind: string
      title: string
    }
    expect(answer).toEqual({ tabId: 't7', kind: 'slides', title: 'Deck.pptx' })
    expect(docsTab.send).not.toHaveBeenCalled()
    const stranger = makeWc(960)
    await expect(
      handlers.get(DOCUMENT_AGENT_CHANNELS.describe)!(eventOf(stranger)),
    ).rejects.toThrow(/not callable from this sender/)
  })

  it('describe carries the routing error when active tab is not a document', async () => {
    tabs = [TAB({ kind: 'home', id: 'home', active: true }), TAB({ kind: 'sheets', id: 't9', active: false })]
    const answer = (await handlers.get(DOCUMENT_AGENT_CHANNELS.describe)!(eventOf(panel))) as {
      error: string
    }
    expect(answer.error).toMatch(/active tab is the Home desktop/)
  })

  it('describe targets the explicit document tabId even while Home is active', async () => {
    tabs = [
      TAB({ kind: 'home', id: 'home', active: true }),
      TAB({ kind: 'markdown', id: 't1', title: 'Poems.md', active: false }),
    ]
    const answer = (await handlers.get(DOCUMENT_AGENT_CHANNELS.describe)!(eventOf(panel), {
      tabId: 't1',
    })) as { tabId: string; kind: string; title: string }
    expect(answer).toEqual({ tabId: 't1', kind: 'markdown', title: 'Poems.md' })
    expect(activateTabSpy).not.toHaveBeenCalled()
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
    fireTask(HEADLESS_AGENT_CHANNELS.result, docsTab, { taskId, ok: true, summary: 'done' })
    await expect(pending).resolves.toMatchObject({ ok: true, summary: 'done', tabId: 't1' })
  })
})

describe('document-agent:undo — Git-style checkpoint rollback', () => {
  it('forwards undo requests to the target tab webContents and resolves its result', async () => {
    const pending = invokeUndo('t1', 'cp-42')
    await flush()
    const undoId = undoIdOf(docsTab)
    expect(docsTab.send).toHaveBeenCalledWith(HEADLESS_AGENT_CHANNELS.undo, {
      undoId,
      checkpointId: 'cp-42',
    })
    fireTask(HEADLESS_AGENT_CHANNELS.undoResult, docsTab, { undoId, ok: true })
    await expect(pending).resolves.toEqual({ ok: true })
  })

  it('returns an error when sender is invalid, tab closed, busy, or timed out', async () => {
    const stranger = makeWc(970)
    await expect(invokeUndo('t1', 'cp-1', stranger)).rejects.toThrow(
      /not callable from this sender/,
    )
    await expect(invokeUndo('', 'cp-1')).resolves.toMatchObject({ ok: false })
    await expect(invokeUndo('missing-tab', 'cp-1')).resolves.toEqual({
      ok: false,
      error: 'document tab is no longer open',
    })
    vi.useFakeTimers()
    try {
      const pending = invokeUndo('t1', 'cp-timeout')
      await vi.advanceTimersByTimeAsync(DOCUMENT_AGENT_UNDO_TIMEOUT_MS + 100)
      await expect(pending).resolves.toEqual({ ok: false, error: 'undo timed out' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the cancel race and the readiness handshake', () => {
  it('a cancel that precedes registration refuses the run at registration (MED-4)', async () => {
    invokeCancel()
    await expect(invokeRun('too late')).rejects.toThrow(/cancelled before it started/)
    expect(docsTab.send).not.toHaveBeenCalled()
  })

  it('a stale buffered cancel (nothing followed it) does not poison the next run', async () => {
    vi.useFakeTimers()
    try {
      invokeCancel()
      await vi.advanceTimersByTimeAsync(3_000)
      const pending = invokeRun('fresh task')
      await vi.advanceTimersByTimeAsync(0)
      fireTask(HEADLESS_AGENT_CHANNELS.result, docsTab, {
        taskId: taskIdOf(docsTab),
        ok: true,
        summary: 'done',
      })
      await expect(pending).resolves.toMatchObject({ ok: true, summary: 'done' })
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
    fireTask(HEADLESS_AGENT_CHANNELS.result, docsTab, {
      taskId: taskIdOf(docsTab),
      ok: true,
      summary: 'done',
    })
    await expect(pending).resolves.toMatchObject({ ok: true, summary: 'done' })
  })

  it('a task for a not-ready tab waits for the announce, then routes (MED-6)', async () => {
    vi.useFakeTimers()
    try {
      docsTab = makeWc(962)
      const pending = handlers.get(DOCUMENT_AGENT_CHANNELS.run)!(eventOf(panel), { task: 'x' })
      await vi.advanceTimersByTimeAsync(0)
      expect(docsTab.send).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(300)
      announceReady(docsTab)
      await vi.advanceTimersByTimeAsync(100)
      fireTask(HEADLESS_AGENT_CHANNELS.result, docsTab, {
        taskId: taskIdOf(docsTab),
        ok: true,
        summary: 'done',
      })
      await expect(pending).resolves.toMatchObject({ ok: true, summary: 'done' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a tab that never announces fails the run after the ready cap, not the task cap', async () => {
    vi.useFakeTimers()
    try {
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
      expect(docsTab.send).not.toHaveBeenCalledWith(HEADLESS_AGENT_CHANNELS.task, expect.anything())
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
    fireTask(HEADLESS_AGENT_CHANNELS.result, docsTab, {
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
    const withJunk = invokeRun('junk')
    await flush()
    fireTask(HEADLESS_AGENT_CHANNELS.result, docsTab, {
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
