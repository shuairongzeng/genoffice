import { describe, expect, it } from 'vitest'

import {
  decideNavigation,
  decideWindowOpen,
  isPaletteSummonChord,
} from '../src/main/navigation-policy'

describe('decideNavigation (will-navigate)', () => {
  it('allows page schemes to navigate in the same tab', () => {
    expect(decideNavigation('https://example.com/next')).toEqual({ action: 'allow' })
    expect(decideNavigation('http://example.com/next')).toEqual({ action: 'allow' })
  })

  it('refuses page-initiated file: navigation — the address bar is the only file: entry', () => {
    expect(decideNavigation('file:///Users/x/page.html')).toEqual({ action: 'deny' })
    expect(decideNavigation('file:///Users/x/../../etc/passwd')).toEqual({ action: 'deny' })
  })

  it('hands hand-off schemes to the OS, not the tab', () => {
    expect(decideNavigation('mailto:someone@example.com')).toEqual({ action: 'external' })
    expect(decideNavigation('tel:+15551234567')).toEqual({ action: 'external' })
  })

  it('refuses everything else', () => {
    expect(decideNavigation('javascript:alert(1)')).toEqual({ action: 'deny' })
    expect(decideNavigation('data:text/html,hi')).toEqual({ action: 'deny' })
    expect(decideNavigation('about:blank')).toEqual({ action: 'deny' })
    expect(decideNavigation('chrome://settings')).toEqual({ action: 'deny' })
  })

  it('refuses unparseable urls', () => {
    expect(decideNavigation('http://[bad')).toEqual({ action: 'deny' })
    expect(decideNavigation('not a url')).toEqual({ action: 'deny' })
  })
})

describe('decideWindowOpen (setWindowOpenHandler)', () => {
  it('http and https pop-ups become browser tabs of the strip', () => {
    expect(decideWindowOpen('https://example.com/popup')).toEqual({ action: 'tab' })
    expect(decideWindowOpen('http://example.com/popup')).toEqual({ action: 'tab' })
  })

  it('hand-off schemes go to the OS with no tab', () => {
    expect(decideWindowOpen('mailto:someone@example.com')).toEqual({ action: 'external' })
    expect(decideWindowOpen('sms:+15551234567')).toEqual({ action: 'external' })
  })

  it('opens nothing for anything else (the opener handle is dropped with the deny)', () => {
    expect(decideWindowOpen('about:blank')).toEqual({ action: 'deny' })
    expect(decideWindowOpen('javascript:window.close()')).toEqual({ action: 'deny' })
    expect(decideWindowOpen('file:///etc/passwd')).toEqual({ action: 'deny' })
  })
})

describe('isPaletteSummonChord (page-view Ctrl/Cmd+K)', () => {
  const base = {
    type: 'keyDown',
    control: true,
    meta: false,
    shift: false,
    alt: false,
    key: 'k',
  }

  it('matches plain Ctrl+K and Cmd+K, both keyDown and rawKeyDown', () => {
    expect(isPaletteSummonChord(base)).toBe(true)
    expect(isPaletteSummonChord({ ...base, meta: true, control: false })).toBe(true)
    expect(isPaletteSummonChord({ ...base, type: 'rawKeyDown' })).toBe(true)
    expect(isPaletteSummonChord({ ...base, key: 'K' })).toBe(true)
  })

  it('yields for modifier variants, other keys, and non-key events', () => {
    expect(isPaletteSummonChord({ ...base, shift: true })).toBe(false)
    expect(isPaletteSummonChord({ ...base, alt: true })).toBe(false)
    expect(isPaletteSummonChord({ ...base, key: 'j' })).toBe(false)
    expect(isPaletteSummonChord({ ...base, control: false, meta: false })).toBe(false)
    expect(isPaletteSummonChord({ ...base, type: 'char' })).toBe(false)
    expect(isPaletteSummonChord({ ...base, type: 'keyUp' })).toBe(false)
  })
})
