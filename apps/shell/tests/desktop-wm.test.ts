// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopWindow, type DesktopWindowProps } from '../src/renderer/src/DesktopWindow'
import {
  INITIAL_DESKTOP_WM_STATE,
  WINDOW_CASCADE_OFFSET_PX,
  desktopWmReducer,
  hasFocusedVisibleWindow,
  zIndexOfWindow,
  type DesktopWmAction,
  type DesktopWmState,
} from '../src/renderer/src/desktop-wm'
import {
  STAGE_SIDE_INSET,
  STAGE_TOP_INSET,
  defaultWindowRect,
  type StageBounds,
} from '../src/renderer/src/desktop-window-geometry'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const STAGE: StageBounds = { width: 1280, height: 800 }

function dispatchAll(
  initial: DesktopWmState,
  actions: readonly DesktopWmAction[],
): DesktopWmState {
  return actions.reduce((state, action) => desktopWmReducer(state, action), initial)
}

describe('desktop-wm state machine', () => {
  it('starts with empty initial state and safe helper defaults', () => {
    expect(WINDOW_CASCADE_OFFSET_PX).toBe(28)
    expect(INITIAL_DESKTOP_WM_STATE).toEqual({
      windows: {},
      order: [],
      activeId: null,
    })
    expect(hasFocusedVisibleWindow(INITIAL_DESKTOP_WM_STATE)).toBe(false)
    expect(zIndexOfWindow(INITIAL_DESKTOP_WM_STATE, 'non-existent')).toBe(1)
  })

  it('opens multiple windows with unique IDs, cascade offsets, and dynamic z-index order', () => {
    let state = desktopWmReducer(INITIAL_DESKTOP_WM_STATE, {
      type: 'open',
      spec: {
        kind: 'folder',
        title: 'Docs',
        stage: STAGE,
        preferredSize: { width: 720, height: 480 },
      },
    })
    expect(state.order).toEqual(['folder-1'])
    expect(state.activeId).toBe('folder-1')
    expect(zIndexOfWindow(state, 'folder-1')).toBe(1)
    expect(hasFocusedVisibleWindow(state)).toBe(true)

    const baseRect = defaultWindowRect(STAGE, { width: 720, height: 480 })
    expect(state.windows['folder-1']?.rect).toEqual(baseRect)

    state = desktopWmReducer(state, {
      type: 'open',
      spec: {
        kind: 'folder',
        title: 'Downloads',
        stage: STAGE,
        preferredSize: { width: 720, height: 480 },
      },
    })
    expect(state.order).toEqual(['folder-1', 'folder-2'])
    expect(state.activeId).toBe('folder-2')
    expect(zIndexOfWindow(state, 'folder-1')).toBe(1)
    expect(zIndexOfWindow(state, 'folder-2')).toBe(2)
    expect(state.windows['folder-2']?.rect).toEqual({
      x: baseRect.x + WINDOW_CASCADE_OFFSET_PX,
      y: baseRect.y + WINDOW_CASCADE_OFFSET_PX,
      width: baseRect.width,
      height: baseRect.height,
    })

    // Closing folder-1 and opening a third folder produces folder-3 without colliding
    state = desktopWmReducer(state, { type: 'close', id: 'folder-1' })
    state = desktopWmReducer(state, {
      type: 'open',
      spec: { kind: 'folder', title: 'Pictures', stage: STAGE },
    })
    expect(state.order).toEqual(['folder-2', 'folder-3'])
    expect(state.activeId).toBe('folder-3')
  })

  it('uses explicit spec.id if free and falls back safely if already occupied', () => {
    let state = desktopWmReducer(INITIAL_DESKTOP_WM_STATE, {
      type: 'open',
      spec: { id: 'preview-main', kind: 'preview', title: 'First', stage: STAGE },
    })
    expect(state.order).toEqual(['preview-main'])

    state = desktopWmReducer(state, {
      type: 'open',
      spec: { id: 'preview-main', kind: 'preview', title: 'Second', stage: STAGE },
    })
    expect(state.order).toEqual(['preview-main', 'preview-1'])
    expect(state.windows['preview-main']?.title).toBe('First')
    expect(state.windows['preview-1']?.title).toBe('Second')
  })

  it('skips overlapping cascade spots, ignores maximized/minimized anchors, and clamps bounds', () => {
    // Anchor w1 at (220, 100) and another window w2 already sitting at (+28, +28)
    let state = dispatchAll(INITIAL_DESKTOP_WM_STATE, [
      {
        type: 'open',
        spec: {
          id: 'w1',
          kind: 'folder',
          title: 'W1',
          stage: STAGE,
          initialRect: { x: 220, y: 100, width: 640, height: 420 },
        },
      },
      {
        type: 'open',
        spec: {
          id: 'w2',
          kind: 'folder',
          title: 'W2',
          stage: STAGE,
          initialRect: {
            x: 220 + WINDOW_CASCADE_OFFSET_PX,
            y: 100 + WINDOW_CASCADE_OFFSET_PX,
            width: 640,
            height: 420,
          },
        },
      },
      { type: 'focus', id: 'w1' },
    ])

    // Opening w3 from anchor w1 would hit w2 at (+28,+28), so it cascades another (+28,+28)
    state = desktopWmReducer(state, {
      type: 'open',
      spec: {
        id: 'w3',
        kind: 'folder',
        title: 'W3',
        stage: STAGE,
        preferredSize: { width: 640, height: 420 },
      },
    })
    expect(state.windows['w3']?.rect).toEqual({
      x: 220 + WINDOW_CASCADE_OFFSET_PX * 2,
      y: 100 + WINDOW_CASCADE_OFFSET_PX * 2,
      width: 640,
      height: 420,
    })

    // Maximized/minimized top windows are ignored as cascade anchors -> falls back to defaultWindowRect
    state = dispatchAll(INITIAL_DESKTOP_WM_STATE, [
      {
        type: 'open',
        spec: {
          id: 'max-win',
          kind: 'computer',
          title: 'Max',
          stage: STAGE,
          initialRect: { x: 400, y: 200, width: 700, height: 460 },
        },
      },
      { type: 'set-mode', id: 'max-win', mode: 'maximized' },
      {
        type: 'open',
        spec: {
          id: 'fresh',
          kind: 'kb',
          title: 'KB',
          stage: STAGE,
          preferredSize: { width: 700, height: 460 },
        },
      },
    ])
    expect(state.windows['fresh']?.rect).toEqual(
      defaultWindowRect(STAGE, { width: 700, height: 460 }),
    )

    // initialRect is clamped inside safe stage bounds & respects minSize
    const clampedState = desktopWmReducer(INITIAL_DESKTOP_WM_STATE, {
      type: 'open',
      spec: {
        id: 'edge',
        kind: 'preview',
        title: 'Clamped',
        stage: STAGE,
        initialRect: { x: -900, y: -40, width: 200, height: 150 },
        minSize: { width: 500, height: 360 },
      },
    })
    const clampedRect = clampedState.windows['edge']!.rect
    expect(clampedRect.width).toBe(500)
    expect(clampedRect.height).toBe(360)
    expect(clampedRect.y).toBe(STAGE_TOP_INSET)
    expect(clampedRect.x + clampedRect.width).toBeGreaterThanOrEqual(STAGE_SIDE_INSET + 140)
  })

  it('reuses singleton and reuseKey windows, merges payload, updates title, and unminimizes', () => {
    let state = dispatchAll(INITIAL_DESKTOP_WM_STATE, [
      {
        type: 'open',
        spec: {
          kind: 'player',
          title: 'Player',
          stage: STAGE,
          singleton: true,
          payload: { track: 'a.mp3', volume: 0.8 },
        },
      },
      {
        type: 'open',
        spec: {
          kind: 'preview',
          title: 'Report.pdf',
          stage: STAGE,
          reuseKey: 'preview:/docs/report.pdf',
          payload: { path: '/docs/report.pdf', page: 1 },
        },
      },
      { type: 'set-mode', id: 'player-1', mode: 'minimized' },
    ])

    expect(state.activeId).toBe('preview-1')
    expect(state.windows['player-1']?.mode).toBe('minimized')

    // Re-opening singleton player brings it to front, restores from minimized, and merges payload
    state = desktopWmReducer(state, {
      type: 'open',
      spec: {
        kind: 'player',
        title: 'Player — Track B',
        stage: STAGE,
        singleton: true,
        payload: { track: 'b.mp3' },
      },
    })
    expect(Object.keys(state.windows)).toEqual(['player-1', 'preview-1'])
    expect(state.order).toEqual(['preview-1', 'player-1'])
    expect(state.activeId).toBe('player-1')
    expect(state.windows['player-1']?.mode).toBe('normal')
    expect(state.windows['player-1']?.title).toBe('Player — Track B')
    expect(state.windows['player-1']?.payload).toEqual({ track: 'b.mp3', volume: 0.8 })

    // Re-opening via matching reuseKey reuses preview-1; new reuseKey opens a separate window
    state = desktopWmReducer(state, {
      type: 'open',
      spec: {
        kind: 'preview',
        title: 'Report.pdf (p.4)',
        stage: STAGE,
        reuseKey: 'preview:/docs/report.pdf',
        payload: { page: 4 },
      },
    })
    expect(state.order).toEqual(['player-1', 'preview-1'])
    expect(state.activeId).toBe('preview-1')
    expect(state.windows['preview-1']?.payload).toEqual({
      path: '/docs/report.pdf',
      page: 4,
    })

    state = desktopWmReducer(state, {
      type: 'open',
      spec: {
        kind: 'preview',
        title: 'Budget.xlsx',
        stage: STAGE,
        reuseKey: 'preview:/docs/budget.xlsx',
      },
    })
    expect(state.order).toEqual(['player-1', 'preview-1', 'preview-2'])
    expect(state.activeId).toBe('preview-2')
  })

  it('handles focus, blur-all, and close handoff across visible and minimized windows', () => {
    let state = dispatchAll(INITIAL_DESKTOP_WM_STATE, [
      { type: 'open', spec: { id: 'a', kind: 'computer', title: 'A', stage: STAGE } },
      { type: 'open', spec: { id: 'b', kind: 'kb', title: 'B', stage: STAGE } },
      { type: 'open', spec: { id: 'c', kind: 'sessions', title: 'C', stage: STAGE } },
    ])

    // Focus bottom window 'a' brings it to top of stacking order
    state = desktopWmReducer(state, { type: 'focus', id: 'a' })
    expect(state.order).toEqual(['b', 'c', 'a'])
    expect(state.activeId).toBe('a')
    expect(zIndexOfWindow(state, 'b')).toBe(1)
    expect(zIndexOfWindow(state, 'c')).toBe(2)
    expect(zIndexOfWindow(state, 'a')).toBe(3)

    // Focusing an unknown ID is a no-op
    expect(desktopWmReducer(state, { type: 'focus', id: 'ghost' })).toBe(state)

    // blur-all clears activeId while preserving windows and z-index order
    const blurred = desktopWmReducer(state, { type: 'blur-all' })
    expect(blurred.activeId).toBeNull()
    expect(blurred.order).toEqual(['b', 'c', 'a'])
    expect(hasFocusedVisibleWindow(blurred)).toBe(false)
    expect(zIndexOfWindow(blurred, 'a')).toBe(3)

    // Closing a background window while blurred preserves activeId === null
    const closedWhileBlurred = desktopWmReducer(blurred, { type: 'close', id: 'b' })
    expect(closedWhileBlurred.activeId).toBeNull()
    expect(closedWhileBlurred.order).toEqual(['c', 'a'])

    // Minimize 'c', then close active 'a' -> handoff skips minimized 'c' to visible 'b'
    state = desktopWmReducer(state, { type: 'set-mode', id: 'c', mode: 'minimized' })
    expect(state.order).toEqual(['b', 'c', 'a'])
    state = desktopWmReducer(state, { type: 'focus', id: 'a' })
    state = desktopWmReducer(state, { type: 'close', id: 'a' })
    expect(state.order).toEqual(['b', 'c'])
    expect(state.activeId).toBe('b')

    // Focusing minimized 'c' unminimizes and raises it
    state = desktopWmReducer(state, { type: 'focus', id: 'c' })
    expect(state.windows['c']?.mode).toBe('normal')
    expect(state.order).toEqual(['b', 'c'])
    expect(state.activeId).toBe('c')
  })

  it('handles set-mode, set-rect, and update mutations cleanly', () => {
    let state = dispatchAll(INITIAL_DESKTOP_WM_STATE, [
      { type: 'open', spec: { id: 'w1', kind: 'player', title: 'P1', stage: STAGE } },
      { type: 'open', spec: { id: 'w2', kind: 'folder', title: 'F2', stage: STAGE } },
    ])

    // Minimizing active window w2 keeps order unchanged and passes activeId to w1
    state = desktopWmReducer(state, { type: 'set-mode', id: 'w2', mode: 'minimized', snap: 'left' })
    expect(state.order).toEqual(['w1', 'w2'])
    expect(state.activeId).toBe('w1')
    expect(state.windows['w2']?.mode).toBe('minimized')
    expect(state.windows['w2']?.snap).toBe('left')
    expect(hasFocusedVisibleWindow(state)).toBe(true)

    // Minimizing the last visible window w1 drops activeId to null
    state = desktopWmReducer(state, { type: 'set-mode', id: 'w1', mode: 'minimized' })
    expect(state.activeId).toBeNull()
    expect(hasFocusedVisibleWindow(state)).toBe(false)

    // Setting visible mode (mini / maximized / normal) raises window to front and activates it
    state = desktopWmReducer(state, { type: 'set-mode', id: 'w2', mode: 'mini', snap: 'none' })
    expect(state.order).toEqual(['w1', 'w2'])
    expect(state.activeId).toBe('w2')
    expect(state.windows['w2']?.mode).toBe('mini')

    // set-rect updates rect and snap
    const nextRect = { x: 180, y: 90, width: 760, height: 500 }
    state = desktopWmReducer(state, { type: 'set-rect', id: 'w1', rect: nextRect, snap: 'right' })
    expect(state.windows['w1']?.rect).toEqual(nextRect)
    expect(state.windows['w1']?.snap).toBe('right')

    // update patches title and merges payload
    state = desktopWmReducer(state, {
      type: 'update',
      id: 'w1',
      title: 'Player Updated',
      payload: { muted: true },
    })
    state = desktopWmReducer(state, {
      type: 'update',
      id: 'w1',
      payload: { rate: 1.5 },
    })
    expect(state.windows['w1']?.title).toBe('Player Updated')
    expect(state.windows['w1']?.payload).toEqual({ muted: true, rate: 1.5 })
  })

  it('cycles forward and backward across windows and restores minimized targets', () => {
    expect(desktopWmReducer(INITIAL_DESKTOP_WM_STATE, { type: 'cycle' })).toBe(
      INITIAL_DESKTOP_WM_STATE,
    )

    let state = dispatchAll(INITIAL_DESKTOP_WM_STATE, [
      { type: 'open', spec: { id: 'w1', kind: 'computer', title: '1', stage: STAGE } },
      { type: 'open', spec: { id: 'w2', kind: 'preview', title: '2', stage: STAGE } },
      { type: 'open', spec: { id: 'w3', kind: 'kb', title: '3', stage: STAGE } },
      { type: 'set-mode', id: 'w1', mode: 'minimized' },
    ])
    // order: ['w1', 'w2', 'w3'], activeId: 'w3', w1 is minimized
    state = desktopWmReducer(state, { type: 'cycle' })
    expect(state.activeId).toBe('w1')
    expect(state.windows['w1']?.mode).toBe('normal')
    expect(state.order).toEqual(['w2', 'w3', 'w1'])

    state = desktopWmReducer(state, { type: 'cycle' })
    expect(state.activeId).toBe('w2')
    expect(state.order).toEqual(['w3', 'w1', 'w2'])

    // Reverse cycle picks the previous window in order (w1) and lifts it to top
    state = desktopWmReducer(state, { type: 'cycle', reverse: true })
    expect(state.activeId).toBe('w1')
    expect(state.order).toEqual(['w3', 'w2', 'w1'])

    // Cycle when all windows are blurred selects a valid window
    state = desktopWmReducer(state, { type: 'blur-all' })
    state = desktopWmReducer(state, { type: 'cycle' })
    expect(state.activeId).toBe('w1')
    expect(state.order[state.order.length - 1]).toBe('w1')
  })
})

describe('DesktopWindow — zIndex, focus attributes, and capture-phase activation', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  function renderWin(over: Partial<DesktopWindowProps> = {}): void {
    act(() => {
      root.render(
        createElement(DesktopWindow, {
          windowId: 'win-alpha',
          zIndex: 4,
          title: 'Alpha',
          mode: 'normal',
          snap: 'none',
          rect: { x: 100, y: 80, width: 640, height: 480 },
          stage: STAGE,
          focused: false,
          labels: {
            minimize: 'Minimize',
            maximize: 'Maximize',
            restore: 'Restore',
            close: 'Close',
          },
          onFocus: vi.fn(),
          onRectChange: vi.fn(),
          onModeChange: vi.fn(),
          onClose: vi.fn(),
          children: createElement(
            'div',
            null,
            createElement('button', {
              type: 'button',
              'data-testid': 'inner-btn',
              onPointerDown: (e: PointerEvent) => e.stopPropagation(),
            }),
          ),
          ...over,
        }),
      )
    })
  }

  it('exposes data-window-id, data-focused, and dynamic inline zIndex when visible', () => {
    renderWin({ focused: true, zIndex: 7, windowId: 'preview-2' })
    const el = host.querySelector<HTMLElement>('[data-testid="desktop-window"]')!
    expect(el.getAttribute('data-window-id')).toBe('preview-2')
    expect(el.getAttribute('data-focused')).toBe('true')
    expect(el.style.zIndex).toBe('7')

    renderWin({ focused: false, zIndex: 2, windowId: 'preview-2' })
    expect(el.getAttribute('data-focused')).toBe('false')
    expect(el.style.zIndex).toBe('2')

    renderWin({ mode: 'minimized', zIndex: 2, windowId: 'preview-2' })
    expect(el.style.zIndex).toBe('')
  })

  it('invokes onFocus in pointerdown capture phase even when inner elements stop propagation', () => {
    const onFocus = vi.fn()
    renderWin({ focused: false, onFocus })
    const innerBtn = host.querySelector<HTMLButtonElement>('[data-testid="inner-btn"]')!

    act(() => {
      innerBtn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    })
    expect(onFocus).toHaveBeenCalledTimes(1)

    const titlebar = host.querySelector<HTMLElement>('.desktop-window-titlebar')!
    act(() => {
      titlebar.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    })
    expect(onFocus).toHaveBeenCalledTimes(2)
  })
})
