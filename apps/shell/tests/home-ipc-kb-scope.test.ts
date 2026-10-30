import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The kb: handlers' 'folders' scope wiring in registerHomeFileIpc: what the
 * app-settings scope selects on each channel. The listing narrows both its
 * halves to the roots — including the no-store fallback's starred half, so a
 * cold-start listing cannot claim files the read gate would refuse; the
 * search builds the roots scope (observable through the widened pool the
 * narrowing scopes fetch); and the read gate is the conjunction "under a
 * root AND starred-or-indexed", so an indexed file outside the chosen
 * folders is no longer corpus-readable.
 *
 * The app main modules are faked at the app-registry seam (the shell's
 * single import site for them) so the real docs-main never loads; the
 * starred list and the settings file are the two stores under test.
 */

const handles = new Map<string, (...args: never[]) => unknown>()
let userData = ''
/** the starred list the app-registry mock serves */
let starred: string[] = []

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { fromWebContents: () => null },
  WebContentsView: class {},
  dialog: { showErrorBox: () => {}, showMessageBox: () => {}, showOpenDialog: () => {} },
  ipcMain: {
    handle: (channel: string, handler: (...args: never[]) => unknown) =>
      handles.set(channel, handler),
  },
  shell: { openPath: () => '', openExternal: () => {} },
}))

vi.mock('../src/main/app-registry', () => ({
  // the routing table's shape (id + extensions), enough for app-routing's
  // module-scope regexes; the views/menus themselves never run here
  appForPath: () => null,
  documentApps: [
    { id: 'docs', extensions: ['docx', 'odt', 'ott'] },
    { id: 'sheets', extensions: ['xlsx', 'xlsm', 'xls', 'csv', 'tsv', 'ods', 'ots'] },
    { id: 'slides', extensions: ['pptx', 'ppt', 'odp', 'otp'] },
    { id: 'pdf', extensions: ['pdf'] },
    { id: 'markdown', extensions: ['md', 'markdown', 'txt'] },
    { id: 'html', extensions: ['html', 'htm'] },
  ],
  defaultSaveDir: () => '',
  projectFileRenamed: () => {},
  readRecentFiles: () => [],
  readStarredFiles: () => starred,
  readStarredGroupMap: () => new Map(),
  readStarredGroups: () => [],
  recordRecentFile: () => {},
  removeRecentFiles: () => {},
  removeStarredFiles: () => {},
  setStarredGroup: () => {},
  toggleStarredFile: () => {},
  uniquePathIn: () => '',
}))

import { registerHomeFileIpc } from '../src/main/home-ipc'

/** one indexed store record, the shape recentFiles answers */
const indexed = (path: string) => ({ path, mtimeMs: 1, sizeBytes: 12, status: 'ok' as const })

describe('home-ipc kb channels — the folders scope', () => {
  let root: string
  let outside: string
  let inStarred: string
  let outStarred: string
  let inIndexedOnly: string
  let outIndexedOnly: string
  /** the fake store's answers, swapped per test */
  let hasPaths: Set<string>
  let recentPaths: string[]
  let searchHits: { path: string; name: string; ext: string }[]
  let searchLimits: number[]

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'genoffice-home-kb-'))
    root = realpathSync(mkdtempSync(join(tmpdir(), 'genoffice-home-kb-root-')))
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'genoffice-home-kb-out-')))
    inStarred = join(root, 'in-starred.txt')
    outStarred = join(outside, 'out-starred.txt')
    inIndexedOnly = join(root, 'in-indexed.txt')
    outIndexedOnly = join(outside, 'out-indexed.txt')
    for (const [path, text] of [
      [inStarred, 'hello from the starred file'],
      [outStarred, 'starred but outside the roots'],
      [inIndexedOnly, 'indexed only, inside'],
      [outIndexedOnly, 'indexed only, outside'],
    ] as const) {
      writeFileSync(path, text)
    }
    starred = [inStarred, outStarred]
    hasPaths = new Set([inIndexedOnly, outIndexedOnly])
    recentPaths = [inStarred, inIndexedOnly, outIndexedOnly]
    searchHits = [inStarred, inIndexedOnly, outIndexedOnly].map((path) => ({
      path,
      name: path.split('/').pop()!,
      ext: 'txt',
    }))
    searchLimits = []

    const store = {
      has: (path: string) => Promise.resolve(hasPaths.has(path)),
      recentFiles: async () => recentPaths.map(indexed),
      search: async (_q: string, opts: { limit: number }) => {
        searchLimits.push(opts.limit)
        return { hits: searchHits, total: searchHits.length }
      },
    }
    const host = {
      translate: (key: string) => key,
      appSettingsPath: () => join(userData, 'app-settings.json'),
      indexStore: () => store,
      ensureFileIndexer: () => null,
    } as unknown as Parameters<typeof registerHomeFileIpc>[0]
    registerHomeFileIpc(host)
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  const setScope = (scope: 'indexed' | 'starred' | 'folders', folders?: string[]): void => {
    writeFileSync(
      join(userData, 'app-settings.json'),
      JSON.stringify({ kbScope: scope, ...(folders ? { kbScopeFolders: folders } : {}) }),
    )
  }
  const kbList = () => handles.get('kb:list')!() as Promise<{ path: string }[]>
  const kbRead = (path: string) =>
    handles.get('kb:read')!(undefined, { path }) as Promise<{ text: string }>
  const kbSearch = (q: string) =>
    handles.get('kb:search')!(undefined, { q, limit: 8 }) as Promise<{ path: string }[]>

  it('kb:list narrows both halves to the roots', async () => {
    setScope('folders', [root])
    const files = await kbList()
    expect(files.map((f) => f.path)).toEqual([inStarred, inIndexedOnly])
  })

  it('kb:list with no store narrows the starred fallback too — a cold start cannot claim what the read gate refuses', async () => {
    // swap the store out: the fallback listing is the starred half alone
    const host = {
      translate: (key: string) => key,
      appSettingsPath: () => join(userData, 'app-settings.json'),
      indexStore: () => null,
      ensureFileIndexer: () => null,
    } as unknown as Parameters<typeof registerHomeFileIpc>[0]
    registerHomeFileIpc(host)

    setScope('folders', [root])
    expect((await kbList()).map((f) => f.path)).toEqual([inStarred])
    // an empty root list is an empty corpus, not "all starred files"
    setScope('folders', [])
    expect(await kbList()).toEqual([])
    // the starred scope keeps its original unfiltered fallback
    setScope('starred')
    expect((await kbList()).map((f) => f.path)).toEqual([inStarred, outStarred])
  })

  it('kb:read admits under-root files and refuses out-of-root ones, starred or indexed', async () => {
    setScope('folders', [root])
    await expect(kbRead(inStarred)).resolves.toMatchObject({
      text: 'hello from the starred file',
    })
    await expect(kbRead(inIndexedOnly)).resolves.toMatchObject({
      text: 'indexed only, inside',
    })
    // a starred file outside the roots: readable in the starred scope, refused here
    await expect(kbRead(outStarred)).rejects.toThrow('path is not in the knowledge base')
    // an indexed file outside the roots: covered by the index, still not corpus
    await expect(kbRead(outIndexedOnly)).rejects.toThrow('path is not in the knowledge base')

    setScope('starred')
    await expect(kbRead(outStarred)).resolves.toMatchObject({
      text: 'starred but outside the roots',
    })
  })

  it('kb:search fetches the widened pool and filters by the roots', async () => {
    setScope('folders', [root])
    const hits = await kbSearch('hello')
    // the narrowing scope fetches the 200 pool, not the caller's 8
    expect(searchLimits).toEqual([200])
    expect(hits.map((h) => h.path)).toEqual([inStarred, inIndexedOnly])

    searchLimits = []
    setScope('indexed')
    const unfiltered = await kbSearch('hello')
    // the indexed scope keeps the store page as the answer: the caller's limit
    expect(searchLimits).toEqual([8])
    expect(unfiltered).toHaveLength(3)
  })
})
