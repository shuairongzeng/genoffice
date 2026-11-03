import { describe, expect, it, vi } from 'vitest'
import type { AgentSkill } from '../src/skill'
import type {
  AgentImage,
  AgentMessage,
  AgentStreamCallbacks,
  AgentStreamRequest,
  AgentToolCall,
  AgentToolDef,
  AgentTransport,
} from '../src/types'
import {
  AgentLoop,
  BROWSER_CLEAR_ANNOTATIONS_TOOL,
  BROWSER_CLICK_TOOL,
  BROWSER_DOWNLOAD_TOOL,
  BROWSER_FILL_FIELD_TOOL,
  BROWSER_GO_BACK_TOOL,
  BROWSER_GO_FORWARD_TOOL,
  BROWSER_LIST_ANNOTATIONS_TOOL,
  BROWSER_PRESS_KEY_TOOL,
  BROWSER_READ_ANNOTATION_SHOT_TOOL,
  BROWSER_READ_PAGE_TOOL,
  BROWSER_RELOAD_TOOL,
  BROWSER_SCREENSHOT_TOOL,
  BROWSER_SCROLL_TOOL,
  BROWSER_WAIT_FOR_TOOL,
  MAX_SELECTOR_CHARS,
  createBrowserSkill,
  formatPageOutline,
  type BrowserActionResult,
  type BrowserClearAnnotationsResult,
  type BrowserDownloadResult,
  type BrowserPageRead,
  type BrowserSkillDeps,
  type BrowserTabSnapshot,
} from '../src'

/**
 * The dock's browser skill: the live-tab gate (tools exist only while a
 * browser tab is open), the tool surface (names, risk annotations, schemas),
 * input validation, the read budget, and the screenshot's ride into visual
 * context through the loop's synthetic image turn.
 */

const TABS: BrowserTabSnapshot[] = [
  { id: 't1', title: 'Example Domain', active: true },
  { id: 't2', title: 'Search results', active: false },
]

const READ: BrowserPageRead = {
  url: 'https://example.com/',
  title: 'Example Domain',
  outline:
    '# Example Domain\nURL: https://example.com/\n\n## Text blocks (1)\n- Hello\n\n' +
    '## Annotations the user left on this page (1)\n- what is this? — "Hello" (p:nth-of-type(1))',
  annotations: [{ selector: 'p:nth-of-type(1)', textSnippet: 'Hello', note: 'what is this?' }],
}

interface Harness {
  skill: AgentSkill
  deps: {
    readPage: ReturnType<typeof vi.fn>
    screenshotPage: ReturnType<typeof vi.fn>
    readAnnotationShot: ReturnType<typeof vi.fn>
    fillField: ReturnType<typeof vi.fn>
    clickElement: ReturnType<typeof vi.fn>
    scrollPage: ReturnType<typeof vi.fn>
    downloadFile: ReturnType<typeof vi.fn>
    navigateHistory: ReturnType<typeof vi.fn>
    waitFor: ReturnType<typeof vi.fn>
    pressKey: ReturnType<typeof vi.fn>
    listAnnotations: ReturnType<typeof vi.fn>
    clearAnnotations: ReturnType<typeof vi.fn>
  }
}

function skillWith(
  openTabs: readonly BrowserTabSnapshot[] | null,
  overrides: Partial<BrowserSkillDeps> = {},
): Harness {
  const fns = {
    readPage: vi.fn(async (): Promise<BrowserPageRead> => READ),
    screenshotPage: vi.fn(async () => ({
      url: 'https://example.com/',
      title: 'Example Domain',
      base64: 'AAAA',
      mime: 'image/png',
      width: 1280,
      height: 800,
    })),
    readAnnotationShot: vi.fn(async () => ({
      id: 'ann-1',
      base64: 'SHOT',
      mime: 'image/png',
      width: 320,
      height: 120,
    })),
    fillField: vi.fn(async (): Promise<BrowserActionResult> => ({
      ok: true,
      detail: 'filled the field',
    })),
    clickElement: vi.fn(async (): Promise<BrowserActionResult> => ({
      ok: true,
      detail: 'clicked the element',
    })),
    scrollPage: vi.fn(async (): Promise<BrowserActionResult> => ({
      ok: true,
      detail: 'scrolled down by 720px',
    })),
    downloadFile: vi.fn(async (): Promise<BrowserDownloadResult> => ({
      path: '/userData/Downloads/report.pdf',
      url: 'https://example.com/report.pdf',
      source: 'url',
      bytes: 2048,
    })),
    navigateHistory: vi.fn(async (): Promise<BrowserActionResult> => ({
      ok: true,
      detail: 'went back the page',
    })),
    waitFor: vi.fn(async (): Promise<BrowserActionResult> => ({
      ok: true,
      detail: 'the page finished loading',
    })),
    pressKey: vi.fn(async (): Promise<BrowserActionResult> => ({ ok: true, detail: 'sent enter' })),
    listAnnotations: vi.fn(async () => [
      { id: 'ann-1', selector: '#q', note: 'the search box', hasShot: true },
    ]),
    clearAnnotations: vi.fn(async (): Promise<BrowserClearAnnotationsResult> => ({
      removed: 2,
      url: 'https://example.com/',
    })),
  }
  const deps: BrowserSkillDeps = { openTabs: () => openTabs, ...fns, ...overrides }
  return { skill: createBrowserSkill(deps), deps: fns }
}

const call = (name: string, input: Record<string, unknown> = {}): AgentToolCall => ({
  id: 'c1',
  name,
  input,
})

describe('the browser skill surface', () => {
  it('offers the tool set, with fill/click/clear gated as high-risk', () => {
    const { skill } = skillWith(TABS)
    expect(skill.tools.map((t) => t.name)).toEqual([
      BROWSER_READ_PAGE_TOOL,
      BROWSER_SCREENSHOT_TOOL,
      BROWSER_READ_ANNOTATION_SHOT_TOOL,
      BROWSER_FILL_FIELD_TOOL,
      BROWSER_CLICK_TOOL,
      BROWSER_SCROLL_TOOL,
      BROWSER_DOWNLOAD_TOOL,
      BROWSER_GO_BACK_TOOL,
      BROWSER_GO_FORWARD_TOOL,
      BROWSER_RELOAD_TOOL,
      BROWSER_WAIT_FOR_TOOL,
      BROWSER_PRESS_KEY_TOOL,
      BROWSER_LIST_ANNOTATIONS_TOOL,
      BROWSER_CLEAR_ANNOTATIONS_TOOL,
    ])
    const byName = new Map(skill.tools.map((t) => [t.name, t]))
    expect(byName.get(BROWSER_READ_PAGE_TOOL)!.risk).toBeUndefined()
    expect(byName.get(BROWSER_SCREENSHOT_TOOL)!.risk).toBeUndefined()
    expect(byName.get(BROWSER_READ_ANNOTATION_SHOT_TOOL)!.risk).toBeUndefined()
    expect(byName.get(BROWSER_FILL_FIELD_TOOL)!.risk).toBe('high')
    expect(byName.get(BROWSER_CLICK_TOOL)!.risk).toBe('high')
    // the page-movement and download tools are visible and reversible:
    // ungated like the reads, with clear_annotations the one new gate (it
    // deletes the user's markers)
    for (const name of [
      BROWSER_SCROLL_TOOL,
      BROWSER_DOWNLOAD_TOOL,
      BROWSER_GO_BACK_TOOL,
      BROWSER_GO_FORWARD_TOOL,
      BROWSER_RELOAD_TOOL,
      BROWSER_WAIT_FOR_TOOL,
      BROWSER_PRESS_KEY_TOOL,
      BROWSER_LIST_ANNOTATIONS_TOOL,
    ]) {
      expect(byName.get(name)!.risk).toBeUndefined()
    }
    expect(byName.get(BROWSER_CLEAR_ANNOTATIONS_TOOL)!.risk).toBe('high')
    // the action tools declare their arguments
    expect(byName.get(BROWSER_FILL_FIELD_TOOL)!.inputSchema).toMatchObject({
      required: ['selector', 'value'],
    })
    expect(byName.get(BROWSER_CLICK_TOOL)!.inputSchema).toMatchObject({
      required: ['selector'],
    })
    expect(byName.get(BROWSER_READ_ANNOTATION_SHOT_TOOL)!.inputSchema).toMatchObject({
      required: ['id'],
    })
    expect(byName.get(BROWSER_PRESS_KEY_TOOL)!.inputSchema).toMatchObject({
      required: ['key'],
    })
    // the prompt names the boundary: active tab, read before acting, approval
    expect(skill.systemPrompt).toMatch(/active.? tab/i)
    expect(skill.systemPrompt).toMatch(/read_page/)
    expect(skill.systemPrompt).toMatch(/approv/i)
    expect(skill.systemPrompt).toMatch(/boundaries/i)
    expect(skill.systemPrompt).toMatch(/read_annotation_shot/)
  })

  it('degrades to nothing when no browser tab is open', () => {
    const { skill } = skillWith([])
    expect(skill.tools).toEqual([])
    expect(skill.systemPrompt).toBe('')
    expect(skill.buildContext?.()).toBe('')
  })

  it('degrades to nothing before the first tab snapshot (bridge unavailable)', () => {
    const { skill } = skillWith(null)
    expect(skill.tools).toEqual([])
    expect(skill.systemPrompt).toBe('')
  })

  it('lists the open browser tabs as per-turn context', () => {
    const { skill } = skillWith(TABS)
    const context = skill.buildContext?.() ?? ''
    expect(context).toContain('t1 | Example Domain | (active)')
    expect(context).toContain('t2 | Search results')
  })

  it('answers a closed mid-run tab with the guiding error, not a silent one', async () => {
    const { skill } = skillWith([]) // tabs closed after the tool list was read
    const execution = await skill.executeTool(call(BROWSER_READ_PAGE_TOOL))
    expect(execution.isError).toBe(true)
    expect(execution.output).toMatch(/no browser tab is open/i)
    expect(execution.output).toMatch(/open a web page/i)
  })
})

describe('browser tool execution', () => {
  it('read_page returns the formatted outline and names the page in the summary', async () => {
    const { skill, deps } = skillWith(TABS)
    const execution = await skill.executeTool(call(BROWSER_READ_PAGE_TOOL))
    expect(deps.readPage).toHaveBeenCalledTimes(1)
    expect(execution.isError).toBeUndefined()
    expect(execution.output).toContain('# Example Domain')
    expect(execution.output).toContain('what is this?')
    expect(execution.summary).toBe('read Example Domain')
  })

  it('read errors (tab closed, page hung) surface as tool errors', async () => {
    const { skill } = skillWith(TABS, {
      readPage: () => Promise.reject(new Error('the page did not answer within 10s')),
    })
    const execution = await skill.executeTool(call(BROWSER_READ_PAGE_TOOL))
    expect(execution.isError).toBe(true)
    expect(execution.output).toMatch(/did not answer within 10s/)
  })

  it('screenshot_page attaches the capture as visual input', async () => {
    const { skill, deps } = skillWith(TABS)
    const execution = await skill.executeTool(call(BROWSER_SCREENSHOT_TOOL))
    expect(deps.screenshotPage).toHaveBeenCalledTimes(1)
    expect(execution.images).toEqual([{ base64: 'AAAA', mime: 'image/png' } satisfies AgentImage])
    expect(execution.output).toMatch(/1280×800/)
    expect(execution.output).toMatch(/attached/i)
    expect(execution.summary).toBe('screenshot Example Domain')
  })

  it('read_annotation_shot attaches the pin-time element shot as visual input', async () => {
    const { skill, deps } = skillWith(TABS)
    const execution = await skill.executeTool(
      call(BROWSER_READ_ANNOTATION_SHOT_TOOL, { id: 'ann-1' }),
    )
    expect(deps.readAnnotationShot).toHaveBeenCalledWith('ann-1')
    expect(execution.isError).toBeUndefined()
    expect(execution.images).toEqual([{ base64: 'SHOT', mime: 'image/png' } satisfies AgentImage])
    expect(execution.output).toMatch(/annotation ann-1/)
    expect(execution.output).toMatch(/320×120/)
    expect(execution.output).toMatch(/attached/i)
    expect(execution.summary).toBe('annotation shot ann-1')
  })

  it('read_annotation_shot with no shot on file answers the guiding error', async () => {
    const readAnnotationShot = vi.fn(async () => null)
    const { skill } = skillWith(TABS, { readAnnotationShot })
    const execution = await skill.executeTool(
      call(BROWSER_READ_ANNOTATION_SHOT_TOOL, { id: 'ann-gone' }),
    )
    expect(readAnnotationShot).toHaveBeenCalledWith('ann-gone')
    expect(execution.isError).toBe(true)
    expect(execution.output).toMatch(/no screenshot is on file/)
    expect(execution.output).toMatch(/read_page/)
    expect(execution.images).toBeUndefined()
  })

  it('read_annotation_shot refuses a bad id before any IPC', async () => {
    const { skill, deps } = skillWith(TABS)
    for (const input of [{}, { id: '' }, { id: 7 }, { id: 'x'.repeat(101) }]) {
      const execution = await skill.executeTool(call(BROWSER_READ_ANNOTATION_SHOT_TOOL, input))
      expect(execution.isError).toBe(true)
      expect(execution.output).toMatch(/`id`/)
      expect(execution.output).toMatch(/was not executed/)
    }
    expect(deps.readAnnotationShot).not.toHaveBeenCalled()
  })

  it('fill_field forwards selector and value, and marks a success as a mutation', async () => {
    const { skill, deps } = skillWith(TABS)
    const execution = await skill.executeTool(
      call(BROWSER_FILL_FIELD_TOOL, { selector: '#q', value: 'hello' }),
    )
    expect(deps.fillField).toHaveBeenCalledWith('#q', 'hello')
    expect(execution.mutated).toBe(true)
    expect(execution.isError).toBeUndefined()
    expect(execution.summary).toBe('filled #q')
  })

  it('fill_field refuses a missing or non-string selector/value before any IPC', async () => {
    const { skill, deps } = skillWith(TABS)
    for (const input of [
      {},
      { selector: '#q' },
      { selector: '', value: 'x' },
      { selector: 7, value: 'x' },
      { selector: '#q', value: 7 },
    ]) {
      const execution = await skill.executeTool(call(BROWSER_FILL_FIELD_TOOL, input))
      expect(execution.isError).toBe(true)
      expect(execution.output).toMatch(/selector|value/)
      expect(execution.output).toMatch(/was not executed/)
    }
    expect(deps.fillField).not.toHaveBeenCalled()
  })

  it('fill_field refuses an over-long selector (the page script never sees it)', async () => {
    const { skill, deps } = skillWith(TABS)
    const execution = await skill.executeTool(
      call(BROWSER_FILL_FIELD_TOOL, { selector: 'a'.repeat(MAX_SELECTOR_CHARS + 1), value: 'x' }),
    )
    expect(execution.isError).toBe(true)
    expect(deps.fillField).not.toHaveBeenCalled()
  })

  it('click_element forwards the selector and reports a structured failure', async () => {
    const clickElement = vi.fn(async (): Promise<BrowserActionResult> => ({
      ok: false,
      detail: 'element "#gone" was not found — the page may have changed; read the page again',
    }))
    const { skill } = skillWith(TABS, { clickElement })
    const execution = await skill.executeTool(call(BROWSER_CLICK_TOOL, { selector: '#gone' }))
    expect(clickElement).toHaveBeenCalledWith('#gone')
    expect(execution.isError).toBe(true)
    expect(execution.mutated).toBeUndefined()
    expect(execution.output).toMatch(/not found/)
  })

  it('click_element refuses a bad selector before any IPC', async () => {
    const { skill, deps } = skillWith(TABS)
    const execution = await skill.executeTool(call(BROWSER_CLICK_TOOL, { selector: '' }))
    expect(execution.isError).toBe(true)
    expect(deps.clickElement).not.toHaveBeenCalled()
  })

  it('an unknown tool name answers an error without touching the deps', async () => {
    const { skill, deps } = skillWith(TABS)
    const execution = await skill.executeTool(call('browser:navigate_page'))
    expect(execution.isError).toBe(true)
    expect(deps.readPage).not.toHaveBeenCalled()
  })
})

describe('the claimed-action guard', () => {
  const executed = (name: string, ok: boolean) => [{ name, ok }]

  it('accepts a reply whose claim matches a succeeded action call', () => {
    const { skill } = skillWith(TABS)
    expect(
      skill.verifyResponse?.('I clicked the search button', executed(BROWSER_CLICK_TOOL, true)),
    ).toBeNull()
  })

  it('corrects a claim with no action call behind it', () => {
    const { skill } = skillWith(TABS)
    const correction = skill.verifyResponse?.('I have clicked the button for you', [])
    expect(correction).toMatch(/no browser:fill_field or browser:click_element call succeeded/i)
  })

  it('a denied action call is not a success (ok stays false)', () => {
    const { skill } = skillWith(TABS)
    const correction = skill.verifyResponse?.(
      'I filled the form',
      executed(BROWSER_FILL_FIELD_TOOL, false),
    )
    expect(correction).not.toBeNull()
  })

  it('advice wording is not a claim (no correction)', () => {
    const { skill } = skillWith(TABS)
    expect(skill.verifyResponse?.('you can click the button yourself', [])).toBeNull()
    expect(skill.verifyResponse?.('the site has a "click here" link', [])).toBeNull()
  })
})

describe('the read_page budget', () => {
  const element = (i: number) => ({
    selector: `a:nth-of-type(${i})`,
    tag: 'a',
    role: 'link',
    text: `link ${i}`,
  })

  it('clips per item, caps the lists and marks the cut', () => {
    const blocks = ['y'.repeat(700), ...Array.from({ length: 79 }, (_, i) => `block ${i}`)]
    const elements = Array.from({ length: 100 }, (_, i) => element(i + 1))
    const { text, truncated } = formatPageOutline({
      url: 'https://example.com/',
      title: 't',
      textBlocks: blocks,
      elements,
    })
    // per-item clip: the 700-char block is cut to the budget with an ellipsis
    expect(text).toContain('y'.repeat(600) + '…')
    expect(text).not.toContain('y'.repeat(601))
    // list caps: 40 of 80 blocks, 60 of 100 elements
    expect(text).toContain('## Text blocks (40 of 80)')
    expect(text).toContain('## Interactive elements (60 of 100)')
    expect(text).toContain('block 38')
    expect(text).not.toContain('block 39')
    expect(truncated).toBe(true)
    // the whole outline stays inside the hard cap
    expect(text.length).toBeLessThanOrEqual(8000 + 200)
  })

  it('hard-caps the whole text with a marker when the items alone overflow', () => {
    const blocks = Array.from({ length: 40 }, () => 'x'.repeat(600))
    const { text, truncated } = formatPageOutline({
      url: 'u',
      title: 't',
      textBlocks: blocks,
      elements: [],
    })
    expect(text.length).toBeLessThanOrEqual(8000 + 200)
    expect(text).toContain('outline truncated to the read budget')
    expect(truncated).toBe(true)
  })

  it('renders annotations with their snippets and selectors, capped', () => {
    const annotations = Array.from({ length: 20 }, (_, i) => ({
      note: `note ${i}`,
      textSnippet: 's',
      selector: `p:nth-of-type(${i + 1})`,
    }))
    const { text } = formatPageOutline(
      { url: 'u', title: 't', textBlocks: [], elements: [] },
      annotations,
    )
    expect(text).toContain('## Annotations the user left on this page (12 of 20)')
    expect(text).toContain('note 0 — "s" (p:nth-of-type(1))')
    expect(text).not.toContain('note 12')
  })

  it('renders the evidence pack fields: xpath, id and the shot marker', () => {
    const { text } = formatPageOutline({ url: 'u', title: 't', textBlocks: [], elements: [] }, [
      {
        id: 'ann-1',
        note: 'what is this?',
        textSnippet: 'Hello',
        selector: 'p:nth-of-type(1)',
        xpath: '/html/body/p[1]',
        hasShot: true,
      },
      { note: 'no pack fields' },
    ])
    expect(text).toContain(
      '- what is this? — "Hello" (p:nth-of-type(1)) [xpath /html/body/p[1]] id=ann-1 · screenshot on file — browser:read_annotation_shot',
    )
    // an annotation without the pack fields renders exactly as before
    expect(text).toContain('- no pack fields')
  })

  it('clips a long xpath to the annotation budget', () => {
    const longXpath = `/${'div/'.repeat(150)}p`
    const { text } = formatPageOutline({ url: 'u', title: 't', textBlocks: [], elements: [] }, [
      { note: 'n', xpath: longXpath },
    ])
    expect(text).toContain(`[xpath ${longXpath.slice(0, 200)}…]`)
    expect(text).not.toContain(`[xpath ${longXpath}]`)
  })

  it('an unannotated page renders no annotation section', () => {
    const { text } = formatPageOutline({ url: 'u', title: 't', textBlocks: [], elements: [] })
    expect(text).not.toMatch(/annotations/i)
  })

  it('empty lists say so instead of a bare header', () => {
    const { text } = formatPageOutline({ url: 'u', title: 't', textBlocks: [], elements: [] })
    expect(text).toContain('(no readable text blocks)')
    expect(text).toContain('(no interactive elements)')
  })
})

// ── the loop integration: a tool's image output reaches the next request ────

/** transport scripted turn by turn; exposes every request it was handed */
function scriptedTransport(script: Array<(cb: AgentStreamCallbacks) => void>): {
  transport: AgentTransport
  requests: AgentMessage[][]
} {
  const requests: AgentMessage[][] = []
  let turn = 0
  const transport: AgentTransport = {
    stream(request: AgentStreamRequest, cb: AgentStreamCallbacks) {
      requests.push(request.messages.map((m) => ({ ...m })))
      const step = script[turn]
      turn += 1
      if (step) queueMicrotask(() => step(cb))
      return {
        cancel: () => {
          queueMicrotask(() => cb.onDone())
        },
      }
    },
  }
  return { transport, requests }
}

describe('the loop attaches a tool image to the next model request', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0))

  it('a screenshot tool result becomes a user-side image turn; the tool result stays text', async () => {
    const { transport, requests } = scriptedTransport([
      (cb) => {
        cb.onToolCall({ id: 't1', name: BROWSER_SCREENSHOT_TOOL, input: {} })
        cb.onDone()
      },
      (cb) => {
        cb.onDelta('the page shows a heading')
        cb.onDone()
      },
    ])
    const tools = (): AgentToolDef[] => [
      { name: BROWSER_SCREENSHOT_TOOL, description: 'd', inputSchema: { type: 'object' } },
    ]
    const skill: AgentSkill = {
      id: 'browser',
      systemPrompt: '',
      tools: tools(),
      executeTool: () => ({
        output: 'screenshot taken',
        summary: 'shot',
        images: [
          { base64: 'AAAA', mime: 'image/png' },
          { base64: 'BBBB', mime: 'image/png' },
        ],
      }),
    }
    const loop = new AgentLoop({ transport, skill })
    const handle = loop.run('describe the page')
    await flush()
    await flush()

    // request 2 (the turn after the screenshot) carries the images as a user
    // message directly after the tool results
    const second = requests[1]!
    const toolAt = second.findIndex((m) => m.role === 'tool')
    const imageAt = second.findIndex((m) => m.role === 'user' && m.images?.length)
    expect(toolAt).toBeGreaterThanOrEqual(0)
    expect(imageAt).toBe(toolAt + 1)
    const imageTurn = second[imageAt] as { text: string; images: AgentImage[] }
    expect(imageTurn.images).toHaveLength(2)
    expect(imageTurn.images[0]).toEqual({ base64: 'AAAA', mime: 'image/png' })
    expect(imageTurn.text).toMatch(/\[a tool attached an image/)
    // the model-facing tool result stays text-only
    const toolMessage = second.find((m) => m.role === 'tool')
    expect(toolMessage && toolMessage.role === 'tool' && toolMessage.results[0]!.output).toBe(
      'screenshot taken',
    )
    await expect(handle.done).resolves.toMatchObject({ text: 'the page shows a heading' })
  })

  it('runs with no image output behave exactly as before (no synthetic turn)', async () => {
    const { transport, requests } = scriptedTransport([
      (cb) => {
        cb.onToolCall({ id: 't1', name: 'plain_tool', input: {} })
        cb.onDone()
      },
      (cb) => {
        cb.onDelta('done')
        cb.onDone()
      },
    ])
    const skill: AgentSkill = {
      id: 's',
      systemPrompt: '',
      tools: [{ name: 'plain_tool', description: 'd', inputSchema: { type: 'object' } }],
      executeTool: () => ({ output: 'ok', summary: 's' }),
    }
    const loop = new AgentLoop({ transport, skill })
    const handle = loop.run('x')
    await flush()
    await flush()
    const second = requests[1]!
    expect(second.some((m) => m.role === 'user' && m.images?.length)).toBe(false)
    await expect(handle.done).resolves.toMatchObject({ text: 'done' })
  })

  it('fill_field stops at the confirmation gate: a denial never reaches the bridge', async () => {
    const { transport } = scriptedTransport([
      (cb) => {
        cb.onToolCall({
          id: 't1',
          name: BROWSER_FILL_FIELD_TOOL,
          input: { selector: '#q', value: 'hello' },
        })
        cb.onDone()
      },
      (cb) => {
        cb.onDelta('I will not fill it then')
        cb.onDone()
      },
    ])
    const fillField = vi.fn(async (): Promise<BrowserActionResult> => ({
      ok: true,
      detail: 'filled',
    }))
    const { skill } = skillWith(TABS, { fillField })
    const confirmTool = vi.fn(
      async (_call: AgentToolCall, _tool: AgentToolDef): Promise<boolean> => false,
    )
    const loop = new AgentLoop({ transport, skill, confirmTool })
    const handle = loop.run('fill the search box')
    await flush()
    await flush()

    // the gate saw the call and its tool definition carries the risk class
    expect(confirmTool).toHaveBeenCalledTimes(1)
    expect(confirmTool.mock.calls[0]![1].risk).toBe('high')
    // the bridge was never reached — nothing was typed into the page
    expect(fillField).not.toHaveBeenCalled()
    // the model got the paired do-not-retry result, not a silent gap
    const toolMessage = loop.messages.find((m) => m.role === 'tool')
    expect(toolMessage && toolMessage.role === 'tool' && toolMessage.results[0]!.isError).toBe(true)
    await expect(handle.done).resolves.toMatchObject({ text: 'I will not fill it then' })
  })

  it('click_element runs only after the gate allows it', async () => {
    const { transport } = scriptedTransport([
      (cb) => {
        cb.onToolCall({ id: 't1', name: BROWSER_CLICK_TOOL, input: { selector: '#go' } })
        cb.onDone()
      },
      (cb) => {
        cb.onDelta('clicked it for you')
        cb.onDone()
      },
    ])
    const clickElement = vi.fn(async (): Promise<BrowserActionResult> => ({
      ok: true,
      detail: 'clicked Go',
    }))
    const { skill } = skillWith(TABS, { clickElement })
    const loop = new AgentLoop({ transport, skill, confirmTool: async () => true })
    const handle = loop.run('click the button')
    await flush()
    await flush()
    expect(clickElement).toHaveBeenCalledWith('#go')
    await expect(handle.done).resolves.toMatchObject({ text: 'clicked it for you' })
  })
})

describe('the new page tools (movement, download, history, wait, key, annotations)', () => {
  it('scroll_page forwards direction, amount and selector, and the result rides the action shape', async () => {
    const { skill, deps } = skillWith(TABS)
    const result = await skill.executeTool(
      call(BROWSER_SCROLL_TOOL, { direction: 'down', amount: 800 }),
    )
    expect(deps.scrollPage).toHaveBeenCalledWith('down', 800, undefined)
    expect(result.isError).toBeUndefined()
    expect(result.output).toContain('scrolled')
    // a bare call defaults to a screen down
    await skill.executeTool(call(BROWSER_SCROLL_TOOL, {}))
    expect(deps.scrollPage).toHaveBeenLastCalledWith(undefined, undefined, undefined)
  })

  it('scroll_page validates its arguments before the bridge', async () => {
    const { skill, deps } = skillWith(TABS)
    for (const [input, message] of [
      [{ direction: 'sideways' }, /direction/],
      [{ amount: -5 }, /amount/],
      [{ amount: 500_000 }, /at most/],
      [{ selector: 'x'.repeat(501) }, /at most/],
    ] as const) {
      const result = await skill.executeTool(
        call(BROWSER_SCROLL_TOOL, input as Record<string, unknown>),
      )
      expect(result.isError, JSON.stringify(input)).toBe(true)
      expect(result.output, JSON.stringify(input)).toMatch(message as RegExp)
    }
    expect(deps.scrollPage).not.toHaveBeenCalled()
  })

  it('download_file answers the saved path and refuses a call naming neither argument', async () => {
    const { skill } = skillWith(TABS)
    const saved = await skill.executeTool(
      call(BROWSER_DOWNLOAD_TOOL, { url: 'https://example.com/x.zip' }),
    )
    expect(saved.isError).toBeUndefined()
    expect(saved.output).toContain('/userData/Downloads/report.pdf')
    expect(saved.output).toContain('2048 bytes')
    const neither = await skill.executeTool(call(BROWSER_DOWNLOAD_TOOL, {}))
    expect(neither.isError).toBe(true)
    expect(neither.output).toMatch(/either `url`/)
  })

  it('the history verbs and press_key forward to the bridge and validate', async () => {
    const { skill, deps } = skillWith(TABS)
    await skill.executeTool(call(BROWSER_GO_BACK_TOOL, {}))
    await skill.executeTool(call(BROWSER_GO_FORWARD_TOOL, {}))
    await skill.executeTool(call(BROWSER_RELOAD_TOOL, {}))
    expect(deps.navigateHistory).toHaveBeenNthCalledWith(1, 'back')
    expect(deps.navigateHistory).toHaveBeenNthCalledWith(2, 'forward')
    expect(deps.navigateHistory).toHaveBeenNthCalledWith(3, 'reload')
    const pressed = await skill.executeTool(call(BROWSER_PRESS_KEY_TOOL, { key: 'tab' }))
    expect(deps.pressKey).toHaveBeenCalledWith('tab')
    expect(pressed.isError).toBeUndefined()
    const refused = await skill.executeTool(call(BROWSER_PRESS_KEY_TOOL, { key: 'q' }))
    expect(refused.isError).toBe(true)
    expect(refused.output).toMatch(/fill_field/)
  })

  it('wait_for forwards the selector and timeout, and the cap is a refusal', async () => {
    const { skill, deps } = skillWith(TABS)
    await skill.executeTool(call(BROWSER_WAIT_FOR_TOOL, { selector: '.r', timeoutMs: 2500 }))
    expect(deps.waitFor).toHaveBeenCalledWith('.r', 2500)
    const capped = await skill.executeTool(call(BROWSER_WAIT_FOR_TOOL, { timeoutMs: 30_000 }))
    expect(capped.isError).toBe(true)
    expect(capped.output).toMatch(/at most 10000/)
    expect(deps.waitFor).toHaveBeenCalledTimes(1)
    // a wait observes: never marked mutated
    const waited = await skill.executeTool(call(BROWSER_WAIT_FOR_TOOL, {}))
    expect(waited.mutated).toBeUndefined()
  })

  it('list_annotations renders the marker list; clear answers the dropped count', async () => {
    const { skill } = skillWith(TABS)
    const listed = await skill.executeTool(call(BROWSER_LIST_ANNOTATIONS_TOOL, {}))
    expect(listed.output).toContain('ann-1')
    expect(listed.output).toContain('the search box')
    expect(listed.output).toContain('screenshot on file')
    const cleared = await skill.executeTool(call(BROWSER_CLEAR_ANNOTATIONS_TOOL, {}))
    expect(cleared.output).toContain('dropped 2 annotations')
    expect(cleared.mutated).toBe(true)
    // the annotations are absent with no browser tab
    const { skill: empty } = skillWith([])
    const degraded = await empty.executeTool(call(BROWSER_LIST_ANNOTATIONS_TOOL, {}))
    expect(degraded.isError).toBe(true)
    expect(degraded.output).toContain('no browser tab is open')
  })
})
