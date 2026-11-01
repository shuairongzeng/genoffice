import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * The browser-main read side of the evidence pack: `readAnnotationShot(id)` —
 * the id whitelist (a known annotation), the canonical shots-path guard, and
 * the file read — plus `readAnnotationsFor` handing the whole records (xpath
 * and shotPath included) to the dock's read_page. Electron is faked (app.getPath
 * answers the seeded userData); the store is the module's own singleton, so the
 * whole file shares one seeded directory.
 */

const h = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => h.userData },
  BrowserWindow: class {},
  WebContentsView: class {},
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  session: { fromPartition: () => ({}) },
  shell: {},
  net: {},
  protocol: {},
  webUtils: {},
}))

import { readAnnotationShot, readAnnotationsFor } from '../src/main/browser-main'

/** a minimal 4×2 PNG (signature + IHDR + IEND) — real bytes, real header */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d]),
  Buffer.from('IHDR'),
  Buffer.from([0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x02]),
  Buffer.from([0x08, 0x06, 0x00, 0x00, 0x00]),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('IEND'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
])

const URL_KEY = 'https://example.com/page'

const record = (over: Record<string, unknown>) => ({
  id: 'ann-1',
  url: URL_KEY,
  selector: '#login',
  xpath: '/html/body/form/button[1]',
  tagName: 'BUTTON',
  textSnippet: 'Sign in',
  rect: { x: 0, y: 0, width: 10, height: 10 },
  note: '',
  createdAt: 5,
  ...over,
})

let dir = ''

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-annotation-shot-read-'))
  h.userData = dir
  mkdirSync(join(dir, 'annotation-shots'), { recursive: true })
  // the shot that exists, one that does not, and a secret the guard must not reach
  writeFileSync(join(dir, 'annotation-shots', 'ann-shot.png'), PNG_BYTES)
  writeFileSync(join(dir, 'secret.png'), PNG_BYTES)
  writeFileSync(
    join(dir, 'browser-annotations.json'),
    JSON.stringify([
      record({ id: 'ann-shot', shotPath: 'annotation-shots/ann-shot.png' }),
      record({ id: 'ann-noshot' }),
      record({ id: 'ann-gone', shotPath: 'annotation-shots/ann-gone.png' }),
      // the escape is dropped by normalization: the record survives, the path does not
      record({ id: 'ann-escape', shotPath: 'annotation-shots/../../secret.png' }),
      record({ id: 'ann-no-xpath', xpath: '' }),
    ]),
    'utf8',
  )
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readAnnotationShot — the id whitelist and the path guard', () => {
  it('reads a known annotation shot with the PNG-derived size', () => {
    expect(readAnnotationShot('ann-shot')).toEqual({
      id: 'ann-shot',
      base64: PNG_BYTES.toString('base64'),
      mime: 'image/png',
      width: 4,
      height: 2,
    })
  })

  it('answers null for everything but a known annotation with a live shot', () => {
    // unknown id, junk id
    expect(readAnnotationShot('missing')).toBeNull()
    expect(readAnnotationShot('')).toBeNull()
    expect(readAnnotationShot('   ')).toBeNull()
    expect(readAnnotationShot(42 as unknown as string)).toBeNull()
    // a record pinned without a shot
    expect(readAnnotationShot('ann-noshot')).toBeNull()
    // a record whose shot file is gone
    expect(readAnnotationShot('ann-gone')).toBeNull()
    // a stored path that tried to walk out of the shots directory: the field
    // was dropped at normalization, so there is no shot to read — and the
    // secret file beside userData is untouched by the whole exercise
    expect(readAnnotationShot('ann-escape')).toBeNull()
    expect(existsSync(join(dir, 'secret.png'))).toBe(true)
  })
})

describe('readAnnotationsFor — the records read_page receives', () => {
  it('carries the evidence pack fields: xpath and the shot path', () => {
    const records = readAnnotationsFor(URL_KEY)
    expect(records.map((r) => r.id)).toEqual(['ann-shot', 'ann-noshot', 'ann-gone', 'ann-escape'])
    expect(records[0]).toMatchObject({
      xpath: '/html/body/form/button[1]',
      shotPath: 'annotation-shots/ann-shot.png',
    })
    // the record with no xpath never made it through shape validation
    expect(records.some((r) => r.id === 'ann-no-xpath')).toBe(false)
    // another URL (or junk) reads as nothing
    expect(readAnnotationsFor('https://example.com/other')).toEqual([])
    expect(readAnnotationsFor('about:blank')).toEqual([])
  })
})
