import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Observer fan-out from home-tabs-ipc lifecycle wrappers: verifies that even
 * before `liveAskRunHub` is initialized (null), registered observers receive
 * run begin, event, confirm, and finish notifications in exact order.
 */

const ipcMock = vi.hoisted(() => ({
  handle: vi.fn(),
  on: vi.fn(),
  buildFromTemplate: vi.fn((template: unknown) => ({ template, popup: vi.fn() })),
  fromWebContents: vi.fn(() => null),
  getFocusedWindow: vi.fn(() => null),
  getAllWebContents: vi.fn(() => []),
}))

vi.mock('electron', () => ({
  ipcMain: { handle: ipcMock.handle, on: ipcMock.on },
  BrowserWindow: {
    fromWebContents: ipcMock.fromWebContents,
    getFocusedWindow: ipcMock.getFocusedWindow,
  },
  Menu: { buildFromTemplate: ipcMock.buildFromTemplate },
  webContents: { getAllWebContents: ipcMock.getAllWebContents },
}))

import type { AskRunEvent } from '../src/shared/home-api'
import type { PiAgentConfirmRequest } from '../src/shared/pi-agent-api'
import type { PiRunStartInput } from '../src/main/ask-run-hub'
import { addAskRunObserver } from '../src/main/ask-run-observer'
import {
  beginPiRunInMain,
  broadcastAskRunEventFromMain,
  finishPiRunInMain,
  getLiveAskRunHub,
  setPiConfirmInMain,
} from '../src/main/home-tabs-ipc'

const disposers: Array<() => void> = []

afterEach(() => {
  while (disposers.length > 0) {
    disposers.pop()?.()
  }
})

describe('home-tabs-ipc ask-run-observer notifications', () => {
  it('delivers begin, event, confirm, and finish notifications in order even when liveAskRunHub is null', () => {
    expect(getLiveAskRunHub()).toBeNull()

    const received: Array<
      | { kind: 'begin'; input: PiRunStartInput }
      | { kind: 'event'; event: AskRunEvent }
      | { kind: 'confirm'; sessionKey: string; req: PiAgentConfirmRequest | null }
      | { kind: 'finish'; sessionKey: string }
    > = []

    disposers.push(
      addAskRunObserver({
        onBegin: (input) => received.push({ kind: 'begin', input }),
        onEvent: (event) => received.push({ kind: 'event', event }),
        onConfirm: (sessionKey, req) => received.push({ kind: 'confirm', sessionKey, req }),
        onFinish: (sessionKey) => received.push({ kind: 'finish', sessionKey }),
      }),
    )

    const sessionKey = 'proj-1:chat-1'
    const runInput: PiRunStartInput = {
      sessionKey,
      projectId: 'proj-1',
      chatId: 'chat-1',
      docPath: null,
      userText: 'Summarize quarterly report',
    }
    const runEvent: AskRunEvent = {
      type: 'text',
      sessionKey,
      payload: 'Working on it...',
    }
    const confirmReq: PiAgentConfirmRequest = {
      requestId: 'req-1',
      sessionKey,
      call: {
        id: 'call-1',
        name: 'write_file',
        arguments: { path: '/tmp/out.md' },
      },
      argsSummary: '/tmp/out.md',
      sessionAllowable: true,
    }

    beginPiRunInMain(runInput)
    broadcastAskRunEventFromMain(runEvent)
    setPiConfirmInMain(sessionKey, confirmReq)
    setPiConfirmInMain(sessionKey, null)
    finishPiRunInMain(sessionKey)

    expect(received).toEqual([
      { kind: 'begin', input: runInput },
      { kind: 'event', event: runEvent },
      { kind: 'confirm', sessionKey, req: confirmReq },
      { kind: 'confirm', sessionKey, req: null },
      { kind: 'finish', sessionKey },
    ])
  })
})
