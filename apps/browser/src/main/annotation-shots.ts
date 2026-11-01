import { mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '@genoffice/electron-utils/atomic-write'

import { ANNOTATION_SHOTS_DIR, normalizeShotPath } from '../shared/annotations'

/**
 * The pin-time element shots: the annotation record's image half. Pin flow:
 * the page preload reports the target's *viewport* rect with the pin IPC, main
 * crops that region out of a `capturePage` and writes it as
 * `userData/annotation-shots/<id>.png`; the record then carries the path
 * relative to userData.
 *
 * Node-only on purpose — no Electron import, so the path math, the write and
 * the read guard are unit-testable without a renderer. Only the capturePage
 * call itself stays in browser-main.ts, where the webContents lives.
 */

/** where every shot lands, under userData */
export function annotationShotsDir(userDataDir: string): string {
  return join(userDataDir, ANNOTATION_SHOTS_DIR)
}

/** the shot path as the record stores it: relative to userData */
export function annotationShotRelPath(id: string): string {
  return `${ANNOTATION_SHOTS_DIR}/${id}.png`
}

/**
 * Resolve a stored shot path against userData — the read-side guard. Only the
 * canonical `annotation-shots/<stem>.png` shape passes (normalizeShotPath),
 * and the answer is re-checked to stay inside the shots directory, so a
 * hand-edited record can never aim a read at a file outside it.
 */
export function resolveAnnotationShotPath(userDataDir: string, relPath: string): string | null {
  const clean = normalizeShotPath(relPath)
  if (clean === undefined) return null
  const resolved = join(userDataDir, clean)
  // belt and braces over the pattern: the resolved path must sit inside the
  // shots directory itself, whatever the platform's separators do
  const dirWithSep = join(annotationShotsDir(userDataDir), '')
  if (!resolved.startsWith(dirWithSep)) return null
  return resolved
}

/** the one shot file an annotation id maps to (the canonical path) */
export function annotationShotPath(userDataDir: string, id: string): string {
  return join(annotationShotsDir(userDataDir), `${id}.png`)
}

/** the shot payload every consumer reads: bytes, mime and the PNG's own size */
export interface AnnotationShotFile {
  base64: string
  mime: string
  width: number
  height: number
}

/** read a PNG's pixel size out of its IHDR chunk (bytes 16–24) */
export function pngSizeOf(png: Buffer): { width: number; height: number } | null {
  // signature (8) + length (4) + 'IHDR' (4) precede width/height
  if (png.length < 24) return null
  if (png.toString('latin1', 12, 16) !== 'IHDR') return null
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  if (width === 0 || height === 0) return null
  return { width, height }
}

/**
 * Read one shot file off disk. null when it is missing or not a PNG-shaped
 * file — a deleted or corrupt shot degrades to "no image", never a crash.
 */
export function readAnnotationShotFile(path: string): AnnotationShotFile | null {
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch {
    return null
  }
  const size = pngSizeOf(bytes)
  if (size === null) return null
  return { base64: bytes.toString('base64'), mime: 'image/png', ...size }
}

/**
 * Write one shot: the directory is created on demand and the bytes land
 * atomically (scratch-then-rename, the store's own discipline). Answers the
 * record's `shotPath` (relative to userData).
 */
export async function writeAnnotationShot(
  userDataDir: string,
  id: string,
  png: Buffer,
): Promise<string> {
  const path = annotationShotPath(userDataDir, id)
  mkdirSync(annotationShotsDir(userDataDir), { recursive: true })
  await atomicWriteFile(path, png)
  return annotationShotRelPath(id)
}

/**
 * Delete one shot file (annotation removal). Best effort: a missing file is
 * the common case (records pinned before shots, a failed capture) and not an
 * error; anything else surfaces to the caller's error hook.
 */
export function deleteAnnotationShot(
  userDataDir: string,
  id: string,
  onError?: (error: unknown) => void,
): void {
  try {
    unlinkSync(annotationShotPath(userDataDir, id))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return
    onError?.(error)
  }
}

/**
 * The capturePage rect for one pin: the element's viewport rect, rescaled by
 * the page's zoom factor (CSS px → view DIPs) and clipped to the view —
 * capturePage outside the view is undefined, and an element partially off
 * view captures its visible part. null when nothing visible remains (a
 * zero-area or fully off-view region; the pin then simply gets no shot).
 */
export function captureRectOf(
  viewportRect: { x: number; y: number; width: number; height: number },
  zoomFactor: number,
  view: { width: number; height: number },
): { x: number; y: number; width: number; height: number } | null {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  const left = Math.round(viewportRect.x * zoom)
  const top = Math.round(viewportRect.y * zoom)
  const right = Math.round((viewportRect.x + viewportRect.width) * zoom)
  const bottom = Math.round((viewportRect.y + viewportRect.height) * zoom)
  const x = Math.max(0, left)
  const y = Math.max(0, top)
  const width = Math.min(view.width, right) - x
  const height = Math.min(view.height, bottom) - y
  if (width <= 0 || height <= 0) return null
  return { x, y, width, height }
}
