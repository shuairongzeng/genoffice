import type {
  ButlerBriefing,
  ButlerBriefingItem,
  ButlerBriefingRef,
  ButlerPartOfDay,
} from '../../shared/butler-api'
import type { TodoItem } from '../../shared/home-api'

export type ButlerTaskRecord = {
  readonly sessionKey: string
  readonly title: string
  readonly status: 'done' | 'error'
  readonly finishedAt: number
}

export interface BuildButlerBriefingInput {
  readonly now: number
  readonly todos: readonly TodoItem[]
  readonly recents: readonly {
    readonly path: string
    readonly name: string
    readonly mtimeMs: number
    readonly missing?: boolean
  }[]
  readonly tasks: readonly ButlerTaskRecord[]
  readonly liveConfirms: readonly {
    readonly sessionKey: string
    readonly title: string
  }[]
  readonly since: number | null
}

const DEFAULT_TASK_WINDOW_MS = 24 * 60 * 60 * 1000
const RECENT_DOC_WINDOW_MS = 72 * 60 * 60 * 1000
const MAX_REFS_PER_ITEM = 3
const MAX_REF_LABEL_LEN = 40

/** Format a local calendar day key as `YYYY-MM-DD`. */
export function formatLocalDayKey(now: number): string {
  const d = new Date(now)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Map local wall-clock hour into the butler's greeting time bucket. */
export function partOfDayFor(now: number): ButlerPartOfDay {
  const hour = new Date(now).getHours()
  if (hour < 5) return 'night'
  if (hour < 12) return 'morning'
  if (hour < 18) return 'afternoon'
  return 'evening'
}

function truncateLabel(raw: string): string {
  const normalized = raw.replace(/\s+/g, ' ').trim()
  if (normalized.length <= MAX_REF_LABEL_LEN) return normalized
  return `${normalized.slice(0, MAX_REF_LABEL_LEN - 1)}…`
}

function pushItem(
  items: ButlerBriefingItem[],
  kind: ButlerBriefingItem['kind'],
  refs: readonly ButlerBriefingRef[],
  totalCount: number,
): void {
  if (totalCount <= 0) return
  items.push({
    kind,
    count: totalCount,
    refs: refs.slice(0, MAX_REFS_PER_ITEM),
  })
}

/**
 * Pure builder for the daily Butler briefing card.
 * Filters pending confirms, recent background tasks, open todos, and active
 * recent documents into a fixed-priority, ref-capped summary payload.
 */
export function buildButlerBriefing(input: BuildButlerBriefingInput): ButlerBriefing {
  const { now, todos, recents, tasks, liveConfirms, since } = input
  const taskCutoff = since ?? now - DEFAULT_TASK_WINDOW_MS

  const recentTasks = tasks.filter((t) => t.finishedAt > taskCutoff)
  const failedTasks = recentTasks.filter((t) => t.status === 'error')
  const doneTasks = recentTasks.filter((t) => t.status === 'done')
  const openTodos = todos.filter((todo) => !todo.done)
  const recentDocs = recents.filter(
    (doc) => !doc.missing && doc.mtimeMs > 0 && now - doc.mtimeMs <= RECENT_DOC_WINDOW_MS,
  )

  const items: ButlerBriefingItem[] = []

  pushItem(
    items,
    'tasks-waiting',
    liveConfirms.slice(0, MAX_REFS_PER_ITEM).map((c) => ({
      type: 'session',
      sessionKey: c.sessionKey,
      label: truncateLabel(c.title),
    })),
    liveConfirms.length,
  )

  pushItem(
    items,
    'tasks-failed',
    failedTasks.slice(0, MAX_REFS_PER_ITEM).map((t) => ({
      type: 'session',
      sessionKey: t.sessionKey,
      label: truncateLabel(t.title),
    })),
    failedTasks.length,
  )

  pushItem(
    items,
    'tasks-done',
    doneTasks.slice(0, MAX_REFS_PER_ITEM).map((t) => ({
      type: 'session',
      sessionKey: t.sessionKey,
      label: truncateLabel(t.title),
    })),
    doneTasks.length,
  )

  pushItem(
    items,
    'todos-open',
    openTodos.slice(0, MAX_REFS_PER_ITEM).map((todo) => ({
      type: 'todo',
      id: todo.id,
      label: truncateLabel(todo.text),
    })),
    openTodos.length,
  )

  pushItem(
    items,
    'recent-docs',
    recentDocs.slice(0, MAX_REFS_PER_ITEM).map((doc) => ({
      type: 'file',
      path: doc.path,
      label: truncateLabel(doc.name),
    })),
    recentDocs.length,
  )

  return {
    dayKey: formatLocalDayKey(now),
    partOfDay: partOfDayFor(now),
    items,
  }
}
