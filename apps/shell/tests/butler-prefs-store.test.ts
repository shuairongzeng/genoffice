import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { writeAppSetting, writeAppSettings } from '../src/main/app-settings'
import {
  BUTLER_KEY,
  butlerStatePath,
  readButlerPrefs,
  readButlerState,
  watchButlerPrefs,
  writeButlerPrefs,
  writeButlerState,
} from '../src/main/butler/butler-prefs-store'
import { DEFAULT_BUTLER_PREFS, type ButlerPrefs } from '../src/shared/butler-prefs'

let dir: string

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = undefined as unknown as string
  }
})

function tempDir(): string {
  dir ??= mkdtempSync(join(tmpdir(), 'genoffice-butler-store-'))
  return dir
}

function settingsPath(): string {
  return join(tempDir(), 'app-settings.json')
}

describe('readButlerPrefs & writeButlerPrefs', () => {
  it('returns defaults when settings file is absent', () => {
    expect(readButlerPrefs(settingsPath())).toEqual(DEFAULT_BUTLER_PREFS)
  })

  it('merges partial patches, persists under butler key, and normalizes fields', () => {
    const path = settingsPath()
    const first = writeButlerPrefs(path, {
      name: 'Alfred',
      maxPerHour: 12,
      dnd: true,
    })
    expect(first).toEqual({
      ...DEFAULT_BUTLER_PREFS,
      name: 'Alfred',
      maxPerHour: 12,
      dnd: true,
    })

    const second = writeButlerPrefs(path, {
      dnd: false,
      voiceRate: 1.44,
    })
    expect(second).toEqual({
      ...DEFAULT_BUTLER_PREFS,
      name: 'Alfred',
      maxPerHour: 12,
      dnd: false,
      voiceRate: 1.4,
    })

    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    expect(onDisk[BUTLER_KEY]).toEqual(second)
  })
})

describe('watchButlerPrefs', () => {
  const settle = (probe: () => void): Promise<void> =>
    vi.waitFor(probe, { timeout: 5000, interval: 50 })

  const armed = (): Promise<void> =>
    new Promise((resolve) =>
      setImmediate(() => {
        setTimeout(resolve, 25)
      }),
    )

  it('fires when butler prefs change in app-settings.json', async () => {
    const path = settingsPath()
    const seen: ButlerPrefs[] = []
    const stop = watchButlerPrefs(path, (prefs) => seen.push(prefs))
    try {
      await armed()
      writeButlerPrefs(path, { name: 'Alfred', voice: false })
      await settle(() =>
        expect(seen).toEqual([
          {
            ...DEFAULT_BUTLER_PREFS,
            name: 'Alfred',
            voice: false,
          },
        ]),
      )
    } finally {
      stop()
    }
  })

  it('stays quiet for unrelated settings keys and unchanged rewrites', async () => {
    const path = settingsPath()
    writeButlerPrefs(path, { name: 'Jarvis', dnd: true })
    const seen: ButlerPrefs[] = []
    const stop = watchButlerPrefs(path, (prefs) => seen.push(prefs))
    try {
      await armed()
      writeAppSetting(path, 'language', 'en')
      writeAppSettings(path, {
        [BUTLER_KEY]: { ...DEFAULT_BUTLER_PREFS, name: 'Jarvis', dnd: true },
      })
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(seen).toEqual([])
    } finally {
      stop()
    }
  })

  it('stops firing after dispose is called', async () => {
    const path = settingsPath()
    const seen: ButlerPrefs[] = []
    const stop = watchButlerPrefs(path, (prefs) => seen.push(prefs))
    await armed()
    writeButlerPrefs(path, { dnd: true })
    await settle(() => expect(seen).toHaveLength(1))
    stop()
    await armed()
    writeButlerPrefs(path, { dnd: false })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(seen).toHaveLength(1)
    expect(seen[0]!.dnd).toBe(true)
  })
})

describe('readButlerState & writeButlerState', () => {
  it('returns empty state on missing or corrupt JSON', () => {
    const userDataDir = tempDir()
    expect(readButlerState(userDataDir)).toEqual({
      lastBriefingDay: null,
      lastBriefingAt: null,
      tasks: [],
    })

    writeFileSync(butlerStatePath(userDataDir), '{broken json', 'utf8')
    expect(readButlerState(userDataDir)).toEqual({
      lastBriefingDay: null,
      lastBriefingAt: null,
      tasks: [],
    })

    writeFileSync(butlerStatePath(userDataDir), JSON.stringify(['not-an-object']), 'utf8')
    expect(readButlerState(userDataDir)).toEqual({
      lastBriefingDay: null,
      lastBriefingAt: null,
      tasks: [],
    })
  })

  it('persists state atomically, creates parent directories, and caps tasks at 30', async () => {
    const nestedDir = join(tempDir(), 'nested', 'userdata')
    const tasks = Array.from({ length: 35 }, (_, i) => ({
      sessionKey: `default:butler-${i}`,
      title: `Task ${i}`,
      status: (i % 2 === 0 ? 'done' : 'error') as 'done' | 'error',
      finishedAt: 1000 + i,
    }))

    await writeButlerState(nestedDir, {
      lastBriefingDay: '2026-11-22',
      lastBriefingAt: 5000,
      tasks,
    })

    const loaded = readButlerState(nestedDir)
    expect(loaded.lastBriefingDay).toBe('2026-11-22')
    expect(loaded.lastBriefingAt).toBe(5000)
    expect(loaded.tasks).toHaveLength(30)
    expect(loaded.tasks[0]!.finishedAt).toBe(1034)
    expect(loaded.tasks[29]!.finishedAt).toBe(1005)
  })

  it('filters invalid task records when reading malformed state payloads', () => {
    const userDataDir = tempDir()
    writeFileSync(
      butlerStatePath(userDataDir),
      JSON.stringify({
        lastBriefingDay: '2026-11-22',
        lastBriefingAt: Number.NaN,
        tasks: [
          { sessionKey: 'default:1', title: 'Valid', status: 'done', finishedAt: 2000 },
          { sessionKey: '', title: 'Empty key', status: 'done', finishedAt: 2000 },
          { sessionKey: 'default:2', title: 'Bad status', status: 'running', finishedAt: 2000 },
          'junk',
        ],
      }),
      'utf8',
    )

    expect(readButlerState(userDataDir)).toEqual({
      lastBriefingDay: '2026-11-22',
      lastBriefingAt: null,
      tasks: [{ sessionKey: 'default:1', title: 'Valid', status: 'done', finishedAt: 2000 }],
    })
  })
})
