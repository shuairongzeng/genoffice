import { useEffect, useRef, useState, type ReactNode } from 'react'

/** one confirm/alert modal request; see useConfirm */
export interface ConfirmRequest {
  /** heading; omit for message-only dialogs (the native alert's replacement) */
  title?: string
  /** the message (and any file list) rendered as-is inside the modal */
  body: ReactNode
  confirmLabel: string
  /** omit for a single-button alert */
  cancelLabel?: string
  /** the confirm button takes the danger style */
  danger?: boolean
}

/**
 * The one in-app confirm/alert modal (home.css's .modal family), replacing the
 * native `window.confirm`/`window.alert` calls that popped unstyled,
 * untranslated system dialogs in a UI that is otherwise all custom modals.
 * Escape and overlay presses dismiss the way every popover in the app does;
 * the cancel button gets focus when present (the safe choice), otherwise the
 * single confirm button does.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel,
  danger,
  onConfirm,
  onCancel,
}: ConfirmRequest & { onConfirm: () => void; onCancel: () => void }) {
  // Escape dismisses. Capture phase + stopPropagation: while this modal is
  // open it owns Escape, so a host that is itself a modal (the folder picker,
  // the settings sheet) does not also close underneath it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onCancel()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [onCancel])
  const label = title ?? (typeof body === 'string' ? body : undefined)
  // the overlay press stops propagation: when this modal is nested inside a
  // host modal (the folder picker, the settings sheet), the press must cancel
  // this dialog only, not bubble into the host's own overlay dismissal
  const onOverlayPress = (event: React.MouseEvent<HTMLDivElement>): void => {
    event.stopPropagation()
    onCancel()
  }
  return (
    <div className="modal-overlay" onClick={onOverlayPress}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(event) => event.stopPropagation()}
      >
        {title !== undefined && <h3>{title}</h3>}
        {body}
        <div className="modal-buttons">
          {cancelLabel !== undefined && (
            <button type="button" className="btn btn-secondary" autoFocus onClick={onCancel}>
              {cancelLabel}
            </button>
          )}
          <button
            type="button"
            className={danger ? 'btn btn-danger' : 'btn'}
            autoFocus={cancelLabel === undefined}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Promise-shaped wrapper over ConfirmDialog for call sites that used to read
 * like native dialogs (`if (await confirm(...))` / `await alert(msg)`). The
 * host renders `dialog` once — a request made while one is open cancels the
 * first (the newest interaction wins, as with the popovers). `okLabel` is the
 * alert's single button label, passed in by the host (the t function is not
 * this hook's to own: half its hosts receive t as a prop).
 */
export function useConfirm(okLabel: string): {
  confirm: (request: ConfirmRequest) => Promise<boolean>
  alert: (body: ReactNode) => Promise<void>
  dialog: ReactNode
} {
  const [pending, setPending] = useState<ConfirmRequest | null>(null)
  const settleRef = useRef<((confirmed: boolean) => void) | null>(null)

  // a request must not outlive its host: the IPC continuation that opened it
  // can land after the host unmounted (a picker closed while its create was
  // in flight), and an unsettled promise would swallow the error message
  // entirely — settle it as cancelled, the same guard tool-confirm.ts carries
  useEffect(
    () => () => {
      settleRef.current?.(false)
      settleRef.current = null
    },
    [],
  )

  const confirm = (request: ConfirmRequest): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      settleRef.current?.(false)
      settleRef.current = resolve
      setPending(request)
    })

  const alert = (body: ReactNode): Promise<void> =>
    confirm({ body, confirmLabel: okLabel }).then(() => undefined)

  const settle = (confirmed: boolean): void => {
    const settleFn = settleRef.current
    settleRef.current = null
    settleFn?.(confirmed)
    setPending(null)
  }

  const dialog =
    pending === null ? null : (
      <ConfirmDialog
        title={pending.title}
        body={pending.body}
        confirmLabel={pending.confirmLabel}
        cancelLabel={pending.cancelLabel}
        danger={pending.danger}
        onConfirm={() => settle(true)}
        onCancel={() => settle(false)}
      />
    )

  return { confirm, alert, dialog }
}
