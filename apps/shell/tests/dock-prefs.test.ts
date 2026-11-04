import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { applyDockOrder } from '../src/renderer/src/dock-math'
import { DOCK_PREFS_KEY, readDockPrefs } from '../src/main/dock-prefs'
import {
  DOCK_BASE_DEFAULT,
  DOCK_BASE_MAX,
  DOCK_BASE_MIN,
  DOCK_CUSTOM_CAP,
  DOCK_MAX_SCALE_DEFAULT,
  DOCK_MAX_SCALE_MAX,
  DOCK_MAX_SCALE_MIN,
  DOCK_OPEN_NONE,
  addDockCustom,
  asDockCustomItem,
  asDockOpenState,
  dockCustomId,
  normalizeDockPrefs,
  removeDockCustom,
  sameDockPrefs,
} from '../src/shared/dock-prefs'

/**
 * The dock's own settings store (shared/dock-prefs.ts + main/dock-prefs.ts):
 * the normalizer every malformed hand-edit funnels through (a hand-edited
 * settings file must never push a degenerate number into the pill math or
 * the overlay's rect), the watcher's equality gate, and the main-side read
 * that lands app-settings.json's `dockPrefs` on the same rails.
 */

let dir: string | undefined

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = undefined
  }
})

describe('normalizeDockPrefs', () => {
  it('fills every default on an absent or empty value', () => {
    for (const empty of [undefined, null, {}, 'x']) {
      expect(normalizeDockPrefs(empty)).toEqual({
        magnify: true,
        baseSize: 48,
        maxScale: 1.7,
        autoHide: false,
        order: [],
        customItems: [],
      })
    }
  })

  it('clamps the sliders into their ranges, whole-pixel steps', () => {
    const prefs = normalizeDockPrefs({ baseSize: 999, maxScale: 0.1 })
    expect(prefs.baseSize).toBe(DOCK_BASE_MAX)
    expect(prefs.maxScale).toBe(DOCK_MAX_SCALE_MIN)
    const low = normalizeDockPrefs({ baseSize: 1, maxScale: 99 })
    expect(low.baseSize).toBe(DOCK_BASE_MIN)
    expect(low.maxScale).toBe(DOCK_MAX_SCALE_MAX)
    // fractional steps survive where they are legal (the strength slider
    // steps by 0.05); NaN and junk fall to the defaults
    expect(normalizeDockPrefs({ maxScale: 1.35 }).maxScale).toBe(1.35)
    expect(normalizeDockPrefs({ baseSize: Number.NaN, maxScale: 'big' })).toEqual(
      normalizeDockPrefs(undefined),
    )
  })

  it('reads the switches strictly: only false/true count, anything else defaults', () => {
    expect(normalizeDockPrefs({ magnify: false }).magnify).toBe(false)
    expect(normalizeDockPrefs({ autoHide: true }).autoHide).toBe(true)
    expect(normalizeDockPrefs({ magnify: 'off', autoHide: 1 }).magnify).toBe(true)
    expect(normalizeDockPrefs({ magnify: 'off', autoHide: 1 }).autoHide).toBe(false)
  })

  it('the order: strings only, deduped, anything else dropped', () => {
    expect(normalizeDockPrefs({ order: ['b', 'a', 'b', 7, '', 'a'] }).order).toEqual(['b', 'a'])
    expect(normalizeDockPrefs({ order: 'recent-first' }).order).toEqual([])
  })
})

describe('the dragged-in custom launchers (dockPrefs.customItems)', () => {
  const fileItem = { id: dockCustomId('file', '/docs/a.md'), kind: 'file', target: '/docs/a.md' }
  const folderItem = {
    id: dockCustomId('folder', '/desk'),
    kind: 'folder',
    target: '/desk',
  } as const
  const appItem = { id: dockCustomId('app', 'app:docs'), kind: 'app', target: 'app:docs' } as const

  it('asDockCustomItem accepts the three kinds, whole; anything else is null', () => {
    expect(asDockCustomItem(fileItem)).toEqual(fileItem)
    expect(asDockCustomItem(folderItem)).toEqual(folderItem)
    expect(asDockCustomItem(appItem)).toEqual(appItem)
    for (const bad of [
      null,
      'file',
      {},
      { ...fileItem, id: 'dock:custom:other' },
      { ...fileItem, kind: 'widget' },
      { ...fileItem, target: '' },
      { ...fileItem, target: 7 },
      { id: 'dock:custom:file:', kind: 'file', target: '' },
    ]) {
      expect(asDockCustomItem(bad)).toBeNull()
    }
  })

  it('the id is pinned to the pair: dockCustomId derives it, drift drops the item', () => {
    expect(dockCustomId('file', '/docs/a.md')).toBe('dock:custom:file:/docs/a.md')
    expect(dockCustomId('app', 'app:docs')).toBe('dock:custom:app:app:docs')
    // a hand-edited id that no longer names its own kind and target drops
    expect(asDockCustomItem({ ...fileItem, id: 'dock:custom:folder:/docs/a.md' })).toBeNull()
  })

  it('normalize validates, dedupes and caps the list; the order gains each id exactly once', () => {
    const junk = [
      fileItem,
      fileItem,
      { ...appItem, kind: 'app' },
      'x',
      null,
      { ...appItem, id: 'drifted' },
    ]
    const prefs = normalizeDockPrefs({ customItems: junk, order: ['dock:ask'] })
    expect(prefs.customItems).toEqual([fileItem, appItem])
    // the consistency rule: the custom ids ride the order sequence, the
    // person's own arrangement untouched ahead of them
    expect(prefs.order).toEqual(['dock:ask', fileItem.id, appItem.id])
    // a custom the order already ranks stays where the person put it — once
    const ranked = normalizeDockPrefs({
      customItems: [appItem, fileItem],
      order: [fileItem.id, 'dock:ask', fileItem.id],
    })
    expect(ranked.order).toEqual([fileItem.id, 'dock:ask', appItem.id])
    // an order entry naming a custom the list dropped ranks nothing and
    // stays tolerated (removing a definition is the remove verb's business)
    const orphan = normalizeDockPrefs({ customItems: [], order: [fileItem.id, 'dock:ask'] })
    expect(orphan.order).toEqual([fileItem.id, 'dock:ask'])
    expect(orphan.customItems).toEqual([])
  })

  it('the cap: at most DOCK_CUSTOM_CAP survive, in stored order', () => {
    const many = Array.from({ length: DOCK_CUSTOM_CAP + 5 }, (_, i) => ({
      id: dockCustomId('file', `/docs/f${i}.md`),
      kind: 'file' as const,
      target: `/docs/f${i}.md`,
    }))
    const prefs = normalizeDockPrefs({ customItems: many })
    expect(prefs.customItems).toHaveLength(DOCK_CUSTOM_CAP)
    expect(prefs.customItems[0]).toEqual(many[0])
    expect(prefs.order).toHaveLength(DOCK_CUSTOM_CAP)
  })

  it('addDockCustom: added joins the end of the list and the order; duplicates and the cap answer honestly', () => {
    const base = normalizeDockPrefs({ order: ['dock:ask'] })
    const first = addDockCustom(base, { kind: 'file', target: '/docs/a.md' })
    expect(first.status).toBe('added')
    expect(first.prefs.customItems).toEqual([fileItem])
    expect(first.prefs.order).toEqual(['dock:ask', fileItem.id])
    // the same drop again: nothing changes, nothing writes
    const again = addDockCustom(first.prefs, { kind: 'file', target: '/docs/a.md' })
    expect(again.status).toBe('duplicate')
    expect(again.prefs).toBe(first.prefs)
    // a candidate the validator refuses answers invalid
    expect(addDockCustom(base, { kind: 'file', target: '' }).status).toBe('invalid')
    // past the cap the drop is refused, the composition stands
    const full = normalizeDockPrefs({
      customItems: Array.from({ length: DOCK_CUSTOM_CAP }, (_, i) => ({
        id: dockCustomId('file', `/docs/f${i}.md`),
        kind: 'file' as const,
        target: `/docs/f${i}.md`,
      })),
    })
    const refused = addDockCustom(full, { kind: 'file', target: '/docs/late.md' })
    expect(refused.status).toBe('full')
    expect(refused.prefs).toBe(full)
  })

  it('removeDockCustom drops the definition and its order entry together; a missing id is a no-op', () => {
    const prefs = normalizeDockPrefs({ customItems: [fileItem, appItem] })
    const next = removeDockCustom(prefs, fileItem.id)
    expect(next.customItems).toEqual([appItem])
    expect(next.order).not.toContain(fileItem.id)
    expect(removeDockCustom(next, fileItem.id)).toBe(next)
  })

  it('a placed insert ranks the whole launchers group explicitly, the newcomer spliced at the index', () => {
    // a fresh store: no launchers ids are listed, so splicing next to a
    // neighbor's rank could not work — the group is ranked whole instead
    const fresh = normalizeDockPrefs(undefined)
    const head = addDockCustom(
      fresh,
      { kind: 'file', target: '/docs/a.md' },
      {
        launchers: ['dock:settings', 'dock:templates', 'dock:plugins'],
        index: 0,
      },
    )
    expect(head.status).toBe('added')
    expect(head.prefs.customItems).toEqual([fileItem])
    expect(head.prefs.order).toEqual([
      'dock:custom:file:/docs/a.md',
      'dock:settings',
      'dock:templates',
      'dock:plugins',
    ])
    // applyDockOrder reproduces the previewed arrangement: the group is
    // ranked in the new sequence (the groups model Home's post-add
    // composition — the customs are the group's coded tail), the others
    // keep their coded places
    expect(
      applyDockOrder(
        [
          ['dock:desktop', 'dock:recent'],
          ['dock:settings', 'dock:templates', 'dock:plugins', 'dock:custom:file:/docs/a.md'],
          ['dock:ask'],
        ],
        head.prefs.order,
      ),
    ).toEqual([
      ['dock:desktop', 'dock:recent'],
      ['dock:custom:file:/docs/a.md', 'dock:settings', 'dock:templates', 'dock:plugins'],
      ['dock:ask'],
    ])
    // between two members, past the last (the gap before ask), and a clamped
    // out-of-range index
    expect(
      addDockCustom(
        fresh,
        { kind: 'file', target: '/docs/a.md' },
        {
          launchers: ['dock:settings', 'dock:templates', 'dock:plugins'],
          index: 2,
        },
      ).prefs.order,
    ).toEqual(['dock:settings', 'dock:templates', 'dock:custom:file:/docs/a.md', 'dock:plugins'])
    expect(
      addDockCustom(
        fresh,
        { kind: 'file', target: '/docs/a.md' },
        {
          launchers: ['dock:settings', 'dock:templates', 'dock:plugins'],
          index: 3,
        },
      ).prefs.order,
    ).toEqual(['dock:settings', 'dock:templates', 'dock:plugins', 'dock:custom:file:/docs/a.md'])
    expect(
      addDockCustom(
        fresh,
        { kind: 'file', target: '/docs/a.md' },
        {
          launchers: ['dock:settings'],
          index: 99,
        },
      ).prefs.order,
    ).toEqual(['dock:settings', 'dock:custom:file:/docs/a.md'])
  })

  it('a placed insert among already-arranged customs keeps their sequence and the others intact', () => {
    // the store holds an arranged nav and a launchers sequence with an
    // existing custom; the newcomer takes a middle gap (the place's
    // launchers are the DISPLAYED sequence, the same applyDockOrder output
    // Home feeds it) without disturbing either
    const prefs = normalizeDockPrefs({
      order: ['dock:recent', 'dock:desktop', 'dock:settings', 'dock:custom:app:app:docs'],
    })
    const placed = addDockCustom(
      prefs,
      { kind: 'file', target: '/docs/a.md' },
      {
        launchers: ['dock:settings', 'dock:templates', 'dock:plugins', 'dock:custom:app:app:docs'],
        index: 2,
      },
    )
    expect(placed.prefs.order).toEqual([
      'dock:recent',
      'dock:desktop',
      'dock:settings',
      'dock:templates',
      'dock:custom:file:/docs/a.md',
      'dock:plugins',
      'dock:custom:app:app:docs',
    ])
    // the block may sit anywhere in the flat sequence: ranks only matter
    // within a group, and the displayed groups follow
    expect(
      applyDockOrder(
        [
          ['dock:desktop', 'dock:recent'],
          [
            'dock:settings',
            'dock:templates',
            'dock:plugins',
            'dock:custom:app:app:docs',
            'dock:custom:file:/docs/a.md',
          ],
          ['dock:ask'],
        ],
        placed.prefs.order,
      ),
    ).toEqual([
      ['dock:recent', 'dock:desktop'],
      [
        'dock:settings',
        'dock:templates',
        'dock:custom:file:/docs/a.md',
        'dock:plugins',
        'dock:custom:app:app:docs',
      ],
      ['dock:ask'],
    ])
  })

  it('sameDockPrefs counts the customs by exact sequence', () => {
    const base = normalizeDockPrefs({ customItems: [fileItem] })
    expect(sameDockPrefs(base, normalizeDockPrefs({ customItems: [fileItem] }))).toBe(true)
    expect(sameDockPrefs(base, normalizeDockPrefs({ customItems: [appItem] }))).toBe(false)
    expect(sameDockPrefs(base, normalizeDockPrefs({ customItems: [fileItem, appItem] }))).toBe(
      false,
    )
    expect(
      sameDockPrefs(
        normalizeDockPrefs({ customItems: [fileItem, appItem] }),
        normalizeDockPrefs({ customItems: [appItem, fileItem] }),
      ),
    ).toBe(false)
  })

  it('readDockPrefs lands a stored customs list on the same rails, junk filtered', () => {
    dir = mkdtempSync(join(tmpdir(), 'genoffice-dock-prefs-'))
    const path = join(dir, 'app-settings.json')
    writeFileSync(
      path,
      JSON.stringify({
        [DOCK_PREFS_KEY]: {
          order: ['dock:ask'],
          customItems: [fileItem, { id: 'drifted', kind: 'file', target: '/x' }, appItem],
        },
      }),
    )
    expect(readDockPrefs(path)).toEqual({
      magnify: true,
      baseSize: DOCK_BASE_DEFAULT,
      maxScale: DOCK_MAX_SCALE_DEFAULT,
      autoHide: false,
      order: ['dock:ask', fileItem.id, appItem.id],
      customItems: [fileItem, appItem],
    })
  })
})

describe('sameDockPrefs (the watcher dedup gate)', () => {
  it('every field counts, the order by exact sequence', () => {
    const base = normalizeDockPrefs(undefined)
    expect(sameDockPrefs(base, normalizeDockPrefs(undefined))).toBe(true)
    expect(sameDockPrefs(base, normalizeDockPrefs({ magnify: false }))).toBe(false)
    expect(sameDockPrefs(base, normalizeDockPrefs({ baseSize: 56 }))).toBe(false)
    // the same ids in a different order is a different arrangement
    expect(sameDockPrefs(base, normalizeDockPrefs({ order: ['a', 'b'] }))).toBe(false)
    expect(
      sameDockPrefs(
        normalizeDockPrefs({ order: ['a', 'b'] }),
        normalizeDockPrefs({ order: ['b', 'a'] }),
      ),
    ).toBe(false)
    expect(
      sameDockPrefs(
        normalizeDockPrefs({ order: ['a', 'b'] }),
        normalizeDockPrefs({ order: ['a', 'b'] }),
      ),
    ).toBe(true)
  })
})

describe('asDockOpenState (the report validation)', () => {
  it('accepts a whole report and reads it back typed, cloud view included', () => {
    const state = {
      view: 'recent',
      settings: true,
      plugins: false,
      templates: true,
      ask: false,
      loggedIn: true,
    }
    expect(asDockOpenState(state)).toEqual(state)
    expect(asDockOpenState({ ...state, view: 'cloud' })).toEqual({ ...state, view: 'cloud' })
    expect(asDockOpenState(DOCK_OPEN_NONE)).toEqual(DOCK_OPEN_NONE)
  })

  it('rejects half-parsed reports whole, never guessing a field', () => {
    for (const bad of [
      null,
      'open',
      {},
      { view: null },
      { view: 'gdrive', settings: true, plugins: true, templates: true, ask: true, loggedIn: true },
      { view: null, settings: 'yes', plugins: true, templates: true, ask: true, loggedIn: true },
      { view: null, settings: true, plugins: true, templates: true, loggedIn: true },
      { view: null, settings: true, plugins: true, templates: true, ask: undefined },
      { view: null, settings: true, plugins: true, templates: true, ask: true },
    ]) {
      expect(asDockOpenState(bad)).toBeNull()
    }
  })
})

describe('readDockPrefs (the main store read)', () => {
  it('reads the dockPrefs key from app-settings.json, defaults on absence or junk', () => {
    dir = mkdtempSync(join(tmpdir(), 'genoffice-dock-prefs-'))
    const path = join(dir, 'app-settings.json')
    // absent file: the defaults
    expect(readDockPrefs(path)).toEqual(normalizeDockPrefs(undefined))
    // a settled store value, clamped on read like everywhere else
    writeFileSync(
      path,
      JSON.stringify({ [DOCK_PREFS_KEY]: { baseSize: 64, magnify: false, order: ['dock:ask'] } }),
    )
    expect(readDockPrefs(path)).toEqual({
      magnify: false,
      baseSize: 64,
      maxScale: DOCK_MAX_SCALE_DEFAULT,
      autoHide: false,
      order: ['dock:ask'],
      customItems: [],
    })
    // a hand-edited degenerate value never reaches the layout: 0 clamps to
    // the slider's floor, junk falls to the defaults
    writeFileSync(path, JSON.stringify({ [DOCK_PREFS_KEY]: { baseSize: 0, maxScale: 50 } }))
    expect(readDockPrefs(path).baseSize).toBe(DOCK_BASE_MIN)
    expect(readDockPrefs(path).maxScale).toBe(DOCK_MAX_SCALE_MAX)
    writeFileSync(path, JSON.stringify({ [DOCK_PREFS_KEY]: { baseSize: 'huge' } }))
    expect(readDockPrefs(path).baseSize).toBe(DOCK_BASE_DEFAULT)
  })
})
