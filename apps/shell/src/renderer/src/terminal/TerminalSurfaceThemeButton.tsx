import type { ReactElement } from 'react'
import { useI18n } from '../locale'
import type { TerminalSurfaceThemeMode } from './terminal-surface-theme'

export interface TerminalSurfaceThemeButtonProps {
  surfaceTheme: TerminalSurfaceThemeMode
  onCycle: () => void
}

/**
 * Shared toolbar button cycling terminal canvas colors across dark, light, and host-matched modes.
 */
export function TerminalSurfaceThemeButton({
  surfaceTheme,
  onCycle,
}: TerminalSurfaceThemeButtonProps): ReactElement {
  const { t } = useI18n()

  const label =
    surfaceTheme === 'dark'
      ? t('termCanvasDark')
      : surfaceTheme === 'light'
        ? t('termCanvasLight')
        : t('termCanvasAuto')

  return (
    <button
      type="button"
      className="term-action-btn"
      data-testid="terminal-surface-theme-btn"
      data-surface-theme={surfaceTheme}
      title={t('termCanvasThemeTitle')}
      aria-label={`${t('termCanvasThemeTitle')}: ${label}`}
      onClick={onCycle}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        {surfaceTheme === 'dark' && (
          <path
            d="M12.6 9.8A5 5 0 0 1 6.2 3.4a5.2 5.2 0 1 0 6.4 6.4Z"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinejoin="round"
          />
        )}
        {surfaceTheme === 'light' && (
          <>
            <circle cx="8" cy="8" r="2.7" stroke="currentColor" strokeWidth="1.25" />
            <path
              d="M8 2.2v1.3M8 12.5v1.3M2.2 8h1.3M12.5 8h1.3M3.9 3.9l.9.9M11.2 11.2l.9.9M12.1 3.9l-.9.9M4.8 11.2l-.9.9"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          </>
        )}
        {surfaceTheme === 'auto' && (
          <>
            <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="1.25" />
            <path d="M8 3a5 5 0 0 0 0 10V3Z" fill="currentColor" />
          </>
        )}
      </svg>
      <span>{label}</span>
    </button>
  )
}
