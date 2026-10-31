/**
 * The knowledge base reaches the model only through the send path: the panel
 * composes the shared kb skill when its bridge carries the kb channel, and the
 * corpus snapshot (refreshed on mount and before each send) rides the request
 * as the skill's context. Driven through the mounted composer, in the style of
 * ai-skill-vars.test.ts: type the request, Enter sends, and the request the
 * transport forwards must carry the corpus — and must NOT grow a knowledge
 * base at all when the bridge has no kb channel (an older preload).
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { AiPanel } from '../src/renderer/ai/AiPanel'
import type { PdfAppDeps } from '../src/renderer/ai/tools'
import type { AgentMessage } from '@genoffice/agent-core'

type StreamRequest = { requestId: string; messages: AgentMessage[] }
type StreamListener = (chunk: { requestId: string; type: 'done' }) => void

const streamListeners = new Set<StreamListener>()
let startedRequestId = ''

const aiStream = vi.fn((request: StreamRequest) => {
  startedRequestId = request.requestId
  return Promise.resolve()
})

/** the panel's own IPC surface; `kb` null leaves the kb channel off the bridge */
function installPdfApi(kb: Array<Record<string, unknown>> | null): void {
  const api: Record<string, unknown> = {
    getAiSettings: () =>
      Promise.resolve({ customEndpoints: [{ baseUrl: 'http://x', model: 'm' }] }),
    setAiSettings: () => Promise.resolve(),
    onAiSettingsChanged: () => () => {},
    openAiModelSettings: () => Promise.resolve(),
    openSkillsSettings: () => Promise.resolve(),
    skillsList: () => Promise.resolve([]),
    skillText: () => Promise.resolve(''),
    gskStatus: () => Promise.resolve({ loggedIn: false }),
    aiStream,
    aiStreamCancel: () => Promise.resolve(),
    onAiStream: (handler: StreamListener) => {
      streamListeners.add(handler)
      return () => streamListeners.delete(handler)
    },
    setAiPanelPrefs: () => Promise.resolve(),
    listPageImages: () => Promise.resolve([]),
    pageImageBytes: () => Promise.resolve(null),
    openSourcePath: () => Promise.resolve(),
  }
  if (kb !== null) {
    // the first kbList answers empty (the mount-time snapshot); only the
    // pre-send re-fetch can then carry the corpus onto the wire — this pins
    // the freshness mechanism, not just corpus presence
    let mountSnapshotTaken = false
    api.kbList = async () => {
      if (!mountSnapshotTaken) {
        mountSnapshotTaken = true
        return []
      }
      return kb
    }
    api.kbSearch = async () => []
    api.kbRead = async () => ({ text: '', totalChars: 0, offset: 0 })
  }
  Object.defineProperty(window, 'pdfApi', { value: api, configurable: true })
}

const projectApi = {
  resolveChat: () => Promise.resolve({ projectId: 'p', chatId: 'c' }),
  appendChat: () => Promise.resolve(),
  loadChat: () => Promise.resolve([]),
  rebindChat: () => Promise.resolve(null),
}

const makeApi = (): PdfAppDeps =>
  ({
    doc: () => null,
    fileName: () => 'Q3 report.pdf',
    pageCount: () => 1,
    currentPage: () => 1,
    readOnly: () => false,
    ocrText: () => null,
    selection: () => null,
    pendingSummary: () => '',
    outline: () => null,
    searchIndex: () => null,
    isDeleted: () => false,
    gotoPage: () => true,
    addMarkup: () => {},
    annotationsOn: () => Promise.resolve({ threads: [], markups: [] }),
    annotationSummary: () => '',
    metadata: () => ({}),
    addNote: () => Promise.resolve(null),
    deletePages: () => Promise.resolve({ ok: true, pageCount: 1 }),
    rotatePages: () => Promise.resolve({ ok: true, pageCount: 1 }),
    setPageSize: () => Promise.resolve({ ok: true, pageCount: 1 }),
    cropPages: () => Promise.resolve({ ok: true, pageCount: 1 }),
    replacePages: () => Promise.resolve({ ok: true, pageCount: 1 }),
    extractPages: () => Promise.resolve({ ok: true, savedPath: '' }),
    splitPdf: () => Promise.resolve({ ok: true, savedDir: '', count: 0 }),
    splitPages: () => Promise.resolve({ ok: true, savedPath: '' }),
    mergePages: () => Promise.resolve({ ok: true, savedPath: '' }),
  }) as unknown as PdfAppDeps

let root: Root | null = null
let container: HTMLDivElement | null = null

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(window, 'projectApi', { value: projectApi, configurable: true })
  Element.prototype.scrollTo = () => {}
  // jsdom's crypto may lack randomUUID (the IPC transport mints stream ids)
  const cryptoObj = globalThis.crypto as Crypto & { randomUUID?: () => string }
  if (typeof cryptoObj.randomUUID !== 'function') {
    Object.defineProperty(cryptoObj, 'randomUUID', {
      value: () => `test-${Math.random().toString(36).slice(2)}`,
      configurable: true,
    })
  }
})

beforeEach(() => {
  aiStream.mockClear()
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = null
  container = null
  aiStream.mockClear()
  delete (window as unknown as { pdfApi?: unknown }).pdfApi
})

const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

async function renderPanel(): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      createElement(AiPanel, {
        api: makeApi(),
        filePath: 'sample.pdf',
        onCollapse: () => {},
        preset: null,
      }),
    )
    await flush()
  })
  return container
}

const textarea = (): HTMLTextAreaElement =>
  container!.querySelector<HTMLTextAreaElement>('.ai-input-box textarea')!

/** replace the draft the way typing does (native setter + input event) */
const type = (text: string): void => {
  act(() => {
    const ta = textarea()
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(ta, text)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const press = (key: string): void => {
  act(() =>
    textarea().dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    ),
  )
}

/** settle the started run so the transport's silence watchdog timer clears */
const finishRun = async (): Promise<void> => {
  await act(async () => {
    for (const listener of [...streamListeners])
      listener({ requestId: startedRequestId, type: 'done' })
    await flush()
  })
}

const KB_FILE = {
  path: '/Users/me/kb/lease.docx',
  folder: 'kb',
  name: 'lease.docx',
  ext: 'docx',
  sizeBytes: 2048,
}

describe('the knowledge base reaches the pdf agent loop', () => {
  it('rides the request as the kb skill when the bridge answers kbList', async () => {
    installPdfApi([KB_FILE])
    await renderPanel()
    type('what does the lease say about pets?')
    press('Enter')
    await act(async () => {
      await flush()
    })
    await finishRun()
    expect(aiStream).toHaveBeenCalled()
    const wire = JSON.stringify(aiStream.mock.calls[0]![0])
    expect(wire).toContain('Knowledge base')
    expect(wire).toContain('lease.docx')
    expect(wire).toContain('/Users/me/kb/lease.docx')
    expect(wire).toContain('search_knowledge_base')
  })

  it('adds nothing when the bridge has no kb channel', async () => {
    installPdfApi(null)
    await renderPanel()
    type('summarize the document')
    press('Enter')
    await act(async () => {
      await flush()
    })
    await finishRun()
    expect(aiStream).toHaveBeenCalled()
    const wire = JSON.stringify(aiStream.mock.calls[0]![0])
    expect(wire).not.toContain('Knowledge base')
    expect(wire).not.toContain('search_knowledge_base')
  })
})
