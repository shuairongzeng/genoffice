import { describe, expect, it } from 'vitest'

import { pickVoice, type ButlerVoiceCandidate } from '../src/renderer/src/butler-voice'

const SAMPLE_VOICES: ButlerVoiceCandidate[] = [
  { name: 'Google US English', lang: 'en-US', localService: false },
  { name: 'Microsoft David', lang: 'en-US', localService: true },
  { name: 'Google 普通话', lang: 'zh-CN', localService: false },
  { name: 'Microsoft Huihui', lang: 'zh-CN', localService: true },
  { name: 'Kyoko', lang: 'ja-JP', localService: false },
]

describe('pickVoice', () => {
  it('prefers an exact preferredName match over language heuristics', () => {
    const chosen = pickVoice(SAMPLE_VOICES, 'zh-CN', 'Google US English')
    expect(chosen?.name).toBe('Google US English')
  })

  it('matches primary language subtag and prefers localService voices', () => {
    const zh = pickVoice(SAMPLE_VOICES, 'zh-CN', '')
    expect(zh?.name).toBe('Microsoft Huihui')

    const en = pickVoice(SAMPLE_VOICES, 'en-GB', '')
    expect(en?.name).toBe('Microsoft David')
  })

  it('falls back to non-local matching language voice when no localService voice exists', () => {
    const ja = pickVoice(SAMPLE_VOICES, 'ja', 'NonExistentVoice')
    expect(ja?.name).toBe('Kyoko')
  })

  it('returns null when voices list is empty or no language matches', () => {
    expect(pickVoice([], 'zh-CN', '')).toBeNull()
    expect(pickVoice(SAMPLE_VOICES, 'fr-FR', '')).toBeNull()
  })
})
