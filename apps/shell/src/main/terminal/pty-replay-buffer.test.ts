import { describe, expect, it } from 'vitest'
import { PtyReplayBuffer } from './pty-replay-buffer'

describe('PtyReplayBuffer', () => {
  it('stores and concatenates appended chunks within capacity', () => {
    const buf = new PtyReplayBuffer(1024)
    expect(buf.byteLength).toBe(0)
    expect(buf.snapshot()).toBe('')

    buf.append('hello ')
    buf.append('world')
    expect(buf.snapshot()).toBe('hello world')
    expect(buf.byteLength).toBe(11)

    buf.clear()
    expect(buf.byteLength).toBe(0)
    expect(buf.snapshot()).toBe('')
  })

  it('evicts oldest chunks FIFO when total byte length exceeds maxBytes', () => {
    const buf = new PtyReplayBuffer(10)
    buf.append('1234')
    buf.append('5678')
    buf.append('ABCD')
    expect(buf.snapshot()).toBe('5678ABCD')
    expect(buf.byteLength).toBe(8)

    buf.append('EFG')
    expect(buf.snapshot()).toBe('ABCDEFG')
    expect(buf.byteLength).toBe(7)
  })

  it('clips oversized single chunks cleanly at valid UTF-8 character boundaries', () => {
    // Each CJK character occupies 3 UTF-8 bytes ('你好世界测试' = 18 bytes).
    const buf = new PtyReplayBuffer(7)
    buf.append('你好世界测试')
    const snap = buf.snapshot()

    expect(Buffer.byteLength(snap, 'utf8')).toBeLessThanOrEqual(7)
    expect(snap.includes('\uFFFD')).toBe(false)
    expect(snap).toBe('测试')

    // Emoji ('🚀' = 4 UTF-8 bytes) boundary check.
    const emojiBuf = new PtyReplayBuffer(6)
    emojiBuf.append('AB🚀🚀CD')
    const emojiSnap = emojiBuf.snapshot()
    expect(Buffer.byteLength(emojiSnap, 'utf8')).toBeLessThanOrEqual(6)
    expect(emojiSnap.includes('\uFFFD')).toBe(false)
    expect(emojiSnap).toBe('🚀CD')
  })
})
