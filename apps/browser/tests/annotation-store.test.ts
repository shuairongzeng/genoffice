import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAnnotationStore, annotationStorePath } from '../src/main/annotation-store'
import { writeAnnotationShot } from '../src/main/annotation-shots'
import {
  ANNOTATION_NOTE_MAX,
  ANNOTATION_RECORDS_MAX,
  ANNOTATION_SNIPPET_MAX,
  normalizeAnnotationRecord,
  normalizeAnnotationUrl,
} from '../src/shared/annotations'
import type { BrowserAnnotation } from '../src/shared/annotations'

/**
 * The annotation store: shape validation on everything read or written, the
 * hash-stripped URL key the revisit restore reads, the atomic-persist round
 * trip (a second store instance at the same path reads what the first wrote —
 * exactly what a page revisit does), and the shot half of the evidence pack —
 * the path the capture stamps, and the file that leaves with the record.
 */

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

let dir: string
let file: string
const writeErrors: unknown[] = []

const store = () =>
  createAnnotationStore({ path: () => file, onWriteError: (e) => writeErrors.push(e) })

const DRAFT = {
  selector: '#login',
  xpath: '/html/body/div[2]/form/button[1]',
  tagName: 'BUTTON',
  textSnippet: 'Sign in',
  rect: { x: 10, y: 20.6, width: 88.4, height: 32 },
  viewportRect: { x: 10, y: 20.6, width: 88.4, height: 32 },
}

const URL_A = 'https://example.com/docs/intro#section-2'
const URL_A_KEY = 'https://example.com/docs/intro'
const URL_B = 'https://example.com/docs/other'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-browser-annotations-'))
  file = annotationStorePath(dir)
  writeErrors.length = 0
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('normalizeAnnotationUrl — the revisit key', () => {
  it('strips the fragment but keeps query, path and trailing shape', () => {
    expect(normalizeAnnotationUrl('https://example.com/p?a=1#frag')).toBe(
      'https://example.com/p?a=1',
    )
  })

  it('accepts http, https and file pages', () => {
    expect(normalizeAnnotationUrl('http://example.com/')).toBe('http://example.com/')
    expect(normalizeAnnotationUrl('file:///Users/x/page.html')).toBe('file:///Users/x/page.html')
  })

  it('refuses junk and non-page schemes', () => {
    expect(normalizeAnnotationUrl('about:blank')).toBeNull()
    expect(normalizeAnnotationUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeAnnotationUrl('')).toBeNull()
    expect(normalizeAnnotationUrl(42)).toBeNull()
    expect(normalizeAnnotationUrl('not a url')).toBeNull()
  })
})

describe('normalizeAnnotationRecord — shape validation', () => {
  const base = {
    id: 'ann-1',
    url: 'https://example.com/p',
    selector: '#login',
    xpath: '/html/body/div[2]/form/button[1]',
    tagName: 'BUTTON',
    textSnippet: 'Sign in',
    rect: { x: 0, y: 0, width: 10, height: 10 },
    note: '',
    createdAt: 12345,
  }

  it('round-trips a well-formed record unchanged', () => {
    expect(normalizeAnnotationRecord(base)).toEqual(base)
  })

  it('round-trips the shot path when it is the canonical shape', () => {
    expect(normalizeAnnotationRecord({ ...base, shotPath: 'annotation-shots/ann-1.png' })).toEqual({
      ...base,
      shotPath: 'annotation-shots/ann-1.png',
    })
    // absent stays absent, an invalid path is dropped rather than fatal
    expect(normalizeAnnotationRecord({ ...base, shotPath: undefined })).not.toHaveProperty(
      'shotPath',
    )
    expect(
      normalizeAnnotationRecord({ ...base, shotPath: 'annotation-shots/../escape.png' }),
    ).not.toHaveProperty('shotPath')
    expect(normalizeAnnotationRecord({ ...base, shotPath: 42 })).not.toHaveProperty('shotPath')
  })

  it('folds and caps an over-long snippet', () => {
    const record = normalizeAnnotationRecord({
      ...base,
      textSnippet: `  a\n\nb   ${'x'.repeat(400)} `,
    })
    expect(record?.textSnippet).toBe(`a b ${'x'.repeat(400)}`.slice(0, ANNOTATION_SNIPPET_MAX))
    expect(record?.textSnippet.length).toBe(ANNOTATION_SNIPPET_MAX)
  })

  it('clamps the note, drops nothing', () => {
    const record = normalizeAnnotationRecord({
      ...base,
      note: 'n'.repeat(ANNOTATION_NOTE_MAX + 50),
    })
    expect(record?.note.length).toBe(ANNOTATION_NOTE_MAX)
  })

  it('drops records with a missing id, unusable url, empty selector, empty xpath or broken rect', () => {
    expect(normalizeAnnotationRecord({ ...base, id: '' })).toBeNull()
    expect(normalizeAnnotationRecord({ ...base, id: 'x', url: 'nope' })).toBeNull()
    expect(normalizeAnnotationRecord({ ...base, selector: '  ' })).toBeNull()
    expect(normalizeAnnotationRecord({ ...base, xpath: '  ' })).toBeNull()
    expect(
      normalizeAnnotationRecord({ ...base, rect: { x: NaN, y: 0, width: 1, height: 1 } }),
    ).toBeNull()
    expect(normalizeAnnotationRecord({ ...base, createdAt: 'yesterday' })).toBeNull()
    expect(normalizeAnnotationRecord(null)).toBeNull()
    expect(normalizeAnnotationRecord('nope')).toBeNull()
  })

  it('rounds rect coordinates to integers', () => {
    const record = normalizeAnnotationRecord({
      ...base,
      rect: { x: 1.6, y: -0.4, width: 9.9, height: 3.2 },
    })
    expect(record?.rect).toEqual({ x: 2, y: 0, width: 10, height: 3 })
  })
})

describe('the store', () => {
  it('adds a pin, mints id + createdAt, and answers it for the same hash-stripped key', () => {
    const s = store()
    const record = s.add(URL_A, DRAFT)
    expect(record).not.toBeNull()
    expect(record!.id).toMatch(/^[\da-f-]{36}$/)
    expect(record!.url).toBe(URL_A_KEY)
    expect(record!.note).toBe('')
    expect(record!.rect).toEqual({ x: 10, y: 21, width: 88, height: 32 })
    // revisit with a different fragment on the same page: same key
    expect(s.listForUrl(`${URL_A_KEY}#whatever`)).toHaveLength(1)
    expect(s.listForUrl(URL_B)).toHaveLength(0)
  })

  it('refuses junk drafts and blank-page URLs without writing', async () => {
    const s = store()
    expect(s.add('about:blank', DRAFT)).toBeNull()
    expect(s.add(URL_A, { selector: '', tagName: '', textSnippet: '', rect: null })).toBeNull()
    expect(s.add(URL_A, 'junk')).toBeNull()
    await new Promise((r) => setTimeout(r, 30))
    expect(s.list()).toHaveLength(0)
    expect(() => readFileSync(file, 'utf8')).toThrow()
  })

  it('persists atomically and a fresh store at the path reads it back (revisit restore)', async () => {
    const first = store()
    const pinned = first.add(URL_A, DRAFT)
    await new Promise((r) => setTimeout(r, 50))
    // the on-disk body is the marker-less version-1 shape: the bare array
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    expect(Array.isArray(onDisk)).toBe(true)
    expect(onDisk).toHaveLength(1)

    const revisit = store()
    const restored = revisit.listForUrl(URL_A)
    expect(restored).toHaveLength(1)
    expect(restored[0]!.id).toBe(pinned!.id)
    expect(restored[0]!.selector).toBe('#login')
    expect(restored[0]!.textSnippet).toBe('Sign in')
  })

  it('updates a note, clamped, and only for known ids', async () => {
    const s = store()
    const pinned = s.add(URL_A, DRAFT)
    await new Promise((r) => setTimeout(r, 50))
    expect(s.setNote('missing', 'x')).toBe(false)
    expect(s.setNote(pinned!.id, '  check the contrast  ')).toBe(true)
    expect(s.byId(pinned!.id)!.note).toBe('  check the contrast  '.slice(0, ANNOTATION_NOTE_MAX))
    await new Promise((r) => setTimeout(r, 50))
    // a no-op note change does not rewrite the file
    const before = readFileSync(file, 'utf8')
    expect(s.setNote(pinned!.id, s.byId(pinned!.id)!.note)).toBe(true)
    await new Promise((r) => setTimeout(r, 30))
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('removes a record and leaves unknown ids alone', async () => {
    const s = store()
    const pinned = s.add(URL_A, DRAFT)
    await new Promise((r) => setTimeout(r, 30))
    expect(s.remove('missing')).toBe(false)
    expect(s.remove(pinned!.id)).toBe(true)
    expect(s.list()).toHaveLength(0)
    await new Promise((r) => setTimeout(r, 30))
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([])
  })

  it('reads a missing, corrupt or foreign file as the empty store, never a crash', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, '{not json', 'utf8')
    expect(store().list()).toEqual([])
    writeFileSync(file, '{"annotations": "nope"}', 'utf8')
    expect(store().list()).toEqual([])
    writeFileSync(file, 'null', 'utf8')
    expect(store().list()).toEqual([])
  })

  it('drops invalid and duplicated records from a hand-edited file', () => {
    const good: BrowserAnnotation = {
      id: 'keep',
      url: 'https://example.com/p',
      selector: '#login',
      xpath: '/html/body/form/button[1]',
      tagName: 'BUTTON',
      textSnippet: 'Sign in',
      rect: { x: 0, y: 0, width: 1, height: 1 },
      note: 'note',
      createdAt: 5,
    }
    writeFileSync(
      file,
      JSON.stringify([
        good,
        { ...good, id: 'keep' },
        { ...good, id: 'bad', selector: '' },
        { ...good, id: 'bad-x', xpath: '' },
        7,
        null,
      ]),
      'utf8',
    )
    const s = store()
    expect(s.list()).toEqual([good])
  })

  it('surfaces write failures through onWriteError and keeps the in-memory list', async () => {
    const s = store()
    const pinned = s.add(URL_A, DRAFT)
    // a directory at the file path breaks the atomic rename AND the in-place
    // fallback, so the write surfaces as an error
    mkdirSync(join(file, 'blocking-directory'), { recursive: true })
    s.add(URL_B, DRAFT)
    await new Promise((r) => setTimeout(r, 50))
    expect(writeErrors.length).toBeGreaterThan(0)
    expect(s.list()).toHaveLength(2)
    expect(s.byId(pinned!.id)).toBeDefined()
    rmSync(join(file, 'blocking-directory'), { recursive: true, force: true })
  })

  it('records the shot path after the capture landed, and only the canonical shape', async () => {
    const s = store()
    const pinned = s.add(URL_A, DRAFT)
    // the pin lands without a shot; the capture stamps it afterwards
    expect(pinned!.shotPath).toBeUndefined()
    expect(s.setShotPath('missing', 'annotation-shots/missing.png')).toBe(false)
    expect(s.setShotPath(pinned!.id, 'annotation-shots/../../escape.png')).toBe(false)
    expect(s.setShotPath(pinned!.id, 'Downloads/x.png')).toBe(false)
    expect(s.setShotPath(pinned!.id, 'annotation-shots/x.jpg')).toBe(false)
    expect(s.setShotPath(pinned!.id, 42)).toBe(false)
    expect(s.byId(pinned!.id)!.shotPath).toBeUndefined()
    expect(s.setShotPath(pinned!.id, `annotation-shots/${pinned!.id}.png`)).toBe(true)
    expect(s.byId(pinned!.id)!.shotPath).toBe(`annotation-shots/${pinned!.id}.png`)
    // let the stamped path reach the disk, then prove a repeat of the same
    // path is a no-op write, not a rewrite
    await new Promise((r) => setTimeout(r, 50))
    const before = readFileSync(file, 'utf8')
    expect(s.setShotPath(pinned!.id, `annotation-shots/${pinned!.id}.png`)).toBe(true)
    await new Promise((r) => setTimeout(r, 30))
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('remove deletes the record shot file with the record (and only that file)', async () => {
    const shotErrors: unknown[] = []
    const s = createAnnotationStore({
      path: () => file,
      onWriteError: (e) => writeErrors.push(e),
      userData: () => dir,
      onShotError: (e) => shotErrors.push(e),
    })
    const pinned = s.add(URL_A, DRAFT)
    const other = s.add(URL_B, DRAFT)
    await writeAnnotationShot(dir, pinned!.id, PNG_BYTES)
    await writeAnnotationShot(dir, other!.id, PNG_BYTES)
    expect(s.setShotPath(pinned!.id, `annotation-shots/${pinned!.id}.png`)).toBe(true)
    expect(s.setShotPath(other!.id, `annotation-shots/${other!.id}.png`)).toBe(true)
    expect(s.remove(pinned!.id)).toBe(true)
    await new Promise((r) => setTimeout(r, 30))
    // the record's shot is gone; the other annotation's shot survives
    expect(existsSync(join(dir, 'annotation-shots', `${pinned!.id}.png`))).toBe(false)
    expect(existsSync(join(dir, 'annotation-shots', `${other!.id}.png`))).toBe(true)
    expect(shotErrors).toHaveLength(0)
    // removing a record that never had a shot file is not an error either
    expect(s.remove(other!.id)).toBe(true)
    await new Promise((r) => setTimeout(r, 30))
    expect(existsSync(join(dir, 'annotation-shots', `${other!.id}.png`))).toBe(false)
    expect(shotErrors).toHaveLength(0)
  })

  it('a store without the userData spec never touches shot files', async () => {
    const s = store()
    const pinned = s.add(URL_A, DRAFT)
    await writeAnnotationShot(dir, pinned!.id, PNG_BYTES)
    expect(s.remove(pinned!.id)).toBe(true)
    await new Promise((r) => setTimeout(r, 30))
    // the record left, the file stayed: pure-shape stores (the tests above)
    // pay no disk-shot behavior
    expect(existsSync(join(dir, 'annotation-shots', `${pinned!.id}.png`))).toBe(true)
  })

  it('caps the store on write: the 2001st pin drops the oldest record, not the file growth', async () => {
    // seed a full store at the cap, ordered oldest-first
    const seed: BrowserAnnotation[] = Array.from({ length: ANNOTATION_RECORDS_MAX }, (_, i) => ({
      id: `ann-${i}`,
      url: URL_A_KEY,
      selector: `#el-${i}`,
      xpath: `/html/body/div[${i + 1}]`,
      tagName: 'BUTTON',
      textSnippet: 'x',
      rect: { x: 0, y: 0, width: 1, height: 1 },
      note: '',
      createdAt: i + 1,
    }))
    writeFileSync(file, JSON.stringify(seed), 'utf8')
    const s = store()
    expect(s.list()).toHaveLength(ANNOTATION_RECORDS_MAX)
    const pinned = s.add(URL_A, DRAFT)
    await new Promise((r) => setTimeout(r, 50))
    // the pin landed, the oldest record left, and the file stayed at the cap
    expect(pinned).not.toBeNull()
    expect(s.list()).toHaveLength(ANNOTATION_RECORDS_MAX)
    expect(s.byId('ann-0')).toBeUndefined()
    expect(s.byId(pinned!.id)).toBeDefined()
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as BrowserAnnotation[]
    expect(onDisk).toHaveLength(ANNOTATION_RECORDS_MAX)
    expect(onDisk.map((r) => r.id)).not.toContain('ann-0')
    expect(onDisk.map((r) => r.id)).toContain(pinned!.id)
  })
})

describe("clearForUrl — the clear_annotations tool's store half", () => {
  it('drops every record keyed to the URL, and only those', async () => {
    const s = store()
    s.add(URL_A, DRAFT)
    s.add(URL_A, { ...DRAFT, selector: '#signup' })
    s.add(URL_B, { ...DRAFT, selector: '#other' })
    await new Promise((r) => setTimeout(r, 30))
    // a fragment-stripped key clears its whole page — the tool's url
    // argument and the page's own URL normalize to the same key
    expect(s.clearForUrl(URL_A)).toBe(2)
    expect(s.list()).toHaveLength(1)
    expect(s.listForUrl(URL_A)).toHaveLength(0)
    expect(s.listForUrl(URL_B)).toHaveLength(1)
    await new Promise((r) => setTimeout(r, 30))
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(1)
    // an unknown URL clears nothing; junk answers 0
    expect(s.clearForUrl('https://nowhere.example.com/')).toBe(0)
    expect(s.clearForUrl('not a url')).toBe(0)
  })
})
