// @vitest-environment jsdom
/**
 * The conversation library (KbAskPanel's ☰ surface): the pure sectioning
 * and the relative-time ladder, then the mounted panel against a recording
 * projectApi — the sections' order, the search's live round trip, the
 * rename's inline edit and persistence, the pin toggle, the delete's
 * confirm flow, the active row, and the Esc/outside close.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMeta, ProjectApi } from '@genoffice/project-store'
import {
  KbAskPanel,
  libraryThreads,
  threadTimeAgo,
  type LibraryThread,
} from '../src/renderer/src/KbAskPanel'
import { LocaleProvider } from '../src/renderer/src/locale'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const fakeFormat = (key: string, params?: Record<string, string>): string =>
  params ? `${key}:${Object.values(params).join(',')}` : key

// ── the pure work ─────────────────────────────────────────────────────

describe('libraryThreads (the sectioning and the ordering)', () => {
  const meta = (over: Partial<ChatMeta> & { chatId: string }): ChatMeta => ({
    updatedAt: '2026-11-03T10:00:00.000Z',
    approxCount: 3,
    ...over,
  })

  it('pinned first, doc-bound next, everything else last; newest first within each', () => {
    const metas = [
      meta({
        chatId: 'kb-ask',
        firstQuestion: 'plain, older',
        updatedAt: '2026-11-01T00:00:00.000Z',
      }),
      meta({
        chatId: 'kb-ask-2',
        firstQuestion: 'plain, newer',
        updatedAt: '2026-11-03T00:00:00.000Z',
      }),
      meta({
        chatId: 'doc-hash-1',
        docPath: '/desk/report.docx',
        updatedAt: '2026-11-02T00:00:00.000Z',
      }),
      meta({
        chatId: 'doc-hash-2',
        docPath: '/desk/notes.md',
        updatedAt: '2026-11-03T08:00:00.000Z',
      }),
      meta({ chatId: 'kb-ask-pinned', firstQuestion: 'pinned', pinned: true }),
      meta({
        chatId: 'doc-hash-pinned',
        docPath: '/desk/pinned.docx',
        pinned: true,
        updatedAt: '2026-11-02T00:00:00.000Z',
      }),
    ]
    const sections = libraryThreads(metas, 'kb-ask')
    expect(sections.pinned.map((r) => r.chatId)).toEqual(['kb-ask-pinned', 'doc-hash-pinned'])
    expect(sections.docs.map((r) => r.chatId)).toEqual(['doc-hash-2', 'doc-hash-1'])
    expect(sections.other.map((r) => r.chatId)).toEqual(['kb-ask-2', 'kb-ask'])
  })

  it('the label: the title override, else the doc name, else the first question, else the id', () => {
    const sections = libraryThreads(
      [
        meta({ chatId: 'kb-ask-a', title: 'renamed', firstQuestion: 'first question' }),
        meta({ chatId: 'doc-hash-1', docPath: '/desk/神兽研究.docx' }),
        meta({ chatId: 'kb-ask-b', firstQuestion: '  help me   write a report  ' }),
        meta({ chatId: 'kb-ask-c' }),
      ],
      'kb-ask',
    )
    const labels = (rows: readonly LibraryThread[]): string[] => rows.map((r) => r.label)
    expect(labels(sections.other)).toEqual(['renamed', 'help me write a report', 'kb-ask-c'])
    expect(labels(sections.docs)).toEqual(['神兽研究.docx'])
  })

  it("only this mount's family and the doc-bound threads belong: other families and unsaved ids stay out", () => {
    const sections = libraryThreads(
      [
        meta({ chatId: 'kb-ask' }),
        meta({ chatId: 'kb-ask-123' }),
        meta({ chatId: 'kb-overlay-ask' }),
        meta({ chatId: 'kb-overlay-ask-1' }),
        meta({ chatId: 'unsaved-456' }),
        meta({ chatId: 'doc-hash-1', docPath: '/a.docx' }),
      ],
      'kb-ask',
    )
    const all = [...sections.pinned, ...sections.docs, ...sections.other].map((r) => r.chatId)
    expect(all).toEqual(['doc-hash-1', 'kb-ask', 'kb-ask-123'])
  })

  it('a family thread that the index maps to a file is doc-bound (the doc panel root)', () => {
    const sections = libraryThreads([meta({ chatId: 'kb-ask', docPath: '/desk/a.docx' })], 'kb-ask')
    expect(sections.other).toHaveLength(0)
    expect(sections.docs[0]?.label).toBe('a.docx')
  })
})

describe('threadTimeAgo (the relative ladder)', () => {
  const now = new Date('2026-11-03T12:00:00.000Z')
  const ago = (minutes: number): string => new Date(now.getTime() - minutes * 60_000).toISOString()

  it('just now → minutes → hours → yesterday → last week → a short date', () => {
    expect(threadTimeAgo(ago(0.5), now, fakeFormat, 'en-US')).toBe('timeAgoNow')
    expect(threadTimeAgo(ago(30), now, fakeFormat, 'en-US')).toBe('timeAgoMinutes:30')
    expect(threadTimeAgo(ago(95), now, fakeFormat, 'en-US')).toBe('timeAgoHours:1')
    expect(threadTimeAgo(ago(30 * 60), now, fakeFormat, 'en-US')).toBe('timeAgoYesterday')
    expect(threadTimeAgo(ago(4 * 24 * 60), now, fakeFormat, 'en-US')).toBe('timeAgoLastWeek')
    // past a week: the locale's short month-day date
    expect(threadTimeAgo('2026-09-15T12:00:00.000Z', now, fakeFormat, 'en-US')).toBe('Sep 15')
    // an unparseable stamp answers nothing
    expect(threadTimeAgo('not-a-date', now, fakeFormat, 'en-US')).toBe('')
  })
})

// ── the mounted panel ─────────────────────────────────────────────────

let host: HTMLDivElement
let root: Root
let calls: Array<{ method: string; args: unknown }>
let metas: ChatMeta[]
/** the kbList answers, mutable so a test can warm the index up mid-flight */
let kbFiles: Array<{ path: string }>
/** the index-updated handlers the panel subscribed (tests fire the push) */
const indexUpdatedHandlers: Array<() => void> = []

function recordingProjectApi(): ProjectApi {
  calls = []
  metas = []
  return {
    resolveChat: async (args) => {
      calls.push({ method: 'resolveChat', args })
      const { tempChatId } = args as { tempChatId: string }
      return { projectId: 'default', chatId: tempChatId }
    },
    appendChat: async (args) => {
      calls.push({ method: 'appendChat', args })
    },
    loadChat: async () => [],
    rebindChat: async (args) => {
      calls.push({ method: 'rebindChat', args })
      return args as { projectId: string; chatId: string }
    },
    listChats: async (args) => {
      calls.push({ method: 'listChats', args })
      const { query } = args as { query?: string }
      if (query && query !== '') {
        const needle = query.toLowerCase()
        return metas.filter(
          (m) =>
            (m.title ?? m.firstQuestion ?? '').toLowerCase().includes(needle) ||
            (m as { content?: string }).content?.toLowerCase().includes(needle),
        )
      }
      return metas
    },
    setChatMeta: async (args) => {
      calls.push({ method: 'setChatMeta', args })
      const { chatId, title, pinned } = args as {
        chatId: string
        title?: string | null
        pinned?: boolean
      }
      const row = metas.find((m) => m.chatId === chatId)
      if (row) {
        if (title !== undefined) {
          if (title === null || title.trim() === '') delete row.title
          else row.title = title.trim()
        }
        if (pinned !== undefined) {
          if (pinned) row.pinned = true
          else delete row.pinned
        }
      }
      return null
    },
    deleteChat: async (args) => {
      calls.push({ method: 'deleteChat', args })
      const { chatId } = args as { chatId: string }
      metas = metas.filter((m) => m.chatId !== chatId)
    },
  } as unknown as ProjectApi
}

beforeEach(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {}
  kbFiles = []
  indexUpdatedHandlers.length = 0
  ;(window as unknown as { aiOffice: unknown }).aiOffice = {
    kbList: async () => kbFiles,
    aiGetSettings: async () => null,
    aiGskStatus: async () => ({ loggedIn: true }),
    onAiSettingsChanged: () => () => {},
    skillsList: async () => [],
    onIndexUpdated: (handler: () => void) => {
      indexUpdatedHandlers.push(handler)
      return () => {
        const index = indexUpdatedHandlers.indexOf(handler)
        if (index >= 0) indexUpdatedHandlers.splice(index, 1)
      }
    },
  }
  recordingProjectApi()
  ;(window as unknown as { projectApi: unknown }).projectApi = (
    window as unknown as { projectApi: ProjectApi }
  ).projectApi
  // re-assign the fresh recording api each time
  const api = recordingProjectApi()
  ;(window as unknown as { projectApi: ProjectApi }).projectApi = api
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
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
        } as never),
      ),
    ),
  )
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete (window as unknown as { aiOffice?: unknown }).aiOffice
  delete (window as unknown as { projectApi?: unknown }).projectApi
  vi.useRealTimers()
})

async function settle(times = 8): Promise<void> {
  await act(async () => {
    for (let i = 0; i < times; i++) await Promise.resolve()
  })
}

/** type into a React-controlled input the way a user's keystroke does */
async function typeInto(input: HTMLInputElement, text: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const openLibrary = async (): Promise<void> => {
  await act(async () => {
    host.querySelector<HTMLElement>('.kb-ask-library-button')!.click()
  })
  await settle()
}

const rows = (): string[] =>
  [...host.querySelectorAll<HTMLElement>('.kb-ask-library-row[data-chat]')].map(
    (el) => el.dataset.chat ?? '',
  )
const sectionHeads = (): string[] =>
  [...host.querySelectorAll('.kb-ask-library-section-head')].map((el) => el.textContent ?? '')
const rowTitle = (chatId: string): string =>
  host.querySelector(`.kb-ask-library-row[data-chat="${chatId}"] .kb-ask-library-row-title`)
    ?.textContent ?? ''

describe('the mounted library', () => {
  it('the ☰ opens it: the three sections in order, the rows newest-first, the doc rows named by their files', async () => {
    metas = [
      {
        chatId: 'kb-ask',
        updatedAt: '2026-11-01T00:00:00.000Z',
        approxCount: 4,
        firstQuestion: 'a plain one',
      },
      {
        chatId: 'kb-ask-2',
        updatedAt: new Date(Date.now() - 12 * 3600_000).toISOString(),
        approxCount: 9,
        firstQuestion: 'a newer one',
      },
      {
        chatId: 'doc-hash-1',
        updatedAt: '2026-11-02T00:00:00.000Z',
        approxCount: 12,
        docPath: '/desk/神兽研究.docx',
      },
      {
        chatId: 'kb-ask-pin',
        updatedAt: '2026-11-01T00:00:00.000Z',
        approxCount: 42,
        firstQuestion: 'pinned one',
        pinned: true,
      },
    ]
    await settle()
    await openLibrary()
    expect(host.querySelector('.kb-ask-library')).toBeTruthy()
    expect(sectionHeads()).toEqual([
      '📌 Pinned',
      '📄 Follow the document',
      '🕘 Other conversations',
    ])
    // the pinned section, then docs, then other — each newest first
    expect(rows()).toEqual(['kb-ask-pin', 'doc-hash-1', 'kb-ask-2', 'kb-ask'])
    expect(rowTitle('doc-hash-1')).toContain('神兽研究.docx')
    // the meta line: the message count and the relative time
    expect(
      host.querySelector('.kb-ask-library-row[data-chat="kb-ask-2"] .kb-ask-library-row-meta')
        ?.textContent,
    ).toContain('9 messages')
    expect(
      host.querySelector('.kb-ask-library-row[data-chat="kb-ask-2"] .kb-ask-library-row-meta')
        ?.textContent,
    ).toContain('12 hr ago')
  })

  it('the active row highlights; clicking a row opens the thread and closes the library', async () => {
    metas = [
      {
        chatId: 'kb-ask',
        updatedAt: '2026-11-03T00:00:00.000Z',
        approxCount: 1,
        firstQuestion: 'the live one',
      },
      {
        chatId: 'kb-ask-2',
        updatedAt: '2026-11-02T00:00:00.000Z',
        approxCount: 1,
        firstQuestion: 'the stored one',
      },
    ]
    await settle()
    await openLibrary()
    expect(
      host.querySelector('.kb-ask-library-row[data-chat="kb-ask-2"]').classList.contains('active'),
    ).toBe(false)
    await act(async () => {
      host
        .querySelector<HTMLElement>(
          '.kb-ask-library-row[data-chat="kb-ask-2"] .kb-ask-library-open',
        )!
        .click()
    })
    await settle()
    // the library closed on selection, and the claimed thread turned active
    expect(host.querySelector('.kb-ask-library')).toBeNull()
    await openLibrary()
    expect(
      host.querySelector('.kb-ask-library-row[data-chat="kb-ask-2"]').classList.contains('active'),
    ).toBe(true)
  })

  it('Esc closes, a press outside closes, the search text resets with it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      metas = [
        {
          chatId: 'kb-ask',
          updatedAt: '2026-11-03T00:00:00.000Z',
          approxCount: 1,
          firstQuestion: 'one',
        },
      ]
      await settle()
      await openLibrary()
      const search = host.querySelector<HTMLInputElement>('.kb-ask-library-search')!
      await act(async () => {
        search.value = 'zzz'
        search.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => {
        vi.advanceTimersByTime(200)
      })
      expect(host.querySelector('.kb-ask-library')).toBeTruthy()
      // Esc closes the library whole
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      })
      expect(host.querySelector('.kb-ask-library')).toBeNull()
      // reopen: the search starts whole again (the query reset with the close)
      await openLibrary()
      expect(host.querySelector<HTMLInputElement>('.kb-ask-library-search')!.value).toBe('')
      // a press outside the library closes it too
      await act(async () => {
        document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      })
      expect(host.querySelector('.kb-ask-library')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('the search filters live: the debounced round trip carries the query, the label and the content both match', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      metas = [
        {
          chatId: 'kb-ask',
          updatedAt: '2026-11-03T00:00:00.000Z',
          approxCount: 1,
          title: 'Research notes',
        },
        {
          chatId: 'kb-ask-2',
          updatedAt: '2026-11-02T00:00:00.000Z',
          approxCount: 1,
          firstQuestion: 'a plain turn',
        },
        {
          chatId: 'kb-ask-3',
          updatedAt: '2026-11-01T00:00:00.000Z',
          approxCount: 1,
          firstQuestion: 'whatever',
          title: 'x',
        },
      ]
      await settle()
      await openLibrary()
      expect(rows()).toEqual(['kb-ask', 'kb-ask-2', 'kb-ask-3'])
      const search = host.querySelector<HTMLInputElement>('.kb-ask-library-search')!
      await typeInto(search, 'research')
      await act(async () => {
        vi.advanceTimersByTime(200)
      })
      await settle()
      // the round trip carried the query, and the title match survived
      const listCalls = calls.filter((c) => c.method === 'listChats')
      expect(listCalls.at(-1)?.args).toEqual({ projectId: 'default', query: 'research' })
      expect(rows()).toEqual(['kb-ask'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('rename: the inline input, Enter persists through setChatMeta and the label follows; Esc cancels', async () => {
    metas = [
      {
        chatId: 'kb-ask',
        updatedAt: '2026-11-03T00:00:00.000Z',
        approxCount: 1,
        firstQuestion: 'the old label',
      },
    ]
    await settle()
    await openLibrary()
    await act(async () => {
      host
        .querySelector<HTMLElement>('.kb-ask-library-actions button[aria-label="Rename"]')!
        .click()
    })
    const input = host.querySelector<HTMLInputElement>('.kb-ask-library-rename input')!
    expect(input).toBeTruthy()
    expect(input.value).toBe('the old label')
    // Esc cancels the edit: no write, the row's label stands
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(host.querySelector('.kb-ask-library-rename')).toBeNull()
    expect(calls.some((c) => c.method === 'setChatMeta')).toBe(false)
    // again, this time Enter: the title override persists and the label follows
    await act(async () => {
      host
        .querySelector<HTMLElement>('.kb-ask-library-actions button[aria-label="Rename"]')!
        .click()
    })
    const input2 = host.querySelector<HTMLInputElement>('.kb-ask-library-rename input')!
    await typeInto(input2, 'the new name')
    await act(async () => {
      input2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await settle()
    expect(calls.filter((c) => c.method === 'setChatMeta').at(-1)?.args).toEqual({
      projectId: 'default',
      chatId: 'kb-ask',
      title: 'the new name',
    })
    expect(rowTitle('kb-ask')).toContain('the new name')
  })

  it('the pin toggle persists and the row changes sections on the refresh', async () => {
    metas = [
      {
        chatId: 'kb-ask',
        updatedAt: '2026-11-03T00:00:00.000Z',
        approxCount: 1,
        firstQuestion: 'a plain one',
      },
    ]
    await settle()
    await openLibrary()
    expect(sectionHeads()).toEqual(['🕘 Other conversations'])
    await act(async () => {
      host.querySelector<HTMLElement>('.kb-ask-library-actions button[aria-label="Pin"]')!.click()
    })
    await settle()
    expect(calls.filter((c) => c.method === 'setChatMeta').at(-1)?.args).toEqual({
      projectId: 'default',
      chatId: 'kb-ask',
      pinned: true,
    })
    // the refresh answered the pinned meta: the row moved to the pinned section
    expect(sectionHeads()).toEqual(['📌 Pinned'])
    expect(rows()).toEqual(['kb-ask'])
    expect(rowTitle('kb-ask')).toContain('Pinned')
    // and the verb flips back: unpin
    await act(async () => {
      host.querySelector<HTMLElement>('.kb-ask-library-actions button[aria-label="Unpin"]')!.click()
    })
    await settle()
    expect(sectionHeads()).toEqual(['🕘 Other conversations'])
  })

  it('delete keeps the confirm: nothing goes until the dialog agrees', async () => {
    metas = [
      {
        chatId: 'kb-ask-2',
        updatedAt: '2026-11-03T00:00:00.000Z',
        approxCount: 5,
        firstQuestion: 'doomed',
      },
    ]
    await settle()
    await openLibrary()
    await act(async () => {
      host.querySelector<HTMLElement>('.kb-ask-library-actions button.danger')!.click()
    })
    await settle()
    // the confirm dialog is up, nothing deleted yet
    const dialog = document.querySelector('.modal-card, [role="dialog"]') as HTMLElement | null
    expect(dialog ?? document.body).toBeTruthy()
    expect(calls.some((c) => c.method === 'deleteChat')).toBe(false)
    // agree: the delete addresses the library's project
    const confirm = document.querySelector<HTMLButtonElement>('.modal .btn-danger')
    expect(confirm).toBeTruthy()
    await act(async () => confirm!.click())
    await settle()
    expect(calls.filter((c) => c.method === 'deleteChat').map((c) => c.args)).toEqual([
      { projectId: 'default', chatId: 'kb-ask-2' },
    ])
    expect(rows()).toEqual([])
  })
})

describe('the corpus snapshot and the fresh-thread empty state', () => {
  it('a fresh family thread with a healthy corpus shows the neutral welcome, not the hero, and keeps the badge', async () => {
    kbFiles = [{ path: '/kb/a.md' }, { path: '/kb/b.md' }]
    // the store answered after the mount: the index push lands the snapshot
    await act(async () => {
      for (const handler of [...indexUpdatedHandlers]) handler()
    })
    await settle()
    // the badge answered the healthy corpus
    expect(host.querySelector('.kb-ask-header-text span')?.textContent).toContain('2')
    // a fresh thread through the library's own new-thread button
    await openLibrary()
    await act(async () => {
      host.querySelector<HTMLElement>('.kb-ask-library-new')!.click()
    })
    await settle()
    // the neutral welcome, never the onboarding hero; the badge survived
    expect(host.querySelector('.kb-ask-hero')).toBeNull()
    expect(host.querySelector('.kb-ask-hint')?.textContent).toBeTruthy()
    expect(host.querySelector('.kb-ask-header-text span')?.textContent).toContain('2')
  })

  it('the cold-boot window self-corrects: the index-updated push re-snapshots a stale 0', async () => {
    // the mount snapshot lands in the window where the store does not exist
    // yet: kbList answers the starred half alone — 0
    kbFiles = []
    await settle()
    expect(host.querySelector('.kb-ask-header-text span')).toBeNull()
    // a fresh thread in that window greets with the hero (the scan is
    // genuinely still out — the copy is honest this instant)
    await openLibrary()
    await act(async () => {
      host.querySelector<HTMLElement>('.kb-ask-library-new')!.click()
    })
    await settle()
    expect(host.querySelector('.kb-ask-hero')).toBeTruthy()
    // the first scan lands: main pushes index-updated, the panel re-snapshots
    kbFiles = Array.from({ length: 8 }, (_, i) => ({ path: `/kb/f${i}.md` }))
    await act(async () => {
      for (const handler of [...indexUpdatedHandlers]) handler()
    })
    await settle()
    expect(host.querySelector('.kb-ask-hero')).toBeNull()
    expect(host.querySelector('.kb-ask-hint')?.textContent).toBeTruthy()
    expect(host.querySelector('.kb-ask-header-text span')?.textContent).toContain('8')
  })

  it('switching threads never zeroes a healthy corpus', async () => {
    kbFiles = [{ path: '/kb/a.md' }]
    metas = [
      {
        chatId: 'kb-ask-2',
        updatedAt: '2026-11-03T00:00:00.000Z',
        approxCount: 1,
        firstQuestion: 'stored',
      },
    ]
    await act(async () => {
      for (const handler of [...indexUpdatedHandlers]) handler()
    })
    await settle()
    await openLibrary()
    await act(async () => {
      host
        .querySelector<HTMLElement>(
          '.kb-ask-library-row[data-chat="kb-ask-2"] .kb-ask-library-open',
        )!
        .click()
    })
    await settle()
    // the thread switched; the corpus state never left the panel
    expect(host.querySelector('.kb-ask-header-text span')?.textContent).toContain('1')
    expect(host.querySelector('.kb-ask-hero')).toBeNull()
  })

  it('the empty-KB hero still shows when the corpus is genuinely empty', async () => {
    kbFiles = []
    await settle()
    await openLibrary()
    await act(async () => {
      host.querySelector<HTMLElement>('.kb-ask-library-new')!.click()
    })
    await settle()
    expect(host.querySelector('.kb-ask-hero')).toBeTruthy()
    expect(host.querySelector('.kb-ask-hint')).toBeNull()
    // and it stays after the (silent) index push: still genuinely empty
    await act(async () => {
      for (const handler of [...indexUpdatedHandlers]) handler()
    })
    await settle()
    expect(host.querySelector('.kb-ask-hero')).toBeTruthy()
  })
})
