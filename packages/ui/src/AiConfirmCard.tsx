import React from 'react'
import type { AiConfirmLabels } from './strings-ai-confirm'
import type { ToolConfirmCard } from './tool-confirm'

/**
 * The inline decision card for one agent tool confirmation: title, tool
 * name, a collapsible arguments preview, and up to three buttons — always
 * allow for this conversation (when the request offers it and the host wired
 * the affordance), allow once, deny. While `outcome` is 'awaiting' the
 * buttons are live and one click settles the request (the buttons then go
 * inert — a settled card cannot be re-decided); afterwards the card stays in
 * the conversation as the record of the decision. Rendered inside the
 * panel's message flow; styles come from ai-confirm-card.css and the shared
 * theme tokens.
 */
export function AiConfirmCard({
  labels,
  card,
  timeoutMinutes = 5,
  onAllow,
  onAllowSession,
  onDeny,
}: {
  readonly labels: AiConfirmLabels
  readonly card: ToolConfirmCard
  /** minutes of silence before the request self-denies (matches the hook's timeout) */
  readonly timeoutMinutes?: number | undefined
  /** allow this one call */
  readonly onAllow: () => void
  /**
   * Always-allow this tool for the rest of the conversation: rendered only
   * when the card's request offers it (sessionAllowable) — destructive
   * 'always-ask' tools never do — and only for hosts that wired it; hosts
   * without the affordance keep the plain two-button card.
   */
  readonly onAllowSession?: (() => void) | undefined
  readonly onDeny: () => void
}): React.JSX.Element {
  const awaiting = card.outcome === 'awaiting'
  const showSession = awaiting && card.sessionAllowable === true && onAllowSession !== undefined
  return (
    <div
      className="ai-confirm-card"
      data-outcome={card.outcome}
      data-via-session={card.viaSession === true || undefined}
      role="alertdialog"
    >
      <div className="ai-confirm-title">
        {labels.title}
        <span className="ai-confirm-tool">{labels.toolLabel(card.toolName)}</span>
      </div>
      {card.argsSummary !== undefined && card.argsSummary !== '' && (
        <div className="ai-confirm-args-summary">{card.argsSummary}</div>
      )}
      <details className="ai-confirm-args">
        <summary>{labels.argsLabel}</summary>
        <pre dir="auto">{card.args}</pre>
      </details>
      {awaiting ? (
        <div className="ai-confirm-actions">
          {showSession && (
            <button type="button" className="ai-confirm-session" onClick={onAllowSession}>
              {labels.allowSession}
            </button>
          )}
          <button type="button" className="ai-confirm-allow" onClick={onAllow}>
            {labels.allow}
          </button>
          <button type="button" className="ai-confirm-deny" onClick={onDeny}>
            {labels.deny}
          </button>
        </div>
      ) : (
        <div className="ai-confirm-outcome" data-denied={card.outcome === 'denied' || undefined}>
          {card.outcome === 'allowed'
            ? card.viaSession === true
              ? labels.allowedSessionNote
              : labels.allowedNote
            : labels.deniedNote}
        </div>
      )}
      {awaiting && (
        <div className="ai-confirm-hint">
          {labels.awaitingHint} {labels.timeoutHint(timeoutMinutes)}
        </div>
      )}
    </div>
  )
}
