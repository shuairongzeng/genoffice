import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The main half of the in-renderer autosave-recovery question
 * (src/main/autosave-recovery.ts): the ask pushes into the opening tab's
 * renderer and awaits its card's answer; only the tab asked may answer; a
 * renderer destroyed mid-ask (or one that never answers) settles without an
 * answer so the open fails instead of hanging. The docs-main integration
 * (hosted → renderer card, standalone → native dialog) is pinned by source
 * assertions — the repo's convention for the Electron main module, which no
 * unit test can import.
 */

const answerListeners = new Map<string, Array<(event: unknown, raw: unknown) => void>>()
/** destroyed-once captures, by webContents id */
const destroyedOnce = new Map<number, () => void>()

interface FakeWc {
  id: number
  send: ReturnType<typeof vi.fn>
  isDestroyed: () => boolean
}

const wcs = new Map<number, FakeWc>()

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, listener: (event: unknown, raw: unknown) => void) => {
      const list = answerListeners.get(channel) ?? []
      list.push(listener)
      answerListeners.set(channel, list)
    },
    handle: () => {},
  },
}))

import {
  RECOVERY_ANSWER_CHANNEL,
  RECOVERY_ASK_CHANNEL,
  RECOVERY_ASK_TIMEOUT_MS,
  askRendererRecovery,
  installAutosaveRecoveryIpc,
} from '../src/main/autosave-recovery'

installAutosaveRecoveryIpc()

function makeWc(id: number): FakeWc {
  const wc: FakeWc = { id, send: vi.fn(), isDestroyed: () => false }
  ;(wc as FakeWc & { once: unknown }).once = (channel: string, listener: () => void) => {
    if (channel === 'destroyed') destroyedOnce.set(id, listener)
  }
  ;(wc as FakeWc & { removeListener: unknown }).removeListener = () => {}
  wcs.set(id, wc)
  return wc
}

/** the ipcMain event shape: the sender IS the webContents (identity matters) */
const eventOf = (wc: FakeWc): { sender: FakeWc } => ({ sender: wc })

const fireAnswer = (wc: FakeWc, raw: unknown): void => {
  for (const listener of answerListeners.get(RECOVERY_ANSWER_CHANNEL) ?? []) {
    listener(eventOf(wc), raw)
  }
}

const ASK = {
  title: '发现自动恢复版本',
  body: '上次会话有未保存的更改。要恢复自动保存的版本吗?',
  diskNewerLine: '注意：此恢复副本保存后…',
  restoreLabel: '恢复',
  discardLabel: '放弃',
}

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  // the module installs its answer listener once for the whole file (its own
  // guard), so the per-test reset only refreshes the fakes; every test settles
  // its own asks
  destroyedOnce.clear()
  wcs.clear()
})

describe('askRendererRecovery', () => {
  it("pushes the ask with its strings and resolves the card's answers", async () => {
    const wc = makeWc(10)
    const restore = askRendererRecovery(wc as never, ASK)
    await flush()
    // the ask carries the localized copy main computed — one source of truth
    expect(wc.send).toHaveBeenCalledWith(RECOVERY_ASK_CHANNEL, {
      requestId: expect.any(String),
      ...ASK,
    })
    fireAnswer(wc, {
      requestId: (wc.send.mock.calls[0]![1] as { requestId: string }).requestId,
      restore: true,
    })
    await expect(restore).resolves.toEqual({ answered: true, restore: true })
    // discard answers identically
    const discard = askRendererRecovery(wc as never, ASK)
    await flush()
    fireAnswer(wc, {
      requestId: (wc.send.mock.calls[1]![1] as { requestId: string }).requestId,
      restore: false,
    })
    await expect(discard).resolves.toEqual({ answered: true, restore: false })
  })

  it('an answer from another renderer is ignored — only the asked tab may answer', async () => {
    const wc = makeWc(11)
    const other = makeWc(12)
    const pending = askRendererRecovery(wc as never, ASK)
    await flush()
    const requestId = (wc.send.mock.calls[0]![1] as { requestId: string }).requestId
    fireAnswer(other, { requestId, restore: true })
    // a non-boolean restore is not a restore either
    fireAnswer(wc, { requestId, restore: 'true' })
    // still pending: only the asked tab's boolean answer settles it
    fireAnswer(wc, { requestId, restore: true })
    await expect(pending).resolves.toEqual({ answered: true, restore: true })
  })

  it('a late answer after the question settled is dropped', async () => {
    const wc = makeWc(13)
    const first = askRendererRecovery(wc as never, ASK)
    await flush()
    const requestId = (wc.send.mock.calls[0]![1] as { requestId: string }).requestId
    fireAnswer(wc, { requestId, restore: false })
    await expect(first).resolves.toEqual({ answered: true, restore: false })
    // the card answering twice (or after a re-ask) must not resurrect anything
    expect(() => fireAnswer(wc, { requestId, restore: true })).not.toThrow()
  })

  it('a destroyed renderer settles as no-answer immediately (not a hang)', async () => {
    const wc = makeWc(14)
    const pending = askRendererRecovery(wc as never, ASK)
    await flush()
    const destroyed = destroyedOnce.get(wc.id)
    expect(destroyed).toBeTruthy()
    ;(destroyed as unknown as () => void)()
    await expect(pending).resolves.toEqual({ answered: false, reason: 'destroyed' })
  })

  it('asking an already-destroyed renderer answers destroyed without sending', async () => {
    const wc = makeWc(15)
    wc.isDestroyed = () => true
    await expect(askRendererRecovery(wc as never, ASK)).resolves.toEqual({
      answered: false,
      reason: 'destroyed',
    })
    expect(wc.send).not.toHaveBeenCalled()
  })

  it('a renderer that never answers times out with no answer', async () => {
    vi.useFakeTimers()
    try {
      const wc = makeWc(16)
      const assertion = askRendererRecovery(wc as never, ASK)
      const settle = vi.advanceTimersByTimeAsync(RECOVERY_ASK_TIMEOUT_MS + 1)
      await expect(Promise.all([settle, assertion]).then(([, a]) => a)).resolves.toEqual({
        answered: false,
        reason: 'timeout',
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the docs-main integration (source-pinned)', () => {
  const source = readFileSync(join(import.meta.dirname, '../src/main/docs-main.ts'), 'utf8')

  it('hosted, the recovery question goes to the renderer card, not a native sheet', () => {
    // the hosted branch asks through the renderer channel module…
    expect(source).toContain('await askRendererRecovery(contents, {')
    // …and only the standalone branch shows the native message box
    expect(source).toMatch(/if \(!runtimeHostedInShell\) \{[\s\S]*?dialog\.showMessageBox/)
    // the answer channel is registered once with the docs IPC
    expect(source).toContain('installAutosaveRecoveryIpc()')
  })

  it('an unanswered question fails the open with the copy preserved', () => {
    // null (no answer) fails the open instead of falling back to the original
    expect(source).toContain(
      'const recovery = await maybeRecoverDocBytes(filePath, plainBytes, wcId)',
    )
    expect(source).toMatch(/if \(!recovery\) \{[\s\S]*?return null[\s\S]*?\}/)
    // and a discard still clears the copy, a restore still reads it
    expect(source).toMatch(/if \(restore\) \{[\s\S]*?readFile\(asPath\)[\s\S]*?\}/)
    expect(source).toContain('clearRecoveryCopy(filePath)')
  })
})
