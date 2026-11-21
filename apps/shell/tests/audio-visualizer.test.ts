import { describe, expect, it } from 'vitest'
import {
  VINYL_HALO_BAR_COUNT,
  computeLogSpectrum,
  deriveTrackPalette,
  findActiveLyricIndex,
  updatePeakCaps,
} from '../src/renderer/src/audio-visualizer'

describe('audio-visualizer acoustic engine', () => {
  it('maps wide-band FFT energy evenly across logarithmic perceptual bands without NaN or clipping', () => {
    const fft = new Uint8Array(128)
    // Inject low bass (bin 2), mid (bin 16), and high-mid harmonic (bin 64)
    fft[2] = 220
    fft[16] = 180
    fft[64] = 160

    const { bars, bassEnergy } = computeLogSpectrum(fft, VINYL_HALO_BAR_COUNT)
    expect(bars).toHaveLength(VINYL_HALO_BAR_COUNT)
    expect(bassEnergy).toBeGreaterThan(0.1)
    expect(bassEnergy).toBeLessThanOrEqual(1)

    for (let i = 0; i < bars.length; i += 1) {
      expect(Number.isFinite(bars[i])).toBe(true)
      expect(bars[i]!).toBeGreaterThanOrEqual(0)
      expect(bars[i]!).toBeLessThanOrEqual(1)
    }

    // High band should stay active rather than flattened to zero
    const upperThirdMax = Math.max(...Array.from(bars.slice(48)))
    expect(upperThirdMax).toBeGreaterThan(0.15)
  })

  it('smoothly accelerates peak-hold caps downward under gravity', () => {
    const bars = new Float32Array([0.9, 0.2])
    const peaks = new Float32Array([0.5, 0.8])
    const vels = new Float32Array([0, 0])

    updatePeakCaps(bars, peaks, vels, 0.05)
    expect(peaks[0]).toBeCloseTo(0.9, 5) // Snaps up immediately
    expect(peaks[1]!).toBeLessThan(0.8) // Falls softly under gravity
    expect(peaks[1]!).toBeGreaterThanOrEqual(0.2)
  })

  it('derives deterministic dual-accent palettes and resolves active lyrics by binary search', () => {
    const p1 = deriveTrackPalette('Twilight Echo', false)
    const p2 = deriveTrackPalette('Twilight Echo', false)
    const pDark = deriveTrackPalette('Twilight Echo', true)
    expect(p1).toEqual(p2)
    expect(p1.primary).not.toBe(pDark.primary)

    const lines = [
      { timeSec: 2, text: 'Line 1' },
      { timeSec: 6, text: 'Line 2' },
      { timeSec: 12, text: 'Line 3' },
    ]
    expect(findActiveLyricIndex(lines, 0.5)).toBe(-1)
    expect(findActiveLyricIndex(lines, 2.1)).toBe(0)
    expect(findActiveLyricIndex(lines, 7.4)).toBe(1)
    expect(findActiveLyricIndex(lines, 99)).toBe(2)
  })
})
