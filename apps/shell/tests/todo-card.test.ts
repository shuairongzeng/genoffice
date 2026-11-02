// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { TodoCard } from '../src/renderer/src/todo-card'
import { LocaleProvider } from '../src/renderer/src/locale'
import { todoStrings } from '../src/renderer/src/todo-strings'

/**
 * The desktop's todo card (src/renderer/src/todo-card.tsx): the retired
 * sidebar widget promoted to desktop furniture — a floating glass card with
 * a persisted placement (the sidebar rail's local-prefs pattern), a
 * head-band drag handle, and the TodoWidget's own quick-capture input
 * intact inside it. jsdom lays nothing out, so the card's parent box (the
 * stage) is stubbed and the drag is driven by pointer events.
 */

let root: Root
let container: HTMLDivElement
/** the positioned parent the card measures and clamps against */
let parent: HTMLDivElement

const TODO_SAVE = vi.fn(async () => undefined)
const TODO_LIST = vi.fn(async () => [
  { id: 't1', text: 'ship the wave', done: false },
  { id: 't2', text: 'review the docs', done: true },
])

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear()
  TODO_SAVE.mockClear()
  TODO_LIST.mockClear()
  window.aiOffice = {
    todosList: TODO_LIST,
    todosSave: TODO_SAVE,
  } as unknown as Window['aiOffice']
  parent = document.createElement('div')
  // the stage's live box, as the drag's one measurement reads it; jsdom has
  // no layout, so the box is stubbed on the container the card measures
  Object.defineProperty(parent, 'clientWidth', { value: 1200, configurable: true })
  Object.defineProperty(parent, 'clientHeight', { value: 800, configurable: true })
  parent.style.position = 'relative'
  document.body.append(parent)
  container = document.createElement('div')
  parent.append(container)
  Object.defineProperty(container, 'clientWidth', { value: 1200, configurable: true })
  Object.defineProperty(container, 'clientHeight', { value: 800, configurable: true })
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  parent.remove()
  container.remove()
  vi.unstubAllGlobals()
})

const card = (): HTMLElement => container.querySelector<HTMLElement>('.desktop-todo')!
const head = (): HTMLElement => container.querySelector<HTMLElement>('.desktop-todo-head')!

async function mountCard(): Promise<void> {
  await act(async () =>
    root.render(
      createElement(LocaleProvider, {
        initial: 'en',
        children: createElement(TodoCard, { lang: 'en' }),
      }),
    ),
  )
}

describe('the desktop todo card', () => {
  it('renders the widget intact: the input, the rows, the store load', async () => {
    await mountCard()
    const s = todoStrings('en')
    expect(container.querySelector('.todo-input')!.getAttribute('placeholder')).toBe(s.placeholder)
    // the store's list loaded through the widget's own bridge
    expect(TODO_LIST).toHaveBeenCalled()
    expect([...container.querySelectorAll('.todo-text')].map((n) => n.textContent)).toEqual([
      'ship the wave',
      'review the docs',
    ])
  })

  it('quick-capture is intact: Enter adds the task and writes the store', async () => {
    await mountCard()
    const input = container.querySelector<HTMLInputElement>('.todo-input')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'one more thing')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    const rows = [...container.querySelectorAll('.todo-text')].map((n) => n.textContent)
    expect(rows).toContain('one more thing')
    // the write-through fires (the debounce runs on real timers here)
    await act(async () => {
      for (let i = 0; i < 8; i++) await Promise.resolve()
    })
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(TODO_SAVE).toHaveBeenCalled()
    const saved = TODO_SAVE.mock.calls.at(-1)?.[0] as Array<{ text: string }>
    expect(saved?.[0]?.text).toBe('one more thing')
  })

  it('the first mount takes the default perch (right edge, below the strip)', async () => {
    await mountCard()
    const style = card().style
    expect(Number.parseFloat(style.left)).toBe(1200 - 264 - 16)
    expect(Number.parseFloat(style.top)).toBeGreaterThan(0)
  })

  it('the drag handle moves the card and persists the placement', async () => {
    await mountCard()
    const dispatch = (type: string, x: number, y: number): void => {
      head().dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          button: 0,
          buttons: 1,
        }),
      )
    }
    await act(async () => dispatch('pointerdown', 900, 64))
    await act(async () => dispatch('pointermove', 400, 300))
    // write-only during the drag: the inline position follows the pointer
    // (the perch 920/64 + the pointer delta 400-900 / 300-64)
    expect(card().style.left).toBe('420px')
    expect(card().style.top).toBe('300px')
    await act(async () => dispatch('pointerup', 400, 300))
    // the release commits to the store (the rail's local-prefs pattern)
    expect(localStorage.getItem('home.todo-card')).toBeTruthy()
    const stored = JSON.parse(localStorage.getItem('home.todo-card')!) as {
      left: number
      top: number
    }
    expect(stored).toEqual({ left: 420, top: 300 })
    // and the card keeps the numbers through a fresh mount
    await act(async () => root.unmount())
    container.remove()
    container = document.createElement('div')
    parent.append(container)
    root = createRoot(container)
    await mountCard()
    expect(card().style.left).toBe('420px')
    expect(card().style.top).toBe('300px')
  })

  it('the drag clamps inside the stage and ignores a stale press', async () => {
    await mountCard()
    const dispatch = (type: string, x: number, y: number, buttons = 1): void => {
      head().dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          button: 0,
          buttons,
        }),
      )
    }
    await act(async () => dispatch('pointerdown', 900, 64))
    // far past the right/bottom edges: the clamp holds the card inside
    await act(async () => dispatch('pointermove', 3000, 3000))
    expect(Number.parseFloat(card().style.left)).toBe(1200 - 264)
    expect(Number.parseFloat(card().style.top)).toBe(800 - 80)
    await act(async () => dispatch('pointerup', 3000, 3000))
    // a stale press (buttons read 0) never starts a drag
    await act(async () => dispatch('pointerdown', 900, 64))
    await act(async () => dispatch('pointermove', 500, 400, 0))
    expect(card().style.left).not.toBe('200px')
    expect(localStorage.getItem('home.todo-card')).toBeTruthy()
  })
})

describe('the card re-clamps when the stage resizes', () => {
  it('a stage that shrinks pulls an off-stage placement back inside', async () => {
    // persist a placement near the right edge of a 1200px stage
    localStorage.setItem('home.todo-card', JSON.stringify({ left: 900, top: 400 }))
    await mountCard()
    expect(card().style.left).toBe('900px')
    // the stage shrinks (a window resize): the placement re-clamps
    Object.defineProperty(container, 'clientWidth', { value: 600, configurable: true })
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
      await Promise.resolve()
    })
    expect(Number.parseFloat(card().style.left)).toBe(600 - 264)
  })
})
