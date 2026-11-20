import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'

import { readAppSettings } from '../app-settings'
import {
  normalizePiAgentPrefs,
  samePiAgentPrefs,
  type PiAgentPrefs,
} from '../../shared/pi-agent-prefs'

/** `app-settings.json` key holding embedded Pi Agent and Magic Context preferences. */
export const PI_AGENT_KEY = 'piAgent'

/** Read normalized `piAgent` prefs from `app-settings.json`. */
export function readPiAgentPrefs(settingsPath: string): PiAgentPrefs {
  return normalizePiAgentPrefs(readAppSettings(settingsPath)[PI_AGENT_KEY])
}

/** Resolve active engine with environment variable override (`GENOFFICE_ASK_ENGINE=legacy`). */
export function resolveEffectiveAskEngine(prefs: PiAgentPrefs): 'pi' | 'legacy' {
  if (process.env.GENOFFICE_ASK_ENGINE === 'legacy') return 'legacy'
  if (process.env.GENOFFICE_ASK_ENGINE === 'pi') return 'pi'
  return prefs.engine
}

const WATCH_DEBOUNCE_MS = 100

/**
 * Watch `app-settings.json` for `piAgent` changes and notify listeners only when
 * `PiAgentPrefs` actually changed. Mirrors `watchAiPetPrefs`.
 */
export function watchPiAgentPrefs(
  settingsPath: string,
  onChange: (prefs: PiAgentPrefs) => void,
): () => void {
  let last = readPiAgentPrefs(settingsPath)
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
      const next = readPiAgentPrefs(settingsPath)
      if (samePiAgentPrefs(next, last)) return
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
