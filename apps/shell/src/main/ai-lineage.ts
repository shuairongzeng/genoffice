import { readFileSync } from 'node:fs'
import { atomicWriteFile } from './atomic-write'
import { canonicalAgentPath } from './open-editor-guard'

/**
 * The AI lineage store (main side): the durable record of "this document came
 * from an AI task", so a document-bound AI thread can open with the continuity
 * context — the task that produced the file, what it made, when — instead of
 * greeting a generated document as a stranger. One JSONL file holds it, a line
 * per recorded task.
 *
 * Every write goes through the scratch-then-rename atomic write the one-file
 * stores in this process share, so a crash mid-record costs the whole line or
 * nothing — never the half line that would poison every later read. Every read
 * is line-by-line tolerant, the JSONL convention the project-store set: a
 * corrupt or wrong-shaped line is skipped, never fatal, because one bad line
 * must not keep every other document's thread from opening with its context.
 * A rewrite carries only the lines the reader honors, so junk a hand edit or
 * an older build left behind is compacted away rather than carried forever.
 *
 * Lookup compares paths through canonicalAgentPath (realpathSync.native + NFC,
 * the open-editor-guard precedent): a thread that spells the document the way
 * the task wrote it, the way the tab records it, or the way macOS decomposes
 * it (/var vs /private/var, a symlink, a composed vs decomposed name) still
 * finds the lineage of the document it is. A path the task regenerated answers
 * with its newest entry — by `at`, the timestamp the entry carries, with the
 * file's append order breaking ties.
 */

/** one "this document came from an AI task" fact, as stored and as answered */
export interface AiLineageEntry {
  /** the document the task produced, spelled as its recorder wrote it */
  path: string
  /** the task that produced the document, capped at TASK_MAX_CHARS */
  task: string
  /** what the task did, in a sentence; an unstamped summary reads as '' */
  summary: string
  /** when the task ran, ISO 8601 — the ordering key when a path was regenerated */
  at: string
}

/** what record() accepts: summary and at may be omitted — the store stamps them */
export interface AiLineageInput {
  /** the path of the document the task produced */
  path: string
  /** the task that produced the document; capped, never rejected for length */
  task: string
  /** what the task did, in a sentence */
  summary?: string
  /** when the task ran, ISO 8601; omitted means "now", stamped at record time */
  at?: string
}

export interface AiLineageStore {
  /**
   * Validate and append one entry, atomically. Rejects when the path or the
   * task is empty — those two are the whole point of the record — and caps a
   * task longer than TASK_MAX_CHARS rather than rejecting it.
   */
  record(entry: AiLineageInput): Promise<void>
  /**
   * The newest entry for a path — a canonicalized compare — or null when the
   * document has no recorded lineage. Reads never throw: a missing file, a
   * corrupt line and an unparseable `at` all just narrow the answer.
   */
  lineageFor(path: string): AiLineageEntry | null
  /**
   * Drop the entries of one canonicalized path, or every entry when the path
   * is omitted. Both rewrite the file atomically; clearing a store that was
   * never written leaves an empty file, not an error.
   */
  clear(path?: string): Promise<void>
}

/** one task's stored length, so a single JSONL line stays a line */
const TASK_MAX_CHARS = 500

/** the file's valid entries in written order; a missing file or junk line never throws */
function readEntries(filePath: string): AiLineageEntry[] {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    // the store was never written, or vanished with its folder — an empty lineage
    return []
  }
  const entries: AiLineageEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      const candidate = parsed as Record<string, unknown>
      // a line without the identity (path), the payload (task) or the ordering
      // key (at) is not a lineage entry — skip it, keep the rest of the file
      if (typeof candidate.path !== 'string' || !candidate.path.trim()) continue
      if (typeof candidate.task !== 'string' || !candidate.task.trim()) continue
      if (typeof candidate.at !== 'string' || !candidate.at) continue
      entries.push({
        path: candidate.path,
        task: candidate.task,
        summary: typeof candidate.summary === 'string' ? candidate.summary : '',
        at: candidate.at,
      })
    } catch {
      continue
    }
  }
  return entries
}

/** the entries as the file's bytes: one JSON line each, newline-terminated */
function toFileBytes(entries: readonly AiLineageEntry[]): Buffer {
  const lines = entries.map((entry) => JSON.stringify(entry))
  return Buffer.from(lines.length ? `${lines.join('\n')}\n` : '')
}

/** a per-call canonicalizer: a path's regenerations repeat the raw spelling, realpath each distinct one once */
function canonicalizer(): (path: string) => string {
  const seen = new Map<string, string>()
  return (path) => {
    const cached = seen.get(path)
    if (cached !== undefined) return cached
    const canonical = canonicalAgentPath(path)
    seen.set(path, canonical)
    return canonical
  }
}

/**
 * The store for one JSONL file. `filePath` is the store file's own path —
 * `<dir>/ai-lineage.jsonl` where the integration lands it.
 */
export function createAiLineage(spec: { filePath: string }): AiLineageStore {
  const { filePath } = spec
  // record and clear are read-modify-write cycles on one file: two awaited
  // mutations interleaving would read the same lines and silently drop a
  // record, so every mutation runs on a shared tail — and one rejected
  // mutation never poisons the ones queued behind it
  let tail: Promise<unknown> = Promise.resolve()
  const enqueue = (job: () => Promise<void>): Promise<void> => {
    const run = tail.then(job, job)
    tail = run.catch(() => undefined)
    return run
  }
  return {
    async record(entry) {
      if (typeof entry.path !== 'string' || !entry.path.trim()) {
        throw new Error('ai-lineage record needs the path of the document the task produced')
      }
      if (typeof entry.task !== 'string' || !entry.task.trim()) {
        throw new Error('ai-lineage record needs the task that produced the document')
      }
      const stamped: AiLineageEntry = {
        path: entry.path,
        task: entry.task.slice(0, TASK_MAX_CHARS),
        summary: typeof entry.summary === 'string' ? entry.summary : '',
        at: typeof entry.at === 'string' && entry.at ? entry.at : new Date().toISOString(),
      }
      await enqueue(async () => {
        const entries = readEntries(filePath)
        entries.push(stamped)
        await atomicWriteFile(filePath, toFileBytes(entries))
      })
    },

    lineageFor(path) {
      if (typeof path !== 'string' || !path.trim()) return null
      const wanted = canonicalAgentPath(path)
      const canonical = canonicalizer()
      let best: AiLineageEntry | null = null
      let bestAt = Number.NEGATIVE_INFINITY
      for (const entry of readEntries(filePath)) {
        if (canonical(entry.path) !== wanted) continue
        const parsed = Date.parse(entry.at)
        // an `at` nothing parses still answers when it is the only entry (it
        // scores as the epoch); a later line wins a tie, so same-millisecond
        // regenerations keep their append order
        const at = Number.isNaN(parsed) ? 0 : parsed
        if (at >= bestAt) {
          best = entry
          bestAt = at
        }
      }
      return best
    },

    async clear(path) {
      if (path === undefined) {
        await enqueue(() => atomicWriteFile(filePath, toFileBytes([])))
        return
      }
      if (typeof path !== 'string' || !path.trim()) {
        throw new Error('ai-lineage clear needs the path to clear (omit it to clear everything)')
      }
      const wanted = canonicalAgentPath(path)
      const canonical = canonicalizer()
      await enqueue(async () => {
        const kept = readEntries(filePath).filter((entry) => canonical(entry.path) !== wanted)
        await atomicWriteFile(filePath, toFileBytes(kept))
      })
    },
  }
}
