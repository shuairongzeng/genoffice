import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
}))
import { net } from 'electron'
import { fetchFaviconDataUrl, faviconCacheSize, resetFaviconCache } from '../src/main/favicon-fetch'

const mockFetch = vi.mocked(net.fetch)

function fakeImage(bytes = 32, type = 'image/x-icon') {
  return {
    ok: true,
    headers: new Map([['content-type', type]]),
    arrayBuffer: () => Promise.resolve(new Uint8Array(bytes).buffer),
  }
}

beforeEach(() => {
  resetFaviconCache()
  mockFetch.mockReset()
})

describe('fetchFaviconDataUrl', () => {
  it('returns a data URL for a good image response', async () => {
    mockFetch.mockResolvedValue(fakeImage() as never)
    const out = await fetchFaviconDataUrl('https://a.example/favicon.ico')
    expect(out).toMatch(/^data:image\/x-icon;base64,/)
  })

  it('rejects non-http(s) schemes without fetching', async () => {
    expect(await fetchFaviconDataUrl('file:///etc/hosts')).toBeNull()
    expect(await fetchFaviconDataUrl('data:image/png;base64,xx')).toBeNull()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('rejects non-image content types and failed responses', async () => {
    mockFetch.mockResolvedValue(fakeImage(32, 'text/html') as never)
    expect(await fetchFaviconDataUrl('https://a.example/f.ico')).toBeNull()
    mockFetch.mockResolvedValue({ ok: false, headers: new Map() } as never)
    expect(await fetchFaviconDataUrl('https://a.example/f.ico')).toBeNull()
  })

  it('rejects oversized payloads', async () => {
    mockFetch.mockResolvedValue(fakeImage(70 * 1024, 'image/png') as never)
    expect(await fetchFaviconDataUrl('https://a.example/big.png')).toBeNull()
  })

  it('caches hits and coalesces inflight requests', async () => {
    mockFetch.mockResolvedValue(fakeImage() as never)
    const [a, b] = await Promise.all([
      fetchFaviconDataUrl('https://a.example/f.ico'),
      fetchFaviconDataUrl('https://a.example/f.ico'),
    ])
    expect(a).toBe(b)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(faviconCacheSize()).toBe(1)
    await fetchFaviconDataUrl('https://a.example/f.ico')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('answers null on a fetch throw and never caches it', async () => {
    mockFetch.mockRejectedValue(new Error('boom'))
    expect(await fetchFaviconDataUrl('https://a.example/f.ico')).toBeNull()
    expect(faviconCacheSize()).toBe(0)
    mockFetch.mockResolvedValue(fakeImage() as never)
    expect(await fetchFaviconDataUrl('https://a.example/f.ico')).not.toBeNull()
  })
})
