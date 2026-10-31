import type { WebContents } from 'electron'
import type { DocumentTabKind, TabSummary } from '../shared/tabs-api'
import {
  EDITOR_COMMAND_IDS,
  editorCommandsFor,
  type EditorCommandId,
} from '../shared/editor-commands'
import {
  runTabDocumentAction,
  type TabDocumentAction,
  type TabDocumentActionDeps,
} from './tab-document-actions'
import { sendHtmlExportRequest, sendMarkdownExportRequest } from './app-registry'

/**
 * The palette's editor-command dispatch (issue #56 P0 #2). save / save-as /
 * print ride the tab menu's own rail (`runTabDocumentAction` — pdf's save-as
 * dialog and the markdown/html save flows live there), so a palette verb and
 * the same tab-menu verb are one code path. The rest go over each family's
 * own menu channel, sent straight to the resolved tab's contents rather than
 * the family's "active view" pointer: the palette summons on Home, and the
 * deterministic target is the tab the row was listed for.
 *
 * The renderer pins that tab's id on the row (the detail line names the
 * document, Enter must run on that document), so the id is resolved first.
 * A stale id — the tab closed while the palette was open — falls back to the
 * most recently used tab of the family (the `lastActiveAt` stamps every
 * activation writes), which is the same rule the renderer lists by.
 *
 * Chrome-free presentation views are never targets: they render a document
 * but own no editor surface — no menu rail, no save/export listener — so a
 * command listed for the family resolves to the owning editor tab instead.
 *
 * A pair outside the shared `editorCommandsFor` table returns false before
 * anything is resolved or activated: the renderer filters by that table, so
 * this is the contract-break backstop — and a binding one, because a stray
 * verb must not reach a family's menu channel (sheets' renderer routes any
 * unrecognized menu action into its save flow). The boolean is the caller's
 * bookkeeping; the renderer's bridge call resolves either way (a no-op row
 * and a run row close the palette alike).
 */
export function runEditorCommand(
  deps: TabDocumentActionDeps,
  kind: DocumentTabKind,
  command: EditorCommandId,
  tabId?: string,
): boolean {
  if (!editorCommandsFor(kind).includes(command)) return false
  const target = tabId
    ? deps.tabs.list().find((tab) => tab.id === tabId && tab.kind === kind && !tab.present)
    : undefined
  const resolved = target ?? newestTabOfKind(deps, kind)
  if (!resolved) return false
  const menuAction = MENU_ACTION[command]
  if (menuAction) return runTabDocumentAction(deps, resolved.id, menuAction)
  // a pdf's "export" is a copy of itself, so the table gives pdf save-as
  // instead of export-pdf — the dialog flow is the save-as action above
  if ((kind === 'markdown' || kind === 'html') && command === 'export-pdf') {
    const contents = liveContents(deps, resolved.id)
    if (!contents) return false
    if (kind === 'markdown') sendMarkdownExportRequest(contents, 'pdf')
    else sendHtmlExportRequest(contents, 'pdf')
    return true
  }
  const contents = liveContents(deps, resolved.id)
  if (!contents) return false
  switch (kind) {
    case 'docs':
      // docs' own word for zoom-reset is zoom-100; the rest are identity
      contents.send('menu:command', command === 'zoom-reset' ? 'zoom-100' : command)
      return true
    case 'sheets':
      contents.send('menu:action', command)
      return true
    case 'slides':
      contents.send('slides:menu', command)
      return true
    default:
      return false
  }
}

/** the palette commands that are exactly the tab menu's document actions */
const MENU_ACTION: Partial<Record<EditorCommandId, TabDocumentAction>> = {
  save: 'save',
  'save-as': 'saveAs',
  print: 'print',
}

/** the most recently used tab of one editor family, by the activation stamps.
 *  Presentation views are skipped: no editor surface, no command target. */
function newestTabOfKind(
  deps: TabDocumentActionDeps,
  kind: DocumentTabKind,
): TabSummary | undefined {
  let newest: TabSummary | undefined
  for (const tab of deps.tabs.list()) {
    if (tab.kind !== kind || tab.present) continue
    if (!newest || (tab.lastActiveAt ?? 0) > (newest.lastActiveAt ?? 0)) newest = tab
  }
  return newest
}

/** the target tab's contents, activated like the tab-menu rail does — running
 *  a command on a document shows that document */
function liveContents(deps: TabDocumentActionDeps, id: string): WebContents | undefined {
  // webContentsForTab comes first, like the menu rail's own runner: it revives
  // a dormant tab (whose null view would fail the detach guard), so a
  // sleeping MRU target still runs. The mid-close guard follows — a closing
  // tab's view is alive, so the revive is a no-op there and the guard
  // refuses it
  const contents = deps.tabs.webContentsForTab(id)
  if (!contents || contents.isDestroyed()) return undefined
  if (!deps.tabs.canDetachTab(id)) return undefined
  deps.tabs.activateTab(id)
  return contents
}

/** the main-side guard for the IPC surface: a well-formed editor + command
 *  pair, and (when present) a string tab id */
export function isValidEditorCommand(kind: unknown, command: unknown, tabId?: unknown): boolean {
  return (
    typeof kind === 'string' &&
    (kind === 'docs' ||
      kind === 'sheets' ||
      kind === 'slides' ||
      kind === 'pdf' ||
      kind === 'markdown' ||
      kind === 'html') &&
    typeof command === 'string' &&
    (EDITOR_COMMAND_IDS as readonly string[]).includes(command) &&
    (tabId === undefined || typeof tabId === 'string')
  )
}
