// @vitest-environment jsdom
/**
 * Skill-body context wiring in the home knowledge-base ask panel. The panel
 * chats over the starred corpus, not a document, so the variables it offers an
 * attached skill are its own: APP is the sidebar's localized label for this
 * surface, LANGUAGE and TODAY follow the UI language, and FILE_NAME and
 * SELECTION are absent — an omitted variable stays literal in the body. These
 * tests drive the real send path (skillText, the agent loop, the IPC
 * transport) and assert on the request that leaves for the main process,
 * which is the model-facing text.
 *
 * The same harness pins the surface context: the shell operator skill's
 * "current surface" system section (per mount, refreshed per send through the
 * getSurfaceTabs bridge) and the shell:* tool list riding the request.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { KbAskPanel } from '../src/renderer/src/KbAskPanel'
import { LocaleProvider } from '../src/renderer/src/locale'
import type { SurfaceTab } from '@genoffice/agent-core'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** one starred file is enough: it opens the corpus gate and the run starts */
const CORPUS = [
  { path: 'C:/kb/notes.md', folder: 'kb', name: 'notes.md', ext: 'md', sizeBytes: 512 },
]

/** every placeholder the panel is expected to fill — or deliberately leave */
const SKILL_BODY = [
  'Write plainly.',
  'App: ${APP}',
  'Language: ${LANGUAGE}',
  'Today: ${TODAY}',
  'File: ${FILE_NAME}',
  'Selection: ${SELECTION}',
  'Request: $ARGUMENTS',
  'First word: $0',
  'Beyond the end: $9',
].join('\n')

/** the request the transport forwards to the main process */
interface StartedRequest {
  requestId: string
  system: string
  messages: Array<{ role: string; text: string }>
  tools: Array<{ name: string }>
}

type ChunkListener = (chunk: { requestId: string; type: string }) => void

let host: HTMLDivElement
let root: Root
let started: StartedRequest[]
let chunkListener: ChunkListener | null
let skillText: ReturnType<typeof vi.fn>
/** the surface snapshot the bridge answers; the panel pulls it per send */
let surfaceTabs: readonly SurfaceTab[] | null

beforeAll(() => {
  // jsdom implements no scrolling; the thread's follow-stream effect calls scrollTo
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {}
})

beforeEach(() => {
  started = []
  chunkListener = null
  skillText = vi.fn(async () => SKILL_BODY)
  surfaceTabs = null
  // the panel tolerates a bridge without kb:* channels, but then it never
  // builds the loop — so the stub carries everything a real ask touches
  ;(window as unknown as { aiOffice: unknown }).aiOffice = {
    skillsList: vi.fn(async () => [{ name: 'tone', description: 'Write plainly' }]),
    skillText,
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
      // the answer arrives at once: one turn, no tools, the run completes
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
})

function render(lang: 'en' | 'zh', surfaceRole?: 'home' | 'overlay' | 'docked'): void {
  act(() =>
    root.render(
      createElement(
        LocaleProvider,
        { initial: lang },
        createElement(KbAskPanel, {
          onOpenPath: () => {},
          onGoToRecents: () => {},
          onOpenModelSettings: () => {},
          onOpenScopeSettings: () => {},
          ...(surfaceRole ? { surfaceRole } : {}),
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

/** attach a skill the way a user does: slash token in the draft, Enter picks it */
async function attach(token: string): Promise<void> {
  type(`/${token}`)
  await settle()
  press('Enter')
  await settle()
}

/** type a question and send it with Enter; the stubbed stream completes the run */
async function ask(question: string): Promise<void> {
  type(question)
  press('Enter')
  await settle()
}

describe('KbAskPanel skill context vars', () => {
  it('expands an attached skill body with this panel’s context at send time', async () => {
    render('en')
    await settle()
    await attach('tone')
    await ask('summarize the starred notes')

    expect(started).toHaveLength(1)
    const message = started[0]!.messages[0]!
    expect(message.role).toBe('user')
    const text = message.text
    // the wrapper withAttachedSkills builds, carrying the expanded body
    expect(text).toContain('The user attached the following skill to this request.')
    expect(text).toContain('<skill name="tone">')
    // $ARGUMENTS and positionals come from the question itself ($0 is the first
    // word); a position past the end stays literal
    expect(text).toContain('Request: summarize the starred notes')
    expect(text).toContain('First word: summarize')
    expect(text).toContain('Beyond the end: $9')
    // the panel's own context: the surface's name, the UI language, today
    expect(text).toContain('App: Ask AI')
    expect(text).toContain('Language: English')
    expect(text).toContain(`Today: ${new Date().toLocaleDateString('en')}`)
    // no document here: the vars a document panel would offer stay literal
    expect(text).toContain('File: ${FILE_NAME}')
    expect(text).toContain('Selection: ${SELECTION}')
    // the question rides behind the skill as the request it is the answer to
    expect(text).toContain('User request:\nsummarize the starred notes')
  })

  it('sends the question as-is when no skill is attached', async () => {
    render('en')
    await settle()
    await ask('summarize the starred notes')

    expect(started).toHaveLength(1)
    const text = started[0]!.messages[0]!.text
    expect(text.startsWith('summarize the starred notes')).toBe(true)
    expect(text).not.toContain('attached the following skill')
    expect(skillText).not.toHaveBeenCalled()
  })

  it('localizes the vars with the UI language', async () => {
    render('zh')
    await settle()
    await attach('tone')
    await ask('总结收藏的笔记')

    expect(started).toHaveLength(1)
    const text = started[0]!.messages[0]!.text
    expect(text).toContain('App: AI 问答')
    expect(text).toContain('Language: 中文')
    expect(text).toContain(`Today: ${new Date().toLocaleDateString('zh')}`)
    expect(text).toContain('Request: 总结收藏的笔记')
  })
})

describe('KbAskPanel surface context', () => {
  const SURFACE: SurfaceTab[] = [
    { id: 'home', kind: 'home', title: 'Home', active: false },
    {
      id: 't1',
      kind: 'browser',
      title: 'Example Domain',
      active: true,
      url: 'https://example.com/',
    },
    { id: 'doc1', kind: 'word', title: 'Report', active: false, filePath: 'C:/kb/report.docx' },
  ]

  it('docks the live surface section and the shell tools into the request', async () => {
    surfaceTabs = SURFACE
    render('en')
    await settle()
    await ask('summarize the starred notes')

    expect(started).toHaveLength(1)
    const system = started[0]!.system
    expect(system).toContain('## Current surface')
    expect(system).toContain('Active tab: browser — "Example Domain" (https://example.com/)')
    expect(system).toContain('- doc1 | word | Report | C:/kb/report.docx')
    expect(system).toContain(
      'The person is looking at the Home desktop; the AI panel is docked beside it.',
    )
    expect(system).toContain('## Operating the desktop')
    const tools = started[0]!.tools.map((tool) => tool.name)
    expect(tools).toEqual(
      expect.arrayContaining([
        'shell:open_browser',
        'shell:navigate',
        'shell:list_tabs',
        'shell:switch_tab',
        'shell:open_path',
      ]),
    )
  })

  it("speaks the overlay mount's visibility line", async () => {
    surfaceTabs = SURFACE
    render('en', 'overlay')
    await settle()
    await ask('summarize the starred notes')

    const system = started[0]!.system
    expect(system).toContain('The AI panel floats over the workspace')
    expect(system).not.toContain('docked beside it')
  })

  it('re-words the visibility line when the drawer docks mid-session (the live role)', async () => {
    // the overlay's shape flips at runtime — floating over the tab, then
    // docked into the document app's own slot — and the skill was built at
    // the loop's mount, so the role must arrive as a getter the prompt
    // re-reads, not the mount-time value: the next request tells the model
    // the truth about where the person's attention sits
    surfaceTabs = SURFACE
    render('en', 'overlay')
    await settle()
    await ask('first question')

    expect(started[0]!.system).toContain('The AI panel floats over the workspace')
    // the entry re-renders the panel with the docked role when the view fits
    // the slot; the same mount follows it
    render('en', 'docked')
    await ask('second question')

    expect(started).toHaveLength(2)
    expect(started[1]!.system).toContain(
      "The AI panel is docked into the document app's own panel slot beside the active tab",
    )
    expect(started[1]!.system).not.toContain('The AI panel floats over the workspace')
    // and back: undocking restores the floating copy on the next send
    render('en', 'overlay')
    await ask('third question')

    expect(started[2]!.system).toContain('The AI panel floats over the workspace')
    expect(started[2]!.system).not.toContain('panel slot beside the active tab')
  })

  it('refreshes the surface between sends: each request sees the surface as it is now', async () => {
    surfaceTabs = [{ id: 'home', kind: 'home', title: 'Home', active: true }]
    render('en')
    await settle()
    await ask('first question')

    expect(started[0]!.system).toContain('Active tab: home (desktop) — "Home"')
    surfaceTabs = SURFACE
    await ask('second question')

    expect(started).toHaveLength(2)
    expect(started[1]!.system).toContain(
      'Active tab: browser — "Example Domain" (https://example.com/)',
    )
  })

  it('degrades to the no-state line before the first pull lands', async () => {
    render('en')
    await settle()
    await ask('summarize the starred notes')

    expect(started[0]!.system).toContain('no tab state is available right now')
  })
})
