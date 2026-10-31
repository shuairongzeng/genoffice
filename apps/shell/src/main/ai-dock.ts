import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'

import { readAppSettings } from './app-settings'
import { normalizeAiDock, type AiDockPrefs } from '../shared/desktop-geometry'

/** app-settings.json key holding the desktop AI dock's `{width, collapsed}` state */
export const AI_DOCK_KEY = 'aiDock'

/** The `aiDock` pref as the main process sees it (defaults on any malformed value). */
export function readAiDock(settingsPath: string): AiDockPrefs {
  return normalizeAiDock(readAppSettings(settingsPath)[AI_DOCK_KEY])
}

const WATCH_DEBOUNCE_MS = 100

/**
 * Re-read the `aiDock` pref whenever app-settings.json changes and call
 * `onChange` with the new value — but only when it actually changed, so a
 * language write or the star prompt's own keys never re-layout anything.
 *
 * The renderer owns the writes, so the file is the whole contract surface: this
 * watches the settings *directory* (the store's atomic writes rename a temp
 * file over the target, which a path-level watch can miss) and filters events
 * touching the settings file or its temp siblings. A watch that cannot be
 * created degrades silently: layout() re-reads the pref on every pass anyway,
 * so a change still lands on the next resize or activation — only the
 * no-other-trigger case (the user dragged the divider) would wait for one.
 *
 * Returns the watcher's disposer.
 */
export function watchAiDock(
  settingsPath: string,
  onChange: (dock: AiDockPrefs) => void,
): () => void {
  let last = readAiDock(settingsPath)
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
      // fire a re-layout, and a watch event racing the read is harmless —
      // the next event re-reads
      const next = readAiDock(settingsPath)
      if (next.width === last.width && next.collapsed === last.collapsed) return
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
