/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AI_PET_IDS,
  mergeAiPetPrefs,
  normalizeAiPetPrefs,
  type AiPetId,
  type AiPetPrefs,
  type AiPetPrefsPatch,
} from '../src/shared/ai-pet-prefs'
import type { AiDockPrefs, HomeApi } from '../src/shared/home-api'
import { AiPetSettingsPane, PET_PREVIEW_MOODS } from '../src/renderer/src/AiPetSettingsPane'
import { AI_PET_CATALOG, petMetaFor } from '../src/renderer/src/ai-pet-catalog'
import { petSoundProfile } from '../src/renderer/src/ai-pet-sound'
import { loadStrings, translate } from '../src/renderer/src/strings'
import type { TFunc } from '../src/renderer/src/locale'

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

interface RecordedOscillator {
  type: OscillatorType
  frequency: {
    setValueAtTime: ReturnType<typeof vi.fn>
    exponentialRampToValueAtTime: ReturnType<typeof vi.fn>
  }
  connect: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
}

interface AudioRecorder {
  oscillators: RecordedOscillator[]
}

function installFreshMockAudioContext(): AudioRecorder {
  const recorder: AudioRecorder = { oscillators: [] }

  class MockAudioContext {
    state: AudioContextState = 'running'
    currentTime = 0
    destination = {}
    resume = vi.fn(() => Promise.resolve())

    createOscillator() {
      const osc: RecordedOscillator = {
        type: 'sine',
        frequency: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      }
      recorder.oscillators.push(osc)
      return osc
    }

    createGain() {
      return {
        gain: {
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
      }
    }
  }

  ;(window as unknown as { AudioContext?: unknown }).AudioContext = MockAudioContext
  return recorder
}

const t: TFunc = (key, params) => translate('en', key, params)

let host: HTMLDivElement
let root: Root
let storedPrefs: AiPetPrefs
let petPatches: AiPetPrefsPatch[]
let dockPatches: Array<Partial<AiDockPrefs>>
let pushHandlers: Array<(next: AiPetPrefs) => void>
let unsubscribeSpy: ReturnType<typeof vi.fn>
let audioRecorder: AudioRecorder

const originalAudioContext = (window as unknown as { AudioContext?: unknown }).AudioContext
const originalWebkitAudioContext = (window as unknown as { webkitAudioContext?: unknown })
  .webkitAudioContext
const originalMatchMedia = window.matchMedia

beforeAll(async () => {
  await loadStrings('en')
})

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)

  storedPrefs = normalizeAiPetPrefs(undefined)
  petPatches = []
  dockPatches = []
  pushHandlers = []
  unsubscribeSpy = vi.fn()
  audioRecorder = installFreshMockAudioContext()

  window.aiOffice = {
    getAiPetPrefs: vi.fn(async () => storedPrefs),
    setAiPetPrefs: vi.fn(async (patch: AiPetPrefsPatch) => {
      petPatches.push(patch)
      storedPrefs = mergeAiPetPrefs(storedPrefs, patch)
      return storedPrefs
    }),
    onAiPetPrefsChanged: vi.fn((handler: (next: AiPetPrefs) => void) => {
      pushHandlers.push(handler)
      return () => {
        unsubscribeSpy()
        const idx = pushHandlers.indexOf(handler)
        if (idx >= 0) pushHandlers.splice(idx, 1)
      }
    }),
    setAiDock: vi.fn(async (patch: Partial<AiDockPrefs>) => {
      dockPatches.push(patch)
      return { width: 380, collapsed: true, petPos: patch.petPos ?? null }
    }),
  } as unknown as HomeApi
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  ;(window as unknown as { AudioContext?: unknown }).AudioContext = originalAudioContext
  ;(window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext =
    originalWebkitAudioContext
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  })
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function renderPane(): Promise<void> {
  await act(async () => {
    root.render(createElement(AiPetSettingsPane, { t }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

function stageSvg(): SVGSVGElement {
  const el = host.querySelector<SVGSVGElement>('.ai-pet-stage .ai-mascot-svg')
  expect(el).toBeTruthy()
  return el!
}

function petCard(id: AiPetId): HTMLButtonElement {
  const el = host.querySelector<HTMLButtonElement>(`[data-pet-card="${id}"]`)
  expect(el, `card for ${id}`).toBeTruthy()
  return el!
}

function moodChip(mood: string): HTMLButtonElement {
  const el = host.querySelector<HTMLButtonElement>(`[data-mood-chip="${mood}"]`)
  expect(el, `mood chip for ${mood}`).toBeTruthy()
  return el!
}

function buttonByText(label: string): HTMLButtonElement {
  const el = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (btn) => btn.textContent?.trim() === label,
  )
  expect(el, `button "${label}"`).toBeTruthy()
  return el!
}

function switchByLabel(label: string): HTMLButtonElement {
  const el = [...host.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find(
    (sw) => sw.getAttribute('aria-label') === label,
  )
  expect(el, `switch "${label}"`).toBeTruthy()
  return el!
}

describe('AiPetSettingsPane', () => {
  it('exports PET_PREVIEW_MOODS with the 9 moods in exact order', () => {
    expect(PET_PREVIEW_MOODS.map((item) => item.mood)).toEqual([
      'idle',
      'curious',
      'thinking',
      'working',
      'petted',
      'fed',
      'playful',
      'sleepy',
      'error',
    ])
    expect(PET_PREVIEW_MOODS.map((item) => item.labelKey)).toEqual([
      'petMoodIdle',
      'petMoodCurious',
      'petMoodThinking',
      'petMoodWorking',
      'petMoodPetted',
      'petMoodFed',
      'petMoodPlayful',
      'petMoodSleepy',
      'petMoodError',
    ])
  })

  it('renders all 5 pet cards, switches companion via setAiPetPrefs, updates stage, and plays select sound', async () => {
    await renderPane()

    const radiogroup = host.querySelector<HTMLElement>('[role="radiogroup"]')
    expect(radiogroup?.getAttribute('aria-label')).toBe(t('setPetSelectLabel'))

    const cards = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"][data-pet-card]')]
    expect(cards).toHaveLength(AI_PET_IDS.length)
    expect(cards.map((c) => c.dataset.petCard)).toEqual([...AI_PET_IDS])

    // Default active companion is bluebird
    expect(petCard('bluebird').getAttribute('aria-checked')).toBe('true')
    expect(petCard('bluebird').textContent).toContain(t('setPetActiveBadge'))
    expect(petCard('bluebird').querySelector('.ai-mascot-svg')?.getAttribute('data-mood')).toBe(
      'hover',
    )
    expect(petCard('cat').getAttribute('aria-checked')).toBe('false')
    expect(petCard('cat').textContent).not.toContain(t('setPetActiveBadge'))
    expect(petCard('cat').querySelector('.ai-mascot-svg')?.getAttribute('data-mood')).toBe('idle')

    expect(stageSvg().getAttribute('data-pet')).toBe('bluebird')
    expect(host.querySelector('.ai-pet-stage-name')?.textContent).toBe(t('petNameBluebird'))

    // Verify all 5 cards carry their species name, tag, and description
    for (const meta of AI_PET_CATALOG) {
      const card = petCard(meta.id)
      expect(card.textContent).toContain(t(meta.nameKey))
      expect(card.textContent).toContain(t(meta.tagKey))
      expect(card.textContent).toContain(t(meta.descKey))
    }

    // Select robot companion
    await act(async () => {
      petCard('robot').click()
      await Promise.resolve()
    })

    expect(petPatches).toEqual([{ petId: 'robot' }])
    expect(petCard('robot').getAttribute('aria-checked')).toBe('true')
    expect(petCard('bluebird').getAttribute('aria-checked')).toBe('false')
    expect(stageSvg().getAttribute('data-pet')).toBe('robot')
    expect(host.querySelector('.ai-pet-stage-name')?.textContent).toBe(t('petNameRobot'))
    expect(host.querySelector('.ai-pet-stage-tag')?.textContent).toBe(t('petTagRobot'))

    // Select sound for robot should have scheduled its square-wave select chime
    const robotSelectProfile = petSoundProfile('robot', 'select')
    expect(audioRecorder.oscillators).toHaveLength(robotSelectProfile.notes.length)
    expect(audioRecorder.oscillators[0]?.type).toBe(robotSelectProfile.waveform)
    expect(audioRecorder.oscillators[0]?.frequency.setValueAtTime).toHaveBeenCalledWith(
      robotSelectProfile.notes[0]!.freq,
      expect.any(Number),
    )
  })

  it('triggers Pet, Feed, and Play interactions with mood, active-species bubble, sound, and atomic count increments', async () => {
    await renderPane()

    // Pet button
    await act(async () => {
      buttonByText(t('petActionPet')).click()
      await Promise.resolve()
    })
    expect(stageSvg().getAttribute('data-mood')).toBe('petted')
    const petBubble = host.querySelector<HTMLElement>('.ai-pet-stage-bubble')
    expect(petBubble).toBeTruthy()
    expect(petBubble?.getAttribute('role')).toBe('status')
    expect(petBubble?.getAttribute('aria-live')).toBe('polite')
    expect(petBubble?.textContent).toBe(t('petLineBluebirdPet'))
    expect(petPatches).toEqual([{ incrementInteraction: 'bluebird' }])
    expect(host.querySelector('.ai-pet-stage-count')?.textContent).toBe(
      t('petBondCount', { n: 1 }),
    )
    expect(audioRecorder.oscillators.length).toBeGreaterThan(0)

    // Switch to cat and click Feed treat
    await act(async () => {
      petCard('cat').click()
      await Promise.resolve()
    })
    await act(async () => {
      buttonByText(t('petActionFeed')).click()
      await Promise.resolve()
    })
    expect(stageSvg().getAttribute('data-mood')).toBe('fed')
    expect(host.querySelector('.ai-pet-stage-bubble')?.textContent).toBe(t('petLineCatFeed'))
    expect(petPatches.at(-1)).toEqual({ incrementInteraction: 'cat' })

    // Play button on cat
    await act(async () => {
      buttonByText(t('petActionPlay')).click()
      await Promise.resolve()
    })
    expect(stageSvg().getAttribute('data-mood')).toBe('playful')
    expect(host.querySelector('.ai-pet-stage-bubble')?.textContent).toBe(t('petLineCatPlay'))
    expect(petPatches.at(-1)).toEqual({ incrementInteraction: 'cat' })
    expect(host.querySelector('.ai-pet-stage-count')?.textContent).toBe(
      t('petBondCount', { n: 2 }),
    )

    // Clicking the stage pet directly triggers a pet reaction
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.ai-pet-stage-pet')!.click()
      await Promise.resolve()
    })
    expect(stageSvg().getAttribute('data-mood')).toBe('petted')
    expect(host.querySelector('.ai-pet-stage-bubble')?.textContent).toBe(t('petLineCatPet'))
    expect(petPatches.at(-1)).toEqual({ incrementInteraction: 'cat' })
  })

  it('renders all 3 bond stages (<5, 5..19, >=20) from initial load and external updates', async () => {
    storedPrefs = normalizeAiPetPrefs({
      petId: 'fox',
      interactions: { fox: 4, cat: 19, panda: 20 },
    })
    await renderPane()

    const badge = () => host.querySelector<HTMLElement>('.ai-pet-bond-badge')
    expect(badge()?.textContent).toBe(t('petBondStranger'))
    expect(badge()?.dataset.bondStage).toBe('stranger')
    expect(host.querySelector('.ai-pet-stage-count')?.textContent).toBe(
      t('petBondCount', { n: 4 }),
    )

    // 4 -> 5 promotes fox from stranger to familiar
    await act(async () => {
      buttonByText(t('petActionPet')).click()
      await Promise.resolve()
    })
    expect(badge()?.textContent).toBe(t('petBondFamiliar'))
    expect(badge()?.dataset.bondStage).toBe('familiar')
    expect(host.querySelector('.ai-pet-stage-count')?.textContent).toBe(
      t('petBondCount', { n: 5 }),
    )

    // Switch to cat (19 -> familiar) then increment to 20 -> partner
    await act(async () => {
      petCard('cat').click()
      await Promise.resolve()
    })
    expect(badge()?.textContent).toBe(t('petBondFamiliar'))
    expect(badge()?.dataset.bondStage).toBe('familiar')

    await act(async () => {
      buttonByText(t('petActionFeed')).click()
      await Promise.resolve()
    })
    expect(badge()?.textContent).toBe(t('petBondPartner'))
    expect(badge()?.dataset.bondStage).toBe('partner')
    expect(host.querySelector('.ai-pet-stage-count')?.textContent).toBe(
      t('petBondCount', { n: 20 }),
    )

    // External push with panda at 25 also shows partner
    await act(async () => {
      for (const handler of [...pushHandlers]) {
        handler(normalizeAiPetPrefs({ petId: 'panda', interactions: { panda: 25 } }))
      }
      await Promise.resolve()
    })
    expect(badge()?.textContent).toBe(t('petBondPartner'))
    expect(host.querySelector('.ai-pet-stage-count')?.textContent).toBe(
      t('petBondCount', { n: 25 }),
    )
  })

  it('switches mood preview chips, toggles back to live mode on re-click or idle, and clears on interaction', async () => {
    vi.useFakeTimers()
    await renderPane()

    expect(stageSvg().getAttribute('data-mood')).toBe('idle')
    expect(moodChip('idle').getAttribute('aria-pressed')).toBe('true')

    // Click Thinking chip
    await act(async () => {
      moodChip('thinking').click()
      await Promise.resolve()
    })
    expect(stageSvg().getAttribute('data-mood')).toBe('thinking')
    expect(moodChip('thinking').getAttribute('aria-pressed')).toBe('true')
    expect(moodChip('idle').getAttribute('aria-pressed')).toBe('false')

    // Re-click Thinking chip toggles back to live mode (idle)
    await act(async () => {
      moodChip('thinking').click()
      await Promise.resolve()
    })
    expect(stageSvg().getAttribute('data-mood')).toBe('idle')
    expect(moodChip('thinking').getAttribute('aria-pressed')).toBe('false')
    expect(moodChip('idle').getAttribute('aria-pressed')).toBe('true')

    // Click Working chip, then click Idle chip to return to live mode
    await act(async () => {
      moodChip('working').click()
      await Promise.resolve()
    })
    expect(stageSvg().getAttribute('data-mood')).toBe('working')
    expect(moodChip('working').getAttribute('aria-pressed')).toBe('true')

    await act(async () => {
      moodChip('idle').click()
      await Promise.resolve()
    })
    expect(stageSvg().getAttribute('data-mood')).toBe('idle')
    expect(moodChip('working').getAttribute('aria-pressed')).toBe('false')
    expect(moodChip('idle').getAttribute('aria-pressed')).toBe('true')

    // Interaction clears active preview mood
    await act(async () => {
      moodChip('error').click()
      await Promise.resolve()
    })
    expect(stageSvg().getAttribute('data-mood')).toBe('error')
    expect(moodChip('error').getAttribute('aria-pressed')).toBe('true')

    await act(async () => {
      buttonByText(t('petActionFeed')).click()
      await Promise.resolve()
    })
    expect(stageSvg().getAttribute('data-mood')).toBe('fed')
    expect(moodChip('error').getAttribute('aria-pressed')).toBe('false')

    // Let the temporary fed reaction & bubble settle back to live idle
    await act(async () => {
      vi.advanceTimersByTime(2500)
      await Promise.resolve()
    })
    expect(stageSvg().getAttribute('data-mood')).toBe('idle')
    expect(host.querySelector('.ai-pet-stage-bubble')).toBeNull()

    // Switching pets also clears preview mood
    await act(async () => {
      moodChip('sleepy').click()
      await Promise.resolve()
    })
    expect(stageSvg().getAttribute('data-mood')).toBe('sleepy')
    await act(async () => {
      petCard('fox').click()
      await Promise.resolve()
    })
    expect(stageSvg().getAttribute('data-pet')).toBe('fox')
    expect(stageSvg().getAttribute('data-mood')).toBe('idle')
    expect(moodChip('sleepy').getAttribute('aria-pressed')).toBe('false')
  })

  it('toggles bubbles and sound switches, resets corner position, and handles external pushes & unmount', async () => {
    await renderPane()

    const bubblesSwitch = switchByLabel(t('setPetBubbles'))
    const soundSwitch = switchByLabel(t('setPetSound'))

    expect(bubblesSwitch.getAttribute('aria-checked')).toBe('true')
    expect(soundSwitch.getAttribute('aria-checked')).toBe('true')

    // Trigger interaction so a speech bubble appears, then turn bubbles OFF
    await act(async () => {
      buttonByText(t('petActionPet')).click()
      await Promise.resolve()
    })
    expect(host.querySelector('.ai-pet-stage-bubble')).toBeTruthy()

    await act(async () => {
      bubblesSwitch.click()
      await Promise.resolve()
    })
    expect(petPatches.at(-1)).toEqual({ bubbles: false })
    expect(bubblesSwitch.getAttribute('aria-checked')).toBe('false')
    expect(host.querySelector('.ai-pet-stage-bubble')).toBeNull()

    // Turning bubbles back ON restores visibility while activeBubble is still live
    await act(async () => {
      bubblesSwitch.click()
      await Promise.resolve()
    })
    expect(petPatches.at(-1)).toEqual({ bubbles: true })
    expect(host.querySelector('.ai-pet-stage-bubble')?.textContent).toBe(t('petLineBluebirdPet'))

    // Turning sound OFF does not play chime and suppresses interaction sounds
    audioRecorder.oscillators.length = 0
    await act(async () => {
      soundSwitch.click()
      await Promise.resolve()
    })
    expect(petPatches.at(-1)).toEqual({ sound: false })
    expect(soundSwitch.getAttribute('aria-checked')).toBe('false')
    expect(audioRecorder.oscillators).toHaveLength(0)

    await act(async () => {
      buttonByText(t('petActionPlay')).click()
      await Promise.resolve()
    })
    expect(audioRecorder.oscillators).toHaveLength(0)

    // Turning sound ON from false plays the active pet's select chime
    await act(async () => {
      soundSwitch.click()
      await Promise.resolve()
    })
    expect(petPatches.at(-1)).toEqual({ sound: true })
    expect(soundSwitch.getAttribute('aria-checked')).toBe('true')
    expect(audioRecorder.oscillators).toHaveLength(
      petSoundProfile('bluebird', 'select').notes.length,
    )

    // Reset pet corner position calls setAiDock({ petPos: null })
    await act(async () => {
      buttonByText(t('setPetResetPos')).click()
      await Promise.resolve()
    })
    expect(dockPatches).toEqual([{ petPos: null }])

    // External push updates active pet, switches, and bond count cleanly
    await act(async () => {
      for (const handler of [...pushHandlers]) {
        handler(
          normalizeAiPetPrefs({
            petId: 'panda',
            bubbles: false,
            sound: false,
            interactions: { panda: 12 },
          }),
        )
      }
      await Promise.resolve()
    })
    expect(stageSvg().getAttribute('data-pet')).toBe('panda')
    expect(petCard('panda').getAttribute('aria-checked')).toBe('true')
    expect(bubblesSwitch.getAttribute('aria-checked')).toBe('false')
    expect(soundSwitch.getAttribute('aria-checked')).toBe('false')
    expect(host.querySelector('.ai-pet-bond-badge')?.textContent).toBe(t('petBondFamiliar'))
    expect(host.querySelector('.ai-pet-stage-count')?.textContent).toBe(
      t('petBondCount', { n: 12 }),
    )

    // Unmount disposes store listener cleanly
    expect(unsubscribeSpy).not.toHaveBeenCalled()
    act(() => root.unmount())
    expect(unsubscribeSpy).toHaveBeenCalledTimes(1)
  })

  it('supports pointer rubbing on the stage pet and respects prefers-reduced-motion for sound', async () => {
    await renderPane()

    const stagePet = host.querySelector<HTMLButtonElement>('.ai-pet-stage-pet')!
    const meta = petMetaFor('bluebird')

    await act(async () => {
      moodChip('sleepy').click()
      await Promise.resolve()
    })
    expect(stageSvg().getAttribute('data-mood')).toBe('sleepy')

    // Rubbing back and forth across the stage pet triggers 'pet' interaction
    await act(async () => {
      stagePet.dispatchEvent(new MouseEvent('pointerenter', { bubbles: true }))
      const strokes = [0, 40, 0, 40, 0, 40]
      for (const clientX of strokes) {
        stagePet.dispatchEvent(
          new MouseEvent('pointermove', { bubbles: true, clientX, clientY: 20 }),
        )
      }
      await Promise.resolve()
    })

    expect(stageSvg().getAttribute('data-mood')).toBe('petted')
    expect(moodChip('sleepy').getAttribute('aria-pressed')).toBe('false')
    expect(host.querySelector('.ai-pet-stage-bubble')?.textContent).toBe(t(meta.lineKeys.pet))
    expect(petPatches.at(-1)).toEqual({ incrementInteraction: 'bluebird' })

    // When reduced motion is active, interaction sound is suppressed
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === '(prefers-reduced-motion: reduce)',
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })

    audioRecorder.oscillators.length = 0
    await act(async () => {
      buttonByText(t('petActionFeed')).click()
      await Promise.resolve()
    })
    expect(stageSvg().getAttribute('data-mood')).toBe('fed')
    expect(audioRecorder.oscillators).toHaveLength(0)
  })
})
