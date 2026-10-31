import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { AI_DOCK_KEY, readAiDock, watchAiDock } from '../src/main/ai-dock'
import { writeAppSetting, writeAppSettings } from '../src/main/app-settings'
import { AI_DOCK_WIDTH_DEFAULT, type AiDockPrefs } from '../src/shared/desktop-geometry'

/**
 * The `aiDock` pref's main-process read path (src/main/ai-dock.ts): defaults
 * on anything malformed, and a directory watch that turns renderer writes into
 * layout triggers — only when the value actually changed, never for the other
 * keys app-settings.json carries.
 */

let dir: string

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = undefined as unknown as string
  }
})

function settingsPath(): string {
  dir ??= mkdtempSync(join(tmpdir(), 'genoffice-ai-dock-'))
  return join(dir, 'app-settings.json')
}

describe('readAiDock', () => {
  it('answers the expanded default while no setting exists', () => {
    expect(readAiDock(settingsPath())).toEqual({
      width: AI_DOCK_WIDTH_DEFAULT,
      collapsed: false,
    })
  })

  it('reads the stored state back, clamped', () => {
    const path = settingsPath()
    writeAppSetting(path, AI_DOCK_KEY, { width: 480, collapsed: true })
    expect(readAiDock(path)).toEqual({ width: 480, collapsed: true })
    writeAppSettings(path, { [AI_DOCK_KEY]: { width: 9999, collapsed: false } })
    expect(readAiDock(path)).toEqual({ width: 560, collapsed: false })
  })

  it('falls back to defaults on a malformed value', () => {
    const path = settingsPath()
    writeAppSetting(path, AI_DOCK_KEY, 'wide')
    expect(readAiDock(path)).toEqual({ width: AI_DOCK_WIDTH_DEFAULT, collapsed: false })
  })
})

describe('watchAiDock', () => {
  /** wait until `probe` passes, with real timers (fs.watch + the 100ms debounce) */
  const settle = (probe: () => void): Promise<void> =>
    vi.waitFor(probe, { timeout: 5000, interval: 50 })

  /** let the watch stream arm before a write: on macOS the FSEvents stream
   *  needs a loop turn, so a write in the same tick as the install can land
   *  before the stream starts and its event is never delivered (the app
   *  installs its watcher at startup, long before any write) */
  const armed = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

  it('fires with the new value when the pref is written', async () => {
    const path = settingsPath()
    const seen: AiDockPrefs[] = []
    const stop = watchAiDock(path, (dock) => seen.push(dock))
    try {
      await armed()
      writeAppSetting(path, AI_DOCK_KEY, { width: 480, collapsed: true })
      await settle(() => expect(seen).toEqual([{ width: 480, collapsed: true }]))
    } finally {
      stop()
    }
  })

  it('stays quiet for writes of other settings keys', async () => {
    const path = settingsPath()
    const seen: AiDockPrefs[] = []
    const stop = watchAiDock(path, (dock) => seen.push(dock))
    try {
      writeAppSetting(path, 'language', 'en')
      writeAppSetting(path, 'theme', 'dark')
      // past the debounce with no relevant write: nothing may have fired
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(seen).toEqual([])
    } finally {
      stop()
    }
  })

  it('stays quiet when the value is rewritten unchanged', async () => {
    const path = settingsPath()
    writeAppSetting(path, AI_DOCK_KEY, { width: 480, collapsed: false })
    const seen: AiDockPrefs[] = []
    const stop = watchAiDock(path, (dock) => seen.push(dock))
    try {
      writeAppSettings(path, { [AI_DOCK_KEY]: { width: 480, collapsed: false } })
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(seen).toEqual([])
    } finally {
      stop()
    }
  })

  it('stops watching once closed', async () => {
    const path = settingsPath()
    const seen: AiDockPrefs[] = []
    const stop = watchAiDock(path, (dock) => seen.push(dock))
    await armed()
    writeAppSetting(path, AI_DOCK_KEY, { width: 480, collapsed: true })
    await settle(() => expect(seen).toHaveLength(1))
    stop()
    await armed()
    writeAppSetting(path, AI_DOCK_KEY, { width: 200, collapsed: false })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(seen).toEqual([{ width: 480, collapsed: true }])
  })

  it('survives a missing settings file (default read, watch armed)', async () => {
    const path = settingsPath()
    const seen: AiDockPrefs[] = []
    const stop = watchAiDock(path, (dock) => seen.push(dock))
    try {
      await armed()
      writeAppSetting(path, 'theme', 'dark') // the directory gains its first file
      writeAppSetting(path, AI_DOCK_KEY, { width: 500, collapsed: true })
      await settle(() => expect(seen).toEqual([{ width: 500, collapsed: true }]))
    } finally {
      stop()
    }
  })
})
