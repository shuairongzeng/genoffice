import { describe, expect, it } from 'vitest'
import { parseAnsi, stripAnsi } from './terminal-ansi'

describe('stripAnsi', () => {
  it('returns empty string and plain text unchanged', () => {
    expect(stripAnsi('')).toBe('')
    expect(stripAnsi('hello world')).toBe('hello world')
    expect(stripAnsi('line 1\nline 2\n')).toBe('line 1\nline 2\n')
  })

  it('strips CSI, OSC, DCS, and single ESC sequences cleanly', () => {
    expect(stripAnsi('\x1b[31merror:\x1b[0m failed')).toBe('error: failed')
    expect(stripAnsi('\x1b[2J\x1b[H\x1b[?25lprompt\x1b[?25h\x1b[K')).toBe('prompt')
    expect(stripAnsi('\x1b]0;GenOffice Terminal\x07ready')).toBe('ready')
    expect(stripAnsi('\x1b]8;;https://example.com\x1b\\open link\x1b]8;;\x1b\\')).toBe('open link')
    expect(stripAnsi('\x1b(B\x1b[1;32mOK\x1b[0m\x1b=')).toBe('OK')
    expect(stripAnsi('\x1bP1$r0m\x1b\\after-dcs')).toBe('after-dcs')
  })

  it('normalizes CRLF and resolves inline CR progress bar overwrites', () => {
    expect(stripAnsi('line1\r\nline2\r\n')).toBe('line1\nline2\n')
    expect(stripAnsi('line1\r\r\nline2')).toBe('line1\nline2')
    expect(stripAnsi('Downloading 10%\rDownloading 50%\rDownloading 100%')).toBe('Downloading 100%')
    expect(stripAnsi('Long progress message...\rDone!')).toBe('Done!')
    expect(stripAnsi('In progress...\r')).toBe('In progress...')
    expect(stripAnsi('Spinner...\r\x1b[K')).toBe('')
    expect(stripAnsi('Step 1\n10%\r50%\r100%\nStep 2')).toBe('Step 1\n100%\nStep 2')
  })

  it('preserves UTF-8 CJK and emoji characters alongside escape codes', () => {
    expect(stripAnsi('\x1b[36mBuilding\x1b[0m 🚀 \x1b[32m测试报告.docx\x1b[0m')).toBe(
      'Building 🚀 测试报告.docx',
    )
  })
})

describe('parseAnsi', () => {
  it('returns empty array for empty input or escape-only input', () => {
    expect(parseAnsi('')).toEqual([])
    expect(parseAnsi('\x1b[31m\x1b[0m\x1b]0;title\x07')).toEqual([])
  })

  it('maps standard 0..15 ANSI fg/bg colors to CSS custom properties', () => {
    expect(parseAnsi('\x1b[31mred\x1b[0m')).toEqual([{ text: 'red', fg: 'var(--term-ansi-1)' }])
    expect(parseAnsi('\x1b[92mbright-green\x1b[39m')).toEqual([
      { text: 'bright-green', fg: 'var(--term-ansi-10)' },
    ])
    expect(parseAnsi('\x1b[44;103mbg-test\x1b[49mplain')).toEqual([
      { text: 'bg-test', bg: 'var(--term-ansi-11)' },
      { text: 'plain' },
    ])

    // All 16 standard foreground and background codes.
    for (let i = 0; i < 8; i++) {
      expect(parseAnsi(`\x1b[${30 + i};${40 + i}mx`)).toEqual([
        { text: 'x', fg: `var(--term-ansi-${i})`, bg: `var(--term-ansi-${i})` },
      ])
      expect(parseAnsi(`\x1b[${90 + i};${100 + i}mx`)).toEqual([
        { text: 'x', fg: `var(--term-ansi-${i + 8})`, bg: `var(--term-ansi-${i + 8})` },
      ])
    }
  })

  it('parses text style flags and SGR off codes including 22 resetting bold and dim', () => {
    const input = '\x1b[1;2;3;4;9mall\x1b[22mno-weight\x1b[23mno-italic\x1b[24mno-ul\x1b[29mplain'
    expect(parseAnsi(input)).toEqual([
      {
        text: 'all',
        bold: true,
        dim: true,
        italic: true,
        underline: true,
        strike: true,
      },
      {
        text: 'no-weight',
        italic: true,
        underline: true,
        strike: true,
      },
      {
        text: 'no-italic',
        underline: true,
        strike: true,
      },
      {
        text: 'no-ul',
        strike: true,
      },
      {
        text: 'plain',
      },
    ])
  })

  it('handles inverse (7) and inverse-off (27) cleanly', () => {
    expect(parseAnsi('\x1b[31;42;7minv\x1b[27mnorm\x1b[0m')).toEqual([
      { text: 'inv', fg: 'var(--term-ansi-2)', bg: 'var(--term-ansi-1)' },
      { text: 'norm', fg: 'var(--term-ansi-1)', bg: 'var(--term-ansi-2)' },
    ])

    const defaultInv = parseAnsi('\x1b[7mhi\x1b[27mbye')
    expect(defaultInv).toHaveLength(2)
    expect(defaultInv[0].text).toBe('hi')
    expect(defaultInv[0].fg).toBeDefined()
    expect(defaultInv[0].bg).toBeDefined()
    expect(defaultInv[0].fg).not.toBe(defaultInv[0].bg)
    expect(defaultInv[1]).toEqual({ text: 'bye' })
  })

  it('handles 256-color palette (0..15 vars, 16..231 cube, 232..255 grayscale) and truecolor', () => {
    expect(parseAnsi('\x1b[38;5;9mstd9\x1b[0m')).toEqual([
      { text: 'std9', fg: 'var(--term-ansi-9)' },
    ])
    expect(parseAnsi('\x1b[38;5;16mcube0\x1b[38;5;196mcubeRed\x1b[38;5;231mcubeWhite')).toEqual([
      { text: 'cube0', fg: 'rgb(0, 0, 0)' },
      { text: 'cubeRed', fg: 'rgb(255, 0, 0)' },
      { text: 'cubeWhite', fg: 'rgb(255, 255, 255)' },
    ])
    expect(parseAnsi('\x1b[48;5;232mg0\x1b[48;5;255mg23')).toEqual([
      { text: 'g0', bg: 'rgb(8, 8, 8)' },
      { text: 'g23', bg: 'rgb(238, 238, 238)' },
    ])
    expect(parseAnsi('\x1b[38;2;12;34;56;48;2;300;0;128mtc\x1b[0m')).toEqual([
      { text: 'tc', fg: 'rgb(12, 34, 56)', bg: 'rgb(255, 0, 128)' },
    ])
    // Colon-separated ITU T.416 extended color subparameters.
    expect(parseAnsi('\x1b[38:2::10:20:30;48:5:21mcolon\x1b[0m')).toEqual([
      { text: 'colon', fg: 'rgb(10, 20, 30)', bg: 'rgb(0, 0, 255)' },
    ])
    // Out-of-range palette index and truncated extended color parameters do not throw.
    expect(parseAnsi('\x1b[38;5;999m\x1b[38;5m\x1b[38;2;10;20msafe')).toEqual([{ text: 'safe' }])
  })

  it('coalesces adjacent spans with identical styles and handles implicit reset', () => {
    expect(parseAnsi('\x1b[31ma\x1b[31mb\x1b[mc')).toEqual([
      { text: 'ab', fg: 'var(--term-ansi-1)' },
      { text: 'c' },
    ])
    expect(parseAnsi('\x1b[1mfoo\x1b[22mbar')).toEqual([
      { text: 'foo', bold: true },
      { text: 'bar' },
    ])
    expect(parseAnsi('\x1b[32mline1\r\nline2\x1b[0m')).toEqual([
      { text: 'line1\nline2', fg: 'var(--term-ansi-2)' },
    ])
  })

  it('handles CR overwrites identically to stripAnsi and preserves SGR state across CR', () => {
    expect(parseAnsi('\x1b[33m10%\x1b[0m\r\x1b[32m100%\x1b[0m')).toEqual([
      { text: '100%', fg: 'var(--term-ansi-2)' },
    ])
    expect(parseAnsi('\x1b[32m10%\r100%\x1b[0m')).toEqual([
      { text: '100%', fg: 'var(--term-ansi-2)' },
    ])
    expect(parseAnsi('old\r\x1b[K\x1b[36mnew')).toEqual([{ text: 'new', fg: 'var(--term-ansi-6)' }])

    const samples = [
      '',
      'plain text\r\nsecond line',
      '\x1b[31mDownloading 20%\x1b[0m\r\x1b[32mComplete!\x1b[0m\nNext',
      'a\r\rb\r\n\x1b]0;Title\x07c\x1b[34md\x1b[0m',
      'spinner\r\x1b[K',
      'trailing\r',
    ]
    for (const sample of samples) {
      expect(
        parseAnsi(sample)
          .map((s) => s.text)
          .join(''),
      ).toBe(stripAnsi(sample))
    }
  })
})
