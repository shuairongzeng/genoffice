// @vitest-environment jsdom
/**
 * The ask panel's two mounts, two threads (P0-1): Home's copy and the
 * document-mode overlay's standalone mount (panel-entry.tsx) used to share
 * the fixed 'kb-ask' chat id, so their AgentLoops cross-read one transcript.
 * The overlay now passes its own id, and these tests pin the isolation
 * end-to-end: two panels mounted against one project-store, each question
 * claimed, persisted and shown under its own thread.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ChatMeta, ProjectApi } from '@genoffice/project-store'
import { KbAskPanel, panelThreads } from '../src/renderer/src/KbAskPanel'
import { LocaleProvider } from '../src/renderer/src/locale'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** the id the overlay's standalone mount owns (panel-entry.tsx) */
const OVERLAY_CHAT_ID = 'kb-overlay-ask'

/**
 * One project-store shared by both mounts (the real store lives in the main
 * process, shared by every renderer): it records every call and answers each
 * resolveChat with the caller's own id, the way the file-less path does.
 */
function recordingProjectApi() {
  const calls: Array<{ method: string; args: unknown }> = []
  const api = {
    resolveChat: async (args: unknown) => {
      calls.push({ method: 'resolveChat', args })
      const { tempChatId } = args as { tempChatId: string }
      return { projectId: 'default', chatId: tempChatId }
    },
    appendChat: async (args: unknown) => {
      calls.push({ method: 'appendChat', args })
    },
    loadChat: async (args: unknown) => {
      calls.push({ method: 'loadChat', args })
      return []
    },
    listChats: async (args: unknown) => {
      calls.push({ method: 'listChats', args })
      return [] as ChatMeta[]
    },
    deleteChat: async (args: unknown) => {
      calls.push({ method: 'deleteChat', args })
    },
  } as unknown as ProjectApi
  return { api, calls }
}

let rootA: Root
let rootB: Root
let hostA: HTMLDivElement
let hostB: HTMLDivElement
let store: ReturnType<typeof recordingProjectApi>

beforeAll(() => {
  // jsdom implements no scrolling; the thread's follow-stream effect calls scrollTo
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {}
})

beforeEach(() => {
  // the aiOffice face the panel's mount and ask paths need: an empty corpus,
  // so a submitted question resolves to the panel's guidance answer without
  // any AI transport taking part (the same trick home-ask-intent tests use)
  ;(window as unknown as { aiOffice: unknown }).aiOffice = {
    kbList: async () => [],
    aiGetSettings: async () => null,
    aiGskStatus: async () => ({ loggedIn: true }),
    onAiSettingsChanged: () => () => {},
    skillsList: async () => [],
  }
  store = recordingProjectApi()
  ;(window as unknown as { projectApi: unknown }).projectApi = store.api
  hostA = document.createElement('div')
  hostB = document.createElement('div')
  document.body.append(hostA, hostB)
  rootA = createRoot(hostA)
  rootB = createRoot(hostB)
})

afterEach(() => {
  act(() => rootA.unmount())
  act(() => rootB.unmount())
  hostA.remove()
  hostB.remove()
  delete (window as unknown as { aiOffice?: unknown }).aiOffice
  delete (window as unknown as { projectApi?: unknown }).projectApi
})

function panelProps(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    onOpenPath: () => {},
    onGoToRecents: () => {},
    onOpenModelSettings: () => {},
    onOpenScopeSettings: () => {},
    ...over,
  }
}

function render(root: Root, props: Record<string, unknown>): void {
  act(() =>
    root.render(
      createElement(
        LocaleProvider,
        { initial: 'en' },
        createElement(KbAskPanel, panelProps(props) as never),
      ),
    ),
  )
}

/** flush the mount claim, the submission chain and the queued persists */
async function settle(times = 8): Promise<void> {
  await act(async () => {
    for (let i = 0; i < times; i++) await Promise.resolve()
  })
}

/** the user turns each mounted panel shows, in thread order */
const askedOf = (host: HTMLElement): string[] =>
  [...host.querySelectorAll('.kb-ask-msg.kb-ask-user')].map((el) => el.textContent ?? '')

describe('two mounted ask panels, two transcripts (P0-1)', () => {
  it('claims its own chat id: the default home thread and the overlay id', async () => {
    render(rootA, {})
    render(rootB, { chatId: OVERLAY_CHAT_ID })
    await settle()
    const resolved = [
      ...new Set(
        store.calls
          .filter((c) => c.method === 'resolveChat')
          .map((c) => (c.args as { tempChatId: string }).tempChatId),
      ),
    ].sort()
    expect(resolved).toEqual(['kb-ask', OVERLAY_CHAT_ID])
  })

  it('writes each panel question to its own transcript, not the other one', async () => {
    render(rootA, {})
    render(rootB, { chatId: OVERLAY_CHAT_ID })
    await settle()
    // a question handed to each panel the way the workbench hands one over
    render(rootA, {
      pendingQuery: { text: 'question for the home copy', seq: 1, origin: 'palette' },
    })
    render(rootB, {
      chatId: OVERLAY_CHAT_ID,
      pendingQuery: { text: 'question for the overlay copy', seq: 1, origin: 'palette' },
    })
    await settle()
    const appends = store.calls
      .filter((c) => c.method === 'appendChat')
      .map((c) => c.args as { chatId: string; role: string; text: string })
    // one asked turn per panel, persisted under that panel's own chat id
    expect(appends.filter((a) => a.role === 'user')).toEqual([
      { projectId: 'default', chatId: 'kb-ask', role: 'user', text: 'question for the home copy' },
      {
        projectId: 'default',
        chatId: OVERLAY_CHAT_ID,
        role: 'user',
        text: 'question for the overlay copy',
      },
    ])
    // each panel's own thread shows its own question — and not the other's
    expect(askedOf(hostA)).toEqual(['question for the home copy'])
    expect(askedOf(hostB)).toEqual(['question for the overlay copy'])
  })

  it('starts a fresh thread inside its own family, so the lists stay disjoint', () => {
    // the thread chips filter by prefix family (panelThreads): the overlay's
    // root must sit outside the home family or each panel would list — and
    // offer deleting — the other surface's transcripts
    const meta = (chatId: string): ChatMeta => ({
      chatId,
      updatedAt: '2026-11-01T09:00:00.000Z',
      approxCount: 2,
    })
    const stored = [
      meta('kb-ask'),
      meta('kb-ask-1731'),
      meta(`${OVERLAY_CHAT_ID}`),
      meta(`${OVERLAY_CHAT_ID}-1731`),
      meta('unsaved-1728000000000'),
    ]
    expect(panelThreads(stored).map((m) => m.chatId)).toEqual(['kb-ask', 'kb-ask-1731'])
    expect(panelThreads(stored, OVERLAY_CHAT_ID).map((m) => m.chatId)).toEqual([
      OVERLAY_CHAT_ID,
      `${OVERLAY_CHAT_ID}-1731`,
    ])
  })
})
