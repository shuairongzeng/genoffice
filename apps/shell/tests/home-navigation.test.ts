// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { defaultAiSettings } from '@genoffice/ai-provider'
import { Home } from '../src/renderer/src/Home'
import { LocaleProvider } from '../src/renderer/src/locale'
import type { RecentEntry } from '../src/shared/home-api'

let root: Root
let container: HTMLDivElement
const files: RecentEntry[] = [
  {
    path: '/fixtures/brief.docx',
    name: 'brief.docx',
    ext: 'docx',
    mtimeMs: 1,
    sizeBytes: 10,
    starred: true,
  },
  {
    path: '/fixtures/budget.xlsx',
    name: 'budget.xlsx',
    ext: 'xlsx',
    mtimeMs: 2,
    sizeBytes: 20,
    starred: false,
  },
]
const page = (starred: boolean) =>
  vi.fn(async (query: { ext?: string; limit?: number }) => {
    const entries = files.filter(
      (file) => (!starred || file.starred) && (!query.ext || file.ext === query.ext),
    )
    return {
      entries: query.limit === 0 ? [] : entries,
      total: entries.length,
      totalAll: entries.length,
      offset: 0,
    }
  })

beforeEach(async () => {
  HTMLElement.prototype.scrollTo = vi.fn()
  // this suite exercises the list views: land on Recent instead of the desktop
  localStorage.clear()
  localStorage.setItem('home.view', 'recent')
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('No network in navigation tests')
    }),
  )
  window.aiOffice = {
    folderRoots: async () => [],
    onFolderChanged: () => () => {},
    recents: page(false),
    starred: page(true),
    starredGroups: async () => [],
    accountStatus: async () => ({ loggedIn: false }),
    onOpenSettings: () => () => {},
    onAccountLogin: () => () => {},
    kbList: async () => [],
    aiGetSettings: async () => defaultAiSettings(),
    aiGskStatus: async () => ({ loggedIn: false }),
    onAiSettingsChanged: () => () => {},
  } as unknown as Window['aiOffice']
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root.render(createElement(LocaleProvider, { initial: 'en', children: createElement(Home) })),
  )
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
function nav(label: string): HTMLButtonElement {
  return [...container.querySelectorAll<HTMLButtonElement>('.sidebar-nav button')].find(
    (button) => button.querySelector('.nav-label')?.textContent === label,
  )!
}
async function click(button: HTMLButtonElement) {
  expect(button).toBeTruthy()
  await act(async () => button.click())
}
function selected(): string[] {
  return [...container.querySelectorAll('.sidebar-nav .active .nav-label')].map(
    (label) => label.textContent!,
  )
}

describe('Home sidebar navigation', () => {
  it.each(['Recent', 'Starred'])(
    'Ask AI focuses the docked panel without leaving %s',
    async (from) => {
      await click(nav(from))
      expect(selected()).toEqual([from])
      await click(nav('Ask AI'))
      // the ask panel is the workbench's dock, not a surface: the list stays
      // selected, the panel is present from launch, and the composer focused
      expect(container.querySelector('.ai-dock')).not.toBeNull()
      expect(container.querySelector('.kb-ask')).not.toBeNull()
      expect(selected()).toEqual([from])
      expect(document.activeElement).toBe(container.querySelector('.kb-ask textarea'))
      expect(nav('Ask AI').hasAttribute('aria-current')).toBe(false)
      expect(fetch).not.toHaveBeenCalled()
      await click(nav(from))
      expect(selected()).toEqual([from])
      expect(nav(from).getAttribute('aria-current')).toBe('page')
      expect(container.querySelector('.content')?.textContent).toContain('brief.docx')
      if (from === 'Starred')
        expect(container.querySelector('.content')?.textContent).not.toContain('budget.xlsx')
    },
  )

  it('keeps the file-type filter across an Ask AI focus', async () => {
    const docs = [...container.querySelectorAll<HTMLButtonElement>('.filter-pill')].find(
      (button) => button.textContent === 'Docs',
    )!
    await click(docs)
    expect(container.querySelector('.content')?.textContent).toContain('brief.docx')
    expect(container.querySelector('.content')?.textContent).not.toContain('budget.xlsx')
    await click(nav('Ask AI'))
    // no view switch happened, so the list never re-queried either
    await click(nav('Recent'))
    expect(container.querySelector('.filter-pill.active')?.textContent).toBe('Docs')
    expect(container.querySelector('.content')?.textContent).toContain('brief.docx')
    expect(container.querySelector('.content')?.textContent).not.toContain('budget.xlsx')
    expect(window.aiOffice.recents).toHaveBeenLastCalledWith(
      expect.objectContaining({ ext: 'docx' }),
    )
  })

  it("the folders-scope ask panel's CTA opens settings on the General pane", async () => {
    // the panel reads the scope through the bridge on mount; the dock mounts
    // with Home, so the bridge carries the folders scope before the render
    const bridge = window.aiOffice as unknown as Record<string, unknown>
    bridge.getKbScope = async () => 'folders'
    bridge.setKbScope = async () => 'folders'
    bridge.aiGskStatus = async () => ({ loggedIn: true })
    await act(async () => root.unmount())
    container.remove()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () =>
      root.render(createElement(LocaleProvider, { initial: 'en', children: createElement(Home) })),
    )
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    const cta = container.querySelector<HTMLButtonElement>('.kb-ask-cta')!
    expect(cta).toBeTruthy()
    expect(cta.textContent).toBe('Pick folders in Settings')
    await click(cta)
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    // the settings modal opened on the pane that holds the scope group, not
    // the account default or the AI panes
    const active = container.querySelector('.set-nav-item.active')
    expect(active?.textContent).toContain('General')
    expect(container.querySelector('[aria-label="Ask AI corpus scope"]')).not.toBeNull()
  })
})
