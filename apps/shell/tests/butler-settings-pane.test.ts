/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mergeButlerPrefs,
  normalizeButlerPrefs,
  type ButlerPrefs,
  type ButlerPrefsPatch,
} from '../src/shared/butler-prefs'
import type { HomeApi, SystemPresenceSettings } from '../src/shared/home-api'
import { ButlerSettingsPane } from '../src/renderer/src/ButlerSettingsPane'
import { hotkeyPresets } from '../src/renderer/src/hotkey-recorder'
import { LocaleProvider, type TFunc } from '../src/renderer/src/locale'
import { loadStrings, translate } from '../src/renderer/src/strings'

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const t: TFunc = (key, params) => translate('en', key, params)

let host: HTMLDivElement
let root: Root
let storedPrefs: ButlerPrefs
let butlerPatches: ButlerPrefsPatch[]
let presenceState: SystemPresenceSettings
let hotkeyPatches: Array<{ enabled?: boolean; accelerator?: string }>
let pushHandlers: Array<(next: ButlerPrefs) => void>
let unsubscribeSpy: ReturnType<typeof vi.fn>
let spokenUtterances: Array<{
  text: string
  rate: number
  lang: string
  voice: SpeechSynthesisVoice | null
}>
let mockVoices: SpeechSynthesisVoice[]

const originalSpeechSynthesis = Object.getOwnPropertyDescriptor(window, 'speechSynthesis')
const originalUtterance = (globalThis as { SpeechSynthesisUtterance?: unknown })
  .SpeechSynthesisUtterance
const originalNavigatorPlatform = Object.getOwnPropertyDescriptor(navigator, 'platform')

beforeAll(async () => {
  await loadStrings('en')
})

beforeEach(() => {
  Object.defineProperty(navigator, 'platform', {
    configurable: true,
    value: 'Win32',
  })

  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)

  storedPrefs = normalizeButlerPrefs(undefined)
  butlerPatches = []
  pushHandlers = []
  unsubscribeSpy = vi.fn()
  hotkeyPatches = []
  presenceState = {
    loginItem: false,
    hotkey: { enabled: true, accelerator: 'Alt+Space' },
    hotkeyActive: true,
    loginItemSupported: true,
    closeToTray: true,
    closeToTraySupported: true,
  }

  mockVoices = [
    {
      name: 'Google 普通话',
      lang: 'zh-CN',
      localService: false,
      default: false,
      voiceURI: 'zh',
    },
    {
      name: 'Microsoft Zira',
      lang: 'en-US',
      localService: true,
      default: true,
      voiceURI: 'en',
    },
    {
      name: 'Kyoko',
      lang: 'ja-JP',
      localService: false,
      default: false,
      voiceURI: 'ja',
    },
  ] as SpeechSynthesisVoice[]

  spokenUtterances = []

  class MockSpeechSynthesisUtterance {
    text: string
    rate = 1
    lang = ''
    voice: SpeechSynthesisVoice | null = null
    constructor(text: string) {
      this.text = text
    }
  }

  ;(globalThis as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance =
    MockSpeechSynthesisUtterance

  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      getVoices: vi.fn(() => mockVoices),
      cancel: vi.fn(),
      speak: vi.fn((utt: MockSpeechSynthesisUtterance) => {
        spokenUtterances.push({
          text: utt.text,
          rate: utt.rate,
          lang: utt.lang,
          voice: utt.voice,
        })
      }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  })

  window.aiOffice = {
    getButlerPrefs: vi.fn(async () => storedPrefs),
    setButlerPrefs: vi.fn(async (patch: ButlerPrefsPatch) => {
      butlerPatches.push(patch)
      storedPrefs = mergeButlerPrefs(storedPrefs, patch)
      return storedPrefs
    }),
    onButlerPrefsChanged: vi.fn((handler: (next: ButlerPrefs) => void) => {
      pushHandlers.push(handler)
      return () => {
        unsubscribeSpy()
        const idx = pushHandlers.indexOf(handler)
        if (idx >= 0) pushHandlers.splice(idx, 1)
      }
    }),
    getSystemPresence: vi.fn(async () => presenceState),
    setGlobalHotkey: vi.fn(async (patch: { enabled?: boolean; accelerator?: string }) => {
      hotkeyPatches.push(patch)
      presenceState = {
        ...presenceState,
        hotkey: {
          enabled: patch.enabled ?? presenceState.hotkey.enabled,
          accelerator: patch.accelerator ?? presenceState.hotkey.accelerator,
        },
        hotkeyActive: true,
      }
      return presenceState
    }),
  } as unknown as HomeApi
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()

  if (originalSpeechSynthesis) {
    Object.defineProperty(window, 'speechSynthesis', originalSpeechSynthesis)
  } else {
    delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis
  }

  if (originalUtterance !== undefined) {
    ;(globalThis as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance =
      originalUtterance
  } else {
    delete (globalThis as unknown as { SpeechSynthesisUtterance?: unknown })
      .SpeechSynthesisUtterance
  }

  if (originalNavigatorPlatform) {
    Object.defineProperty(navigator, 'platform', originalNavigatorPlatform)
  }

  vi.restoreAllMocks()
})

async function renderPane(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(LocaleProvider, { initial: 'en' }, createElement(ButlerSettingsPane, { t })),
    )
    await Promise.resolve()
    await Promise.resolve()
  })
}

function switchByLabel(label: string): HTMLButtonElement {
  const el = [...host.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find(
    (sw) => sw.getAttribute('aria-label') === label,
  )
  expect(el, `switch "${label}"`).toBeTruthy()
  return el!
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('ButlerSettingsPane', () => {
  it('renders and toggles master, persona, proactive, and voice switches via setButlerPrefs', async () => {
    await renderPane()

    const switchMappings: Array<[string, keyof ButlerPrefs, boolean]> = [
      [t('setButlerEnabled'), 'enabled', false],
      [t('setButlerPersona'), 'persona', false],
      [t('setButlerBriefing'), 'briefing', false],
      [t('setButlerNotifyDone'), 'notifyDone', false],
      [t('setButlerNotifyConfirm'), 'notifyConfirm', false],
      [t('setButlerDnd'), 'dnd', true],
      [t('setButlerVoice'), 'voice', false],
    ]

    for (const [label, key, expectedNext] of switchMappings) {
      const sw = switchByLabel(label)
      expect(sw.getAttribute('aria-checked')).toBe(String(!expectedNext))
      await act(async () => {
        sw.click()
        await Promise.resolve()
      })
      expect(butlerPatches.at(-1)).toEqual({ [key]: expectedNext })
      expect(sw.getAttribute('aria-checked')).toBe(String(expectedNext))
    }

    // External push updates UI switches and unmount cleans up the listener
    await act(async () => {
      for (const handler of [...pushHandlers]) {
        handler(normalizeButlerPrefs({ enabled: true, dnd: false, name: 'Alfred' }))
      }
      await Promise.resolve()
    })
    expect(switchByLabel(t('setButlerEnabled')).getAttribute('aria-checked')).toBe('true')
    expect(switchByLabel(t('setButlerDnd')).getAttribute('aria-checked')).toBe('false')
    expect(host.querySelector<HTMLInputElement>('#butler-name-input')?.value).toBe('Alfred')

    expect(unsubscribeSpy).not.toHaveBeenCalled()
    act(() => root.unmount())
    expect(unsubscribeSpy).toHaveBeenCalledTimes(1)
  })

  it('commits persona text fields on blur/Enter, clamps maxPerHour, and protects active drafts from broadcasts', async () => {
    await renderPane()

    const nameInput = host.querySelector<HTMLInputElement>('#butler-name-input')!
    const honorificInput = host.querySelector<HTMLInputElement>('#butler-honorific-input')!
    const userNameInput = host.querySelector<HTMLInputElement>('#butler-user-name-input')!
    const maxInput = host.querySelector<HTMLInputElement>('#butler-max-per-hour')!

    // Active draft in nameInput is not clobbered by external broadcast
    await act(async () => {
      nameInput.focus()
      setInputValue(nameInput, 'Alfred')
      await Promise.resolve()
    })
    await act(async () => {
      for (const handler of [...pushHandlers]) {
        handler(normalizeButlerPrefs({ name: 'JarvisTwo', honorific: 'Boss' }))
      }
      await Promise.resolve()
    })
    expect(nameInput.value).toBe('Alfred')
    expect(honorificInput.value).toBe('Boss')

    // Blur commits the name draft
    await act(async () => {
      nameInput.blur()
      await Promise.resolve()
    })
    expect(butlerPatches.at(-1)).toEqual({ name: 'Alfred' })

    // Enter commits honorific & userName drafts
    await act(async () => {
      honorificInput.focus()
      setInputValue(honorificInput, 'Madam')
      honorificInput.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
      await Promise.resolve()
    })
    expect(butlerPatches.at(-1)).toEqual({ honorific: 'Madam' })

    await act(async () => {
      userNameInput.focus()
      setInputValue(userNameInput, 'Alice')
      userNameInput.blur()
      await Promise.resolve()
    })
    expect(butlerPatches.at(-1)).toEqual({ userName: 'Alice' })

    // maxPerHour clamps out-of-range numbers on blur
    await act(async () => {
      maxInput.focus()
      setInputValue(maxInput, '99')
      maxInput.blur()
      await Promise.resolve()
    })
    expect(butlerPatches.at(-1)).toEqual({ maxPerHour: 30 })
    expect(maxInput.value).toBe('30')
  })

  it('handles hotkey presets, recording, Escape cancel, invalid warning, and blocked retry', async () => {
    presenceState = {
      ...presenceState,
      hotkeyActive: false,
    }
    await renderPane()

    // Keycaps show Alt + Space
    const kbds = [...host.querySelectorAll<HTMLElement>('.butler-kbd')].map((el) =>
      el.textContent?.trim(),
    )
    expect(kbds).toEqual(['Alt', 'Space'])

    // All presets rendered; first preset has the recommended badge
    const chips = [...host.querySelectorAll<HTMLButtonElement>('[data-hotkey-preset]')]
    expect(chips.map((c) => c.dataset.hotkeyPreset)).toEqual([...hotkeyPresets(false)])
    expect(chips[0]?.textContent).toContain(t('setButlerHotkeyRecommended'))
    expect(chips[1]?.textContent).not.toContain(t('setButlerHotkeyRecommended'))

    // Blocked banner + retry button when hotkeyActive is false
    expect(host.textContent).toContain(t('setGlobalHotkeyBlocked'))
    const retryBtn = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === t('setGlobalHotkeyRetry'),
    )!
    await act(async () => {
      retryBtn.click()
      await Promise.resolve()
    })
    expect(hotkeyPatches.at(-1)).toEqual({ enabled: true, accelerator: 'Alt+Space' })
    expect(host.textContent).toContain(t('setButlerHotkeyActive'))

    // Click preset chip
    await act(async () => {
      chips[0]!.click()
      await Promise.resolve()
    })
    expect(hotkeyPatches.at(-1)).toEqual({ accelerator: 'Ctrl+Alt+Space' })
    expect(
      [...host.querySelectorAll<HTMLElement>('.butler-kbd')].map((el) => el.textContent?.trim()),
    ).toEqual(['Ctrl', 'Alt', 'Space'])

    // Record button -> invalid key shows warning, valid combo submits, Escape cancels
    const recordBtn = host.querySelector<HTMLButtonElement>('.butler-record-btn')!
    expect(recordBtn.textContent).toBe(t('setButlerHotkeyRecord'))

    await act(async () => {
      recordBtn.click()
      await Promise.resolve()
    })
    expect(recordBtn.textContent).toBe(t('setButlerHotkeyRecording'))

    // Unmodified key produces invalid prompt and keeps recording active
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true }),
      )
      await Promise.resolve()
    })
    expect(host.querySelector('.butler-hotkey-error')?.textContent).toBe(
      t('setButlerHotkeyInvalid'),
    )
    expect(recordBtn.textContent).toBe(t('setButlerHotkeyRecording'))

    // Escape cancels recording and clears error
    await act(async () => {
      const escEvent = new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
        cancelable: true,
      })
      window.dispatchEvent(escEvent)
      await Promise.resolve()
    })
    expect(recordBtn.textContent).toBe(t('setButlerHotkeyRecord'))
    expect(host.querySelector('.butler-hotkey-error')).toBeNull()

    // Re-enter recording and press Ctrl+Shift+K
    await act(async () => {
      recordBtn.click()
      await Promise.resolve()
    })
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'k',
          code: 'KeyK',
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      )
      await Promise.resolve()
    })
    expect(hotkeyPatches.at(-1)).toEqual({ accelerator: 'Ctrl+Shift+K' })
    expect(recordBtn.textContent).toBe(t('setButlerHotkeyRecord'))
  })

  it('orders matching-language voices first, saves rate/voice selection, and previews voice via speakButler', async () => {
    storedPrefs = normalizeButlerPrefs({ name: 'Jarvis', honorific: 'Sir', voiceRate: 1.0 })
    await renderPane()

    const select = host.querySelector<HTMLSelectElement>('#butler-voice-name')!
    const options = [...select.options].map((o) => ({ value: o.value, text: o.textContent }))
    expect(options[0]).toEqual({ value: '', text: t('setButlerVoiceAuto') })
    // Language is 'en', so Microsoft Zira (en-US) must sort ahead of zh-CN / ja-JP
    expect(options[1]?.value).toBe('Microsoft Zira')

    // Change rate slider
    const rateInput = host.querySelector<HTMLInputElement>('#butler-voice-rate')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(rateInput, '1.3')
      rateInput.dispatchEvent(new Event('input', { bubbles: true }))
      rateInput.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    expect(butlerPatches.at(-1)).toEqual({ voiceRate: 1.3 })
    expect(host.querySelector('.butler-voice-rate-val')?.textContent).toBe('1.3×')

    // Select a specific voice
    await act(async () => {
      select.value = 'Microsoft Zira'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    expect(butlerPatches.at(-1)).toEqual({ voiceName: 'Microsoft Zira' })

    // Preview button calls speechSynthesis.speak with expected text, rate, and voice
    const previewBtn = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === t('setButlerVoicePreview'),
    )!
    await act(async () => {
      previewBtn.click()
      await Promise.resolve()
    })
    expect(spokenUtterances).toHaveLength(1)
    expect(spokenUtterances[0]).toMatchObject({
      text: t('setButlerVoicePreviewText', { honorific: 'Sir', name: 'Jarvis' }),
      rate: 1.3,
      lang: 'en-US',
    })
    expect(spokenUtterances[0]?.voice?.name).toBe('Microsoft Zira')
  })
})
