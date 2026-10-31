// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { defaultAiSettings } from '@genoffice/ai-provider'
import { KbAskPanel } from '../src/renderer/src/KbAskPanel'
import { LocaleProvider } from '../src/renderer/src/locale'

/**
 * The ask panel's 'folders' corpus scope, the guidance contract of the
 * settings kbScope's third option: the teaching surfaces (hero, step 1,
 * intro) switch to the folders wording, the empty-corpus CTA opens the
 * settings center instead of the recents list, the empty-corpus guidance
 * tells an empty folders list and chosen folders with nothing in them apart,
 * and a kb:scope-changed push re-reads the scope rather than keeping the one
 * the panel mounted with.
 */

let host: HTMLDivElement
let root: Root
let scopeChangedHandler: (() => void) | null
let scopeReads: number
let corpusReads: number

beforeEach(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {}
  scopeChangedHandler = null
  scopeReads = 0
  corpusReads = 0
  ;(window as unknown as { aiOffice: unknown }).aiOffice = {
    kbList: async () => {
      corpusReads++
      return []
    },
    getKbScope: async () => {
      scopeReads++
      return 'folders'
    },
    onKbScopeChanged: (handler: () => void) => {
      scopeChangedHandler = handler
      return () => {}
    },
    aiGetSettings: async () => defaultAiSettings(),
    aiGskStatus: async () => ({ loggedIn: true }),
    onAiSettingsChanged: () => () => {},
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete (window as unknown as { aiOffice?: unknown }).aiOffice
})

function render(onOpenScopeSettings: () => void = vi.fn()): void {
  act(() =>
    root.render(
      createElement(
        LocaleProvider,
        { initial: 'en' },
        createElement(KbAskPanel, {
          onOpenPath: () => {},
          onGoToRecents: () => {},
          onOpenModelSettings: () => {},
          onOpenScopeSettings,
        }),
      ),
    ),
  )
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

/** set the composer draft the way a user's keystrokes would */
function type(text: string): void {
  const ta = host.querySelector('textarea')!
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(ta, text)
    ta.setSelectionRange(text.length, text.length)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** press Enter in the composer */
function pressEnter(): void {
  act(() => {
    host
      .querySelector('textarea')!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
  })
}

describe('KbAskPanel folders scope', () => {
  it('teaches the folders corpus and sends the CTA to settings, not recents', async () => {
    const onOpenScopeSettings = vi.fn()
    const onGoToRecents = vi.fn()
    act(() =>
      root.render(
        createElement(
          LocaleProvider,
          { initial: 'en' },
          createElement(KbAskPanel, {
            onOpenPath: () => {},
            onGoToRecents,
            onOpenModelSettings: () => {},
            onOpenScopeSettings,
          }),
        ),
      ),
    )
    await settle()

    expect(host.textContent).toContain('searches only the folders you picked in Settings')
    expect(host.textContent).toContain('Pick folders')
    expect(host.textContent).toContain('Add knowledge base folders in Settings › General')

    // the CTA is the scope's: settings, never the recents list
    const cta = host.querySelector<HTMLButtonElement>('.kb-ask-cta')
    expect(cta).not.toBeNull()
    expect(cta!.textContent).toBe('Pick folders in Settings')
    await act(async () => {
      cta!.click()
      await Promise.resolve()
    })
    expect(onOpenScopeSettings).toHaveBeenCalledTimes(1)
    expect(onGoToRecents).not.toHaveBeenCalled()
  })

  it('the indexed scope keeps the recents CTA (the branch map is exhaustive)', async () => {
    ;(
      window as unknown as { aiOffice: { getKbScope: () => Promise<string> } }
    ).aiOffice.getKbScope = async () => 'indexed'
    const onOpenScopeSettings = vi.fn()
    const onGoToRecents = vi.fn()
    act(() =>
      root.render(
        createElement(
          LocaleProvider,
          { initial: 'en' },
          createElement(KbAskPanel, {
            onOpenPath: () => {},
            onGoToRecents,
            onOpenModelSettings: () => {},
            onOpenScopeSettings,
          }),
        ),
      ),
    )
    await settle()

    const cta = host.querySelector<HTMLButtonElement>('.kb-ask-cta')
    expect(cta!.textContent).toBe('Browse your files in Recents')
    await act(async () => {
      cta!.click()
      await Promise.resolve()
    })
    expect(onGoToRecents).toHaveBeenCalledTimes(1)
    expect(onOpenScopeSettings).not.toHaveBeenCalled()
  })

  it('a kb:scope-changed push re-reads the scope and the corpus', async () => {
    render()
    await settle()
    expect(scopeReads).toBe(1)
    expect(corpusReads).toBeGreaterThanOrEqual(1)
    expect(scopeChangedHandler).not.toBeNull()

    const readsBefore = corpusReads
    ;(
      window as unknown as { aiOffice: { getKbScope: () => Promise<string> } }
    ).aiOffice.getKbScope = async () => {
      scopeReads++
      return 'starred'
    }
    await act(async () => {
      scopeChangedHandler!()
      await Promise.resolve()
    })
    await settle()
    // the push is what moved the panel off its mounted scope
    expect(scopeReads).toBe(2)
    expect(corpusReads).toBeGreaterThan(readsBefore)
    expect(host.textContent).toContain('Star the files you read often')
  })

  it('an empty-corpus question answers with the folders guidance, not the starred one', async () => {
    render()
    await settle()
    type('where is the lease?')
    pressEnter()
    await settle()
    // the guidance answer is scope-keyed: the panel says pick folders, never
    // "star your files", under the scope that cannot see any
    expect(host.textContent).toContain('The knowledge base has no folders chosen yet')
    expect(host.textContent).not.toContain('Star the files you read often')
  })

  it('distinguishes an empty folders list from chosen folders with nothing in them', async () => {
    // folders are chosen, the corpus is still empty: the guidance names the
    // chosen-but-empty condition, not the "no folders chosen yet" one
    ;(
      window as unknown as { aiOffice: { getKbScopeFolders: () => Promise<string[]> } }
    ).aiOffice.getKbScopeFolders = async () => ['/Users/me/contracts']
    render()
    await settle()
    type('where is the lease?')
    pressEnter()
    await settle()
    expect(host.textContent).toContain('The chosen folders hold no knowledge base files yet')
    expect(host.textContent).not.toContain('The knowledge base has no folders chosen yet')
    expect(host.textContent).not.toContain('Star the files you read often')
  })

  it('a non-empty folders corpus shows the folders intro under the count', async () => {
    ;(window as unknown as { aiOffice: { kbList: () => Promise<unknown[]> } }).aiOffice.kbList =
      async () => [
        {
          path: '/Users/me/contracts/lease.docx',
          folder: 'contracts',
          folderPath: '/Users/me/contracts',
          name: 'lease.docx',
          ext: 'docx',
          sizeBytes: 10,
        },
      ]
    render()
    await settle()
    expect(host.textContent).toContain('Questions search only your chosen folders')
    expect(host.textContent).toContain('Knowledge base: 1 files')
  })
})
