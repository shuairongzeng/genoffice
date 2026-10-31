import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RenderSlide } from '@genoffice/pptx-render'

// The knowledge base reaches the model only through the send path: the panel
// composes the shared kb skill when its bridge carries the kb channel, and the
// corpus snapshot (refreshed on mount and before each send) rides the request
// as the skill's context. The real AgentLoop runs against a stubbed
// window.slidesApi stream, in the style of ai-confirm-gate.test.ts (the panel
// drives the run through its preset auto-send) — and must NOT grow a
// knowledge base at all when the bridge has no kb channel (an older preload).

// react-konva's node entry requires the native 'canvas' package; these tests do not draw.
vi.mock('react-konva', () => {
  const stub = () => null
  return {
    Stage: stub,
    Layer: stub,
    Rect: stub,
    Group: stub,
    Transformer: stub,
    Line: stub,
    Arrow: stub,
    Text: stub,
    Ellipse: stub,
    Image: stub,
    Path: stub,
    Circle: stub,
    Arc: stub,
  }
})

import { AiPanel } from '../src/renderer/ai/AiPanel'
import { AI_PROVIDERS, type AiSettings } from '../src/shared/ipc'

const settings: AiSettings = {
  provider: 'anthropic',
  providers: Object.fromEntries(
    AI_PROVIDERS.map((provider) => [provider.id, { apiKey: '', model: provider.defaultModel }]),
  ) as AiSettings['providers'],
}

/** one minimal deck page: a single text element */
const slide = {
  nodes: [
    {
      type: 'text',
      durableId: 't1',
      sourceId: 't1',
      fill: { kind: 'none' },
      text: {
        lines: [
          {
            runs: [{ text: 'original body', color: '#000000', fontSizePx: 18, isBullet: false }],
          },
        ],
      },
      box: { x: 40, y: 40, w: 320, h: 40, rotationDeg: 0 },
    },
  ],
  widthPx: 960,
  heightPx: 540,
} as unknown as RenderSlide

type Message = { role: string; text?: string }
const requests: Array<{ requestId: string; messages: Message[] }> = []

/** the panel's own IPC surface; `kb` null leaves the kb channel off the bridge */
function installSlidesApi(kb: Array<Record<string, unknown>> | null): void {
  const api: Record<string, unknown> = {
    aiGskStatus: vi.fn(async () => ({ loggedIn: true })),
    beginHistoryBatch: vi.fn(async () => false),
    endHistoryBatch: vi.fn(async () => null),
    aiLogRunFailure: vi.fn(async () => undefined),
    applyEditScript: vi.fn(async () => ({ slide })),
    readDeckImage: vi.fn(async () => null),
    onAiStream: () => () => {},
    aiStream: (request: { requestId: string; messages: Message[] }) => {
      requests.push(request)
      return Promise.resolve()
    },
    aiStreamCancel: vi.fn(),
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
  Object.defineProperty(window, 'slidesApi', { configurable: true, value: api })
}

const mountedRoots: Array<{ root: Root; container: HTMLElement }> = []
let nonce = 0

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  Element.prototype.scrollTo ??= () => {}
})

beforeEach(() => {
  requests.length = 0
})

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
  delete (window as unknown as { slidesApi?: unknown }).slidesApi
})

function mountPanel(): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() =>
    root.render(
      createElement(AiPanel, {
        slides: [slide],
        current: 0,
        selectedIds: [],
        images: new Map<string, HTMLImageElement>(),
        applySlide: vi.fn(),
        applyDeck: () => {},
        fitWidthPx: 960,
        settings,
        open: true,
        onExpand: () => {},
        onCollapse: () => {},
        preset: { text: `what does the lease say ${nonce}`, nonce: ++nonce, autoRun: true },
      }),
    ),
  )
  mountedRoots.push({ root, container })
  return container
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
    })
  }
}

const KB_FILE = {
  path: '/Users/me/kb/lease.docx',
  folder: 'kb',
  name: 'lease.docx',
  ext: 'docx',
  sizeBytes: 2048,
}

describe('the knowledge base reaches the slides agent loop', () => {
  it('rides the request as the kb skill when the bridge answers kbList', async () => {
    installSlidesApi([KB_FILE])
    mountPanel()
    await flush()
    expect(requests.length).toBeGreaterThan(0)
    const wire = JSON.stringify(requests[0])
    expect(wire).toContain('Knowledge base')
    expect(wire).toContain('lease.docx')
    expect(wire).toContain('/Users/me/kb/lease.docx')
    expect(wire).toContain('search_knowledge_base')
  })

  it('adds nothing when the bridge has no kb channel', async () => {
    installSlidesApi(null)
    mountPanel()
    await flush()
    expect(requests.length).toBeGreaterThan(0)
    const wire = JSON.stringify(requests[0])
    expect(wire).not.toContain('Knowledge base')
    expect(wire).not.toContain('search_knowledge_base')
  })
})
