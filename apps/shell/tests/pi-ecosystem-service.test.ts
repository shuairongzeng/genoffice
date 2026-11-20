import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import {
  deleteMagicContextMemoryFromDb,
  findMagicContextDbPath,
  isNodeSqliteSupported,
  listMagicContextMemoriesFromDb,
  readMagicContextStats,
} from '../src/main/pi-agent/pi-memory-store'

const tempDirs: string[] = []
const nodeRequire = createRequire(join(process.cwd(), 'package.json'))

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function nodeSupportsSqliteInProcess(): boolean {
  try {
    const mod = nodeRequire('node:sqlite') as { DatabaseSync?: unknown }
    return typeof mod?.DatabaseSync === 'function'
  } catch {
    return false
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('pi-ecosystem-service & pi-memory-store', () => {
  it('handles missing Magic Context SQLite directory and empty DB cleanly', () => {
    const missing = join(tmpdir(), 'nonexistent-genoffice-mc-dir-xyz')
    expect(findMagicContextDbPath(missing)).toBeNull()
    expect(readMagicContextStats(missing)).toEqual({ memoryCount: 0, compartmentCount: 0 })
    expect(listMagicContextMemoriesFromDb(missing)).toEqual([])
    expect(deleteMagicContextMemoryFromDb(missing, 1)).toBe(false)
  })

  it.skipIf(!nodeSupportsSqliteInProcess())(
    'lists and deletes active Magic Context memories and reads stats via node:sqlite',
    () => {
      const storageDir = makeTempDir('genoffice-mc-sqlite-')
      const dbPath = join(storageDir, 'magic-context.db')
      const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite')

      const db = new DatabaseSync(dbPath)
      db.exec(`
        CREATE TABLE memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_path TEXT NOT NULL,
          category TEXT NOT NULL,
          content TEXT NOT NULL,
          normalized_hash TEXT NOT NULL,
          importance INTEGER,
          status TEXT DEFAULT 'active',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE memory_embeddings (
          memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          embedding BLOB NOT NULL,
          model_id TEXT NOT NULL,
          PRIMARY KEY(memory_id, model_id)
        );
        CREATE TABLE compartments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `)
      const now = Date.now()
      db.prepare(
        `INSERT INTO memories (project_path, category, content, normalized_hash, importance, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('/proj/a', 'preference', 'Prefers dark theme', 'h1', 80, 'active', now - 1000, now - 500)
      db.prepare(
        `INSERT INTO memories (project_path, category, content, normalized_hash, importance, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('/proj/a', 'fact', 'Archived note', 'h2', 40, 'archived', now - 2000, now - 1000)
      db.prepare(
        `INSERT INTO memories (project_path, category, content, normalized_hash, importance, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('/proj/b', 'workflow', 'Always run typecheck', 'h3', 90, 'permanent', now, now)
      db.prepare(`INSERT INTO memory_embeddings (memory_id, embedding, model_id) VALUES (?, ?, ?)`).run(
        1,
        Buffer.from([1, 2, 3, 4]),
        'wasm',
      )
      db.prepare(
        `INSERT INTO compartments (session_id, sequence, title, content, created_at) VALUES (?, ?, ?, ?, ?)`,
      ).run('s-1', 1, 'Intro', 'Discussed project architecture', now)
      db.close()

      expect(isNodeSqliteSupported()).toBe(true)
      expect(findMagicContextDbPath(storageDir)).toBe(dbPath)
      expect(readMagicContextStats(storageDir)).toEqual({ memoryCount: 2, compartmentCount: 1 })

      const all = listMagicContextMemoriesFromDb(storageDir)
      expect(all).toHaveLength(2)
      expect(all[0]!.content).toBe('Always run typecheck')
      expect(all[1]!.content).toBe('Prefers dark theme')

      const filtered = listMagicContextMemoriesFromDb(storageDir, { project: '/proj/a' })
      expect(filtered).toHaveLength(1)
      expect(filtered[0]!.category).toBe('preference')

      expect(deleteMagicContextMemoryFromDb(storageDir, all[1]!.id)).toBe(true)
      expect(readMagicContextStats(storageDir)).toEqual({ memoryCount: 1, compartmentCount: 1 })
      expect(deleteMagicContextMemoryFromDb(storageDir, 9999)).toBe(false)
    },
  )
})
