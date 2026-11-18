import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The palette's editor-command dispatch (src/main/editor-command-dispatch.ts,
 * issue #56 P0 #2): save/save-as/print must ride the tab menu's own rail
 * (runTabDocumentAction — one pdf dialog, one save flow), the other verbs go
 * over each family's own menu channel to the resolved tab's contents, and the
 * target is always the most recently used tab of that family.
 *
 * app-registry is mocked so the markdown/html export requests are observable;
 * runTabDocumentAction runs for real against stub deps, which is the point:
 * the palette's verbs and the tab menu's are one code path.
 */

const sendMarkdownExportRequest = vi.fn()
const sendHtmlExportRequest = vi.fn()

vi.mock('../src/main/app-registry', () => ({
  sendMarkdownExportRequest: (...args: unknown[]) => sendMarkdownExportRequest(...args),
  sendHtmlExportRequest: (...args: unknown[]) => sendHtmlExportRequest(...args),
}))

import { isValidEditorCommand, runEditorCommand } from '../src/main/editor-command-dispatch'
import { editorCommandsFor } from '../src/shared/editor-commands'
import type { DocumentTabKind, TabSummary } from '../src/shared/tabs-api'
import type { TabDocumentActionDeps } from '../src/main/tab-document-actions'

const tab = (over: Partial<TabSummary> & { id: string; kind: TabSummary['kind'] }): TabSummary => ({
  title: 'A tab',
  closable: true,
  active: false,
  ...over,
})

interface FakeContents {
  id: number
  send: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
}

let tabs: TabSummary[]
let contents: Map<string, FakeContents>
let activated: string[]
let deps: TabDocumentActionDeps
/** models a dormant tab: the detach guard refuses it until webContentsForTab
 *  (the revive path) has run, the way the real tab manager behaves */
let dormantRevived: boolean

beforeEach(() => {
  vi.clearAllMocks()
  tabs = []
  contents = new Map()
  activated = []
  dormantRevived = false
  deps = {
    // the subset of TabManager the rail resolves through: list, activate,
    // detach-guard, and contents lookup
    tabs: {
      list: () => tabs,
      activateTab: (id: string) => {
        activated.push(id)
        for (const t of tabs) t.active = t.id === id
      },
      canDetachTab: (id: string) => id !== 'closing' && (id !== 'dormant' || dormantRevived),
      webContentsForTab: (id: string) => {
        if (id === 'dormant') dormantRevived = true
        return contents.get(id) as never
      },
    },
    savePdf: vi.fn(),
    savePdfAs: vi.fn(),
    printPdf: vi.fn(),
    saveMarkdown: vi.fn(),
    printMarkdown: vi.fn(),
    saveHtml: vi.fn(),
    printHtml: vi.fn(),
  }
})

const mount = (over: { id: string; kind: DocumentTabKind; lastActiveAt?: number }): void => {
  tabs.push(tab(over))
  contents.set(
    over.id,
    (over.id === 'dead'
      ? { id: 1, send: vi.fn(), isDestroyed: vi.fn(() => true) }
      : { id: tabs.length + 1, send: vi.fn(), isDestroyed: vi.fn(() => false) }) as FakeContents,
  )
}

describe('runEditorCommand', () => {
  it('resolves the most recently used tab of the family, not the strip order', () => {
    // two docs tabs: the strip's second is the more recently used one, and the
    // palette listed the command for that one — the dispatch must agree
    mount({ id: 'd1', kind: 'docs', lastActiveAt: 100 })
    mount({ id: 'd2', kind: 'docs', lastActiveAt: 900 })
    expect(runEditorCommand(deps, 'docs', 'find')).toBe(true)
    expect(contents.get('d2')!.send).toHaveBeenCalledWith('menu:command', 'find')
    expect(contents.get('d1')!.send).not.toHaveBeenCalled()
    expect(activated).toEqual(['d2'])
  })

  it('ignores tabs of other families and Home when resolving', () => {
    mount({ id: 's1', kind: 'sheets', lastActiveAt: 500 })
    mount({ id: 'home', kind: 'home', lastActiveAt: 950 })
    mount({ id: 'p1', kind: 'pdf', lastActiveAt: 600 })
    expect(runEditorCommand(deps, 'pdf', 'print')).toBe(true)
    expect(deps.printPdf).toHaveBeenCalledWith(contents.get('p1'))
  })

  it('a pinned tab id wins over the family MRU — Enter runs on the row the palette named', () => {
    // the renderer pins the target's id on the row; the dispatch must honor
    // it even when the family's most recently used tab moved since listing
    mount({ id: 'd1', kind: 'docs', lastActiveAt: 100 })
    mount({ id: 'd2', kind: 'docs', lastActiveAt: 900 })
    expect(runEditorCommand(deps, 'docs', 'find', 'd1')).toBe(true)
    expect(contents.get('d1')!.send).toHaveBeenCalledWith('menu:command', 'find')
    expect(contents.get('d2')!.send).not.toHaveBeenCalled()
    expect(activated).toEqual(['d1'])
  })

  it('a stale pinned id (the tab closed mid-overlay) falls back to the family MRU', () => {
    mount({ id: 'd1', kind: 'docs', lastActiveAt: 100 })
    mount({ id: 'd2', kind: 'docs', lastActiveAt: 900 })
    expect(runEditorCommand(deps, 'docs', 'find', 'gone')).toBe(true)
    expect(contents.get('d2')!.send).toHaveBeenCalledWith('menu:command', 'find')
  })

  it('a presentation view is never a target: the owning editor tab answers instead', () => {
    // html Present renders a document but owns no editor surface — commands
    // listed for the family must resolve to the real editor tab, never the
    // chrome-free view (whose save/print would silently no-op and whose
    // export listener does not exist)
    mount({ id: 'h1', kind: 'html', lastActiveAt: 100 })
    mount({ id: 'present', kind: 'html', lastActiveAt: 900, present: true })
    expect(runEditorCommand(deps, 'html', 'export-pdf')).toBe(true)
    expect(sendHtmlExportRequest).toHaveBeenCalledWith(contents.get('h1'), 'pdf')
    expect(activated).toEqual(['h1'])
    // and a pinned present id cannot be coaxed into targeting it either
    vi.clearAllMocks()
    expect(runEditorCommand(deps, 'html', 'print', 'present')).toBe(true)
    expect(deps.printHtml).toHaveBeenCalledWith(contents.get('h1'))
  })

  it('a family whose only tabs are presentations answers "not run"', () => {
    mount({ id: 'present', kind: 'html', lastActiveAt: 1, present: true })
    expect(runEditorCommand(deps, 'html', 'print')).toBe(false)
    expect(deps.printHtml).not.toHaveBeenCalled()
  })

  it('save, save-as and print ride the tab-menu rail for every family that lists them', () => {
    mount({ id: 'm1', kind: 'markdown', lastActiveAt: 1 })
    expect(runEditorCommand(deps, 'markdown', 'save')).toBe(true)
    expect(deps.saveMarkdown).toHaveBeenCalledWith(contents.get('m1'), 'save')
    expect(activated).toEqual(['m1'])
    expect(runEditorCommand(deps, 'markdown', 'save-as')).toBe(true)
    expect(deps.saveMarkdown).toHaveBeenCalledWith(contents.get('m1'), 'saveAs')
    expect(runEditorCommand(deps, 'markdown', 'print')).toBe(true)
    expect(deps.printMarkdown).toHaveBeenCalledWith(contents.get('m1'))
  })

  it("docs' zoom-reset rides the app's own word for it: zoom-100", () => {
    mount({ id: 'd1', kind: 'docs', lastActiveAt: 1 })
    expect(runEditorCommand(deps, 'docs', 'zoom-reset')).toBe(true)
    expect(contents.get('d1')!.send).toHaveBeenCalledWith('menu:command', 'zoom-100')
  })

  it('sheets and slides verbs ride their own menu channels', () => {
    mount({ id: 's1', kind: 'sheets', lastActiveAt: 1 })
    mount({ id: 'sl1', kind: 'slides', lastActiveAt: 1 })
    expect(runEditorCommand(deps, 'sheets', 'undo')).toBe(true)
    expect(contents.get('s1')!.send).toHaveBeenCalledWith('menu:action', 'undo')
    expect(runEditorCommand(deps, 'slides', 'zoom-in')).toBe(true)
    expect(contents.get('sl1')!.send).toHaveBeenCalledWith('slides:menu', 'zoom-in')
  })

  it('markdown and html export-pdf ask the renderer to export a pdf', () => {
    mount({ id: 'm1', kind: 'markdown', lastActiveAt: 1 })
    mount({ id: 'h1', kind: 'html', lastActiveAt: 1 })
    expect(runEditorCommand(deps, 'markdown', 'export-pdf')).toBe(true)
    expect(sendMarkdownExportRequest).toHaveBeenCalledWith(contents.get('m1'), 'pdf')
    expect(runEditorCommand(deps, 'html', 'export-pdf')).toBe(true)
    expect(sendHtmlExportRequest).toHaveBeenCalledWith(contents.get('h1'), 'pdf')
  })

  it('a dormant MRU target revives and runs: the revive comes before the guard', () => {
    // a sleeping tab has no view, so the detach guard alone would refuse it —
    // webContentsForTab (which revives) must run first, exactly like the menu
    // rail's own runner, or every verb listed for a sleeping document
    // silently no-ops
    mount({ id: 'dormant', kind: 'docs', lastActiveAt: 1 })
    expect(runEditorCommand(deps, 'docs', 'find')).toBe(true)
    expect(contents.get('dormant')!.send).toHaveBeenCalledWith('menu:command', 'find')
    expect(activated).toEqual(['dormant'])
  })

  it('a tab mid-close is no target for any verb: the arms answer alike', () => {
    // canDetachTab goes false while a tab is closing; the menu verbs already
    // refused it through their own runner, and the channel/export verbs must
    // not send into — or switch the user onto — a renderer being torn down
    mount({ id: 'closing', kind: 'markdown', lastActiveAt: 1 })
    expect(runEditorCommand(deps, 'markdown', 'save')).toBe(false)
    expect(runEditorCommand(deps, 'markdown', 'export-pdf')).toBe(false)
    expect(deps.saveMarkdown).not.toHaveBeenCalled()
    expect(sendMarkdownExportRequest).not.toHaveBeenCalled()
    expect(activated).toEqual([])
  })

  it('a dead renderer answers "not run" rather than throwing', () => {
    mount({ id: 'dead', kind: 'docs', lastActiveAt: 1 })
    expect(runEditorCommand(deps, 'docs', 'find')).toBe(false)
    expect(contents.get('dead')!.send).not.toHaveBeenCalled()
  })

  it('a dead renderer answers "not run" for the menu verbs too, not a silent success', () => {
    // the save/save-as/print arm rides runTabDocumentAction, whose guard
    // answers false on a dead tab — the palette's boolean stays honest
    // instead of implying the save ran
    mount({ id: 'dead', kind: 'markdown', lastActiveAt: 1 })
    expect(runEditorCommand(deps, 'markdown', 'save')).toBe(false)
    expect(deps.saveMarkdown).not.toHaveBeenCalled()
    expect(activated).toEqual([])
  })

  it('no tab of the family means no dispatch', () => {
    mount({ id: 'd1', kind: 'docs', lastActiveAt: 1 })
    expect(runEditorCommand(deps, 'sheets', 'undo')).toBe(false)
    expect(contents.get('d1')!.send).not.toHaveBeenCalled()
  })

  it('every command the renderer may list dispatches for every family that lists it', () => {
    // the contract both sides share: editorCommandsFor decides what is
    // listed, runEditorCommand decides what runs — a listed-but-unrunnable
    // pair would be a palette promise the shell cannot keep
    for (const kind of [
      'docs',
      'sheets',
      'slides',
      'pdf',
      'markdown',
      'html',
    ] as DocumentTabKind[]) {
      tabs = []
      contents = new Map()
      mount({ id: 'only', kind, lastActiveAt: 1 })
      for (const command of editorCommandsFor(kind)) {
        vi.clearAllMocks()
        activated = []
        expect(runEditorCommand(deps, kind, command), `${kind} ${command}`).toBe(true)
      }
    }
  })

  it('an off-table pair answers "not run" without resolving, activating, or messaging', () => {
    // the shape guard on the IPC surface accepts any verb from the shared
    // vocabulary; the dispatch is the binding backstop. A stray verb must
    // never reach a family's menu channel — sheets' renderer routes any
    // unrecognized menu action into its save flow — and must not even switch
    // the user to the tab it named. The table's one deliberate absence is
    // pinned too: pdf has no export verb (save-as is that dialog)
    mount({ id: 's1', kind: 'sheets', lastActiveAt: 1 })
    mount({ id: 'p1', kind: 'pdf', lastActiveAt: 1 })
    mount({ id: 'm1', kind: 'markdown', lastActiveAt: 1 })
    expect(runEditorCommand(deps, 'sheets', 'find')).toBe(false)
    expect(runEditorCommand(deps, 'pdf', 'undo')).toBe(false)
    expect(runEditorCommand(deps, 'pdf', 'export-pdf')).toBe(false)
    expect(activated).toEqual([])
    expect(contents.get('s1')!.send).not.toHaveBeenCalled()
    expect(contents.get('p1')!.send).not.toHaveBeenCalled()
    expect(contents.get('m1')!.send).not.toHaveBeenCalled()
    expect(deps.savePdf).not.toHaveBeenCalled()
    expect(deps.savePdfAs).not.toHaveBeenCalled()
    expect(deps.saveMarkdown).not.toHaveBeenCalled()
  })
})

describe('isValidEditorCommand', () => {
  it('accepts the six editor families and the shared command vocabulary', () => {
    expect(isValidEditorCommand('docs', 'save')).toBe(true)
    expect(isValidEditorCommand('html', 'export-pdf')).toBe(true)
    expect(isValidEditorCommand('html', 'export-pdf', 't3')).toBe(true)
    expect(isValidEditorCommand('html', 'export-pdf', undefined)).toBe(true)
  })

  it('rejects non-editors, unknown commands, and non-strings', () => {
    expect(isValidEditorCommand('home', 'save')).toBe(false)
    expect(isValidEditorCommand('help', 'find')).toBe(false)
    expect(isValidEditorCommand('docs', 'export-csv')).toBe(false)
    expect(isValidEditorCommand(undefined, 'save')).toBe(false)
    expect(isValidEditorCommand('docs', 42)).toBe(false)
    // the optional tab id is a string or absent, nothing else
    expect(isValidEditorCommand('docs', 'save', 42)).toBe(false)
    expect(isValidEditorCommand('docs', 'save', null)).toBe(false)
  })
})
