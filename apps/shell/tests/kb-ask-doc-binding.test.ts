// @vitest-environment jsdom
/**
 * The doc-bound panel (KbAskPanel + the lineage/suggestion integration): the
 * conversation IS the active document's thread. These tests drive the real
 * panel mount — the surface-tabs bridge decides which document is bound, the
 * project-store stub resolves identity by file path (the editors' own seam),
 * and the lineage channels answer the continuity seed. Pins: identity per
 * path, switching on tab change, history reload, the seed's presence and its
 * first-question ride, the suggestion cards and their park-on-click, the
 * footer copy per thread kind, and the create_document lineage record.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { KbAskPanel } from '../src/renderer/src/KbAskPanel'
import { LocaleProvider } from '../src/renderer/src/locale'
import type { SurfaceTab } from '@genoffice/agent-core'
import type { ProjectApi } from '@genoffice/project-store'
import type { ChatMessage } from '@genoffice/project-store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface StartedRequest {
  requestId: string
  system: string
  messages: Array<{ role: string; text?: string }>
}

type ChunkListener = (chunk: { requestId: string; type: string }) => void

const CORPUS = [
  { path: 'C:/kb/notes.md', folder: 'kb', name: 'notes.md', ext: 'md', sizeBytes: 512 },
]

const DOC_TAB = (path: string, title = 'Report.docx'): SurfaceTab => ({
  id: 't1',
  kind: 'docs',
  title,
  active: true,
  filePath: path,
})
const HOME_TAB: SurfaceTab = { id: 'home', kind: 'home', title: 'Home', active: true }
const BROWSER_TAB: SurfaceTab = {
  id: 't2',
  kind: 'browser',
  title: 'Example',
  active: true,
  url: 'https://example.com/',
}

/** the doc-bound thread's stable id (the store's chatIdForFile seam: path-keyed) */
const chatIdForPath = (path: string): string => `chat-${path.replace(/[^a-z0-9]/gi, '')}`

let host: HTMLDivElement
let root: Root
let started: StartedRequest[]
let chunkListener: ChunkListener | null
let surfaceTabs: readonly SurfaceTab[] | null
let surfaceListener: (() => void) | null
/** the lineage answers the get channel gives, keyed by path */
let lineageByPath: Record<string, { path: string; task: string; summary: string; at: string }>
let lineageRecords: Array<{ path: string; task: string; summary?: string }>
let projectApi: ProjectApi
/** the chats the store stub holds, keyed by chatId */
let chats: Map<string, ChatMessage[]>
let projectCalls: Array<{ method: string; args: Record<string, unknown> }>

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {}
})

beforeEach(() => {
  started = []
  chunkListener = null
  surfaceTabs = null
  surfaceListener = null
  lineageByPath = {}
  lineageRecords = []
  chats = new Map()
  projectCalls = []
  projectApi = {
    resolveChat: async (args: { filePath: string | null; tempChatId?: string }) => {
      projectCalls.push({ method: 'resolveChat', args: args as Record<string, unknown> })
      if (args.filePath !== null) {
        return { projectId: 'default', chatId: chatIdForPath(args.filePath) }
      }
      return { projectId: 'default', chatId: args.tempChatId ?? 'kb-ask' }
    },
    loadChat: async (args: { chatId: string }) => {
      projectCalls.push({ method: 'loadChat', args: args as Record<string, unknown> })
      return [...(chats.get(args.chatId) ?? [])]
    },
    appendChat: async (args: { chatId: string; role: 'user' | 'assistant'; text: string }) => {
      projectCalls.push({ method: 'appendChat', args: args as Record<string, unknown> })
      const list = chats.get(args.chatId) ?? []
      list.push({
        seq: list.length,
        ts: '2026-11-03T09:00:00.000Z',
        role: args.role,
        text: args.text,
      })
      chats.set(args.chatId, list)
    },
    deleteChat: async () => undefined,
    listChats: async () =>
      [...chats.entries()].map(([chatId, list]) => ({
        chatId,
        firstQuestion: list.find((m) => m.role === 'user')?.text ?? '',
        updatedAt: '2026-11-03T09:00:00.000Z',
        approxCount: list.length,
      })),
  } as unknown as ProjectApi
  ;(window as unknown as { projectApi?: unknown }).projectApi = projectApi
  ;(window as unknown as { aiOfficeTabs?: unknown }).aiOfficeTabs = {
    list: async () => [...(surfaceTabs ?? [])],
    onChanged: (handler: () => void) => {
      surfaceListener = handler
      return () => {
        surfaceListener = null
      }
    },
  }
  ;(window as unknown as { aiOffice: unknown }).aiOffice = {
    skillsList: vi.fn(async () => []),
    skillText: vi.fn(async () => ''),
    aiGetSettings: async () => null,
    aiGskStatus: async () => ({ loggedIn: true }),
    onAiSettingsChanged: () => () => {},
    kbList: async () => CORPUS,
    getSurfaceTabs: async () => surfaceTabs,
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
    aiLineageGet: vi.fn(async (path: string) => lineageByPath[path] ?? null),
    aiLineageRecord: vi.fn(async (entry: { path: string; task: string; summary?: string }) => {
      lineageRecords.push(entry)
    }),
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
          ...(host.dataset.chat ? { chatId: host.dataset.chat } : {}),
        }),
      ),
    ),
  )
}

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
    for (let i = 0; i < 12; i++) await Promise.resolve()
  })
}

const type = (text: string): void => {
  const ta = host.querySelector('textarea')!
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(ta, text)
    ta.setSelectionRange(text.length, text.length)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const ask = async (question: string): Promise<void> => {
  type(question)
  act(() => {
    host
      .querySelector('textarea')!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
  })
  await settle()
}

/** switch the active surface tab and push the tabs-changed signal */
const switchTab = async (tabs: readonly SurfaceTab[]): Promise<void> => {
  surfaceTabs = tabs
  await act(async () => {
    surfaceListener?.()
    for (let i = 0; i < 12; i++) await Promise.resolve()
  })
  await settle()
}

const threadChips = (): string[] =>
  [...host.querySelectorAll('.kb-ask-thread-chip')].map(
    (el) => (el as HTMLElement).dataset.chat,
  ) as string[]

describe('the doc-bound thread identity', () => {
  it("a docs tab with a file binds the panel to that document's thread", async () => {
    const id = chatIdForPath('/desk/Q3 Report.docx')
    chats.set(id, [{ seq: 0, ts: '2026-11-03T09:00:00.000Z', role: 'user', text: 'a stored turn' }])
    surfaceTabs = [DOC_TAB('/desk/Q3 Report.docx')]
    render()
    await settle()
    // resolveChat went by FILE PATH — the editors' own seam, the same thread
    // the doc's suppressed panel used — not the mount's family root
    const resolves = projectCalls.filter((c) => c.method === 'resolveChat')
    expect(resolves.some((c) => c.args.filePath === '/desk/Q3 Report.docx')).toBe(true)
    // the thread family listed is the document's own chatId, not kb-ask
    expect(threadChips()).toContain(chatIdForPath('/desk/Q3 Report.docx'))
  })

  it("history reloads: turns already in the document's thread show on open", async () => {
    const id = chatIdForPath('/desk/Q3 Report.docx')
    chats.set(id, [
      { seq: 0, ts: '2026-11-03T09:00:00.000Z', role: 'user', text: 'summarize the sales table' },
      { seq: 1, ts: '2026-11-03T09:00:01.000Z', role: 'assistant', text: 'the sales table shows…' },
    ])
    surfaceTabs = [DOC_TAB('/desk/Q3 Report.docx')]
    render()
    await settle()
    const text = host.querySelector('.kb-ask-thread')?.textContent ?? ''
    expect(text).toContain('summarize the sales table')
    expect(text).toContain('the sales table shows…')
  })

  it('a tab switch switches the thread: the old turns leave, the new thread claims', async () => {
    const first = chatIdForPath('/desk/a.docx')
    const second = chatIdForPath('/desk/b.docx')
    chats.set(first, [
      { seq: 0, ts: '2026-11-03T09:00:00.000Z', role: 'user', text: 'question for a' },
    ])
    chats.set(second, [
      { seq: 0, ts: '2026-11-03T09:00:00.000Z', role: 'user', text: 'question for b' },
    ])
    surfaceTabs = [DOC_TAB('/desk/a.docx')]
    render()
    await settle()
    expect(host.querySelector('.kb-ask-thread')?.textContent).toContain('question for a')
    // the person switches to the other document
    await switchTab([DOC_TAB('/desk/b.docx')])
    const text = host.querySelector('.kb-ask-thread')?.textContent ?? ''
    expect(text).toContain('question for b')
    expect(text).not.toContain('question for a')
    // and back: the first thread's turns are still there (persisted ids)
    await switchTab([DOC_TAB('/desk/a.docx')])
    expect(host.querySelector('.kb-ask-thread')?.textContent).toContain('question for a')
  })

  it('leaving the docs tab returns the panel to its family root', async () => {
    surfaceTabs = [DOC_TAB('/desk/a.docx')]
    render()
    await settle()
    // a browser tab (or Home) is not a document: the mount's own root again
    await switchTab([BROWSER_TAB])
    const resolves = projectCalls.filter((c) => c.method === 'resolveChat')
    expect(resolves.at(-1)!.args).toEqual({ filePath: null, tempChatId: 'kb-ask' })
  })

  it('two documents never cross-list: the family filter stays per-root', async () => {
    const a = chatIdForPath('/desk/a.docx')
    const b = chatIdForPath('/desk/b.docx')
    chats.set(a, [{ seq: 0, ts: '2026-11-03T09:00:00.000Z', role: 'user', text: 'for a' }])
    chats.set(b, [{ seq: 0, ts: '2026-11-03T09:00:00.000Z', role: 'user', text: 'for b' }])
    surfaceTabs = [DOC_TAB('/desk/a.docx'), { ...DOC_TAB('/desk/b.docx'), active: false }]
    render()
    await settle()
    expect(threadChips()).toEqual([a])
  })
})

describe('the continuity seed', () => {
  const PATH = '/desk/generated.docx'
  const lineage = {
    path: PATH,
    task: 'write a quarterly report',
    summary: 'created a report with three sections',
    at: '2026-11-02T09:00:00.000Z',
  }

  it('an empty doc-bound thread with lineage seeds the first question', async () => {
    lineageByPath[PATH] = lineage
    surfaceTabs = [DOC_TAB(PATH)]
    render()
    await settle()
    await ask('你刚才做了什么')
    // the seed rode the FIRST question (the scaffold precedent: visible in
    // the transcript, stored with it) — the model's user message opens with
    // the lineage line, then the person's question
    const first = started[0]!.messages.find((m) => m.role === 'user')!
    expect(first.text).toContain('Document lineage — this document came from the task')
    expect(first.text).toContain('write a quarterly report')
    expect(first.text).toContain('Outcome: created a report with three sections')
    expect(first.text).toContain('你刚才做了什么')
    // only the first ask: the thread now has turns, the seed does not repeat
    await ask('and now?')
    const second = started[1]!.messages.filter((m) => m.role === 'user')
    expect(second.at(-1)!.text).not.toContain('Document lineage')
  })

  it("no lineage, no seed: the question is the person's alone", async () => {
    surfaceTabs = [DOC_TAB(PATH)]
    render()
    await settle()
    await ask('plain question')
    const first = started[0]!.messages.find((m) => m.role === 'user')!
    expect(first.text).not.toContain('Document lineage')
  })

  it('the visible marker names the task in the empty state', async () => {
    lineageByPath[PATH] = lineage
    surfaceTabs = [DOC_TAB(PATH)]
    render()
    await settle()
    const marker = host.querySelector('.kb-ask-doc-lineage')
    expect(marker).toBeTruthy()
    expect(marker!.textContent).toContain('write a quarterly report')
  })
})

describe('the first-open suggestions', () => {
  it("the doc-bound empty state renders the engine's cards, and a click parks the prompt", async () => {
    surfaceTabs = [DOC_TAB('/desk/Handbook.docx', 'Handbook')]
    render()
    await settle()
    const cards = [...host.querySelectorAll('.kb-ask-suggestion')] as HTMLButtonElement[]
    expect(cards.length).toBeGreaterThan(0)
    // a word document without lineage: the prose trio's keys
    expect(cards.map((c) => c.dataset.key)).toContain('polish')
    // the park: the composer holds the localized prompt, nothing sends
    cards.find((c) => c.dataset.key === 'polish')!.click()
    await act(async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve()
    })
    const draft = host.querySelector<HTMLTextAreaElement>('.kb-ask textarea')?.value ?? ''
    expect(draft).toContain('Polish the wording')
    expect(started).toHaveLength(0)
  })

  it('a lineage document ranks the continuation verbs first', async () => {
    lineageByPath['/desk/gen.docx'] = {
      path: '/desk/gen.docx',
      task: 'write it',
      summary: '',
      at: '2026-11-02T09:00:00.000Z',
    }
    surfaceTabs = [DOC_TAB('/desk/gen.docx')]
    render()
    await settle()
    const keys = ([...host.querySelectorAll('.kb-ask-suggestion')] as HTMLButtonElement[]).map(
      (c) => c.dataset.key,
    )
    expect(keys[0]).toBe('continue-writing')
    expect(keys[1]).toBe('expand')
  })

  it('no doc, no cards: the panel family keeps its own empty state', async () => {
    surfaceTabs = [HOME_TAB]
    render()
    await settle()
    expect(host.querySelector('.kb-ask-suggestion')).toBeNull()
  })
})

describe('the footer copy per thread kind', () => {
  it('doc-bound says saved-with-the-document; the family root says the panel copy', async () => {
    const id = chatIdForPath('/desk/a.docx')
    chats.set(id, [
      { seq: 0, ts: '2026-11-03T09:00:00.000Z', role: 'user', text: 'a turn, so the footer shows' },
    ])
    chats.set('kb-ask', [
      { seq: 0, ts: '2026-11-03T09:00:00.000Z', role: 'user', text: 'a family turn' },
    ])
    surfaceTabs = [DOC_TAB('/desk/a.docx')]
    render()
    await settle()
    const docFooter = host.querySelector('.kb-ask-nosave')
    expect(docFooter).toBeTruthy()
    expect(docFooter!.getAttribute('data-kind')).toBe('doc')
    expect(docFooter!.textContent).toContain('saved with the document')
    // back to the family root: the panel copy
    await switchTab([HOME_TAB])
    const panelFooter = host.querySelector('.kb-ask-nosave')
    expect(panelFooter!.getAttribute('data-kind')).toBe('panel')
    expect(panelFooter!.textContent).toContain('saved on this device')
  })
})

describe('the create_document lineage record', () => {
  it("a successful create writes path + task + the answer's first line", async () => {
    surfaceTabs = [HOME_TAB]
    render()
    await settle()
    // one turn whose only tool call creates a document and whose answer
    // settles; the panel's finishLast is the record point. The LOOP executes
    // the skill renderer-side (kbCreateDocument answers the path), so the
    // run is two stream turns: the tool call, then the settling answer
    ;(window as unknown as { aiOffice: Record<string, unknown> }).aiOffice.kbCreateDocument = vi.fn(
      async () => ({ path: '/desk/Report.docx' }),
    )
    ;(window as unknown as { aiOffice: { aiStream: unknown } }).aiOffice.aiStream = (
      request: StartedRequest,
    ) => {
      started.push(request)
      queueMicrotask(() => {
        if (started.length === 1) {
          chunkListener?.({
            requestId: request.requestId,
            type: 'tool-call',
            toolCall: {
              id: 't1',
              name: 'create_document',
              input: { title: 'Report', format: 'docx', content: 'the content' },
            },
          })
          chunkListener?.({ requestId: request.requestId, type: 'done' })
          return
        }
        chunkListener?.({
          requestId: request.requestId,
          type: 'delta',
          text: 'I created the report with three sections.',
        })
        chunkListener?.({ requestId: request.requestId, type: 'done' })
      })
    }
    await ask('make me a report')
    // create_document is risk:'high': the card asks, the person allows
    const allow = host.querySelector('.ai-confirm-allow') as HTMLButtonElement
    expect(allow, 'the create card shows').toBeTruthy()
    act(() => allow.click())
    await settle()
    expect(lineageRecords).toHaveLength(1)
    expect(lineageRecords[0]).toEqual({
      path: '/desk/Report.docx',
      task: 'make me a report',
      summary: 'I created the report with three sections.',
    })
  })
})
