import { randomUUID } from 'node:crypto'
import { renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { primeJsonCache, readJsonCached } from '@genoffice/electron-utils/cached-json'

/**
 * Helpers for userData/app-settings.json — a flat JSON object holding
 * cross-module app preferences (UI language, first-run onboarding flag).
 * Editor modules read the same file, so the shape must stay a plain object.
 *
 * Reads go through the stat-validated cached-json layer: settings are read on
 * many IPC paths, and the write below primes the cache, so a settled file
 * costs one stat per read instead of a synchronous disk read + parse.
 */

export function readAppSettings(path: string): Record<string, unknown> {
  const raw = readJsonCached(path)
  if (raw.present && raw.value && typeof raw.value === 'object' && !Array.isArray(raw.value)) {
    return raw.value as Record<string, unknown>
  }
  // missing or corrupt file: treat as empty settings
  return {}
}

/**
 * Persist several related settings as one atomic replacement. The temporary
 * file lives beside the destination so rename never crosses filesystems.
 */
export function writeAppSettings(path: string, updates: Record<string, unknown>): void {
  const settings = { ...readAppSettings(path), ...updates }
  const json = JSON.stringify(settings, null, 2)
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(tempPath, json, {
      encoding: 'utf8',
      flag: 'wx',
      flush: true,
    })
    renameSync(tempPath, path)
    primeJsonCache(path, json)
  } catch (error) {
    try {
      unlinkSync(tempPath)
    } catch {
      // The write may have failed before the temporary file was created.
    }
    throw error
  }
}

export function writeAppSetting(path: string, key: string, value: unknown): void {
  writeAppSettings(path, { [key]: value })
}

/**
 * Persist `key` and run `apply` only once the bytes are on disk. writeAppSetting
 * rethrows when userData/app-settings.json is unwritable, so a caller that
 * updates its cached value first keeps showing a preference that was never
 * stored and silently reverts on the next launch.
 */
export function writeAppSettingThen<T>(
  path: string,
  key: string,
  value: T,
  apply: (value: T) => void,
): void {
  writeAppSetting(path, key, value)
  apply(value)
}
