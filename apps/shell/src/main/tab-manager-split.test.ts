import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', () => {
  const realpathSync = ((path?: string) => path) as typeof import('node:fs').realpathSync
  realpathSync.native = ((path?: string) => path) as typeof import('node:fs').realpathSync.native
  return { realpathSync }
})

interface FakeWebContents {
  id: number
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  reload: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  listeners: Map<string, Array<(...args: unknown[]) => void>>
}

interface FakeView {
  webContents: FakeWebContents
  setVisible: ReturnType<typeof vi.fn>
  setBounds: ReturnType<typeof vi.fn>
  getBounds: () => { x: number; y: number; width: number; height: number }
}

const state = vi.hoisted(() => ({
  nextWebContentsId: 1,
  createdWebContentsViews: [] as FakeView[],
}))

function createFakeViewImpl(startId?: number): FakeView {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  let bounds = { x: 0, y: 0, width: 0, height: 0 }
  const id = startId ?? state.nextWebContentsId++
  return {
    webContents: {
      id,
      listeners,
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        const list = listeners.get(event) ?? []
        list.push(handler)
        listeners.set(event, list)
      }),
      once: vi.fn(),
      close: vi.fn(),
      reload: vi.fn(),
      focus: vi.fn(),
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(() => ({ action: 'deny' as const })),
      loadURL: vi.fn(() => Promise.resolve()),
    },
    setVisible: vi.fn(),
    setBounds: vi.fn((rect: typeof bounds) => {
      bounds = rect
    }),
    getBounds: () => bounds,
  }
}

vi.mock('electron', () => ({
  BrowserWindow: class {},
  app: { getAppMetrics: () => [] },
  shell: { openExternal: vi.fn() },
  WebContentsView: class {
    webContents: FakeWebContents
    setVisible: FakeView['setVisible']
    setBounds: FakeView['setBounds']
    getBounds: FakeView['getBounds']

    constructor() {
      const inner = createFakeViewImpl(900000 + state.nextWebContentsId++)
      this.webContents = inner.webContents
      this.setVisible = inner.setVisible
      this.setBounds = inner.setBounds
      this.getBounds = inner.getBounds
      state.createdWebContentsViews.push(this as unknown as FakeView)
    }
  },
}))

const createDocsView = vi.fn(() => createFakeViewImpl())
const docsQueryDirty = vi.fn(() => Promise.resolve(false))
const markDocsNewBlank = vi.fn()
const requestDocsClose = vi.fn(() => Promise.resolve(true))
const setActiveDocsResolver = vi.fn()
const teardownDocsRenderer = vi.fn()

vi.mock('../../../docs/src/main/docs-main', () => ({
  buildDocsMenu: vi.fn(),
  queueDocsAiContent: vi.fn(),
  createDocsView: (...args: unknown[]) => createDocsView(...(args as [])),
  docsQueryDirty: (...args: unknown[]) => docsQueryDirty(...(args as [])),
  markDocsNewBlank: (...args: unknown[]) => markDocsNewBlank(...args),
  requestDocsClose: (...args: unknown[]) => requestDocsClose(...(args as [])),
  setActiveDocsResolver: (...args: unknown[]) => setActiveDocsResolver(...args),
  teardownDocsRenderer: (...args: unknown[]) => teardownDocsRenderer(...args),
}))

const createPdfView = vi.fn(() => createFakeViewImpl())
vi.mock('../../../pdf/src/main/pdf-main', () => ({
  createPdfView: (...args: unknown[]) => createPdfView(...(args as [])),
  pdfIsDirty: vi.fn(() => false),
  clearPdfDirty: vi.fn(),
  requestPdfClose: vi.fn(() => Promise.resolve(true)),
}))

const createSheetsView = vi.fn(() => createFakeViewImpl())
const setActiveSheetsWebContents = vi.fn()
vi.mock('../../../sheets/src/main/sheets-main', () => ({
  installSheetsMenu: vi.fn(),
  createSheetsView: (...args: unknown[]) => createSheetsView(...(args as [])),
  nudgeQueuedWorkbook: vi.fn(),
  queueWorkbookForView: vi.fn(),
  requestSheetsClose: vi.fn(() => Promise.resolve(true)),
  setActiveSheetsWebContents: (...args: unknown[]) => setActiveSheetsWebContents(...args),
  setSheetsNewBlank: vi.fn(),
  sheetsPendingEditCount: vi.fn(() => 0),
}))

const createSlidesView = vi.fn(() => createFakeViewImpl())
const setActiveSlidesWebContents = vi.fn()
vi.mock('../../../slides/src/main/slides-main', () => ({
  installSlidesMenu: vi.fn(),
  discardSlidesRecovery: vi.fn(),
  createSlidesView: (...args: unknown[]) => createSlidesView(...(args as [])),
  requestSlidesClose: vi.fn(() => Promise.resolve(true)),
  setActiveSlidesWebContents: (...args: unknown[]) => setActiveSlidesWebContents(...args),
  slidesIsDirty: vi.fn(() => false),
}))

const createMarkdownView = vi.fn(() => createFakeViewImpl())
vi.mock('../../../markdown/src/main/markdown-main', () => ({
  markdownDiscardPendingAssets: vi.fn(async () => undefined),
  markdownReadText: vi.fn(async () => ''),
  markdownSaveToPath: vi.fn(async () => undefined),
  createMarkdownView: (...args: unknown[]) => createMarkdownView(...(args as [])),
  markdownIsDirty: vi.fn(() => false),
  requestMarkdownClose: vi.fn(() => Promise.resolve(true)),
}))

const createHtmlView = vi.fn(() => createFakeViewImpl())
vi.mock('../../../html/src/main/html-main', () => ({
  htmlDiscardPendingAssets: vi.fn(async () => undefined),
  htmlReadText: vi.fn(async () => ''),
  htmlSaveToPath: vi.fn(async () => undefined),
  createHtmlView: (...args: unknown[]) => createHtmlView(...(args as [])),
  createHtmlPresentView: vi.fn(() => createFakeViewImpl()),
  htmlIsDirty: vi.fn(() => false),
  requestHtmlClose: vi.fn(() => Promise.resolve(true)),
}))

const createBrowserView = vi.fn(() => createFakeViewImpl())
const syncBrowserPageView = vi.fn()
vi.mock('../../../browser/src/main/browser-main', () => ({
  browserNavigate: vi.fn(),
  configureBrowserRuntime: vi.fn(),
  createBrowserView: (...args: unknown[]) => createBrowserView(...(args as [])),
  requestBrowserClose: vi.fn(() => Promise.resolve(true)),
  setBrowserShellHooks: vi.fn(),
  syncBrowserPageView: (...args: unknown[]) => syncBrowserPageView(...(args as [])),
  teardownBrowserTab: vi.fn(),
}))

const createMediaView = vi.fn(() => createFakeViewImpl())
vi.mock('./media-main', () => ({
  MEDIA_EXTS: ['.png', '.mp3'],
  isPlayableMediaExt: () => true,
  createMediaView: (...args: unknown[]) => createMediaView(...(args as [])),
  requestMediaClose: vi.fn(() => Promise.resolve(true)),
  mediaFilePathForWebContents: vi.fn(() => undefined),
  mediaReadSnapshot: vi.fn(),
  registerMediaIpc: vi.fn(),
  registerMediaProtocol: vi.fn(),
  setMediaFileChangedHook: vi.fn(),
}))

import { COMPARE_CHANNELS } from '../shared/compare-api'
import { TERMINAL_CHANNELS } from '../shared/terminal-api'
import { SPLIT_DIVIDER_WIDTH, type SplitState } from '../shared/split-api'
import { TabManager } from './tab-manager'

const STAGE_RECT = { x: 200, y: 44, width: 1008, height: 700 }

function makeShellWindow() {
  return {
    on: vi.fn(),
    webContents: {
      once: vi.fn(),
      focus: vi.fn(),
      on: vi.fn(),
      send: vi.fn(),
      isDestroyed: vi.fn(() => false),
    },
    isDestroyed: vi.fn(() => false),
    isFocused: vi.fn(() => true),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    getContentBounds: () => ({ x: 0, y: 0, width: 1208, height: 744 }),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  }
}

function lastView(factory: ReturnType<typeof vi.fn>): FakeView {
  return factory.mock.results.at(-1)!.value as FakeView
}

function emitWcEvent(wc: FakeWebContents, event: string, ...args: unknown[]): void {
  for (const fn of wc.listeners.get(event) ?? []) {
    fn(...args)
  }
}

describe('TabManager split view and compare tab', () => {
  let shellWindow: ReturnType<typeof makeShellWindow>
  let onChanged: ReturnType<typeof vi.fn<() => void>>
  let applyMenuFor: ReturnType<typeof vi.fn<(kind: string) => void>>
  let splitListener: ReturnType<typeof vi.fn<(state: SplitState | null) => void>>
  let manager: TabManager

  beforeEach(() => {
    vi.clearAllMocks()
    state.nextWebContentsId = 1
    state.createdWebContentsViews.length = 0
    docsQueryDirty.mockImplementation(() => Promise.resolve(false))
    shellWindow = makeShellWindow()
    onChanged = vi.fn<() => void>()
    applyMenuFor = vi.fn<(kind: string) => void>()
    splitListener = vi.fn<(state: SplitState | null) => void>()
    manager = new TabManager(
      shellWindow as never,
      () => onChanged(),
      (kind) => applyMenuFor(kind),
    )
    manager.setSplitChangeListener(splitListener)
    manager.setStageRect(STAGE_RECT)
  })

  it('returns null when opening split with fewer than two eligible tabs', () => {
    expect(manager.openSplit()).toBeNull()
    expect(manager.getSplitState()).toBeNull()
    expect(manager.getSplitTabs()).toBeNull()

    manager.openDocsTab('/tmp/a.docx')
    expect(manager.openSplit()).toBeNull()
    expect(manager.getSplitState()).toBeNull()
  })

  it('opens split side-by-side with exact non-overlapping bounds and shows both views', () => {
    const t1 = manager.openDocsTab('/tmp/a.docx')
    const v1 = lastView(createDocsView)
    const t2 = manager.openSheetsTab('/tmp/b.xlsx')
    const v2 = lastView(createSheetsView)

    splitListener.mockClear()
    const split = manager.openSplit()
    expect(split).toEqual({
      leftTabId: t2,
      rightTabId: t1,
      activePane: 'left',
      ratio: 0.5,
      syncScroll: false,
      suspended: false,
    })
    expect(manager.getSplitState()).toEqual(split)
    expect(splitListener).toHaveBeenLastCalledWith(split)

    // Both panes become visible and divide STAGE_RECT cleanly across the 8px divider.
    expect(v2.setVisible).toHaveBeenLastCalledWith(true)
    expect(v1.setVisible).toHaveBeenLastCalledWith(true)
    const bLeft = v2.getBounds()
    const bRight = v1.getBounds()
    expect(bLeft).toEqual({ x: 200, y: 44, width: 500, height: 700 })
    expect(bRight).toEqual({ x: 200 + 500 + SPLIT_DIVIDER_WIDTH, y: 44, width: 500, height: 700 })

    const splitTabs = manager.getSplitTabs()
    expect(splitTabs).toEqual({
      left: { id: t2, kind: 'sheets', webContents: v2.webContents },
      right: { id: t1, kind: 'docs', webContents: v1.webContents },
      syncScroll: false,
    })
  })

  it('keeps split views hidden until stageRect arrives, then reveals both', () => {
    const fresh = new TabManager(
      shellWindow as never,
      () => onChanged(),
      (kind) => applyMenuFor(kind),
    )
    fresh.openDocsTab('/tmp/a.docx')
    const v1 = lastView(createDocsView)
    fresh.openSheetsTab('/tmp/b.xlsx')
    const v2 = lastView(createSheetsView)

    expect(fresh.openSplit()).not.toBeNull()
    expect(v1.setVisible).toHaveBeenLastCalledWith(false)
    expect(v2.setVisible).toHaveBeenLastCalledWith(false)

    fresh.setStageRect(STAGE_RECT)
    expect(v1.setVisible).toHaveBeenLastCalledWith(true)
    expect(v2.setVisible).toHaveBeenLastCalledWith(true)
  })

  it('closes split and restores single full-stage layout for the active pane', () => {
    const t1 = manager.openDocsTab('/tmp/a.docx')
    const v1 = lastView(createDocsView)
    const t2 = manager.openSheetsTab('/tmp/b.xlsx')
    const v2 = lastView(createSheetsView)

    manager.openSplit(t1, 'right')
    expect(manager.activeTabId()).toBe(t1)

    splitListener.mockClear()
    onChanged.mockClear()
    manager.closeSplit()

    expect(manager.getSplitState()).toBeNull()
    expect(manager.getSplitTabs()).toBeNull()
    expect(v1.getBounds()).toEqual(STAGE_RECT)
    expect(v1.setVisible).toHaveBeenLastCalledWith(true)
    expect(v2.setVisible).toHaveBeenLastCalledWith(false)
    expect(splitListener).toHaveBeenCalledWith(null)
    expect(onChanged).toHaveBeenCalled()
    expect(manager.activeTabId()).toBe(t1)
    void t2
  })

  it('swaps left and right panes and keeps activePane aligned with activeId', () => {
    const t1 = manager.openDocsTab('/tmp/a.docx')
    const v1 = lastView(createDocsView)
    const t2 = manager.openSheetsTab('/tmp/b.xlsx')
    const v2 = lastView(createSheetsView)

    manager.openSplit(t1, 'right')
    // Active tab is t1 on the right pane.
    expect(manager.getSplitState()).toMatchObject({
      leftTabId: t2,
      rightTabId: t1,
      activePane: 'right',
    })

    const swapped = manager.swapSplit()
    expect(swapped).toMatchObject({
      leftTabId: t1,
      rightTabId: t2,
      activePane: 'left',
    })
    expect(manager.activeTabId()).toBe(t1)
    expect(v1.getBounds().x).toBe(STAGE_RECT.x)
    expect(v2.getBounds().x).toBeGreaterThan(v1.getBounds().x)
  })

  it('updates layout during drag without pushing onChanged until commit', () => {
    manager.openDocsTab('/tmp/a.docx')
    const v1 = lastView(createDocsView)
    manager.openSheetsTab('/tmp/b.xlsx')
    const v2 = lastView(createSheetsView)

    manager.openSplit()
    onChanged.mockClear()
    splitListener.mockClear()

    // Non-committed drag frame: resizes bounds smoothly without triggering onChanged.
    manager.setSplitRatio(0.3, false)
    expect(manager.getSplitState()?.ratio).toBe(0.3)
    expect(v2.getBounds().width).toBe(300)
    expect(v1.getBounds().width).toBe(700)
    expect(onChanged).not.toHaveBeenCalled()

    // Committed drop at the same ratio still emits split change and onChanged.
    manager.setSplitRatio(0.3, true)
    expect(splitListener).toHaveBeenCalledWith(expect.objectContaining({ ratio: 0.3 }))
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('toggles syncScroll and reports it in split state and getSplitTabs', () => {
    manager.openDocsTab('/tmp/a.docx')
    manager.openSheetsTab('/tmp/b.xlsx')
    manager.openSplit()

    splitListener.mockClear()
    onChanged.mockClear()
    const updated = manager.setSplitSyncScroll(true)
    expect(updated?.syncScroll).toBe(true)
    expect(manager.getSplitTabs()?.syncScroll).toBe(true)
    expect(splitListener).toHaveBeenCalledWith(expect.objectContaining({ syncScroll: true }))
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('switches active pane via focusSplitPane and avoids re-focusing on webContents focus/mouseDown', () => {
    const t1 = manager.openDocsTab('/tmp/a.docx')
    const v1 = lastView(createDocsView)
    const t2 = manager.openSheetsTab('/tmp/b.xlsx')
    const v2 = lastView(createSheetsView)

    manager.openSplit()
    // Active pane starts on left (t2).
    expect(manager.activeTabId()).toBe(t2)

    v1.webContents.focus.mockClear()
    v2.webContents.focus.mockClear()

    // Programmatic focusSplitPane calls focusActiveView.
    expect(manager.focusSplitPane('right')).toBe(true)
    expect(manager.activeTabId()).toBe(t1)
    expect(manager.getSplitState()?.activePane).toBe('right')
    expect(applyMenuFor).toHaveBeenLastCalledWith('docs')
    expect(v1.webContents.focus).toHaveBeenCalledTimes(1)

    // Non-mouseDown input on the inactive pane does not switch focus.
    emitWcEvent(
      v2.webContents,
      'before-input-event',
      { preventDefault: vi.fn() },
      { type: 'keyDown', key: 'a' },
    )
    expect(manager.activeTabId()).toBe(t1)

    // Native mouseDown or focus event on left pane switches activePane with skipFocusView: true.
    v2.webContents.focus.mockClear()
    emitWcEvent(
      v2.webContents,
      'before-input-event',
      { preventDefault: vi.fn() },
      { type: 'mouseDown' },
    )
    expect(manager.activeTabId()).toBe(t2)
    expect(manager.getSplitState()?.activePane).toBe('left')
    expect(applyMenuFor).toHaveBeenLastCalledWith('sheets')
    expect(v2.webContents.focus).not.toHaveBeenCalled()

    // Focus event on the right pane promotes right without stealing focus back.
    v1.webContents.focus.mockClear()
    emitWcEvent(v1.webContents, 'focus')
    expect(manager.activeTabId()).toBe(t1)
    expect(manager.getSplitState()?.activePane).toBe('right')
    expect(v1.webContents.focus).not.toHaveBeenCalled()
  })

  it('suspends split on Home and resumes when returning to a split pane, or exits on third tab', () => {
    const t1 = manager.openDocsTab('/tmp/a.docx')
    const v1 = lastView(createDocsView)
    const t2 = manager.openSheetsTab('/tmp/b.xlsx')
    const v2 = lastView(createSheetsView)
    const t3 = manager.openPdfTab('/tmp/c.pdf')
    const v3 = lastView(createPdfView)

    // Activate t2 then split with t1.
    manager.activateTab(t2)
    manager.openSplit(t1, 'right')
    expect(v1.setVisible).toHaveBeenLastCalledWith(true)
    expect(v2.setVisible).toHaveBeenLastCalledWith(true)
    expect(v3.setVisible).toHaveBeenLastCalledWith(false)

    // Go to Home: split suspends and both split views hide.
    manager.activateTab('home')
    expect(manager.getSplitState()).toMatchObject({
      leftTabId: t2,
      rightTabId: t1,
      suspended: true,
    })
    expect(v1.setVisible).toHaveBeenLastCalledWith(false)
    expect(v2.setVisible).toHaveBeenLastCalledWith(false)

    // Return to left split tab t2: split resumes with both views visible.
    manager.activateTab(t2)
    expect(manager.getSplitState()).toMatchObject({
      leftTabId: t2,
      rightTabId: t1,
      activePane: 'left',
      suspended: false,
    })
    expect(v1.setVisible).toHaveBeenLastCalledWith(true)
    expect(v2.setVisible).toHaveBeenLastCalledWith(true)

    // Suspend again then activate third tab t3: exits split and shows t3 single-pane.
    manager.activateTab('home')
    manager.activateTab(t3)
    expect(manager.getSplitState()).toBeNull()
    expect(v3.setVisible).toHaveBeenLastCalledWith(true)
    expect(v3.getBounds()).toEqual(STAGE_RECT)
    expect(v1.setVisible).toHaveBeenLastCalledWith(false)
    expect(v2.setVisible).toHaveBeenLastCalledWith(false)
  })

  it('replaces the active split pane when activating a third tab while un-suspended', () => {
    const t1 = manager.openDocsTab('/tmp/a.docx')
    const v1 = lastView(createDocsView)
    const t2 = manager.openSheetsTab('/tmp/b.xlsx')
    const v2 = lastView(createSheetsView)
    const t3 = manager.openPdfTab('/tmp/c.pdf')
    const v3 = lastView(createPdfView)

    manager.activateTab(t2)
    manager.openSplit(t1, 'right')
    expect(manager.getSplitState()).toMatchObject({
      leftTabId: t2,
      rightTabId: t1,
      activePane: 'right',
    })

    // Activating t3 replaces the active right pane (t1) while keeping t2 on the left.
    manager.activateTab(t3)
    expect(manager.getSplitState()).toMatchObject({
      leftTabId: t2,
      rightTabId: t3,
      activePane: 'right',
      suspended: false,
    })
    expect(v1.setVisible).toHaveBeenLastCalledWith(false)
    expect(v2.setVisible).toHaveBeenLastCalledWith(true)
    expect(v3.setVisible).toHaveBeenLastCalledWith(true)
    expect(v3.getBounds().x).toBeGreaterThan(v2.getBounds().x)
  })

  it('exits split and falls back to sibling when closing active or inactive split pane', async () => {
    const t1 = manager.openDocsTab('/tmp/a.docx')
    const v1 = lastView(createDocsView)
    const t2 = manager.openSheetsTab('/tmp/b.xlsx')
    const v2 = lastView(createSheetsView)
    const t3 = manager.openPdfTab('/tmp/c.pdf')

    manager.activateTab(t2)
    manager.openSplit(t1, 'right')

    // Closing unrelated background tab t3 preserves split.
    await manager.closeTab(t3)
    expect(manager.getSplitState()).not.toBeNull()

    // Closing the active right pane (t1) exits split and activates sibling t2 full-width.
    await manager.closeTab(t1)
    expect(manager.getSplitState()).toBeNull()
    expect(manager.activeTabId()).toBe(t2)
    expect(v2.getBounds()).toEqual(STAGE_RECT)
    expect(v2.setVisible).toHaveBeenLastCalledWith(true)
    void v1

    // Re-open t1, split again, and close the inactive pane (t2): active stays on t1 full-width.
    const t1b = manager.openDocsTab('/tmp/a2.docx')
    const v1b = lastView(createDocsView)
    manager.openSplit(t2, 'left')
    // Active is t2 on left; focus right (t1b) then close t2.
    manager.focusSplitPane('right')
    await manager.closeTab(t2)
    expect(manager.getSplitState()).toBeNull()
    expect(manager.activeTabId()).toBe(t1b)
    expect(v1b.getBounds()).toEqual(STAGE_RECT)
    expect(v1b.setVisible).toHaveBeenLastCalledWith(true)
  })

  it('exits split when detaching either split pane and re-installs focus listener once on re-attach', () => {
    const t1 = manager.openDocsTab('/tmp/a.docx')
    const v1 = lastView(createDocsView)
    const t2 = manager.openSheetsTab('/tmp/b.xlsx')
    const v2 = lastView(createSheetsView)

    manager.activateTab(t2)
    manager.openSplit(t1, 'right')

    const focusRegistrationsBefore = v1.webContents.on.mock.calls.filter(
      ([ev]) => ev === 'focus',
    ).length
    expect(focusRegistrationsBefore).toBe(1)

    const detached = manager.detachTab(t1)
    expect(detached).not.toBeNull()
    expect(manager.getSplitState()).toBeNull()
    expect(manager.activeTabId()).toBe(t2)
    expect(v2.getBounds()).toEqual(STAGE_RECT)

    const reattachedId = manager.attachTab(detached!)
    const focusRegistrationsAfter = v1.webContents.on.mock.calls.filter(
      ([ev]) => ev === 'focus',
    ).length
    expect(focusRegistrationsAfter).toBe(1)
    expect(manager.activeTabId()).toBe(reattachedId)
  })

  it('prevents sleeping tabs that belong to an active or suspended split view', async () => {
    const t1 = manager.openDocsTab('/tmp/a.docx')
    const t2 = manager.openDocsTab('/tmp/b.docx')
    const t3 = manager.openDocsTab('/tmp/c.docx')

    manager.activateTab(t2)
    manager.openSplit(t1, 'right')
    // Even suspended on Home, split members must not sleep.
    manager.activateTab('home')

    const slept = await manager.sleepIdleTabs(
      { maxLiveTabs: 1, idleMs: 0 },
      Date.now() + 10_000,
      true,
    )
    expect(slept).toEqual([t3])
    expect(manager.list().find((t) => t.id === t1)?.dormant).toBeUndefined()
    expect(manager.list().find((t) => t.id === t2)?.dormant).toBeUndefined()
    expect(manager.list().find((t) => t.id === t3)?.dormant).toBe(true)
  })

  it('collapses split into fullscreen presentation and restores split on exit', () => {
    const t1 = manager.openSlidesTab('/tmp/deck.pptx')
    const v1 = lastView(createSlidesView)
    const t2 = manager.openDocsTab('/tmp/notes.docx')
    const v2 = lastView(createDocsView)

    manager.activateTab(t2)
    manager.openSplit(t1, 'right')

    // Active pane is t1 (right). Enter HTML fullscreen on t1.
    emitWcEvent(v1.webContents, 'enter-html-full-screen')
    expect(v1.getBounds()).toEqual({ x: 0, y: 0, width: 1208, height: 744 })
    expect(v2.setVisible).toHaveBeenLastCalledWith(false)

    // Leave HTML fullscreen: dual split bounds and visibility return.
    emitWcEvent(v1.webContents, 'leave-html-full-screen')
    expect(v1.setVisible).toHaveBeenLastCalledWith(true)
    expect(v2.setVisible).toHaveBeenLastCalledWith(true)
    expect(v1.getBounds().width + SPLIT_DIVIDER_WIDTH + v2.getBounds().width).toBe(STAGE_RECT.width)
  })

  it('opens, reuses, and cleans up the single Document Compare tab', () => {
    const opts1 = {
      left: { kind: 'tab' as const, tabId: 't1' },
      right: { kind: 'file' as const, filePath: '/tmp/b.docx' },
    }
    const id1 = manager.openCompareTab(opts1)
    expect(state.createdWebContentsViews).toHaveLength(1)
    const compareView = state.createdWebContentsViews[0]!

    expect(compareView.webContents.loadURL).toHaveBeenCalledTimes(1)
    const loadedUrl = compareView.webContents.loadURL.mock.calls[0]![0] as string
    expect(loadedUrl).toContain('view=compare')
    expect(manager.getCompareInitForWebContents(compareView.webContents.id)).toEqual(opts1)
    expect(manager.list().find((t) => t.id === id1)).toMatchObject({
      kind: 'compare',
      title: 'Document Compare',
      active: true,
    })

    // Open another tab, then reopen compare with updated options: reuses existing tab.
    manager.openDocsTab('/tmp/other.docx')
    const opts2 = {
      left: { kind: 'file' as const, filePath: '/tmp/x.md' },
      right: { kind: 'file' as const, filePath: '/tmp/y.md' },
    }
    const id2 = manager.openCompareTab(opts2)
    expect(id2).toBe(id1)
    expect(state.createdWebContentsViews).toHaveLength(1)
    expect(compareView.webContents.send).toHaveBeenCalledWith(COMPARE_CHANNELS.initUpdated, opts2)
    expect(manager.getCompareInitForWebContents(compareView.webContents.id)).toEqual(opts2)
    expect(manager.activeTabId()).toBe(id1)

    // Closing compare cleans up stored init options.
    manager.closeTabWithoutPrompt(id1)
    expect(manager.getCompareInitForWebContents(compareView.webContents.id)).toBeUndefined()
  })

  it('exits active split view so Document Compare opens full-width', () => {
    const t1 = manager.openDocsTab('/tmp/left.docx')
    const v1 = lastView(createDocsView)
    const t2 = manager.openSheetsTab('/tmp/right.xlsx')
    const v2 = lastView(createSheetsView)

    manager.activateTab(t2)
    manager.openSplit(t1, 'right')
    expect(manager.getSplitState()).not.toBeNull()

    const cmpId = manager.openCompareTab({
      left: { kind: 'tab', tabId: t2 },
      right: { kind: 'tab', tabId: t1 },
    })
    const compareView = state.createdWebContentsViews[0]!

    expect(manager.getSplitState()).toBeNull()
    expect(manager.activeTabId()).toBe(cmpId)
    expect(compareView.getBounds()).toEqual(STAGE_RECT)
    expect(v1.setVisible).toHaveBeenLastCalledWith(false)
    expect(v2.setVisible).toHaveBeenLastCalledWith(false)
  })

  it('opens, reuses, splits, and docks the standalone terminal tab', () => {
    const docId = manager.openDocsTab('/tmp/notes.docx')
    const docView = lastView(createDocsView)

    const termId = manager.openTerminalTab({ sessionId: 'term-sess-1' })
    expect(state.createdWebContentsViews).toHaveLength(1)
    const termView = state.createdWebContentsViews[0]!
    const loadedUrl = termView.webContents.loadURL.mock.calls[0]![0] as string
    expect(loadedUrl).toContain('view=terminal')
    expect(loadedUrl).toContain('session=term-sess-1')
    expect(manager.activeTabId()).toBe(termId)
    expect(manager.list().find((t) => t.id === termId)).toMatchObject({
      kind: 'terminal',
      title: 'Terminal',
      active: true,
    })

    // Standalone terminal tab can join a side-by-side split with a document tab.
    const split = manager.openSplit(docId, 'left')
    expect(split).toEqual({
      leftTabId: docId,
      rightTabId: termId,
      activePane: 'left',
      ratio: 0.5,
      syncScroll: false,
      suspended: false,
    })
    expect(docView.setVisible).toHaveBeenLastCalledWith(true)
    expect(termView.setVisible).toHaveBeenLastCalledWith(true)

    // Reopening terminal tab with a new sessionId reuses the view and notifies it.
    const reusedId = manager.openTerminalTab({ sessionId: 'term-sess-2' })
    expect(reusedId).toBe(termId)
    expect(state.createdWebContentsViews).toHaveLength(1)
    expect(termView.webContents.send).toHaveBeenCalledWith(
      TERMINAL_CHANNELS.tabSessionUpdated,
      'term-sess-2',
    )

    // Closing terminal tabs (docking back to drawer) exits split and keeps sibling doc active.
    manager.closeTerminalTabs()
    expect(manager.list().some((t) => t.kind === 'terminal')).toBe(false)
    expect(manager.getSplitState()).toBeNull()
    expect(manager.activeTabId()).toBe(docId)
    expect(docView.setVisible).toHaveBeenLastCalledWith(true)
  })

  it('reserves open bottom terminal drawer height under autoHideActive and suppresses dock overlay', () => {
    const syncDock = vi.fn()
    manager.setDockOverlay({ sync: syncDock, dispose: vi.fn() } as never)

    const docId = manager.openDocsTab('/tmp/fullscreen.docx')
    const docView = lastView(createDocsView)

    // Simulate autoHide topbar with open 280px bottom terminal drawer (744 - 280 = 464 bottom).
    manager.setStageRect({ x: 200, y: 44, width: 1008, height: 420 })
    manager.setWindowChromeState({
      maximized: true,
      fullScreen: false,
      autoHideEnabled: true,
      autoHideActive: true,
      revealed: false,
    })

    expect(manager.activeTabId()).toBe(docId)
    expect(docView.getBounds()).toEqual({ x: 0, y: 0, width: 1208, height: 464 })
    expect(syncDock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        docActive: true,
        suppressed: true,
      }),
    )

    // Collapsing the bottom drawer restores full height and stops suppressing dock overlay.
    manager.setStageRect({ x: 200, y: 44, width: 1008, height: 700 })
    expect(docView.getBounds()).toEqual({ x: 0, y: 0, width: 1208, height: 744 })
    expect(syncDock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        docActive: true,
        suppressed: false,
      }),
    )
  })
})
