import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DOCK_PREFS_KEY, readDockPrefs } from '../src/main/dock-prefs'
import {
  DOCK_BASE_DEFAULT,
  DOCK_BASE_MAX,
  DOCK_BASE_MIN,
  DOCK_MAX_SCALE_DEFAULT,
  DOCK_MAX_SCALE_MAX,
  DOCK_MAX_SCALE_MIN,
  DOCK_OPEN_NONE,
  asDockOpenState,
  normalizeDockPrefs,
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
