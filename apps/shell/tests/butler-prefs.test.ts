import { describe, expect, it } from 'vitest'

import { isButlerOpenTarget } from '../src/shared/butler-api'
import {
  DEFAULT_BUTLER_PREFS,
  mergeButlerPrefs,
  normalizeButlerPrefs,
  sameButlerPrefs,
  sanitizeButlerLine,
} from '../src/shared/butler-prefs'

describe('sanitizeButlerLine', () => {
  it('replaces newlines/tabs with spaces, strips prompt delimiters, trims and truncates', () => {
    expect(sanitizeButlerLine('  Jar\nvis\r\n\t"Mr."  <>{}`\'  ', 30)).toBe('Jar vis Mr.')
    expect(sanitizeButlerLine('a'.repeat(40), 24)).toHaveLength(24)
    expect(sanitizeButlerLine(123, 24)).toBe('')
    expect(sanitizeButlerLine('hello', 0)).toBe('')
  })
})

describe('normalizeButlerPrefs', () => {
  it('returns defaults on missing or malformed values', () => {
    for (const bad of [undefined, null, 'bad', 123, []]) {
      expect(normalizeButlerPrefs(bad)).toEqual(DEFAULT_BUTLER_PREFS)
    }
  })

  it('falls back name to default when sanitized empty, and keeps explicit empty honorific', () => {
    const emptyName = normalizeButlerPrefs({ name: '  "\n<>{}  ', honorific: '' })
    expect(emptyName.name).toBe(DEFAULT_BUTLER_PREFS.name)
    expect(emptyName.honorific).toBe('')
  })

  it('truncates name, honorific, userName, and voiceName to their bounds', () => {
    const prefs = normalizeButlerPrefs({
      name: 'N'.repeat(40),
      honorific: 'H'.repeat(40),
      userName: 'U'.repeat(50),
      voiceName: 'V'.repeat(160),
    })
    expect(prefs.name).toHaveLength(24)
    expect(prefs.honorific).toHaveLength(24)
    expect(prefs.userName).toHaveLength(32)
    expect(prefs.voiceName).toHaveLength(120)
  })

  it('clamps maxPerHour (1..30) and voiceRate (0.7..1.6 rounded to 0.1)', () => {
    expect(normalizeButlerPrefs({ maxPerHour: 0 }).maxPerHour).toBe(1)
    expect(normalizeButlerPrefs({ maxPerHour: 99 }).maxPerHour).toBe(30)
    expect(normalizeButlerPrefs({ maxPerHour: 12.6 }).maxPerHour).toBe(13)
    expect(normalizeButlerPrefs({ maxPerHour: Number.NaN }).maxPerHour).toBe(
      DEFAULT_BUTLER_PREFS.maxPerHour,
    )

    expect(normalizeButlerPrefs({ voiceRate: 0.2 }).voiceRate).toBe(0.7)
    expect(normalizeButlerPrefs({ voiceRate: 3.5 }).voiceRate).toBe(1.6)
    expect(normalizeButlerPrefs({ voiceRate: 1.14 }).voiceRate).toBe(1.1)
    expect(normalizeButlerPrefs({ voiceRate: 1.16 }).voiceRate).toBe(1.2)
    expect(normalizeButlerPrefs({ voiceRate: Number.POSITIVE_INFINITY }).voiceRate).toBe(
      DEFAULT_BUTLER_PREFS.voiceRate,
    )
  })

  it('treats boolean fields strictly (only literal true/false override defaults)', () => {
    const weird = normalizeButlerPrefs({
      enabled: 'false',
      persona: 0,
      briefing: 'no',
      notifyDone: null,
      notifyConfirm: 1,
      dnd: 'true',
      voice: 0,
    })
    expect(weird).toEqual(DEFAULT_BUTLER_PREFS)

    const toggled = normalizeButlerPrefs({
      enabled: false,
      persona: false,
      briefing: false,
      notifyDone: false,
      notifyConfirm: false,
      dnd: true,
      voice: false,
    })
    expect(toggled.enabled).toBe(false)
    expect(toggled.dnd).toBe(true)
    expect(toggled.voice).toBe(false)
  })
})

describe('mergeButlerPrefs & sameButlerPrefs', () => {
  it('merges valid patch fields and detects value differences', () => {
    const next = mergeButlerPrefs(DEFAULT_BUTLER_PREFS, {
      name: 'Alfred',
      dnd: true,
      maxPerHour: 10,
      voiceRate: 1.3,
    })
    expect(next.name).toBe('Alfred')
    expect(next.dnd).toBe(true)
    expect(next.maxPerHour).toBe(10)
    expect(next.voiceRate).toBe(1.3)
    expect(next.honorific).toBe(DEFAULT_BUTLER_PREFS.honorific)

    expect(sameButlerPrefs(DEFAULT_BUTLER_PREFS, { ...DEFAULT_BUTLER_PREFS })).toBe(true)
    expect(sameButlerPrefs(DEFAULT_BUTLER_PREFS, next)).toBe(false)
  })

  it('ignores non-object patches', () => {
    expect(mergeButlerPrefs(DEFAULT_BUTLER_PREFS, null)).toEqual(DEFAULT_BUTLER_PREFS)
    expect(mergeButlerPrefs(DEFAULT_BUTLER_PREFS, ['bad'])).toEqual(DEFAULT_BUTLER_PREFS)
  })
})

describe('isButlerOpenTarget', () => {
  it('accepts valid target payloads and rejects malformed shapes', () => {
    expect(isButlerOpenTarget({ type: 'settings' })).toBe(true)
    expect(isButlerOpenTarget({ type: 'file', path: 'C:/a.docx', label: 'a.docx' })).toBe(true)
    expect(isButlerOpenTarget({ type: 'todo', id: 't1', label: 'Review' })).toBe(true)
    expect(
      isButlerOpenTarget({ type: 'session', sessionKey: 'default:butler-1', label: 'Task' }),
    ).toBe(true)

    expect(isButlerOpenTarget(null)).toBe(false)
    expect(isButlerOpenTarget({ type: 'file', path: '   ', label: 'x' })).toBe(false)
    expect(isButlerOpenTarget({ type: 'todo', id: 't1' })).toBe(false)
    expect(isButlerOpenTarget({ type: 'session', sessionKey: '', label: 'x' })).toBe(false)
    expect(isButlerOpenTarget({ type: 'unknown' })).toBe(false)
  })
})
