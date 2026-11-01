import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'

import { readAppSettings } from './app-settings'
import { normalizeDockPrefs, sameDockPrefs, type DockPrefs } from '../shared/dock-prefs'

/** app-settings.json key holding the dock's own prefs (设置 ▸ 程序坞) */
export const DOCK_PREFS_KEY = 'dockPrefs'

/** The `dockPrefs` value as the main process sees it (defaults on any malformed value). */
export function readDockPrefs(settingsPath: string): DockPrefs {
  return normalizeDockPrefs(readAppSettings(settingsPath)[DOCK_PREFS_KEY])
}

const WATCH_DEBOUNCE_MS = 100

/**
 * Re-read the `dockPrefs` value whenever app-settings.json changes and call
 * `onChange` with the new value — but only when it actually changed (every
 * field counts, the order by exact sequence), so an unrelated write (the
 * language, the star prompt, the AI drawer) never re-fits the dock.
 *
 * Same shape as watchAiDock: the renderer owns the writes, so the file is
 * the whole contract surface; this watches the settings *directory* (the
 * store's atomic writes rename a temp file over the target) and filters
 * events touching the settings file or its temp siblings. A watch that
 * cannot be created degrades silently — layout() re-reads the pref on every
 * pass anyway, so a change still lands on the next resize or activation.
 *
 * Returns the watcher's disposer.
 */
export function watchDockPrefs(
  settingsPath: string,
  onChange: (prefs: DockPrefs) => void,
): () => void {
  let last = readDockPrefs(settingsPath)
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
      // the value comparison is the gate: unrelated settings writes must not
      // re-fit the dock, and a watch event racing the read is harmless — the
      // next event re-reads
      const next = readDockPrefs(settingsPath)
      if (sameDockPrefs(next, last)) return
      last = next
      onChange(next)
    }, WATCH_DEBOUNCE_MS)
  }
  try {
    watcher = watch(dirname(settingsPath), { persistent: false }, (_event, filename) => {
      const name = filename?.toString() ?? ''
      // some platforms deliver bare events; a re-read is one stat, and the
      // value comparison keeps those from ever reaching onChange
      if (name === '' || name.startsWith(basename(settingsPath))) changed()
    })
    watcher.on('error', () => close())
  } catch {
    watcher = null
  }
  return close
}
