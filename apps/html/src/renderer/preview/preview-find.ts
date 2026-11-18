/**
 * Find-in-preview (issue #56 P2 #8): the previewed document runs in a
 * cross-origin sandboxed frame the app cannot read, so the panel searches a
 * text MIRROR the frame's inspector pushes (gx:docText, node by node with
 * stable ids) and sends match ranges back (gx:findMark / gx:findActivate) to
 * be painted as overlay boxes. The mirror makes the search synchronous, which
 * is exactly what the shared FindPanel's `search` contract demands.
 */
import { findInText, type FindOptions, type FindTarget } from '@genoffice/ui'
import type { ToInspector } from './inspector-protocol'

/** one inspector text node as pushed in a gx:docText snapshot. `sep` is the
 *  newline the frame inserts before this node's text at a block boundary:
 *  joining with it makes the mirror read like the rendered lines, so
 *  whole-word matching sees word edges where the layout draws them */
export interface DocTextNode {
  id: number
  text: string
  sep?: string
}

/** a match piece within one node (a hit spanning two nodes splits per node) */
export interface FindRange {
  id: number
  start: number
  end: number
}

export type PostToInspector = (msg: ToInspector) => void

/** sanity bounds for a pushed mirror: the frame runs with allow-scripts and
 *  an opaque origin, so any script in the previewed document can forge a
 *  same-version gx:docText — the payload is bounded before it reaches the
 *  search math (a join of unbounded size would throw inside the panel's
 *  debounce timer and take the scan loop down with it) */
const MAX_MIRROR_NODES = 20000
const MAX_MIRROR_CHARS = 1000000

export class PreviewFindController {
  private nodes: DocTextNode[] = []
  private docListeners = new Set<() => void>()
  /** the last posted search context: a repaint-in-place rescan must not scroll */
  private lastSig: string | null = null
  private lastActive = -1
  /** one target for the controller's lifetime: the host hands the panel this
   *  target on every Cmd+F, and a fresh object per call would read as a
   *  retarget — the panel would clear the painted marks and re-run its
   *  debounced scan on every keystroke that re-opens an open panel */
  private target: FindTarget | null = null

  constructor(private readonly post: PostToInspector) {}

  /** a fresh snapshot arrived (ready push or settled mutation): swap the
   *  mirror and let an open panel rescan against it. The payload crosses the
   *  sandbox boundary from a document that can forge it, so it is
   *  shape-checked and bounded before it reaches the search math */
  onDocText(nodes: unknown): void {
    if (!Array.isArray(nodes)) return
    const clean: DocTextNode[] = []
    let total = 0
    let truncated = false
    for (const node of nodes) {
      if (clean.length >= MAX_MIRROR_NODES) {
        truncated = true
        break
      }
      if (typeof node !== 'object' || node === null) continue
      const { id, text, sep } = node as { id?: unknown; text?: unknown; sep?: unknown }
      if (typeof id !== 'number' || !Number.isFinite(id)) continue
      if (typeof text !== 'string') continue
      // the only separator the frame ever sends; anything else is a forged
      // payload trying to wedge match offsets into the gaps between nodes
      const safeSep = sep === '\n' ? '\n' : undefined
      // over the total cap: keep the node's searchable PREFIX rather than
      // dropping it whole (dropped text would silently become unfindable)
      const room = MAX_MIRROR_CHARS - total
      const safeText = text.length > room ? text.slice(0, Math.max(0, room)) : text
      if (safeText.length < text.length) truncated = true
      total += safeText.length
      clean.push(
        safeSep === undefined ? { id, text: safeText } : { id, text: safeText, sep: safeSep },
      )
      if (truncated) break
    }
    if (truncated)
      // under-reporting beats crashing, but it must not be silent
      console.warn('[html] preview text mirror truncated at the size caps')
    this.nodes = clean
    for (const listener of this.docListeners) listener()
  }

  /** the preview target became active: ask the frame to start reporting */
  start(): void {
    this.post({ type: 'gx:setDocText', on: true })
  }

  /** panel closed (or the target left the preview): stop the pushes and drop
   *  the marks the frame painted — an orphaned session would leave both on */
  stop(): void {
    this.post({ type: 'gx:findClear' })
    this.post({ type: 'gx:setDocText', on: false })
    this.lastSig = null
    this.lastActive = -1
  }

  findTarget(): FindTarget {
    if (this.target) return this.target
    this.target = {
      editable: false,
      search: (query: string, opts: FindOptions, activeIndex: number) => {
        const { count, matches } = searchMirror(this.nodes, query, opts)
        const active = count > 0 ? Math.max(0, Math.min(activeIndex, count - 1)) : -1
        // scroll only when the context moved (a new needle or a different
        // active match): a doc-change rescan repaints in place, and scrolling
        // on every rescan would yank the reader back while the page settles
        // under them
        const sig = `${query}\u0000${opts.matchCase ? 1 : 0}${opts.wholeWord ? 1 : 0}`
        const scroll = sig !== this.lastSig || active !== this.lastActive
        this.lastSig = sig
        this.lastActive = active
        this.post({ type: 'gx:findMark', matches, active, scroll })
        return count
      },
      activate: (index: number) => {
        this.post({ type: 'gx:findActivate', active: index })
      },
      // the preview is a view: edits go through the source pane (the panel
      // hides the replace row for a non-editable target)
      replaceOne: () => {},
      replaceAll: () => {},
      clear: () => {
        this.post({ type: 'gx:findClear' })
      },
      onDocChanged: (listener: () => void) => {
        this.docListeners.add(listener)
        return () => this.docListeners.delete(listener)
      },
    }
    return this.target
  }
}

/**
 * The matches of `query` in the mirror, each as the list of its per-node
 * pieces addressed the way the inspector understands them (one group per
 * match, so the frame can emphasize a whole cross-node hit). Inline runs join
 * without separators (`<b>Hel</b>lo` reads "Hello", so a query spanning two
 * nodes is one hit); block boundaries join through the node's `sep` newline.
 */
export function searchMirror(
  nodes: readonly DocTextNode[],
  query: string,
  opts: FindOptions,
): { count: number; matches: FindRange[][] } {
  const matches: FindRange[][] = []
  if (!query || nodes.length === 0) return { count: 0, matches }
  // spans[i] = where nodes[i]'s text sits in the joined string; its sep is
  // glued on front but never belongs to the node (a query cannot contain the
  // newline separator, so a hit never covers one)
  const spans: Array<{ id: number; start: number; end: number }> = []
  let offset = 0
  for (const node of nodes) {
    if (node.sep) offset += node.sep.length
    spans.push({ id: node.id, start: offset, end: offset + node.text.length })
    offset += node.text.length
  }
  const flat = nodes.map((node) => (node.sep ? node.sep : '') + node.text).join('')
  const starts = findInText(flat, query, opts)
  for (const s of starts) {
    const e = s + query.length
    let i = 0
    while (i + 1 < spans.length && spans[i + 1]!.start <= s) i++ // the node containing s (empty nodes never own an offset)
    const pieces: FindRange[] = []
    let at = s
    while (at < e && i < spans.length) {
      // a match that starts inside a separator (a caller passing a query with
      // its own newline): jump to the node's text, never a negative offset
      if (at < spans[i]!.start) at = spans[i]!.start
      const end = Math.min(e, spans[i]!.end)
      // a zero-length node mid-match advances i without contributing a piece
      if (end > at) {
        pieces.push({ id: spans[i]!.id, start: at - spans[i]!.start, end: end - spans[i]!.start })
        at = end
      }
      i++
    }
    if (pieces.length) matches.push(pieces)
  }
  return { count: matches.length, matches }
}
