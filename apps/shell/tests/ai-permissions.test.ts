import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AI_PERMISSIONS_KEY,
  readAiPermissions,
  shouldAskBrowserPageAction,
  watchAiPermissions,
} from '../src/main/ai-permissions'
import { writeAppSetting, writeAppSettings } from '../src/main/app-settings'

/**
 * The `aiPermissions` pref's main-process read path
 * (src/main/ai-permissions.ts): the app's global permission mode, defaulting
 * to smart on anything malformed, a directory watch that turns renderer
 * writes into broadcasts — only when the value actually changed, never for
 * the other keys app-settings.json carries (same contract shape as the aiDock
 * and dockPrefs watchers) — and the native browser page-action ask's pure
 * verdict: the mode/marker/session matrix behind index.ts's
 * confirmBrowserPageAction, so the ask-exactly-once contract is pinnable
 * without a dialog.
 */

let dir: string

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = undefined as unknown as string
  }
})

function settingsPath(): string {
  dir ??= mkdtempSync(join(tmpdir(), 'genoffice-ai-permissions-'))
  return join(dir, 'app-settings.json')
}

describe('readAiPermissions', () => {
  it('answers the smart default while no setting exists', () => {
    expect(readAiPermissions(settingsPath())).toBe('smart')
  })

  it('reads the stored mode back', () => {
    const path = settingsPath()
    writeAppSetting(path, AI_PERMISSIONS_KEY, { mode: 'auto' })
    expect(readAiPermissions(path)).toBe('auto')
    writeAppSetting(path, AI_PERMISSIONS_KEY, { mode: 'paranoid' })
    expect(readAiPermissions(path)).toBe('paranoid')
  })

  it('falls back to smart on a malformed value — never silently permissive', () => {
    const path = settingsPath()
    writeAppSetting(path, AI_PERMISSIONS_KEY, 'auto')
    expect(readAiPermissions(path)).toBe('smart')
    writeAppSetting(path, AI_PERMISSIONS_KEY, { mode: 'yolo' })
    expect(readAiPermissions(path)).toBe('smart')
    writeAppSettings(path, { [AI_PERMISSIONS_KEY]: { mode: 42 } })
    expect(readAiPermissions(path)).toBe('smart')
  })
})

describe('watchAiPermissions', () => {
  /** wait until `probe` passes, with real timers (fs.watch + the 100ms debounce) */
  const settle = (probe: () => void): Promise<void> =>
    vi.waitFor(probe, { timeout: 5000, interval: 50 })

  /** let the watch stream arm before a write (the aiDock watcher's same breath) */
  const armed = (): Promise<void> =>
    new Promise((resolve) =>
      setImmediate(() => {
        setTimeout(resolve, 25)
      }),
    )

  it('fires with the new mode when the pref is written', async () => {
    const path = settingsPath()
    const seen: string[] = []
    const stop = watchAiPermissions(path, (mode) => seen.push(mode))
    try {
      await armed()
      writeAppSetting(path, AI_PERMISSIONS_KEY, { mode: 'auto' })
      await settle(() => expect(seen).toEqual(['auto']))
    } finally {
      stop()
    }
  })

  it('stays quiet for writes of other settings keys', async () => {
    const path = settingsPath()
    const seen: string[] = []
    const stop = watchAiPermissions(path, (mode) => seen.push(mode))
    try {
      writeAppSetting(path, 'language', 'en')
      writeAppSetting(path, 'theme', 'dark')
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(seen).toEqual([])
    } finally {
      stop()
    }
  })

  it('stays quiet when the mode is rewritten unchanged', async () => {
    const path = settingsPath()
    writeAppSetting(path, AI_PERMISSIONS_KEY, { mode: 'auto' })
    const seen: string[] = []
    const stop = watchAiPermissions(path, (mode) => seen.push(mode))
    try {
      writeAppSettings(path, { [AI_PERMISSIONS_KEY]: { mode: 'auto' } })
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(seen).toEqual([])
    } finally {
      stop()
    }
  })
})

describe("shouldAskBrowserPageAction (the native dialog's verdict)", () => {
  /** the ask verdict for a call, given the mode / marker / session answer */
  const ask = (over: Partial<Parameters<typeof shouldAskBrowserPageAction>[0]>): boolean =>
    shouldAskBrowserPageAction({
      mode: 'smart',
      confirmed: false,
      sessionAllowed: false,
      ...over,
    })

  it('AUTO: never asks — the action runs, dialog or not', () => {
    // the person chose 完全自动: no ask anywhere, the marker and the
    // session set included (they are moot in this mode)
    expect(ask({ mode: 'auto' })).toBe(false)
    expect(ask({ mode: 'auto', confirmed: false, sessionAllowed: false })).toBe(false)
  })

  it("the renderer gate's marker means the one ask already happened", () => {
    // smart: the dock's card (or the verdict that stood behind the call)
    // asked — a second native dialog on top is the "keeps asking" bug
    expect(ask({ confirmed: true })).toBe(false)
    // paranoid too: the card asked (the mode cards every side effect), the
    // dialog must not ask again
    expect(ask({ mode: 'paranoid', confirmed: true })).toBe(false)
    // the marker outranks a missing session entry — it is not "instead of"
    // one, it is the ask already having happened
    expect(ask({ mode: 'paranoid', confirmed: true, sessionAllowed: false })).toBe(false)
  })

  it('SMART: a marker-less call honors the recorded always-allow, dialog-free', () => {
    // the card\'s 始终允许 landed in the main-side app-session set: a call
    // that bypassed the renderer gate (a stale panel without the marker)
    // still rides the person's recorded answer
    expect(ask({ sessionAllowed: true })).toBe(false)
  })

  it('SMART: a marker-less, un-recorded call asks — the dialog is its one ask', () => {
    expect(ask({})).toBe(true)
  })

  it('PARANOID: a marker-less call asks even when the set holds an entry', () => {
    // 始终询问: every side effect asks. The session set can only hold an
    // answer recorded in smart mode, and it must not leak a silent pass into
    // the always-ask posture — no renderer card stood behind this call
    expect(ask({ mode: 'paranoid', sessionAllowed: true })).toBe(true)
    expect(ask({ mode: 'paranoid' })).toBe(true)
  })
})
