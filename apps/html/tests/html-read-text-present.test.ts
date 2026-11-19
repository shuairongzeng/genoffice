import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * HTML Present view readText routing tests: verifies htmlReadText redirects a
 * chrome-free Present view to its owner editor WebContents and fails fast when
 * the owner editor has been destroyed.
 */

interface FakeWc {
  id: number
  isDestroyed: () => boolean
  send: ReturnType<typeof vi.fn>
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  once: (event: string, cb: () => void) => void
  destroy: () => void
}

const { liveWcs, ipcOnHandlers, ipcHandleHandlers } = vi.hoisted(() => ({
  liveWcs: new Map<number, FakeWc>(),
  ipcOnHandlers: new Map<string, (event: { sender: FakeWc }, payload?: unknown) => void>(),
  ipcHandleHandlers: new Map<string, (event: { sender: FakeWc }, ...args: unknown[]) => unknown>(),
}))

function makeWc(id: number): FakeWc {
  const emitter = new EventEmitter()
  let destroyed = false
  const wc: FakeWc = {
    id,
    isDestroyed: () => destroyed,
    send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    once: (event, cb) => {
      emitter.once(event, cb)
    },
    destroy: () => {
      destroyed = true
      liveWcs.delete(id)
      emitter.emit('destroyed')
    },
  }
  liveWcs.set(id, wc)
  return wc
}

let nextViewId = 500

vi.mock('electron', () => ({
  app: { getLocale: () => 'en-US', getPath: () => '', isPackaged: false, whenReady: async () => {} },
  BrowserWindow: class {},
  WebContentsView: class {
    webContents: FakeWc
    constructor() {
      const wc = makeWc(++nextViewId)
      ;(wc as unknown as { loadURL: () => Promise<void> }).loadURL = async () => {}
      this.webContents = wc
    }
  },
  dialog: {},
  ipcMain: {
    on: (ch: string, cb: (event: { sender: FakeWc }, payload?: unknown) => void) => {
      ipcOnHandlers.set(ch, cb)
    },
    handle: (ch: string, cb: (event: { sender: FakeWc }, ...args: unknown[]) => unknown) => {
      ipcHandleHandlers.set(ch, cb)
    },
    removeHandler: (ch: string) => {
      ipcHandleHandlers.delete(ch)
    },
  },
  net: {},
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  shell: {},
  webContents: {
    fromId: (id: number) => liveWcs.get(id),
  },
}))

vi.mock('@genoffice/electron-utils', () => ({
  configuredDefaultSaveDir: () => '',
  contextMenuLabels: () => ({}),
  fetchRemoteImage: vi.fn(),
  installContextMenu: vi.fn(),
  installNavigationGuard: vi.fn(),
  isHeadlessMode: () => true,
  safeExternalUrl: (u: string) => u,
  showOpenDialogWithMemory: vi.fn(),
  showSaveDialogWithMemory: vi.fn(),
  installRendererProtocol: vi.fn(),
  rendererUrl: () => 'app://html/index.html',
  MAX_REMOTE_IMAGE_BYTES: 1024 * 1024,
  readBodyCapped: vi.fn(),
  printHtmlDocument: vi.fn(),
}))

import { HTML_CHANNELS } from '../src/shared/ipc'
import { createHtmlPresentView, htmlReadText } from '../src/main/html-main'

beforeEach(() => {
  liveWcs.clear()
})

describe('htmlReadText present-view redirection', () => {
  it('redirects htmlReadText from a Present view to its owner editor window', async () => {
    const owner = makeWc(10)
    const presentView = createHtmlPresentView(owner as unknown as Electron.WebContents, 'Preview')
    const presentWc = presentView.webContents as unknown as Electron.WebContents

    owner.send.mockImplementation((channel: string) => {
      if (channel === HTML_CHANNELS.readTextRequest) {
        queueMicrotask(() => {
          ipcOnHandlers.get(HTML_CHANNELS.readTextResult)?.(
            { sender: owner },
            { text: '<html><body>LIVE_HTML_PRESENT_303</body></html>' },
          )
        })
      }
    })

    const text = await htmlReadText(presentWc)
    expect(text).toBe('<html><body>LIVE_HTML_PRESENT_303</body></html>')
    expect(owner.send).toHaveBeenCalledWith(HTML_CHANNELS.readTextRequest)
    expect(presentView.webContents.send).not.toHaveBeenCalledWith(HTML_CHANNELS.readTextRequest)
  })

  it('rejects cleanly when the owner editor of a Present view is destroyed', async () => {
    const owner = makeWc(20)
    const presentView = createHtmlPresentView(owner as unknown as Electron.WebContents, 'Preview')
    const presentWc = presentView.webContents as unknown as Electron.WebContents
    owner.destroy()

    await expect(htmlReadText(presentWc)).rejects.toThrow(/no longer open/)
  })
})
