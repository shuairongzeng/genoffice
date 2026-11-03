import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The knowledge-base channels behind the Ask AI panel (kb:search / kb:read in
 * home-ipc) against a mocked Electron and a fake index store: the round scope
 * — an explicit file selection as one conversation's corpus — intersects
 * search with the selection, reports the selected paths the index does not
 * cover as `notIndexed`, and narrows the read gate the same way: a selected
 * existing office file is readable only at a whitelisted location (the alias
 * list, the recents, the stars, or inside a folder root — the host and
 * registry stubs answer those lists per test), and a corpus file outside the
 * selection is refused. Scope payloads are validated the same way in both
 * channels: strings, absolute, per-path length, count. Unscoped calls keep
 * answering the bare hit array a renderer that predates onlyPaths reads.
 */

const handles = new Map<string, (...args: never[]) => unknown>()

/** the OS trash calls the delete handler made (the electron mock's record) */
const trashCalls = vi.hoisted(() => [] as string[])

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/genoffice-home-ipc-kb' },
  BrowserWindow: class {},
  dialog: {
    showOpenDialog: async () => ({ canceled: false, filePaths: ['/desk/added.md'] }),
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: never[]) => unknown) =>
      handles.set(channel, handler),
  },
  shell: {
    trashItem: async (path: string) => void trashCalls.push(path),
  },
}))

// app-registry re-exports the six app main modules; the kb handlers only need
// the starred and recent lists, so the registry is stubbed rather than loaded.
// The descriptor table stays (app-routing builds its extension regexes from it at
// import time) with just the fields that load-time code reads. The lists are
// hoisted mutable state so a test can place a path in the round-scope
// location whitelist (recents) or leave it out.
const APPS = vi.hoisted(() =>
  ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html'].map((id) => ({
    id,
    family: id,
    extensions: [id === 'markdown' ? 'md' : id],
    untitledTitle: id,
    untitledTitleKey: `untitled-${id}`,
  })),
)

/** the recents list the registry stub answers with (per test) */
const recentsState = vi.hoisted(() => ({ paths: [] as string[] }))
/** the desktop alias list the host stub answers with (per test) */
const aliasState = vi.hoisted(() => ({ paths: [] as string[] }))
/** the open-document paths the host stub answers with (per test) */
const openDocsState = vi.hoisted(() => ({
  paths: [] as Array<{ path: string; kind: string }>,
}))

vi.mock('../src/main/app-registry', () => ({
  documentApps: APPS,
  appForPath: (path: string) =>
    APPS.find((app) => path.endsWith(`.${app.extensions[0]}`))?.id ?? null,
  appForKind: (kind: string) => APPS.find((app) => app.id === kind) ?? null,
  appIsDirty: () => false,
  resetSheetsShuttingDown: () => {},
  defaultSaveDir: () => '/tmp/genoffice-home-ipc-kb/save',
  projectFileRenamed: () => {},
  readRecentFiles: () => recentsState.paths,
  readStarredFiles: () => [] as string[],
  readStarredGroupMap: () => new Map<string, string>(),
  readStarredGroups: () => [] as string[],
  recordRecentFile: () => {},
  removeRecentFiles: () => {},
  removeStarredFiles: () => {},
  setStarredGroup: () => {},
  toggleStarredFile: () => {},
  uniquePathIn: (dir: string, name: string) => join(dir, name),
}))

import { registerHomeFileIpc, type HomeFileIpcHost } from '../src/main/home-ipc'

/** the fake store: a fixed search table plus an index-membership set */
const INDEXED = new Set<string>(['/idx/contract.docx', '/idx/other.pdf'])

const searchImpl = vi.fn(async (q: string, opts?: { limit?: number }) => ({
  total: 3,
  hits: [...INDEXED]
    .filter((path) => path.includes(q))
    .slice(0, opts?.limit ?? 50)
    .map((path) => ({
      path,
      name: path.split('/').pop()!,
      ext: path.split('.').pop()!,
      folder: 'idx',
      snippet: [{ text: '…hit…' }],
      mtimeMs: 1,
      sizeBytes: 10,
      starred: false,
    })),
}))

const store = {
  search: searchImpl,
  has: async (path: string) => INDEXED.has(path),
  recentFiles: async () => [] as Array<{ path: string; mtimeMs: number; sizeBytes: number }>,
}

const host = {
  translate: (key: string) => key,
  appSettingsPath: () => settingsPath,
  getShellWindow: () => null,
  getTabManager: () => null,
  ensureFileIndexer: () => null,
  indexStore: () => store as never,
  refreshIndexer: () => {},
  indexNow: async () => {},
  readFileSearchSettings: () => ({ rerank: false }) as never,
  ensureSearchReranker: () => null,
  openDocumentPath: () => false,
  rememberPendingDir: () => {},
  newDocTab: () => {},
  newSheetTab: () => {},
  newSlideTab: () => {},
  newMarkdownTab: () => {},
  newHtmlTab: () => {},
  newBrowserTab: () => {},
  newPdfTab: () => {},
  afterFileMoved: () => {},
  afterFolderMoved: () => {},
  trackedFilesUnder: () => [] as string[],
  fileTargetSources: () => ({}) as never,
  statMaybeFile: (path: string) => {
    try {
      return statSync(path)
    } catch {
      return null
    }
  },
  /** the open-document list the edit_file guard consults (per test) */
  openDocumentPaths: () => openDocsState.paths,
  extraFolderRoots: () => [] as string[],
  insideAnyRoot: () => false,
  isAnyRoot: () => false,
  desktopAliases: () => aliasState.paths,
  ensureFolderWatchers: () => {},
  droppedFilesDeps: () => ({}) as never,
  cliRunner: () => ({}) as never,
  fetchGithubStars: async () => null,
  openDialogExtensions: [] as readonly string[],
} as HomeFileIpcHost

const invoke = (channel: string, ...args: unknown[]) =>
  handles.get(channel)!({ sender: { id: 1 } } as never, ...args)

let dir: string
let settingsPath: string

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'genoffice-kb-ipc-')))
  settingsPath = join(dir, 'app-settings.json')
  handles.clear()
  searchImpl.mockClear()
  trashCalls.length = 0
  recentsState.paths = []
  aliasState.paths = []
  openDocsState.paths = []
  registerHomeFileIpc(host)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('kb:edit-file — the patch gate over the kb scope', () => {
  /** an in-scope file: on the recents list, in a real (non-symlinked) temp dir */
  const scopedFile = (name: string, text: string): string => {
    const path = join(dir, name)
    writeFileSync(path, text)
    recentsState.paths.push(path)
    return path
  }

  it('edits an in-scope file: the one occurrence is replaced on disk', async () => {
    const file = scopedFile('notes.md', '# Notes\n\nold text\n\nbye')
    const answer = (await invoke('kb:edit-file', {
      path: file,
      old_string: 'old text',
      new_string: 'new text',
    })) as { path: string; occurrences: number; bytes: number }
    expect(answer.occurrences).toBe(1)
    expect(answer.path).toBe(file)
    expect(readFileSync(file, 'utf8')).toBe('# Notes\n\nnew text\n\nbye')
  })

  it('refuses a path the desktop never surfaced, before touching the disk', async () => {
    const file = join(dir, 'stranger.md')
    writeFileSync(file, 'x')
    await expect(
      invoke('kb:edit-file', { path: file, old_string: 'x', new_string: 'y' }),
    ).rejects.toThrow(/file scope/)
  })

  it('refuses a file an app has open, steering to document_agent (the routing safety net)', async () => {
    const file = scopedFile('open.docx', 'original content')
    // the docs app has this path open in a tab right now
    openDocsState.paths = [{ path: file, kind: 'docs' }]
    await expect(
      invoke('kb:edit-file', { path: file, old_string: 'original', new_string: 'rewritten' }),
    ).rejects.toThrow(/is open in the docs app right now/)
    // the refusal steers the model to the delegation, not to a retry
    await expect(
      invoke('kb:edit-file', { path: file, old_string: 'original', new_string: 'rewritten' }),
    ).rejects.toThrow(/goes through document_agent instead/)
    // nothing was written — the live document and the file never fork
    expect(readFileSync(file, 'utf8')).toBe('original content')
  })

  it('an open path in another app kind is refused with the same fork rationale', async () => {
    const file = scopedFile('sheet.csv', 'a,b\n1,2\n')
    openDocsState.paths = [{ path: file, kind: 'sheets' }]
    await expect(
      invoke('kb:edit-file', { path: file, old_string: 'a,b', new_string: 'x,y' }),
    ).rejects.toThrow(/is open in the sheets app right now/)
  })

  it('the guard canonicalizes both spellings: a symlinked directory still matches the open document', async () => {
    // the tab recorded the realpath'd spelling, the model asks through a
    // symlinked one (macOS hands /var/folders to callers and /private/var to
    // realpath — the raw string compare these spellings broke is what the
    // canonicalization is for)
    const file = scopedFile('open.md', 'content')
    openDocsState.paths = [{ path: file, kind: 'markdown' }]
    const aliased = join(dir, 'alias-root')
    symlinkSync(dir, aliased)
    await expect(
      invoke('kb:edit-file', {
        path: join(aliased, 'open.md'),
        old_string: 'content',
        new_string: 'x',
      }),
    ).rejects.toThrow(/is open in the markdown app right now/)
    // the fold is not one-way: the tab's symlinked spelling matches the
    // model's real one too (either side may carry either spelling)
    openDocsState.paths = [{ path: join(aliased, 'open.md'), kind: 'markdown' }]
    await expect(
      invoke('kb:edit-file', { path: file, old_string: 'content', new_string: 'x' }),
    ).rejects.toThrow(/is open in the markdown app right now/)
  })

  it('the guard folds Unicode composition: an NFD-open document refuses an NFC request', async () => {
    // 'é' on disk as e + U+0301 (NFD — the decomposition macOS hands back),
    // the open list records it that way, the model composes the accent (NFC):
    // both sides canonicalize to the composed form and the guard still fires.
    // The fold holds on a case-sensitive fs too: the composed spelling has no
    // file to resolve, so its raw normalized form is what compares.
    const name = 'cafe\u0301.md'
    const file = scopedFile(name, 'content')
    openDocsState.paths = [{ path: file, kind: 'markdown' }]
    const composed = file.replace(name, 'caf\u00e9.md')
    await expect(
      invoke('kb:edit-file', { path: composed, old_string: 'content', new_string: 'x' }),
    ).rejects.toThrow(/is open in the markdown app right now/)
    // and the mirror: the tab recorded the composed spelling (NFC), the model
    // decomposes (NFD)
    openDocsState.paths = [{ path: composed, kind: 'markdown' }]
    await expect(
      invoke('kb:edit-file', { path: file, old_string: 'content', new_string: 'x' }),
    ).rejects.toThrow(/is open in the markdown app right now/)
  })

  it('the guard folds letter case on a case-insensitive filesystem (the on-disk spelling wins)', async () => {
    const file = scopedFile('Report.md', 'content')
    openDocsState.paths = [{ path: file, kind: 'markdown' }]
    const varied = join(dir, 'rEPORT.md')
    // a case-sensitive fs (linux CI) has no second file there — the varied
    // spelling genuinely names nothing, and refusing it would be wrong; the
    // fold is a case-insensitive-disk behavior (macos, windows) and is pinned
    // only where it exists
    if (!existsSync(varied)) return
    await expect(
      invoke('kb:edit-file', { path: varied, old_string: 'content', new_string: 'x' }),
    ).rejects.toThrow(/is open in the markdown app right now/)
  })

  it('the same file, once the tab closed, edits normally again', async () => {
    const file = scopedFile('was-open.md', 'keep thisdrop this')
    openDocsState.paths = [{ path: file, kind: 'markdown' }]
    await expect(
      invoke('kb:edit-file', { path: file, old_string: 'drop this', new_string: 'kept' }),
    ).rejects.toThrow(/is open in the markdown app/)
    openDocsState.paths = []
    await expect(
      invoke('kb:edit-file', { path: file, old_string: 'drop this', new_string: 'kept' }),
    ).resolves.toBeDefined()
    expect(readFileSync(file, 'utf8')).toBe('keep thiskept')
  })

  it('not-found and ambiguous matches answer the patch errors', async () => {
    const file = scopedFile('twice.md', 'x x')
    await expect(
      invoke('kb:edit-file', { path: file, old_string: 'gone', new_string: 'y' }),
    ).rejects.toThrow(/was not found/)
    await expect(
      invoke('kb:edit-file', { path: file, old_string: 'x', new_string: 'y' }),
    ).rejects.toThrow(/matches 2 places/)
    // replace_all resolves the ambiguity on the caller's say-so
    const answer = (await invoke('kb:edit-file', {
      path: file,
      old_string: 'x',
      new_string: 'y',
      replace_all: true,
    })) as { occurrences: number }
    expect(answer.occurrences).toBe(2)
    expect(readFileSync(file, 'utf8')).toBe('y y')
  })

  it('a relative path is refused outright', async () => {
    await expect(
      invoke('kb:edit-file', { path: 'notes.md', old_string: 'a', new_string: 'b' }),
    ).rejects.toThrow(/absolute/)
  })
})

describe('kb:delete-file — one confirmation, the trash, fail closed', () => {
  it('moves an in-scope file to the OS trash when the panel confirmed it', async () => {
    const file = join(dir, 'notes.md')
    writeFileSync(file, 'x')
    recentsState.paths.push(file)
    const answer = (await invoke('kb:delete-file', { path: file, confirmed: true })) as {
      path: string
    }
    expect(answer).toEqual({ path: file })
    // the electron mock records the trash call; the real shell.trashItem is
    // what removes the file, and that is the OS's contract, not ours to test
    expect(trashCalls).toEqual([file])
  })

  it('refuses a delete that did not come through the panel card (fail closed)', async () => {
    const file = join(dir, 'notes.md')
    writeFileSync(file, 'x')
    recentsState.paths.push(file)
    await expect(invoke('kb:delete-file', { path: file })).rejects.toThrow(
      /did not come through the panel's confirmation/,
    )
    // a string "true" is not the fact either
    await expect(invoke('kb:delete-file', { path: file, confirmed: 'true' })).rejects.toThrow(
      /confirmation/,
    )
    expect(trashCalls).toEqual([])
    expect(statSync(file, { throwIfNoEntry: false })).toBeDefined()
  })

  it('refuses an out-of-scope path even when confirmed', async () => {
    const file = join(dir, 'stranger.md')
    writeFileSync(file, 'x')
    await expect(invoke('kb:delete-file', { path: file, confirmed: true })).rejects.toThrow(
      /file scope/,
    )
    expect(trashCalls).toEqual([])
  })

  it("refuses a delete of a file an app has open (the disk copy is the person's live document)", async () => {
    // the same gate edit_file carries: the card confirmed a delete, but an
    // app sitting on the file makes the disk copy the person's live document
    // — trashing it under the app throws their work away at the next save
    const file = join(dir, 'live.docx')
    writeFileSync(file, 'content')
    recentsState.paths.push(file)
    openDocsState.paths = [{ path: file, kind: 'docs' }]
    await expect(invoke('kb:delete-file', { path: file, confirmed: true })).rejects.toThrow(
      /is open in the docs app right now/,
    )
    await expect(invoke('kb:delete-file', { path: file, confirmed: true })).rejects.toThrow(
      /document_agent instead/,
    )
    expect(trashCalls).toEqual([])
    expect(statSync(file, { throwIfNoEntry: false })).toBeDefined()
  })

  it('the delete guard canonicalizes the spelling too: a symlinked path is still the open document', async () => {
    // the guard shares edit_file's canonicalization, so a spelling change
    // cannot route a live document into the trash either
    const file = join(dir, 'live.md')
    writeFileSync(file, 'content')
    recentsState.paths.push(file)
    openDocsState.paths = [{ path: file, kind: 'markdown' }]
    const aliased = join(dir, 'alias-root')
    symlinkSync(dir, aliased)
    await expect(
      invoke('kb:delete-file', { path: join(aliased, 'live.md'), confirmed: true }),
    ).rejects.toThrow(/is open in the markdown app right now/)
    expect(trashCalls).toEqual([])
    expect(statSync(file, { throwIfNoEntry: false })).toBeDefined()
  })

  it('a symlink whose target sits outside the scope cannot smuggle a file past the gate', async () => {
    const target = join(dir, 'secret.md')
    writeFileSync(target, 'x')
    const link = join(dir, 'report.md')
    symlinkSync(target, link)
    // the link's own location is surfaced (a recent), its target is not
    recentsState.paths.push(link)
    await expect(invoke('kb:delete-file', { path: link, confirmed: true })).rejects.toThrow(
      /resolves outside the desktop's file scope|file scope/,
    )
    await expect(
      invoke('kb:edit-file', { path: link, old_string: 'x', new_string: 'y' }),
    ).rejects.toThrow(/file scope/)
    expect(trashCalls).toEqual([])
    expect(readFileSync(target, 'utf8')).toBe('x')
  })

  it('a missing file answers that nothing was deleted', async () => {
    const file = join(dir, 'gone.md')
    recentsState.paths.push(file)
    await expect(invoke('kb:delete-file', { path: file, confirmed: true })).rejects.toThrow(
      /nothing was deleted/,
    )
    expect(trashCalls).toEqual([])
  })
})

describe('kb:search — the round scope', () => {
  it('answers a bare hit array when no onlyPaths rides the query', async () => {
    const answer = await invoke('kb:search', { q: 'contract', limit: 8 })
    expect(Array.isArray(answer)).toBe(true)
    expect((answer as { path: string }[]).map((h) => h.path)).toEqual(['/idx/contract.docx'])
  })

  it('intersects the index with the selection and reports the not-indexed paths', async () => {
    const answer = (await invoke('kb:search', {
      q: 'idx',
      limit: 8,
      onlyPaths: ['/idx/contract.docx', '/idx/unindexed.docx', '/elsewhere/notes.md'],
    })) as { hits: { path: string }[]; notIndexed: string[] }
    expect(answer.hits.map((h) => h.path)).toEqual(['/idx/contract.docx'])
    // the second path exists in no index; the third is another index's
    expect(answer.notIndexed).toEqual(['/idx/unindexed.docx', '/elsewhere/notes.md'])
  })

  it('the round scope overrides a starred kbScope for that call', async () => {
    writeFileSync(settingsPath, JSON.stringify({ kbScope: 'starred' }))
    const answer = (await invoke('kb:search', {
      q: 'contract',
      limit: 8,
      onlyPaths: ['/idx/contract.docx'],
    })) as { hits: { path: string }[]; notIndexed: string[] }
    // unstarred and outside the starred corpus — in the selection, so a hit
    expect(answer.hits.map((h) => h.path)).toEqual(['/idx/contract.docx'])
  })

  it('no store answers an empty scope with every path not indexed', async () => {
    const hostNoStore = { ...host, indexStore: () => null }
    handles.clear()
    registerHomeFileIpc(hostNoStore)
    const answer = (await invoke('kb:search', {
      q: 'anything',
      limit: 8,
      onlyPaths: ['/idx/contract.docx'],
    })) as { hits: unknown[]; notIndexed: string[] }
    expect(answer.hits).toEqual([])
    expect(answer.notIndexed).toEqual(['/idx/contract.docx'])
  })

  it('a blank query with a scope keeps the scoped answer shape', async () => {
    const answer = (await invoke('kb:search', {
      q: '   ',
      limit: 8,
      onlyPaths: ['/idx/contract.docx', '/idx/unindexed.docx'],
    })) as { hits: unknown[]; notIndexed: string[] }
    expect(answer.hits).toEqual([])
    expect(answer.notIndexed).toEqual(['/idx/unindexed.docx'])
  })

  it('rejects malformed scope payloads before anything runs', async () => {
    await expect(invoke('kb:search', { q: 'x', onlyPaths: 'not-an-array' })).rejects.toThrow(
      /array of absolute paths/,
    )
    await expect(invoke('kb:search', { q: 'x', onlyPaths: ['/idx/a.docx', 42] })).rejects.toThrow(
      /must be strings/,
    )
    await expect(invoke('kb:search', { q: 'x', onlyPaths: ['relative/a.docx'] })).rejects.toThrow(
      /absolute/,
    )
    await expect(
      invoke('kb:search', { q: 'x', onlyPaths: [`/${'a'.repeat(4097)}.docx`] }),
    ).rejects.toThrow(/too long/)
    await expect(
      invoke('kb:search', {
        q: 'x',
        onlyPaths: Array.from({ length: 51 }, (_, i) => `/idx/${i}.docx`),
      }),
    ).rejects.toThrow(/at most 50/)
    // nothing above reached the store
    expect(searchImpl).not.toHaveBeenCalled()
  })
})

describe('kb:read — the gate', () => {
  it('reads an indexed file, refuses one off-index without a scope', async () => {
    const indexed = join(dir, 'indexed.md')
    writeFileSync(indexed, 'in the index')
    INDEXED.add(indexed)
    const page = (await invoke('kb:read', { path: indexed, offset: 0 })) as { text: string }
    expect(page.text).toBe('in the index')
    const offIndex = join(dir, 'off-index.md')
    writeFileSync(offIndex, 'never indexed')
    await expect(invoke('kb:read', { path: offIndex, offset: 0 })).rejects.toThrow(
      /not in the knowledge base/,
    )
  })

  it('a scope narrows: a corpus path outside the selection is refused', async () => {
    const picked = join(dir, 'picked.md')
    const other = join(dir, 'other.md')
    writeFileSync(picked, 'selected corpus file')
    writeFileSync(other, 'in the corpus, not selected')
    aliasState.paths = [picked]
    INDEXED.add(other)
    const page = (await invoke('kb:read', {
      path: picked,
      offset: 0,
      onlyPaths: [picked],
    })) as { text: string }
    expect(page.text).toBe('selected corpus file')
    // the chip means the selection is the corpus: index membership alone
    // (union) must not leak a path the request did not select
    await expect(
      invoke('kb:read', { path: other, offset: 0, onlyPaths: [picked] }),
    ).rejects.toThrow(/not in the knowledge base/)
  })

  it('a selected file the index missed stays readable when it sits on the alias list', async () => {
    const picked = join(dir, 'picked.md')
    writeFileSync(picked, 'selected corpus file')
    aliasState.paths = [picked]
    const page = (await invoke('kb:read', {
      path: picked,
      offset: 0,
      onlyPaths: [picked],
    })) as { text: string; offset: number }
    expect(page.text).toBe('selected corpus file')
    expect(page.offset).toBe(0)
  })

  it('a selected file the index missed stays readable when it sits among the recents', async () => {
    const recent = join(dir, 'recent.md')
    writeFileSync(recent, 'a recent, unindexed')
    recentsState.paths = [recent]
    const page = (await invoke('kb:read', {
      path: recent,
      offset: 0,
      onlyPaths: [recent],
    })) as { text: string }
    expect(page.text).toBe('a recent, unindexed')
  })

  it('a selected path outside every root and off every list is refused, even in onlyPaths', async () => {
    // the host answers no roots; the registry stub answers no recents or
    // stars, and the alias list is empty — a real office file in a scratch
    // directory is exactly the arbitrary-file read the gate must refuse
    const stray = join(dir, 'stray.md')
    writeFileSync(stray, 'nowhere the desktop could have selected me')
    await expect(invoke('kb:read', { path: stray, offset: 0, onlyPaths: [stray] })).rejects.toThrow(
      /not in the knowledge base/,
    )
  })

  it('a selected path is refused when the file is gone or not a readable office type', async () => {
    const gone = join(dir, 'gone.docx')
    await expect(
      invoke('kb:read', {
        path: gone,
        offset: 0,
        onlyPaths: [gone],
      }),
    ).rejects.toThrow(/not in the knowledge base/)
    const archive = join(dir, 'packed.zip')
    writeFileSync(archive, 'not office')
    aliasState.paths = [archive]
    await expect(
      invoke('kb:read', { path: archive, offset: 0, onlyPaths: [archive] }),
    ).rejects.toThrow(/not in the knowledge base/)
  })

  it('a file outside the selection is refused even when the request carries a scope', async () => {
    const picked = join(dir, 'picked.md')
    writeFileSync(picked, 'selected corpus file')
    aliasState.paths = [picked]
    const other = join(dir, 'other.md')
    writeFileSync(other, 'not selected')
    await expect(
      invoke('kb:read', { path: other, offset: 0, onlyPaths: [picked] }),
    ).rejects.toThrow(/not in the knowledge base/)
  })

  it('validates the read-side scope payload the same way', async () => {
    await expect(
      invoke('kb:read', { path: '/idx/contract.docx', offset: 0, onlyPaths: ['relative.md'] }),
    ).rejects.toThrow(/absolute/)
    await expect(
      invoke('kb:read', {
        path: '/idx/contract.docx',
        offset: 0,
        onlyPaths: Array.from({ length: 51 }, (_, i) => `/idx/${i}.md`),
      }),
    ).rejects.toThrow(/at most 50/)
  })
})

describe('the Knowledge Base center channels', () => {
  /** a richer store stub the center's channels read: statuses + remove */
  function centerStore(entries: Array<{ path: string; status: string }>) {
    return {
      ...store,
      recentFiles: async () =>
        entries.map((entry) => ({
          path: entry.path,
          mtimeMs: 1,
          sizeBytes: 10,
          status: entry.status,
        })),
      remove: vi.fn(async () => undefined),
    }
  }
  const withHost = (over: Record<string, unknown>) => ({ ...host, ...over }) as typeof host

  it('kb:sources lists the roots plus the outside files, with readiness from the entries', async () => {
    const store2 = centerStore([
      { path: '/tmp/genoffice-home-ipc-kb/save/ok-one.md', status: 'ok' },
      { path: '/tmp/genoffice-home-ipc-kb/save/ok-two.md', status: 'ok' },
      { path: '/tmp/genoffice-home-ipc-kb/save/broken.md', status: 'error' },
      { path: '/outside/extra.md', status: 'ok' },
    ])
    registerHomeFileIpc(withHost({ indexStore: () => store2 as never }))
    const answer = (await invoke('kb:sources')) as {
      scanning: boolean
      sources: Array<{
        kind: string
        path: string
        indexed: number
        errors: number
        status: string
      }>
    }
    expect(answer.scanning).toBe(false)
    // the default save root (the host stub's /tmp/... path): one folder
    // source covering the three files under it, plus the outside file
    const folder = answer.sources.find(
      (s) => s.kind === 'folder' && s.path === '/tmp/genoffice-home-ipc-kb/save',
    )
    expect(folder).toBeDefined()
    expect(folder!.indexed).toBe(2)
    expect(folder!.errors).toBe(1)
    expect(folder!.status).toBe('error')
    const file = answer.sources.find((s) => s.path === '/outside/extra.md')
    expect(file).toBeDefined()
    expect(file!.status).toBe('ready')
    expect(answer.sources.filter((s) => s.kind === 'file')).toHaveLength(1)
  })

  it('a scan in flight marks an empty root as indexing (the honest pipeline state)', async () => {
    const store2 = centerStore([])
    const indexer = {
      progress: async () => ({ indexed: 0, pending: 4, scanning: true }),
      refreshIfStale: () => undefined,
      settle: async () => undefined,
    }
    registerHomeFileIpc(
      withHost({ indexStore: () => store2 as never, ensureFileIndexer: () => indexer as never }),
    )
    const answer = (await invoke('kb:sources')) as {
      scanning: boolean
      pending: number
      sources: Array<{ status: string }>
    }
    expect(answer.scanning).toBe(true)
    expect(answer.pending).toBe(4)
    expect(answer.sources.every((s) => s.status === 'indexing')).toBe(true)
  })

  it('kb:recall answers the full-index hits (no scope narrowing), bounded', async () => {
    const store2 = centerStore([])
    const search = vi.fn(async () => ({
      hits: [
        {
          path: '/idx/contract.docx',
          name: 'contract.docx',
          ext: 'docx',
          snippet: [{ text: 'the meeting decided…' }],
        },
      ],
    }))
    registerHomeFileIpc(
      withHost({
        indexStore: () => ({ ...store2, search }) as never,
        ensureFileIndexer: () =>
          ({ refreshIfStale: () => undefined, settle: async () => undefined }) as never,
      }),
    )
    const answer = (await invoke('kb:recall', { q: 'meeting', limit: 5 })) as Array<{
      path: string
      snippet: string
    }>
    expect(search).toHaveBeenCalledWith('meeting', expect.anything())
    expect(answer).toHaveLength(1)
    expect(answer[0]!.path).toBe('/idx/contract.docx')
    expect(answer[0]!.snippet).toContain('the meeting decided')
    // a missing store or empty query answers [] (never a throw)
    registerHomeFileIpc(withHost({ indexStore: () => null }))
    expect(await invoke('kb:recall', { q: 'x' })).toEqual([])
    const answer2 = (await invoke('kb:recall', { q: '' })) as unknown[]
    expect(answer2).toEqual([])
  })

  it('kb:reindex: a file drops and re-extracts; a folder drops its entries; the global drops the errored', async () => {
    const store2 = centerStore([
      { path: '/tmp/genoffice-home-ipc-kb/save/a.md', status: 'ok' },
      { path: '/tmp/genoffice-home-ipc-kb/save/b.md', status: 'error' },
      { path: '/outside/c.md', status: 'ok' },
    ])
    const indexNow = vi.fn(async () => undefined)
    const refresh = vi.fn()
    registerHomeFileIpc(
      withHost({
        indexStore: () => store2 as never,
        indexNow,
        refreshIndexer: refresh,
      }),
    )
    // a file source: remove + indexNow (the first-sight re-extraction)
    const fileAnswer = (await invoke('kb:reindex', { path: '/outside/c.md' })) as {
      removed: number
    }
    expect(fileAnswer.removed).toBe(1)
    expect(store2.remove).toHaveBeenCalledWith(['/outside/c.md'])
    expect(indexNow).toHaveBeenCalledWith(['/outside/c.md'])
    // a folder source: every entry under it drops, then the re-walk
    store2.remove.mockClear()
    const folderAnswer = (await invoke('kb:reindex', {
      path: '/tmp/genoffice-home-ipc-kb/save',
    })) as { removed: number }
    expect(folderAnswer.removed).toBe(2)
    expect(store2.remove).toHaveBeenCalledWith([
      '/tmp/genoffice-home-ipc-kb/save/a.md',
      '/tmp/genoffice-home-ipc-kb/save/b.md',
    ])
    // the global: only the errored entries drop
    store2.remove.mockClear()
    const globalAnswer = (await invoke('kb:reindex', {})) as { removed: number }
    expect(globalAnswer.removed).toBe(1)
    expect(store2.remove).toHaveBeenCalledWith(['/tmp/genoffice-home-ipc-kb/save/b.md'])
    expect(refresh).toHaveBeenCalled()
    // a relative path is refused outright
    await expect(invoke('kb:reindex', { path: 'relative.md' })).rejects.toThrow(/absolute/)
  })

  it('kb:pick-source-files stars every picked file and brings it into the index', async () => {
    const indexNow = vi.fn(async () => undefined)
    const refresh = vi.fn()
    registerHomeFileIpc(withHost({ indexNow, refreshIndexer: refresh }))
    const picked = (await invoke('kb:pick-source-files')) as string[]
    expect(picked).toEqual([expect.any(String)])
    expect(indexNow).toHaveBeenCalledWith(picked)
    expect(refresh).toHaveBeenCalled()
  })
})
