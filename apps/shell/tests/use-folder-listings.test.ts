// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useFolderListings } from '../src/renderer/src/useFolderListings'
import type { FolderListing } from '../src/shared/home-api'

/**
 * The focus refresh's dirty-check: `revalidate` re-asks each cached folder
 * with the mtime it was read at — an `unchanged` reply keeps the cached
 * listing, a fresh one replaces it in place, and a probe that resolves after
 * an invalidate dropped the entry does not resurrect it.
 */

let root: Root
let container: HTMLDivElement
let api: ReturnType<typeof useFolderListings> | null = null

function Harness(): ReactNode {
  const hook = useFolderListings()
  api = hook
  return null
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(Harness))
  })
})

afterEach(async () => {
  root.unmount()
  await act(async () => {})
  container.remove()
  api = null
  vi.unstubAllGlobals()
})

const listing = (dir: string, name: string, mtimeMs: number): FolderListing => ({
  dir,
  mtimeMs,
  folders: [],
  files: [{ path: `${dir}/${name}`, name, ext: 'md', mtimeMs: 1, sizeBytes: 1, starred: false }],
})

// what the main process answers: the cached listing for a matching mtime
// (empty placeholders + unchanged), a fresh one otherwise
const replies = new Map<string, FolderListing>()
let asked: { dir: string; knownMtimeMs?: number }[] = []
const makeListFolder = () =>
  vi.fn(async (dir: string, knownMtimeMs?: number): Promise<FolderListing> => {
    asked.push({ dir, knownMtimeMs })
    const reply = replies.get(dir)
    if (!reply) return { dir, mtimeMs: 1, folders: [], files: [], missing: true }
    if (reply.mtimeMs === knownMtimeMs) {
      return { dir, mtimeMs: reply.mtimeMs, folders: [], files: [], unchanged: true }
    }
    return reply
  })

let listFolder: ReturnType<typeof makeListFolder>

beforeEach(() => {
  listFolder = makeListFolder()
  Object.defineProperty(window, 'aiOffice', {
    configurable: true,
    value: { listFolder },
  })
  asked = []
})

afterEach(() => {
  replies.clear()
})

describe('useFolderListings.revalidate', () => {
  it('keeps the cached listing when the probe answers unchanged', async () => {
    replies.set('/docs', listing('/docs', 'a.md', 7))
    await act(async () => {
      api!.load('/docs')
    })
    await act(async () => {})
    expect(api!.listings.get('/docs')?.files[0]!.name).toBe('a.md')
    listFolder.mockClear()
    asked = []

    await act(async () => {
      api!.revalidate()
    })
    // the probe passed the mtime the cache was read at
    expect(asked).toEqual([{ dir: '/docs', knownMtimeMs: 7 }])
    // exactly one probe — the cached entry is otherwise untouched
    expect(listFolder).toHaveBeenCalledTimes(1)
    expect(api!.listings.get('/docs')?.files[0]!.name).toBe('a.md')
  })

  it('replaces the cached listing when the mtime moved', async () => {
    replies.set('/docs', listing('/docs', 'a.md', 7))
    await act(async () => {
      api!.load('/docs')
    })
    await act(async () => {})
    expect(api!.listings.get('/docs')?.mtimeMs).toBe(7)

    // the folder changed on disk while the window was unfocused
    replies.set('/docs', listing('/docs', 'b.md', 9))
    await act(async () => {
      api!.revalidate()
    })
    await act(async () => {})
    const next = api!.listings.get('/docs')!
    expect(next.mtimeMs).toBe(9)
    expect(next.files[0]!.name).toBe('b.md')
  })

  it('does not resurrect an entry that an invalidate dropped while the probe was in flight', async () => {
    replies.set('/docs', listing('/docs', 'a.md', 7))
    await act(async () => {
      api!.load('/docs')
    })
    await act(async () => {})
    expect(api!.listings.has('/docs')).toBe(true)

    // gate the next two calls: the focus-refresh probe, then the forced
    // reload the watch event's invalidate starts
    let releaseProbe: ((reply: FolderListing) => void) | null = null
    const probeGate = new Promise<FolderListing>((resolve) => {
      releaseProbe = resolve
    })
    listFolder.mockImplementationOnce(() => probeGate)
    let releaseReload: ((reply: FolderListing) => void) | null = null
    const reloadGate = new Promise<FolderListing>((resolve) => {
      releaseReload = resolve
    })
    listFolder.mockImplementationOnce(() => reloadGate)

    // the probe leaves with the entry still cached…
    await act(async () => {
      api!.revalidate()
    })
    // …and the watch event drops the entry and starts a forced reload before
    // the probe comes back
    await act(async () => {
      api!.invalidate(['/docs'])
    })
    expect(api!.listings.has('/docs')).toBe(false)

    // the probe answers with fresh data, but the entry is gone: the forced
    // reload owns it now, the stale probe must not re-add it
    await act(async () => {
      releaseProbe?.(listing('/docs', 'b.md', 9))
    })
    await act(async () => {})
    expect(api!.listings.has('/docs')).toBe(false)

    await act(async () => {
      releaseReload?.(listing('/docs', 'c.md', 11))
    })
    await act(async () => {})
    const final = api!.listings.get('/docs')!
    expect(final.mtimeMs).toBe(11)
    expect(final.files[0]!.name).toBe('c.md')
  })
})
