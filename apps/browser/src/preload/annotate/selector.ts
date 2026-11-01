/**
 * Selector generation for the annotation picker: one element in, one robust
 * CSS selector out, with uniqueness validated against the live document.
 *
 * The strategy (id > data-* > semantic class names > nth-of-type path) trades
 * verbosity for survival: an id or a stable test attribute survives template
 * edits, a semantic class survives data churn, and the fully-indexed
 * structural path — the guaranteed-unique fallback — survives nothing but is
 * always available. Pure DOM code on purpose: it runs in the page view's
 * isolated world and is pinned by jsdom tests without Electron.
 */

/** data attributes the framework ecosystem treats as stable test hooks */
const DATA_ATTR_WHITELIST: readonly string[] = [
  'data-testid',
  'data-test-id',
  'data-test',
  'data-testing',
  'data-qa-id',
  'data-qa',
  'data-cy',
  'data-automation-id',
]

/** data attributes that are positional or build-hashed, never stable hooks */
const DATA_ATTR_BLOCKED: RegExp[] = [
  /^data-index$/i,
  /^data-v-/i, // Vue scoped-attribute hash
  /^data-reactid$/i,
  /^data-svelte-/i, // svelte-xxx scoped/hydration markers
  /^data-astro-/i,
  /^data-hydration/i,
]

/** class names that look generated or utility-graded rather than semantic */
const CLASS_BLOCKED: RegExp[] = [
  /\d{4,}/, // hashy: css-1a2b3c, jsx-4219756
  /^(?:css|jsx|sc|emotion|styled|svelte|astro|hydration|webpack|module)-/i,
  /^[a-z]{1,2}-?\d/i, // tailwind-style sizes: w-4, mt-2, p-3, h-56
  /^_/, // CSS-modules locals by convention
  /^(?:hover|focus|active|disabled|visited|checked|group-|peer-)/, // state variants
]

/** how many ancestors the structural path may climb before giving up */
const STRUCTURAL_DEPTH_MAX = 30

const cssEscapeFallback = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`)

/** CSS.escape with a fallback for engines (and jsdoms) that lack it */
export function cssEscape(value: string): string {
  const escaper = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS?.escape
  return escaper ? escaper(value) : cssEscapeFallback(value)
}

/** escape a quoted attribute-selector value */
const attrValue = (value: string): string =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/**
 * Whether a selector resolves to exactly the given element: the uniqueness
 * contract every candidate must pass before it is used. A throwing selector
 * (invalid syntax, unsupported pseudo) answers false.
 */
export function resolvesUniquely(doc: Document, selector: string, el: Element): boolean {
  let hits: NodeListOf<Element>
  try {
    hits = doc.querySelectorAll(selector)
  } catch {
    return false
  }
  return hits.length === 1 && hits[0] === el
}

/** `#id` when the element carries a unique id */
function byId(doc: Document, el: Element): string | null {
  const id = el.getAttribute('id')
  if (id === null || id.trim() === '') return null
  const selector = `#${cssEscape(id)}`
  return resolvesUniquely(doc, selector, el) ? selector : null
}

/** the element's data attributes worth trying, whitelist order first */
function candidateDataAttrs(el: Element): string[] {
  const names: string[] = []
  for (const name of DATA_ATTR_WHITELIST) {
    if (el.hasAttribute(name)) names.push(name)
  }
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase()
    if (!name.startsWith('data-') || names.includes(name)) continue
    if (DATA_ATTR_BLOCKED.some((blocked) => blocked.test(name))) continue
    if (name.length < 5) continue
    names.push(name)
  }
  return names
}

/** `[data-testid="x"]` (optionally tag-prefixed) when it is unique */
function byDataAttr(doc: Document, el: Element): string | null {
  for (const name of candidateDataAttrs(el)) {
    const value = el.getAttribute(name) ?? ''
    if (value === '' || value.length > 100 || /[\n\r\t]/.test(value)) continue
    const bare = `[${name}=${attrValue(value)}]`
    if (resolvesUniquely(doc, bare, el)) return bare
    const tagged = `${localTag(el)}[${name}=${attrValue(value)}]`
    if (resolvesUniquely(doc, tagged, el)) return tagged
  }
  return null
}

/** the element's tag as a selector segment (localName is already lowercase for HTML) */
function localTag(el: Element): string {
  return cssEscape(el.localName)
}

/** class names that plausibly survive a template edit */
function semanticClasses(el: Element): string[] {
  const out: string[] = []
  for (const cls of Array.from(el.classList)) {
    if (cls.length < 2 || cls.length > 60) continue
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(cls)) continue
    if (CLASS_BLOCKED.some((blocked) => blocked.test(cls))) continue
    out.push(cls)
  }
  return out
}

/** `tag.cls` / `tag.cls1.cls2` when the combination is unique */
function byClass(doc: Document, el: Element): string | null {
  const classes = semanticClasses(el)
  if (classes.length === 0) return null
  const tag = localTag(el)
  const withPrefix = (count: number): string =>
    `${tag}.${classes.slice(0, count).map(cssEscape).join('.')}`
  for (let count = 1; count <= classes.length; count += 1) {
    const selector = withPrefix(count)
    if (resolvesUniquely(doc, selector, el)) return selector
  }
  return null
}

/**
 * The element's 1-based position among its same-tag siblings — exactly what
 * CSS `:nth-of-type()` counts, computed the same way.
 */
export function nthOfType(el: Element): number {
  const parent = el.parentElement
  if (parent === null) return 1
  let index = 0
  for (const child of Array.from(parent.children)) {
    if (child === el) return index + 1
    if (child.localName === el.localName) index += 1
  }
  return index + 1
}

/** whether the parent has exactly one element child of this tag */
function onlyTagOfType(el: Element): boolean {
  const parent = el.parentElement
  if (parent === null) return true
  return Array.from(parent.children).filter((c) => c.localName === el.localName).length === 1
}

/**
 * The structural path: `tag` segments up the ancestor chain, `:nth-of-type(k)`
 * wherever the tag repeats among siblings, tested for uniqueness after every
 * level so the shortest unique path wins. The guaranteed fallback is the
 * fully-indexed path from a unique root (`body`/`html`), which cannot match
 * two elements; if even that somehow fails, the best-effort path is returned
 * anyway — the overlay re-validates at draw time and silently skips misses.
 */
export function structuralSelector(el: Element): string {
  const doc = el.ownerDocument
  const parts: string[] = []
  let current: Element | null = el
  let depth = 0
  while (current !== null && current.nodeType === 1 && depth < STRUCTURAL_DEPTH_MAX) {
    const tag = localTag(current)
    const segment = onlyTagOfType(current) ? tag : `${tag}:nth-of-type(${nthOfType(current)})`
    parts.unshift(segment)
    const selector = parts.join(' > ')
    if (resolvesUniquely(doc, selector, el)) return selector
    if (current === doc.body || current === doc.documentElement) break
    current = current.parentElement
    depth += 1
  }
  // fully-indexed fallback: every level pinned, from the topmost reached
  const indexed: string[] = []
  current = el
  depth = 0
  while (current !== null && current.nodeType === 1 && depth < STRUCTURAL_DEPTH_MAX) {
    indexed.unshift(`${localTag(current)}:nth-of-type(${nthOfType(current)})`)
    if (current === doc.body || current === doc.documentElement) break
    current = current.parentElement
    depth += 1
  }
  return indexed.join(' > ')
}

/**
 * Build the element's selector. Order per the contract: unique id, then a
 * stable data attribute, then semantic classes, then the structural path.
 */
export function buildSelector(el: Element): string {
  const doc = el.ownerDocument
  return byId(doc, el) ?? byDataAttr(doc, el) ?? byClass(doc, el) ?? structuralSelector(el)
}
