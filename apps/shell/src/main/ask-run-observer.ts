import type { AskRunEvent } from '../shared/home-api'
import type { PiAgentConfirmRequest } from '../shared/pi-agent-api'
import type { PiRunStartInput } from './ask-run-hub'

/**
 * Observer hook for Pi Agent runs dispatched anywhere in the main process.
 * Allows auxiliary surfaces (such as the Butler service) to track live task
 * progress, pending permission cards, and completion without coupling into
 * `ask-run-hub` or renderer state.
 */
export interface AskRunObserver {
  onBegin?(input: PiRunStartInput): void
  onEvent?(event: AskRunEvent): void
  onConfirm?(sessionKey: string, req: PiAgentConfirmRequest | null): void
  onFinish?(sessionKey: string): void
}

const observers = new Set<AskRunObserver>()

/** Register an observer and return an idempotent disposer. */
export function addAskRunObserver(observer: AskRunObserver): () => void {
  observers.add(observer)
  return () => {
    observers.delete(observer)
  }
}

export function notifyRunBegin(input: PiRunStartInput): void {
  for (const observer of [...observers]) {
    try {
      observer.onBegin?.(input)
    } catch {
      // Never let a passive observer interrupt an active agent run.
    }
  }
}

export function notifyRunEvent(event: AskRunEvent): void {
  for (const observer of [...observers]) {
    try {
      observer.onEvent?.(event)
    } catch {
      // Never let a passive observer interrupt an active agent run.
    }
  }
}

export function notifyRunConfirm(sessionKey: string, req: PiAgentConfirmRequest | null): void {
  for (const observer of [...observers]) {
    try {
      observer.onConfirm?.(sessionKey, req)
    } catch {
      // Never let a passive observer interrupt an active agent run.
    }
  }
}

export function notifyRunFinish(sessionKey: string): void {
  for (const observer of [...observers]) {
    try {
      observer.onFinish?.(sessionKey)
    } catch {
      // Never let a passive observer interrupt an active agent run.
    }
  }
}
