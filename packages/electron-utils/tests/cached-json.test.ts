import { chmodSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { primeJsonCache, readJsonCached } from '../src/cached-json'
import { writeJsonAtomic } from '../src/atomic-write'

let dir = ''

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

/** a fresh cache entry per test: one file, one path, no cross-test state */
function freshFile(name = 'state.json'): string {
  dir = mkdtempSync(join(tmpdir(), 'cached-json-'))
  return join(dir, name)
}

/** set the file's mtime to an exact whole second — the one value utimes can
 *  restore bit-exactly, which lets a test pin one identity axis at a time */
const setMtime = (path: string, secondsSinceEpoch: number) => {
  const at = new Date(secondsSinceEpoch * 1000)
  utimesSync(path, at, at)
}

describe('readJsonCached', () => {
  it('reads the parsed value and keeps serving it while the file is unchanged', () => {
    const path = freshFile()
    writeJsonAtomic(path, { lang: 'zh', flags: [1, 2] })
    const first = readJsonCached(path)
    expect(first).toEqual({ present: true, value: { lang: 'zh', flags: [1, 2] } })
    const second = readJsonCached(path)
    expect(second).toEqual(first)
  })

  it('hands every caller its own copy: mutating a read never poisons the next one', () => {
    const path = freshFile()
    writeJsonAtomic(path, { nested: { list: ['a'] } })
    const first = readJsonCached(path)
    if (first.present) {
      const value = first.value as { nested: { list: string[] } }
      value.nested.list.push('mutated')
      value.nested = null as never
    }
    expect(readJsonCached(path)).toEqual({ present: true, value: { nested: { list: ['a'] } } })
  })

  it('reports a missing file as unusable, and a file that appears afterwards is read', () => {
    const path = freshFile()
    expect(readJsonCached(path)).toEqual({ present: false })
    expect(readJsonCached(path)).toEqual({ present: false })
    writeJsonAtomic(path, ['now', 'present'])
    expect(readJsonCached(path)).toEqual({ present: true, value: ['now', 'present'] })
  })

  it('reports a corrupt file as unusable, and the healed file is read again', () => {
    const path = freshFile()
    writeJsonAtomic(path, { a: 1 })
    writeFileSync(path, '{corrupt', 'utf8')
    setMtime(path, Math.floor(Date.now() / 1000) + 100)
    expect(readJsonCached(path)).toEqual({ present: false })
    writeJsonAtomic(path, { healed: true })
    expect(readJsonCached(path)).toEqual({ present: true, value: { healed: true } })
  })

  it('an external write with a new mtime invalidates the entry (same size)', () => {
    const path = freshFile()
    // compact on both sides so the two writes have identical byte length and
    // only the mtime axis can catch the edit
    writeFileSync(path, JSON.stringify({ v: 'aa' }), 'utf8')
    expect(readJsonCached(path)).toEqual({ present: true, value: { v: 'aa' } })
    const sizeBefore = statSync(path).size
    writeFileSync(path, JSON.stringify({ v: 'bb' }), 'utf8')
    setMtime(path, Math.floor(Date.now() / 1000) + 200)
    expect(statSync(path).size).toBe(sizeBefore) // pin: the size axis is equal
    expect(readJsonCached(path)).toEqual({ present: true, value: { v: 'bb' } })
  })

  it('an external write that changes only the size invalidates the entry (same mtime)', () => {
    const path = freshFile()
    // pin the mtime to a whole second before the first read so the same value
    // can be restored exactly after the edit (sub-ms mtimes do not roundtrip
    // through utimes); the mtime axis then stays equal and only the size axis
    // can catch the edit
    const pinnedSecond = Math.floor(Date.now() / 1000) - 100
    writeJsonAtomic(path, { v: 1 })
    setMtime(path, pinnedSecond)
    expect(readJsonCached(path)).toEqual({ present: true, value: { v: 1 } })
    writeFileSync(path, JSON.stringify({ v: 22 }), 'utf8') // compact: different size
    setMtime(path, pinnedSecond)
    expect(statSync(path).mtimeMs).toBe(pinnedSecond * 1000) // pin: mtime axis equal
    expect(readJsonCached(path)).toEqual({ present: true, value: { v: 22 } })
  })

  // chmod models the transient read failure: the file is still stat-able (its
  // mtime/size identity is intact) but the read fails — an AV/indexer lock on
  // Windows behaves the same way. Windows itself has no portable chmod, and a
  // 0o000 mode does not block reads there, so the test runs POSIX-only.
  it.skipIf(process.platform === 'win32')(
    'a transient read failure is not latched: the retry reads the file',
    () => {
      const path = freshFile()
      writeFileSync(path, JSON.stringify({ a: 1 }), 'utf8')
      chmodSync(path, 0o000)
      // no entry exists yet, so this read misses the cache and fails at the disk
      expect(readJsonCached(path)).toEqual({ present: false })
      chmodSync(path, 0o644)
      // the failed read must not have been latched under the identity
      expect(readJsonCached(path)).toEqual({ present: true, value: { a: 1 } })
    },
  )

  it('a JSON null on disk is a present value, not an unusable file', () => {
    const path = freshFile()
    writeJsonAtomic(path, null)
    expect(readJsonCached(path)).toEqual({ present: true, value: null })
  })

  it('a deleted file goes back to unusable', () => {
    const path = freshFile()
    writeJsonAtomic(path, { a: 1 })
    expect(readJsonCached(path).present).toBe(true)
    rmSync(path)
    expect(readJsonCached(path)).toEqual({ present: false })
  })
})

describe('primeJsonCache', () => {
  it('primes from the written text, so a write followed by a read never re-parses from disk', () => {
    const path = freshFile()
    writeJsonAtomic(path, { primed: true })
    // prove the answer comes from the cache: replace the bytes behind the
    // cache's back with a same-identity file the stat check cannot tell apart
    const before = readJsonCached(path)
    expect(before).toEqual({ present: true, value: { primed: true } })
    primeJsonCache(path, JSON.stringify({ primed: 'still-cached' }))
    expect(readJsonCached(path)).toEqual({ present: true, value: { primed: 'still-cached' } })
  })

  it('an unparseable primed text drops the entry instead of caching garbage', () => {
    const path = freshFile()
    writeJsonAtomic(path, { a: 1 })
    primeJsonCache(path, 'not json')
    // the entry is gone: the next read parses the real file bytes
    expect(readJsonCached(path)).toEqual({ present: true, value: { a: 1 } })
  })

  it('priming a path that no longer exists drops the entry', () => {
    const path = freshFile()
    writeJsonAtomic(path, { a: 1 })
    rmSync(path)
    primeJsonCache(path, JSON.stringify({ a: 2 }))
    expect(readJsonCached(path)).toEqual({ present: false })
  })
})
