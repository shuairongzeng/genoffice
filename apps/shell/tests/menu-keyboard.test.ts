/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { handleMenuKeyDown } from '../src/renderer/src/menu-keyboard'

/**
 * The menu keyboard model against a hand-built DOM tree shaped like the
 * desktop's context menus: a root menu of [role=menuitem] buttons where some
 * rows own a nested submenu. The DOM is conditional-rendered in the real
 * component, so "the items in document order" here is exactly what the
 * handler sees in the app; the component-level behavior (focus-on-open, the
 * state callbacks' effects) is pinned by desktop-view.test.ts.
 */

/** the menu skeleton: rows with optional submenus, plus plain items */
function buildMenu(): HTMLElement {
  const root = document.createElement('div')
  root.setAttribute('role', 'menu')
  root.innerHTML = `
    <div class="desktop-menu-row">
      <button role="menuitem" data-submenu="new" aria-haspopup="menu">New</button>
      <div class="desktop-submenu" role="menu">
        <button role="menuitem">Docs</button>
        <button role="menuitem">Sheets</button>
      </div>
    </div>
    <div class="desktop-menu-row">
      <button role="menuitem" data-submenu="sort" aria-haspopup="menu">Sort by</button>
    </div>
    <button role="menuitem">Refresh</button>
    <button role="menuitem">Properties</button>
  `
  document.body.append(root)
  return root
}

/** dispatch a real keydown at the focused element (or the container) */
function key(container: HTMLElement, keyName: string, target?: HTMLElement): KeyboardEvent {
  const source =
    target ?? (document.activeElement instanceof HTMLElement ? document.activeElement : container)
  const event = new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true })
  source.dispatchEvent(event)
  return event
}

const noop = () => {}

/** find a menuitem by its label text */
function item(container: HTMLElement, label: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (b) => b.textContent === label,
  )
  if (!found) throw new Error(`no menuitem labeled ${label}`)
  return found
}

describe('handleMenuKeyDown — vertical walk', () => {
  it('ArrowDown/ArrowUp step through the items in DOM order, wrapping', () => {
    const container = buildMenu()
    const first = container.querySelectorAll('[role="menuitem"]')[0] as HTMLElement
    first.focus()
    // from New (skipping the unopened submenu's items — not rendered when
    // closed; here they are in the DOM, so the walk includes them only when
    // the caller renders them; this test's tree has them present and walks
    // them, matching the open state)
    expect(handleMenuKeyDown(key(container, 'ArrowDown'), container, opts(null))).toBe(true)
    expect(document.activeElement?.textContent).toBe('Docs')
    expect(handleMenuKeyDown(key(container, 'ArrowDown'), container, opts(null))).toBe(true)
    expect(document.activeElement?.textContent).toBe('Sheets')
    // wrap at the end
    for (let i = 0; i < 4; i++)
      handleMenuKeyDown(key(container, 'ArrowDown'), container, opts(null))
    expect(document.activeElement?.textContent).toBe('New')
    expect(handleMenuKeyDown(key(container, 'ArrowUp'), container, opts(null))).toBe(true)
    expect(document.activeElement?.textContent).toBe('Properties')
  })

  it('Home and End jump to the ends', () => {
    const container = buildMenu()
    ;(container.querySelectorAll('[role="menuitem"]')[2] as HTMLElement).focus()
    expect(handleMenuKeyDown(key(container, 'Home'), container, opts(null))).toBe(true)
    expect(document.activeElement?.textContent).toBe('New')
    expect(handleMenuKeyDown(key(container, 'End'), container, opts(null))).toBe(true)
    expect(document.activeElement?.textContent).toBe('Properties')
  })

  it('the walk never scrolls: consumed keys are default-prevented', () => {
    const container = buildMenu()
    const first = container.querySelectorAll('[role="menuitem"]')[0] as HTMLElement
    first.focus()
    const event = key(container, 'ArrowDown')
    handleMenuKeyDown(event, container, opts(null))
    expect(event.defaultPrevented).toBe(true)
  })

  function opts(openSub: string | null) {
    return {
      openSub,
      onOpenSubmenu: noop,
      onCloseSubmenu: noop,
      onDismiss: noop,
      dir: 'ltr' as const,
    }
  }
})

describe('handleMenuKeyDown — the inline-end / inline-start arrows', () => {
  it("ltr: ArrowRight opens the focused row's submenu, ArrowLeft closes the open one", () => {
    const container = buildMenu()
    const open = vi.fn()
    const close = vi.fn()
    item(container, 'Sort by').focus()
    expect(
      handleMenuKeyDown(key(container, 'ArrowRight'), container, {
        openSub: null,
        onOpenSubmenu: open,
        onCloseSubmenu: close,
        onDismiss: noop,
        dir: 'ltr',
      }),
    ).toBe(true)
    expect(open).toHaveBeenCalledWith('sort')

    // inline-start with a submenu open: close, and focus is back on the trigger
    item(container, 'Docs').focus()
    expect(
      handleMenuKeyDown(key(container, 'ArrowLeft'), container, {
        openSub: 'new',
        onOpenSubmenu: open,
        onCloseSubmenu: close,
        onDismiss: noop,
        dir: 'ltr',
      }),
    ).toBe(true)
    expect(close).toHaveBeenCalled()
    expect(document.activeElement?.textContent).toBe('New')
  })

  it('rtl: the arrows trade roles — ArrowLeft opens, ArrowRight closes', () => {
    const container = buildMenu()
    const open = vi.fn()
    const close = vi.fn()
    item(container, 'Sort by').focus()
    expect(
      handleMenuKeyDown(key(container, 'ArrowLeft'), container, {
        openSub: null,
        onOpenSubmenu: open,
        onCloseSubmenu: close,
        onDismiss: noop,
        dir: 'rtl',
      }),
    ).toBe(true)
    expect(open).toHaveBeenCalledWith('sort')

    item(container, 'Sheets').focus()
    expect(
      handleMenuKeyDown(key(container, 'ArrowRight'), container, {
        openSub: 'new',
        onOpenSubmenu: open,
        onCloseSubmenu: close,
        onDismiss: noop,
        dir: 'rtl',
      }),
    ).toBe(true)
    expect(close).toHaveBeenCalled()
    expect(document.activeElement?.textContent).toBe('New')
  })

  it('inline-end inside the open submenu is swallowed, not forwarded', () => {
    const container = buildMenu()
    const open = vi.fn()
    item(container, 'Docs').focus()
    const event = key(container, 'ArrowRight')
    expect(
      handleMenuKeyDown(event, container, {
        openSub: 'new',
        onOpenSubmenu: open,
        onCloseSubmenu: noop,
        onDismiss: noop,
        dir: 'ltr',
      }),
    ).toBe(true)
    expect(open).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it('inline-end on a row without a submenu is consumed, never forwarded', () => {
    const container = buildMenu()
    const open = vi.fn()
    // the plain rows — every row of the icon menu routes inline-end here
    item(container, 'Refresh').focus()
    const event = key(container, 'ArrowRight')
    expect(
      handleMenuKeyDown(event, container, {
        openSub: null,
        onOpenSubmenu: open,
        onCloseSubmenu: noop,
        onDismiss: noop,
        dir: 'ltr',
      }),
    ).toBe(true)
    expect(open).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it('inline-end on the trigger of the submenu that is already open steps into it', () => {
    // reachable by wrapping the vertical walk back onto the trigger while
    // the flyout stays open; the same-value open callback would be a silent
    // no-op, so the model must focus the flyout's first item itself
    const container = buildMenu()
    const open = vi.fn()
    item(container, 'New').focus()
    const event = key(container, 'ArrowRight')
    expect(
      handleMenuKeyDown(event, container, {
        openSub: 'new',
        onOpenSubmenu: open,
        onCloseSubmenu: noop,
        onDismiss: noop,
        dir: 'ltr',
      }),
    ).toBe(true)
    expect(open).not.toHaveBeenCalled()
    expect(document.activeElement?.textContent).toBe('Docs')
    expect(event.defaultPrevented).toBe(true)
  })

  it('inline-start with nothing open is swallowed: the grid behind stays still', () => {
    const container = buildMenu()
    const close = vi.fn()
    ;(container.querySelectorAll('[role="menuitem"]')[0] as HTMLElement).focus()
    expect(
      handleMenuKeyDown(key(container, 'ArrowLeft'), container, {
        openSub: null,
        onOpenSubmenu: noop,
        onCloseSubmenu: close,
        onDismiss: noop,
        dir: 'ltr',
      }),
    ).toBe(true)
    expect(close).not.toHaveBeenCalled()
  })
})

describe('handleMenuKeyDown — Escape tiers', () => {
  it('closes the submenu when one is open, keeping the menu itself', () => {
    const container = buildMenu()
    const close = vi.fn()
    item(container, 'Docs').focus()
    const event = key(container, 'Escape')
    expect(
      handleMenuKeyDown(event, container, {
        openSub: 'new',
        onOpenSubmenu: noop,
        onCloseSubmenu: close,
        onDismiss: noop,
        dir: 'ltr',
      }),
    ).toBe(true)
    expect(close).toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
    // and focus went back to the trigger
    expect(document.activeElement?.textContent).toBe('New')
  })

  it("with no submenu open, Escape is the window listener's to handle", () => {
    const container = buildMenu()
    ;(container.querySelectorAll('[role="menuitem"]')[0] as HTMLElement).focus()
    expect(
      handleMenuKeyDown(key(container, 'Escape'), container, {
        openSub: null,
        onOpenSubmenu: noop,
        onCloseSubmenu: noop,
        onDismiss: noop,
        dir: 'ltr',
      }),
    ).toBe(false)
  })
})

describe('handleMenuKeyDown — Tab dismisses', () => {
  it('Tab closes the whole menu through onDismiss and keeps its default action', () => {
    const container = buildMenu()
    const dismiss = vi.fn()
    ;(container.querySelectorAll('[role="menuitem"]')[0] as HTMLElement).focus()
    const event = key(container, 'Tab')
    expect(
      handleMenuKeyDown(event, container, {
        openSub: null,
        onOpenSubmenu: noop,
        onCloseSubmenu: noop,
        onDismiss: dismiss,
        dir: 'ltr',
      }),
    ).toBe(true)
    expect(dismiss).toHaveBeenCalledTimes(1)
    // not default-prevented: the browser's focus move is the point
    expect(event.defaultPrevented).toBe(false)
  })
})

describe('handleMenuKeyDown — keys it does not own', () => {
  it('letters, Enter and PageDown pass through untouched', () => {
    const container = buildMenu()
    ;(container.querySelectorAll('[role="menuitem"]')[0] as HTMLElement).focus()
    for (const keyName of ['a', 'Enter', 'PageDown']) {
      expect(
        handleMenuKeyDown(key(container, keyName), container, {
          openSub: null,
          onOpenSubmenu: noop,
          onCloseSubmenu: noop,
          onDismiss: noop,
          dir: 'ltr',
        }),
      ).toBe(false)
    }
  })
})
