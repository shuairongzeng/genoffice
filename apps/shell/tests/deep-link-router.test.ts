import { describe, expect, it, vi } from 'vitest'
import { makeDeepLinkRouter } from '../src/main/deep-link-router'
import { HOME_CHANNELS } from '../src/shared/home-api'

/**
 * The deep-link routing matrix in isolation: every window-shaped effect is a
 * mock here, so the table — which verb rides which channel, which verbs the
 * main process handles itself, and what a link that beats app-ready does —
 * is pinned without booting Electron. index.ts wires the real windows on
 * top of this; Home.tsx owns what the renderer does with the forwarded verbs.
 */

interface Recording {
  ready: boolean
  calls: string[]
  deepLinkSends: unknown[][]
  palette: number
  home: number
  reveals: number
  routed: string[]
}

/** a router over recorded deps; set `ready` to flip the pre-ready path */
function makeRouter(ready = true) {
  const rec: Recording = {
    ready,
    calls: [],
    deepLinkSends: [],
    palette: 0,
    home: 0,
    reveals: 0,
    routed: [],
  }
  const router = makeDeepLinkRouter({
    isReady: () => rec.ready,
    revealShellWindow: () => {
      rec.reveals += 1
      rec.calls.push('reveal')
    },
    summonHome: () => {
      rec.home += 1
      rec.calls.push('home')
    },
    summonPalette: () => {
      rec.palette += 1
      rec.calls.push('palette')
    },
    routeDocumentPath: (path) => {
      rec.routed.push(path)
      rec.calls.push(`route:${path}`)
    },
    sendToShellRenderer: vi.fn((channel: string, payload?: unknown) => {
      rec.calls.push(`send:${channel}`)
      if (channel === HOME_CHANNELS.deepLink) rec.deepLinkSends.push([payload])
    }),
  })
  return { router, rec }
}

describe('makeDeepLinkRouter routing matrix', () => {
  it('routes desktop like ask: summonHome plus exactly one home:deep-link send', () => {
    const { router, rec } = makeRouter()
    router.deliver({ view: 'desktop' })
    expect(rec.home).toBe(1)
    expect(rec.reveals).toBe(0)
    expect(rec.palette).toBe(0)
    expect(rec.routed).toEqual([])
    expect(rec.deepLinkSends).toEqual([[{ view: 'desktop' }]])
    // and only that one channel: no palette summon, no document routing
    expect(rec.calls).toEqual(['home', `send:${HOME_CHANNELS.deepLink}`])
  })

  it('forwards an ask link verbatim through the same fall-through', () => {
    const { router, rec } = makeRouter()
    router.deliver({ view: 'ask', query: 'quarterly report' })
    expect(rec.deepLinkSends).toEqual([[{ view: 'ask', query: 'quarterly report' }]])
    expect(rec.home).toBe(1)
    expect(rec.palette).toBe(0)
  })

  it('routes palette main-side: the summon, never a deep-link send', () => {
    const { router, rec } = makeRouter()
    router.deliver({ view: 'palette' })
    expect(rec.palette).toBe(1)
    expect(rec.home).toBe(0)
    expect(rec.reveals).toBe(0)
    expect(rec.deepLinkSends).toEqual([])
  })

  it('routes open main-side: reveal first, then the document through the file router', () => {
    const { router, rec } = makeRouter()
    router.deliver({ view: 'open', path: '/tmp/report.docx' })
    expect(rec.reveals).toBe(1)
    expect(rec.routed).toEqual(['/tmp/report.docx'])
    expect(rec.home).toBe(0)
    expect(rec.deepLinkSends).toEqual([])
    // the reveal happens before the routing, so a background launch surfaces
    expect(rec.calls.indexOf('reveal')).toBeLessThan(rec.calls.indexOf('route:/tmp/report.docx'))
  })

  it('reveals the shell for an open verb with no path, routing nothing', () => {
    const { router, rec } = makeRouter()
    router.deliver({ view: 'open' })
    expect(rec.reveals).toBe(1)
    expect(rec.routed).toEqual([])
    expect(rec.deepLinkSends).toEqual([])
  })
})

describe('makeDeepLinkRouter pre-ready queue', () => {
  it('queues a link that beats app ready and delivers it on the flush', () => {
    const { router, rec } = makeRouter(false)
    router.deliver({ view: 'desktop' })
    expect(rec.calls).toEqual([]) // nothing has happened yet — no window exists
    rec.ready = true
    router.flushPending()
    expect(rec.deepLinkSends).toEqual([[{ view: 'desktop' }]])
    expect(rec.home).toBe(1)
  })

  it('delivers queued links in arrival order, each exactly once', () => {
    const { router, rec } = makeRouter(false)
    router.deliver({ view: 'ask', query: 'first' })
    router.deliver({ view: 'palette' })
    router.deliver({ view: 'open', path: '/tmp/a.pdf' })
    expect(rec.calls).toEqual([])
    rec.ready = true
    router.flushPending()
    // ask before palette before open, matching the order the links arrived
    expect(rec.calls).toEqual([
      'home',
      `send:${HOME_CHANNELS.deepLink}`,
      'palette',
      'reveal',
      'route:/tmp/a.pdf',
    ])
    expect(rec.deepLinkSends).toEqual([[{ view: 'ask', query: 'first' }]])
    // and the queue is drained: a second flush is a no-op
    router.flushPending()
    expect(rec.palette).toBe(1)
    expect(rec.home).toBe(1)
  })

  it('keeps queueing across a flush while ready has not flipped yet', () => {
    const { router, rec } = makeRouter(false)
    router.deliver({ view: 'desktop' })
    router.flushPending() // still not ready: the link stays queued
    expect(rec.calls).toEqual([])
    router.deliver({ view: 'ask' })
    rec.ready = true
    router.flushPending()
    expect(rec.deepLinkSends).toEqual([[{ view: 'desktop' }], [{ view: 'ask' }]])
  })

  it('flushes an empty queue without touching a thing', () => {
    const { router, rec } = makeRouter(true)
    router.flushPending()
    expect(rec.calls).toEqual([])
  })

  it('delivers live links after the flush without re-queueing them', () => {
    const { router, rec } = makeRouter(false)
    router.deliver({ view: 'palette' })
    rec.ready = true
    router.flushPending()
    router.deliver({ view: 'desktop' }) // ready now: straight through
    expect(rec.palette).toBe(1)
    expect(rec.deepLinkSends).toEqual([[{ view: 'desktop' }]])
    router.flushPending()
    expect(rec.palette).toBe(1) // nothing was double-delivered
  })
})
