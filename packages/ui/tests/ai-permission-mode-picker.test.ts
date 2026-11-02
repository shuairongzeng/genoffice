/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AiPermissionModePicker,
  type AiPermissionModePickerBridge,
} from '../src/AiPermissionModePicker'
import type { AiPermissionMode } from '../src/ai-permission-mode'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * The permission-mode picker (src/AiPermissionModePicker.tsx): the composer
 * footer chip the panel mounts beside the model picker — the current mode
 * readable at a glance, the popover listing every posture with its one-line
 * hint, a pick persisted through the bridge, and the store's broadcast
 * re-rendering the chip.
 */

let host: HTMLDivElement
let root: Root
/** the mode the bridge answers with (the store) */
let storedMode: AiPermissionMode
let modeListeners: Set<(mode: AiPermissionMode) => void>
const setMode = vi.fn(async (mode: AiPermissionMode): Promise<void> => {
  storedMode = mode
  for (const listener of modeListeners) listener(mode)
})

beforeEach(() => {
  storedMode = 'smart'
  modeListeners = new Set()
  setMode.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const bridge = (): AiPermissionModePickerBridge => ({
  getMode: () => Promise.resolve(storedMode),
  setMode,
  onModeChanged: (handler) => {
    modeListeners.add(handler)
    return () => modeListeners.delete(handler)
  },
})

const mount = (): void => {
  act(() => root.render(createElement(AiPermissionModePicker, { bridge: bridge(), lang: 'en' })))
}

/** the chip's label text (the mode name, readable at a glance) */
const chipText = (): string => host.querySelector('.ai-model-chip-text')?.textContent ?? ''

describe('AiPermissionModePicker', () => {
  it('renders the current mode as the chip, named for the person', async () => {
    mount()
    await act(async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve()
    })
    expect(chipText()).toBe('Ask when needed')
    // and the chip's tooltip carries the mode's hint
    const chip = host.querySelector<HTMLButtonElement>('.ai-model-chip')!
    expect(chip.getAttribute('data-tip')).toContain('High-risk actions ask once')
  })

  it('lists every mode with its hint; picking one persists it', async () => {
    mount()
    await act(async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve()
    })
    act(() => host.querySelector<HTMLButtonElement>('.ai-model-chip')!.click())
    const items = [...host.querySelectorAll('.ai-model-item')]
    expect(items.map((i) => i.querySelector('.ai-model-item-text')?.textContent)).toEqual([
      'Fully automatic',
      'Ask when needed',
      'Always ask',
    ])
    // each row carries its one-line hint
    expect(items[0]!.querySelector('.ai-model-item-hint')?.textContent).toContain('OS trash')
    // smart is the selected row
    expect(items[1]!.classList.contains('selected')).toBe(true)
    // pick paranoid: the bridge's write lands, the popover closes, the chip follows
    act(() => items[2]!.click())
    await act(async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve()
    })
    expect(setMode).toHaveBeenCalledWith('paranoid')
    expect(host.querySelector('.ai-model-pop')).toBeNull()
    expect(chipText()).toBe('Always ask')
  })

  it("the store's broadcast re-renders the chip (another mount's write)", async () => {
    mount()
    await act(async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve()
    })
    expect(chipText()).toBe('Ask when needed')
    // the mode changed elsewhere (the other panel's dropdown): the broadcast
    // is what this chip follows, not its own last write
    await act(async () => {
      storedMode = 'auto'
      for (const listener of modeListeners) listener('auto')
    })
    expect(chipText()).toBe('Fully automatic')
  })

  it('a throwing getMode never takes the panel down: no chip renders', async () => {
    const broken: AiPermissionModePickerBridge = {
      getMode: () => Promise.reject(new Error('no store')),
      setMode: () => Promise.resolve(),
    }
    act(() => root.render(createElement(AiPermissionModePicker, { bridge: broken, lang: 'en' })))
    await act(async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve()
    })
    expect(host.querySelector('.ai-model-chip')).toBeNull()
  })
})
