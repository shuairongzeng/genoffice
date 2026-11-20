// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, GlobalChatMeta, ProjectApi } from '@genoffice/project-store'
import { LocaleProvider } from '../src/renderer/src/locale'
import {
  SessionsCenterView,
  filterAndSortSessions,
  formatSessionMarkdown,
} from '../src/renderer/src/SessionsCenterView'
import type { SessionTarget } from '../src/renderer/src/ask-session-binding'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SAMPLE_METAS: GlobalChatMeta[] = [
  {
    projectId: 'p1',
    projectName: 'Workspace',
    chatId: 'doc-1',
    docPath: 'C:/Docs/Report.docx',
    docExists: true,
    pinned: true,
    firstQuestion: 'Summarize report',
    lastMessagePreview: 'Here is the summary.',
    messageCount: 8,
    approxCount: 8,
    updatedAt: '2026-11-20T10:00:00.000Z',
  },
  {
    projectId: 'p1',
    projectName: 'Workspace',
    chatId: 'doc-missing',
    docPath: 'C:/Docs/Deleted.docx',
    docExists: false,
    pinned: false,
    firstQuestion: 'Old notes',
    lastMessagePreview: 'Archived point',
    messageCount: 2,
    approxCount: 2,
    updatedAt: '2026-11-18T10:00:00.000Z',
  },
  {
    projectId: 'default',
    projectName: 'Default',
    chatId: 'kb-ask',
    docExists: true,
    pinned: false,
    firstQuestion: 'Free question',
    lastMessagePreview: 'Free reply',
    messageCount: 12,
    approxCount: 12,
    updatedAt: '2026-11-19T10:00:00.000Z',
  },
]

describe('SessionsCenterView helpers', () => {
  it('filters by category and sorts pinned first then recent or messageCount', () => {
    expect(filterAndSortSessions(SAMPLE_METAS, 'docs', 'recent').map((m) => m.chatId)).toEqual([
      'doc-1',
      'doc-missing',
    ])
    expect(filterAndSortSessions(SAMPLE_METAS, 'free', 'recent').map((m) => m.chatId)).toEqual([
      'kb-ask',
    ])
    expect(filterAndSortSessions(SAMPLE_METAS, 'pinned', 'recent').map((m) => m.chatId)).toEqual([
      'doc-1',
    ])
    expect(filterAndSortSessions(SAMPLE_METAS, 'missing', 'recent').map((m) => m.chatId)).toEqual([
      'doc-missing',
    ])
    expect(filterAndSortSessions(SAMPLE_METAS, 'all', 'messages').map((m) => m.chatId)).toEqual([
      'doc-1',
      'kb-ask',
      'doc-missing',
    ])
  })

  it('formats a transcript into clean Markdown with document link and turn headings', () => {
    const md = formatSessionMarkdown(
      SAMPLE_METAS[0],
      [
        { seq: 0, ts: '2026-11-20T10:00:00.000Z', role: 'user', text: 'Hello doc' },
        { seq: 1, ts: '2026-11-20T10:00:01.000Z', role: 'assistant', text: 'Hi there' },
      ],
      { user: 'You', assistant: 'AI', doc: 'Document' },
    )
    expect(md).toContain('# Report.docx')
    expect(md).toContain('> Document: `C:/Docs/Report.docx`')
    expect(md).toContain('## You\n\nHello doc')
    expect(md).toContain('## AI\n\nHi there')
  })
})

describe('SessionsCenterView component', () => {
  let host: HTMLDivElement
  let root: Root
  let sessionsData: GlobalChatMeta[]
  let transcripts: Map<string, ChatMessage[]>
  let setChatMetaMock: ReturnType<typeof vi.fn>
  let deleteChatsMock: ReturnType<typeof vi.fn>
  let onOpenSession: ReturnType<typeof vi.fn<(target: SessionTarget) => void>>

  const flush = async (ticks = 6): Promise<void> => {
    for (let i = 0; i < ticks; i++) {
      await act(async () => {
        await Promise.resolve()
      })
    }
  }

  beforeEach(() => {
    sessionsData = SAMPLE_METAS.map((m) => ({ ...m }))
    transcripts = new Map([
      [
        'p1:doc-1',
        [
          { seq: 0, ts: '2026-11-20T10:00:00.000Z', role: 'user', text: 'User asks A' },
          { seq: 1, ts: '2026-11-20T10:00:01.000Z', role: 'assistant', text: 'Assistant answers A' },
        ],
      ],
      [
        'p1:doc-missing',
        [{ seq: 0, ts: '2026-11-18T10:00:00.000Z', role: 'user', text: 'Missing file ask' }],
      ],
    ])
    setChatMetaMock = vi.fn(async () => null)
    deleteChatsMock = vi.fn(async (args: { targets: Array<{ projectId: string; chatId: string }> }) => {
      const drop = new Set(args.targets.map((t) => `${t.projectId}:${t.chatId}`))
      sessionsData = sessionsData.filter((m) => !drop.has(`${m.projectId}:${m.chatId}`))
      return { deleted: args.targets.length }
    })
    onOpenSession = vi.fn()

    const projectApi = {
      listAllChats: vi.fn(async (args?: { query?: string }) => {
        const q = args?.query?.toLowerCase() ?? ''
        return sessionsData.filter(
          (m) =>
            !q ||
            (m.title ?? '').toLowerCase().includes(q) ||
            (m.docPath ?? '').toLowerCase().includes(q) ||
            (m.firstQuestion ?? '').toLowerCase().includes(q),
        )
      }),
      loadChat: vi.fn(async (args: { projectId: string; chatId: string }) => {
        return [...(transcripts.get(`${args.projectId}:${args.chatId}`) ?? [])]
      }),
      setChatMeta: setChatMetaMock,
      deleteChats: deleteChatsMock,
      deleteChat: vi.fn(async () => undefined),
    } as unknown as ProjectApi

    ;(window as unknown as { projectApi: ProjectApi }).projectApi = projectApi
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    delete (window as unknown as { projectApi?: unknown }).projectApi
  })

  const renderView = (): void => {
    act(() => {
      root.render(
        createElement(
          LocaleProvider,
          { initial: 'en' },
          createElement(SessionsCenterView, { onOpenSession }),
        ),
      )
    })
  }

  it('loads sessions, previews transcript, supports open-doc jump, rename, filter, and batch delete', async () => {
    renderView()
    await flush()

    // First item (pinned Report.docx) auto-selected with transcript preview
    expect(host.textContent).toContain('Report.docx')
    expect(host.textContent).toContain('User asks A')
    expect(host.textContent).toContain('Assistant answers A')

    // Clicking primary button triggers onOpenSession with target session
    const openBtn = host.querySelector('.sessions-center-primary-btn') as HTMLButtonElement
    act(() => {
      openBtn.click()
    })
    expect(onOpenSession).toHaveBeenCalledWith({
      projectId: 'p1',
      chatId: 'doc-1',
      docPath: 'C:/Docs/Report.docx',
    })

    // Pin toggle & inline rename both call setChatMeta with the row projectId/chatId
    const actionBtns = Array.from(
      host.querySelectorAll('.sessions-center-action-btn'),
    ) as HTMLButtonElement[]
    const unpinBtn = actionBtns.find((b) => b.textContent === 'Unpin')!
    await act(async () => {
      unpinBtn.click()
    })
    await flush()
    expect(setChatMetaMock).toHaveBeenCalledWith({
      projectId: 'p1',
      chatId: 'doc-1',
      pinned: false,
    })

    const renameBtn = Array.from(
      host.querySelectorAll('.sessions-center-action-btn'),
    ).find((b) => b.textContent === 'Rename') as HTMLButtonElement
    act(() => {
      renameBtn.click()
    })
    await flush()
    const renameInput = host.querySelector('.sessions-center-rename-row input') as HTMLInputElement
    const saveRenameBtn = host.querySelector('.sessions-center-rename-row button') as HTMLButtonElement
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        renameInput,
        'Q4 Executive Summary',
      )
      renameInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      saveRenameBtn.click()
    })
    await flush()
    expect(setChatMetaMock).toHaveBeenCalledWith({
      projectId: 'p1',
      chatId: 'doc-1',
      title: 'Q4 Executive Summary',
    })

    // Switch filter to missing document sessions
    const filterButtons = Array.from(host.querySelectorAll('.sessions-center-filter')) as HTMLButtonElement[]
    const missingTab = filterButtons.find((b) => b.textContent === 'Missing file')!
    act(() => {
      missingTab.click()
    })
    await flush()
    expect(host.querySelectorAll('.sessions-center-item')).toHaveLength(1)
    expect(host.textContent).toContain('Missing file ask')

    // Enable batch management, select missing/empty, and delete with confirmation modal
    const toolButtons = Array.from(host.querySelectorAll('.sessions-center-tool-btn')) as HTMLButtonElement[]
    const batchBtn = toolButtons.find((b) => b.textContent === 'Batch select')!
    act(() => {
      batchBtn.click()
    })
    await flush()

    const selectMissingBtn = Array.from(host.querySelectorAll('.sessions-center-tool-btn')).find(
      (b) => b.textContent === 'Select empty/missing',
    ) as HTMLButtonElement
    act(() => {
      selectMissingBtn.click()
    })
    await flush()

    const batchDeleteBtn = host.querySelector('.sessions-center-tool-btn.danger') as HTMLButtonElement
    act(() => {
      batchDeleteBtn.click()
    })
    await flush()

    // Confirm inside ConfirmDialog modal
    const modalConfirm = host.querySelector('.modal-actions .danger') as HTMLButtonElement | null
    const fallbackConfirm =
      modalConfirm ??
      (Array.from(host.querySelectorAll('.modal button')).pop() as HTMLButtonElement)
    await act(async () => {
      fallbackConfirm.click()
    })
    await flush()

    expect(deleteChatsMock).toHaveBeenCalledWith({
      targets: [{ projectId: 'p1', chatId: 'doc-missing' }],
    })
  })
})
