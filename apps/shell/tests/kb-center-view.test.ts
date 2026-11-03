// @vitest-environment jsdom
/**
 * The Knowledge Base center (KbCenterView + its strings): the sources list
 * with readiness, the recall test, the reindex verbs, and the i18n table's
 * parity. Driven through the real view with a stubbed aiOffice bridge — the
 * channels' own validation is pinned in home-ipc-kb.test.ts.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KbCenterView } from '../src/renderer/src/KbCenterView'
import { KB_CENTER_STRINGS } from '../src/renderer/src/kb-center-strings'
import { LocaleProvider } from '../src/renderer/src/locale'
import type { KbSourcesReport } from '../src/shared/home-api'
import type { Lang } from '@genoffice/i18n'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const REPORT: KbSourcesReport = {
  scanning: false,
  pending: 0,
  sources: [
    {
      kind: 'folder',
      path: '/kb/reports',
      name: 'reports',
      indexed: 12,
      errors: 1,
      status: 'error',
    },
    {
      kind: 'file',
      path: '/kb/notes.md',
      name: 'notes.md',
      indexed: 1,
      errors: 0,
      status: 'ready',
    },
  ],
  truncated: false,
}

let host: HTMLDivElement
let root: Root
let report: KbSourcesReport | null
let reportCalls: number
let recallQuery: { q: string; limit?: number } | null
let recallAnswer: Array<{ path: string; name: string; ext: string; snippet: string }>
let reindexCalls: Array<{ path?: string } | undefined>
let picked: string[]
let addFolderCalls: number
let removedRoots: string[]
let unstared: string[][]
let removedRecents: string[][]
const onOpenScopeSettings = vi.fn()

beforeEach(() => {
  report = REPORT
  reportCalls = 0
  recallQuery = null
  recallAnswer = [
    { path: '/kb/notes.md', name: 'notes.md', ext: 'md', snippet: '…the meeting decided…' },
  ]
  reindexCalls = []
  picked = ['/desk/new-notes.md']
  addFolderCalls = 0
  removedRoots = []
  unstared = []
  removedRecents = []
  onOpenScopeSettings.mockClear()
  ;(window as unknown as { aiOffice: unknown }).aiOffice = {
    kbSources: vi.fn(async () => {
      reportCalls += 1
      return report
    }),
    kbRecallTest: vi.fn(async (query: { q: string; limit?: number }) => {
      recallQuery = query
      return recallAnswer
    }),
    kbReindex: vi.fn(async (request: { path?: string }) => {
      reindexCalls.push(request)
      return { removed: 2 }
    }),
    kbPickSourceFiles: vi.fn(async () => picked),
    addFolderRoot: vi.fn(async () => {
      addFolderCalls += 1
      return null
    }),
    removeFolderRoot: vi.fn(async (path: string) => {
      removedRoots.push(path)
    }),
    unstarPaths: vi.fn(async (paths: string[]) => {
      unstared.push(paths)
    }),
    removeRecent: vi.fn(async (paths: string[]) => {
      removedRecents.push(paths)
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
})

function render(lang: Lang = 'en'): void {
  act(() =>
    root.render(
      createElement(
        LocaleProvider,
        { initial: lang },
        createElement(KbCenterView, { lang, onOpenScopeSettings }),
      ),
    ),
  )
}

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

describe('the sources list', () => {
  it('renders every source with its readiness label and the folder counts', async () => {
    render()
    await settle()
    const rows = [...host.querySelectorAll('.kb-center-source')]
    expect(rows).toHaveLength(2)
    const folder = rows[0]!
    expect(folder.querySelector('.kb-center-source-name')?.textContent).toBe('reports')
    expect(folder.querySelector('.kb-center-source-status')?.textContent).toBe('Has errors')
    expect(folder.querySelector('.kb-center-source-counts')?.textContent).toBe(
      '12 files indexed · 1 failed',
    )
    const file = rows[1]!
    expect(file.querySelector('.kb-center-source-status')?.textContent).toBe('Ready')
    expect(file.querySelector('.kb-center-source-counts')).toBeNull()
    // the header names what the surface is for
    expect(host.querySelector('.kb-center-header p')?.textContent).toContain(
      'Ask AI searches and cites these sources',
    )
  })

  it('the scanning banner shows while the pipeline runs; the empty state when nothing exists', async () => {
    // fake timers BEFORE the mount: the poll's interval must be a fake one
    // so flipping the store's answer and advancing time lands the next pull
    vi.useFakeTimers()
    try {
      report = { scanning: true, pending: 7, sources: [], truncated: false }
      render()
      await act(async () => {
        for (let i = 0; i < 6; i++) await Promise.resolve()
      })
      expect(host.querySelector('.kb-center-scanning')?.textContent).toContain('7')
      report = { scanning: false, pending: 0, sources: [], truncated: false }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1600)
        for (let i = 0; i < 6; i++) await Promise.resolve()
      })
      // the poll's last pull flipped the state: no banner, the honest empty
      expect(host.querySelector('.kb-center-scanning')).toBeNull()
      expect(host.querySelector('.kb-center-sources-empty')?.textContent).toContain(
        'No sources yet',
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('the remove verb: a folder leaves the knowledge roots; a file leaves the corpus (unstar + un-recent)', async () => {
    render()
    await settle()
    const verbs = (row: Element) =>
      [...row.querySelectorAll('.kb-center-source-verb')] as HTMLButtonElement[]
    verbs(host.querySelectorAll('.kb-center-source')[0]!).at(-1)!.click()
    await settle()
    expect(removedRoots).toEqual(['/kb/reports'])
    expect(unstared).toEqual([])
    verbs(host.querySelectorAll('.kb-center-source')[1]!).at(-1)!.click()
    await settle()
    expect(unstared).toEqual([['/kb/notes.md']])
    expect(removedRecents).toEqual([['/kb/notes.md']])
    expect(removedRoots).toEqual(['/kb/reports']) // the file never touched the roots
    // every verb refreshes the report
    expect(reportCalls).toBeGreaterThanOrEqual(3)
  })

  it('the add verbs: folder picker and the star-onboarding file picker', async () => {
    render()
    await settle()
    const buttons = [...host.querySelectorAll('.kb-center-verbs button')] as HTMLButtonElement[]
    buttons.find((b) => b.textContent === 'Add folder…')!.click()
    await settle()
    expect(addFolderCalls).toBe(1)
    buttons.find((b) => b.textContent === 'Add files…')!.click()
    await settle()
    expect(
      (window.aiOffice as unknown as { kbPickSourceFiles: { mock: { calls: unknown[][] } } })
        .kbPickSourceFiles.mock.calls,
    ).toHaveLength(1)
  })
})

describe('the reindex verbs', () => {
  it("the global verb reindexes with no path; a source's verb carries its path", async () => {
    render()
    await settle()
    const buttons = [...host.querySelectorAll('.kb-center-verbs button')] as HTMLButtonElement[]
    buttons.find((b) => b.textContent === 'Rebuild everything')!.click()
    await settle()
    expect(reindexCalls[0]).toEqual({})
    const row = host.querySelectorAll('.kb-center-source')[0]!
    ;([...row.querySelectorAll('.kb-center-source-verb')] as HTMLButtonElement[])
      .find((b) => b.textContent === 'Rebuild index')!
      .click()
    await settle()
    expect(reindexCalls[1]).toEqual({ path: '/kb/reports' })
  })
})

describe('the recall test', () => {
  it('runs the query and renders the hits as excerpts with names', async () => {
    render()
    await settle()
    const input = host.querySelector<HTMLInputElement>('.kb-center-recall-form input')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'meeting decision')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      ;(
        [...host.querySelectorAll('.kb-center-recall-form button')] as HTMLButtonElement[]
      )[0]!.click()
    })
    await settle()
    expect(recallQuery).toEqual({ q: 'meeting decision', limit: 5 })
    expect(host.querySelector('.kb-center-recall-count')?.textContent).toContain('1 hits')
    expect(host.querySelector('.kb-center-recall-path')?.textContent).toBe('notes.md')
    expect(host.querySelector('.kb-center-recall-snippet')?.textContent).toContain(
      'the meeting decided',
    )
  })

  it('the no-hit answer names the honest outcome; Enter submits', async () => {
    recallAnswer = []
    render()
    await settle()
    const input = host.querySelector<HTMLInputElement>('.kb-center-recall-form input')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'zzz')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
    })
    await settle()
    expect(recallQuery?.q).toBe('zzz')
    expect(host.querySelector('.kb-center-recall-count')?.textContent).toContain(
      'Nothing retrieved',
    )
    expect(host.querySelector('.kb-center-recall-hits')).toBeNull()
  })
})

describe('the scope settings entry', () => {
  it('the link opens the settings section that already owns the scope', async () => {
    render()
    await settle()
    ;(host.querySelector('.kb-center-scope-link') as HTMLButtonElement).click()
    expect(onOpenScopeSettings).toHaveBeenCalledTimes(1)
  })
})

describe('the i18n table', () => {
  it('every supported locale carries the full key set, nothing empty', () => {
    const keys = Object.keys(KB_CENTER_STRINGS.en).sort()
    expect(keys.length).toBeGreaterThan(10)
    for (const lang of Object.keys(KB_CENTER_STRINGS) as Lang[]) {
      const table = KB_CENTER_STRINGS[lang] as unknown as Record<string, unknown>
      for (const key of keys) {
        expect(
          typeof table[key] === 'string' && (table[key] as string).length > 0,
          `${lang}.${key}`,
        ).toBe(true)
      }
    }
    // 21 locales shipped
    expect(Object.keys(KB_CENTER_STRINGS)).toHaveLength(21)
  })
})
