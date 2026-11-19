import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, args: unknown) => unknown) => {
      handlers.set(channel, listener)
    },
  },
}))

import {
  APP_SKILL_CHANNELS,
  buildAppSkillManifest,
  executeAppSkillRead,
  registerAppSkillIpc,
  type AppDocumentReader,
  type AppSkillProxyDeps,
} from '../../src/main/mcp/app-skill-proxy'
import type { DesktopWindowInfo } from '../../src/main/desktop-control'

/**
 * The shell-main half of the desktop loop: the manifest follows the
 * open-window enumeration (only tabs of apps with a reader expose their tool),
 * and one prefixed read call routes to the right family reader and window.
 * The enumeration is a fake in the desktop-control shape; the readers are
 * fakes too — the point under test is the routing, not any app's read.
 */

function contentsFor(id: number): WebContents {
  return { id, isDestroyed: () => false } as unknown as WebContents
}

const WINDOWS: DesktopWindowInfo[] = [
  { id: 'home', kind: 'home', title: 'GenOffice', active: true },
  { id: 'tab-2', kind: 'docs', title: 'report.docx', filePath: '/tmp/report.docx', active: false },
  {
    id: 'tab-5',
    kind: 'sheets',
    title: 'budget.xlsx',
    filePath: '/tmp/budget.xlsx',
    active: false,
  },
  { id: 'tab-6', kind: 'pdf', title: 'scan.pdf', filePath: '/tmp/scan.pdf', active: false },
  { id: 'tab-7', kind: 'docs', title: 'notes.docx', active: true },
]

const READERS: Partial<Record<'docs' | 'sheets', AppDocumentReader>> = {
  docs: async () => ({ text: '0|heading|Report' }),
  sheets: async () => ({ sheets: [{ name: 'Sheet1' }] }),
}

function depsWith(
  windows: readonly DesktopWindowInfo[],
  readers: Partial<Record<string, AppDocumentReader>> = READERS,
): AppSkillProxyDeps {
  const byId = new Map(WINDOWS.map((w) => [w.id, contentsFor(Number(w.id.replace(/\D/g, '')))]))
  return {
    listWindows: () => [...windows],
    webContentsFor: (tabId) => byId.get(tabId),
    readers: readers as AppSkillProxyDeps['readers'],
  }
}

describe('the app-skill manifest', () => {
  it('offers the read tool only of apps with an open tab and a reader', () => {
    const manifest = buildAppSkillManifest(WINDOWS, READERS as AppSkillProxyDeps['readers'])
    expect(manifest.tools.map((t) => t.name)).toEqual(['docs:read_document', 'sheets:read_sheet'])
    expect(manifest.tools.map((t) => t.kind)).toEqual(['docs', 'sheets'])
  })

  it('lists every open document window (Home excluded) even without a tool', () => {
    const manifest = buildAppSkillManifest(WINDOWS, READERS as AppSkillProxyDeps['readers'])
    expect(manifest.windows.map((w) => w.id)).toEqual(['tab-2', 'tab-5', 'tab-6', 'tab-7'])
    // the pdf tab is context, but pdf has no read surface (the app is a viewer)
    expect(manifest.tools.find((t) => t.kind === 'pdf')).toBeUndefined()
  })

  it('drops a family whose tabs all closed (the degrade path)', () => {
    const windows = WINDOWS.filter((w) => w.kind !== 'sheets')
    const manifest = buildAppSkillManifest(windows, READERS as AppSkillProxyDeps['readers'])
    expect(manifest.tools.map((t) => t.name)).toEqual(['docs:read_document'])
    expect(manifest.windows.map((w) => w.kind)).not.toContain('sheets')
  })
})

describe('executeAppSkillRead routing', () => {
  it('routes by prefix to the family reader with the target window', async () => {
    const read: AppDocumentReader = async () => ({ text: 'blocks' })
    const seen: number[] = []
    const deps = {
      listWindows: () => [...WINDOWS],
      webContentsFor: (id: string) => {
        const wc = contentsFor(Number(id.replace(/\D/g, '')))
        seen.push(wc.id)
        return wc
      },
      readers: { docs: read },
    }
    const result = await executeAppSkillRead(deps, 'docs:read_document', { document: 'tab-2' })
    expect(result).toMatchObject({
      target: { id: 'tab-2', kind: 'docs', title: 'report.docx', path: '/tmp/report.docx' },
      result: { text: 'blocks' },
    })
    expect(seen).toEqual([2])
  })

  it('defaults to the family’s active window when no target is given', async () => {
    const result = await executeAppSkillRead(depsWith(WINDOWS), 'docs:read_document', {})
    expect(result.target.id).toBe('tab-7')
  })

  it('resolves a target by path as well as by tab id', async () => {
    const result = await executeAppSkillRead(depsWith(WINDOWS), 'docs:read_document', {
      document: '/tmp/report.docx',
    })
    expect(result.target.id).toBe('tab-2')
  })

  it('forwards and validates the sheets read payload', async () => {
    const read = vi.fn(async () => ({}))
    const deps = {
      listWindows: () => [...WINDOWS],
      webContentsFor: () => contentsFor(5),
      readers: { sheets: read },
    }
    await executeAppSkillRead(deps, 'sheets:read_sheet', {
      document: 'tab-5',
      addresses: ['A1', 'B2'],
      sheet: 'Sheet1',
    })
    expect(read).toHaveBeenCalledWith(expect.anything(), {
      addresses: ['A1', 'B2'],
      sheet: 'Sheet1',
    })
    await expect(
      executeAppSkillRead(deps, 'sheets:read_sheet', { addresses: 'A1' }),
    ).rejects.toThrow(/addresses.*array/)
    await expect(
      executeAppSkillRead(deps, 'sheets:read_sheet', {
        addresses: Array.from({ length: 101 }, (_, i) => `A${i}`),
      }),
    ).rejects.toThrow(/at most 100/)
  })

  it('guides a no-match target with what is actually open', async () => {
    await expect(
      executeAppSkillRead(depsWith(WINDOWS), 'docs:read_document', { document: 'tab-404' }),
    ).rejects.toThrow(/no open Word document matches "tab-404".*tab-2.*tab-7/s)
  })

  it('names the family when none of its documents is open (degrade, not crash)', async () => {
    const windows = WINDOWS.filter((w) => w.kind !== 'sheets')
    await expect(executeAppSkillRead(depsWith(windows), 'sheets:read_sheet', {})).rejects.toThrow(
      /no spreadsheet document is open/,
    )
  })

  it('refuses a family without a read surface (pdf) and an unknown tool', async () => {
    await expect(executeAppSkillRead(depsWith(WINDOWS), 'pdf:read_text', {})).rejects.toThrow(
      /PDF documents cannot be read/,
    )
    await expect(executeAppSkillRead(depsWith(WINDOWS), 'draw:read', {})).rejects.toThrow(
      /unknown app tool/,
    )
  })

  it('reports a window that closed between manifest and call', async () => {
    const deps = {
      listWindows: () => [...WINDOWS],
      webContentsFor: () => undefined,
      readers: { docs: async () => ({}) },
    }
    await expect(
      executeAppSkillRead(deps, 'docs:read_document', { document: 'tab-2' }),
    ).rejects.toThrow(/no longer open/)
  })
})

describe('the IPC registration', () => {
  it('registers both channels and serves them like invoke would', async () => {
    handlers.clear()
    registerAppSkillIpc(depsWith(WINDOWS))
    expect([...handlers.keys()].sort()).toEqual([
      APP_SKILL_CHANNELS.execute,
      APP_SKILL_CHANNELS.manifest,
    ])
    const manifest = (await handlers.get(APP_SKILL_CHANNELS.manifest)!({}, undefined)) as {
      tools: Array<{ name: string }>
    }
    expect(manifest.tools.map((t) => t.name)).toContain('docs:read_document')
    const executed = (await handlers.get(APP_SKILL_CHANNELS.execute)!(
      {},
      {
        tool: 'docs:read_document',
        input: { document: 'tab-2' },
      },
    )) as { target: { id: string } }
    expect(executed.target.id).toBe('tab-2')
  })

  it('validates the execute envelope before routing', async () => {
    handlers.clear()
    registerAppSkillIpc(depsWith(WINDOWS))
    const invoke = handlers.get(APP_SKILL_CHANNELS.execute)!
    await expect(invoke({}, {})).rejects.toThrow(/requires a tool name/)
    await expect(invoke({}, { tool: 'docs:read_document', input: 'nope' })).rejects.toThrow(
      /input must be an object/,
    )
  })

  it('forwards sheets:read_sheet range and registers/validates pdf:read_pages when a PDF reader is wired', async () => {
    const readSheet = vi.fn(async () => ({ grid: 'A\t1' }))
    const readPdf = vi.fn(async () => ({ text: '[Page 1]\nHello PDF' }))
    const deps = {
      listWindows: () => [...WINDOWS],
      webContentsFor: (id: string) =>
        id === 'tab-5' ? contentsFor(5) : id === 'tab-6' ? contentsFor(6) : undefined,
      readers: { sheets: readSheet, pdf: readPdf },
    }
    const manifest = buildAppSkillManifest(WINDOWS, deps.readers)
    expect(manifest.tools.map((t) => t.name)).toEqual(['sheets:read_sheet', 'pdf:read_pages'])

    await executeAppSkillRead(deps, 'sheets:read_sheet', {
      document: 'tab-5',
      range: 'A1:F32',
    })
    expect(readSheet).toHaveBeenCalledWith(expect.anything(), { range: 'A1:F32' })

    const pdfRes = await executeAppSkillRead(deps, 'pdf:read_pages', {
      document: 'tab-6',
      start: 2,
      end: 5,
    })
    expect(pdfRes.target.id).toBe('tab-6')
    expect(readPdf).toHaveBeenCalledWith(expect.anything(), { start: 2, end: 5 })

    await expect(
      executeAppSkillRead(deps, 'pdf:read_pages', { document: 'tab-6', start: 0 }),
    ).rejects.toThrow(/positive integer/)
    await expect(
      executeAppSkillRead(deps, 'pdf:read_pages', { document: 'tab-6', end: '2' }),
    ).rejects.toThrow(/positive integer/)
  })

  it('forwards docs/slides read params, filters present windows, and paginates large markdown/html text', async () => {
    const readDocs = vi.fn(async () => ({ text: 'block body' }))
    const readSlides = vi.fn(async () => ({ slides: [] }))
    const longText = `HEAD_${'A'.repeat(24_000)}_TAIL_998`
    const shortText = 'Short plain notes'
    const readMd = vi.fn(async (wc: WebContents) => (wc.id === 8 ? longText : shortText))
    const readHtml = vi.fn(async () => '<html><body>ok</body></html>')
    const windows: DesktopWindowInfo[] = [
      { id: 'tab-2', kind: 'docs', title: 'doc.docx', active: false },
      { id: 'tab-3', kind: 'slides', title: 'deck.pptx', active: false },
      { id: 'tab-8', kind: 'markdown', title: 'big.log', active: false },
      { id: 'tab-9', kind: 'markdown', title: 'short.txt', active: false },
      { id: 'tab-10', kind: 'html', title: 'page.html', active: false },
      { id: 'tab-11', kind: 'html', title: 'Present', active: true, present: true },
    ]
    const deps: AppSkillProxyDeps = {
      listWindows: () => windows,
      webContentsFor: (id) => contentsFor(Number(id.replace(/\D/g, ''))),
      readers: { docs: readDocs, slides: readSlides, markdown: readMd, html: readHtml },
    }

    const manifest = buildAppSkillManifest(windows, deps.readers)
    expect(manifest.windows.map((w) => w.id)).not.toContain('tab-11')

    await executeAppSkillRead(deps, 'docs:read_document', {
      document: 'tab-2',
      startBlockIndex: 1,
      endBlockIndex: 4,
      offset: 0,
    })
    expect(readDocs).toHaveBeenCalledWith(expect.anything(), {
      startBlockIndex: 1,
      endBlockIndex: 4,
      offset: 0,
    })
    await expect(
      executeAppSkillRead(deps, 'docs:read_document', { document: 'tab-2', startBlockIndex: -1 }),
    ).rejects.toThrow(/non-negative integer/)

    await executeAppSkillRead(deps, 'slides:read_deck', {
      document: 'tab-3',
      slideIndex: 0,
      start: 0,
      end: 2,
    })
    expect(readSlides).toHaveBeenCalledWith(expect.anything(), { slideIndex: 0, start: 0, end: 2 })
    await expect(
      executeAppSkillRead(deps, 'slides:read_deck', { document: 'tab-3', start: -1 }),
    ).rejects.toThrow(/non-negative integer/)

    // default active html routes to editor tab-10 rather than active present tab-11,
    // while an explicit present tab-11 id still routes through to htmlReadText redirection
    const htmlRes = await executeAppSkillRead(deps, 'html:read_text', {})
    expect(htmlRes.target.id).toBe('tab-10')
    expect(htmlRes.result).toBe('<html><body>ok</body></html>')
    const explicitPresentRes = await executeAppSkillRead(deps, 'html:read_text', {
      document: 'tab-11',
    })
    expect(explicitPresentRes.target.id).toBe('tab-11')

    // short markdown stays verbatim when no pagination is needed
    const shortRes = await executeAppSkillRead(deps, 'markdown:read_text', { document: 'tab-9' })
    expect(shortRes.result).toBe(shortText)

    // oversized markdown slices at 24,000 chars and supports offset continuation to EOF
    const chunk1 = await executeAppSkillRead(deps, 'markdown:read_text', { document: 'tab-8' })
    expect(String(chunk1.result)).toContain('offset=24000')
    expect(String(chunk1.result)).not.toContain('_TAIL_998')

    const chunk2 = await executeAppSkillRead(deps, 'markdown:read_text', {
      document: 'tab-8',
      offset: 24_000,
    })
    expect(String(chunk2.result)).toContain('end of document')
    expect(String(chunk2.result)).toContain('_TAIL_998')

    await expect(
      executeAppSkillRead(deps, 'markdown:read_text', { document: 'tab-8', offset: 999_999 }),
    ).rejects.toThrow(/beyond the document length/)
  })

  it('exposes and routes media:read_media and media:analyze_media for open media tabs', async () => {
    const readMedia = vi.fn(async () => ({
      text: 'File: clip.mp4',
      images: [{ base64: 'AAA', mime: 'image/jpeg' }],
    }))
    const analyzeMedia = vi.fn(async () => ({ text: 'Spoken summary of clip.mp4' }))
    const windows: DesktopWindowInfo[] = [
      { id: 'tab-20', kind: 'media', title: 'clip.mp4', filePath: '/tmp/clip.mp4', active: true },
    ]
    const deps: AppSkillProxyDeps = {
      listWindows: () => windows,
      webContentsFor: (id) => (id === 'tab-20' ? contentsFor(20) : undefined),
      readers: { media: readMedia },
      toolReaders: { 'media:analyze_media': analyzeMedia },
    }

    const manifest = buildAppSkillManifest(windows, deps.readers, deps.toolReaders)
    expect(manifest.tools.map((t) => t.name)).toEqual(['media:read_media', 'media:analyze_media'])

    const snapshot = await executeAppSkillRead(deps, 'media:read_media', { timestampSec: 1.5 })
    expect(snapshot.target.id).toBe('tab-20')
    expect(readMedia).toHaveBeenCalledWith(expect.anything(), { timestampSec: 1.5 })

    await expect(
      executeAppSkillRead(deps, 'media:read_media', { timestampSec: -2 }),
    ).rejects.toThrow(/non-negative finite number/)

    const analyzed = await executeAppSkillRead(deps, 'media:analyze_media', {
      requirements: 'Transcribe and summarize',
    })
    expect(analyzed.result).toEqual({ text: 'Spoken summary of clip.mp4' })
    expect(analyzeMedia).toHaveBeenCalledWith(expect.anything(), {
      requirements: 'Transcribe and summarize',
    })

    await expect(
      executeAppSkillRead(deps, 'media:analyze_media', { requirements: '   ' }),
    ).rejects.toThrow(/non-empty string/)

    // Closing the media tab removes both tools from the manifest.
    const emptyManifest = buildAppSkillManifest([], deps.readers, deps.toolReaders)
    expect(emptyManifest.tools).toEqual([])
  })
})
