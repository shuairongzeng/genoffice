// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'

import { buildXPath, nthOfName, resolvesUniquelyX } from '../src/preload/annotate/xpath'

/**
 * XPath generation for the annotation picker: the absolute `/html/body/…`
 * path with positional predicates, the shortest-unique preference, and the
 * fully-indexed fallback — the pin draft's second addressing key, pinned here
 * so the two (CSS selector + XPath) cannot drift apart in shape or intent.
 */

beforeEach(() => {
  document.head.replaceChildren()
  document.body.innerHTML = ''
})

describe('buildXPath', () => {
  it('builds the absolute html/body path for a simple document', () => {
    document.body.innerHTML = '<p id="only">hello</p>'
    const el = document.getElementById('only')!
    expect(buildXPath(el)).toBe('/html/body/p')
  })

  it('pins a 1-based predicate wherever the tag repeats among siblings', () => {
    document.body.innerHTML = '<div><ul><li>a</li><li>b</li><li>c</li></ul></div>'
    const items = document.querySelectorAll('li')
    expect(buildXPath(items[2]!)).toBe('/html/body/div/ul/li[3]')
    expect(buildXPath(items[0]!)).toBe('/html/body/div/ul/li[1]')
  })

  it('skips the predicate when the element is the only child of its tag', () => {
    document.body.innerHTML = '<section><h1>t</h1><p>only</p></section>'
    const el = document.querySelector('section p')!
    expect(buildXPath(el)).toBe('/html/body/section/p')
  })

  it('addresses a same-tag sibling group without disturbing other tags', () => {
    document.body.innerHTML = '<main><span>a</span><b>x</b><span>b</span></main>'
    const spans = document.querySelectorAll('span')
    expect(buildXPath(spans[1]!)).toBe('/html/body/main/span[2]')
    expect(buildXPath(document.querySelector('b')!)).toBe('/html/body/main/b')
  })

  it('resolves uniquely back to the element it was built from', () => {
    document.body.innerHTML = `
      <div><div><span>deep</span></div></div>
      <div><span>other</span></div>
    `
    const el = document.querySelector('div > div > span')!
    const path = buildXPath(el)
    expect(resolvesUniquelyX(document, path, el)).toBe(true)
    // and it does not resolve to the other span
    const other = document.querySelectorAll('span')[1]!
    expect(resolvesUniquelyX(document, path, other)).toBe(false)
  })

  it('answers a unique path for the document element itself', () => {
    expect(buildXPath(document.documentElement)).toBe('/html')
  })

  it('keeps the path bounded when the tree is deeper than the climb cap', () => {
    // 80 nested divs: the climb stops after 30 ancestors, so the path is a
    // root-anchored but truncated one — evidence of the element's
    // neighborhood, not a promise that it still resolves (the same
    // best-effort deal selector.ts's structural path makes past its cap)
    let root: Element = document.body
    let target: Element | null = null
    for (let i = 0; i < 80; i += 1) {
      const div = document.createElement('div')
      root.appendChild(div)
      root = div
      if (i === 79) target = div
    }
    const path = buildXPath(target!)
    expect(path).toMatch(/^\/div(\[\d+])?(\/div(\[\d+])?)*$/)
    // the chain is capped at 30 ancestors: 30 segments, root-anchored
    expect(path.split('/')).toHaveLength(31)
    // within the cap the same tree answers a unique root-anchored path
    document.body.replaceChildren()
    let node: Element = document.body
    for (let i = 0; i < 10; i += 1) {
      const div = document.createElement('div')
      node.appendChild(div)
      node = div
    }
    expect(buildXPath(node)).toBe(`/html/body${'/div'.repeat(10)}`)
    expect(resolvesUniquelyX(document, buildXPath(node), node)).toBe(true)
  })
})

describe('nthOfName', () => {
  it('counts 1-based among same-localName siblings only', () => {
    document.body.innerHTML = '<ul><li>a</li><em>x</em><li>b</li></ul>'
    const children = document.querySelector('ul')!.children
    expect(nthOfName(children[0]!)).toBe(1)
    expect(nthOfName(children[1]!)).toBe(1)
    expect(nthOfName(children[2]!)).toBe(2)
  })

  it('answers 1 for the document element (no parent)', () => {
    expect(nthOfName(document.documentElement)).toBe(1)
  })
})
