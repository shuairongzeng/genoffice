import { describe, expect, it } from 'vitest'
import { hitTargetText } from '../src/shared/home-api'

/**
 * The search deep link's text target extraction (issue #56): the hit's
 * snippet decides whether opening the hit jumps to the match. Only the
 * first `hit` part is the document's own text — needles are folded query
 * fragments and never a usable target.
 */
describe('hitTargetText', () => {
  it('returns the first hit part, trimmed', () => {
    expect(
      hitTargetText({
        snippet: [
          { text: 'The ', hit: false },
          { text: ' termination clause ', hit: true },
          { text: ' of the lease', hit: false },
        ],
      }),
    ).toBe('termination clause')
  })

  it('skips non-hit parts to the later hit, and whitespace-only targets are absent', () => {
    expect(
      hitTargetText({
        snippet: [
          { text: 'alpha', hit: false },
          { text: 'beta', hit: true },
        ],
      }),
    ).toBe('beta')
    expect(hitTargetText({ snippet: [{ text: '   ', hit: true }] })).toBeUndefined()
  })

  it('a snippet with no hit part, or no snippet at all, has no target', () => {
    expect(hitTargetText({ snippet: [{ text: 'only context', hit: false }] })).toBeUndefined()
    expect(hitTargetText({ snippet: null })).toBeUndefined()
    expect(hitTargetText({ snippet: undefined })).toBeUndefined()
    expect(hitTargetText({})).toBeUndefined()
  })

  it('a name-only hit object (no snippet field) reads as no target', () => {
    // the structural minimum HomeSearchPanel and the palette hand around
    const nameOnly: { snippet?: null } = {}
    expect(hitTargetText(nameOnly)).toBeUndefined()
  })
})
