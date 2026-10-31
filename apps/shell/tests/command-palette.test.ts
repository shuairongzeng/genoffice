/**
 * @vitest-environment jsdom
 */
import { act, createElement, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  FileSearchHit,
  FileSearchRerank,
  HomeApi,
  InstalledPlugin,
  RecentEntry,
  UserSkillEntry,
} from '../src/shared/home-api'
import type { PluginComponents } from '../src/shared/found-skill'
import { CommandPalette, folderOf, scoreMatch } from '../src/renderer/src/CommandPalette'
import {
  createAskAiProvider,
  createEditorCommandsProvider,
  createFilesProvider,
  createHelpTopicsProvider,
  createSettingsProvider,
  createTabsProvider,
  defaultPaletteProviders,
  mergePaletteRows,
  type PaletteContext,
  type PaletteProvider,
  type PaletteRow,
} from '../src/renderer/src/palette-providers'
import { COMMAND_PALETTE_STRINGS } from '../src/renderer/src/command-palette-strings'
import { loadStrings } from '../src/renderer/src/strings'
import type { SettingsTarget } from '../src/renderer/src/SettingsModal'
import type { TabSummary } from '../src/shared/tabs-api'

/**
 * The Ctrl/Cmd+K launcher. Everything it does goes through window.aiOffice:
 * the lists it reads on open, and the bridge action Enter fires. Esc and
 * backdrop clicks only ever call onClose.
 */

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let closed: number
let openedPaths: string[]
let created: string[]
let skillsSettingsOpened: number
let modelSettingsOpened: number
let pluginToggles: Array<[string, boolean]>
let askedQueries: string[]
/** settings rows route through the host instead of the bridge (issue #56) */
let settingsTargets: SettingsTarget[]
let openedHelpTopics: string[]
let editorCommandsRun: Array<[string, string, string | undefined]>
let tabActivations: string[]

const recent = (over: Partial<RecentEntry>): RecentEntry => ({
  path: 'C:\\Docs\\report.docx',
  name: 'report.docx',
  ext: 'docx',
  mtimeMs: 1,
  sizeBytes: 1,
  starred: false,
  ...over,
})

const hit = (over: Partial<FileSearchHit>): FileSearchHit => ({
  path: 'C:\\Docs\\hit.docx',
  name: 'hit.docx',
  ext: 'docx',
  mtimeMs: 1,
  sizeBytes: 1,
  starred: false,
  snippet: null,
  needles: [],
  ...over,
})

/** a provider context for driving the registry without mounting the palette */
const ctx = (over: Partial<PaletteContext> = {}): PaletteContext => ({
  strings: COMMAND_PALETTE_STRINGS.en,
  lang: 'en',
  recents: [],
  skills: [],
  plugins: [],
  onAskAi: () => {},
  openSettings: () => {},
  ...over,
})

const skill = (over: Partial<UserSkillEntry>): UserSkillEntry => ({
  name: 'pptx-builder',
  description: 'Build a deck',
  relevant: true,
  ...over,
})

const plugin = (
  over: Partial<InstalledPlugin> & { components?: Partial<PluginComponents> },
): InstalledPlugin => ({
  name: 'deck-tools',
  version: '1.0.0',
  description: 'Helpers for decks',
  author: 'someone',
  enabled: true,
  components: { skills: [], commands: [], mcpServers: [], ...over.components },
  format: 'claude',
  ...over,
})

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  closed = 0
  openedPaths = []
  created = []
  skillsSettingsOpened = 0
  modelSettingsOpened = 0
  pluginToggles = []
  askedQueries = []
  settingsTargets = []
  openedHelpTopics = []
  editorCommandsRun = []
  tabActivations = []
  // the tabs/commands providers must degrade when the bridge face is absent
  // — and no test may inherit the face the previous one installed: coverage
  // that depends on file order passes today and rots silently tomorrow
  ;(window as { aiOfficeTabs?: typeof window.aiOfficeTabs }).aiOfficeTabs = undefined
  ;(window as { aiOffice?: typeof window.aiOffice }).aiOffice = undefined
})

afterEach(async () => {
  // clear the files provider's pending debounce before unmount: an armed
  // 200ms timer would fire after jsdom teardown and read a torn-down
  // `window` (an uncaught ReferenceError that fails the whole run under
  // full-suite load). The empty query is the provider's cancel path.
  await act(async () => {
    const el = host.querySelector<HTMLInputElement>('.cmd-input')
    if (el) {
      const proto = window.HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, '')
      el.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    }
    root.unmount()
  })
  host.remove()
})

function mountApi(
  recentsList: RecentEntry[],
  skills: UserSkillEntry[] = [],
  plugins: InstalledPlugin[] = [],
): void {
  window.aiOffice = {
    recents: async () => ({
      entries: recentsList,
      total: recentsList.length,
      totalAll: recentsList.length,
    }),
    skillsList: async () => skills,
    pluginsList: async () => plugins,
    openPath: async (path: string) => {
      openedPaths.push(path)
    },
    browse: async () => {
      created.push('browse')
    },
    newDoc: async () => {
      created.push('doc')
    },
    newSheet: async () => {
      created.push('sheet')
    },
    newSlide: async () => {
      created.push('slide')
    },
    newMarkdown: async () => {
      created.push('markdown')
    },
    newHtml: async () => {
      created.push('html')
    },
    newPdf: async () => {
      created.push('pdf')
    },
    openSkillsSettings: async () => {
      skillsSettingsOpened += 1
    },
    openAiModelSettings: async () => {
      modelSettingsOpened += 1
    },
    openHelp: async (topic?: string) => {
      if (topic) openedHelpTopics.push(topic)
    },
    runEditorCommand: async (kind: string, command: string, tabId?: string) => {
      editorCommandsRun.push([kind, command, tabId])
    },
    pluginsSetEnabled: async (name: string, enabled: boolean) => {
      pluginToggles.push([name, enabled])
    },
  } as unknown as HomeApi
}

/** the open-tab strip the tabs and commands providers read */
const tabSummary = (
  over: Partial<TabSummary> & { id: string; kind: TabSummary['kind'] },
): TabSummary => ({
  title: 'A tab',
  closable: true,
  active: false,
  ...over,
})

function mountTabs(list: TabSummary[]): void {
  window.aiOfficeTabs = {
    list: async () => list,
    activate: async (id: string) => {
      tabActivations.push(id)
    },
  } as unknown as NonNullable<typeof window.aiOfficeTabs>
}

async function render(providers?: PaletteProvider[]): Promise<void> {
  await act(async () => {
    root.render(
      createElement(CommandPalette, {
        lang: 'en',
        onClose: () => (closed += 1),
        onAskAi: (q) => askedQueries.push(q),
        onOpenSettings: (target) => settingsTargets.push(target),
        ...(providers ? { providers } : {}),
      }),
    )
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** the palette's search input */
const input = (): HTMLInputElement => host.querySelector<HTMLInputElement>('.cmd-input')

/** the flat result rows, in visual order */
const rows = (): HTMLButtonElement[] => [...host.querySelectorAll<HTMLButtonElement>('.cmd-row')]

const activeRow = (): HTMLButtonElement | undefined =>
  host.querySelector<HTMLButtonElement>('.cmd-row.active')

const rowTitles = (): string[] =>
  rows().map((row) => row.querySelector('.cmd-row-title')?.textContent)

/** type into the search input through the native setter, so React's own value
 *  tracker registers the change and onChange fires */
function typeInto(text: string): void {
  const el = input()
  expect(el).toBeTruthy()
  const proto = window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, text)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function actType(text: string): Promise<void> {
  await act(async () => {
    typeInto(text)
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** one keydown on the search input, as the keyboard driver sends it */
async function press(key: string): Promise<void> {
  await act(async () => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function clickRow(title: string): Promise<void> {
  const row = rows().find((r) => r.textContent?.includes(title))
  expect(row).toBeTruthy()
  await act(async () => {
    row!.click()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('scoreMatch', () => {
  it('ranks a title prefix over a title substring, then a detail hit, then a subsequence', () => {
    const prefix = scoreMatch('sheet', 'sheet-maker', 'a skill')
    const inside = scoreMatch('sheet', 'New spreadsheet', '')
    const detail = scoreMatch('sheet', 'New file', 'AI Sheets · xlsx')
    const fuzzy = scoreMatch('nsp', 'New spreadsheet', '')
    expect(prefix).not.toBeNull()
    expect(inside).not.toBeNull()
    expect(detail).not.toBeNull()
    expect(fuzzy).not.toBeNull()
    expect(prefix!).toBeGreaterThan(inside!)
    expect(inside!).toBeGreaterThan(detail!)
    expect(detail!).toBeGreaterThan(fuzzy!)
  })

  it('matches case-insensitively and as a subsequence over the title', () => {
    expect(scoreMatch('SHEET', 'New spreadsheet', 'AI Sheets · xlsx')).not.toBeNull()
    // letters in order, not contiguous
    expect(scoreMatch('nssh', 'New spreadsheet', '')).not.toBeNull()
    // a letter missing breaks it
    expect(scoreMatch('nxw', 'New spreadsheet', '')).toBeNull()
  })

  it('scores every row as a match for an empty query', () => {
    expect(scoreMatch('', 'anything')).toBe(0)
    expect(scoreMatch('   ', 'anything')).toBe(0)
  })

  it('never matches text that lacks a character of the query', () => {
    expect(scoreMatch('表格', '新建文档', 'Word · docx')).toBeNull()
    expect(scoreMatch('表格', '新建表格', 'Sheet · xlsx')).not.toBeNull()
  })

  it('keeps CJK and mixed-script queries working through the detail line', () => {
    // typing "sheet" while the UI is Chinese still finds the spreadsheet action
    expect(scoreMatch('sheet', '新建表格', 'AI Sheets · xlsx')).not.toBeNull()
    expect(scoreMatch('表格', '新建表格', 'AI Sheets · xlsx')).not.toBeNull()
  })
})

describe('CommandPalette', () => {
  it('focuses the input on open', async () => {
    mountApi([])
    await render()
    expect(document.activeElement).toBe(input())
  })

  it('shows the create actions and the top 5 recents before anything is typed', async () => {
    mountApi(
      Array.from({ length: 8 }, (_, i) =>
        recent({ path: `C:\\Docs\\file-${i}.docx`, name: `file-${i}.docx` }),
      ),
    )
    await render()
    // the fixed create actions, in order
    expect(rowTitles().slice(0, 7)).toEqual([
      'New document',
      'New spreadsheet',
      'New presentation',
      'New Markdown',
      'New web page',
      'New PDF',
      'Open a local file…',
    ])
    // only the five newest recents ride along
    expect(rows().slice(7)).toHaveLength(5)
    expect(rowTitles()[7]).toBe('file-0.docx')
    expect(rowTitles()[11]).toBe('file-4.docx')
    // no skills, settings or plugins groups on an empty query
    expect(host.querySelector('.cmd-group-title')?.textContent).toBe('New')
    expect(host.querySelectorAll('.cmd-group-title')).toHaveLength(2)
  })

  it('typing filters the recents by file name', async () => {
    mountApi([
      recent({ path: 'C:\\Docs\\budget-2026.xlsx', name: 'budget-2026.xlsx', ext: 'xlsx' }),
      recent({ path: 'C:\\Docs\\report.docx', name: 'report.docx' }),
    ])
    await render()
    await actType('budget')
    // the recent match, then the natural-language fallback that never leaves a
    // non-empty query unanswered
    expect(rowTitles()).toEqual(['budget-2026.xlsx', 'Ask AI: budget'])
    // the folder rides on the row as its detail line
    expect(rows()[0]!.querySelector('.cmd-row-detail')?.textContent).toBe('C:\\Docs')
  })

  it('Enter opens the selected recent through openPath and closes', async () => {
    mountApi([
      recent({ path: 'C:\\Docs\\budget-2026.xlsx', name: 'budget-2026.xlsx', ext: 'xlsx' }),
    ])
    await render()
    await actType('budget')
    await press('Enter')
    expect(openedPaths).toEqual(['C:\\Docs\\budget-2026.xlsx'])
    expect(closed).toBe(1)
    expect(created).toEqual([])
  })

  it('Esc closes without running anything', async () => {
    mountApi([recent({})])
    await render()
    await actType('report')
    await press('Escape')
    expect(closed).toBe(1)
    expect(openedPaths).toEqual([])
    expect(created).toEqual([])
  })

  it('a backdrop click closes too', async () => {
    mountApi([recent({})])
    await render()
    const overlay = host.querySelector<HTMLElement>('.cmd-overlay')
    await act(async () => {
      overlay!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      await Promise.resolve()
    })
    expect(closed).toBe(1)
  })

  it('keyboard navigation moves and wraps over the whole flat list', async () => {
    mountApi(
      Array.from({ length: 3 }, (_, i) =>
        recent({ name: `file-${i}.docx`, path: `C:\\D\\file-${i}.docx` }),
      ),
    )
    await render()
    // 7 create actions + 3 recents = 10 rows, the first is active
    expect(rows()).toHaveLength(10)
    expect(activeRow()?.textContent).toContain('New document')
    // up from the first wraps to the last row (the third recent)
    await press('ArrowUp')
    expect(activeRow()?.textContent).toContain('file-2.docx')
    // up again steps within the recents
    await press('ArrowUp')
    expect(activeRow()?.textContent).toContain('file-1.docx')
    // down twice returns to the first create action, wrapping through the end
    await press('ArrowDown')
    await press('ArrowDown')
    expect(activeRow()?.textContent).toContain('New document')
    // the highlight follows the combobox's aria-activedescendant
    const activeIndex = rows().findIndex((row) => row === activeRow())
    expect(input().getAttribute('aria-activedescendant')).toBe(`cmd-opt-${activeIndex}`)
  })

  it('a query with no matches falls through to the Ask AI row, and Enter submits it', async () => {
    mountApi([recent({})])
    await render()
    await actType('zzz-no-match')
    // no empty state anymore: the fallback row is the one row that always answers
    expect(rows()).toHaveLength(1)
    expect(rowTitles()).toEqual(['Ask AI: zzz-no-match'])
    expect(host.querySelector('.cmd-empty')).toBeFalsy()
    // arrow keys cycle the single row and Enter hands the query to the host
    await press('ArrowDown')
    expect(activeRow()?.textContent).toContain('Ask AI')
    await press('Enter')
    expect(askedQueries).toEqual(['zzz-no-match'])
    expect(closed).toBe(1)
    expect(openedPaths).toEqual([])
  })

  it('lists installed skills and plugin components under Skills & commands', async () => {
    // the skill's name stays clear of the help vocabulary on purpose: this
    // is an exact row-list assertion, and the lazy help group contributes
    // whatever rows its matcher finds whenever its import lands — "outline"
    // matches no help title or keyword, so the list is stable whichever way
    // that race resolves
    mountApi(
      [],
      [skill({ name: 'brief-outline', description: 'Turn a brief into slide outlines' })],
      [plugin({ name: 'deck-tools', components: { skills: ['builder'], commands: ['deploy'] } })],
    )
    await render()
    await actType('outline')
    expect(host.textContent).toContain('Skills & commands')
    expect(rowTitles()).toEqual(['brief-outline', 'Ask AI: outline'])
    // a plugin's components surface as plugin:name entries, searched by name
    await actType('deck-tools:deploy')
    expect(rowTitles()).toEqual(['deck-tools:deploy', 'Ask AI: deck-tools:deploy'])
    expect(rows()[0]!.querySelector('.cmd-row-detail')?.textContent).toBe('Helpers for decks')
  })

  it('picking a skill opens the skills settings page (the ask view is not bridge-reachable)', async () => {
    mountApi([], [skill({ name: 'brief-outline' })])
    await render()
    await actType('outline')
    await press('Enter')
    expect(skillsSettingsOpened).toBe(1)
    expect(closed).toBe(1)
  })

  it('typing sheet offers the spreadsheet action, and Enter runs newSheet', async () => {
    mountApi([])
    await render()
    await actType('sheet')
    expect(rowTitles()).toContain('New spreadsheet')
    // navigate onto it: it is the top match for "sheet"
    expect(activeRow()?.textContent).toContain('New spreadsheet')
    await press('Enter')
    expect(created).toEqual(['sheet'])
    expect(closed).toBe(1)
  })

  it('jumping to the AI model settings routes through the host modal', async () => {
    // the settings group is a catalog now (issue #56 P0 #2), and every row
    // routes through onOpenSettings — the modal is a Home internal, not a
    // bridge call
    mountApi([])
    await render()
    await actType('model')
    expect(rowTitles()).toContain('AI model settings')
    await press('Enter')
    expect(settingsTargets).toEqual([{ section: 'aiModel' }])
    expect(closed).toBe(1)
    expect(modelSettingsOpened).toBe(0)
  })

  it('typing a setting by its own words lands on its settings row', async () => {
    // the issue's acceptance gate: Cmd+K typed with the localized word for
    // auto-save must reach the settings row — here in the en shard, "auto"
    // must reach the auto-save row and
    // Enter must open the general section it lives in
    await loadStrings('en')
    mountApi([])
    await render()
    await actType('auto')
    expect(rowTitles()).toContain('Auto-save all documents')
    await clickRow('Auto-save all documents')
    expect(settingsTargets).toEqual([{ section: 'general' }])
  })

  it('the settings catalog covers every section by its nav label', async () => {
    await loadStrings('en')
    mountApi([])
    await render()
    await actType('general')
    expect(rowTitles()).toContain('General')
    await clickRow('General')
    expect(settingsTargets).toEqual([{ section: 'general' }])
  })

  it('plugins list with a Disable chip, and Enter toggles them through the bridge', async () => {
    mountApi([], [], [plugin({ enabled: true }), plugin({ name: 'off-one', enabled: false })])
    await render()
    await actType('deck-tools')
    expect(rowTitles()).toEqual(['deck-tools', 'Ask AI: deck-tools'])
    expect(rows()[0]!.querySelector('.cmd-chip')?.textContent).toBe('Disable')
    await press('Enter')
    expect(pluginToggles).toEqual([['deck-tools', false]])
    expect(closed).toBe(1)
    // a disabled plugin offers the inverse action
    await actType('off-one')
    expect(rows()[0]!.querySelector('.cmd-chip')?.textContent).toBe('Enable')
  })

  it('clicking a row runs it, and hovering moves the highlight', async () => {
    mountApi([
      recent({ path: 'C:\\Docs\\a.docx', name: 'a.docx' }),
      recent({ path: 'C:\\Docs\\b.docx', name: 'b.docx' }),
    ])
    await render()
    expect(activeRow()?.textContent).toContain('New document')
    await act(async () => {
      rows()[8]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      await Promise.resolve()
    })
    expect(activeRow()?.textContent).toContain('b.docx')
    await clickRow('b.docx')
    expect(openedPaths).toEqual(['C:\\Docs\\b.docx'])
    expect(closed).toBe(1)
  })

  it('the Ask AI fallback never shows on an empty query', async () => {
    mountApi([recent({})])
    await render()
    expect(rowTitles().some((title) => title.startsWith('Ask AI'))).toBe(false)
    expect(host.querySelector('.cmd-empty')).toBeFalsy()
  })

  it('the fallback row carries its hint as the detail line', async () => {
    mountApi([recent({})])
    await render()
    await actType('zzz-no-match')
    expect(rowTitles()).toEqual(['Ask AI: zzz-no-match'])
    expect(rows()[0]!.querySelector('.cmd-row-detail')?.textContent).toBe(
      'Send this question to the Ask AI panel',
    )
  })

  it('dims a missing recent but Enter still tries to open it', async () => {
    mountApi([recent({ name: 'gone.docx', path: 'C:\\Docs\\gone.docx', missing: true })])
    await render()
    await actType('gone')
    expect(rows()[0]!.className).toContain('missing')
    expect(rows()[0]!.querySelector('.cmd-row-detail')?.textContent).toBe('File unavailable')
    await press('Enter')
    expect(openedPaths).toEqual(['C:\\Docs\\gone.docx'])
  })

  it('caps the result list at 50 rows in the fixed group order', async () => {
    mountApi(
      Array.from({ length: 80 }, (_, i) =>
        recent({ path: `C:\\Docs\\num-${i}.docx`, name: `num-${i}.docx` }),
      ),
      [skill({ name: 'num-skill', description: '' })],
    )
    await render()
    await actType('num')
    expect(rows()).toHaveLength(50)
    // the create group leads, then recents; the skill lands after 7 + 43 rows
    expect(rowTitles()[0]).toContain('New')
    expect(host.querySelectorAll('.cmd-group-title')[0]!.textContent).toBe('New')
    expect(host.querySelectorAll('.cmd-group-title')[1]!.textContent).toBe('Recent files')
    expect(rowTitles().includes('num-skill')).toBe(false)
  })

  it('a late-landing source must not blank the tabs group the reader is in', async () => {
    // the query effect re-runs whenever any dependency changes — recents
    // landing after the tabs answered is one such re-run. The tabs slot seeds
    // with what it answered for this same query, so the group survives even
    // when the refetch cannot land (a bridge that has gone quiet mid-overlay)
    mountApi([])
    let releaseRecents: ((value: RecentEntry[]) => void) | undefined
    window.aiOffice.recents = (async () => {
      const entries = await new Promise<RecentEntry[]>((resolve) => {
        releaseRecents = resolve
      })
      return { entries, total: entries.length, totalAll: entries.length }
    }) as HomeApi['recents']
    let tabsBridgeQuiet = false
    const openTabs = [tabSummary({ id: 'd1', kind: 'docs', title: 'letter.docx', lastActiveAt: 1 })]
    window.aiOfficeTabs = {
      list: async () => (tabsBridgeQuiet ? await new Promise<typeof openTabs>(() => {}) : openTabs),
      activate: async () => {},
    } as unknown as NonNullable<typeof window.aiOfficeTabs>
    await render()
    await actType('letter')
    expect(rowTitles()).toContain('letter.docx')
    // the recents answer lands late, re-running the effect for the same query
    // — and the tabs refetch now hangs forever
    tabsBridgeQuiet = true
    await act(async () => {
      releaseRecents?.([])
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(rowTitles()).toContain('letter.docx')
  })

  it('a stale answer from an older run cannot poison the seeded rows', async () => {
    // two runs of the same query can both have promises in flight (recents
    // landing re-runs the effect). The older run's late resolution is
    // seq-discarded from the screen — and it must stay out of the seeding
    // cache too, or the next re-run would regress the rows to a stale
    // snapshot (a closed tab reappearing in the switcher). Only the tabs
    // provider is mounted, so the deferred slots below are its own calls —
    // the commands provider would issue its own listTabs per run
    const onlyTabs = [createTabsProvider()]
    mountApi([])
    // every async source is held so the effect runs exactly when the test
    // says so: recents release once, skills and plugins never land
    let releaseRecents: ((value: RecentEntry[]) => void) | undefined
    window.aiOffice.recents = (async () => {
      const entries = await new Promise<RecentEntry[]>((resolve) => {
        releaseRecents = resolve
      })
      return { entries, total: entries.length, totalAll: entries.length }
    }) as HomeApi['recents']
    window.aiOffice.skillsList = (() => new Promise<never>(() => {})) as HomeApi['skillsList']
    window.aiOffice.pluginsList = (() => new Promise<never>(() => {})) as HomeApi['pluginsList']
    const deferred: Array<(value: TabSummary[]) => void> = []
    window.aiOfficeTabs = {
      list: () => new Promise<TabSummary[]>((resolve) => deferred.push(resolve)),
      activate: async () => {},
    } as unknown as NonNullable<typeof window.aiOfficeTabs>
    const letterTab = [
      tabSummary({ id: 'd1', kind: 'docs', title: 'letter.docx', lastActiveAt: 1 }),
    ]
    await render(onlyTabs)
    // the mount-run answer for the empty query
    deferred[0]!(letterTab)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    await actType('letter')
    // the 'letter' run's request is slow; recents landing re-runs the effect,
    // and the newer run's own answer lands first
    await act(async () => {
      releaseRecents?.([])
      await Promise.resolve()
      await Promise.resolve()
    })
    // the run count is pinned before indexing by it: if React's act ever
    // stopped draining the recents re-run inside the block above, the last
    // slot would be run 2's and the "stale" resolution below would silently
    // land on an already-settled promise — the test would pass vacuously
    expect(deferred).toHaveLength(3)
    deferred[deferred.length - 1]!(letterTab)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(rowTitles()).toContain('letter.docx')
    // now the older run resolves — late, with an out-of-date tab list
    deferred[1]!([tabSummary({ id: 'd0', kind: 'docs', title: 'old.docx', lastActiveAt: 1 })])
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(rowTitles()).toContain('letter.docx')
    // a re-render with fresh prop identities re-runs the effect once more;
    // what it seeds must be the current answer, never the stale one
    await render(onlyTabs)
    expect(rowTitles()).toContain('letter.docx')
    expect(rowTitles()).not.toContain('old.docx')
  })

  it('a whitespace-only edit re-seeds the landed group instead of blanking it', async () => {
    // "letter" -> "letter " is not a new question: the effect re-runs (the
    // raw query is a dependency) and the tabs slot must seed from the
    // trimmed-key cache while the refetch is still in flight
    mountApi([])
    let tabsBridgeQuiet = false
    const openTabs = [tabSummary({ id: 'd1', kind: 'docs', title: 'letter.docx', lastActiveAt: 1 })]
    window.aiOfficeTabs = {
      list: async () => (tabsBridgeQuiet ? await new Promise<typeof openTabs>(() => {}) : openTabs),
      activate: async () => {},
    } as unknown as NonNullable<typeof window.aiOfficeTabs>
    await render()
    await actType('letter')
    expect(rowTitles()).toContain('letter.docx')
    // the trailing space is question grammar, not content — and the refetch
    // now hangs forever
    tabsBridgeQuiet = true
    await actType('letter ')
    expect(rowTitles()).toContain('letter.docx')
  })

  it('survives a preload without the palette read methods', async () => {
    window.aiOffice = {} as unknown as HomeApi
    await render()
    await actType('doc')
    // the create actions still work; the sources simply read as empty
    expect(rowTitles()).toContain('New document')
    expect(host.querySelector('.cmd-empty')).toBeFalsy()
  })
})

describe('folderOf', () => {
  it('takes the directory part, both separators honored', () => {
    expect(folderOf('C:\\Docs\\report.docx')).toBe('C:\\Docs')
    expect(folderOf('/home/notes.md')).toBe('/home')
    expect(folderOf('report.docx')).toBe('')
    expect(folderOf('\\report.docx')).toBe('')
  })
})

// ── the provider registry ──

const stubRow = (group: PaletteRow['group'], id: string, path?: string): PaletteRow => ({
  id,
  group,
  title: id,
  detail: '',
  icon: { kind: 'pen' },
  missing: false,
  chip: '',
  path,
  run: () => {},
})

describe('defaultPaletteProviders', () => {
  it('registers every source in a stable priority order', () => {
    const providers = defaultPaletteProviders()
    expect(providers.map((p) => p.id)).toEqual([
      'create',
      'tabs',
      'recent',
      'files',
      'skills',
      'commands',
      'settings',
      'help',
      'plugins',
      'ask',
    ])
    const priorities = providers.map((p) => p.priority)
    expect([...priorities].sort((a, b) => a - b)).toEqual(priorities)
  })

  it('reproduces the legacy empty-query list: the create actions plus the five newest recents', async () => {
    const recents = Array.from({ length: 8 }, (_, i) =>
      recent({ path: `C:\\Docs\\file-${i}.docx`, name: `file-${i}.docx` }),
    )
    const context = ctx({ recents })
    // every source answers, sync and async alike — an async provider that
    // never settles would hang the palette on its first keystroke
    const parts = await Promise.all(
      defaultPaletteProviders().map(async (p) => ({
        priority: p.priority,
        rows: await p.getRows('', context),
      })),
    )
    const rows = mergePaletteRows(parts)
    expect(rows.map((r) => r.group)).toEqual([
      ...Array(7).fill('create'),
      ...Array.from({ length: 5 }, () => 'recent'),
    ])
    expect(rows[7]!.title).toBe('file-0.docx')
  })
})

describe('createAskAiProvider', () => {
  it('is empty for a blank query and a single trailing row otherwise', () => {
    const provider = createAskAiProvider()
    expect(provider.getRows('', ctx())).toEqual([])
    expect(provider.getRows('   ', ctx())).toEqual([])
    const rows = provider.getRows('  summarize Q3  ', ctx()) as PaletteRow[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.group).toBe('ask')
    expect(rows[0]!.title).toBe('Ask AI: summarize Q3')
  })

  it('runs by handing the trimmed query to the host', () => {
    const asked: string[] = []
    const provider = createAskAiProvider()
    const rows = provider.getRows('hello', ctx({ onAskAi: (q) => asked.push(q) })) as PaletteRow[]
    rows[0]!.run()
    expect(asked).toEqual(['hello'])
  })
})

describe('createTabsProvider', () => {
  it('lists the open tabs most-recently-used first, minus Home', async () => {
    // the palette is summoned on Home, so the Home row would always point at
    // where you already are; the rest of the strip is the switcher
    mountTabs([
      tabSummary({
        id: 'home',
        kind: 'home',
        title: 'GenOffice',
        closable: false,
        active: true,
        lastActiveAt: 900,
      }),
      tabSummary({
        id: 'd1',
        kind: 'docs',
        title: 'older.docx',
        lastActiveAt: 100,
        filePath: 'C:\\Docs\\older.docx',
      }),
      tabSummary({
        id: 's1',
        kind: 'sheets',
        title: 'newer.xlsx',
        lastActiveAt: 800,
        filePath: 'C:\\Docs\\newer.xlsx',
      }),
    ])
    const rows = (await createTabsProvider().getRows('', ctx())) as PaletteRow[]
    expect(rows.map((r) => r.title)).toEqual(['newer.xlsx', 'older.docx'])
    expect(rows.every((r) => r.group === 'tabs')).toBe(true)
    // rows carry their file path so the files source can shadow them
    expect(rows[0]!.path).toBe('C:\\Docs\\newer.xlsx')
  })

  it('activates the picked tab through the bridge', async () => {
    mountTabs([tabSummary({ id: 'd1', kind: 'docs', title: 'report.docx', lastActiveAt: 1 })])
    const rows = (await createTabsProvider().getRows('report', ctx())) as PaletteRow[]
    expect(rows).toHaveLength(1)
    rows[0]!.run()
    expect(tabActivations).toEqual(['d1'])
  })

  it('answers [] when the bridge face is absent (an older preload)', async () => {
    ;(window as { aiOfficeTabs?: typeof window.aiOfficeTabs }).aiOfficeTabs = undefined
    expect(await createTabsProvider().getRows('', ctx())).toEqual([])
  })
})

describe('createEditorCommandsProvider', () => {
  it('offers the most recently used editor family only, with its title as the detail', async () => {
    mountApi([])
    // Home holds the active slot while the palette is open; the commands are
    // for the editor the user was last in, and the row says which one that is
    mountTabs([
      tabSummary({ id: 'd1', kind: 'docs', title: 'letter.docx', lastActiveAt: 100 }),
      tabSummary({ id: 's1', kind: 'sheets', title: 'budget.xlsx', lastActiveAt: 900 }),
    ])
    const rows = (await createEditorCommandsProvider().getRows('save', ctx())) as PaletteRow[]
    expect(rows.map((r) => r.title).sort()).toEqual(['Save', 'Save as'])
    expect(rows.every((r) => r.detail === 'budget.xlsx')).toBe(true)
    // sheets has no find or zoom verbs — the shared table is the contract
    expect(await createEditorCommandsProvider().getRows('zoom', ctx())).toEqual([])
    expect(await createEditorCommandsProvider().getRows('find', ctx())).toEqual([])
  })

  it('runs the picked command through the bridge for that family', async () => {
    mountApi([])
    mountTabs([tabSummary({ id: 'd1', kind: 'docs', title: 'letter.docx', lastActiveAt: 1 })])
    const rows = (await createEditorCommandsProvider().getRows('zoom', ctx())) as PaletteRow[]
    expect(rows.map((r) => r.title).sort()).toEqual(['Reset zoom', 'Zoom in', 'Zoom out'])
    const reset = rows.find((r) => r.title === 'Reset zoom')!
    reset.run()
    // the run pins the tab the row named, so Enter executes on that document
    expect(editorCommandsRun).toEqual([['docs', 'zoom-reset', 'd1']])
  })

  it('presents no rows when the preload predates the runEditorCommand rail', async () => {
    // the tabs bridge is older than the command rail, so tabs can be listed
    // while the run cannot — listing would be a promise the shell cannot keep
    window.aiOffice = {} as unknown as HomeApi
    mountTabs([tabSummary({ id: 'd1', kind: 'docs', title: 'letter.docx', lastActiveAt: 1 })])
    expect(await createEditorCommandsProvider().getRows('save', ctx())).toEqual([])
  })

  it('skips chrome-free presentation views: the owning editor answers', async () => {
    mountApi([])
    // html Present renders a document but owns no editor surface; the rows
    // must name the owner tab, never the presentation
    mountTabs([
      tabSummary({ id: 'h1', kind: 'html', title: 'page.html', lastActiveAt: 100 }),
      tabSummary({
        id: 'present',
        kind: 'html',
        title: 'page.html',
        lastActiveAt: 900,
        present: true,
      }),
    ])
    const rows = (await createEditorCommandsProvider().getRows('save', ctx())) as PaletteRow[]
    // both save verbs are listed for html now, each naming the owner tab
    expect(rows.map((r) => [r.title, r.detail])).toEqual([
      ['Save', 'page.html'],
      ['Save as', 'page.html'],
    ])
    // the switcher still lists the presentation itself — switching to it is real
    const switchRows = (await createTabsProvider().getRows('page', ctx())) as PaletteRow[]
    expect(switchRows.map((r) => r.id)).toContain('tab:present')
  })

  it('offers nothing with no editor open', async () => {
    mountApi([])
    mountTabs([
      tabSummary({
        id: 'home',
        kind: 'home',
        title: 'GenOffice',
        closable: false,
        lastActiveAt: 1,
      }),
    ])
    expect(await createEditorCommandsProvider().getRows('save', ctx())).toEqual([])
  })
})

describe('createHelpTopicsProvider', () => {
  it('matches a question-shaped query through the topic keywords', async () => {
    mountApi([])
    // the issue's acceptance gate: a Chinese "merge PDFs" question must land
    // on the PDF topic; here in en, "merge pdf" must — the registry's
    // keywords welcome both languages
    const rows = (await createHelpTopicsProvider().getRows('merge pdf', ctx())) as PaletteRow[]
    expect(rows.map((r) => r.title)).toContain('PDF: reading, annotating and redacting')
  })

  it('matches an unsegmented CJK question: the token contains the keyword, not the reverse', async () => {
    mountApi([])
    // CJK questions are typed without spaces, so the whole question is one
    // token; it must still land on the topic whose keyword it contains
    const rows = (await createHelpTopicsProvider().getRows('怎么合并PDF', ctx())) as PaletteRow[]
    expect(rows.map((r) => r.title)).toContain('PDF: reading, annotating and redacting')
  })

  it('a spaced-language word that merely contains a topic word is not a match', async () => {
    mountApi([])
    // the reverse probe exists for unsegmented CJK; a segmented word like
    // "outline" containing the title word "line" must not surface that topic
    const rows = await createHelpTopicsProvider().getRows('outline', ctx())
    expect(rows).toEqual([])
  })

  it('ranks a title hit above a keyword-only hit', async () => {
    mountApi([])
    const rows = (await createHelpTopicsProvider().getRows('pdf', ctx())) as PaletteRow[]
    expect(rows[0]!.title).toBe('PDF: reading, annotating and redacting')
  })

  it('offers no rows when the preload predates the openHelp bridge', async () => {
    // a help row's whole point is the deep link; an older rail cannot keep
    // that promise, so the provider offers nothing to run
    window.aiOffice = {} as unknown as HomeApi
    expect(await createHelpTopicsProvider().getRows('merge pdf', ctx())).toEqual([])
  })

  it('runs by opening the manual deep-linked to the topic', async () => {
    mountApi([])
    const rows = (await createHelpTopicsProvider().getRows('merge', ctx())) as PaletteRow[]
    rows[0]!.run()
    expect(openedHelpTopics).toEqual(['pdf'])
  })

  it('is empty for a blank query and for gibberish', async () => {
    // the bridge face is mounted by the test itself, not inherited from the
    // previous one: this arm is about the matcher, not the absent guard
    mountApi([])
    const provider = createHelpTopicsProvider()
    expect(await provider.getRows('', ctx())).toEqual([])
    expect(await provider.getRows('zzzqx', ctx())).toEqual([])
  })

  it('a two-letter Latin keyword embedded in a CJK question is not the question word', async () => {
    // "ai" is a keyword of the assistant-panel topic; a Chinese question
    // whose Latin run merely contains it ("airdrop") must not surface that
    // topic — a Latin keyword only matches as one of the token's whole Latin
    // runs, so "form" is not "format" either
    mountApi([])
    const provider = createHelpTopicsProvider()
    expect(await provider.getRows('如何维修airdrop', ctx())).toEqual([])
    expect(await provider.getRows('如何format化', ctx())).toEqual([])
    // the bounded run is the question's own word, and it still matches
    const hits = (await provider.getRows('怎么用AI写作', ctx())) as PaletteRow[]
    expect(hits.map((r) => r.title)).toContain('The AI assistant panel')
  })

  it('the probe serves every space-less script, digit glue, and hyphenated keywords', async () => {
    // the probe is the acceptance gate's engine and must not assume Han: a
    // Korean question glued to "pdf", digits glued to the keyword (space-less
    // scripts glue digits too), and a hyphenated keyword matched as its run
    // sequence all have to land on their topic. The digit-glue query carries
    // no Han keyword of the topic, so its only match path is the digit-split
    // run — the one mechanism this arm exists to pin
    mountApi([])
    const provider = createHelpTopicsProvider()
    const korean = (await provider.getRows('pdf병합방법', ctx())) as PaletteRow[]
    expect(korean.map((r) => r.title)).toContain('PDF: reading, annotating and redacting')
    const glued = (await provider.getRows('怎么2024pdf', ctx())) as PaletteRow[]
    expect(glued.map((r) => r.title)).toContain('PDF: reading, annotating and redacting')
    const hyphen = (await provider.getRows('怎么double-click', ctx())) as PaletteRow[]
    expect(hyphen.map((r) => r.title)).toContain('Tabs and window management')
  })
})

describe('createSettingsProvider catalog', () => {
  it('searches the settings pane by its own words, from the same dictionaries', async () => {
    await loadStrings('en')
    const rows = createSettingsProvider().getRows('auto', ctx()) as PaletteRow[]
    expect(rows.map((r) => r.title)).toContain('Auto-save all documents')
    // the detail line says which section the setting lives in
    const autoSave = rows.find((r) => r.title === 'Auto-save all documents')!
    expect(autoSave.detail).toBe('General')
  })

  it('routes every row through the host modal with its section', async () => {
    await loadStrings('en')
    const rows = createSettingsProvider().getRows(
      'api key',
      ctx({ openSettings: (target) => settingsTargets.push(target) }),
    ) as PaletteRow[]
    expect(rows.map((r) => r.title)).toContain('API Key')
    rows.find((r) => r.title === 'API Key')!.run()
    expect(settingsTargets).toEqual([{ section: 'aiModel' }])
  })
})

describe('mergePaletteRows tab shadowing', () => {
  it('a file-index hit shadows the open-tab row of the same path, like it shadows the recent', () => {
    const files = [
      { priority: 30, rows: [stubRow('files', 'file:C:\\Docs\\a.docx', 'C:\\Docs\\a.docx')] },
    ]
    const tabs = [
      {
        priority: 15,
        rows: [
          stubRow('tabs', 'tab:d1', 'C:\\Docs\\a.docx'),
          stubRow('tabs', 'tab:d2', 'C:\\Docs\\b.docx'),
        ],
      },
    ]
    const merged = mergePaletteRows([...tabs, ...files])
    expect(merged.map((r) => r.id)).toEqual(['tab:d2', 'file:C:\\Docs\\a.docx'])
  })

  it('an open tab shadows the recents row of the same path — an open document is by definition recent', () => {
    const tabs = [{ priority: 15, rows: [stubRow('tabs', 'tab:d1', 'C:\\Docs\\a.docx')] }]
    const recents = [{ priority: 20, rows: [stubRow('recent', 'recent:a', 'C:\\Docs\\a.docx')] }]
    const merged = mergePaletteRows([...tabs, ...recents])
    expect(merged.map((r) => r.id)).toEqual(['tab:d1'])
  })
})

describe('createFilesProvider', () => {
  const page = (hits: FileSearchHit[]) => ({
    hits,
    total: hits.length,
    index: { indexed: 1, pending: 0, scanning: false },
  })

  it('answers [] synchronously for a blank query and never searches', () => {
    let calls = 0
    const provider = createFilesProvider({
      search: async () => {
        calls += 1
        return page([])
      },
    })
    expect(provider.getRows('', ctx())).toEqual([])
    expect(provider.getRows('   ', ctx())).toEqual([])
    expect(calls).toBe(0)
  })

  it('debounces the search, caps the rows and maps hits to openable file rows', async () => {
    const searched: string[] = []
    const opened: string[] = []
    const provider = createFilesProvider({
      debounceMs: 0,
      search: async (q) => {
        searched.push(q)
        return page(
          Array.from({ length: 8 }, (_, i) =>
            hit({ path: `C:\\Docs\\hit-${i}.docx`, name: `hit-${i}.docx` }),
          ),
        )
      },
      open: (path) => opened.push(path),
    })
    const rows = await provider.getRows('hit', ctx())
    expect(searched).toEqual(['hit'])
    // at most five file rows ride along
    expect(rows).toHaveLength(5)
    expect(rows[0]!.group).toBe('files')
    expect(rows[0]!.detail).toBe('C:\\Docs')
    rows[0]!.run()
    expect(opened).toEqual(['C:\\Docs\\hit-0.docx'])
    // the same query again reuses the settled answer instead of re-searching
    const again = await provider.getRows('hit', ctx())
    expect(searched).toEqual(['hit'])
    expect(again.map((r) => r.id)).toEqual(rows.map((r) => r.id))
  })

  it('settles to no rows when the search fails, so other sources still answer', async () => {
    const provider = createFilesProvider({
      debounceMs: 0,
      search: () => Promise.reject(new Error('index busy')),
    })
    await expect(provider.getRows('hit', ctx())).resolves.toEqual([])
  })

  it('a superseded query resolves to no rows and its search never fires', async () => {
    const searched: string[] = []
    const provider = createFilesProvider({
      debounceMs: 5,
      search: async (q) => {
        searched.push(q)
        return page([hit({})])
      },
    })
    const first = provider.getRows('old', ctx()) as Promise<PaletteRow[]>
    const second = provider.getRows('new', ctx()) as Promise<PaletteRow[]>
    await expect(first).resolves.toEqual([])
    await expect(second).resolves.toHaveLength(1)
    expect(searched).toEqual(['new'])
  })

  /** two macrotask rounds: the rerank timer plus the async judgement chain */
  const settleRerank = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  it('runs the Home decision-model rerank: local order first, judged order on the notification', async () => {
    const hits = [
      hit({ path: 'C:\\Docs\\a.docx', name: 'a.docx' }),
      hit({ path: 'C:\\Docs\\b.docx', name: 'b.docx' }),
      hit({ path: 'C:\\Docs\\c.docx', name: 'c.docx' }),
    ]
    const reranks: Array<[string, string[]]> = []
    const provider = createFilesProvider({
      debounceMs: 0,
      rerankSettleMs: 0,
      search: async () => page(hits),
      rerank: async (q, paths) => {
        reranks.push([q, [...paths]])
        return { order: ['C:\\Docs\\c.docx', 'C:\\Docs\\a.docx'], scores: {} }
      },
    })
    // the whole pool is offered to the judge, exactly as Home's top-20 is
    const rows = await provider.getRows('hit', ctx())
    expect(rows.map((r) => r.id)).toEqual([
      'file:C:\\Docs\\a.docx',
      'file:C:\\Docs\\b.docx',
      'file:C:\\Docs\\c.docx',
    ])
    const fired: number[] = []
    const off = provider.subscribe?.(() => fired.push(1))
    await settleRerank()
    expect(reranks).toEqual([['hit', ['C:\\Docs\\a.docx', 'C:\\Docs\\b.docx', 'C:\\Docs\\c.docx']]])
    expect(fired).toHaveLength(1)
    // the re-query the notification triggers sees the judged order: the model's
    // picks first, the unjudged rest in local order
    const again = await provider.getRows('hit', ctx())
    expect(again.map((r) => r.id)).toEqual([
      'file:C:\\Docs\\c.docx',
      'file:C:\\Docs\\a.docx',
      'file:C:\\Docs\\b.docx',
    ])
    off?.()
  })

  it('a null judgement (reranking off) keeps the local order and notifies nobody', async () => {
    const provider = createFilesProvider({
      debounceMs: 0,
      rerankSettleMs: 0,
      search: async () => page([hit({}), hit({ path: 'C:\\Docs\\b.docx', name: 'b.docx' })]),
      rerank: async () => null,
    })
    const rows = await provider.getRows('hit', ctx())
    const fired: number[] = []
    const off = provider.subscribe?.(() => fired.push(1))
    await settleRerank()
    expect(fired).toHaveLength(0)
    const again = await provider.getRows('hit', ctx())
    expect(again.map((r) => r.id)).toEqual(rows.map((r) => r.id))
    off?.()
  })

  it('a superseding query cancels the pending judgement before it fires', async () => {
    const reranks: string[] = []
    const provider = createFilesProvider({
      debounceMs: 0,
      rerankSettleMs: 30,
      search: async (q) =>
        page([
          hit({ path: `C:\\Docs\\${q}.docx`, name: `${q}.docx` }),
          hit({ path: `C:\\Docs\\${q}-2.docx`, name: `${q}-2.docx` }),
        ]),
      rerank: async (q) => {
        reranks.push(q)
        return null
      },
    })
    await provider.getRows('old', ctx())
    // the 'old' judgement is armed for +30ms; typing again must cancel it
    await provider.getRows('new', ctx())
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(reranks).toEqual(['new'])
  })

  it('dispose cancels pending search and judgement timers and settles the in-flight promise', async () => {
    const searched: string[] = []
    const reranks: string[] = []
    const provider = createFilesProvider({
      debounceMs: 20,
      rerankSettleMs: 10,
      search: async (q) => {
        searched.push(q)
        return page([
          hit({ path: `C:\\Docs\\${q}.docx`, name: `${q}.docx` }),
          hit({ path: `C:\\Docs\\${q}-2.docx`, name: `${q}-2.docx` }),
        ])
      },
      rerank: async (q) => {
        reranks.push(q)
        return null
      },
    })
    const promise = provider.getRows('hit', ctx()) as Promise<PaletteRow[]>
    provider.dispose?.()
    await expect(promise).resolves.toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(searched).toEqual([])
    expect(reranks).toEqual([])
  })

  it('a search resolving after dispose cannot re-arm the rerank: no stray model call', async () => {
    const reranks: string[] = []
    let releaseSearch: ((page: ReturnType<typeof page>) => void) | null = null
    const provider = createFilesProvider({
      debounceMs: 0,
      rerankSettleMs: 0,
      search: () =>
        new Promise((resolve) => {
          releaseSearch = resolve
        }),
      rerank: async (q) => {
        reranks.push(q)
        return null
      },
    })
    const promise = provider.getRows('report', ctx()) as Promise<PaletteRow[]>
    // the palette closes while the searchFiles IPC is still in flight
    provider.dispose?.()
    releaseSearch?.(page([hit({}), hit({ path: 'C:\\Docs\\b.docx', name: 'b.docx' })]))
    await expect(promise).resolves.toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(reranks).toEqual([])
  })

  it('a stale verdict never lands: typing A, then B, then back to A drops the first A judgement', async () => {
    // each rerank call hands back its own resolver, so the test can age one
    const verdicts: Array<(result: FileSearchRerank | null) => void> = []
    const provider = createFilesProvider({
      debounceMs: 0,
      rerankSettleMs: 0,
      search: async (q) =>
        page([
          hit({ path: `C:\\Docs\\${q}-1.docx`, name: `${q}-1.docx` }),
          hit({ path: `C:\\Docs\\${q}-2.docx`, name: `${q}-2.docx` }),
        ]),
      rerank: () =>
        new Promise<FileSearchRerank | null>((resolve) => {
          verdicts.push(resolve)
        }),
    })
    await provider.getRows('repo', ctx())
    // let the first query's judgement actually start (its settle timer fires)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(verdicts).toHaveLength(1)
    // supersede with a new query, then come back to the first one
    await provider.getRows('re', ctx())
    await provider.getRows('repo', ctx())
    const before = await provider.getRows('repo', ctx())
    // the first query's verdict arrives late: it would put repo-2 first, and
    // must not touch the fresh answer for the same query
    verdicts[0]!({ order: ['C:\\Docs\\repo-2.docx'], scores: {} })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const after = await provider.getRows('repo', ctx())
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id))
    expect(after[0]!.id).toBe('file:C:\\Docs\\repo-1.docx')
  })

  it("while the index is scanning the provider re-asks and its rows grow like Home's", async () => {
    const searched: number[] = []
    const pages = [
      // first answer: partial, the index still busy
      {
        hits: [hit({ path: 'C:\\Docs\\a.docx', name: 'a.docx' })],
        total: 1,
        index: { indexed: 40, pending: 3, scanning: true },
      },
      // catch-up: more hits, the index quiet now
      {
        hits: [
          hit({ path: 'C:\\Docs\\a.docx', name: 'a.docx' }),
          hit({ path: 'C:\\Docs\\b.docx', name: 'b.docx' }),
        ],
        total: 2,
        index: { indexed: 43, pending: 0, scanning: false },
      },
    ]
    const provider = createFilesProvider({
      debounceMs: 0,
      rerankSettleMs: 0,
      busyPollMs: 10,
      search: async () => {
        const page = pages[Math.min(searched.length, pages.length - 1)]!
        searched.push(1)
        return page
      },
      rerank: async () => null,
    })
    const rows = await provider.getRows('hit', ctx())
    expect(rows.map((r) => r.id)).toEqual(['file:C:\\Docs\\a.docx'])
    const fired: number[] = []
    const off = provider.subscribe?.(() => fired.push(1))
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(searched.length).toBe(2) // the catch-up poll fired once
    const grown = await provider.getRows('hit', ctx())
    expect(grown.map((r) => r.id)).toEqual(['file:C:\\Docs\\a.docx', 'file:C:\\Docs\\b.docx'])
    expect(fired).toHaveLength(1)
    off?.()
    // the index went quiet: no further polls
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(searched.length).toBe(2)
  })
})

describe('mergePaletteRows', () => {
  it('orders groups by priority regardless of contribution order', () => {
    const rows = mergePaletteRows([
      { priority: 100, rows: [stubRow('ask', 'ask:ai')] },
      { priority: 10, rows: [stubRow('create', 'create:doc')] },
      { priority: 20, rows: [stubRow('recent', 'recent:x', '/x')] },
    ])
    expect(rows.map((r) => r.id)).toEqual(['create:doc', 'recent:x', 'ask:ai'])
  })

  it('a file-index hit shadows the recent row of the same path', () => {
    // both rows open the same file; the hit matched the live query, the recent
    // only repeats an old open, so the recent yields its slot
    const rows = mergePaletteRows([
      {
        priority: 20,
        rows: [
          stubRow('recent', 'recent:/a.docx', '/a.docx'),
          stubRow('recent', 'recent:/b.docx', '/b.docx'),
        ],
      },
      { priority: 30, rows: [stubRow('files', 'file:/a.docx', '/a.docx')] },
    ])
    expect(rows.map((r) => r.id)).toEqual(['recent:/b.docx', 'file:/a.docx'])
  })

  it('caps the list at 50 rows and always keeps the Ask AI fallback last', () => {
    const many = Array.from({ length: 80 }, (_, i) => stubRow('recent', `recent:${i}`))
    const rows = mergePaletteRows([
      { priority: 20, rows: many },
      { priority: 100, rows: [stubRow('ask', 'ask:ai')] },
    ])
    expect(rows).toHaveLength(50)
    expect(rows[49]!.id).toBe('ask:ai')
  })
})

describe('CommandPalette + FilesProvider (mounted)', () => {
  /** the default registry with the files source swapped for a test double */
  const providersWithFiles = (
    search: (q: string) => Promise<{
      hits: FileSearchHit[]
      total: number
      index: { indexed: number; pending: number; scanning: boolean }
    }>,
  ): PaletteProvider[] =>
    defaultPaletteProviders().map((p) =>
      p.id === 'files' ? createFilesProvider({ debounceMs: 0, search }) : p,
    )

  /** the debounced search lands a macrotask later even with debounceMs 0 */
  const flushSearch = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      await Promise.resolve()
    })

  it('surfaces file-index hits under their own group and opens them', async () => {
    const searched: string[] = []
    mountApi([])
    await render(
      providersWithFiles(async (q) => {
        searched.push(q)
        return {
          hits: [hit({ path: 'C:\\Docs\\repo-note.docx', name: 'repo-note.docx' })],
          total: 1,
          index: { indexed: 1, pending: 0, scanning: false },
        }
      }),
    )
    await actType('repo')
    await flushSearch()
    expect(searched).toEqual(['repo'])
    const groupLabels = [...host.querySelectorAll('.cmd-group-title')].map((el) => el.textContent)
    expect(groupLabels).toContain('Files')
    expect(rowTitles()).toContain('repo-note.docx')
    await clickRow('repo-note.docx')
    expect(openedPaths).toEqual(['C:\\Docs\\repo-note.docx'])
    expect(closed).toBe(1)
  })

  it('a file hit shadows the recent row of the same path', async () => {
    mountApi([recent({ path: 'C:\\Docs\\quarterly.docx', name: 'quarterly.docx' })])
    await render(
      providersWithFiles(async () => ({
        hits: [hit({ path: 'C:\\Docs\\quarterly.docx', name: 'quarterly.docx' })],
        total: 1,
        index: { indexed: 1, pending: 0, scanning: false },
      })),
    )
    await actType('quarterly')
    await flushSearch()
    // one row for the path, under Files; the Ask AI fallback trails
    expect(rowTitles()).toEqual(['quarterly.docx', 'Ask AI: quarterly'])
    const groupLabels = [...host.querySelectorAll('.cmd-group-title')].map((el) => el.textContent)
    expect(groupLabels).toEqual(['Files', 'Ask AI'])
  })

  it('a failing search degrades to no file rows while the rest still answer', async () => {
    mountApi([recent({ path: 'C:\\Docs\\quarterly.docx', name: 'quarterly.docx' })])
    await render(providersWithFiles(() => Promise.reject(new Error('index busy'))))
    await actType('quarterly')
    await flushSearch()
    expect(rowTitles()).toEqual(['quarterly.docx', 'Ask AI: quarterly'])
  })

  it('re-renders the file rows in the judged order when the decision model answers', async () => {
    mountApi([])
    const providers = defaultPaletteProviders().map((p) =>
      p.id === 'files'
        ? createFilesProvider({
            debounceMs: 0,
            rerankSettleMs: 30,
            search: async () => ({
              hits: [
                hit({ path: 'C:\\Docs\\alpha.docx', name: 'alpha.docx' }),
                hit({ path: 'C:\\Docs\\beta.docx', name: 'beta.docx' }),
              ],
              total: 2,
              index: { indexed: 1, pending: 0, scanning: false },
            }),
            rerank: async () => ({ order: ['C:\\Docs\\beta.docx'], scores: {} }),
          })
        : p,
    )
    await render(providers)
    await actType('alp')
    await flushSearch()
    // local order first: the launcher answers before the model judges (the
    // settle window below is still open at this point)
    expect(rowTitles().indexOf('alpha.docx')).toBeLessThan(rowTitles().indexOf('beta.docx'))
    // the judgement lands and the palette re-queries on the provider's notify
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15))
      await new Promise((resolve) => setTimeout(resolve, 15))
      await new Promise((resolve) => setTimeout(resolve, 15))
    })
    const titles = rowTitles()
    expect(titles).toContain('beta.docx')
    expect(titles.indexOf('beta.docx')).toBeLessThan(titles.indexOf('alpha.docx'))
  })

  it('survives a StrictMode double-mount: the second mount still reranks', async () => {
    mountApi([])
    const reranks: string[] = []
    // counts the StrictMode cleanups so the test fails loudly if React stops
    // double-mounting (then this would stop covering the regression at all)
    let probeDisposes = 0
    const providers: PaletteProvider[] = [
      ...defaultPaletteProviders().map((p) =>
        p.id === 'files'
          ? createFilesProvider({
              debounceMs: 0,
              rerankSettleMs: 0,
              search: async () => ({
                hits: [
                  hit({ path: 'C:\\Docs\\alpha.docx', name: 'alpha.docx' }),
                  hit({ path: 'C:\\Docs\\beta.docx', name: 'beta.docx' }),
                ],
                total: 2,
                index: { indexed: 1, pending: 0, scanning: false },
              }),
              rerank: async (q) => {
                reranks.push(q)
                return { order: ['C:\\Docs\\beta.docx'], scores: {} }
              },
            })
          : p,
      ),
      {
        id: 'strict-probe',
        priority: 1000,
        getRows: () => [],
        dispose: () => (probeDisposes += 1),
      },
    ]
    // main.tsx mounts the whole app under React.StrictMode: in dev the
    // palette's effects run setup -> cleanup -> setup on one mount, and the
    // cleanup disposes every provider — the same instances the second setup
    // keeps using, because the palette holds them in a useMemo. Production and
    // these tests' plain createRoot never trigger it, which is how the latch
    // hid: green tests, dead dev rerank
    await act(async () => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(CommandPalette, {
            lang: 'en',
            onClose: () => (closed += 1),
            onAskAi: (q) => askedQueries.push(q),
            providers,
          }),
        ),
      )
    })
    // the simulated unmount ran once and the palette is now on its second mount
    expect(probeDisposes).toBe(1)
    await actType('alp')
    await flushSearch()
    // the index still answers in local order (the settle window is open)
    expect(rowTitles()).toContain('alpha.docx')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15))
      await new Promise((resolve) => setTimeout(resolve, 15))
      await new Promise((resolve) => setTimeout(resolve, 15))
    })
    // the regression: the model call must still fire after the double mount,
    // and the judged order must replace the local one
    expect(reranks).toEqual(['alp'])
    const titles = rowTitles()
    expect(titles.indexOf('beta.docx')).toBeLessThan(titles.indexOf('alpha.docx'))
  })
})
