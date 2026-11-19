import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPdfFileCheckpoints } from '../src/main/file-checkpoints'

describe('createPdfFileCheckpoints', () => {
  const tempRoots: string[] = []

  const makeTempDir = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'pdf-cp-test-'))
    tempRoots.push(dir)
    return dir
  }

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('captures original bytes and restores them after in-place disk mutations', async () => {
    const dir = await makeTempDir()
    const cpRoot = join(dir, 'checkpoints')
    const pdfPath = join(dir, 'sample.pdf')
    const original = Buffer.from('%PDF-1.4\n%original-bytes\n')
    await writeFile(pdfPath, original)

    const manager = createPdfFileCheckpoints(cpRoot)
    const checkpointId = await manager.capture(101, pdfPath)

    // Simulate an in-place rewrite changing the PDF bytes on disk.
    await writeFile(pdfPath, Buffer.from('%PDF-1.7\n%mutated-by-resize\n'))

    const restored = await manager.restore(101, checkpointId, pdfPath)
    expect(restored).toEqual({ ok: true })
    expect(await readFile(pdfPath)).toEqual(original)
    // Restoring removes the consumed checkpoint backup file cleanly.
    expect(existsSync(join(cpRoot, '101', `${checkpointId}.pdf`))).toBe(false)
  })

  it('evicts oldest checkpoint backups FIFO once maxCheckpoints is exceeded', async () => {
    const dir = await makeTempDir()
    const cpRoot = join(dir, 'checkpoints')
    const pdfPath = join(dir, 'ring.pdf')
    await writeFile(pdfPath, 'v1')

    const manager = createPdfFileCheckpoints(cpRoot, { maxCheckpoints: 2 })
    const cp1 = await manager.capture(5, pdfPath)
    await writeFile(pdfPath, 'v2')
    const cp2 = await manager.capture(5, pdfPath)
    await writeFile(pdfPath, 'v3')
    const cp3 = await manager.capture(5, pdfPath)

    expect(existsSync(join(cpRoot, '5', `${cp1}.pdf`))).toBe(false)
    expect(existsSync(join(cpRoot, '5', `${cp2}.pdf`))).toBe(true)
    expect(existsSync(join(cpRoot, '5', `${cp3}.pdf`))).toBe(true)

    const stale = await manager.restore(5, cp1, pdfPath)
    expect(stale.ok).toBe(false)
  })

  it('rejects cross-view or mismatched file path restores and cleans up view directories', async () => {
    const dir = await makeTempDir()
    const cpRoot = join(dir, 'checkpoints')
    const pdfPath = join(dir, 'doc.pdf')
    const otherPath = join(dir, 'other.pdf')
    await writeFile(pdfPath, 'alpha')
    await writeFile(otherPath, 'beta')

    const manager = createPdfFileCheckpoints(cpRoot)
    const cp = await manager.capture(11, pdfPath)

    const wrongView = await manager.restore(22, cp, pdfPath)
    expect(wrongView.ok).toBe(false)

    const wrongPath = await manager.restore(11, cp, otherPath)
    expect(wrongPath.ok).toBe(false)

    await manager.cleanupView(11)
    expect(existsSync(join(cpRoot, '11'))).toBe(false)
  })
})
