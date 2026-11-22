import { describe, expect, it } from 'vitest'
import {
  acceleratorFromKeyEvent,
  formatHotkeyParts,
  hotkeyPresets,
  type KeyEventLike,
} from '../src/renderer/src/hotkey-recorder'

function keyEvent(overrides: Partial<KeyEventLike> & { code: string }): KeyEventLike {
  return {
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...overrides,
  }
}

describe('hotkeyPresets', () => {
  it('returns platform-tuned one-handed presets for macOS and non-macOS', () => {
    expect(hotkeyPresets(true)).toEqual(['Alt+Space', 'Ctrl+Alt+Space', 'Alt+J'])
    expect(hotkeyPresets(false)).toEqual(['Ctrl+Alt+Space', 'Alt+Space', 'Alt+J'])
  })
})

describe('acceleratorFromKeyEvent', () => {
  it('maps Space, letters A-Z, digits 0-9, and F1-F24', () => {
    expect(acceleratorFromKeyEvent(keyEvent({ code: 'Space', altKey: true }), false)).toBe(
      'Alt+Space',
    )

    for (let i = 0; i < 26; i++) {
      const letter = String.fromCharCode(65 + i)
      expect(
        acceleratorFromKeyEvent(keyEvent({ code: `Key${letter}`, ctrlKey: true }), false),
      ).toBe(`Ctrl+${letter}`)
    }

    for (let d = 0; d <= 9; d++) {
      expect(acceleratorFromKeyEvent(keyEvent({ code: `Digit${d}`, altKey: true }), false)).toBe(
        `Alt+${d}`,
      )
    }

    for (let f = 1; f <= 24; f++) {
      expect(acceleratorFromKeyEvent(keyEvent({ code: `F${f}`, shiftKey: true }), false)).toBe(
        `Shift+F${f}`,
      )
    }

    expect(acceleratorFromKeyEvent(keyEvent({ code: 'F0', ctrlKey: true }), false)).toBeNull()
    expect(acceleratorFromKeyEvent(keyEvent({ code: 'F25', ctrlKey: true }), false)).toBeNull()
  })

  it('maps punctuation and arrow keys', () => {
    const cases: Array<[string, string]> = [
      ['Backquote', '`'],
      ['Minus', '-'],
      ['Equal', '='],
      ['BracketLeft', '['],
      ['BracketRight', ']'],
      ['Semicolon', ';'],
      ['Quote', "'"],
      ['Comma', ','],
      ['Period', '.'],
      ['Slash', '/'],
      ['Backslash', '\\'],
      ['ArrowUp', 'Up'],
      ['ArrowDown', 'Down'],
      ['ArrowLeft', 'Left'],
      ['ArrowRight', 'Right'],
    ]

    for (const [code, expected] of cases) {
      expect(acceleratorFromKeyEvent(keyEvent({ code, ctrlKey: true }), false)).toBe(
        `Ctrl+${expected}`,
      )
    }
  })

  it('orders modifiers as Ctrl, Alt, Shift, Command/Super depending on platform', () => {
    const allMods = keyEvent({
      code: 'Space',
      ctrlKey: true,
      altKey: true,
      shiftKey: true,
      metaKey: true,
    })

    expect(acceleratorFromKeyEvent(allMods, true)).toBe('Ctrl+Alt+Shift+Command+Space')
    expect(acceleratorFromKeyEvent(allMods, false)).toBe('Ctrl+Alt+Shift+Super+Space')
    expect(acceleratorFromKeyEvent(keyEvent({ code: 'KeyK', metaKey: true }), true)).toBe(
      'Command+K',
    )
    expect(acceleratorFromKeyEvent(keyEvent({ code: 'KeyK', metaKey: true }), false)).toBe(
      'Super+K',
    )
  })

  it('returns null when no modifier is held, for modifier-only keys, or for unsupported keys', () => {
    expect(acceleratorFromKeyEvent(keyEvent({ code: 'Space' }), false)).toBeNull()
    expect(acceleratorFromKeyEvent(keyEvent({ code: 'KeyA' }), true)).toBeNull()
    expect(acceleratorFromKeyEvent(keyEvent({ code: 'F5' }), false)).toBeNull()

    for (const modCode of [
      'ControlLeft',
      'ControlRight',
      'AltLeft',
      'AltRight',
      'ShiftLeft',
      'ShiftRight',
      'MetaLeft',
      'MetaRight',
    ]) {
      expect(
        acceleratorFromKeyEvent(
          keyEvent({ code: modCode, ctrlKey: true, altKey: true, shiftKey: true, metaKey: true }),
          true,
        ),
      ).toBeNull()
    }

    for (const unsupported of ['Enter', 'Tab', 'Escape', 'Backspace', 'CapsLock', 'UnknownKey']) {
      expect(
        acceleratorFromKeyEvent(keyEvent({ code: unsupported, ctrlKey: true }), false),
      ).toBeNull()
    }
  })
})

describe('formatHotkeyParts', () => {
  it('formats modifiers as glyphs on macOS and words on non-macOS', () => {
    expect(formatHotkeyParts('Alt+Space', true)).toEqual(['⌥', 'Space'])
    expect(formatHotkeyParts('Alt+Space', false)).toEqual(['Alt', 'Space'])

    expect(formatHotkeyParts('CommandOrControl+Shift+Space', true)).toEqual(['⌘', '⇧', 'Space'])
    expect(formatHotkeyParts('CommandOrControl+Shift+Space', false)).toEqual([
      'Ctrl',
      'Shift',
      'Space',
    ])

    expect(formatHotkeyParts('Ctrl+Alt+Shift+Command+Space', true)).toEqual([
      '⌃',
      '⌥',
      '⇧',
      '⌘',
      'Space',
    ])
    expect(formatHotkeyParts('Ctrl+Alt+Shift+Super+Space', false)).toEqual([
      'Ctrl',
      'Alt',
      'Shift',
      'Super',
      'Space',
    ])

    expect(formatHotkeyParts('CmdOrCtrl+Option+q', true)).toEqual(['⌘', '⌥', 'Q'])
    expect(formatHotkeyParts('CmdOrCtrl+Option+q', false)).toEqual(['Ctrl', 'Alt', 'Q'])
  })

  it('returns an empty list for empty input', () => {
    expect(formatHotkeyParts('', false)).toEqual([])
    expect(formatHotkeyParts('   ', true)).toEqual([])
  })
})
