import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { controlHandler, openDocumentAtText, type ControlHost } from '../src/main/control-handlers'
import type { TabKind } from '../src/shared/tabs-api'

/**
 * The text target is the search deep link's half of the control protocol
 * (issue #56): `openDocumentAtText` reveals the first match in a just-opened
 * tab, and the CLI `open` route accepts a text target on any app kind (the
 * per-kind check only guards the structural targets).
 */

const fakeWebContents = (reply: unknown): WebContents => {
  const executeJavaScript = vi.fn(async () => reply)
  return {
    isDestroyed: () => false,
    isLoading: () => false,
    executeJavaScript,
  } as unknown as WebContents & { executeJavaScript: ReturnType<typeof vi.fn> }
}

describe('openDocumentAtText — the search deep link reveal', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'genoffice-control-text-'))
    path = join(dir, 'report.docx')
    writeFileSync(path, 'x')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const hostWith = (tab: { id: string; kind: TabKind; webContents: WebContents } | null) => ({
    findTab: () => tab,
    readyTimeoutMs: 0,
  })

  it('asks the found tab to goto the first text match', async () => {
    const wc = fakeWebContents({ status: 'ok', result: {} })
    openDocumentAtText(hostWith({ id: 't1', kind: 'docs', webContents: wc }), path, 'quarterly')
    // fire-and-forget: let the internal promise settle before asserting
    await new Promise((r) => setTimeout(r, 0))
    expect(wc.executeJavaScript).toHaveBeenCalledTimes(1)
    const script = wc.executeJavaScript.mock.calls[0]![0] as string
    expect(script).toContain('"cmd":"goto"')
    expect(script).toContain('"target":{"kind":"text","text":"quarterly"}')
  })

  it('stays silent when nothing opened or the app has no text reveal', async () => {
    // the open failed (unsupported type): no tab to reveal in
    const noTab = fakeWebContents({ status: 'ok', result: {} })
    openDocumentAtText(hostWith(null), path, 'quarterly')
    // markdown/html renderers install no control hook: no point polling
    const noReveal = fakeWebContents({ status: 'ok', result: {} })
    openDocumentAtText(
      hostWith({ id: 't1', kind: 'markdown', webContents: noReveal }),
      path,
      'quarterly',
    )
    // blank text carries no address to reveal
    const blank = fakeWebContents({ status: 'ok', result: {} })
    openDocumentAtText(hostWith({ id: 't2', kind: 'docs', webContents: blank }), path, '   ')
    await new Promise((r) => setTimeout(r, 0))
    expect(noTab.executeJavaScript).not.toHaveBeenCalled()
    expect(noReveal.executeJavaScript).not.toHaveBeenCalled()
    expect(blank.executeJavaScript).not.toHaveBeenCalled()
  })

  it('retries a not_ready renderer until it answers', async () => {
    // a fresh tab needs a moment before its control hook is live: the ask
    // loop polls (250ms cadence) rather than concluding at the first
    // not_ready — the reveal is only abandoned at the deadline
    const replies = [{ status: 'not_ready' }, { status: 'ok', result: { text: 'needle' } }]
    const executeJavaScript = vi.fn(async () => replies.shift() ?? { status: 'ok', result: {} })
    const wc = {
      isDestroyed: () => false,
      isLoading: () => false,
      executeJavaScript,
    } as unknown as WebContents & { executeJavaScript: ReturnType<typeof vi.fn> }
    openDocumentAtText(
      { findTab: () => ({ id: 't1', kind: 'docs', webContents: wc }), readyTimeoutMs: 2000 },
      path,
      'needle',
    )
    // the first ask lands while the tab is not ready; the poll ~250ms later
    // gets the ok — a slow machine only adds polls, never a miss
    await new Promise((r) => setTimeout(r, 400))
    expect(executeJavaScript.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(executeJavaScript.mock.calls.at(-1)![0]).toContain('"cmd":"goto"')
  })

  it('a dead renderer surfaces nothing: no ask is fired, the open stands', async () => {
    // isDestroyed short-circuits the ask: the reveal degrades to the plain
    // open with no executeJavaScript and nothing user-visible
    const executeJavaScript = vi.fn(async () => ({ status: 'ok', result: {} }))
    const wc = {
      isDestroyed: () => true,
      isLoading: () => false,
      executeJavaScript,
    } as unknown as WebContents & { executeJavaScript: ReturnType<typeof vi.fn> }
    openDocumentAtText(hostWith({ id: 't1', kind: 'docs', webContents: wc }), path, 'needle')
    await new Promise((r) => setTimeout(r, 0))
    expect(executeJavaScript).not.toHaveBeenCalled()
  })
})

describe('controlHandler with a text target', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'genoffice-control-open-'))
    path = join(dir, 'notes.docx')
    writeFileSync(path, 'x')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const hostOf = (kind: TabKind) => {
    const wc = fakeWebContents({ status: 'ok', result: { from: 2, to: 9 } })
    const host: ControlHost = {
      reveal: vi.fn(),
      openDocument: vi.fn(() => true),
      activateTab: vi.fn(),
      findTab: vi.fn(() => ({ id: 't1', kind, webContents: wc })),
      readyTimeoutMs: 0,
    }
    return { host, wc }
  }

  it('open with a text target asks any app kind (the per-kind check guards structural targets only)', async () => {
    const { host, wc } = hostOf('sheets')
    const reply = await controlHandler(host)({
      cmd: 'open',
      path,
      target: { kind: 'text', text: 'termination' },
    })
    expect(reply).toEqual({ ok: true, result: { from: 2, to: 9 } })
    expect(wc.executeJavaScript).toHaveBeenCalledTimes(1)
    expect(wc.executeJavaScript.mock.calls[0]![0]).toContain('"kind":"text"')
  })

  it('a structural target still must match the tab kind', async () => {
    const { host } = hostOf('docs')
    const reply = await controlHandler(host)({
      cmd: 'open',
      path,
      target: { kind: 'page', page: 3 },
    })
    expect(reply).toMatchObject({
      ok: false,
      error: { reason: 'unsupported', detail: { supported: ['block'] } },
    })
  })
})
