// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createAnnotateOverlay } from '../src/preload/annotate/overlay'
import type { AnnotateOverlayStrings } from '../src/preload/annotate/overlay'
import type { BrowserAnnotation } from '../src/shared/annotations'

/**
 * The annotation overlay: picking (hover + click-to-pin + Esc), the persisted
 * markers (restore on revisit, silent skip for dead selectors), the popup
 * card's note/delete/ask actions — and the isolation contract, the reason the
 * layer exists: the page world can neither style nor observe it.
 *
 * jsdom has one world, so "the page" here is the test itself: page-visible
 * state is read off `document`/`window`, overlay internals only through the
 * inspect seam (which only the isolated world could ever hold in production).
 */

const STRINGS: AnnotateOverlayStrings = {
  hint: 'Click an element to annotate · Esc to exit',
  notePlaceholder: 'Add a note…',
  delete: 'Delete',
  askAi: 'Ask AI',
  dir: 'ltr',
}

interface Harness {
  overlay: ReturnType<typeof createAnnotateOverlay>
  host: HTMLElement
  shadow: ShadowRoot
  onPin: ReturnType<typeof vi.fn>
  onNote: ReturnType<typeof vi.fn>
  onDelete: ReturnType<typeof vi.fn>
  onAsk: ReturnType<typeof vi.fn>
  onExit: ReturnType<typeof vi.fn>
}

const record = (over: Partial<BrowserAnnotation> = {}): BrowserAnnotation => ({
  id: 'ann-1',
  url: 'https://example.com/page',
  selector: '#target',
  tagName: 'BUTTON',
  textSnippet: 'Sign in',
  rect: { x: 0, y: 0, width: 10, height: 10 },
  note: '',
  createdAt: 1,
  ...over,
})

function mountPage(html: string): void {
  document.head.replaceChildren()
  document.body.innerHTML = html
}

let harness: Harness | null = null

function createOverlay(): Harness {
  const onPin = vi.fn()
  const onNote = vi.fn()
  const onDelete = vi.fn()
  const onAsk = vi.fn()
  const onExit = vi.fn()
  let host: HTMLElement | null = null
  let shadow: ShadowRoot | null = null
  const overlay = createAnnotateOverlay({
    doc: document,
    strings: () => STRINGS,
    onPin,
    onNote,
    onDelete,
    onAsk,
    onExit,
    inspect: (parts) => {
      host = parts.host
      shadow = parts.shadow
    },
  })
  if (host === null || shadow === null) throw new Error('inspect seam did not fire')
  const h: Harness = { overlay, host, shadow, onPin, onNote, onDelete, onAsk, onExit }
  harness = h
  return h
}

beforeEach(() => {
  harness?.overlay.destroy()
  harness = null
  mountPage('<div id="target">Sign in</div><a id="link" href="https://example.com/next">next</a>')
})

const fire = (el: Element, type: string, init: Record<string, unknown> = {}): Event => {
  const event = new (type === 'keydown' ? KeyboardEvent : MouseEvent)(type, {
    bubbles: true,
    cancelable: true,
    ...init,
  })
  el.dispatchEvent(event)
  return event
}

describe('isolation — the page cannot see the layer', () => {
  it('hides the overlay nodes behind a closed shadow root', () => {
    const h = createOverlay()
    h.overlay.setPageState({ mode: false, annotations: [record()] })
    // page-world traversal stops at the host
    expect(h.host.shadowRoot).toBeNull()
    expect(h.host.children.length).toBe(0)
    expect(document.querySelector('.anno-marker')).toBeNull()
    expect(document.querySelector('.anno-badge')).toBeNull()
    expect(document.querySelector('.anno-card')).toBeNull()
    // and the styles the page could match never apply to the internals
    expect(document.querySelectorAll('[class^="anno-"]').length).toBe(0)
  })

  it('leaves no trace on the page globals', () => {
    const before = Object.getOwnPropertyNames(window)
    const h = createOverlay()
    h.overlay.setPageState({ mode: true, annotations: [record()] })
    expect(Object.getOwnPropertyNames(window)).toEqual(before)
    h.overlay.destroy()
    expect(h.host.isConnected).toBe(false)
  })

  it('consumes a picking click before any page listener can act', () => {
    const h = createOverlay()
    h.overlay.setPageState({ mode: true, annotations: [] })
    const target = document.getElementById('target')!
    const sawDocument = vi.fn()
    const sawTarget = vi.fn()
    // page scripts register after the preload, by construction
    document.addEventListener('click', sawDocument)
    target.addEventListener('click', sawTarget)
    const event = fire(target, 'click')
    expect(event.defaultPrevented).toBe(true)
    expect(sawDocument).not.toHaveBeenCalled()
    expect(sawTarget).not.toHaveBeenCalled()
    expect(h.onPin).toHaveBeenCalledTimes(1)
  })
})

describe('picking mode', () => {
  it('outlines the hovered element with a corner tag naming it', () => {
    const h = createOverlay()
    h.overlay.setPageState({ mode: true, annotations: [] })
    const target = document.getElementById('target')!
    fire(target, 'mouseover')
    const box = h.shadow.querySelector<HTMLElement>('.anno-hover')
    const tag = h.shadow.querySelector<HTMLElement>('.anno-hover-tag')
    expect(box?.style.display).toBe('block')
    expect(tag?.style.display).toBe('block')
    expect(tag?.textContent).toBe('DIV · Sign in')
  })

  it('pins the clicked element with selector, xpath, snippet and document rect', () => {
    const h = createOverlay()
    h.overlay.setPageState({ mode: true, annotations: [] })
    const target = document.getElementById('target')!
    fire(target, 'mouseover')
    fire(target, 'click')
    // the overlay host itself is a body-level div after the page content, so
    // the target is the first of two divs: the predicate is part of the path
    expect(h.onPin).toHaveBeenCalledWith({
      selector: '#target',
      xpath: '/html/body/div[1]',
      tagName: 'DIV',
      textSnippet: 'Sign in',
      rect: { x: 0, y: 0, width: 0, height: 0 },
      viewportRect: { x: 0, y: 0, width: 0, height: 0 },
    })
  })

  it('pins the viewport rect (the shot crop) alongside the document rect', () => {
    const h = createOverlay()
    h.overlay.setPageState({ mode: true, annotations: [] })
    const target = document.getElementById('target')!
    target.getBoundingClientRect = () =>
      ({ x: 12.4, y: 34.6, width: 120.2, height: 40.8 }) as DOMRect
    Object.defineProperty(window, 'scrollX', { value: 100, configurable: true })
    Object.defineProperty(window, 'scrollY', { value: 50, configurable: true })
    fire(target, 'click')
    expect(h.onPin).toHaveBeenCalledWith(
      expect.objectContaining({
        // document rect: viewport position plus the page's scroll offset
        rect: { x: 112, y: 85, width: 120, height: 41 },
        // viewport rect: exactly what was on screen when the pin landed
        viewportRect: { x: 12, y: 35, width: 120, height: 41 },
      }),
    )
  })

  it('leaves the mode on Esc', () => {
    const h = createOverlay()
    h.overlay.setPageState({ mode: true, annotations: [] })
    fire(document, 'keydown', { key: 'Escape' })
    expect(h.onExit).toHaveBeenCalledTimes(1)
    // and again with the mode off: Esc belongs to the page again
    h.overlay.setPageState({ mode: false, annotations: [] })
    fire(document, 'keydown', { key: 'Escape' })
    expect(h.onExit).toHaveBeenCalledTimes(1)
  })

  it('shows the picking hint while on and hides it when off', () => {
    const h = createOverlay()
    h.overlay.setPageState({ mode: true, annotations: [] })
    const hint = h.shadow.querySelector<HTMLElement>('.anno-hint')
    expect(hint?.textContent).toBe(STRINGS.hint)
    expect(hint?.style.display).toBe('block')
    h.overlay.setPageState({ mode: false, annotations: [] })
    expect(hint?.style.display).toBe('none')
  })

  it('opens the existing card instead of pinning a duplicate element', () => {
    const h = createOverlay()
    const target = document.getElementById('target')!
    h.overlay.setPageState({ mode: true, annotations: [record()] })
    fire(target, 'click')
    expect(h.onPin).not.toHaveBeenCalled()
    const card = h.shadow.querySelector<HTMLElement>('.anno-card')
    expect(card?.style.display).toBe('block')
  })
})

describe('markers', () => {
  it('restores markers on revisit without the picker being on', () => {
    const h = createOverlay()
    h.overlay.setPageState({ mode: false, annotations: [record()] })
    expect(h.shadow.querySelectorAll('.anno-marker').length).toBe(1)
    expect(h.shadow.querySelectorAll('.anno-badge').length).toBe(1)
    expect(h.shadow.querySelector<HTMLElement>('.anno-badge')?.textContent).toBe('1')
    expect(h.shadow.querySelector<HTMLElement>('.anno-hint')?.style.display).toBe('none')
  })

  it('silently draws nothing when the selector no longer resolves', () => {
    const h = createOverlay()
    h.overlay.setPageState({
      mode: false,
      annotations: [record({ selector: '#gone-forever' }), record({ selector: '##broken' })],
    })
    for (const outline of Array.from(h.shadow.querySelectorAll<HTMLElement>('.anno-marker'))) {
      expect(outline.style.display).toBe('none')
    }
    for (const badge of Array.from(h.shadow.querySelectorAll<HTMLElement>('.anno-badge'))) {
      expect(badge.style.display).toBe('none')
    }
  })

  it('re-keys the markers when the page state changes (SPA route move)', () => {
    const h = createOverlay()
    h.overlay.setPageState({ mode: false, annotations: [record()] })
    h.overlay.setPageState({
      mode: false,
      annotations: [record({ id: 'ann-2', selector: '#link' })],
    })
    expect(h.shadow.querySelectorAll('.anno-marker').length).toBe(1)
    expect(h.shadow.querySelector<HTMLElement>('.anno-badge')?.textContent).toBe('1')
  })

  it('keeps one marker per id when the same record re-arrives', () => {
    const h = createOverlay()
    const state = { mode: false, annotations: [record()] }
    h.overlay.setPageState(state)
    h.overlay.setPageState({ mode: false, annotations: [record({ note: 'renoted' })] })
    expect(h.shadow.querySelectorAll('.anno-marker').length).toBe(1)
  })

  it('a dead marker returns if its selector resolves again', () => {
    const h = createOverlay()
    const target = document.getElementById('target')!
    h.overlay.setPageState({ mode: false, annotations: [record({ selector: '#target' })] })
    const outline = h.shadow.querySelector<HTMLElement>('.anno-marker')!
    expect(outline.style.display).toBe('block')
    // the SPA replaces the node the selector pointed at
    target.remove()
    document.body.insertAdjacentHTML('beforeend', '<button id="target">Back</button>')
    // a state push (or the mutation settle) re-resolves: still exactly one marker, live again
    h.overlay.setPageState({ mode: false, annotations: [record({ selector: '#target' })] })
    expect(h.shadow.querySelectorAll('.anno-marker').length).toBe(1)
    expect(h.shadow.querySelector<HTMLElement>('.anno-marker')!.style.display).toBe('block')
  })
})

describe('the popup card', () => {
  it('opens on the marker badge click and shows the snippet and note', () => {
    const h = createOverlay()
    h.overlay.setPageState({ mode: false, annotations: [record({ note: 'existing note' })] })
    const badge = h.shadow.querySelector<HTMLElement>('.anno-badge')!
    fire(badge, 'click')
    const card = h.shadow.querySelector<HTMLElement>('.anno-card')!
    expect(card.style.display).toBe('block')
    expect(h.shadow.querySelector('.anno-card-snippet')?.textContent).toBe('Sign in')
    const note = h.shadow.querySelector<HTMLTextAreaElement>('.anno-card-note')!
    expect(note.value).toBe('existing note')
    expect(note.placeholder).toBe(STRINGS.notePlaceholder)
    expect(h.shadow.querySelector('.anno-card-ask')?.textContent).toBe(STRINGS.askAi)
    expect(h.shadow.querySelector('.anno-card-delete')?.textContent).toBe(STRINGS.delete)
  })

  it('saves the edited note (debounced) and deletes through the callbacks', async () => {
    const h = createOverlay()
    h.overlay.setPageState({ mode: false, annotations: [record()] })
    fire(h.shadow.querySelector<HTMLElement>('.anno-badge')!, 'click')
    const note = h.shadow.querySelector<HTMLTextAreaElement>('.anno-card-note')!
    note.value = 'check this copy'
    fire(note, 'input')
    await new Promise((resolve) => setTimeout(resolve, 460))
    expect(h.onNote).toHaveBeenCalledWith('ann-1', 'check this copy')

    fire(h.shadow.querySelector<HTMLElement>('.anno-card-delete')!, 'click')
    expect(h.onDelete).toHaveBeenCalledWith('ann-1')
    expect(h.shadow.querySelector<HTMLElement>('.anno-card')!.style.display).toBe('none')
  })

  it('hands the annotation to ask-AI and closes the card', () => {
    const h = createOverlay()
    h.overlay.setPageState({ mode: false, annotations: [record()] })
    fire(h.shadow.querySelector<HTMLElement>('.anno-badge')!, 'click')
    fire(h.shadow.querySelector<HTMLElement>('.anno-card-ask')!, 'click')
    expect(h.onAsk).toHaveBeenCalledWith('ann-1')
    expect(h.shadow.querySelector<HTMLElement>('.anno-card')!.style.display).toBe('none')
  })

  it('waits for the marker when the card is requested before the state push', () => {
    const h = createOverlay()
    h.overlay.openCardFor('ann-2')
    expect(h.shadow.querySelector<HTMLElement>('.anno-card')!.style.display).toBe('none')
    h.overlay.setPageState({
      mode: false,
      annotations: [record({ id: 'ann-2', selector: '#target' })],
    })
    expect(h.shadow.querySelector<HTMLElement>('.anno-card')!.style.display).toBe('block')
  })

  it('an outside click closes the card off-mode and still reaches the page', () => {
    const h = createOverlay()
    h.overlay.setPageState({ mode: false, annotations: [record()] })
    fire(h.shadow.querySelector<HTMLElement>('.anno-badge')!, 'click')
    const pageClick = vi.fn()
    document.addEventListener('click', pageClick)
    const link = document.getElementById('link')!
    const event = fire(link, 'click')
    // off-mode: the page keeps working; the card just closes
    expect(event.defaultPrevented).toBe(false)
    expect(pageClick).toHaveBeenCalledTimes(1)
    expect(h.shadow.querySelector<HTMLElement>('.anno-card')!.style.display).toBe('none')
  })

  it('an outside click closes the card in picking mode without pinning', () => {
    const h = createOverlay()
    h.overlay.setPageState({ mode: true, annotations: [record()] })
    fire(h.shadow.querySelector<HTMLElement>('.anno-badge')!, 'click')
    const event = fire(document.getElementById('link')!, 'click')
    expect(event.defaultPrevented).toBe(true)
    expect(h.onPin).not.toHaveBeenCalled()
    expect(h.shadow.querySelector<HTMLElement>('.anno-card')!.style.display).toBe('none')
  })

  it('Esc closes an open card before it exits the mode', () => {
    const h = createOverlay()
    h.overlay.setPageState({ mode: true, annotations: [record()] })
    fire(h.shadow.querySelector<HTMLElement>('.anno-badge')!, 'click')
    fire(document, 'keydown', { key: 'Escape' })
    expect(h.onExit).not.toHaveBeenCalled()
    expect(h.shadow.querySelector<HTMLElement>('.anno-card')!.style.display).toBe('none')
    fire(document, 'keydown', { key: 'Escape' })
    expect(h.onExit).toHaveBeenCalledTimes(1)
  })

  it('keeps the note typing invisible to page listeners (P1-2)', async () => {
    const h = createOverlay()
    h.overlay.setPageState({ mode: false, annotations: [record()] })
    fire(h.shadow.querySelector<HTMLElement>('.anno-badge')!, 'click')
    const note = h.shadow.querySelector<HTMLTextAreaElement>('.anno-card-note')!
    const pageKeydown = vi.fn()
    const pageKeypress = vi.fn()
    const pageInput = vi.fn()
    // the eavesdropper every page can mount for free: bubble listeners on
    // document and window, registered after the preload by construction
    document.addEventListener('keydown', pageKeydown)
    document.addEventListener('keypress', pageKeypress)
    document.addEventListener('input', pageInput)
    window.addEventListener('keydown', pageKeydown)
    note.value = 'the passcode is 1234'
    fire(note, 'input')
    fire(note, 'keydown', { key: '1' })
    fire(note, 'keypress')
    expect(pageKeydown).not.toHaveBeenCalled()
    expect(pageKeypress).not.toHaveBeenCalled()
    expect(pageInput).not.toHaveBeenCalled()
    // the overlay's own note handling keeps working
    await new Promise((resolve) => setTimeout(resolve, 460))
    expect(h.onNote).toHaveBeenCalledWith('ann-1', 'the passcode is 1234')
  })
})

describe('picking-mode interception (P1-3)', () => {
  it('consumes the page input surface before any page listener can act', () => {
    const h = createOverlay()
    h.overlay.setPageState({ mode: true, annotations: [] })
    const target = document.getElementById('target')!
    // a window-capture listener is the earliest a page can register — the
    // overlay's own window-capture listeners were registered first, so even
    // this one is too late
    const pageWindowCapture = vi.fn()
    const pageDocument = vi.fn()
    for (const type of [
      'pointerdown',
      'pointerup',
      'mousedown',
      'mouseup',
      'auxclick',
      'contextmenu',
      'wheel',
    ]) {
      window.addEventListener(type, pageWindowCapture, { capture: true })
      document.addEventListener(type, pageDocument)
    }
    for (const type of [
      'pointerdown',
      'pointerup',
      'mousedown',
      'mouseup',
      'auxclick',
      'contextmenu',
      'wheel',
    ]) {
      const event = fire(target, type)
      expect(event.defaultPrevented, `${type} is prevented`).toBe(true)
    }
    expect(pageWindowCapture).not.toHaveBeenCalled()
    expect(pageDocument).not.toHaveBeenCalled()
    expect(h.onPin).not.toHaveBeenCalled()
  })

  it('consumes driving keys while picking and leaves editing keys alone', () => {
    const h = createOverlay()
    h.overlay.setPageState({ mode: true, annotations: [] })
    const pageKey = vi.fn()
    document.addEventListener('keydown', pageKey)
    for (const key of ['Enter', 'Tab', ' ', 'F5', 'ArrowDown']) {
      const event = fire(document.body, 'keydown', { key })
      expect(event.defaultPrevented, `${key} is prevented`).toBe(true)
    }
    const chord = fire(document.body, 'keydown', { key: 'r', ctrlKey: true })
    expect(chord.defaultPrevented).toBe(true)
    expect(pageKey).not.toHaveBeenCalled()
    // a focused page field keeps editing: its keys are not the page's controls
    const field = document.createElement('input')
    document.body.appendChild(field)
    const typing = fire(field, 'keydown', { key: 'a' })
    expect(typing.defaultPrevented).toBe(false)
    expect(pageKey).toHaveBeenCalledTimes(1)
    field.remove()
  })

  it('off picking mode the page input flows untouched', () => {
    const h = createOverlay()
    h.overlay.setPageState({ mode: false, annotations: [] })
    const pageWindowCapture = vi.fn()
    const pageDocument = vi.fn()
    window.addEventListener('mousedown', pageWindowCapture, { capture: true })
    document.addEventListener('keydown', pageDocument)
    const down = fire(document.getElementById('target')!, 'mousedown')
    expect(down.defaultPrevented).toBe(false)
    expect(pageWindowCapture).toHaveBeenCalledTimes(1)
    const key = fire(document.getElementById('target')!, 'keydown', { key: 'Enter' })
    expect(key.defaultPrevented).toBe(false)
    expect(pageDocument).toHaveBeenCalledTimes(1)
  })
})

describe('the host guard (P2)', () => {
  it('re-asserts the host style a page replaced or cleared', async () => {
    const h = createOverlay()
    h.overlay.setPageState({ mode: false, annotations: [record()] })
    h.host.setAttribute('style', 'display:none')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.host.getAttribute('style')).toContain('display:block!important')
    expect(h.host.getAttribute('style')).toContain('z-index:2147483647!important')
    // a second tamper loses the same race
    h.host.setAttribute('style', 'position:static')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.host.getAttribute('style')).toContain('position:fixed!important')
  })
})
