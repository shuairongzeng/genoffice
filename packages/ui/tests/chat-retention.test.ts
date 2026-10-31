import { describe, expect, it } from 'vitest'
import { MAX_CHAT_ENTRIES, boundChatHistory } from '../src/chat-retention'

describe('boundChatHistory (issue #51 P1: the five editor panels share this bound)', () => {
  it('drops the oldest entries past the bound, keeping the newest in order', () => {
    const entries = Array.from({ length: 160 }, (_, i) => ({ n: i }) as { n: number })
    const bound = boundChatHistory(entries)
    expect(bound).toHaveLength(MAX_CHAT_ENTRIES)
    expect(bound[0]).toEqual({ n: 100 })
    expect(bound[bound.length - 1]).toEqual({ n: 159 })
  })

  it('returns the input array itself when nothing needed trimming', () => {
    const small = [{ n: 0 }, { n: 1 }]
    expect(boundChatHistory(small)).toBe(small)
    const exact = Array.from({ length: MAX_CHAT_ENTRIES }, (_, i) => ({ n: i }) as { n: number })
    expect(boundChatHistory(exact)).toBe(exact)
  })

  it('trims at 60+1 and keeps entry references intact', () => {
    const entries = Array.from(
      { length: MAX_CHAT_ENTRIES + 1 },
      (_, i) => ({ n: i }) as { n: number },
    )
    const bound = boundChatHistory(entries)
    expect(bound).toHaveLength(MAX_CHAT_ENTRIES)
    // the kept entries are the very objects, not copies
    expect(bound[0]).toBe(entries[1])
  })

  it('accepts a custom max and handles empty input', () => {
    expect(boundChatHistory([1, 2, 3], 2)).toEqual([2, 3])
    expect(boundChatHistory([] as number[])).toEqual([])
  })
})
