/**
 * The keyboard model for the desktop's fixed-position context menus — the
 * APG menu pattern, one level of submenu:
 *
 * - ArrowDown / ArrowUp step through the visible menuitems in DOM order (an
 *   open submenu's items sit directly after its trigger), wrapping; Home and
 *   End jump to the ends.
 * - the inline-end arrow (ArrowRight in ltr, ArrowLeft in rtl) opens the
 *   focused row's submenu; the inline-start arrow closes the open submenu
 *   and returns focus to its trigger.
 * - Escape closes the open submenu itself; with no submenu open it is left
 *   to bubble, and the window listener the desktop already has closes the
 *   menu (the established tier: submenu → menu → selection).
 * - Tab (or Shift+Tab) dismisses the whole menu through onDismiss — the APG
 *   dismiss-on-Tab behavior — and is the one owned key that keeps its
 *   default action, because moving focus out of the menu is the point.
 *
 * The model is DOM-driven on purpose: the menus conditional-render their
 * submenus, so the container's [role=menuitem] buttons in document order are
 * exactly the visible items, and focus is the only moving state — the caller
 * keeps owning what "open" and "close" mean. Every arrow is consumed while
 * focus is inside the menu: the desktop's own window-level arrow handler
 * moves the icon-grid selection, and a key that leaked out of an open menu
 * would move the icons behind it.
 */
export interface MenuKeyboardOptions<T extends string> {
  /** the submenu currently open (its row's data-submenu value), or null */
  openSub: T | null
  /** opens the row's submenu; the caller focuses its first item after render */
  onOpenSubmenu: (sub: T) => void
  /** closes the open submenu; focus has already moved back to its trigger */
  onCloseSubmenu: () => void
  /** dismisses the whole menu — the Tab path; focus moves on by itself */
  onDismiss: () => void
  /** the reading direction the inline arrows follow */
  dir: 'ltr' | 'rtl'
}

/**
 * The keydown shape this model needs — structural, so React's synthetic
 * KeyboardEvent and a real DOM KeyboardEvent both fit.
 */
export interface MenuKeyboardEvent {
  key: string
  preventDefault(): void
  stopPropagation(): void
}

const MENU_ITEMS = '[role="menuitem"]'

function visibleItems(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(MENU_ITEMS)]
}

/** the row's trigger button: the focused element's own row when focus sits
 *  inside the submenu, the focused button itself when it sits on the trigger */
function triggerOf(focused: HTMLElement): HTMLElement | null {
  const row = focused.closest('.desktop-menu-row')
  return row?.querySelector<HTMLElement>(':scope > button') ?? focused
}

/**
 * One keydown against an open menu container. Returns true when the key was
 * consumed (the caller should neither see it again nor let the window-level
 * handlers act on it); consumed keys are also preventDefaulted — the browser
 * gives ArrowDown/Up scroll meaning that a menu must not have. Tab is the
 * deliberate exception: it is consumed for dispatch but keeps its default
 * action, since focus moving out of the dismissed menu is the behavior.
 */
export function handleMenuKeyDown<T extends string>(
  event: MenuKeyboardEvent,
  container: HTMLElement,
  options: MenuKeyboardOptions<T>,
): boolean {
  const consume = (): boolean => {
    event.preventDefault()
    event.stopPropagation()
    return true
  }
  const items = visibleItems(container)
  const doc = container.ownerDocument
  const focused =
    doc.activeElement instanceof HTMLElement && container.contains(doc.activeElement)
      ? doc.activeElement
      : null
  const at = focused === null ? -1 : items.indexOf(focused)

  const move = (delta: number): boolean => {
    if (items.length === 0) return consume()
    const next = items[(at + delta + items.length) % items.length]!
    next.focus()
    return consume()
  }

  if (event.key === 'ArrowDown') return move(1)
  if (event.key === 'ArrowUp') return move(-1)
  if (event.key === 'Home' && items.length > 0) {
    items[0]!.focus()
    return consume()
  }
  if (event.key === 'End' && items.length > 0) {
    items[items.length - 1]!.focus()
    return consume()
  }

  const inlineEndKey = options.dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight'
  const inlineStartKey = options.dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft'

  if (event.key === inlineEndKey) {
    // focus already inside the one open submenu: nothing further that way
    if (focused?.closest('.desktop-submenu')) return consume()
    // the data-submenu values are this menu's own authored union; a value
    // outside it cannot occur in the markup this module is wired to
    const sub = focused?.dataset.submenu as T | undefined
    if (sub) {
      if (sub === options.openSub) {
        // the focused row's flyout is already the open one: stepping into it
        // must focus directly, because the caller's same-value setState
        // bails out of re-render and its focus effect never runs
        focused
          ?.closest('.desktop-menu-row')
          ?.querySelector<HTMLElement>('.desktop-submenu [role="menuitem"]')
          ?.focus()
      } else {
        options.onOpenSubmenu(sub)
      }
      return consume()
    }
    return consume()
  }

  if (event.key === inlineStartKey) {
    if (options.openSub === null) return consume()
    if (focused) triggerOf(focused)?.focus()
    options.onCloseSubmenu()
    return consume()
  }

  if (event.key === 'Tab') {
    // Tab leaves the menu: dismiss it and let the default action carry
    // focus on — an open menu must never strand the keyboard behind it
    options.onDismiss()
    event.stopPropagation()
    return true
  }

  if (event.key === 'Escape') {
    // one tier at a time: the submenu closes here, the menu itself is the
    // window listener's to close (and the selection after that)
    if (options.openSub === null) return false
    if (focused) triggerOf(focused)?.focus()
    options.onCloseSubmenu()
    return consume()
  }

  return false
}
