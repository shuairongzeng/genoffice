import type { ButlerPrefs } from '../../shared/butler-prefs'

export type ButlerInterruptKind = 'done' | 'error' | 'confirm'

const WINDOW_MS = 3_600_000

/**
 * Sliding-window rate limiter for Butler OS notifications.
 * Do-not-disturb blocks all interruptions (including confirmations);
 * confirmation prompts bypass the hourly budget when DND is off;
 * completion and failure alerts share the 1-hour sliding budget.
 */
export function createInterruptGate(): {
  allow(
    kind: ButlerInterruptKind,
    now: number,
    prefs: Pick<ButlerPrefs, 'dnd' | 'maxPerHour'>,
  ): boolean
} {
  let timestamps: number[] = []

  return {
    allow(kind, now, prefs) {
      if (prefs.dnd) return false
      if (kind === 'confirm') return true

      const cutoff = now - WINDOW_MS
      timestamps = timestamps.filter((ts) => ts > cutoff)

      if (timestamps.length >= prefs.maxPerHour) {
        return false
      }
      timestamps.push(now)
      return true
    },
  }
}
