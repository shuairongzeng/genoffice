import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'

/** live AI pipeline state mapped onto the pet avatar */
export type AiPetActivity = 'idle' | 'thinking' | 'working' | 'attention' | 'error'

/** immutable activity snapshot emitted by the ask panel */
export interface AiPetRunSnapshot {
  readonly activity: AiPetActivity
  readonly completedSeq: number
}

export const IDLE_PET_RUN_SNAPSHOT: AiPetRunSnapshot = {
  activity: 'idle',
  completedSeq: 0,
}

/** all 14 visual moods supported by the AI pet mascots */
export type AiPetMood =
  | 'idle'
  | 'curious'
  | 'sleepy'
  | 'hover'
  | 'petted'
  | 'fed'
  | 'playful'
  | 'dragging'
  | 'settle'
  | 'thinking'
  | 'working'
  | 'unread-done'
  | 'attention'
  | 'error'

/** tactile / nurturing user interactions available on the pet */
export type AiPetInteractionKind = 'pet' | 'feed' | 'play'

export interface AiPetGaze {
  readonly x: number
  readonly y: number
}

export interface PettingTracker {
  energy: number
  lastDx: number
  lastTs: number
}

export const PET_IDLE_SLEEP_MS = 45_000
export const PET_CURIOUS_INTERVAL_MS = 14_000
export const PET_CURIOUS_HOLD_MS = 2_400
export const PET_SETTLE_MS = 420
export const PET_PETTED_HOLD_MS = 1_100
export const PET_FED_HOLD_MS = 1_400
export const PET_PLAYFUL_HOLD_MS = 1_300
export const PET_BUBBLE_HOLD_MS = 2_400
export const PET_GAZE_RADIUS_PX = 260
export const PET_DRAG_TILT_MAX_DEG = 16

const INTERACTION_HOLD_MS: Record<AiPetInteractionKind, number> = {
  pet: PET_PETTED_HOLD_MS,
  feed: PET_FED_HOLD_MS,
  play: PET_PLAYFUL_HOLD_MS,
}

function clearTimerRef(ref: { current: ReturnType<typeof setTimeout> | null }): void {
  if (ref.current !== null) {
    clearTimeout(ref.current)
    ref.current = null
  }
}

export interface ResolvePetMoodInput {
  readonly dragging: boolean
  readonly settling: boolean
  readonly activity: AiPetActivity
  readonly fed?: boolean
  readonly playful?: boolean
  readonly petted: boolean
  readonly unreadDone: boolean
  readonly hovered: boolean
  readonly sleeping: boolean
  readonly curious: boolean
}

/**
 * Arbitrate the active mood strictly by interaction & AI priority:
 * dragging > settle > attention > working > thinking > error >
 * fed > playful > petted > unread-done > hover > sleepy > curious > idle.
 */
export function resolvePetMood(input: ResolvePetMoodInput): AiPetMood {
  if (input.dragging) return 'dragging'
  if (input.settling) return 'settle'
  if (input.activity === 'attention') return 'attention'
  if (input.activity === 'working') return 'working'
  if (input.activity === 'thinking') return 'thinking'
  if (input.activity === 'error') return 'error'
  if (input.fed) return 'fed'
  if (input.playful) return 'playful'
  if (input.petted) return 'petted'
  if (input.unreadDone) return 'unread-done'
  if (input.hovered) return 'hover'
  if (input.sleeping) return 'sleepy'
  if (input.curious) return 'curious'
  return 'idle'
}

function clampRound(value: number, min: number, max: number): number {
  const clamped = Math.min(max, Math.max(min, value))
  const rounded = Math.round(clamped * 1000) / 1000
  return rounded === 0 ? 0 : rounded
}

/**
 * Map a pointer location to normalized pupil gaze offsets relative to the pet center.
 * Horizontal range is [-1, 1]; vertical range is [-0.85, 0.85].
 */
export function computePetGaze(
  pointer: { x: number; y: number },
  center: { x: number; y: number },
  radius: number = PET_GAZE_RADIUS_PX,
): AiPetGaze {
  const dx = pointer.x - center.x
  const dy = pointer.y - center.y
  const dist = Math.hypot(dx, dy)
  if (!Number.isFinite(dist) || dist === 0 || !Number.isFinite(radius) || radius <= 0) {
    return { x: 0, y: 0 }
  }
  const scale = Math.min(1, dist / radius)
  return {
    x: clampRound((dx / dist) * scale, -1, 1),
    y: clampRound((dy / dist) * scale * 0.85, -0.85, 0.85),
  }
}

/**
 * Map horizontal pointer velocity (px/ms) to a gentle tilt angle in [-16, 16] deg.
 * Trailing tilt leans slightly opposite horizontal travel for a playful lifted feel.
 */
export function computeDragTilt(velocityX: number): number {
  if (!Number.isFinite(velocityX) || velocityX === 0) return 0
  const tilt = -Math.tanh(velocityX * 0.75) * PET_DRAG_TILT_MAX_DEG
  const rounded = Math.round(tilt * 100) / 100
  return rounded === 0 ? 0 : rounded
}

const PETTING_DECAY_WINDOW_MS = 650
const PETTING_HALF_LIFE_MS = 320
const PETTING_REVERSAL_BONUS = 28
const PETTING_TRIGGER_ENERGY = 110

/**
 * Accumulate back-and-forth pointer strokes inside the pet bounds and trigger
 * a happy petted reaction once rubbing energy reaches the threshold.
 */
export function advancePettingEnergy(
  tracker: PettingTracker,
  dx: number,
  dy: number,
  nowMs: number,
): { next: PettingTracker; triggered: boolean } {
  const dt = Math.max(0, nowMs - tracker.lastTs)
  const decayed =
    tracker.lastTs <= 0 || dt > PETTING_DECAY_WINDOW_MS
      ? 0
      : tracker.energy * Math.exp(-dt / PETTING_HALF_LIFE_MS)
  const dist = Math.hypot(dx, dy)
  if (!Number.isFinite(dist) || dist <= 0) {
    return {
      next: { energy: decayed, lastDx: tracker.lastDx, lastTs: nowMs },
      triggered: false,
    }
  }
  const reversed = Math.abs(dx) >= 3 && tracker.lastDx * dx < 0
  const total = decayed + dist + (reversed ? PETTING_REVERSAL_BONUS : 0)
  const nextDx = Math.abs(dx) >= 2 ? dx : tracker.lastDx
  if (total >= PETTING_TRIGGER_ENERGY) {
    return {
      next: { energy: 0, lastDx: nextDx, lastTs: nowMs },
      triggered: true,
    }
  }
  return {
    next: { energy: total, lastDx: nextDx, lastTs: nowMs },
    triggered: false,
  }
}

export interface UseAiPetBehaviorOptions {
  readonly collapsed: boolean
  readonly dragging: boolean
  readonly runState: AiPetRunSnapshot
  readonly reducedMotion: boolean
  readonly petRef: RefObject<HTMLElement | null>
  /** True on full-window surfaces (Home) where window pointermove tracks gaze anywhere */
  readonly windowGaze: boolean
  /** Invoked whenever a pet/feed/play interaction triggers (click action or pointer rubbing) */
  readonly onInteract?: (kind: AiPetInteractionKind) => void
}

export interface UseAiPetBehaviorResult {
  readonly mood: AiPetMood
  readonly isSleeping: boolean
  readonly settling: boolean
  readonly activeBubble: AiPetInteractionKind | null
  readonly onPointerEnter: () => void
  readonly onPointerLeave: () => void
  readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
  readonly onDragVelocity: (velocityX: number) => void
  readonly triggerSettle: () => void
  readonly toggleManualSleep: () => void
  readonly wakeUp: () => void
  readonly triggerPet: () => void
  readonly triggerFeed: () => void
  readonly triggerPlay: () => void
}

/**
 * Shared stateful behavior controller for both the Home pet and the overlay view's pet.
 * Drives gaze & tilt CSS custom properties via rAF without triggering React re-renders.
 */
export function useAiPetBehavior({
  collapsed,
  dragging,
  runState,
  reducedMotion,
  petRef,
  windowGaze,
  onInteract,
}: UseAiPetBehaviorOptions): UseAiPetBehaviorResult {
  const [hovered, setHovered] = useState(false)
  const [activeInteraction, setActiveInteraction] = useState<AiPetInteractionKind | null>(null)
  const [activeBubble, setActiveBubble] = useState<AiPetInteractionKind | null>(null)
  const [settling, setSettling] = useState(false)
  const [manualSleep, setManualSleep] = useState(false)
  const [autoSleep, setAutoSleep] = useState(false)
  const [curious, setCurious] = useState(false)
  const [unreadDone, setUnreadDone] = useState(false)

  const prevCompletedSeqRef = useRef(runState.completedSeq)
  const pettingRef = useRef<PettingTracker>({ energy: 0, lastDx: 0, lastTs: 0 })
  const lastLocalPointerRef = useRef<{ x: number; y: number } | null>(null)
  const onInteractRef = useRef(onInteract)
  onInteractRef.current = onInteract

  const interactionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bubbleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const curiousHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const gazeTargetRef = useRef<AiPetGaze>({ x: 0, y: 0 })
  const tiltTargetRef = useRef(0)
  const rafRef = useRef<number | null>(null)

  const clearInteractions = useCallback(() => {
    clearTimerRef(interactionTimerRef)
    clearTimerRef(bubbleTimerRef)
    setActiveInteraction(null)
    setActiveBubble(null)
  }, [])

  const triggerInteraction = useCallback((kind: AiPetInteractionKind) => {
    setManualSleep(false)
    setAutoSleep(false)
    setCurious(false)

    clearTimerRef(interactionTimerRef)
    setActiveInteraction(kind)
    interactionTimerRef.current = setTimeout(() => {
      interactionTimerRef.current = null
      setActiveInteraction(null)
    }, INTERACTION_HOLD_MS[kind])

    clearTimerRef(bubbleTimerRef)
    setActiveBubble(kind)
    bubbleTimerRef.current = setTimeout(() => {
      bubbleTimerRef.current = null
      setActiveBubble(null)
    }, PET_BUBBLE_HOLD_MS)

    onInteractRef.current?.(kind)
  }, [])

  const flushStyles = useCallback(() => {
    rafRef.current = null
    const el = petRef.current
    if (!el) return
    el.style.setProperty('--gaze-x', String(gazeTargetRef.current.x))
    el.style.setProperty('--gaze-y', String(gazeTargetRef.current.y))
    el.style.setProperty('--pet-tilt', `${tiltTargetRef.current}deg`)
  }, [petRef])

  const scheduleStyleFlush = useCallback(() => {
    if (typeof requestAnimationFrame !== 'function') {
      flushStyles()
      return
    }
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(flushStyles)
  }, [flushStyles])

  const resetGaze = useCallback(() => {
    if (gazeTargetRef.current.x === 0 && gazeTargetRef.current.y === 0) return
    gazeTargetRef.current = { x: 0, y: 0 }
    scheduleStyleFlush()
  }, [scheduleStyleFlush])

  // Clear sleep/curious/unread/interaction states when the drawer expands
  useEffect(() => {
    if (collapsed) return
    setUnreadDone(false)
    setAutoSleep(false)
    setManualSleep(false)
    setCurious(false)
    setHovered(false)
    clearInteractions()
  }, [collapsed, clearInteractions])

  // Track completed background responses only while collapsed
  useEffect(() => {
    const prev = prevCompletedSeqRef.current
    prevCompletedSeqRef.current = runState.completedSeq
    if (runState.completedSeq > prev && collapsed) {
      setUnreadDone(true)
      setAutoSleep(false)
    }
  }, [runState.completedSeq, collapsed])

  // Active AI work or unread completion wakes an auto-napping pet
  useEffect(() => {
    if (runState.activity !== 'idle' || unreadDone) {
      setAutoSleep(false)
      setCurious(false)
    }
  }, [runState.activity, unreadDone])

  // Clear tilt when drag ends and reset stale petting pointer history across drags
  useEffect(() => {
    lastLocalPointerRef.current = null
    pettingRef.current = { energy: 0, lastDx: 0, lastTs: 0 }
    if (dragging) {
      clearInteractions()
      return
    }
    if (tiltTargetRef.current !== 0) {
      tiltTargetRef.current = 0
      scheduleStyleFlush()
    }
  }, [dragging, scheduleStyleFlush, clearInteractions])

  const sleeping = (manualSleep || autoSleep) && runState.activity === 'idle' && !unreadDone
  const interacting = activeInteraction !== null

  // Auto-nap timer when collapsed and genuinely idle
  useEffect(() => {
    if (
      !collapsed ||
      reducedMotion ||
      runState.activity !== 'idle' ||
      hovered ||
      dragging ||
      interacting ||
      unreadDone ||
      sleeping
    ) {
      return
    }
    const timer = setTimeout(() => {
      setAutoSleep(true)
      setCurious(false)
    }, PET_IDLE_SLEEP_MS)
    return () => clearTimeout(timer)
  }, [
    collapsed,
    reducedMotion,
    runState.activity,
    hovered,
    dragging,
    interacting,
    unreadDone,
    sleeping,
  ])

  // Occasional curious head-tilt while awake and idle
  useEffect(() => {
    if (
      !collapsed ||
      reducedMotion ||
      runState.activity !== 'idle' ||
      hovered ||
      dragging ||
      sleeping ||
      interacting ||
      unreadDone ||
      settling
    ) {
      setCurious(false)
      return
    }
    const interval = setInterval(() => {
      setCurious(true)
      clearTimerRef(curiousHoldTimerRef)
      curiousHoldTimerRef.current = setTimeout(() => {
        curiousHoldTimerRef.current = null
        setCurious(false)
      }, PET_CURIOUS_HOLD_MS)
    }, PET_CURIOUS_INTERVAL_MS)
    return () => {
      clearInterval(interval)
      clearTimerRef(curiousHoldTimerRef)
    }
  }, [
    collapsed,
    reducedMotion,
    runState.activity,
    hovered,
    dragging,
    sleeping,
    interacting,
    unreadDone,
    settling,
  ])

  // Window-wide gaze tracking for Home desktop
  useEffect(() => {
    if (!windowGaze || !collapsed || reducedMotion || sleeping || dragging) {
      resetGaze()
      return
    }
    const onWinMove = (event: PointerEvent) => {
      const rect = petRef.current?.getBoundingClientRect()
      if (!rect || rect.width <= 0 || rect.height <= 0) return
      gazeTargetRef.current = computePetGaze(
        { x: event.clientX, y: event.clientY },
        { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      )
      scheduleStyleFlush()
    }
    const onWinLeave = () => resetGaze()
    window.addEventListener('pointermove', onWinMove, { passive: true })
    window.addEventListener('blur', onWinLeave)
    document.addEventListener('mouseleave', onWinLeave)
    return () => {
      window.removeEventListener('pointermove', onWinMove)
      window.removeEventListener('blur', onWinLeave)
      document.removeEventListener('mouseleave', onWinLeave)
    }
  }, [
    windowGaze,
    collapsed,
    reducedMotion,
    sleeping,
    dragging,
    petRef,
    resetGaze,
    scheduleStyleFlush,
  ])

  // Cleanup timers and rAF on unmount
  useEffect(
    () => () => {
      clearTimerRef(interactionTimerRef)
      clearTimerRef(bubbleTimerRef)
      clearTimerRef(settleTimerRef)
      clearTimerRef(curiousHoldTimerRef)
      if (rafRef.current !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafRef.current)
      }
    },
    [],
  )

  const wakeUp = useCallback(() => {
    setManualSleep(false)
    setAutoSleep(false)
    setCurious(false)
  }, [])

  const toggleManualSleep = useCallback(() => {
    setCurious(false)
    if (manualSleep || autoSleep) {
      setManualSleep(false)
      setAutoSleep(false)
      return
    }
    clearInteractions()
    lastLocalPointerRef.current = null
    pettingRef.current = { energy: 0, lastDx: 0, lastTs: 0 }
    setHovered(false)
    setAutoSleep(false)
    setManualSleep(true)
  }, [manualSleep, autoSleep, clearInteractions])

  const triggerSettle = useCallback(() => {
    if (reducedMotion) return
    setSettling(true)
    clearTimerRef(settleTimerRef)
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null
      setSettling(false)
    }, PET_SETTLE_MS)
  }, [reducedMotion])

  const triggerPet = useCallback(() => triggerInteraction('pet'), [triggerInteraction])
  const triggerFeed = useCallback(() => triggerInteraction('feed'), [triggerInteraction])
  const triggerPlay = useCallback(() => triggerInteraction('play'), [triggerInteraction])

  const onDragVelocity = useCallback(
    (velocityX: number) => {
      if (reducedMotion) return
      tiltTargetRef.current = computeDragTilt(velocityX)
      scheduleStyleFlush()
    },
    [reducedMotion, scheduleStyleFlush],
  )

  const onPointerEnter = useCallback(() => {
    setHovered(true)
    setAutoSleep(false)
    setCurious(false)
    lastLocalPointerRef.current = null
  }, [])

  const onPointerLeave = useCallback(() => {
    setHovered(false)
    lastLocalPointerRef.current = null
    pettingRef.current = { energy: 0, lastDx: 0, lastTs: 0 }
    if (!windowGaze) resetGaze()
  }, [windowGaze, resetGaze])

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!collapsed || dragging) return
      if (!windowGaze && !reducedMotion && !sleeping) {
        const rect = petRef.current?.getBoundingClientRect()
        if (rect && rect.width > 0 && rect.height > 0) {
          gazeTargetRef.current = computePetGaze(
            { x: event.clientX, y: event.clientY },
            { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
            Math.max(34, rect.width * 0.6),
          )
          scheduleStyleFlush()
        }
      }
      if (reducedMotion) return
      const prev = lastLocalPointerRef.current
      lastLocalPointerRef.current = { x: event.clientX, y: event.clientY }
      if (!prev) return
      const dx = event.clientX - prev.x
      const dy = event.clientY - prev.y
      const { next, triggered } = advancePettingEnergy(
        pettingRef.current,
        dx,
        dy,
        event.timeStamp || performance.now(),
      )
      pettingRef.current = next
      if (triggered) {
        triggerInteraction('pet')
      }
    },
    [
      collapsed,
      dragging,
      windowGaze,
      reducedMotion,
      sleeping,
      petRef,
      scheduleStyleFlush,
      triggerInteraction,
    ],
  )

  const mood = resolvePetMood({
    dragging,
    settling,
    activity: runState.activity,
    fed: activeInteraction === 'feed',
    playful: activeInteraction === 'play',
    petted: activeInteraction === 'pet',
    unreadDone,
    hovered,
    sleeping,
    curious,
  })

  return {
    mood,
    isSleeping: sleeping,
    settling,
    activeBubble,
    onPointerEnter,
    onPointerLeave,
    onPointerMove,
    onDragVelocity,
    triggerSettle,
    toggleManualSleep,
    wakeUp,
    triggerPet,
    triggerFeed,
    triggerPlay,
  }
}
