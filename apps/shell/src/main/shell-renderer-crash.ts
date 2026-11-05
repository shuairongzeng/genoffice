import type { BrowserWindow } from 'electron'

/**
 * The shell renderer's crash recovery. The document-tab views and the dock
 * overlays all carry their own `render-process-gone` handlers, but the
 * shell's own webContents — the workbench itself — had none: a dead renderer
 * left the window as a frozen painting that still eats clicks (they land on
 * the root element) while nothing answers, which reads as "every button is
 * broken". Log the death and reload the renderer; three deaths inside a
 * minute stop the auto-reload, or a crash loop would reload forever.
 */

/** deaths within this window count toward the crash-loop guard */
const CRASH_LOOP_WINDOW_MS = 60_000
/** how many deaths inside the window still get an automatic reload */
const CRASH_LOOP_TOLERANCE = 3

/** reasons that are not a crash: a clean exit (or an explicit kill) needs no recovery */
const BENIGN_REASONS = new Set(['clean-exit', 'killed'])

export function watchShellRendererCrash(
  win: Pick<BrowserWindow, 'isDestroyed'> & {
    webContents: Pick<BrowserWindow['webContents'], 'on' | 'reload'>
  },
  log: (message: string) => void = (message) => console.error(message),
): void {
  let deaths: number[] = []
  win.webContents.on('render-process-gone', (_event, details) => {
    if (BENIGN_REASONS.has(details.reason)) return
    log(`[shell] renderer process gone (${details.reason}, exit ${details.exitCode}) — reloading`)
    const now = Date.now()
    deaths = deaths.filter((t) => now - t < CRASH_LOOP_WINDOW_MS)
    deaths.push(now)
    if (deaths.length > CRASH_LOOP_TOLERANCE) {
      log('[shell] renderer keeps crashing — leaving the window dead rather than loop-reloading')
      return
    }
    if (!win.isDestroyed()) win.webContents.reload()
  })
}
