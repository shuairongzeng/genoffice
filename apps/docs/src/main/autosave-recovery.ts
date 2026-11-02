import { ipcMain } from 'electron'
import type { WebContents } from 'electron'
import type { AutosaveRecoveryAsk } from '../shared/ipc'

/**
 * Main half of the in-renderer autosave-recovery question (open flow).
 *
 * Hosted in the unified shell, the recovery prompt must NOT be a native
 * `dialog.showMessageBox`: there is no docs `mainWindow` and often no focused
 * window, so the sheet shows unparented — half off the window's edge, dimming
 * the whole shell, and in automation the renderer's open flow waits forever
 * on the unanswered sheet while the tab sits at "正在打开…". Instead, main
 * pushes the question into the docs renderer that is opening the document
 * (over `docs:autosave-recovery-ask`) and awaits its card's answer — the
 * same request/response shape `queryCloseState`/`requestRendererSave` use for
 * the close flow.
 *
 * Failure is honest, never a hang: a renderer destroyed mid-ask (or one that
 * never answers — stale preload, wedged frame) settles the wait without an
 * answer, and the caller fails the open with the recovery copy left intact
 * for the next attempt.
 */

export const RECOVERY_ASK_CHANNEL = 'docs:autosave-recovery-ask'
export const RECOVERY_ANSWER_CHANNEL = 'docs:autosave-recovery-answer'

/**
 * How long the ask waits for the card's answer. A live user deciding takes
 * seconds; the cap exists for a renderer that can never answer (destroyed is
 * caught by the watcher, but a stale or wedged one is not) so the open fails
 * instead of parking at "Opening…" — the same budget the close flow's save
 * request allows itself.
 */
export const RECOVERY_ASK_TIMEOUT_MS = 120_000

/** the ask's outcome: the person's answer, or why there is none */
export type RecoveryAnswer =
  { answered: true; restore: boolean } | { answered: false; reason: 'destroyed' | 'timeout' }

interface PendingAsk {
  /** the webContents the question was asked to — only its answers count */
  wcId: number
  resolve: (answer: RecoveryAnswer) => void
  timer: NodeJS.Timeout
  offDestroyed: () => void
}

const pending = new Map<string, PendingAsk>()
let askSeq = 0
let installed = false

function settleAsk(requestId: string, answer: RecoveryAnswer): void {
  const ask = pending.get(requestId)
  if (!ask) return
  pending.delete(requestId)
  clearTimeout(ask.timer)
  ask.offDestroyed()
  ask.resolve(answer)
}

/** Register the renderer's answer channel. Safe to call more than once. */
export function installAutosaveRecoveryIpc(): void {
  if (installed) return
  installed = true
  ipcMain.on(RECOVERY_ANSWER_CHANNEL, (event, raw: unknown) => {
    const payload = raw as { requestId?: unknown; restore?: unknown }
    if (!payload || typeof payload.requestId !== 'string') return
    // a malformed answer is not a person's choice — ignore it, keep waiting
    if (typeof payload.restore !== 'boolean') return
    const ask = pending.get(payload.requestId)
    if (!ask) return
    // requestIds are guessable, so any renderer could otherwise answer
    // another tab's question: the answer is only valid from the tab asked
    if (event.sender.id !== ask.wcId) return
    settleAsk(payload.requestId, { answered: true, restore: payload.restore })
  })
}

/**
 * Ask one renderer the restore-or-discard question and await its card's
 * answer. `ask` carries the fully localized strings (the same ones the
 * standalone native dialog shows — one source of truth for the copy).
 */
export function askRendererRecovery(
  contents: WebContents,
  ask: Omit<AutosaveRecoveryAsk, 'requestId'>,
): Promise<RecoveryAnswer> {
  if (contents.isDestroyed()) {
    return Promise.resolve({ answered: false, reason: 'destroyed' })
  }
  const requestId = `recovery-${++askSeq}`
  return new Promise<RecoveryAnswer>((resolve) => {
    // destroyed mid-ask: the tab is gone, nobody can answer — settle now
    const onDestroyed = (): void => settleAsk(requestId, { answered: false, reason: 'destroyed' })
    contents.once('destroyed', onDestroyed)
    const timer = setTimeout(
      () => settleAsk(requestId, { answered: false, reason: 'timeout' }),
      RECOVERY_ASK_TIMEOUT_MS,
    )
    pending.set(requestId, {
      wcId: contents.id,
      resolve,
      timer,
      offDestroyed: () => contents.removeListener('destroyed', onDestroyed),
    })
    contents.send(RECOVERY_ASK_CHANNEL, { requestId, ...ask })
  })
}
