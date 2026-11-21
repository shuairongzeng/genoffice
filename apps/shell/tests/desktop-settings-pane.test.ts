// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopPrefs, HomeApi } from '../src/shared/home-api'
import { LocaleProvider } from '../src/renderer/src/locale'
import { SettingsModal, type SettingsModalProps } from '../src/renderer/src/SettingsModal'
import { normalizeDockPrefs } from '../src/shared/dock-prefs'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('SettingsModal — Desktop & Wallpaper pane', () => {
  let host: HTMLDivElement
  let root: Root
  let currentPrefs: DesktopPrefs
  let saves: DesktopPrefs[]
  let pushHandlers: Array<(prefs: DesktopPrefs) => void>

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    currentPrefs = {
      wallpaper: 'default',
      carouselMinutes: 10,
      iconSize: 'md',
      sortMode: 'custom',
      wallpaperFit: 'cover',
      labelColor: '',
      recentsMode: 'stack',
      useStacks: true,
      hiddenRecentPaths: ['/docs/a.docx'],
    }
    saves = []
    pushHandlers = []

    window.aiOffice = {
      getTheme: async () => 'system',
      getDefaultSaveDir: async () => '',
      getAnalyticsEnabled: async () => true,
      getAutoSaveDefault: async () => ({ on: false, updatedAt: 0 }),
      getAiPanelPrefs: async () => ({ fontSize: 'default', spellcheck: true }),
      getUpdateChannel: async () => 'stable',
      getAppVersion: async () => '1.0.0',
      githubStars: async () => null,
      getDockPrefs: async () => normalizeDockPrefs(undefined),
      onDockPrefsChanged: () => () => undefined,
      desktopPrefs: async () => currentPrefs,
      desktopPrefsSave: async (next: DesktopPrefs) => {
        currentPrefs = next
        saves.push(next)
      },
      onDesktopPrefsChanged: (handler: (prefs: DesktopPrefs) => void) => {
        pushHandlers.push(handler)
        return () => {
          const i = pushHandlers.indexOf(handler)
          if (i >= 0) pushHandlers.splice(i, 1)
        }
      },
      wallpaperImage: async (id: string) => `data:image/png;base64,${btoa(id)}`,
      wallpaperPickCustom: async () => 'custom:1700000000-picked.png',
    } as unknown as HomeApi
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.restoreAllMocks()
  })

  async function renderDesktopSection(): Promise<void> {
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
            target: { section: 'desktop' },
            onOpenLoginUrl: vi.fn(),
            onCopyLoginUrl: vi.fn(),
            onClose: vi.fn(),
            onLogin: vi.fn(),
            onLogout: vi.fn(),
          } satisfies SettingsModalProps),
        ),
      )
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('loads desktop prefs, syncs bidirectional updates, stops conflicting carousel on wallpaper pick, and toggles layout prefs', async () => {
    await renderDesktopSection()

    expect(host.querySelector('[data-testid="desktop-settings-pane"]')).toBeTruthy()
    expect(host.querySelectorAll('.desktop-wp-tile img').length).toBe(6)

    // Picking a static wallpaper saves the wallpaper and automatically clears carouselMinutes
    const minimalTile = [...host.querySelectorAll<HTMLElement>('.desktop-wp-tile')].find((el) =>
      el.textContent?.includes('Minimal light'),
    )!
    await act(async () => {
      minimalTile.click()
      await Promise.resolve()
    })
    expect(saves.at(-1)).toMatchObject({
      wallpaper: 'builtin:minimal-light',
      carouselMinutes: 0,
    })

    // Toggle Use stacks off
    const stacksSwitch = host.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Use stacks"]',
    )!
    expect(stacksSwitch.getAttribute('aria-checked')).toBe('true')
    await act(async () => {
      stacksSwitch.click()
      await Promise.resolve()
    })
    expect(saves.at(-1)).toMatchObject({ useStacks: false })

    // Pushed external update reflects live in the pane
    await act(async () => {
      for (const h of pushHandlers) {
        h({ ...currentPrefs, useStacks: true, hiddenRecentPaths: [] })
      }
      await Promise.resolve()
    })
    expect(
      host
        .querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Use stacks"]')!
        .getAttribute('aria-checked'),
    ).toBe('true')
  })
})
