// @vitest-environment jsdom
/**
 * The headless document agent (src/renderer/ai/headless-agent.ts): the global
 * dock's document_agent tool routes a task here, and the docs agent loop
 * runs it WITHOUT the panel UI — same docs skill, same transport, one-shot
 * conversation. These drive the real loop with a stubbed bridge: a task goes
 * in, the write op applies to the live editor, the summary and edit list
 * come out, and the live progress reports ride the bridge. The headless
 * confirm policy shows itself as the write tool simply running — the same
 * call parks the in-app panel at its allow/deny card. Abort cancels the
 * sub-agent's run; a second task while one runs answers the busy report.
 */
import { describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { installHeadlessAgentBridge } from '../src/renderer/ai/headless-agent'
import type { FileActionContext } from '../src/renderer/file-actions'
import type { AiSettings } from '../src/shared/ipc'
import { AI_PROVIDERS } from '../src/shared/ipc'
import { AI_REVISION_AUTHOR } from '../src/renderer/ai/AiPanel'

type ChunkListener = (chunk: {
  requestId: string
  type: string
  text?: string
  toolCall?: { id: string; name: string; input: Record<string, unknown> }
}) => void

type CommandListener = (message: { taskId: string; task: string }) => void
type AbortListener = (message: { taskId: string }) => void

interface BridgeStub {
  commandListeners: CommandListener[]
  abortListeners: AbortListener[]
  progress: Array<{ taskId: string; status: { kind: string; tool?: string } }>
  results: Array<{ taskId: string; ok: boolean; summary: string; edits?: unknown }>
  started: Array<{ requestId: string; messages: unknown[] }>
}

function settings(): AiSettings {
  return {
    provider: 'gemini',
    providers: Object.fromEntries(
      AI_PROVIDERS.map((p) => [
        p.id,
        p.id === 'gemini'
          ? { apiKey: 'k', model: p.defaultModel }
          : { apiKey: '', model: p.defaultModel },
      ]),
    ) as AiSettings['providers'],
  }
}

function createEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: {
      type: 'doc',
      content: [
        {
          type: 'docParagraph',
          attrs: { docxIndex: 0 },
          content: [{ type: 'text', text: 'original body' }],
        },
      ],
    },
  })
}

const ctxOf = (editor: Editor): FileActionContext =>
  ({
    editor,
    doc: { parsed: { blocks: [] }, isBlank: false },
    dirtyRef: { current: false },
    saveInFlightRef: { current: false },
    saveIncompleteRef: { current: false },
    pendingMixedExportRef: { current: false },
    bumpPendingExportTick: () => {},
    printAutoOpenedPreviewRef: { current: false },
    setShowPrintDialog: () => {},
    setStatus: () => {},
    setRecent: () => {},
    setShowAi: () => {},
  }) as unknown as FileActionContext

/**
 * The bridge + transport stub. Turn 1 answers with the insert_content call
 * (the same shape the confirm-gate tests use); turn 2 answers with text —
 * unless `hangAfterTool` leaves it silent (the abort fixture).
 */
function stubBridge(hangAfterTool = false): BridgeStub {
  const stub: BridgeStub = {
    commandListeners: [],
    abortListeners: [],
    progress: [],
    results: [],
    started: [],
  }
  let streamListener: ChunkListener | null = null
  ;(window as unknown as Record<string, unknown>).desktop = {
    aiGskStatus: vi.fn(async () => ({ loggedIn: true })),
    onAiStream: (l: ChunkListener) => {
      streamListener = l
      return () => {
        streamListener = null
      }
    },
    aiStream: vi.fn(async (request: { requestId: string; messages: unknown[] }) => {
      stub.started.push(request)
      if (stub.started.length === 1) {
        queueMicrotask(() => {
          streamListener?.({
            requestId: request.requestId,
            type: 'tool-call',
            toolCall: {
              id: 't1',
              name: 'insert_content',
              input: { html: '<p>AI inserted</p>', afterBlockIndex: -1 },
            },
          })
          streamListener?.({ requestId: request.requestId, type: 'done' })
        })
      } else if (!hangAfterTool) {
        queueMicrotask(() => {
          streamListener?.({
            requestId: request.requestId,
            type: 'delta',
            text: 'added the paragraph',
          })
          streamListener?.({ requestId: request.requestId, type: 'done' })
        })
      }
      // hangAfterTool: turn 2 stays silent (the abort fixture)
    }),
    aiStreamCancel: vi.fn(async (requestId: string) => {
      // the real cancel aborts the provider stream, whose catch emits a clean
      // done chunk (docs-main's ai:stream-cancel path)
      queueMicrotask(() => streamListener?.({ requestId, type: 'done' }))
    }),
    kbList: undefined,
    onAgentTaskCommand: (handler: CommandListener) => {
      stub.commandListeners.push(handler)
      return () => {}
    },
    onAgentTaskAbort: (handler: AbortListener) => {
      stub.abortListeners.push(handler)
      return () => {}
    },
    reportAgentTaskProgress: (report: {
      taskId: string
      status: { kind: string; tool?: string }
    }) => {
      stub.progress.push(report)
    },
    reportAgentTaskResult: (result: {
      taskId: string
      ok: boolean
      summary: string
      edits?: unknown
    }) => {
      stub.results.push(result)
    },
  }
  return stub
}

const settle = async (rounds = 8): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0))
}

const fireTask = (stub: BridgeStub, taskId: string, task: string): void => {
  for (const listener of stub.commandListeners) listener({ taskId, task })
}

const fireAbort = (stub: BridgeStub, taskId: string): void => {
  for (const listener of stub.abortListeners) listener({ taskId })
}

const install = (editor: Editor) =>
  installHeadlessAgentBridge({
    getCtx: () => ctxOf(editor),
    getSettings: () => settings(),
    getComments: () => undefined,
    getHf: () => undefined,
    getPageSetup: () => undefined,
    getExtras: () => undefined,
    getNotes: () => undefined,
    attachments: () => [],
  })

describe('the headless document agent', () => {
  it('runs a task end to end: the op applies, the summary and edits report, progress streams', async () => {
    const editor = createEditor()
    try {
      const stub = stubBridge()
      const off = install(editor)
      fireTask(stub, 'task-1', 'add a paragraph at the top')
      await settle()

      // the write op applied to the live document — the headless confirm
      // policy in action: this very call would park the in-app panel at its
      // allow/deny card; under the delegation's mandate it just runs
      expect(editor.state.doc.textContent).toContain('AI inserted')
      // the task's answer carries the sub-agent's summary and its edits
      expect(stub.results).toHaveLength(1)
      expect(stub.results[0]).toMatchObject({
        taskId: 'task-1',
        ok: true,
        summary: 'added the paragraph',
        edits: [{ tool: 'insert_content' }],
      })
      // the live status streamed: the tool's kind, not a silent spinner
      const kinds = stub.progress.map((p) => p.status.kind)
      expect(kinds).toContain('inserting')
      expect(stub.progress.some((p) => p.status.tool === 'insert_content')).toBe(true)
      // the loop is one-shot: the whole conversation was the task text (the
      // docs skill's block-list context rides along, as in the panel)
      expect(JSON.stringify(stub.started[0]!.messages[0])).toContain('add a paragraph at the top')
      off()
    } finally {
      editor.destroy()
    }
  })

  it('a document that is not ready reports it instead of throwing', async () => {
    const stub = stubBridge()
    const off = installHeadlessAgentBridge({
      getCtx: () => ({ editor: null, doc: null }) as unknown as FileActionContext,
      getSettings: () => settings(),
      getComments: () => undefined,
      getHf: () => undefined,
      getPageSetup: () => undefined,
      getExtras: () => undefined,
      getNotes: () => undefined,
      attachments: () => [],
    })
    fireTask(stub, 'task-9', 'do anything')
    await settle()
    expect(stub.results).toEqual([
      { taskId: 'task-9', ok: false, summary: 'the document is not ready', edits: [] },
    ])
    off()
  })

  it('a second task while one runs answers the busy report (one task per document)', async () => {
    const editor = createEditor()
    try {
      const stub = stubBridge(true) // turn 2 hangs: the first task stays in flight
      const off = install(editor)
      fireTask(stub, 'task-1', 'first')
      await settle()
      fireTask(stub, 'task-2', 'second')
      await settle()
      expect(stub.results).toEqual([
        { taskId: 'task-2', ok: false, summary: 'this document is already running a task' },
      ])
      fireAbort(stub, 'task-1')
      await settle()
      off()
    } finally {
      editor.destroy()
    }
  })

  it('abort mid-task cancels the sub-agent run and reports the stop', async () => {
    const editor = createEditor()
    try {
      const stub = stubBridge(true) // the model stream hangs after the write
      const off = install(editor)
      fireTask(stub, 'task-1', 'long task')
      await settle()
      // the write op landed before the hang
      expect(editor.state.doc.textContent).toContain('AI inserted')
      expect(stub.results).toHaveLength(0)
      fireAbort(stub, 'task-1')
      await settle()
      expect(stub.results).toHaveLength(1)
      expect(stub.results[0]).toMatchObject({
        taskId: 'task-1',
        ok: false,
      })
      expect(stub.results[0]!.summary).toMatch(/stopped/)
      off()
    } finally {
      editor.destroy()
    }
  })

  it('the headless toolset excludes the laundering, disk and non-revisionary writes', async () => {
    const editor = createEditor()
    try {
      const stub = stubBridge()
      const off = install(editor)
      fireTask(stub, 'task-1', 'add a paragraph')
      await settle()
      // the loop's first request carries the tool table the sub-agent got
      const request = stub.started[0] as unknown as {
        tools: Array<{ name: string }>
      }
      const names = new Set(request.tools.map((t) => t.name))
      // the revision-expressible writes and reads stay
      for (const name of [
        'insert_content',
        'replace_blocks',
        'replace_selection',
        'apply_ops',
        'write_document',
        'get_document_context',
        'read_blocks',
        'add_comment',
      ]) {
        expect(names.has(name), `${name} should be offered`).toBe(true)
      }
      // the self-laundering, disk-write and untracked-write escapes are gone
      for (const name of [
        'accept_changes',
        'reject_changes',
        'create_document',
        'insert_image',
        'generate_image',
        'insert_chart',
        'edit_chart',
        'insert_footnote',
        'set_header_footer',
        'delete_comment',
      ]) {
        expect(names.has(name), `${name} must not be offered headless`).toBe(false)
      }
      off()
    } finally {
      editor.destroy()
    }
  })

  it('every change stays a PENDING revision under the AI author (even with the document tracking off)', async () => {
    const editor = createEditor()
    try {
      const stub = stubBridge()
      // the document's own track-changes state is OFF here (the default test
      // editor) — the sub-agent's edits must still land as pending revisions
      const off = install(editor)
      fireTask(stub, 'task-1', 'add a paragraph')
      await settle()
      expect(editor.state.doc.textContent).toContain('AI inserted')
      // the inserted text carries the tracked-insertion mark authored by the
      // sub-agent: the Review tab is where the owner accepts or rejects it
      const inserted = editor.state.doc.firstChild
      const marks = (inserted?.firstChild?.marks ?? []) as unknown as Array<{
        type: { name: string }
        attrs: { author?: string }
      }>
      const ins = marks.find((m) => m.type.name === 'ins')
      expect(ins, 'the insertion should carry the ins revision mark').toBeTruthy()
      expect(ins?.attrs.author).toBe(AI_REVISION_AUTHOR)
      off()
    } finally {
      editor.destroy()
    }
  })
})
