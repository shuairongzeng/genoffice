import { describe, expect, it, vi } from 'vitest'

import type { WebContents } from 'electron'

/**
 * The surface context's collector (src/main/surface-context.ts): every open
 * tab — the shell strip's and the detached editor windows' — shaped into the
 * one list both the prompt's "current surface" section and shell:list_tabs
 * read. Browser tabs ask the source for their URL, document tabs keep their
 * file path, and an absent URL stays absent rather than guessed. Only types
 * come from electron, so the chrome fakes are plain objects.
 */

import {
  collectSurfaceTabs,
  urlOfWith,
  type SurfaceContextDeps,
  type SurfaceTabInput,
} from '../src/main/surface-context'

function depsWith(
  tabs: readonly SurfaceTabInput[] | Promise<readonly SurfaceTabInput[]>,
  urls: Record<string, string> = {},
): SurfaceContextDeps {
  return {
    listTabs: () => tabs,
    urlOf: (tabId: string) => urls[tabId] ?? '',
  }
}

describe('collectSurfaceTabs', () => {
  it('gives a browser tab the URL its source answers', async () => {
    const tabs = await collectSurfaceTabs(
      depsWith(
        [
          { id: 't1', kind: 'browser', title: 'Example Domain', active: true },
          { id: 't2', kind: 'browser', title: 'Docs', active: false },
        ],
        { t1: 'https://example.com/', t2: 'https://genoffice.dev/docs' },
      ),
    )
    expect(tabs).toEqual([
      {
        id: 't1',
        kind: 'browser',
        title: 'Example Domain',
        active: true,
        url: 'https://example.com/',
      },
      {
        id: 't2',
        kind: 'browser',
        title: 'Docs',
        active: false,
        url: 'https://genoffice.dev/docs',
      },
    ])
  })

  it('never asks the URL source about a document tab, and omits an absent one', async () => {
    const urlOf = vi.fn((tabId: string) => (tabId === 't1' ? 'https://example.com/' : ''))
    const tabs = await collectSurfaceTabs({
      listTabs: () => [
        { id: 'doc1', kind: 'word', title: 'Report', active: true, filePath: '/docs/report.docx' },
        { id: 'doc2', kind: 'markdown', title: 'Untitled', active: false },
        { id: 't1', kind: 'browser', title: 'Example Domain', active: false },
      ],
      urlOf,
    })
    expect(urlOf).toHaveBeenCalledTimes(1)
    expect(urlOf).toHaveBeenCalledWith('t1')
    expect(tabs).toEqual([
      {
        id: 'doc1',
        kind: 'word',
        title: 'Report',
        active: true,
        filePath: '/docs/report.docx',
      },
      { id: 'doc2', kind: 'markdown', title: 'Untitled', active: false },
      {
        id: 't1',
        kind: 'browser',
        title: 'Example Domain',
        active: false,
        url: 'https://example.com/',
      },
    ])
  })

  it('carries the detached flag and an empty-string filePath as absent', async () => {
    const tabs = await collectSurfaceTabs(
      depsWith([
        {
          id: 'doc1',
          kind: 'word',
          title: 'Report',
          active: false,
          filePath: '',
          detached: true,
        },
      ]),
    )
    expect(tabs).toEqual([
      { id: 'doc1', kind: 'word', title: 'Report', active: false, detached: true },
    ])
  })

  it("demotes the strip's active tab when a detached window is focused", async () => {
    // the strip's active flag is the tab the shell window had selected when
    // it lost focus: with a detached editor focused, the person is looking at
    // THAT window, and the section must not claim two actives
    const tabs = await collectSurfaceTabs(
      depsWith(
        [
          { id: 't1', kind: 'browser', title: 'Strip tab', active: true },
          {
            id: 'd1',
            kind: 'word',
            title: 'Detached',
            active: true,
            filePath: '/docs/report.docx',
            detached: true,
          },
        ],
        { t1: 'https://example.com/' },
      ),
    )
    expect(tabs).toEqual([
      { id: 't1', kind: 'browser', title: 'Strip tab', active: false, url: 'https://example.com/' },
      {
        id: 'd1',
        kind: 'word',
        title: 'Detached',
        active: true,
        filePath: '/docs/report.docx',
        detached: true,
      },
    ])
  })

  it("keeps the strip's active tab when no detached window is focused", async () => {
    const tabs = await collectSurfaceTabs(
      depsWith([
        { id: 't1', kind: 'browser', title: 'Strip tab', active: true },
        { id: 'd1', kind: 'word', title: 'Detached', active: false, detached: true },
      ]),
    )
    expect(tabs[0]).toMatchObject({ id: 't1', active: true })
    expect(tabs[1]).toMatchObject({ id: 'd1', active: false })
  })

  it('accepts async sources with the same shape as sync ones', async () => {
    const asyncTabs = Promise.resolve<readonly SurfaceTabInput[]>([
      { id: 't1', kind: 'browser', title: 'Example Domain', active: true, detached: true },
    ])
    const tabs = await collectSurfaceTabs(depsWith(asyncTabs, { t1: 'https://example.com/' }))
    expect(tabs).toEqual([
      {
        id: 't1',
        kind: 'browser',
        title: 'Example Domain',
        active: true,
        url: 'https://example.com/',
        detached: true,
      },
    ])
  })

  it('filters junk the sources may hand back', async () => {
    const tabs = await collectSurfaceTabs({
      // cast: the collector defends against a source gone wrong, not a typed one
      listTabs: () =>
        [null, 5, {}, { id: '', kind: 'browser', title: 'x', active: false }] as never,
      urlOf: () => '',
    })
    expect(tabs).toEqual([])
  })
})

describe('urlOfWith', () => {
  it('answers the page URL through both helpers', () => {
    const chrome = { isDestroyed: () => false } as WebContents
    const urlOf = urlOfWith(
      (tabId) => (tabId === 't1' ? chrome : undefined),
      () => 'https://a.dev/',
    )
    expect(urlOf('t1')).toBe('https://a.dev/')
    expect(urlOf('nope')).toBe('')
  })

  it('answers an empty string when the chrome is destroyed or missing', () => {
    const destroyed = { isDestroyed: () => true } as WebContents
    const pageUrlOf = vi.fn(() => 'https://never-read.dev/')
    const urlOf = urlOfWith(() => destroyed, pageUrlOf)
    expect(urlOf('t1')).toBe('')
    expect(pageUrlOf).not.toHaveBeenCalled()
  })
})
