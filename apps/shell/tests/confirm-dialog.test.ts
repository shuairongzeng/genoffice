// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useConfirm } from '../src/renderer/src/ConfirmDialog'
import { LocaleProvider } from '../src/renderer/src/locale'

/**
 * The in-app confirm/alert pair that replaced the native dialogs: promise
 * settlement on every dismissal path (button, overlay, Escape), the alert's
 * single button, and the supersede behavior when a second request arrives
 * while one is open. The act calls stay inline in each test body — React's
 * async act scope does not survive an extra await hop through a helper.
 */

let root: Root
let container: HTMLDivElement
let api: ReturnType<typeof useConfirm> | null = null
let hostPresses = 0

// the hook is only consumable inside a component; this harness captures it and
// renders the dialog node the way a real host does — inside a wrapping element
// whose own press handler stands in for a host modal's overlay dismissal
function Harness(): ReactNode {
  const hook = useConfirm('OK')
  api = hook
  return createElement('div', { onClick: () => (hostPresses += 1) }, hook.dialog)
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  hostPresses = 0
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  // plain unmount + a flush act: wrapping the unmount itself in act never
  // settles under this tree (a resolved confirm promise in flight)
  root.unmount()
  await act(async () => {})
  container.remove()
  api = null
  vi.unstubAllGlobals()
})

const mount = async () => {
  await act(async () =>
    root.render(
      createElement(LocaleProvider, {
        initial: 'en',
        children: createElement(Harness),
      }),
    ),
  )
}

const buttons = () => [...container.querySelectorAll<HTMLButtonElement>('.modal-buttons button')]

describe('useConfirm', () => {
  it('renders title, body and both buttons; the confirm click settles true', async () => {
    await mount()
    let promise!: Promise<boolean>
    await act(async () => {
      promise = api!.confirm({
        title: 'Delete file',
        body: createElement('p', null, 'Delete report.docx?'),
        confirmLabel: 'Delete',
        cancelLabel: 'Cancel',
        danger: true,
      })
    })
    expect(container.querySelector('.modal h3')?.textContent).toBe('Delete file')
    expect(container.querySelector('.modal p')?.textContent).toBe('Delete report.docx?')
    expect(buttons().map((b) => b.textContent)).toEqual(['Cancel', 'Delete'])
    // the danger request styles the confirm button
    expect(buttons()[1]!.className).toContain('btn-danger')
    await act(async () => buttons()[1]!.click())
    await expect(promise).resolves.toBe(true)
    // settled: the modal is gone
    expect(container.querySelector('.modal')).toBeNull()
  })

  it('the cancel button and the overlay press both settle false', async () => {
    await mount()
    let viaButton!: Promise<boolean>
    await act(async () => {
      viaButton = api!.confirm({
        body: createElement('p', null, 'first'),
        confirmLabel: 'Go',
        cancelLabel: 'Stop',
      })
    })
    await act(async () => buttons()[0]!.click())
    await expect(viaButton).resolves.toBe(false)

    let viaOverlay!: Promise<boolean>
    await act(async () => {
      viaOverlay = api!.confirm({
        body: createElement('p', null, 'second'),
        confirmLabel: 'Go',
        cancelLabel: 'Stop',
      })
    })
    await act(async () => (container.querySelector('.modal-overlay') as HTMLElement).click())
    await expect(viaOverlay).resolves.toBe(false)
  })

  it('Escape settles false and swallows the key from host-level Escape handlers', async () => {
    await mount()
    // a host modal (the folder picker) listens for Escape at bubble phase on
    // window; while the confirm is open it must not also fire. The key event
    // starts at a descendant like a real keypress, so the confirm's
    // capture-phase listener runs first.
    const hostEscape = vi.fn()
    window.addEventListener('keydown', hostEscape)
    try {
      let promise!: Promise<boolean>
      await act(async () => {
        promise = api!.confirm({
          body: createElement('p', null, 'press escape'),
          confirmLabel: 'Go',
          cancelLabel: 'Stop',
        })
      })
      await act(async () => {
        buttons()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      await expect(promise).resolves.toBe(false)
      expect(hostEscape).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', hostEscape)
    }
  })

  it('an overlay press does not bubble into a host modal underneath', async () => {
    await mount()
    let promise!: Promise<boolean>
    await act(async () => {
      promise = api!.confirm({
        body: createElement('p', null, 'nested'),
        confirmLabel: 'Go',
        cancelLabel: 'Stop',
      })
    })
    await act(async () => (container.querySelector('.modal-overlay') as HTMLElement).click())
    await expect(promise).resolves.toBe(false)
    // the wrapper's press handler (a host overlay) never saw the click
    expect(hostPresses).toBe(0)
  })

  it('a second request while one is open settles the first as cancelled', async () => {
    await mount()
    let first!: Promise<boolean>
    await act(async () => {
      first = api!.confirm({
        body: createElement('p', null, 'first'),
        confirmLabel: 'A',
        cancelLabel: 'Stop',
      })
    })
    let second!: Promise<boolean>
    await act(async () => {
      second = api!.confirm({
        body: createElement('p', null, 'second'),
        confirmLabel: 'B',
        cancelLabel: 'Stop',
      })
    })
    await expect(first).resolves.toBe(false)
    expect(container.querySelector('.modal p')?.textContent).toBe('second')
    await act(async () => buttons()[1]!.click())
    await expect(second).resolves.toBe(true)
  })

  it('alert renders one focused OK button and settles on its click', async () => {
    await mount()
    let promise!: Promise<void>
    await act(async () => {
      promise = api!.alert(createElement('p', null, 'the rename failed'))
    })
    expect(buttons()).toHaveLength(1)
    expect(buttons()[0]!.textContent).toBe('OK')
    expect(document.activeElement).toBe(buttons()[0])
    await act(async () => buttons()[0]!.click())
    await expect(promise).resolves.toBeUndefined()
  })

  it('a title-less request falls back to the body text for the dialog label', async () => {
    await mount()
    let promise!: Promise<boolean>
    await act(async () => {
      promise = api!.confirm({ body: 'plain message', confirmLabel: 'Go', cancelLabel: 'Stop' })
    })
    const modal = container.querySelector('.modal') as HTMLElement
    expect(modal.getAttribute('aria-label')).toBe('plain message')
    expect(modal.querySelector('h3')).toBeNull()
    await act(async () => buttons()[1]!.click())
    await expect(promise).resolves.toBe(true)
  })

  it('an open request settles as cancelled when its host unmounts', async () => {
    // the IPC continuation that opened an alert can land after the host
    // unmounted (a picker closed while its create was in flight); the
    // promise must settle, not hang with the message swallowed
    await mount()
    let promise!: Promise<boolean>
    await act(async () => {
      promise = api!.confirm({ body: 'in flight', confirmLabel: 'Go' })
    })
    root.unmount()
    await expect(promise).resolves.toBe(false)
  })
})
