import { useEffect, useRef, useState } from 'react'
import type { Lang } from '@genoffice/i18n'
import type { HomeApi, TodoItem } from '../../shared/home-api'
import { todoStrings } from './todo-strings'

/** the store's defensive cap — the main process clamps too; the widget never piles past it */
const MAX_ITEMS = 500
/** one task's text, clamped the same way the main process clamps it */
const MAX_TEXT = 500
/** write-through window: a burst of changes costs one save */
const SAVE_DEBOUNCE_MS = 300

interface TodoWidgetProps {
  /** the UI language, from the locale context the parent holds */
  lang: Lang
}

/**
 * The Home sidebar's todo quick-capture card: one line in, Enter, and the task
 * is on disk (home.css carries the look; the parent mounts it under the
 * folder tree). The list is owned whole by this widget — every change replaces
 * it in one state update and is written through 300ms later, newest on top —
 * but a write from outside (the CLI, another window) arrives as a
 * todos-changed broadcast and is adopted or merged, so the two writers never
 * clobber each other's entries.
 */
export function TodoWidget({ lang }: TodoWidgetProps) {
  const s = todoStrings(lang)
  const [items, setItems] = useState<TodoItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [draft, setDraft] = useState('')

  // the list the next save must write, whichever render armed the timer
  const itemsRef = useRef(items)
  itemsRef.current = items
  const savingRef = useRef(false)
  /** the list that is on disk or in flight; a flush of it is a no-op */
  const savedRef = useRef<TodoItem[] | null>(null)
  /** ids removed here while a write was pending: the merge must not resurrect
   *  them — a pending removal is as real as a pending edit */
  const removedRef = useRef(new Set<string>())
  const retryTimerRef = useRef(0)

  // load once on mount. A preload that predates the feature, or an unreadable
  // store, reads as an empty list: the widget still works, and its first
  // change writes the file.
  useEffect(() => {
    let alive = true
    const request = (window.aiOffice as Partial<HomeApi>).todosList?.()
    if (!request) {
      savedRef.current = itemsRef.current
      setLoaded(true)
      return
    }
    request.then(
      (stored) => {
        if (!alive) return
        const items = Array.isArray(stored) ? stored : []
        savedRef.current = items
        setItems(items)
        setLoaded(true)
      },
      () => {
        if (alive) {
          // an unreadable store reads as the empty list, and nothing here is
          // pending against it — the post-subscribe pull adopts disk truth
          // instead of merging the whole list in and writing it back
          savedRef.current = itemsRef.current
          setLoaded(true)
        }
      },
    )
    return () => {
      alive = false
    }
  }, [])

  // the list changed on disk outside this widget — the CLI's
  // `desktop todo add`, another window's save. With nothing pending here the
  // disk truth is adopted wholesale (a cross-window toggle arrives the same
  // way); with edits in flight, the entries this list has never seen are
  // spliced in on top, minus anything removed here (a pending removal is as
  // real as a pending edit), because the next whole-list write-through must
  // not write either back off the disk. An incoming list of only known
  // entries changes nothing — that is our own save's echo, and adopting it
  // would re-arm the write-through against content we already hold.
  //
  // The subscription is followed by one pull: a CLI write whose broadcast
  // landed between the load's disk read and this listener attaching would be
  // gone otherwise (plain ipc events are not replayed for late subscribers),
  // and the widget's next save would write it off the disk.
  useEffect(() => {
    if (!loaded) return
    const reconcile = (incoming: TodoItem[]): void => {
      if (itemsRef.current === savedRef.current) {
        savedRef.current = incoming
        removedRef.current.clear()
        setItems(incoming)
        return
      }
      const known = new Set(itemsRef.current.map((item) => item.id))
      const fresh = incoming.filter(
        (item) => !known.has(item.id) && !removedRef.current.has(item.id),
      )
      if (fresh.length === 0) return
      // newest on top, the position both this widget's add() and the CLI's
      // addTodo give a new entry
      setItems([...fresh, ...itemsRef.current])
    }
    const off = (window.aiOffice as Partial<HomeApi>).onTodosChanged?.((incoming) => {
      if (Array.isArray(incoming)) reconcile(incoming)
    })
    let alive = true
    const pull = (window.aiOffice as Partial<HomeApi>).todosList?.()
    if (pull) {
      pull.then(
        (fresh) => {
          if (alive && Array.isArray(fresh)) reconcile(fresh)
        },
        () => {},
      )
    }
    return () => {
      alive = false
      off?.()
    }
  }, [loaded])

  // write-through: every change arms one save, 300ms out, of the newest list.
  // A change that lands while a save is still in flight re-arms on that save's
  // completion, so of two racing writes the newer list is the one on disk.
  useEffect(() => {
    if (!loaded) return
    const timer = window.setTimeout(() => void flush(), SAVE_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)

    async function flush(): Promise<void> {
      if (savingRef.current) {
        retryTimerRef.current = window.setTimeout(() => void flush(), SAVE_DEBOUNCE_MS)
        return
      }
      const snapshot = itemsRef.current
      if (snapshot === savedRef.current) return
      savingRef.current = true
      try {
        await (window.aiOffice as Partial<HomeApi>).todosSave?.(snapshot)
        savedRef.current = snapshot
        // only the removals this snapshot made durable (ids absent from it —
        // they are gone from disk now) clear; an id removed while the save
        // was in flight is still in the written list, so its tombstone must
        // survive the next broadcast or the removal resurrects
        const durable = new Set(snapshot.map((item) => item.id))
        for (const id of [...removedRef.current]) {
          if (!durable.has(id)) removedRef.current.delete(id)
        }
        // a change landed mid-flight: write the newest list right away
        if (itemsRef.current !== savedRef.current) {
          retryTimerRef.current = window.setTimeout(() => void flush(), 0)
        }
      } catch {
        // a refused save is retried by the next change's debounce
      } finally {
        savingRef.current = false
      }
    }
  }, [items, loaded])

  useEffect(() => () => window.clearTimeout(retryTimerRef.current), [])

  const add = () => {
    const text = draft.trim().slice(0, MAX_TEXT)
    if (!text || items.length >= MAX_ITEMS) return
    setItems([{ id: crypto.randomUUID(), text, done: false }, ...items])
    setDraft('')
  }

  const toggle = (id: string) =>
    setItems(items.map((item) => (item.id === id ? { ...item, done: !item.done } : item)))

  const remove = (id: string) => {
    // remember the removal until it is durable: a broadcast merged into a
    // pending write must not resurrect what this list just dropped
    removedRef.current.add(id)
    setItems(items.filter((item) => item.id !== id))
  }

  const clearDone = () => {
    for (const item of items) if (item.done) removedRef.current.add(item.id)
    setItems(items.filter((item) => !item.done))
  }

  const openCount = items.filter((item) => !item.done).length
  const hasDone = openCount < items.length

  return (
    <section className="todo-panel" aria-label={s.title}>
      <div className="todo-head">
        <span className="todo-title">{s.title}</span>
        {openCount > 0 && <span className="todo-count">{openCount}</span>}
      </div>
      <input
        className="todo-input"
        value={draft}
        placeholder={s.placeholder}
        aria-label={s.placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          // an IME's Enter confirms the composition, not the task
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter') add()
        }}
      />
      <ul className="todo-list">
        {loaded && items.length === 0 && <li className="todo-empty">{s.empty}</li>}
        {items.map((item) => (
          <li key={item.id} className="todo-row" onClick={() => toggle(item.id)}>
            <input
              type="checkbox"
              className="todo-check"
              checked={item.done}
              onChange={() => toggle(item.id)}
              onClick={(event) => event.stopPropagation()}
              aria-label={item.text}
            />
            <span className={`todo-text${item.done ? ' done' : ''}`}>{item.text}</span>
            <button
              className="todo-remove"
              aria-label={s.delete}
              onClick={(event) => {
                event.stopPropagation()
                remove(item.id)
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <path
                  d="M2 2l8 8M10 2L2 10"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </li>
        ))}
      </ul>
      {hasDone && (
        <button className="todo-clear" onClick={clearDone}>
          {s.clearDone}
        </button>
      )}
    </section>
  )
}
