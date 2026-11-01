// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

/**
 * The read_page script itself (READ_PAGE_SCRIPT in src/main/browser-agent.ts),
 * executed against a jsdom document: the password redaction (P0) is a
 * property of the script string main sends into the page renderer, so the
 * suite runs that exact string rather than a reimplementation. jsdom is
 * patched only where it lacks browser behavior the script reads: innerText
 * (not implemented in jsdom) and element rects (jsdom lays nothing out, so
 * every box is 0×0 and would read as invisible).
 */

const browserExports = vi.hoisted(() => ({}))

vi.mock('../../browser/src/main/browser-main', () => browserExports)
vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: { handle: vi.fn() },
  session: { fromPartition: vi.fn(() => ({})) },
  webContents: { fromId: vi.fn(() => undefined) },
}))

import { READ_PAGE_SCRIPT } from '../src/main/browser-agent'

interface OutlineElement {
  selector: string
  tag: string
  role: string
  text: string
  type?: string
}

interface Outline {
  url: string
  title: string
  textBlocks: string[]
  elements: OutlineElement[]
}

const mountLoginForm = (): void => {
  document.title = 'Sign in'
  document.body.innerHTML = `
    <h1>Sign in</h1>
    <form>
      <input id="user" type="text" value="alice" placeholder="Username">
      <input id="pw" type="password" value="hunter2" placeholder="Password">
      <input id="pin" type="PASSWORD" value="TOP-SECRET" aria-label="PIN code">
      <input id="bare" type="password" value="also-secret">
      <button id="go" type="submit">Go</button>
    </form>
  `
  // jsdom lays nothing out: give every interactive element a real box so the
  // script's visibility check keeps them
  for (const el of document.querySelectorAll('input, button')) {
    el.getBoundingClientRect = () =>
      ({ x: 0, y: 0, width: 120, height: 20, top: 0, left: 0, right: 120, bottom: 20 }) as DOMRect
  }
  Object.defineProperty(document.body, 'innerText', {
    value: 'Sign in\n\nUsername\n\nPassword',
    configurable: true,
  })
}

const runScript = (): Outline => window.eval(READ_PAGE_SCRIPT) as Outline

describe('READ_PAGE_SCRIPT — the password redaction (P0)', () => {
  it('never carries a password field value into the outline in any form', () => {
    mountLoginForm()
    const outline = runScript()
    const serialized = JSON.stringify(outline)
    expect(serialized).not.toContain('hunter2')
    expect(serialized).not.toContain('TOP-SECRET')
    expect(serialized).not.toContain('also-secret')
  })

  it('still reports the password field itself — placeholder/aria-label, and its type', () => {
    mountLoginForm()
    const outline = runScript()
    const byId = new Map(outline.elements.map((el) => [el.selector, el]))
    expect(byId.get('#pw')).toMatchObject({ type: 'password', text: 'Password' })
    expect(byId.get('#pin')).toMatchObject({ type: 'password', text: 'PIN code' })
    // no placeholder, no aria-label: the field exists, labeled by nothing
    expect(byId.get('#bare')).toMatchObject({ type: 'password', text: '' })
  })

  it('keeps the ordinary value surface for every other input', () => {
    mountLoginForm()
    const outline = runScript()
    const byId = new Map(outline.elements.map((el) => [el.selector, el]))
    // a text input's current value still rides the label (that is the point
    // of the value surface); only the password type is redacted
    expect(byId.get('#user')).toMatchObject({ type: 'text', text: 'alice' })
    expect(outline.elements.map((el) => el.selector)).toContain('#go')
  })
})
