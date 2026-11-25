import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { manageDesktopTodos, readTodos } from '../src/main/todos-ipc'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'genoffice-butler-todos-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('manageDesktopTodos', () => {
  it('supports list, add, update, complete/uncomplete/toggle, delete, and clear_done with onChanged notifications', async () => {
    const userDataDir = makeTempDir()
    const broadcasts: Array<ReadonlyArray<{ id: string; text: string; done: boolean }>> = []
    const onChanged = vi.fn((items) => {
      broadcasts.push(items)
    })

    const initialList = await manageDesktopTodos(userDataDir, { action: 'list' }, onChanged)
    expect(initialList).toEqual({
      ok: true,
      action: 'list',
      todos: [],
      remainingCount: 0,
    })
    expect(onChanged).not.toHaveBeenCalled()

    const add1 = await manageDesktopTodos(
      userDataDir,
      { action: 'add', text: '明天 07:00 起床煮饭' },
      onChanged,
    )
    expect(add1.ok).toBe(true)
    expect(add1.item?.text).toBe('明天 07:00 起床煮饭')
    expect(add1.item?.done).toBe(false)
    expect(add1.remainingCount).toBe(1)
    expect(onChanged).toHaveBeenCalledTimes(1)

    const add2 = await manageDesktopTodos(
      userDataDir,
      { action: 'add', text: '周一 08:30 拿药' },
      onChanged,
    )
    expect(add2.ok).toBe(true)
    expect(add2.todos).toHaveLength(2)
    expect(add2.remainingCount).toBe(2)

    const updated = await manageDesktopTodos(
      userDataDir,
      { action: 'update', match: '起床', text: '明天 07:00 起床早饭煮饭' },
      onChanged,
    )
    expect(updated.ok).toBe(true)
    expect(updated.item?.text).toBe('明天 07:00 起床早饭煮饭')

    const completed = await manageDesktopTodos(
      userDataDir,
      { action: 'complete', match: '拿药' },
      onChanged,
    )
    expect(completed.ok).toBe(true)
    expect(completed.item?.done).toBe(true)
    expect(completed.remainingCount).toBe(1)

    const uncompleted = await manageDesktopTodos(
      userDataDir,
      { action: 'uncomplete', id: completed.item!.id },
      onChanged,
    )
    expect(uncompleted.ok).toBe(true)
    expect(uncompleted.item?.done).toBe(false)
    expect(uncompleted.remainingCount).toBe(2)

    const toggled = await manageDesktopTodos(
      userDataDir,
      { action: 'toggle', id: completed.item!.id },
      onChanged,
    )
    expect(toggled.ok).toBe(true)
    expect(toggled.item?.done).toBe(true)
    expect(toggled.remainingCount).toBe(1)

    const cleared = await manageDesktopTodos(
      userDataDir,
      { action: 'clear_done' },
      onChanged,
    )
    expect(cleared.ok).toBe(true)
    expect(cleared.removedCount).toBe(1)
    expect(cleared.todos).toHaveLength(1)

    const deleted = await manageDesktopTodos(
      userDataDir,
      { action: 'delete', id: updated.item!.id },
      onChanged,
    )
    expect(deleted.ok).toBe(true)
    expect(deleted.todos).toEqual([])
    expect(readTodos(userDataDir)).toEqual([])
    expect(broadcasts).toHaveLength(8)
  })

  it('guards against missing, non-matching, or ambiguous fuzzy matches cleanly', async () => {
    const userDataDir = makeTempDir()
    await manageDesktopTodos(userDataDir, { action: 'add', text: '周一 09:00 开会' })
    await manageDesktopTodos(userDataDir, { action: 'add', text: '周二 14:00 开会' })

    const emptyAdd = await manageDesktopTodos(userDataDir, { action: 'add', text: '   ' })
    expect(emptyAdd.ok).toBe(false)

    const notFound = await manageDesktopTodos(userDataDir, {
      action: 'complete',
      match: '不存在的事项',
    })
    expect(notFound.ok).toBe(false)

    const ambiguous = await manageDesktopTodos(userDataDir, {
      action: 'delete',
      match: '开会',
    })
    expect(ambiguous.ok).toBe(false)
    expect(ambiguous.matches).toHaveLength(2)
    expect(readTodos(userDataDir)).toHaveLength(2)
  })
})
