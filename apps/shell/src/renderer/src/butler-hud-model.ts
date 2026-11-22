import type {
  ButlerBriefing,
  ButlerBriefingKind,
  ButlerPartOfDay,
  ButlerStepKind,
  ButlerTaskStatus,
  ButlerTaskUpdate,
} from '../../shared/butler-api'
import type { ButlerPrefs } from '../../shared/butler-prefs'
import type { StringKey, TFunc } from './locale'

const MAX_HUD_TASKS = 6
const MAX_BRIEFING_SPEECH_ITEMS = 3

const STEP_LABEL_KEYS: Record<ButlerStepKind, StringKey> = {
  read: 'butlerStepRead',
  search: 'butlerStepSearch',
  browse: 'butlerStepBrowse',
  edit: 'butlerStepEdit',
  create: 'butlerStepCreate',
  command: 'butlerStepCommand',
  think: 'butlerStepThink',
  other: 'butlerStepOther',
}

const STATUS_LABEL_KEYS: Record<ButlerTaskStatus, StringKey> = {
  running: 'butlerTaskRunning',
  confirm: 'butlerTaskConfirm',
  done: 'butlerTaskDone',
  error: 'butlerTaskError',
}

const BRIEFING_LINE_KEYS: Record<ButlerBriefingKind, StringKey> = {
  'tasks-waiting': 'butlerBriefTasksWaiting',
  'tasks-failed': 'butlerBriefTasksFailed',
  'tasks-done': 'butlerBriefTasksDone',
  'todos-open': 'butlerBriefTodosOpen',
  'recent-docs': 'butlerBriefRecentDocs',
}

const GREETING_KEYS: Record<ButlerPartOfDay, StringKey> = {
  morning: 'butlerGreetMorning',
  afternoon: 'butlerGreetAfternoon',
  evening: 'butlerGreetEvening',
  night: 'butlerGreetNight',
}

const STATUS_TIEBREAK_ORDER: Record<ButlerTaskStatus, number> = {
  confirm: 0,
  running: 1,
  error: 2,
  done: 3,
}

const MAC_KEYCAPS: Record<string, string> = {
  alt: '⌥',
  option: '⌥',
  command: '⌘',
  cmd: '⌘',
  commandorcontrol: '⌘',
  cmdorctrl: '⌘',
  super: '⌘',
  meta: '⌘',
  shift: '⇧',
  control: '⌃',
  ctrl: '⌃',
}

const NON_MAC_KEYCAPS: Record<string, string> = {
  commandorcontrol: 'Ctrl',
  cmdorctrl: 'Ctrl',
  control: 'Ctrl',
  ctrl: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
}

function isActiveStatus(status: ButlerTaskStatus): boolean {
  return status === 'running' || status === 'confirm'
}

/** Map an internal tool-step kind to its localized status label key. */
export function stepLabelKey(kind: ButlerStepKind): StringKey {
  return STEP_LABEL_KEYS[kind] ?? 'butlerStepOther'
}

/** Map a butler task status to its localized pill label key. */
export function statusLabelKey(status: ButlerTaskStatus): StringKey {
  return STATUS_LABEL_KEYS[status] ?? 'butlerTaskError'
}

/** Map a daily briefing category to its localized summary template key. */
export function briefingLineKey(kind: ButlerBriefingKind): StringKey {
  return BRIEFING_LINE_KEYS[kind]
}

/** Map a time-of-day bucket to its localized greeting key. */
export function greetingKey(partOfDay: ButlerPartOfDay): StringKey {
  return GREETING_KEYS[partOfDay]
}

/**
 * Merge a task update by `sessionKey`, prioritize active (`running` / `confirm`)
 * tasks ahead of completed/failed ones sorted by newest `startedAt` first,
 * and cap the resulting list at 6 entries.
 */
export function upsertTask(
  list: readonly ButlerTaskUpdate[],
  update: ButlerTaskUpdate,
): ButlerTaskUpdate[] {
  const next = list.filter((item) => item.sessionKey !== update.sessionKey)
  next.push(update)
  next.sort((a, b) => {
    const activeA = isActiveStatus(a.status) ? 0 : 1
    const activeB = isActiveStatus(b.status) ? 0 : 1
    if (activeA !== activeB) return activeA - activeB
    if (b.startedAt !== a.startedAt) return b.startedAt - a.startedAt
    const rankDiff = STATUS_TIEBREAK_ORDER[a.status] - STATUS_TIEBREAK_ORDER[b.status]
    if (rankDiff !== 0) return rankDiff
    return a.sessionKey.localeCompare(b.sessionKey)
  })
  return next.slice(0, MAX_HUD_TASKS)
}

/** Build the spoken summary text for a daily briefing using the active locale. */
export function composeBriefingSpeech(
  t: TFunc,
  briefing: ButlerBriefing,
  prefs: Pick<ButlerPrefs, 'honorific'>,
): string {
  const greeting = t(greetingKey(briefing.partOfDay))
  const honorific = prefs.honorific.trim()
  const opener = honorific ? `${greeting}, ${honorific}.` : `${greeting}.`

  if (briefing.items.length === 0) {
    return `${opener} ${t('butlerBriefEmpty')}`
  }

  const lines = briefing.items
    .slice(0, MAX_BRIEFING_SPEECH_ITEMS)
    .map((item) => t(briefingLineKey(item.kind), { count: item.count }))
  return [opener, ...lines].join(' ')
}

/** Split an Electron accelerator string into platform-appropriate keycap labels. */
export function formatAcceleratorKeycaps(accelerator: string, isMac: boolean): string[] {
  const trimmed = accelerator.trim()
  if (!trimmed) return []

  const parts = trimmed
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)

  const table = isMac ? MAC_KEYCAPS : NON_MAC_KEYCAPS
  return parts.map((part) => {
    const mapped = table[part.toLowerCase()]
    if (mapped) return mapped
    return part.length === 1 ? part.toUpperCase() : part
  })
}
