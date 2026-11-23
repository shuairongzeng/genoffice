import { useCallback, useEffect, useState } from 'react'
import type { TerminalColorScheme } from '../../../shared/terminal-api'
import { useDarkTheme } from './TerminalRichOutput'

export type TerminalSurfaceThemeMode = 'dark' | 'light' | 'auto'

export const TERMINAL_SURFACE_THEME_STORAGE_KEY = 'genoffice.terminal.surfaceTheme'
export const DEFAULT_TERMINAL_SURFACE_THEME: TerminalSurfaceThemeMode = 'dark'

const SURFACE_THEME_EVENT = 'genoffice-terminal-surface-theme-change'
const SURFACE_THEME_CYCLE: readonly TerminalSurfaceThemeMode[] = ['dark', 'light', 'auto']

function normalizeSurfaceTheme(raw: unknown): TerminalSurfaceThemeMode {
  if (raw === 'dark' || raw === 'light' || raw === 'auto') {
    return raw
  }
  return DEFAULT_TERMINAL_SURFACE_THEME
}

/**
 * Read persisted terminal canvas theme preference, defaulting to `'dark'`.
 */
export function readTerminalSurfaceTheme(): TerminalSurfaceThemeMode {
  if (typeof window === 'undefined') return DEFAULT_TERMINAL_SURFACE_THEME
  try {
    return normalizeSurfaceTheme(window.localStorage.getItem(TERMINAL_SURFACE_THEME_STORAGE_KEY))
  } catch {
    return DEFAULT_TERMINAL_SURFACE_THEME
  }
}

/**
 * Persist terminal canvas theme preference and broadcast change to same-window listeners.
 */
export function writeTerminalSurfaceTheme(
  mode: TerminalSurfaceThemeMode,
): TerminalSurfaceThemeMode {
  const normalized = normalizeSurfaceTheme(mode)
  if (typeof window === 'undefined') return normalized
  try {
    window.localStorage.setItem(TERMINAL_SURFACE_THEME_STORAGE_KEY, normalized)
  } catch {
    // Ignore storage quota or private browsing errors.
  }
  try {
    window.dispatchEvent(
      new CustomEvent<TerminalSurfaceThemeMode>(SURFACE_THEME_EVENT, { detail: normalized }),
    )
  } catch {
    // Ignore synthetic DOM environments without CustomEvent constructor.
  }
  return normalized
}

/**
 * Cycle terminal canvas theme across `dark -> light -> auto -> dark`.
 */
export function nextTerminalSurfaceTheme(
  current: TerminalSurfaceThemeMode,
): TerminalSurfaceThemeMode {
  const idx = SURFACE_THEME_CYCLE.indexOf(current)
  if (idx < 0) return DEFAULT_TERMINAL_SURFACE_THEME
  return SURFACE_THEME_CYCLE[(idx + 1) % SURFACE_THEME_CYCLE.length]!
}

/**
 * Resolve effective PTY canvas palette (`dark` or `light`) from explicit override or host theme.
 */
export function resolveEffectiveTerminalSurface(
  mode: TerminalSurfaceThemeMode,
  appIsDark: boolean,
): TerminalColorScheme {
  if (mode === 'dark' || mode === 'light') return mode
  return appIsDark ? 'dark' : 'light'
}

export interface UseTerminalSurfaceThemeResult {
  surfaceTheme: TerminalSurfaceThemeMode
  effectiveSurface: TerminalColorScheme
  setSurfaceTheme: (mode: TerminalSurfaceThemeMode) => void
  cycleSurfaceTheme: () => void
}

/**
 * Shared terminal canvas theme state synced across the bottom drawer, standalone tab view,
 * and every mounted PTY pane via localStorage and custom window events.
 */
export function useTerminalSurfaceTheme(): UseTerminalSurfaceThemeResult {
  const appIsDark = useDarkTheme()
  const [surfaceTheme, setSurfaceThemeState] = useState<TerminalSurfaceThemeMode>(() =>
    readTerminalSurfaceTheme(),
  )

  useEffect(() => {
    const handleCustom = (ev: Event): void => {
      const detail = (ev as CustomEvent<TerminalSurfaceThemeMode>).detail
      setSurfaceThemeState(normalizeSurfaceTheme(detail))
    }
    const handleStorage = (ev: StorageEvent): void => {
      if (ev.key === TERMINAL_SURFACE_THEME_STORAGE_KEY) {
        setSurfaceThemeState(normalizeSurfaceTheme(ev.newValue))
      }
    }
    window.addEventListener(SURFACE_THEME_EVENT, handleCustom)
    window.addEventListener('storage', handleStorage)
    return () => {
      window.removeEventListener(SURFACE_THEME_EVENT, handleCustom)
      window.removeEventListener('storage', handleStorage)
    }
  }, [])

  const setSurfaceTheme = useCallback((mode: TerminalSurfaceThemeMode) => {
    const normalized = writeTerminalSurfaceTheme(mode)
    setSurfaceThemeState(normalized)
  }, [])

  const cycleSurfaceTheme = useCallback(() => {
    setSurfaceThemeState((prev) => {
      const next = nextTerminalSurfaceTheme(prev)
      writeTerminalSurfaceTheme(next)
      return next
    })
  }, [])

  return {
    surfaceTheme,
    effectiveSurface: resolveEffectiveTerminalSurface(surfaceTheme, appIsDark),
    setSurfaceTheme,
    cycleSurfaceTheme,
  }
}
