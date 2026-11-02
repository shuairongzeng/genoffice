// @vitest-environment jsdom
/**
 * The Ask panel's safety layer end to end: the inline allow/deny card around
 * risk:'high' tools, and the background-task list backed by the project
 * store's first-class runs API (appendRunEvent / listRuns / deleteRun over the
 * renderer bridges). These drive the real send path (AgentLoop + IPC
 * transport) with a stubbed main process, asserting on what the model receives
 * and on the run events that cross the runs bridge.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { KbAskPanel } from '../src/renderer/src/KbAskPanel'
import { LocaleProvider } from '../src/renderer/src/locale'
import { TOOL_DENIED_OUTPUT } from '@genoffice/agent-core'
import type { ChatMessage, ProjectApi, RunSummary } from '@genoffice/project-store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CORPUS = [
  { path: 'C:/kb/notes.md', folder: 'kb', name: 'notes.md', ext: 'md', sizeBytes: 512 },
]

interface StartedRequest {
  requestId: string
  messages: Array<{ role: string; text?: string; results?: Array<{ output: string }> }>
  tools: Array<{ name: string; risk?: string }>
}

type ChunkListener = (chunk: {
  requestId: string
  type: string
  text?: string
  toolCall?: unknown
}) => void

/** stores the conversations and records every call, like the main process would */
function projectApiStub(storedRuns: string[]) {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = []
  const chats = new Map<string, ChatMessage[]>()
  for (const text of storedRuns) {
    const list = chats.get(RUNS_CHAT_ID) ?? []
    list.push({
      seq: list.length,
      ts: `2026-10-30T09:0${list.length}:00.000Z`,
      role: 'assistant',
      text,
    })
    chats.set(RUNS_CHAT_ID, list)
  }
  const api = {
    resolveChat: async (args: { filePath: string | null; tempChatId?: string }) => {
      calls.push({ method: 'resolveChat', args: args as Record<string, unknown> })
      return { projectId: 'default', chatId: args.tempChatId ?? 'kb-ask' }
    },
    appendChat: async (args: Record<string, unknown>) => {
      calls.push({ method: 'appendChat', args })
      const chatId = args.chatId as string
      const list = chats.get(chatId) ?? []
      list.push({
        seq: list.length,
        ts: '2026-10-30T09:00:00.000Z',
        role: args.role as 'user' | 'assistant',
        text: args.text as string,
      })
      chats.set(chatId, list)
    },
    loadChat: async (args: { chatId: string; limit?: number }) => {
      calls.push({ method: 'loadChat', args: args as Record<string, unknown> })
      return [...(chats.get(args.chatId) ?? [])]
    },
    deleteChat: async (args: Record<string, unknown>) => {
      calls.push({ method: 'deleteChat', args })
      chats.delete(args.chatId as string)
    },
    listChats: async (args: { projectId: string }) => {
      calls.push({ method: 'listChats', args: args as Record<string, unknown> })
      return [...chats.entries()].map(([chatId, list]) => ({
        chatId,
        firstQuestion: list.find((m) => m.role === 'user')?.text ?? '',
        updatedAt: '2026-10-30T09:00:00.000Z',
      }))
    },
  } as unknown as ProjectApi
  return { api, calls, chats }
}

let host: HTMLDivElement
let root: Root
let started: StartedRequest[]
let chunkListener: ChunkListener | null
let runCli: ReturnType<typeof vi.fn>
let editFile: ReturnType<typeof vi.fn>
let deleteFile: ReturnType<typeof vi.fn>
let documentAgentRun: ReturnType<typeof vi.fn>
let documentAgentCancel: ReturnType<typeof vi.fn>
let documentAgentDescribe: ReturnType<typeof vi.fn>
let agentProgressListener:
  ((event: { taskId: string; status: { kind: string; tool?: string } }) => void) | null
let project: ReturnType<typeof projectApiStub>
let runs: ReturnType<typeof runsApiStub>

/**
 * The runs half of the aiOffice bridge, over an in-memory event log: the
 * panel sees the same contract the shell preload forwards
 * (project:appendRunEvent / listRuns / deleteRun), with the store's fold
 * reduced to what these tests need (a start fixes the row, the last terminal
 * settles it).
 */
function runsApiStub(storedRuns: RunSummary[]) {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = []
  const eventsByRun = new Map<string, Array<Record<string, unknown>>>()
  const summaries = [...storedRuns]
  const fold = (): RunSummary[] => {
    const folded: RunSummary[] = []
    for (const [runId, events] of eventsByRun) {
      const start = events.find((e) => e.kind === 'start')
      if (!start) continue
      const terminal = [...events].reverse().find((e) => e.kind === 'finish' || e.kind === 'error')
      folded.push({
        runId,
        instruction: String(start.instruction ?? ''),
        ...(start.chatId ? { chatId: String(start.chatId) } : {}),
        status: terminal
          ? terminal.kind === 'error'
            ? 'error'
            : terminal.outcome === 'cancelled'
              ? 'cancelled'
              : terminal.outcome === 'discarded'
                ? 'discarded'
                : 'done'
          : 'interrupted',
        startedAt: '2026-10-30T09:00:00.000Z',
      })
    }
    return folded
  }
  const api = {
    appendRunEvent: async (args: Record<string, unknown>) => {
      calls.push({ method: 'appendRunEvent', args })
      const runId = String(args.runId)
      const list = eventsByRun.get(runId) ?? []
      list.push({ ...args })
      eventsByRun.set(runId, list)
    },
    listRuns: async (args: Record<string, unknown>) => {
      calls.push({ method: 'listRuns', args })
      return [...summaries, ...fold()]
    },
    deleteRun: async (args: Record<string, unknown>) => {
      calls.push({ method: 'deleteRun', args })
      eventsByRun.delete(String(args.runId))
      const at = summaries.findIndex((run) => run.runId === args.runId)
      if (at >= 0) summaries.splice(at, 1)
    },
  }
  return { api, calls, summaries }
}

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {}
})

beforeEach(() => {
  started = []
  chunkListener = null
  runCli = vi.fn(async () => ({ ok: true, code: 0, stdout: '{"status":"ok"}', stderr: '' }))
  editFile = vi.fn(async () => ({ path: 'C:/kb/notes.md', occurrences: 1, bytes: 512 }))
  deleteFile = vi.fn(async () => ({ path: 'C:/kb/notes.md' }))
  documentAgentRun = vi.fn(async () => ({
    ok: true,
    summary: 'inserted the section',
    edits: [{ tool: 'insert_content', summary: 'inserted 2 blocks' }],
  }))
  documentAgentCancel = vi.fn(async () => true)
  documentAgentDescribe = vi.fn(async () => ({ tabId: 't1', title: 'Report.docx' }))
  agentProgressListener = null
  project = projectApiStub([])
  runs = runsApiStub([])
  ;(window as unknown as { projectApi?: unknown }).projectApi = project.api
  // the tab-strip bridge the desktop loop subscribes to for manifest refreshes
  ;(window as unknown as { aiOfficeTabs?: unknown }).aiOfficeTabs = {
    onChanged: () => () => {},
  }
  ;(window as unknown as { aiOffice: unknown }).aiOffice = {
    skillsList: vi.fn(async () => []),
    skillText: vi.fn(async () => ''),
    aiGetSettings: async () => null,
    aiGskStatus: async () => ({ loggedIn: true }),
    onAiSettingsChanged: () => () => {},
    kbList: async () => CORPUS,
    kbRunCli: runCli,
    // the file write powers: permissive fakes the tool tests spy on
    kbEditFile: editFile,
    kbDeleteFile: deleteFile,
    // the document-agent delegation: the fake bridge the tool tests drive
    documentAgentRun,
    documentAgentCancel,
    documentAgentDescribe,
    onDocumentAgentProgress: (listener: typeof agentProgressListener) => {
      agentProgressListener = listener
      return () => {
        agentProgressListener = null
      }
    },
    // the edit_file card's size line reads the file's page count
    kbRead: vi.fn(async () => ({ text: 'x'.repeat(10), totalChars: 5000, offset: 0 })),
    // the desktop loop's app-skill proxy: nothing open, so no cross-app tools
    appSkillManifest: async () => ({ windows: [], tools: [] }),
    appSkillExecute: vi.fn(async () => {
      throw new Error('nothing is open')
    }),
    appendRunEvent: runs.api.appendRunEvent,
    listRuns: runs.api.listRuns,
    deleteRun: runs.api.deleteRun,
    onAiStream: (listener: ChunkListener) => {
      chunkListener = listener
      return () => {
        chunkListener = null
      }
    },
    aiStream: (request: StartedRequest) => {
      started.push(request)
      queueMicrotask(() => chunkListener?.({ requestId: request.requestId, type: 'done' }))
    },
    aiStreamCancel: () => {},
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete (window as unknown as { aiOffice?: unknown }).aiOffice
  delete (window as unknown as { projectApi?: unknown }).projectApi
  delete (window as unknown as { aiOfficeTabs?: unknown }).aiOfficeTabs
})

function render(): void {
  act(() =>
    root.render(
      createElement(
        LocaleProvider,
        { initial: 'en' },
        createElement(KbAskPanel, {
          onOpenPath: () => {},
          onGoToRecents: () => {},
          onOpenModelSettings: () => {},
          onOpenScopeSettings: () => {},
        }),
      ),
    ),
  )
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (let i = 0; i < 12; i++) await Promise.resolve()
  })
}

function type(text: string): void {
  const ta = host.querySelector('textarea')!
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(ta, text)
    ta.setSelectionRange(text.length, text.length)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function press(key: string): void {
  act(() => {
    host
      .querySelector('textarea')!
      .dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

async function ask(question: string): Promise<void> {
  type(question)
  press('Enter')
  await settle()
}

const click = (selector: string) => {
  const el = host.querySelector(selector)
  expect(el).toBeTruthy()
  act(() => (el as HTMLElement).click())
}

/** the run events that crossed the runs bridge, as (method, args) pairs */
const runEventCalls = (): Array<Record<string, unknown>> =>
  runs.calls.filter((c) => c.method === 'appendRunEvent').map((c) => c.args)

describe('KbAskPanel tool confirmation', () => {
  it('offers risk-marked tools to the model', () => {
    render()
    return settle().then(() => {
      const runGenoffice = started.length === 0 ? null : null // no request yet; the tools ride the first one
      void runGenoffice
      // the corpus gate is open; ask once to see the request's tool table
      return ask('build a file').then(() => {
        const tools = started[0]!.tools
        const risky = tools.filter((t) => t.risk === 'high').map((t) => t.name)
        expect(risky).toContain('run_genoffice')
        expect(risky).toContain('create_document')
      })
    })
  })

  it('shows the allow/deny card and holds the next request until decided', async () => {
    render()
    await settle()
    // turn 1: the model calls the CLI; the run parks at the approval gate
    ;(window as unknown as { aiOffice: { aiStream: unknown } }).aiOffice.aiStream = (
      request: StartedRequest,
    ) => {
      started.push(request)
      const turn = started.length
      queueMicrotask(() => {
        if (turn === 1) {
          chunkListener?.({
            requestId: request.requestId,
            type: 'tool-call',
            toolCall: { id: 't1', name: 'run_genoffice', input: { args: ['guide', 'docs'] } },
          })
        } else {
          chunkListener?.({ requestId: request.requestId, type: 'delta', text: 'ok then' })
        }
        chunkListener?.({ requestId: request.requestId, type: 'done' })
      })
    }

    await ask('build a guide')
    expect(started).toHaveLength(1)
    // the card is in the conversation, awaiting the decision
    expect(host.querySelector('.ai-confirm-card')).toBeTruthy()
    expect(host.querySelector('.ai-confirm-allow')).toBeTruthy()
    // no second request: the loop is parked at the gate

    click('.ai-confirm-deny')
    await settle()
    expect(started).toHaveLength(2)
    // the model received the denial as an error tool result it can act on
    const toolMessage = started[1]!.messages.find((m) => m.role === 'tool')
    expect(toolMessage?.results?.[0]?.output).toBe(TOOL_DENIED_OUTPUT)
    // the settled card stays in the flow as the record of the decision
    expect(host.querySelector('.ai-confirm-card')?.getAttribute('data-outcome')).toBe('denied')
    expect(host.querySelector('.ai-confirm-deny')).toBeNull()
    // the CLI was never spawned
    expect(runCli).not.toHaveBeenCalled()
  })

  it('allowing executes the tool through the host bridge', async () => {
    render()
    await settle()
    ;(window as unknown as { aiOffice: { aiStream: unknown } }).aiOffice.aiStream = (
      request: StartedRequest,
    ) => {
      started.push(request)
      const turn = started.length
      queueMicrotask(() => {
        if (turn === 1) {
          chunkListener?.({
            requestId: request.requestId,
            type: 'tool-call',
            toolCall: { id: 't1', name: 'run_genoffice', input: { args: ['guide', 'docs'] } },
          })
        } else {
          chunkListener?.({ requestId: request.requestId, type: 'delta', text: 'ok then' })
        }
        chunkListener?.({ requestId: request.requestId, type: 'done' })
      })
    }

    await ask('build a guide')
    click('.ai-confirm-allow')
    await settle()
    expect(runCli).toHaveBeenCalledTimes(1)
    // the model round-trip continued: the tool result went back to it
    expect(started).toHaveLength(2)
    const toolMessage = started[1]!.messages.find((m) => m.role === 'tool')
    expect(toolMessage?.results?.[0]?.output).toContain('exit 0')
    expect(host.querySelector('.ai-confirm-card')?.getAttribute('data-outcome')).toBe('allowed')
  })

  it('Stop settles an open confirmation as denied', async () => {
    render()
    await settle()
    ;(window as unknown as { aiOffice: { aiStream: unknown } }).aiOffice.aiStream = (
      request: StartedRequest,
    ) => {
      started.push(request)
      const turn = started.length
      queueMicrotask(() => {
        if (turn === 1) {
          chunkListener?.({
            requestId: request.requestId,
            type: 'tool-call',
            toolCall: { id: 't1', name: 'run_genoffice', input: { args: ['guide', 'docs'] } },
          })
        } else {
          chunkListener?.({ requestId: request.requestId, type: 'delta', text: 'ok then' })
        }
        chunkListener?.({ requestId: request.requestId, type: 'done' })
      })
    }

    await ask('build a guide')
    expect(host.querySelector('.ai-confirm-card')).toBeTruthy()
    // the composer's Stop button while the card is open
    click('.ai-stop-btn')
    await settle()
    // the request settled as denied, the loop freed, no second turn
    expect(host.querySelector('.ai-confirm-card')?.getAttribute('data-outcome')).toBe('denied')
    expect(runCli).not.toHaveBeenCalled()
  })
})

describe('KbAskPanel background tasks', () => {
  it('lists a run while it streams and settles its events when it finishes', async () => {
    render()
    await settle()
    expect(host.querySelector('.kb-ask-tasks')).toBeNull() // nothing to show yet

    await ask('summarize the notes')
    // the run completed within the same settle: the row came and went
    expect(host.querySelector('.kb-ask-task')).toBeNull()
    const events = runEventCalls()
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      projectId: 'default',
      kind: 'start',
      instruction: 'summarize the notes',
      chatId: 'kb-ask',
    })
    expect(events[1]).toMatchObject({ runId: events[0]!.runId, kind: 'finish', outcome: 'done' })
  })

  it('shows the run left unfinished by a closed window as interrupted, and dismissable', async () => {
    runs = runsApiStub([
      {
        runId: 'run-9',
        chatId: 'kb-ask',
        instruction: 'build the deck',
        status: 'interrupted',
        startedAt: '2026-10-29T18:00:00.000Z',
      },
    ])
    ;(window as unknown as { aiOffice: Record<string, unknown> }).aiOffice.appendRunEvent =
      runs.api.appendRunEvent
    ;(window as unknown as { aiOffice: Record<string, unknown> }).aiOffice.listRuns =
      runs.api.listRuns
    ;(window as unknown as { aiOffice: Record<string, unknown> }).aiOffice.deleteRun =
      runs.api.deleteRun
    render()
    await settle()

    const row = host.querySelector('.kb-ask-task[data-status="interrupted"]')
    expect(row).toBeTruthy()
    expect(row?.querySelector('.kb-ask-task-text')?.textContent).toBe('build the deck')

    click('.kb-ask-task[data-status="interrupted"] .kb-ask-task-stop')
    await settle()
    // the dismissal settled the record as discarded and dropped the row
    expect(host.querySelector('.kb-ask-task[data-status="interrupted"]')).toBeNull()
    const discard = runEventCalls().at(-1)
    expect(discard).toMatchObject({
      runId: 'run-9',
      kind: 'finish',
      outcome: 'discarded',
    })
  })

  it('clear all empties the interrupted list through the store', async () => {
    runs = runsApiStub([
      {
        runId: 'run-9',
        instruction: 'first interrupted',
        status: 'interrupted',
        startedAt: '2026-10-29T18:00:00.000Z',
      },
      {
        runId: 'run-8',
        instruction: 'second interrupted',
        status: 'interrupted',
        startedAt: '2026-10-29T17:00:00.000Z',
      },
    ])
    ;(window as unknown as { aiOffice: Record<string, unknown> }).aiOffice.appendRunEvent =
      runs.api.appendRunEvent
    ;(window as unknown as { aiOffice: Record<string, unknown> }).aiOffice.listRuns =
      runs.api.listRuns
    ;(window as unknown as { aiOffice: Record<string, unknown> }).aiOffice.deleteRun =
      runs.api.deleteRun
    render()
    await settle()
    expect(host.querySelectorAll('.kb-ask-task[data-status="interrupted"]')).toHaveLength(2)

    click('.kb-ask-task-clear')
    await settle()
    expect(host.querySelector('.kb-ask-tasks')).toBeNull()
    // the wipe went through the runs API: every stored run deleted by id
    const deleted = runs.calls
      .filter((c) => c.method === 'deleteRun')
      .map((c) => (c.args as { runId: string }).runId)
    expect(deleted.sort()).toEqual(['run-8', 'run-9'])
  })
})

describe("the three-state card and the conversation's session allows", () => {
  /**
   * A stream whose first turn (the user message is the newest one) emits a
   * gated tool call, and whose later turns answer plain text: each new ask
   * therefore parks the card once, exactly like a model that tries the tool
   * again per request.
   */
  function toolCallStream(tool: string, input: Record<string, unknown>): void {
    ;(window as unknown as { aiOffice: { aiStream: unknown } }).aiOffice.aiStream = (
      request: StartedRequest,
    ) => {
      started.push(request)
      queueMicrotask(() => {
        const newest = request.messages[request.messages.length - 1]
        if (newest?.role === 'user') {
          chunkListener?.({
            requestId: request.requestId,
            type: 'tool-call',
            toolCall: { id: 't1', name: tool, input },
          })
        } else {
          chunkListener?.({ requestId: request.requestId, type: 'delta', text: 'ok then' })
        }
        chunkListener?.({ requestId: request.requestId, type: 'done' })
      })
    }
  }

  it('offers the write tools with their risk grades (edit_file high, delete_file always-ask)', async () => {
    render()
    await settle()
    await ask('build a file')
    const tools = started[0]!.tools
    const edit = tools.find((t) => t.name === 'edit_file')
    const del = tools.find((t) => t.name === 'delete_file')
    expect(edit?.risk).toBe('high')
    expect(del?.risk).toBe('always-ask')
    // create_document keeps today's shape
    expect(tools.find((t) => t.name === 'create_document')?.risk).toBe('high')
  })

  it('always-allow settles this call AND later calls of the tool run without a card', async () => {
    toolCallStream('run_genoffice', { args: ['guide', 'docs'] })
    render()
    await settle()
    await ask('build a guide')
    // the card offers all three buttons, always-allow first
    const buttons = [...host.querySelectorAll('.ai-confirm-actions button')].map((b) => b.className)
    expect(buttons).toEqual(['ai-confirm-session', 'ai-confirm-allow', 'ai-confirm-deny'])
    click('.ai-confirm-session')
    await settle()
    expect(runCli).toHaveBeenCalledTimes(1)
    expect(host.querySelector('.ai-confirm-card')?.getAttribute('data-outcome')).toBe('allowed')
    expect(host.querySelector('.ai-confirm-card')?.getAttribute('data-via-session')).toBe('true')
    // the next ask calls the same tool again: the conversation now trusts
    // it, so no card appears (the settled one is cleared with the new run)
    await ask('build it again')
    expect(runCli).toHaveBeenCalledTimes(2)
    expect(host.querySelector('.ai-confirm-card')).toBeNull()
  })

  it('allow-once settles this call only: the next call asks again', async () => {
    toolCallStream('run_genoffice', { args: ['guide', 'docs'] })
    render()
    await settle()
    await ask('build a guide')
    click('.ai-confirm-allow')
    await settle()
    expect(runCli).toHaveBeenCalledTimes(1)
    // a fresh ask stops at a fresh card — once is once
    await ask('build it again')
    expect(host.querySelector('.ai-confirm-card')?.getAttribute('data-outcome')).toBe('awaiting')
    expect(host.querySelector('.ai-confirm-card')?.getAttribute('data-via-session')).toBeNull()
    expect(host.querySelector('.ai-confirm-session')).toBeTruthy()
    click('.ai-confirm-deny')
    await settle()
    expect(runCli).toHaveBeenCalledTimes(1)
  })

  it('a destructive always-ask tool never offers always-allow', async () => {
    toolCallStream('delete_file', { path: 'C:/kb/notes.md' })
    render()
    await settle()
    await ask('build a guide')
    expect(host.querySelector('.ai-confirm-session')).toBeNull()
    expect(host.querySelector('.ai-confirm-allow')).toBeTruthy()
    // denying feeds the model the do-not-try result; nothing was deleted
    click('.ai-confirm-deny')
    await settle()
    expect(deleteFile).not.toHaveBeenCalled()
    const toolMessage = started[1]!.messages.find((m) => m.role === 'tool')
    expect(toolMessage?.results?.[0]?.output).toBe(TOOL_DENIED_OUTPUT)
  })

  it('session allows are per tool: a different gated tool still asks', async () => {
    toolCallStream('run_genoffice', { args: ['guide', 'docs'] })
    render()
    await settle()
    await ask('build a guide')
    click('.ai-confirm-session')
    await settle()
    // a new run calls a different high-risk tool
    toolCallStream('create_document', { title: 'Report', format: 'md', content: 'x' })
    await ask('build another guide')
    expect(host.querySelector('.ai-confirm-card')?.getAttribute('data-outcome')).toBe('awaiting')
    expect(host.querySelector('.ai-confirm-session')).toBeTruthy()
    click('.ai-confirm-deny')
    await settle()
  })

  it('a new thread starts with the card asking again (the session set dies with the conversation)', async () => {
    // one stored thread, so the chips row (and its + button) renders
    project.chats.set('kb-ask', [
      { seq: 0, ts: '2026-10-30T09:00:00.000Z', role: 'user', text: 'first question' },
    ])
    toolCallStream('run_genoffice', { args: ['guide', 'docs'] })
    render()
    await settle()
    await ask('build a guide')
    click('.ai-confirm-session')
    await settle()
    // same conversation: the next ask runs the tool with no card
    await ask('build it again')
    expect(runCli).toHaveBeenCalledTimes(2)
    // a new thread: fresh trust, the card asks again
    click('.kb-ask-thread-new')
    await settle()
    await ask('build a third guide')
    expect(host.querySelector('.ai-confirm-card')?.getAttribute('data-outcome')).toBe('awaiting')
    expect(host.querySelector('.ai-confirm-session')).toBeTruthy()
    click('.ai-confirm-deny')
    await settle()
    expect(runCli).toHaveBeenCalledTimes(2)
  })

  it('delegates a document task: one card, the live status line, the result back to the model', async () => {
    toolCallStream('document_agent', { task: 'add a summary section' })
    render()
    await settle()
    await ask('build a guide')
    // the tool is risk:'high': one confirm card per delegated task, its
    // arguments preview carrying the task text
    expect(host.querySelector('.ai-confirm-args pre')?.textContent).toContain(
      'add a summary section',
    )
    // the card names the target document (the card-time describe, MED-5)
    expect(host.querySelector('.ai-confirm-args-summary')?.textContent).toContain(
      'works in "Report.docx"',
    )
    // hold the task so the status line can be watched mid-flight
    let release!: (result: { ok: boolean; summary: string; edits?: unknown[] }) => void
    documentAgentRun.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    click('.ai-confirm-allow')
    await settle()
    // the run carried the card-time pin (a tab switch would have refused)
    expect(documentAgentRun).toHaveBeenCalledWith('add a summary section', 't1')
    // the line is live from the moment the task starts (the delegation itself
    // is activity), with the generic verb until the first status streams in
    expect(host.querySelector('.kb-ask-subagent')?.textContent).toContain('Working')
    // the sub-agent's first status streams in: the rolling line shows it
    agentProgressListener?.({
      taskId: 'agent-1',
      status: { kind: 'inserting', tool: 'insert_content' },
    })
    await settle()
    const line = host.querySelector('.kb-ask-subagent')
    expect(line?.textContent).toContain('Document assistant')
    expect(line?.textContent).toContain('Inserting content')
    // the line ROLLS with the next status
    agentProgressListener?.({ taskId: 'agent-1', status: { kind: 'writing' } })
    await settle()
    expect(host.querySelector('.kb-ask-subagent')?.textContent).toContain('Writing a draft')
    // the final result ends the line and feeds the model the sub-agent's summary
    release({
      ok: true,
      summary: 'inserted the section',
      edits: [{ tool: 'insert_content', summary: 'inserted 2 blocks' }],
    })
    await settle()
    expect(host.querySelector('.kb-ask-subagent')).toBeNull()
    const toolMessage = started[1]!.messages.find((m) => m.role === 'tool')
    expect(toolMessage?.results?.[0]?.output).toContain('inserted the section')
    // the transcript chip records that the assistant ran
    expect(host.querySelector('.kb-ask-tool-note')?.textContent).toContain(
      'Ran the document assistant',
    )
  })

  it('a refused task (busy, no document) is the model-facing error result', async () => {
    toolCallStream('document_agent', { task: 'add a summary section' })
    documentAgentRun.mockRejectedValueOnce(
      new Error('the document assistant is already working in this document — wait for it'),
    )
    render()
    await settle()
    await ask('build a guide')
    click('.ai-confirm-allow')
    await settle()
    const toolMessage = started[1]!.messages.find((m) => m.role === 'tool')
    expect(toolMessage?.results?.[0]?.output).toContain('already working in this document')
    // no status line was ever shown: the task never ran
    expect(host.querySelector('.kb-ask-subagent')).toBeNull()
  })

  it('a describe failure names the routing problem on the card before the person allows', async () => {
    documentAgentDescribe.mockResolvedValueOnce({
      error: 'no Word document is open — open one first',
    })
    toolCallStream('document_agent', { task: 'add a summary section' })
    render()
    await settle()
    await ask('build a guide')
    expect(host.querySelector('.ai-confirm-args-summary')?.textContent).toContain(
      'no document is targeted',
    )
    // denying is the honest outcome; nothing ran
    click('.ai-confirm-deny')
    await settle()
    expect(documentAgentRun).not.toHaveBeenCalled()
  })

  it('the edit_file card shows the size of what the patch removes (HIGH-2)', async () => {
    toolCallStream('edit_file', {
      path: 'C:/kb/notes.md',
      old_string: 'x'.repeat(1200),
      new_string: 'y'.repeat(300),
    })
    render()
    await settle()
    await ask('build a guide')
    const summary = host.querySelector('.ai-confirm-args-summary')?.textContent
    // the raw arguments preview truncates at 400 chars — the sizes ride their
    // own line, with the file's current size from the read
    expect(summary).toContain('removes 900 characters')
    expect(summary).toContain('adds 0 characters')
    expect(summary).toContain('file: 5000 characters')
    click('.ai-confirm-deny')
    await settle()
    expect(editFile).not.toHaveBeenCalled()
  })

  it('the two mounts keep separate session allows (each conversation its own trust)', async () => {
    // a broadcast stub: both panels' listeners receive every chunk, and the
    // transport drops the ones whose requestId is not its own run's
    const listeners = new Set<ChunkListener>()
    ;(window as unknown as { aiOffice: Record<string, unknown> }).aiOffice.onAiStream = (
      listener: ChunkListener,
    ) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
    ;(window as unknown as { aiOffice: { aiStream: unknown } }).aiOffice.aiStream = (
      request: StartedRequest,
    ) => {
      started.push(request)
      queueMicrotask(() => {
        const newest = request.messages[request.messages.length - 1]
        if (newest?.role === 'user') {
          const toolCall = { id: 't1', name: 'run_genoffice', input: { args: ['guide', 'docs'] } }
          for (const l of listeners)
            l({ requestId: request.requestId, type: 'tool-call', toolCall })
        } else {
          for (const l of listeners) l({ requestId: request.requestId, type: 'delta', text: 'ok' })
        }
        for (const l of listeners) l({ requestId: request.requestId, type: 'done' })
      })
    }

    // mount the two conversations the way the shell does: Home's own id and
    // the doc-mode overlay's fixed one
    const hosts: HTMLDivElement[] = []
    const roots: Root[] = []
    const mount = (chatId: string): void => {
      const panelHost = document.createElement('div')
      document.body.append(panelHost)
      hosts.push(panelHost)
      const panelRoot = createRoot(panelHost)
      roots.push(panelRoot)
      act(() =>
        panelRoot.render(
          createElement(
            LocaleProvider,
            { initial: 'en' },
            createElement(KbAskPanel, {
              chatId,
              onOpenPath: () => {},
              onGoToRecents: () => {},
              onOpenModelSettings: () => {},
              onOpenScopeSettings: () => {},
            }),
          ),
        ),
      )
    }
    mount('home-ask-chat')
    mount('overlay-ask-chat')
    try {
      await settle()
      const askIn = async (index: number, question: string): Promise<void> => {
        const panelHost = hosts[index]!
        const ta = panelHost.querySelector('textarea')!
        act(() => {
          const setter = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            'value',
          )!.set!
          setter.call(ta, question)
          ta.setSelectionRange(question.length, question.length)
          ta.dispatchEvent(new Event('input', { bubbles: true }))
        })
        act(() => {
          ta.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
          )
        })
        await settle()
      }
      const clickIn = (index: number, selector: string): void => {
        const el = hosts[index]!.querySelector(selector)
        expect(el, `panel ${index} ${selector}`).toBeTruthy()
        act(() => (el as HTMLElement).click())
      }

      // Home's conversation always-allows the tool…
      await askIn(0, 'build a guide')
      clickIn(0, '.ai-confirm-session')
      await settle()
      // …so its next call runs with no card
      await askIn(0, 'build the second')
      expect(hosts[0]!.querySelector('.ai-confirm-card[data-outcome="awaiting"]')).toBeNull()

      // the overlay's conversation was watching the same bridge, same tool —
      // and still asks: its trust set is its own
      await askIn(1, 'build a file')
      expect(hosts[1]!.querySelector('.ai-confirm-card[data-outcome="awaiting"]')).toBeTruthy()
      expect(hosts[1]!.querySelector('.ai-confirm-session')).toBeTruthy()
      clickIn(1, '.ai-confirm-deny')
      await settle()
    } finally {
      for (const r of roots) act(() => r.unmount())
      for (const h of hosts) h.remove()
    }
  })
})
