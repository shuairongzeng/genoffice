import { existsSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

import type { PiMagicMemoryEntry } from '../../shared/pi-agent-api'

function loadNodeSqlite(): typeof import('node:sqlite') | null {
  try {
    const anchor =
      typeof __filename === 'string' ? __filename : resolve(process.cwd(), 'package.json')
    const req = createRequire(anchor)
    return req('node:sqlite') as typeof import('node:sqlite')
  } catch {
    return null
  }
}

/** Locate the active SQLite database file inside Magic Context's storage directory. */
export function findMagicContextDbPath(storageDir: string): string | null {
  if (!storageDir || !existsSync(storageDir)) return null
  const primary = join(storageDir, 'magic-context.db')
  if (existsSync(primary) && statSync(primary).isFile()) return primary
  try {
    const entries = readdirSync(storageDir)
    for (const name of entries) {
      if (/\.(db|sqlite|sqlite3)$/i.test(name)) {
        const candidate = join(storageDir, name)
        if (statSync(candidate).isFile()) return candidate
      }
    }
  } catch {
    return null
  }
  return null
}

export function isNodeSqliteSupported(): boolean {
  const sqlite = loadNodeSqlite()
  if (!sqlite) return false
  try {
    const db = new sqlite.DatabaseSync(':memory:')
    try {
      db.prepare('SELECT 1').get()
      return true
    } finally {
      db.close()
    }
  } catch {
    return false
  }
}

export interface MagicContextDbStats {
  readonly memoryCount: number
  readonly compartmentCount: number
}

/** Read memory and compartment counts from Magic Context's SQLite store. */
export function readMagicContextStats(storageDir: string): MagicContextDbStats | null {
  const sqlite = loadNodeSqlite()
  if (!sqlite) return null
  const dbPath = findMagicContextDbPath(storageDir)
  if (!dbPath) return { memoryCount: 0, compartmentCount: 0 }
  try {
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
    try {
      let memoryCount = 0
      let compartmentCount = 0
      try {
        const memRow = db
          .prepare("SELECT COUNT(*) AS cnt FROM memories WHERE status IN ('active', 'permanent')")
          .get() as { cnt?: number } | undefined
        memoryCount = Number(memRow?.cnt ?? 0)
      } catch {
        memoryCount = 0
      }
      try {
        const compRow = db.prepare('SELECT COUNT(*) AS cnt FROM compartments').get() as
          | { cnt?: number }
          | undefined
        compartmentCount = Number(compRow?.cnt ?? 0)
      } catch {
        compartmentCount = 0
      }
      return { memoryCount, compartmentCount }
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

function formatEpochIso(val: unknown): string | undefined {
  if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
    return new Date(val).toISOString()
  }
  if (typeof val === 'string' && val.trim()) {
    const asNum = Number(val)
    if (Number.isFinite(asNum) && asNum > 0) return new Date(asNum).toISOString()
    return val
  }
  return undefined
}

/** Query active/permanent Magic Context memories directly via `node:sqlite`. */
export function listMagicContextMemoriesFromDb(
  storageDir: string,
  opts?: { limit?: number; category?: string; project?: string },
): PiMagicMemoryEntry[] {
  const sqlite = loadNodeSqlite()
  if (!sqlite) return []
  const dbPath = findMagicContextDbPath(storageDir)
  if (!dbPath) return []

  const limitRaw = opts?.limit
  const limit =
    typeof limitRaw === 'number' && Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(500, Math.floor(limitRaw)))
      : 100

  try {
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
    try {
      const clauses: string[] = ["status IN ('active', 'permanent')"]
      const params: Array<string | number> = []
      if (opts?.category?.trim()) {
        clauses.push('category = ?')
        params.push(opts.category.trim())
      }
      if (opts?.project?.trim()) {
        clauses.push('project_path = ?')
        params.push(opts.project.trim())
      }
      params.push(limit)
      const sql = `SELECT id, project_path, category, content, importance, created_at, updated_at FROM memories WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ?`
      const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>
      return rows.map((row) => {
        const createdAt = formatEpochIso(row.created_at)
        const updatedAt = formatEpochIso(row.updated_at)
        return {
          id: Number(row.id),
          projectIdentity: String(row.project_path ?? ''),
          category: String(row.category ?? 'general'),
          content: String(row.content ?? ''),
          ...(typeof row.importance === 'number' ? { importance: row.importance } : {}),
          ...(createdAt ? { createdAt } : {}),
          ...(updatedAt ? { updatedAt } : {}),
        }
      })
    } finally {
      db.close()
    }
  } catch {
    return []
  }
}

/** Delete one Magic Context memory row (`DELETE FROM memories` triggers FTS & FK cascades). */
export function deleteMagicContextMemoryFromDb(storageDir: string, id: number): boolean {
  if (!Number.isInteger(id) || id <= 0) return false
  const sqlite = loadNodeSqlite()
  if (!sqlite) return false
  const dbPath = findMagicContextDbPath(storageDir)
  if (!dbPath) return false

  try {
    const db = new sqlite.DatabaseSync(dbPath)
    try {
      db.exec('PRAGMA foreign_keys = ON;')
      const res = db.prepare('DELETE FROM memories WHERE id = ?').run(id) as {
        changes?: number | bigint
      }
      return Number(res?.changes ?? 0) > 0
    } finally {
      db.close()
    }
  } catch {
    return false
  }
}
