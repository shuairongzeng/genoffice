import { ipcMain, webContents } from 'electron'
import { APP_SELECTION_CHANGED } from '@genoffice/agent-core'

/**
 * The selection store (main side): every app's renderer reports its editor's
 * current text selection over `app:selection-changed`, one entry per tab's
 * webContents. The surface collector (surface-context.ts) reads it to attach
 * the selection to the active tab, so the AI panel's "current surface" prompt
 * section sees exactly the passage the person selected — across docs, pdf,
 * sheets, slides and markdown alike.
 *
 * Empty reports clear the entry (a deselected editor must not keep feeding a
 * stale passage to the next model request).
 */

/** the cap a stored selection may carry — long enough for a passage, short
 *  enough that it cannot crowd out the rest of the prompt */
export const MAX_SELECTION_CHARS = 2000

const selections = new Map<number, string>()

export function registerSelectionStore(): void {
  ipcMain.on(APP_SELECTION_CHANGED, (event, payload: unknown) => {
    const text = typeof payload === 'string' ? payload : ''
    const trimmed = text.trim()
    if (trimmed === '') {
      selections.delete(event.sender.id)
    } else {
      selections.set(event.sender.id, trimmed.slice(0, MAX_SELECTION_CHARS))
    }
    // the composer's selection chip rides it live (pub/sub): every OTHER
    // renderer hears the new selection, the reporting one already knows it
    for (const wc of webContents.getAllWebContents()) {
      if (wc === event.sender || wc.isDestroyed()) continue
      wc.send('home:selection-changed', trimmed)
    }

  // a crashed or reloaded renderer's selection must not linger
  event.sender.once('destroyed', () => selections.delete(event.sender.id))
  event.sender.once('did-start-navigation', () => selections.delete(event.sender.id))
  })
}

/** the latest selection for one tab's webContents, undefined when none/empty */
export function selectionForWebContents(wcId: number): string | undefined {
  return selections.get(wcId)
}
