import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The two palette channels on home-ipc (issue #56 P0 #2): openHelp(topic)
 * validates the topic id against the manual's grammar before it reaches the
 * tab manager, and runCommand validates the editor/command pair against the
 * shared vocabulary before the host dispatch is allowed to run. Both are the
 * renderer-trust boundary — a fuzzed payload is never forwarded: an
 * off-grammar topic reaches the tab manager only as "no topic" (the manual
 * opens on its default article, the same topic-less F1 flow), never as the
 * fuzzed string, and an off-vocabulary pair never reaches the dispatch.
 */

const handles = new Map<string, (...args: never[]) => unknown>()

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/genoffice-home-run-command' },
  BrowserWindow: class {},
  dialog: {},
  ipcMain: {
    handle: (channel: string, handler: (...args: never[]) => unknown) =>
      handles.set(channel, handler),
  },
  shell: {},
}))

const APPS = vi.hoisted(() =>
  ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html'].map((id) => ({
    id,
    family: id,
    extensions: [id === 'markdown' ? 'md' : id],
    untitledTitle: id,
    untitledTitleKey: `untitled-${id}`,
  })),
)

vi.mock('../src/main/app-registry', () => ({
  documentApps: APPS,
  appForPath: (path: string) =>
    APPS.find((app) => path.endsWith(`.${app.extensions[0]}`))?.id ?? null,
  appForKind: (kind: string) => APPS.find((app) => app.id === kind) ?? null,
  appIsDirty: () => false,
  resetSheetsShuttingDown: () => {},
  defaultSaveDir: () => '/tmp/genoffice-home-run-command/save',
  projectFileRenamed: () => {},
  readRecentFiles: () => [] as string[],
  readStarredFiles: () => [] as string[],
  readStarredGroupMap: () => new Map<string, string>(),
  readStarredGroups: () => [] as string[],
  recordRecentFile: () => {},
  removeRecentFiles: () => {},
  removeStarredFiles: () => {},
  setStarredGroup: () => {},
  toggleStarredFile: () => {},
  uniquePathIn: (dir: string, name: string) => `${dir}/${name}`,
  // editor-command-dispatch's exports; these tests never fire them
  sendMarkdownExportRequest: () => {},
  sendHtmlExportRequest: () => {},
}))

import { registerHomeFileIpc, type HomeFileIpcHost } from '../src/main/home-ipc'
import { HOME_CHANNELS } from '../src/shared/home-api'

/** the topics that reached the tab manager (undefined topics never do, so a
 *  rejected payload is invisible by construction and the arms assert on
 *  counts, not on whichever call happened to be last) */
const openedTopics: string[] = []
const ranCommands: Array<[string, string, string | undefined]> = []

const tabManager = {
  openHelpTab: (topic?: string) => {
    if (topic !== undefined) openedTopics.push(topic)
    return 'help-tab'
  },
}

const host = {
  translate: (key: string) => key,
  appSettingsPath: () => '/tmp/genoffice-home-run-command/settings.json',
  getShellWindow: () => null,
  getTabManager: () => tabManager,
  runEditorCommand: (kind: string, command: string, tabId?: string) => {
    ranCommands.push([kind, command, tabId])
  },
  ensureFileIndexer: () => null,
  indexStore: () => null,
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
  newPdfTab: () => {},
  afterFileMoved: () => {},
  afterFolderMoved: () => {},
  trackedFilesUnder: () => [] as string[],
  fileTargetSources: () => ({}) as never,
  statMaybeFile: () => null,
  extraFolderRoots: () => [] as string[],
  insideAnyRoot: () => false,
  isAnyRoot: () => false,
  desktopAliases: () => [] as string[],
  ensureFolderWatchers: () => {},
  droppedFilesDeps: () => ({}) as never,
  cliRunner: () => ({}) as never,
  fetchGithubStars: async () => null,
  openDialogExtensions: [] as readonly string[],
} as HomeFileIpcHost

registerHomeFileIpc(host)

// the recorders and the handler registrations live at module scope; each
// test must start from an empty tape
beforeEach(() => {
  openedTopics.length = 0
  ranCommands.length = 0
})

const invoke = (channel: string, ...args: unknown[]): unknown =>
  handles.get(channel)!({ sender: { id: 1 } } as never, ...(args as never[]))

describe('home:open-help topic validation', () => {
  it('passes a well-formed topic id through to the tab manager', () => {
    invoke(HOME_CHANNELS.openHelp, 'pdf')
    expect(openedTopics).toEqual(['pdf'])
  })

  it('rejects topic ids outside the manual grammar without opening anything', () => {
    for (const bad of ['not a topic!', '../../secrets', 'UPPER', '', 42, null, undefined]) {
      invoke(HOME_CHANNELS.openHelp, bad)
    }
    // count, not content: every rejection is invisible to the recorder, so a
    // guard deleted entirely would forward some payload and grow the list
    expect(openedTopics).toEqual([])
  })
})

describe('home:run-command pair validation', () => {
  it('forwards a validated editor + command pair (and its pinned tab id) to the host', () => {
    invoke(HOME_CHANNELS.runCommand, 'docs', 'find')
    expect(ranCommands).toEqual([['docs', 'find', undefined]])
    invoke(HOME_CHANNELS.runCommand, 'docs', 'save', 't3')
    expect(ranCommands).toEqual([
      ['docs', 'find', undefined],
      ['docs', 'save', 't3'],
    ])
  })

  it('rejects non-editors, unknown verbs, and non-string payloads', () => {
    const before = ranCommands.length
    for (const [kind, command, tabId] of [
      ['home', 'save', undefined],
      ['help', 'find', undefined],
      ['docs', 'export-csv', undefined],
      ['docs', 'explode', undefined],
      [undefined, 'save', undefined],
      ['docs', undefined, undefined],
      [42, 'save', undefined],
      ['docs', 42, undefined],
      ['docs', 'save', 42],
      ['docs', 'save', null],
    ] as Array<[string | undefined, string | undefined, unknown]>) {
      invoke(HOME_CHANNELS.runCommand, kind, command, tabId)
    }
    expect(ranCommands).toHaveLength(before)
  })
})
