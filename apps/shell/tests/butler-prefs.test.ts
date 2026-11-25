import { describe, expect, it } from 'vitest'

import {
  classifyButlerPlanReplyIntent,
  isButlerApproveMissionPlanRequest,
  isButlerOpenTarget,
} from '../src/shared/butler-api'
import {
  BUTLER_WORKER_THINKING_EFFORTS,
  DEFAULT_BUTLER_PREFS,
  isButlerWorkerThinkingEffort,
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

describe('ButlerPrefs Wave 1 thinking & plan alignment fields', () => {
  it('exposes defaults and strict validation for chiefFastMode, workerThinkingEffort, and planConfirmBeforeDispatch', () => {
    expect(BUTLER_WORKER_THINKING_EFFORTS).toEqual(['follow', 'low', 'medium', 'high'])
    expect(DEFAULT_BUTLER_PREFS.chiefFastMode).toBe(true)
    expect(DEFAULT_BUTLER_PREFS.workerThinkingEffort).toBe('high')
    expect(DEFAULT_BUTLER_PREFS.planConfirmBeforeDispatch).toBe(true)

    expect(isButlerWorkerThinkingEffort('follow')).toBe(true)
    expect(isButlerWorkerThinkingEffort('low')).toBe(true)
    expect(isButlerWorkerThinkingEffort('medium')).toBe(true)
    expect(isButlerWorkerThinkingEffort('high')).toBe(true)
    expect(isButlerWorkerThinkingEffort('max')).toBe(false)
    expect(isButlerWorkerThinkingEffort(123)).toBe(false)

    const malformed = normalizeButlerPrefs({
      chiefFastMode: 'false',
      workerThinkingEffort: 'xhigh',
      planConfirmBeforeDispatch: 0,
    })
    expect(malformed.chiefFastMode).toBe(true)
    expect(malformed.workerThinkingEffort).toBe('high')
    expect(malformed.planConfirmBeforeDispatch).toBe(true)

    const updated = normalizeButlerPrefs({
      chiefFastMode: false,
      workerThinkingEffort: 'medium',
      planConfirmBeforeDispatch: false,
    })
    expect(updated.chiefFastMode).toBe(false)
    expect(updated.workerThinkingEffort).toBe('medium')
    expect(updated.planConfirmBeforeDispatch).toBe(false)
  })

  it('merges and compares the 3 new fields accurately', () => {
    const patched = mergeButlerPrefs(DEFAULT_BUTLER_PREFS, {
      chiefFastMode: false,
      workerThinkingEffort: 'follow',
      planConfirmBeforeDispatch: false,
    })
    expect(patched.chiefFastMode).toBe(false)
    expect(patched.workerThinkingEffort).toBe('follow')
    expect(patched.planConfirmBeforeDispatch).toBe(false)
    expect(sameButlerPrefs(DEFAULT_BUTLER_PREFS, patched)).toBe(false)
    expect(sameButlerPrefs(patched, { ...patched })).toBe(true)
  })
})

describe('isButlerApproveMissionPlanRequest & classifyButlerPlanReplyIntent', () => {
  it('validates plan approval requests', () => {
    expect(isButlerApproveMissionPlanRequest({ missionId: 'm1' })).toBe(true)
    expect(isButlerApproveMissionPlanRequest({ missionId: 'm1', comment: 'Go ahead' })).toBe(true)
    expect(isButlerApproveMissionPlanRequest({ missionId: '   ' })).toBe(false)
    expect(isButlerApproveMissionPlanRequest({ missionId: 'm1', comment: 123 })).toBe(false)
    expect(isButlerApproveMissionPlanRequest(null)).toBe(false)
  })

  it('classifies short unambiguous confirmations as approve (including multi-clause)', () => {
    for (const reply of [
      '好的',
      '好，开始吧！',
      '好，没问题，按这个办',
      '好的，可以，开始吧',
      '没问题，贾维斯',
      '就按这个办吧',
      '确认派发',
      '安排下去吧，先生',
      'ok',
      'Okay, go ahead!',
      'OK, looks good, go ahead!',
      'Yes, start please',
      'Looks good!',
      'ship it',
    ]) {
      expect(classifyButlerPlanReplyIntent(reply), reply).toBe('approve')
    }
  })

  it('classifies explicit cancellations as cancel (including multi-clause)', () => {
    for (const reply of [
      '取消',
      '取消任务吧',
      '算了',
      '算了，取消任务',
      '算了，不用做了，谢谢',
      '不用做了',
      'Cancel mission',
      'Never mind, cancel mission',
      'abort mission!',
      'Never mind',
    ]) {
      expect(classifyButlerPlanReplyIntent(reply), reply).toBe('cancel')
    }
  })

  it('classifies adversative qualifiers, mixed signals, honorific-only, and long replies as revise', () => {
    for (const reply of [
      '',
      '   ',
      '贾维斯',
      '好，算了',
      '好的，但是把第二步改成生成 PPT',
      '没问题，不过先别改这个文件',
      'Yes, but change step 2 instead',
      'Wait, add a summary table at the end',
      '把第二阶段拆分一下，加上对比分析',
      '请问第二步的数据来源是从哪里获取的？',
      '好的，没问题，好的，没问题，好的，没问题，好的，没问题，好的，没问题，好的，没问题',
    ]) {
      expect(classifyButlerPlanReplyIntent(reply), reply).toBe('revise')
    }
  })

  it('does not confuse English words containing substring "but" or "add" with revise', () => {
    expect(classifyButlerPlanReplyIntent('approve')).toBe('approve')
    expect(classifyButlerPlanReplyIntent('ok, proceed')).toBe('approve')
    expect(classifyButlerPlanReplyIntent('yes, butler')).toBe('approve')
    expect(classifyButlerPlanReplyIntent('cancel address')).toBe('revise')
  })
})
