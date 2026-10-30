import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileIndexStore } from '../src/main/file-index/store'
import {
  KB_LIST_CAP,
  isUnderAnyRoot,
  listIndexedKnowledgeFiles,
  normalizeKbScope,
  normalizeKbScopeFolders,
  searchKnowledgeBase,
} from '../src/main/knowledge-base'

/**
 * The Ask AI corpus scope: 'indexed' (default) reaches every file the local
 * index covers, 'starred' keeps the original hand-picked set, 'folders'
 * narrows to the folders in kbScopeFolders (empty list = empty corpus).
 * Search drops the JS post-filter for the indexed and folders scopes (the
 * store's own ranked page is the answer; folders only re-checks the prefix),
 * the read gate probes index membership, and the prompt listing is a bounded
 * window of starred-first files.
 */

const HIT = (path: string) => ({
  path,
  name: path.split('/').pop()!,
  ext: 'docx',
  snippetText: '…hit…',
})

describe('normalizeKbScope', () => {
  it('defaults to indexed, keeps starred and folders, rejects junk', () => {
    expect(normalizeKbScope(undefined)).toBe('indexed')
    expect(normalizeKbScope('starred')).toBe('starred')
    expect(normalizeKbScope('folders')).toBe('folders')
    expect(normalizeKbScope('everything')).toBe('indexed')
  })
})

describe('normalizeKbScopeFolders', () => {
  it('keeps non-empty strings only, de-duplicated and sorted', () => {
    expect(normalizeKbScopeFolders(undefined)).toEqual([])
    expect(normalizeKbScopeFolders('/b')).toEqual([])
    expect(normalizeKbScopeFolders(['/b', '/a', '/b', '', 7, null, '/a'])).toEqual(['/a', '/b'])
  })
})

describe('isUnderAnyRoot', () => {
  it('accepts the root itself and its children, nothing else', () => {
    expect(isUnderAnyRoot('/proj', ['/proj'])).toBe(true)
    expect(isUnderAnyRoot('/proj/sub/a.docx', ['/proj'])).toBe(true)
    expect(isUnderAnyRoot('/project-x/a.docx', ['/proj'])).toBe(false)
    expect(isUnderAnyRoot('/other/a.docx', ['/proj'])).toBe(false)
  })

  it('handles separator-ending roots, the filesystem root, and blanks', () => {
    expect(isUnderAnyRoot('/proj/a.docx', ['/proj/'])).toBe(true)
    expect(isUnderAnyRoot('/proj', ['/proj/'])).toBe(true)
    // the '/' root already ends in a separator; its children must not double it
    expect(isUnderAnyRoot('/home/a.docx', ['/'])).toBe(true)
    expect(isUnderAnyRoot('/home/a.docx', [''])).toBe(false)
    // windows spellings: backslash children and a drive root
    expect(isUnderAnyRoot('C:\\docs\\a.docx', ['C:\\docs'])).toBe(true)
    expect(isUnderAnyRoot('C:\\a.docx', ['C:\\'])).toBe(true)
    expect(isUnderAnyRoot('D:\\a.docx', ['C:\\'])).toBe(false)
  })

  it('retries a failing candidate through its realpath, so a symlinked spelling matches', () => {
    const real = mkdtempSync(join(tmpdir(), 'genoffice-kb-real-'))
    const alias = join(tmpdir(), 'genoffice-kb-alias')
    symlinkSync(real, alias, 'dir')
    // the candidate must exist for its realpath to resolve, and the roots
    // must be canonical — kb:add-scope-folder realpath's what it stores
    writeFileSync(join(real, 'a.docx'), 'x')
    const realRoot = realpathSync(real)
    const aliasRoot = realpathSync(alias)
    try {
      const throughAlias = join(alias, 'a.docx')
      const throughReal = join(real, 'a.docx')
      // the index or starred list may hold either spelling for the same file
      expect(isUnderAnyRoot(throughAlias, [realRoot])).toBe(true)
      expect(isUnderAnyRoot(throughReal, [aliasRoot])).toBe(true)
      // a genuinely unrelated path still fails, and a missing one resolves
      // to "not under" rather than throwing
      expect(isUnderAnyRoot('/elsewhere/a.docx', [realRoot])).toBe(false)
      expect(isUnderAnyRoot(join(alias, 'missing.docx'), [realRoot])).toBe(false)
    } finally {
      rmSync(alias, { force: true })
      rmSync(real, { recursive: true, force: true })
    }
  })
})

describe('searchKnowledgeBase', () => {
  const poolOf = (paths: string[]) => paths.map(HIT)

  it('indexed scope (null) takes the store page directly — no 200-pool fetch', async () => {
    const requested: number[] = []
    const search = (q: string, limit: number) => {
      requested.push(limit)
      return poolOf(['/a/1.docx', '/b/2.docx'])
    }
    const hits = await searchKnowledgeBase(async (q, limit) => search(q, limit), 'report', null, 8)
    expect(requested).toEqual([8])
    expect(hits.map((h) => h.path)).toEqual(['/a/1.docx', '/b/2.docx'])
  })

  it('starred scope keeps the pool fetch and the membership filter', async () => {
    const requested: number[] = []
    const search = (q: string, limit: number) => {
      requested.push(limit)
      return poolOf(['/a/starred.docx', '/b/other.docx'])
    }
    const hits = await searchKnowledgeBase(
      async (q, limit) => search(q, limit),
      'report',
      { paths: ['/a/starred.docx'] },
      8,
    )
    expect(requested).toEqual([200])
    expect(hits.map((h) => h.path)).toEqual(['/a/starred.docx'])
  })

  it('folders scope widens the pool like the starred scope and filters by prefix', async () => {
    const requested: number[] = []
    const search = (q: string, limit: number) => {
      requested.push(limit)
      return poolOf(['/proj/a.docx', '/proj/sub/b.docx', '/project-x/c.docx', '/proj/a.docx'])
    }
    const hits = await searchKnowledgeBase(
      async (q, limit) => search(q, limit),
      'report',
      { roots: ['/proj'] },
      8,
    )
    // the store ranks over the whole index, so a narrowing scope must fetch
    // the widened pool — the caller's limit would leave the answer as
    // "globally top-N ∩ under the roots", empty whenever out-of-root files
    // outrank the in-root matches
    expect(requested).toEqual([200])
    expect(hits.map((h) => h.path)).toEqual(['/proj/a.docx', '/proj/sub/b.docx'])
    expect(hits[0]!.folder).toBe('proj')
  })

  it('trims the query and de-duplicates the hits', async () => {
    const search = () => poolOf(['/a/1.docx', '/a/1.docx', '/b/2.docx'])
    expect(await searchKnowledgeBase(async () => search(), '  x  ', null, 5)).toHaveLength(2)
    expect(await searchKnowledgeBase(async () => search(), '   ', null, 5)).toEqual([])
  })
})

describe('listIndexedKnowledgeFiles', () => {
  let dir: string
  let outsideDir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'genoffice-kb-scope-'))
    outsideDir = mkdtempSync(join(tmpdir(), 'genoffice-kb-outside-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  })

  const indexed = (paths: string[]) =>
    paths.map((path, i) => ({ path, mtimeMs: i, sizeBytes: 10 + i, status: 'ok' as const }))

  it('lists starred files first, then recent indexed ones, deduplicated and capped', () => {
    const starred = join(dir, 'starred.docx')
    writeFileSync(starred, 'x')
    const list = listIndexedKnowledgeFiles(
      [starred, join(dir, 'gone.docx')],
      indexed([starred, '/idx/a.docx', '/idx/b.docx']),
    )
    // the starred file exists on disk and leads; the vanished one drops out;
    // the indexed copy of the starred path is not duplicated
    expect(list.map((f) => f.path)).toEqual([starred, '/idx/a.docx', '/idx/b.docx'])
    expect(list[0]!.folder).toBe(basename(dir))
  })

  it('honors the cap', () => {
    const many = indexed(Array.from({ length: 300 }, (_, i) => `/idx/file-${i}.docx`))
    expect(listIndexedKnowledgeFiles([], many)).toHaveLength(KB_LIST_CAP)
  })

  it('narrows both halves to the roots when given', () => {
    const starred = join(dir, 'in-root-starred.docx')
    const outside = join(outsideDir, 'elsewhere.docx')
    writeFileSync(starred, 'x')
    writeFileSync(outside, 'y')
    const list = listIndexedKnowledgeFiles(
      [starred, outside],
      indexed([starred, '/idx/in-root.docx', '/outside/elsewhere.docx']),
      KB_LIST_CAP,
      [dir, '/idx'],
    )
    // the starred half keeps only files under the roots; the indexed half
    // re-checks the same prefix; the in-root starred path is not duplicated
    expect(list.map((f) => f.path)).toEqual([starred, '/idx/in-root.docx'])
  })
})

describe('FileIndexStore.has / recentFiles (the indexed-scope gates)', () => {
  let dir: string
  let store: FileIndexStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'genoffice-kb-index-'))
    store = new FileIndexStore(join(dir, 'index.db'))
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('has() answers membership exactly', () => {
    store.upsert({ path: '/docs/a.docx', mtimeMs: 1, sizeBytes: 10 }, 'hello', 'ok')
    expect(store.has('/docs/a.docx')).toBe(true)
    expect(store.has('/docs/other.docx')).toBe(false)
  })

  it('recentFiles() returns newest first, honoring the limit', () => {
    store.upsert({ path: '/docs/old.docx', mtimeMs: 100, sizeBytes: 10 }, null, 'name-only')
    store.upsert({ path: '/docs/new.docx', mtimeMs: 200, sizeBytes: 20 }, 'text', 'ok')
    store.upsert({ path: '/docs/mid.docx', mtimeMs: 150, sizeBytes: 15 }, 'text', 'ok')
    const all = store.recentFiles(10)
    expect(all.map((f) => f.path)).toEqual(['/docs/new.docx', '/docs/mid.docx', '/docs/old.docx'])
    expect(all[0]!.sizeBytes).toBe(20)
    expect(store.recentFiles(2)).toHaveLength(2)
  })
})
