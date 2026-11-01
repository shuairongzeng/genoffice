/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HomeApi } from '../src/shared/home-api'
import { SettingsModal, type SettingsModalProps } from '../src/renderer/src/SettingsModal'
import { LocaleProvider } from '../src/renderer/src/locale'
import { normalizeDockPrefs, type DockPrefs } from '../src/shared/dock-prefs'

/**
 * The dock's settings section (设置 ▸ 程序坞): the macOS System Settings
 * parity surface — the magnification switch, the icon-size and strength
 * sliders, the auto-hide switch, the order reset — wired to the same
 * `dockPrefs` store both dock mounts read. The mock bridge keeps the prefs
 * state and records every patch, the way the plugins pane's mock behaves.
 */

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
/** the store the mock main answers reads from, updated by writes */
let prefs: DockPrefs
/** the patches the writes carried */
const patches: Array<Partial<DockPrefs>> = []
/** the prefs-push handlers the modal subscribed */
const pushHandlers: Array<(prefs: DockPrefs) => void> = []

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  prefs = normalizeDockPrefs(undefined)
  patches.length = 0
  pushHandlers.length = 0
  window.aiOffice = {
    getTheme: async () => 'system',
    getDefaultSaveDir: async () => '',
    getAnalyticsEnabled: async () => true,
    getAutoSaveDefault: async () => ({ on: false, updatedAt: 0 }),
    getAiPanelPrefs: async () => ({ fontSize: 'default', spellcheck: true }),
    getUpdateChannel: async () => 'stable',
    getAppVersion: async () => '1.0.0',
    githubStars: async () => null,
    getDockPrefs: async () => prefs,
    setDockPrefs: async (patch: Partial<DockPrefs>) => {
      patches.push(patch)
      prefs = normalizeDockPrefs({ ...prefs, ...patch })
      return prefs
    },
    onDockPrefsChanged: (handler: (next: DockPrefs) => void) => {
      pushHandlers.push(handler)
      return () => {
        const index = pushHandlers.indexOf(handler)
        if (index >= 0) pushHandlers.splice(index, 1)
      }
    },
  } as unknown as HomeApi
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

async function renderModal(): Promise<void> {
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
        } satisfies SettingsModalProps),
      ),
    )
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function openDockSection(): Promise<void> {
  await renderModal()
  const navItem = [...host.querySelectorAll<HTMLButtonElement>('.set-nav-item')].find((button) =>
    button.textContent?.includes('Dock'),
  )
  expect(navItem).toBeTruthy()
  await act(async () => {
    navItem!.click()
    await Promise.resolve()
  })
}

const switchOf = (label: string): HTMLElement => {
  const el = [...host.querySelectorAll<HTMLElement>('.set-switch')].find(
    (sw) => sw.getAttribute('aria-label') === label,
  )
  expect(el, `the ${label} switch`).toBeTruthy()
  return el!
}

const rangeOf = (label: string): HTMLInputElement => {
  const el = [...host.querySelectorAll<HTMLInputElement>('.set-range')].find(
    (input) => input.getAttribute('aria-label') === label,
  )
  expect(el, `the ${label} slider`).toBeTruthy()
  return el!
}

/** set an input's value the way a real keystroke does (bypassing the React value tracker) */
const setValue = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
}

describe('the dock settings section', () => {
  it('lists between General and Integrations, and renders every control', async () => {
    await openDockSection()
    const labels = [...host.querySelectorAll<HTMLButtonElement>('.set-nav-item')].map(
      (button) => button.textContent,
    )
    expect(labels.indexOf('Dock')).toBe(labels.indexOf('General') + 1)
    expect(labels.indexOf('Dock')).toBeLessThan(labels.indexOf('Integrations'))
    expect(host.querySelector('.set-pane-title')?.textContent).toBe('Dock')
    expect(switchOf('Magnification')).toBeTruthy()
    expect(rangeOf('Icon size')).toBeTruthy()
    expect(rangeOf('Magnification strength')).toBeTruthy()
    expect(switchOf('Automatically hide the dock')).toBeTruthy()
    expect(
      [...host.querySelectorAll('button')].some((b) => b.textContent === 'Restore default order'),
    ).toBe(true)
  })

  it('the switches write their one field; the reset writes the empty order', async () => {
    await openDockSection()
    // seed a non-default order so the reset has something to clear
    prefs = normalizeDockPrefs({ order: ['dock:ask', 'dock:recent'] })
    await act(async () => switchOf('Magnification').click())
    await act(async () => switchOf('Automatically hide the dock').click())
    expect(patches).toEqual([{ magnify: false }, { autoHide: true }])
    const reset = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Restore default order',
    )!
    await act(async () => reset.click())
    expect(patches.at(-1)).toEqual({ order: [] })
  })

  it('the sliders draft live and commit once, on the release', async () => {
    await openDockSection()
    const size = rangeOf('Icon size')
    // three drag steps: the store is an atomic file write plus a broadcast
    // that re-fits both mounts — none of that may run per step
    for (const value of ['52', '56', '60']) {
      await act(async () => {
        setValue(size, value)
        size.dispatchEvent(new Event('input', { bubbles: true }))
        await Promise.resolve()
      })
    }
    expect(patches).toEqual([])
    // the readout followed the draft live
    expect(host.textContent).toContain('60 px')
    // the slider's release commits exactly once, with the final value
    await act(async () => {
      size.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
      await Promise.resolve()
    })
    expect(patches).toEqual([{ baseSize: 60 }])
    // the strength slider commits on its release too (the keyboard's keyup
    // shares the handler)
    const strength = rangeOf('Magnification strength')
    await act(async () => {
      setValue(strength, '1.45')
      strength.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    expect(patches).toEqual([{ baseSize: 60 }])
    await act(async () => {
      strength.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowRight' }))
      await Promise.resolve()
    })
    expect(patches.at(-1)).toEqual({ maxScale: 1.45 })
    expect(host.textContent).toContain('1.45×')
  })

  it('a store push (a drag on another mount, the watcher broadcast) re-renders the pane', async () => {
    await openDockSection()
    expect(switchOf('Magnification').getAttribute('aria-checked')).toBe('true')
    await act(async () => {
      for (const handler of [...pushHandlers]) handler(normalizeDockPrefs({ magnify: false }))
    })
    expect(switchOf('Magnification').getAttribute('aria-checked')).toBe('false')
  })
})
