/// Knowledge-base channel: the user's local files as AI can search and read,
/// so an answer can cite the folder and file it came from. Lives in the shell
/// main process because that is the one place that already holds both halves —
/// the starred list (readStarredFiles, docs-main) and the full-text index
/// (file-index). The handlers are app-agnostic IPC; docs wires them into its
/// AI panel first, the other apps can follow.
///
/// The corpus is a scope: 'indexed' (the default) is every file the local
/// index covers — the save folder, the added folder roots, recents and the
/// starred set — 'starred' is the original hand-picked set, and 'folders'
/// narrows the index to the folders in `kbScopeFolders` (an empty list is an
/// empty corpus: the settings page and the panel's empty state both say so).
/// kb:list stays a bounded prompt window either way (starred first, then the
/// most recently touched indexed files); search and read are what reach the
/// whole corpus.
///
/// Why the starred search still filters in JS rather than in SQLite: the FTS
/// index's path column stores tokenized FOLDER names (see store.ts upsert),
/// not real paths, so a `path IN (...)` cannot express "within the starred
/// set". Starred corpora are small, so fetching a bounded pool and filtering
/// by real path is the cheap, correct filter. The indexed scope needs no
/// post-filter at all, so it takes the store's own ranked page directly.

import { realpathSync, statSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { parseFileToText } from '@genoffice/file-parse'
import type { IndexedFile } from './file-index/store'

/** characters of parsed text one read_knowledge_file page returns (aligned
 *  with the chat-attachment reader, files-skill.ts, so models meet one paging
 *  convention everywhere) */
export const KB_READ_CHUNK_CHARS = 24_000

/** byte cap per corpus file, aligned with the chat-attachment reader's
 *  ATTACHMENT_MAX_BYTES: a larger file is refused before parse rather than
 *  parsed and held in the text cache */
export const KB_READ_MAX_BYTES = 50 * 1024 * 1024

/** query cap, same as the home search box */
const KB_QUERY_MAX_CHARS = 200

/** how many indexed hits to fetch before filtering to the starred set */
const KB_SEARCH_POOL = 200

/**
 * How many files kb:list returns for the indexed scope: the listing is a
 * prompt window (the model searches first; the system prompt says so), and a
 * hundred rows is about what the knowledge-base skill's context budget shows
 * before it degrades to names only.
 */
export const KB_LIST_CAP = 100

/**
 * The knowledge-base corpus scope (app-settings.json `kbScope`); default: the
 * whole index. `'folders'` narrows to the folders in `kbScopeFolders` — the
 * corpus is then the indexed (and starred) files under those roots.
 */
export type KbScope = 'indexed' | 'starred' | 'folders'

export function normalizeKbScope(raw: unknown): KbScope {
  return raw === 'starred' || raw === 'folders' ? raw : 'indexed'
}

/**
 * The `kbScopeFolders` list, normalized: string entries only, de-duplicated,
 * sorted (so the settings file and the UI see one stable shape regardless of
 * the order the folders were picked in).
 */
export function normalizeKbScopeFolders(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out = new Set<string>()
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.length > 0) out.add(entry)
  }
  return [...out].sort()
}

/**
 * Real-path prefix membership: `path` is under `roots` when it equals a root
 * or sits below it (either separator, matching the renderer's isUnder in
 * home-shared.tsx). A root may arrive with a trailing separator — hand-edited
 * settings values, windows dialogs — so both spellings of the same root
 * match; the filesystem root stays a lone separator, and its children must
 * not double it.
 *
 * The scope roots are realpath'd (kb:add-scope-folder), but the index and the
 * starred list keep the spelling they were picked with — a symlinked or
 * junctioned folder can therefore appear under its alias on one side and its
 * target on the other. When the raw prefix test fails, the candidate is
 * retried through its own realpath so a file physically under a scope folder
 * matches regardless of the spelling it was recorded under. Raw-first keeps
 * the no-symlink common case syscall-free.
 */
export function isUnderAnyRoot(path: string, roots: readonly string[]): boolean {
  if (underAnyRootRaw(path, roots)) return true
  try {
    return underAnyRootRaw(realpathSync(path), roots)
  } catch {
    // a path that does not exist (or cannot be resolved) is simply not under
    return false
  }
}

/** the pure string test isUnderAnyRoot falls back from */
function underAnyRootRaw(path: string, roots: readonly string[]): boolean {
  for (const raw of roots) {
    if (raw === '') continue
    const root = raw.replace(/[\\/]+$/, '')
    if (root === '') {
      // the filesystem root ("/" or "\\"): everything absolute is under it
      if (path.startsWith('/') || path.startsWith('\\')) return true
      continue
    }
    if (path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)) return true
  }
  return false
}

/** one corpus entry as the AI (and the panel) sees it */
export interface KbFile {
  /** absolute path — also the citation target (filenav:///abs/path) */
  path: string
  /** owning folder name ("contracts" in /Users/me/contracts/lease.docx) */
  folder: string
  /** absolute folder path */
  folderPath: string
  name: string
  ext: string
  sizeBytes: number
}

/** search result as the model sees it */
export interface KbSearchHit {
  path: string
  name: string
  ext: string
  folder: string
  snippet: string
}

/** text extraction cache, keyed by path, invalidated by mtime+size */
const kbTextCache = new Map<string, { stamp: string; text: string }>()
const KB_TEXT_CACHE_MAX = 8

/** shape one KbFile from a path and its known size (stats taken by the caller) */
function kbFileOf(path: string, sizeBytes: number): KbFile {
  const folderPath = dirname(path)
  return {
    path,
    folder: basename(folderPath),
    folderPath,
    name: basename(path),
    ext: basename(path)
      .replace(/^[^.]*./, '')
      .toLowerCase(),
    sizeBytes,
  }
}

/** the starred corpus: every starred file that still exists on disk */
export function listKnowledgeFiles(starredPaths: readonly string[]): KbFile[] {
  const out: KbFile[] = []
  for (const path of starredPaths) {
    try {
      const stat = statSync(path)
      if (!stat.isFile()) continue
      out.push(kbFileOf(path, stat.size))
    } catch {
      // a starred path can outlive its file (r158 keeps the dimmed row in the
      // home UI); for the corpus it simply drops out
    }
  }
  return out
}

/**
 * The prompt's listing window for the indexed scope: the starred files first
 * (the user's deliberate picks), then the most recently touched indexed files
 * that are not already listed, capped at KB_LIST_CAP. Discovery past the
 * window goes through search — the skill's prompt says exactly that. With
 * `roots` (the 'folders' scope) both halves narrow to files under them.
 */
export function listIndexedKnowledgeFiles(
  starredPaths: readonly string[],
  recentIndexed: readonly IndexedFile[],
  cap: number = KB_LIST_CAP,
  roots?: readonly string[],
): KbFile[] {
  const underRoots =
    roots === undefined ? () => true : (path: string) => isUnderAnyRoot(path, roots)
  const out = listKnowledgeFiles(starredPaths.filter(underRoots))
  const listed = new Set(out.map((f) => f.path))
  for (const entry of recentIndexed) {
    if (out.length >= cap) break
    if (listed.has(entry.path) || !underRoots(entry.path)) continue
    out.push(kbFileOf(entry.path, entry.sizeBytes))
    listed.add(entry.path)
  }
  return out
}

/**
 * What the search filters by: `null` is the indexed scope (no post-filter —
 * the store's own ranked page is the answer), a real path set keeps the
 * starred behavior, and roots narrow to files under them. Both narrowing
 * scopes fetch the widened KB_SEARCH_POOL before filtering, because the
 * store's ranking spans the whole index and a scope-restricted "top limit"
 * would silently drop in-scope matches that out-of-scope files outrank.
 */
export type KbSearchScope = null | { paths: readonly string[] } | { roots: readonly string[] }

/**
 * Fetch + trim one search page; pure so it is unit-testable. Async because
 * the search runs in the store worker.
 */
export async function searchKnowledgeBase(
  search: (
    q: string,
    limit: number,
  ) => Promise<ReadonlyArray<{ path: string; name: string; ext: string; snippetText?: string }>>,
  query: string,
  scope: KbSearchScope,
  limit: number,
): Promise<KbSearchHit[]> {
  const q = query.trim().slice(0, KB_QUERY_MAX_CHARS)
  if (!q) return []
  const scopedPaths = scope !== null && 'paths' in scope ? new Set(scope.paths) : null
  const scopedRoots = scope !== null && 'roots' in scope ? scope.roots : null
  const inScope = (path: string): boolean => {
    if (scopedPaths !== null) return scopedPaths.has(path)
    if (scopedRoots !== null) return isUnderAnyRoot(path, scopedRoots)
    return true
  }
  // the store ranks over the whole index, so a narrowing scope must fetch a
  // widened pool before filtering — the caller's limit would otherwise leave
  // the answer as "globally top-N ∩ in-scope", silently empty when out-of-
  // scope files outrank the in-scope matches (the starred scope's own reason
  // for the 200 pool; the indexed scope applies no post-filter and keeps the
  // store's page as the answer)
  const pool = await search(q, scope === null ? limit : KB_SEARCH_POOL)
  const seen = new Set<string>()
  const out: KbSearchHit[] = []
  for (const hit of pool) {
    if (!inScope(hit.path)) continue
    if (seen.has(hit.path)) continue
    seen.add(hit.path)
    out.push({
      path: hit.path,
      name: hit.name,
      ext: hit.ext,
      folder: basename(dirname(hit.path)),
      snippet: hit.snippetText ?? '',
    })
    if (out.length >= limit) break
  }
  return out
}

/** parsed text of one corpus file; throws with a plain message the panel can
 *  show — shell main has no i18n channel of its own (unlike the docs
 *  attachment reader, whose errors carry locale strings and a larger budget) */
export async function readKnowledgeFileText(filePath: string): Promise<string> {
  const stat = statSync(filePath)
  const stamp = `${stat.mtimeMs}:${stat.size}`
  const cached = kbTextCache.get(filePath)
  if (cached && cached.stamp === stamp) return cached.text
  if (stat.size > KB_READ_MAX_BYTES) {
    throw new Error(
      `file too large to read (${Math.round(stat.size / 1024 / 1024)}MB, cap ${KB_READ_MAX_BYTES / 1024 / 1024}MB)`,
    )
  }
  const parsed = await parseFileToText(filePath)
  if (!parsed.ok || parsed.kind !== 'text' || parsed.text == null) {
    throw new Error(parsed.error ?? 'unreadable file')
  }
  kbTextCache.set(filePath, { stamp, text: parsed.text })
  if (kbTextCache.size > KB_TEXT_CACHE_MAX) {
    const oldest = kbTextCache.keys().next().value
    if (oldest) kbTextCache.delete(oldest)
  }
  return parsed.text
}

/** one page of a corpus file's text */
export interface KbReadPage {
  text: string
  /** total parsed characters, so the reader knows whether to page on */
  totalChars: number
  offset: number
}

export async function readKnowledgeFilePage(filePath: string, offset: number): Promise<KbReadPage> {
  const text = await readKnowledgeFileText(filePath)
  const start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0
  if (start >= text.length) return { text: '', totalChars: text.length, offset: start }
  return {
    text: text.slice(start, start + KB_READ_CHUNK_CHARS),
    totalChars: text.length,
    offset: start,
  }
}

// ---- create_document: the ask panel's one write path ----

export type KbCreateFormat = 'md' | 'docx'

export interface KbCreateRequest {
  title: string
  format: KbCreateFormat
  content: string
}

/** keep in step with CREATE_DOCUMENT_MAX_CHARS in agent-core */
export const KB_CREATE_MAX_CHARS = 2_000_000

/** validate the renderer's payload; throws a plain message for the panel */
export function parseKbCreateRequest(raw: unknown): KbCreateRequest {
  const req = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const format = req.format
  if (format !== 'md' && format !== 'docx') throw new Error('format must be "md" or "docx"')
  const content = typeof req.content === 'string' ? req.content : ''
  if (!content.trim()) throw new Error('content must not be empty')
  if (content.length > KB_CREATE_MAX_CHARS) throw new Error('content is too long')
  return { title: typeof req.title === 'string' ? req.title : '', format, content }
}

export interface KbCreateDeps {
  /** folder new files land in */
  dir: () => string
  /** `${sanitized title}${ext}` → first free absolute path in dir */
  uniquePath: (dir: string, fileName: string) => string
  sanitizeBase: (title: string) => string
  writeText: (path: string, text: string) => Promise<void>
  /** markdown → .docx at `out` (the bundled CLI) */
  markdownToDocx: (markdown: string, out: string) => Promise<void>
  recordRecent: (path: string) => void
}

export async function createKnowledgeDocument(
  deps: KbCreateDeps,
  req: KbCreateRequest,
): Promise<{ path: string }> {
  const path = deps.uniquePath(deps.dir(), `${deps.sanitizeBase(req.title)}.${req.format}`)
  if (req.format === 'md') await deps.writeText(path, req.content)
  else await deps.markdownToDocx(req.content, path)
  deps.recordRecent(path)
  return { path }
}
