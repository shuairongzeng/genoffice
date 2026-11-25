import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_BUTLER_PREFS } from '../src/shared/butler-prefs'
import {
  DEFAULT_BUTLER_VOICE_CONFIG,
  type ButlerTtsStreamEvent,
} from '../src/shared/butler-voice-api'
import {
  AdaptiveVadDetector,
  TARGET_AUDIO_SAMPLE_RATE,
  createStreamingSpeechChunker,
  createStreamingWavParser,
  downsampleTo24kMono,
  encodePcm16ToWav,
  isLikelyAsrHallucination,
  isVoiceDismissPhrase,
  matchWakeWord,
  parseFollowUpTranscript,
  sanitizeSpeechText,
  splitSpeechSentences,
  uint8ToBase64,
} from '../src/renderer/src/butler-audio-dsp'
import {
  getButlerSpeechState,
  isButlerSpeakingOrEchoGuard,
  isButlerSpeechQueueBusy,
  playWakeEarcon,
  speakButlerSmart,
  startButlerMicCapture,
  stopButlerSpeech,
  subscribeButlerSpeechState,
} from '../src/renderer/src/butler-voice'

function makeConstantPcmFrame(length: number, amplitude: number): Int16Array {
  const frame = new Int16Array(length)
  const val = Math.max(-32768, Math.min(32767, Math.round(amplitude * 32768)))
  // Alternate sign per sample to preserve exact RMS without DC bias quirks.
  for (let i = 0; i < length; i += 1) {
    frame[i] = i % 2 === 0 ? val : -val
  }
  return frame
}

function makeStreamingWavHeader(sampleRate: number, placeholder = true): Uint8Array {
  const buf = new ArrayBuffer(44)
  const view = new DataView(buf)
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(off + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, placeholder ? 0xffffffff : 36, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, placeholder ? 0xffffffff : 0, true)
  return new Uint8Array(buf)
}

describe('downsampleTo24kMono', () => {
  it('downsamples 48 kHz mono audio to 24 kHz signed PCM16', () => {
    const input = new Float32Array(4800)
    for (let i = 0; i < input.length; i += 1) {
      input[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.5
    }
    const out = downsampleTo24kMono(input, 48000)
    expect(out.length).toBe(2400)
    // Peak should stay close to 0.5 * 32767 = ~16383
    let maxAbs = 0
    for (let i = 0; i < out.length; i += 1) {
      maxAbs = Math.max(maxAbs, Math.abs(out[i]!))
    }
    expect(maxAbs).toBeGreaterThan(15500)
    expect(maxAbs).toBeLessThanOrEqual(16384)
  })

  it('resamples 44.1 kHz via linear interpolation and clamps out-of-range samples', () => {
    const input = new Float32Array([1.8, -1.8, 0, Number.NaN, 0.5])
    const direct = downsampleTo24kMono(input, TARGET_AUDIO_SAMPLE_RATE)
    expect([...direct]).toEqual([32767, -32768, 0, 0, 16384])

    const tone44k = new Float32Array(4410)
    for (let i = 0; i < tone44k.length; i += 1) {
      tone44k[i] = 0.25
    }
    const resampled = downsampleTo24kMono(tone44k, 44100)
    expect(resampled.length).toBe(2400)
    expect(resampled[100]).toBeCloseTo(8192, -1)
  })

  it('returns empty Int16Array for empty input or invalid sample rates', () => {
    expect(downsampleTo24kMono(new Float32Array(0), 48000).length).toBe(0)
    expect(downsampleTo24kMono(new Float32Array([0.1, 0.2]), 0).length).toBe(0)
    expect(downsampleTo24kMono(new Float32Array([0.1, 0.2]), Number.NaN).length).toBe(0)
  })
})

describe('encodePcm16ToWav', () => {
  it('writes a valid 44-byte RIFF/WAVE PCM16 mono little-endian header and payload', () => {
    const samples = new Int16Array([0, 1000, -1000, 32767, -32768])
    const wav = encodePcm16ToWav(samples, 24000)

    expect(wav.length).toBe(44 + samples.length * 2)
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF')
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe('WAVE')
    expect(String.fromCharCode(...wav.subarray(12, 16))).toBe('fmt ')
    expect(String.fromCharCode(...wav.subarray(36, 40))).toBe('data')

    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
    expect(view.getUint32(4, true)).toBe(36 + 10)
    expect(view.getUint32(16, true)).toBe(16)
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(24000)
    expect(view.getUint32(28, true)).toBe(48000)
    expect(view.getUint16(32, true)).toBe(2)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(10)

    expect(view.getInt16(44, true)).toBe(0)
    expect(view.getInt16(46, true)).toBe(1000)
    expect(view.getInt16(48, true)).toBe(-1000)
    expect(view.getInt16(50, true)).toBe(32767)
    expect(view.getInt16(52, true)).toBe(-32768)
  })
})

describe('uint8ToBase64', () => {
  it('encodes empty and large buffers cleanly without call-stack overflow', () => {
    expect(uint8ToBase64(new Uint8Array(0))).toBe('')

    const large = new Uint8Array(250_000)
    for (let i = 0; i < large.length; i += 1) {
      large[i] = i & 0xff
    }
    const b64 = uint8ToBase64(large)
    expect(b64).toBe(Buffer.from(large).toString('base64'))
  })

  it('matches Buffer output even when using the browser chunked btoa fallback', () => {
    const origBuffer = globalThis.Buffer
    const sample = new Uint8Array(100_003)
    for (let i = 0; i < sample.length; i += 1) {
      sample[i] = (i * 13) & 0xff
    }
    const expected = origBuffer.from(sample).toString('base64')

    try {
      // @ts-expect-error Simulate browser runtime without Node Buffer
      globalThis.Buffer = undefined
      expect(uint8ToBase64(sample)).toBe(expected)
    } finally {
      globalThis.Buffer = origBuffer
    }
  })
})

describe('createStreamingWavParser', () => {
  it('accumulates 44-byte header across splits, supports 0xFFFFFFFF placeholders, and carries odd bytes', () => {
    const parser = createStreamingWavParser()
    const header = makeStreamingWavHeader(24000, true)
    const pcmSamples = new Int16Array([8192, -8192, 16384, -16384, 4096])
    const pcmBytes = new Uint8Array(pcmSamples.buffer)

    const fullStream = new Uint8Array(header.length + pcmBytes.length)
    fullStream.set(header, 0)
    fullStream.set(pcmBytes, header.length)

    // Split 1: partial header (15 bytes)
    expect(parser.push(fullStream.subarray(0, 15))).toBeNull()
    // Split 2: rest of header + 3 PCM bytes (1 full sample + 1 odd trailing byte)
    const chunk2 = parser.push(fullStream.subarray(15, 47))
    expect(chunk2).not.toBeNull()
    expect(chunk2!.sampleRate).toBe(24000)
    expect(chunk2!.samples.length).toBe(1)
    expect(chunk2!.samples[0]).toBeCloseTo(8192 / 32768, 5)

    // Split 3: 1 byte only (completes second sample together with carried odd byte)
    const chunk3 = parser.push(fullStream.subarray(47, 48))
    expect(chunk3).not.toBeNull()
    expect(chunk3!.samples.length).toBe(1)
    expect(chunk3!.samples[0]).toBeCloseTo(-8192 / 32768, 5)

    // Split 4: 1 odd byte -> buffered until next chunk
    expect(parser.push(fullStream.subarray(48, 49))).toBeNull()

    // Split 5: remaining bytes -> 3 samples
    const chunk5 = parser.push(fullStream.subarray(49))
    expect(chunk5).not.toBeNull()
    expect(chunk5!.samples.length).toBe(3)
    expect(chunk5!.samples[0]).toBeCloseTo(16384 / 32768, 5)
    expect(chunk5!.samples[1]).toBeCloseTo(-16384 / 32768, 5)
    expect(chunk5!.samples[2]).toBeCloseTo(4096 / 32768, 5)
  })

  it('reads custom sample rate from offset 24, falls back to 24000 if invalid, and resets cleanly', () => {
    const parser = createStreamingWavParser()
    const wav16k = encodePcm16ToWav(new Int16Array([1024, -1024]), 16000)
    const res1 = parser.push(wav16k)
    expect(res1?.sampleRate).toBe(16000)
    expect(res1?.samples.length).toBe(2)

    parser.reset()
    const badHeader = makeStreamingWavHeader(0, true)
    const pcm = new Uint8Array(new Int16Array([3276, -3276]).buffer)
    const combined = new Uint8Array(badHeader.length + pcm.length)
    combined.set(badHeader, 0)
    combined.set(pcm, badHeader.length)

    const res2 = parser.push(combined)
    expect(res2?.sampleRate).toBe(24000)
    expect(res2?.samples.length).toBe(2)
  })
})

describe('AdaptiveVadDetector', () => {
  it('retains pre-roll audio, triggers on speech, and emits completed segment after silenceMs', () => {
    // 24 kHz: 1 frame = 2400 samples (100ms)
    const vad = new AdaptiveVadDetector({
      sampleRate: 24000,
      silenceMs: 300,
      preRollMs: 200,
      minSpeechMs: 200,
      maxSegmentMs: 2000,
      minRmsThreshold: 0.012,
    })

    const idleFrame = makeConstantPcmFrame(2400, 0.002)
    // Mark distinct pre-roll signature sample so we verify pre-roll retention
    idleFrame[0] = 123
    for (let i = 0; i < 3; i += 1) {
      const res = vad.pushFrame(idleFrame)
      expect(res.speaking).toBe(false)
      expect(res.completedSegment).toBeNull()
    }

    const speechFrame = makeConstantPcmFrame(2400, 0.12)
    expect(vad.pushFrame(speechFrame).speaking).toBe(true)
    expect(vad.pushFrame(speechFrame).speaking).toBe(true)

    const quietFrame = makeConstantPcmFrame(2400, 0.001)
    expect(vad.pushFrame(quietFrame).completedSegment).toBeNull()
    expect(vad.pushFrame(quietFrame).completedSegment).toBeNull()
    const done = vad.pushFrame(quietFrame)
    expect(done.speaking).toBe(false)
    expect(done.completedSegment).not.toBeNull()
    // Pre-roll (200ms = 4800) + speech (200ms = 4800) + trailing keep (<= 250ms)
    expect(done.completedSegment!.length).toBeGreaterThanOrEqual(4800 + 4800)
    expect(done.completedSegment![0]).toBe(123)
  })

  it('adapts noise floor via slow EMA and suppresses transient short bursts below minSpeechMs', () => {
    const vad = new AdaptiveVadDetector({
      sampleRate: 24000,
      silenceMs: 200,
      preRollMs: 100,
      minSpeechMs: 300,
      minRmsThreshold: 0.012,
    })

    // Raise ambient noise floor to ~0.010 -> threshold rises toward ~0.028
    const ambient = makeConstantPcmFrame(2400, 0.01)
    for (let i = 0; i < 40; i += 1) {
      vad.pushFrame(ambient)
    }
    expect(vad.currentThreshold).toBeGreaterThan(0.02)

    // Moderate burst below adaptive threshold must not trigger speech
    const mildNoise = makeConstantPcmFrame(2400, 0.02)
    expect(vad.pushFrame(mildNoise).speaking).toBe(false)

    // Single 100ms loud click (< 300ms minSpeechMs) should be discarded after silence
    const click = makeConstantPcmFrame(2400, 0.25)
    expect(vad.pushFrame(click).speaking).toBe(true)
    const quiet = makeConstantPcmFrame(2400, 0.001)
    vad.pushFrame(quiet)
    const afterClick = vad.pushFrame(quiet)
    expect(afterClick.speaking).toBe(false)
    expect(afterClick.completedSegment).toBeNull()
  })

  it('cuts at maxSegmentMs and supports flush/reset', () => {
    const vad = new AdaptiveVadDetector({
      sampleRate: 24000,
      silenceMs: 500,
      preRollMs: 100,
      minSpeechMs: 200,
      maxSegmentMs: 500,
    })

    const speech = makeConstantPcmFrame(2400, 0.15) // 100ms per frame
    for (let i = 0; i < 4; i += 1) {
      expect(vad.pushFrame(speech).completedSegment).toBeNull()
    }
    const maxHit = vad.pushFrame(speech)
    expect(maxHit.speaking).toBe(false)
    expect(maxHit.completedSegment).not.toBeNull()
    expect(maxHit.completedSegment!.length).toBe(12000)

    // Test flush when speech meets minSpeechMs
    vad.pushFrame(speech)
    vad.pushFrame(speech)
    const flushed = vad.flush()
    expect(flushed).not.toBeNull()
    expect(flushed!.length).toBe(4800)

    // Test flush when below minSpeechMs
    vad.pushFrame(speech)
    expect(vad.flush()).toBeNull()

    vad.pushFrame(speech)
    vad.reset()
    expect(vad.isSpeaking).toBe(false)
    expect(vad.flush()).toBeNull()
  })

  it('clamps adaptive noise floor ceiling and supports pauseAndClear without resetting noise floor', () => {
    const vad = new AdaptiveVadDetector({
      sampleRate: 24000,
      silenceMs: 300,
      preRollMs: 100,
      minSpeechMs: 200,
      minRmsThreshold: 0.012,
    })

    // Seed an ambient noise floor, then feed loud sub-threshold frames repeatedly;
    // the noise floor must stay bounded by MAX_ADAPTIVE_NOISE_FLOOR (0.025).
    const quiet = makeConstantPcmFrame(2400, 0.005)
    vad.pushFrame(quiet)
    const loudAmbient = makeConstantPcmFrame(2400, 0.03)
    for (let i = 0; i < 100; i += 1) {
      vad.pushFrame(loudAmbient)
    }
    expect(vad.currentNoiseFloor).toBeLessThanOrEqual(0.025)
    expect(vad.currentThreshold).toBeLessThanOrEqual(0.0701)

    // Subsequent moderate speech above capped threshold still triggers cleanly.
    const speech = makeConstantPcmFrame(2400, 0.09)
    expect(vad.pushFrame(speech).speaking).toBe(true)

    // pauseAndClear drops active segment & pre-roll while keeping adapted noise floor.
    const floorBeforePause = vad.currentNoiseFloor
    vad.pauseAndClear()
    expect(vad.isSpeaking).toBe(false)
    expect(vad.flush()).toBeNull()
    expect(vad.currentNoiseFloor).toBe(floorBeforePause)
  })

  it('finalizes utterance promptly after loud speech even with AGC-elevated background noise and single-frame clicks', () => {
    const vad = new AdaptiveVadDetector({
      sampleRate: 24000,
      silenceMs: 400,
      preRollMs: 100,
      minSpeechMs: 300,
      minRmsThreshold: 0.012,
    })

    // User speaks loudly (~0.14 RMS) for 400ms (4 x 100ms frames).
    const speech = makeConstantPcmFrame(2400, 0.14)
    for (let i = 0; i < 4; i += 1) {
      expect(vad.pushFrame(speech).speaking).toBe(true)
    }

    // After user stops talking, AGC boosts fan/room noise to ~0.020 (> 0.012 minRmsThreshold,
    // yet well below peak * 0.28 = 0.0392), plus a single 100ms click spike (0.045 < peak * 0.55).
    const agcNoise = makeConstantPcmFrame(2400, 0.02)
    const click = makeConstantPcmFrame(2400, 0.045)

    vad.pushFrame(agcNoise) // 100ms silence
    vad.pushFrame(agcNoise) // 200ms silence
    vad.pushFrame(click) // single transient click -> only partially decays silence, does NOT reset
    vad.pushFrame(agcNoise) // ~200ms
    vad.pushFrame(agcNoise) // ~300ms
    const finalized = vad.pushFrame(agcNoise) // >= 400ms -> cuts cleanly!

    expect(finalized.speaking).toBe(false)
    expect(finalized.completedSegment).not.toBeNull()
  })

  it('drops weak near-threshold room noise and sparse transient clicks', () => {
    const vad = new AdaptiveVadDetector({
      sampleRate: 24000,
      silenceMs: 700,
      preRollMs: 100,
      minSpeechMs: 300,
      minRmsThreshold: 0.012,
    })

    // Peak RMS below 1.35 * minRmsThreshold (0.0162) is rejected even if >= 0.012.
    const weakNoise = makeConstantPcmFrame(2400, 0.014)
    for (let i = 0; i < 4; i += 1) {
      vad.pushFrame(weakNoise)
    }
    const quiet = makeConstantPcmFrame(2400, 0.001)
    let weakCompleted: Int16Array | null = null
    for (let i = 0; i < 8; i += 1) {
      const res = vad.pushFrame(quiet)
      if (res.completedSegment) weakCompleted = res.completedSegment
    }
    expect(weakCompleted).toBeNull()

    // Sparse transient clicks (200ms burst + 1500ms silence + 200ms burst) have voiced ratio < 0.2.
    const click = makeConstantPcmFrame(2400, 0.08)
    const room = makeConstantPcmFrame(2400, 0.003)
    vad.pushFrame(click)
    vad.pushFrame(click)
    for (let i = 0; i < 5; i += 1) vad.pushFrame(room) // 500ms (< 700ms silenceMs)
    vad.pushFrame(click)
    for (let i = 0; i < 5; i += 1) vad.pushFrame(room)
    vad.pushFrame(click)
    for (let i = 0; i < 6; i += 1) vad.pushFrame(room)
    // Now voiced=400ms, total non-pre-roll=2000ms => ratio 0.20, add 2 more room frames to drop below 0.2.
    const almost = vad.pushFrame(room)
    expect(almost.completedSegment).toBeNull()
    expect(vad.flush()).toBeNull()
  })
})

describe('isLikelyAsrHallucination', () => {
  it('filters subtitle watermarks, song/encyclopedia trivia, and filler loops while preserving real tasks', () => {
    expect(isLikelyAsrHallucination('')).toBe(true)
    expect(isLikelyAsrHallucination('  ，，。 ')).toBe(true)
    expect(
      isLikelyAsrHallucination(
        '《爱的初体验》是张学友演唱的一首歌曲，收录于1990年12月1日发行的专辑《爱的初体验》中。',
      ),
    ).toBe(true)
    expect(isLikelyAsrHallucination('感谢观看，请不吝点赞订阅我的频道！')).toBe(true)
    expect(isLikelyAsrHallucination('Subtitles by Amara.org')).toBe(true)
    expect(isLikelyAsrHallucination('哈哈哈哈')).toBe(true)
    expect(isLikelyAsrHallucination('嗯嗯嗯嗯。')).toBe(true)

    expect(isLikelyAsrHallucination('帮我写一篇《小王子》读后感')).toBe(false)
    expect(isLikelyAsrHallucination('查一下《爱的初体验》')).toBe(false)
    expect(isLikelyAsrHallucination('今天天气真不错')).toBe(false)

    expect(
      parseFollowUpTranscript(
        '《爱的初体验》是张学友演唱的一首歌曲，收录于1990年12月1日发行的专辑《爱的初体验》中。',
        '贾维斯',
      ),
    ).toEqual({ kind: 'empty' })
    expect(parseFollowUpTranscript('帮我写一篇《小王子》读后感', '贾维斯')).toEqual({
      kind: 'command',
      commandText: '帮我写一篇《小王子》读后感',
    })
  })
})

describe('createStreamingSpeechChunker', () => {
  it('cuts first clause eagerly at natural pauses and emits subsequent sentences safely', () => {
    const chunker = createStreamingSpeechChunker({ firstMinChars: 6, nextMinChars: 12 })

    expect(chunker.push('好的先生，')).toEqual([])
    expect(chunker.push('好的先生，接下来')).toEqual([])
    expect(chunker.push('好的先生，接下来为您整理，版本号 v3.8 和 https://example.com/a.b 文档。')).toEqual([
      '好的先生，接下来为您整理，',
      '版本号 v3.8 和 https://example.com/a.b 文档。',
    ])
    expect(chunker.emittedCount).toBe(2)

    expect(chunker.push('好的先生，接下来为您整理，版本号 v3.8 和 https://example.com/a.b 文档。请稍等')).toEqual([])
    expect(chunker.flush()).toEqual(['请稍等'])
    expect(chunker.emittedCount).toBe(3)

    chunker.reset()
    expect(chunker.emittedCount).toBe(0)
  })

  it('supports delta mode, ignores shrinking cumulative replays, and strips markdown tokens', () => {
    const chunker = createStreamingSpeechChunker({ firstMinChars: 6, nextMinChars: 12 })

    expect(chunker.push('**收到您的指示**，', 'delta')).toEqual(['收到您的指示，'])
    expect(chunker.push('我们正在生成 `report.docx` 的完整摘要。', 'delta')).toEqual([
      '我们正在生成 report.docx 的完整摘要。',
    ])

    // Cumulative shrink/replay check and nextMinChars threshold
    const cumChunker = createStreamingSpeechChunker()
    expect(cumChunker.push('收到您的指示，现在立刻为您开始并行执行任务。')).toEqual([
      '收到您的指示，',
      '现在立刻为您开始并行执行任务。',
    ])
    expect(cumChunker.push('收到您的')).toEqual([])
    // Short tail (< nextMinChars=12) stays buffered until flush()
    expect(cumChunker.push('收到您的指示，现在立刻为您开始并行执行任务。已就绪。')).toEqual([])
    expect(cumChunker.flush()).toEqual(['已就绪。'])
  })
})

describe('isVoiceDismissPhrase and parseFollowUpTranscript', () => {
  it('recognizes standalone dismiss phrases and preserves actionable commands', () => {
    expect(isVoiceDismissPhrase('没事了')).toBe(true)
    expect(isVoiceDismissPhrase('好的，谢谢，贾维斯，退下吧！', '贾维斯')).toBe(true)
    expect(isVoiceDismissPhrase('先这样吧')).toBe(true)
    expect(isVoiceDismissPhrase('Ok, stop listening.', 'Jarvis')).toBe(true)

    // Must NOT treat a phrase with a trailing task instruction as dismiss.
    expect(isVoiceDismissPhrase('不用了，帮我把标题改成红色', '贾维斯')).toBe(false)
    // Bare wake word is NOT a dismiss phrase.
    expect(isVoiceDismissPhrase('贾维斯', '贾维斯')).toBe(false)

    expect(parseFollowUpTranscript('   ，，。 ', '贾维斯')).toEqual({ kind: 'empty' })
    expect(parseFollowUpTranscript('贾维斯', '贾维斯')).toEqual({ kind: 'wake_only' })
    expect(parseFollowUpTranscript('没事了呀', '贾维斯')).toEqual({ kind: 'dismiss' })
    expect(parseFollowUpTranscript('那第二页的数据呢？', '贾维斯')).toEqual({
      kind: 'command',
      commandText: '那第二页的数据呢？',
    })
    expect(parseFollowUpTranscript('贾维斯，再总结一下重点', '贾维斯')).toEqual({
      kind: 'command',
      commandText: '再总结一下重点',
    })
  })
})

describe('matchWakeWord', () => {
  it('handles live Qwen3-ASR comma-separated greeting + wake word + command', () => {
    const res = matchWakeWord(
      '你好，贾维斯，帮我把季度汇报整理成演示文稿。',
      '贾维斯',
      'Jarvis,佳维斯,贾维思,小贾',
    )
    expect(res).toEqual({
      matched: true,
      mode: 'command',
      wakeWord: '贾维斯',
      commandText: '帮我把季度汇报整理成演示文稿。',
    })
  })

  it('returns listen mode when only greeting, wake word, punctuation, or trailing fillers exist', () => {
    expect(matchWakeWord('贾维斯', '贾维斯')).toEqual({
      matched: true,
      mode: 'listen',
      wakeWord: '贾维斯',
    })
    expect(matchWakeWord('你好，贾维斯！', '贾维斯')).toEqual({
      matched: true,
      mode: 'listen',
      wakeWord: '贾维斯',
    })
    expect(matchWakeWord('Hey Jarvis, hello!', '贾维斯', 'Jarvis')).toEqual({
      matched: true,
      mode: 'listen',
      wakeWord: 'Jarvis',
    })
    expect(matchWakeWord('嗯，嗨，佳维斯，那个...', '贾维斯')).toEqual({
      matched: true,
      mode: 'listen',
      wakeWord: '佳维斯',
    })
  })

  it('matches homophones, longest aliases, ASCII case-insensitively, and respects word boundaries', () => {
    expect(matchWakeWord('贾维思帮我打开日程', '贾维斯')).toEqual({
      matched: true,
      mode: 'command',
      wakeWord: '贾维思',
      commandText: '帮我打开日程',
    })

    // Longest alias wins over shorter prefix
    expect(
      matchWakeWord('小贾同学，总结一下今天邮件', '贾维斯', '小贾/小贾同学|Jarvis'),
    ).toEqual({
      matched: true,
      mode: 'command',
      wakeWord: '小贾同学',
      commandText: '总结一下今天邮件',
    })

    expect(matchWakeWord('ok JARVIS: draft quarterly summary', 'Jarvis')).toEqual({
      matched: true,
      mode: 'command',
      wakeWord: 'Jarvis',
      commandText: 'draft quarterly summary',
    })

    // Must not partially match inside a longer ASCII identifier
    expect(matchWakeWord('Jarvison please check this', 'Jarvis')).toEqual({
      matched: false,
    })
    expect(matchWakeWord('请帮我打开桌面', '贾维斯', 'Jarvis,小贾')).toEqual({
      matched: false,
    })
  })
})

describe('sanitizeSpeechText and splitSpeechSentences', () => {
  it('strips code fences, markdown markers, links, URLs, and noisy paths cleanly', () => {
    const md = [
      '# 季度汇报 Summary',
      '',
      '详情请查看 [汇报文档](https://example.com/q4/report) 或访问 https://internal.local/docs 。',
      '',
      '```ts',
      'const secret = 123',
      '```',
      '',
      '- 文件路径 `C:\\Users\\Alice\\report_v1.2.docx` 已更新 **已完成**。',
    ].join('\n')

    const clean = sanitizeSpeechText(md)
    expect(clean).not.toContain('```')
    expect(clean).not.toContain('const secret')
    expect(clean).not.toContain('https://')
    expect(clean).not.toContain('**')
    expect(clean).not.toContain('\\')
    expect(clean).toContain('季度汇报 Summary')
    expect(clean).toContain('汇报文档')
    expect(clean).toContain('report_v1.2.docx')
  })

  it('truncates cleanly at maxChars and preserves decimals while splitting/merging sentences', () => {
    const longText = '第一句话已经完成。第二句话也准备好了，请您查看具体数据。第三句话是额外的补充说明内容。'
    const truncated = sanitizeSpeechText(longText, 24)
    expect(truncated.length).toBeLessThanOrEqual(24)
    expect(truncated.endsWith('。') || truncated.endsWith('，')).toBe(true)

    const sentences = splitSpeechSentences('好！版本号 v1.5 已经发布成功。收到。')
    expect(sentences).toEqual(['好！版本号 v1.5 已经发布成功。收到。'])

    const multi = splitSpeechSentences(
      '第一部分分析已经全部完成，结果保存在桌面文档里。第二部分请您确认是否需要导出幻灯片！',
    )
    expect(multi).toEqual([
      '第一部分分析已经全部完成，结果保存在桌面文档里。',
      '第二部分请您确认是否需要导出幻灯片！',
    ])
  })
})

describe('butler-voice smart playback, earcons, and mic capture', () => {
  beforeEach(() => {
    stopButlerSpeech()
  })

  afterEach(() => {
    stopButlerSpeech()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function installFakeAudioContext() {
    const startedSources: Array<{ startTime: number; duration: number; stopped: boolean }> = []
    const createdOscillators: Array<{ freq: number; type: string }> = []
    const createdFilters: Array<{ type: string; frequency: number }> = []
    let processorNode: {
      onaudioprocess: ((e: { inputBuffer: { getChannelData: (c: number) => Float32Array } }) => void) | null
      connect: ReturnType<typeof vi.fn>
      disconnect: ReturnType<typeof vi.fn>
    } | null = null

    class FakeAudioContext {
      sampleRate = 48000
      currentTime = 0
      state: AudioContextState = 'running'
      destination = {} as AudioDestinationNode
      resume = vi.fn().mockResolvedValue(undefined)
      close = vi.fn().mockResolvedValue(undefined)

      createBuffer(_channels: number, length: number, sampleRate: number) {
        const channel = new Float32Array(length)
        return {
          duration: length / sampleRate,
          getChannelData: () => channel,
        } as unknown as AudioBuffer
      }

      createBufferSource() {
        const rec = { startTime: -1, duration: 0, stopped: false }
        let bufDuration = 0
        const node = {
          set buffer(b: AudioBuffer | null) {
            bufDuration = b?.duration ?? 0
          },
          get buffer() {
            return null
          },
          onended: null as (() => void) | null,
          connect: vi.fn(),
          disconnect: vi.fn(),
          start: vi.fn((when = 0) => {
            rec.startTime = when
            rec.duration = bufDuration
            startedSources.push(rec)
          }),
          stop: vi.fn(() => {
            rec.stopped = true
          }),
        }
        return node as unknown as AudioBufferSourceNode
      }

      createOscillator() {
        const rec = { freq: 0, type: 'sine' }
        createdOscillators.push(rec)
        return {
          set type(t: OscillatorType) {
            rec.type = t
          },
          frequency: {
            setValueAtTime: vi.fn((f: number) => {
              rec.freq = f
            }),
          },
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
        } as unknown as OscillatorNode
      }

      createGain() {
        return {
          gain: {
            value: 1,
            setValueAtTime: vi.fn(),
            exponentialRampToValueAtTime: vi.fn(),
          },
          connect: vi.fn(),
          disconnect: vi.fn(),
        } as unknown as GainNode
      }

      createBiquadFilter() {
        const rec = { type: 'allpass', frequency: 0 }
        createdFilters.push(rec)
        return {
          set type(t: BiquadFilterType) {
            rec.type = t
          },
          frequency: {
            set value(v: number) {
              rec.frequency = v
            },
            get value() {
              return rec.frequency
            },
          },
          Q: { value: 0 },
          connect: vi.fn(),
          disconnect: vi.fn(),
        } as unknown as BiquadFilterNode
      }

      createMediaStreamSource() {
        return {
          connect: vi.fn(),
          disconnect: vi.fn(),
        } as unknown as MediaStreamAudioSourceNode
      }

      createScriptProcessor() {
        processorNode = {
          onaudioprocess: null,
          connect: vi.fn(),
          disconnect: vi.fn(),
        }
        return processorNode as unknown as ScriptProcessorNode
      }
    }

    return {
      FakeAudioContext,
      startedSources,
      createdOscillators,
      createdFilters,
      getProcessor: () => processorNode,
    }
  }

  it('streams sentence-by-sentence via oMLX into Web Audio queue and holds 500ms Echo-Guard', async () => {
    const fakeAudio = installFakeAudioContext()
    let ttsListener: ((ev: ButlerTtsStreamEvent) => void) | null = null
    const startedRequests: Array<{ requestId: string; text: string; voice?: string }> = []
    const arbitrationUpdates: Array<{ ttsSpeaking?: boolean }> = []
    const stateSnapshots: Array<{ speaking: boolean; sourceId: string | null }> = []

    let fakeNow = 10_000
    vi.spyOn(Date, 'now').mockImplementation(() => fakeNow)

    const unsubState = subscribeButlerSpeechState((s) => stateSnapshots.push(s))

    const header = makeStreamingWavHeader(24000, true)
    const pcmBytes = new Uint8Array(new Int16Array(240).buffer) // 10ms @ 24kHz
    const streamPayload = new Uint8Array(header.length + pcmBytes.length)
    streamPayload.set(header, 0)
    streamPayload.set(pcmBytes, header.length)

    const aiOffice = {
      butlerVoiceTtsStart: vi.fn(async (req: { requestId: string; text: string; voice?: string }) => {
        startedRequests.push(req)
        queueMicrotask(() => {
          ttsListener?.({
            requestId: req.requestId,
            type: 'chunk',
            chunk: streamPayload.subarray(0, 20),
          })
          ttsListener?.({
            requestId: req.requestId,
            type: 'chunk',
            chunk: streamPayload.subarray(20),
          })
          ttsListener?.({ requestId: req.requestId, type: 'done' })
        })
        return { ok: true, requestId: req.requestId }
      }),
      butlerVoiceTtsStop: vi.fn().mockResolvedValue(undefined),
      onButlerVoiceTtsEvent: vi.fn((cb: (ev: ButlerTtsStreamEvent) => void) => {
        ttsListener = cb
        return () => {
          if (ttsListener === cb) ttsListener = null
        }
      }),
      reportButlerVoiceArbitration: vi.fn((patch: { ttsSpeaking?: boolean }) => {
        arbitrationUpdates.push(patch)
      }),
    }

    vi.stubGlobal('window', {
      AudioContext: fakeAudio.FakeAudioContext,
      aiOffice,
    })

    await speakButlerSmart('第一句测试语音已经准备好。第二句测试语音也已经准备好了。', {
      prefs: DEFAULT_BUTLER_PREFS,
      voiceConfig: DEFAULT_BUTLER_VOICE_CONFIG,
      langTag: 'zh-CN',
      sourceId: 'entry-1',
    })
    unsubState()

    expect(startedRequests).toHaveLength(2)
    expect(startedRequests[0]?.voice).toBe('serena')
    expect(fakeAudio.startedSources).toHaveLength(2)
    // Second chunk must schedule cleanly at or after the end of the first chunk.
    expect(fakeAudio.startedSources[1]!.startTime).toBeGreaterThanOrEqual(
      fakeAudio.startedSources[0]!.startTime + fakeAudio.startedSources[0]!.duration - 1e-6,
    )

    expect(stateSnapshots).toEqual([
      { speaking: true, sourceId: 'entry-1' },
      { speaking: false, sourceId: null },
    ])
    expect(arbitrationUpdates).toEqual([{ ttsSpeaking: true }, { ttsSpeaking: false }])
    expect(getButlerSpeechState()).toEqual({ speaking: false, sourceId: null })

    // Echo-Guard remains true for 180ms after natural playback completion.
    expect(isButlerSpeakingOrEchoGuard()).toBe(true)
    fakeNow += 120
    expect(isButlerSpeakingOrEchoGuard()).toBe(true)
    fakeNow += 70
    expect(isButlerSpeakingOrEchoGuard()).toBe(false)
  })

  it('falls back to system speechSynthesis when oMLX reports fallbackSystem=true', async () => {
    const fakeAudio = installFakeAudioContext()
    const spoken: Array<{ text: string; rate: number; lang: string }> = []

    class FakeUtterance {
      text: string
      rate = 1
      lang = ''
      voice: SpeechSynthesisVoice | null = null
      onend: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor(text: string) {
        this.text = text
      }
    }

    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)

    const speechSynthesis = {
      speaking: false,
      pending: false,
      cancel: vi.fn(),
      getVoices: vi.fn(() => []),
      speak: vi.fn((u: FakeUtterance) => {
        spoken.push({ text: u.text, rate: u.rate, lang: u.lang })
        queueMicrotask(() => u.onend?.())
      }),
    }

    const aiOffice = {
      butlerVoiceTtsStart: vi.fn(async (req: { requestId: string }) => ({
        ok: false,
        requestId: req.requestId,
        fallbackSystem: true,
        error: 'offline',
      })),
      onButlerVoiceTtsEvent: vi.fn(() => () => {}),
      reportButlerVoiceArbitration: vi.fn(),
    }

    vi.stubGlobal('window', {
      AudioContext: fakeAudio.FakeAudioContext,
      speechSynthesis,
      aiOffice,
    })

    await speakButlerSmart('Fallback message works.', {
      prefs: { ...DEFAULT_BUTLER_PREFS, voiceRate: 1.2 },
      voiceConfig: DEFAULT_BUTLER_VOICE_CONFIG,
      langTag: 'en-US',
    })

    expect(spoken).toEqual([{ text: 'Fallback message works.', rate: 1.2, lang: 'en-US' }])
  })

  it('supports barge-in stopButlerSpeech and plays earcons safely', async () => {
    const fakeAudio = installFakeAudioContext()
    const stopSpy = vi.fn().mockResolvedValue(undefined)
    const cancelSpy = vi.fn()
    const arbSpy = vi.fn()

    vi.stubGlobal('window', {
      AudioContext: fakeAudio.FakeAudioContext,
      speechSynthesis: { cancel: cancelSpy, getVoices: () => [], speak: vi.fn() },
      aiOffice: {
        butlerVoiceTtsStart: vi.fn(async (req: { requestId: string }) => ({
          ok: true,
          requestId: req.requestId,
        })),
        butlerVoiceTtsStop: stopSpy,
        onButlerVoiceTtsEvent: vi.fn(() => () => {}),
        reportButlerVoiceArbitration: arbSpy,
      },
    })

    const pendingSpeak = speakButlerSmart('Never ending until interrupted.', {
      prefs: DEFAULT_BUTLER_PREFS,
      voiceConfig: DEFAULT_BUTLER_VOICE_CONFIG,
      langTag: 'en-US',
    })

    // Wait a tick for butlerVoiceTtsStart to register activeRequestId.
    await Promise.resolve()
    await Promise.resolve()
    expect(getButlerSpeechState().speaking).toBe(true)

    stopButlerSpeech()
    await pendingSpeak

    expect(stopSpy).toHaveBeenCalledTimes(1)
    expect(cancelSpy).toHaveBeenCalled()
    expect(getButlerSpeechState().speaking).toBe(false)
    expect(arbSpy).toHaveBeenLastCalledWith({ ttsSpeaking: false })

    playWakeEarcon('wake')
    playWakeEarcon('done')
    playWakeEarcon('cancel')
    expect(fakeAudio.createdOscillators).toHaveLength(6)
  })

  it('captures mic audio with optional human-voice bandpass and emits WAV segments', async () => {
    const fakeAudio = installFakeAudioContext()
    const trackStop = vi.fn()
    const fakeStream = {
      getTracks: () => [{ stop: trackStop }],
    } as unknown as MediaStream

    vi.stubGlobal('window', {
      AudioContext: fakeAudio.FakeAudioContext,
    })
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(fakeStream),
      },
    })

    const segments: Uint8Array[] = []
    const levels: number[] = []
    const handle = startButlerMicCapture({
      silenceMs: 300,
      continuous: false,
      bandpassHumanVoice: true,
      onLevel: (lvl) => levels.push(lvl),
      onSpeechSegment: (wav) => segments.push(wav),
    })

    // Wait for getUserMedia promise chain to connect nodes.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(fakeAudio.createdFilters).toEqual([
      { type: 'highpass', frequency: 280 },
      { type: 'lowpass', frequency: 3500 },
    ])

    const proc = fakeAudio.getProcessor()
    expect(proc).not.toBeNull()

    const makeInputFrame = (amp: number) => {
      const buf = new Float32Array(4096) // ~85.3ms @ 48kHz -> 2048 samples @ 24kHz
      for (let i = 0; i < buf.length; i += 1) {
        buf[i] = i % 2 === 0 ? amp : -amp
      }
      return { inputBuffer: { getChannelData: () => buf } }
    }

    // Feed ~425ms speech (5 frames) then ~340ms silence (4 frames)
    for (let i = 0; i < 5; i += 1) proc!.onaudioprocess!(makeInputFrame(0.15))
    for (let i = 0; i < 4; i += 1) proc!.onaudioprocess!(makeInputFrame(0.001))

    expect(levels.length).toBe(9)
    expect(segments).toHaveLength(1)
    expect(String.fromCharCode(...segments[0]!.subarray(0, 4))).toBe('RIFF')
    expect(String.fromCharCode(...segments[0]!.subarray(8, 12))).toBe('WAVE')
    // Non-continuous capture auto-stops tracks once a segment completes.
    expect(trackStop).toHaveBeenCalledTimes(1)

    handle.stop()
  })

  it('preempts prior speakButlerSmart call without letting old cleanup clear new state', async () => {
    const fakeAudio = installFakeAudioContext()
    let ttsListener: ((ev: ButlerTtsStreamEvent) => void) | null = null
    const startedReqIds: string[] = []
    const arbitrationUpdates: Array<{ ttsSpeaking?: boolean }> = []

    const header = makeStreamingWavHeader(24000, true)
    const pcmBytes = new Uint8Array(new Int16Array(240).buffer)
    const streamPayload = new Uint8Array(header.length + pcmBytes.length)
    streamPayload.set(header, 0)
    streamPayload.set(pcmBytes, header.length)

    vi.stubGlobal('window', {
      AudioContext: fakeAudio.FakeAudioContext,
      aiOffice: {
        butlerVoiceTtsStart: vi.fn(async (req: { requestId: string; text: string }) => {
          startedReqIds.push(req.requestId)
          if (req.text.includes('Second')) {
            queueMicrotask(() => {
              ttsListener?.({ requestId: req.requestId, type: 'chunk', chunk: streamPayload })
              ttsListener?.({ requestId: req.requestId, type: 'done' })
            })
          }
          return { ok: true, requestId: req.requestId }
        }),
        butlerVoiceTtsStop: vi.fn().mockResolvedValue(undefined),
        onButlerVoiceTtsEvent: vi.fn((cb: (ev: ButlerTtsStreamEvent) => void) => {
          ttsListener = cb
          return () => {
            if (ttsListener === cb) ttsListener = null
          }
        }),
        reportButlerVoiceArbitration: vi.fn((patch: { ttsSpeaking?: boolean }) => {
          arbitrationUpdates.push(patch)
        }),
      },
    })

    const first = speakButlerSmart('First utterance stays open.', {
      prefs: DEFAULT_BUTLER_PREFS,
      voiceConfig: DEFAULT_BUTLER_VOICE_CONFIG,
      langTag: 'en-US',
      sourceId: 'first',
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(getButlerSpeechState()).toEqual({ speaking: true, sourceId: 'first' })

    const second = speakButlerSmart('Second utterance takes over cleanly.', {
      prefs: DEFAULT_BUTLER_PREFS,
      voiceConfig: DEFAULT_BUTLER_VOICE_CONFIG,
      langTag: 'en-US',
      sourceId: 'second',
    })
    await Promise.all([first, second])

    expect(startedReqIds).toHaveLength(2)
    expect(getButlerSpeechState()).toEqual({ speaking: false, sourceId: null })
    expect(arbitrationUpdates.at(-1)).toEqual({ ttsSpeaking: false })
  })

  it('supports continuous sentinel mode and stop(true) flushPending capture', async () => {
    const fakeAudio = installFakeAudioContext()
    const trackStop = vi.fn()
    const fakeStream = {
      getTracks: () => [{ stop: trackStop }],
    } as unknown as MediaStream

    vi.stubGlobal('window', {
      AudioContext: fakeAudio.FakeAudioContext,
    })
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(fakeStream),
      },
    })

    const segments: Uint8Array[] = []
    const handle = startButlerMicCapture({
      silenceMs: 300,
      continuous: true,
      onSpeechSegment: (wav) => segments.push(wav),
    })

    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    const proc = fakeAudio.getProcessor()!
    const makeInputFrame = (amp: number) => {
      const buf = new Float32Array(4096)
      for (let i = 0; i < buf.length; i += 1) {
        buf[i] = i % 2 === 0 ? amp : -amp
      }
      return { inputBuffer: { getChannelData: () => buf } }
    }

    // Segment 1 completes naturally; continuous mode keeps tracks open.
    for (let i = 0; i < 5; i += 1) proc.onaudioprocess!(makeInputFrame(0.15))
    for (let i = 0; i < 4; i += 1) proc.onaudioprocess!(makeInputFrame(0.001))
    expect(segments).toHaveLength(1)
    expect(trackStop).not.toHaveBeenCalled()

    // Segment 2 starts speaking and is flushed manually via stop(true).
    for (let i = 0; i < 5; i += 1) proc.onaudioprocess!(makeInputFrame(0.15))
    handle.stop(true)
    expect(segments).toHaveLength(2)
    expect(trackStop).toHaveBeenCalledTimes(1)
  })

  it('reports capture error gracefully when getUserMedia is unavailable', () => {
    vi.stubGlobal('navigator', undefined)
    const onError = vi.fn()
    const handle = startButlerMicCapture({
      silenceMs: 750,
      onSpeechSegment: vi.fn(),
      onError,
    })
    expect(onError).toHaveBeenCalledTimes(1)
    handle.stop()
  })

  it('plays queued utterances sequentially without preemption when enqueue=true and clears queue on stopButlerSpeech', async () => {
    const fakeAudio = installFakeAudioContext()
    let ttsListener: ((ev: ButlerTtsStreamEvent) => void) | null = null
    const startedTexts: string[] = []
    const pendingRequests: string[] = []
    const arbitrationUpdates: Array<{ ttsSpeaking?: boolean }> = []

    const header = makeStreamingWavHeader(24000, true)
    const pcmBytes = new Uint8Array(new Int16Array(240).buffer)
    const streamPayload = new Uint8Array(header.length + pcmBytes.length)
    streamPayload.set(header, 0)
    streamPayload.set(pcmBytes, header.length)

    vi.stubGlobal('window', {
      AudioContext: fakeAudio.FakeAudioContext,
      speechSynthesis: { cancel: vi.fn(), getVoices: () => [], speak: vi.fn() },
      aiOffice: {
        butlerVoiceTtsStart: vi.fn(async (req: { requestId: string; text: string }) => {
          startedTexts.push(req.text)
          pendingRequests.push(req.requestId)
          return { ok: true, requestId: req.requestId }
        }),
        butlerVoiceTtsStop: vi.fn().mockResolvedValue(undefined),
        onButlerVoiceTtsEvent: vi.fn((cb: (ev: ButlerTtsStreamEvent) => void) => {
          ttsListener = cb
          return () => {
            if (ttsListener === cb) ttsListener = null
          }
        }),
        reportButlerVoiceArbitration: vi.fn((patch: { ttsSpeaking?: boolean }) => {
          arbitrationUpdates.push(patch)
        }),
      },
    })

    const first = speakButlerSmart('First queued line.', {
      prefs: DEFAULT_BUTLER_PREFS,
      voiceConfig: DEFAULT_BUTLER_VOICE_CONFIG,
      langTag: 'en-US',
      sourceId: 'q1',
      enqueue: true,
    })
    const second = speakButlerSmart('Second queued line.', {
      prefs: DEFAULT_BUTLER_PREFS,
      voiceConfig: DEFAULT_BUTLER_VOICE_CONFIG,
      langTag: 'en-US',
      sourceId: 'q2',
      enqueue: true,
    })

    await Promise.resolve()
    await Promise.resolve()

    // Second line must wait in queue rather than preempting the first line.
    expect(startedTexts).toEqual(['First queued line.'])
    expect(isButlerSpeechQueueBusy()).toBe(true)

    // Finish first line -> second line starts seamlessly while arbitration stays true.
    const req1 = pendingRequests[0]!
    ttsListener?.({ requestId: req1, type: 'chunk', chunk: streamPayload })
    ttsListener?.({ requestId: req1, type: 'done' })
    await first

    for (let i = 0; i < 6; i += 1) {
      await Promise.resolve()
    }
    expect(startedTexts).toEqual(['First queued line.', 'Second queued line.'])
    expect(arbitrationUpdates).toEqual([{ ttsSpeaking: true }])

    // Finish second line -> queue empties and clears arbitration cleanly.
    const req2 = pendingRequests[1]!
    ttsListener?.({ requestId: req2, type: 'chunk', chunk: streamPayload })
    ttsListener?.({ requestId: req2, type: 'done' })
    await second
    await new Promise((r) => setTimeout(r, 40))

    expect(isButlerSpeechQueueBusy()).toBe(false)
    expect(arbitrationUpdates).toEqual([{ ttsSpeaking: true }, { ttsSpeaking: false }])

    // Enqueue two items and interrupt immediately with stopButlerSpeech().
    const pA = speakButlerSmart('Alpha queued.', {
      prefs: DEFAULT_BUTLER_PREFS,
      voiceConfig: DEFAULT_BUTLER_VOICE_CONFIG,
      langTag: 'en-US',
      enqueue: true,
    })
    const pB = speakButlerSmart('Beta queued.', {
      prefs: DEFAULT_BUTLER_PREFS,
      voiceConfig: DEFAULT_BUTLER_VOICE_CONFIG,
      langTag: 'en-US',
      enqueue: true,
    })
    await Promise.resolve()
    stopButlerSpeech()
    await Promise.all([pA, pB])
    expect(isButlerSpeechQueueBusy()).toBe(false)
  })
})
