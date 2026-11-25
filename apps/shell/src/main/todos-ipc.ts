import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { createJsonStore } from './json-store'
import type {
  ButlerDesktopTodoRequest,
  ButlerDesktopTodoResult,
} from '../shared/butler-orchestrator-api'
import { HOME_CHANNELS, type TodoItem } from '../shared/home-api'

/**
 * Tell every live renderer the list on disk just changed, carrying the list
 * as written. A write from anywhere — the CLI's `desktop todo add`, another
 * window's widget — reaches every reader, so a mounted widget can adopt or
 * merge the new list instead of blind-writing its stale copy back over it
 * (the same contract the desktop prefs' broadcast carries).
 */
export function broadcastTodosChanged(items: TodoItem[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(HOME_CHANNELS.todosChanged, items)
  }
}

/** where the todo list lives: one file the whole widget reads and writes through */
export function todosFilePath(userDataDir: string): string {
  return join(userDataDir, 'todos.json')
}

/** the list never grows past this, whatever the renderer sends (defensive, not a refusal) */
const MAX_ITEMS = 500
/** one todo's text is clamped to this before anything is stored */
const MAX_TEXT = 500

function isTodoItem(value: unknown): value is TodoItem {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return (
    typeof item.id === 'string' && typeof item.text === 'string' && typeof item.done === 'boolean'
  )
}

/**
 * The store's invariant, applied to anything read or written: shape-valid
 * entries only, at most `MAX_ITEMS` of them, each text clamped. A payload that
 * is not an array is the empty list; entries that lost their shape are dropped
 * individually so one bad line never costs the rest of the list.
 */
function normalizeTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return []
  const out: TodoItem[] = []
  for (const entry of raw) {
    if (!isTodoItem(entry)) continue
    out.push({ id: entry.id, text: entry.text.slice(0, MAX_TEXT), done: entry.done })
    if (out.length >= MAX_ITEMS) break
  }
  return out
}

/**
 * A missing, corrupt or shapeless file is the empty list — the todos are a
 * convenience, never a reason Home fails to open. Reading is also the one
 * moment a hand-edited or foreign file is normalized into the invariant.
 * Version 1 is today's bare array body (see json-store.ts for the marker and
 * migration convention).
 */
const todosStore = (userDataDir: string) =>
  createJsonStore<TodoItem[]>({
    path: () => todosFilePath(userDataDir),
    version: 1,
    normalize: normalizeTodos,
  })

export function readTodos(userDataDir: string): TodoItem[] {
  return todosStore(userDataDir).read()
}

/** the scratch-then-rename write the imports use, so a crash mid-write costs nothing */
export async function writeTodos(userDataDir: string, items: readonly TodoItem[]): Promise<void> {
  await todosStore(userDataDir).write([...items])
}

/**
 * One new entry added the way the widget adds one (prepended, id from
 * randomUUID, text clamped to the store's per-item cap); returns the
 * normalized list as written, so the caller sees exactly what landed.
 */
export async function addTodo(userDataDir: string, text: string): Promise<TodoItem[]> {
  const items = [{ id: randomUUID(), text, done: false }, ...readTodos(userDataDir)]
  const normalized = normalizeTodos(items)
  await writeTodos(userDataDir, normalized)
  return normalized
}

function countRemainingTodos(items: readonly TodoItem[]): number {
  let count = 0
  for (const item of items) {
    if (!item.done) count += 1
  }
  return count
}

function resolveTargetTodo(
  items: readonly TodoItem[],
  req: ButlerDesktopTodoRequest,
):
  | { readonly ok: true; readonly index: number; readonly item: TodoItem }
  | { readonly ok: false; readonly result: ButlerDesktopTodoResult } {
  const remainingCount = countRemainingTodos(items)
  const rawId = req.id?.trim()
  if (rawId) {
    const idx = items.findIndex((item) => item.id === rawId)
    if (idx === -1) {
      return {
        ok: false,
        result: {
          ok: false,
          action: req.action,
          error: `No desktop todo found with id "${rawId}".`,
          todos: items,
          remainingCount,
        },
      }
    }
    return { ok: true, index: idx, item: items[idx]! }
  }

  const rawMatch = req.match?.trim()
  if (!rawMatch) {
    return {
      ok: false,
      result: {
        ok: false,
        action: req.action,
        error: `Either "id" or "match" is required for desktop todo action "${req.action}".`,
        todos: items,
        remainingCount,
      },
    }
  }

  const needle = rawMatch.toLowerCase()
  const matchedIndices: number[] = []
  for (let i = 0; i < items.length; i += 1) {
    if (items[i]!.text.toLowerCase().includes(needle)) {
      matchedIndices.push(i)
    }
  }

  if (matchedIndices.length === 0) {
    return {
      ok: false,
      result: {
        ok: false,
        action: req.action,
        error: `No desktop todo matching "${rawMatch}" was found.`,
        todos: items,
        remainingCount,
      },
    }
  }

  if (matchedIndices.length > 1) {
    return {
      ok: false,
      result: {
        ok: false,
        action: req.action,
        error: `Multiple desktop todos match "${rawMatch}". Clarify which item or specify its id.`,
        matches: matchedIndices.map((idx) => items[idx]!),
        todos: items,
        remainingCount,
      },
    }
  }

  const index = matchedIndices[0]!
  return { ok: true, index, item: items[index]! }
}

/**
 * Execute CRUD operations on the desktop floating Todo card store and emit
 * the updated list so mounted renderers stay in sync immediately.
 */
export async function manageDesktopTodos(
  userDataDir: string,
  req: ButlerDesktopTodoRequest,
  onChanged?: (items: TodoItem[]) => void,
): Promise<ButlerDesktopTodoResult> {
  const current = readTodos(userDataDir)

  switch (req.action) {
    case 'list':
      return {
        ok: true,
        action: 'list',
        todos: current,
        remainingCount: countRemainingTodos(current),
      }

    case 'add': {
      const text = req.text?.trim() ?? ''
      if (!text) {
        return {
          ok: false,
          action: 'add',
          error: 'Todo text must not be empty when action is "add".',
          todos: current,
          remainingCount: countRemainingTodos(current),
        }
      }
      const next = await addTodo(userDataDir, text)
      onChanged?.(next)
      return {
        ok: true,
        action: 'add',
        item: next[0],
        todos: next,
        remainingCount: countRemainingTodos(next),
      }
    }

    case 'update': {
      const nextText = req.text?.trim().slice(0, MAX_TEXT) ?? ''
      if (!nextText) {
        return {
          ok: false,
          action: 'update',
          error: 'Replacement "text" is required when action is "update".',
          todos: current,
          remainingCount: countRemainingTodos(current),
        }
      }
      const target = resolveTargetTodo(current, req)
      if (!target.ok) return target.result

      const updated: TodoItem = { ...target.item, text: nextText }
      const next = normalizeTodos(current.map((item, idx) => (idx === target.index ? updated : item)))
      await writeTodos(userDataDir, next)
      onChanged?.(next)
      return {
        ok: true,
        action: 'update',
        item: next[target.index] ?? updated,
        todos: next,
        remainingCount: countRemainingTodos(next),
      }
    }

    case 'complete':
    case 'uncomplete':
    case 'toggle': {
      const target = resolveTargetTodo(current, req)
      if (!target.ok) return target.result

      const nextDone =
        req.action === 'complete' ? true : req.action === 'uncomplete' ? false : !target.item.done
      const updated: TodoItem = { ...target.item, done: nextDone }
      const next = normalizeTodos(current.map((item, idx) => (idx === target.index ? updated : item)))
      await writeTodos(userDataDir, next)
      onChanged?.(next)
      return {
        ok: true,
        action: req.action,
        item: next[target.index] ?? updated,
        todos: next,
        remainingCount: countRemainingTodos(next),
      }
    }

    case 'delete': {
      const target = resolveTargetTodo(current, req)
      if (!target.ok) return target.result

      const next = current.filter((_, idx) => idx !== target.index)
      await writeTodos(userDataDir, next)
      onChanged?.(next)
      return {
        ok: true,
        action: 'delete',
        item: target.item,
        todos: next,
        remainingCount: countRemainingTodos(next),
      }
    }

    case 'clear_done': {
      const next = current.filter((item) => !item.done)
      const removedCount = current.length - next.length
      if (removedCount > 0) {
        await writeTodos(userDataDir, next)
        onChanged?.(next)
      }
      return {
        ok: true,
        action: 'clear_done',
        removedCount,
        todos: next,
        remainingCount: countRemainingTodos(next),
      }
    }
  }
}

/**
 * The Home todo widget's IPC: list and whole-list save. The file is the user's
 * data, so a save that does not carry the promised shape is refused outright
 * (the file stays as it was), while size is only ever clamped — never a
 * user-facing refusal. Registered from index.ts like the other feature IPC
 * modules.
 */
export function registerTodosIpc(): void {
  ipcMain.handle(HOME_CHANNELS.todosList, async (): Promise<TodoItem[]> =>
    readTodos(app.getPath('userData')),
  )

  ipcMain.handle(HOME_CHANNELS.todosSave, async (_event, raw: unknown): Promise<void> => {
    if (!Array.isArray(raw) || !raw.every(isTodoItem)) {
      throw new Error('the todo list must be an array of { id, text, done } entries')
    }
    const normalized = normalizeTodos(raw)
    await writeTodos(app.getPath('userData'), normalized)
    broadcastTodosChanged(normalized)
  })
}
