/**
 * The autosave-recovery question as an in-window card: main pushes the ask
 * (`docs:autosave-recovery-ask`) while this renderer's document is still
 * opening, so the card floats over the "Opening…" booting state and answers
 * over `docs:autosave-recovery-answer`. This is the shell-hosted replacement
 * for the native restore/discard dialog, which has no parent window in the
 * unified shell and shows displaced and blocking.
 *
 * All copy arrives in the ask (main's localized strings — the same ones the
 * standalone native dialog shows), so this component renders whatever it is
 * handed. Esc answers discard, matching the native dialog's cancel button.
 */
import { useEffect } from 'react'
import type { AutosaveRecoveryAsk } from '../../shared/ipc'

export function AutosaveRecoveryDialog({
  ask,
  onAnswer,
}: {
  ask: AutosaveRecoveryAsk
  /** answer the question: true restores the recovery copy, false discards it */
  onAnswer: (restore: boolean) => void
}) {
  // the native dialog's cancelId is the discard button: Esc = discard
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onAnswer(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onAnswer])
  return (
    <div className="modal-backdrop">
      <div className="modal gs-form autosave-recovery-dialog" role="dialog" aria-modal="true">
        <h2>{ask.title}</h2>
        <p className="modal-desc">{ask.body}</p>
        {ask.diskNewerLine !== undefined && (
          <p className="modal-desc autosave-disk-newer">{ask.diskNewerLine}</p>
        )}
        <div className="modal-actions">
          <button onClick={() => onAnswer(false)}>{ask.discardLabel}</button>
          {/* defaultId 0 in the native dialog: Restore is the default answer */}
          <button className="btn-primary" autoFocus onClick={() => onAnswer(true)}>
            {ask.restoreLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
