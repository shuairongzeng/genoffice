/**
 * Favicon fetcher: the shell's tab strip renders under a CSP that forbids
 * remote images (`img-src 'self' data: blob:`), so a page's favicon URL can
 * never load there. The main process fetches it instead — through the page's
 * own browser partition, so the request carries the page's session state —
 * and hands the renderer a `data:` URL, which the CSP allows.
 *
 * Bounded and best-effort: http/https only, image content-types only, 64 KB
 * cap, 5s timeout, in-memory LRU of 200 entries keyed by the remote URL.
 * Failures answer null and the strip keeps its glyph fallback.
 */
import { net } from 'electron'

const FAVICON_MAX_BYTES = 64 * 1024
const FAVICON_TIMEOUT_MS = 5000
const FAVICON_CACHE_MAX = 200

const cache = new Map<string, string>()
const inflight = new Map<string, Promise<string | null>>()

/** url → data URL, or null on any failure; nulls are not cached (a retry is cheap) */
export function fetchFaviconDataUrl(url: string): Promise<string | null> {
  const hit = cache.get(url)
  if (hit !== undefined) {
    // LRU touch
    cache.delete(url)
    cache.set(url, hit)
    return Promise.resolve(hit)
  }
  const pending = inflight.get(url)
  if (pending) return pending
  const job = doFetch(url).finally(() => inflight.delete(url))
  inflight.set(url, job)
  return job
}

async function doFetch(url: string): Promise<string | null> {
  if (!/^https?:\/\//i.test(url)) return null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FAVICON_TIMEOUT_MS)
    const res = await net
      .fetch(url, { signal: controller.signal, credentials: 'omit' })
      .finally(() => clearTimeout(timer))
    if (!res.ok) return null
    const type = (res.headers.get('content-type') ?? '').toLowerCase()
    if (!type.startsWith('image/')) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0 || buf.length > FAVICON_MAX_BYTES) return null
    const dataUrl = `data:${type};base64,${buf.toString('base64')}`
    cache.set(url, dataUrl)
    if (cache.size > FAVICON_CACHE_MAX) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    return dataUrl
  } catch {
    return null
  }
}

/** test seam: empty both caches */
export function resetFaviconCache(): void {
  cache.clear()
  inflight.clear()
}

/** test introspection */
export function faviconCacheSize(): number {
  return cache.size
}
