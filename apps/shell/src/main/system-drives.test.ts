import { EventEmitter } from 'node:events'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOME_CHANNELS, type SystemSearchResult } from '../shared/home-api'
import { MAX_SYSTEM_SEARCH_QUERY_LEN } from '../shared/system-search-matcher'
import { isInsideRoot } from './folder-tree'
import {
  DEFAULT_SEARCH_MAX_DIRS,
  DEFAULT_SEARCH_MAX_RESULTS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  getSystemPlaces,
  isDriveRootPath,
  isSystemNoiseEntry,
  listSystemDirectory,
  listSystemDrives,
  probeDriveEntry,
  searchSystemDirectory,
} from './system-drives'

const tempDirs: string[] = []

function makeTempDir(prefix = 'genoffice-sysdrives-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('isDriveRootPath', () => {
  it('recognizes Windows drive roots and rejects nested or relative paths', () => {
    expect(isDriveRootPath('C:\\')).toBe(true)
    expect(isDriveRootPath('c:')).toBe(true)
    expect(isDriveRootPath('D:/')).toBe(true)
    expect(isDriveRootPath('C:\\Users\\..')).toBe(true)
    expect(isDriveRootPath('D:\\Work')).toBe(false)
    expect(isDriveRootPath('C:\\Users\\Administrator')).toBe(false)
    expect(isDriveRootPath('C:relative')).toBe(false)
  })

  it('recognizes POSIX / and single-segment /Volumes/* roots while rejecting nested paths', () => {
    expect(isDriveRootPath('/')).toBe(true)
    expect(isDriveRootPath('/Volumes/USB')).toBe(true)
    expect(isDriveRootPath('/Volumes/USB/')).toBe(true)
    expect(isDriveRootPath('/Volumes')).toBe(false)
    expect(isDriveRootPath('/Volumes/USB/Folder')).toBe(false)
    expect(isDriveRootPath('/Users/a')).toBe(false)
    expect(isDriveRootPath('')).toBe(false)
    expect(isDriveRootPath('   ')).toBe(false)
    expect(isDriveRootPath('relative/dir')).toBe(false)
  })
})

describe('isSystemNoiseEntry', () => {
  it('filters Windows system directories, page/hibernation files, lock files, and dotfiles by default', () => {
    expect(isSystemNoiseEntry('$Recycle.Bin', true, false)).toBe(true)
    expect(isSystemNoiseEntry('System Volume Information', true, false)).toBe(true)
    expect(isSystemNoiseEntry('Recovery', true, false)).toBe(true)
    expect(isSystemNoiseEntry('Config.Msi', true, false)).toBe(true)
    expect(isSystemNoiseEntry('PerfLogs', true, false)).toBe(true)
    expect(isSystemNoiseEntry('$Windows.~BT', true, false)).toBe(true)

    expect(isSystemNoiseEntry('pagefile.sys', false, false)).toBe(true)
    expect(isSystemNoiseEntry('hiberfil.sys', false, false)).toBe(true)
    expect(isSystemNoiseEntry('swapfile.sys', false, false)).toBe(true)
    expect(isSystemNoiseEntry('DumpStack.log.tmp', false, false)).toBe(true)
    expect(isSystemNoiseEntry('desktop.ini', false, false)).toBe(true)
    expect(isSystemNoiseEntry('Thumbs.db', false, false)).toBe(true)
    expect(isSystemNoiseEntry('~$report.docx', false, false)).toBe(true)
    expect(isSystemNoiseEntry('.gitignore', false, false)).toBe(true)
    expect(isSystemNoiseEntry('.git', true, false)).toBe(true)

    expect(isSystemNoiseEntry('Projects', true, false)).toBe(false)
    expect(isSystemNoiseEntry('report.docx', false, false)).toBe(false)
  })

  it('reveals dotfiles when showHidden is true while still shielding lock and desktop metadata junk', () => {
    expect(isSystemNoiseEntry('.gitignore', false, true)).toBe(false)
    expect(isSystemNoiseEntry('.git', true, true)).toBe(false)
    expect(isSystemNoiseEntry('~$draft.xlsx', false, true)).toBe(true)
    expect(isSystemNoiseEntry('desktop.ini', false, true)).toBe(true)
    expect(isSystemNoiseEntry('Thumbs.db', false, true)).toBe(true)
  })
})

describe('listSystemDirectory', () => {
  it('lists folders naturally sorted, filters supported vs all files, and respects showHidden', async () => {
    const dir = makeTempDir()
    mkdirSync(join(dir, 'folder-10'))
    mkdirSync(join(dir, 'folder-2'))
    mkdirSync(join(dir, 'folder-1'))
    mkdirSync(join(dir, '$Recycle.Bin'))
    mkdirSync(join(dir, '.hidden-dir'))

    const oldDoc = join(dir, 'old.docx')
    const newMd = join(dir, 'new.md')
    const binFile = join(dir, 'raw.bin')
    const dotFile = join(dir, '.env')
    writeFileSync(oldDoc, 'doc')
    writeFileSync(newMd, '# hi')
    writeFileSync(binFile, 'bin')
    writeFileSync(dotFile, 'SECRET=1')
    writeFileSync(join(dir, 'desktop.ini'), '[ViewState]')
    writeFileSync(join(dir, '~$old.docx'), 'lock')

    utimesSync(oldDoc, new Date(1_700_000_000_000), new Date(1_700_000_000_000))
    utimesSync(newMd, new Date(1_700_000_100_000), new Date(1_700_000_100_000))

    const supportedOnly = await listSystemDirectory(dir)
    expect(supportedOnly.error).toBeUndefined()
    expect(supportedOnly.isDriveRoot).toBe(false)
    expect(supportedOnly.parentDir).toBe(dirname(dir))
    expect(supportedOnly.truncated).toBe(false)
    expect(supportedOnly.folders.map((f) => f.name)).toEqual(['folder-1', 'folder-2', 'folder-10'])
    expect(supportedOnly.files.map((f) => f.name)).toEqual(['new.md', 'old.docx'])
    expect(supportedOnly.files.every((f) => f.supported)).toBe(true)
    expect(supportedOnly.totalCount).toBe(5)

    const allFiles = await listSystemDirectory(dir, { showAllFiles: true })
    expect(allFiles.files.map((f) => f.name).sort()).toEqual(['new.md', 'old.docx', 'raw.bin'])
    const rawEntry = allFiles.files.find((f) => f.name === 'raw.bin')
    expect(rawEntry?.supported).toBe(false)

    const withHidden = await listSystemDirectory(dir, { showAllFiles: true, showHidden: true })
    expect(withHidden.folders.map((f) => f.name)).toContain('.hidden-dir')
    expect(withHidden.files.map((f) => f.name)).toContain('.env')
    expect(withHidden.files.map((f) => f.name)).not.toContain('desktop.ini')
    expect(withHidden.files.map((f) => f.name)).not.toContain('~$old.docx')
  })

  it('sets parentDir to null at drive root and handles missing or non-directory targets', async () => {
    const driveRoot =
      process.platform === 'win32' ? `${(process.env.SystemDrive || 'C:').toUpperCase()}\\` : '/'
    const rootListing = await listSystemDirectory(driveRoot)
    expect(rootListing.isDriveRoot).toBe(true)
    expect(rootListing.parentDir).toBeNull()

    const dir = makeTempDir()
    const missing = await listSystemDirectory(join(dir, 'does-not-exist'))
    expect(missing.error).toBe('missing')
    expect(missing.folders).toEqual([])
    expect(missing.files).toEqual([])

    const filePath = join(dir, 'plain.txt')
    writeFileSync(filePath, 'hello')
    const notDir = await listSystemDirectory(filePath)
    expect(notDir.error).toBe('not-directory')
    expect(notDir.folders).toEqual([])
    expect(notDir.files).toEqual([])
  })

  it('truncates entries above maxEntries and reports totalCount and truncated flag', async () => {
    const dir = makeTempDir()
    for (let i = 0; i < 3; i += 1) mkdirSync(join(dir, `dir-${i}`))
    for (let i = 0; i < 10; i += 1) writeFileSync(join(dir, `note-${i}.md`), 'md')

    const listed = await listSystemDirectory(dir, { maxEntries: 5 })
    expect(listed.totalCount).toBe(13)
    expect(listed.truncated).toBe(true)
    expect(listed.folders.length + listed.files.length).toBe(5)
    expect(listed.folders.length).toBe(3)
    expect(listed.files.length).toBe(2)
  })

  it('skips broken symlinks cleanly without throwing', async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'ok.md'), 'hi')
    try {
      symlinkSync(join(dir, 'missing-target.md'), join(dir, 'broken-link.md'))
    } catch {
      // On unprivileged Windows environments symlink creation may require Developer Mode.
      return
    }
    const listed = await listSystemDirectory(dir, { showAllFiles: true })
    expect(listed.files.map((f) => f.name)).toEqual(['ok.md'])
  })
})

describe('listSystemDrives & getSystemPlaces', () => {
  it('uses TTL cache and respects forceRefresh', async () => {
    const placeDir = makeTempDir('genoffice-place-')
    const probe = vi.fn(async () => [
      {
        id: 'C:',
        path: 'C:\\',
        name: 'C:',
        label: 'OS',
        kind: 'system' as const,
        totalBytes: 100,
        freeBytes: 40,
        usedBytes: 60,
        usedRatio: 0.6,
        accessible: true,
        isSystem: true,
      },
    ])

    const first = await listSystemDrives({
      forceRefresh: true,
      cacheTtlMs: 5_000,
      probeOverride: probe,
      resolvePlacePath: (id) => (id === 'desktop' ? placeDir : null),
    })
    const second = await listSystemDrives({
      cacheTtlMs: 5_000,
      probeOverride: probe,
      resolvePlacePath: (id) => (id === 'desktop' ? placeDir : null),
    })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(second.fetchedAt).toBe(first.fetchedAt)

    const third = await listSystemDrives({
      forceRefresh: true,
      cacheTtlMs: 5_000,
      probeOverride: probe,
      resolvePlacePath: (id) => (id === 'desktop' ? placeDir : null),
    })
    expect(probe).toHaveBeenCalledTimes(2)
    expect(third.drives).toHaveLength(1)
  })

  it('isolates failing drives without interrupting healthy ones or throwing', async () => {
    const healthyDir = makeTempDir('genoffice-drive-ok-')
    const [healthy, failed] = await Promise.all([
      probeDriveEntry({
        id: 'C:',
        path: healthyDir,
        name: 'C:',
        label: 'System',
        kind: 'system',
        isSystem: true,
      }),
      probeDriveEntry(
        {
          id: 'Z:',
          path: join(healthyDir, 'disconnected-share'),
          name: 'Z:',
          label: 'Remote',
          kind: 'network',
          isSystem: false,
        },
        {
          accessFn: async () => {
            throw new Error('ENODEV')
          },
        },
      ),
    ])

    expect(healthy.accessible).toBe(true)
    expect(healthy.totalBytes).toBeGreaterThan(0)
    expect(failed).toEqual({
      id: 'Z:',
      path: join(healthyDir, 'disconnected-share'),
      name: 'Z:',
      label: 'Remote',
      kind: 'network',
      totalBytes: 0,
      freeBytes: 0,
      usedBytes: 0,
      usedRatio: 0,
      accessible: false,
      isSystem: false,
    })

    const snapshot = await listSystemDrives({
      forceRefresh: true,
      probeOverride: async () => {
        throw new Error('probe crashed')
      },
    })
    expect(snapshot.drives).toEqual([])
    expect(Array.isArray(snapshot.places)).toBe(true)
  })

  it('deduplicates places and checks directory accessibility', async () => {
    const existing = makeTempDir('genoffice-places-')
    const fileAsPlace = join(existing, 'file.txt')
    writeFileSync(fileAsPlace, 'x')

    const places = await getSystemPlaces((id) => {
      if (id === 'desktop' || id === 'documents') return existing
      if (id === 'downloads') return fileAsPlace
      return join(existing, 'missing')
    })

    expect(places).toHaveLength(3)
    expect(places.find((p) => p.id === 'desktop')?.accessible).toBe(true)
    expect(places.find((p) => p.id === 'documents')).toBeUndefined()
    expect(places.find((p) => p.id === 'downloads')?.accessible).toBe(false)
    expect(places.find((p) => p.id === 'pictures')?.accessible).toBe(false)
  })

  it('probes at least one drive and one quick place on the real host OS', async () => {
    const snapshot = await listSystemDrives({ forceRefresh: true })
    expect(snapshot.platform).toBe(process.platform)
    expect(snapshot.drives.length).toBeGreaterThanOrEqual(1)
    expect(snapshot.places.length).toBeGreaterThanOrEqual(1)
    expect(snapshot.drives.some((d) => d.accessible)).toBe(true)
  })
})

describe('security invariants', () => {
  it('confirms C:\\Windows\\System32 is outside defaultSaveDir and read-only browsing leaves folderRoots untouched', async () => {
    const userData = makeTempDir('genoffice-userdata-')
    const saveDir = join(userData, 'GenOffice')
    mkdirSync(saveDir, { recursive: true })
    const settingsPath = join(userData, 'app-settings.json')
    const initialSettings = JSON.stringify({ folderRoots: [] }, null, 2)
    writeFileSync(settingsPath, initialSettings, 'utf8')

    expect(isInsideRoot(saveDir, 'C:\\Windows\\System32')).toBe(false)
    expect(isInsideRoot(saveDir, join(saveDir, 'report.docx'))).toBe(true)

    await listSystemDrives({ forceRefresh: true })
    await listSystemDirectory(saveDir)

    expect(readFileSync(settingsPath, 'utf8')).toBe(initialSettings)
  })

  it('guards dropFolderRoots against adding drive roots and validates systemListDir IPC args', async () => {
    const userData = makeTempDir('genoffice-homeipc-')
    const settingsPath = join(userData, 'app-settings.json')
    writeFileSync(settingsPath, JSON.stringify({ folderRoots: [] }), 'utf8')

    const handles = new Map<string, (...args: unknown[]) => unknown>()
    vi.resetModules()
    vi.doMock('electron', () => ({
      app: { getPath: () => userData, isPackaged: false },
      BrowserWindow: { fromWebContents: () => null },
      dialog: { showOpenDialog: vi.fn() },
      ipcMain: {
        handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
          handles.set(channel, handler),
      },
      shell: { openPath: vi.fn(), openExternal: vi.fn(), showItemInFolder: vi.fn() },
    }))
    vi.doMock('./app-registry', () => ({
      appForPath: () => null,
      appForKind: () => null,
      documentApps: [
        { id: 'docs', extensions: ['docx', 'odt', 'ott'] },
        { id: 'sheets', extensions: ['xlsx', 'xlsm', 'xls', 'csv', 'tsv', 'ods', 'ots'] },
        { id: 'slides', extensions: ['pptx', 'ppt', 'odp', 'otp'] },
        { id: 'pdf', extensions: ['pdf'] },
        { id: 'markdown', extensions: ['md', 'markdown', 'txt'] },
        { id: 'html', extensions: ['html', 'htm'] },
      ],
      defaultSaveDir: () => join(userData, 'save'),
      projectFileRenamed: () => {},
      readRecentFiles: () => [],
      readStarredFiles: () => [],
      readStarredGroupMap: () => new Map(),
      readStarredGroups: () => [],
      recordRecentFile: () => {},
      removeRecentFiles: () => {},
      removeStarredFiles: () => {},
      setStarredGroup: () => {},
      toggleStarredFile: () => {},
      uniquePathIn: () => '',
    }))

    try {
      const { registerHomeFileIpc } = await import('./home-ipc')
      const droppedFiles: string[] = []
      registerHomeFileIpc({
        translate: (k) => k,
        appSettingsPath: () => settingsPath,
        getShellWindow: () => null,
        getTabManager: () => null,
        ensureFileIndexer: () => null,
        indexStore: () => null,
        refreshIndexer: () => {},
        indexNow: async () => {},
        readFileSearchSettings: () => ({}) as never,
        ensureSearchReranker: () => null,
        openDocumentPath: () => true,
        openDocumentAtText: () => {},
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
        trackedFilesUnder: () => [],
        fileTargetSources: () => ({}) as never,
        statMaybeFile: () => null,
        openDocumentPaths: () => [],
        extraFolderRoots: () => [],
        insideAnyRoot: () => false,
        isAnyRoot: () => false,
        desktopAliases: () => [],
        ensureFolderWatchers: () => {},
        droppedFilesDeps: () =>
          ({
            openFile: (p: string) => droppedFiles.push(p),
          }) as never,
        cliRunner: () => ({}) as never,
        fetchGithubStars: async () => null,
        openDialogExtensions: [],
        runEditorCommand: () => {},
      })

      const dropHandler = handles.get(HOME_CHANNELS.dropFolderRoots)!
      const added = dropHandler({} as never, ['C:\\', 'D:/', '/', '/Volumes/USB'])
      expect(added).toEqual([])
      expect(droppedFiles).toEqual([])
      expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({ folderRoots: [] })

      const listHandler = handles.get(HOME_CHANNELS.systemListDir)!
      const invalidRelative = await (listHandler(
        {} as never,
        'relative/path',
        undefined,
      ) as Promise<{
        error?: string
      }>)
      expect(invalidRelative.error).toBe('missing')

      const invalidNonString = await (listHandler({} as never, 123, undefined) as Promise<{
        error?: string
      }>)
      expect(invalidNonString.error).toBe('missing')

      const overlongDir = `C:\\${'a'.repeat(4100)}`
      const invalidOverlong = await (listHandler({} as never, overlongDir, undefined) as Promise<{
        error?: string
      }>)
      expect(invalidOverlong.error).toBe('missing')

      const drivesHandler = handles.get(HOME_CHANNELS.systemDrives)!
      const snap = await (drivesHandler({} as never, true) as Promise<{ drives: unknown[] }>)
      expect(snap.drives.length).toBeGreaterThanOrEqual(1)
    } finally {
      vi.doUnmock('electron')
      vi.doUnmock('./app-registry')
      vi.resetModules()
    }
  })

  it('normalizes showSystemDrivesOnDesktop in desktop-ipc without altering base defaults', async () => {
    const { DEFAULT_DESKTOP_PREFS, normalizePrefs } = await import('./desktop-ipc')
    expect(DEFAULT_DESKTOP_PREFS.showSystemDrivesOnDesktop).toBeUndefined()
    expect(normalizePrefs({ ...DEFAULT_DESKTOP_PREFS }).showSystemDrivesOnDesktop).toBeUndefined()
    expect(
      normalizePrefs({ ...DEFAULT_DESKTOP_PREFS, showSystemDrivesOnDesktop: true })
        .showSystemDrivesOnDesktop,
    ).toBe(true)
    expect(
      normalizePrefs({ ...DEFAULT_DESKTOP_PREFS, showSystemDrivesOnDesktop: false })
        .showSystemDrivesOnDesktop,
    ).toBe(false)
    expect(
      normalizePrefs({ ...DEFAULT_DESKTOP_PREFS, showSystemDrivesOnDesktop: 'yes' })
        .showSystemDrivesOnDesktop,
    ).toBeUndefined()
  })
})

describe('searchSystemDirectory', () => {
  it('exports default search bounds and rejects missing or non-directory targets', async () => {
    expect(DEFAULT_SEARCH_MAX_RESULTS).toBe(500)
    expect(DEFAULT_SEARCH_MAX_DIRS).toBe(20_000)
    expect(DEFAULT_SEARCH_TIMEOUT_MS).toBe(10_000)

    const emptyRes = await searchSystemDirectory('', { query: '*.docx' })
    expect(emptyRes.error).toBe('missing')

    const dir = makeTempDir()
    const missingRes = await searchSystemDirectory(join(dir, 'absent'), { query: '*.docx' })
    expect(missingRes.error).toBe('missing')

    const filePath = join(dir, 'plain.txt')
    writeFileSync(filePath, 'hi')
    const notDirRes = await searchSystemDirectory(filePath, { query: '*.txt' })
    expect(notDirRes.error).toBe('not-directory')
  })

  it('recursively matches *.dll across subdirectories when showAllFiles is true with exact relativeDir', async () => {
    const dir = makeTempDir()
    mkdirSync(join(dir, 'sub', 'nested'), { recursive: true })
    mkdirSync(join(dir, 'sub', 'pack.dll'), { recursive: true })

    const rootDll = join(dir, 'root.dll')
    const midDll = join(dir, 'sub', 'mid.dll')
    const deepDll = join(dir, 'sub', 'nested', 'deep.dll')
    const otherMd = join(dir, 'sub', 'nested', 'notes.md')

    writeFileSync(rootDll, 'r')
    writeFileSync(midDll, 'm')
    writeFileSync(deepDll, 'd')
    writeFileSync(otherMd, '# notes')

    utimesSync(rootDll, new Date(1_700_000_000_000), new Date(1_700_000_000_000))
    utimesSync(midDll, new Date(1_700_000_100_000), new Date(1_700_000_100_000))
    utimesSync(deepDll, new Date(1_700_000_200_000), new Date(1_700_000_200_000))

    const res = await searchSystemDirectory(dir, { query: '*.dll', showAllFiles: true })
    expect(res.error).toBeUndefined()
    expect(res.truncated).toBe(false)
    expect(res.timedOut).toBe(false)
    expect(res.cancelled).toBe(false)
    expect(res.folders.map((f) => ({ name: f.name, relativeDir: f.relativeDir }))).toEqual([
      { name: 'pack.dll', relativeDir: 'sub' },
    ])
    expect(res.files.map((f) => ({ name: f.name, relativeDir: f.relativeDir }))).toEqual([
      { name: 'deep.dll', relativeDir: join('sub', 'nested') },
      { name: 'mid.dll', relativeDir: 'sub' },
      { name: 'root.dll', relativeDir: '' },
    ])
  })

  it('returns only supported office and code files when showAllFiles is false', async () => {
    const dir = makeTempDir()
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'report.docx'), 'doc')
    writeFileSync(join(dir, 'sub', 'notes.md'), '# md')
    writeFileSync(join(dir, 'sub', 'app.dll'), 'bin')
    writeFileSync(join(dir, 'sub', 'raw.bin'), 'raw')

    const res = await searchSystemDirectory(dir, { query: '*', showAllFiles: false })
    expect(res.error).toBeUndefined()
    expect(res.files.map((f) => f.name).sort()).toEqual(['notes.md', 'report.docx'])
    expect(res.files.every((f) => f.supported)).toBe(true)
  })

  it('supports explicit regex, /pattern/flags literal regex, empty query, and invalid-regex errors', async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'app_12.dll'), '1')
    writeFileSync(join(dir, 'APP_99.dll'), '2')
    writeFileSync(join(dir, 'app_abc.dll'), '3')
    writeFileSync(join(dir, 'other.dll'), '4')

    const explicitRegex = await searchSystemDirectory(dir, {
      query: '^app_\\d+\\.dll$',
      regex: true,
      showAllFiles: true,
    })
    expect(explicitRegex.error).toBeUndefined()
    expect(explicitRegex.files.map((f) => f.name).sort()).toEqual(['APP_99.dll', 'app_12.dll'])

    const literalRegex = await searchSystemDirectory(dir, {
      query: '/app_\\d+/i',
      showAllFiles: true,
    })
    expect(literalRegex.error).toBeUndefined()
    expect(literalRegex.files.map((f) => f.name).sort()).toEqual(['APP_99.dll', 'app_12.dll'])

    const invalidRegex = await searchSystemDirectory(dir, { query: '[', regex: true })
    expect(invalidRegex.error).toBe('invalid-regex')
    expect(invalidRegex.folders).toEqual([])
    expect(invalidRegex.files).toEqual([])
    expect(invalidRegex.scannedDirs).toBe(0)

    const emptyQuery = await searchSystemDirectory(dir, { query: '   ' })
    expect(emptyQuery.error).toBeUndefined()
    expect(emptyQuery.folders).toEqual([])
    expect(emptyQuery.files).toEqual([])
    expect(emptyQuery.scannedDirs).toBe(0)
  })

  it('matches path-scoped queries containing slash across relative paths', async () => {
    const dir = makeTempDir()
    mkdirSync(join(dir, 'nested', 'deeper'), { recursive: true })
    mkdirSync(join(dir, 'other'), { recursive: true })
    writeFileSync(join(dir, 'top.docx'), 't')
    writeFileSync(join(dir, 'nested', 'plan.docx'), 'p')
    writeFileSync(join(dir, 'nested', 'deeper', 'deep.docx'), 'd')
    writeFileSync(join(dir, 'other', 'plan.docx'), 'o')

    const singleLevel = await searchSystemDirectory(dir, {
      query: 'nested/*.docx',
      showAllFiles: false,
    })
    expect(singleLevel.files.map((f) => ({ name: f.name, relativeDir: f.relativeDir }))).toEqual([
      { name: 'plan.docx', relativeDir: 'nested' },
    ])

    const deepMatch = await searchSystemDirectory(dir, {
      query: 'nested/**/*.docx',
      showAllFiles: false,
    })
    expect(deepMatch.files.map((f) => ({ name: f.name, relativeDir: f.relativeDir }))).toEqual([
      { name: 'deep.docx', relativeDir: join('nested', 'deeper') },
    ])

    const anyDepthMatch = await searchSystemDirectory(dir, {
      query: 'nested/**.docx',
      showAllFiles: false,
    })
    expect(
      anyDepthMatch.files
        .map((f) => ({ name: f.name, relativeDir: f.relativeDir }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ).toEqual([
      { name: 'deep.docx', relativeDir: join('nested', 'deeper') },
      { name: 'plan.docx', relativeDir: 'nested' },
    ])
  })

  it('skips OS noise directories such as $Recycle.Bin and never recurses into directory symlinks', async () => {
    const dir = makeTempDir()
    mkdirSync(join(dir, '$Recycle.Bin'), { recursive: true })
    mkdirSync(join(dir, '.git'), { recursive: true })
    mkdirSync(join(dir, 'real'), { recursive: true })
    writeFileSync(join(dir, '$Recycle.Bin', 'trashed.docx'), 'trash')
    writeFileSync(join(dir, '.git', 'ignored.docx'), 'git')
    writeFileSync(join(dir, 'real', 'ok.docx'), 'ok')

    try {
      symlinkSync(
        dir,
        join(dir, 'real', 'loop-link'),
        process.platform === 'win32' ? 'junction' : 'dir',
      )
    } catch {
      // Unprivileged environments that block symlink creation still verify noise directory skipping.
    }

    const res = await searchSystemDirectory(dir, { query: '*.docx', showAllFiles: false })
    expect(res.error).toBeUndefined()
    expect(res.files.map((f) => f.name)).toEqual(['ok.docx'])
    expect(res.scannedDirs).toBe(2)
  })

  it('truncates at maxResults and maxVisitedDirs and reports truncated: true', async () => {
    const dir = makeTempDir()
    for (let d = 0; d < 6; d += 1) {
      const sub = join(dir, `dir-${d}`)
      mkdirSync(sub, { recursive: true })
      for (let f = 0; f < 3; f += 1) {
        writeFileSync(join(sub, `doc-${d}-${f}.docx`), 'doc')
      }
    }

    const cappedResults = await searchSystemDirectory(dir, {
      query: '*.docx',
      maxResults: 4,
    })
    expect(cappedResults.truncated).toBe(true)
    expect(cappedResults.folders.length + cappedResults.files.length).toBe(4)

    const cappedDirs = await searchSystemDirectory(dir, {
      query: '*.docx',
      maxVisitedDirs: 3,
      maxResults: 100,
    })
    expect(cappedDirs.truncated).toBe(true)
    expect(cappedDirs.scannedDirs).toBeLessThanOrEqual(3)
  })

  it('aborts cleanly and sets cancelled: true when AbortController triggers', async () => {
    const dir = makeTempDir()
    for (let i = 0; i < 20; i += 1) {
      mkdirSync(join(dir, `sub-${i}`), { recursive: true })
      writeFileSync(join(dir, `sub-${i}`, 'item.docx'), 'x')
    }

    const preAborted = new AbortController()
    preAborted.abort()
    const preRes = await searchSystemDirectory(dir, { query: '*.docx' }, preAborted.signal)
    expect(preRes.cancelled).toBe(true)
    expect(preRes.scannedDirs).toBe(0)
    expect(preRes.files).toEqual([])

    const midController = new AbortController()
    const pending = searchSystemDirectory(dir, { query: '*.docx' }, midController.signal)
    midController.abort()
    const midRes = await pending
    expect(midRes.cancelled).toBe(true)
  })

  it('validates IPC arguments and cancels active per-sender search on systemCancelSearch or sender destroy', async () => {
    const userData = makeTempDir('genoffice-search-ipc-')
    const settingsPath = join(userData, 'app-settings.json')
    writeFileSync(settingsPath, JSON.stringify({ folderRoots: [] }), 'utf8')

    const searchRoot = makeTempDir('genoffice-search-root-')
    for (let i = 0; i < 30; i += 1) {
      mkdirSync(join(searchRoot, `folder-${i}`), { recursive: true })
      writeFileSync(join(searchRoot, `folder-${i}`, `report_${i}.docx`), 'doc')
    }

    const handles = new Map<string, (...args: unknown[]) => unknown>()
    vi.resetModules()
    vi.doMock('electron', () => ({
      app: { getPath: () => userData, isPackaged: false },
      BrowserWindow: { fromWebContents: () => null },
      dialog: { showOpenDialog: vi.fn() },
      ipcMain: {
        handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
          handles.set(channel, handler),
      },
      shell: { openPath: vi.fn(), openExternal: vi.fn(), showItemInFolder: vi.fn() },
    }))
    vi.doMock('./app-registry', () => ({
      appForPath: () => null,
      appForKind: () => null,
      documentApps: [],
      defaultSaveDir: () => join(userData, 'save'),
      projectFileRenamed: () => {},
      readRecentFiles: () => [],
      readStarredFiles: () => [],
      readStarredGroupMap: () => new Map(),
      readStarredGroups: () => [],
      recordRecentFile: () => {},
      removeRecentFiles: () => {},
      removeStarredFiles: () => {},
      setStarredGroup: () => {},
      toggleStarredFile: () => {},
      uniquePathIn: () => '',
    }))

    try {
      const { registerHomeFileIpc } = await import('./home-ipc')
      registerHomeFileIpc({
        translate: (k) => k,
        appSettingsPath: () => settingsPath,
        getShellWindow: () => null,
        getTabManager: () => null,
        ensureFileIndexer: () => null,
        indexStore: () => null,
        refreshIndexer: () => {},
        indexNow: async () => {},
        readFileSearchSettings: () => ({}) as never,
        ensureSearchReranker: () => null,
        openDocumentPath: () => true,
        openDocumentAtText: () => {},
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
        trackedFilesUnder: () => [],
        fileTargetSources: () => ({}) as never,
        statMaybeFile: () => null,
        openDocumentPaths: () => [],
        extraFolderRoots: () => [],
        insideAnyRoot: () => false,
        isAnyRoot: () => false,
        desktopAliases: () => [],
        ensureFolderWatchers: () => {},
        droppedFilesDeps: () => ({}) as never,
        cliRunner: () => ({}) as never,
        fetchGithubStars: async () => null,
        openDialogExtensions: [],
        runEditorCommand: () => {},
      })

      const searchHandler = handles.get(HOME_CHANNELS.systemSearch)!
      const cancelHandler = handles.get(HOME_CHANNELS.systemCancelSearch)!
      const sender = Object.assign(new EventEmitter(), { id: 101 })

      const relErr = (await searchHandler({ sender } as never, 'relative/path', {
        query: '*.docx',
      })) as SystemSearchResult
      expect(relErr.error).toBe('missing')

      const overlongQueryErr = (await searchHandler({ sender } as never, searchRoot, {
        query: 'a'.repeat(MAX_SYSTEM_SEARCH_QUERY_LEN + 1),
      })) as SystemSearchResult
      expect(overlongQueryErr.error).toBe('invalid-regex')

      const validRes = (await searchHandler({ sender } as never, searchRoot, {
        query: 'report_1.docx',
      })) as SystemSearchResult
      expect(validRes.error).toBeUndefined()
      expect(validRes.files.map((f) => f.name)).toEqual(['report_1.docx'])

      const inFlight = searchHandler({ sender } as never, searchRoot, {
        query: '*.docx',
        searchId: 'req-1',
      }) as Promise<SystemSearchResult>
      await cancelHandler({ sender } as never, 'req-1')
      const cancelledRes = await inFlight
      expect(cancelledRes.cancelled).toBe(true)

      const destroyedFlight = searchHandler({ sender } as never, searchRoot, {
        query: '*.docx',
        searchId: 'req-2',
      }) as Promise<SystemSearchResult>
      sender.emit('destroyed')
      const destroyedRes = await destroyedFlight
      expect(destroyedRes.cancelled).toBe(true)
    } finally {
      vi.doUnmock('electron')
      vi.doUnmock('./app-registry')
      vi.resetModules()
    }
  })
})
