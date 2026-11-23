import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractRichCandidateFromPty, readXtermThemeFromElement } from './terminal-pty-theme'

describe('readXtermThemeFromElement', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns an empty theme when element or window.getComputedStyle is unavailable', () => {
    expect(readXtermThemeFromElement(null)).toEqual({})
    expect(readXtermThemeFromElement({} as HTMLElement)).toEqual({})
  })

  it('reads --term-* CSS variables into xterm ITheme properties', () => {
    const vars: Record<string, string> = {
      '--term-bg': ' #16181c ',
      '--term-fg': '#e6edf3',
      '--term-cursor': '#58a6ff',
      '--term-selection': 'rgba(88, 166, 255, 0.28)',
      '--term-ansi-0': '#484f58',
      '--term-ansi-1': '#ff7b72',
      '--term-ansi-15': '#f0f6fc',
    }
    vi.stubGlobal('window', {
      getComputedStyle: () => ({
        getPropertyValue: (name: string) => vars[name] ?? '',
      }),
    })

    const theme = readXtermThemeFromElement({} as HTMLElement)
    expect(theme).toEqual({
      background: '#16181c',
      foreground: '#e6edf3',
      cursor: '#58a6ff',
      selectionBackground: 'rgba(88, 166, 255, 0.28)',
      black: '#484f58',
      red: '#ff7b72',
      brightWhite: '#f0f6fc',
    })
  })
})

describe('extractRichCandidateFromPty', () => {
  it('passes through directly detected HTML or JSON', () => {
    const html = extractRichCandidateFromPty('<div>Hello Rich</div>')
    expect(html.detection.kind).toBe('html')

    const json = extractRichCandidateFromPty('{"ok":true,"count":3}')
    expect(json.detection.kind).toBe('json')
  })

  it('extracts a trailing JSON payload line from mixed shell screen output', () => {
    const mixed = [
      'PS D:\\GitHub\\genoffice> Write-Output \'{"status":"ok","items":[1,2]}\'',
      '{"status":"ok","items":[1,2]}',
      'PS D:\\GitHub\\genoffice>',
    ].join('\n')

    const candidate = extractRichCandidateFromPty(mixed)
    expect(candidate.detection.kind).toBe('json')
    expect(candidate.source).toBe('{"status":"ok","items":[1,2]}')
  })
})
