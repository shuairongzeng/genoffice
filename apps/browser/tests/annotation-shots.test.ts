import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  annotationShotsDir,
  annotationShotPath,
  annotationShotRelPath,
  captureRectOf,
  deleteAnnotationShot,
  pngSizeOf,
  readAnnotationShotFile,
  resolveAnnotationShotPath,
  writeAnnotationShot,
} from '../src/main/annotation-shots'

/**
 * The pin-time element shots: the path math that turns a viewport rect into a
 * capturePage rect, the atomic write under the shots directory, the read-side
 * guard that keeps a stored path inside that directory, and the delete that
 * follows annotation removal.
 */

let userData: string

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'genoffice-annotation-shots-'))
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

/** a minimal 1×1 PNG (signature + IHDR + IEND) — real bytes, real header */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d]),
  Buffer.from('IHDR'),
  // width 4, height 2
  Buffer.from([0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x02]),
  Buffer.from([0x08, 0x06, 0x00, 0x00, 0x00]),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('IEND'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
])

describe('captureRectOf — the capturePage rect for one pin', () => {
  const VIEW = { width: 1000, height: 800 }

  it('passes a zoom-1 viewport rect through, rounded at the edges', () => {
    // edges round independently (left/right, top/bottom), so a fractional
    // size can round either way — the crop stays pixel-aligned
    expect(captureRectOf({ x: 10.2, y: 20.6, width: 100.4, height: 50.6 }, 1, VIEW)).toEqual({
      x: 10,
      y: 21,
      width: 101,
      height: 50,
    })
  })

  it('rescales by the zoom factor: CSS px become view px', () => {
    // the page zoomed to 150%: a 100-CSS-px element paints 150 view px
    expect(captureRectOf({ x: 100, y: 60, width: 100, height: 80 }, 1.5, VIEW)).toEqual({
      x: 150,
      y: 90,
      width: 150,
      height: 120,
    })
    // zoomed out to 50% halves it
    expect(captureRectOf({ x: 100, y: 60, width: 100, height: 80 }, 0.5, VIEW)).toEqual({
      x: 50,
      y: 30,
      width: 50,
      height: 40,
    })
  })

  it('clips to the view: an element partially off-view captures its visible part', () => {
    expect(captureRectOf({ x: -20, y: 700, width: 100, height: 200 }, 1, VIEW)).toEqual({
      x: 0,
      y: 700,
      width: 80,
      height: 100,
    })
  })

  it('answers null when nothing visible remains (nothing to capture)', () => {
    expect(captureRectOf({ x: 0, y: 0, width: 0, height: 10 }, 1, VIEW)).toBeNull()
    expect(captureRectOf({ x: 2000, y: 0, width: 10, height: 10 }, 1, VIEW)).toBeNull()
    expect(captureRectOf({ x: 0, y: 2000, width: 10, height: 10 }, 1, VIEW)).toBeNull()
  })

  it('treats a broken zoom factor as no zoom rather than throwing', () => {
    expect(captureRectOf({ x: 10, y: 10, width: 10, height: 10 }, NaN, VIEW)).toEqual({
      x: 10,
      y: 10,
      width: 10,
      height: 10,
    })
    expect(captureRectOf({ x: 10, y: 10, width: 10, height: 10 }, 0, VIEW)).toEqual({
      x: 10,
      y: 10,
      width: 10,
      height: 10,
    })
  })
})

describe('the shots directory', () => {
  it('writes atomically under userData/annotation-shots and answers the record path', async () => {
    const rel = await writeAnnotationShot(userData, 'ann-1', PNG)
    expect(rel).toBe('annotation-shots/ann-1.png')
    expect(existsSync(annotationShotPath(userData, 'ann-1'))).toBe(true)
    // the directory is created on demand
    expect(existsSync(annotationShotsDir(userData))).toBe(true)
    // and the bytes on disk are the bytes handed over
    expect(readFileSync(annotationShotPath(userData, 'ann-1'))).toEqual(PNG)
  })

  it('reads back the shot with its PNG-derived size; junk is not a shot', () => {
    mkdirSync(annotationShotsDir(userData), { recursive: true })
    writeFileSync(annotationShotPath(userData, 'ann-1'), PNG)
    expect(readAnnotationShotFile(annotationShotPath(userData, 'ann-1'))).toEqual({
      base64: PNG.toString('base64'),
      mime: 'image/png',
      width: 4,
      height: 2,
    })
    // a missing file, an empty file and a non-PNG file all answer null
    expect(readAnnotationShotFile(annotationShotPath(userData, 'nope'))).toBeNull()
    writeFileSync(annotationShotPath(userData, 'empty'), Buffer.alloc(0))
    expect(readAnnotationShotFile(annotationShotPath(userData, 'empty'))).toBeNull()
    writeFileSync(annotationShotPath(userData, 'text'), Buffer.from('not a png at all'))
    expect(readAnnotationShotFile(annotationShotPath(userData, 'text'))).toBeNull()
  })

  it('deletes the shot file, and a missing one is not an error', () => {
    const errors: unknown[] = []
    deleteAnnotationShot(userData, 'gone', (e) => errors.push(e))
    expect(errors).toHaveLength(0)
    mkdirSync(annotationShotsDir(userData), { recursive: true })
    writeFileSync(annotationShotPath(userData, 'ann-1'), PNG)
    deleteAnnotationShot(userData, 'ann-1', (e) => errors.push(e))
    expect(existsSync(annotationShotPath(userData, 'ann-1'))).toBe(false)
    expect(errors).toHaveLength(0)
  })

  it('reads the pixel size out of the IHDR header only', () => {
    expect(pngSizeOf(PNG)).toEqual({ width: 4, height: 2 })
    expect(pngSizeOf(Buffer.alloc(10))).toBeNull()
    expect(pngSizeOf(Buffer.concat([PNG, Buffer.alloc(40)]))).toEqual({ width: 4, height: 2 })
  })
})

describe('resolveAnnotationShotPath — the read-side guard', () => {
  it('resolves the canonical shape to the shots directory', () => {
    expect(resolveAnnotationShotPath(userData, 'annotation-shots/ann-1.png')).toBe(
      join(annotationShotsDir(userData), 'ann-1.png'),
    )
  })

  it('refuses everything that is not the canonical shape', () => {
    // traversal, absolute, nested, foreign directories, other extensions
    expect(resolveAnnotationShotPath(userData, 'annotation-shots/../../secrets.png')).toBeNull()
    expect(resolveAnnotationShotPath(userData, '/etc/passwd.png')).toBeNull()
    expect(resolveAnnotationShotPath(userData, 'annotation-shots/sub/dir/x.png')).toBeNull()
    expect(resolveAnnotationShotPath(userData, 'Downloads/x.png')).toBeNull()
    expect(resolveAnnotationShotPath(userData, 'annotation-shots/x.jpg')).toBeNull()
    expect(resolveAnnotationShotPath(userData, 'annotation-shots/.hidden.png')).toBeNull()
    expect(resolveAnnotationShotPath(userData, 'annotation-shots/..png')).toBeNull()
    expect(resolveAnnotationShotPath(userData, '')).toBeNull()
    expect(resolveAnnotationShotPath(userData, 42)).toBeNull()
  })

  it('derives the canonical path and rel path from the id alone', () => {
    expect(annotationShotPath(userData, 'ann-9')).toBe(
      join(annotationShotsDir(userData), 'ann-9.png'),
    )
    expect(annotationShotRelPath('ann-9')).toBe('annotation-shots/ann-9.png')
  })
})
