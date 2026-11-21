// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentToolCall } from '@genoffice/agent-core'
import { applyAiPanelPrefs, DEFAULT_AI_PANEL_PREFS } from '@genoffice/ui'
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
  applyAiPanelPrefs(DEFAULT_AI_PANEL_PREFS)
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

  it('interleaves multi-turn ReAct steps chronologically, auto-collapses sealed thinking, and respects manual toggle', async () => {
    let resolveSearch!: (hits: unknown[]) => void
    search = () =>
      new Promise((resolve) => {
        resolveSearch = resolve
      })
    render()
    await settle()
    expect(started).toHaveLength(1)

    // Round 1: thinking starts open while streaming.
    chunk('reasoning', { text: 'First plan: search notes for metrics.' })
    pump()
    const think1 = host.querySelectorAll<HTMLDetailsElement>('details.kb-ask-thinking')[0]!
    expect(think1).toBeTruthy()
    expect(think1.open).toBe(true)

    // Entering tool 1 seals thinking 1 (auto-collapse + preview line).
    chunk('tool-call', {
      toolCall: { id: 'react-c1', name: 'search_knowledge_base', input: { query: 'metrics' } },
    })
    chunk('done')
    await settle(3)
    pump()
    expect(think1.open).toBe(false)
    expect(think1.querySelector('.kb-ask-thinking-preview')?.textContent).toContain('First plan:')

    // Manual expand on thinking 1 must survive subsequent streaming events.
    act(() => think1.querySelector('summary')!.click())
    expect(think1.open).toBe(true)

    resolveSearch([HIT])
    await settle()
    expect(started).toHaveLength(2)

    // Round 2: new thinking block opens cleanly after tool 1.
    chunk('reasoning', { text: 'Second plan: inspect related summary.' })
    pump()
    const thinksAfterR2 = host.querySelectorAll<HTMLDetailsElement>('details.kb-ask-thinking')
    expect(thinksAfterR2).toHaveLength(2)
    expect(thinksAfterR2[0]!.open).toBe(true)
    expect(thinksAfterR2[1]!.open).toBe(true)

    chunk('tool-call', {
      toolCall: { id: 'react-c2', name: 'search_knowledge_base', input: { query: 'summary' } },
    })
    chunk('done')
    await settle(3)
    pump()
    expect(thinksAfterR2[0]!.open).toBe(true)
    expect(thinksAfterR2[1]!.open).toBe(false)

    resolveSearch([HIT])
    await settle()
    expect(started).toHaveLength(3)

    // Final answer text appears last, keeping full chronological order in DOM.
    chunk('delta', { text: 'Final synthesis from two lookups.' })
    chunk('done')
    await settle()

    const timeline = host.querySelector('.kb-ask-timeline')!
    expect(timeline).toBeTruthy()
    const order = [...timeline.children].map((el) => {
      if (el.classList.contains('kb-ask-thinking')) return 'thinking'
      if (el.classList.contains('kb-ask-activity')) return 'tool'
      if (el.classList.contains('kb-ask-step-note')) return 'note'
      if (el.classList.contains('kb-ask-step-answer')) return 'answer'
      return 'other'
    })
    expect(order).toEqual(['thinking', 'tool', 'thinking', 'tool', 'answer'])
    expect(
      Boolean(think1.compareDocumentPosition(activity()) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true)
    expect(thinksAfterR2[0]!.open).toBe(true)
    expect(thinksAfterR2[1]!.open).toBe(false)
  })

  it('restores structured timeline snapshots with intermediate notes and respects visibility prefs', async () => {
    const c1: AgentToolCall = {
      id: 'snap-c1',
      name: 'search_knowledge_base',
      input: { query: 'alpha' },
    }
    const c2: AgentToolCall = {
      id: 'snap-c2',
      name: 'search_knowledge_base',
      input: { query: 'beta' },
    }
    snapshot = {
      messages: [
        { role: 'user', text: 'check timeline', toolNotes: [], artifacts: [] },
        {
          role: 'assistant',
          text: 'Inspecting beta next.',
          reasoning: 'T1\n\nT2',
          toolNotes: [],
          activities: [
            { id: c1.id, name: c1.name, call: c1, status: 'done', inputPreview: '{}', outputPreview: 'alpha ok' },
            { id: c2.id, name: c2.name, call: c2, status: 'running', inputPreview: '{}' },
          ],
          steps: [
            { kind: 'thinking', id: 'think-0', text: 'T1', streaming: false, startedAt: 1000, endedAt: 2400 },
            { kind: 'tool', id: 'tool-snap-c1', activityId: 'snap-c1' },
            { kind: 'text', id: 'text-2', text: 'Inspecting beta next.', streaming: false },
            { kind: 'thinking', id: 'think-3', text: 'T2', streaming: false, startedAt: 3000, endedAt: 4200 },
            { kind: 'tool', id: 'tool-snap-c2', activityId: 'snap-c2' },
          ],
          artifacts: [],
          streaming: true,
        },
      ],
      liveRun: { text: 'Inspecting beta next.', reasoning: 'T1\n\nT2', busy: true },
    }

    render(true)
    await settle()

    act(() => {
      mirrorListener?.({
        type: 'tool-executed',
        payload: { call: c2, execution: { output: 'beta ok', summary: c2.name } },
      })
      mirrorListener?.({ type: 'reasoning', payload: 'T3 wrap-up thought.' })
      mirrorListener?.({ type: 'text', payload: 'Final summary.' })
      mirrorListener?.({ type: 'done', payload: null })
    })
    await settle()

    const timeline = host.querySelector('.kb-ask-timeline')!
    const classes = [...timeline.children].map((el) => {
      if (el.classList.contains('kb-ask-thinking')) return 'thinking'
      if (el.classList.contains('kb-ask-activity')) return 'tool'
      if (el.classList.contains('kb-ask-step-note')) return 'note'
      if (el.classList.contains('kb-ask-step-answer')) return 'answer'
      return 'other'
    })
    expect(classes).toEqual(['thinking', 'tool', 'note', 'thinking', 'tool', 'thinking', 'answer'])
    expect(host.querySelector('.kb-ask-thinking-duration')?.textContent).toBe('1.4s')

    // Hide thinking via panel prefs update.
    act(() => {
      applyAiPanelPrefs({ showThinking: false, showToolCalls: true })
    })
    await settle()
    expect(host.querySelectorAll('.kb-ask-thinking')).toHaveLength(0)
    expect(host.querySelectorAll('.kb-ask-activity')).toHaveLength(2)

    // Restore thinking and hide tool calls via panel prefs update.
    act(() => {
      applyAiPanelPrefs({ showThinking: true, showToolCalls: false })
    })
    await settle()
    expect(host.querySelectorAll('.kb-ask-thinking')).toHaveLength(3)
    expect(host.querySelectorAll('.kb-ask-activity')).toHaveLength(0)
  })

  it('tracks live thinking scroll position without stealing upward scrolls and clears state when sealed', async () => {
    render()
    await settle()

    chunk('reasoning', { text: 'First thinking line.' })
    pump()

    const details = host.querySelector<HTMLDetailsElement>('details.kb-ask-thinking')!
    const body = host.querySelector<HTMLDivElement>('.kb-ask-thinking-text')!
    expect(details.classList.contains('kb-ask-thinking-live')).toBe(true)
    expect(body.getAttribute('data-scrolled-top')).toBeNull()

    let bodyTop = 0
    Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => 400 })
    Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => 180 })
    Object.defineProperty(body, 'scrollTop', {
      configurable: true,
      get: () => bodyTop,
      set: (value: number) => {
        bodyTop = value
      },
    })

    // Auto-follows to bottom while pinned near bottom and sets top fade mask flag.
    chunk('reasoning', { text: ' Second thinking line.' })
    pump()
    expect(bodyTop).toBe(400)
    expect(body.getAttribute('data-scrolled-top')).toBe('true')

    // User scrolls up past threshold (> 16px from bottom): subsequent tokens must not snap back.
    bodyTop = 60
    act(() => {
      body.dispatchEvent(new Event('scroll'))
    })
    chunk('reasoning', { text: ' Third thinking line.' })
    pump()
    expect(bodyTop).toBe(60)
    expect(body.getAttribute('data-scrolled-top')).toBe('true')

    // Tool call / answer seals live thinking and renders g-scroll on tool pre blocks.
    chunk('tool-call', {
      toolCall: { id: 'pre-1', name: 'search_knowledge_base', input: { query: 'test' } },
    })
    chunk('delta', { text: 'Done.' })
    chunk('done')
    await settle()
    pump()

    expect(details.classList.contains('kb-ask-thinking-live')).toBe(false)
    expect(body.getAttribute('data-scrolled-top')).toBeNull()
    const toolPre = host.querySelector('details.kb-ask-activity pre')
    expect(toolPre?.classList.contains('g-scroll')).toBe(true)
  })
})
