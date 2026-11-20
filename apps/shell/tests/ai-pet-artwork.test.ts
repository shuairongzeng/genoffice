// @vitest-environment jsdom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AI_PET_IDS, type AiPetId } from '../src/shared/ai-pet-prefs'
import { MascotSvg, type MascotMood } from '../src/renderer/src/AiMascot'
import { AI_PET_CATALOG, petMetaFor } from '../src/renderer/src/ai-pet-catalog'
import { translate } from '../src/renderer/src/strings'

/**
 * Unit and geometry specs for all 5 AI companion vector pets (`AiMascot.tsx`,
 * `ai-pet-catalog.ts`, `ai-pet-artwork.css`): catalog integrity, multi-instance
 * gradient ID isolation, species-specific anatomy across all 14 moods, bluebird
 * backward compatibility, and strict [3..69, 3..61] safe-box SVG bounds.
 */

const ALL_MOODS: readonly MascotMood[] = [
  'idle',
  'curious',
  'sleepy',
  'hover',
  'petted',
  'fed',
  'playful',
  'dragging',
  'settle',
  'thinking',
  'working',
  'unread-done',
  'attention',
  'error',
]

const STATUS_BADGE_MOODS: readonly MascotMood[] = [
  'thinking',
  'working',
  'unread-done',
  'attention',
  'error',
  'sleepy',
]

interface Bounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

function expandBounds(bounds: Bounds, x: number, y: number): void {
  expect(Number.isFinite(x)).toBe(true)
  expect(Number.isFinite(y)).toBe(true)
  bounds.minX = Math.min(bounds.minX, x)
  bounds.maxX = Math.max(bounds.maxX, x)
  bounds.minY = Math.min(bounds.minY, y)
  bounds.maxY = Math.max(bounds.maxY, y)
}

function parseTranslateOffset(el: Element): { tx: number; ty: number } {
  let tx = 0
  let ty = 0
  let cur: Element | null = el
  while (cur && cur.tagName.toLowerCase() !== 'svg') {
    const transform = cur.getAttribute('transform')
    if (transform) {
      const match = /translate\(\s*([-+]?(?:\d*\.\d+|\d+))[\s,]+([-+]?(?:\d*\.\d+|\d+))\s*\)/.exec(
        transform,
      )
      if (match) {
        tx += Number(match[1])
        ty += Number(match[2])
      }
    }
    cur = cur.parentElement
  }
  return { tx, ty }
}

function recordPathBounds(d: string, tx: number, ty: number, bounds: Bounds): void {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? []
  let idx = 0
  let cmd = ''
  let curX = 0
  let curY = 0
  let startX = 0
  let startY = 0

  const nextNum = (): number => {
    const val = Number(tokens[idx])
    idx += 1
    return val
  }

  while (idx < tokens.length) {
    const tok = tokens[idx]!
    if (/^[a-zA-Z]$/.test(tok)) {
      cmd = tok
      idx += 1
      if (cmd === 'Z' || cmd === 'z') {
        curX = startX
        curY = startY
      }
      continue
    }

    const rel = cmd === cmd.toLowerCase()
    const upper = cmd.toUpperCase()
    const ox = rel ? curX : 0
    const oy = rel ? curY : 0

    switch (upper) {
      case 'M': {
        const x = ox + nextNum()
        const y = oy + nextNum()
        curX = x
        curY = y
        startX = x
        startY = y
        expandBounds(bounds, x + tx, y + ty)
        cmd = rel ? 'l' : 'L'
        break
      }
      case 'L':
      case 'T': {
        const x = ox + nextNum()
        const y = oy + nextNum()
        curX = x
        curY = y
        expandBounds(bounds, x + tx, y + ty)
        break
      }
      case 'H': {
        const x = ox + nextNum()
        curX = x
        expandBounds(bounds, x + tx, curY + ty)
        break
      }
      case 'V': {
        const y = oy + nextNum()
        curY = y
        expandBounds(bounds, curX + tx, y + ty)
        break
      }
      case 'C': {
        const x1 = ox + nextNum()
        const y1 = oy + nextNum()
        const x2 = ox + nextNum()
        const y2 = oy + nextNum()
        const x = ox + nextNum()
        const y = oy + nextNum()
        expandBounds(bounds, x1 + tx, y1 + ty)
        expandBounds(bounds, x2 + tx, y2 + ty)
        expandBounds(bounds, x + tx, y + ty)
        curX = x
        curY = y
        break
      }
      case 'S':
      case 'Q': {
        const x1 = ox + nextNum()
        const y1 = oy + nextNum()
        const x = ox + nextNum()
        const y = oy + nextNum()
        expandBounds(bounds, x1 + tx, y1 + ty)
        expandBounds(bounds, x + tx, y + ty)
        curX = x
        curY = y
        break
      }
      case 'A': {
        nextNum() // rx
        nextNum() // ry
        nextNum() // rotation
        nextNum() // largeArc
        nextNum() // sweep
        const x = ox + nextNum()
        const y = oy + nextNum()
        expandBounds(bounds, x + tx, y + ty)
        curX = x
        curY = y
        break
      }
      default: {
        throw new Error(`Unsupported SVG path command "${cmd}" in: ${d}`)
      }
    }
  }
}

function measureSvgGeometryBounds(svg: SVGElement): Bounds {
  const bounds: Bounds = {
    minX: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  }

  for (const el of svg.querySelectorAll('circle, ellipse, rect, line, path')) {
    const { tx, ty } = parseTranslateOffset(el)
    const tag = el.tagName.toLowerCase()

    if (tag === 'circle') {
      const cx = Number(el.getAttribute('cx') ?? 0) + tx
      const cy = Number(el.getAttribute('cy') ?? 0) + ty
      const r = Number(el.getAttribute('r') ?? 0)
      expandBounds(bounds, cx - r, cy - r)
      expandBounds(bounds, cx + r, cy + r)
    } else if (tag === 'ellipse') {
      const cx = Number(el.getAttribute('cx') ?? 0) + tx
      const cy = Number(el.getAttribute('cy') ?? 0) + ty
      const rx = Number(el.getAttribute('rx') ?? 0)
      const ry = Number(el.getAttribute('ry') ?? 0)
      expandBounds(bounds, cx - rx, cy - ry)
      expandBounds(bounds, cx + rx, cy + ry)
    } else if (tag === 'rect') {
      const x = Number(el.getAttribute('x') ?? 0) + tx
      const y = Number(el.getAttribute('y') ?? 0) + ty
      const width = Number(el.getAttribute('width') ?? 0)
      const height = Number(el.getAttribute('height') ?? 0)
      expandBounds(bounds, x, y)
      expandBounds(bounds, x + width, y + height)
    } else if (tag === 'line') {
      const x1 = Number(el.getAttribute('x1') ?? 0) + tx
      const y1 = Number(el.getAttribute('y1') ?? 0) + ty
      const x2 = Number(el.getAttribute('x2') ?? 0) + tx
      const y2 = Number(el.getAttribute('y2') ?? 0) + ty
      expandBounds(bounds, x1, y1)
      expandBounds(bounds, x2, y2)
    } else if (tag === 'path') {
      const d = el.getAttribute('d')
      if (d) recordPathBounds(d, tx, ty, bounds)
    }
  }

  return bounds
}

function renderMascot(
  petId: AiPetId,
  mood: MascotMood,
  decorative = false,
): { box: HTMLDivElement; svg: SVGElement } {
  const html = renderToStaticMarkup(createElement(MascotSvg, { petId, mood, decorative }))
  const box = document.createElement('div')
  box.innerHTML = html
  const svg = box.querySelector('svg')!
  return { box, svg }
}

describe('ai-pet-catalog', () => {
  it('lists all 5 AI_PET_IDS in order with complete i18n keys', () => {
    expect(AI_PET_CATALOG.map((item) => item.id)).toEqual([...AI_PET_IDS])
    expect(AI_PET_CATALOG).toHaveLength(5)

    for (const id of AI_PET_IDS) {
      const meta = petMetaFor(id)
      expect(meta.id).toBe(id)

      const keys = [
        meta.nameKey,
        meta.tagKey,
        meta.descKey,
        meta.helloKey,
        meta.lineKeys.pet,
        meta.lineKeys.feed,
        meta.lineKeys.play,
      ]
      for (const key of keys) {
        const enText = translate('en', key)
        const zhText = translate('zh', key)
        expect(enText).not.toBe(key)
        expect(zhText).not.toBe(key)
        expect(enText.trim().length).toBeGreaterThan(0)
        expect(zhText.trim().length).toBeGreaterThan(0)
      }
    }
  })
})

describe('MascotSvg multi-pet artwork', () => {
  it('renders all 5 species simultaneously with unique <defs> IDs and species rigs', () => {
    const html = renderToStaticMarkup(
      createElement(
        'div',
        null,
        ...AI_PET_IDS.map((petId) => createElement(MascotSvg, { key: petId, petId, mood: 'idle' })),
      ),
    )
    const container = document.createElement('div')
    container.innerHTML = html

    const svgs = [...container.querySelectorAll('svg')]
    expect(svgs).toHaveLength(AI_PET_IDS.length)
    expect(svgs.map((svg) => svg.getAttribute('data-pet'))).toEqual([...AI_PET_IDS])

    const defIds = [...container.querySelectorAll('defs [id]')].map((el) => el.id)
    expect(defIds.length).toBeGreaterThan(AI_PET_IDS.length)
    expect(new Set(defIds).size).toBe(defIds.length)

    // Verify each species owns distinct silhouette rig elements
    expect(svgs[0]!.querySelector('.ai-mascot-tuft-group')).not.toBeNull()
    expect(svgs[1]!.querySelector('.ai-pet-cat-tail')).not.toBeNull()
    expect(svgs[1]!.querySelector('.ai-pet-cat-ear-l')).not.toBeNull()
    expect(svgs[2]!.querySelector('.ai-pet-robot-visor')).not.toBeNull()
    expect(svgs[2]!.querySelector('.ai-pet-robot-antenna')).not.toBeNull()
    expect(svgs[3]!.querySelector('.ai-pet-fox-tail')).not.toBeNull()
    expect(svgs[3]!.querySelector('.ai-pet-fox-ear-r')).not.toBeNull()
    expect(svgs[4]!.querySelector('.ai-pet-panda-bamboo')).not.toBeNull()
    expect(svgs[4]!.querySelector('.ai-pet-panda-ear-l')).not.toBeNull()
  })

  it('preserves all backward-compatible bluebird selectors', () => {
    const sleepy = renderMascot('bluebird', 'sleepy')
    expect(sleepy.box.querySelector('.ai-mascot-body-rig')).not.toBeNull()
    expect(sleepy.box.querySelector('.ai-mascot-eyes-closed')).not.toBeNull()
    expect(sleepy.box.querySelector('.ai-mascot-badge-zzz')).not.toBeNull()

    const petted = renderMascot('bluebird', 'petted')
    expect(petted.box.querySelector('.ai-mascot-eyes-happy')).not.toBeNull()

    const attention = renderMascot('bluebird', 'attention')
    expect(attention.box.querySelector('.ai-mascot-aura')).not.toBeNull()
    expect(attention.box.querySelector('.ai-mascot-badge-attention')).not.toBeNull()

    const error = renderMascot('bluebird', 'error')
    expect(error.box.querySelector('.ai-mascot-badge-error')).not.toBeNull()
    expect(error.box.querySelectorAll('.ai-mascot-brow')).toHaveLength(2)

    const idle = renderMascot('bluebird', 'idle')
    expect(idle.box.querySelectorAll('.ai-mascot-iris-group')).toHaveLength(2)
  })

  it('renders all 5 pets across all 14 moods with distinct visuals and safe badges', () => {
    for (const petId of AI_PET_IDS) {
      for (const mood of ALL_MOODS) {
        const { box, svg } = renderMascot(petId, mood, false)
        expect(svg.getAttribute('data-pet')).toBe(petId)
        expect(svg.getAttribute('data-mood')).toBe(mood)
        expect(svg.getAttribute('data-decorative')).toBeNull()
        expect(svg.getAttribute('viewBox')).toBe('0 0 72 64')
        expect(svg.getAttribute('width')).toBe('56')
        expect(svg.getAttribute('height')).toBe('50')

        if (mood === 'sleepy') {
          expect(box.querySelector('.ai-mascot-eyes-closed')).not.toBeNull()
          expect(box.querySelector('.ai-mascot-badge-zzz')).not.toBeNull()
          if (petId === 'cat') {
            expect(box.querySelector('.ai-pet-cat-bubble')).not.toBeNull()
          }
        } else if (mood === 'petted') {
          expect(box.querySelector('.ai-mascot-eyes-happy')).not.toBeNull()
        } else {
          expect(box.querySelectorAll('.ai-mascot-iris-group')).toHaveLength(2)
        }

        if (mood === 'fed') {
          expect(box.querySelector('.ai-pet-particles-fed')).not.toBeNull()
        }
        if (mood === 'playful') {
          expect(box.querySelector('.ai-pet-particles-playful')).not.toBeNull()
        }
        if (mood === 'error') {
          expect(box.querySelector('.ai-mascot-badge-error')).not.toBeNull()
          expect(box.querySelectorAll('.ai-mascot-brow')).toHaveLength(2)
        }

        if (STATUS_BADGE_MOODS.includes(mood)) {
          expect(box.querySelector('.ai-mascot-badge')).not.toBeNull()
        } else {
          expect(box.querySelector('.ai-mascot-badge')).toBeNull()
        }

        const deco = renderMascot(petId, mood, true)
        expect(deco.svg.getAttribute('data-decorative')).toBe('true')
        expect(deco.box.querySelector('.ai-mascot-badge')).toBeNull()
        expect(deco.box.querySelector('.ai-mascot-aura')).toBeNull()
      }
    }
  })

  it('keeps static SVG geometry strictly inside the [2.5..69.5, 2.5..61.5] safe box', () => {
    for (const petId of AI_PET_IDS) {
      for (const mood of ALL_MOODS) {
        const { svg } = renderMascot(petId, mood, false)
        const bounds = measureSvgGeometryBounds(svg)
        expect(
          bounds.minX,
          `${petId}/${mood} minX (${bounds.minX}) clipped left safe bound`,
        ).toBeGreaterThanOrEqual(2.5)
        expect(
          bounds.maxX,
          `${petId}/${mood} maxX (${bounds.maxX}) clipped right safe bound`,
        ).toBeLessThanOrEqual(69.5)
        expect(
          bounds.minY,
          `${petId}/${mood} minY (${bounds.minY}) clipped top safe bound`,
        ).toBeGreaterThanOrEqual(2.5)
        expect(
          bounds.maxY,
          `${petId}/${mood} maxY (${bounds.maxY}) clipped bottom safe bound`,
        ).toBeLessThanOrEqual(61.5)
      }
    }
  })
})
