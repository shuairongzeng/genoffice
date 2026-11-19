// @vitest-environment jsdom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MascotSvg } from '../src/renderer/src/AiMascot'
import {
  advancePettingEnergy,
  computeDragTilt,
  computePetGaze,
  PET_DRAG_TILT_MAX_DEG,
  resolvePetMood,
  type AiPetMood,
  type PettingTracker,
} from '../src/renderer/src/ai-pet-state'

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
