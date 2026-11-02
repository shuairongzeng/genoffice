import { useCallback, useEffect, useRef, useState } from 'react'
import type { AutosaveRecoveryAsk } from '../shared/ipc'

/**
 * The renderer half of the autosave-recovery question: main pushes the ask
 * while this tab's document is opening (hosted in the shell — the native
 * dialog would have no parent window there), the card answers. The ask
 * carries its own localized copy, so the renderer owns no strings for it.
 */
export function useAutosaveRecoveryAsk(): {
  /** the question on the table (null when none) */
  ask: AutosaveRecoveryAsk | null
  /** answer it: true restores the recovery copy, false discards it */
  answer: (restore: boolean) => void
} {
  const [ask, setAsk] = useState<AutosaveRecoveryAsk | null>(null)
  const askRef = useRef<AutosaveRecoveryAsk | null>(null)

  useEffect(
    () =>
      window.desktop.onAutosaveRecoveryAsk((next) => {
        askRef.current = next
        setAsk(next)
      }),
    [],
  )

  const answer = useCallback((restore: boolean) => {
    const current = askRef.current
    if (!current) return
    askRef.current = null
    setAsk(null)
    window.desktop.answerAutosaveRecovery(current.requestId, restore)
  }, [])

  return { ask, answer }
}
