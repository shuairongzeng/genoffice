import type { MediaLyricLine, MediaVisualizerMode } from '../../shared/home-api'

export interface AudioStagePalette {
  primary: string
  secondary: string
  glow: string
  glowSoft: string
}

export interface AudioVisualizerRenderState {
  bars: Float32Array
  peaks: Float32Array
  timeData: Uint8Array | null
  bassEnergy: number
  phase: number
  playing: boolean
  isDark: boolean
  palette: AudioStagePalette
}

export const VINYL_HALO_BAR_COUNT = 72
export const MIRROR_BAR_COUNT = 48

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function hashString(input: string): number {
  let h = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function paletteFromHue(hue: number, isDark: boolean): AudioStagePalette {
  const h1 = ((Math.round(hue) % 360) + 360) % 360
  const h2 = (h1 + 48) % 360
  if (isDark) {
    return {
      primary: `hsl(${h1} 88% 64%)`,
      secondary: `hsl(${h2} 90% 68%)`,
      glow: `hsla(${h1} 92% 62% / 0.42)`,
      glowSoft: `hsla(${h2} 90% 64% / 0.18)`,
    }
  }
  return {
    primary: `hsl(${h1} 82% 46%)`,
    secondary: `hsl(${h2} 78% 50%)`,
    glow: `hsla(${h1} 85% 48% / 0.28)`,
    glowSoft: `hsla(${h2} 80% 52% / 0.14)`,
  }
}

/** Derive a harmonious dual-accent stage palette deterministically from track title/path. */
export function deriveTrackPalette(seed: string, isDark: boolean): AudioStagePalette {
  const clean = seed.trim() || 'genoffice-audio'
  const hue = hashString(clean) % 360
  return paletteFromHue(hue, isDark)
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0)
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  return { h: h * 60, s, l }
}

/** Extract dominant dual-accent colors from cover artwork, returning null if neutral or unreadable. */
export function extractPaletteFromImage(
  img: HTMLImageElement,
  isDark: boolean,
): AudioStagePalette | null {
  if (typeof document === 'undefined' || !img.complete || img.naturalWidth <= 0) return null
  try {
    const sampleSize = 24
    const canvas = document.createElement('canvas')
    canvas.width = sampleSize
    canvas.height = sampleSize
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, sampleSize, sampleSize)
    const { data } = ctx.getImageData(0, 0, sampleSize, sampleSize)

    const buckets = new Float32Array(12)
    let saturatedWeight = 0
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3] ?? 255
      if (a < 128) continue
      const r = data[i] ?? 0
      const g = data[i + 1] ?? 0
      const b = data[i + 2] ?? 0
      const { h, s, l } = rgbToHsl(r, g, b)
      if (s < 0.22 || l < 0.1 || l > 0.92) continue
      const bucket = Math.min(11, Math.floor((h % 360) / 30))
      const weight = s * (1 - Math.abs(l - 0.5))
      buckets[bucket]! += weight
      saturatedWeight += weight
    }
    if (saturatedWeight <= 0.15) return null

    let bestIdx = 0
    for (let i = 1; i < buckets.length; i += 1) {
      if (buckets[i]! > buckets[bestIdx]!) bestIdx = i
    }
    let secondIdx = (bestIdx + 2) % 12
    let secondScore = -1
    for (let i = 0; i < buckets.length; i += 1) {
      const dist = Math.min(Math.abs(i - bestIdx), 12 - Math.abs(i - bestIdx))
      if (dist >= 2 && buckets[i]! > secondScore) {
        secondScore = buckets[i]!
        secondIdx = i
      }
    }

    const h1 = bestIdx * 30 + 15
    const h2 = secondScore > buckets[bestIdx]! * 0.28 ? secondIdx * 30 + 15 : (h1 + 48) % 360
    if (isDark) {
      return {
        primary: `hsl(${h1} 88% 64%)`,
        secondary: `hsl(${h2} 90% 68%)`,
        glow: `hsla(${h1} 92% 62% / 0.44)`,
        glowSoft: `hsla(${h2} 90% 64% / 0.20)`,
      }
    }
    return {
      primary: `hsl(${h1} 82% 46%)`,
      secondary: `hsl(${h2} 78% 50%)`,
      glow: `hsla(${h1} 85% 48% / 0.28)`,
      glowSoft: `hsla(${h2} 80% 52% / 0.14)`,
    }
  } catch {
    return null
  }
}

/** Map linear FFT bins onto perceptual logarithmic frequency bands with pink-noise tilt balance. */
export function computeLogSpectrum(
  freqData: Uint8Array,
  barCount: number,
  prevBars?: Float32Array,
): { bars: Float32Array; bassEnergy: number } {
  const out = new Float32Array(barCount)
  const binCount = freqData.length
  if (binCount === 0 || barCount <= 0) {
    return { bars: out, bassEnergy: 0 }
  }

  // Emphasize sub-bass / kick bins 1..5 for stage breathing motion.
  const bassEnd = Math.min(binCount, 6)
  let bassSum = 0
  let bassCount = 0
  for (let i = 1; i < bassEnd; i += 1) {
    bassSum += (freqData[i] ?? 0) / 255
    bassCount += 1
  }
  if (bassCount === 0) {
    bassSum = (freqData[0] ?? 0) / 255
    bassCount = 1
  }
  const bassEnergy = clamp01(bassSum / bassCount)

  const usableBins = Math.max(2, Math.floor(binCount * 0.68))
  const minLog = Math.log2(1)
  const maxLog = Math.log2(usableBins)

  for (let i = 0; i < barCount; i += 1) {
    const t0 = i / barCount
    const t1 = (i + 1) / barCount
    const startF = Math.pow(2, minLog + (maxLog - minLog) * t0)
    const endF = Math.pow(2, minLog + (maxLog - minLog) * t1)
    const b0 = Math.min(binCount - 1, Math.max(0, Math.floor(startF)))
    const b1 = Math.min(binCount - 1, Math.max(b0, Math.ceil(endF)))

    let peak = 0
    let sum = 0
    const span = b1 - b0 + 1
    for (let b = b0; b <= b1; b += 1) {
      const v = (freqData[b] ?? 0) / 255
      if (v > peak) peak = v
      sum += v
    }
    const raw = peak * 0.65 + (sum / span) * 0.35
    // Gentle high-frequency perceptual boost so mids and highs stay lively without clipping lows.
    const gain = 0.82 + 0.72 * Math.pow(t0, 0.68)
    const boosted = clamp01(Math.pow(clamp01(raw * gain), 0.92))

    const prev = prevBars && i < prevBars.length ? prevBars[i]! : 0
    // Fast attack, smooth exponential decay.
    const alpha = boosted > prev ? 0.58 : 0.24
    out[i] = clamp01(prev + (boosted - prev) * alpha)
  }

  return { bars: out, bassEnergy }
}

/** Update gravity-driven peak hold caps alongside live bar heights. */
export function updatePeakCaps(
  bars: Float32Array,
  peaks: Float32Array,
  velocities: Float32Array,
  dtSec: number,
): void {
  const safeDt = Math.min(0.1, Math.max(0.004, dtSec))
  const gravity = 2.6
  for (let i = 0; i < bars.length; i += 1) {
    const val = bars[i] ?? 0
    const curPeak = peaks[i] ?? 0
    if (val >= curPeak) {
      peaks[i] = val
      velocities[i] = 0
    } else {
      const vel = (velocities[i] ?? 0) + gravity * safeDt
      velocities[i] = vel
      const next = curPeak - vel * safeDt
      if (next <= val) {
        peaks[i] = val
        velocities[i] = 0
      } else {
        peaks[i] = next
      }
    }
  }
}

/** Binary-search the active lyric line index for the current playback time in seconds. */
export function findActiveLyricIndex(lyrics: readonly MediaLyricLine[], currentTimeSec: number): number {
  if (lyrics.length === 0 || !Number.isFinite(currentTimeSec)) return -1
  if (currentTimeSec < lyrics[0]!.timeSec - 0.15) return -1
  let lo = 0
  let hi = lyrics.length - 1
  let ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lyrics[mid]!.timeSec <= currentTimeSec + 0.15) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/** Render 360-degree radial halo visualizer centered behind the vinyl record. */
export function renderVinylHalo(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  state: AudioVisualizerRenderState,
): void {
  ctx.clearRect(0, 0, width, height)
  if (width <= 0 || height <= 0) return

  const cx = width / 2
  const cy = height / 2
  const minDim = Math.min(width, height)
  const baseRadius = minDim * 0.345 + state.bassEnergy * minDim * 0.014
  const maxBarReach = Math.max(18, minDim * 0.145)
  const count = state.bars.length || VINYL_HALO_BAR_COUNT

  ctx.save()

  // Outer breathing acoustic aura ring
  ctx.beginPath()
  ctx.arc(cx, cy, baseRadius + 4, 0, Math.PI * 2)
  ctx.strokeStyle = state.palette.glow
  ctx.lineWidth = state.playing ? 2 + state.bassEnergy * 2.5 : 1.5
  ctx.stroke()

  // Subtle dashed reference ring rotating softly with phase
  ctx.beginPath()
  ctx.arc(cx, cy, baseRadius + maxBarReach * 0.72, state.phase * 0.25, state.phase * 0.25 + Math.PI * 1.65)
  ctx.strokeStyle = state.palette.glowSoft
  ctx.lineWidth = 1.25
  ctx.stroke()

  // Radial frequency rays around the vinyl perimeter
  const rayGrad = ctx.createRadialGradient(
    cx,
    cy,
    baseRadius,
    cx,
    cy,
    baseRadius + maxBarReach,
  )
  rayGrad.addColorStop(0, state.palette.primary)
  rayGrad.addColorStop(1, state.palette.secondary)
  ctx.strokeStyle = rayGrad
  ctx.lineCap = 'round'
  ctx.lineWidth = Math.max(2.2, (minDim / count) * 1.15)

  for (let i = 0; i < count; i += 1) {
    // Mirror lower/upper energy slightly around vertical axis for organic symmetry
    const sampleIdx = i < count / 2 ? i * 2 : (count - 1 - i) * 2
    const amp = state.playing
      ? clamp01(state.bars[sampleIdx % count] ?? 0)
      : 0.08 + 0.05 * Math.sin(state.phase + i * 0.35)
    const angle = (i / count) * Math.PI * 2 - Math.PI / 2 + state.phase * 0.06
    const inner = baseRadius + 4
    const len = 4 + amp * maxBarReach
    const x0 = cx + Math.cos(angle) * inner
    const y0 = cy + Math.sin(angle) * inner
    const x1 = cx + Math.cos(angle) * (inner + len)
    const y1 = cy + Math.sin(angle) * (inner + len)

    ctx.globalAlpha = state.playing ? 0.42 + amp * 0.58 : 0.32
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    ctx.lineTo(x1, y1)
    ctx.stroke()
  }

  // Orbiting ambient particles synced to bass energy
  ctx.fillStyle = state.palette.secondary
  const particleCount = 10
  for (let p = 0; p < particleCount; p += 1) {
    const orbit = baseRadius + maxBarReach * (0.48 + (p % 3) * 0.22)
    const theta = (p / particleCount) * Math.PI * 2 + state.phase * (0.28 + (p % 2) * 0.14)
    const px = cx + Math.cos(theta) * orbit
    const py = cy + Math.sin(theta) * orbit
    const r = 1.6 + state.bassEnergy * 2.1
    ctx.globalAlpha = state.playing ? 0.35 + state.bassEnergy * 0.45 : 0.16
    ctx.beginPath()
    ctx.arc(px, py, r, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.restore()
}

/** Render symmetrical glowing capsule bars with gravity peak-hold caps and floor reflection. */
export function renderMirrorBars(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  state: AudioVisualizerRenderState,
): void {
  ctx.clearRect(0, 0, width, height)
  if (width <= 0 || height <= 0) return

  const count = state.bars.length || MIRROR_BAR_COUNT
  const padX = Math.max(12, width * 0.03)
  const usableW = Math.max(40, width - padX * 2)
  const step = usableW / count
  const barW = Math.max(3, Math.min(12, step * 0.64))
  const axisY = height * 0.61
  const maxUp = Math.max(20, axisY - 18)
  const maxDown = Math.max(12, height - axisY - 14)

  const gradUp = ctx.createLinearGradient(0, axisY - maxUp, 0, axisY)
  gradUp.addColorStop(0, state.palette.secondary)
  gradUp.addColorStop(1, state.palette.primary)

  const gradDown = ctx.createLinearGradient(0, axisY, 0, axisY + maxDown)
  gradDown.addColorStop(0, state.palette.primary)
  gradDown.addColorStop(1, state.palette.glowSoft)

  ctx.save()

  // Center baseline glow
  ctx.fillStyle = state.palette.glowSoft
  ctx.fillRect(padX, axisY - 0.5, usableW, 1)

  for (let i = 0; i < count; i += 1) {
    const val = state.playing
      ? clamp01(state.bars[i] ?? 0)
      : 0.06 + 0.04 * Math.sin(i * 0.45)
    const peak = state.playing ? clamp01(state.peaks[i] ?? val) : val
    const x = padX + i * step + (step - barW) / 2
    const upH = Math.max(4, val * maxUp)
    const downH = Math.max(3, val * maxDown * 0.72)
    const r = Math.min(barW / 2, 4)

    // Upper bar
    ctx.globalAlpha = state.playing ? 0.52 + val * 0.48 : 0.35
    ctx.fillStyle = gradUp
    ctx.beginPath()
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, axisY - upH, barW, upH, [r, r, 1, 1])
    } else {
      ctx.rect(x, axisY - upH, barW, upH)
    }
    ctx.fill()

    // Reflection bar
    ctx.globalAlpha = state.playing ? 0.16 + val * 0.24 : 0.1
    ctx.fillStyle = gradDown
    ctx.beginPath()
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, axisY + 2, barW, downH, [1, 1, r, r])
    } else {
      ctx.rect(x, axisY + 2, barW, downH)
    }
    ctx.fill()

    // Gravity-driven peak-hold cap
    if (state.playing) {
      const capY = Math.max(4, axisY - peak * maxUp - 5)
      ctx.globalAlpha = 0.85
      ctx.fillStyle = state.palette.secondary
      ctx.beginPath()
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(x, capY, barW, 2.5, 1.25)
      } else {
        ctx.rect(x, capY, barW, 2.5)
      }
      ctx.fill()
    }
  }

  ctx.restore()
}

/** Render layered fluid silk waveform ribbons driven by time-domain audio + harmonic envelope. */
export function renderFluidWave(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  state: AudioVisualizerRenderState,
): void {
  ctx.clearRect(0, 0, width, height)
  if (width <= 0 || height <= 0) return

  const centerY = height * 0.52
  const ampScale = height * 0.34
  const points = 72

  let avgEnergy = 0
  for (let i = 0; i < state.bars.length; i += 1) avgEnergy += state.bars[i]!
  avgEnergy = state.bars.length > 0 ? avgEnergy / state.bars.length : 0

  const strokeGrad = ctx.createLinearGradient(0, 0, width, 0)
  strokeGrad.addColorStop(0, state.palette.primary)
  strokeGrad.addColorStop(0.5, state.palette.secondary)
  strokeGrad.addColorStop(1, state.palette.primary)

  const fillGrad = ctx.createLinearGradient(0, centerY - ampScale, 0, height)
  fillGrad.addColorStop(0, state.palette.glow)
  fillGrad.addColorStop(1, state.palette.glowSoft)

  const layers = [
    { speed: 1.0, freq: 2.2, alpha: 0.92, weight: 2.6, amp: 1.0, fill: true },
    { speed: -1.35, freq: 3.1, alpha: 0.55, weight: 1.8, amp: 0.72, fill: false },
    { speed: 1.8, freq: 4.3, alpha: 0.34, weight: 1.4, amp: 0.48, fill: false },
  ]

  ctx.save()
  for (const layer of layers) {
    const xs: number[] = []
    const ys: number[] = []
    for (let i = 0; i <= points; i += 1) {
      const t = i / points
      const x = t * width
      // Hanning-style edge fade so waves anchor cleanly at left and right edges.
      const windowEnv = Math.sin(t * Math.PI)
      let timeSample = 0
      if (state.playing && state.timeData && state.timeData.length > 0) {
        const tdIdx = Math.min(
          state.timeData.length - 1,
          Math.floor(t * (state.timeData.length - 1)),
        )
        timeSample = ((state.timeData[tdIdx] ?? 128) - 128) / 128
      }
      const barIdx = Math.min(state.bars.length - 1, Math.floor(t * state.bars.length))
      const spectral = state.playing ? state.bars[barIdx] ?? 0 : 0.08
      const baseSine = Math.sin(t * Math.PI * 2 * layer.freq + state.phase * layer.speed)
      const harmonic = state.playing
        ? baseSine * (0.28 + avgEnergy * 0.55 + spectral * 0.45) + timeSample * 0.95
        : baseSine * 0.14
      const y = centerY + harmonic * ampScale * layer.amp * windowEnv
      xs.push(x)
      ys.push(y)
    }

    ctx.beginPath()
    ctx.moveTo(xs[0]!, ys[0]!)
    for (let i = 1; i < xs.length - 1; i += 1) {
      const xc = (xs[i]! + xs[i + 1]!) / 2
      const yc = (ys[i]! + ys[i + 1]!) / 2
      ctx.quadraticCurveTo(xs[i]!, ys[i]!, xc, yc)
    }
    ctx.lineTo(xs[xs.length - 1]!, ys[ys.length - 1]!)

    ctx.globalAlpha = state.playing ? layer.alpha : 0.38
    ctx.strokeStyle = strokeGrad
    ctx.lineWidth = layer.weight
    ctx.lineCap = 'round'
    ctx.stroke()

    if (layer.fill) {
      ctx.save()
      ctx.lineTo(width, height)
      ctx.lineTo(0, height)
      ctx.closePath()
      ctx.globalAlpha = state.playing ? 0.38 + state.bassEnergy * 0.24 : 0.16
      ctx.fillStyle = fillGrad
      ctx.fill()
      ctx.restore()
    }
  }
  ctx.restore()
}

export function normalizeVisualizerMode(raw: unknown): MediaVisualizerMode {
  if (raw === 'bars' || raw === 'wave' || raw === 'vinyl') return raw
  return 'vinyl'
}
