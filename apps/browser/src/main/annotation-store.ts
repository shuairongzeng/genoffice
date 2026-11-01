import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { atomicWriteFile } from '@genoffice/electron-utils/atomic-write'

import {
  ANNOTATION_NOTE_MAX,
  clampNote,
  normalizeAnnotationList,
  normalizeAnnotationUrl,
  normalizePinDraft,
} from '../shared/annotations'
import type { BrowserAnnotation } from '../shared/annotations'

/**
 * The browser's one-file userData store behind `browser-annotations.json`,
 * following the shell's json-store pattern (apps/shell/src/main/json-store.ts
 * — the shell module cannot be imported from an app, so the same contract is
 * restated here): a normalize hook that enforces the shape on everything read
 * or written, a scratch-then-rename atomic write, and a read that treats a
 * missing or corrupt file as the store's default value instead of a crash.
 *
 * Version 1 by the convention's marker-less rule: the body on disk is the bare
 * annotation array — no wrapper, no version stamp — so the first migration
 * step wraps it whenever a schema change lands.
 */

/** the file the store reads and writes, under userData */
export function annotationStorePath(userDataDir: string): string {
  return `${userDataDir}/browser-annotations.json`
}

export interface AnnotationStore {
  /** every valid record, file order; a missing/corrupt file reads as [] */
  list(): readonly BrowserAnnotation[]
  /** the records whose key matches the given URL (hash-stripped; [] for junk) */
  listForUrl(url: string): readonly BrowserAnnotation[]
  /** one record by id */
  byId(id: string): BrowserAnnotation | undefined
  /**
   * Pin a new annotation: the draft is validated and clamped (the renderer is
   * never trusted for shape), the id and createdAt are minted here. null when
   * the draft or URL is unusable — the pin is dropped, nothing is written.
   */
  add(url: string, draft: unknown): BrowserAnnotation | null
  /** rewrite one record's note (clamped); false when the id is unknown */
  setNote(id: string, note: string): boolean
  /** drop one record; false (no write) when the id is unknown */
  remove(id: string): boolean
  /** read the file again (tests; runtime keeps the in-memory list current) */
  reload(): void
}

export interface AnnotationStoreSpec {
  /** the one file the store reads and writes */
  path: () => string
  /** how failures surface (main logs; tests can capture) */
  onWriteError?: (error: unknown) => void
}

/** read + normalize whatever the file holds; junk and absence both read as [] */
function readList(path: string): BrowserAnnotation[] {
  try {
    return normalizeAnnotationList(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return []
  }
}

export function createAnnotationStore(spec: AnnotationStoreSpec): AnnotationStore {
  let records: BrowserAnnotation[] = readList(spec.path())

  const persist = (next: BrowserAnnotation[]): void => {
    records = next
    const body = Buffer.from(JSON.stringify(next, null, 2), 'utf8')
    void atomicWriteFile(spec.path(), body).catch((error: unknown) => spec.onWriteError?.(error))
  }

  return {
    list: () => records,
    listForUrl: (url) => {
      const key = normalizeAnnotationUrl(url)
      if (key === null) return []
      return records.filter((record) => record.url === key)
    },
    byId: (id) => records.find((record) => record.id === id),
    add: (url, draft) => {
      const key = normalizeAnnotationUrl(url)
      if (key === null) return null
      const record = normalizePinDraft(draft, key, randomUUID(), Date.now())
      if (record === null) return null
      // the record cap applies on write, not only when a reload normalizes:
      // the list (and the file it persists) never grows past
      // ANNOTATION_RECORDS_MAX, so the store bounds itself however long it
      // lives. The cap keeps the newest records, so this pin survives and the
      // oldest record drops.
      const next = normalizeAnnotationList([...records, record])
      persist(next)
      // a pin the cap itself dropped (nothing survived the trim) reads as a
      // refused pin: the caller parks nothing for it
      return next.find((entry) => entry.id === record.id) ?? null
    },
    setNote: (id, note) => {
      const index = records.findIndex((record) => record.id === id)
      if (index < 0) return false
      const clamped = clampNote(note.slice(0, ANNOTATION_NOTE_MAX))
      if (records[index]!.note === clamped) return true
      const next = [...records]
      next[index] = { ...records[index]!, note: clamped }
      persist(next)
      return true
    },
    remove: (id) => {
      if (!records.some((record) => record.id === id)) return false
      persist(records.filter((record) => record.id !== id))
      return true
    },
    reload: () => {
      records = readList(spec.path())
    },
  }
}
