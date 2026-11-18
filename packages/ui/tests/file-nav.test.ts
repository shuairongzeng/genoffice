import { describe, expect, it, vi } from 'vitest'
import {
  FILE_NAV_SCHEME,
  createFileNav,
  fileNavHref,
  parseFileNavHref,
  parseFileNavText,
} from '../src/file-nav'

describe('filenav href generation', () => {
  it('keeps a plain POSIX path readable', () => {
    expect(fileNavHref('/Users/me/report.docx')).toBe('filenav:///Users/me/report.docx')
  })

  it('encodes spaces, parens and CJK so the markdown link regex accepts the href', () => {
    const href = fileNavHref('/Users/\u738b\u5c0f\u660e/\u62a5\u544a (final v2).docx')
    // nothing left that the inline-link href grammar rejects: no space, no raw paren
    expect(href).not.toMatch(/[\s()]/)
    // encodeURIComponent already handles spaces/CJK; parens are encoded on top
    expect(href).toBe(
      'filenav:///Users/%E7%8E%8B%E5%B0%8F%E6%98%8E/%E6%8A%A5%E5%91%8A%20%28final%20v2%29.docx',
    )
  })

  it('round-trips through parseFileNavHref exactly', () => {
    const paths = [
      '/Users/me/report.docx',
      '/Users/\u738b\u5c0f\u660e/\u62a5\u544a (final v2).docx',
      '/tmp/50%off (1).md',
      "/tmp/odd'!*.pdf",
    ]
    for (const path of paths) expect(parseFileNavHref(fileNavHref(path))).toBe(path)
  })
})

describe('filenav text fragments (issue #56 deep links)', () => {
  it('appends the matched text as a :~:text= fragment, href-grammar safe', () => {
    const href = fileNavHref(
      '/Users/me/\u62a5\u544a (v2).docx',
      '\u5b63\u5ea6 \u6c47\u603b (draft)',
    )
    // the inline-link grammar rejects spaces and raw parens \u2014 neither may leak
    // into the href through the fragment
    expect(href).not.toMatch(/[\s()]/)
    expect(href.startsWith('filenav:///Users/me/%E6%8A%A5%E5%91%8A%20%28v2%29.docx')).toBe(true)
    expect(href).toContain('#:~:text=')
    // the fragment percent-encodes the same way the path does
    expect(href.endsWith('%E5%AD%A3%E5%BA%A6%20%E6%B1%87%E6%80%BB%20%28draft%29')).toBe(true)
  })

  it('drops an empty or whitespace-only text instead of carrying a stub fragment', () => {
    expect(fileNavHref('/a/report.docx', '')).toBe('filenav:///a/report.docx')
    expect(fileNavHref('/a/report.docx', '   ')).toBe('filenav:///a/report.docx')
    expect(fileNavHref('/a/report.docx', undefined)).toBe('filenav:///a/report.docx')
  })

  it('parseFileNavHref returns the path half; parseFileNavText the decoded fragment', () => {
    const href = fileNavHref('/Users/me/notes.md', 'the matched sentence')
    expect(parseFileNavHref(href)).toBe('/Users/me/notes.md')
    expect(parseFileNavText(href)).toBe('the matched sentence')
    // the two halves are independently decodable \u2014 a path with '#' in it
    // percent-escapes, so the split at the first raw '#' is unambiguous
    const hashPath = fileNavHref('/tmp/a#b.md', 'needle')
    expect(parseFileNavHref(hashPath)).toBe('/tmp/a#b.md')
    expect(parseFileNavText(hashPath)).toBe('needle')
  })

  it('a hand-written raw # in the path half survives the fragment split', () => {
    // the split is at the '#:~:text=' marker, not at any '#': a hand-written
    // (unencoded) '#' in the path keeps it, fragment or not. Splitting at any
    // '#' would truncate this path to '/tmp/a' and the fragment to 'b.md'.
    const handWritten = 'filenav:///tmp/a#b.md#:~:text=needle'
    expect(parseFileNavHref(handWritten)).toBe('/tmp/a#b.md')
    expect(parseFileNavText(handWritten)).toBe('needle')
    // no fragment: the whole href is path, '#' included
    expect(parseFileNavHref('filenav:///tmp/a#b.md')).toBe('/tmp/a#b.md')
    expect(parseFileNavText('filenav:///tmp/a#b.md')).toBeNull()
  })

  it('a fragment-less href has no text; a foreign fragment is not a text target', () => {
    expect(parseFileNavText(fileNavHref('/a/report.docx'))).toBeNull()
    expect(parseFileNavText('filenav:///a/report.docx#page=3')).toBeNull()
    expect(parseFileNavText('filenav:///a/report.docx#:~:text=')).toBe('')
    // hand-written raw (unencoded) fragment text passes through like raw paths
    expect(parseFileNavText('filenav:///a/report.docx#:~:text=raw needle')).toBe('raw needle')
  })

  it('parseFileNavHref keeps its old contract on fragment-carrying and malformed hrefs', () => {
    expect(parseFileNavHref('filenav://')).toBeNull()
    expect(parseFileNavHref('docnav://block/3')).toBeNull()
    expect(parseFileNavHref('filenav:///a b/report.docx#:~:text=x')).toBe('/a b/report.docx')
  })
})

describe('filenav href parsing', () => {
  it('decodes an encoded href', () => {
    expect(parseFileNavHref('filenav:///a%20b/(1).docx')).toBe('/a b/(1).docx')
  })

  it('passes a raw hand-written href through when it has no valid percent escapes', () => {
    expect(parseFileNavHref('filenav:///a b/report.docx')).toBe('/a b/report.docx')
  })

  it('rejects other schemes and empty paths', () => {
    expect(parseFileNavHref('docnav://block/3')).toBeNull()
    expect(parseFileNavHref('filenav://')).toBeNull()
    expect(parseFileNavHref('https://example.com/x.pdf')).toBeNull()
  })
})

describe('createFileNav', () => {
  it('opens the decoded path of a matching href', () => {
    const openPath = vi.fn()
    const nav = createFileNav(openPath)
    expect(nav.scheme).toBe(FILE_NAV_SCHEME)
    nav.onNavigate(fileNavHref('/Users/me/\u5b63\u5ea6\u62a5\u544a (2).xlsx'))
    // a fragment-less cite keeps the exact one-argument call shape
    expect(openPath).toHaveBeenCalledWith('/Users/me/\u5b63\u5ea6\u62a5\u544a (2).xlsx')
  })

  it('forwards a fragment target alongside the path; hosts may ignore it', () => {
    const openPath = vi.fn()
    createFileNav(openPath).onNavigate(fileNavHref('/Users/me/notes.md', 'the hit'))
    expect(openPath).toHaveBeenCalledWith('/Users/me/notes.md', 'the hit')
    // an empty fragment decodes to no target, not to an empty string
    createFileNav(openPath).onNavigate('filenav:///Users/me/notes.md#:~:text=')
    expect(openPath).toHaveBeenLastCalledWith('/Users/me/notes.md')
  })

  it('ignores hrefs without a path or of another scheme', () => {
    const openPath = vi.fn()
    createFileNav(openPath).onNavigate('docnav://block/3')
    createFileNav(openPath).onNavigate('filenav://')
    expect(openPath).not.toHaveBeenCalled()
  })
})
