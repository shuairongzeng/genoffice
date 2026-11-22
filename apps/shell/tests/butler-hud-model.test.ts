import { describe, expect, it } from 'vitest'
import type {
  ButlerBriefing,
  ButlerBriefingKind,
  ButlerPartOfDay,
  ButlerStepKind,
  ButlerTaskStatus,
  ButlerTaskUpdate,
} from '../src/shared/butler-api'
import {
  briefingLineKey,
  composeBriefingSpeech,
  formatAcceleratorKeycaps,
  greetingKey,
  statusLabelKey,
  stepLabelKey,
  upsertTask,
} from '../src/renderer/src/butler-hud-model'
import type { TFunc } from '../src/renderer/src/locale'
import { translate } from '../src/renderer/src/strings'

const zhT: TFunc = (key, params) => translate('zh', key, params)
const enT: TFunc = (key, params) => translate('en', key, params)

function makeTask(
  sessionKey: string,
  status: ButlerTaskStatus,
  startedAt: number,
  extra?: Partial<ButlerTaskUpdate>,
): ButlerTaskUpdate {
  return {
    sessionKey,
    title: `Task ${sessionKey}`,
    status,
    step: null,
    startedAt,
    fromButler: true,
    ...extra,
  }
}

describe('label key mappers', () => {
  it('maps every ButlerStepKind to its string key', () => {
    const cases: Array<[ButlerStepKind, string]> = [
      ['read', 'butlerStepRead'],
      ['search', 'butlerStepSearch'],
      ['browse', 'butlerStepBrowse'],
      ['edit', 'butlerStepEdit'],
      ['create', 'butlerStepCreate'],
      ['command', 'butlerStepCommand'],
      ['think', 'butlerStepThink'],
      ['other', 'butlerStepOther'],
    ]
    for (const [kind, expected] of cases) {
      expect(stepLabelKey(kind)).toBe(expected)
    }
  })

  it('maps every ButlerTaskStatus to its string key', () => {
    const cases: Array<[ButlerTaskStatus, string]> = [
      ['running', 'butlerTaskRunning'],
      ['confirm', 'butlerTaskConfirm'],
      ['done', 'butlerTaskDone'],
      ['error', 'butlerTaskError'],
    ]
    for (const [status, expected] of cases) {
      expect(statusLabelKey(status)).toBe(expected)
    }
  })

  it('maps every ButlerBriefingKind to its string key', () => {
    const cases: Array<[ButlerBriefingKind, string]> = [
      ['tasks-waiting', 'butlerBriefTasksWaiting'],
      ['tasks-failed', 'butlerBriefTasksFailed'],
      ['tasks-done', 'butlerBriefTasksDone'],
      ['todos-open', 'butlerBriefTodosOpen'],
      ['recent-docs', 'butlerBriefRecentDocs'],
    ]
    for (const [kind, expected] of cases) {
      expect(briefingLineKey(kind)).toBe(expected)
    }
  })

  it('maps every ButlerPartOfDay to its greeting key', () => {
    const cases: Array<[ButlerPartOfDay, string]> = [
      ['morning', 'butlerGreetMorning'],
      ['afternoon', 'butlerGreetAfternoon'],
      ['evening', 'butlerGreetEvening'],
      ['night', 'butlerGreetNight'],
    ]
    for (const [part, expected] of cases) {
      expect(greetingKey(part)).toBe(expected)
    }
  })
})

describe('upsertTask', () => {
  it('replaces existing tasks by sessionKey without mutating the input array', () => {
    const initial = [makeTask('s1', 'running', 100), makeTask('s2', 'done', 200)]
    const updated = upsertTask(initial, makeTask('s1', 'done', 100, { summary: 'Finished' }))

    expect(initial[0]!.status).toBe('running')
    expect(updated).toHaveLength(2)
    expect(updated.map((t) => t.sessionKey)).toEqual(['s2', 's1'])
    expect(updated[1]!.summary).toBe('Finished')
  })

  it('prioritizes running/confirm ahead of done/error, sorted by startedAt descending, capped at 6', () => {
    let list: ButlerTaskUpdate[] = []
    const inputs: ButlerTaskUpdate[] = [
      makeTask('done-old', 'done', 100),
      makeTask('done-new', 'done', 500),
      makeTask('err-mid', 'error', 350),
      makeTask('run-old', 'running', 150),
      makeTask('confirm-new', 'confirm', 450),
      makeTask('run-mid', 'running', 300),
      makeTask('done-mid', 'done', 250),
      makeTask('done-oldest', 'done', 50),
    ]
    for (const item of inputs) {
      list = upsertTask(list, item)
    }

    expect(list).toHaveLength(6)
    expect(list.map((t) => t.sessionKey)).toEqual([
      'confirm-new',
      'run-mid',
      'run-old',
      'done-new',
      'err-mid',
      'done-mid',
    ])
  })
})

describe('composeBriefingSpeech', () => {
  it('includes greeting, honorific, and at most 3 briefing items', () => {
    const briefing: ButlerBriefing = {
      dayKey: '2026-11-22',
      partOfDay: 'morning',
      items: [
        { kind: 'tasks-waiting', count: 2, refs: [] },
        { kind: 'tasks-failed', count: 1, refs: [] },
        { kind: 'todos-open', count: 4, refs: [] },
        { kind: 'recent-docs', count: 5, refs: [] },
      ],
    }

    const speechZh = composeBriefingSpeech(zhT, briefing, { honorific: '先生' })
    expect(speechZh).toContain('早上好')
    expect(speechZh).toContain('先生')
    expect(speechZh).toContain(zhT('butlerBriefTasksWaiting', { count: 2 }))
    expect(speechZh).toContain(zhT('butlerBriefTasksFailed', { count: 1 }))
    expect(speechZh).toContain(zhT('butlerBriefTodosOpen', { count: 4 }))
    expect(speechZh).not.toContain(zhT('butlerBriefRecentDocs', { count: 5 }))

    const speechEn = composeBriefingSpeech(enT, briefing, { honorific: '' })
    expect(speechEn.startsWith('Good morning.')).toBe(true)
    expect(speechEn).toContain('2 tasks awaiting your confirmation')
  })

  it('uses empty briefing message when items array is empty', () => {
    const briefing: ButlerBriefing = {
      dayKey: '2026-11-22',
      partOfDay: 'evening',
      items: [],
    }
    const speech = composeBriefingSpeech(zhT, briefing, { honorific: '老板' })
    expect(speech).toContain('晚上好')
    expect(speech).toContain('老板')
    expect(speech).toContain(zhT('butlerBriefEmpty'))
  })
})

describe('formatAcceleratorKeycaps', () => {
  it('returns empty array for empty or whitespace strings', () => {
    expect(formatAcceleratorKeycaps('', false)).toEqual([])
    expect(formatAcceleratorKeycaps('   ', true)).toEqual([])
  })

  it('formats Mac modifier symbols and non-Mac labels', () => {
    expect(formatAcceleratorKeycaps('Alt+Space', false)).toEqual(['Alt', 'Space'])
    expect(formatAcceleratorKeycaps('Alt+Space', true)).toEqual(['⌥', 'Space'])

    expect(formatAcceleratorKeycaps('CommandOrControl+Shift+k', true)).toEqual(['⌘', '⇧', 'K'])
    expect(formatAcceleratorKeycaps('CommandOrControl+Shift+k', false)).toEqual([
      'Ctrl',
      'Shift',
      'K',
    ])

    expect(formatAcceleratorKeycaps('Option+Control+Cmd+Space', true)).toEqual([
      '⌥',
      '⌃',
      '⌘',
      'Space',
    ])
    expect(formatAcceleratorKeycaps('Control+CmdOrCtrl+j', false)).toEqual(['Ctrl', 'Ctrl', 'J'])
  })
})
