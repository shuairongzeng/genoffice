const DEEP_LINK_PREFIX = 'genoffice://'

/**
 * Decide whether a second-instance dev launch should attempt to reclaim the
 * single-instance lock from a stale process. Launches carrying a genoffice://
 * deep link or document paths are meant to hand off once to the running app
 * and exit immediately, avoiding lock-reclaim retries that emit repeated
 * `second-instance` events (and flicker the Butler HUD).
 */
export function shouldReclaimDevLock(
  argv: readonly string[],
  launchPaths: readonly string[],
): boolean {
  if (launchPaths.length > 0) return false
  return !argv.some((arg) => typeof arg === 'string' && arg.startsWith(DEEP_LINK_PREFIX))
}
