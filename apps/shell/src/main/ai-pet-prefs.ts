import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'

import { readAppSettings } from './app-settings'
import {
  normalizeAiPetPrefs,
  sameAiPetPrefs,
  type AiPetPrefs,
} from '../shared/ai-pet-prefs'

/** `app-settings.json` key holding the AI pet prefs (Settings > AI Pets). */
export const AI_PET_KEY = 'aiPet'

/** Read normalized `aiPet` prefs from `app-settings.json`. */
export function readAiPetPrefs(settingsPath: string): AiPetPrefs {
  return normalizeAiPetPrefs(readAppSettings(settingsPath)[AI_PET_KEY])
}

const WATCH_DEBOUNCE_MS = 100

/**
 * Watch `app-settings.json` for `aiPet` changes and notify listeners only when
 * `AiPetPrefs` actually changed. Mirrors `watchAiDock` and `watchDockPrefs`.
 */
export function watchAiPetPrefs(
  settingsPath: string,
  onChange: (prefs: AiPetPrefs) => void,
): () => void {
  let last = readAiPetPrefs(settingsPath)
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
      const next = readAiPetPrefs(settingsPath)
      if (sameAiPetPrefs(next, last)) return
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
