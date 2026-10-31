import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Editor } from '@tiptap/core'
import { buildExtensions } from '../src/renderer/editor/extensions'
import { AiPanel, type MarkdownAiDeps } from '../src/renderer/ai/AiPanel'
import type { MarkdownApi } from '../src/shared/ipc'

// The knowledge base reaches the model only through the send path: the panel
// composes the shared kb skill when its bridge carries the kb channel, and the
// corpus snapshot (refreshed on mount and before each send) rides the request
// as the skill's context. Driven through the mounted composer, in the style of
// ai-panel-skill-vars.test.ts: type the request, Enter sends, and the request
// the transport receives must carry the corpus — and must NOT grow a knowledge
// base at all when the bridge has no kb channel (an older preload).

const roots: Root[] = []
// Undestroyed views leave DOMObserver flush timers that fire after jsdom
// teardown ("document is not defined" unhandled error) — destroy every editor.
const editors: Editor[] = []

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Element.prototype.scrollTo ??= () => {}
})

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  for (const editor of editors.splice(0)) editor.destroy()
  document.body.innerHTML = ''
  delete (window as unknown as { markdownApi?: MarkdownApi }).markdownApi
})

function createEditor(): Editor {
  const editor = new Editor({
    extensions: buildExtensions({
      slashController: {
        onOpen: () => {},
        onUpdate: () => {},
        onKeyDown: () => false,
        onClose: () => {},
      },
      slashItems: () => [],
    }),
    content: '',
  })
  editors.push(editor)
  return editor
}

type StreamRequest = { requestId: string; messages: Array<{ role: string; text: string }> }

/** the panel's own IPC surface, minus everything a mounted send needs; the
 *  stream fake answers with one delta and a done chunk so the run settles.
 *  `kbFiles` null leaves the kb channel off the bridge entirely. */
function installApi(kbFiles: Array<Record<string, unknown>> | null): { streams: StreamRequest[] } {
  const streams: StreamRequest[] = []
  let chunkListener: ((chunk: { requestId: string; type: string; text?: string }) => void) | null =
    null
  const api: Record<string, unknown> = {
    aiGskStatus: async () => ({ loggedIn: false }),
    getAiSettings: async () => ({
      provider: 'openai',
      providers: { openai: { apiKey: 'k', model: 'gpt' } },
    }),
    setAiSettings: async () => {},
    onAiSettingsChanged: () => () => {},
    openAiModelSettings: async () => {},
    skillsList: async () => [],
    skillText: async () => '',
    setAiPanelPrefs: async (prefs: unknown) => prefs,
    openSourcePath: async () => {},
    aiStream: async (request: StreamRequest) => {
      streams.push(request)
      setTimeout(() => {
        chunkListener?.({ requestId: request.requestId, type: 'delta', text: 'Done.' })
        chunkListener?.({ requestId: request.requestId, type: 'done' })
      }, 0)
    },
    aiStreamCancel: async () => {},
    onAiStream: (handler: (chunk: { requestId: string; type: string; text?: string }) => void) => {
      chunkListener = handler
      return () => {
        chunkListener = null
      }
    },
  }
  if (kbFiles !== null) {
    // the first kbList answers empty (the mount-time snapshot); only the
    // pre-send re-fetch can then carry the corpus onto the wire — this pins
    // the freshness mechanism, not just corpus presence
    let mountSnapshotTaken = false
    api.kbList = async () => {
      if (!mountSnapshotTaken) {
        mountSnapshotTaken = true
        return []
      }
      return kbFiles
    }
    api.kbSearch = async () => []
    api.kbRead = async () => ({ text: '', totalChars: 0, offset: 0 })
  }
  ;(window as unknown as { markdownApi: MarkdownApi }).markdownApi = api as unknown as MarkdownApi
  return { streams }
}

function mountPanel(editor: Editor): HTMLDivElement {
  const deps: MarkdownAiDeps = {
    getEditor: () => editor,
    getFrontmatter: () => '',
    setFrontmatter: () => {},
    getSnapshot: () => ({ body: '', frontmatter: '' }),
    restoreSnapshot: () => {},
    onRunDone: () => {},
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(createElement(AiPanel, { deps, filePath: 'a.md', onCollapse: () => {} }))
  })
  return container
}

function typeInto(textarea: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** pump timers until the condition holds (the send pipeline is promise-driven) */
async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 60 && !cond(); i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
}

async function send(container: HTMLDivElement, request: string): Promise<void> {
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
  typeInto(textarea, request)
  act(() => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

const KB_FILE = {
  path: '/Users/me/kb/lease.docx',
  folder: 'kb',
  name: 'lease.docx',
  ext: 'docx',
  sizeBytes: 2048,
}

describe('the knowledge base reaches the markdown agent loop', () => {
  it('rides the request as the kb skill when the bridge answers kbList', async () => {
    const { streams } = installApi([KB_FILE])
    const container = mountPanel(createEditor())
    await send(container, 'what does the lease say about pets?')
    await waitFor(() => streams.length > 0)
    const wire = JSON.stringify(streams[0])
    expect(wire).toContain('Knowledge base')
    expect(wire).toContain('lease.docx')
    expect(wire).toContain('/Users/me/kb/lease.docx')
    expect(wire).toContain('search_knowledge_base')
  })

  it('adds nothing when the bridge has no kb channel', async () => {
    const { streams } = installApi(null)
    const container = mountPanel(createEditor())
    await send(container, 'summarize the document')
    await waitFor(() => streams.length > 0)
    const wire = JSON.stringify(streams[0])
    expect(wire).not.toContain('Knowledge base')
    expect(wire).not.toContain('search_knowledge_base')
  })
})
