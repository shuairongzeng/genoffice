import { isAbsolute } from 'node:path'

/**
 * Pure path guard for shell.showItemInFolder: Home's This PC browser
 * (ComputerView.tsx) needs to reveal arbitrary local disk files outside the
 * managed save folder, while UNC paths (`\\server\share` / `//server/share` /
 * `\\?\UNC\...`) and non-absolute paths must never trigger SMB probes or
 * arbitrary lookups.
 */
export function isSafeRevealPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return false
  if (value.startsWith('\\\\') || value.startsWith('//') || /^\\\\\?\\unc\\/i.test(value)) {
    return false
  }
  return isAbsolute(value)
}
