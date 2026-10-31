/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AiComposer } from '../src/AiComposer'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

type Change = (next: string) => void
let draft = ''
const onChange: Change = (next) => {
  draft = next
}
function render(props: Record<string, unknown> = {}): void {
  act(() =>
    root.render(
      createElement(AiComposer, {
        value: draft,
        busy: false,
        placeholder: 'Ask anything',
        hintIdle: 'Enter to send',
        hintBusy: 'Esc to stop',
        sendLabel: 'Send',
        stopLabel: 'Stop',
        onChange,
        onSend: () => {},
        onStop: () => {},
        ...props,
      }),
    ),
  )
}

it('icon-only idle with a draft shows the enter glyph as SVG, never a bitmap', () => {
  draft = 'summarize this'
  render({ iconOnly: true })
  const btn = host.querySelector<HTMLButtonElement>('.ai-send-btn')
  expect(btn).not.toBeNull()
  const svg = btn!.querySelector('svg')
  expect(svg).not.toBeNull()
  // the enter glyph is the two-path arrow (not the stop rect, not a bitmap)
  expect(svg!.querySelectorAll('path')).toHaveLength(2)
  expect(svg!.querySelector('rect')).toBeNull()
  // the PNG art is retired: no <img> may ride the send/stop buttons again
  expect(host.querySelector('.ai-send-btn img')).toBeNull()
})

it('icon-only while busy swaps to the stop glyph', () => {
  draft = 'summarize this'
  render({ iconOnly: true, busy: true, onStop: () => {} })
  const btn = host.querySelector<HTMLButtonElement>('.ai-send-btn')
  expect(btn!.classList.contains('ai-stop-btn')).toBe(true)
  const svg = btn!.querySelector('svg')
  expect(svg).not.toBeNull()
  // the stop glyph is the single filled rect
  expect(svg!.querySelectorAll('rect')).toHaveLength(1)
  expect(svg!.querySelector('path')).toBeNull()
  expect(host.querySelector('.ai-send-btn img')).toBeNull()
})

it('the labeled variant shows the send glyph plus the label text', () => {
  draft = 'summarize this'
  render()
  const btn = host.querySelector<HTMLButtonElement>('.ai-send-btn')
  expect(btn!.querySelector('svg')).not.toBeNull()
  expect(btn!.textContent).toContain('Send')
  expect(host.querySelector('.ai-send-btn img')).toBeNull()
})
