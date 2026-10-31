// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  homeViewReducer,
  initialHomeViewState,
  readLaunchView,
  type HomeViewAction,
  type HomeViewState,
} from '../src/renderer/src/home-view'

/**
 * The content-column state machine after the workbench split: the knowledge-
 * base ask panel moved out of the surfaces (it is the docked AI panel now),
 * so exactly four surfaces remain and nothing can switch to a fifth. A
 * launch preference of 'ask' — stored by a build before the split — must not
 * land Home in a state with no panel: it maps to the Recent list, whose
 * neighbor the dock always is.
 */

const at = (
  surface: HomeViewState['surface'],
  patch: Partial<HomeViewState> = {},
): HomeViewState => ({
  surface,
  list: 'recent',
  folder: null,
  ...patch,
})

describe('readLaunchView', () => {
  it('reads each stored top-level view', () => {
    localStorage.setItem('home.view', 'recent')
    expect(readLaunchView()).toBe('recent')
    localStorage.setItem('home.view', 'starred')
    expect(readLaunchView()).toBe('starred')
    localStorage.setItem('home.view', 'cloud')
    expect(readLaunchView()).toBe('cloud')
    localStorage.setItem('home.view', 'desktop')
    expect(readLaunchView()).toBe('desktop')
  })

  it("maps a stored 'ask' onto the Recent list — the panel is the dock now", () => {
    localStorage.setItem('home.view', 'ask')
    expect(readLaunchView()).toBe('recent')
  })

  it('falls back to the desktop on an absent or corrupt value', () => {
    localStorage.removeItem('home.view')
    expect(readLaunchView()).toBe('desktop')
    localStorage.setItem('home.view', 'nonsense')
    expect(readLaunchView()).toBe('desktop')
  })
})

describe('initialHomeViewState', () => {
  it.each(['desktop', 'recent', 'starred', 'cloud'] as const)(
    'maps %s onto its surface',
    (view) => {
      const state = initialHomeViewState(view)
      expect(state.surface).toBe(view === 'starred' || view === 'recent' ? 'list' : view)
      expect(state.list).toBe(view === 'starred' ? 'starred' : 'recent')
      expect(state.folder).toBeNull()
    },
  )
})

describe('homeViewReducer', () => {
  it('a surface switch drops the folder path; a non-switching update keeps the mode', () => {
    const foldered = homeViewReducer(at('folder', { folder: '/docs' }), {
      type: 'show-list',
      list: 'starred',
    })
    expect(foldered).toEqual({ surface: 'list', list: 'starred', folder: null })

    const rebased = homeViewReducer(foldered, { type: 'set-folder', dir: '/docs/q3' })
    expect(rebased).toEqual({ surface: 'folder', list: 'starred', folder: '/docs/q3' })
  })

  it('set-folder null falls back to the list only from the folder surface', () => {
    const fromFolder = homeViewReducer(at('folder', { folder: '/docs' }), {
      type: 'set-folder',
      dir: null,
    })
    expect(fromFolder.surface).toBe('list')
    expect(fromFolder.folder).toBeNull()

    // a no-op keeps the state's reference: memoized children keep their props
    const fromList = at('list')
    expect(homeViewReducer(fromList, { type: 'set-folder', dir: null })).toBe(fromList)
    const fromDesktop = at('desktop')
    expect(homeViewReducer(fromDesktop, { type: 'set-folder', dir: null })).toBe(fromDesktop)
  })

  it('show-desktop and show-cloud clear the folder; exit-cloud only leaves the cloud', () => {
    expect(homeViewReducer(at('folder', { folder: '/docs' }), { type: 'show-desktop' })).toEqual(
      at('desktop'),
    )
    expect(homeViewReducer(at('folder', { folder: '/docs' }), { type: 'show-cloud' })).toEqual(
      at('cloud'),
    )
    expect(homeViewReducer(at('cloud'), { type: 'exit-cloud' })).toEqual(at('list'))
    // the remembered list mode survives the cloud round trip
    const remembered = homeViewReducer(at('cloud', { list: 'starred' }), { type: 'exit-cloud' })
    expect(remembered).toEqual(at('list', { list: 'starred' }))
    const onList = at('list')
    expect(homeViewReducer(onList, { type: 'exit-cloud' })).toBe(onList)
    const onDesktop = at('desktop')
    expect(homeViewReducer(onDesktop, { type: 'exit-cloud' })).toBe(onDesktop)
  })

  it('every action keeps exactly one of the four surfaces', () => {
    const actions: HomeViewAction[] = [
      { type: 'show-desktop' },
      { type: 'show-list', list: 'recent' },
      { type: 'show-list', list: 'starred' },
      { type: 'select-folder', dir: '/docs' },
      { type: 'set-folder', dir: null },
      { type: 'set-folder', dir: '/docs/sub' },
      { type: 'show-cloud' },
      { type: 'exit-cloud' },
    ]
    const surfaces = new Set(['desktop', 'list', 'folder', 'cloud'])
    for (const action of actions) {
      const next = homeViewReducer(at('folder', { folder: '/docs' }), action)
      expect(surfaces).toContain(next.surface)
    }
  })
})
