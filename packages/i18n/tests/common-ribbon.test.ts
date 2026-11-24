import { describe, expect, it } from 'vitest'
import * as commonRibbon from '../src/common-ribbon'
import { ribbonCommonZh } from '../src/common-ribbon'

// Cross-app ribbon shard deduplication against apps/docs and apps/slides is
// enabled once Batch 2 (slides) and Batch 4 (docs) migrate their ribbon shards.
describe('shared ribbon table', () => {
  it('keeps identical key sets across all exported locale tables', () => {
    const expected = Object.keys(ribbonCommonZh).sort()
    expect(expected.length).toBeGreaterThan(50)
    for (const [name, dict] of Object.entries(commonRibbon)) {
      if (!name.startsWith('ribbonCommon')) continue
      expect(Object.keys(dict as Record<string, string>).sort(), name).toEqual(expected)
    }
  })
})
