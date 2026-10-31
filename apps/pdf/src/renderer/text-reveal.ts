import { searchInIndex, type SearchIndex, type SearchMatch } from './search'

/**
 * The search deep link's reveal (issue #56), extracted so the composition is
 * testable: search the loaded document for the deep link's text and hand the
 * find surface the results. The app-side half (opening the find bar, focusing
 * its input, the jump effect that centers match 0) stays in App.tsx and runs
 * off the state this returns through `applyFindState`.
 */

export interface PdfTextRevealDeps {
  /** the loaded document's text index, or null while no document is loaded */
  searchIndex(): Promise<SearchIndex> | null
  /** original page indices the user deleted — their matches must not reveal */
  deletedPages(): ReadonlySet<number>
  /** put the find bar's state: open with this query and these matches */
  applyFindState(state: { open: true; query: string; matches: SearchMatch[] }): void
}

/**
 * Find `text` and stage the reveal; true when a match exists. The find bar
 * opens populated (count, Enter stepping, highlights are then the normal find
 * surface), and the caller's search-jump effect centers match 0 once the new
 * state lands.
 */
export async function revealPdfText(deps: PdfTextRevealDeps, text: string): Promise<boolean> {
  const index = deps.searchIndex()
  if (index === null) return false
  const matches = searchInIndex(await index, text).filter(
    (m) => !deps.deletedPages().has(m.pageIndex),
  )
  if (matches.length === 0) return false
  deps.applyFindState({ open: true, query: text, matches })
  return true
}
