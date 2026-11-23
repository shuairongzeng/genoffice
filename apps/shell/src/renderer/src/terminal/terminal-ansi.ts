/**
 * ANSI SGR / CSI / OSC parser and stripper for terminal block output.
 */

export interface AnsiSpan {
  text: string
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
}

interface SgrState {
  fg?: string
  bg?: string
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  inverse: boolean
}

const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)

// Matches CSI, OSC, DCS/SOS/PM/APC, single/intermediate ESC sequences, CR, and LF.
const ANSI_TOKEN_RE = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]` +
    `|${ESC}\\](?:[^${BEL}${ESC}]|${ESC}(?!\\\\))*(?:${BEL}|${ESC}\\\\)` +
    `|${ESC}[PX^_](?:[^${BEL}${ESC}]|${ESC}(?!\\\\))*(?:${BEL}|${ESC}\\\\)` +
    `|${ESC}(?:[ -/]+[0-~]|[0-OQRSTUVWYZ\\\\\`a-z{|}~])` +
    `|\\r|\\n`,
  'g',
)

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const

function createDefaultState(): SgrState {
  return {
    fg: undefined,
    bg: undefined,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    strike: false,
    inverse: false,
  }
}

function clampByte(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n <= 0) return 0
  if (n >= 255) return 255
  return Math.round(n)
}

function xterm256ToCss(index: number): string | undefined {
  if (!Number.isFinite(index)) return undefined
  const idx = Math.trunc(index)
  if (idx < 0 || idx > 255) return undefined
  if (idx <= 15) return `var(--term-ansi-${idx})`
  if (idx <= 231) {
    const offset = idx - 16
    const r = CUBE_LEVELS[Math.floor(offset / 36)]
    const g = CUBE_LEVELS[Math.floor((offset % 36) / 6)]
    const b = CUBE_LEVELS[offset % 6]
    return `rgb(${r}, ${g}, ${b})`
  }
  const gray = 8 + (idx - 232) * 10
  return `rgb(${gray}, ${gray}, ${gray})`
}

function applyExtendedColor(
  state: SgrState,
  target: 'fg' | 'bg',
  parts: number[],
  index: number,
): number {
  const mode = parts[index + 1]
  if (mode === 5) {
    if (index + 2 < parts.length) {
      const color = xterm256ToCss(parts[index + 2])
      if (color) state[target] = color
      return 2
    }
    return 1
  }
  if (mode === 2) {
    if (index + 4 < parts.length) {
      const r = clampByte(parts[index + 2])
      const g = clampByte(parts[index + 3])
      const b = clampByte(parts[index + 4])
      state[target] = `rgb(${r}, ${g}, ${b})`
      return 4
    }
    return 1
  }
  return 0
}

function applyColonSubparams(state: SgrState, rawToken: string): void {
  const nums = rawToken.split(':').map((part) => (part === '' ? Number.NaN : Number(part)))
  const code = nums[0]
  if (code !== 38 && code !== 48) return
  const target: 'fg' | 'bg' = code === 38 ? 'fg' : 'bg'
  const mode = nums[1]
  if (mode === 5 && Number.isFinite(nums[2])) {
    const color = xterm256ToCss(nums[2])
    if (color) state[target] = color
  } else if (mode === 2) {
    // Support both 38:2:r:g:b and ITU T.416 38:2:colorspace:r:g:b forms.
    const offset = nums.length >= 6 ? 3 : 2
    if (
      Number.isFinite(nums[offset]) &&
      Number.isFinite(nums[offset + 1]) &&
      Number.isFinite(nums[offset + 2])
    ) {
      const r = clampByte(nums[offset])
      const g = clampByte(nums[offset + 1])
      const b = clampByte(nums[offset + 2])
      state[target] = `rgb(${r}, ${g}, ${b})`
    }
  }
}

function applySgrSequence(state: SgrState, seq: string): void {
  const body = seq.slice(2, -1)
  if (body.length === 0) {
    Object.assign(state, createDefaultState())
    return
  }

  // Reject private-parameter SGR-like sequences such as CSI >4;2m or CSI ?4m.
  if (!/^[0-9;:]*$/.test(body)) return

  const rawTokens = body.split(';')
  // If any token uses colon subparameters, process sequentially while preserving
  // index stepping for standard semicolon-delimited extended colors.
  const numericParams: number[] = []
  let hasColon = false
  for (const tok of rawTokens) {
    if (tok.includes(':')) {
      hasColon = true
      break
    }
    numericParams.push(tok === '' ? 0 : Number(tok))
  }

  if (hasColon) {
    for (let i = 0; i < rawTokens.length; i++) {
      const tok = rawTokens[i]
      if (tok.includes(':')) {
        applyColonSubparams(state, tok)
        continue
      }
      const n = tok === '' ? 0 : Number(tok)
      i += applySingleSgrCode(state, n, rawTokens, i)
    }
    return
  }

  for (let i = 0; i < numericParams.length; i++) {
    const code = numericParams[i]
    if (code === 38) {
      i += applyExtendedColor(state, 'fg', numericParams, i)
    } else if (code === 48) {
      i += applyExtendedColor(state, 'bg', numericParams, i)
    } else {
      applyBasicSgrCode(state, code)
    }
  }
}

function applySingleSgrCode(
  state: SgrState,
  code: number,
  rawTokens: string[],
  index: number,
): number {
  if (code === 38 || code === 48) {
    const target: 'fg' | 'bg' = code === 38 ? 'fg' : 'bg'
    const nextNums = rawTokens
      .slice(index)
      .map((t) => (t === '' || t.includes(':') ? Number.NaN : Number(t)))
    return applyExtendedColor(state, target, nextNums, 0)
  }
  applyBasicSgrCode(state, code)
  return 0
}

function applyBasicSgrCode(state: SgrState, code: number): void {
  if (code === 0) {
    Object.assign(state, createDefaultState())
  } else if (code === 1) {
    state.bold = true
  } else if (code === 2) {
    state.dim = true
  } else if (code === 3) {
    state.italic = true
  } else if (code === 4) {
    state.underline = true
  } else if (code === 7) {
    state.inverse = true
  } else if (code === 9) {
    state.strike = true
  } else if (code === 22) {
    state.bold = false
    state.dim = false
  } else if (code === 23) {
    state.italic = false
  } else if (code === 24) {
    state.underline = false
  } else if (code === 27) {
    state.inverse = false
  } else if (code === 29) {
    state.strike = false
  } else if (code >= 30 && code <= 37) {
    state.fg = `var(--term-ansi-${code - 30})`
  } else if (code === 39) {
    state.fg = undefined
  } else if (code >= 40 && code <= 47) {
    state.bg = `var(--term-ansi-${code - 40})`
  } else if (code === 49) {
    state.bg = undefined
  } else if (code >= 90 && code <= 97) {
    state.fg = `var(--term-ansi-${code - 90 + 8})`
  } else if (code >= 100 && code <= 107) {
    state.bg = `var(--term-ansi-${code - 100 + 8})`
  }
}

function buildSpan(text: string, state: SgrState): AnsiSpan {
  let fg = state.fg
  let bg = state.bg
  if (state.inverse) {
    const origFg = fg ?? 'var(--term-fg, var(--text))'
    const origBg = bg ?? 'var(--term-bg, var(--surface))'
    fg = origBg
    bg = origFg
  }

  const span: AnsiSpan = { text }
  if (fg) span.fg = fg
  if (bg) span.bg = bg
  if (state.bold) span.bold = true
  if (state.dim) span.dim = true
  if (state.italic) span.italic = true
  if (state.underline) span.underline = true
  if (state.strike) span.strike = true
  return span
}

function sameSpanStyle(a: AnsiSpan, b: AnsiSpan): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strike === b.strike
  )
}

function pushSpan(target: AnsiSpan[], span: AnsiSpan): void {
  if (!span.text) return
  const prev = target[target.length - 1]
  if (prev && sameSpanStyle(prev, span)) {
    prev.text += span.text
    return
  }
  target.push(span)
}

function isLineEraseCsi(seq: string): boolean {
  return seq === `${ESC}[K` || seq === `${ESC}[0K` || seq === `${ESC}[2K`
}

/**
 * Strip CSI, OSC, and single ESC sequences while normalizing CRLF to LF and
 * resolving inline CR progress overwrites identically to parseAnsi.
 */
export function stripAnsi(input: string): string {
  if (!input) return ''

  ANSI_TOKEN_RE.lastIndex = 0
  const committed: string[] = []
  let currentLine: string[] = []
  let pendingCr = false
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = ANSI_TOKEN_RE.exec(input)) !== null) {
    if (match.index > lastIndex) {
      const text = input.slice(lastIndex, match.index)
      if (pendingCr) {
        currentLine = []
        pendingCr = false
      }
      currentLine.push(text)
    }

    const token = match[0]
    if (token === '\r') {
      pendingCr = true
    } else if (token === '\n') {
      pendingCr = false
      if (currentLine.length > 0) {
        committed.push(currentLine.join(''))
        currentLine = []
      }
      committed.push('\n')
    } else if (pendingCr && isLineEraseCsi(token)) {
      currentLine = []
      pendingCr = false
    }

    lastIndex = ANSI_TOKEN_RE.lastIndex
  }

  if (lastIndex < input.length) {
    const tail = input.slice(lastIndex)
    if (pendingCr) {
      currentLine = []
    }
    currentLine.push(tail)
  }

  if (currentLine.length > 0) {
    committed.push(currentLine.join(''))
  }

  return committed.join('')
}

/**
 * Parse ANSI SGR escape sequences into styled text spans, resolving CRLF and
 * inline CR overwrites identically to stripAnsi and coalescing adjacent spans
 * that share identical styling.
 */
export function parseAnsi(input: string): AnsiSpan[] {
  if (!input) return []

  ANSI_TOKEN_RE.lastIndex = 0
  const state = createDefaultState()
  const committed: AnsiSpan[] = []
  let currentLine: AnsiSpan[] = []
  let pendingCr = false
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = ANSI_TOKEN_RE.exec(input)) !== null) {
    if (match.index > lastIndex) {
      const text = input.slice(lastIndex, match.index)
      if (pendingCr) {
        currentLine = []
        pendingCr = false
      }
      pushSpan(currentLine, buildSpan(text, state))
    }

    const token = match[0]
    if (token === '\r') {
      pendingCr = true
    } else if (token === '\n') {
      pendingCr = false
      for (const span of currentLine) {
        pushSpan(committed, span)
      }
      currentLine = []
      pushSpan(committed, buildSpan('\n', state))
    } else if (pendingCr && isLineEraseCsi(token)) {
      currentLine = []
      pendingCr = false
    } else if (token.startsWith(`${ESC}[`) && token.endsWith('m')) {
      applySgrSequence(state, token)
    }

    lastIndex = ANSI_TOKEN_RE.lastIndex
  }

  if (lastIndex < input.length) {
    const tail = input.slice(lastIndex)
    if (pendingCr) {
      currentLine = []
    }
    pushSpan(currentLine, buildSpan(tail, state))
  }

  for (const span of currentLine) {
    pushSpan(committed, span)
  }

  return committed
}
