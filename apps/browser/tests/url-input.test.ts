import { describe, expect, it } from 'vitest'

import { defaultSearchUrl, resolveAddressInput } from '../src/main/url-input'

/** searches for exactly the trimmed input, URL-encoded */
const searchFor = (query: string): string => defaultSearchUrl(query)

describe('resolveAddressInput — full URLs pass through', () => {
  it('keeps http and https URLs (normalized by the WHATWG parser)', () => {
    expect(resolveAddressInput('https://example.com/a?b=c')).toEqual({
      kind: 'url',
      url: 'https://example.com/a?b=c',
    })
    expect(resolveAddressInput('  http://example.com  ')).toEqual({
      kind: 'url',
      url: 'http://example.com/',
    })
  })

  it('keeps file URLs', () => {
    expect(resolveAddressInput('file:///Users/x/notes.txt')).toEqual({
      kind: 'url',
      url: 'file:///Users/x/notes.txt',
    })
  })

  it('is case-insensitive about the scheme', () => {
    expect(resolveAddressInput('HTTPS://EXAMPLE.COM').kind).toBe('url')
  })
})

describe('resolveAddressInput — bare hosts gain a scheme', () => {
  it('domains go over https', () => {
    expect(resolveAddressInput('genoffice.com')).toEqual({
      kind: 'url',
      url: 'https://genoffice.com',
    })
    expect(resolveAddressInput('docs.python.org/3/library')).toEqual({
      kind: 'url',
      url: 'https://docs.python.org/3/library',
    })
  })

  it('localhost and IPv4 go over plain http (the local-dev shape)', () => {
    expect(resolveAddressInput('localhost:3000')).toEqual({
      kind: 'url',
      url: 'http://localhost:3000',
    })
    expect(resolveAddressInput('localhost')).toEqual({ kind: 'url', url: 'http://localhost' })
    expect(resolveAddressInput('192.168.1.10:8080/admin')).toEqual({
      kind: 'url',
      url: 'http://192.168.1.10:8080/admin',
    })
  })

  it('accepts domains with ports and hyphenated labels', () => {
    expect(resolveAddressInput('my-site.example.com:8443/x')).toEqual({
      kind: 'url',
      url: 'https://my-site.example.com:8443/x',
    })
  })
})

describe('resolveAddressInput — everything else is a search', () => {
  it('multi-word input searches', () => {
    expect(resolveAddressInput('how to tie a tie')).toEqual({
      kind: 'search',
      url: searchFor('how to tie a tie'),
    })
  })

  it('single words without a dot search', () => {
    expect(resolveAddressInput('weather')).toEqual({ kind: 'search', url: searchFor('weather') })
    expect(resolveAddressInput('天气')).toEqual({ kind: 'search', url: searchFor('天气') })
  })

  it('executable and browser-internal schemes never reach the page view', () => {
    expect(resolveAddressInput('javascript:alert(1)')).toEqual({
      kind: 'search',
      url: searchFor('javascript:alert(1)'),
    })
    expect(resolveAddressInput('data:text/html,hi')).toEqual({
      kind: 'search',
      url: searchFor('data:text/html,hi'),
    })
    expect(resolveAddressInput('chrome://settings')).toEqual({
      kind: 'search',
      url: searchFor('chrome://settings'),
    })
  })

  it('a malformed scheme-like string searches rather than navigating', () => {
    expect(resolveAddressInput('http://[bad')).toEqual({
      kind: 'search',
      url: searchFor('http://[bad'),
    })
  })

  it('a host-looking string with a bad port searches', () => {
    expect(resolveAddressInput('example.com:notaport')).toEqual({
      kind: 'search',
      url: searchFor('example.com:notaport'),
    })
  })

  it('empty input searches for nothing (the chrome disables submit; the answer stays well-formed)', () => {
    expect(resolveAddressInput('   ')).toEqual({ kind: 'search', url: searchFor('') })
  })
})

describe('resolveAddressInput — the search engine is injectable', () => {
  it('uses the provided searchUrl builder', () => {
    const custom = resolveAddressInput('hello world', {
      searchUrl: (query) => `https://example.invalid/?q=${query}`,
    })
    expect(custom).toEqual({ kind: 'search', url: 'https://example.invalid/?q=hello world' })
  })
})
