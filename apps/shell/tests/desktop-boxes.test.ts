// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopGroupBox as DesktopGroupBoxModel } from '../src/shared/home-api'
import {
  BOX_COLLAPSED_HEIGHT,
  BOX_DEFAULT_HEIGHT,
  BOX_DEFAULT_WIDTH,
  BOX_MIN_HEIGHT,
  BOX_MIN_WIDTH,
  assignItemsToBox,
  bringBoxToFront,
  clampBoxRect,
  computeBoxResize,
  createGroupBox,
  dissolveBox,
  findBoxAtPoint,
  partitionDesktopItems,
  removeItemsFromBoxes,
} from '../src/renderer/src/desktop-boxes'
import type { DesktopItem } from '../src/renderer/src/desktop-items'
import { DesktopGroupBox } from '../src/renderer/src/DesktopGroupBox'
import { DESKTOP_STRINGS } from '../src/renderer/src/desktop-strings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function item(id: string, kind: DesktopItem['kind'] = 'app'): DesktopItem {
  return {
    id,
    kind,
    title: id,
    open: () => undefined,
  }
}

describe('desktop-boxes pure helpers', () => {
  it('creates normalized group boxes with deduped items and cascading defaults', () => {
    const b1 = createGroupBox([], {
      title: '  Work Docs  ',
      itemIds: ['app:docs', 'app:docs', 'app:sheets'],
      stageWidth: 1200,
      stageHeight: 800,
    })
    expect(b1.title).toBe('Work Docs')
    expect(b1.width).toBe(BOX_DEFAULT_WIDTH)
    expect(b1.height).toBe(BOX_DEFAULT_HEIGHT)
    expect(b1.color).toBe('glass')
    expect(b1.collapsed).toBe(false)
    expect(b1.itemIds).toEqual(['app:docs', 'app:sheets'])

    const b2 = createGroupBox([b1], {
      title: '   ',
      x: 1180,
      y: 780,
      stageWidth: 1200,
      stageHeight: 800,
    })
    expect(b2.id).not.toBe(b1.id)
    expect(b2.color).toBe('blue')
    // Clamped within stage margins
    expect(b2.x + b2.width).toBeLessThanOrEqual(1188)
    expect(b2.y + b2.height).toBeLessThanOrEqual(788)
  })

  it('clamps rects to viewport bounds including collapsed height', () => {
    const shrunk = clampBoxRect(
      { x: 950, y: 740, width: 400, height: 300 },
      { width: 1000, height: 500 },
      true,
    )
    expect(shrunk.x + shrunk.width).toBeLessThanOrEqual(988)
    expect(shrunk.y + BOX_COLLAPSED_HEIGHT).toBeLessThanOrEqual(488)

    const minClamped = clampBoxRect(
      { x: -20, y: -10, width: 50, height: 40 },
      { width: 1000, height: 800 },
    )
    expect(minClamped).toEqual({
      x: 12,
      y: 12,
      width: BOX_MIN_WIDTH,
      height: BOX_MIN_HEIGHT,
    })
  })

  it('computes edge resizes while preserving minimum bounds and anchored edges', () => {
    const start = { x: 200, y: 150, width: 320, height: 240 }
    const stage = { width: 1200, height: 800 }

    expect(computeBoxResize(start, 'se', 80, 60, stage)).toEqual({
      x: 200,
      y: 150,
      width: 400,
      height: 300,
    })

    // Dragging west past minimum clamps width and keeps right edge at 200 + 320 = 520
    const nw = computeBoxResize(start, 'nw', 250, 200, stage)
    expect(nw.width).toBe(BOX_MIN_WIDTH)
    expect(nw.height).toBe(BOX_MIN_HEIGHT)
    expect(nw.x).toBe(520 - BOX_MIN_WIDTH)
    expect(nw.y).toBe(390 - BOX_MIN_HEIGHT)
  })

  it('enforces single-box ownership when assigning or removing items', () => {
    const a: DesktopGroupBoxModel = {
      id: 'box:a',
      title: 'A',
      x: 40,
      y: 40,
      width: 300,
      height: 240,
      collapsed: false,
      color: 'blue',
      itemIds: ['app:docs', 'app:sheets'],
    }
    const b: DesktopGroupBoxModel = {
      id: 'box:b',
      title: 'B',
      x: 400,
      y: 40,
      width: 300,
      height: 240,
      collapsed: true,
      color: 'rose',
      itemIds: ['app:pdf'],
    }

    const moved = assignItemsToBox([a, b], 'box:b', ['app:docs'])
    expect(moved[0]?.itemIds).toEqual(['app:sheets'])
    expect(moved[1]?.itemIds).toEqual(['app:pdf', 'app:docs'])

    const removed = removeItemsFromBoxes(moved, ['app:docs'])
    expect(removed[1]?.itemIds).toEqual(['app:pdf'])

    expect(bringBoxToFront(moved, 'box:a').map((x) => x.id)).toEqual(['box:b', 'box:a'])
    expect(dissolveBox(moved, 'box:a').map((x) => x.id)).toEqual(['box:b'])

    // Collapsed box only hits its 40px header band
    expect(findBoxAtPoint([a, b], 450, 60)?.id).toBe('box:b')
    expect(findBoxAtPoint([a, b], 450, 120)).toBeNull()
  })

  it('partitions desktop items cleanly and excludes pinned widgets from boxes', () => {
    const items: DesktopItem[] = [
      item('app:docs'),
      item('app:sheets'),
      item('widget:clock', 'widget'),
      item('app:pdf'),
    ]
    const boxes: DesktopGroupBoxModel[] = [
      {
        id: 'box:1',
        title: 'B1',
        x: 20,
        y: 20,
        width: 300,
        height: 220,
        collapsed: false,
        color: 'glass',
        itemIds: ['app:docs', 'widget:clock', 'missing:item'],
      },
      {
        id: 'box:2',
        title: 'B2',
        x: 340,
        y: 20,
        width: 300,
        height: 220,
        collapsed: false,
        color: 'emerald',
        // Duplicate claim across boxes goes to the first box only
        itemIds: ['app:docs', 'app:sheets'],
      },
    ]

    const { looseItems, boxItems, ownerByItemId } = partitionDesktopItems(items, boxes)
    expect(boxItems.get('box:1')?.map((i) => i.id)).toEqual(['app:docs'])
    expect(boxItems.get('box:2')?.map((i) => i.id)).toEqual(['app:sheets'])
    expect(ownerByItemId.get('app:docs')).toBe('box:1')
    expect(looseItems.map((i) => i.id)).toEqual(['widget:clock', 'app:pdf'])
  })
})

describe('DesktopGroupBox component', () => {
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

  function baseBox(over: Partial<DesktopGroupBoxModel> = {}): DesktopGroupBoxModel {
    return {
      id: 'box:1',
      title: 'Projects',
      x: 80,
      y: 60,
      width: 320,
      height: 240,
      collapsed: false,
      color: 'blue',
      itemIds: ['app:docs'],
      ...over,
    }
  }

  function renderBox(
    box: DesktopGroupBoxModel,
    over: Partial<Parameters<typeof DesktopGroupBox>[0]> = {},
  ): {
    onToggleCollapse: ReturnType<typeof vi.fn>
    onToggleLock: ReturnType<typeof vi.fn>
    onRenameCommit: ReturnType<typeof vi.fn>
    onRenameCancel: ReturnType<typeof vi.fn>
    onRenameStart: ReturnType<typeof vi.fn>
  } {
    const callbacks = {
      onToggleCollapse: vi.fn(),
      onToggleLock: vi.fn(),
      onRenameCommit: vi.fn(),
      onRenameCancel: vi.fn(),
      onRenameStart: vi.fn(),
    }
    act(() => {
      root.render(
        createElement(DesktopGroupBox, {
          box,
          items: [item('app:docs')],
          iconScale: 1,
          strings: DESKTOP_STRINGS.en,
          selectedIds: new Set<string>(),
          draggingId: null,
          isDropTarget: false,
          editingTitle: false,
          stageBounds: { width: 1200, height: 800 },
          renderTile: (it) => createElement('div', { className: 'tile' }, it.title),
          onBringToFront: vi.fn(),
          onMoveCommit: vi.fn(),
          onResizeCommit: vi.fn(),
          onToggleCollapse: callbacks.onToggleCollapse,
          onToggleLock: callbacks.onToggleLock,
          onRenameStart: callbacks.onRenameStart,
          onRenameCommit: callbacks.onRenameCommit,
          onRenameCancel: callbacks.onRenameCancel,
          onBoxContextMenu: vi.fn(),
          onIconPointerDown: vi.fn(),
          onIconDoubleClick: vi.fn(),
          onIconContextMenu: vi.fn(),
          onExternalDrop: vi.fn(),
          ...over,
        }),
      )
    })
    return callbacks
  }

  it('toggles collapse on header double click and hides body & resize handles when collapsed', () => {
    const { onToggleCollapse } = renderBox(baseBox())
    const header = host.querySelector<HTMLElement>('.desktop-box-header')!
    act(() => {
      header.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(onToggleCollapse).toHaveBeenCalledWith('box:1')

    renderBox(baseBox({ collapsed: true }))
    const section = host.querySelector<HTMLElement>('[data-testid="desktop-box-box:1"]')!
    expect(section.classList.contains('is-collapsed')).toBe(true)
    expect(host.querySelector('.desktop-box-body')).toBeNull()
    expect(host.querySelectorAll('.desktop-box-resize')).toHaveLength(0)
  })

  it('supports inline title rename via Enter submit and Escape cancel', () => {
    const { onRenameStart } = renderBox(baseBox())
    const titleSpan = host.querySelector<HTMLElement>('.desktop-box-title')!
    act(() => {
      titleSpan.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(onRenameStart).toHaveBeenCalledWith('box:1')

    const { onRenameCommit, onRenameCancel } = renderBox(baseBox(), { editingTitle: true })
    const input = host.querySelector<HTMLInputElement>('.desktop-box-title-input')!
    expect(input).toBeTruthy()
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'Renamed Folder')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onRenameCommit).toHaveBeenCalledWith('box:1', 'Renamed Folder')

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onRenameCancel).toHaveBeenCalledTimes(1)
  })

  it('hides resize handles and toggles lock button when locked', () => {
    const { onToggleLock } = renderBox(baseBox({ locked: true }))
    const section = host.querySelector<HTMLElement>('[data-testid="desktop-box-box:1"]')!
    expect(section.classList.contains('is-locked')).toBe(true)
    expect(host.querySelectorAll('.desktop-box-resize')).toHaveLength(0)

    const lockBtn = host.querySelector<HTMLButtonElement>(
      `button[aria-label="${DESKTOP_STRINGS.en.boxUnlock}"]`,
    )!
    act(() => {
      lockBtn.click()
    })
    expect(onToggleLock).toHaveBeenCalledWith('box:1')
  })
})
