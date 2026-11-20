// @vitest-environment jsdom
import { act, createElement, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_PET_IDS, type AiPetId } from '../src/shared/ai-pet-prefs'
import { MascotSvg } from '../src/renderer/src/AiMascot'
import {
  petSoundProfile,
  playPetSound,
  type AiPetSoundKind,
} from '../src/renderer/src/ai-pet-sound'
import {
  advancePettingEnergy,
  computeDragTilt,
  computePetGaze,
  IDLE_PET_RUN_SNAPSHOT,
  PET_BUBBLE_HOLD_MS,
  PET_DRAG_TILT_MAX_DEG,
  PET_FED_HOLD_MS,
  PET_PETTED_HOLD_MS,
  PET_PLAYFUL_HOLD_MS,
  resolvePetMood,
  useAiPetBehavior,
  type AiPetInteractionKind,
  type AiPetMood,
  type AiPetRunSnapshot,
  type PettingTracker,
  type UseAiPetBehaviorResult,
} from '../src/renderer/src/ai-pet-state'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Unit specs for the Lively Bluebird pet state machine and SVG artwork
 * (ai-pet-state.ts + AiMascot.tsx): mood priority arbitration, pointer gaze
 * clamping, velocity-driven drag tilt, petting energy trigger, and gradient ID
 * isolation across concurrent mascot instances.
 */

describe('resolvePetMood', () => {
  const base = {
    dragging: false,
    settling: false,
    activity: 'idle' as const,
    petted: false,
    unreadDone: false,
    hovered: false,
    sleeping: false,
    curious: false,
  }

  it('arbitrates all 12 moods strictly by priority', () => {
    expect(resolvePetMood(base)).toBe('idle')
    expect(resolvePetMood({ ...base, curious: true })).toBe('curious')
    expect(resolvePetMood({ ...base, curious: true, sleeping: true })).toBe('sleepy')
    expect(resolvePetMood({ ...base, sleeping: true, hovered: true })).toBe('hover')
    expect(resolvePetMood({ ...base, hovered: true, unreadDone: true })).toBe('unread-done')
    expect(resolvePetMood({ ...base, unreadDone: true, petted: true })).toBe('petted')
    expect(resolvePetMood({ ...base, petted: true, activity: 'error' })).toBe('error')
    expect(resolvePetMood({ ...base, activity: 'thinking' })).toBe('thinking')
    expect(resolvePetMood({ ...base, activity: 'working' })).toBe('working')
    expect(resolvePetMood({ ...base, activity: 'attention' })).toBe('attention')
    expect(resolvePetMood({ ...base, activity: 'attention', settling: true })).toBe('settle')
    expect(resolvePetMood({ ...base, settling: true, dragging: true })).toBe('dragging')
  })

  it('arbitrates all 14 moods including fed and playful strictly by priority', () => {
    expect(resolvePetMood({ ...base, unreadDone: true, petted: true })).toBe('petted')
    expect(resolvePetMood({ ...base, petted: true, playful: true })).toBe('playful')
    expect(resolvePetMood({ ...base, petted: true, playful: true, fed: true })).toBe('fed')
    expect(resolvePetMood({ ...base, fed: true, playful: true, activity: 'error' })).toBe('error')
    expect(resolvePetMood({ ...base, fed: true, activity: 'thinking' })).toBe('thinking')
    expect(resolvePetMood({ ...base, fed: true, activity: 'working' })).toBe('working')
    expect(resolvePetMood({ ...base, fed: true, activity: 'attention' })).toBe('attention')
    expect(resolvePetMood({ ...base, fed: true, settling: true })).toBe('settle')
    expect(resolvePetMood({ ...base, fed: true, dragging: true })).toBe('dragging')
  })
})

describe('computePetGaze', () => {
  it('returns zero gaze at the center and saturates smoothly within [-1..1] / [-0.85..0.85]', () => {
    expect(computePetGaze({ x: 100, y: 100 }, { x: 100, y: 100 })).toEqual({ x: 0, y: 0 })
    const right = computePetGaze({ x: 360, y: 100 }, { x: 100, y: 100 }, 260)
    expect(right).toEqual({ x: 1, y: 0 })
    const farBottomLeft = computePetGaze({ x: -900, y: 1900 }, { x: 100, y: 100 }, 260)
    expect(farBottomLeft.x).toBeGreaterThanOrEqual(-1)
    expect(farBottomLeft.x).toBeLessThan(0)
    expect(farBottomLeft.y).toBeLessThanOrEqual(0.85)
    expect(farBottomLeft.y).toBeGreaterThan(0)
  })
})

describe('computeDragTilt', () => {
  it('stays finite, monotonic in magnitude, and bounded within max drag tilt degrees', () => {
    expect(computeDragTilt(0)).toBe(0)
    expect(computeDragTilt(Number.NaN)).toBe(0)
    expect(computeDragTilt(Number.POSITIVE_INFINITY)).toBe(0)
    const gentleRight = computeDragTilt(0.4)
    const fastRight = computeDragTilt(4)
    const fastLeft = computeDragTilt(-4)
    expect(gentleRight).not.toBe(0)
    expect(Math.abs(fastRight)).toBeGreaterThan(Math.abs(gentleRight))
    expect(Math.abs(fastRight)).toBeLessThanOrEqual(PET_DRAG_TILT_MAX_DEG)
    expect(fastLeft).toBe(-fastRight)
  })
})

describe('advancePettingEnergy', () => {
  it('triggers petted state on rapid back-and-forth strokes and decays after idle gaps', () => {
    let tracker: PettingTracker = { energy: 0, lastDx: 0, lastTs: 0 }
    let t = 1000
    let triggered = false
    for (let i = 0; i < 6; i += 1) {
      const dx = i % 2 === 0 ? 18 : -18
      t += 40
      const step = advancePettingEnergy(tracker, dx, 2, t)
      tracker = step.next
      if (step.triggered) {
        triggered = true
        break
      }
    }
    expect(triggered).toBe(true)
    // A pause longer than the decay window resets accumulated energy
    const afterGap = advancePettingEnergy({ energy: 85, lastDx: 10, lastTs: 1000 }, 4, 0, 2000)
    expect(afterGap.triggered).toBe(false)
    expect(afterGap.next.energy).toBeLessThan(10)
  })
})

describe('MascotSvg', () => {
  it('renders distinct gradient IDs per instance and exposes accurate mood visuals', () => {
    const html = renderToStaticMarkup(
      createElement(
        'div',
        null,
        createElement(MascotSvg, { mood: 'idle' }),
        createElement(MascotSvg, { mood: 'thinking' }),
      ),
    )
    const container = document.createElement('div')
    container.innerHTML = html
    const svgs = [...container.querySelectorAll('svg')]
    expect(svgs).toHaveLength(2)
    expect(svgs[0]!.getAttribute('data-mood')).toBe('idle')
    expect(svgs[1]!.getAttribute('data-mood')).toBe('thinking')

    const defIds = [...container.querySelectorAll('defs [id]')].map((el) => el.id)
    expect(new Set(defIds).size).toBe(defIds.length)

    // Assert every distinct mood renders cleanly
    const moods: AiPetMood[] = [
      'idle',
      'curious',
      'sleepy',
      'hover',
      'petted',
      'dragging',
      'settle',
      'thinking',
      'working',
      'unread-done',
      'attention',
      'error',
    ]
    for (const mood of moods) {
      const oneHtml = renderToStaticMarkup(createElement(MascotSvg, { mood }))
      const box = document.createElement('div')
      box.innerHTML = oneHtml
      const svg = box.querySelector('svg')!
      expect(svg.getAttribute('data-mood')).toBe(mood)
      if (mood === 'sleepy') {
        expect(box.querySelector('.ai-mascot-eyes-closed')).not.toBeNull()
        expect(box.querySelector('.ai-mascot-badge-zzz')).not.toBeNull()
      } else if (mood === 'petted') {
        expect(box.querySelector('.ai-mascot-eyes-happy')).not.toBeNull()
      } else {
        expect(box.querySelectorAll('.ai-mascot-iris-group')).toHaveLength(2)
      }
      if (mood === 'attention') {
        expect(box.querySelector('.ai-mascot-badge-attention')).not.toBeNull()
      }
      if (mood === 'error') {
        expect(box.querySelector('.ai-mascot-badge-error')).not.toBeNull()
        expect(box.querySelectorAll('.ai-mascot-brow')).toHaveLength(2)
      }
    }

    // Decorative hello mode suppresses notification micro-badges
    const decoHtml = renderToStaticMarkup(
      createElement(MascotSvg, { mood: 'thinking', decorative: true }),
    )
    const decoBox = document.createElement('div')
    decoBox.innerHTML = decoHtml
    expect(decoBox.querySelector('.ai-mascot-badge')).toBeNull()
  })
})

describe('useAiPetBehavior interactions and bubble timers', () => {
  interface HarnessProps {
    readonly collapsed?: boolean
    readonly dragging?: boolean
    readonly runState?: AiPetRunSnapshot
    readonly reducedMotion?: boolean
    readonly windowGaze?: boolean
    readonly onInteract?: (kind: AiPetInteractionKind) => void
  }

  let host: HTMLDivElement
  let root: Root
  let hook!: UseAiPetBehaviorResult

  function Harness({
    collapsed = true,
    dragging = false,
    runState = IDLE_PET_RUN_SNAPSHOT,
    reducedMotion = false,
    windowGaze = false,
    onInteract,
  }: HarnessProps): React.JSX.Element {
    const petRef = useRef<HTMLDivElement | null>(null)
    hook = useAiPetBehavior({
      collapsed,
      dragging,
      runState,
      reducedMotion,
      petRef,
      windowGaze,
      onInteract,
    })
    return createElement('div', { ref: petRef })
  }

  const mountHarness = (props: HarnessProps = {}): void => {
    act(() => {
      root.render(createElement(Harness, props))
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    host.remove()
    vi.useRealTimers()
  })

  it('triggers pet, feed, and play moods with bubbles, wake-up, mutual exclusion, and expiry', () => {
    const onInteract = vi.fn<(kind: AiPetInteractionKind) => void>()
    mountHarness({ onInteract })

    // Put the pet to sleep first, then verify triggerPet wakes it up
    act(() => {
      hook.toggleManualSleep()
    })
    expect(hook.isSleeping).toBe(true)
    expect(hook.mood).toBe('sleepy')

    act(() => {
      hook.triggerPet()
    })
    expect(hook.isSleeping).toBe(false)
    expect(hook.mood).toBe('petted')
    expect(hook.activeBubble).toBe('pet')
    expect(onInteract).toHaveBeenLastCalledWith('pet')

    act(() => {
      vi.advanceTimersByTime(PET_PETTED_HOLD_MS)
    })
    expect(hook.mood).toBe('idle')
    expect(hook.activeBubble).toBe('pet')

    act(() => {
      vi.advanceTimersByTime(PET_BUBBLE_HOLD_MS - PET_PETTED_HOLD_MS)
    })
    expect(hook.activeBubble).toBeNull()

    // Feed wakes sleeping pet and clears conflicting playful state
    act(() => {
      hook.triggerPlay()
    })
    expect(hook.mood).toBe('playful')
    expect(hook.activeBubble).toBe('play')
    expect(onInteract).toHaveBeenLastCalledWith('play')

    act(() => {
      hook.triggerFeed()
    })
    expect(hook.mood).toBe('fed')
    expect(hook.activeBubble).toBe('feed')
    expect(onInteract).toHaveBeenLastCalledWith('feed')

    act(() => {
      vi.advanceTimersByTime(PET_FED_HOLD_MS - 1)
    })
    expect(hook.mood).toBe('fed')
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(hook.mood).toBe('idle')
    expect(hook.activeBubble).toBe('feed')

    // Play clears conflicting fed state and settles after PET_PLAYFUL_HOLD_MS
    act(() => {
      hook.triggerFeed()
      hook.triggerPlay()
    })
    expect(hook.mood).toBe('playful')
    expect(hook.activeBubble).toBe('play')

    act(() => {
      vi.advanceTimersByTime(PET_PLAYFUL_HOLD_MS)
    })
    expect(hook.mood).toBe('idle')
    expect(hook.activeBubble).toBe('play')

    act(() => {
      vi.advanceTimersByTime(PET_BUBBLE_HOLD_MS - PET_PLAYFUL_HOLD_MS)
    })
    expect(hook.activeBubble).toBeNull()
  })

  it('shares the triggerPet path when pointer rubbing completes', () => {
    const onInteract = vi.fn<(kind: AiPetInteractionKind) => void>()
    mountHarness({ onInteract })

    act(() => {
      hook.toggleManualSleep()
    })
    expect(hook.isSleeping).toBe(true)

    let x = 10
    let t = 1000
    act(() => {
      for (let i = 0; i < 4; i += 1) {
        x += i % 2 === 0 ? 22 : -22
        t += 35
        hook.onPointerMove({
          clientX: x,
          clientY: 12,
          timeStamp: t,
        } as unknown as ReactPointerEvent<HTMLElement>)
      }
    })

    expect(hook.isSleeping).toBe(false)
    expect(hook.mood).toBe('petted')
    expect(hook.activeBubble).toBe('pet')
    expect(onInteract).toHaveBeenCalledTimes(1)
    expect(onInteract).toHaveBeenCalledWith('pet')
  })

  it('clears interaction states and timers on dragging, drawer expand, and manual sleep', () => {
    const onInteract = vi.fn<(kind: AiPetInteractionKind) => void>()
    mountHarness({ onInteract })

    // 1. Clearing on dragging = true
    act(() => {
      hook.triggerFeed()
    })
    expect(hook.mood).toBe('fed')
    expect(hook.activeBubble).toBe('feed')

    mountHarness({ dragging: true, onInteract })
    expect(hook.mood).toBe('dragging')
    expect(hook.activeBubble).toBeNull()

    mountHarness({ dragging: false, onInteract })
    expect(hook.mood).toBe('idle')
    expect(hook.activeBubble).toBeNull()

    // 2. Clearing on !collapsed expand
    act(() => {
      hook.triggerPlay()
    })
    expect(hook.mood).toBe('playful')
    expect(hook.activeBubble).toBe('play')

    mountHarness({ collapsed: false, onInteract })
    expect(hook.mood).toBe('idle')
    expect(hook.activeBubble).toBeNull()

    mountHarness({ collapsed: true, onInteract })
    expect(hook.mood).toBe('idle')

    // 3. Clearing on toggleManualSleep
    act(() => {
      hook.triggerFeed()
    })
    expect(hook.mood).toBe('fed')
    expect(hook.activeBubble).toBe('feed')

    act(() => {
      hook.toggleManualSleep()
    })
    expect(hook.isSleeping).toBe(true)
    expect(hook.mood).toBe('sleepy')
    expect(hook.activeBubble).toBeNull()
  })

  it('preserves active interaction timers across onInteract callback identity changes', () => {
    const first = vi.fn<(kind: AiPetInteractionKind) => void>()
    const second = vi.fn<(kind: AiPetInteractionKind) => void>()

    mountHarness({ onInteract: first })
    const triggerRef = hook.triggerFeed

    act(() => {
      hook.triggerFeed()
    })
    expect(first).toHaveBeenCalledWith('feed')

    // Re-render with a new callback reference midway through the hold window
    act(() => {
      vi.advanceTimersByTime(500)
    })
    mountHarness({ onInteract: second })
    expect(hook.triggerFeed).toBe(triggerRef)
    expect(hook.mood).toBe('fed')
    expect(hook.activeBubble).toBe('feed')

    act(() => {
      vi.advanceTimersByTime(PET_FED_HOLD_MS - 500)
    })
    expect(hook.mood).toBe('idle')

    act(() => {
      hook.triggerPlay()
    })
    expect(second).toHaveBeenCalledWith('play')
    expect(first).toHaveBeenCalledTimes(1)
  })
})

describe('ai-pet-sound synthesizer and tonal profiles', () => {
  const originalAudioContext = (window as unknown as { AudioContext?: unknown }).AudioContext
  const originalWebkitAudioContext = (window as unknown as { webkitAudioContext?: unknown })
    .webkitAudioContext

  afterEach(() => {
    ;(window as unknown as { AudioContext?: unknown }).AudioContext = originalAudioContext
    ;(window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext =
      originalWebkitAudioContext
  })

  it('defines distinct, short (<= 0.25s), ultra-quiet (<= 0.045) profiles per pet and kind', () => {
    const kinds: readonly AiPetSoundKind[] = ['pet', 'feed', 'play', 'select']
    const petSignatures = new Set<string>()

    for (const petId of AI_PET_IDS) {
      const kindSignatures = new Set<string>()
      for (const kind of kinds) {
        const profile = petSoundProfile(petId, kind)
        expect(profile.petId).toBe(petId)
        expect(profile.kind).toBe(kind)
        expect(profile.notes.length).toBeGreaterThan(0)

        for (const note of profile.notes) {
          expect(note.freq).toBeGreaterThan(0)
          expect(note.startOffsetSec).toBeGreaterThanOrEqual(0)
          expect(note.durationSec).toBeGreaterThan(0)
          expect(note.startOffsetSec + note.durationSec).toBeLessThanOrEqual(0.25)
          expect(note.gain).toBeGreaterThan(0)
          expect(note.gain).toBeLessThanOrEqual(0.045)
          if (note.slideTo !== undefined) {
            expect(note.slideTo).toBeGreaterThan(0)
          }
        }

        // Check concurrent peak gain across overlapping notes (e.g. panda chords)
        for (const probe of profile.notes) {
          const t = probe.startOffsetSec + 0.001
          const concurrentGain = profile.notes
            .filter((n) => n.startOffsetSec <= t && n.startOffsetSec + n.durationSec > t)
            .reduce((sum, n) => sum + n.gain, 0)
          expect(concurrentGain).toBeLessThanOrEqual(0.045)
        }

        kindSignatures.add(JSON.stringify({ waveform: profile.waveform, notes: profile.notes }))
      }
      // Every kind within a pet has a distinct profile
      expect(kindSignatures.size).toBe(kinds.length)
      petSignatures.add(
        JSON.stringify(kinds.map((kind) => petSoundProfile(petId, kind))),
      )
    }

    // All 5 pets have distinct overall tonal signatures
    expect(petSignatures.size).toBe(AI_PET_IDS.length)
  })

  it('is a safe no-op when disabled, reducedMotion is true, or AudioContext is absent', () => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext
    delete (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext

    expect(() => playPetSound('bluebird', 'pet')).not.toThrow()
    expect(() => playPetSound('robot', 'play', { enabled: false })).not.toThrow()
    expect(() => playPetSound('panda', 'feed', { reducedMotion: true })).not.toThrow()
  })

  it('schedules Web Audio oscillators safely with a lazy singleton context', () => {
    const instances: MockAudioContext[] = []

    class MockAudioContext {
      state: AudioContextState = 'suspended'
      currentTime = 1.5
      destination = {}
      resume = vi.fn(() => Promise.resolve())
      oscillators: Array<{
        type: OscillatorType
        frequency: {
          setValueAtTime: ReturnType<typeof vi.fn>
          exponentialRampToValueAtTime: ReturnType<typeof vi.fn>
        }
        connect: ReturnType<typeof vi.fn>
        start: ReturnType<typeof vi.fn>
        stop: ReturnType<typeof vi.fn>
      }> = []
      gains: Array<{
        gain: {
          setValueAtTime: ReturnType<typeof vi.fn>
          linearRampToValueAtTime: ReturnType<typeof vi.fn>
          exponentialRampToValueAtTime: ReturnType<typeof vi.fn>
        }
        connect: ReturnType<typeof vi.fn>
      }> = []

      constructor() {
        instances.push(this)
      }

      createOscillator() {
        const osc = {
          type: 'sine' as OscillatorType,
          frequency: {
            setValueAtTime: vi.fn(),
            exponentialRampToValueAtTime: vi.fn(),
          },
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
        }
        this.oscillators.push(osc)
        return osc
      }

      createGain() {
        const gain = {
          gain: {
            setValueAtTime: vi.fn(),
            linearRampToValueAtTime: vi.fn(),
            exponentialRampToValueAtTime: vi.fn(),
          },
          connect: vi.fn(),
        }
        this.gains.push(gain)
        return gain
      }
    }

    ;(window as unknown as { AudioContext?: unknown }).AudioContext = MockAudioContext

    // Disabled / reducedMotion still skips creating AudioContext
    playPetSound('bluebird', 'pet', { enabled: false })
    playPetSound('bluebird', 'pet', { reducedMotion: true })
    expect(instances).toHaveLength(0)

    const robotProfile = petSoundProfile('robot', 'play')
    playPetSound('robot', 'play')
    expect(instances).toHaveLength(1)
    const ctx = instances[0]!
    expect(ctx.resume).toHaveBeenCalledTimes(1)
    expect(ctx.oscillators).toHaveLength(robotProfile.notes.length)
    expect(ctx.gains).toHaveLength(robotProfile.notes.length)
    for (let i = 0; i < robotProfile.notes.length; i += 1) {
      const osc = ctx.oscillators[i]!
      const gain = ctx.gains[i]!
      const note = robotProfile.notes[i]!
      expect(osc.type).toBe('square')
      expect(osc.frequency.setValueAtTime).toHaveBeenCalledWith(note.freq, 1.5 + note.startOffsetSec)
      expect(osc.connect).toHaveBeenCalledWith(gain)
      expect(gain.connect).toHaveBeenCalledWith(ctx.destination)
      expect(gain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(
        note.gain,
        expect.any(Number),
      )
      expect(osc.start).toHaveBeenCalledWith(1.5 + note.startOffsetSec)
      expect(osc.stop).toHaveBeenCalledWith(1.5 + note.startOffsetSec + note.durationSec)
    }

    // Subsequent call reuses the same singleton AudioContext
    playPetSound('fox', 'select')
    expect(instances).toHaveLength(1)
    expect(ctx.oscillators).toHaveLength(
      robotProfile.notes.length + petSoundProfile('fox', 'select').notes.length,
    )

    // Throwing AudioContext constructor is swallowed gracefully
    delete (window as unknown as { AudioContext?: unknown }).AudioContext
    ;(window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext = function () {
      throw new Error('Autoplay blocked')
    }
    expect(() => playPetSound('cat', 'pet')).not.toThrow()
  })

  it('matches all expected pet IDs cleanly', () => {
    const ids: readonly AiPetId[] = AI_PET_IDS
    expect(ids).toEqual(['bluebird', 'cat', 'robot', 'fox', 'panda'])
  })
})
