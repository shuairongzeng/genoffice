// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopWindow, type DesktopWindowProps } from '../src/renderer/src/DesktopWindow'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('DesktopWindow — auto-hide header when maximized', () => {
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
    vi.useRealTimers()
  })

  function renderWindow(over: Partial<DesktopWindowProps> = {}): void {
    act(() => {
      root.render(
        createElement(DesktopWindow, {
          title: 'Player',
          mode: 'maximized',
          snap: 'none',
          rect: { x: 100, y: 80, width: 640, height: 480 },
          stage: { width: 1200, height: 800, topInset: 8 },
          focused: true,
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
          children: createElement('div', { 'data-testid': 'content' }, 'Body'),
          ...over,
        }),
      )
    })
  }

  it('hides the title bar by default in maximized mode and reveals it from top hotedge', async () => {
    vi.useFakeTimers()
    renderWindow({ mode: 'normal' })
    const normalEl = host.querySelector<HTMLElement>('[data-testid="desktop-window"]')!
    expect(normalEl.classList.contains('is-autohide-header')).toBe(false)
    expect(host.querySelector('[data-testid="desktop-window-top-hotedge"]')).toBeNull()

    renderWindow({ mode: 'maximized' })
    const winEl = host.querySelector<HTMLElement>('[data-testid="desktop-window"]')!
    expect(winEl.classList.contains('is-maximized')).toBe(true)
    expect(winEl.classList.contains('is-autohide-header')).toBe(true)
    expect(winEl.classList.contains('is-header-revealed')).toBe(false)

    const hotedge = host.querySelector<HTMLElement>('[data-testid="desktop-window-top-hotedge"]')!
    expect(hotedge).toBeTruthy()
    const header = host.querySelector<HTMLElement>('.desktop-window-titlebar')!

    // Enter top hotedge -> reveals header (React 19 maps onPointerEnter via pointerover)
    act(() => {
      hotedge.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
    })
    expect(winEl.classList.contains('is-header-revealed')).toBe(true)

    // Leave header -> stays visible during 280ms grace, hides after timer
    act(() => {
      header.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: host }))
    })
    expect(winEl.classList.contains('is-header-revealed')).toBe(true)

    act(() => {
      vi.advanceTimersByTime(290)
    })
    expect(winEl.classList.contains('is-header-revealed')).toBe(false)
  })

  it('keeps header pinned on focus inside controls and honors autoHideHeaderOnMaximize=false', () => {
    vi.useFakeTimers()
    renderWindow({ mode: 'maximized', autoHideHeaderOnMaximize: true })
    const winEl = host.querySelector<HTMLElement>('[data-testid="desktop-window"]')!
    const closeBtn = host.querySelector<HTMLButtonElement>('[data-testid="desktop-window-close"]')!
    const header = host.querySelector<HTMLElement>('.desktop-window-titlebar')!

    act(() => {
      closeBtn.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })
    expect(winEl.classList.contains('is-header-revealed')).toBe(true)

    // Blur to element outside header schedules auto-hide
    act(() => {
      header.dispatchEvent(
        new FocusEvent('focusout', { bubbles: true, relatedTarget: host }),
      )
      vi.advanceTimersByTime(300)
    })
    expect(winEl.classList.contains('is-header-revealed')).toBe(false)

    // Disabling the preference keeps title bar visible when maximized
    renderWindow({ mode: 'maximized', autoHideHeaderOnMaximize: false })
    expect(winEl.classList.contains('is-autohide-header')).toBe(false)
    expect(host.querySelector('[data-testid="desktop-window-top-hotedge"]')).toBeNull()
  })
})
