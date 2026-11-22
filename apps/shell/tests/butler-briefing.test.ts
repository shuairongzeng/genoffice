import { describe, expect, it } from 'vitest'

import { buildButlerBriefing, type ButlerTaskRecord } from '../src/main/butler/butler-briefing'
import type { TodoItem } from '../src/shared/home-api'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function localTs(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

describe('buildButlerBriefing', () => {
  it('orders categories, applies window filters, caps refs at 3, and truncates labels to <= 40 chars', () => {
    const now = localTs(2026, 11, 22, 9, 30)
    const since = now - 12 * HOUR

    const longTitle = 'A'.repeat(55)
    const longTodo = 'B'.repeat(45)
    const longFile = 'Very-long-quarterly-financial-report-final-v3.docx'

    const liveConfirms = [
      { sessionKey: 'default:c1', title: longTitle },
      { sessionKey: 'default:c2', title: 'Confirm 2' },
      { sessionKey: 'default:c3', title: 'Confirm 3' },
      { sessionKey: 'default:c4', title: 'Confirm 4' },
    ]

    const tasks: ButlerTaskRecord[] = [
      { sessionKey: 'default:e1', title: 'Error 1', status: 'error', finishedAt: now - HOUR },
      { sessionKey: 'default:e2', title: 'Error boundary', status: 'error', finishedAt: since },
      { sessionKey: 'default:d1', title: 'Done 1', status: 'done', finishedAt: now - 2 * HOUR },
      { sessionKey: 'default:d2', title: 'Done 2', status: 'done', finishedAt: now - 3 * HOUR },
      { sessionKey: 'default:d3', title: 'Done 3', status: 'done', finishedAt: now - 4 * HOUR },
      { sessionKey: 'default:d4', title: 'Done 4', status: 'done', finishedAt: now - 5 * HOUR },
      { sessionKey: 'default:old', title: 'Old Done', status: 'done', finishedAt: since - 1000 },
    ]

    const todos: TodoItem[] = [
      { id: 't-done', text: 'Already finished', done: true },
      { id: 't1', text: longTodo, done: false },
      { id: 't2', text: 'Todo 2', done: false },
      { id: 't3', text: 'Todo 3', done: false },
      { id: 't4', text: 'Todo 4', done: false },
    ]

    const recents = [
      { path: '/docs/a.docx', name: longFile, mtimeMs: now - HOUR },
      { path: '/docs/b.xlsx', name: 'b.xlsx', mtimeMs: now - 72 * HOUR },
      { path: '/docs/c.pptx', name: 'c.pptx', mtimeMs: now - 10 * HOUR },
      { path: '/docs/d.md', name: 'd.md', mtimeMs: now - 20 * HOUR },
      { path: '/docs/missing.docx', name: 'missing.docx', mtimeMs: now - HOUR, missing: true },
      { path: '/docs/zero.docx', name: 'zero.docx', mtimeMs: 0 },
      { path: '/docs/stale.docx', name: 'stale.docx', mtimeMs: now - (72 * HOUR + 1) },
    ]

    const briefing = buildButlerBriefing({
      now,
      todos,
      recents,
      tasks,
      liveConfirms,
      since,
    })

    expect(briefing.dayKey).toBe('2026-11-22')
    expect(briefing.partOfDay).toBe('morning')
    expect(briefing.items.map((item) => item.kind)).toEqual([
      'tasks-waiting',
      'tasks-failed',
      'tasks-done',
      'todos-open',
      'recent-docs',
    ])

    const [waiting, failed, done, openTodos, recentDocs] = briefing.items
    expect(waiting!.count).toBe(4)
    expect(waiting!.refs).toHaveLength(3)
    expect(failed!.count).toBe(1)
    expect(failed!.refs).toHaveLength(1)
    expect(done!.count).toBe(4)
    expect(done!.refs).toHaveLength(3)
    expect(openTodos!.count).toBe(4)
    expect(openTodos!.refs).toHaveLength(3)
    expect(recentDocs!.count).toBe(4)
    expect(recentDocs!.refs).toHaveLength(3)

    const confirmKeys = new Set(liveConfirms.map((c) => c.sessionKey))
    const taskKeys = new Set(tasks.filter((t) => t.finishedAt > since).map((t) => t.sessionKey))
    const todoIds = new Set(todos.filter((t) => !t.done).map((t) => t.id))
    const docPaths = new Set(
      recents
        .filter((d) => !d.missing && d.mtimeMs > 0 && now - d.mtimeMs <= 72 * HOUR)
        .map((d) => d.path),
    )

    for (const item of briefing.items) {
      expect(item.refs.length).toBeLessThanOrEqual(3)
      for (const ref of item.refs) {
        expect(ref.label.length).toBeLessThanOrEqual(40)
        if (ref.type === 'session') {
          if (item.kind === 'tasks-waiting') {
            expect(confirmKeys.has(ref.sessionKey)).toBe(true)
          } else {
            expect(taskKeys.has(ref.sessionKey)).toBe(true)
          }
        } else if (ref.type === 'todo') {
          expect(todoIds.has(ref.id)).toBe(true)
        } else {
          expect(docPaths.has(ref.path)).toBe(true)
        }
      }
    }
  })

  it('defaults task window to 24 hours when since is null', () => {
    const now = localTs(2026, 11, 22, 14, 0)
    const briefing = buildButlerBriefing({
      now,
      todos: [],
      recents: [],
      liveConfirms: [],
      since: null,
      tasks: [
        { sessionKey: 's:recent', title: 'Recent', status: 'done', finishedAt: now - 23 * HOUR },
        { sessionKey: 's:exact', title: 'Exact 24h', status: 'done', finishedAt: now - DAY },
        { sessionKey: 's:old', title: 'Older', status: 'error', finishedAt: now - 25 * HOUR },
      ],
    })

    expect(briefing.items).toEqual([
      {
        kind: 'tasks-done',
        count: 1,
        refs: [{ type: 'session', sessionKey: 's:recent', label: 'Recent' }],
      },
    ])
  })

  it('computes local dayKey and partOfDay buckets accurately', () => {
    expect(
      buildButlerBriefing({
        now: localTs(2026, 1, 5, 4, 59),
        todos: [],
        recents: [],
        tasks: [],
        liveConfirms: [],
        since: null,
      }),
    ).toEqual({ dayKey: '2026-01-05', partOfDay: 'night', items: [] })

    expect(
      buildButlerBriefing({
        now: localTs(2026, 1, 5, 5, 0),
        todos: [],
        recents: [],
        tasks: [],
        liveConfirms: [],
        since: null,
      }).partOfDay,
    ).toBe('morning')

    expect(
      buildButlerBriefing({
        now: localTs(2026, 1, 5, 12, 0),
        todos: [],
        recents: [],
        tasks: [],
        liveConfirms: [],
        since: null,
      }).partOfDay,
    ).toBe('afternoon')

    expect(
      buildButlerBriefing({
        now: localTs(2026, 1, 5, 18, 0),
        todos: [],
        recents: [],
        tasks: [],
        liveConfirms: [],
        since: null,
      }).partOfDay,
    ).toBe('evening')
  })

  it('returns items: [] when there are no matching items', () => {
    const now = localTs(2026, 11, 22, 20, 0)
    const briefing = buildButlerBriefing({
      now,
      todos: [{ id: '1', text: 'Finished', done: true }],
      recents: [{ path: '/a.docx', name: 'a.docx', mtimeMs: now - 100 * HOUR }],
      tasks: [],
      liveConfirms: [],
      since: null,
    })

    expect(briefing).toEqual({
      dayKey: '2026-11-22',
      partOfDay: 'evening',
      items: [],
    })
  })
})
