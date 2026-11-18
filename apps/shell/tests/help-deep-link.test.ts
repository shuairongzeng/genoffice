// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { LocaleProvider } from '../src/renderer/src/locale'
import { HelpScreen } from '../src/renderer/src/i18n/help/HelpScreen'
import { HELP_TOPICS } from '../src/renderer/src/i18n/help/help-registry'
import { topicTitle } from '../src/renderer/src/i18n/help/help-titles'

/**
 * The manual's deep-link routes (issue #56 P0 #2): a palette help row calls
 * openHelp(topic) — on first open the topic rides the ?mode=help URL, and
 * while the manual is already open it arrives as a home:help-topic event.
 * Both must land on the article, and a bogus topic must fall back to the
 * default article rather than a blank screen.
 */

// every React-mounting test in this suite sets this: act() warns (and the
// warn noise can fail under some reporters) without it
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
/** the event handler the screen subscribed with */
let topicHandler: ((topic: string) => void) | undefined

beforeEach(() => {
  Element.prototype.scrollTo ??= function scrollTo(): void {}
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  topicHandler = undefined
  window.aiOffice = {
    onHelpTopic: (handler: (topic: string) => void) => {
      topicHandler = handler
      return () => {
        topicHandler = undefined
      }
    },
  } as unknown as Window['aiOffice']
  window.history.pushState({}, '', '?mode=help')
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  window.history.pushState({}, '', '?')
})

async function render(): Promise<void> {
  act(() => {
    root.render(
      createElement(LocaleProvider, { initial: 'en', children: createElement(HelpScreen) }),
    )
  })
}

/** poll until the article heading names the topic the test deep-linked to —
 * and fail when it never does: a poll that gives up silently would let a
 * broken deep link pass as "settled" */
async function settleHeading(title: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (host.querySelector('h1')?.textContent === title) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
    })
  }
  expect(host.querySelector('h1')?.textContent).toBe(title)
}

describe('the manual deep-links from the palette', () => {
  it('opens on the topic named in the view URL', async () => {
    window.history.pushState({}, '', '?mode=help&topic=pdf')
    await render()
    await settleHeading(topicTitle('pdf', 'en'))
  })

  it('falls back to the first article for an unknown URL topic', async () => {
    window.history.pushState({}, '', '?mode=help&topic=not-a-real-topic')
    await render()
    await settleHeading(topicTitle(HELP_TOPICS[0]!.id, 'en'))
  })

  it('switches articles when a home:help-topic event arrives', async () => {
    await render()
    await settleHeading(topicTitle(HELP_TOPICS[0]!.id, 'en'))
    act(() => topicHandler?.('pdf'))
    await settleHeading(topicTitle('pdf', 'en'))
  })

  it('ignores a topic the registry does not know', async () => {
    await render()
    const before = host.querySelector('h1')?.textContent
    act(() => topicHandler?.('zzz-not-a-topic'))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
    // no article switch, no crash — a bogus id falls through like a bad
    // help:// link would (the main-side guard regex-checks, this is the
    // second net)
    expect(host.querySelector('h1')?.textContent).toBe(before)
  })
})
