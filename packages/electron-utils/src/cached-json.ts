import { readFileSync, statSync } from 'node:fs'

/**
 * Stat-validated in-memory cache for the small JSON state files the main
 * process reads synchronously (app settings, recents, stars, AI settings).
 * A read stats the file first — mtime + size must match the entry before it
 * is reused — so an external write that changes either (another process, a
 * hand edit, an atomic replace) invalidates the cached value and forces a
 * fresh read. What the cache saves is the synchronous read + JSON.parse on
 * the main event loop, not the stat.
 *
 * Values leave the cache as deep clones: callers historically mutate what
 * readJson-style helpers hand them (docs-main's AI-settings heal writes back
 * a mutated read), and a caller must never be able to change the object the
 * next reader receives.
 */

/** the outcome of a raw read: any JSON value, or unusable (missing/corrupt) */
export type CachedJson =
  { readonly present: true; readonly value: unknown } | { readonly present: false }

interface Entry {
  /** the file identity the value was parsed from; null while the file is absent */
  readonly identity: { readonly mtimeMs: number; readonly size: number } | null
  readonly raw: CachedJson
}

const entries = new Map<string, Entry>()

const identityOf = (path: string): { mtimeMs: number; size: number } | null => {
  try {
    const st = statSync(path)
    return { mtimeMs: st.mtimeMs, size: st.size }
  } catch {
    return null
  }
}

const sameIdentity = (
  a: { mtimeMs: number; size: number } | null,
  b: { mtimeMs: number; size: number } | null,
): boolean => (a === null || b === null ? a === b : a.mtimeMs === b.mtimeMs && a.size === b.size)

/** the shared (never caller-visible) entry for `path`, validated by stat */
function readValidated(path: string): CachedJson {
  const identity = identityOf(path)
  const hit = entries.get(path)
  if (hit && sameIdentity(hit.identity, identity)) return hit.raw
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // absent (before the stat or vanished mid-read): latch — the file
      // reappearing changes the identity and invalidates on its own
      entries.set(path, { identity, raw: { present: false } })
    } else {
      // a transient read failure (an AV/indexer lock, EMFILE): never latch —
      // the next read retries instead of serving the fallback
      entries.delete(path)
    }
    return { present: false }
  }
  let raw: CachedJson
  try {
    raw = { present: true, value: JSON.parse(text) }
  } catch {
    // corrupt bytes: deterministic per content — latch until the file changes
    raw = { present: false }
  }
  entries.set(path, { identity, raw })
  return raw
}

/**
 * Parse `path` through the cache. `present: false` covers a missing and a
 * corrupt file alike — both mean "caller, use your fallback" — and both
 * latch, so a permanently-absent file costs one stat per read instead of a
 * read + parse attempt. A transient read failure (a locked-but-present file)
 * does not latch; the next read retries.
 */
export function readJsonCached(path: string): CachedJson {
  const raw = readValidated(path)
  if (!raw.present) return { present: false }
  // the caller gets its own copy; the entry keeps the pristine value
  return { present: true, value: JSON.parse(JSON.stringify(raw.value)) }
}

/**
 * Replace the cached value for a file this process just wrote. `json` is the
 * exact text written to disk, so the entry holds exactly what a fresh read
 * would parse — no aliasing with the caller's object. A failed stat drops
 * the entry so the next read goes to disk.
 */
export function primeJsonCache(path: string, json: string): void {
  const identity = identityOf(path)
  if (!identity) {
    entries.delete(path)
    return
  }
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    entries.delete(path)
    return
  }
  entries.set(path, { identity, raw: { present: true, value } })
}
