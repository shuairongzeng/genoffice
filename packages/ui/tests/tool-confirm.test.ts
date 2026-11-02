/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiConfirmCard } from '../src/AiConfirmCard'
import { AI_CONFIRM_LABELS } from '../src/strings-ai-confirm'
import { useToolConfirm } from '../src/tool-confirm'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** a host that mounts the hook and exposes the card + decisions */
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
let hook: ReturnType<typeof useToolConfirm>

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** renders the card the way a panel does: card + the decisions */
function mountGate(timeoutMs?: number): void {
  function Gate() {
    hook = useToolConfirm(timeoutMs ? { timeoutMs } : undefined)
    if (!hook.card) return null
    return createElement(AiConfirmCard, {
      labels: AI_CONFIRM_LABELS.en,
      card: hook.card,
      ...(timeoutMs ? { timeoutMinutes: 1 } : {}),
      onAllow: hook.allow,
      onDeny: hook.deny,
    })
  }
  act(() => root.render(createElement(Gate)))
}

/** renders the card the way the dock's panels do: with the session affordance wired */
function mountSessionGate(onSessionAllow?: (toolName: string) => void): void {
  function Gate() {
    hook = useToolConfirm({ onSessionAllow })
    if (!hook.card) return null
    return createElement(AiConfirmCard, {
      labels: AI_CONFIRM_LABELS.en,
      card: hook.card,
      onAllow: hook.allow,
      onAllowSession: hook.allowSession,
      onDeny: hook.deny,
    })
  }
  act(() => root.render(createElement(Gate)))
}

/** renders the card the way a host without the session affordance does (the doc-mode panels) */
function mountBareGate(): void {
  function Gate() {
    hook = useToolConfirm()
    if (!hook.card) return null
    return createElement(AiConfirmCard, {
      labels: AI_CONFIRM_LABELS.en,
      card: hook.card,
      onAllow: hook.allow,
      onDeny: hook.deny,
    })
  }
  act(() => root.render(createElement(Gate)))
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const click = (selector: string) => {
  const el = host.querySelector(selector)
  expect(el).toBeTruthy()
  act(() => (el as HTMLElement).click())
}

describe('useToolConfirm + AiConfirmCard', () => {
  it('asks, then allows: the promise resolves true and the card keeps the outcome', async () => {
    mountGate()
    let decided: boolean | undefined
    const pending = hook.confirm({ name: 'run_genoffice', input: { args: ['guide', 'docs'] } })
    void pending.then((allowed) => (decided = allowed))
    await settle()
    expect(hook.card?.outcome).toBe('awaiting')
    expect(host.querySelector('.ai-confirm-card')).toBeTruthy()

    click('.ai-confirm-allow')
    await settle()
    expect(decided).toBe(true)
    // the settled card stays in the flow as the record of the decision
    expect(hook.card?.outcome).toBe('allowed')
    expect(host.querySelector('.ai-confirm-allow')).toBeNull()
  })

  it('denying resolves false and disables further clicks (one decision per request)', async () => {
    mountGate()
    const decisions: boolean[] = []
    const pending = hook.confirm({ name: 'create_document', input: { title: 'Report' } })
    void pending.then((allowed) => decisions.push(allowed))
    await settle()
    click('.ai-confirm-deny')
    await settle()
    expect(decisions).toEqual([false])
    expect(hook.card?.outcome).toBe('denied')
    // the buttons are gone: the settled request cannot be re-decided
    expect(host.querySelector('.ai-confirm-deny')).toBeNull()
  })

  it('a click after the outcome must not double-settle the promise', async () => {
    mountGate()
    const decisions: boolean[] = []
    const pending = hook.confirm({ name: 'run_genoffice', input: {} })
    void pending.then((allowed) => decisions.push(allowed))
    await settle()
    click('.ai-confirm-deny')
    await settle()
    // late clicks (a zombie handler, a second card instance) settle nothing
    hook.deny()
    hook.allow()
    await settle()
    expect(decisions).toEqual([false])
  })

  it('silence past the timeout counts as denial', async () => {
    vi.useFakeTimers()
    try {
      mountGate(1_000)
      let decided: boolean | undefined
      const pending = hook.confirm({ name: 'run_genoffice', input: {} })
      void pending.then((allowed) => (decided = allowed))
      await settle()
      act(() => vi.advanceTimersByTime(1_001))
      await settle()
      expect(decided).toBe(false)
      expect(hook.card?.outcome).toBe('denied')
      expect(hook.card?.timedOut).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('settleAll(false) answers a pending request the safe way (Stop, thread switch)', async () => {
    mountGate()
    let decided: boolean | undefined
    const pending = hook.confirm({ name: 'run_genoffice', input: {} })
    void pending.then((allowed) => (decided = allowed))
    await settle()
    hook.settleAll(false)
    await settle()
    expect(decided).toBe(false)
    expect(hook.card?.outcome).toBe('denied')
  })

  it('unmount denies whatever is still pending, so the loop never hangs', async () => {
    mountGate()
    let decided: boolean | undefined
    const pending = hook.confirm({ name: 'run_genoffice', input: {} })
    void pending.then((allowed) => (decided = allowed))
    await settle()
    act(() => root.unmount())
    // the unmount cleanup resolves the pending promise on the next microtask
    await Promise.resolve()
    expect(decided).toBe(false)
  })

  it('a second request while one is pending settles the first as denied', async () => {
    mountGate()
    const decisions: boolean[] = []
    const first = hook.confirm({ name: 'run_genoffice', input: {} })
    void first.then((allowed) => decisions.push(allowed))
    await settle()
    const second = hook.confirm({ name: 'create_document', input: {} })
    await settle()
    expect(decisions).toEqual([false])
    // the card now shows the new request
    expect(hook.card?.toolName).toBe('create_document')
    click('.ai-confirm-allow')
    await settle()
    await expect(second).resolves.toBe(true)
  })

  it('clear drops a settled card from the flow (a new run owns the stream)', async () => {
    mountGate()
    const pending = hook.confirm({ name: 'run_genoffice', input: {} })
    await settle()
    click('.ai-confirm-deny')
    await settle()
    expect(hook.card).not.toBeNull()
    act(() => hook.clear())
    expect(hook.card).toBeNull()
    await expect(pending).resolves.toBe(false)
  })

  it('shows the tool name and a capped arguments preview', async () => {
    mountGate()
    void hook.confirm({ name: 'apply_ops', input: { ops: [{ op: 'setFont', color: '#FF0000' }] } })
    await settle()
    expect(host.querySelector('.ai-confirm-tool')?.textContent).toContain('apply_ops')
    const pre = host.querySelector('.ai-confirm-args pre')
    expect(pre?.textContent).toContain('setFont')
  })

  it("a host's args summary renders as its own line above the preview", async () => {
    mountGate()
    void hook.confirm({
      name: 'edit_file',
      input: { path: '/docs/a.md' },
      argsSummary: 'removes 900 characters, adds 0 characters, file: 5000 characters',
    })
    await settle()
    const summary = host.querySelector('.ai-confirm-args-summary')
    expect(summary?.textContent).toBe(
      'removes 900 characters, adds 0 characters, file: 5000 characters',
    )
    // the raw preview still shows beneath it
    expect(host.querySelector('.ai-confirm-args pre')?.textContent).toContain('/docs/a.md')
    // and the summary stays on the settled card as part of the record
    click('.ai-confirm-deny')
    await settle()
    expect(host.querySelector('.ai-confirm-args-summary')).toBeTruthy()
  })

  it('a request without a summary renders no summary line', async () => {
    mountGate()
    void hook.confirm({ name: 'run_genoffice', input: {} })
    await settle()
    expect(host.querySelector('.ai-confirm-args-summary')).toBeNull()
  })

  it('a request without sessionAllowable keeps the plain two-button card', async () => {
    mountSessionGate()
    void hook.confirm({ name: 'run_genoffice', input: {} })
    await settle()
    expect(host.querySelector('.ai-confirm-session')).toBeNull()
    expect(host.querySelector('.ai-confirm-allow')).toBeTruthy()
  })

  it('a sessionable request offers always-allow first, then allow once, then deny', async () => {
    mountSessionGate()
    void hook.confirm(
      { name: 'edit_file', input: { path: '/docs/report.md' } },
      {
        sessionAllowable: true,
      },
    )
    await settle()
    const buttons = [...host.querySelectorAll('.ai-confirm-actions button')].map((b) => b.className)
    expect(buttons).toEqual(['ai-confirm-session', 'ai-confirm-allow', 'ai-confirm-deny'])
    expect(host.querySelector('.ai-confirm-session')?.textContent).toBe(
      AI_CONFIRM_LABELS.en.allowSession,
    )
  })

  it('always-allow resolves true, reports the tool name, and notes the session outcome', async () => {
    const sessionAllowed: string[] = []
    mountSessionGate((toolName) => sessionAllowed.push(toolName))
    let decided: boolean | undefined
    const pending = hook.confirm(
      { name: 'edit_file', input: { path: '/x.md' } },
      {
        sessionAllowable: true,
      },
    )
    void pending.then((allowed) => (decided = allowed))
    await settle()
    click('.ai-confirm-session')
    await settle()
    expect(decided).toBe(true)
    expect(sessionAllowed).toEqual(['edit_file'])
    expect(hook.card?.outcome).toBe('allowed')
    expect(hook.card?.viaSession).toBe(true)
    // the record in the flow says which allow it was
    expect(host.querySelector('.ai-confirm-outcome')?.textContent).toBe(
      AI_CONFIRM_LABELS.en.allowedSessionNote,
    )
  })

  it('a plain allow fires no session callback', async () => {
    const sessionAllowed: string[] = []
    mountSessionGate((toolName) => sessionAllowed.push(toolName))
    void hook.confirm({ name: 'edit_file', input: {} }, { sessionAllowable: true })
    await settle()
    click('.ai-confirm-allow')
    await settle()
    expect(sessionAllowed).toEqual([])
    expect(hook.card?.viaSession).toBeUndefined()
    expect(host.querySelector('.ai-confirm-outcome')?.textContent).toBe(
      AI_CONFIRM_LABELS.en.allowedNote,
    )
  })

  it('a host that wires no onAllowSession never renders the button', async () => {
    mountBareGate()
    void hook.confirm({ name: 'delete_file', input: {} }, { sessionAllowable: true })
    await settle()
    // the request offers it, but the host did not wire the affordance
    expect(host.querySelector('.ai-confirm-session')).toBeNull()
  })
})

describe('AI_CONFIRM_LABELS — the three-state copy in every locale', () => {
  it('every locale carries the session-allow strings, non-empty', () => {
    for (const [lang, labels] of Object.entries(AI_CONFIRM_LABELS)) {
      expect(labels.allowSession.length, `${lang} allowSession`).toBeGreaterThan(0)
      expect(labels.allowedSessionNote.length, `${lang} allowedSessionNote`).toBeGreaterThan(0)
      expect(labels.allow.length, `${lang} allow`).toBeGreaterThan(0)
      expect(labels.deny.length, `${lang} deny`).toBeGreaterThan(0)
      expect(labels.allowedNote.length, `${lang} allowedNote`).toBeGreaterThan(0)
      expect(labels.deniedNote.length, `${lang} deniedNote`).toBeGreaterThan(0)
    }
  })

  it('the locale count matches the i18n table', async () => {
    const { LANGS } = await import('@genoffice/i18n')
    expect(Object.keys(AI_CONFIRM_LABELS).sort()).toEqual([...LANGS].sort())
  })
})
