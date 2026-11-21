// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SurfaceTab } from '@genoffice/agent-core'
import type { ChatMessage, ChatMeta, GlobalChatMeta, ProjectApi } from '@genoffice/project-store'
import {
  deriveActiveTabBinding,
  deriveFocusedSurfaceTab,
  docExtraChatId,
  filterCurrentDocThreads,
  isBindableDocumentTab,
  planThreadClaim,
  sameDocPath,
  sessionKeyOf,
  shouldAcceptMirrorEvent,
  unsavedTabChatId,
} from '../src/renderer/src/ask-session-binding'
import { KbAskPanel } from '../src/renderer/src/KbAskPanel'
import { LocaleProvider } from '../src/renderer/src/locale'
import type { AskRunEvent } from '../src/shared/home-api'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const docHash = (filePath: string): string => {
  let h = 2166136261
  for (let i = 0; i < filePath.length; i++) {
    h ^= filePath.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return `chat-${h.toString(16)}`
}

describe('ask-session-binding helpers', () => {
  it('binds all document and media tabs while excluding home and browser tabs', () => {
    expect(isBindableDocumentTab({ kind: 'docs' })).toBe(true)
    expect(isBindableDocumentTab({ kind: 'sheets' })).toBe(true)
    expect(isBindableDocumentTab({ kind: 'slides' })).toBe(true)
    expect(isBindableDocumentTab({ kind: 'pdf' })).toBe(true)
    expect(isBindableDocumentTab({ kind: 'markdown' })).toBe(true)
    expect(isBindableDocumentTab({ kind: 'html' })).toBe(true)
    expect(isBindableDocumentTab({ kind: 'media' })).toBe(true)
    expect(isBindableDocumentTab({ kind: 'home' })).toBe(false)
    expect(isBindableDocumentTab({ kind: 'browser' })).toBe(false)
  })

  it('derives stable binding keys for saved docs, unsaved drafts, and explicit targets', () => {
    const unsavedTab: SurfaceTab = { id: 'tab/unsaved:1', kind: 'docs', title: 'Untitled', active: true }
    const binding = deriveActiveTabBinding([unsavedTab])
    expect(binding).toEqual({
      tabId: 'tab/unsaved:1',
      kind: 'docs',
      title: 'Untitled',
      filePath: null,
    })
    expect(unsavedTabChatId('tab/unsaved:1')).toBe('tab-tab_unsaved_1')
    expect(docExtraChatId('chat-abc', 123456)).toBe('chat-abc-123456')

    expect(
      planThreadClaim({
        activeTab: binding,
        explicitTarget: null,
        fallbackChatId: 'kb-ask',
      }),
    ).toEqual({ mode: 'unsaved-tab', tempChatId: 'tab-tab_unsaved_1' })

    expect(
      planThreadClaim({
        activeTab: binding,
        explicitTarget: null,
        fallbackChatId: 'kb-ask',
        followActiveTab: false,
      }),
    ).toEqual({ mode: 'family', tempChatId: 'kb-ask' })

    const browserTab: SurfaceTab = {
      id: 'b1',
      kind: 'browser',
      title: 'Example',
      url: 'https://example.com',
      active: true,
    }
    expect(deriveFocusedSurfaceTab([unsavedTab])).toEqual({
      id: 'tab/unsaved:1',
      kind: 'docs',
      title: 'Untitled',
      filePath: null,
      url: null,
    })
    expect(deriveFocusedSurfaceTab([browserTab])).toEqual({
      id: 'b1',
      kind: 'browser',
      title: 'Example',
      filePath: null,
      url: 'https://example.com',
    })
    expect(deriveFocusedSurfaceTab([{ id: 'home', kind: 'home', title: 'Home', active: true }])).toBeNull()

    expect(
      planThreadClaim({
        activeTab: binding,
        explicitTarget: { projectId: 'proj1', chatId: 'chat-abc-999', docPath: 'C:/a.docx' },
        fallbackChatId: 'kb-ask',
      }),
    ).toEqual({
      mode: 'explicit',
      projectId: 'proj1',
      chatId: 'chat-abc-999',
      docPath: 'C:/a.docx',
    })
  })

  it('filters mirror run events strictly by sessionKey and splits current document threads', () => {
    expect(shouldAcceptMirrorEvent('p1:c1', 'p1:c1')).toBe(true)
    expect(shouldAcceptMirrorEvent('p1:c2', 'p1:c1')).toBe(false)
    expect(shouldAcceptMirrorEvent('p1:c1', null)).toBe(false)
    expect(shouldAcceptMirrorEvent(undefined, 'p1:c1')).toBe(true)

    expect(sameDocPath('C:\\Docs\\Report.docx', 'c:/docs/Report.docx/')).toBe(true)
    const { currentDoc, otherDocs } = filterCurrentDocThreads(
      [
        { chatId: 'c1', docPath: 'C:\\Docs\\Report.docx' },
        { chatId: 'c2', docPath: 'D:/Other.md' },
      ],
      'c:/docs/Report.docx',
    )
    expect(currentDoc.map((r) => r.chatId)).toEqual(['c1'])
    expect(otherDocs.map((r) => r.chatId)).toEqual(['c2'])
    expect(sessionKeyOf('p1', 'c1')).toBe('p1:c1')
  })
})

describe('KbAskPanel session binding integration', () => {
  let host: HTMLDivElement
  let root: Root
  let surfaceTabs: SurfaceTab[]
  let surfaceListener: (() => void) | null
  let runEventListener: ((event: AskRunEvent) => void) | null
  let emittedEvents: AskRunEvent[]
  let chats: Map<string, ChatMessage[]>
  let metaByChat: Map<string, { title?: string; pinned?: boolean; docPath?: string }>
  let rebindCalls: Array<{ projectId: string; tempChatId: string; newFilePath: string }>
  let setMetaCalls: Array<{ projectId: string; chatId: string; docPath?: string | null }>

  const flush = async (ticks = 6): Promise<void> => {
    for (let i = 0; i < ticks; i++) {
      await act(async () => {
        await Promise.resolve()
      })
    }
  }

  beforeAll(() => {
    if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {}
  })

  beforeEach(() => {
    surfaceTabs = []
    surfaceListener = null
    runEventListener = null
    emittedEvents = []
    chats = new Map()
    metaByChat = new Map()
    rebindCalls = []
    setMetaCalls = []

    const projectApi = {
      resolveChat: vi.fn(async (args: { filePath: string | null; tempChatId?: string }) => {
        if (args.filePath !== null) {
          const id = docHash(args.filePath)
          const existing = metaByChat.get(id) ?? {}
          metaByChat.set(id, { ...existing, docPath: args.filePath })
          return { projectId: 'default', chatId: id }
        }
        return { projectId: 'default', chatId: args.tempChatId ?? 'kb-ask' }
      }),
      loadChat: vi.fn(async (args: { chatId: string }) => [...(chats.get(args.chatId) ?? [])]),
      appendChat: vi.fn(async (args: { chatId: string; role: 'user' | 'assistant'; text: string }) => {
        const list = chats.get(args.chatId) ?? []
        list.push({ seq: list.length, ts: '2026-11-20T10:00:00.000Z', role: args.role, text: args.text })
        chats.set(args.chatId, list)
      }),
      deleteChat: vi.fn(async (args: { chatId: string }) => {
        chats.delete(args.chatId)
        metaByChat.delete(args.chatId)
      }),
      setChatMeta: vi.fn(
        async (args: {
          projectId: string
          chatId: string
          title?: string | null
          pinned?: boolean
          docPath?: string | null
        }) => {
          setMetaCalls.push(args)
          const cur = metaByChat.get(args.chatId) ?? {}
          metaByChat.set(args.chatId, {
            ...cur,
            ...(args.title !== undefined && args.title !== null ? { title: args.title } : {}),
            ...(args.pinned !== undefined ? { pinned: args.pinned } : {}),
            ...(args.docPath ? { docPath: args.docPath } : {}),
          })
          return null
        },
      ),
      rebindChat: vi.fn(
        async (args: { projectId: string; tempChatId: string; newFilePath: string }) => {
          rebindCalls.push(args)
          const nextId = docHash(args.newFilePath)
          const oldMsgs = chats.get(args.tempChatId) ?? []
          chats.set(nextId, [...oldMsgs])
          chats.delete(args.tempChatId)
          const prevMeta = metaByChat.get(args.tempChatId) ?? {}
          metaByChat.delete(args.tempChatId)
          metaByChat.set(nextId, { ...prevMeta, docPath: args.newFilePath })
          return { projectId: 'default', chatId: nextId }
        },
      ),
      listChats: vi.fn(async () => [] as ChatMeta[]),
      listAllChats: vi.fn(async () => {
        const ids = new Set([...chats.keys(), ...metaByChat.keys()])
        const out: GlobalChatMeta[] = []
        for (const id of ids) {
          const list = chats.get(id) ?? []
          const meta = metaByChat.get(id)
          out.push({
            projectId: 'default',
            projectName: 'Default',
            chatId: id,
            title: meta?.title,
            pinned: meta?.pinned,
            docPath: meta?.docPath,
            docExists: true,
            firstQuestion: list.find((m) => m.role === 'user')?.text ?? '',
            lastMessagePreview: list.at(-1)?.text ?? '',
            messageCount: list.length,
            approxCount: list.length,
            updatedAt: '2026-11-20T10:00:00.000Z',
          })
        }
        return out
      }),
    } as unknown as ProjectApi

    ;(window as unknown as { projectApi: ProjectApi }).projectApi = projectApi
    ;(window as unknown as { aiOfficeTabs: unknown }).aiOfficeTabs = {
      list: async () => [...surfaceTabs],
      onChanged: (fn: () => void) => {
        surfaceListener = fn
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
      kbList: async () => [],
      getSurfaceTabs: async () => surfaceTabs,
      onAiStream: () => () => {},
      aiStream: () => {},
      aiStreamCancel: () => {},
      askRunSnapshot: async () => null,
      askRunEvent: (evt: AskRunEvent) => emittedEvents.push(evt),
      onAskRunEvent: (fn: (evt: AskRunEvent) => void) => {
        runEventListener = fn
        return () => {
          runEventListener = null
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
    delete (window as unknown as { aiOffice?: unknown }).aiOffice
    delete (window as unknown as { projectApi?: unknown }).projectApi
    delete (window as unknown as { aiOfficeTabs?: unknown }).aiOfficeTabs
  })

  const mountPanel = (props: Partial<Parameters<typeof KbAskPanel>[0]> = {}): void => {
    act(() => {
      root.render(
        createElement(
          LocaleProvider,
          { initial: 'en' },
          createElement(KbAskPanel, {
            onOpenPath: () => {},
            onGoToRecents: () => {},
            onOpenModelSettings: () => {},
            onOpenScopeSettings: () => {},
            ...props,
          }),
        ),
      )
    })
  }

  it('rebinds unsaved draft chat to saved document path while keeping messages visible', async () => {
    chats.set('tab-u1', [
      { seq: 0, ts: '2026-11-20T10:00:00.000Z', role: 'user', text: 'Draft prompt kept' },
      { seq: 1, ts: '2026-11-20T10:00:01.000Z', role: 'assistant', text: 'Draft answer kept' },
    ])
    surfaceTabs = [{ id: 'u1', kind: 'docs', title: 'Untitled 1', active: true }]

    mountPanel()
    await flush()

    expect(host.textContent).toContain('Draft prompt kept')
    expect(host.textContent).toContain('Draft answer kept')

    // First save attaches filePath to the same tabId
    surfaceTabs = [
      { id: 'u1', kind: 'docs', title: 'SavedReport.docx', active: true, filePath: 'C:/SavedReport.docx' },
    ]
    await act(async () => {
      surfaceListener?.()
    })
    await flush()

    expect(rebindCalls).toEqual([
      { projectId: 'default', tempChatId: 'tab-u1', newFilePath: 'C:/SavedReport.docx' },
    ])
    expect(host.textContent).toContain('Draft prompt kept')
    expect(host.textContent).toContain('SavedReport.docx')
  })

  it('creates an extra scoped chat under active document and renders current doc section in drawer', async () => {
    const docPath = 'C:/Plans/Q4.docx'
    const primaryId = docHash(docPath)
    chats.set(primaryId, [
      { seq: 0, ts: '2026-11-20T09:00:00.000Z', role: 'user', text: 'Primary thread question' },
    ])
    metaByChat.set(primaryId, { docPath })
    surfaceTabs = [{ id: 'd1', kind: 'docs', title: 'Q4.docx', active: true, filePath: docPath }]

    mountPanel()
    await flush()

    // Open library drawer and click "+ New Chat"
    const libBtn = host.querySelector('.kb-ask-library-button') as HTMLButtonElement
    act(() => {
      libBtn.click()
    })
    await flush()

    expect(host.textContent).toContain('Current document')

    const newBtn = host.querySelector('.kb-ask-library-new') as HTMLButtonElement
    await act(async () => {
      newBtn.click()
    })
    await flush()

    expect(setMetaCalls.some((c) => c.docPath === docPath && c.chatId.startsWith(`${primaryId}-`))).toBe(true)
  })

  it('ignores mirror stream events addressed to a different sessionKey', async () => {
    const docA = 'C:/A.docx'
    const docB = 'C:/B.docx'
    chats.set(docHash(docA), [{ seq: 0, ts: '2026-11-20T09:00:00.000Z', role: 'user', text: 'Doc A' }])
    surfaceTabs = [{ id: 'a1', kind: 'docs', title: 'A.docx', active: true, filePath: docA }]

    mountPanel({ mirror: true })
    await flush()

    const wrongKey = sessionKeyOf('default', docHash(docB))
    const rightKey = sessionKeyOf('default', docHash(docA))

    await act(async () => {
      runEventListener?.({ type: 'user-message', sessionKey: wrongKey, payload: { role: 'user', text: 'Leaked B' } })
    })
    expect(host.textContent).not.toContain('Leaked B')

    await act(async () => {
      runEventListener?.({ type: 'user-message', sessionKey: rightKey, payload: { role: 'user', text: 'Accepted A' } })
    })
    expect(host.textContent).toContain('Accepted A')
  })

  it('keeps desktop workbench session alive across doc/browser switches and lets user explicitly switch to a doc chat', async () => {
    const docB = 'C:/Plans/DocB.md'
    const docBChatId = docHash(docB)
    chats.set('kb-ask', [
      { seq: 0, ts: '2026-11-20T09:00:00.000Z', role: 'user', text: 'Desktop workflow question' },
    ])
    chats.set(docBChatId, [
      { seq: 0, ts: '2026-11-20T09:05:00.000Z', role: 'user', text: 'Existing DocB thread note' },
    ])
    metaByChat.set(docBChatId, { docPath: docB })
    surfaceTabs = [{ id: 'home', kind: 'home', title: 'Home', active: true }]

    const setActiveCalls: Array<unknown> = []
    ;(window as unknown as { aiOffice: Record<string, unknown> }).aiOffice.setActiveAskSession = vi.fn(
      async (target: unknown) => {
        setActiveCalls.push(target)
        return { session: target, runningSessionKeys: [] }
      },
    )

    mountPanel({ mirror: true })
    await flush()
    expect(host.textContent).toContain('Desktop workflow question')
    expect(host.querySelector('[data-testid="kb-focused-context-bar"]')).toBeNull()

    // Switch to DocB tab: conversation stays on Home thread and streams without clearing.
    surfaceTabs = [{ id: 't-b', kind: 'markdown', title: 'DocB.md', filePath: docB, active: true }]
    await act(async () => {
      surfaceListener?.()
    })
    await flush()

    expect(host.textContent).toContain('Desktop workflow question')
    const chip = host.querySelector('[data-testid="kb-focused-context-chip"]')
    expect(chip?.textContent).toContain('DocB.md')

    // Stream event for kb-ask continues landing uninterrupted while viewing DocB.md.
    await act(async () => {
      runEventListener?.({
        type: 'text',
        sessionKey: 'default:kb-ask',
        seq: 11,
        payload: 'Streaming while DocB is visible',
      })
    })
    expect(host.textContent).toContain('Desktop workflow question')

    // Dismiss and restore focus attachment chip.
    act(() => {
      ;(host.querySelector('[data-testid="kb-focused-context-dismiss-btn"]') as HTMLButtonElement).click()
    })
    expect(host.querySelector('[data-testid="kb-focused-context-chip"]')).toBeNull()
    act(() => {
      ;(host.querySelector('[data-testid="kb-focused-context-restore-btn"]') as HTMLButtonElement).click()
    })
    expect(host.querySelector('[data-testid="kb-focused-context-chip"]')?.textContent).toContain('DocB.md')

    // Click one-click doc switcher to enter DocB's dedicated thread.
    const switchBtn = host.querySelector('[data-testid="kb-switch-doc-chat-btn"]') as HTMLButtonElement
    expect(switchBtn).toBeTruthy()
    await act(async () => {
      switchBtn.click()
    })
    await flush()

    expect(host.textContent).toContain('Existing DocB thread note')
    expect(host.querySelector('[data-testid="kb-focused-context-bound"]')).toBeTruthy()
    expect(setActiveCalls.at(-1)).toEqual({
      projectId: 'default',
      chatId: docBChatId,
      docPath: docB,
    })
  })

  it('deduplicates replayed stream events using snapshot eventSeq in mirror mode', async () => {
    const aiOffice = (window as unknown as { aiOffice: Record<string, unknown> }).aiOffice
    aiOffice.getActiveAskSession = async () => ({
      session: { projectId: 'default', chatId: 'kb-ask', docPath: null },
      runningSessionKeys: ['default:kb-ask'],
    })
    aiOffice.askRunSnapshot = async () => ({
      sessionKey: 'default:kb-ask',
      projectId: 'default',
      chatId: 'kb-ask',
      docPath: null,
      eventSeq: 10,
      messages: [
        { role: 'user', text: 'Open docs', toolNotes: [], artifacts: [] },
        {
          role: 'assistant',
          text: 'Initial snapshot text',
          toolNotes: [],
          activities: [],
          artifacts: [],
          streaming: true,
        },
      ],
      liveRun: { text: 'Initial snapshot text', reasoning: '', busy: true },
      confirmCard: null,
    })

    mountPanel({ mirror: true })
    await flush()
    expect(host.textContent).toContain('Initial snapshot text')

    // Event with seq <= 10 must be ignored so snapshot state is not overwritten backwards.
    await act(async () => {
      runEventListener?.({
        type: 'text',
        sessionKey: 'default:kb-ask',
        seq: 9,
        payload: 'Stale earlier text',
      })
    })
    expect(host.textContent).toContain('Initial snapshot text')
    expect(host.textContent).not.toContain('Stale earlier text')

    // Event with seq > 10 applies normally.
    await act(async () => {
      runEventListener?.({
        type: 'text',
        sessionKey: 'default:kb-ask',
        seq: 12,
        payload: 'Fresh newer text',
      })
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(host.textContent).toContain('Fresh newer text')
  })
})
