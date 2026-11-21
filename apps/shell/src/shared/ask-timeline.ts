import type { AskToolActivity } from './ask-activity'

export interface AskThinkingStep {
  readonly kind: 'thinking'
  readonly id: string
  readonly text: string
  readonly streaming: boolean
  readonly startedAt?: number
  readonly endedAt?: number
}

export interface AskToolStep {
  readonly kind: 'tool'
  readonly id: string
  readonly activityId: string
}

export interface AskTextStep {
  readonly kind: 'text'
  readonly id: string
  readonly text: string
  readonly streaming: boolean
}

export type AskTimelineStep = AskThinkingStep | AskToolStep | AskTextStep

export interface AskTimelineLegacySource {
  readonly steps?: readonly AskTimelineStep[]
  readonly reasoning?: string
  readonly activities?: readonly AskToolActivity[]
  readonly text?: string
  readonly streaming?: boolean
}

function nextStepSeq(steps: readonly AskTimelineStep[]): number {
  let max = steps.length
  for (const step of steps) {
    const match = /-(\d+)$/.exec(step.id)
    if (match) {
      const n = Number(match[1])
      if (Number.isFinite(n) && n >= max) max = n + 1
    }
  }
  return max
}

/**
 * Resolve timeline steps for rendering. When explicit ordered steps exist on
 * the message, returns them directly; otherwise hydrates a compatible sequence
 * from legacy flat fields (`reasoning`, `activities`, `text`).
 */
export function resolveTimelineSteps(source: AskTimelineLegacySource): AskTimelineStep[] {
  if (source.steps && source.steps.length > 0) {
    return [...source.steps]
  }
  const hydrated: AskTimelineStep[] = []
  const hasActivities = (source.activities?.length ?? 0) > 0
  const hasText = typeof source.text === 'string' && source.text.trim().length > 0
  const isStreaming = source.streaming === true

  if (typeof source.reasoning === 'string' && source.reasoning.length > 0) {
    hydrated.push({
      kind: 'thinking',
      id: 'think-0',
      text: source.reasoning,
      streaming: isStreaming && !hasActivities && !hasText,
    })
  }
  if (source.activities) {
    for (const activity of source.activities) {
      hydrated.push({
        kind: 'tool',
        id: `tool-${activity.id}`,
        activityId: activity.id,
      })
    }
  }
  if (hasText) {
    hydrated.push({
      kind: 'text',
      id: `text-${hydrated.length}`,
      text: source.text!,
      streaming: isStreaming,
    })
  }
  return hydrated
}

/**
 * Hydrate an existing message snapshot before applying a new timeline mutation.
 * Ensures mirror mounts catching up from legacy snapshots keep prior content.
 */
export function hydrateTimelineSteps(source: AskTimelineLegacySource): AskTimelineStep[] {
  if (source.steps !== undefined) {
    return [...source.steps]
  }
  return resolveTimelineSteps(source)
}

/**
 * Seal every still-streaming thinking or text step so preceding reasoning blocks
 * collapse automatically once a tool call, answer text, or completion occurs.
 */
export function sealStreamingSteps(
  steps: readonly AskTimelineStep[],
  now?: number,
): AskTimelineStep[] {
  let changed = false
  const next = steps.map((step) => {
    if (step.kind === 'thinking' && step.streaming) {
      changed = true
      return {
        ...step,
        streaming: false,
        ...(now !== undefined && step.endedAt === undefined ? { endedAt: now } : {}),
      }
    }
    if (step.kind === 'text' && step.streaming) {
      changed = true
      return {
        ...step,
        streaming: false,
      }
    }
    return step
  })
  return changed ? next : [...steps]
}

/**
 * Append a reasoning delta to the active thinking step, or seal any open step
 * and start a fresh thinking block when transitioning after a tool or text turn.
 */
export function appendReasoningStep(
  steps: readonly AskTimelineStep[],
  delta: string,
  now?: number,
): AskTimelineStep[] {
  if (!delta) return [...steps]
  const last = steps[steps.length - 1]
  if (last?.kind === 'thinking' && last.streaming) {
    const updated: AskThinkingStep = {
      ...last,
      text: last.text + delta,
    }
    return [...steps.slice(0, -1), updated]
  }
  const sealed = sealStreamingSteps(steps, now)
  const cleanLeading = delta.replace(/^\n+/, '')
  if (!cleanLeading) return sealed
  const seq = nextStepSeq(sealed)
  return [
    ...sealed,
    {
      kind: 'thinking',
      id: `think-${seq}`,
      text: cleanLeading,
      streaming: true,
      ...(now !== undefined ? { startedAt: now } : {}),
    },
  ]
}

/**
 * Update the current round's text step from cumulative per-turn text. Seals any
 * active thinking step when entering text generation while preserving in-place
 * updates for text-only corrective retries within the same round.
 */
export function appendTextStep(
  steps: readonly AskTimelineStep[],
  turnText: string,
  now?: number,
): AskTimelineStep[] {
  if (turnText.trim().length === 0) return [...steps]
  const last = steps[steps.length - 1]
  if (last?.kind === 'text' && last.streaming) {
    const updated: AskTextStep = {
      ...last,
      text: turnText,
    }
    return [...steps.slice(0, -1), updated]
  }
  const sealed = sealStreamingSteps(steps, now)
  const seq = nextStepSeq(sealed)
  return [
    ...sealed,
    {
      kind: 'text',
      id: `text-${seq}`,
      text: turnText,
      streaming: true,
    },
  ]
}

/**
 * Seal active thinking/text steps and record a tool step at its real execution position.
 */
export function recordToolStartStep(
  steps: readonly AskTimelineStep[],
  callId: string,
  now?: number,
): AskTimelineStep[] {
  const sealed = sealStreamingSteps(steps, now)
  if (sealed.some((step) => step.kind === 'tool' && step.activityId === callId)) {
    return sealed
  }
  return [
    ...sealed,
    {
      kind: 'tool',
      id: `tool-${callId}`,
      activityId: callId,
    },
  ]
}

/**
 * Ensure a finished tool (e.g. a call rejected before tool-start) is anchored
 * cleanly after sealing any preceding streaming thinking or text step.
 */
export function recordToolFinishedStep(
  steps: readonly AskTimelineStep[],
  callId: string,
  now?: number,
): AskTimelineStep[] {
  return recordToolStartStep(steps, callId, now)
}

/** Combine all non-empty text steps into a plain transcript string for copy/persistence. */
export function deriveCombinedText(
  steps: readonly AskTimelineStep[],
  fallbackText = '',
): string {
  const parts = steps
    .filter((step): step is AskTextStep => step.kind === 'text' && step.text.trim().length > 0)
    .map((step) => step.text.trim())
  if (parts.length === 0) return fallbackText
  return parts.join('\n\n')
}

/** Extract a compact single-line preview from a thinking block for collapsed headers. */
export function thinkingPreviewLine(text: string, maxChars = 72): string {
  const lines = text.split(/\r?\n/)
  let first = ''
  for (const line of lines) {
    const trimmed = line.replace(/\s+/g, ' ').trim()
    if (trimmed.length > 0) {
      first = trimmed
      break
    }
  }
  if (!first) return ''
  if (first.length <= maxChars) return first
  return `${first.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`
}

/** Format elapsed thinking duration when at least one second passed. */
export function formatThinkingDuration(startedAt?: number, endedAt?: number): string | null {
  if (
    typeof startedAt !== 'number' ||
    typeof endedAt !== 'number' ||
    !Number.isFinite(startedAt) ||
    !Number.isFinite(endedAt)
  ) {
    return null
  }
  const elapsedMs = endedAt - startedAt
  if (elapsedMs < 1000) return null
  const totalSeconds = elapsedMs / 1000
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`
  }
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.round(totalSeconds % 60)
  if (seconds === 60) {
    return `${minutes + 1}m 0s`
  }
  return `${minutes}m ${seconds}s`
}
