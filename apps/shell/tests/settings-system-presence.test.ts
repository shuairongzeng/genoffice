/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeButlerPrefs } from '../src/shared/butler-prefs'
import type { HomeApi, SystemPresenceSettings } from '../src/shared/home-api'
import { LocaleProvider } from '../src/renderer/src/locale'
import { SettingsModal } from '../src/renderer/src/SettingsModal'

/**
 * System presence settings across SettingsModal: General retains launch-at-login
 * and close-to-tray (and no longer hosts the legacy global hotkey controls),
 * while the AI Butler section hosts the summon shortcut switch, presets, and
 * blocked-registration retry backed by getSystemPresence / setGlobalHotkey.
 */

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const PRESENCE: SystemPresenceSettings = {
  loginItem: false,
  hotkey: { enabled: true, accelerator: 'Alt+Space' },
  hotkeyActive: true,
  loginItemSupported: true,
  closeToTray: true,
  closeToTraySupported: true,
}

function stubApi(overrides: Partial<HomeApi> = {}): HomeApi {
  return {
    getTheme: async () => 'system',
    getDefaultSaveDir: async () => '',
    getAnalyticsEnabled: async () => true,
    setAnalyticsEnabled: async () => true,
    getUpdateChannel: async () => 'stable',
    getAppVersion: async () => '1.0.0',
    githubStars: async () => null,
    getSystemPresence: async () => PRESENCE,
    getButlerPrefs: async () => normalizeButlerPrefs(undefined),
    ...overrides,
  } as unknown as HomeApi
}

async function openSection(navLabel: string): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        LocaleProvider,
        { initial: 'en' },
        createElement(SettingsModal, {
          status: null,
          loggingOut: false,
          loginWaiting: false,
          loginUrl: null,
          urlCopied: false,
          onOpenLoginUrl: vi.fn(),
          onCopyLoginUrl: vi.fn(),
          onClose: vi.fn(),
          onLogin: vi.fn(),
          onLogout: vi.fn(),
        }),
      ),
    )
    await Promise.resolve()
    await Promise.resolve()
  })
  const navBtn = Array.from(host.querySelectorAll<HTMLButtonElement>('.set-nav-item')).find(
    (button) => button.textContent?.includes(navLabel),
  )
  expect(navBtn).toBeDefined()
  await act(async () => {
    navBtn!.click()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click()
    await Promise.resolve()
  })
}

describe('Settings system presence', () => {
  it('keeps login-item in General and no longer renders global hotkey controls there', async () => {
    const setLoginItem = vi
      .fn<(enabled: boolean) => Promise<SystemPresenceSettings>>()
      .mockResolvedValue({ ...PRESENCE, loginItem: true })
    window.aiOffice = stubApi({ setLoginItemEnabled: setLoginItem })
    await openSection('General')

    const login = host.querySelector<HTMLButtonElement>('.set-switch[aria-label="Launch at login"]')
    expect(login?.getAttribute('aria-checked')).toBe('false')
    expect(host.querySelector('.set-switch[aria-label="Global shortcut"]')).toBeNull()
    expect(host.querySelector('#set-hotkey-accelerator')).toBeNull()

    await click(login!)
    expect(setLoginItem).toHaveBeenCalledWith(true)
    expect(login?.getAttribute('aria-checked')).toBe('true')
  })

  it('disables the login-item switch on platforms that cannot drive it', async () => {
    window.aiOffice = stubApi({
      getSystemPresence: async () => ({ ...PRESENCE, loginItemSupported: false }),
    })
    await openSection('General')
    const login = host.querySelector<HTMLButtonElement>('.set-switch[aria-label="Launch at login"]')
    expect(login?.disabled).toBe(true)
  })

  it('renders summon shortcut configuration in the AI Butler section and calls setGlobalHotkey', async () => {
    const setHotkey = vi
      .fn<(patch: { enabled?: boolean; accelerator?: string }) => Promise<SystemPresenceSettings>>()
      .mockResolvedValueOnce({
        ...PRESENCE,
        hotkey: { enabled: true, accelerator: 'Ctrl+Alt+Space' },
      })
      .mockResolvedValueOnce({
        ...PRESENCE,
        hotkey: { enabled: false, accelerator: 'Ctrl+Alt+Space' },
      })

    window.aiOffice = stubApi({ setGlobalHotkey: setHotkey })
    await openSection('AI Butler')

    const hotkeySwitch = host.querySelector<HTMLButtonElement>(
      '.set-switch[aria-label="Summon shortcut"]',
    )
    expect(hotkeySwitch?.getAttribute('aria-checked')).toBe('true')

    const preset = host.querySelector<HTMLButtonElement>('[data-hotkey-preset="Ctrl+Alt+Space"]')
    expect(preset).toBeTruthy()
    await click(preset!)
    expect(setHotkey).toHaveBeenCalledWith({ accelerator: 'Ctrl+Alt+Space' })

    await click(hotkeySwitch!)
    expect(setHotkey).toHaveBeenCalledWith({ enabled: false })
    expect(hotkeySwitch?.getAttribute('aria-checked')).toBe('false')
    expect(host.querySelector('.butler-hotkey-panel')).toBeNull()
  })
})
