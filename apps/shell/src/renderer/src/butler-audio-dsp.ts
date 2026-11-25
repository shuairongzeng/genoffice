/**
 * Pure audio DSP, streaming WAV codec, adaptive VAD, wake-word matching, and
 * speech-text normalization helpers for GenOffice Butler Voice.
 *
 * Kept Electron-free and DOM-free so both the renderer audio engine and Node
 * unit tests execute identically.
 */

export {
  createStreamingSpeechChunker,
  type StreamingSpeechChunker,
} from '../../shared/butler-api'

export const TARGET_AUDIO_SAMPLE_RATE = 24000
const WAV_HEADER_BYTES = 44
const MIN_VALID_SAMPLE_RATE = 8000
const MAX_VALID_SAMPLE_RATE = 192000
const BASE64_CHUNK_BYTES = 0x6000 // 24576 bytes (multiple of 3) to avoid call-stack limits

export type WakeWordMatchResult =
  | { readonly matched: false }
  | { readonly matched: true; readonly mode: 'listen'; readonly wakeWord: string }
  | {
      readonly matched: true
      readonly mode: 'command'
      readonly wakeWord: string
      readonly commandText: string
    }

export interface StreamingWavChunk {
  readonly sampleRate: number
  readonly samples: Float32Array
}

export interface StreamingWavParser {
  push(chunk: Uint8Array): StreamingWavChunk | null
  reset(): void
}

export interface AdaptiveVadOptions {
  readonly sampleRate?: number
  readonly silenceMs?: number
  readonly preRollMs?: number
  readonly minSpeechMs?: number
  readonly maxSegmentMs?: number
  readonly minRmsThreshold?: number
}

export interface VadPushResult {
  readonly speaking: boolean
  readonly rms: number
  readonly completedSegment: Int16Array | null
}

function clampUnitSample(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value > 1) return 1
  if (value < -1) return -1
  return value
}

function floatToInt16(sample: number): number {
  const clamped = clampUnitSample(sample)
  const scaled = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff)
  if (scaled > 32767) return 32767
  if (scaled < -32768) return -32768
  return scaled
}

/**
 * Resample mono Float32 PCM audio to 24 kHz using linear interpolation and
 * quantize each sample into signed 16-bit PCM.
 */
export function downsampleTo24kMono(input: Float32Array, inputSampleRate: number): Int16Array {
  if (input.length === 0 || !Number.isFinite(inputSampleRate) || inputSampleRate <= 0) {
    return new Int16Array(0)
  }

  if (Math.abs(inputSampleRate - TARGET_AUDIO_SAMPLE_RATE) < 1e-6) {
    const out = new Int16Array(input.length)
    for (let i = 0; i < input.length; i += 1) {
      out[i] = floatToInt16(input[i]!)
    }
    return out
  }

  const ratio = inputSampleRate / TARGET_AUDIO_SAMPLE_RATE
  const outputLength = Math.max(1, Math.round(input.length / ratio))
  const out = new Int16Array(outputLength)
  const lastIdx = input.length - 1

  for (let i = 0; i < outputLength; i += 1) {
    const srcPos = i * ratio
    const idx0 = Math.min(lastIdx, Math.floor(srcPos))
    const idx1 = Math.min(lastIdx, idx0 + 1)
    const frac = srcPos - idx0
    const s0 = input[idx0]!
    const s1 = input[idx1]!
    const interpolated = s0 + (s1 - s0) * frac
    out[i] = floatToInt16(interpolated)
  }

  return out
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i))
  }
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = ''
  for (let i = 0; i < length; i += 1) {
    out += String.fromCharCode(bytes[offset + i] ?? 0)
  }
  return out
}

/**
 * Encode mono signed 16-bit PCM samples into a complete 44-byte RIFF/WAVE
 * little-endian container.
 */
export function encodePcm16ToWav(
  samples: Int16Array,
  sampleRate = TARGET_AUDIO_SAMPLE_RATE,
): Uint8Array {
  const safeRate =
    Number.isFinite(sampleRate) && sampleRate > 0
      ? Math.round(sampleRate)
      : TARGET_AUDIO_SAMPLE_RATE
  const numChannels = 1
  const bitsPerSample = 16
  const blockAlign = numChannels * (bitsPerSample / 8)
  const byteRate = safeRate * blockAlign
  const dataLength = samples.length * 2
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataLength)
  const view = new DataView(buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataLength, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, safeRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataLength, true)

  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(WAV_HEADER_BYTES + i * 2, samples[i]!, true)
  }

  return new Uint8Array(buffer)
}

/**
 * Convert a Uint8Array to a base64 string without overflowing the call stack on
 * large audio buffers. Works identically in browser and Node runtimes.
 */
export function uint8ToBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) return ''

  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
  }

  const binaryParts: string[] = []
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    const slice = bytes.subarray(offset, Math.min(offset + BASE64_CHUNK_BYTES, bytes.length))
    binaryParts.push(String.fromCharCode(...slice))
  }
  return btoa(binaryParts.join(''))
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b
  if (b.length === 0) return a
  const merged = new Uint8Array(a.length + b.length)
  merged.set(a, 0)
  merged.set(b, a.length)
  return merged
}

/**
 * Create a stateful streaming WAV parser that handles arbitrary chunk splits,
 * `0xFFFFFFFF` streaming placeholder lengths, and trailing odd bytes across
 * PCM16 little-endian chunk boundaries.
 */
export function createStreamingWavParser(): StreamingWavParser {
  let headerBytes: Uint8Array = new Uint8Array(0)
  let headerParsed = false
  let sampleRate = TARGET_AUDIO_SAMPLE_RATE
  let oddByte: number | null = null

  const parseHeader = (buf: Uint8Array): { dataOffset: number; rate: number } | null => {
    if (buf.length < WAV_HEADER_BYTES) return null

    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const isRiffWave = readAscii(buf, 0, 4) === 'RIFF' && readAscii(buf, 8, 4) === 'WAVE'
    if (!isRiffWave) {
      return { dataOffset: WAV_HEADER_BYTES, rate: TARGET_AUDIO_SAMPLE_RATE }
    }

    const offset24Rate = view.getUint32(24, true)
    let resolvedRate =
      offset24Rate >= MIN_VALID_SAMPLE_RATE && offset24Rate <= MAX_VALID_SAMPLE_RATE
        ? offset24Rate
        : TARGET_AUDIO_SAMPLE_RATE

    if (readAscii(buf, 36, 4) === 'data') {
      return { dataOffset: WAV_HEADER_BYTES, rate: resolvedRate }
    }

    // Fallback scan for non-standard WAV files containing extra subchunks before `data`.
    let cursor = 12
    while (cursor + 8 <= buf.length) {
      const chunkId = readAscii(buf, cursor, 4)
      const chunkSize = view.getUint32(cursor + 4, true)
      if (chunkId === 'fmt ' && cursor + 16 <= buf.length) {
        const fmtRate = view.getUint32(cursor + 12, true)
        if (fmtRate >= MIN_VALID_SAMPLE_RATE && fmtRate <= MAX_VALID_SAMPLE_RATE) {
          resolvedRate = fmtRate
        }
      }
      if (chunkId === 'data') {
        return { dataOffset: cursor + 8, rate: resolvedRate }
      }
      if (chunkSize === 0xffffffff) break
      const paddedSize = chunkSize + (chunkSize & 1)
      const nextCursor = cursor + 8 + paddedSize
      if (nextCursor <= cursor) break
      if (nextCursor > buf.length) {
        if (buf.length < 4096) return null
        break
      }
      cursor = nextCursor
    }

    return { dataOffset: WAV_HEADER_BYTES, rate: resolvedRate }
  }

  return {
    push(chunk: Uint8Array): StreamingWavChunk | null {
      if (chunk.length === 0) return null

      let payload: Uint8Array
      if (!headerParsed) {
        headerBytes = concatBytes(headerBytes, chunk)
        const parsed = parseHeader(headerBytes)
        if (!parsed) return null
        headerParsed = true
        sampleRate = parsed.rate
        payload = headerBytes.subarray(parsed.dataOffset)
        headerBytes = new Uint8Array(0)
      } else {
        payload = chunk
      }

      if (payload.length === 0) return null

      let pcmBytes = payload
      if (oddByte !== null) {
        const combined = new Uint8Array(1 + payload.length)
        combined[0] = oddByte
        combined.set(payload, 1)
        pcmBytes = combined
        oddByte = null
      }

      if ((pcmBytes.length & 1) === 1) {
        oddByte = pcmBytes[pcmBytes.length - 1]!
        pcmBytes = pcmBytes.subarray(0, pcmBytes.length - 1)
      }

      if (pcmBytes.length < 2) return null

      const sampleCount = pcmBytes.length >> 1
      const samples = new Float32Array(sampleCount)
      const view = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength)
      for (let i = 0; i < sampleCount; i += 1) {
        samples[i] = view.getInt16(i * 2, true) / 32768
      }

      return { sampleRate, samples }
    },

    reset(): void {
      headerBytes = new Uint8Array(0)
      headerParsed = false
      sampleRate = TARGET_AUDIO_SAMPLE_RATE
      oddByte = null
    },
  }
}

function positiveFinite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function concatInt16Chunks(chunks: readonly Int16Array[], maxSamples?: number): Int16Array {
  let total = 0
  for (const chunk of chunks) {
    total += chunk.length
  }
  const targetLen = maxSamples !== undefined ? Math.min(total, maxSamples) : total
  const out = new Int16Array(targetLen)
  let offset = 0
  for (const chunk of chunks) {
    if (offset >= targetLen) break
    const copyLen = Math.min(chunk.length, targetLen - offset)
    out.set(chunk.subarray(0, copyLen), offset)
    offset += copyLen
  }
  return out
}

function computeRms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0
  let sumSq = 0
  for (let i = 0; i < pcm.length; i += 1) {
    const normalized = pcm[i]! / 32768
    sumSq += normalized * normalized
  }
  return Math.sqrt(sumSq / pcm.length)
}

const MAX_ADAPTIVE_NOISE_FLOOR = 0.025

/**
 * Adaptive energy-based Voice Activity Detector with slow noise-floor EMA
 * tracking and a pre-roll ring buffer so initial syllables of wake words are
 * never clipped.
 */
export class AdaptiveVadDetector {
  readonly sampleRate: number
  readonly silenceMs: number
  readonly preRollMs: number
  readonly minSpeechMs: number
  readonly maxSegmentMs: number
  readonly minRmsThreshold: number

  private readonly preRollSamples: number
  private readonly silenceSamples: number
  private readonly minSpeechSamples: number
  private readonly maxSegmentSamples: number
  private readonly trailingKeepSamples: number

  private preRollChunks: Int16Array[] = []
  private preRollTotal = 0

  private segmentChunks: Int16Array[] = []
  private segmentTotal = 0
  private initialPreRollSamples = 0
  private voicedSamples = 0
  private trailingSilenceSamples = 0
  private speechPeakRms = 0
  private consecutiveResumeFrames = 0

  private speaking = false
  private noiseFloor = 0
  private hasNoiseSample = false

  constructor(options: AdaptiveVadOptions = {}) {
    this.sampleRate = positiveFinite(options.sampleRate, TARGET_AUDIO_SAMPLE_RATE)
    this.silenceMs = positiveFinite(options.silenceMs, 750)
    this.preRollMs = positiveFinite(options.preRollMs, 250)
    this.minSpeechMs = positiveFinite(options.minSpeechMs, 320)
    this.maxSegmentMs = positiveFinite(options.maxSegmentMs, 10000)
    this.minRmsThreshold = positiveFinite(options.minRmsThreshold, 0.012)

    this.preRollSamples = Math.round((this.sampleRate * this.preRollMs) / 1000)
    this.silenceSamples = Math.round((this.sampleRate * this.silenceMs) / 1000)
    this.minSpeechSamples = Math.round((this.sampleRate * this.minSpeechMs) / 1000)
    this.maxSegmentSamples = Math.round((this.sampleRate * this.maxSegmentMs) / 1000)
    this.trailingKeepSamples = Math.min(
      this.silenceSamples,
      Math.round((this.sampleRate * 250) / 1000),
    )
  }

  get currentThreshold(): number {
    return Math.max(this.minRmsThreshold, this.noiseFloor * 2.8)
  }

  get currentNoiseFloor(): number {
    return this.noiseFloor
  }

  get isSpeaking(): boolean {
    return this.speaking
  }

  private appendPreRoll(frame: Int16Array): void {
    if (this.preRollSamples <= 0 || frame.length === 0) return

    const copy = new Int16Array(frame)
    this.preRollChunks.push(copy)
    this.preRollTotal += copy.length

    while (this.preRollTotal > this.preRollSamples && this.preRollChunks.length > 0) {
      const excess = this.preRollTotal - this.preRollSamples
      const head = this.preRollChunks[0]!
      if (head.length <= excess) {
        this.preRollChunks.shift()
        this.preRollTotal -= head.length
      } else {
        this.preRollChunks[0] = head.subarray(excess)
        this.preRollTotal -= excess
      }
    }
  }

  private clearActiveSegment(): void {
    this.segmentChunks = []
    this.segmentTotal = 0
    this.initialPreRollSamples = 0
    this.voicedSamples = 0
    this.trailingSilenceSamples = 0
    this.speechPeakRms = 0
    this.consecutiveResumeFrames = 0
    this.speaking = false
  }

  private updateNoiseFloor(rms: number): void {
    if (!this.hasNoiseSample) {
      this.noiseFloor = Math.min(MAX_ADAPTIVE_NOISE_FLOOR, rms)
      this.hasNoiseSample = true
      return
    }
    const alpha = rms < this.noiseFloor ? 0.14 : 0.015
    this.noiseFloor = Math.min(
      MAX_ADAPTIVE_NOISE_FLOOR,
      this.noiseFloor * (1 - alpha) + rms * alpha,
    )
  }

  pushFrame(pcm: Int16Array): VadPushResult {
    const rms = computeRms(pcm)
    if (pcm.length === 0) {
      return { speaking: this.speaking, rms, completedSegment: null }
    }

    const threshold = this.currentThreshold
    const isSpeech = rms >= threshold

    if (!this.speaking) {
      if (isSpeech) {
        this.speaking = true
        this.initialPreRollSamples = this.preRollTotal
        this.segmentChunks = [...this.preRollChunks, new Int16Array(pcm)]
        this.segmentTotal = this.preRollTotal + pcm.length
        this.voicedSamples = pcm.length
        this.trailingSilenceSamples = 0
        this.speechPeakRms = Math.min(0.4, rms)
        this.consecutiveResumeFrames = 0
        this.preRollChunks = []
        this.preRollTotal = 0

        if (this.segmentTotal >= this.maxSegmentSamples) {
          const completed = this.finalizeSegment(false)
          return { speaking: false, rms, completedSegment: completed }
        }
        return { speaking: true, rms, completedSegment: null }
      }

      this.updateNoiseFloor(rms)
      this.appendPreRoll(pcm)
      return { speaking: false, rms, completedSegment: null }
    }

    if (rms > this.speechPeakRms) {
      this.speechPeakRms = Math.min(0.4, rms)
    }
    const sustainThreshold = Math.max(this.currentThreshold * 0.85, this.speechPeakRms * 0.28)
    const isVoicedFrame = rms >= sustainThreshold

    this.segmentChunks.push(new Int16Array(pcm))
    this.segmentTotal += pcm.length
    if (isVoicedFrame) {
      if (this.trailingSilenceSamples === 0) {
        this.voicedSamples += pcm.length
      } else {
        this.consecutiveResumeFrames += 1
        // Require either a loud continuation or 2 consecutive voiced frames before
        // cancelling accumulated trailing silence, so transient AGC clicks cannot
        // reset end-of-utterance detection.
        if (this.consecutiveResumeFrames >= 2 || rms >= this.speechPeakRms * 0.55) {
          this.voicedSamples += pcm.length
          this.trailingSilenceSamples = 0
          this.consecutiveResumeFrames = 0
        } else {
          this.trailingSilenceSamples = Math.max(
            0,
            this.trailingSilenceSamples - Math.floor(pcm.length * 0.5),
          )
        }
      }
    } else {
      this.consecutiveResumeFrames = 0
      this.trailingSilenceSamples += pcm.length
    }

    const hitSilenceLimit = this.trailingSilenceSamples >= this.silenceSamples
    const hitMaxDuration = this.segmentTotal >= this.maxSegmentSamples

    if (hitSilenceLimit || hitMaxDuration) {
      const completed = this.finalizeSegment(hitSilenceLimit && !hitMaxDuration)
      return { speaking: false, rms, completedSegment: completed }
    }

    return { speaking: true, rms, completedSegment: null }
  }

  private finalizeSegment(trimTrailingSilence: boolean): Int16Array | null {
    const minRequiredPeak = Math.max(this.minRmsThreshold * 1.35, this.noiseFloor * 2.8)
    if (this.voicedSamples < this.minSpeechSamples || this.speechPeakRms < minRequiredPeak) {
      this.clearActiveSegment()
      return null
    }

    const maxCountedTrailingSilence = Math.round((this.sampleRate * 750) / 1000)
    const excessTrailingSilence = Math.max(
      0,
      this.trailingSilenceSamples - maxCountedTrailingSilence,
    )
    const activeNonPreRollSamples = Math.max(
      1,
      this.segmentTotal - this.initialPreRollSamples - excessTrailingSilence,
    )
    if (this.voicedSamples / activeNonPreRollSamples < 0.2) {
      this.clearActiveSegment()
      return null
    }

    let maxSamples = this.segmentTotal
    if (trimTrailingSilence && this.trailingSilenceSamples > this.trailingKeepSamples) {
      maxSamples = Math.max(
        this.voicedSamples,
        this.segmentTotal - (this.trailingSilenceSamples - this.trailingKeepSamples),
      )
    }

    const result = concatInt16Chunks(this.segmentChunks, maxSamples)
    this.clearActiveSegment()
    return result
  }

  flush(): Int16Array | null {
    const minRequiredPeak = Math.max(this.minRmsThreshold * 1.35, this.noiseFloor * 2.8)
    if (
      !this.speaking ||
      this.voicedSamples < this.minSpeechSamples ||
      this.speechPeakRms < minRequiredPeak ||
      this.voicedSamples / Math.max(1, this.segmentTotal) < 0.2
    ) {
      this.clearActiveSegment()
      return null
    }
    const result = concatInt16Chunks(this.segmentChunks)
    this.clearActiveSegment()
    return result
  }

  /** Clear buffered speech and pre-roll frames during TTS suppression while preserving noise floor. */
  pauseAndClear(): void {
    this.clearActiveSegment()
    this.preRollChunks = []
    this.preRollTotal = 0
  }

  reset(): void {
    this.clearActiveSegment()
    this.preRollChunks = []
    this.preRollTotal = 0
    this.noiseFloor = 0
    this.hasNoiseSample = false
  }
}

const BUILTIN_JARVIS_HOMOPHONES = [
  '贾维斯',
  '佳维斯',
  '贾维思',
  '加维斯',
  '甲维斯',
  '假维斯',
  'jarvis',
]

const LEADING_PUNCT_OR_SPACE_RE = /^[\s\p{P}\p{S}]+/u
const TRAILING_PUNCT_OR_SPACE_RE = /[\s\p{P}\p{S}]+$/u
const ASCII_ALNUM_RE = /^[a-z0-9]$/i

const CJK_FILLERS = ['你好', '您好', '那个', '嗨', '嘿', '喂', '嗯', '请']
const ASCII_FILLERS = ['hello', 'hey', 'hi', 'ok']

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isPureAsciiWord(text: string): boolean {
  return /^[\x20-\x7e]+$/.test(text)
}

function buildWakeCandidates(butlerName: string, aliasesCsv?: string): string[] {
  const seen = new Map<string, string>()
  const addCandidate = (raw: string): void => {
    const trimmed = raw.trim()
    if (!trimmed) return
    const key = isPureAsciiWord(trimmed) ? trimmed.toLowerCase() : trimmed
    if (!seen.has(key)) {
      seen.set(key, trimmed)
    }
  }

  const cleanName = butlerName.trim()
  addCandidate(cleanName)

  if (aliasesCsv) {
    for (const part of aliasesCsv.split(/[,，|/;；]+/)) {
      addCandidate(part)
    }
  }

  const normalizedName = cleanName.toLowerCase().replace(/\./g, '')
  if (normalizedName === '贾维斯' || normalizedName === 'jarvis') {
    for (const homophone of BUILTIN_JARVIS_HOMOPHONES) {
      addCandidate(homophone)
    }
  }

  return [...seen.values()].sort((a, b) => b.length - a.length)
}

function matchCandidatePrefix(input: string, candidate: string): { matched: true; rest: string } | null {
  const chars = [...candidate.replace(/\s+/g, '')]
  if (chars.length === 0) return null

  const pattern = chars.map((ch) => escapeRegExp(ch)).join('\\s*')
  const flags = isPureAsciiWord(candidate) ? 'i' : ''
  const re = new RegExp(`^(${pattern})`, flags)
  const hit = re.exec(input)
  if (!hit) return null

  const rest = input.slice(hit[0].length)
  if (isPureAsciiWord(candidate) && rest.length > 0 && ASCII_ALNUM_RE.test(rest[0]!)) {
    return null
  }
  return { matched: true, rest }
}

function stripOneLeadingFiller(input: string): string | null {
  for (const filler of CJK_FILLERS) {
    if (input.startsWith(filler)) {
      return input.slice(filler.length)
    }
  }

  const lower = input.toLowerCase()
  for (const filler of ASCII_FILLERS) {
    if (lower.startsWith(filler)) {
      const nextChar = input[filler.length]
      if (nextChar === undefined || !ASCII_ALNUM_RE.test(nextChar)) {
        return input.slice(filler.length)
      }
    }
  }
  return null
}

function stripLeadingFillersAndPunct(input: string): string {
  let current = input.replace(LEADING_PUNCT_OR_SPACE_RE, '')
  for (let i = 0; i < 12; i += 1) {
    const next = stripOneLeadingFiller(current)
    if (next === null) break
    current = next.replace(LEADING_PUNCT_OR_SPACE_RE, '')
  }
  return current.replace(TRAILING_PUNCT_OR_SPACE_RE, '').trim()
}

/**
 * Match a wake-word prefix in an ASR transcript after normalizing punctuation
 * and stripping optional leading Chinese/English filler greetings.
 */
export function matchWakeWord(
  transcript: string,
  butlerName: string,
  aliasesCsv?: string,
): WakeWordMatchResult {
  const raw = transcript.trim()
  if (!raw) return { matched: false }

  const candidates = buildWakeCandidates(butlerName, aliasesCsv)
  if (candidates.length === 0) return { matched: false }

  let cursor = raw.replace(LEADING_PUNCT_OR_SPACE_RE, '')
  for (let step = 0; step < 12 && cursor.length > 0; step += 1) {
    for (const candidate of candidates) {
      const hit = matchCandidatePrefix(cursor, candidate)
      if (!hit) continue

      const commandText = hit.rest.replace(LEADING_PUNCT_OR_SPACE_RE, '').trim()
      const meaningful = stripLeadingFillersAndPunct(commandText)
      if (!meaningful) {
        return { matched: true, mode: 'listen', wakeWord: candidate }
      }
      return {
        matched: true,
        mode: 'command',
        wakeWord: candidate,
        commandText,
      }
    }

    const stripped = stripOneLeadingFiller(cursor)
    if (stripped === null) break
    cursor = stripped.replace(LEADING_PUNCT_OR_SPACE_RE, '')
  }

  return { matched: false }
}

const DISMISS_LEADING_POLITE_CJK = ['谢谢', '多谢', '麻烦', '好的', '好', '行', '嗯', '哦', '噢', '那']
const DISMISS_LEADING_POLITE_ASCII = ['thank you', 'thanks', 'okay', 'ok']
const DISMISS_TRAILING_PARTICLE_RE = /[吧啦呀啊呢喔哦\s\p{P}\p{S}]+$/gu

const DISMISS_EXACT_CJK = new Set([
  '退下',
  '没事',
  '没事了',
  '没有',
  '没有了',
  '没别的事',
  '没其他事',
  '先这样',
  '就这样',
  '不用',
  '不用了',
  '不用管',
  '不用管了',
  '结束',
  '结束对话',
  '停止对话',
  '停止倾听',
  '关闭语音',
  '闭嘴',
  '安静',
  '休息',
  '再见',
  '拜拜',
])

const DISMISS_EXACT_EN = new Set([
  'stop',
  'stop listening',
  'end chat',
  'end conversation',
  'dismiss',
  'that is all',
  'thats all',
  "that's all",
  'nothing else',
  'never mind',
  'nevermind',
  'bye',
  'goodbye',
])

function stripLeadingDismissPolite(input: string): string {
  let cursor = input.replace(LEADING_PUNCT_OR_SPACE_RE, '')
  for (let round = 0; round < 3 && cursor.length > 0; round += 1) {
    let changed = false
    for (const prefix of DISMISS_LEADING_POLITE_CJK) {
      if (cursor.startsWith(prefix)) {
        const rest = cursor.slice(prefix.length).replace(LEADING_PUNCT_OR_SPACE_RE, '')
        if (rest.length > 0) {
          cursor = rest
          changed = true
          break
        }
      }
    }
    if (changed) continue

    const lower = cursor.toLowerCase()
    for (const prefix of DISMISS_LEADING_POLITE_ASCII) {
      if (lower.startsWith(prefix)) {
        const nextChar = cursor[prefix.length]
        if (nextChar === undefined || !ASCII_ALNUM_RE.test(nextChar)) {
          const rest = cursor.slice(prefix.length).replace(LEADING_PUNCT_OR_SPACE_RE, '')
          if (rest.length > 0) {
            cursor = rest
            changed = true
            break
          }
        }
      }
    }
    if (!changed) break
  }
  return cursor
}

/**
 * Return true when an ASR transcript is a standalone conversational dismiss
 * command (e.g. "stop listening", "dismiss", or localized equivalents) rather
 * than a task instruction with trailing clauses.
 */
export function isVoiceDismissPhrase(
  transcript: string,
  butlerName = '贾维斯',
  aliasesCsv?: string,
): boolean {
  const raw = transcript.trim()
  if (!raw) return false

  const withoutPolite = stripLeadingDismissPolite(raw)
  const inputsToCheck = withoutPolite && withoutPolite !== raw ? [raw, withoutPolite] : [raw]

  let subject = withoutPolite || raw
  for (const input of inputsToCheck) {
    const wake = matchWakeWord(input, butlerName, aliasesCsv)
    if (wake.matched) {
      if (wake.mode === 'listen') return false
      subject = wake.commandText
      break
    }
  }

  let normalized = stripLeadingDismissPolite(subject)
  normalized = normalized.replace(DISMISS_TRAILING_PARTICLE_RE, '').trim()
  if (!normalized || normalized.length > 24) return false

  const enCandidate = normalized
    .toLowerCase()
    .replace(/(?:(?!')[\p{P}\p{S}])+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (DISMISS_EXACT_EN.has(enCandidate)) {
    return true
  }

  const cjkCandidate = normalized.replace(/[\s\p{P}\p{S}]+/gu, '')
  if (cjkCandidate.length > 0 && cjkCandidate.length <= 16 && DISMISS_EXACT_CJK.has(cjkCandidate)) {
    return true
  }

  return false
}

const ASR_HALLUCINATION_WATERMARK_RE =
  /字幕由|感谢观看|谢谢观看|请不吝点赞|订阅我的频道|欢迎订阅|优优独播|Amara\.org|Subtitles by|Thank you for watching/i
const ASR_HALLUCINATION_TRIVIA_RE =
  /^《[^》]{1,24}》是[^。！？!?]{2,40}(?:演唱|发行|出版|上映|执导|创作|收录)的/
const ASR_HALLUCINATION_FILLER_LOOP_RE = /^(哈|啊|嗯|哦|呃|啦|呢)\1{3,}[。！!？?\s]*$/

/**
 * Detect common ASR hallucinations emitted on silent/low-SNR room audio
 * (empty strings, video subtitle watermarks, spontaneous encyclopedia/song
 * trivia, or repeated single-character filler loops).
 */
export function isLikelyAsrHallucination(transcript: string): boolean {
  const cleaned = transcript.replace(/^[，,、。！？!?\s]+/, '').trim()
  if (!cleaned) return true

  const meaningful = cleaned.replace(/[\s\p{P}\p{S}]+/gu, '')
  if (!meaningful) return true

  if (ASR_HALLUCINATION_WATERMARK_RE.test(cleaned)) return true
  if (ASR_HALLUCINATION_TRIVIA_RE.test(cleaned)) return true
  if (ASR_HALLUCINATION_FILLER_LOOP_RE.test(cleaned)) return true

  return false
}

export type FollowUpParseResult =
  | { readonly kind: 'empty' }
  | { readonly kind: 'dismiss' }
  | { readonly kind: 'wake_only' }
  | { readonly kind: 'command'; readonly commandText: string }

/**
 * Classify a transcript captured during hands-free follow-up listening as an
 * empty noise utterance, an explicit dismiss phrase, a bare wake word, or an
 * actionable follow-up command (with any optional wake prefix stripped).
 */
export function parseFollowUpTranscript(
  transcript: string,
  butlerName: string,
  aliasesCsv?: string,
): FollowUpParseResult {
  const cleaned = transcript.replace(/^[，,、。！？!?\s]+/, '').trim()
  if (!cleaned) return { kind: 'empty' }

  const meaningful = cleaned.replace(/[\s\p{P}\p{S}]+/gu, '')
  if (!meaningful) return { kind: 'empty' }

  if (isLikelyAsrHallucination(cleaned)) {
    return { kind: 'empty' }
  }

  if (isVoiceDismissPhrase(cleaned, butlerName, aliasesCsv)) {
    return { kind: 'dismiss' }
  }

  const wake = matchWakeWord(cleaned, butlerName, aliasesCsv)
  if (wake.matched) {
    if (wake.mode === 'listen') {
      return { kind: 'wake_only' }
    }
    const stripped = wake.commandText.replace(/^[，,、。！？!?\s]+/, '').trim()
    return stripped ? { kind: 'command', commandText: stripped } : { kind: 'wake_only' }
  }

  return { kind: 'command', commandText: cleaned }
}

/**
 * Strip fenced code blocks, Markdown formatting, URLs, and noisy path
 * punctuation so spoken TTS output sounds natural and bounded.
 */
export function sanitizeSpeechText(markdown: string, maxChars = 1200): string {
  if (!markdown) return ''

  let text = markdown
  // Remove fenced code blocks completely before inline formatting cleanup.
  text = text.replace(/```[\s\S]*?```/g, ' ')
  text = text.replace(/~~~[\s\S]*?~~~/g, ' ')
  // Keep link/image labels while dropping URL targets.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  // Drop bare HTTP(S) and www URLs.
  text = text.replace(/https?:\/\/\S+/gi, ' ')
  text = text.replace(/\bwww\.\S+/gi, ' ')
  // Remove inline code ticks and common Markdown syntax markers.
  text = text.replace(/`([^`]*)`/g, '$1')
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  text = text.replace(/^\s{0,3}>\s?/gm, '')
  text = text.replace(/^\s*[-*+]\s+/gm, '')
  text = text.replace(/(\*\*|__|~~|\*)/g, '')
  text = text.replace(/(?<![a-zA-Z0-9])_|_(?![a-zA-Z0-9])/g, '')
  // Clean markdown table borders and noisy path separators without hurting decimals.
  text = text.replace(/\|[-:\s]+\|/g, ' ')
  text = text.replace(/[|\\]/g, ' ')
  text = text.replace(/\/{2,}/g, ' ')
  text = text.replace(/(^|\s)\/(?=\S)/g, '$1')
  text = text.replace(/(?<=[a-zA-Z0-9_\-.])\/(?=[a-zA-Z0-9_\-.])/g, ' ')
  text = text.replace(/[-=~]{3,}/g, ' ')
  text = text.replace(/\s+/g, ' ').trim()

  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 1200
  if (text.length <= limit) return text

  const slice = text.slice(0, limit)
  const boundaryIdx = Math.max(
    slice.lastIndexOf('。'),
    slice.lastIndexOf('！'),
    slice.lastIndexOf('？'),
    slice.lastIndexOf('；'),
    slice.lastIndexOf('. '),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? '),
    slice.lastIndexOf('，'),
    slice.lastIndexOf(', '),
    slice.lastIndexOf(' '),
  )
  if (boundaryIdx >= Math.floor(limit * 0.5)) {
    return slice.slice(0, boundaryIdx + 1).trim()
  }
  return slice.trim()
}

/**
 * Split speech text on sentence-ending punctuation and merge short fragments
 * (< 8 characters) so streaming TTS stays natural with low HTTP overhead.
 */
export function splitSpeechSentences(text: string): string[] {
  const cleaned = text.replace(/\r\n/g, '\n').trim()
  if (!cleaned) return []

  const rawSegments: string[] = []
  let start = 0

  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i]!
    const prev = i > 0 ? cleaned[i - 1]! : ''
    const next = i + 1 < cleaned.length ? cleaned[i + 1]! : ''

    const isCjkEnd = ch === '。' || ch === '！' || ch === '？' || ch === '；' || ch === '\n'
    const isAsciiBangOrQuestion = ch === '!' || ch === '?'
    const isAsciiPeriodBoundary =
      ch === '.' && !(/\d/.test(prev) && /\d/.test(next)) && (next === '' || /\s/.test(next))

    if (isCjkEnd || isAsciiBangOrQuestion || isAsciiPeriodBoundary) {
      const part = cleaned.slice(start, i + 1).trim()
      if (part) rawSegments.push(part)
      start = i + 1
    }
  }

  const tail = cleaned.slice(start).trim()
  if (tail) rawSegments.push(tail)

  if (rawSegments.length <= 1) {
    return rawSegments
  }

  const joinParts = (left: string, right: string): string => {
    if (!left) return right
    return /[。！？；]$/.test(left) ? `${left}${right}` : `${left} ${right}`
  }

  const merged: string[] = []
  let pending = ''

  for (const seg of rawSegments) {
    pending = joinParts(pending, seg)
    if (pending.length >= 8) {
      merged.push(pending.trim())
      pending = ''
    }
  }

  if (pending) {
    if (merged.length > 0) {
      merged[merged.length - 1] = joinParts(merged[merged.length - 1]!, pending).trim()
    } else {
      merged.push(pending.trim())
    }
  }

  return merged
}
