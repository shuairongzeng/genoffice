/**
 * Find/replace floating panel (⌘F) — modeled on PowerPoint "Home → Find/Replace".
 * Find works on render-tree text (element-granularity hits, page jump + select); replace goes
 * through the main-process model layer (in-run matching, byte-faithful patches), and on success
 * the whole RenderSlide set refreshes.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../i18n/locale'
import type { FindSpan } from '../konva-adapter'
import type {
  GroupRenderNode,
  RenderNode,
  RenderSlide,
  RenderTextLayout,
  ShapeRenderNode,
  TableRenderNode,
} from '@genoffice/pptx-render'

export interface FindMatch {
  slideIndex: number
  sourceId: string
  count: number
  /** run-level hit positions for the text highlight (issue #56 P1 #7); empty
   *  on group nodes — their children render through StaticNode, so those hits
   *  keep the shape-select behavior */
  spans: FindSpan[]
}

/** Laid-out text → plain text (skip bullet glyphs; restore spaces swallowed by wrapping; newline between paragraphs). */
function layoutText(text?: RenderTextLayout): string {
  if (!text) return ''
  let out = ''
  text.lines.forEach((l, i) => {
    if (i > 0 && l.paraStart !== false) out += '\n'
    out += l.runs
      .filter((r) => !r.isBullet)
      .map((r) => r.text)
      .join('')
    if (l.trailingSpace) out += l.trailingText ?? ' '
  })
  return out
}

/**
 * Searchable text aggregated from a node (including group children/table cells).
 *
 * Deliberately the **raw** view, unlike the model's read path: a span withheld
 * from a model is the reader's own text, and their find-and-replace has to
 * reach it. This is the reader acting as the owner, not the model being handed
 * something it was not shown.
 */
function nodeText(n: RenderNode): string {
  if (n.type === 'text' || n.type === 'shape') return layoutText((n as ShapeRenderNode).text)
  if (n.type === 'table')
    return (n as TableRenderNode).cells.map((c) => layoutText(c.text)).join('\n')
  if (n.type === 'group') return (n as GroupRenderNode).children.map(nodeText).join('\n')
  return ''
}

function countHits(hay: string, needle: string, matchCase: boolean): number {
  if (!needle) return 0
  const h = matchCase ? hay : hay.toLowerCase()
  const q = matchCase ? needle : needle.toLowerCase()
  let n = 0
  for (let i = h.indexOf(q); i >= 0; i = h.indexOf(q, i + q.length)) n++
  return n
}

/** layoutText's flat text with a per-char back-map to the run each char came
 *  from — null on inserted separators (paragraph newlines, swallowed trailing
 *  spaces), which belong to no run and can highlight nothing. Run indexes
 *  count every run in layoutGlyphs order (bullets included) so a span
 *  addresses the same draw its geometry lives in. */
interface ScannedLayout {
  text: string
  map: Array<{ run: number; off: number } | null>
}

function scanLayout(text?: RenderTextLayout): ScannedLayout {
  if (!text) return { text: '', map: [] }
  let out = ''
  const map: ScannedLayout['map'] = []
  let runIdx = 0
  text.lines.forEach((l, i) => {
    if (i > 0 && l.paraStart !== false) {
      out += '\n'
      map.push(null)
    }
    for (const r of l.runs) {
      if (!r.isBullet) {
        for (let k = 0; k < r.text.length; k++) {
          out += r.text[k]
          map.push({ run: runIdx, off: k })
        }
      }
      runIdx++
    }
    if (l.trailingSpace) {
      const t = l.trailingText ?? ' '
      out += t
      for (let k = 0; k < t.length; k++) map.push(null)
    }
  })
  return { text: out, map }
}

/** V8's whole-string toLowerCase applies the Unicode Final_Sigma rule: Σ
 *  becomes ς only when a cased letter precedes it (case-ignorable characters
 *  in between allowed) and no cased letter follows (ignorables in between
 *  allowed). Cased is Lu/Ll/Lt plus Other-Upper/Lowercase — CJK and Hebrew
 *  letters are NOT cased, so a CJK letter followed by Σ folds the Σ
 *  ordinarily, not to final sigma. */
const CASED = /[\p{Lowercase}\p{Uppercase}\p{Lt}]/u
const CASE_IGNORABLE = /[\p{Mn}\p{Me}\p{Cf}\p{Lm}\p{Sk}]/u

function isFinalSigma(s: string, i: number): boolean {
  let j = i - 1
  while (j >= 0 && CASE_IGNORABLE.test(s[j]!)) j--
  if (j < 0 || !CASED.test(s[j]!)) return false
  let k = i + 1
  while (k < s.length && CASE_IGNORABLE.test(s[k]!)) k++
  return k === s.length || !CASED.test(s[k]!)
}

/** toLowerCase per char, padding the back-map when a char's lowercase grows —
 *  Turkish İ is the only one in Unicode — so folded indexOf offsets stay
 *  aligned with the run/char map (both extra units map back to the same char).
 *  Word-final Σ folds to ς as well (isFinalSigma above): whole-string
 *  toLowerCase — what the query and the group-branch countHits use — applies
 *  the Unicode Final_Sigma rule a bare per-char fold misses, and without it
 *  case-insensitive find would lose Greek matches the old joined-text scan
 *  found. */
function foldIndexed(scanned: ScannedLayout): ScannedLayout {
  let out = ''
  const map: ScannedLayout['map'] = []
  for (let i = 0; i < scanned.text.length; i++) {
    const ch = scanned.text[i]!
    const lc = ch === 'Σ' && isFinalSigma(scanned.text, i) ? 'ς' : ch.toLowerCase()
    for (let k = 0; k < lc.length; k++) map.push(scanned.map[i] ?? null)
    out += lc
  }
  return { text: out, map }
}

/** The occurrences of the query in one scanned layout, as run-level spans: a
 *  hit crossing a separator gap splits into one span per covered stretch (the
 *  pdf search's rects do the same); the count equals countHits on the same
 *  text, so per-cell scanning sums to the old joined-string count for any
 *  query without a newline — which the single-line find input cannot type. */
function scanSpans(
  scanned: ScannedLayout,
  query: string,
  matchCase: boolean,
): { count: number; spans: FindSpan[] } {
  const folded = matchCase ? scanned : foldIndexed(scanned)
  const q = matchCase ? query : query.toLowerCase()
  const spans: FindSpan[] = []
  let count = 0
  let from = 0
  while (q) {
    const s = folded.text.indexOf(q, from)
    if (s < 0) break
    const e = s + q.length
    count++
    let k = s
    while (k < e) {
      const m = folded.map[k]
      if (!m) {
        k++
        continue
      }
      let j = k + 1
      while (j < e && folded.map[j]?.run === m.run) j++
      // end = the last covered char's original offset + 1: j-k counts FOLDED
      // units, and a folded İ grows to two — unit arithmetic would overrun
      // the run's own chars by one per grown char inside the hit
      spans.push({ runIdx: m.run, start: m.off, end: folded.map[j - 1]!.off + 1 })
      k = j
    }
    from = e
  }
  return { count, spans }
}

export function buildMatches(
  slides: RenderSlide[],
  query: string,
  matchCase: boolean,
): FindMatch[] {
  const out: FindMatch[] = []
  if (!query) return out
  slides.forEach((sl, si) => {
    for (const n of sl.nodes) {
      if (n.decoration) continue
      let count = 0
      const spans: FindSpan[] = []
      if (n.type === 'table') {
        for (const c of (n as TableRenderNode).cells) {
          const r = scanSpans(scanLayout(c.text), query, matchCase)
          count += r.count
          for (const sp of r.spans) spans.push({ ...sp, cell: { row: c.row, col: c.col } })
        }
      } else if (n.type === 'group') {
        // group children render through StaticNode: keep the old joined-text
        // count (the hit still navigates + selects) but no run-level spans
        count = countHits(nodeText(n), query, matchCase)
      } else {
        const r = scanSpans(scanLayout((n as ShapeRenderNode).text), query, matchCase)
        count = r.count
        spans.push(...r.spans)
      }
      if (count > 0) out.push({ slideIndex: si, sourceId: n.sourceId, count, spans })
    }
  })
  return out
}

export function FindReplaceDialog({
  slides,
  onNavigate,
  onReplaced,
  onClose,
  scanFn = buildMatches,
}: {
  slides: RenderSlide[]
  onNavigate: (slideIndex: number, sourceId: string, spans: FindSpan[]) => void
  onReplaced: (slides: RenderSlide[]) => void
  onClose: () => void
  /** injected for tests: counts scans (the debounce contract) without spying on module internals */
  scanFn?: typeof buildMatches
}) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  /** the query the passive scan/display runs on: settles 150ms behind the
   *  input (docs/markdown use the same cadence) so keystrokes no longer
   *  rescan the whole deck (issue #56 P1 #7) */
  const [settledQuery, setSettledQuery] = useState('')
  const [replaceText, setReplaceText] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [cursor, setCursor] = useState(-1)
  /** transient action feedback (not found / replaced N) — cleared by the next
   *  query keystroke or option toggle, never by a deck refresh */
  const [status, setStatus] = useState('')
  /** position string from the last explicit step (Enter / Find Next). Kept
   *  separate from status because it describes the CURRENT list: any
   *  recomposition — deck mutation, matchCase toggle — must drop it, while
   *  replace feedback legitimately survives the refresh its own edit caused */
  const [pos, setPos] = useState('')
  const findRef = useRef<HTMLInputElement>(null)

  useEffect(() => findRef.current?.focus(), [])

  useEffect(() => {
    const id = setTimeout(() => setSettledQuery(query), 150)
    return () => clearTimeout(id)
  }, [query])

  // the match list recomposes whenever its inputs do — a deck mutation that
  // lands while the panel is open (replace result, undo) or a matchCase
  // toggle. A surviving cursor would index whatever element now sits at that
  // position, and single Replace would target an element that was never
  // navigated or highlighted, so every recomposition drops the cursor and
  // the stepped position together.
  useEffect(() => {
    setCursor(-1)
    setPos('')
  }, [slides])

  // memoized on the settled inputs: cursor/status changes and parent
  // re-renders no longer rescan the deck either
  const matches = useMemo(
    () => scanFn(slides, settledQuery, matchCase),
    [scanFn, slides, settledQuery, matchCase],
  )

  /** actions (Enter / Find Next / Replace) scan the typed query synchronously
   *  — one scan per explicit user action, the same cost the old per-render
   *  rebuild paid on every cursor move — so they never act on a 150ms-stale
   *  display list */
  const scan = (): FindMatch[] => scanFn(slides, query, matchCase)

  const stepTo = (list: FindMatch[], next: number): void => {
    setCursor(next)
    const m = list[next]!
    onNavigate(m.slideIndex, m.sourceId, m.spans)
    setPos(t('paneFrMatchPos', { i: String(next + 1), n: String(list.length) }))
  }

  const findNext = () => {
    const list = scan()
    if (!list.length) {
      setStatus(t('paneFrNotFound'))
      return
    }
    stepTo(list, (cursor + 1) % list.length)
  }

  const doReplace = async (all: boolean) => {
    if (!query) return
    const list = scan()
    const cur = !all && cursor >= 0 && cursor < list.length ? list[cursor] : undefined
    if (!all && !cur) {
      findNext()
      return
    }
    const r = await window.slidesApi.findReplace({
      find: query,
      replace: replaceText,
      matchCase,
      ...(all ? {} : { firstOnly: true, slideIndex: cur!.slideIndex, elementId: cur!.sourceId }),
    })
    if (!r || !r.count || !r.slides) {
      setStatus(t('paneFrNotFound'))
      return
    }
    onReplaced(r.slides)
    setStatus(t('paneFrReplaced', { n: String(r.count) }))
    // no cursor advance: the replaced slides re-render the panel, and the
    // recomposition effect above has already dropped the stale index — the
    // next Find Next starts from the top of the fresh list
  }

  return (
    <div className="find-panel" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="find-panel-head">
        <span>{t('paneFrTitle')}</span>
        <button
          className="find-panel-close"
          onClick={onClose}
          data-tip="Esc"
          aria-label={t('paneCsdClose')}
        >
          ×
        </button>
      </div>
      <div className="find-panel-row">
        <input
          ref={findRef}
          placeholder={t('paneFrFind')}
          aria-label={t('paneFrFind')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setCursor(-1)
            setPos('')
            setStatus('')
          }}
          onKeyDown={(e) => e.key === 'Enter' && findNext()}
        />
      </div>
      <div className="find-panel-row">
        <input
          placeholder={t('paneFrReplaceWith')}
          aria-label={t('paneFrReplaceWith')}
          value={replaceText}
          onChange={(e) => setReplaceText(e.target.value)}
        />
      </div>
      <div className="find-panel-row find-panel-opts">
        <label>
          <input
            type="checkbox"
            checked={matchCase}
            onChange={(e) => {
              setMatchCase(e.target.checked)
              // the list recomposes: the cursor and the old position no
              // longer describe it (same reset as a query keystroke)
              setCursor(-1)
              setPos('')
              setStatus('')
            }}
          />
          {t('paneFrMatchCase')}
        </label>
        <span className="find-panel-status">
          {status ||
            pos ||
            (settledQuery
              ? t('paneFrMatchPos', {
                  i: String(Math.max(cursor + 1, 0)),
                  n: String(matches.length),
                })
              : '')}
        </span>
      </div>
      <div className="find-panel-row find-panel-actions">
        <button onClick={findNext} disabled={!query}>
          {t('paneFrFindNext')}
        </button>
        <button onClick={() => void doReplace(false)} disabled={!query}>
          {t('paneFrReplace')}
        </button>
        {/* gated like Replace: the action scans the typed query fresh, so the
            150ms-settled total must not hold the button back (a click in the
            settle window is otherwise dead for no correctness gain) */}
        <button onClick={() => void doReplace(true)} disabled={!query}>
          {t('paneFrReplaceAll')}
        </button>
      </div>
    </div>
  )
}
