// @vitest-environment jsdom
/**
 * The Ask panel's streaming render discipline: the animation-frame flush
 * queue that coalesces a token burst into one React render (the O(history ×
 * tokens) fix), the stick-to-bottom scroll guard, and patchLast's pure half.
 * The panel-level tests drive the real send path with a stubbed main process
 * and a manually pumped requestAnimationFrame, asserting commits through a
 * React Profiler and scroll behavior through the thread element.
 */
import { Profiler, act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RafFlushQueue,
  STICK_TO_BOTTOM_PX,
  sticksToBottom,
  type ScheduleFlush,
} from '../src/renderer/src/ask-stream'
import { applyAskPatch, KbAskPanel } from '../src/renderer/src/KbAskPanel'
import { LocaleProvider } from '../src/renderer/src/locale'
import type { ChatMessage, ProjectApi } from '@genoffice/project-store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CORPUS = [
  { path: 'C:/kb/notes.md', folder: 'kb', name: 'notes.md', ext: 'md', sizeBytes: 512 },
]

type ChunkListener = (chunk: {
  requestId: string
  type: string
  text?: string
  error?: string
  toolCall?: { id: string; name: string; input: Record<string, unknown> }
}) => void

// ---- the ask-stream units --------------------------------------------------

/** a scheduler that hands the queued frames to the test */
function manualScheduler(): { schedule: ScheduleFlush; frames: Array<() => void> } {
  const frames: Array<() => void> = []
  return { schedule: (run) => frames.push(run), frames }
}

describe('RafFlushQueue', () => {
  it('coalesces a burst of requests into one flush per frame', () => {
    const flush = vi.fn()
    const { schedule, frames } = manualScheduler()
    const queue = new RafFlushQueue(flush, schedule)
    for (let i = 0; i < 10; i++) queue.request()
    // ten requests, one scheduled frame: the flush reads the ref when the
    // frame lands, so every patch in between rides the same frame
    expect(frames).toHaveLength(1)
    for (const frame of frames.splice(0)) frame()
    expect(flush).toHaveBeenCalledTimes(1)
    // the slot is free again: a later request schedules a new frame
    queue.request()
    expect(frames).toHaveLength(1)
  })

  it('a request after dispose never schedules or flushes', () => {
    const flush = vi.fn()
    const { schedule, frames } = manualScheduler()
    const queue = new RafFlushQueue(flush, schedule)
    queue.request()
    queue.dispose()
    // a frame already in flight lands as a no-op
    for (const frame of frames.splice(0)) frame()
    expect(flush).not.toHaveBeenCalled()
    queue.request()
    expect(frames).toHaveLength(0)
  })
})

describe('sticksToBottom', () => {
  it('sticks at the bottom and within the threshold', () => {
    // exactly pinned: zero gap
    expect(sticksToBottom(700, 1000, 300)).toBe(true)
    // one pixel short of the threshold still counts as reading the bottom
    expect(sticksToBottom(1000 - 300 - (STICK_TO_BOTTOM_PX - 1), 1000, 300)).toBe(true)
  })

  it('lets go once the reader is further up than the threshold', () => {
    expect(sticksToBottom(1000 - 300 - STICK_TO_BOTTOM_PX, 1000, 300)).toBe(false)
    // far from the bottom: rereading history
    expect(sticksToBottom(0, 1000, 300)).toBe(false)
  })

  it('honors a custom threshold', () => {
    expect(sticksToBottom(650, 1000, 300, 8)).toBe(false)
    expect(sticksToBottom(695, 1000, 300, 8)).toBe(true)
  })
})

describe('applyAskPatch', () => {
  const thread = [
    { role: 'user', text: 'q', toolNotes: [], artifacts: [] },
    { role: 'assistant', text: '', toolNotes: [], artifacts: [], streaming: true },
  ] as Parameters<typeof applyAskPatch>[0]

  it('patches the last assistant turn', () => {
    const next = applyAskPatch(thread, { text: 'answer' })
    expect(next).toHaveLength(2)
    expect(next[1]!.text).toBe('answer')
    expect(next[1]!.streaming).toBe(true)
    // the user turn keeps its identity (memoized rows survive)
    expect(next[0]).toBe(thread[0])
  })

  it('accepts a patch computed from the last message', () => {
    const next = applyAskPatch(thread, (last) => ({ text: `${last.text}more` }))
    expect(next[1]!.text).toBe('more')
  })

  it('returns the same reference when there is no assistant tail to patch', () => {
    const userTail = [thread[0]!]
    expect(applyAskPatch(userTail, { text: 'x' })).toBe(userTail)
    expect(applyAskPatch([], { text: 'x' })).toEqual([])
  })
})

// ---- the panel end to end --------------------------------------------------

let host: HTMLDivElement
let root: Root
let chunkListener: ChunkListener | null
let started: Array<{ requestId: string }>
let commits: number
let persisted: ChatMessage[]
let frames: Array<() => void>

function projectApiStub() {
  const api = {
    resolveChat: async () => ({ projectId: 'default', chatId: 'kb-ask' }),
    loadChat: async () => [] as ChatMessage[],
    appendChat: async (args: Record<string, unknown>) => {
      persisted.push({
        seq: persisted.length,
        ts: '2026-10-30T09:00:00.000Z',
        role: args.role as 'user' | 'assistant',
        text: args.text as string,
      })
    },
    deleteChat: async () => {},
    listChats: async () => [],
  } as unknown as ProjectApi
  return api
}

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {}
})

beforeEach(() => {
  started = []
  commits = 0
  persisted = []
  chunkListener = null
  frames = []
  // requestAnimationFrame becomes a manual pump: the panel's deferred flushes
  // land exactly when the test says the frame arrives
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    frames.push(cb)
    return frames.length
  })
  ;(window as unknown as { projectApi?: unknown }).projectApi = projectApiStub()
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
    onAiStream: (listener: ChunkListener) => {
      chunkListener = listener
      return () => {
        chunkListener = null
      }
    },
    aiStream: (request: { requestId: string }) => {
      // the stream stays open: the test delivers deltas and the done chunk
      // by hand, so frame boundaries are under its control
      started.push(request)
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
  vi.unstubAllGlobals()
  delete (window as unknown as { aiOffice?: unknown }).aiOffice
  delete (window as unknown as { projectApi?: unknown }).projectApi
  delete (window as unknown as { aiOfficeTabs?: unknown }).aiOfficeTabs
})

function render(): void {
  act(() =>
    root.render(
      createElement(
        Profiler,
        {
          id: 'panel',
          // one invocation per commit of the panel's subtree: the render
          // count the streaming animation is judged against
          onRender: () => {
            commits++
          },
        },
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

/** deliver one stream chunk into the panel's open request */
const chunk = (type: string, text?: string): void =>
  act(() => {
    chunkListener?.({ requestId: started[started.length - 1]!.requestId, type, text })
  })

/** run every queued animation frame, as the browser would for one paint */
function pumpFrame(): void {
  act(() => {
    for (const frame of frames.splice(0)) frame()
  })
}

async function ask(question: string): Promise<void> {
  type(question)
  press('Enter')
  await settle()
}

/** the thread element with layout geometry the test controls (jsdom has none) */
function threadEl(): HTMLDivElement {
  const el = host.querySelector('.kb-ask-thread') as HTMLDivElement
  expect(el).toBeTruthy()
  return el
}

function setViewport(
  el: HTMLDivElement,
  scrollTop: number,
  scrollHeight = 1000,
  clientHeight = 300,
): void {
  for (const [prop, value] of [
    ['scrollTop', scrollTop],
    ['scrollHeight', scrollHeight],
    ['clientHeight', clientHeight],
  ] as const) {
    Object.defineProperty(el, prop, { value, configurable: true })
  }
}

describe('KbAskPanel streaming renders', () => {
  it('renders a token burst as one commit per frame, not one per token', async () => {
    render()
    await settle()
    await ask('summarize the notes')
    expect(started).toHaveLength(1)
    const baseline = commits

    // a burst of tokens: the ref advances ten times, the state does not
    for (let i = 0; i < 10; i++) chunk('delta', `token${i} `)
    expect(commits).toBe(baseline)
    // all ten requests folded into a single scheduled frame
    expect(frames).toHaveLength(1)
    // the frame landing paints the whole burst at once
    pumpFrame()
    expect(commits).toBe(baseline + 1)
    expect(host.textContent).toContain('token9')
  })

  it('a deferred flush landing after a synchronous one changes nothing on screen', async () => {
    render()
    await settle()
    await ask('summarize the notes')
    for (let i = 0; i < 5; i++) chunk('delta', `token${i} `)
    // a synchronous patch (the finish) flushes the state itself; the still
    // pending frame then sets the same array reference. React's bailout may
    // re-run the component itself once, but never re-renders its children —
    // the observable contract is that the late frame paints nothing new
    chunk('done')
    // the run's own retirement (the task list row) settles outside the
    // measurement, so only the frame's flush is left to observe
    await settle()
    const before = host.innerHTML
    expect(frames).toHaveLength(1)
    pumpFrame()
    expect(frames).toHaveLength(0)
    expect(host.innerHTML).toBe(before)
  })

  it('persists the finished answer before any frame has landed', async () => {
    render()
    await settle()
    await ask('summarize the notes')
    // tokens land on the ref only; no frame is ever pumped
    for (let i = 0; i < 5; i++) chunk('delta', `token${i} `)
    chunk('done')
    // the finish persisted the full text although React never rendered any
    // intermediate token: finishLast reads the ref, not the state
    const answer = persisted.find((m) => m.role === 'assistant' && m.text.includes('token'))
    expect(answer?.text).toContain('token4')
    // and the sync flush painted it without a frame
    expect(host.textContent).toContain('token4')
  })

  it('follows the thread while pinned, and stops once the reader scrolls up', async () => {
    render()
    await settle()
    await ask('summarize the notes')
    const el = threadEl()
    const scrollTo = vi.fn()
    el.scrollTo = scrollTo as unknown as typeof el.scrollTo

    // pinned at the bottom (initial state): growth is followed
    setViewport(el, 700)
    chunk('delta', 'first ')
    pumpFrame()
    expect(scrollTo).toHaveBeenCalledTimes(1)

    // the reader scrolls up to reread history mid-stream
    setViewport(el, 0)
    act(() => el.dispatchEvent(new Event('scroll')))
    scrollTo.mockClear()
    for (let i = 0; i < 4; i++) chunk('delta', `token${i} `)
    pumpFrame()
    // the viewport stays exactly where the reader left it
    expect(scrollTo).not.toHaveBeenCalled()

    // back at the bottom: following resumes
    setViewport(el, 700)
    act(() => el.dispatchEvent(new Event('scroll')))
    scrollTo.mockClear()
    chunk('delta', 'tail')
    pumpFrame()
    expect(scrollTo).toHaveBeenCalledTimes(1)
  })

  it('the scroll-to-latest button: hidden while followed, appears on unfollow, its click resumes', async () => {
    render()
    await settle()
    await ask('summarize the notes')
    const el = threadEl()
    // following: no button
    expect(host.querySelector('.kb-ask-scroll-latest')).toBeNull()
    // the reader leaves the bottom: the button appears
    setViewport(el, 0)
    act(() => el.dispatchEvent(new Event('scroll')))
    const button = host.querySelector<HTMLButtonElement>('.kb-ask-scroll-latest')
    expect(button).toBeTruthy()
    expect(button!.getAttribute('aria-label')).toBe('Scroll to the latest message')
    // growth while unfollowed: the button flags the new content
    chunk('delta', 'new stuff')
    pumpFrame()
    expect(host.querySelector('.kb-ask-scroll-latest')?.classList.contains('has-new')).toBe(true)
    // the click resumes the follow and the button leaves
    setViewport(el, 700)
    act(() => button!.click())
    expect(host.querySelector('.kb-ask-scroll-latest')).toBeNull()
  })

  it('preserves partial text, displays error banner, clears busy, and allows follow-up asks on mid-stream error', async () => {
    const published: Array<{ type: string; payload: unknown }> = []
    ;(window as unknown as { aiOffice: Record<string, unknown> }).aiOffice.askRunEvent = (evt: {
      type: string
      payload: unknown
    }) => {
      published.push(evt)
    }

    render()
    await settle()
    await ask('summarize the table')
    expect(started).toHaveLength(1)
    expect(host.querySelector('.ai-stop-btn')).toBeTruthy()

    chunk('delta', 'Checking the spreadsheet first.')
    pumpFrame()
    expect(host.textContent).toContain('Checking the spreadsheet first.')

    act(() => {
      chunkListener?.({
        requestId: started[0]!.requestId,
        type: 'error',
        error: 'Model output contains an unrecoverable tool call.',
      })
    })
    await settle()

    // Partial text stays intact and the error banner surfaces the failure clearly.
    expect(host.textContent).toContain('Checking the spreadsheet first.')
    const banner = host.querySelector('.kb-ask-error-banner[role="alert"]')
    expect(banner?.textContent).toBe('Model output contains an unrecoverable tool call.')
    // Stop button clears back to idle so follow-up questions are never deadlocked.
    expect(host.querySelector('.ai-stop-btn')).toBeNull()
    expect(host.querySelector('.ai-send-btn')).toBeTruthy()

    const errEvt = published.find((e) => e.type === 'error')
    expect(errEvt?.payload).toBe('Model output contains an unrecoverable tool call.')
    const lastSnap = [...published].reverse().find((e) => e.type === 'snapshot')
    expect((lastSnap?.payload as { liveRun?: unknown } | undefined)?.liveRun).toBeNull()

    // Sending a second question immediately succeeds.
    await ask('retry 1+1')
    expect(started).toHaveLength(2)
    chunk('delta', '2')
    chunk('done')
    await settle()
    expect(host.textContent).toContain('2')
  })

  it('ignores whitespace-only text overwrites and keeps the live typing indicator visible while streaming', async () => {
    ;(window as unknown as { aiOffice: Record<string, unknown> }).aiOffice.kbSearch = async () => []
    render()
    await settle()
    await ask('analyze spending')
    expect(started).toHaveLength(1)

    chunk('delta', 'Inspecting sheet data.')
    pumpFrame()
    expect(host.textContent).toContain('Inspecting sheet data.')
    // Live typing indicator remains visible below partial text while the run is still streaming.
    expect(host.querySelector('.kb-ask-live-status .ai-typing')).toBeTruthy()

    // A subsequent whitespace-only turn (e.g. "\n\n" before a tool call) must not erase prior text.
    act(() => {
      chunkListener?.({
        requestId: started[0]!.requestId,
        type: 'tool-call',
        toolCall: { id: 'c1', name: 'search_knowledge_base', input: { query: 'cost' } },
      })
      chunkListener?.({ requestId: started[0]!.requestId, type: 'done' })
    })
    await settle()
    expect(started).toHaveLength(2)

    act(() => {
      chunkListener?.({ requestId: started[1]!.requestId, type: 'delta', text: '\n\n' })
    })
    pumpFrame()
    expect(host.textContent).toContain('Inspecting sheet data.')
    expect(host.querySelector('.kb-ask-live-status .ai-typing')).toBeTruthy()

    act(() => {
      chunkListener?.({
        requestId: started[1]!.requestId,
        type: 'delta',
        text: 'Final RMB total: 100.',
      })
      chunkListener?.({ requestId: started[1]!.requestId, type: 'done' })
    })
    await settle()
    expect(host.textContent).toContain('Final RMB total: 100.')
    expect(host.querySelector('.ai-typing')).toBeNull()
  })

  it('publishes an initial streaming snapshot even before chat ids finish resolving', async () => {
    const published: Array<{ type: string; payload: unknown }> = []
    let resolveIds!: (ids: { projectId: string; chatId: string }) => void
    const pendingProjectApi = {
      resolveChat: () =>
        new Promise<{ projectId: string; chatId: string }>((resolve) => {
          resolveIds = resolve
        }),
      loadChat: async () => [] as ChatMessage[],
      appendChat: async () => {},
      deleteChat: async () => {},
      listChats: async () => [],
    } as unknown as ProjectApi
    ;(window as unknown as { projectApi: ProjectApi }).projectApi = pendingProjectApi
    ;(window as unknown as { aiOffice: Record<string, unknown> }).aiOffice.askRunEvent = (evt: {
      type: string
      payload: unknown
    }) => {
      published.push(evt)
    }

    render()
    await settle()
    await ask('early question before ids resolve')

    const snap = published.find((e) => e.type === 'snapshot')
    expect(snap).toBeTruthy()
    const payload = snap!.payload as {
      messages: Array<{ role: string; streaming?: boolean }>
      liveRun: { busy?: boolean } | null
    }
    expect(payload.liveRun?.busy).toBe(true)
    expect(payload.messages.at(-1)?.role).toBe('assistant')
    expect(payload.messages.at(-1)?.streaming).toBe(true)

    resolveIds({ projectId: 'default', chatId: 'kb-ask' })
    chunk('done')
    await settle()
  })
})
