import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createAiLineage } from '../src/main/ai-lineage'

// symlink creation needs privileges on some Windows setups; probe once so the
// symlink-spelling test skips where it cannot run instead of failing there
const canSymlink = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'genoffice-ai-lineage-probe-'))
  try {
    symlinkSync(join(probe, 'real.txt'), join(probe, 'alias.txt'))
    return true
  } catch {
    return false
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
})()

// 'café' composed vs decomposed — the spelling macOS hands back decomposed
const COMPOSED = 'caf\u00e9-report.docx'
const DECOMPOSED = 'cafe\u0301-report.docx'

const iso = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString()

let dir: string
let filePath: string
let store: ReturnType<typeof createAiLineage>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-ai-lineage-'))
  filePath = join(dir, 'ai-lineage.jsonl')
  store = createAiLineage({ filePath })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createAiLineage', () => {
  it('round-trips one entry as a single JSONL line and answers null for unknown paths', async () => {
    const entry = {
      path: join(dir, 'report.docx'),
      task: 'quarterly summary',
      summary: 'made one',
      at: iso(10),
    }
    await store.record(entry)
    expect(store.lineageFor(entry.path)).toEqual(entry)
    expect(store.lineageFor(join(dir, 'other.docx'))).toBeNull()
    const raw = readFileSync(filePath, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(raw.split('\n').filter(Boolean)).toHaveLength(1)
    expect(JSON.parse(raw)).toEqual(entry)
  })

  it('answers null before anything was ever recorded', () => {
    expect(store.lineageFor(join(dir, 'report.docx'))).toBeNull()
    expect(existsSync(filePath)).toBe(false)
  })

  it('stamps a missing summary as "" and a missing at as now', async () => {
    const doc = join(dir, 'report.docx')
    await store.record({ path: doc, task: 'quarterly summary' })
    const entry = store.lineageFor(doc)
    expect(entry?.summary).toBe('')
    expect(Number.isNaN(Date.parse(entry?.at ?? ''))).toBe(false)
  })

  it('answers the newest entry when a path was regenerated', async () => {
    const doc = join(dir, 'report.docx')
    await store.record({ path: doc, task: 'v1', summary: 'first', at: iso(10) })
    await store.record({ path: doc, task: 'v2', summary: 'second', at: iso(20) })
    expect(store.lineageFor(doc)).toEqual({ path: doc, task: 'v2', summary: 'second', at: iso(20) })
  })

  it('answers by timestamp, not line order, when entries land out of order', async () => {
    const doc = join(dir, 'report.docx')
    await store.record({ path: doc, task: 'late', at: iso(30) })
    await store.record({ path: doc, task: 'early', at: iso(10) })
    expect(store.lineageFor(doc)?.task).toBe('late')
  })

  it('breaks same-timestamp ties by append order', async () => {
    const doc = join(dir, 'report.docx')
    await store.record({ path: doc, task: 'first', at: iso(10) })
    await store.record({ path: doc, task: 'second', at: iso(10) })
    expect(store.lineageFor(doc)?.task).toBe('second')
  })

  it('keeps one path regenerating from touching another path lineage', async () => {
    const a = join(dir, 'a.docx')
    const b = join(dir, 'b.docx')
    await store.record({ path: a, task: 'a-v1', at: iso(10) })
    await store.record({ path: b, task: 'b-only', at: iso(15) })
    await store.record({ path: a, task: 'a-v2', at: iso(20) })
    expect(store.lineageFor(a)?.task).toBe('a-v2')
    expect(store.lineageFor(b)?.task).toBe('b-only')
  })

  it('skips corrupt lines instead of failing the read', () => {
    const doc = join(dir, 'report.docx')
    writeFileSync(
      filePath,
      [
        JSON.stringify({ path: doc, task: 'first', summary: '', at: iso(10) }),
        '{ torn mid-line',
        JSON.stringify(['an array is not an entry']),
        JSON.stringify({ path: doc, summary: 'no task', at: iso(30) }),
        JSON.stringify({ task: 'no path', summary: '', at: iso(40) }),
        '',
        JSON.stringify({ path: doc, task: 'second', summary: '', at: iso(20) }),
      ].join('\n') + '\n',
      'utf8',
    )
    // the at:30 line has no task, so the newest valid entry is still at:20
    expect(store.lineageFor(doc)?.task).toBe('second')
    expect(store.lineageFor(join(dir, 'other.docx'))).toBeNull()
  })

  it('reads an all-corrupt file as no lineage', () => {
    writeFileSync(filePath, 'not json at all, not even one line\n\u0000binary\n', 'utf8')
    expect(store.lineageFor(join(dir, 'report.docx'))).toBeNull()
  })

  it('compacts corrupt lines away on the next record', async () => {
    const doc = join(dir, 'report.docx')
    writeFileSync(
      filePath,
      [
        JSON.stringify({ path: doc, task: 'first', summary: '', at: iso(10) }),
        '{ junk the reader skips',
        JSON.stringify({ path: doc, task: 'second', summary: '', at: iso(20) }),
      ].join('\n') + '\n',
      'utf8',
    )
    await store.record({ path: doc, task: 'third', at: iso(30) })
    const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
    expect(lines).toHaveLength(3)
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
  })

  it('caps the stored task instead of rejecting it', async () => {
    const doc = join(dir, 'report.docx')
    await store.record({ path: doc, task: 'x'.repeat(600), at: iso(10) })
    expect(store.lineageFor(doc)?.task).toBe('x'.repeat(500))
  })

  it('rejects records without a path or a task, and writes nothing', async () => {
    const doc = join(dir, 'report.docx')
    await expect(store.record({ path: '', task: 't' })).rejects.toThrow()
    await expect(store.record({ path: '   ', task: 't' })).rejects.toThrow()
    await expect(store.record({ path: doc, task: '' })).rejects.toThrow()
    await expect(store.record({ path: doc, task: '   ' })).rejects.toThrow()
    expect(existsSync(filePath)).toBe(false)
    expect(store.lineageFor(doc)).toBeNull()
  })

  it.skipIf(!canSymlink)('matches a spelling through a symlink, in both directions', async () => {
    const real = join(dir, 'real-report.docx')
    writeFileSync(real, 'x')
    const alias = join(dir, 'alias-report.docx')
    symlinkSync(real, alias)
    await store.record({ path: alias, task: 'via alias', at: iso(10) })
    expect(store.lineageFor(real)?.task).toBe('via alias')
    await store.record({ path: real, task: 'via real', at: iso(20) })
    expect(store.lineageFor(alias)?.task).toBe('via real')
  })

  it.skipIf(process.platform !== 'darwin')(
    'matches the decomposed spelling macOS keeps on disk',
    async () => {
      const nfdPath = join(dir, DECOMPOSED)
      writeFileSync(nfdPath, 'x')
      await store.record({ path: join(dir, COMPOSED), task: 'composed', at: iso(10) })
      expect(store.lineageFor(nfdPath)?.task).toBe('composed')
    },
  )

  it('matches a decomposed spelling of a missing file through the raw fallback', async () => {
    // no file on disk, so canonicalization falls back to NFC-normalizing the
    // raw spelling — the composed record must still answer the decomposed ask
    await store.record({ path: join(dir, COMPOSED), task: 'gone', at: iso(10) })
    expect(store.lineageFor(join(dir, DECOMPOSED))?.task).toBe('gone')
  })

  it.skipIf(process.platform !== 'darwin')(
    'matches across the /var vs /private/var spelling macOS hands back',
    async () => {
      // tmpdir() is /var/folders/... on macOS; realpath resolves the /var symlink
      const doc = join(dir, 'report.docx')
      writeFileSync(doc, 'x')
      await store.record({ path: doc, task: 'var', at: iso(10) })
      expect(store.lineageFor(realpathSync.native(doc))?.task).toBe('var')
    },
  )

  it('clears one path and leaves the others', async () => {
    const a = join(dir, 'a.docx')
    const b = join(dir, 'b.docx')
    await store.record({ path: a, task: 'a', at: iso(10) })
    await store.record({ path: b, task: 'b', at: iso(20) })
    await store.clear(a)
    expect(store.lineageFor(a)).toBeNull()
    expect(store.lineageFor(b)?.task).toBe('b')
  })

  it('clears by canonicalized path too', async () => {
    const kept = join(dir, 'kept.docx')
    await store.record({ path: join(dir, COMPOSED), task: 'gone', at: iso(10) })
    await store.record({ path: kept, task: 'kept', at: iso(20) })
    await store.clear(join(dir, DECOMPOSED))
    expect(store.lineageFor(join(dir, COMPOSED))).toBeNull()
    expect(store.lineageFor(kept)?.task).toBe('kept')
  })

  it('clears everything when no path is given, leaving an empty file', async () => {
    await store.record({ path: join(dir, 'a.docx'), task: 'a', at: iso(10) })
    await store.record({ path: join(dir, 'b.docx'), task: 'b', at: iso(20) })
    await store.clear()
    expect(store.lineageFor(join(dir, 'a.docx'))).toBeNull()
    expect(store.lineageFor(join(dir, 'b.docx'))).toBeNull()
    expect(readFileSync(filePath, 'utf8')).toBe('')
  })

  it('clears a store that was never written without error', async () => {
    const never = createAiLineage({ filePath: join(dir, 'never.jsonl') })
    await expect(never.clear()).resolves.toBeUndefined()
    await expect(never.clear(join(dir, 'a.docx'))).resolves.toBeUndefined()
    expect(never.lineageFor(join(dir, 'a.docx'))).toBeNull()
  })

  it('keeps every record when mutations overlap', async () => {
    const doc = join(dir, 'report.docx')
    await Promise.all([
      store.record({ path: doc, task: 'first', at: iso(10) }),
      store.record({ path: doc, task: 'second', at: iso(20) }),
      store.clear(join(dir, 'unrelated.docx')),
    ])
    expect(readFileSync(filePath, 'utf8').split('\n').filter(Boolean)).toHaveLength(2)
    expect(store.lineageFor(doc)?.task).toBe('second')
  })
})
