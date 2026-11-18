// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentToolCall } from '@genoffice/agent-core'
import type { ChatMessage, ProjectApi } from '@genoffice/project-store'
import { KbAskPanel } from '../src/renderer/src/KbAskPanel'
import { LocaleProvider } from '../src/renderer/src/locale'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CORPUS = [
  { path: 'C:/kb/notes.md', folder: 'kb', name: 'notes.md', ext: 'md', sizeBytes: 512 },
]
const HIT = { ...CORPUS[0]!, snippet: 'selected text' }

type Chunk = {
  requestId: string
  type: string
  text?: string
  toolCall?: AgentToolCall
}
type Listener = (chunk: Chunk) => void

let host: HTMLDivElement
let root: Root
let listener: Listener | null
let mirrorListener: ((event: { type: string; payload: unknown }) => void) | null
let started: string[]
let frames: Array<() => void>
let search: () => Promise<unknown>
let snapshot: unknown

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {}
})

beforeEach(() => {
  listener = null
  mirrorListener = null
  started = []
  frames = []
  snapshot = null
  search = async () => [HIT]
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    frames.push(cb)
    return frames.length
  })
  const project = {
    resolveChat: async () => ({ projectId: 'default', chatId: 'kb-ask' }),
    loadChat: async () => [] as ChatMessage[],
    appendChat: async () => {},
    deleteChat: async () => {},
    listChats: async () => [],
  } as unknown as ProjectApi
  ;(window as unknown as { projectApi?: unknown }).projectApi = project
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
    kbSearch: () => search(),
    onAiStream: (next: Listener) => {
      listener = next
      return () => {
        if (listener === next) listener = null
      }
    },
    aiStream: (request: { requestId: string }) => {
      started.push(request.requestId)
    },
    aiStreamCancel: () => {},
    askRunSnapshot: async () => snapshot,
    onAskRunEvent: (next: typeof mirrorListener) => {
      mirrorListener = next
      return () => {
        mirrorListener = null
      }
    },
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  delete (window as unknown as { aiOffice?: unknown }).aiOffice
  delete (window as unknown as { projectApi?: unknown }).projectApi
  delete (window as unknown as { aiOfficeTabs?: unknown }).aiOfficeTabs
})

function render(mirror = false): void {
  act(() =>
    root.render(
      createElement(
        LocaleProvider,
        { initial: 'en' },
        createElement(KbAskPanel, {
          mirror,
          pendingQuery: mirror ? null : { text: 'inspect the notes', seq: 1, origin: 'palette' },
          onOpenPath: () => {},
          onGoToRecents: () => {},
          onOpenModelSettings: () => {},
          onOpenScopeSettings: () => {},
        }),
      ),
    ),
  )
}

async function settle(times = 12): Promise<void> {
  await act(async () => {
    for (let i = 0; i < times; i++) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function chunk(type: string, over: Partial<Chunk> = {}): void {
  act(() => {
    listener?.({ requestId: started[started.length - 1]!, type, ...over })
  })
}

function pump(): void {
  act(() => {
    for (const frame of frames.splice(0)) frame()
  })
}

function activity(): HTMLDetailsElement {
  const el = host.querySelector<HTMLDetailsElement>('details.kb-ask-activity')
  expect(el).toBeTruthy()
  return el!
}

describe('KbAskPanel tool activity', () => {
  it('renders reasoning and a successful tool call with collapsed input/output details', async () => {
    let resolveSearch!: (hits: unknown[]) => void
    search = () =>
      new Promise((resolve) => {
        resolveSearch = resolve
      })
    render()
    await settle()
    expect(started).toHaveLength(1)

    chunk('reasoning', { text: 'Search first, then answer.' })
    pump()
    expect(host.querySelector('.kb-ask-thinking-text')?.textContent).toBe(
      'Search first, then answer.',
    )

    const call: AgentToolCall = {
      id: 'call-success',
      name: 'search_knowledge_base',
      input: { query: 'selected', limit: 1 },
    }
    chunk('tool-call', { toolCall: call })
    chunk('done')
    await settle(3)
    pump()
    expect(activity().classList.contains('kb-ask-activity-running')).toBe(true)
    expect(activity().open).toBe(false)

    resolveSearch([HIT])
    await settle()
    expect(started).toHaveLength(2)
    expect(activity().classList.contains('kb-ask-activity-done')).toBe(true)
    expect(activity().textContent).toContain('notes.md')

    act(() => activity().querySelector('summary')!.click())
    expect(activity().open).toBe(true)
    expect(activity().textContent).toContain('"query": "selected"')
    expect(activity().textContent).toContain('selected text')

    chunk('delta', { text: 'The note is selected.' })
    chunk('done')
    await settle()
    expect(host.textContent).toContain('The note is selected.')
  })

  it('marks a failed tool without turning it into a successful result', async () => {
    search = async () => {
      throw new Error('index unavailable')
    }
    render()
    await settle()
    chunk('tool-call', {
      toolCall: {
        id: 'call-failure',
        name: 'search_knowledge_base',
        input: { query: 'anything' },
      },
    })
    chunk('done')
    await settle()
    expect(activity().classList.contains('kb-ask-activity-error')).toBe(true)
    expect(activity().textContent).toContain('Failed')
    act(() => activity().querySelector('summary')!.click())
    expect(activity().textContent).toContain('index unavailable')
  })

  it('restores a mirror from its snapshot and applies the later completion event', async () => {
    const call: AgentToolCall = {
      id: 'mirror-call',
      name: 'search_knowledge_base',
      input: { query: 'mirror' },
    }
    snapshot = {
      messages: [
        { role: 'user', text: 'mirror question', toolNotes: [], artifacts: [] },
        {
          role: 'assistant',
          text: '',
          reasoning: 'Mirror reasoning',
          toolNotes: [],
          activities: [
            {
              id: call.id,
              name: call.name,
              call,
              status: 'running',
              inputPreview: JSON.stringify(call.input, null, 2),
              detail: 'mirror query',
            },
          ],
          artifacts: [],
          streaming: true,
        },
      ],
      liveRun: { text: '', reasoning: 'Mirror reasoning', busy: true },
    }
    render(true)
    await settle()
    expect(started).toHaveLength(0)
    expect(activity().classList.contains('kb-ask-activity-running')).toBe(true)
    expect(host.querySelector('.kb-ask-thinking-text')?.textContent).toBe('Mirror reasoning')

    act(() => {
      mirrorListener?.({
        type: 'tool-executed',
        payload: { call, execution: { output: 'mirror result', summary: call.name } },
      })
    })
    expect(activity().classList.contains('kb-ask-activity-done')).toBe(true)
    act(() => activity().querySelector('summary')!.click())
    expect(activity().textContent).toContain('mirror result')
    expect(started).toHaveLength(0)
  })
})
