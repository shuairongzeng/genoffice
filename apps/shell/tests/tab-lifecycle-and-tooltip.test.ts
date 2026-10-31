import { describe, expect, it, vi } from 'vitest'
import {
  closeTabsInOrder,
  createRecentlyClosedTracker,
  MAX_RECENTLY_CLOSED,
  type TabCloseManager,
  type TabCloseTarget,
} from '../src/main/tab-lifecycle'

/**
 * Tab close ordering and the recently-closed tracker (src/main/tab-lifecycle.ts):
 * the sequential bulk-close loop stops at a cancelled prompt, and reopening
 * walks the bounded stack. The native tab strip's tooltip/rename helpers
 * (formerly in renderer TabBar.tsx) were retired with the strip itself.
 */

describe('bulk close sequential ordering and prompt cancellation (C1-C8)', () => {
  it('C1: stops closing subsequent tabs when unsaved-changes close confirmation is cancelled', async () => {
    let openTabs: TabCloseTarget[] = [
      { id: 'tab-a', closable: true },
      { id: 'tab-b', closable: true },
      { id: 'tab-c', closable: true },
    ]

    const manager: TabCloseManager = {
      list: () => openTabs,
      closeTab: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'tab-b') {
          // User clicked "Cancel" on unsaved-changes prompt for tab-b
          // tab-b remains in list
          return
        }
        openTabs = openTabs.filter((t) => t.id !== id)
      }),
    }

    await closeTabsInOrder(manager, ['tab-a', 'tab-b', 'tab-c'])

    expect(manager.closeTab).toHaveBeenCalledWith('tab-a')
    expect(manager.closeTab).toHaveBeenCalledWith('tab-b')
    expect(manager.closeTab).not.toHaveBeenCalledWith('tab-c')
    expect(openTabs.map((t) => t.id)).toEqual(['tab-b', 'tab-c'])
  })

  it('C2: continues sequential close when user selects Save and save succeeds', async () => {
    let openTabs: TabCloseTarget[] = [
      { id: 'tab-a', closable: true },
      { id: 'tab-b', closable: true },
      { id: 'tab-c', closable: true },
    ]

    const manager: TabCloseManager = {
      list: () => openTabs,
      closeTab: vi.fn().mockImplementation(async (id: string) => {
        // User clicked Save and save succeeded -> tab is closed
        openTabs = openTabs.filter((t) => t.id !== id)
      }),
    }

    await closeTabsInOrder(manager, ['tab-a', 'tab-b', 'tab-c'])

    expect(manager.closeTab).toHaveBeenCalledWith('tab-a')
    expect(manager.closeTab).toHaveBeenCalledWith('tab-b')
    expect(manager.closeTab).toHaveBeenCalledWith('tab-c')
    expect(openTabs).toHaveLength(0)
  })

  it('C3: halts sequential close when save fails and tab remains open', async () => {
    let openTabs: TabCloseTarget[] = [
      { id: 'tab-1', closable: true },
      { id: 'tab-2', closable: true },
      { id: 'tab-3', closable: true },
    ]

    const manager: TabCloseManager = {
      list: () => openTabs,
      closeTab: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'tab-2') {
          // Save failed, tab remains open
          return
        }
        openTabs = openTabs.filter((t) => t.id !== id)
      }),
    }

    await closeTabsInOrder(manager, ['tab-1', 'tab-2', 'tab-3'])

    expect(manager.closeTab).toHaveBeenCalledWith('tab-1')
    expect(manager.closeTab).toHaveBeenCalledWith('tab-2')
    expect(manager.closeTab).not.toHaveBeenCalledWith('tab-3')
    expect(openTabs.map((t) => t.id)).toEqual(['tab-2', 'tab-3'])
  })

  it('C4: safely skips tabs that were already closed before sequence reaches them', async () => {
    let openTabs: TabCloseTarget[] = [
      { id: 'tab-x', closable: true },
      { id: 'tab-z', closable: true },
    ]

    const manager: TabCloseManager = {
      list: () => openTabs,
      closeTab: vi.fn().mockImplementation(async (id: string) => {
        openTabs = openTabs.filter((t) => t.id !== id)
      }),
    }

    // tab-y is in the request list but not open in manager
    await closeTabsInOrder(manager, ['tab-x', 'tab-y', 'tab-z'])

    expect(manager.closeTab).toHaveBeenCalledWith('tab-x')
    expect(manager.closeTab).not.toHaveBeenCalledWith('tab-y')
    expect(manager.closeTab).toHaveBeenCalledWith('tab-z')
    expect(openTabs).toHaveLength(0)
  })

  it('C5: closes tabs sequentially without overlapping calls', async () => {
    const executionOrder: string[] = []
    let openTabs: TabCloseTarget[] = [
      { id: 't1', closable: true },
      { id: 't2', closable: true },
    ]

    const manager: TabCloseManager = {
      list: () => openTabs,
      closeTab: vi.fn().mockImplementation(async (id: string) => {
        executionOrder.push(`start-${id}`)
        await new Promise((r) => setTimeout(r, 10))
        openTabs = openTabs.filter((t) => t.id !== id)
        executionOrder.push(`end-${id}`)
      }),
    }

    await closeTabsInOrder(manager, ['t1', 't2'])

    expect(executionOrder).toEqual(['start-t1', 'end-t1', 'start-t2', 'end-t2'])
  })

  it('C6: never closes Home tab even if included in requested ids', async () => {
    let openTabs: TabCloseTarget[] = [
      { id: 'home', closable: false },
      { id: 'doc-1', closable: true },
    ]

    const manager: TabCloseManager = {
      list: () => openTabs,
      closeTab: vi.fn().mockImplementation(async (id: string) => {
        openTabs = openTabs.filter((t) => t.id !== id)
      }),
    }

    await closeTabsInOrder(manager, ['home', 'doc-1'])

    expect(manager.closeTab).not.toHaveBeenCalledWith('home')
    expect(manager.closeTab).toHaveBeenCalledWith('doc-1')
    expect(openTabs.map((t) => t.id)).toEqual(['home'])
  })

  it('C7: Close Others preserves right-clicked tab while closing all other closable tabs', async () => {
    let openTabs: TabCloseTarget[] = [
      { id: 'home', closable: false },
      { id: 't1', closable: true },
      { id: 'target', closable: true },
      { id: 't2', closable: true },
    ]

    const othersToClose = openTabs
      .filter((t) => t.id !== 'target' && t.id !== 'home' && t.closable)
      .map((t) => t.id)

    const manager: TabCloseManager = {
      list: () => openTabs,
      closeTab: vi.fn().mockImplementation(async (id: string) => {
        openTabs = openTabs.filter((t) => t.id !== id)
      }),
    }

    await closeTabsInOrder(manager, othersToClose)

    expect(openTabs.map((t) => t.id)).toEqual(['home', 'target'])
  })

  it('C8: Close Tabs to the Right only closes tabs to the right in sequence', async () => {
    let openTabs: TabCloseTarget[] = [
      { id: 'home', closable: false },
      { id: 't1', closable: true },
      { id: 't2', closable: true },
      { id: 't3', closable: true },
      { id: 't4', closable: true },
    ]

    const index = openTabs.findIndex((t) => t.id === 't2')
    const rightToClose = openTabs
      .slice(index + 1)
      .filter((t) => t.closable)
      .map((t) => t.id)

    expect(rightToClose).toEqual(['t3', 't4'])

    const manager: TabCloseManager = {
      list: () => openTabs,
      closeTab: vi.fn().mockImplementation(async (id: string) => {
        openTabs = openTabs.filter((t) => t.id !== id)
      }),
    }

    await closeTabsInOrder(manager, rightToClose)

    expect(openTabs.map((t) => t.id)).toEqual(['home', 't1', 't2'])
  })
})

describe('production recently closed tabs lifecycle tracker', () => {
  it('maintains bounded history for recently closed tabs and skips missing files on reopen', () => {
    const tracker = createRecentlyClosedTracker(MAX_RECENTLY_CLOSED)

    // Add 25 closed tabs
    for (let i = 1; i <= 25; i++) {
      tracker.push({ kind: 'docs', filePath: `/path/file${i}.docx` })
    }

    const entries = tracker.getEntries()
    expect(entries.length).toBe(20)
    expect(entries[0]?.filePath).toBe('/path/file6.docx')
    expect(entries[19]?.filePath).toBe('/path/file25.docx')

    // Untitled tab without filePath is never remembered
    tracker.push({ kind: 'docs' })
    expect(tracker.getEntries().length).toBe(20)

    // Home and Help tabs are never remembered
    tracker.push({ kind: 'home', filePath: '/path/home.docx' })
    tracker.push({ kind: 'help', filePath: '/path/help.docx' })
    expect(tracker.getEntries().length).toBe(20)

    // Repeated close of an existing path moves it to top without duplication
    tracker.push({ kind: 'docs', filePath: '/path/file6.docx' })
    expect(tracker.getEntries().length).toBe(20)
    expect(tracker.getEntries()[19]?.filePath).toBe('/path/file6.docx')

    // Reopen skipping missing files
    const existingFiles = new Set(['/path/file23.docx'])
    const openDocumentMock = vi.fn().mockReturnValue(true)
    const fileExistsMock = (path: string) => existingFiles.has(path)

    const reopened = tracker.reopenNext(openDocumentMock, fileExistsMock)
    expect(reopened).toBe(true)
    expect(openDocumentMock).toHaveBeenCalledWith('/path/file23.docx')

    // Remaining stack popped files up to file23
    expect(tracker.getEntries().some((e) => e.filePath === '/path/file23.docx')).toBe(false)
  })

  it('handles empty stack or all-missing files cleanly', () => {
    const tracker = createRecentlyClosedTracker()
    const openMock = vi.fn()

    // Empty stack
    expect(tracker.reopenNext(openMock)).toBe(false)
    expect(openMock).not.toHaveBeenCalled()

    // All missing files
    tracker.push({ kind: 'docs', filePath: '/missing/a.docx' })
    tracker.push({ kind: 'docs', filePath: '/missing/b.docx' })

    const fileExists = () => false
    expect(tracker.reopenNext(openMock, fileExists)).toBe(false)
    expect(openMock).not.toHaveBeenCalled()
    expect(tracker.getEntries()).toHaveLength(0)
  })
})
