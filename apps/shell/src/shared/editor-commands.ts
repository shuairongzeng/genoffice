import type { DocumentTabKind } from './tabs-api'

/**
 * The editor commands the command palette can run (issue #56 P0 #2): the
 * cross-app verb set every editor's menu already offers, now addressable from
 * the one global box. The ids are palette-level — each app's dispatch maps
 * them onto its native menu command (docs `MenuCommand`, sheets `MenuAction`,
 * slides' inline ids, the per-family request functions).
 *
 * This module is the vocabulary's single source: the renderer filters rows
 * with `editorCommandsFor(kind)` and the main process dispatches with the same
 * table, so a command can never be listed but unrunnable (or vice versa — the
 * dispatch switch is exhaustive over the same union).
 */
export const EDITOR_COMMAND_IDS = [
  'save',
  'save-as',
  'print',
  'export-pdf',
  'undo',
  'redo',
  'zoom-in',
  'zoom-out',
  'zoom-reset',
  'find',
] as const

export type EditorCommandId = (typeof EDITOR_COMMAND_IDS)[number]

/** which commands each editor family answers (the menu surface it really has) */
const COMMANDS_BY_KIND: Partial<Record<DocumentTabKind, readonly EditorCommandId[]>> = {
  docs: [
    'save',
    'save-as',
    'print',
    'export-pdf',
    'undo',
    'redo',
    'zoom-in',
    'zoom-out',
    'zoom-reset',
    'find',
  ],
  sheets: ['save', 'save-as', 'print', 'export-pdf', 'undo', 'redo'],
  slides: [
    'save',
    'save-as',
    'print',
    'export-pdf',
    'undo',
    'redo',
    'zoom-in',
    'zoom-out',
    'zoom-reset',
  ],
  // a pdf's export is a copy of itself: save-as is that dialog, so the
  // palette offers no separate export verb for pdf
  pdf: ['save', 'save-as', 'print'],
  markdown: ['save', 'save-as', 'print', 'export-pdf'],
  html: ['save', 'save-as', 'print', 'export-pdf'],
}

/** the commands `kind` answers, in catalog order; never undefined, so callers
 *  can spread without guarding */
export function editorCommandsFor(kind: DocumentTabKind): readonly EditorCommandId[] {
  return COMMANDS_BY_KIND[kind] ?? []
}
