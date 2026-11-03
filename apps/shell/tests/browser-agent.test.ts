import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { session } from 'electron'
import type { WebContents } from 'electron'

/**
 * The browser skill's shell-main half (src/main/browser-agent.ts): the
 * active-tab resolution, the chrome-view → page-view pairing rebuilt from
 * creation order, the tool routing (read / screenshot / fill / click), the
 * structured error paths (no tab, unreachable page, timeout), the read
 * budget, the defensive consumption of W2a's `readAnnotationsFor` contract,
 * and the channel's IPC gate: only the panel-hosting renderers (the shell
 * window's drawer and the drawer overlay's standalone panel) may call, and
 * fill/click additionally need the main-side confirmation. Electron and the
 * browser app's module are faked. (The page script itself — including the
 * password redaction — runs in browser-agent-read-page.test.ts under jsdom.)
 */

const browserExports = vi.hoisted(() => ({
  readAnnotationsFor: undefined as undefined | ((url: string) => unknown),
  readAnnotationShot: undefined as undefined | ((id: string) => unknown),
  clearAnnotationsFor: undefined as undefined | ((url: string) => number),
  // the navigate tool awaits the load's commit: the fake answers the same
  // promise shape the real one does
  browserNavigate: undefined as
    undefined | ((chrome: unknown, url: string) => void | Promise<void>),
}))

vi.mock('../../browser/src/main/browser-main', () => browserExports)

const atomicWrites = vi.hoisted(() => [] as Array<{ path: string; bytes: Buffer }>)
vi.mock('../src/main/atomic-write', () => ({
  atomicWriteFile: async (path: string, bytes: Buffer) => {
    atomicWrites.push({ path, bytes })
  },
}))

const appOn = vi.hoisted(() => vi.fn())
const ipcHandlers = vi.hoisted(() => new Map<string, (event: unknown, call: unknown) => unknown>())
const sessions = vi.hoisted(() => new Map<string, { id: string }>())
const webContentsById = vi.hoisted(() => new Map<number, unknown>())

vi.mock('electron', () => ({
  app: { on: appOn, getPath: () => '/tmp/genoffice-browser-agent-test' },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, call: unknown) => unknown) => {
      ipcHandlers.set(channel, handler)
    },
  },
  session: {
    fromPartition: (partition: string) => {
      let s = sessions.get(partition)
      if (!s) {
        s = { id: partition }
        sessions.set(partition, s)
      }
      return s
    },
  },
  webContents: {
    fromId: (id: number) => webContentsById.get(id),
  },
}))

import {
  BROWSER_CLEAR_ANNOTATIONS_TOOL,
  BROWSER_CLICK_TOOL,
  BROWSER_DOWNLOAD_TOOL,
  BROWSER_FILL_FIELD_TOOL,
  BROWSER_GO_BACK_TOOL,
  BROWSER_GO_FORWARD_TOOL,
  BROWSER_LIST_ANNOTATIONS_TOOL,
  BROWSER_PRESS_KEY_TOOL,
  BROWSER_READ_ANNOTATION_SHOT_TOOL,
  BROWSER_READ_PAGE_TOOL,
  BROWSER_RELOAD_TOOL,
  BROWSER_SCREENSHOT_TOOL,
  BROWSER_SCROLL_TOOL,
  BROWSER_WAIT_FOR_TOOL,
  SHELL_ADD_TODO_TOOL,
  SHELL_CLOSE_TAB_TOOL,
  SHELL_CREATE_FOLDER_TOOL,
  SHELL_LIST_DIRECTORY_TOOL,
  SHELL_LIST_TABS_TOOL,
  SHELL_MOVE_FILE_TOOL,
  SHELL_NAVIGATE_TOOL,
  SHELL_OPEN_BROWSER_TOOL,
  SHELL_OPEN_FOLDER_TOOL,
  SHELL_OPEN_PATH_TOOL,
  SHELL_RENAME_FILE_TOOL,
  SHELL_STAR_FILE_TOOL,
  SHELL_SWITCH_TAB_TOOL,
  SHELL_UNSTAR_FILE_TOOL,
  SHELL_WRITE_TEXT_FILE_TOOL,
  createShellSkill,
  type BrowserPageRead,
  type SurfaceTab,
} from '@genoffice/agent-core'
import {
  BrowserPageLinks,
  browserAnnotationShotFor,
  browserAnnotationsFor,
  executeBrowserSkillAction,
  registerBrowserSkillIpc,
  resolveActiveBrowserTab,
  resolveAgentUrl,
  BROWSER_SKILL_CHANNEL,
  type BrowserAgentDeps,
  type BrowserAgentIpcDeps,
  type BrowserTabLike,
} from '../src/main/browser-agent'

// ── fakes ───────────────────────────────────────────────────────────────────

interface FakeWc {
  id: number
  session?: { id: string }
  executeJavaScript: ReturnType<typeof vi.fn>
  executeJavaScriptInIsolatedWorld: ReturnType<typeof vi.fn>
  capturePage: ReturnType<typeof vi.fn>
  isDestroyed: () => boolean
  getURL: () => string
  getTitle: () => string
}

let nextWcId = 1

function makeWc(overrides: Partial<FakeWc> = {}): FakeWc {
  const wc: FakeWc = {
    id: nextWcId++,
    executeJavaScript: vi.fn(async () => ({})),
    executeJavaScriptInIsolatedWorld: vi.fn(async () => ({ ok: true, detail: 'done' })),
    capturePage: vi.fn(async () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 1280, height: 800 }),
      resize: () => {
        throw new Error('resize not expected')
      },
      toPNG: () => Buffer.from('png-bytes'),
    })),
    isDestroyed: () => false,
    getURL: () => 'https://example.com/',
    getTitle: () => 'Example Domain',
    ...overrides,
  }
  return wc
}

const asWc = (wc: FakeWc): WebContents => wc as unknown as WebContents

/** a page script answer shaped like READ_PAGE_SCRIPT's */
const OUTLINE = {
  url: 'https://example.com/',
  title: 'Example Domain',
  textBlocks: ['Hello world', 'More text'],
  elements: [
    { selector: '#q', tag: 'input', role: 'input', text: '', type: 'search' },
    { selector: 'a:nth-child(2)', tag: 'a', role: 'link', text: 'About us' },
  ],
}

/** deps wired at a chrome and a page, with the tab list given per test */
function depsWith(
  chrome: FakeWc,
  page: FakeWc,
  tabs: readonly BrowserTabLike[],
  extra: Partial<BrowserAgentDeps> = {},
): BrowserAgentDeps {
  return {
    listBrowserTabs: () => tabs,
    webContentsFor: (tabId) => (tabId === 't1' ? asWc(chrome) : undefined),
    pageFor: (candidate) => (candidate === chrome ? asWc(page) : undefined),
    // the main-side confirmation is granted by default; the gate's own tests
    // inject the decisions that matter
    confirmAction: () => Promise.resolve(true),
    // the shell operator tools: permissive fakes the shell-tool tests spy on
    openBrowserTab: () => 't9',
    activateTab: () => true,
    listSurfaceTabs: () => [] as readonly SurfaceTab[],
    pathAllowed: () => true,
    openPath: () => true,
    // the shell's desktop powers: permissive defaults the tests override
    closeTab: () => true,
    openFolder: () => true,
    listDirectory: () => Promise.resolve({ dir: '/tmp/kb', entries: [], truncated: false }),
    createDirectory: (path) => Promise.resolve(path),
    writeTextFile: (path) => Promise.resolve(path),
    moveFile: (_from, to) => Promise.resolve(to),
    renameFile: (path, name) => Promise.resolve(`${path}/${name}`),
    starFile: () => true,
    unstarFile: () => true,
    addTodo: (text) => Promise.resolve({ id: 'todo-1', text, done: false }),
    ...extra,
  }
}

const TAB: BrowserTabLike = { id: 't1', kind: 'browser', title: 'Example Domain', active: true }

// ── the active tab resolution ──────────────────────────────────────────────

describe('resolveActiveBrowserTab', () => {
  const tab = (over: Partial<BrowserTabLike>): BrowserTabLike => ({
    id: 'x',
    kind: 'browser',
    title: 't',
    active: false,
    ...over,
  })

  it('picks the active tab when it is a browser tab', () => {
    const tabs = [
      tab({ id: 'a' }),
      tab({ id: 'b', active: true }),
      { id: 'd', kind: 'docs', title: 'x', active: false },
    ]
    expect(resolveActiveBrowserTab(tabs)?.id).toBe('b')
  })

  it('falls back to the last browser tab when the active tab is another app', () => {
    const tabs = [
      tab({ id: 'a' }),
      tab({ id: 'b' }),
      { id: 'd', kind: 'docs', title: 'x', active: true },
    ]
    expect(resolveActiveBrowserTab(tabs)?.id).toBe('b')
  })

  it('no browser tab at all answers undefined', () => {
    expect(resolveActiveBrowserTab([])).toBeUndefined()
    expect(
      resolveActiveBrowserTab([{ id: 'd', kind: 'docs', title: 'x', active: true }]),
    ).toBeUndefined()
  })
})

// ── the chrome → page pairing ───────────────────────────────────────────────

describe('BrowserPageLinks', () => {
  const pageIds = new Set([10, 12])
  const links = () => new BrowserPageLinks((wc) => pageIds.has(wc.id))

  it('pairs each page view with the chrome view created just before it', () => {
    const l = links()
    l.observeCreated({ id: 9 }) // chrome 1
    l.observeCreated({ id: 10 }) // page 1
    l.observeCreated({ id: 11 }) // chrome 2
    l.observeCreated({ id: 12 }) // page 2
    expect(l.pageOf(9)).toBe(10)
    expect(l.pageOf(11)).toBe(12)
    expect(l.pageOf(10)).toBeUndefined()
  })

  it('a second page view never pairs with another page view', () => {
    const l = links()
    l.observeCreated({ id: 9 })
    l.observeCreated({ id: 10 })
    l.observeCreated({ id: 12 }) // a second page without a chrome between
    expect(l.pageOf(9)).toBe(12)
    expect(l.pageOf(10)).toBeUndefined()
  })

  it('forgets both sides of a pairing', () => {
    const l = links()
    l.observeCreated({ id: 9 })
    l.observeCreated({ id: 10 })
    l.forget(10)
    expect(l.pageOf(9)).toBeUndefined()
    // the chrome side alone is gone too (forget by the other id works)
    l.observeCreated({ id: 21 })
    l.observeCreated({ id: 22 })
    l.forget(21)
    expect(l.pageOf(21)).toBeUndefined()
  })
})

// ── the W2a annotation contract ────────────────────────────────────────────

describe('browserAnnotationsFor (the readAnnotationsFor contract)', () => {
  beforeEach(() => {
    browserExports.readAnnotationsFor = undefined
  })

  it('answers the empty list when the browser side has no function yet (W2a not landed)', () => {
    browserExports.readAnnotationsFor = undefined
    expect(browserAnnotationsFor('https://example.com/')).toEqual([])
  })

  it('keeps the well-formed annotations and clips their fields', () => {
    browserExports.readAnnotationsFor = () => [
      { note: 'what is this?', textSnippet: 'Hello', selector: 'p:nth-of-type(1)' },
      { note: 7 }, // junk: dropped
      'nope', // junk: dropped
      { note: 'x'.repeat(600) }, // clipped
    ]
    const out = browserAnnotationsFor('https://example.com/')
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({
      note: 'what is this?',
      textSnippet: 'Hello',
      selector: 'p:nth-of-type(1)',
    })
    expect(out[1]!.note!.length).toBe(400)
  })

  it('carries the evidence pack fields forward, but never the shot path', () => {
    browserExports.readAnnotationsFor = () => [
      {
        id: 'ann-1',
        note: 'what is this?',
        textSnippet: 'Hello',
        selector: 'p:nth-of-type(1)',
        xpath: '/html/body/p[1]',
        shotPath: 'annotation-shots/ann-1.png',
      },
      { note: 'no pack', shotPath: 42 }, // junk shotPath: no marker
    ]
    const out = browserAnnotationsFor('https://example.com/')
    expect(out[0]).toEqual({
      id: 'ann-1',
      note: 'what is this?',
      textSnippet: 'Hello',
      selector: 'p:nth-of-type(1)',
      xpath: '/html/body/p[1]',
      hasShot: true,
    })
    expect(out[1]).toEqual({ note: 'no pack' })
  })

  it('a throwing store answers the empty list, not a failed read', () => {
    browserExports.readAnnotationsFor = () => {
      throw new Error('store exploded')
    }
    expect(browserAnnotationsFor('https://example.com/')).toEqual([])
  })

  it('a non-array answer reads as no annotations', () => {
    browserExports.readAnnotationsFor = () => ({ not: 'an array' })
    expect(browserAnnotationsFor('https://example.com/')).toEqual([])
  })
})

// ── the annotation shot contract ────────────────────────────────────────────

describe('browserAnnotationShotFor (the readAnnotationShot contract)', () => {
  beforeEach(() => {
    browserExports.readAnnotationShot = undefined
  })

  const SHOT = { id: 'ann-1', base64: 'AAAA', mime: 'image/png', width: 4, height: 2 }

  it('answers null when the browser side has no function yet', () => {
    browserExports.readAnnotationShot = undefined
    expect(browserAnnotationShotFor('ann-1')).toBeNull()
  })

  it('keeps a well-formed shot and clips its id', () => {
    browserExports.readAnnotationShot = () => SHOT
    expect(browserAnnotationShotFor('ann-1')).toEqual(SHOT)
    browserExports.readAnnotationShot = () => ({ ...SHOT, id: 'i'.repeat(300) })
    expect(browserAnnotationShotFor('long')).toMatchObject({ id: 'i'.repeat(100) })
  })

  it('refuses junk shapes: no bytes, no size, no id, not an object', () => {
    for (const answer of [
      null,
      undefined,
      'shot',
      42,
      {},
      { ...SHOT, base64: '' },
      { ...SHOT, mime: '' },
      { ...SHOT, id: '' },
      { ...SHOT, width: 0 },
      { ...SHOT, height: -1 },
      { ...SHOT, width: NaN },
      { ...SHOT, base64: 7 },
    ]) {
      browserExports.readAnnotationShot = () => answer
      expect(browserAnnotationShotFor('ann-1')).toBeNull()
    }
  })

  it('a throwing reader answers null, not a failed call', () => {
    browserExports.readAnnotationShot = () => {
      throw new Error('store exploded')
    }
    expect(browserAnnotationShotFor('ann-1')).toBeNull()
  })
})

// ── the tool routing ───────────────────────────────────────────────────────

describe('executeBrowserSkillAction', () => {
  beforeEach(() => {
    browserExports.readAnnotationsFor = undefined
    browserExports.readAnnotationShot = undefined
  })

  it('read_page runs the outline script on the page and formats within the budget', async () => {
    const chrome = makeWc()
    const page = makeWc({
      executeJavaScript: vi.fn(async () => structuredClone(OUTLINE)),
    })
    const read = (await executeBrowserSkillAction(
      depsWith(chrome, page, [TAB]),
      BROWSER_READ_PAGE_TOOL,
      {},
    )) as BrowserPageRead
    expect(page.executeJavaScript).toHaveBeenCalledTimes(1)
    expect(page.executeJavaScript.mock.calls[0]![0]).toMatch(/location\.href/)
    expect(read.url).toBe('https://example.com/')
    expect(read.title).toBe('Example Domain')
    expect(read.outline).toContain('# Example Domain')
    expect(read.outline).toContain('## Text blocks (2)')
    expect(read.outline).toContain('## Interactive elements (2)')
    expect(read.outline).toContain('- #q  (input · type=search)')
    expect(read.outline).toContain('- a:nth-child(2)  (link · "About us")')
    expect(read.annotations).toEqual([])
    expect(read.truncated).toBeUndefined()
  })

  it('read_page carries the page url to the annotation reader and renders its annotations', async () => {
    browserExports.readAnnotationsFor = (url) => {
      expect(url).toBe('https://example.com/')
      return [{ note: 'what is this?', textSnippet: 'Hello', selector: 'p:nth-of-type(1)' }]
    }
    const chrome = makeWc()
    const page = makeWc({ executeJavaScript: vi.fn(async () => structuredClone(OUTLINE)) })
    const read = (await executeBrowserSkillAction(
      depsWith(chrome, page, [TAB]),
      BROWSER_READ_PAGE_TOOL,
      {},
    )) as BrowserPageRead
    expect(read.annotations).toEqual([
      { note: 'what is this?', textSnippet: 'Hello', selector: 'p:nth-of-type(1)' },
    ])
    expect(read.outline).toContain('## Annotations the user left on this page (1)')
    expect(read.outline).toContain('what is this? — "Hello" (p:nth-of-type(1))')
  })

  it('a deps-provided reader outranks the module default', async () => {
    browserExports.readAnnotationsFor = () => [{ note: 'from the browser module' }]
    const chrome = makeWc()
    const page = makeWc({ executeJavaScript: vi.fn(async () => structuredClone(OUTLINE)) })
    const read = (await executeBrowserSkillAction(
      depsWith(chrome, page, [TAB], { readAnnotations: () => [{ note: 'from deps' }] }),
      BROWSER_READ_PAGE_TOOL,
      {},
    )) as BrowserPageRead
    expect(read.annotations).toEqual([{ note: 'from deps' }])
  })

  it('an oversized outline is truncated with the budget marker', async () => {
    const chrome = makeWc()
    const page = makeWc({
      executeJavaScript: vi.fn(async () => ({
        url: 'https://example.com/',
        title: 't',
        textBlocks: Array.from({ length: 40 }, () => 'x'.repeat(600)),
        elements: [],
      })),
    })
    const read = (await executeBrowserSkillAction(
      depsWith(chrome, page, [TAB]),
      BROWSER_READ_PAGE_TOOL,
      {},
    )) as BrowserPageRead
    expect(read.outline.length).toBeLessThanOrEqual(8200)
    expect(read.outline).toContain('outline truncated to the read budget')
    expect(read.truncated).toBe(true)
  })

  it('a page script that rejects answers a structured error', async () => {
    const chrome = makeWc()
    const page = makeWc({
      executeJavaScript: vi.fn(() => Promise.reject(new Error('script blew up'))),
    })
    await expect(
      executeBrowserSkillAction(depsWith(chrome, page, [TAB]), BROWSER_READ_PAGE_TOOL, {}),
    ).rejects.toThrow(/the page did not answer the read: script blew up/)
  })

  it('a page that never answers times out with a structured error', async () => {
    vi.useFakeTimers()
    try {
      const chrome = makeWc()
      const page = makeWc({
        executeJavaScript: vi.fn(() => new Promise(() => {})),
      })
      const attempt = executeBrowserSkillAction(
        depsWith(chrome, page, [TAB]),
        BROWSER_READ_PAGE_TOOL,
        {},
      )
      // let the call reach withTimeout and arm its timer before advancing it
      await Promise.resolve()
      await Promise.resolve()
      vi.advanceTimersByTime(10_001)
      await expect(attempt).rejects.toThrow(/reading the page timed out/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('no browser tab answers the guiding error', async () => {
    const chrome = makeWc()
    const page = makeWc()
    await expect(
      executeBrowserSkillAction(depsWith(chrome, page, []), BROWSER_READ_PAGE_TOOL, {}),
    ).rejects.toThrow(/no browser tab is open/)
    await expect(
      executeBrowserSkillAction(
        {
          ...depsWith(chrome, page, []),
          listBrowserTabs: () => [{ id: 'd', kind: 'docs', title: 'x', active: true }],
        },
        BROWSER_SCREENSHOT_TOOL,
        {},
      ),
    ).rejects.toThrow(/no browser tab is open/)
  })

  it('a tab whose chrome or page is unreachable answers a structured error', async () => {
    const chrome = makeWc()
    const page = makeWc()
    await expect(
      executeBrowserSkillAction(
        { ...depsWith(chrome, page, [TAB]), webContentsFor: () => undefined },
        BROWSER_READ_PAGE_TOOL,
        {},
      ),
    ).rejects.toThrow(/no longer live/)
    await expect(
      executeBrowserSkillAction(
        { ...depsWith(chrome, page, [TAB]), pageFor: () => undefined },
        BROWSER_READ_PAGE_TOOL,
        {},
      ),
    ).rejects.toThrow(/not reachable/)
  })

  it('screenshot_page captures, caps the width and answers the image payload', async () => {
    const chrome = makeWc()
    const page = makeWc({
      capturePage: vi.fn(async () => ({
        isEmpty: () => false,
        getSize: () => ({ width: 2000, height: 1250 }),
        resize: vi.fn(() => ({
          isEmpty: () => false,
          getSize: () => ({ width: 1280, height: 800 }),
          toPNG: () => Buffer.from('png-bytes'),
        })),
        toPNG: () => Buffer.from('png-bytes'),
      })),
    })
    const shot = (await executeBrowserSkillAction(
      depsWith(chrome, page, [TAB]),
      BROWSER_SCREENSHOT_TOOL,
      {},
    )) as { base64: string; mime: string; width: number; height: number; url: string }
    expect(shot).toMatchObject({
      base64: Buffer.from('png-bytes').toString('base64'),
      mime: 'image/png',
      width: 1280,
      height: 800,
      url: 'https://example.com/',
    })
  })

  it('a page with nothing visible to capture answers a structured error', async () => {
    const chrome = makeWc()
    const page = makeWc({
      capturePage: vi.fn(async () => ({
        isEmpty: () => true,
        getSize: () => ({ width: 0, height: 0 }),
      })),
    })
    await expect(
      executeBrowserSkillAction(depsWith(chrome, page, [TAB]), BROWSER_SCREENSHOT_TOOL, {}),
    ).rejects.toThrow(/nothing visible to capture/)
  })

  it('read_annotation_shot answers the shot without needing a live tab or page', async () => {
    browserExports.readAnnotationShot = () => ({
      id: 'ann-1',
      base64: 'AAAA',
      mime: 'image/png',
      width: 4,
      height: 2,
    })
    // no tab at all: the shot is a disk read, not a page read
    const shot = (await executeBrowserSkillAction(
      depsWith(makeWc(), makeWc(), []),
      BROWSER_READ_ANNOTATION_SHOT_TOOL,
      { id: 'ann-1' },
    )) as { id: string; base64: string }
    expect(shot).toMatchObject({ id: 'ann-1', base64: 'AAAA', mime: 'image/png' })
  })

  it('read_annotation_shot with no shot on file answers the structured error', async () => {
    browserExports.readAnnotationShot = () => null
    await expect(
      executeBrowserSkillAction(
        depsWith(makeWc(), makeWc(), [TAB]),
        BROWSER_READ_ANNOTATION_SHOT_TOOL,
        { id: 'ann-gone' },
      ),
    ).rejects.toThrow(/no screenshot is on file for annotation ann-gone/)
    // the browser module predating the export reads the same way
    browserExports.readAnnotationShot = undefined
    await expect(
      executeBrowserSkillAction(
        depsWith(makeWc(), makeWc(), [TAB]),
        BROWSER_READ_ANNOTATION_SHOT_TOOL,
        { id: 'ann-1' },
      ),
    ).rejects.toThrow(/no screenshot is on file/)
  })

  it('read_annotation_shot refuses a bad id before any read', async () => {
    browserExports.readAnnotationShot = vi.fn(() => ({
      id: 'x',
      base64: 'A',
      mime: 'image/png',
      width: 1,
      height: 1,
    }))
    const deps = depsWith(makeWc(), makeWc(), [TAB])
    await expect(
      executeBrowserSkillAction(deps, BROWSER_READ_ANNOTATION_SHOT_TOOL, {}),
    ).rejects.toThrow(/`id` must be a non-empty string/)
    await expect(
      executeBrowserSkillAction(deps, BROWSER_READ_ANNOTATION_SHOT_TOOL, { id: '' }),
    ).rejects.toThrow(/`id` must be a non-empty string/)
    await expect(
      executeBrowserSkillAction(deps, BROWSER_READ_ANNOTATION_SHOT_TOOL, { id: 'x'.repeat(101) }),
    ).rejects.toThrow(/at most 100 characters/)
    expect(browserExports.readAnnotationShot).not.toHaveBeenCalled()
  })

  it('a deps-provided shot reader outranks the module default', async () => {
    browserExports.readAnnotationShot = () => ({
      id: 'from-module',
      base64: 'M',
      mime: 'image/png',
      width: 1,
      height: 1,
    })
    const shot = (await executeBrowserSkillAction(
      depsWith(makeWc(), makeWc(), [TAB], {
        readAnnotationShot: (id) =>
          id === 'ann-1' ? { id, base64: 'D', mime: 'image/png', width: 2, height: 2 } : null,
      }),
      BROWSER_READ_ANNOTATION_SHOT_TOOL,
      { id: 'ann-1' },
    )) as { id: string; base64: string }
    expect(shot).toMatchObject({ id: 'ann-1', base64: 'D' })
  })

  it('fill_field injects the isolated-world script with JSON-escaped arguments', async () => {
    const chrome = makeWc()
    const page = makeWc({
      executeJavaScriptInIsolatedWorld: vi.fn(async () => ({
        ok: true,
        detail: 'filled #q with "hello"',
      })),
    })
    const result = (await executeBrowserSkillAction(
      depsWith(chrome, page, [TAB]),
      BROWSER_FILL_FIELD_TOOL,
      { selector: '#q', value: 'hello' },
    )) as { ok: boolean; detail: string }
    expect(result).toEqual({ ok: true, detail: 'filled #q with "hello"' })
    // the action runs in an isolated world, with the user gesture the
    // confirmation gate granted
    expect(page.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(
      42,
      [{ code: expect.any(String) }],
      true,
    )
    const code = page.executeJavaScriptInIsolatedWorld.mock.calls[0]![1][0]!.code as string
    // arguments travel as a JSON literal — never interpolated
    expect(code).toContain(
      JSON.stringify({ action: 'fill', selector: '#q', value: 'hello' }).slice(0, -1),
    )
    // a selector with quotes stays quoted, not escaping the script
    const hostile = page.executeJavaScriptInIsolatedWorld.mock.calls
    expect(hostile).toHaveLength(1)
  })

  it('a quoted selector cannot escape the injected script', async () => {
    const chrome = makeWc()
    const page = makeWc()
    await executeBrowserSkillAction(depsWith(chrome, page, [TAB]), BROWSER_CLICK_TOOL, {
      selector: '#q"); throw new Error("pwned',
    })
    const code = page.executeJavaScriptInIsolatedWorld.mock.calls[0]![1][0]!.code as string
    // the whole selector rides inside the JSON literal
    expect(code).toContain(
      JSON.stringify({
        action: 'click',
        selector: '#q"); throw new Error("pwned',
        value: '',
      }).slice(0, -1),
    )
    expect(code).not.toMatch(/throw new Error\("pwned"\)/)
  })

  it('fill_field with a bad selector or value answers a structured error before the page', async () => {
    const chrome = makeWc()
    const page = makeWc()
    const deps = depsWith(chrome, page, [TAB])
    await expect(
      executeBrowserSkillAction(deps, BROWSER_FILL_FIELD_TOOL, { selector: '' }),
    ).rejects.toThrow(/selector/)
    await expect(
      executeBrowserSkillAction(deps, BROWSER_FILL_FIELD_TOOL, { selector: 7, value: 'x' }),
    ).rejects.toThrow(/selector/)
    await expect(
      executeBrowserSkillAction(deps, BROWSER_FILL_FIELD_TOOL, { selector: '#q' }),
    ).rejects.toThrow(/value/)
    await expect(
      executeBrowserSkillAction(deps, BROWSER_CLICK_TOOL, { selector: '#q'.repeat(600) }),
    ).rejects.toThrow(/at most 500 characters/)
    expect(page.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
  })

  it('a page action failure reports the structured detail', async () => {
    const chrome = makeWc()
    const page = makeWc({
      executeJavaScriptInIsolatedWorld: vi.fn(async () => ({
        ok: false,
        detail: 'no element matches "#gone" — the page may have changed; read the page again',
      })),
    })
    const result = await executeBrowserSkillAction(
      depsWith(chrome, page, [TAB]),
      BROWSER_CLICK_TOOL,
      {
        selector: '#gone',
      },
    )
    expect(result).toEqual({
      ok: false,
      detail: 'no element matches "#gone" — the page may have changed; read the page again',
    })
  })

  it('an action the page rejects (script throw) reports a structured failure, not a rejection', async () => {
    const chrome = makeWc()
    const page = makeWc({
      executeJavaScriptInIsolatedWorld: vi.fn(() =>
        Promise.reject(new Error('page renderer gone')),
      ),
    })
    const result = await executeBrowserSkillAction(
      depsWith(chrome, page, [TAB]),
      BROWSER_CLICK_TOOL,
      {
        selector: '#q',
      },
    )
    expect(result).toEqual({
      ok: false,
      detail: 'the page rejected the click: page renderer gone',
    })
  })

  it('an unknown tool answers an error', async () => {
    const chrome = makeWc()
    const page = makeWc()
    await expect(
      executeBrowserSkillAction(depsWith(chrome, page, [TAB]), 'browser:navigate', {}),
    ).rejects.toThrow(/unknown browser tool/)
  })
})

// ── the IPC registration ───────────────────────────────────────────────────

describe('registerBrowserSkillIpc', () => {
  beforeEach(() => {
    appOn.mockClear()
    ipcHandlers.clear()
    webContentsById.clear()
    sessions.clear()
    browserExports.readAnnotationsFor = undefined
  })

  it('watches web-contents-created and serves the channel against the pairing', async () => {
    const shellWc = { id: 201, isDestroyed: () => false } as unknown as WebContents
    registerBrowserSkillIpc({
      listBrowserTabs: () => [TAB],
      webContentsFor: (tabId) =>
        tabId === 't1'
          ? ({ id: 101, isDestroyed: () => false } as unknown as WebContents)
          : undefined,
      panelWebContents: () => [shellWc],
      confirmPageAction: async () => true,
    })
    // the pairing watcher registered
    expect(appOn).toHaveBeenCalledWith('web-contents-created', expect.any(Function))
    const observe = appOn.mock.calls[0]![1] as (event: unknown, wc: unknown) => void
    // the page view must carry the session object the mocked fromPartition
    // hands out — pairing is by session identity
    const browserSession = (
      (await import('electron')) as { session: { fromPartition: (p: string) => unknown } }
    ).session.fromPartition('persist:browser')
    const page = makeWc({
      id: 102,
      session: browserSession as FakeWc['session'],
      executeJavaScript: vi.fn(async () => structuredClone(OUTLINE)),
    })
    webContentsById.set(102, page)
    // chrome view (no browser session) then its nested page view
    observe({}, makeWc({ id: 101 }))
    observe({}, page)
    const handler = ipcHandlers.get(BROWSER_SKILL_CHANNEL)!
    const event = { sender: shellWc }
    const read = (await handler(event, {
      tool: BROWSER_READ_PAGE_TOOL,
      input: {},
    })) as BrowserPageRead
    expect(read.title).toBe('Example Domain')
    expect(page.executeJavaScript).toHaveBeenCalled()
  })

  it('rejects a malformed call shape', async () => {
    const shellWc = { id: 201, isDestroyed: () => false } as unknown as WebContents
    registerBrowserSkillIpc({
      listBrowserTabs: () => [],
      webContentsFor: () => undefined,
      panelWebContents: () => [shellWc],
      confirmPageAction: async () => true,
    })
    const handler = ipcHandlers.get(BROWSER_SKILL_CHANNEL)!
    const event = { sender: shellWc }
    await expect(handler(event, {})).rejects.toThrow(/requires a tool name/)
    await expect(handler(event, { tool: 'browser:read_page', input: 'nope' })).rejects.toThrow(
      /input must be an object/,
    )
  })
})

// ── the IPC gate (P1-4) ─────────────────────────────────────────────────────

describe('the browserskill:execute gate (P1-4)', () => {
  /**
   * One registered channel with the pairing already established: a chrome
   * view, its nested page view (paired by the mocked session identity), and
   * the two panel-hosting webContents the sender check compares against —
   * the shell window's renderer and the drawer overlay's standalone panel.
   */
  function setupChannel(over: Partial<BrowserAgentIpcDeps> = {}): {
    page: FakeWc
    shellWc: FakeWc
    overlayWc: FakeWc
    handler: (event: unknown, call: unknown) => Promise<unknown>
    event: { sender: FakeWc }
  } {
    const browserSession = session.fromPartition('persist:browser')
    const chrome = makeWc({ id: 101 })
    const page = makeWc({
      id: 102,
      session: browserSession as FakeWc['session'],
      executeJavaScriptInIsolatedWorld: vi.fn(async () => ({ ok: true, detail: 'done' })),
    })
    const shellWc = makeWc({ id: 201 })
    const overlayWc = makeWc({ id: 202 })
    webContentsById.set(102, page)
    registerBrowserSkillIpc({
      listBrowserTabs: () => [TAB],
      webContentsFor: (tabId) => (tabId === 't1' ? asWc(chrome) : undefined),
      panelWebContents: () => [asWc(shellWc), asWc(overlayWc)],
      confirmPageAction: async () => true,
      ...over,
    })
    const observe = appOn.mock.calls.find((call) => call[0] === 'web-contents-created')![1] as (
      event: unknown,
      wc: unknown,
    ) => void
    observe({}, chrome)
    observe({}, page)
    return {
      page,
      shellWc,
      overlayWc,
      handler: ipcHandlers.get(BROWSER_SKILL_CHANNEL)!,
      event: { sender: shellWc },
    }
  }

  beforeEach(() => {
    appOn.mockClear()
    ipcHandlers.clear()
    webContentsById.clear()
    sessions.clear()
    browserExports.readAnnotationsFor = undefined
  })

  it('refuses a sender that is neither panel-hosting webContents, before parsing the call', async () => {
    const { handler } = setupChannel()
    const other = makeWc()
    await expect(
      handler({ sender: other }, { tool: BROWSER_READ_PAGE_TOOL, input: {} }),
    ).rejects.toThrow(/not callable from this sender/)
    // a destroyed or missing panel host fails closed the same way
    const destroyed = setupChannel({
      panelWebContents: () => [{ isDestroyed: () => true } as unknown as WebContents],
    })
    await expect(
      destroyed.handler({ sender: destroyed.shellWc }, { tool: BROWSER_READ_PAGE_TOOL }),
    ).rejects.toThrow(/not callable from this sender/)
    const gone = setupChannel({ panelWebContents: () => [] })
    await expect(
      gone.handler({ sender: gone.shellWc }, { tool: BROWSER_READ_PAGE_TOOL }),
    ).rejects.toThrow(/not callable from this sender/)
  })

  it('accepts the drawer overlay panel webContents as a sender', async () => {
    // the drawer over a document is its own WebContentsView: its AgentLoop
    // calls the same tools, and the parked annotation card's pin-time shot
    // (read_annotation_shot) needs this acceptance above all
    const { overlayWc, page, handler } = setupChannel()
    const result = (await handler(
      { sender: overlayWc },
      {
        tool: BROWSER_CLICK_TOOL,
        input: { selector: '#q' },
      },
    )) as { ok: boolean; detail: string }
    expect(result).toEqual({ ok: true, detail: 'done' })
    expect(page.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(
      42,
      [{ code: expect.any(String) }],
      true,
    )
  })

  it('refuses a fill whose main-side confirmation was not granted', async () => {
    const confirm = vi.fn(async () => false)
    const { page, handler, event } = setupChannel({ confirmPageAction: confirm })
    await expect(
      handler(event, { tool: BROWSER_FILL_FIELD_TOOL, input: { selector: '#q', value: 'x' } }),
    ).rejects.toThrow(/declined this page action/)
    expect(page.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
    // the ask carried the exact action it was gating
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: BROWSER_FILL_FIELD_TOOL,
        action: 'fill',
        selector: '#q',
        value: 'x',
        pageTitle: 'Example Domain',
        pageUrl: 'https://example.com/',
      }),
    )
    // a panel that did not attach the marker (a stale renderer) sends no
    // `confirmed` key at all — the request reflects that honestly
    expect(confirm.mock.calls[0]![0]).not.toHaveProperty('confirmed')
  })

  it("the renderer gate's marker rides the request through to the confirm", async () => {
    // the panel\'s gated executor attaches `confirmed: true` (the delete_file
    // precedent); the ask the wiring makes of this request reads it — the
    // mode/marker/session verdict lives there (index.ts), pinned in
    // ai-permissions.test.ts; here we pin the plumbing
    const confirm = vi.fn(async () => true)
    const { handler, event } = setupChannel({ confirmPageAction: confirm })
    await handler(event, {
      tool: BROWSER_FILL_FIELD_TOOL,
      input: { selector: '#q', value: 'x', confirmed: true },
    })
    expect(confirm.mock.calls[0]![0]).toMatchObject({ confirmed: true })
    // a falsy or malformed marker is not the marker: the request carries no
    // `confirmed` key at all, exactly a stale renderer's call
    await handler(event, {
      tool: BROWSER_CLICK_TOOL,
      input: { selector: '#q', confirmed: 'yes' },
    })
    expect(confirm.mock.calls.at(-1)![0]).not.toHaveProperty('confirmed')
  })

  it('a forged marker does not pass the sender gate: only panel-hosting renderers are served', async () => {
    // the marker only ever skips the CONFIRM ask — it is not a credential:
    // a call from any other webContents is refused before the call is even
    // parsed, marker or not
    const confirm = vi.fn(async () => true)
    const { handler } = setupChannel({ confirmPageAction: confirm })
    const other = makeWc()
    await expect(
      handler(
        { sender: other },
        { tool: BROWSER_FILL_FIELD_TOOL, input: { selector: '#q', value: 'x', confirmed: true } },
      ),
    ).rejects.toThrow(/not callable from this sender/)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('a forged marker does not skip the input validation', async () => {
    // same honesty: the marker is not a key to the page — a malformed call
    // errors before any ask, marker or not
    const confirm = vi.fn(async () => true)
    const { page, handler, event } = setupChannel({ confirmPageAction: confirm })
    await expect(
      handler(event, { tool: BROWSER_FILL_FIELD_TOOL, input: { selector: '#q', confirmed: true } }),
    ).rejects.toThrow(/value/)
    await expect(
      handler(event, { tool: BROWSER_CLICK_TOOL, input: { selector: '', confirmed: true } }),
    ).rejects.toThrow(/selector/)
    expect(confirm).not.toHaveBeenCalled()
    expect(page.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
  })

  it('refuses a click without the main-side confirmation too', async () => {
    const { page, handler, event } = setupChannel({ confirmPageAction: async () => false })
    await expect(
      handler(event, { tool: BROWSER_CLICK_TOOL, input: { selector: '#q' } }),
    ).rejects.toThrow(/declined this page action/)
    expect(page.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
  })

  it('runs the action once the main-side confirmation grants it', async () => {
    const { page, handler, event } = setupChannel()
    const result = (await handler(event, {
      tool: BROWSER_CLICK_TOOL,
      input: { selector: '#q' },
    })) as { ok: boolean; detail: string }
    expect(result).toEqual({ ok: true, detail: 'done' })
    expect(page.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(
      42,
      [{ code: expect.any(String) }],
      true,
    )
  })

  it('fails closed when the confirmation itself throws', async () => {
    const { page, handler, event } = setupChannel({
      confirmPageAction: () => Promise.reject(new Error('dialog exploded')),
    })
    await expect(
      handler(event, { tool: BROWSER_CLICK_TOOL, input: { selector: '#q' } }),
    ).rejects.toThrow(/declined this page action/)
    expect(page.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
  })

  it('validates the input before asking for the confirmation', async () => {
    const confirm = vi.fn(async () => true)
    const { page, handler, event } = setupChannel({ confirmPageAction: confirm })
    await expect(
      handler(event, { tool: BROWSER_FILL_FIELD_TOOL, input: { selector: '#q' } }),
    ).rejects.toThrow(/value/)
    await expect(
      handler(event, { tool: BROWSER_CLICK_TOOL, input: { selector: '' } }),
    ).rejects.toThrow(/selector/)
    expect(confirm).not.toHaveBeenCalled()
    expect(page.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
  })
})

describe('resolveAgentUrl (the agent navigation gate)', () => {
  it('resolves bare domains to https and keeps full urls', () => {
    expect(resolveAgentUrl('example.com')).toBe('https://example.com')
    expect(resolveAgentUrl('http://example.com/page')).toBe('http://example.com/page')
    expect(resolveAgentUrl('localhost:3000')).toBe('http://localhost:3000')
  })

  it('refuses search-shaped input: the agent passes addresses, not queries', () => {
    expect(() => resolveAgentUrl('best pizza near me')).toThrow(/does not look like a web address/)
    expect(() => resolveAgentUrl('')).toThrow(/non-empty web address/)
  })

  it('refuses non-web schemes: agent loads are http/https only', () => {
    // the address bar itself accepts file:, but an agent-driven load must
    // not — the model never walks the disk through a page view
    expect(() => resolveAgentUrl('file:///etc/passwd')).toThrow(/web-only/)
    expect(() => resolveAgentUrl('javascript:alert(1)')).toThrow(/does not look like|web-only/)
    expect(() => resolveAgentUrl('about:blank')).toThrow(/does not look like|web-only/)
  })
})

describe('the shell operator tools (ungated, validated)', () => {
  beforeEach(() => {
    browserExports.browserNavigate = undefined
  })

  it('open_browser delegates to the tab-strip dep and answers the tab id', async () => {
    const openBrowserTab = vi.fn((): string => 't9')
    const result = (await executeBrowserSkillAction(
      depsWith(makeWc(), makeWc(), [], { openBrowserTab }),
      SHELL_OPEN_BROWSER_TOOL,
      {},
    )) as { tabId: string }
    expect(openBrowserTab).toHaveBeenCalledWith(undefined)
    expect(result).toEqual({ tabId: 't9' })
  })

  it('open_browser validates an optional url through the agent gate', async () => {
    const openBrowserTab = vi.fn((): string => 't9')
    await expect(
      executeBrowserSkillAction(
        depsWith(makeWc(), makeWc(), [], { openBrowserTab }),
        SHELL_OPEN_BROWSER_TOOL,
        { url: 'file:///tmp/secret' },
      ),
    ).rejects.toThrow(/web-only/)
    expect(openBrowserTab).not.toHaveBeenCalled()
    // a bare domain resolves and rides the call
    await executeBrowserSkillAction(
      depsWith(makeWc(), makeWc(), [], { openBrowserTab }),
      SHELL_OPEN_BROWSER_TOOL,
      { url: 'example.com' },
    )
    expect(openBrowserTab).toHaveBeenCalledWith('https://example.com')
  })

  it('open_browser rejects a non-string url outright', async () => {
    await expect(
      executeBrowserSkillAction(depsWith(makeWc(), makeWc(), []), SHELL_OPEN_BROWSER_TOOL, {
        url: 42,
      }),
    ).rejects.toThrow(/`url` must be a string/)
  })

  it('navigate loads the resolved url into the active tab and answers the url that committed', async () => {
    const navigated: Array<{ chrome: number; url: string }> = []
    browserExports.browserNavigate = (chrome: unknown, url: string) => {
      navigated.push({ chrome: (chrome as FakeWc).id, url })
      return Promise.resolve()
    }
    const chrome = makeWc()
    // the page reports where it actually ended up (post-redirect): the tool's
    // answer is what landed, not what was asked for
    const page = makeWc({ getURL: () => 'https://genoffice.dev/docs' })
    const result = (await executeBrowserSkillAction(
      depsWith(chrome, page, [TAB]),
      SHELL_NAVIGATE_TOOL,
      { url: 'genoffice.dev/docs' },
    )) as { tabId: string; url: string }
    expect(result).toEqual({ tabId: 't1', url: 'https://genoffice.dev/docs' })
    expect(navigated).toEqual([{ chrome: chrome.id, url: 'https://genoffice.dev/docs' }])
  })

  it('navigate refuses a background-only surface: only a strictly active tab may be navigated', async () => {
    browserExports.browserNavigate = () => {
      throw new Error('must not be called')
    }
    const background: readonly BrowserTabLike[] = [
      { id: 't1', kind: 'browser', title: 'Example Domain', active: false },
      { id: 't2', kind: 'browser', title: 'Docs', active: false },
    ]
    await expect(
      executeBrowserSkillAction(depsWith(makeWc(), makeWc(), background), SHELL_NAVIGATE_TOOL, {
        url: 'https://example.com/',
      }),
    ).rejects.toThrow(/no browser tab is active.*shell:switch_tab.*shell:open_browser/)
  })

  it('navigate reports a failed load as a tool error', async () => {
    browserExports.browserNavigate = () => Promise.reject(new Error('ERR_INTERNET_DISCONNECTED'))
    await expect(
      executeBrowserSkillAction(depsWith(makeWc(), makeWc(), [TAB]), SHELL_NAVIGATE_TOOL, {
        url: 'https://example.com/',
      }),
    ).rejects.toThrow(/the page did not load: ERR_INTERNET_DISCONNECTED/)
  })

  it('navigate answers a load that never commits with the timeout error', async () => {
    vi.useFakeTimers()
    try {
      browserExports.browserNavigate = () => new Promise<void>(() => {})
      const pending = executeBrowserSkillAction(
        depsWith(makeWc(), makeWc(), [TAB]),
        SHELL_NAVIGATE_TOOL,
        { url: 'https://example.com/' },
      )
      // the rejection handler exists before the timer fires, or the race
      // reports itself as an unhandled rejection
      const assertion = expect(pending).rejects.toThrow(/the navigation timed out after 8s/)
      await vi.advanceTimersByTimeAsync(8000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('navigate with no browser tab points the model at open_browser', async () => {
    await expect(
      executeBrowserSkillAction(depsWith(makeWc(), makeWc(), []), SHELL_NAVIGATE_TOOL, {
        url: 'https://example.com/',
      }),
    ).rejects.toThrow(/shell:open_browser/)
  })

  it('navigate refuses non-web input before touching the tab', async () => {
    browserExports.browserNavigate = () => {
      throw new Error('must not be called')
    }
    await expect(
      executeBrowserSkillAction(depsWith(makeWc(), makeWc(), [TAB]), SHELL_NAVIGATE_TOOL, {
        url: 'file:///etc/passwd',
      }),
    ).rejects.toThrow(/web-only/)
  })

  it('list_tabs answers the surface enumeration as the bare array the skill renders', async () => {
    const tabs: readonly SurfaceTab[] = [
      { id: 'home', kind: 'home', title: 'Home', active: false },
      { id: 't1', kind: 'browser', title: 'Example', active: true, url: 'https://example.com/' },
    ]
    const result = await executeBrowserSkillAction(
      depsWith(makeWc(), makeWc(), [TAB], { listSurfaceTabs: () => tabs }),
      SHELL_LIST_TABS_TOOL,
      {},
    )
    // the array itself, unwrapped: the renderer skill casts this shape
    // directly, and the seam test below holds both halves to it
    expect(result).toEqual(tabs)
  })

  it('list_tabs crosses the seam: what main answers is what the model sees', async () => {
    // the seam the two suites each pinned one side of — the main handler's
    // return and the skill's consumption of it, driven together through the
    // real executeBrowserSkillAction wiring and the real skill
    const tabs: readonly SurfaceTab[] = [
      { id: 'home', kind: 'home', title: 'Home', active: false },
      {
        id: 't1',
        kind: 'browser',
        title: 'Example',
        active: true,
        url: 'https://example.com/',
      },
      { id: 'doc1', kind: 'word', title: 'Report', active: false, filePath: '/docs/report.docx' },
    ]
    const skill = createShellSkill({
      surfaceTabs: () => null,
      viewer: 'home',
      execute: (tool, input) =>
        executeBrowserSkillAction(
          depsWith(makeWc(), makeWc(), [TAB], { listSurfaceTabs: () => tabs }),
          tool,
          input,
        ),
    })
    const execution = await skill.executeTool({ id: 'c1', name: SHELL_LIST_TABS_TOOL, input: {} })
    expect(execution.isError).toBeUndefined()
    expect(execution.summary).toBe('listed the tabs')
    expect(execution.output).toContain('Open tabs (id | kind | title | url or file):')
    expect(execution.output).toContain('- t1 | browser | Example | https://example.com/ | active')
    expect(execution.output).toContain('- doc1 | word | Report | /docs/report.docx')
    expect(execution.output).not.toContain('No tabs are open')
  })

  it('switch_tab routes the id and names an unknown one as an error', async () => {
    const activateTab = vi.fn((): boolean => true)
    await executeBrowserSkillAction(
      depsWith(makeWc(), makeWc(), [], { activateTab }),
      SHELL_SWITCH_TAB_TOOL,
      { id: 't1' },
    )
    expect(activateTab).toHaveBeenCalledWith('t1')
    await expect(
      executeBrowserSkillAction(
        depsWith(makeWc(), makeWc(), [], { activateTab: () => false }),
        SHELL_SWITCH_TAB_TOOL,
        { id: 'nope' },
      ),
    ).rejects.toThrow(/no open tab has the id "nope"/)
    await expect(
      executeBrowserSkillAction(depsWith(makeWc(), makeWc(), []), SHELL_SWITCH_TAB_TOOL, {}),
    ).rejects.toThrow(/`id` must be/)
  })

  it('open_path routes an in-scope file (verdict on the path and its realpath)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'genoffice-open-path-'))
    try {
      const file = join(dir, 'report.docx')
      writeFileSync(file, 'x')
      const openPath = vi.fn((): boolean => true)
      const pathAllowed = vi.fn((): boolean => true)
      await executeBrowserSkillAction(
        depsWith(makeWc(), makeWc(), [], { openPath, pathAllowed }),
        SHELL_OPEN_PATH_TOOL,
        { path: file },
      )
      expect(openPath).toHaveBeenCalledWith(file)
      expect(pathAllowed).toHaveBeenCalledWith(file)
      // the scope re-runs on the resolved path: a symlinked tmpdir (macOS
      // /var → /private/var) is the ordinary case, not an attack
      expect(pathAllowed).toHaveBeenCalledWith(realpathSync(file))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("open_path refuses a path outside the desktop's file scope", async () => {
    const openPath = vi.fn((): boolean => true)
    await expect(
      executeBrowserSkillAction(
        depsWith(makeWc(), makeWc(), [], { openPath, pathAllowed: () => false }),
        SHELL_OPEN_PATH_TOOL,
        { path: '/etc/passwd' },
      ),
    ).rejects.toThrow(/outside the desktop's file scope.*[Aa]sk the person/)
    expect(openPath).not.toHaveBeenCalled()
  })

  it('open_path refuses a relative path outright', async () => {
    await expect(
      executeBrowserSkillAction(depsWith(makeWc(), makeWc(), []), SHELL_OPEN_PATH_TOOL, {
        path: 'report.docx',
      }),
    ).rejects.toThrow(/`path` must be absolute/)
  })

  it('open_path refuses a symlink whose target sits outside the scope', async () => {
    const scopeDir = mkdtempSync(join(tmpdir(), 'genoffice-open-path-scope-'))
    const outsideDir = mkdtempSync(join(tmpdir(), 'genoffice-open-path-out-'))
    try {
      const target = join(outsideDir, 'secret.docx')
      writeFileSync(target, 'x')
      const link = join(scopeDir, 'report.docx')
      symlinkSync(target, link)
      const openPath = vi.fn((): boolean => true)
      // the verdict whitelists the link's own location only
      const pathAllowed = vi.fn((p: string) => p === link)
      await expect(
        executeBrowserSkillAction(
          depsWith(makeWc(), makeWc(), [], { openPath, pathAllowed }),
          SHELL_OPEN_PATH_TOOL,
          { path: link },
        ),
      ).rejects.toThrow(/resolves outside the desktop's file scope/)
      expect(openPath).not.toHaveBeenCalled()
    } finally {
      rmSync(scopeDir, { recursive: true, force: true })
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('open_path routes the path and reports a file nothing opens', async () => {
    const openPath = vi.fn((): boolean => true)
    await executeBrowserSkillAction(
      depsWith(makeWc(), makeWc(), [], { openPath }),
      SHELL_OPEN_PATH_TOOL,
      { path: '/docs/report.docx' },
    )
    expect(openPath).toHaveBeenCalledWith('/docs/report.docx')
    await expect(
      executeBrowserSkillAction(
        depsWith(makeWc(), makeWc(), [], { openPath: () => false }),
        SHELL_OPEN_PATH_TOOL,
        { path: '/tmp/thing.unknown' },
      ),
    ).rejects.toThrow(/did not open/)
    await expect(
      executeBrowserSkillAction(depsWith(makeWc(), makeWc(), []), SHELL_OPEN_PATH_TOOL, {
        path: '',
      }),
    ).rejects.toThrow(/`path` must be/)
  })
})

// ── the new page tools (movement, download, history, wait, key, annotations) ─

describe('the new page tools', () => {
  it("scroll_page runs its script on the active tab's page, in the isolated world", async () => {
    const chrome = makeWc()
    const page = makeWc()
    const result = (await executeBrowserSkillAction(
      depsWith(chrome, page, [TAB]),
      BROWSER_SCROLL_TOOL,
      { direction: 'down', amount: 800 },
    )) as { ok: boolean; detail: string }
    expect(result.ok).toBe(true)
    expect(page.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(
      42,
      [expect.objectContaining({ code: expect.stringContaining('scrollBy') })],
      true,
    )
    expect(chrome.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
    // a bad direction is refused before the page is touched
    await expect(
      executeBrowserSkillAction(depsWith(chrome, page, [TAB]), BROWSER_SCROLL_TOOL, {
        direction: 'sideways',
      }),
    ).rejects.toThrow(/direction/)
  })

  it('download_file fetches the address and sinks it under Downloads (the will-download story)', async () => {
    const chrome = makeWc()
    const page = makeWc()
    atomicWrites.length = 0
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const saved = (await executeBrowserSkillAction(
        depsWith(chrome, page, [TAB]),
        BROWSER_DOWNLOAD_TOOL,
        { url: 'https://example.com/report.pdf' },
      )) as { path: string; url: string; source: string; bytes: number }
      expect(fetchMock).toHaveBeenCalledWith(
        expect.objectContaining({ href: 'https://example.com/report.pdf' }),
      )
      expect(saved.url).toBe('https://example.com/report.pdf')
      expect(saved.source).toBe('url')
      expect(saved.bytes).toBe(4)
      expect(saved.path).toMatch(/Downloads\/report\.pdf$/)
      expect(atomicWrites).toHaveLength(1)
      expect(atomicWrites[0]!.path).toBe(saved.path)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('download_file refuses non-web schemes and an address neither argument names', async () => {
    const chrome = makeWc()
    const page = makeWc()
    await expect(
      executeBrowserSkillAction(depsWith(chrome, page, [TAB]), BROWSER_DOWNLOAD_TOOL, {
        url: 'file:///etc/passwd',
      }),
    ).rejects.toThrow(/not an http\/https address/)
    await expect(
      executeBrowserSkillAction(depsWith(chrome, page, [TAB]), BROWSER_DOWNLOAD_TOOL, {}),
    ).rejects.toThrow(/either `url` or `selector`/)
  })

  it("download_file's selector path resolves the element's address through the page", async () => {
    const chrome = makeWc()
    const page = makeWc({
      executeJavaScriptInIsolatedWorld: vi.fn(async () => ({
        ok: true,
        url: 'https://cdn.example.com/pic.png',
      })),
    })
    atomicWrites.length = 0
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      arrayBuffer: async () => new Uint8Array([9]).buffer,
    }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const saved = (await executeBrowserSkillAction(
        depsWith(chrome, page, [TAB]),
        BROWSER_DOWNLOAD_TOOL,
        { selector: 'img.hero' },
      )) as { source: string; url: string }
      expect(page.executeJavaScriptInIsolatedWorld).toHaveBeenCalled()
      expect(saved.source).toBe('selector')
      expect(saved.url).toBe('https://cdn.example.com/pic.png')
      expect(saved.path).toMatch(/pic\.png$/)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('go_back / go_forward drive the page history and answer its edges', async () => {
    const chrome = makeWc()
    const page = makeWc({
      navigationHistory: { canGoBack: () => true, canGoForward: () => false },
      goBack: vi.fn(),
      goForward: vi.fn(),
    } as unknown as Partial<FakeWc>)
    const back = (await executeBrowserSkillAction(
      depsWith(chrome, page, [TAB]),
      BROWSER_GO_BACK_TOOL,
      {},
    )) as { ok: boolean }
    expect(back.ok).toBe(true)
    expect(page.goBack).toHaveBeenCalled()
    const forward = (await executeBrowserSkillAction(
      depsWith(chrome, page, [TAB]),
      BROWSER_GO_FORWARD_TOOL,
      {},
    )) as { ok: boolean; detail: string }
    expect(forward.ok).toBe(false)
    expect(forward.detail).toContain('no later history')
    expect(page.goForward).not.toHaveBeenCalled()
  })

  it('reload drives the page and wait_for answers an idle page at once', async () => {
    const chrome = makeWc()
    const page = makeWc({
      reload: vi.fn(),
      isLoading: () => false,
    } as unknown as Partial<FakeWc>)
    const reloaded = (await executeBrowserSkillAction(
      depsWith(chrome, page, [TAB]),
      BROWSER_RELOAD_TOOL,
      {},
    )) as { ok: boolean }
    expect(reloaded.ok).toBe(true)
    expect(page.reload).toHaveBeenCalled()
    const waited = (await executeBrowserSkillAction(
      depsWith(chrome, page, [TAB]),
      BROWSER_WAIT_FOR_TOOL,
      { timeoutMs: 1000 },
    )) as { ok: boolean; detail: string }
    expect(waited.ok).toBe(true)
    expect(waited.detail).toContain('not loading')
    // the wait cap is a refusal, not a clamp
    await expect(
      executeBrowserSkillAction(depsWith(chrome, page, [TAB]), BROWSER_WAIT_FOR_TOOL, {
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow(/at most 10000/)
  })

  it("wait_for with a selector runs the page's poll script with the deadline baked in", async () => {
    const chrome = makeWc()
    const page = makeWc()
    const waited = (await executeBrowserSkillAction(
      depsWith(chrome, page, [TAB]),
      BROWSER_WAIT_FOR_TOOL,
      { selector: '.results', timeoutMs: 2000 },
    )) as { ok: boolean; detail: string }
    expect(waited.ok).toBe(true)
    expect(page.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(
      42,
      [expect.objectContaining({ code: expect.stringContaining('.results') })],
      true,
    )
  })

  it('press_key sends the whitelisted key through the real input pipeline, and refuses others', async () => {
    const chrome = makeWc()
    const sendInputEvent = vi.fn()
    const page = makeWc({ sendInputEvent } as unknown as Partial<FakeWc>)
    const pressed = (await executeBrowserSkillAction(
      depsWith(chrome, page, [TAB]),
      BROWSER_PRESS_KEY_TOOL,
      { key: 'enter' },
    )) as { ok: boolean }
    expect(pressed.ok).toBe(true)
    expect(sendInputEvent).toHaveBeenCalledWith({ type: 'rawKeyDown', keyCode: 'Return' })
    expect(sendInputEvent).toHaveBeenCalledWith({ type: 'keyUp', keyCode: 'Return' })
    await expect(
      executeBrowserSkillAction(depsWith(chrome, page, [TAB]), BROWSER_PRESS_KEY_TOOL, {
        key: 'a',
      }),
    ).rejects.toThrow(/must be one of/)
  })

  it("list_annotations answers the page's records; clear drops them by URL", async () => {
    const chrome = makeWc()
    const page = makeWc()
    browserExports.readAnnotationsFor = () => [
      { id: 'ann-1', selector: '#q', note: 'the search box' },
    ]
    try {
      const listed = (await executeBrowserSkillAction(
        depsWith(chrome, page, [TAB]),
        BROWSER_LIST_ANNOTATIONS_TOOL,
        {},
      )) as { url: string; annotations: unknown[] }
      expect(listed.url).toBe('https://example.com/')
      expect(listed.annotations).toHaveLength(1)
      // clear: the browser module's export answers the count
      browserExports.clearAnnotationsFor = () => 2
      const cleared = (await executeBrowserSkillAction(
        depsWith(chrome, page, [TAB]),
        BROWSER_CLEAR_ANNOTATIONS_TOOL,
        {},
      )) as { url: string; removed: number }
      expect(cleared.removed).toBe(2)
      expect(cleared.url).toBe('https://example.com/')
    } finally {
      browserExports.readAnnotationsFor = undefined
      browserExports.clearAnnotationsFor = undefined
    }
  })
})

// ── the shell's desktop powers (the new shell:* tools) ───────────────────────

describe('the shell desktop tools', () => {
  it("close_tab refuses the Home tab and unknown ids, and routes the strip's own verb", async () => {
    const chrome = makeWc()
    const page = makeWc()
    await expect(
      executeBrowserSkillAction(depsWith(chrome, page, [TAB]), SHELL_CLOSE_TAB_TOOL, {
        id: 'home',
      }),
    ).rejects.toThrow(/Home tab cannot be closed/)
    const closeTab = vi.fn(async () => false)
    await expect(
      executeBrowserSkillAction(depsWith(chrome, page, [TAB], { closeTab }), SHELL_CLOSE_TAB_TOOL, {
        id: 't404',
      }),
    ).rejects.toThrow(/no open tab matches/)
    expect(closeTab).toHaveBeenCalledWith('t404')
    const ok = (await executeBrowserSkillAction(
      depsWith(chrome, page, [TAB], { closeTab: async () => true }),
      SHELL_CLOSE_TAB_TOOL,
      { id: 't2' },
    )) as { id: string }
    expect(ok.id).toBe('t2')
  })

  it('open_folder answers the guiding error when the path is not inside a root', async () => {
    const chrome = makeWc()
    const page = makeWc()
    await expect(
      executeBrowserSkillAction(
        depsWith(chrome, page, [TAB], { openFolder: () => false }),
        SHELL_OPEN_FOLDER_TOOL,
        { path: '/tmp/nowhere' },
      ),
    ).rejects.toThrow(/not inside a folder the desktop tracks/)
    const opened = (await executeBrowserSkillAction(
      depsWith(chrome, page, [TAB], { openFolder: () => true }),
      SHELL_OPEN_FOLDER_TOOL,
      { path: '/tmp/kb' },
    )) as { path: string }
    expect(opened.path).toBe('/tmp/kb')
  })

  it('list_directory routes to the dep and the write/rearrange tools route with their args', async () => {
    const chrome = makeWc()
    const page = makeWc()
    const listDirectory = vi.fn(async () => ({
      dir: '/tmp/kb',
      entries: [
        { name: 'notes.md', kind: 'file', size: 12 },
        { name: 'sub', kind: 'folder' },
      ],
      truncated: false,
    }))
    const listed = (await executeBrowserSkillAction(
      depsWith(chrome, page, [TAB], { listDirectory }),
      SHELL_LIST_DIRECTORY_TOOL,
      { path: '/tmp/kb' },
    )) as { entries: unknown[] }
    expect(listDirectory).toHaveBeenCalledWith('/tmp/kb')
    expect(listed.entries).toHaveLength(2)

    const createDirectory = vi.fn(async (path: string) => path)
    const created = (await executeBrowserSkillAction(
      depsWith(chrome, page, [TAB], { createDirectory }),
      SHELL_CREATE_FOLDER_TOOL,
      { path: '/tmp/kb/new' },
    )) as { path: string }
    expect(createDirectory).toHaveBeenCalledWith('/tmp/kb/new')
    expect(created.path).toBe('/tmp/kb/new')

    const writeTextFile = vi.fn(async (path: string, _content: string) => path)
    await executeBrowserSkillAction(
      depsWith(chrome, page, [TAB], { writeTextFile }),
      SHELL_WRITE_TEXT_FILE_TOOL,
      { path: '/tmp/kb/a.txt', content: 'hello' },
    )
    expect(writeTextFile).toHaveBeenCalledWith('/tmp/kb/a.txt', 'hello')

    const moveFile = vi.fn(async (_from: string, to: string) => to)
    await executeBrowserSkillAction(
      depsWith(chrome, page, [TAB], { moveFile }),
      SHELL_MOVE_FILE_TOOL,
      { from: '/tmp/kb/a.txt', to: '/tmp/kb2/a.txt' },
    )
    expect(moveFile).toHaveBeenCalledWith('/tmp/kb/a.txt', '/tmp/kb2/a.txt')

    const renameFile = vi.fn(async (path: string, name: string) => `${path}-${name}`)
    await executeBrowserSkillAction(
      depsWith(chrome, page, [TAB], { renameFile }),
      SHELL_RENAME_FILE_TOOL,
      { path: '/tmp/kb/a.txt', name: 'b.txt' },
    )
    expect(renameFile).toHaveBeenCalledWith('/tmp/kb/a.txt', 'b.txt')
  })

  it('star/unstar refuse a missing file, and add_todo routes the text', async () => {
    const chrome = makeWc()
    const page = makeWc()
    await expect(
      executeBrowserSkillAction(
        depsWith(chrome, page, [TAB], { starFile: () => false }),
        SHELL_STAR_FILE_TOOL,
        { path: '/tmp/gone.md' },
      ),
    ).rejects.toThrow(/does not exist/)
    const starFile = vi.fn(() => true)
    await executeBrowserSkillAction(
      depsWith(chrome, page, [TAB], { starFile }),
      SHELL_STAR_FILE_TOOL,
      {
        path: '/tmp/kb/a.md',
      },
    )
    expect(starFile).toHaveBeenCalledWith('/tmp/kb/a.md')
    const unstarFile = vi.fn(() => true)
    await executeBrowserSkillAction(
      depsWith(chrome, page, [TAB], { unstarFile }),
      SHELL_UNSTAR_FILE_TOOL,
      { path: '/tmp/kb/a.md' },
    )
    expect(unstarFile).toHaveBeenCalledWith('/tmp/kb/a.md')
    const addTodo = vi.fn(async (text: string) => ({ id: 'todo-1', text, done: false }))
    const todo = (await executeBrowserSkillAction(
      depsWith(chrome, page, [TAB], { addTodo }),
      SHELL_ADD_TODO_TOOL,
      { text: 'buy milk' },
    )) as { id: string; text: string }
    expect(addTodo).toHaveBeenCalledWith('buy milk')
    expect(todo).toEqual({ id: 'todo-1', text: 'buy milk', done: false })
  })
})
