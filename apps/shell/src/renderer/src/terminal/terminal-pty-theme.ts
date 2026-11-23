import type { ITheme } from '@xterm/xterm'
import { detectRichOutput, type RichOutputDetection } from './terminal-rich-detect'

type XtermStringColorKey =
  | 'background'
  | 'foreground'
  | 'cursor'
  | 'selectionBackground'
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'brightBlack'
  | 'brightRed'
  | 'brightGreen'
  | 'brightYellow'
  | 'brightBlue'
  | 'brightMagenta'
  | 'brightCyan'
  | 'brightWhite'

const THEME_VAR_MAP: ReadonlyArray<readonly [cssVar: string, themeKey: XtermStringColorKey]> = [
  ['--term-bg', 'background'],
  ['--term-fg', 'foreground'],
  ['--term-cursor', 'cursor'],
  ['--term-selection', 'selectionBackground'],
  ['--term-ansi-0', 'black'],
  ['--term-ansi-1', 'red'],
  ['--term-ansi-2', 'green'],
  ['--term-ansi-3', 'yellow'],
  ['--term-ansi-4', 'blue'],
  ['--term-ansi-5', 'magenta'],
  ['--term-ansi-6', 'cyan'],
  ['--term-ansi-7', 'white'],
  ['--term-ansi-8', 'brightBlack'],
  ['--term-ansi-9', 'brightRed'],
  ['--term-ansi-10', 'brightGreen'],
  ['--term-ansi-11', 'brightYellow'],
  ['--term-ansi-12', 'brightBlue'],
  ['--term-ansi-13', 'brightMagenta'],
  ['--term-ansi-14', 'brightCyan'],
  ['--term-ansi-15', 'brightWhite'],
]

/**
 * Read active `--term-*` design tokens from a mounted DOM element and map them
 * to an `@xterm/xterm` theme object without hardcoding raw hex literals in TS/CSS.
 */
export function readXtermThemeFromElement(el: HTMLElement | null): ITheme {
  if (!el || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
    return {}
  }

  const styles = window.getComputedStyle(el)
  const theme: ITheme = {}

  for (const [cssVar, themeKey] of THEME_VAR_MAP) {
    const val = styles.getPropertyValue(cssVar).trim()
    if (val) {
      theme[themeKey] = val
    }
  }

  return theme
}

export interface PtySearchDecorations {
  matchBackground: string
  matchBorder: string
  matchOverviewRuler: string
  activeMatchBackground: string
  activeMatchBorder: string
  activeMatchColorOverviewRuler: string
}

/**
 * Read active `--term-search-*` #RRGGBB tokens so `@xterm/addon-search` enables
 * full match-count reporting and theme-adaptive highlights without hardcoded colors.
 */
export function readSearchDecorationsFromElement(
  el: HTMLElement | null,
): PtySearchDecorations | undefined {
  if (!el || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
    return undefined
  }
  const styles = window.getComputedStyle(el)
  const matchBg = styles.getPropertyValue('--term-search-match').trim()
  const activeBg = styles.getPropertyValue('--term-search-active').trim()
  const matchRuler = styles.getPropertyValue('--term-search-ruler').trim()
  const activeRuler = styles.getPropertyValue('--term-search-active-ruler').trim()
  if (!matchBg || !activeBg || !matchRuler || !activeRuler) {
    return undefined
  }
  return {
    matchBackground: matchBg,
    matchBorder: matchRuler,
    matchOverviewRuler: matchRuler,
    activeMatchBackground: activeBg,
    activeMatchBorder: activeRuler,
    activeMatchColorOverviewRuler: activeRuler,
  }
}

export interface PtyRichCandidate {
  source: string
  detection: RichOutputDetection
}

/**
 * Classify captured PTY text for the rich preview overlay.
 * When a full-screen snapshot includes shell prompt lines around a JSON payload line,
 * extract the last standalone JSON line if full-text detection fell back to `plain`.
 */
export function extractRichCandidateFromPty(rawText: string): PtyRichCandidate {
  const direct = detectRichOutput(rawText)
  if (direct.kind !== 'plain') {
    return { source: rawText, detection: direct }
  }

  const lines = rawText.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const candidate = lines[i]!.trim()
    if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue
    const lineDetection = detectRichOutput(candidate)
    if (lineDetection.kind === 'json') {
      return { source: candidate, detection: lineDetection }
    }
  }

  return { source: rawText, detection: direct }
}
