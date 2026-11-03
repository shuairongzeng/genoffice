import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { atomicWriteFile } from '@genoffice/electron-utils/atomic-write'

import {
  ANNOTATION_NOTE_MAX,
  clampNote,
  normalizeAnnotationList,
  normalizeAnnotationUrl,
  normalizePinDraft,
  normalizeShotPath,
} from '../shared/annotations'
import type { BrowserAnnotation } from '../shared/annotations'
import { deleteAnnotationShot } from './annotation-shots'

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
  /**
   * Record one annotation's element shot (the path relative to userData, as
   * the pin flow wrote it). false when the id is unknown or the path is not
   * the canonical shots shape — the shot stays unrecorded either way.
   */
  setShotPath(id: string, shotPath: string): boolean
  /**
   * Drop one record — and with it the record's shot file, which belongs to no
   * one else (the file name is the record id). false (no write, no delete)
   * when the id is unknown.
   */
  remove(id: string): boolean
  /**
   * Drop every record keyed to one URL — and with them their shot files —
   * answering how many went (0 for an unknown URL or unusable key). The
   * browser:clear_annotations tool's store half.
   */
  clearForUrl(url: string): number
  /** read the file again (tests; runtime keeps the in-memory list current) */
  reload(): void
}

export interface AnnotationStoreSpec {
  /** the one file the store reads and writes */
  path: () => string
  /** how failures surface (main logs; tests can capture) */
  onWriteError?: (error: unknown) => void
  /**
   * Where the store's userData root is (the shots live under
   * `userData/annotation-shots`). Present = remove() deletes the record's
   * shot file too; absent = the store never touches files (the pure-shape
   * tests need no disk shots).
   */
  userData?: () => string
  /** how shot-file removal failures surface */
  onShotError?: (error: unknown) => void
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
    setShotPath: (id, shotPath) => {
      const index = records.findIndex((record) => record.id === id)
      if (index < 0) return false
      const clean = normalizeShotPath(shotPath)
      if (clean === undefined) return false
      if (records[index]!.shotPath === clean) return true
      const next = [...records]
      next[index] = { ...records[index]!, shotPath: clean }
      persist(next)
      return true
    },
    remove: (id) => {
      if (!records.some((record) => record.id === id)) return false
      persist(records.filter((record) => record.id !== id))
      // the shot file leaves with its record: the file is named by the record
      // id and belongs to no one else, so leaving it is only garbage. Deleting
      // the canonical path (not the stored field) also cleans a capture whose
      // setShotPath write never landed, and cannot be aimed elsewhere.
      const userData = spec.userData?.()
      if (userData !== undefined) {
        deleteAnnotationShot(userData, id, spec.onShotError)
      }
      return true
    },
    clearForUrl: (url) => {
      const key = normalizeAnnotationUrl(url)
      if (key === null) return 0
      const doomed = records.filter((record) => record.url === key)
      if (doomed.length === 0) return 0
      persist(records.filter((record) => record.url !== key))
      // every dropped record's shot file leaves with it, exactly as a
      // one-by-one remove() would do
      const userData = spec.userData?.()
      if (userData !== undefined) {
        for (const record of doomed) {
          if (record.shotPath !== undefined)
            deleteAnnotationShot(userData, record.id, spec.onShotError)
        }
      }
      return doomed.length
    },
    reload: () => {
      records = readList(spec.path())
    },
  }
}
