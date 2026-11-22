import { existsSync, mkdirSync, readFileSync, watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { readAppSettings, writeAppSetting } from '../app-settings'
import { atomicWriteFile } from '../atomic-write'
import type { ButlerTaskRecord } from './butler-briefing'
import {
  mergeButlerPrefs,
  normalizeButlerPrefs,
  sameButlerPrefs,
  type ButlerPrefs,
} from '../../shared/butler-prefs'

/** `app-settings.json` key holding the AI butler prefs (Settings > AI Butler). */
export const BUTLER_KEY = 'butler'

const WATCH_DEBOUNCE_MS = 100
const MAX_PERSISTED_TASKS = 30
const BUTLER_STATE_FILENAME = 'butler-state.json'

export type ButlerPersistedState = {
  readonly lastBriefingDay: string | null
  readonly lastBriefingAt: number | null
  readonly tasks: readonly ButlerTaskRecord[]
}

const EMPTY_BUTLER_STATE: ButlerPersistedState = {
  lastBriefingDay: null,
  lastBriefingAt: null,
  tasks: [],
}

/** Read normalized `butler` prefs from `app-settings.json`. */
export function readButlerPrefs(settingsPath: string): ButlerPrefs {
  return normalizeButlerPrefs(readAppSettings(settingsPath)[BUTLER_KEY])
}

/** Merge a partial patch into stored `butler` prefs, persist, and return the normalized snapshot. */
export function writeButlerPrefs(settingsPath: string, patch: unknown): ButlerPrefs {
  mkdirSync(dirname(settingsPath), { recursive: true })
  const current = readButlerPrefs(settingsPath)
  const next = mergeButlerPrefs(current, patch)
  writeAppSetting(settingsPath, BUTLER_KEY, next)
  return next
}

/**
 * Watch `app-settings.json` for `butler` changes and notify listeners only when
 * `ButlerPrefs` actually changed. Mirrors `watchAiPetPrefs`.
 */
export function watchButlerPrefs(
  settingsPath: string,
  onChange: (prefs: ButlerPrefs) => void,
): () => void {
  let last = readButlerPrefs(settingsPath)
  let timer: ReturnType<typeof setTimeout> | null = null
  let watcher: FSWatcher | null = null

  const close = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    watcher?.close()
    watcher = null
  }

  const changed = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      const next = readButlerPrefs(settingsPath)
      if (sameButlerPrefs(next, last)) return
      last = next
      onChange(next)
    }, WATCH_DEBOUNCE_MS)
  }

  try {
    watcher = watch(dirname(settingsPath), { persistent: false }, (_event, filename) => {
      const name = filename?.toString() ?? ''
      if (name === '' || name.startsWith(basename(settingsPath))) changed()
    })
    watcher.on('error', () => close())
  } catch {
    watcher = null
  }

  return close
}

/** Resolve the persisted Butler runtime state path inside `userDataDir`. */
export function butlerStatePath(userDataDir: string): string {
  return join(userDataDir, BUTLER_STATE_FILENAME)
}

function normalizeTaskRecord(raw: unknown): ButlerTaskRecord | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.sessionKey !== 'string' || r.sessionKey.trim().length === 0) return null
  if (typeof r.title !== 'string') return null
  if (r.status !== 'done' && r.status !== 'error') return null
  if (typeof r.finishedAt !== 'number' || !Number.isFinite(r.finishedAt)) return null
  return {
    sessionKey: r.sessionKey,
    title: r.title,
    status: r.status,
    finishedAt: r.finishedAt,
  }
}

function normalizeButlerState(raw: unknown): ButlerPersistedState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return EMPTY_BUTLER_STATE
  }
  const obj = raw as Record<string, unknown>

  const lastBriefingDay =
    typeof obj.lastBriefingDay === 'string' && obj.lastBriefingDay.trim().length > 0
      ? obj.lastBriefingDay.trim()
      : null

  const lastBriefingAt =
    typeof obj.lastBriefingAt === 'number' && Number.isFinite(obj.lastBriefingAt)
      ? obj.lastBriefingAt
      : null

  const parsedTasks: ButlerTaskRecord[] = []
  if (Array.isArray(obj.tasks)) {
    for (const entry of obj.tasks) {
      const normalized = normalizeTaskRecord(entry)
      if (normalized) parsedTasks.push(normalized)
    }
  }

  const boundedTasks =
    parsedTasks.length <= MAX_PERSISTED_TASKS
      ? parsedTasks
      : [...parsedTasks].sort((a, b) => b.finishedAt - a.finishedAt).slice(0, MAX_PERSISTED_TASKS)

  return {
    lastBriefingDay,
    lastBriefingAt,
    tasks: boundedTasks,
  }
}

/** Read and normalize `<userDataDir>/butler-state.json`, tolerating missing or corrupt JSON. */
export function readButlerState(userDataDir: string): ButlerPersistedState {
  const filePath = butlerStatePath(userDataDir)
  if (!existsSync(filePath)) return EMPTY_BUTLER_STATE
  try {
    const raw = readFileSync(filePath, 'utf8')
    return normalizeButlerState(JSON.parse(raw))
  } catch {
    return EMPTY_BUTLER_STATE
  }
}

/** Atomically persist `<userDataDir>/butler-state.json`, capped at 30 task records. */
export async function writeButlerState(
  userDataDir: string,
  state: ButlerPersistedState,
): Promise<void> {
  const filePath = butlerStatePath(userDataDir)
  mkdirSync(dirname(filePath), { recursive: true })
  const normalized = normalizeButlerState(state)
  await atomicWriteFile(filePath, Buffer.from(JSON.stringify(normalized, null, 2), 'utf8'))
}
