// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { FileSearchResults } from '../src/renderer/src/HomeSearchPanel'
import { LocaleProvider } from '../src/renderer/src/locale'
import type { FileSearchPage } from '../src/shared/home-api'

/**
 * The Home search's no-results state (issue #56 P0 #2, gate 3): a dead end is
 * not an answer — the query that matched nothing by keyword is handed to the
 * Ask AI view as a question, the same intent bus the palette's fallback row
 * uses. Mounts FileSearchResults directly: the referral is a property of the
 * empty page, not of the search flow that produced it.
 */

const emptyPage: FileSearchPage = {
  hits: [],
  total: 0,
  index: { indexed: 1, pending: 0, scanning: false },
}

let root: Root
let container: HTMLDivElement
let asked: string[]

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  asked = []
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(props: Partial<Parameters<typeof FileSearchResults>[0]> = {}): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        LocaleProvider,
        { initial: 'en' },
        createElement(FileSearchResults, {
          searchPage: emptyPage,
          q: 'quarterly report',
          rerankApplied: null,
          roots: [],
          onAskAi: (query) => asked.push(query),
          ...props,
        }),
      ),
    )
  })
}

describe('Home search no-results referral', () => {
  it('offers Ask AI with the exact query when the index found nothing', async () => {
    await render()
    const button = container.querySelector<HTMLButtonElement>('.search-ask-referral')
    expect(button).toBeTruthy()
    expect(button!.textContent).toContain('quarterly report')
    await act(async () => button!.click())
    expect(asked).toEqual(['quarterly report'])
  })

  it('stays a plain no-results hint without the referral route', async () => {
    // an older host or a test harness without the route keeps the old shape
    await render({ onAskAi: undefined })
    expect(container.querySelector('.search-ask-referral')).toBeNull()
    expect(container.querySelector('.search-empty')).toBeTruthy()
  })

  it('shows no referral for an empty query — there is nothing to ask', async () => {
    await render({ q: '' })
    expect(container.querySelector('.search-ask-referral')).toBeNull()
  })

  it('shows no referral while the index is still busy', async () => {
    await render({
      searchPage: { ...emptyPage, index: { indexed: 0, pending: 3, scanning: true } },
    })
    expect(container.querySelector('.search-ask-referral')).toBeNull()
  })
})
