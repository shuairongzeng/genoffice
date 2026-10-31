import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileIndexStore } from '../src/main/file-index/store'
import {
  KB_LIST_CAP,
  KB_ONLY_PATHS_MAX,
  KB_SCOPE_FOLDERS_MAX,
  isUnderAnyRoot,
  kbReadAllows,
  listIndexedKnowledgeFiles,
  normalizeKbScope,
  normalizeKbScopeFolders,
  notIndexedPaths,
  parseKbOnlyPaths,
  searchKnowledgeBase,
} from '../src/main/knowledge-base'

/**
 * The Ask AI corpus scope: 'indexed' (default) reaches every file the local
 * index covers, 'starred' keeps the original hand-picked set, 'folders'
 * narrows to the folders in kbScopeFolders (empty list = empty corpus).
 * Search drops the JS post-filter for the indexed scope (the store's own
 * ranked page is the answer) and checks the prefix for the folders scope,
 * the read gate probes index membership, and the prompt listing is a bounded
 * window of starred-first files.
 *
 * The round scope (an explicit file selection as one conversation's corpus)
 * rides on top and outranks the settings for the call: onlyPaths payloads
 * are validated (strings, absolute, length, count), the read gate narrows to
 * the selection and admits a selected existing office file only at a
 * whitelisted location (a folder root, a desktop alias, a recent or a star),
 * and the not-indexed report says which selected paths the index does not
 * cover.
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

  it('refuses a list past the cap instead of trimming it', () => {
    // a hand-edited settings file cannot widen the corpus roots: the cap
    // throws, so the kb: readers refuse the call rather than serve half a
    // scope the settings page would then show as something else
    expect(() =>
      normalizeKbScopeFolders(
        Array.from({ length: KB_SCOPE_FOLDERS_MAX + 1 }, (_, i) => `/roots/${i}`),
      ),
    ).toThrow(/at most 50 folders/)
    // the cap counts distinct entries: duplicates fold before it, and junk
    // entries never count toward it
    const dupes = Array.from({ length: KB_SCOPE_FOLDERS_MAX + 20 }, (_, i) => `/roots/${i % 50}`)
    expect(normalizeKbScopeFolders(dupes)).toHaveLength(50)
    expect(
      normalizeKbScopeFolders([
        ...Array.from({ length: KB_SCOPE_FOLDERS_MAX }, (_, i) => `/r/${i}`),
        '',
      ]),
    ).toHaveLength(KB_SCOPE_FOLDERS_MAX)
    expect(
      normalizeKbScopeFolders(Array.from({ length: KB_SCOPE_FOLDERS_MAX }, (_, i) => `/ok/${i}`)),
    ).toHaveLength(KB_SCOPE_FOLDERS_MAX)
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

describe('parseKbOnlyPaths — the round-scope payload', () => {
  it('absent and empty mean no round scope (null)', () => {
    expect(parseKbOnlyPaths(undefined)).toBeNull()
    expect(parseKbOnlyPaths(null)).toBeNull()
    expect(parseKbOnlyPaths([])).toBeNull()
  })

  it('keeps a validated selection, deduplicated in order', () => {
    expect(parseKbOnlyPaths(['/a/1.docx', '/a/1.docx', '/b/2.docx'])).toEqual([
      '/a/1.docx',
      '/b/2.docx',
    ])
  })

  it('rejects wrong shapes, relative paths, over-long paths and over-many paths', () => {
    expect(() => parseKbOnlyPaths('/a/1.docx')).toThrow(/array of absolute paths/)
    expect(() => parseKbOnlyPaths({ 0: '/a/1.docx' })).toThrow(/array of absolute paths/)
    expect(() => parseKbOnlyPaths(['/a/1.docx', 42])).toThrow(/must be strings/)
    expect(() => parseKbOnlyPaths(['relative/1.docx'])).toThrow(/absolute/)
    expect(() => parseKbOnlyPaths([''])).toThrow(/absolute/)
    expect(() => parseKbOnlyPaths([`/${'a'.repeat(4097)}.docx`])).toThrow(/too long/)
    expect(() =>
      parseKbOnlyPaths(Array.from({ length: KB_ONLY_PATHS_MAX + 1 }, (_, i) => `/idx/${i}.docx`)),
    ).toThrow(/at most 50/)
    // node:path's isAbsolute is platform-specific: a Windows drive path is
    // absolute only where it is a real path
    const winPath = 'C:\\Users\\me\\a.docx'
    if (process.platform === 'win32') {
      expect(parseKbOnlyPaths([winPath])).toEqual([winPath])
    } else {
      expect(() => parseKbOnlyPaths([winPath])).toThrow(/absolute/)
    }
  })
})

describe('kbReadAllows — the read gate with a round scope', () => {
  let dir: string
  const statFile = (path: string) => {
    try {
      return statSync(path)
    } catch {
      return null
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'genoffice-kb-gate-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('admits what the corpus already admits, scope or not', () => {
    expect(
      kbReadAllows('/idx/a.docx', {
        inCorpus: true,
        scopePaths: null,
        locationAllowed: false,
        statFile,
      }),
    ).toBe(true)
    expect(
      kbReadAllows('/idx/a.docx', {
        inCorpus: false,
        scopePaths: null,
        locationAllowed: true,
        statFile,
      }),
    ).toBe(false)
  })

  it('a scope narrows: a corpus path outside the selection is refused, an in-scope one reads', () => {
    const indexed = join(dir, 'indexed.docx')
    writeFileSync(indexed, 'x')
    expect(
      kbReadAllows(indexed, {
        inCorpus: true,
        scopePaths: [join(dir, 'picked.docx')],
        locationAllowed: false,
        statFile,
      }),
    ).toBe(false)
    expect(
      kbReadAllows(indexed, {
        inCorpus: true,
        scopePaths: [indexed],
        locationAllowed: false,
        statFile,
      }),
    ).toBe(true)
  })

  it('a selected file the index missed is readable when its location is whitelisted and it is an office type', () => {
    const picked = join(dir, 'picked.docx')
    writeFileSync(picked, 'x')
    expect(
      kbReadAllows(picked, {
        inCorpus: false,
        scopePaths: [picked],
        locationAllowed: true,
        statFile,
      }),
    ).toBe(true)
  })

  it('refuses a selected path whose location is not whitelisted — off every root, not an alias, not tracked', () => {
    const stray = join(dir, 'stray.docx')
    writeFileSync(stray, 'x')
    expect(
      kbReadAllows(stray, {
        inCorpus: false,
        scopePaths: [stray],
        locationAllowed: false,
        statFile,
      }),
    ).toBe(false)
  })

  it('refuses a whitelisted selected path that is gone, a directory, or not a readable office type', () => {
    const gone = join(dir, 'gone.docx')
    const archive = join(dir, 'packed.zip')
    writeFileSync(archive, 'not office')
    const folder = join(dir, 'sub.docx')
    mkdirSync(folder)
    for (const path of [gone, archive, folder]) {
      expect(
        kbReadAllows(path, {
          inCorpus: false,
          scopePaths: [path],
          locationAllowed: true,
          statFile,
        }),
      ).toBe(false)
    }
  })

  it('refuses a path outside the selection even when a scope is attached', () => {
    const picked = join(dir, 'picked.docx')
    writeFileSync(picked, 'x')
    expect(
      kbReadAllows(join(dir, 'other.docx'), {
        inCorpus: false,
        scopePaths: [picked],
        locationAllowed: true,
        statFile,
      }),
    ).toBe(false)
  })
})

describe('notIndexedPaths — the scope paths the index does not cover', () => {
  it('answers membership per path, in order', async () => {
    const store = { has: async (path: string) => path.startsWith('/idx/') }
    expect(
      await notIndexedPaths(store, ['/idx/a.docx', '/elsewhere/b.docx', '/idx/c.docx']),
    ).toEqual(['/elsewhere/b.docx'])
  })

  it('a failing membership probe reads as not indexed, no throw', async () => {
    const store = {
      has: async (path: string) => {
        if (path === '/boom') throw new Error('store gone')
        return true
      },
    }
    expect(await notIndexedPaths(store, ['/fine.docx', '/boom'])).toEqual(['/boom'])
  })

  it('no store: the whole selection reports not indexed', async () => {
    expect(await notIndexedPaths(null, ['/a.docx', '/b.docx'])).toEqual(['/a.docx', '/b.docx'])
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
