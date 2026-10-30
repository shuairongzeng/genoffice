/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LANGS, type Lang } from '@genoffice/i18n'
import type { HomeApi, TodoItem } from '../src/shared/home-api'
import { TodoWidget } from '../src/renderer/src/TodoWidget'
import { TODO_STRINGS } from '../src/renderer/src/todo-strings'

/**
 * The Home sidebar's todo widget against a mocked bridge: what the card shows,
 * that every change is written through — debounced, and with the newest list
 * winning when two writes race — and that a todos-changed broadcast from
 * outside (the CLI, another window) is adopted or merged rather than clobbered
 * by this widget's next whole-list save.
 */

const DEBOUNCE_MS = 300

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
/** what the bridge has been asked to list */
let stored: TodoItem[]
/** every save, in order, with the exact list it carried */
let saves: TodoItem[][]
/** the widget's live todos-changed subscriptions */
let changedListeners: Set<(items: TodoItem[]) => void>

const item = (id: string, text: string, done = false): TodoItem => ({ id, text, done })

beforeEach(() => {
  vi.useFakeTimers()
  stored = []
  saves = []
  changedListeners = new Set()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  window.aiOffice = {
    todosList: vi.fn(async () => stored),
    todosSave: vi.fn(async (items: TodoItem[]) => {
      saves.push(items)
      return undefined
    }),
    onTodosChanged: vi.fn((handler: (items: TodoItem[]) => void) => {
      changedListeners.add(handler)
      return () => changedListeners.delete(handler)
    }),
  } as unknown as HomeApi
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  window.aiOffice = undefined as unknown as HomeApi
  vi.useRealTimers()
})

async function render(lang: Lang = 'en'): Promise<void> {
  await act(async () => {
    root.render(createElement(TodoWidget, { lang }))
    await Promise.resolve()
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** a clean mount: the load effect runs once per mount, so a second scenario needs a new root */
async function renderFresh(lang: Lang = 'en'): Promise<void> {
  act(() => root.unmount())
  host.remove()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await render(lang)
}

/** run the write-through debounce out */
async function tick(ms = DEBOUNCE_MS): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function click(el: Element | null | undefined): Promise<void> {
  expect(el).toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).click()
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** type into the add input the way a user would */
async function type(text: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('.todo-input')!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
}

async function pressEnter(): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('.todo-input')!
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await Promise.resolve()
  })
}

/** add a todo the way the card's own user does: type, Enter */
async function add(text: string): Promise<void> {
  await type(text)
  await pressEnter()
}

/** deliver a main-process todos-changed broadcast to the mounted widget */
async function broadcast(items: TodoItem[]): Promise<void> {
  await act(async () => {
    for (const listener of [...changedListeners]) listener(items)
    await Promise.resolve()
    await Promise.resolve()
  })
}

const rows = () => [...host.querySelectorAll('.todo-row')]
const rowTexts = () => rows().map((row) => row.querySelector('.todo-text')?.textContent ?? '')
const count = () => host.querySelector('.todo-count')?.textContent ?? ''
const clearButton = () =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === 'Clear completed')
const textsOf = (items: TodoItem[]) => items.map((i) => i.text)

describe('TodoWidget — the card', () => {
  it('loads the stored list on mount: rows, open count, done styling', async () => {
    stored = [item('a', 'buy milk'), item('b', 'write report', true)]
    await render()
    expect(rowTexts()).toEqual(['buy milk', 'write report'])
    expect(rows()[1]!.querySelector('.todo-text')!.className).toContain('done')
    expect((rows()[1]!.querySelector('.todo-check') as HTMLInputElement).checked).toBe(true)
    expect(count()).toBe('1')
    expect(clearButton()).toBeTruthy()
    expect(saves).toEqual([])
  })

  it('shows nothing in the list while the load is in flight, then the rows', async () => {
    let resolveList: (v: TodoItem[]) => void = () => {}
    ;(window.aiOffice as HomeApi).todosList = () =>
      new Promise<TodoItem[]>((r) => (resolveList = r))
    await render()
    expect(host.querySelectorAll('.todo-row')).toHaveLength(0)
    expect(host.textContent).not.toContain('Nothing here yet')
    await act(async () => {
      resolveList([item('a', 'one')])
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(rowTexts()).toEqual(['one'])
    expect(saves).toEqual([])
  })

  it('reads an unreadable store as empty and still works', async () => {
    ;(window.aiOffice as HomeApi).todosList = async () => {
      throw new Error('unreadable')
    }
    await render()
    expect(host.textContent).toContain('Nothing here yet')
    await add('first')
    await tick()
    expect(saves).toHaveLength(1)
    expect(textsOf(saves[0]!)).toEqual(['first'])
  })

  it('survives a preload that predates the feature', async () => {
    window.aiOffice = {} as unknown as HomeApi
    await render()
    expect(host.textContent).toContain('Nothing here yet')
    expect(saves).toEqual([])
  })

  it('Enter adds the typed task, clears the input, and saves it after the debounce', async () => {
    await render()
    await type('buy milk')
    await pressEnter()
    const input = host.querySelector<HTMLInputElement>('.todo-input')!
    expect(input.value).toBe('')
    expect(rowTexts()).toEqual(['buy milk'])
    expect(count()).toBe('1')
    expect(saves).toEqual([])
    await tick(DEBOUNCE_MS - 1)
    expect(saves).toEqual([])
    await tick(1)
    expect(saves).toHaveLength(1)
    expect(saves[0]).toEqual([{ id: expect.any(String), text: 'buy milk', done: false }])
  })

  it('Enter on whitespace adds nothing and saves nothing', async () => {
    await render()
    await type('   ')
    await pressEnter()
    expect(rowTexts()).toEqual([])
    expect(saves).toEqual([])
    await tick()
    expect(saves).toEqual([])
  })

  it('clamps an oversized paste to the 500-character text cap the store keeps', async () => {
    await render()
    await add('x'.repeat(600))
    expect(rowTexts()[0]).toHaveLength(500)
    await tick()
    expect(saves[0]![0]!.text).toHaveLength(500)
  })

  it('shows the newest task on top', async () => {
    stored = [item('a', 'first')]
    await render()
    await add('second')
    expect(rowTexts()).toEqual(['second', 'first'])
    await tick()
    expect(textsOf(saves[0]!)).toEqual(['second', 'first'])
  })

  it('one friendly line when the list is empty and loaded', async () => {
    await render()
    expect(host.textContent).toContain('Nothing here yet — jot down a task and press Enter')
    await add('something')
    expect(host.textContent).not.toContain('Nothing here yet')
  })

  it('renders the zh words when the lang prop is zh', async () => {
    await render('zh')
    expect(host.querySelector('.todo-title')!.textContent).toBe('待办')
    expect(host.querySelector<HTMLInputElement>('.todo-input')!.placeholder).toBe(
      '添加一条待办，回车保存',
    )
    expect(host.textContent).toContain('还没有待办，想到什么直接写下来')
    stored = [item('a', '写周报', true)]
    await renderFresh('zh')
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toContain('清除已完成')
  })
})

describe('TodoWidget — write-through', () => {
  it('a burst of changes is one save of the final list', async () => {
    await render()
    await add('one')
    await add('two')
    await tick()
    expect(saves).toHaveLength(1)
    expect(textsOf(saves[0]!)).toEqual(['two', 'one'])
    // and nothing further happens when the timer runs out again
    await tick()
    expect(saves).toHaveLength(1)
  })

  it('clicking a row toggles it and persists the flip', async () => {
    stored = [item('a', 'buy milk')]
    await render()
    await click(rows()[0])
    expect(rows()[0]!.querySelector('.todo-text')!.className).toContain('done')
    expect(count()).toBe('')
    await tick()
    expect(saves).toHaveLength(1)
    expect(saves[0]![0]!.done).toBe(true)
    // and back
    await click(rows()[0])
    expect(rows()[0]!.querySelector('.todo-text')!.className).not.toContain('done')
    await tick()
    expect(saves).toHaveLength(2)
    expect(saves[1]![0]!.done).toBe(false)
  })

  it('the checkbox toggles its row without double-firing', async () => {
    stored = [item('a', 'buy milk')]
    await render()
    await click(rows()[0]!.querySelector('.todo-check'))
    expect(rows()[0]!.querySelector('.todo-text')!.className).toContain('done')
    await tick()
    expect(saves).toHaveLength(1)
    expect(saves[0]![0]!.done).toBe(true)
  })

  it('the hover ✕ deletes its row and persists the shorter list', async () => {
    stored = [item('a', 'keep'), item('b', 'drop')]
    await render()
    await click(rows()[1]!.querySelector('.todo-remove'))
    expect(rowTexts()).toEqual(['keep'])
    await tick()
    expect(saves).toHaveLength(1)
    expect(textsOf(saves[0]!)).toEqual(['keep'])
  })

  it('清除已完成 / Clear completed drops only the done rows, then hides itself', async () => {
    stored = [item('a', 'open one'), item('b', 'done one', true), item('c', 'done two', true)]
    await render()
    expect(count()).toBe('1')
    await click(clearButton())
    expect(rowTexts()).toEqual(['open one'])
    expect(clearButton()).toBeFalsy()
    await tick()
    expect(saves).toHaveLength(1)
    expect(textsOf(saves[0]!)).toEqual(['open one'])
  })

  it('the clear action stays hidden while nothing is done', async () => {
    stored = [item('a', 'open one')]
    await render()
    expect(clearButton()).toBeFalsy()
    await click(rows()[0])
    expect(clearButton()).toBeTruthy()
  })

  it('a change during an in-flight save re-arms, so the newest list is written last', async () => {
    stored = [item('a', 'one')]
    // each save resolves only when the test releases it
    const releases: Array<() => void> = []
    ;(window.aiOffice as HomeApi).todosSave = (items: TodoItem[]) => {
      saves.push(items)
      return new Promise<void>((resolve) => releases.push(resolve))
    }
    await render()

    await add('two')
    await tick() // save 1 in flight: [two, one]
    expect(saves).toHaveLength(1)
    expect(textsOf(saves[0]!)).toEqual(['two', 'one'])

    // a change lands while that write is still open: toggle 'one'
    await click(rows()[1])
    expect(saves).toHaveLength(1) // nothing new yet

    await act(async () => {
      releases[0]!()
      await Promise.resolve()
      await Promise.resolve()
    })
    await tick(1) // the mid-flight change writes right away
    expect(saves).toHaveLength(2)
    expect(saves[1]!.map((i) => [i.text, i.done])).toEqual([
      ['two', false],
      ['one', true],
    ])
    await act(async () => {
      releases[1]!()
      await Promise.resolve()
      await Promise.resolve()
    })
    await tick()
    expect(saves).toHaveLength(2) // the newest state is on disk; no more writes
  })
})

describe('TodoWidget — a write from outside (todos-changed)', () => {
  it('adopts the broadcast at once: the CLI entry is on the card with no debounce', async () => {
    stored = [item('a', 'buy milk')]
    await render()
    await broadcast([item('cli', 'from the CLI'), item('a', 'buy milk')])
    expect(rowTexts()).toEqual(['from the CLI', 'buy milk'])
    expect(count()).toBe('2')
    // nothing was pending here, so adoption writes nothing back
    await tick()
    expect(saves).toEqual([])
  })

  it('the acceptance gate: a later UI edit persists the CLI entry instead of writing it off the disk', async () => {
    stored = [item('a', 'buy milk')]
    await render()
    await broadcast([item('cli', 'from the CLI'), item('a', 'buy milk')])
    await click(rows()[1]) // the user toggles their own task
    await tick()
    expect(saves).toHaveLength(1)
    expect(saves[0]!.map((i) => [i.id, i.done])).toEqual([
      ['cli', false],
      ['a', true],
    ])
  })

  it('merges when local edits are in flight: the next write-through carries both writers', async () => {
    stored = [item('a', 'on disk')]
    await render()
    await add('typed here') // pending: the debounce has not run
    await broadcast([item('cli', 'from the CLI'), item('a', 'on disk')])
    // the unknown entry is spliced in on top; the local edit keeps its place
    expect(rowTexts()).toEqual(['from the CLI', 'typed here', 'on disk'])
    await tick()
    expect(textsOf(saves[0]!)).toEqual(['from the CLI', 'typed here', 'on disk'])
  })

  it('keeps a locally removed row removed when the broadcast still carries it', async () => {
    stored = [item('a', 'keep'), item('b', 'drop')]
    await render()
    await click(rows()[1]!.querySelector('.todo-remove')) // pending removal
    await broadcast([item('cli', 'from the CLI'), item('a', 'keep'), item('b', 'drop')])
    expect(rowTexts()).toEqual(['from the CLI', 'keep'])
    await tick()
    expect(textsOf(saves[0]!)).toEqual(['from the CLI', 'keep'])
  })

  it('adopts a cross-window toggle with nothing pending, without re-saving', async () => {
    stored = [item('a', 'buy milk')]
    await render()
    await broadcast([item('a', 'buy milk', true)])
    expect(rows()[0]!.querySelector('.todo-text')!.className).toContain('done')
    await tick()
    expect(saves).toEqual([]) // disk already holds this; no echo write
  })

  it("ignores its own save's echo: a broadcast of what it just wrote writes nothing", async () => {
    await render()
    await add('only one')
    await tick()
    expect(saves).toHaveLength(1)
    // the main process broadcasts every write, including this widget's own
    await broadcast([item('id-1', 'only one')])
    await tick()
    expect(saves).toHaveLength(1)
    expect(rowTexts()).toEqual(['only one'])
  })

  it('a malformed broadcast changes nothing and costs nothing', async () => {
    stored = [item('a', 'buy milk')]
    await render()
    await broadcast(null as unknown as TodoItem[])
    await broadcast('nope' as unknown as TodoItem[])
    expect(rowTexts()).toEqual(['buy milk'])
    await tick()
    expect(saves).toEqual([])
  })

  it('a CLI write that raced the load lands via the post-subscribe pull', async () => {
    // the load's disk read predated the CLI write, and the write's broadcast
    // predated the subscription — only the pull that follows subscribing
    // can still see it, or the next save would write it off the disk
    let reads = 0
    ;(window.aiOffice as HomeApi).todosList = async () => {
      reads += 1
      return reads === 1 ? [] : [item('cli', 'from the CLI')]
    }
    await render()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(rowTexts()).toEqual(['from the CLI'])
    await tick()
    expect(saves).toEqual([]) // adoption of disk truth writes nothing back
  })

  it('a CLI broadcast landing mid-save converges: the retry write carries the union, and the echo writes nothing', async () => {
    stored = [item('a', 'one')]
    // each save resolves only when the test releases it
    const releases: Array<() => void> = []
    ;(window.aiOffice as HomeApi).todosSave = (items: TodoItem[]) => {
      saves.push(items)
      return new Promise<void>((resolve) => releases.push(resolve))
    }
    await render()
    await add('two')
    await tick() // save 1 in flight: [two, one]
    expect(saves).toHaveLength(1)
    // the CLI writes while that save is still open
    await broadcast([item('cli', 'from the CLI'), item('a', 'one')])
    expect(rowTexts()).toEqual(['from the CLI', 'two', 'one'])
    await act(async () => {
      releases[0]!()
      await Promise.resolve()
      await Promise.resolve()
    })
    await tick(1) // the mid-flight change writes right away
    expect(saves).toHaveLength(2)
    expect(textsOf(saves[1]!)).toEqual(['from the CLI', 'two', 'one'])
    await act(async () => {
      releases[1]!()
      await Promise.resolve()
      await Promise.resolve()
    })
    // the main process echoes save 2 back: nothing pending, so nothing writes
    await broadcast(saves[1]!)
    await tick()
    expect(saves).toHaveLength(2)
  })

  it('a removal made while a save was in flight stays removed across the next broadcast', async () => {
    stored = [item('a', 'keep'), item('b', 'doomed')]
    const releases: Array<() => void> = []
    ;(window.aiOffice as HomeApi).todosSave = (items: TodoItem[]) => {
      saves.push(items)
      return new Promise<void>((resolve) => releases.push(resolve))
    }
    await render()
    await add('mine')
    await tick() // save 1 in flight: [mine, keep, doomed]
    expect(saves).toHaveLength(1)
    // 'doomed' leaves while save 1 is still open: that snapshot still
    // carries it, so its removal is NOT durable when the save lands
    await click(rows()[2]!.querySelector('.todo-remove'))
    expect(rowTexts()).toEqual(['mine', 'keep'])
    await act(async () => {
      releases[0]!()
      await Promise.resolve()
      await Promise.resolve()
    })
    // a broadcast lands between the save's reply and the retry write, still
    // carrying the removed row (say the CLI's echo of the just-written file)
    await broadcast([
      item('cli', 'from the CLI'),
      saves[0]![0]!, // the local 'mine', with its own id
      item('a', 'keep'),
      item('b', 'doomed'),
    ])
    expect(rowTexts()).toEqual(['from the CLI', 'mine', 'keep'])
    await tick(1) // the retry write carries the union, minus the removal
    expect(saves).toHaveLength(2)
    expect(textsOf(saves[1]!)).toEqual(['from the CLI', 'mine', 'keep'])
    await act(async () => {
      releases[1]!()
      await Promise.resolve()
      await Promise.resolve()
    })
    await tick()
    expect(saves).toHaveLength(2)
  })

  it('subscribes once the list has loaded and unsubscribes on unmount', async () => {
    await render()
    expect(changedListeners.size).toBe(1)
    act(() => root.unmount())
    expect(changedListeners.size).toBe(0)
  })

  it('survives a preload that predates the broadcast', async () => {
    // list and save still work; only onTodosChanged is missing
    window.aiOffice = {
      todosList: async () => stored,
      todosSave: async (items: TodoItem[]) => {
        saves.push(items)
      },
    } as unknown as HomeApi
    await render()
    expect(rowTexts()).toEqual([])
    await add('still works')
    await tick()
    expect(textsOf(saves[0]!)).toEqual(['still works'])
  })
})

describe('todo strings — every UI language', () => {
  it('covers all 21 langs with non-empty words for each key', () => {
    expect(LANGS).toHaveLength(21)
    for (const lang of LANGS) {
      const words = TODO_STRINGS[lang]
      expect(words, `${lang} is present`).toBeTruthy()
      for (const [key, value] of Object.entries(words)) {
        expect((value as string).length, `${lang}.${key} is empty`).toBeGreaterThan(0)
      }
    }
  })
})
