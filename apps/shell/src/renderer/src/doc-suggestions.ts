/**
 * The document-suggestion engine for the AI panel's per-document prompts
 * (renderer/src): given what the shell already knows about the open document —
 * its app kind, its file name and title, its shape (word count, headings,
 * emptiness) and whether an AI task birthed it — pick the few AI moves that
 * make sense on THAT document, in a stable order. Pure by design: no DOM, no
 * locale, no IPC. The engine answers KEYS, not prose — 'summarize', 'draft',
 * 'continue-writing', … — because the locale strings land in a later
 * integration slice; params carry document facts (a draft's topic seed),
 * never phrasing, so one engine serves every language unchanged.
 *
 * The engine is a fixed rule table in precedence order — lineage (the
 * continuity case) first, the blank page second, then the shape rules (long,
 * structure) and the kind rules (sheets, slides, pdf, markdown), the everyday
 * prose trio last. Each rule contributes ordered candidates; the collector
 * keeps the first occurrence of every key and caps the answer at
 * MAX_DOC_SUGGESTIONS, so the same metadata always yields the same
 * suggestions in the same order, no key repeats, and a long tail of weak
 * matches can never crowd out a strong one. Degenerate metadata is
 * normalized, never thrown on: an unknown or junk kind reads as prose (the
 * safe default for a word-shaped guess), junk optionals read as unknown, only
 * a literal true is a true flag, and a meta that is not even an object
 * answers the fresh-document pair. The answer is never empty.
 *
 * The keys the table can emit — the locale slice's contract:
 *
 * - draft — start the document (the empty word-shaped starter; params.topic
 *   carries the seed when the title or file name offers one)
 * - outline — plan an empty document, or structure a heading-light one
 * - continue-writing — resume the AI task a lineage document came from
 * - expand — grow a lineage document further
 * - fill-data — fill a sheet's grid (the empty starter and the data action)
 * - summarize — compress a long document, a sheet's data, a deck, a pdf
 * - polish — tighten prose, a markdown file, a deck
 * - publish — ship a markdown document
 * - translate — any document can be translated (the safe universal verb)
 * - make-presentation — turn word-shaped content into a slides deck
 */

// ── the model ────────────────────────────────────────────

/**
 * What the shell knows about the open document. `kind` is the tab's app kind
 * — the DocumentTabKind set from shared/tabs-api.ts ('docs' | 'sheets' |
 * 'slides' | 'pdf' | 'markdown' | 'html') — typed as an open string so a
 * future app kind, a sloppy bridge, or a junk value flows through as prose
 * instead of throwing. `hasLineage` marks the continuity case: the document
 * was created or opened from an AI task, so its strongest next move is to
 * keep that task's thread going. `wordCount` and `headings` are optional
 * because not every app reports them — absent means unknown, and the rules
 * that need them stay quiet rather than guess.
 */
export interface DocSuggestionMeta {
  /** the tab's app kind: a DocumentTabKind value, or any string (unknown reads as prose) */
  readonly kind: string
  /** the document's file name — the topic seed's fallback when no title exists */
  readonly fileName: string
  /** the document's own title, when the app reports one; the preferred topic seed */
  readonly title?: string
  /** the word count, when the app reports one; absent or junk means unknown */
  readonly wordCount?: number
  /** the heading texts in order, when the app reports them; absent or junk means unknown */
  readonly headings?: readonly string[]
  /** true when the document has no content to act on (the blank-page case) */
  readonly isEmpty: boolean
  /** true when the document was created or opened from an AI task (the continuity case) */
  readonly hasLineage: boolean
}

/**
 * One suggested AI move: a locale KEY (not prose — the integration slice maps
 * it to its label and prompt) plus optional params carrying document facts.
 * The one param the engine emits today is `topic`, the seed a draft should
 * grow from (the title, or the file name's stem): phrasing stays out so every
 * locale shares the same engine.
 */
export interface DocSuggestion {
  /** the suggestion key ('summarize', 'draft', 'continue-writing', …) */
  readonly key: string
  /** document facts for the locale slice ('topic' today); never prose */
  readonly params?: Readonly<Record<string, string>>
}

// ── the tuned lines ──────────────────────────────────────

/** the answer's hard cap: a suggestion panel that scrolls is a menu, not a suggestion */
export const MAX_DOC_SUGGESTIONS = 4
/** a "long" document, in words: ≈ five printed pages — past this the digest pair leads */
export const LONG_DOC_WORDS = 1200
/** the structure rule's floor, in words: below it a short note needs no outline */
export const STRUCTURE_MIN_WORDS = 200
/** "few" headings: fewer than this reads as a wall of text worth structuring */
export const FEW_HEADING_COUNT = 3

// ── normalization ────────────────────────────────────────

/** the shape families the rules branch on */
type DocFamily = 'prose' | 'sheet' | 'deck' | 'fixed'

/**
 * The metadata as the rules read it: every optional normalized to a known
 * state (null = unknown), every degenerate value read as its safest meaning
 * (junk kind → prose, junk count → unknown, junk flag → the quiet default).
 * Junk never reaches a rule, so no rule can throw on it.
 */
interface NormalizedDoc {
  /** the trimmed, lowercased kind ('' when the field was junk) */
  readonly kind: string
  /** the kind's rule family */
  readonly family: DocFamily
  readonly isEmpty: boolean
  readonly hasLineage: boolean
  /** the word count, or null when unknown (absent or junk) */
  readonly words: number | null
  /** the heading count, or null when unknown (absent or junk) */
  readonly headingCount: number | null
  /** the draft's topic seed, or null when the names offer none */
  readonly topic: string | null
}

/**
 * The kind's rule family: sheets, slides and pdf branch on their own; every
 * other kind — docs, markdown, html, and whatever an unknown or junk kind
 * turns out to be — reads as prose, the safe default for a word-shaped guess
 * (polishing an unrecognized kind is harmless; gridding or deck-ifying it
 * would not be).
 */
function familyOf(kind: string): DocFamily {
  switch (kind) {
    case 'sheets':
      return 'sheet'
    case 'slides':
      return 'deck'
    case 'pdf':
      return 'fixed'
    default:
      return 'prose'
  }
}

/**
 * The seed a draft should grow from: the document's title when it has one,
 * else its file name's stem — '/desk/Q3 Report.docx' reads as 'Q3 Report'. A
 * blank or placeholder name ('Untitled', 'untitled-2') is no seed at all:
 * drafting "about Untitled" is noise, so the draft carries no params and the
 * locale slice composes its own opening.
 */
function topicSeed(title: string, fileName: string): string | null {
  const fromTitle = usableSeed(title)
  if (fromTitle !== null) return fromTitle
  const base = fileName.split(/[\\/]/).pop() ?? ''
  return usableSeed(base.replace(/\.[^.]*$/, ''))
}

/** a non-blank, non-placeholder stem; null means "no seed" */
function usableSeed(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  return /^untitled(?:[-_\s]?\d+)?$/i.test(trimmed) ? null : trimmed
}

/**
 * Read the metadata into the rules' normalized shape: the kind is trimmed and
 * lowercased (apps pass their registry kind; a sloppy bridge's 'Docs ' still
 * maps), the word count is kept only when finite and non-negative, headings
 * only when an array, and the flags strictly — only a literal true is true,
 * so junk reads as the quiet default and a bad bridge cannot conjure the
 * continuity case.
 */
function normalizeMeta(meta: DocSuggestionMeta): NormalizedDoc {
  const kind = typeof meta.kind === 'string' ? meta.kind.trim().toLowerCase() : ''
  const words =
    typeof meta.wordCount === 'number' && Number.isFinite(meta.wordCount) && meta.wordCount >= 0
      ? meta.wordCount
      : null
  const title = typeof meta.title === 'string' ? meta.title.trim() : ''
  const fileName = typeof meta.fileName === 'string' ? meta.fileName : ''
  return {
    kind,
    family: familyOf(kind),
    isEmpty: meta.isEmpty === true,
    hasLineage: meta.hasLineage === true,
    words,
    headingCount: Array.isArray(meta.headings) ? meta.headings.length : null,
    topic: topicSeed(title, fileName),
  }
}

// ── the rule table (precedence order) ────────────────────

/** one rule: the ordered candidates it contributes for a document, possibly none */
type SuggestionRule = (doc: NormalizedDoc) => readonly DocSuggestion[]

/**
 * The continuity rule: a document born from an AI task suggests the
 * continuation verbs first, whatever its state — the thread the person
 * started is the strongest signal the panel has, so it outranks even the
 * long document's digest pair. It fires on an empty lineage document too: an
 * empty task-born file is an interrupted task, and "continue writing" is the
 * resume move, not a contradiction.
 */
const lineageRule: SuggestionRule = (doc) =>
  doc.hasLineage ? [{ key: 'continue-writing' }, { key: 'expand' }] : []

/**
 * The blank-page rule: an empty document suggests its starting kinds, and
 * nothing else applies — every other rule acts on content that does not exist
 * yet. The starter is kind-shaped: a sheet wants its first data filled, a
 * deck wants its first presentation made, every word-shaped kind (and every
 * unknown one) wants a draft — seeded with the document's own topic when its
 * names offer one — and an outline to plan against.
 */
const blankRule: SuggestionRule = (doc) => {
  if (!doc.isEmpty) return []
  if (doc.family === 'sheet') return [{ key: 'fill-data' }]
  if (doc.family === 'deck') return [{ key: 'make-presentation' }]
  const draft: DocSuggestion = doc.topic
    ? { key: 'draft', params: { topic: doc.topic } }
    : { key: 'draft' }
  return [draft, { key: 'outline' }]
}

/**
 * The digest rule: a long word-shaped document suggests summarize first,
 * then outline as the navigation aid. wordCount is a word metric — sheets and
 * slides carry their size in rows and slides, which the meta does not know —
 * so the rule stays quiet for them and their verbs come from their own kind
 * rules.
 */
const longRule: SuggestionRule = (doc) => {
  if (doc.isEmpty || doc.family === 'sheet' || doc.family === 'deck') return []
  if (doc.words === null || doc.words < LONG_DOC_WORDS) return []
  return [{ key: 'summarize' }, { key: 'outline' }]
}

/**
 * The structure rule: a word-shaped document with words worth structuring
 * (≥ STRUCTURE_MIN_WORDS, or an unknown count — heading data, when present,
 * is authoritative about structure) but fewer than FEW_HEADING_COUNT headings
 * suggests an outline: structure is the fix for a wall of text. A heading
 * count the app never reported is unknown, not few — the rule stays quiet
 * rather than claim a shape it did not see.
 */
const structureRule: SuggestionRule = (doc) => {
  if (doc.isEmpty || doc.family !== 'prose') return []
  if (doc.headingCount === null || doc.headingCount >= FEW_HEADING_COUNT) return []
  if (doc.words !== null && doc.words < STRUCTURE_MIN_WORDS) return []
  return [{ key: 'outline' }]
}

/**
 * The sheets rule: a non-empty workbook suggests data actions — fill the grid
 * with more data, then what the data says. Prose verbs (polish, translate)
 * would misfire on a grid, so the family owns its own pair.
 */
const sheetsRule: SuggestionRule = (doc) =>
  doc.isEmpty || doc.family !== 'sheet' ? [] : [{ key: 'fill-data' }, { key: 'summarize' }]

/**
 * The slides rule: a non-empty deck wants its everyday ask first — polish, the
 * tighten-this-deck verb — then its story (summarize). make-presentation is
 * the prose side's verb: a deck already is one.
 */
const slidesRule: SuggestionRule = (doc) =>
  doc.isEmpty || doc.family !== 'deck' ? [] : [{ key: 'polish' }, { key: 'summarize' }]

/**
 * The pdf rule: a fixed-layout document is a read-me artifact — digest it,
 * translate it, or repurpose it into a deck. No polish: the pdf app imports
 * and prints documents, it does not rewrite them.
 */
const pdfRule: SuggestionRule = (doc) =>
  doc.isEmpty || doc.family !== 'fixed'
    ? []
    : [{ key: 'summarize' }, { key: 'translate' }, { key: 'make-presentation' }]

/**
 * The markdown rule: a markdown document is usually headed somewhere — polish
 * the writing, then publish it. Markdown's own pair, ranked ahead of the
 * prose trio so publish makes the cap on a plain .md.
 */
const markdownRule: SuggestionRule = (doc) =>
  doc.isEmpty || doc.kind !== 'markdown' ? [] : [{ key: 'polish' }, { key: 'publish' }]

/**
 * The prose trio — the everyday fallback for every word-shaped document:
 * polish the writing, translate it, turn it into a presentation. It is what
 * guarantees a non-empty prose document always has suggestions, and the place
 * translate lives: any document can be translated, which is what makes it the
 * safe universal verb.
 */
const proseRule: SuggestionRule = (doc) =>
  doc.isEmpty || doc.family !== 'prose'
    ? []
    : [{ key: 'polish' }, { key: 'translate' }, { key: 'make-presentation' }]

/**
 * The rule table in precedence order. The order IS the ranking: a rule
 * earlier in the table contributes its candidates earlier in the answer, so
 * lineage outranks the blank page, the blank page outranks the shape rules,
 * and the kind rules outrank the prose trio. Every rule checks its own gate,
 * so the table's order decides ranking, never correctness.
 */
const RULES: readonly SuggestionRule[] = [
  lineageRule,
  blankRule,
  longRule,
  structureRule,
  sheetsRule,
  slidesRule,
  pdfRule,
  markdownRule,
  proseRule,
]

// ── the engine ───────────────────────────────────────────

/**
 * The suggestions for one document's metadata: every rule's candidates in
 * table order, the first occurrence of each key kept, the answer capped at
 * MAX_DOC_SUGGESTIONS. Deterministic — the same metadata always yields the
 * same keys in the same order — never empty, and never thrown on: a meta that
 * is not even an object (a bridge gone bad) answers the fresh-document pair
 * rather than an error. The final guard is unreachable under the current
 * table — an empty document always meets the blank-page rule, a non-empty one
 * always meets its family's rule — and is kept anyway so the never-empty
 * promise survives future rule edits.
 */
export function suggestForDocument(meta: DocSuggestionMeta): readonly DocSuggestion[] {
  if (typeof meta !== 'object' || meta === null) return [{ key: 'draft' }, { key: 'outline' }]
  const doc = normalizeMeta(meta)
  const picked: DocSuggestion[] = []
  const seen = new Set<string>()
  for (const rule of RULES) {
    for (const candidate of rule(doc)) {
      if (seen.has(candidate.key)) continue
      seen.add(candidate.key)
      picked.push(candidate)
      if (picked.length >= MAX_DOC_SUGGESTIONS) return picked
    }
  }
  return picked.length > 0 ? picked : [doc.isEmpty ? { key: 'draft' } : { key: 'summarize' }]
}
