import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AiPanel, type HtmlAiDeps } from '../src/renderer/ai/AiPanel'
import { buildParseMap } from '../src/renderer/document/parse-map'
import type { HtmlApi } from '../src/shared/ipc'

// The knowledge base reaches the model only through the send path: the panel
// composes the shared kb skill when its bridge carries the kb channel, and the
// corpus snapshot (refreshed on mount and before each send) rides the request
// as the skill's context. Driven through the mounted composer, in the style of
// ai-panel-skill-vars.test.ts: type the request, Enter sends, and the request
// the transport receives must carry the corpus — and must NOT grow a knowledge
// base at all when the bridge has no kb channel (an older preload).

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // jsdom implements neither scrolling nor animation frames
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {}
  if (!window.requestAnimationFrame) {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(cb, 0))
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  delete (window as unknown as { htmlApi?: HtmlApi }).htmlApi
})

const PAGE = '<main><p>Call now</p></main>'

type StreamedRequest = { requestId: string; messages: Array<{ role: string; text: string }> }

/** the panel's own IPC surface, minus everything a mounted send needs; `kb`
 *  null leaves the kb channel off the bridge entirely (an older preload). */
function installApi(kb: Array<Record<string, unknown>> | null): { requests: StreamedRequest[] } {
  const requests: StreamedRequest[] = []
  const api: Record<string, unknown> = {
    getAiSettings: () => Promise.resolve({}),
    setAiSettings: () => Promise.resolve(),
    onAiSettingsChanged: () => () => {},
    aiGskStatus: () => Promise.resolve({ loggedIn: true }),
    openAiModelSettings: () => Promise.resolve(),
    openSkillsSettings: () => Promise.resolve(),
    skillsList: () => Promise.resolve([]),
    skillText: () => Promise.resolve(''),
    setAiPanelPrefs: () => Promise.resolve(),
    onAiPanelPrefsChanged: () => () => {},
    getPathForFile: () => null,
    readAttachmentImage: () => Promise.resolve({ ok: false, error: 'stub' }),
    aiStream: (request: StreamedRequest) => {
      requests.push(request)
      return Promise.resolve()
    },
    aiStreamCancel: () => {},
    onAiStream: () => () => {},
  }
  if (kb !== null) {
    // the first kbList answers empty (the mount-time snapshot); only the
    // pre-send re-fetch can then carry the corpus onto the wire — this pins
    // the freshness mechanism, not just corpus presence
    let mountSnapshotTaken = false
    api.kbList = () => {
      if (!mountSnapshotTaken) {
        mountSnapshotTaken = true
        return Promise.resolve([])
      }
      return Promise.resolve(kb)
    }
    api.kbSearch = () => Promise.resolve([])
    api.kbRead = () => Promise.resolve({ text: '', totalChars: 0, offset: 0 })
  }
  ;(window as unknown as { htmlApi: HtmlApi }).htmlApi = api as unknown as HtmlApi
  return { requests }
}

function makeDeps(): HtmlAiDeps {
  return {
    access: {
      getText: () => PAGE,
      getVersion: () => 1,
      getMap: () => buildParseMap(PAGE, 1, null),
      getLastManualVersion: () => 1,
      getFilePath: () => null,
      getSelectedSid: () => null,
      applyOps: () => ({ ok: true, ranges: [] }),
      replaceAll: () => {},
    },
    getSnapshot: () => ({ text: PAGE }),
    restoreSnapshot: () => {},
    onPrompt: () => {},
    onRunDone: () => {},
    clearHighlights: () => {},
    navigateTo: () => {},
    onBriefConfirmed: () => {},
    previewDraft: () => {},
  }
}

function mountPanel(): HTMLElement {
  const dock = document.createElement('div')
  dock.className = 'ai-dock'
  document.body.appendChild(dock)
  const root: Root = createRoot(dock)
  act(() =>
    root.render(
      createElement(AiPanel, {
        deps: makeDeps(),
        filePath: null,
        preset: null,
        editQueue: [],
        onQueueEditInstruction: () => {},
        onQueueRemove: () => {},
        onQueueClear: () => {},
        onQueueFocus: () => {},
        onQueueConsume: () => {},
        onCollapse: () => {},
      }),
    ),
  )
  return dock
}

/** flush the settings / skill-body promises and any pending render */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function type(dock: HTMLElement, text: string): void {
  const ta = dock.querySelector('textarea')!
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(ta, text)
    ta.setSelectionRange(text.length, text.length)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function press(dock: HTMLElement, key: string): void {
  act(() =>
    dock
      .querySelector('textarea')!
      .dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })),
  )
}

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 60 && !cond(); i++) await settle()
}

const KB_FILE = {
  path: '/Users/me/kb/lease.docx',
  folder: 'kb',
  name: 'lease.docx',
  ext: 'docx',
  sizeBytes: 2048,
}

describe('the knowledge base reaches the html agent loop', () => {
  it('rides the request as the kb skill when the bridge answers kbList', async () => {
    const { requests } = installApi([KB_FILE])
    const dock = mountPanel()
    type(dock, 'what does the lease say about pets?')
    press(dock, 'Enter')
    await waitFor(() => requests.length > 0)
    const wire = JSON.stringify(requests[0])
    expect(wire).toContain('Knowledge base')
    expect(wire).toContain('lease.docx')
    expect(wire).toContain('/Users/me/kb/lease.docx')
    expect(wire).toContain('search_knowledge_base')
  })

  it('adds nothing when the bridge has no kb channel', async () => {
    const { requests } = installApi(null)
    const dock = mountPanel()
    type(dock, 'summarize the page')
    press(dock, 'Enter')
    await waitFor(() => requests.length > 0)
    const wire = JSON.stringify(requests[0])
    expect(wire).not.toContain('Knowledge base')
    expect(wire).not.toContain('search_knowledge_base')
  })
})
