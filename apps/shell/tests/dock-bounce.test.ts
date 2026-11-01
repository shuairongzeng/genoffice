// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { useDockBounce, type DockBounce } from '../src/renderer/src/dock-bounce'
import { DOCK_BOUNCE_TIMEOUT_MS } from '../src/renderer/src/dock-math'

/**
 * The launch bounce's lifecycle (src/renderer/src/dock-bounce.ts): the
 * steady macOS attention demand and everything that ends it — the target
 * becoming ready, a second click on the same item, a superseding launch,
 * and the 8s cap for a ready signal that never arrives. Fake timers own the
 * clock; a one-button probe exposes the hook's face.
 */

let root: Root
let container: HTMLDivElement
let bounce: DockBounce

function Probe(): React.JSX.Element {
  const hook = useDockBounce()
  bounce = hook
  return createElement('button', { onClick: () => hook.launch('dock:ask') })
}

async function mountProbe(): Promise<void> {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(createElement(Probe)))
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the launch bounce lifecycle', () => {
  it('launch bounces the item; the target becoming ready stops it', async () => {
    await mountProbe()
    act(() => bounce.launch('dock:templates'))
    expect(bounce.bouncing).toBe('dock:templates')
    act(() => bounce.settle('dock:templates'))
    expect(bounce.bouncing).toBeNull()
  })

  it('settle for another item is a no-op: only the bouncing one stops', async () => {
    await mountProbe()
    act(() => bounce.launch('dock:templates'))
    act(() => bounce.settle('dock:ask'))
    expect(bounce.bouncing).toBe('dock:templates')
    act(() => bounce.settle('dock:templates'))
    expect(bounce.bouncing).toBeNull()
  })

  it('a second launch for the same item is the cancel (the macOS click)', async () => {
    await mountProbe()
    act(() => bounce.launch('dock:ask'))
    act(() => bounce.launch('dock:ask'))
    expect(bounce.bouncing).toBeNull()
    // and it launches again cleanly afterwards
    act(() => bounce.launch('dock:ask'))
    expect(bounce.bouncing).toBe('dock:ask')
  })

  it('launching another item switches targets, and the old ready signal is stale', async () => {
    await mountProbe()
    act(() => bounce.launch('dock:templates'))
    act(() => bounce.launch('dock:ask'))
    expect(bounce.bouncing).toBe('dock:ask')
    // the templates target arriving late must not stop the ask bounce
    act(() => bounce.settle('dock:templates'))
    expect(bounce.bouncing).toBe('dock:ask')
  })

  it('the 8s cap stops a ready signal that never arrives', async () => {
    await mountProbe()
    act(() => bounce.launch('dock:ask'))
    await act(async () => {
      vi.advanceTimersByTime(DOCK_BOUNCE_TIMEOUT_MS - 1)
    })
    expect(bounce.bouncing).toBe('dock:ask')
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(bounce.bouncing).toBeNull()
  })

  it('the cap is per launch: a superseded timer never stops the newer bounce', async () => {
    await mountProbe()
    act(() => bounce.launch('dock:templates'))
    await act(async () => {
      vi.advanceTimersByTime(4000)
    })
    act(() => bounce.launch('dock:ask'))
    // the first launch's timer fires inside the second's window
    await act(async () => {
      vi.advanceTimersByTime(DOCK_BOUNCE_TIMEOUT_MS - 4000)
    })
    expect(bounce.bouncing).toBe('dock:ask')
    // only the second's own cap ends it
    await act(async () => {
      vi.advanceTimersByTime(4000 + 1)
    })
    expect(bounce.bouncing).toBeNull()
  })

  it('cancel stops whatever is bouncing', async () => {
    await mountProbe()
    act(() => bounce.launch('dock:ask'))
    act(() => bounce.cancel())
    expect(bounce.bouncing).toBeNull()
  })

  it('a settled bounce leaves no timer behind', async () => {
    await mountProbe()
    act(() => bounce.launch('dock:ask'))
    act(() => bounce.settle('dock:ask'))
    expect(vi.getTimerCount()).toBe(0)
  })
})
