import { describe, expect, it } from 'vitest'

import {
  dedupeDownloadName,
  decidePermissionRequest,
  sanitizeDownloadFilename,
} from '../src/main/page-session'

/**
 * The page session's pure policy: every permission a page view could ask for
 * answers no unless it is on the (near-empty) grant list, and a download
 * filename is a bare, de-duplicated name — the main process applies both, the
 * rules are pinned here.
 */

describe('decidePermissionRequest — deny by default', () => {
  it('denies the capability asks a page can actually make', () => {
    for (const permission of [
      'geolocation',
      'media',
      'notifications',
      'pointerLock',
      'midi',
      'midiSysex',
      'clipboard-read',
      'clipboard-sanitized-write',
      'background-sync',
      'mediaKeySystem',
      'window-management',
      'openExternal',
    ]) {
      expect(decidePermissionRequest(permission), permission).toBe('deny')
    }
  })

  it('denies unknown or junk permission names', () => {
    expect(decidePermissionRequest('definitely-not-a-permission')).toBe('deny')
    expect(decidePermissionRequest('')).toBe('deny')
  })

  it('grants fullscreen — the page views own that feature, and it is bounds-only', () => {
    expect(decidePermissionRequest('fullscreen')).toBe('allow')
  })
})

describe('sanitizeDownloadFilename', () => {
  it('reduces a page-supplied name to a bare filename', () => {
    expect(sanitizeDownloadFilename('report.pdf')).toBe('report.pdf')
    expect(sanitizeDownloadFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeDownloadFilename('..\\..\\C:\\secret.txt')).toBe('secret.txt')
    expect(sanitizeDownloadFilename('a/b/c.bin')).toBe('c.bin')
  })

  it('strips control characters and collapses emptiness', () => {
    expect(sanitizeDownloadFilename('na\u0000me.txt')).toBe('name.txt')
    expect(sanitizeDownloadFilename('   ')).toBe('download')
    expect(sanitizeDownloadFilename('')).toBe('download')
  })

  it('caps the length', () => {
    expect(sanitizeDownloadFilename(`${'x'.repeat(400)}.pdf`)).toHaveLength(200)
  })
})

describe('dedupeDownloadName — same-named files never overwrite', () => {
  it('passes a fresh name through', () => {
    expect(dedupeDownloadName(() => false, 'report.pdf')).toBe('report.pdf')
  })

  it('appends a counter before the extension, first free slot wins', () => {
    const taken = new Set(['report.pdf', 'report (1).pdf', 'report (2).pdf'])
    expect(dedupeDownloadName((n) => taken.has(n), 'report.pdf')).toBe('report (3).pdf')
  })

  it('handles names with no extension and keeps the dot-files alone', () => {
    expect(dedupeDownloadName(() => true, 'notes')).toMatch(/^notes \(\d+\)$/)
    // a leading-dot name has no stem to split: the counter lands behind it
    expect(dedupeDownloadName(() => true, '.env')).toMatch(/^\.env \(\d+\)$/)
  })

  it('falls back to a timestamped stem when a thousand names are taken', () => {
    const out = dedupeDownloadName(() => true, 'report.pdf')
    expect(out).toMatch(/^report \(\d+\)\.pdf$/)
  })
})
