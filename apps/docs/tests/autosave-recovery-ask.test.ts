// @vitest-environment jsdom
/**
 * The renderer half of the autosave-recovery question: the hook that owns the
 * ask state and answers over the bridge, and the in-window card itself — the
 * shell-hosted replacement for the native restore/discard sheet, which has no
 * parent window in the unified shell. The card must float over the "Opening…"
 * booting state, its buttons answer the question, and Esc answers discard
 * (the native dialog's cancel button was Discard).
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAutosaveRecoveryAsk } from '../src/renderer/autosave-recovery-ask'
import { AutosaveRecoveryDialog } from '../src/renderer/components/AutosaveRecoveryDialog'
import type { AutosaveRecoveryAsk } from '../src/shared/ipc'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ASK: AutosaveRecoveryAsk = {
  requestId: 'recovery-7',
  title: '发现自动恢复版本',
  body: '上次会话有未保存的更改。要恢复自动保存的版本吗?',
  diskNewerLine: '注意：磁盘上的文件又被修改过。',
  restoreLabel: '恢复',
  discardLabel: '放弃',
}

let askListener: ((ask: AutosaveRecoveryAsk) => void) | null = null
const answerAutosaveRecovery = vi.fn()

beforeEach(() => {
  askListener = null
  answerAutosaveRecovery.mockClear()
  ;(window as unknown as { desktop: unknown }).desktop = {
    onAutosaveRecoveryAsk: (listener: (ask: AutosaveRecoveryAsk) => void) => {
      askListener = listener
      return () => {
        askListener = null
      }
    },
    answerAutosaveRecovery,
  }
})

afterEach(() => {
  delete (window as unknown as { desktop?: unknown }).desktop
})

let host: HTMLDivElement
let root: Root

const mount = (element: React.ReactElement): void => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(element))
}

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

/** a harness component exposing the hook's values */
let hookState: { ask: AutosaveRecoveryAsk | null; answer: (restore: boolean) => void }

function HookHarness(): React.JSX.Element | null {
  hookState = useAutosaveRecoveryAsk()
  return null
}

describe('useAutosaveRecoveryAsk', () => {
  it('holds the pushed ask and answers it over the bridge', async () => {
    mount(createElement(HookHarness))
    await settle()
    expect(hookState.ask).toBeNull()
    act(() => askListener?.(ASK))
    await settle()
    expect(hookState.ask).toEqual(ASK)
    act(() => hookState.answer(true))
    await settle()
    // the answer carried the ask's request id: restore
    expect(answerAutosaveRecovery).toHaveBeenCalledWith('recovery-7', true)
    // and the question is off the table
    expect(hookState.ask).toBeNull()
  })

  it('a second answer after settling is a no-op (no zombie card double-answer)', async () => {
    mount(createElement(HookHarness))
    await settle()
    act(() => askListener?.(ASK))
    act(() => hookState.answer(false))
    act(() => hookState.answer(true))
    await settle()
    expect(answerAutosaveRecovery).toHaveBeenCalledTimes(1)
    expect(answerAutosaveRecovery).toHaveBeenCalledWith('recovery-7', false)
  })
})

describe('the AutosaveRecoveryDialog card', () => {
  it("renders the ask's own copy over the booting state and answers its buttons", async () => {
    const onAnswer = vi.fn()
    mount(
      createElement(
        'div',
        null,
        createElement('div', { className: 'start-screen start-booting' }, '正在打开…'),
        createElement(AutosaveRecoveryDialog, { ask: ASK, onAnswer }),
      ),
    )
    await settle()
    // the card floats over the booting state (a fixed backdrop above it in DOM)
    expect(host.querySelector('.start-booting')).toBeTruthy()
    const dialog = host.querySelector('.autosave-recovery-dialog') as HTMLElement
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.querySelector('h2')?.textContent).toBe(ASK.title)
    expect(dialog.textContent).toContain(ASK.body)
    expect(dialog.textContent).toContain(ASK.diskNewerLine!)
    const buttons = [...dialog.querySelectorAll('.modal-actions button')] as HTMLElement[]
    expect(buttons.map((b) => b.textContent)).toEqual([ASK.discardLabel, ASK.restoreLabel])
    act(() => buttons[1]!.click())
    expect(onAnswer).toHaveBeenCalledWith(true)
    act(() => buttons[0]!.click())
    expect(onAnswer).toHaveBeenCalledWith(false)
  })

  it("Esc answers discard — the native dialog's cancel button was Discard", async () => {
    const onAnswer = vi.fn()
    mount(createElement(AutosaveRecoveryDialog, { ask: ASK, onAnswer }))
    await settle()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
    })
    expect(onAnswer).toHaveBeenCalledWith(false)
    expect(onAnswer).not.toHaveBeenCalledWith(true)
  })

  it('a card without the disk-newer line renders no warning line', async () => {
    const onAnswer = vi.fn()
    mount(
      createElement(AutosaveRecoveryDialog, {
        ask: { ...ASK, diskNewerLine: undefined },
        onAnswer,
      }),
    )
    await settle()
    expect(host.querySelector('.autosave-disk-newer')).toBeNull()
  })
})
