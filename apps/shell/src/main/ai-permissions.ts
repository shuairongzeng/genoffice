import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'

import { readAppSettings } from './app-settings'
import {
  DEFAULT_AI_PERMISSION_MODE,
  normalizeAiPermissionMode,
  sameAiPermissionMode,
  type AiPermissionMode,
} from '@genoffice/ui/ai-permission-mode'

/**
 * The native browser page-action ask's verdict, mode-aware — the pure half of
 * index.ts's confirmBrowserPageAction so the matrix is pinnable without a
 * dialog:
 *
 * - auto (完全自动): never ask — the call runs.
 * - the renderer gate's `confirmed` marker: never ask — the dock's card (or
 *   the mode / session verdict that stood behind the call) was the one ask.
 *   RENDERER-ASSERTED: a wiring guard, not proof against a compromised
 *   renderer; the marker only ever skips THIS ask — the channel's sender
 *   gate and every validation run regardless.
 * - smart + a recorded app-session always-allow for the tool: never ask —
 *   the person's 始终允许 answer covers the call dialog-free.
 * - anything else (a marker-less call — a bypassed or stale renderer): ask.
 *   Paranoid deliberately skips the session consult: 始终询问 means every
 *   side effect asks, and no renderer card stood behind a marker-less call.
 */
export function shouldAskBrowserPageAction(input: {
  /** the current permission mode (read from the store, synchronously) */
  mode: AiPermissionMode
  /** the renderer gate's marker rode the call (the delete_file precedent) */
  confirmed: boolean
  /** the main-side app-session set's answer for the call's tool */
  sessionAllowed: boolean
}): boolean {
  if (input.mode === 'auto') return false
  if (input.confirmed) return false
  if (input.mode === 'smart' && input.sessionAllowed) return false
  return true
}

/**
 * app-settings.json key holding the AI panel's global permission mode. The
 * value is an object (`{ mode }`) like the aiDock and dockPrefs stores, so
 * later fields (per-tool exceptions, an audit toggle) can land without a
 * store migration.
 */
export const AI_PERMISSIONS_KEY = 'aiPermissions'

/**
 * The stored mode as the main process sees it — the `aiPermissions.mode`
 * field, normalized (a malformed or absent store reads as the default
 * posture, never as a crash or a silently-permissive value).
 */
export function readAiPermissions(settingsPath: string): AiPermissionMode {
  const raw = readAppSettings(settingsPath)[AI_PERMISSIONS_KEY]
  const mode =
    raw !== null && typeof raw === 'object' ? (raw as { mode?: unknown }).mode : undefined
  return normalizeAiPermissionMode(mode)
}

const WATCH_DEBOUNCE_MS = 100

/**
 * Re-read the permission mode whenever app-settings.json changes and call
 * `onChange` with the new value — only when it actually changed, so an
 * unrelated settings write (the language, the dock, the drawer) never
 * re-broadcasts a mode the panels already hold.
 *
 * Same shape as watchAiDock / watchDockPrefs: the renderer owns the writes,
 * so the file is the whole contract surface; this watches the settings
 * *directory* (atomic writes rename a temp file over the target) and
 * filters events touching the settings file or its temp siblings. A watch
 * that cannot be created degrades silently — the panels pull the mode once
 * at mount and re-pull on focus, so a missed change still lands.
 *
 * Returns the watcher's disposer.
 */
export function watchAiPermissions(
  settingsPath: string,
  onChange: (mode: AiPermissionMode) => void,
): () => void {
  let last = readAiPermissions(settingsPath)
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
      // re-broadcast, and a watch event racing the read is harmless — the
      // next event re-reads
      const next = readAiPermissions(settingsPath)
      if (sameAiPermissionMode(next, last)) return
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

export { DEFAULT_AI_PERMISSION_MODE, normalizeAiPermissionMode }
export type { AiPermissionMode }
