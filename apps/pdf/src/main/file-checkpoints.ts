import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writePdfAtomically } from './atomic-write'

/**
 * Per-view backup ring for PDF files prior to in-place file-level rewrites
 * (setPageSize, cropPages, replacePages). Allows the headless document agent's
 * Git-style checkpoint undo to restore exact original disk bytes cleanly.
 */

const DEFAULT_MAX_CHECKPOINTS = 20

interface FileCheckpointEntry {
  filePath: string
  backupPath: string
}

export interface PdfFileCheckpoints {
  capture(wcId: number, filePath: string): Promise<string>
  restore(
    wcId: number,
    checkpointId: string,
    expectedPath: string,
  ): Promise<{ ok: true } | { ok: false; error: string }>
  cleanupView(wcId: number): Promise<void>
  cleanupAll(): Promise<void>
}

export function createPdfFileCheckpoints(
  rootDir: string,
  options?: { maxCheckpoints?: number },
): PdfFileCheckpoints {
  const maxCheckpoints = Math.max(1, options?.maxCheckpoints ?? DEFAULT_MAX_CHECKPOINTS)
  const byView = new Map<number, Map<string, FileCheckpointEntry>>()

  const unlinkQuietly = async (targetPath: string): Promise<void> => {
    try {
      await unlink(targetPath)
    } catch {
      /* ignore ENOENT or transient lock on temp cleanup */
    }
  }

  return {
    async capture(wcId: number, filePath: string): Promise<string> {
      const viewDir = join(rootDir, String(wcId))
      await mkdir(viewDir, { recursive: true })
      const checkpointId = `pdf-file-${randomUUID()}`
      const backupPath = join(viewDir, `${checkpointId}.pdf`)
      const bytes = await readFile(filePath)
      await writeFile(backupPath, bytes)

      let ring = byView.get(wcId)
      if (!ring) {
        ring = new Map<string, FileCheckpointEntry>()
        byView.set(wcId, ring)
      }
      ring.set(checkpointId, { filePath, backupPath })

      while (ring.size > maxCheckpoints) {
        const oldestKey = ring.keys().next().value
        if (oldestKey === undefined) break
        const evicted = ring.get(oldestKey)
        ring.delete(oldestKey)
        if (evicted) await unlinkQuietly(evicted.backupPath)
      }

      return checkpointId
    },

    async restore(
      wcId: number,
      checkpointId: string,
      expectedPath: string,
    ): Promise<{ ok: true } | { ok: false; error: string }> {
      const ring = byView.get(wcId)
      const entry = ring?.get(checkpointId)
      if (!entry) {
        return { ok: false, error: 'file checkpoint is no longer available' }
      }
      if (entry.filePath !== expectedPath) {
        return { ok: false, error: 'checkpoint path does not match active file' }
      }
      try {
        const buf = await readFile(entry.backupPath)
        await writePdfAtomically(expectedPath, new Uint8Array(buf))
        ring?.delete(checkpointId)
        await unlinkQuietly(entry.backupPath)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },

    async cleanupView(wcId: number): Promise<void> {
      byView.delete(wcId)
      try {
        await rm(join(rootDir, String(wcId)), { recursive: true, force: true })
      } catch {
        /* ignore cleanup failures */
      }
    },

    async cleanupAll(): Promise<void> {
      byView.clear()
      try {
        await rm(rootDir, { recursive: true, force: true })
      } catch {
        /* ignore cleanup failures */
      }
    },
  }
}
