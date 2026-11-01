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
  it('answers the open-drawer default while no setting exists', () => {
    expect(readAiDock(settingsPath())).toEqual({
      width: AI_DOCK_WIDTH_DEFAULT,
      collapsed: false,
      petPos: null,
    })
  })

  it('reads the stored state back, clamped', () => {
    const path = settingsPath()
    writeAppSetting(path, AI_DOCK_KEY, { width: 480, collapsed: true, petPos: { x: 12, y: 34 } })
    expect(readAiDock(path)).toEqual({ width: 480, collapsed: true, petPos: { x: 12, y: 34 } })
    writeAppSettings(path, { [AI_DOCK_KEY]: { width: 9999, collapsed: false } })
    expect(readAiDock(path)).toEqual({ width: 560, collapsed: false, petPos: null })
  })

  it('rounds a stored pet position to whole pixels', () => {
    const path = settingsPath()
    writeAppSetting(path, AI_DOCK_KEY, { petPos: { x: 12.4, y: 34.6 } })
    expect(readAiDock(path).petPos).toEqual({ x: 12, y: 35 })
  })

  it('drops a malformed pet position back to the default corner', () => {
    const path = settingsPath()
    writeAppSetting(path, AI_DOCK_KEY, { petPos: { x: 'left', y: 4 } })
    expect(readAiDock(path).petPos).toBeNull()
    writeAppSetting(path, AI_DOCK_KEY, { petPos: { x: 12 } })
    expect(readAiDock(path).petPos).toBeNull()
    writeAppSetting(path, AI_DOCK_KEY, { petPos: 'corner' })
    expect(readAiDock(path).petPos).toBeNull()
  })

  it('falls back to defaults on a malformed value', () => {
    const path = settingsPath()
    writeAppSetting(path, AI_DOCK_KEY, 'wide')
    expect(readAiDock(path)).toEqual({
      width: AI_DOCK_WIDTH_DEFAULT,
      collapsed: false,
      petPos: null,
    })
  })
})

describe('watchAiDock', () => {
  /** wait until `probe` passes, with real timers (fs.watch + the 100ms debounce) */
  const settle = (probe: () => void): Promise<void> =>
    vi.waitFor(probe, { timeout: 5000, interval: 50 })

  /** let the watch stream arm before a write: on macOS the FSEvents stream
   *  needs loop turns — and under a fully parallel suite run, more than one —
   *  so a write that lands before the stream starts is never delivered (the
   *  app installs its watcher at startup, long before any write; a short
   *  breath after the install stands in for that distance here) */
  const armed = (): Promise<void> =>
    new Promise((resolve) =>
      setImmediate(() => {
        setTimeout(resolve, 25)
      }),
    )

  it('fires with the new value when the pref is written', async () => {
    const path = settingsPath()
    const seen: AiDockPrefs[] = []
    const stop = watchAiDock(path, (dock) => seen.push(dock))
    try {
      await armed()
      writeAppSetting(path, AI_DOCK_KEY, { width: 480, collapsed: true, petPos: { x: 5, y: 6 } })
      await settle(() =>
        expect(seen).toEqual([{ width: 480, collapsed: true, petPos: { x: 5, y: 6 } }]),
      )
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

  it('fires when only the pet position moved (P2: the pet-only write)', async () => {
    // a pet drag commits petPos alone; the broadcast is what tells every other
    // prefs copy where the bird perches now, so the gate cannot swallow it
    const path = settingsPath()
    writeAppSetting(path, AI_DOCK_KEY, { width: 480, collapsed: false, petPos: { x: 5, y: 6 } })
    const seen: AiDockPrefs[] = []
    const stop = watchAiDock(path, (dock) => seen.push(dock))
    try {
      await armed()
      writeAppSetting(path, AI_DOCK_KEY, { width: 480, collapsed: false, petPos: { x: 9, y: 6 } })
      await settle(() =>
        expect(seen).toEqual([{ width: 480, collapsed: false, petPos: { x: 9, y: 6 } }]),
      )
    } finally {
      stop()
    }
  })

  it('fires when the pet returns to the default corner (null)', async () => {
    const path = settingsPath()
    writeAppSetting(path, AI_DOCK_KEY, { width: 480, collapsed: false, petPos: { x: 5, y: 6 } })
    const seen: AiDockPrefs[] = []
    const stop = watchAiDock(path, (dock) => seen.push(dock))
    try {
      await armed()
      writeAppSetting(path, AI_DOCK_KEY, { width: 480, collapsed: false, petPos: null })
      await settle(() => expect(seen).toEqual([{ width: 480, collapsed: false, petPos: null }]))
    } finally {
      stop()
    }
  })

  it('stays quiet when the pet position is rewritten at the same perch', async () => {
    const path = settingsPath()
    writeAppSetting(path, AI_DOCK_KEY, { width: 480, collapsed: false, petPos: { x: 5, y: 6 } })
    const seen: AiDockPrefs[] = []
    const stop = watchAiDock(path, (dock) => seen.push(dock))
    try {
      await armed()
      writeAppSettings(path, {
        [AI_DOCK_KEY]: { width: 480, collapsed: false, petPos: { x: 5, y: 6 } },
      })
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
    expect(seen).toEqual([{ width: 480, collapsed: true, petPos: null }])
  })

  it('survives a missing settings file (default read, watch armed)', async () => {
    const path = settingsPath()
    const seen: AiDockPrefs[] = []
    const stop = watchAiDock(path, (dock) => seen.push(dock))
    try {
      await armed()
      writeAppSetting(path, 'theme', 'dark') // the directory gains its first file
      writeAppSetting(path, AI_DOCK_KEY, { width: 500, collapsed: true })
      await settle(() => expect(seen).toEqual([{ width: 500, collapsed: true, petPos: null }]))
    } finally {
      stop()
    }
  })
})
