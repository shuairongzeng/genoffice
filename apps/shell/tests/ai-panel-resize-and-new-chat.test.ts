// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SurfaceTab } from '@genoffice/agent-core'
import type { ChatMessage, GlobalChatMeta, ProjectApi } from '@genoffice/project-store'
import { AiDock } from '../src/renderer/src/AiDock'
import { KbAskPanel } from '../src/renderer/src/KbAskPanel'
import { LocaleProvider } from '../src/renderer/src/locale'
import { computeResizedPanelBox, resolveOverlayResizeEdges } from '../src/renderer/src/panel-resize'
import { AI_DOCK_WIDTH_DEFAULT, AI_DOCK_WIDTH_PRESETS } from '../src/shared/desktop-geometry'
import type { AskRunEvent } from '../src/shared/home-api'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const docHash = (filePath: string): string => {
  let h = 2166136261
  for (let i = 0; i < filePath.length; i++) {
    h ^= filePath.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return `chat-${h.toString(16)}`
}

describe('panel-resize helpers', () => {
  it('picks correct inner/outer resize edges for every host posture', () => {
    expect(resolveOverlayResizeEdges({ embedded: false, side: 'left', activeTabKind: 'docs' })).toEqual([
      'left',
      'right',
    ])
    expect(resolveOverlayResizeEdges({ embedded: true, side: 'left', activeTabKind: 'browser' })).toEqual([
      'left',
    ])
    expect(resolveOverlayResizeEdges({ embedded: true, side: 'left', activeTabKind: 'docs' })).toEqual([
      'right',
    ])
    expect(resolveOverlayResizeEdges({ embedded: true, side: 'right', activeTabKind: 'docs' })).toEqual([
      'left',
    ])
  })

  it('computes bidirectional resize boxes respecting 320-760 bounds, 60%/360px reserve, and ui scale', () => {
    // Left-docked slot dragging right edge wider at 1x
    expect(
      computeResizedPanelBox({
        edge: 'right',
        clientX: 640,
        originPanel: { x: 40, y: 44, width: 400, height: 700 },
        windowWidth: 1400,
        scale: 1,
      }),
    ).toEqual({
      box: { x: 40, y: 44, width: 600, height: 700 },
      cssWidth: 600,
    })

    // Right-docked panel dragging left edge at 1.25x scale
    expect(
      computeResizedPanelBox({
        edge: 'left',
        clientX: 900,
        originPanel: { x: 1100, y: 44, width: 500, height: 700 },
        windowWidth: 1600,
        scale: 1.25,
      }),
    ).toEqual({
      box: { x: 900, y: 44, width: 700, height: 700 },
      cssWidth: 560,
    })

    // Clamps to 360px content room reserve on narrow 900px window (max = 540px)
    expect(
      computeResizedPanelBox({
        edge: 'left',
        clientX: 100,
        originPanel: { x: 500, y: 0, width: 400, height: 600 },
        windowWidth: 900,
        scale: 1,
      }),
    ).toEqual({
      box: { x: 360, y: 0, width: 540, height: 600 },
      cssWidth: 540,
    })
  })
})

describe('AiDock live resize pill & Escape cancel', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('shows live width pill during drag and cancels cleanly on Escape without committing', async () => {
    const onWidthCommit = vi.fn()
    act(() => {
      root.render(
        createElement(
          LocaleProvider,
          { initial: 'en' },
          createElement(
            AiDock,
            {
              collapsed: false,
              width: AI_DOCK_WIDTH_DEFAULT,
              petPos: null,
              docActive: false,
              onCollapse: vi.fn(),
              onExpand: vi.fn(),
              onWidthCommit,
              onPetPosCommit: vi.fn(),
            },
            createElement('div', null, 'inner'),
          ),
        ),
      )
    })

    const resizer = host.querySelector('.ai-drawer-resize') as HTMLElement
    act(() => {
      resizer.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 800 }))
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 650 }))
    })
    const pill = host.querySelector('.ai-resize-pill')
    expect(pill?.textContent).toBe('550 px')
    expect(onWidthCommit).not.toHaveBeenCalled()

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(host.querySelector('.ai-resize-pill')).toBeNull()
    expect(onWidthCommit).not.toHaveBeenCalled()
  })
})

describe('KbAskPanel header quick new chat & width presets', () => {
  let host: HTMLDivElement
  let root: Root
  let chats: Map<string, ChatMessage[]>
  let metaByChat: Map<string, { docPath?: string }>
  let setMetaCalls: Array<{ chatId: string; docPath?: string | null }>
  let emittedEvents: AskRunEvent[]
  let setAiDockMock: ReturnType<typeof vi.fn>
  const surfaceTabs: SurfaceTab[] = [
    { id: 'doc1', kind: 'docs', title: 'Spec.docx', active: true, filePath: 'C:/Spec.docx' },
  ]

  const flush = async (ticks = 6): Promise<void> => {
    for (let i = 0; i < ticks; i++) {
      await act(async () => {
        await Promise.resolve()
      })
    }
  }

  beforeAll(() => {
    if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {}
  })

  beforeEach(() => {
    chats = new Map()
    metaByChat = new Map()
    setMetaCalls = []
    emittedEvents = []
    setAiDockMock = vi.fn(async () => ({}))

    const projectApi = {
      resolveChat: vi.fn(async (args: { filePath: string | null; tempChatId?: string }) => {
        if (args.filePath !== null) {
          return { projectId: 'default', chatId: docHash(args.filePath) }
        }
        return { projectId: 'default', chatId: args.tempChatId ?? 'kb-ask' }
      }),
      loadChat: vi.fn(async (args: { chatId: string }) => [...(chats.get(args.chatId) ?? [])]),
      appendChat: vi.fn(async () => undefined),
      deleteChat: vi.fn(async () => undefined),
      setChatMeta: vi.fn(
        async (args: { chatId: string; docPath?: string | null }) => {
          setMetaCalls.push(args)
          metaByChat.set(args.chatId, { ...(args.docPath ? { docPath: args.docPath } : {}) })
          return null
        },
      ),
      listChats: vi.fn(async () => []),
      listAllChats: vi.fn(async () => [] as GlobalChatMeta[]),
    } as unknown as ProjectApi

    ;(window as unknown as { projectApi: ProjectApi }).projectApi = projectApi
    ;(window as unknown as { aiOfficeTabs: unknown }).aiOfficeTabs = {
      list: async () => surfaceTabs,
      onChanged: () => () => {},
    }
    ;(window as unknown as { aiOffice: unknown }).aiOffice = {
      skillsList: vi.fn(async () => []),
      skillText: vi.fn(async () => ''),
      aiGetSettings: async () => null,
      aiGskStatus: async () => ({ loggedIn: true }),
      onAiSettingsChanged: () => () => {},
      kbList: async () => [],
      getSurfaceTabs: async () => surfaceTabs,
      onAiStream: () => () => {},
      aiStream: () => {},
      aiStreamCancel: () => {},
      askRunSnapshot: async () => null,
      askRunEvent: (evt: AskRunEvent) => emittedEvents.push(evt),
      onAskRunEvent: () => () => {},
      setAiDock: setAiDockMock,
    }

    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    delete (window as unknown as { aiOffice?: unknown }).aiOffice
    delete (window as unknown as { projectApi?: unknown }).projectApi
    delete (window as unknown as { aiOfficeTabs?: unknown }).aiOfficeTabs
  })

  const renderPanel = (): void => {
    act(() => {
      root.render(
        createElement(
          LocaleProvider,
          { initial: 'en' },
          createElement(KbAskPanel, {
            onOpenPath: () => {},
            onGoToRecents: () => {},
            onOpenModelSettings: () => {},
            onOpenScopeSettings: () => {},
          }),
        ),
      )
    })
  }

  it('guards empty session quick new-chat by focusing composer instead of spawning empty child threads', async () => {
    renderPanel()
    await flush()

    const newBtn = host.querySelector('[data-testid="kb-ask-new-chat-btn"]') as HTMLButtonElement
    expect(newBtn).toBeTruthy()
    expect(newBtn.getAttribute('aria-label')).toBe('New chat for this document')

    await act(async () => {
      newBtn.click()
    })
    await flush()

    expect(setMetaCalls).toHaveLength(0)
    expect(document.activeElement).toBe(host.querySelector('textarea'))
  })

  it('creates scoped child thread from header quick new-chat when history exists, and applies width presets', async () => {
    const docId = docHash('C:/Spec.docx')
    chats.set(docId, [
      { seq: 0, ts: '2026-11-20T10:00:00.000Z', role: 'user', text: 'Existing question' },
    ])

    renderPanel()
    await flush()
    expect(host.textContent).toContain('Existing question')

    const newBtn = host.querySelector('[data-testid="kb-ask-new-chat-btn"]') as HTMLButtonElement
    await act(async () => {
      newBtn.click()
    })
    await flush()

    expect(
      setMetaCalls.some((c) => c.docPath === 'C:/Spec.docx' && c.chatId.startsWith(`${docId}-`)),
    ).toBe(true)
    expect(emittedEvents.some((e) => e.type === 'switch-session')).toBe(true)

    const menuBtn = host.querySelector('.kb-ask-menu-button') as HTMLButtonElement
    act(() => {
      menuBtn.click()
    })
    await flush()

    const presetButtons = Array.from(
      host.querySelectorAll('.kb-ask-width-preset-btn'),
    ) as HTMLButtonElement[]
    expect(presetButtons).toHaveLength(3)
    const wideBtn = presetButtons.find((b) =>
      b.textContent?.includes(String(AI_DOCK_WIDTH_PRESETS.wide)),
    )!
    await act(async () => {
      wideBtn.click()
    })
    expect(setAiDockMock).toHaveBeenCalledWith({ width: AI_DOCK_WIDTH_PRESETS.wide })
  })
})
