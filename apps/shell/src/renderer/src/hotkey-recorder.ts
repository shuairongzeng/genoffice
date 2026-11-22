/**
 * Keyboard shortcut recording and Electron accelerator formatting helpers shared
 * by the AI Butler settings pane.
 */

export function hotkeyPresets(isMac: boolean): readonly string[] {
  return isMac ? ['Alt+Space', 'Ctrl+Alt+Space', 'Alt+J'] : ['Ctrl+Alt+Space', 'Alt+Space', 'Alt+J']
}

export type KeyEventLike = {
  readonly code: string
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
  readonly metaKey: boolean
}

const CODE_TO_KEY: Record<string, string> = {
  Space: 'Space',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
}

function keyFromCode(code: string): string | null {
  if (Object.hasOwn(CODE_TO_KEY, code)) {
    return CODE_TO_KEY[code]!
  }
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1]!
  const digit = /^Digit([0-9])$/.exec(code)
  if (digit) return digit[1]!
  const fnKey = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code)
  if (fnKey) return `F${fnKey[1]!}`
  return null
}

/**
 * Convert a keyboard event into an Electron accelerator string, or `null` if
 * the event has no modifier keys or targets an unsupported/modifier-only key.
 */
export function acceleratorFromKeyEvent(e: KeyEventLike, isMac: boolean): string | null {
  if (!e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
    return null
  }
  const key = keyFromCode(e.code)
  if (!key) return null

  const mods: string[] = []
  if (e.ctrlKey) mods.push('Ctrl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push(isMac ? 'Command' : 'Super')
  return `${mods.join('+')}+${key}`
}

const KEY_DISPLAY_NAMES: Record<string, string> = {
  space: 'Space',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
}

function formatPart(part: string, isMac: boolean): string {
  const lower = part.toLowerCase()
  if (isMac) {
    if (
      lower === 'command' ||
      lower === 'cmd' ||
      lower === 'commandorcontrol' ||
      lower === 'cmdorctrl' ||
      lower === 'meta' ||
      lower === 'super'
    ) {
      return '⌘'
    }
    if (lower === 'alt' || lower === 'option') return '⌥'
    if (lower === 'shift') return '⇧'
    if (lower === 'control' || lower === 'ctrl') return '⌃'
  } else {
    if (
      lower === 'commandorcontrol' ||
      lower === 'cmdorctrl' ||
      lower === 'control' ||
      lower === 'ctrl'
    ) {
      return 'Ctrl'
    }
    if (lower === 'alt' || lower === 'option') return 'Alt'
    if (lower === 'shift') return 'Shift'
    if (lower === 'super' || lower === 'meta') return 'Super'
    if (lower === 'command' || lower === 'cmd') return 'Command'
  }

  if (Object.hasOwn(KEY_DISPLAY_NAMES, lower)) {
    return KEY_DISPLAY_NAMES[lower]!
  }
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) {
    return lower.toUpperCase()
  }
  if (part.length === 1) {
    return part.toUpperCase()
  }
  return part
}

/**
 * Split an Electron accelerator into display keycaps matching HUD rules
 * (`⌘/⌥/⇧/⌃` on macOS, `Ctrl/Alt/Shift` elsewhere).
 */
export function formatHotkeyParts(accelerator: string, isMac: boolean): string[] {
  const trimmed = accelerator.trim()
  if (!trimmed) return []

  const rawParts = trimmed
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  return rawParts.map((part) => formatPart(part, isMac))
}
