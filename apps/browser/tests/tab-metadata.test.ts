import { describe, expect, it } from 'vitest'

import {
  applyNavigation,
  applyPageFavicon,
  applyPageTitle,
  titleFallback,
} from '../src/main/tab-metadata'

describe('titleFallback', () => {
  it('uses the hostname of a parseable URL', () => {
    expect(titleFallback('https://example.com/some/long/path')).toBe('example.com')
    expect(titleFallback('http://localhost:3000/')).toBe('localhost')
  })

  it('uses the scheme without its colon for URLs without a host', () => {
    expect(titleFallback('about:blank')).toBe('about')
  })

  it('uses the raw text when it is not a URL, and empty stays empty', () => {
    expect(titleFallback('not a url')).toBe('not a url')
    expect(titleFallback('')).toBe('')
  })
})

describe('applyNavigation', () => {
  it('a new page starts from the host title with no favicon (the old site’s icon must not linger)', () => {
    const before = { title: 'Old Site — Home', faviconUrl: 'https://old.com/favicon.ico' }
    expect(applyNavigation(before, 'https://new.com/article')).toEqual({
      title: 'new.com',
      faviconUrl: null,
    })
  })
})

describe('applyPageTitle', () => {
  it('a real title wins and collapses whitespace', () => {
    const current = { title: 'new.com', faviconUrl: null }
    expect(applyPageTitle(current, '  GenOffice —\nDocs  ', 'https://new.com')).toEqual({
      title: 'GenOffice — Docs',
      faviconUrl: null,
    })
  })

  it('caps runaway titles at 120 characters', () => {
    const long = 'x'.repeat(400)
    expect(
      applyPageTitle({ title: '', faviconUrl: null }, long, 'https://new.com').title,
    ).toHaveLength(120)
  })

  it('an empty title keeps the fallback shape', () => {
    const current = { title: 'example.com', faviconUrl: null }
    expect(applyPageTitle(current, '   ', 'https://example.com')).toEqual({
      title: 'example.com',
      faviconUrl: null,
    })
  })
})

describe('applyPageFavicon', () => {
  it('the last candidate the page announced wins (the most specific size)', () => {
    const current = { title: 'example.com', faviconUrl: null }
    expect(
      applyPageFavicon(current, [
        'https://example.com/favicon-16.png',
        'https://example.com/favicon-64.png',
      ]),
    ).toEqual({ title: 'example.com', faviconUrl: 'https://example.com/favicon-64.png' })
  })

  it('an empty or malformed list clears the icon', () => {
    const current = { title: 'example.com', faviconUrl: 'https://example.com/favicon.ico' }
    expect(applyPageFavicon(current, [])).toEqual({ title: 'example.com', faviconUrl: null })
    expect(applyPageFavicon(current, [null])).toEqual({ title: 'example.com', faviconUrl: null })
  })
})
