import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_TERMINAL_SURFACE_THEME,
  TERMINAL_SURFACE_THEME_STORAGE_KEY,
  nextTerminalSurfaceTheme,
  readTerminalSurfaceTheme,
  resolveEffectiveTerminalSurface,
  writeTerminalSurfaceTheme,
} from './terminal-surface-theme'

describe('terminal-surface-theme', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('defaults to dark canvas when window or storage is absent or invalid', () => {
    expect(DEFAULT_TERMINAL_SURFACE_THEME).toBe('dark')
    expect(readTerminalSurfaceTheme()).toBe('dark')

    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => 'unexpected',
      },
    })
    expect(readTerminalSurfaceTheme()).toBe('dark')

    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('blocked')
        },
      },
    })
    expect(readTerminalSurfaceTheme()).toBe('dark')
  })

  it('reads, persists, and notifies changes via localStorage and custom events', () => {
    const store = new Map<string, string>()
    const dispatched: Array<{ type: string; detail: unknown }> = []
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, val: string) => {
          store.set(key, val)
        },
      },
      dispatchEvent: (ev: { type: string; detail?: unknown }) => {
        dispatched.push({ type: ev.type, detail: ev.detail })
        return true
      },
    })
    vi.stubGlobal(
      'CustomEvent',
      class MockCustomEvent {
        type: string
        detail: unknown
        constructor(type: string, init?: { detail?: unknown }) {
          this.type = type
          this.detail = init?.detail
        }
      },
    )

    expect(writeTerminalSurfaceTheme('light')).toBe('light')
    expect(store.get(TERMINAL_SURFACE_THEME_STORAGE_KEY)).toBe('light')
    expect(readTerminalSurfaceTheme()).toBe('light')
    expect(dispatched).toEqual([
      { type: 'genoffice-terminal-surface-theme-change', detail: 'light' },
    ])
  })

  it('cycles deterministically across dark -> light -> auto -> dark', () => {
    expect(nextTerminalSurfaceTheme('dark')).toBe('light')
    expect(nextTerminalSurfaceTheme('light')).toBe('auto')
    expect(nextTerminalSurfaceTheme('auto')).toBe('dark')
  })

  it('resolves effective canvas scheme against explicit overrides and host theme', () => {
    expect(resolveEffectiveTerminalSurface('dark', false)).toBe('dark')
    expect(resolveEffectiveTerminalSurface('dark', true)).toBe('dark')
    expect(resolveEffectiveTerminalSurface('light', false)).toBe('light')
    expect(resolveEffectiveTerminalSurface('light', true)).toBe('light')
    expect(resolveEffectiveTerminalSurface('auto', false)).toBe('light')
    expect(resolveEffectiveTerminalSurface('auto', true)).toBe('dark')
  })
})
