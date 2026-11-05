import { describe, expect, it, vi } from 'vitest'

import { watchShellRendererCrash } from '../src/main/shell-renderer-crash'

type FakeWin = {
  isDestroyed: () => boolean
  webContents: {
    on: (event: string, handler: (event: unknown, details: { reason: string; exitCode: number }) => void) => void
    reload: ReturnType<typeof vi.fn>
  }
  /** fire the gone event with a reason */
  die: (reason: string) => void
}

function makeWindow(): FakeWin {
  let gone: ((event: unknown, details: { reason: string; exitCode: number }) => void) | null = null
  return {
    isDestroyed: () => false,
    webContents: {
      on: (event, handler) => {
        if (event === 'render-process-gone') gone = handler
      },
      reload: vi.fn(),
    },
    die: (reason) => gone?.({}, { reason, exitCode: 1 }),
  }
}

describe('watchShellRendererCrash', () => {
  it('reloads the shell renderer on a crash, with the death logged', () => {
    const win = makeWindow()
    const log = vi.fn()
    watchShellRendererCrash(win, log)
    win.die('crashed')
    expect(win.webContents.reload).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('crashed'))
  })

  it('ignores the benign exits (a clean exit, an explicit kill)', () => {
    const win = makeWindow()
    watchShellRendererCrash(win, vi.fn())
    win.die('clean-exit')
    win.die('killed')
    expect(win.webContents.reload).not.toHaveBeenCalled()
  })

  it('stops reloading past three deaths inside a minute — a crash loop must not loop', () => {
    const win = makeWindow()
    const log = vi.fn()
    watchShellRendererCrash(win, log)
    for (let i = 0; i < 3; i++) win.die('oom')
    expect(win.webContents.reload).toHaveBeenCalledTimes(3)
    win.die('oom')
    expect(win.webContents.reload).toHaveBeenCalledTimes(3)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('keeps crashing'))
  })

  it('never reloads a destroyed window', () => {
    const win = makeWindow()
    watchShellRendererCrash(win, vi.fn())
    ;(win as { isDestroyed: () => boolean }).isDestroyed = () => true
    win.die('crashed')
    expect(win.webContents.reload).not.toHaveBeenCalled()
  })
})
