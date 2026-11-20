import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { AI_PET_KEY, readAiPetPrefs, watchAiPetPrefs } from '../src/main/ai-pet-prefs'
import { writeAppSetting, writeAppSettings } from '../src/main/app-settings'
import {
  AI_PET_IDS,
  AI_PET_INTERACTION_MAX,
  DEFAULT_AI_PET_ID,
  bondStageForCount,
  mergeAiPetPrefs,
  normalizeAiPetPrefs,
  sameAiPetPrefs,
  type AiPetPrefs,
} from '../src/shared/ai-pet-prefs'

let dir: string

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = undefined as unknown as string
  }
})

function settingsPath(): string {
  dir ??= mkdtempSync(join(tmpdir(), 'genoffice-ai-pet-prefs-'))
  return join(dir, 'app-settings.json')
}

const DEFAULT_PREFS: AiPetPrefs = {
  petId: DEFAULT_AI_PET_ID,
  bubbles: true,
  sound: true,
  interactions: {
    bluebird: 0,
    cat: 0,
    robot: 0,
    fox: 0,
    panda: 0,
  },
}

describe('normalizeAiPetPrefs', () => {
  it('fills complete defaults on absent or malformed values', () => {
    for (const empty of [undefined, null, {}, 'bluebird', 42, []]) {
      expect(normalizeAiPetPrefs(empty)).toEqual(DEFAULT_PREFS)
    }
  })

  it('accepts every supported petId and falls back to default on unknown ones', () => {
    for (const id of AI_PET_IDS) {
      expect(normalizeAiPetPrefs({ petId: id }).petId).toBe(id)
    }
    expect(normalizeAiPetPrefs({ petId: 'dragon' }).petId).toBe(DEFAULT_AI_PET_ID)
    expect(normalizeAiPetPrefs({ petId: 123 }).petId).toBe(DEFAULT_AI_PET_ID)
  })

  it('treats bubbles and sound strictly: only false turns them off', () => {
    expect(normalizeAiPetPrefs({ bubbles: false, sound: false })).toEqual({
      ...DEFAULT_PREFS,
      bubbles: false,
      sound: false,
    })
    expect(normalizeAiPetPrefs({ bubbles: 'off', sound: 0 })).toEqual(DEFAULT_PREFS)
  })

  it('clamps, floors, and sanitizes interaction counts across all pets', () => {
    const prefs = normalizeAiPetPrefs({
      interactions: {
        bluebird: 3.9,
        cat: -5,
        robot: AI_PET_INTERACTION_MAX + 500,
        fox: Number.NaN,
        panda: Number.POSITIVE_INFINITY,
        dragon: 99,
      },
    })
    expect(prefs.interactions).toEqual({
      bluebird: 3,
      cat: 0,
      robot: AI_PET_INTERACTION_MAX,
      fox: 0,
      panda: 0,
    })
  })
})

describe('mergeAiPetPrefs', () => {
  it('merges valid scalar fields and preserves unspecified ones', () => {
    const next = mergeAiPetPrefs(DEFAULT_PREFS, { petId: 'fox', sound: false })
    expect(next).toEqual({
      ...DEFAULT_PREFS,
      petId: 'fox',
      sound: false,
    })
    // Original object remains untouched
    expect(DEFAULT_PREFS.petId).toBe('bluebird')
  })

  it('ignores unknown petId and malformed scalar patches', () => {
    const current = normalizeAiPetPrefs({ petId: 'cat', bubbles: false, sound: true })
    const next = mergeAiPetPrefs(current, {
      petId: 'unknown',
      bubbles: 'yes',
      sound: 0,
    })
    expect(next).toEqual(current)
  })

  it('merges partial interaction counts and clamps out-of-range values', () => {
    const current = normalizeAiPetPrefs({ interactions: { bluebird: 4, cat: 7 } })
    const next = mergeAiPetPrefs(current, {
      interactions: {
        cat: 12.8,
        robot: -2,
        panda: AI_PET_INTERACTION_MAX + 10,
      },
    })
    expect(next.interactions).toEqual({
      bluebird: 4,
      cat: 12,
      robot: 0,
      fox: 0,
      panda: AI_PET_INTERACTION_MAX,
    })
  })

  it('performs atomic incrementInteraction and clamps at max', () => {
    const step1 = mergeAiPetPrefs(DEFAULT_PREFS, { incrementInteraction: 'panda' })
    expect(step1.interactions.panda).toBe(1)

    const atCap = normalizeAiPetPrefs({ interactions: { robot: AI_PET_INTERACTION_MAX } })
    const stepCap = mergeAiPetPrefs(atCap, { incrementInteraction: 'robot' })
    expect(stepCap.interactions.robot).toBe(AI_PET_INTERACTION_MAX)

    const unknownInc = mergeAiPetPrefs(step1, { incrementInteraction: 'dragon' })
    expect(unknownInc).toEqual(step1)
  })

  it('applies explicit interactions before incrementInteraction', () => {
    const next = mergeAiPetPrefs(DEFAULT_PREFS, {
      interactions: { fox: 9 },
      incrementInteraction: 'fox',
    })
    expect(next.interactions.fox).toBe(10)
  })
})

describe('bondStageForCount', () => {
  it('maps counts to stranger, familiar, and partner stages', () => {
    expect(bondStageForCount(-1)).toBe('stranger')
    expect(bondStageForCount(0)).toBe('stranger')
    expect(bondStageForCount(4)).toBe('stranger')
    expect(bondStageForCount(Number.NaN)).toBe('stranger')
    expect(bondStageForCount(Number.POSITIVE_INFINITY)).toBe('stranger')
    expect(bondStageForCount(5)).toBe('familiar')
    expect(bondStageForCount(19)).toBe('familiar')
    expect(bondStageForCount(20)).toBe('partner')
    expect(bondStageForCount(AI_PET_INTERACTION_MAX)).toBe('partner')
  })
})

describe('sameAiPetPrefs', () => {
  it('detects changes across scalars and every pet interaction counter', () => {
    const base = normalizeAiPetPrefs(undefined)
    expect(sameAiPetPrefs(base, normalizeAiPetPrefs(undefined))).toBe(true)
    expect(sameAiPetPrefs(base, normalizeAiPetPrefs({ petId: 'cat' }))).toBe(false)
    expect(sameAiPetPrefs(base, normalizeAiPetPrefs({ bubbles: false }))).toBe(false)
    expect(sameAiPetPrefs(base, normalizeAiPetPrefs({ sound: false }))).toBe(false)
    expect(sameAiPetPrefs(base, normalizeAiPetPrefs({ interactions: { fox: 1 } }))).toBe(false)
  })
})

describe('readAiPetPrefs', () => {
  it('returns defaults when settings file does not exist', () => {
    expect(readAiPetPrefs(settingsPath())).toEqual(DEFAULT_PREFS)
  })

  it('reads and normalizes stored aiPet preferences', () => {
    const path = settingsPath()
    writeAppSetting(path, AI_PET_KEY, {
      petId: 'robot',
      bubbles: false,
      interactions: { robot: 14.7, unknown: 99 },
    })
    expect(readAiPetPrefs(path)).toEqual({
      petId: 'robot',
      bubbles: false,
      sound: true,
      interactions: {
        bluebird: 0,
        cat: 0,
        robot: 14,
        fox: 0,
        panda: 0,
      },
    })
  })

  it('falls back to defaults when stored aiPet is malformed', () => {
    const path = settingsPath()
    writeAppSetting(path, AI_PET_KEY, 'corrupted')
    expect(readAiPetPrefs(path)).toEqual(DEFAULT_PREFS)
  })
})

describe('watchAiPetPrefs', () => {
  const settle = (probe: () => void): Promise<void> =>
    vi.waitFor(probe, { timeout: 5000, interval: 50 })

  const armed = (): Promise<void> =>
    new Promise((resolve) =>
      setImmediate(() => {
        setTimeout(resolve, 25)
      }),
    )

  it('fires when aiPet changes in app-settings.json', async () => {
    const path = settingsPath()
    const seen: AiPetPrefs[] = []
    const stop = watchAiPetPrefs(path, (prefs) => seen.push(prefs))
    try {
      await armed()
      writeAppSetting(path, AI_PET_KEY, {
        petId: 'cat',
        bubbles: false,
        sound: true,
        interactions: { cat: 6 },
      })
      await settle(() =>
        expect(seen).toEqual([
          {
            petId: 'cat',
            bubbles: false,
            sound: true,
            interactions: { bluebird: 0, cat: 6, robot: 0, fox: 0, panda: 0 },
          },
        ]),
      )
    } finally {
      stop()
    }
  })

  it('ignores unrelated settings keys such as language or dockPrefs', async () => {
    const path = settingsPath()
    const seen: AiPetPrefs[] = []
    const stop = watchAiPetPrefs(path, (prefs) => seen.push(prefs))
    try {
      await armed()
      writeAppSetting(path, 'language', 'en')
      writeAppSetting(path, 'dockPrefs', { magnify: false, baseSize: 56 })
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(seen).toEqual([])
    } finally {
      stop()
    }
  })

  it('stays quiet when aiPet is rewritten unchanged', async () => {
    const path = settingsPath()
    writeAppSetting(path, AI_PET_KEY, { petId: 'panda', bubbles: true, sound: false })
    const seen: AiPetPrefs[] = []
    const stop = watchAiPetPrefs(path, (prefs) => seen.push(prefs))
    try {
      await armed()
      writeAppSettings(path, {
        [AI_PET_KEY]: { petId: 'panda', bubbles: true, sound: false },
      })
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(seen).toEqual([])
    } finally {
      stop()
    }
  })

  it('stops firing after the disposer is called', async () => {
    const path = settingsPath()
    const seen: AiPetPrefs[] = []
    const stop = watchAiPetPrefs(path, (prefs) => seen.push(prefs))
    await armed()
    writeAppSetting(path, AI_PET_KEY, { petId: 'fox' })
    await settle(() => expect(seen).toHaveLength(1))
    stop()
    await armed()
    writeAppSetting(path, AI_PET_KEY, { petId: 'robot' })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(seen).toHaveLength(1)
    expect(seen[0]!.petId).toBe('fox')
  })

  it('survives a missing settings file and detects later aiPet writes', async () => {
    const path = settingsPath()
    const seen: AiPetPrefs[] = []
    const stop = watchAiPetPrefs(path, (prefs) => seen.push(prefs))
    try {
      await armed()
      writeAppSetting(path, 'language', 'en')
      writeAppSetting(path, AI_PET_KEY, { petId: 'panda', interactions: { panda: 2 } })
      await settle(() =>
        expect(seen).toEqual([
          {
            petId: 'panda',
            bubbles: true,
            sound: true,
            interactions: { bluebird: 0, cat: 0, robot: 0, fox: 0, panda: 2 },
          },
        ]),
      )
    } finally {
      stop()
    }
  })
})
