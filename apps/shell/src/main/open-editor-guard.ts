import { realpathSync } from 'node:fs'

/**
 * The open-document guard every agent write shares (edit_file, delete_file,
 * write_text_file, move_file, rename_file): a file an app has open is the
 * person's live document — rewriting, moving or renaming the disk copy under
 * the app forks it from what the person is looking at, so the operation is
 * refused and steered to the app's own agent instead.
 *
 * Both sides are canonicalized before the compare (the tab-manager's
 * canonicalPath precedent): `realpathSync.native` resolves symlinks and the
 * on-disk letter case, NFC normalization folds the decomposition macOS hands
 * back — so a path the model spells differently from the tab's own record
 * (/var vs /private/var, a case variant, a composed vs decomposed name)
 * still matches the open document it is, and the guard cannot be sidestepped
 * by a spelling change. An unresolvable path (the file is gone) folds to its
 * normalized raw form — nothing open matches it anyway.
 */

/** one open document as the guard's caller reports it (strip tabs + detached windows) */
export interface OpenDocumentEntry {
  path: string
  kind: string
}

/** canonicalize one path for the compare: realpath + NFC, falling back to the normalized raw form */
export function canonicalAgentPath(path: string): string {
  try {
    return realpathSync.native(path).normalize('NFC')
  } catch {
    return path.replaceAll('\\', '/').normalize('NFC')
  }
}

/**
 * The app kind that has this path open right now, or null — the canonicalized
 * verdict edit_file and delete_file have always carried, shared with
 * write_text_file, move_file and rename_file since the capability-completion
 * wave.
 */
export function openEditorOf(
  path: string,
  openDocuments: readonly OpenDocumentEntry[],
): string | null {
  const canonical = (p: string): string => canonicalAgentPath(p)
  const wanted = canonical(path)
  for (const entry of openDocuments) {
    if (canonical(entry.path) === wanted) return entry.kind
  }
  return null
}

/** the refusal the guard's answer turns into, steering to the owning app */
export function openDocumentRefusal(path: string, kind: string, verb: string): Error {
  return new Error(
    `"${path.slice(0, 120)}" is open in the ${kind} app right now — ${verb} the file behind ` +
      'the app would fork it from what the person is looking at. A Word document goes through ' +
      'document_agent instead; other kinds, ask the person to edit them in their app',
  )
}
