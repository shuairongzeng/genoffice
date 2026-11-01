import { describe, expect, it } from 'vitest'

import { BROWSER_CHANNELS } from '../src/shared/ipc'
import { PAGE_CHANNELS } from '../src/preload/annotate/channels'

/**
 * The page preload's channel copy must match the table the main process
 * registers: the two preload build entries share no module (a shared module
 * would split into a chunk the sandboxed page preload cannot require), so the
 * page side carries its own constants — this is the drift guard.
 */
describe('page-annotate channel parity', () => {
  it('every page-side channel matches the shared table', () => {
    expect(PAGE_CHANNELS.state).toBe(BROWSER_CHANNELS.pageAnnotateState)
    expect(PAGE_CHANNELS.sync).toBe(BROWSER_CHANNELS.pageAnnotateSync)
    expect(PAGE_CHANNELS.pin).toBe(BROWSER_CHANNELS.pageAnnotatePin)
    expect(PAGE_CHANNELS.note).toBe(BROWSER_CHANNELS.pageAnnotateNote)
    expect(PAGE_CHANNELS.delete).toBe(BROWSER_CHANNELS.pageAnnotateDelete)
    expect(PAGE_CHANNELS.ask).toBe(BROWSER_CHANNELS.pageAnnotateAsk)
    expect(PAGE_CHANNELS.exit).toBe(BROWSER_CHANNELS.pageAnnotateExit)
  })
})
