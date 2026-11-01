/**
 * XPath generation for the annotation picker: one element in, one absolute
 * XPath out — the `evidence pack`'s addressing twin of the CSS selector. A
 * CSS selector is what the *suite* re-resolves markers with; the XPath is
 * what survives for anything else (a human pasting it into devtools, a model
 * reasoning about the document's structure, an XPath-capable consumer the CSS
 * engine cannot serve).
 *
 * The path is absolute (`/html/body/…`) with 1-based positional predicates
 * wherever the tag repeats among siblings, validated for uniqueness against
 * the live document with `document.evaluate` — the XPath twin of
 * selector.ts's resolvesUniquely. Pure DOM code on purpose: it runs in the
 * page view's isolated world and is pinned by jsdom tests without Electron.
 */

/** how many ancestors the path may climb before giving up (selector.ts's own cap) */
const XPATH_DEPTH_MAX = 30

/**
 * The element's 1-based position among its same-*localName* siblings — what
 * an XPath positional predicate counts. Unlike CSS `:nth-of-type()` this
 * counts siblings of the same *tag* regardless of namespace prefix, which for
 * an HTML document (one namespace) is the same set.
 */
export function nthOfName(el: Element): number {
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
function onlyTagOfName(el: Element): boolean {
  const parent = el.parentElement
  if (parent === null) return true
  return Array.from(parent.children).filter((c) => c.localName === el.localName).length === 1
}

/**
 * Whether an XPath resolves to exactly the given element: the uniqueness
 * contract a candidate path must pass before it is used. A throwing
 * expression (malformed XPath, unsupported engine) answers false.
 */
export function resolvesUniquelyX(doc: Document, path: string, el: Element): boolean {
  try {
    const hit = doc.evaluate(
      path,
      doc,
      null,
      9 /* XPathResult.FIRST_ORDERED_NODE_TYPE */,
      null,
    ).singleNodeValue
    return hit === el
  } catch {
    return false
  }
}

/** one path segment: `tag`, or `tag[n]` when the tag repeats among siblings */
function segmentOf(el: Element): string {
  const tag = el.localName
  return onlyTagOfName(el) ? tag : `${tag}[${nthOfName(el)}]`
}

/**
 * Build the element's absolute XPath. The candidate path climbs from the
 * element toward the document root, pinning a positional predicate wherever
 * the tag repeats, and is tested for uniqueness after every level so the
 * shortest unique path wins; the guaranteed fallback is the fully-indexed
 * path (`html[1]/body[1]/div[2]/…`) whose every level is pinned, which cannot
 * address two elements. If even that somehow fails to match, it is returned
 * anyway — the store keeps it as evidence, not as a promise.
 */
export function buildXPath(el: Element): string {
  const doc = el.ownerDocument

  // candidate chain, element-first, capped by depth
  const chain: Element[] = []
  let current: Element | null = el
  while (current !== null && current.nodeType === 1 && chain.length < XPATH_DEPTH_MAX) {
    chain.unshift(current)
    if (current === doc.documentElement) break
    current = current.parentElement
  }

  // shortest unique: prepend segments until the path resolves to the element
  const parts: string[] = []
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    parts.unshift(segmentOf(chain[i]!))
    const path = `/${parts.join('/')}`
    if (resolvesUniquelyX(doc, path, el)) return path
  }

  // fully-indexed fallback: every level pinned, cannot match two elements
  return `/${chain.map((node) => `${node.localName}[${nthOfName(node)}]`).join('/')}`
}
