/**
 * Pure state machine, display placement math, and gate rules for the instant
 * startup splash window. Kept free of runtime Electron imports so unit tests
 * run directly in Node without mocks.
 */

export type SplashStage = 'boot' | 'core' | 'workspace' | 'ready'

export const SPLASH_STAGE_ORDER: readonly SplashStage[] = ['boot', 'core', 'workspace', 'ready']

export const SPLASH_STAGE_PROGRESS: Record<SplashStage, number> = {
  boot: 22,
  core: 56,
  workspace: 86,
  ready: 100,
}

export const SPLASH_WIDTH = 400
export const SPLASH_HEIGHT = 280
export const SPLASH_SAFETY_TIMEOUT_MS = 12_000
export const SPLASH_EXIT_ANIM_MS = 180

export interface SplashRect {
  x: number
  y: number
  width: number
  height: number
}

export interface SplashEligibilityInput {
  headless: boolean
  hasSingleInstanceLock: boolean
  disabledByEnv?: boolean
}

/**
 * Only show the splash screen for a primary interactive GUI launch.
 * Headless CLI exports, secondary forwarded launches, and explicit opt-outs
 * must never flash a splash window.
 */
export function shouldShowSplash(opts: SplashEligibilityInput): boolean {
  return !opts.headless && opts.hasSingleInstanceLock && !opts.disabledByEnv
}

function intersectionArea(a: SplashRect, b: SplashRect): number {
  const xOverlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const yOverlap = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  return xOverlap * yOverlap
}

function containsPoint(rect: SplashRect, px: number, py: number): boolean {
  return px >= rect.x && px < rect.x + rect.width && py >= rect.y && py < rect.y + rect.height
}

/**
 * Pick the display work area that hosted the saved shell window (falling back
 * to the primary work area) and center the splash rectangle inside it, clamped
 * so it never overflows the target work area.
 */
export function computeSplashBounds(
  workAreas: readonly SplashRect[],
  primaryWorkArea: SplashRect,
  savedWindow?: SplashRect | null,
  size: { width: number; height: number } = { width: SPLASH_WIDTH, height: SPLASH_HEIGHT },
): SplashRect {
  let target = primaryWorkArea

  if (savedWindow && workAreas.length > 0) {
    const cx = savedWindow.x + savedWindow.width / 2
    const cy = savedWindow.y + savedWindow.height / 2
    const byCenter = workAreas.find((area) => containsPoint(area, cx, cy))
    if (byCenter) {
      target = byCenter
    } else {
      let bestArea = 0
      for (const area of workAreas) {
        const overlap = intersectionArea(savedWindow, area)
        if (overlap > bestArea) {
          bestArea = overlap
          target = area
        }
      }
    }
  }

  const width = target.width > 0 ? Math.min(size.width, target.width) : size.width
  const height = target.height > 0 ? Math.min(size.height, target.height) : size.height
  const rawX = target.x + (target.width - width) / 2
  const rawY = target.y + (target.height - height) / 2
  const maxX = target.x + Math.max(0, target.width - width)
  const maxY = target.y + Math.max(0, target.height - height)

  return {
    x: Math.round(Math.min(Math.max(rawX, target.x), maxX)),
    y: Math.round(Math.min(Math.max(rawY, target.y), maxY)),
    width: Math.round(width),
    height: Math.round(height),
  }
}

export type SplashRevealReason = 'ready' | 'timeout' | 'forced'

export interface SplashCoordinatorHooks {
  timeoutMs?: number
  onStage?: (stage: SplashStage) => void
  revealMainWindow: (reason: SplashRevealReason) => void
  onRevealed?: (reason: SplashRevealReason) => void
}

export interface SplashCoordinator {
  setStage(stage: SplashStage): void
  markReadyToShow(): void
  markFirstPaint(): void
  forceReveal(reason?: string): void
  isRevealed(): boolean
  currentStage(): SplashStage
  dispose(): void
}

/**
 * Dual-gate handoff coordinator: holds the hidden main window until both
 * Chromium's `ready-to-show` and the renderer's post-mount `firstPaint`
 * signal arrive, or until a safety timeout / explicit error recovery fires.
 * Guarantees `revealMainWindow` and `onRevealed` each fire at most once.
 */
export function createSplashCoordinator(hooks: SplashCoordinatorHooks): SplashCoordinator {
  const timeoutMs = hooks.timeoutMs ?? SPLASH_SAFETY_TIMEOUT_MS
  let stage: SplashStage = 'boot'
  let readyToShow = false
  let firstPaint = false
  let revealed = false
  let disposed = false

  const clearTimer = (): void => {
    if (safetyTimer) {
      clearTimeout(safetyTimer)
      safetyTimer = null
    }
  }

  const triggerReveal = (reason: SplashRevealReason): void => {
    if (revealed || disposed) return
    revealed = true
    clearTimer()
    setStage('ready')
    hooks.revealMainWindow(reason)
    hooks.onRevealed?.(reason)
  }

  let safetyTimer: ReturnType<typeof setTimeout> | null =
    timeoutMs > 0
      ? setTimeout(() => {
          triggerReveal('timeout')
        }, timeoutMs)
      : null
  safetyTimer?.unref?.()

  const setStage = (next: SplashStage): void => {
    if (disposed) return
    if (SPLASH_STAGE_ORDER.indexOf(next) > SPLASH_STAGE_ORDER.indexOf(stage)) {
      stage = next
      hooks.onStage?.(stage)
    }
  }

  const maybeReveal = (): void => {
    if (readyToShow && firstPaint) {
      triggerReveal('ready')
    }
  }

  return {
    setStage,
    markReadyToShow() {
      if (disposed || revealed) return
      readyToShow = true
      maybeReveal()
    },
    markFirstPaint() {
      if (disposed || revealed) return
      firstPaint = true
      maybeReveal()
    },
    forceReveal() {
      triggerReveal('forced')
    },
    isRevealed: () => revealed,
    currentStage: () => stage,
    dispose() {
      if (disposed) return
      disposed = true
      clearTimer()
    },
  }
}
