import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', () => {
  const realpathSync = ((path?: string) => {
    if (path === undefined) return undefined
    if (path === '/real/file' || path === '/canonical/file' || path === '/REAL/FILE')
      return '/real/file'
    return path
  }) as typeof import('node:fs').realpathSync

  realpathSync.native = ((path?: string) => {
    if (path === undefined) return undefined
    if (path === '/real/file' || path === '/canonical/file' || path === '/REAL/FILE')
      return '/real/file'
    return path
  }) as typeof import('node:fs').realpathSync.native

  return { realpathSync }
})

/**
 * TabManager (src/main/tab-manager.ts): tab list state, activation,
 * close guards, and view lifecycle inside the shell's single window.
 * Electron and the per-module main entrypoints are mocked; only the
 * manager's own observable behavior is asserted.
 */

interface FakeWebContents {
  id: number
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  reload: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  listeners: Map<string, () => void>
}

interface FakeView {
  webContents: FakeWebContents
  setVisible: ReturnType<typeof vi.fn>
  setBounds: ReturnType<typeof vi.fn>
}

let nextWebContentsId = 1

function makeFakeView(): FakeView {
  const listeners = new Map<string, () => void>()
  return {
    webContents: {
      id: nextWebContentsId++,
      listeners,
      on: vi.fn((event: string, handler: () => void) => {
        listeners.set(event, handler)
      }),
      once: vi.fn(),
      close: vi.fn(),
      reload: vi.fn(),
      focus: vi.fn(),
      isDestroyed: vi.fn(() => false),
    },
    setVisible: vi.fn(),
    setBounds: vi.fn(),
  }
}

vi.mock('electron', () => ({
  BrowserWindow: class {},
  // the manual's view is constructed inline in tab-manager (createHelpView),
  // unlike the editor views which arrive through mocked module factories, so
  // the electron mock itself must construct one. Self-contained: no outside
  // references (vi.mock factories run before the module body). The large id
  // stays clear of makeFakeView's counter. Sent channels and loaded URLs are
  // recorded on the class so the help deep-link tests can read them.
  WebContentsView: class {
    static sent: Array<{ channel: string; args: unknown[] }> = []
    static loadedUrls: string[] = []
    webContents = {
      id: 900001,
      setWindowOpenHandler: () => ({ action: 'deny' as const }),
      loadURL: (url: string) => {
        WebContentsView.loadedUrls.push(url)
        return Promise.resolve()
      },
      focus: () => {},
      on: () => {},
      once: () => {},
      close: () => {},
      reload: () => {},
      isDestroyed: () => false,
      send: (channel: string, ...args: unknown[]) => {
        WebContentsView.sent.push({ channel, args })
      },
    }
    setBounds = () => {}
    setVisible = () => {}
  },
}))

const createDocsView = vi.fn(() => makeFakeView())
const docsQueryDirty = vi.fn(() => Promise.resolve(false))
const markDocsNewBlank = vi.fn()
const requestDocsClose = vi.fn(() => Promise.resolve(true))
const setActiveDocsResolver = vi.fn()
const teardownDocsRenderer = vi.fn()

vi.mock('../../docs/src/main/docs-main', () => ({
  // buildDocsMenu/queueDocsAiContent are referenced by the app registry at
  // module scope; TabManager's own tests never call them
  buildDocsMenu: vi.fn(),
  queueDocsAiContent: vi.fn(),
  createDocsView: (...args: unknown[]) => createDocsView(...(args as [])),
  docsQueryDirty: (...args: unknown[]) => docsQueryDirty(...(args as [])),
  markDocsNewBlank: (...args: unknown[]) => markDocsNewBlank(...args),
  requestDocsClose: (...args: unknown[]) => requestDocsClose(...(args as [])),
  setActiveDocsResolver: (...args: unknown[]) => setActiveDocsResolver(...args),
  teardownDocsRenderer: (...args: unknown[]) => teardownDocsRenderer(...args),
}))

const createPdfView = vi.fn(() => makeFakeView())
const pdfIsDirty = vi.fn(() => false)
const clearPdfDirty = vi.fn()
const requestPdfClose = vi.fn(() => Promise.resolve(true))

vi.mock('../../pdf/src/main/pdf-main', () => ({
  createPdfView: (...args: unknown[]) => createPdfView(...(args as [])),
  pdfIsDirty: (...args: unknown[]) => pdfIsDirty(...(args as [])),
  clearPdfDirty: (...args: unknown[]) => clearPdfDirty(...(args as [])),
  requestPdfClose: (...args: unknown[]) => requestPdfClose(...(args as [])),
}))

const createSheetsView = vi.fn(() => makeFakeView())
const nudgeQueuedWorkbook = vi.fn()
const queueWorkbookForView = vi.fn()
const requestSheetsClose = vi.fn(() => Promise.resolve(true))
const setActiveSheetsWebContents = vi.fn()
const setSheetsNewBlank = vi.fn()
const sheetsPendingEditCount = vi.fn(() => 0)

vi.mock('../../sheets/src/main/sheets-main', () => ({
  // installSheetsMenu is referenced by the app registry at module scope
  installSheetsMenu: vi.fn(),
  createSheetsView: (...args: unknown[]) => createSheetsView(...(args as [])),
  nudgeQueuedWorkbook: (...args: unknown[]) => nudgeQueuedWorkbook(...args),
  queueWorkbookForView: (...args: unknown[]) => queueWorkbookForView(...args),
  requestSheetsClose: (...args: unknown[]) => requestSheetsClose(...(args as [])),
  setActiveSheetsWebContents: (...args: unknown[]) => setActiveSheetsWebContents(...args),
  setSheetsNewBlank: (...args: unknown[]) => setSheetsNewBlank(...args),
  sheetsPendingEditCount: (...args: unknown[]) => sheetsPendingEditCount(...(args as [])),
}))

const createSlidesView = vi.fn(() => makeFakeView())
const requestSlidesClose = vi.fn(() => Promise.resolve(true))
const setActiveSlidesWebContents = vi.fn()
const slidesIsDirty = vi.fn(() => false)

vi.mock('../../slides/src/main/slides-main', () => ({
  // installSlidesMenu/discardSlidesRecovery are referenced by the app registry
  installSlidesMenu: vi.fn(),
  discardSlidesRecovery: vi.fn(),
  createSlidesView: (...args: unknown[]) => createSlidesView(...(args as [])),
  requestSlidesClose: (...args: unknown[]) => requestSlidesClose(...(args as [])),
  setActiveSlidesWebContents: (...args: unknown[]) => setActiveSlidesWebContents(...args),
  slidesIsDirty: (...args: unknown[]) => slidesIsDirty(...(args as [])),
}))

const createMarkdownView = vi.fn(() => makeFakeView())
const markdownIsDirty = vi.fn(() => false)
const requestMarkdownClose = vi.fn(() => Promise.resolve(true))

vi.mock('../../markdown/src/main/markdown-main', () => ({
  // the agent-surface trio is referenced by the app registry at module scope
  markdownDiscardPendingAssets: vi.fn(async () => undefined),
  markdownReadText: vi.fn(async () => ''),
  markdownSaveToPath: vi.fn(async () => undefined),
  createMarkdownView: (...args: unknown[]) => createMarkdownView(...(args as [])),
  markdownIsDirty: (...args: unknown[]) => markdownIsDirty(...(args as [])),
  requestMarkdownClose: (...args: unknown[]) => requestMarkdownClose(...(args as [])),
}))

const createHtmlView = vi.fn(() => makeFakeView())
const createHtmlPresentView = vi.fn(() => makeFakeView())
const htmlIsDirty = vi.fn(() => false)
const requestHtmlClose = vi.fn(() => Promise.resolve(true))

vi.mock('../../html/src/main/html-main', () => ({
  // the agent-surface trio is referenced by the app registry at module scope
  htmlDiscardPendingAssets: vi.fn(async () => undefined),
  htmlReadText: vi.fn(async () => ''),
  htmlSaveToPath: vi.fn(async () => undefined),
  createHtmlView: (...args: unknown[]) => createHtmlView(...(args as [])),
  createHtmlPresentView: (...args: unknown[]) => createHtmlPresentView(...(args as [])),
  htmlIsDirty: (...args: unknown[]) => htmlIsDirty(...(args as [])),
  requestHtmlClose: (...args: unknown[]) => requestHtmlClose(...(args as [])),
}))

import { TabManager } from '../src/main/tab-manager'
import { HOME_CHANNELS } from '../src/shared/home-api'
import type { TabKind } from '../src/shared/tabs-api'
import {
  AI_DOCK_RAIL_WIDTH,
  AI_DOCK_WIDTH_DEFAULT,
  DESKTOP_HEADER_HEIGHT,
} from '../src/shared/desktop-geometry'
import { WebContentsView } from 'electron'

/** the manual-tab view mock's recorder — the live static arrays, so test-file
 *  resets actually clear them (a mapped copy would reset a throwaway) */
const helpRecorder = () =>
  WebContentsView as unknown as {
    sent: Array<{ channel: string; args: unknown[] }>
    loadedUrls: string[]
  }

/** the manual-tab view mock's recorded sends, as (channel, arg) tuples */
const helpSent = (): Array<[string, unknown]> =>
  helpRecorder().sent.map(({ channel, args }) => [channel, ...args] as [string, unknown])

/** the manual-tab view mock's recorded loadURL calls */
const helpLoadedUrls = (): string[] => helpRecorder().loadedUrls

const WINDOW_WIDTH = 800
const WINDOW_HEIGHT = 600
/** the default expanded AI dock occupies this many window px beside a document */
const DOCK_WIDTH = AI_DOCK_WIDTH_DEFAULT
/** the desktop header band above an embedded document (the fallback geometry) */
const HEADER = DESKTOP_HEADER_HEIGHT

/** the fallback rect an embedded document view gets at scale 1 with the default dock */
function embeddedBounds(width = WINDOW_WIDTH, height = WINDOW_HEIGHT) {
  return {
    x: 0,
    y: HEADER,
    width: width - DOCK_WIDTH,
    height: height - HEADER,
  }
}

interface FakeShellWindow {
  on: ReturnType<typeof vi.fn>
  webContents: {
    once: ReturnType<typeof vi.fn>
    focus: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
    send: ReturnType<typeof vi.fn>
    listeners: Map<string, (event: never, input: never) => void>
    isDestroyed: ReturnType<typeof vi.fn>
  }
  isDestroyed: ReturnType<typeof vi.fn>
  isFocused: ReturnType<typeof vi.fn>
  isMinimized: ReturnType<typeof vi.fn>
  restore: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  getContentBounds: () => { x: number; y: number; width: number; height: number }
  contentView: {
    addChildView: ReturnType<typeof vi.fn>
    removeChildView: ReturnType<typeof vi.fn>
  }
}

function makeShellWindow(): FakeShellWindow {
  // the chrome webContents records its listeners so the palette-summon tests
  // can press keys at the shell window itself (Home is the palette host)
  const chromeListeners = new Map<string, (event: never, input: never) => void>()
  return {
    on: vi.fn(),
    webContents: {
      once: vi.fn(),
      focus: vi.fn(),
      on: vi.fn((event: string, handler: (event: never, input: never) => void) => {
        chromeListeners.set(event, handler)
      }),
      send: vi.fn(),
      listeners: chromeListeners,
      isDestroyed: vi.fn(() => false),
    },
    isDestroyed: vi.fn(() => false),
    isFocused: vi.fn(() => true),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    getContentBounds: () => ({ x: 0, y: 0, width: WINDOW_WIDTH, height: WINDOW_HEIGHT }),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  }
}

let shellWindow: FakeShellWindow
let onChanged: ReturnType<typeof vi.fn>
let applyMenuFor: ReturnType<typeof vi.fn>
let manager: TabManager

function lastCreatedView(factory: ReturnType<typeof vi.fn>): FakeView {
  return factory.mock.results.at(-1)!.value as FakeView
}

beforeEach(() => {
  vi.clearAllMocks()
  nextWebContentsId = 1
  helpRecorder().sent.length = 0
  helpRecorder().loadedUrls.length = 0
  docsQueryDirty.mockImplementation(() => Promise.resolve(false))
  requestDocsClose.mockImplementation(() => Promise.resolve(true))
  pdfIsDirty.mockImplementation(() => false)
  sheetsPendingEditCount.mockImplementation(() => 0)
  slidesIsDirty.mockImplementation(() => false)
  shellWindow = makeShellWindow()
  onChanged = vi.fn()
  applyMenuFor = vi.fn()
  manager = new TabManager(
    shellWindow as never,
    () => onChanged(),
    (kind) => applyMenuFor(kind),
  )
})

describe('initial state', () => {
  it('starts with only the non-closable, active Home tab', () => {
    // expect.any pins the summary's lastActiveAt export itself: the palette's
    // MRU resolution reads it, and undefined would fail the matcher
    expect(manager.list()).toMatchObject([
      {
        id: 'home',
        kind: 'home',
        title: 'GenOffice',
        closable: false,
        active: true,
        lastActiveAt: expect.any(Number),
      },
    ])
  })
})

describe('activation stamps', () => {
  it('keeps the most recently used editor answerable while Home holds the active slot', () => {
    // the palette summons itself on Home, so `active` can never name the
    // editor the user was last in — its lastActiveAt must. A controlled clock
    // keeps the stamps strictly ordered across fast consecutive activations.
    // The last-used editor (d1) is deliberately the OLDER-CREATED one: if
    // activation did not stamp, the create-time stamps would leave d2 newest
    // and the palette would list commands for a document the user left
    let clock = 1_000
    const now = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 10))
    try {
      const d1 = manager.openDocsTab()
      const d2 = manager.openDocsTab()
      // the user works in d2 first, then returns to d1 before going Home
      manager.activateTab(d2)
      manager.activateTab(d1)
      // Home takes over: the editor it replaced carries the newest editor
      // stamp, exactly the state the command palette lists commands from
      manager.activateTab('home')
      const stamps = new Map(manager.list().map((t) => [t.id, t.lastActiveAt]))
      expect(stamps.get(d1)!).toBeGreaterThan(stamps.get(d2)!)
      expect(manager.list().find((t) => t.id === 'home')?.active).toBe(true)
    } finally {
      now.mockRestore()
    }
  })

  it('activating a tab stamps the target itself, not only what it replaced', () => {
    // the fallback flows re-activate a neighbour that was never the active
    // tab's predecessor (closing the active tab, detaching); the target's
    // own stamp is what keeps the MRU answer pointing at it afterwards
    let clock = 1_000
    const now = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 10))
    try {
      const d1 = manager.openDocsTab()
      const d2 = manager.openDocsTab()
      const d3 = manager.openDocsTab()
      manager.activateTab('home')
      // d1 is the strip-oldest and was never the active tab's predecessor
      manager.activateTab(d1)
      const stamps = new Map(manager.list().map((t) => [t.id, t.lastActiveAt]))
      expect(stamps.get(d1)!).toBeGreaterThan(stamps.get(d2)!)
      expect(stamps.get(d1)!).toBeGreaterThan(stamps.get(d3)!)
    } finally {
      now.mockRestore()
    }
  })

  it('reports a presentation view in the summary so palette consumers can skip it', () => {
    // html Present renders a document but owns no editor surface: the
    // summary's flag is what lets the palette's command resolution route to
    // the owning editor tab instead
    const id = manager.openHtmlPresentTab(makeFakeView().webContents as never, 'Live preview')
    expect(manager.list().find((t) => t.id === id)).toMatchObject({
      kind: 'html',
      present: true,
      title: 'Live preview',
    })
  })
})

describe('opening tabs', () => {
  it('focuses the help tab already open instead of opening a second one', () => {
    // F1 is a toggle-shaped key in practice: press it, read something, press it
    // again. The help tab is closable (only Home is not), so a second copy is
    // never what the reader meant.
    const first = manager.openHelpTab()
    expect(manager.list()).toHaveLength(2)
    const second = manager.openHelpTab()
    expect(second).toBe(first)
    expect(manager.list()).toHaveLength(2)
    expect(manager.list()[1]).toMatchObject({ id: first, kind: 'help', active: true })
    expect(shellWindow.contentView.addChildView).toHaveBeenCalledTimes(1)
  })

  it('reactivates the help tab when another tab took over', () => {
    const helpId = manager.openHelpTab()
    const docsId = manager.openDocsTab()
    expect(manager.list().find((t) => t.id === docsId)?.active).toBe(true)
    manager.openHelpTab()
    expect(manager.list().find((t) => t.id === helpId)?.active).toBe(true)
    expect(manager.list().find((t) => t.id === docsId)?.active).toBe(false)
  })

  it('opens a fresh help tab once the previous one was closed', () => {
    const first = manager.openHelpTab()
    manager.closeTabWithoutPrompt(first)
    const second = manager.openHelpTab()
    expect(second).not.toBe(first)
    expect(manager.list().filter((t) => t.kind === 'help')).toHaveLength(1)
  })

  it('deep-links a palette help topic through the fresh manual view URL', () => {
    // openHelp(topic) on the first open: the topic rides the ?mode=help URL,
    // and the manual renderer reads it as its initial article
    manager.openHelpTab('pdf')
    expect(helpLoadedUrls()).toHaveLength(1)
    expect(helpLoadedUrls()[0]).toContain('mode=help')
    expect(helpLoadedUrls()[0]).toContain('topic=pdf')
    // the channel route is for the already-open case only
    expect(helpSent()).toEqual([])
  })

  it('deep-links a palette help topic to the already-open manual over the channel', () => {
    // the URL is fixed once the view exists, so a topic picked later (the
    // palette's help row while the manual tab is already open) arrives as a
    // home:help-topic event, and the tab is activated to read it
    const helpId = manager.openHelpTab()
    manager.openDocsTab()
    manager.openHelpTab('pdf')
    expect(helpSent()).toEqual([[HOME_CHANNELS.helpTopic, 'pdf']])
    expect(manager.list().find((t) => t.id === helpId)?.active).toBe(true)
    expect(manager.list().filter((t) => t.kind === 'help')).toHaveLength(1)
  })

  it('a help topic on a fresh manual still lands via URL after the channel case ran', () => {
    // both deep-link routes must stay independent: a topic sent over the
    // channel to one manual must not bleed into the next manual's URL
    manager.openHelpTab('pdf')
    manager.closeTabWithoutPrompt(manager.list().find((t) => t.kind === 'help')!.id)
    manager.openHelpTab('shortcuts')
    expect(helpLoadedUrls().at(-1)).toContain('topic=shortcuts')
  })

  it('opens a docs tab, activates it, and attaches its view to the window', () => {
    const id = manager.openDocsTab()
    const tabs = manager.list()
    expect(tabs).toHaveLength(2)
    expect(tabs[1]).toMatchObject({
      id,
      kind: 'docs',
      title: 'GenOffice Docs',
      closable: true,
      active: true,
    })
    expect(tabs[0].active).toBe(false)
    expect(shellWindow.contentView.addChildView).toHaveBeenCalledTimes(1)
    expect(applyMenuFor).toHaveBeenLastCalledWith('docs')
    expect(onChanged).toHaveBeenCalled()
  })

  it('titles file-backed tabs with the file basename', () => {
    manager.openDocsTab('/tmp/report.docx')
    manager.openSheetsTab('/tmp/budget.xlsx')
    manager.openSlidesTab('/tmp/deck.pptx')
    manager.openPdfTab('/tmp/scan.pdf')
    expect(manager.list().map((t) => t.title)).toEqual([
      'GenOffice',
      'report.docx',
      'budget.xlsx',
      'deck.pptx',
      'scan.pdf',
    ])
  })

  it('uses module default titles for pathless tabs', () => {
    manager.openSheetsTab()
    manager.openSlidesTab()
    expect(manager.list().map((t) => t.title)).toEqual(['GenOffice', 'AI Sheets', 'AI Slides'])
  })

  it('assigns unique, monotonic tab ids', () => {
    const a = manager.openDocsTab()
    const b = manager.openSheetsTab()
    expect(a).not.toBe(b)
    expect(a).toBe('t1')
    expect(b).toBe('t2')
  })

  it('forwards the new-blank flag to the module', () => {
    manager.openDocsTab(undefined, { newBlank: true })
    expect(markDocsNewBlank).toHaveBeenCalledTimes(1)
    manager.openSheetsTab(undefined, { newBlank: true })
    expect(setSheetsNewBlank).toHaveBeenCalledTimes(1)
  })
})

describe('listWithDirty', () => {
  it("resolves each tab's unsaved state while the sync list stays dirtiness-free", async () => {
    manager.openDocsTab('/tmp/report.docx')
    manager.openPdfTab('/tmp/scan.pdf')
    // docs answers through its renderer round-trip, pdf synchronously; home
    // has no document to be dirty
    docsQueryDirty.mockImplementation(() => Promise.resolve(true))
    pdfIsDirty.mockImplementation(() => false)
    const withDirty = await manager.listWithDirty()
    expect(withDirty).toMatchObject([
      { id: 'home', kind: 'home', dirty: false },
      { kind: 'docs', filePath: '/tmp/report.docx', dirty: true },
      { kind: 'pdf', filePath: '/tmp/scan.pdf', dirty: false },
    ])
    // the face the tab menus use is unchanged — no dirty key at all
    for (const tab of manager.list()) expect(tab.dirty).toBeUndefined()
  })

  it('a dormant tab answers clean without asking its released renderer', async () => {
    const a = manager.openDocsTab('/a.docx')
    manager.openDocsTab('/b.docx')
    manager.openDocsTab('/c.docx')
    const slept = await manager.sleepIdleTabs({ maxLiveTabs: 2, idleMs: 1000 }, Date.now() + 5000)
    expect(slept).toEqual([a])
    docsQueryDirty.mockClear()
    const withDirty = await manager.listWithDirty()
    expect(withDirty.find((t) => t.id === a)).toMatchObject({ dormant: true, dirty: false })
    // only the two live docs tabs were asked — the dormant one has no
    // renderer to ask, which is why it answers clean by construction
    const asked = docsQueryDirty.mock.calls.map((call) => (call[0] as { id: number }).id)
    expect(asked).toHaveLength(2)
    expect(asked).not.toContain((createDocsView.mock.results[0]!.value as FakeView).webContents.id)
  })
})

describe('spare sheets view', () => {
  it('does not warm Sheets during Home or Docs sessions', () => {
    vi.useFakeTimers()
    try {
      const homeLoaded = shellWindow.webContents.once.mock.calls.find(
        ([event]) => event === 'did-finish-load',
      )
      ;(homeLoaded?.[1] as (() => void) | undefined)?.()
      vi.advanceTimersByTime(5000)
      manager.openDocsTab('/tmp/report.docx')
      vi.advanceTimersByTime(5000)
      expect(createSheetsView).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('warms a spare while Sheets is active and hands it to the next open', () => {
    vi.useFakeTimers()
    try {
      manager.setStageRect({ x: 208, y: 44, width: 552, height: 556 })
      manager.openSheetsTab('/tmp/first.xlsx')
      expect(createSheetsView).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(3000)
      expect(createSheetsView).toHaveBeenCalledTimes(2)
      const spare = lastCreatedView(createSheetsView)
      expect(shellWindow.contentView.addChildView).toHaveBeenCalledWith(spare)
      expect(spare.setVisible).toHaveBeenLastCalledWith(false)
      expect(manager.list()).toHaveLength(2)

      manager.openSheetsTab('/tmp/budget.xlsx')
      expect(createSheetsView).toHaveBeenCalledTimes(2)
      expect(queueWorkbookForView).toHaveBeenCalledWith(spare.webContents, '/tmp/budget.xlsx')
      expect(nudgeQueuedWorkbook).toHaveBeenCalledWith(spare.webContents)
      expect(spare.setVisible).toHaveBeenLastCalledWith(true)
      expect(manager.list()[2]).toMatchObject({
        kind: 'sheets',
        title: 'budget.xlsx',
        active: true,
      })

      vi.advanceTimersByTime(3000)
      expect(createSheetsView).toHaveBeenCalledTimes(3)
      expect(lastCreatedView(createSheetsView)).not.toBe(spare)
      expect(setActiveSheetsWebContents).toHaveBeenLastCalledWith(spare.webContents)
    } finally {
      vi.useRealTimers()
    }
  })

  it('creates a fresh view when no spare is ready and does not nudge it', () => {
    manager.openSheetsTab('/tmp/budget.xlsx')
    expect(createSheetsView).toHaveBeenCalledTimes(1)
    expect(createSheetsView).toHaveBeenCalledWith({
      includeAiHandlers: false,
      openingWorkbook: true,
    })
    expect(nudgeQueuedWorkbook).not.toHaveBeenCalled()
  })

  it('starts a new blank view without the opening state', () => {
    manager.openSheetsTab()
    expect(createSheetsView).toHaveBeenCalledWith({
      includeAiHandlers: false,
      openingWorkbook: false,
    })
  })

  it('drops a spare whose renderer died instead of handing it out', () => {
    vi.useFakeTimers()
    try {
      manager.openSheetsTab()
      vi.advanceTimersByTime(3000)
      const spare = lastCreatedView(createSheetsView)
      const gone = spare.webContents.once.mock.calls.find(
        ([event]) => event === 'render-process-gone',
      )
      ;(gone![1] as () => void)()
      expect(spare.webContents.close).toHaveBeenCalledTimes(1)
      manager.openSheetsTab()
      expect(createSheetsView).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a pending spare and closes an existing spare on leaving Sheets', () => {
    vi.useFakeTimers()
    try {
      const sheetsId = manager.openSheetsTab()
      manager.openDocsTab()
      vi.advanceTimersByTime(3000)
      expect(createSheetsView).toHaveBeenCalledTimes(1)

      manager.activateTab(sheetsId)
      vi.advanceTimersByTime(3000)
      expect(createSheetsView).toHaveBeenCalledTimes(2)
      const spare = lastCreatedView(createSheetsView)
      manager.activateTab('home')
      expect(shellWindow.contentView.removeChildView).toHaveBeenCalledWith(spare)
      expect(spare.webContents.close).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays off under GENOFFICE_NO_SPARE_VIEW', () => {
    vi.stubEnv('GENOFFICE_NO_SPARE_VIEW', '1')
    vi.useFakeTimers()
    try {
      manager.openSheetsTab()
      vi.advanceTimersByTime(5000)
      expect(createSheetsView).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      vi.unstubAllEnvs()
    }
  })
})

describe('activation', () => {
  it('shows only the activated tab view and embeds it beside the AI dock', () => {
    // the boot sequence: the desktop reports its stage before the first
    // document activates (the pre-report hold test below covers the gap)
    manager.setStageRect({ x: 208, y: 44, width: 552, height: 556 })
    const docsId = manager.openDocsTab()
    const docsView = lastCreatedView(createDocsView)
    manager.openSheetsTab()
    const sheetsView = lastCreatedView(createSheetsView)

    manager.activateTab(docsId)
    expect(docsView.setVisible).toHaveBeenLastCalledWith(true)
    expect(sheetsView.setVisible).toHaveBeenLastCalledWith(false)
    // the document fills the desktop's reported content area exactly
    expect(docsView.setBounds).toHaveBeenLastCalledWith({
      x: 208,
      y: 44,
      width: 552,
      height: 556,
    })
    expect(manager.list().find((t) => t.id === docsId)?.active).toBe(true)
  })

  it('hands keyboard focus to the activated view so typing works right after open/switch', () => {
    const docsId = manager.openDocsTab()
    const docsView = lastCreatedView(createDocsView)
    expect(docsView.webContents.focus).toHaveBeenCalled()

    docsView.webContents.focus.mockClear()
    manager.activateTab('home')
    expect(shellWindow.webContents.focus).toHaveBeenCalled()
    manager.activateTab(docsId)
    expect(docsView.webContents.focus).toHaveBeenCalledTimes(1)
  })

  it('does not steal OS focus for a background open (window unfocused)', () => {
    shellWindow.isFocused.mockReturnValue(false)
    manager.openDocsTab()
    const docsView = lastCreatedView(createDocsView)
    expect(docsView.webContents.focus).not.toHaveBeenCalled()

    // the window `focus` handler runs it once the user comes back
    shellWindow.isFocused.mockReturnValue(true)
    manager.focusActiveView()
    expect(docsView.webContents.focus).toHaveBeenCalledTimes(1)
  })

  it('ignores activation of unknown tab ids', () => {
    onChanged.mockClear()
    manager.activateTab('nope')
    expect(onChanged).not.toHaveBeenCalled()
    expect(manager.list()[0].active).toBe(true)
  })

  it('routes the active webContents to the matching module', () => {
    manager.openSheetsTab()
    const sheetsView = lastCreatedView(createSheetsView)
    expect(setActiveSheetsWebContents).toHaveBeenLastCalledWith(sheetsView.webContents)

    manager.openSlidesTab()
    const slidesView = lastCreatedView(createSlidesView)
    expect(setActiveSlidesWebContents).toHaveBeenLastCalledWith(slidesView.webContents)
  })

  it('lets the active view cover the tab strip during HTML fullscreen', () => {
    manager.openSlidesTab()
    const view = lastCreatedView(createSlidesView)
    view.webContents.listeners.get('enter-html-full-screen')!()
    expect(view.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 0,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
    })
    view.webContents.listeners.get('leave-html-full-screen')!()
    expect(view.setBounds).toHaveBeenLastCalledWith(embeddedBounds())
  })
})

describe('desktop content-area geometry (embedded document views)', () => {
  function managerWithDock(
    dock: () => { width: number; collapsed: boolean },
    scale: () => number = () => 1,
  ): TabManager {
    return new TabManager(
      shellWindow as never,
      () => onChanged(),
      (kind) => applyMenuFor(kind),
      undefined,
      scale,
      dock,
    )
  }

  it('reserves the mascot rail while the dock is collapsed', () => {
    const docked = managerWithDock(() => ({ width: 480, collapsed: true }))
    docked.openDocsTab()
    const view = lastCreatedView(createDocsView)
    // the collapsed dock is the corner pet's rail, not zero width: the pet
    // stays visible and clickable beside the document
    expect(view.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: HEADER,
      width: WINDOW_WIDTH - AI_DOCK_RAIL_WIDTH,
      height: WINDOW_HEIGHT - HEADER,
    })
  })

  it('re-fits the active document when the dock pref changes between layouts', () => {
    let dock = { width: 480, collapsed: false }
    const docked = managerWithDock(() => dock)
    docked.openDocsTab()
    const view = lastCreatedView(createDocsView)
    expect(view.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: HEADER,
      width: WINDOW_WIDTH - 480,
      height: WINDOW_HEIGHT - HEADER,
    })
    // the renderer wrote `aiDock`: the next layout reads the new state
    dock = { width: 480, collapsed: true }
    docked.layout()
    expect(view.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: HEADER,
      width: WINDOW_WIDTH - AI_DOCK_RAIL_WIDTH,
      height: WINDOW_HEIGHT - HEADER,
    })
  })

  it('clamps an oversized dock to the shared max, like the renderer drag does', () => {
    const docked = managerWithDock(() => ({ width: 2000, collapsed: false }))
    docked.openDocsTab()
    const view = lastCreatedView(createDocsView)
    expect(view.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: HEADER,
      width: WINDOW_WIDTH - 560,
      height: WINDOW_HEIGHT - HEADER,
    })
  })

  it('scales the header and the dock footprint with the interface scale', () => {
    const docked = managerWithDock(
      () => ({ width: 400, collapsed: false }),
      () => 1.5,
    )
    docked.openDocsTab()
    const view = lastCreatedView(createDocsView)
    // header 44 × 1.5 = 66; a 400 CSS px dock occupies 600 window px at 150%
    expect(view.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 66,
      width: WINDOW_WIDTH - 600,
      height: WINDOW_HEIGHT - 66,
    })
  })

  it('uses the renderer-reported stage rect exactly, and a newer report wins', () => {
    manager.openDocsTab()
    const view = lastCreatedView(createDocsView)
    // the desktop's own layout reports where its stage sits — the sidebar and
    // the embedded strip live in those numbers, not in the fallback constants
    manager.setStageRect({ x: 208, y: 44, width: 552, height: 556 })
    expect(view.setBounds).toHaveBeenLastCalledWith({
      x: 208,
      y: 44,
      width: 552,
      height: 556,
    })
    manager.setStageRect({ x: 208, y: 44, width: 452, height: 556 })
    expect(view.setBounds).toHaveBeenLastCalledWith({
      x: 208,
      y: 44,
      width: 452,
      height: 556,
    })
  })

  it('a degenerate stage report never zero-sizes the view; the next good one applies', () => {
    manager.openDocsTab()
    const view = lastCreatedView(createDocsView)
    view.setBounds.mockClear()
    manager.setStageRect({ x: 0, y: 44, width: 0, height: 0 })
    // the degenerate rect shares no area with the window: the intersection is
    // empty, so the computed geometry stands in — never a zero-sized view
    expect(view.setBounds).toHaveBeenLastCalledWith(embeddedBounds())
    manager.setStageRect({ x: 208, y: 44, width: 552, height: 556 })
    expect(view.setBounds).toHaveBeenLastCalledWith({
      x: 208,
      y: 44,
      width: 552,
      height: 556,
    })
  })

  it('holds a document hidden until the first stage report, then embeds it at the reported rect', () => {
    // a launch with file arguments: the tab activates before Home has
    // measured its stage, and the only geometry known is the fallback whose
    // x/y would cover the desktop's own chrome — so the view stays hidden
    // (the desktop shows) until the report arrives
    manager.openDocsTab('/tmp/report.docx')
    const view = lastCreatedView(createDocsView)
    expect(view.setVisible).not.toHaveBeenCalledWith(true)
    expect(view.setBounds).toHaveBeenLastCalledWith(embeddedBounds())

    manager.setStageRect({ x: 208, y: 44, width: 552, height: 556 })
    expect(view.setBounds).toHaveBeenLastCalledWith({
      x: 208,
      y: 44,
      width: 552,
      height: 556,
    })
    expect(view.setVisible).toHaveBeenLastCalledWith(true)
  })

  it('clips a stale stage rect to the shrunk window between reports', () => {
    manager.setStageRect({ x: 208, y: 44, width: 552, height: 556 })
    manager.openDocsTab()
    const view = lastCreatedView(createDocsView)
    view.setBounds.mockClear()
    // the resize layout runs before the renderer's ResizeObserver reports the
    // new stage: the stored rect still describes the pre-shrink window
    shellWindow.getContentBounds = () => ({ x: 0, y: 0, width: 500, height: 400 })
    manager.layout()
    // never past the window's edges — the dock rail and the strip stay clear
    // of the document instead of being spilled over
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 208, y: 44, width: 292, height: 356 })
  })

  it('falls back to the computed geometry once the shrunk window no longer overlaps the stage', () => {
    manager.setStageRect({ x: 700, y: 44, width: 100, height: 556 })
    manager.openDocsTab()
    const view = lastCreatedView(createDocsView)
    view.setBounds.mockClear()
    // the stored stage sits past the shrunk window's right edge: no overlap
    shellWindow.getContentBounds = () => ({ x: 0, y: 0, width: 650, height: 600 })
    manager.layout()
    expect(view.setBounds).toHaveBeenLastCalledWith(embeddedBounds(650, 600))
  })

  it('keeps HTML fullscreen covering the whole window even with a stage rect on file', () => {
    manager.setStageRect({ x: 208, y: 44, width: 552, height: 556 })
    manager.openSlidesTab()
    const view = lastCreatedView(createSlidesView)
    view.webContents.listeners.get('enter-html-full-screen')!()
    expect(view.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 0,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
    })
  })

  it('keeps the content-bleed path (slides show) covering the whole window, then embeds again', () => {
    manager.setStageRect({ x: 208, y: 44, width: 552, height: 556 })
    manager.openSlidesTab()
    const view = lastCreatedView(createSlidesView)
    manager.setContentBleed(view.webContents, true)
    expect(view.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 0,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
    })
    manager.setContentBleed(view.webContents, false)
    expect(view.setBounds).toHaveBeenLastCalledWith({
      x: 208,
      y: 44,
      width: 552,
      height: 556,
    })
  })

  it('skips a degenerate (minimized/mid-restore) rect instead of zero-sizing the view', () => {
    manager.openDocsTab()
    const view = lastCreatedView(createDocsView)
    view.setBounds.mockClear()
    shellWindow.getContentBounds = () => ({ x: 0, y: 0, width: 0, height: 0 })
    manager.layout()
    expect(view.setBounds).not.toHaveBeenCalled()
  })
})

describe('palette summon (Ctrl/Cmd+K)', () => {
  /** fire the installed before-input-event listener with a key combo */
  const press = (
    wc: { listeners: Map<string, (event: never, input: never) => void> },
    input: Record<string, unknown>,
  ) => {
    const handler = wc.listeners.get('before-input-event')
    expect(handler).toBeTypeOf('function')
    const event = { preventDefault: vi.fn() }
    handler!(
      { ...event } as never,
      {
        type: 'keyDown',
        control: true,
        ...input,
      } as never,
    )
    return event
  }

  it('yields plain Ctrl/Cmd+K inside docs (Word hyperlink) and never claims shift/alt combos', () => {
    manager.openDocsTab()
    const view = lastCreatedView(createDocsView)
    // docs owns the plain chord: the app's own dialog binding sees the key
    const plain = press(view.webContents, { key: 'k' })
    expect(plain.preventDefault).not.toHaveBeenCalled()
    expect(shellWindow.webContents.send).not.toHaveBeenCalled()
    // every app keeps its shift/alt variants; the palette never claims them
    for (const combo of [
      { key: 'k', shift: true },
      { key: 'k', alt: true },
    ]) {
      const variant = press(view.webContents, combo)
      expect(variant.preventDefault).not.toHaveBeenCalled()
    }
    expect(shellWindow.webContents.send).not.toHaveBeenCalled()
  })

  it('summons the palette from a non-owner tab and from the Home chrome', () => {
    manager.openSheetsTab()
    const view = lastCreatedView(createSheetsView)
    const plain = press(view.webContents, { key: 'k' })
    expect(plain.preventDefault).toHaveBeenCalled()
    expect(shellWindow.webContents.send).toHaveBeenCalledWith(HOME_CHANNELS.paletteOpen)
    shellWindow.webContents.send.mockClear()
    // Home's own webContents is the palette host
    const chrome = press(shellWindow.webContents, { key: 'k', meta: true, control: false })
    expect(chrome.preventDefault).toHaveBeenCalled()
    expect(shellWindow.webContents.send).toHaveBeenCalledWith(HOME_CHANNELS.paletteOpen)
  })

  it('stands down while the view is detached and answers again once docked back', () => {
    manager.openSheetsTab()
    const view = lastCreatedView(createSheetsView)
    const id = manager.list().find((t) => t.kind === 'sheets')!.id
    // torn into its own window, the view is that window's to summon — the
    // strip's listener must not double-summon (its own hook is still attached)
    expect(manager.detachTab(id)).not.toBeNull()
    const detached = press(view.webContents, { key: 'k' })
    expect(detached.preventDefault).toHaveBeenCalled()
    expect(shellWindow.webContents.send).not.toHaveBeenCalled()
    // docked back, the record exists again and the strip's listener answers
    manager.attachTab({
      view: view as never,
      kind: 'sheets',
      title: 't',
      filePath: undefined,
    })
    const docked = press(view.webContents, { key: 'k' })
    expect(docked.preventDefault).toHaveBeenCalled()
    expect(shellWindow.webContents.send).toHaveBeenCalledWith(HOME_CHANNELS.paletteOpen)
  })
})

describe('window resize layout', () => {
  function resizeHandler(): () => void {
    const call = shellWindow.on.mock.calls.find((c) => c[0] === 'resize')
    expect(call).toBeDefined()
    return call![1] as () => void
  }

  it('re-lays out after resize bounds settle (Linux/X11 stale getContentBounds)', async () => {
    // On X11, `resize` fires before the WM applies maximize bounds, so the first
    // layout still sees the pre-maximize size. The deferred layout must pick up
    // the real size on the next turn (see issue #15).
    manager.openSheetsTab()
    const view = lastCreatedView(createSheetsView)
    view.setBounds.mockClear()

    let width = WINDOW_WIDTH
    let height = WINDOW_HEIGHT
    shellWindow.getContentBounds = () => ({ x: 0, y: 0, width, height })

    resizeHandler()()
    expect(view.setBounds).toHaveBeenLastCalledWith(embeddedBounds())

    // Bounds update after the synchronous layout, as on X11 maximize.
    width = 1920
    height = 1080
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(view.setBounds).toHaveBeenLastCalledWith(embeddedBounds(1920, 1080))
    expect(view.setBounds).toHaveBeenCalledTimes(2)
  })

  it('skips deferred layout after the shell window is destroyed', async () => {
    manager.openSheetsTab()
    const view = lastCreatedView(createSheetsView)
    view.setBounds.mockClear()

    resizeHandler()()
    expect(view.setBounds).toHaveBeenCalledTimes(1)

    shellWindow.isDestroyed.mockReturnValue(true)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(view.setBounds).toHaveBeenCalledTimes(1)
  })
})

describe('closing tabs', () => {
  it('never closes the Home tab', async () => {
    await manager.closeTab('home')
    expect(manager.list()).toHaveLength(1)

    manager.openHomeTab()
    manager.closeActiveTab()
    await Promise.resolve()
    expect(manager.list()).toHaveLength(1)
  })

  it('removes a clean tab and falls back to the previous tab', async () => {
    manager.setStageRect({ x: 208, y: 44, width: 552, height: 556 })
    manager.openSheetsTab()
    const sheetsView = lastCreatedView(createSheetsView)
    const slidesId = manager.openSlidesTab()

    await manager.closeTab(slidesId)
    const tabs = manager.list()
    expect(tabs.map((t) => t.id)).toEqual(['home', 't1'])
    expect(tabs[1].active).toBe(true)
    expect(sheetsView.setVisible).toHaveBeenLastCalledWith(true)
  })

  it('keeps the current tab active when closing a background tab', async () => {
    const sheetsId = manager.openSheetsTab()
    const slidesId = manager.openSlidesTab()
    await manager.closeTab(sheetsId)
    expect(manager.list().find((t) => t.id === slidesId)?.active).toBe(true)
  })

  it('detaches and destroys non-docs views on close', async () => {
    const id = manager.openSheetsTab()
    const view = lastCreatedView(createSheetsView)
    await manager.closeTab(id)
    expect(shellWindow.contentView.removeChildView).toHaveBeenCalledWith(view)
    expect(view.webContents.close).toHaveBeenCalledTimes(1)
  })

  it('tears down the docs bookkeeping, then destroys the docs renderer on close', async () => {
    const id = manager.openDocsTab()
    const view = lastCreatedView(createDocsView)
    await manager.closeTab(id)
    expect(shellWindow.contentView.removeChildView).toHaveBeenCalledWith(view)
    expect(teardownDocsRenderer).toHaveBeenCalledWith(view.webContents)
    expect(view.webContents.close).toHaveBeenCalledTimes(1)
  })

  it('closes a clean docs tab after the async dirty query says clean', async () => {
    const id = manager.openDocsTab()
    await manager.closeTab(id)
    expect(docsQueryDirty).toHaveBeenCalledTimes(1)
    expect(requestDocsClose).not.toHaveBeenCalled()
    expect(manager.list()).toHaveLength(1)
  })

  it('keeps a dirty docs tab open when the user cancels the close guard', async () => {
    docsQueryDirty.mockImplementation(() => Promise.resolve(true))
    requestDocsClose.mockImplementation(() => Promise.resolve(false))
    const id = manager.openDocsTab()
    await manager.closeTab(id)
    expect(requestDocsClose).toHaveBeenCalledTimes(1)
    expect(manager.list().map((t) => t.id)).toEqual(['home', id])
  })

  it('activates a dirty background tab before showing its close guard', async () => {
    sheetsPendingEditCount.mockImplementation(() => 1)
    requestSheetsClose.mockImplementation(() => Promise.resolve(false))
    const sheetsId = manager.openSheetsTab()
    manager.openSlidesTab()

    await manager.closeTab(sheetsId)
    expect(requestSheetsClose).toHaveBeenCalledTimes(1)
    // the guarded tab was brought into view for the prompt
    expect(manager.list().find((t) => t.id === sheetsId)?.active).toBe(true)
  })

  it('closes a dirty sheets tab when the guard resolves true', async () => {
    sheetsPendingEditCount.mockImplementation(() => 1)
    requestSheetsClose.mockImplementation(() => Promise.resolve(true))
    const id = manager.openSheetsTab()
    await manager.closeTab(id)
    expect(manager.list()).toHaveLength(1)
  })

  it('does not stack close guards while one prompt is pending', async () => {
    sheetsPendingEditCount.mockImplementation(() => 1)
    let resolveGuard!: (ok: boolean) => void
    requestSheetsClose.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveGuard = resolve
        }),
    )
    const id = manager.openSheetsTab()
    const first = manager.closeTab(id)
    const second = manager.closeTab(id)
    resolveGuard(true)
    await Promise.all([first, second])
    expect(requestSheetsClose).toHaveBeenCalledTimes(1)
    expect(manager.list()).toHaveLength(1)
  })
})

describe('file path bookkeeping', () => {
  it('updates the tab title when a module opens a file in an existing tab', () => {
    manager.openDocsTab()
    const view = lastCreatedView(createDocsView)
    manager.setTabFileFor(view.webContents.id, '/tmp/final.docx')
    expect(manager.list()[1].title).toBe('final.docx')
    expect(manager.findDocsTabByPath('/tmp/final.docx')).toBe('t1')
  })

  it('ignores setTabFileFor for unknown webContents', () => {
    onChanged.mockClear()
    manager.setTabFileFor(999, '/tmp/x.docx')
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('renames matching tabs and reports the affected views', () => {
    manager.openDocsTab('/tmp/old.docx')
    const view = lastCreatedView(createDocsView)
    const affected = manager.renameTabFile('/tmp/old.docx', '/tmp/new.docx')
    expect(affected).toEqual([{ kind: 'docs', webContents: view.webContents }])
    expect(manager.list()[1].title).toBe('new.docx')
    expect(manager.findDocsTabByPath('/tmp/new.docx')).toBe('t1')
    expect(manager.findDocsTabByPath('/tmp/old.docx')).toBeUndefined()
  })

  it('returns no affected views when nothing matches a rename', () => {
    onChanged.mockClear()
    expect(manager.renameTabFile('/tmp/none.docx', '/tmp/new.docx')).toEqual([])
    expect(onChanged).not.toHaveBeenCalled()
  })

  /**
   * One case per TabKind a file can live in. The shell dispatches a rename to a
   * per-app hook on the kind renameTabFile reports, so a kind with no case here
   * is a kind whose editor would silently keep saving to the old path. `home`
   * carries no file, so it gets the negative case below instead of a positive
   * one.
   */
  const RENAMABLE: {
    kind: Exclude<TabKind, 'home'>
    file: string
    renamed: string
    open: () => FakeView
  }[] = [
    {
      kind: 'docs',
      file: '/tmp/one.docx',
      renamed: '/tmp/two.docx',
      open: () => {
        manager.openDocsTab('/tmp/one.docx')
        return lastCreatedView(createDocsView)
      },
    },
    {
      kind: 'sheets',
      file: '/tmp/one.xlsx',
      renamed: '/tmp/two.xlsx',
      open: () => {
        manager.openSheetsTab('/tmp/one.xlsx')
        return lastCreatedView(createSheetsView)
      },
    },
    {
      kind: 'slides',
      file: '/tmp/one.pptx',
      renamed: '/tmp/two.pptx',
      open: () => {
        manager.openSlidesTab('/tmp/one.pptx')
        return lastCreatedView(createSlidesView)
      },
    },
    {
      kind: 'pdf',
      file: '/tmp/one.pdf',
      renamed: '/tmp/two.pdf',
      open: () => {
        manager.openPdfTab('/tmp/one.pdf')
        return lastCreatedView(createPdfView)
      },
    },
    {
      kind: 'markdown',
      file: '/tmp/one.md',
      renamed: '/tmp/two.md',
      open: () => {
        manager.openMarkdownTab('/tmp/one.md')
        return lastCreatedView(createMarkdownView)
      },
    },
    {
      kind: 'html',
      file: '/tmp/one.html',
      renamed: '/tmp/two.html',
      open: () => {
        manager.openHtmlTab('/tmp/one.html')
        return lastCreatedView(createHtmlView)
      },
    },
  ]

  it.each(RENAMABLE)('a rename reports the $kind view', (c) => {
    const view = c.open()
    expect(manager.renameTabFile(c.file, c.renamed)).toEqual([
      { kind: c.kind, webContents: view.webContents },
    ])
  })

  it.each(RENAMABLE)('a rename retitles and repaths the $kind tab', (c) => {
    c.open()
    manager.renameTabFile(c.file, c.renamed)
    const tab = manager.list().find((t) => t.id === 't1')
    expect(tab?.filePath).toBe(c.renamed)
    expect(tab?.title).toBe('two' + c.file.slice(c.file.lastIndexOf('.')))
  })

  it('never claims the home tab, which has no file on disk', () => {
    const before = manager.list().map((t) => ({ id: t.id, title: t.title, filePath: t.filePath }))
    expect(before.some((t) => t.id === 'home')).toBe(true)
    expect(manager.renameTabFile('/tmp/one.docx', '/tmp/two.docx')).toEqual([])
    expect(manager.list().map((t) => ({ id: t.id, title: t.title, filePath: t.filePath }))).toEqual(
      before,
    )
  })

  it('covers every kind the manager can open', () => {
    // The table is checked against what the manager can actually produce rather
    // than a hand-written list, so a new open*Tab method cannot ship without a
    // rename case. A Record<TabKind, true> would read better, but apps/shell
    // tsconfig includes src/** only, so nothing under tests/ ever reaches the
    // typecheck CI runs. openDocumentTab is the registry-driven dispatcher the
    // per-kind openers below delegate to, not a kind of its own, so it is
    // enumerated through the wrappers instead.
    const openers = Object.getOwnPropertyNames(TabManager.prototype).filter(
      (name) => /^open[A-Z]\w*Tab$/.test(name) && name !== 'openDocumentTab',
    )
    expect(openers.length).toBeGreaterThanOrEqual(7)
    const opened: string[] = []
    for (const name of openers) {
      const before = manager.list().length
      const opener = (manager as unknown as Record<string, (arg?: unknown) => unknown>)[name]
      opener?.call(manager, '/tmp/probe.probe')
      const after = manager.list()
      if (after.length > before) opened.push(after[after.length - 1]!.kind)
    }
    // file-less tabs (the in-app manual) have no path to rename, so they are
    // opened by the enumeration but must not demand a RENAMABLE case
    const fileless = new Set(['help'])
    expect([...new Set(opened.filter((k) => !fileless.has(k)))].sort()).toEqual(
      RENAMABLE.map((c) => c.kind).sort(),
    )
  })

  it('finds tabs by kind and path', () => {
    manager.openSheetsTab('/tmp/a.xlsx')
    manager.openSlidesTab('/tmp/b.pptx')
    manager.openPdfTab('/tmp/c.pdf')
    expect(manager.findSheetsTab()).toBe('t1')
    expect(manager.findSheetsTabByPath('/tmp/a.xlsx')).toBe('t1')
    expect(manager.findSlidesTabByPath('/tmp/b.pptx')).toBe('t2')
    expect(manager.findPdfTabByPath('/tmp/c.pdf')).toBe('t3')
    expect(manager.findPdfTabByPath('/tmp/missing.pdf')).toBeUndefined()
  })

  it('finds every document family by a canonicalized path alias', () => {
    const docsId = manager.openDocsTab('/real/file')
    const sheetsId = manager.openSheetsTab('/real/file')
    const slidesId = manager.openSlidesTab('/real/file')
    const pdfId = manager.openPdfTab('/real/file')
    // markdown/html view factories need electron protocol mocks the shell
    // suite does not provide, so seed their tab records directly: the
    // finders only read kind/view/filePath.
    const seedTab = (kind: string, filePath: string) => {
      const tabs = (
        manager as unknown as {
          tabs: Array<{ id: string; kind: string; view: unknown; filePath: string }>
        }
      ).tabs
      const id = `seed-${kind}`
      tabs.push({ id, kind, view: {}, filePath })
      return id
    }
    const markdownId = seedTab('markdown', '/real/file')
    const htmlId = seedTab('html', '/real/file')

    expect(manager.findDocsTabByPath('/canonical/file')).toBe(docsId)
    expect(manager.findSheetsTabByPath('/REAL/FILE')).toBe(sheetsId)
    expect(manager.findSlidesTabByPath('/canonical/file')).toBe(slidesId)
    expect(manager.findPdfTabByPath('/REAL/FILE')).toBe(pdfId)
    expect(manager.findMarkdownTabByPath('/canonical/file')).toBe(markdownId)
    expect(manager.findHtmlTabByPath('/REAL/FILE')).toBe(htmlId)
    expect(manager.findDocsTabByPath('/missing')).toBeUndefined()
    expect(manager.findDocsTabByPath()).toBeUndefined()
  })

  it('reloads an existing pdf tab so a re-export rereads the file from disk', () => {
    const id = manager.openPdfTab('/tmp/c.pdf')
    const view = lastCreatedView(createPdfView)
    manager.reloadTab(id)
    expect(clearPdfDirty).toHaveBeenCalledWith(view.webContents.id)
    expect(view.webContents.reload).toHaveBeenCalledTimes(1)
  })

  it('reports the active pdf tab with its id (so callers can re-activate it)', () => {
    const pdfId = manager.openPdfTab('/tmp/c.pdf')
    const active = manager.activePdfTab()
    expect(active?.id).toBe(pdfId)
    expect(active?.filePath).toBe('/tmp/c.pdf')
    manager.openDocsTab()
    expect(manager.activePdfTab()).toBeUndefined()
  })
})

describe('dirty-tab queries (shell close guard)', () => {
  it('lists only tabs whose module reports unsaved changes', () => {
    const dirtySheetsId = manager.openSheetsTab()
    const dirtyView = lastCreatedView(createSheetsView)
    manager.openSheetsTab()
    sheetsPendingEditCount.mockImplementation((id: number) =>
      id === dirtyView.webContents.id ? 3 : 0,
    )

    const dirty = manager.dirtySheetsTabs()
    expect(dirty).toEqual([{ id: dirtySheetsId, webContents: dirtyView.webContents }])
  })

  it('lists dirty pdf and slides tabs', () => {
    const pdfId = manager.openPdfTab('/tmp/c.pdf')
    const slidesId = manager.openSlidesTab()
    expect(manager.dirtyPdfTabs()).toEqual([])
    expect(manager.dirtySlidesTabs()).toEqual([])
    pdfIsDirty.mockImplementation(() => true)
    slidesIsDirty.mockImplementation(() => true)
    expect(manager.dirtyPdfTabs().map((t) => t.id)).toEqual([pdfId])
    expect(manager.dirtySlidesTabs().map((t) => t.id)).toEqual([slidesId])
  })

  it('lists every live docs tab for the async dirtiness sweep', () => {
    manager.openDocsTab()
    manager.openSheetsTab()
    manager.openDocsTab('/tmp/a.docx')
    expect(manager.docsTabs().map((t) => t.id)).toEqual(['t1', 't3'])
  })
})

describe('detach / attach (Open in New Window, tear-off, dock)', () => {
  it('lifts a tab out without closing its renderer and hands the live view back', () => {
    manager.openDocsTab('/tmp/a.docx')
    const id = manager.openPdfTab('/tmp/scan.pdf')
    const view = lastCreatedView(createPdfView)
    const record = manager.detachTab(id)
    expect(record).toMatchObject({ kind: 'pdf', title: 'scan.pdf', filePath: '/tmp/scan.pdf' })
    expect(record!.view).toBe(view)
    expect(shellWindow.contentView.removeChildView).toHaveBeenCalledWith(view)
    expect(view.webContents.close).not.toHaveBeenCalled()
    expect(manager.list().map((t) => t.id)).toEqual(['home', 't1'])
    expect(manager.list()[1].active).toBe(true)
  })

  it('every document kind can be detached; Home and Present tabs cannot', () => {
    const docs = manager.openDocsTab()
    const sheets = manager.openSheetsTab()
    const slides = manager.openSlidesTab()
    const pdf = manager.openPdfTab('/tmp/scan.pdf')
    const markdown = manager.openMarkdownTab()
    const html = manager.openHtmlTab()
    const present = manager.openHtmlPresentTab({ id: 999 } as never, 'Preview')
    for (const id of [docs, sheets, slides, pdf, markdown, html])
      expect(manager.canDetachTab(id)).toBe(true)
    expect(manager.canDetachTab('home')).toBe(false)
    expect(manager.canDetachTab(present)).toBe(false)
    expect(manager.canDetachTab('nope')).toBe(false)
    expect(manager.detachTab(present)).toBeNull()
  })

  it('attaches a view back as a new, active tab at the requested slot', () => {
    manager.setStageRect({ x: 208, y: 44, width: 552, height: 556 })
    manager.openDocsTab('/tmp/a.docx')
    manager.openDocsTab('/tmp/b.docx')
    const id = manager.openSlidesTab('/tmp/deck.pptx')
    const record = manager.detachTab(id)!
    shellWindow.contentView.addChildView.mockClear()

    const newId = manager.attachTab(record, 1)
    expect(newId).not.toBe(id)
    expect(shellWindow.contentView.addChildView).toHaveBeenCalledWith(record.view)
    expect(record.view.setVisible).toHaveBeenLastCalledWith(true)
    expect(record.view.setBounds).toHaveBeenLastCalledWith({
      x: 208,
      y: 44,
      width: 552,
      height: 556,
    })
    expect(manager.list().map((t) => [t.id, t.title, t.active])).toEqual([
      ['home', 'GenOffice', false],
      [newId, 'deck.pptx', true],
      ['t1', 'a.docx', false],
      ['t2', 'b.docx', false],
    ])
    expect(setActiveSlidesWebContents).toHaveBeenLastCalledWith(record.view.webContents)
    expect(applyMenuFor).toHaveBeenLastCalledWith('slides')
  })

  it('keeps Home pinned: slot 0 and negative slots land right after it, out-of-range appends', () => {
    manager.openDocsTab('/tmp/a.docx')
    const first = manager.detachTab(manager.openSheetsTab('/tmp/x.xlsx'))!
    const second = manager.detachTab(manager.openSheetsTab('/tmp/y.xlsx'))!
    const third = manager.detachTab(manager.openSheetsTab('/tmp/z.xlsx'))!
    manager.attachTab(first, 0)
    expect(manager.list().map((t) => t.title)).toEqual(['GenOffice', 'x.xlsx', 'a.docx'])
    manager.attachTab(second, -4)
    expect(manager.list().map((t) => t.title)).toEqual(['GenOffice', 'y.xlsx', 'x.xlsx', 'a.docx'])
    manager.attachTab(third, 99)
    expect(manager.list().map((t) => t.title)).toEqual([
      'GenOffice',
      'y.xlsx',
      'x.xlsx',
      'a.docx',
      'z.xlsx',
    ])
  })

  it('appends when no slot is given', () => {
    manager.openDocsTab('/tmp/a.docx')
    const record = manager.detachTab(manager.openPdfTab('/tmp/scan.pdf'))!
    manager.openDocsTab('/tmp/b.docx')
    manager.attachTab(record)
    expect(manager.list().map((t) => t.title)).toEqual([
      'GenOffice',
      'a.docx',
      'b.docx',
      'scan.pdf',
    ])
  })

  it('installs the HTML-fullscreen listeners once per view across detach and re-attach', () => {
    const id = manager.openSlidesTab('/tmp/deck.pptx')
    const view = lastCreatedView(createSlidesView)
    const fullScreenRegistrations = () =>
      view.webContents.on.mock.calls.filter(([event]) => event === 'enter-html-full-screen').length
    expect(fullScreenRegistrations()).toBe(1)
    const record = manager.detachTab(id)!
    const newId = manager.attachTab(record)
    expect(fullScreenRegistrations()).toBe(1)

    // the listener resolves the *current* id: fullscreen after re-attach covers the strip
    view.webContents.listeners.get('enter-html-full-screen')!()
    expect(view.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 0,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
    })
    view.webContents.listeners.get('leave-html-full-screen')!()
    expect(view.setBounds).toHaveBeenLastCalledWith(embeddedBounds())
    expect(manager.list()[1].id).toBe(newId)
  })

  it('a re-attached docs tab closes through the docs teardown path like any docs tab', async () => {
    const record = manager.detachTab(manager.openDocsTab('/tmp/a.docx'))!
    const newId = manager.attachTab(record)
    await manager.closeTab(newId)
    expect(teardownDocsRenderer).toHaveBeenCalledWith(record.view.webContents)
    expect(record.view.webContents.close).toHaveBeenCalledTimes(1)
    expect(manager.list()).toHaveLength(1)
  })
})

describe('tab sleep (background renderers released to free memory)', () => {
  const policy = { maxLiveTabs: 2, idleMs: 1000 }
  const IDLE = 5000

  function openDocs(path: string): string {
    return manager.openDocsTab(path)
  }

  it('sleeps the oldest idle background tab once more than maxLiveTabs are live', async () => {
    const a = openDocs('/a.docx')
    const b = openDocs('/b.docx')
    const c = openDocs('/c.docx')
    const viewA = createDocsView.mock.results[0]!.value as FakeView
    const slept = await manager.sleepIdleTabs(policy, Date.now() + IDLE)
    expect(slept).toEqual([a])
    expect(shellWindow.contentView.removeChildView).toHaveBeenCalledWith(viewA)
    expect(teardownDocsRenderer).toHaveBeenCalledWith(viewA.webContents)
    expect(viewA.webContents.close).toHaveBeenCalledTimes(1)
    const list = manager.list()
    expect(list.find((t) => t.id === a)?.dormant).toBe(true)
    expect(list.find((t) => t.id === b)?.dormant).toBeUndefined()
    expect(list.find((t) => t.id === c)?.active).toBe(true)
  })

  it('leaves everything alone while the live count is within the cap', async () => {
    openDocs('/a.docx')
    openDocs('/b.docx')
    expect(await manager.sleepIdleTabs(policy, Date.now() + IDLE)).toEqual([])
  })

  it('does not sleep a tab that has not been idle long enough', async () => {
    openDocs('/a.docx')
    openDocs('/b.docx')
    openDocs('/c.docx')
    expect(await manager.sleepIdleTabs(policy, Date.now())).toEqual([])
  })

  it('never sleeps the active, pinned, dirty or untitled tab', async () => {
    const a = openDocs('/a.docx')
    const b = openDocs('/b.docx')
    const untitled = manager.openDocsTab()
    openDocs('/d.docx')
    manager.setPinned(a, true)
    docsQueryDirty.mockImplementation((wc: { id: number }) =>
      Promise.resolve(wc.id === (createDocsView.mock.results[1]!.value as FakeView).webContents.id),
    )
    const slept = await manager.sleepIdleTabs({ maxLiveTabs: 1, idleMs: 0 }, Date.now() + IDLE)
    expect(slept).toEqual([])
    expect(manager.list().filter((t) => t.dormant)).toHaveLength(0)
    expect([a, b, untitled].every((id) => manager.list().some((t) => t.id === id))).toBe(true)
  })

  it('over the memory budget the oldest candidate sleeps even inside the cap', async () => {
    const a = openDocs('/a.docx')
    openDocs('/b.docs')
    const slept = await manager.sleepIdleTabs({ maxLiveTabs: 10, idleMs: 60_000 }, Date.now(), true)
    expect(slept).toEqual([a])
  })

  it('activating a sleeping tab rebuilds its view from the file, in place', async () => {
    manager.setStageRect({ x: 208, y: 44, width: 552, height: 556 })
    const a = openDocs('/a.docx')
    openDocs('/b.docx')
    openDocs('/c.docx')
    await manager.sleepIdleTabs(policy, Date.now() + IDLE)
    createDocsView.mockClear()
    shellWindow.contentView.addChildView.mockClear()
    manager.activateTab(a)
    expect(createDocsView).toHaveBeenCalledWith('/a.docx')
    const revived = lastCreatedView(createDocsView)
    expect(shellWindow.contentView.addChildView).toHaveBeenCalledWith(revived)
    expect(revived.setVisible).toHaveBeenLastCalledWith(true)
    const tab = manager.list().find((t) => t.id === a)
    expect(tab).toMatchObject({ active: true, filePath: '/a.docx' })
    expect(tab?.dormant).toBeUndefined()
    expect(manager.list().map((t) => t.id)).toEqual([
      'home',
      a,
      expect.any(String),
      expect.any(String),
    ])
  })

  it('a sleeping sheets tab wakes with its workbook queued for the new view', async () => {
    const a = manager.openSheetsTab('/a.xlsx')
    manager.openSheetsTab('/b.xlsx')
    manager.openSheetsTab('/c.xlsx')
    await manager.sleepIdleTabs(policy, Date.now() + IDLE)
    queueWorkbookForView.mockClear()
    manager.activateTab(a)
    const revived = lastCreatedView(createSheetsView)
    expect(queueWorkbookForView).toHaveBeenCalledWith(revived.webContents, '/a.xlsx')
  })

  it('a dirty tab is skipped by the sweep so the clean tabs behind it still sleep', async () => {
    const a = openDocs('/a.docx')
    const b = openDocs('/b.docx')
    openDocs('/c.docx')
    const viewA = createDocsView.mock.results[0]!.value as FakeView
    docsQueryDirty.mockImplementation((wc: { id: number }) =>
      Promise.resolve(wc.id === viewA.webContents.id),
    )
    expect(await manager.sleepIdleTabs({ maxLiveTabs: 10, idleMs: 0 }, Date.now(), true)).toEqual([
      b,
    ])
    expect(manager.list().find((t) => t.id === a)?.dormant).toBeUndefined()
  })

  it('asking a sleeping tab for its webContents (agents, CLI) wakes it in the background', async () => {
    const a = openDocs('/a.docx')
    openDocs('/b.docx')
    const c = openDocs('/c.docx')
    await manager.sleepIdleTabs(policy, Date.now() + IDLE)
    createDocsView.mockClear()
    const wc = manager.webContentsForTab(a)
    expect(createDocsView).toHaveBeenCalledWith('/a.docx')
    expect(wc).toBe(lastCreatedView(createDocsView).webContents)
    expect(manager.list().find((t) => t.id === a)).toMatchObject({ active: false })
    expect(manager.list().find((t) => t.id === a)?.dormant).toBeUndefined()
    expect(manager.list().find((t) => t.id === c)?.active).toBe(true)
    expect(lastCreatedView(createDocsView).setVisible).toHaveBeenLastCalledWith(false)
    // a freshly woken tab is not put straight back to sleep by the next sweep
    expect(await manager.sleepIdleTabs(policy, Date.now())).toEqual([])
  })

  it('a background wake renews the sleep lease, not the MRU answer', async () => {
    // the palette lists commands for "the editor the user was last in" by
    // lastActiveAt; an agent or CLI background read wakes a sleeping tab
    // without the user ever visiting it, and must not steal that answer —
    // the wake is a liveness lease (the sleep clock), not attention. The
    // lease is real but temporary: protected while fresh, gone once it ages
    // past the idle policy
    const oneLive = { maxLiveTabs: 1, idleMs: 1000 }
    let clock = 1_000
    const now = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 10))
    try {
      openDocs('/a.docx')
      openDocs('/b.docx')
      manager.activateTab('home')
      // idle past the policy: the oldest-stamped editor sleeps
      clock += 10_000
      const slept = await manager.sleepIdleTabs(oneLive, Date.now())
      expect(slept).toHaveLength(1)
      const woken = slept[0]!
      expect(manager.list().find((t) => t.id === woken)?.dormant).toBe(true)
      const stampsBefore = new Map(manager.list().map((t) => [t.id, t.lastActiveAt]))
      // the background read wakes it — no activation, no user visit
      clock += 10_000
      expect(manager.webContentsForTab(woken)).toBeTruthy()
      const stampsAfter = new Map(manager.list().map((t) => [t.id, t.lastActiveAt]))
      expect(stampsAfter.get(woken)).toBe(stampsBefore.get(woken))
      expect(manager.list().find((t) => t.id === woken)?.dormant).toBeUndefined()
      // under live pressure the fresh lease protects the just-woken tab
      const protectedSweep = await manager.sleepIdleTabs(oneLive, Date.now())
      expect(protectedSweep).not.toContain(woken)
      // and once the lease has aged past the idle policy, the woken tab
      // sleeps again like any idle tab
      clock += 10_000
      openDocs('/c.docx')
      const expiredSweep = await manager.sleepIdleTabs(oneLive, Date.now())
      expect(expiredSweep).toContain(woken)
    } finally {
      now.mockRestore()
    }
  })

  it('findTabByPath wakes a sleeping tab and returns its new webContents', async () => {
    const a = openDocs('/a.docx')
    openDocs('/b.docx')
    openDocs('/c.docx')
    await manager.sleepIdleTabs(policy, Date.now() + IDLE)
    const found = manager.findTabByPath('/a.docx')
    expect(found?.id).toBe(a)
    expect(found?.webContents).toBe(lastCreatedView(createDocsView).webContents)
  })

  it('renaming the file behind a sleeping tab updates the strip', async () => {
    const a = openDocs('/a.docx')
    openDocs('/b.docx')
    openDocs('/c.docx')
    await manager.sleepIdleTabs(policy, Date.now() + IDLE)
    onChanged.mockClear()
    expect(manager.renameTabFile('/a.docx', '/renamed.docx')).toEqual([])
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(manager.list().find((t) => t.id === a)).toMatchObject({
      title: 'renamed.docx',
      filePath: '/renamed.docx',
    })
  })

  it('a sleeping tab still counts as the open tab for its path, closes without a prompt and is listed for agents', async () => {
    const a = openDocs('/a.docx')
    openDocs('/b.docx')
    openDocs('/c.docx')
    await manager.sleepIdleTabs(policy, Date.now() + IDLE)
    expect(manager.findDocsTabByPath('/a.docx')).toBe(a)
    expect(manager.openFilePaths()).toContain('/a.docx')
    expect(manager.canDetachTab(a)).toBe(false)
    const docs = await manager.openDocuments()
    expect(docs.find((d) => d.id === a)).toMatchObject({ filePath: '/a.docx', dirty: false })
    docsQueryDirty.mockClear()
    await manager.closeTab(a)
    expect(docsQueryDirty).not.toHaveBeenCalled()
    expect(manager.list().some((t) => t.id === a)).toBe(false)
  })
})
