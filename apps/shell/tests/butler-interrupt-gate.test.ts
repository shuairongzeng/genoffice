import { describe, expect, it } from 'vitest'

import { createInterruptGate } from '../src/main/butler/interrupt-gate'

const HOUR = 3_600_000

describe('createInterruptGate', () => {
  it('enforces the shared hourly budget for done and error notifications', () => {
    const gate = createInterruptGate()
    const prefs = { dnd: false, maxPerHour: 3 }

    expect(gate.allow('done', 1000, prefs)).toBe(true)
    expect(gate.allow('error', 2000, prefs)).toBe(true)
    expect(gate.allow('done', 3000, prefs)).toBe(true)
    expect(gate.allow('error', 4000, prefs)).toBe(false)
    expect(gate.allow('done', 5000, prefs)).toBe(false)
  })

  it('recovers budget as timestamps slide past 1 hour', () => {
    const gate = createInterruptGate()
    const prefs = { dnd: false, maxPerHour: 2 }

    expect(gate.allow('done', 10_000, prefs)).toBe(true)
    expect(gate.allow('error', 20_000, prefs)).toBe(true)
    expect(gate.allow('done', 30_000, prefs)).toBe(false)

    // At 10_000 + HOUR - 1, first slot is still within the 1-hour window.
    expect(gate.allow('done', 10_000 + HOUR - 1, prefs)).toBe(false)

    // At exactly 10_000 + HOUR, the entry at 10_000 expires (`<= now - 3_600_000`).
    expect(gate.allow('done', 10_000 + HOUR, prefs)).toBe(true)
    expect(gate.allow('error', 10_000 + HOUR + 1, prefs)).toBe(false)

    // At 20_000 + HOUR, the second entry expires as well.
    expect(gate.allow('error', 20_000 + HOUR, prefs)).toBe(true)
  })

  it('blocks everything including confirm when dnd is enabled without consuming budget', () => {
    const gate = createInterruptGate()
    const dndOn = { dnd: true, maxPerHour: 2 }
    const dndOff = { dnd: false, maxPerHour: 2 }

    expect(gate.allow('done', 1000, dndOn)).toBe(false)
    expect(gate.allow('error', 2000, dndOn)).toBe(false)
    expect(gate.allow('confirm', 3000, dndOn)).toBe(false)

    // Budget must remain untouched once DND turns off.
    expect(gate.allow('done', 4000, dndOff)).toBe(true)
    expect(gate.allow('done', 5000, dndOff)).toBe(true)
  })

  it('lets confirm bypass the hourly cap when dnd is off', () => {
    const gate = createInterruptGate()
    const prefs = { dnd: false, maxPerHour: 1 }

    expect(gate.allow('done', 1000, prefs)).toBe(true)
    expect(gate.allow('done', 2000, prefs)).toBe(false)

    expect(gate.allow('confirm', 3000, prefs)).toBe(true)
    expect(gate.allow('confirm', 4000, prefs)).toBe(true)

    // Confirm calls must not extend or alter the exhausted done/error budget.
    expect(gate.allow('error', 5000, prefs)).toBe(false)
  })
})
