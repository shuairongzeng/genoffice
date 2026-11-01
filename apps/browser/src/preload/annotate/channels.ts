/**
 * The page view's IPC channel names. Duplicated from `shared/ipc` on
 * purpose: the two preload build entries must share no module, or rollup
 * code-splits a common chunk between them — and the page view's preload runs
 * in a *sandboxed* renderer, whose `require` resolves only 'electron' and a
 * few node builtins, never `require('./chunks/…')`. The parity test
 * (tests/annotate-channels.test.ts) keeps this copy honest against
 * BROWSER_CHANNELS.
 */
export const PAGE_CHANNELS = {
  /** main → page preload: the full annotate state for the shown page */
  state: 'browser:page-annotate-state',
  /** page preload → main: fetch the annotate state at overlay startup (invoke) */
  sync: 'browser:page-annotate-sync',
  /** page preload → main: pin the hovered element as a new annotation */
  pin: 'browser:page-annotate-pin',
  /** page preload → main: update one annotation's note */
  note: 'browser:page-annotate-note',
  /** page preload → main: delete one annotation */
  delete: 'browser:page-annotate-delete',
  /** page preload → main: hand one annotation to the Home AI dock */
  ask: 'browser:page-annotate-ask',
  /** page preload → main: Esc pressed inside the picker — exit it */
  exit: 'browser:page-annotate-exit',
} as const
