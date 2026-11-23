import { describe, expect, it } from 'vitest'
import { isTerminalResponseSequence } from './terminal-workspace-utils'

describe('isTerminalResponseSequence', () => {
  it('filters xterm automatic device, geometry, color, focus, and mouse responses', () => {
    const replies = [
      '\x1b[?1;2c', // DA1
      '\x1b[>0;276;0c', // DA2
      '\x1b[12;34R', // CPR
      '\x1b[?12;34R', // DECXCPR
      '\x1b[0n', // DSR
      '\x1b[?2026;2$y', // DECRPM synchronized output
      '\x1b[20;2$y', // DECRPM LNM
      '\x1b[4;464;800t', // XTWINOPS text area size in pixels
      '\x1b[6;18;9t', // XTWINOPS cell size in pixels
      '\x1b[8;24;80t', // XTWINOPS size in chars
      '\x1b[?0u', // Kitty keyboard query reply
      '\x1b[?1u',
      '\x1b[I', // Focus In
      '\x1b[O', // Focus Out
      '\x1b[<0;12;4M', // SGR mouse press
      '\x1b[<35;12;4m', // SGR mouse release/move
      '\x1b[M !#', // X10 mouse event
      '\x1b]10;rgb:e6e6/eded/f3f3\x1b\\', // OSC 10 fg
      '\x1b]11;rgb:1212/1515/fbfb\x07', // OSC 11 bg
      '\x1bP1$r0 q\x1b\\', // DECRQSS
      '\x1bP>|xterm.js(6.0.0)\x1b\\', // XTVERSION
      '\x1b_Gi=1;OK\x1b\\', // APC
    ]

    for (const reply of replies) {
      expect(isTerminalResponseSequence(reply), `Expected filtered: ${JSON.stringify(reply)}`).toBe(
        true,
      )
    }
  })

  it('allows normal user input, Chinese text, shortcuts, arrows, and bracketed pastes', () => {
    const inputs = [
      'a',
      '1',
      ' ',
      '\r',
      '\x03',
      '\x7f',
      '\x1b', // bare Escape
      '我要问一个问题',
      'git status\r',
      '\x1b[A', // Up arrow
      '\x1b[B', // Down arrow
      '\x1b[C', // Right arrow
      '\x1b[D', // Left arrow
      '\x1bOA', // Application cursor Up
      '\x1bOP', // F1
      '\x1b[15~', // F5
      '\x1b[3~', // Delete
      '\x1b[H', // Home
      '\x1b[F', // End
      '\x1b[Z', // Shift+Tab
      '\x1b[200~我要问一个问题\x1b[201~', // Bracketed paste
      '464',
      'd/fbfb',
    ]

    for (const input of inputs) {
      expect(isTerminalResponseSequence(input), `Expected allowed: ${JSON.stringify(input)}`).toBe(
        false,
      )
    }
  })
})
