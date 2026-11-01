import { describe, expect, it } from 'vitest'
import type { BrowserAskAboutPayload } from '../src/shared/home-api'
import {
  browserAskEvidenceSuffix,
  browserAskLabelOf,
  browserAskScaffoldParams,
  browserAskUrlOf,
  normalizeBrowserAskAbout,
} from '../src/renderer/src/ask-browser'

/**
 * The "ask AI about this" park (charter W2a/W2b): the browser side pushes an
 * annotation over `browser:ask-about` — the evidence pack (selector, XPath,
 * snippet, note, url, shot path) — the panel normalizes the page-supplied
 * payload and parks a draft question. These are the pure halves: what survives
 * normalization, what the card/scaffold show, and what the evidence line
 * teaches the model.
 */

describe('normalizeBrowserAskAbout', () => {
  it('keeps the well-formed string fields, evidence pack included', () => {
    const draft = normalizeBrowserAskAbout({
      id: 'ann-1',
      selector: 'p:nth-of-type(3)',
      xpath: '/html/body/p[3]',
      textSnippet: 'quarterly revenue',
      note: 'what does this mean?',
      url: 'https://example.com/report',
      shotPath: 'annotation-shots/ann-1.png',
    })
    expect(draft).toEqual({
      id: 'ann-1',
      selector: 'p:nth-of-type(3)',
      xpath: '/html/body/p[3]',
      textSnippet: 'quarterly revenue',
      note: 'what does this mean?',
      url: 'https://example.com/report',
      shotPath: 'annotation-shots/ann-1.png',
    })
  })

  it('drops non-string fields and trims empties', () => {
    const draft = normalizeBrowserAskAbout({
      selector: 7,
      textSnippet: '  ',
      note: 'keep me',
      url: 42,
      id: 9,
      xpath: '  ',
      shotPath: '   ',
      extra: 'ignored',
    })
    expect(draft).toEqual({ note: 'keep me' })
  })

  it('clips over-long fields', () => {
    const draft = normalizeBrowserAskAbout({
      note: 'n'.repeat(500),
      textSnippet: 's'.repeat(500),
      url: 'u'.repeat(1000),
      xpath: 'x'.repeat(500),
      shotPath: 'p'.repeat(500),
    })
    expect(draft!.note!.length).toBe(200)
    expect(draft!.textSnippet!.length).toBe(200)
    expect(draft!.xpath!.length).toBe(200)
    expect(draft!.url!.length).toBe(400)
    expect(draft!.shotPath!.length).toBe(300)
  })

  it('answers null for shapes with nothing usable', () => {
    expect(normalizeBrowserAskAbout(null)).toBeNull()
    expect(normalizeBrowserAskAbout('text')).toBeNull()
    expect(normalizeBrowserAskAbout({})).toBeNull()
    expect(normalizeBrowserAskAbout({ url: 'https://example.com/' })).toBeNull()
    // the pack's fields alone are not a usable annotation: the note,
    // snippet or selector must carry something
    expect(normalizeBrowserAskAbout({ id: 'ann-1', xpath: '/html/body/p[1]' })).toBeNull()
    expect(normalizeBrowserAskAbout({ selector: '   ' })).toBeNull()
  })
})

describe('the card and scaffold views of a parked draft', () => {
  const draft: BrowserAskAboutPayload = {
    selector: 'p:nth-of-type(3)',
    textSnippet: 'quarterly revenue',
    note: 'what does this mean?',
    url: 'https://example.com/report/',
  }

  it('the label prefers the note, then the snippet, then the selector', () => {
    expect(browserAskLabelOf(draft)).toBe('what does this mean?')
    expect(browserAskLabelOf({ textSnippet: 'quarterly revenue' })).toBe('quarterly revenue')
    expect(browserAskLabelOf({ selector: 'p:nth-of-type(3)' })).toBe('p:nth-of-type(3)')
    expect(browserAskLabelOf({ note: 'x' })).toBe('x')
  })

  it('the url view strips the scheme and trailing slash', () => {
    expect(browserAskUrlOf(draft)).toBe('example.com/report')
    expect(browserAskUrlOf({ note: 'x' })).toBe('(no URL)')
  })

  it('the scaffold joins note and snippet and falls back to the selector', () => {
    expect(browserAskScaffoldParams(draft)).toEqual({
      content: 'what does this mean? — quarterly revenue',
      url: 'https://example.com/report/',
    })
    expect(browserAskScaffoldParams({ textSnippet: 'only a snippet' })).toEqual({
      content: 'only a snippet',
      url: '(no URL)',
    })
    expect(browserAskScaffoldParams({ selector: '#q' })).toEqual({
      content: '#q',
      url: '(no URL)',
    })
  })

  it('the evidence suffix teaches the model the addressing keys and the shot', () => {
    expect(
      browserAskEvidenceSuffix({
        id: 'ann-1',
        selector: '#buy',
        xpath: '/html/body/form/button[1]',
        note: 'check this',
        shotPath: 'annotation-shots/ann-1.png',
      }),
    ).toBe(
      'Marked element — selector #buy; xpath /html/body/form/button[1]; ' +
        'annotation id ann-1; its pin-time screenshot is attached to this question.',
    )
    // only the fields that exist ride along
    expect(browserAskEvidenceSuffix({ selector: '#buy' })).toBe('Marked element — selector #buy.')
    expect(browserAskEvidenceSuffix({ note: 'x' })).toBe('')
  })
})
