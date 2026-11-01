// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'

import { buildSelector, resolvesUniquely, nthOfType } from '../src/preload/annotate/selector'

/**
 * Selector generation: the id > data-* > semantic class > structural-path
 * strategy, each candidate gated on live uniqueness. Pinned in jsdom because
 * the logic is pure DOM — no Electron, no page.
 */

const mount = (html: string): void => {
  document.head.replaceChildren()
  document.body.innerHTML = html
}

beforeEach(() => {
  mount('<div id="app"></div>')
})

describe('buildSelector — id', () => {
  it('uses a unique id', () => {
    mount('<main><button id="login">Sign in</button></main>')
    const el = document.getElementById('login')!
    expect(buildSelector(el)).toBe('#login')
  })

  it('escapes an id CSS would otherwise choke on', () => {
    mount('<div><p id="a:b">x</p></div>')
    const el = document.querySelector('p')!
    const selector = buildSelector(el)
    expect(selector).toContain('#')
    expect(resolvesUniquely(document, selector, el)).toBe(true)
  })

  it('falls through when the id is not unique (duplicate ids on the page)', () => {
    mount('<div><p id="dup">one</p><p id="dup">two</p></div>')
    const el = document.querySelectorAll('p')[0]!
    const selector = buildSelector(el)
    expect(selector).not.toBe('#dup')
    expect(resolvesUniquely(document, selector, el)).toBe(true)
  })
})

describe('buildSelector — data attributes', () => {
  it('prefers a stable test attribute over classes and paths', () => {
    mount(
      '<section><button class="btn primary" data-testid="submit-btn">Go</button>' +
        '<button class="btn primary">Other</button></section>',
    )
    const el = document.querySelector('[data-testid]')!
    expect(buildSelector(el)).toBe('[data-testid="submit-btn"]')
  })

  it('tag-prefixes the attribute when the bare form matches several tags', () => {
    mount('<div><span data-test="x">a</span><div data-test="x">b</div></div>')
    const el = document.querySelector('span')!
    expect(buildSelector(el)).toBe('span[data-test="x"]')
  })

  it('ignores positional and build-hashed data attributes', () => {
    mount('<ul><li data-index="3" data-v-abc123="s">one</li><li data-index="4">two</li></ul>')
    const el = document.querySelector('li')!
    const selector = buildSelector(el)
    expect(selector).not.toContain('data-index')
    expect(selector).not.toContain('data-v-')
    expect(resolvesUniquely(document, selector, el)).toBe(true)
  })

  it('ignores an empty test attribute', () => {
    mount('<div><p data-testid="">empty</p></div>')
    const el = document.querySelector('p')!
    expect(buildSelector(el)).not.toBe('[data-testid=""]')
  })
})

describe('buildSelector — semantic classes', () => {
  it('combines classes until the match is unique', () => {
    mount(
      '<div><button class="btn primary">one</button>' +
        '<button class="btn primary">two</button>' +
        '<button class="btn ghost">three</button></div>',
    )
    // all three share 'btn'; none is unique — the structural path answers
    const el = document.querySelectorAll('button')[1]!
    const selector = buildSelector(el)
    expect(resolvesUniquely(document, selector, el)).toBe(true)
  })

  it('skips utility and generated class names', () => {
    mount(
      '<div><span class="w-4 css-1a2b3c mt-2 label">one</span>' +
        '<span class="w-4 css-1a2b3c mt-2 label">two</span></div>',
    )
    const el = document.querySelectorAll('span')[1]!
    const selector = buildSelector(el)
    expect(selector).not.toContain('w-4')
    expect(selector).not.toContain('css-1a2b3c')
    expect(selector).not.toContain('mt-2')
    expect(resolvesUniquely(document, selector, el)).toBe(true)
  })

  it('keeps a genuinely semantic class when it is unique', () => {
    mount('<div><button class="checkout-cta">Buy</button><button class="x">No</button></div>')
    const el = document.querySelector('.checkout-cta')!
    expect(buildSelector(el)).toBe('button.checkout-cta')
  })
})

describe('buildSelector — structural path', () => {
  it('indexes repeated tags with nth-of-type', () => {
    mount('<div><p>one</p><p>two</p><p>three</p></div>')
    const el = document.querySelectorAll('p')[1]!
    expect(buildSelector(el)).toBe('p:nth-of-type(2)')
  })

  it('walks up until the path is unique', () => {
    mount(
      '<div><div><span>one</span></div><div><span>two</span></div><div><span>three</span></div></div>',
    )
    const el = document.querySelectorAll('span')[2]!
    const selector = buildSelector(el)
    expect(selector).toContain('nth-of-type(3)')
    expect(resolvesUniquely(document, selector, el)).toBe(true)
  })

  it('leaves bare tags whose sibling set has no other same-tag element', () => {
    mount('<header><h1>title</h1></header><section><h1>other</h1></section>')
    const el = document.querySelectorAll('h1')[1]!
    const selector = buildSelector(el)
    expect(resolvesUniquely(document, selector, el)).toBe(true)
    // h1 is the only h1 inside its section, but 'h1' alone matches twice, so
    // the path must still carry the section discriminator
    expect(selector.length).toBeGreaterThan(2)
  })

  it('always answers a selector that resolves uniquely, however deep the DOM', () => {
    mount(
      '<ul>' +
        Array.from({ length: 12 }, (_, i) => `<li><a href="#">link ${i}</a></li>`).join('') +
        '</ul>',
    )
    for (const el of Array.from(document.querySelectorAll('a'))) {
      const selector = buildSelector(el)
      expect(resolvesUniquely(document, selector, el), selector).toBe(true)
    }
  })

  it('describes body itself', () => {
    expect(buildSelector(document.body)).toBe('body')
  })
})

describe('nthOfType', () => {
  it('counts only same-tag siblings, 1-based', () => {
    mount('<div><h1>t</h1><p>one</p><p>two</p><span>s</span><p>three</p></div>')
    const paragraphs = document.querySelectorAll('p')
    expect(nthOfType(paragraphs[0]!)).toBe(1)
    expect(nthOfType(paragraphs[1]!)).toBe(2)
    expect(nthOfType(paragraphs[2]!)).toBe(3)
  })
})
