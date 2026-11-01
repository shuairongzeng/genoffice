import type { AgentImage, AgentToolCall, AgentToolDef, ToolExecution } from './types'
import type { AgentSkill, ExecutedToolCall } from './skill'

/**
 * The desktop loop's browser skill (charter workstream W2b): read and — behind
 * the confirmation gate — act on the page in the desktop browser's *active*
 * tab. The loop lives in the dock's renderer; every tool call crosses IPC into
 * the shell main, which resolves the active tab's page webContents and runs
 * the page-side script there (see apps/shell/src/main/browser-agent.ts).
 *
 * The gate mirrors the proxied-apps skill: the host injects a live snapshot of
 * the open browser tabs, the tools exist only while at least one is open, and
 * a tab closed mid-run degrades to a guiding error instead of a failed
 * mystery. Unlike the proxied apps, this surface is not read-only: fill_field
 * and click_element change the live page, so both carry risk:'high' and stop
 * at the host's confirmTool gate (the dock's allow/deny card). The actions'
 * read-only twin, read_annotation_shot, pulls one annotation's pin-time
 * screenshot off the suite's own disk — as risk-free as read_page itself.
 */

/** tool names, prefixed so composeSkills never sees a collision */
export const BROWSER_READ_PAGE_TOOL = 'browser:read_page'
export const BROWSER_SCREENSHOT_TOOL = 'browser:screenshot_page'
export const BROWSER_READ_ANNOTATION_SHOT_TOOL = 'browser:read_annotation_shot'
export const BROWSER_FILL_FIELD_TOOL = 'browser:fill_field'
export const BROWSER_CLICK_TOOL = 'browser:click_element'

/** one browser tab, as the dock's tab strip reports it to the loop */
export interface BrowserTabSnapshot {
  id: string
  title: string
  active: boolean
}

/**
 * One annotation the user left on a page with the browser's "ask AI" entry
 * (W2a). The shape is the browser side's contract: the fields are optional
 * because the entry may be a bare highlight; the consumer renders whatever is
 * there and never assumes a field.
 */
export interface BrowserPageAnnotation {
  /** the annotation's stable id — the key `read_annotation_shot` takes */
  id?: string
  selector?: string
  /** the element's absolute XPath (`/html/body/…`) — the twin of the selector */
  xpath?: string
  textSnippet?: string
  note?: string
  url?: string
  /** true when a pin-time element shot exists (fetch it with `read_annotation_shot`) */
  hasShot?: boolean
  /**
   * The shot's path relative to the browser's userData — carried by the
   * `browser:ask-about` push for the Ask AI card's thumbnail; never sent to
   * the model (the id-keyed tool is the model's only way in).
   */
  shotPath?: string
}

/** one interactive element of the page outline, with the selector to address it */
export interface BrowserOutlineElement {
  /** CSS selector that resolves this element (fill_field/click_element take it) */
  selector: string
  tag: string
  /** coarse role: link, button, input, select, textarea… */
  role: string
  /** trimmed label, value or placeholder text */
  text: string
  /** an input's type attribute, when it has one */
  type?: string
}

/** the raw page outline as the injected page script reports it */
export interface BrowserOutlineData {
  url: string
  title: string
  textBlocks: string[]
  elements: BrowserOutlineElement[]
}

/** what a successful read_page answers over the bridge */
export interface BrowserPageRead {
  url: string
  title: string
  /** the formatted outline (budget applied) */
  outline: string
  /** the page's annotations, as the browser side reported them */
  annotations: BrowserPageAnnotation[]
  /** true when the outline had to be cut to fit the budget */
  truncated?: boolean
}

/** what a successful screenshot_page answers over the bridge */
export interface BrowserScreenshot {
  url: string
  title: string
  base64: string
  mime: string
  width: number
  height: number
}

/**
 * What a successful `read_annotation_shot` answers: one annotation's pin-time
 * element shot as raw image bytes. `id` echoes the annotation it belongs to.
 */
export interface BrowserAnnotationShot {
  id: string
  base64: string
  mime: string
  width: number
  height: number
}

/** what fill_field / click_element answer over the bridge */
export interface BrowserActionResult {
  ok: boolean
  /** human-readable outcome, or the structured reason the action did not land */
  detail: string
}

export interface BrowserSkillDeps {
  /**
   * The open browser tabs right now; null before the first refresh or when the
   * bridge is unavailable. Tools exist only while the list is non-empty.
   */
  openTabs(): readonly BrowserTabSnapshot[] | null
  readPage(): Promise<BrowserPageRead>
  screenshotPage(): Promise<BrowserScreenshot>
  /**
   * One annotation's pin-time element shot, by annotation id — null when the
   * id is unknown, the record has no shot, or the file is gone. Read-only and
   * risk-free: the bytes come from the suite's own shots directory.
   */
  readAnnotationShot(id: string): Promise<BrowserAnnotationShot | null>
  fillField(selector: string, value: string): Promise<BrowserActionResult>
  clickElement(selector: string): Promise<BrowserActionResult>
}

// ── the read_page budget ───────────────────────────────────────────────────

/** how much of a page read_page may put in front of the model */
export const READ_PAGE_BUDGET = {
  /** per text block */
  blockChars: 600,
  /** text blocks kept */
  blocks: 40,
  /** interactive elements kept */
  elements: 60,
  /** per element label */
  elementChars: 120,
  /** whole outline, a hard cap */
  totalChars: 8000,
  /** annotations kept (a page the reader marked up heavily) */
  annotations: 12,
  /** per annotation field */
  annotationChars: 200,
} as const

/**
 * Render the page outline as model-facing text within the budget: every item
 * is clipped per-item, the lists are capped, and the whole text is hard-cut at
 * totalChars with a marker so the model knows it saw a budgeted view, not the
 * whole page. Pure — the shell main calls it on the injected script's answer,
 * the tests pin the caps.
 */
export function formatPageOutline(
  data: BrowserOutlineData,
  annotations: readonly BrowserPageAnnotation[] = [],
  budget: typeof READ_PAGE_BUDGET = READ_PAGE_BUDGET,
): { text: string; truncated: boolean } {
  const clip = (text: string, max: number): string =>
    text.length > max ? `${text.slice(0, max)}…` : text
  const lines: string[] = []
  lines.push(`# ${clip(data.title || '(untitled page)', budget.annotationChars)}`)
  lines.push(`URL: ${data.url || '(no URL)'}`)
  lines.push('')
  const blocks = data.textBlocks.slice(0, budget.blocks).map((b) => clip(b, budget.blockChars))
  lines.push(
    `## Text blocks (${blocks.length}${blocks.length < data.textBlocks.length ? ` of ${data.textBlocks.length}` : ''})`,
  )
  if (blocks.length === 0) lines.push('(no readable text blocks)')
  for (const block of blocks) lines.push(`- ${block}`)
  lines.push('')
  const elements = data.elements.slice(0, budget.elements).map((e) => ({
    ...e,
    text: clip(e.text, budget.elementChars),
  }))
  lines.push(
    `## Interactive elements (${elements.length}${elements.length < data.elements.length ? ` of ${data.elements.length}` : ''})`,
  )
  if (elements.length === 0) lines.push('(no interactive elements)')
  for (const e of elements) {
    const extra = [e.type ? `type=${e.type}` : null, e.text ? `"${e.text}"` : null]
      .filter(Boolean)
      .join(' ')
    lines.push(`- ${e.selector}  (${e.role}${extra ? ` · ${extra}` : ''})`)
  }
  if (annotations.length > 0) {
    lines.push('')
    const kept = annotations.slice(0, budget.annotations)
    lines.push(
      `## Annotations the user left on this page (${kept.length}${kept.length < annotations.length ? ` of ${annotations.length}` : ''})`,
    )
    for (const a of kept) {
      const note = a.note ? clip(a.note, budget.annotationChars) : ''
      const snippet = a.textSnippet ? clip(a.textSnippet, budget.annotationChars) : ''
      const where = a.selector ? ` (${a.selector})` : ''
      // the evidence pack's addressing half: the XPath rides along, and the
      // shot marker tells the model the id is fetchable as an image
      const xpath = a.xpath ? ` [xpath ${clip(a.xpath, budget.annotationChars)}]` : ''
      const id = a.id ? ` id=${a.id}` : ''
      const shot = a.hasShot ? ` · screenshot on file — browser:read_annotation_shot` : ''
      lines.push(
        `- ${[note, snippet && `"${snippet}"`].filter(Boolean).join(' — ') || '(unlabeled)'}${where}${xpath}${id}${shot}`,
      )
    }
  }
  let text = lines.join('\n')
  let truncated =
    blocks.length < data.textBlocks.length ||
    elements.length < data.elements.length ||
    annotations.length > budget.annotations
  if (text.length > budget.totalChars) {
    text = `${text.slice(0, budget.totalChars)}\n…(outline truncated to the read budget — narrow the question, or take a screenshot for the rest)`
    truncated = true
  }
  return { text, truncated }
}

// ── the skill ──────────────────────────────────────────────────────────────

const BROWSER_SKILL_PROMPT = `## The desktop's web browser (the active browser tab)
The desktop's browser app is open; these tools see and act on its *active* tab
(the tab currently in front). Each turn's context lists the open browser tabs.
- Read before you act: browser:read_page returns the page's outline — title,
  URL, text blocks, and every interactive element with the CSS selector that
  addresses it — plus the annotations the user left on the page (each with its
  selector, XPath and id, and a marker when a pin-time screenshot of the
  annotated element exists). Selectors from that list are the addressing key
  for the action tools; inventing one usually fails with "element not found".
- browser:screenshot_page attaches a screenshot of the page to the next turn as
  visual input — use it when the outline cannot answer a visual question.
- browser:read_annotation_shot attaches the screenshot the user's annotation
  was pinned with (the element as it looked when they marked it) — call it with
  an annotation id from read_page whose line says a screenshot is on file. It
  is a read from the suite's own disk; it never touches the live page.
- browser:fill_field and browser:click_element change the live page. Both are
  risk-gated: the user approves each call before it runs, a denial means "do
  not retry as-is", and a page that changed since the read fails with a
  structured error — re-read the page, then retry with a selector from the new
  outline.
- The tools follow the open tabs: with no browser tab open they are absent from
  the tool list — ask the user to open a web page in the desktop's browser
  (the Web tile on the desktop, or + in the tab strip) instead of retrying, and
  never claim a page action that no tool call performed.
- Boundaries: only the active tab's top document is visible (no cross-origin
  iframes, no other tabs, no page source); the tools never navigate, download
  or open new tabs, and cannot log in for the user. If the person means a
  different page, ask them to switch to that tab first.`

const DEGRADED = (tool: string): ToolExecution => ({
  output:
    `${tool} is not available: no browser tab is open right now. Ask the user to open ` +
    "a web page in the desktop's browser (the Web tile on the desktop, or + in the tab " +
    'strip) and try again once one is open.',
  isError: true,
  summary: tool,
})

/** longest selector/value the tools accept (the loop's own schema check is per-type) */
export const MAX_SELECTOR_CHARS = 500
export const MAX_FILL_VALUE_CHARS = 10_000
/** longest annotation id read_annotation_shot accepts (ids are uuid-shaped) */
export const MAX_ANNOTATION_ID_CHARS = 100

const INPUT_TOOLS: Record<string, AgentToolDef> = {
  [BROWSER_FILL_FIELD_TOOL]: {
    name: BROWSER_FILL_FIELD_TOOL,
    description:
      'Type a value into a field of the active browser page. `selector` must come from a ' +
      'previous browser:read_page (its interactive-elements list) or a page annotation. ' +
      'Changes the live page — the user approves each call before it runs.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: "CSS selector of the field to fill, from read_page's element list",
        },
        value: { type: 'string', description: 'text to type into the field' },
      },
      required: ['selector', 'value'],
    },
    risk: 'high',
  },
  [BROWSER_CLICK_TOOL]: {
    name: BROWSER_CLICK_TOOL,
    description:
      'Click an element of the active browser page. `selector` must come from a previous ' +
      'browser:read_page (its interactive-elements list) or a page annotation. Changes the ' +
      'live page — the user approves each call before it runs.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: "CSS selector of the element to click, from read_page's element list",
        },
      },
      required: ['selector'],
    },
    risk: 'high',
  },
}

// save-only phrasing, as in cli-skill: "click"/"fill" also appear in advice
const CLAIMS_ACTED =
  /\bI(?:'ve| have)? (?:click(?:ed)?|fill(?:ed)?|typ(?:ed|ped)|submitt(?:ed)|press(?:ed)|enter(?:ed))\b|\b(?:has been|have been) (?:click(?:ed)|fill(?:ed)|submitt(?:ed))\b/i

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Compose the browser skill. The deps are the dock's IPC bridges; everything
 * Electron-shaped (tab resolution, page scripts, capturePage) lives behind
 * them in the shell main, so this module stays dependency-free and the tests
 * inject fakes.
 */
export function createBrowserSkill(deps: BrowserSkillDeps): AgentSkill {
  return {
    id: 'browser',
    // no browser tab open: no prompt section and no tools, so the model is not
    // offered an action it cannot aim (the same live-manifest degradation the
    // proxied-apps skill uses)
    get systemPrompt() {
      return deps.openTabs()?.length ? BROWSER_SKILL_PROMPT : ''
    },
    get tools(): AgentToolDef[] {
      if (!deps.openTabs()?.length) return []
      return [
        {
          name: BROWSER_READ_PAGE_TOOL,
          description:
            'Read the outline of the active browser page: title, URL, main text blocks and ' +
            'every interactive element with its CSS selector, plus the annotations the user ' +
            'left on the page (selector, XPath, id, and which carry a screenshot). Read this ' +
            'before acting on a page.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: BROWSER_SCREENSHOT_TOOL,
          description:
            'Capture a screenshot of the active browser page and attach it as an image to ' +
            'the conversation (visual input). Use it when the text outline cannot answer a ' +
            'visual question about the page.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: BROWSER_READ_ANNOTATION_SHOT_TOOL,
          description:
            'Attach the pin-time screenshot of one annotation the user left on a browser ' +
            'page — the annotated element exactly as it looked when they marked it. `id` must ' +
            'come from a browser:read_page annotation line marked "screenshot on file". ' +
            'Read-only; the live page is not touched.',
          inputSchema: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: "the annotation id from read_page's annotation line",
              },
            },
            required: ['id'],
          },
        },
        INPUT_TOOLS[BROWSER_FILL_FIELD_TOOL]!,
        INPUT_TOOLS[BROWSER_CLICK_TOOL]!,
      ]
    },
    buildContext: () => {
      const tabs = deps.openTabs()
      if (!tabs || tabs.length === 0) return ''
      const lines = tabs
        .map((t) => `${t.id} | ${t.title || '(untitled tab)'}${t.active ? ' | (active)' : ''}`)
        .join('\n')
      return `Open browser tabs (tab id | title):\n${lines}`
    },
    executeTool: async (call: AgentToolCall): Promise<ToolExecution> => {
      if (!deps.openTabs()?.length) return DEGRADED(call.name)
      try {
        switch (call.name) {
          case BROWSER_READ_PAGE_TOOL:
            return await executeRead(deps)
          case BROWSER_SCREENSHOT_TOOL:
            return await executeScreenshot(deps)
          case BROWSER_READ_ANNOTATION_SHOT_TOOL: {
            const id = call.input.id
            if (typeof id !== 'string' || !id.trim()) {
              return badInput(
                BROWSER_READ_ANNOTATION_SHOT_TOOL,
                '`id` must be a non-empty string (an annotation id from read_page)',
              )
            }
            if (id.length > MAX_ANNOTATION_ID_CHARS) {
              return badInput(
                BROWSER_READ_ANNOTATION_SHOT_TOOL,
                `\`id\` must be at most ${MAX_ANNOTATION_ID_CHARS} characters`,
              )
            }
            return await executeReadShot(deps, id)
          }
          case BROWSER_FILL_FIELD_TOOL: {
            const selector = call.input.selector
            const value = call.input.value
            if (typeof selector !== 'string' || !selector.trim()) {
              return badInput(BROWSER_FILL_FIELD_TOOL, '`selector` must be a non-empty string')
            }
            if (typeof value !== 'string') {
              return badInput(BROWSER_FILL_FIELD_TOOL, '`value` must be a string')
            }
            if (selector.length > MAX_SELECTOR_CHARS) {
              return badInput(
                BROWSER_FILL_FIELD_TOOL,
                `\`selector\` must be at most ${MAX_SELECTOR_CHARS} characters`,
              )
            }
            if (value.length > MAX_FILL_VALUE_CHARS) {
              return badInput(
                BROWSER_FILL_FIELD_TOOL,
                `\`value\` must be at most ${MAX_FILL_VALUE_CHARS} characters`,
              )
            }
            return await executeAction(
              await deps.fillField(selector, value),
              `filled ${describeTarget(selector)}`,
            )
          }
          case BROWSER_CLICK_TOOL: {
            const selector = call.input.selector
            if (typeof selector !== 'string' || !selector.trim()) {
              return badInput(BROWSER_CLICK_TOOL, '`selector` must be a non-empty string')
            }
            if (selector.length > MAX_SELECTOR_CHARS) {
              return badInput(
                BROWSER_CLICK_TOOL,
                `\`selector\` must be at most ${MAX_SELECTOR_CHARS} characters`,
              )
            }
            return await executeAction(
              await deps.clickElement(selector),
              `clicked ${describeTarget(selector)}`,
            )
          }
          default:
            return {
              output: `unknown browser tool: ${call.name}`,
              isError: true,
              summary: call.name,
            }
        }
      } catch (error) {
        // the tab closed, the page hung, the bridge is stale: the reason is the
        // tool result so the model can pick another move instead of retrying
        return { output: errorMessage(error), isError: true, summary: call.name }
      }
    },
    verifyResponse: (finalText, executed: readonly ExecutedToolCall[]) => {
      const acted = executed.some(
        (c) => (c.name === BROWSER_FILL_FIELD_TOOL || c.name === BROWSER_CLICK_TOOL) && c.ok,
      )
      if (acted || !CLAIMS_ACTED.test(finalText)) return null
      return (
        'The reply claims a page element was clicked or filled, but no browser:fill_field or ' +
        'browser:click_element call succeeded in this run. Say plainly that nothing was ' +
        'changed on the page, or perform the action first.'
      )
    },
  }
}

async function executeRead(deps: BrowserSkillDeps): Promise<ToolExecution> {
  const read = await deps.readPage()
  const label = read.title || read.url || 'the page'
  return {
    output: read.outline,
    summary: `read ${label}`,
  }
}

async function executeScreenshot(deps: BrowserSkillDeps): Promise<ToolExecution> {
  const shot = await deps.screenshotPage()
  const label = shot.title || shot.url || 'the page'
  const images: AgentImage[] = [{ base64: shot.base64, mime: shot.mime }]
  return {
    output:
      `Screenshot of "${label}" (${shot.url}) at ${shot.width}×${shot.height} — the image is ` +
      'attached to the conversation as visual input. Describe what you need from it in your ' +
      'own words; do not repeat this notice.',
    summary: `screenshot ${label}`,
    images,
  }
}

async function executeReadShot(deps: BrowserSkillDeps, id: string): Promise<ToolExecution> {
  const shot = await deps.readAnnotationShot(id)
  if (shot === null) {
    return {
      output:
        `no screenshot is on file for annotation ${id} — it was pinned without one, deleted, ` +
        'or the id does not match a read_page annotation line. Re-read the page and use an id ' +
        'from a line marked "screenshot on file", or fall back to browser:screenshot_page for ' +
        'the live page.',
      isError: true,
      summary: 'annotation shot missing',
    }
  }
  const images: AgentImage[] = [{ base64: shot.base64, mime: shot.mime }]
  return {
    output:
      `The pin-time screenshot of annotation ${shot.id} (${shot.width}×${shot.height}) — the ` +
      'annotated element exactly as it looked when the user marked it — is attached as visual ' +
      'input. Describe what you need from it in your own words; do not repeat this notice.',
    summary: `annotation shot ${shot.id}`,
    images,
  }
}

async function executeAction(result: BrowserActionResult, summary: string): Promise<ToolExecution> {
  if (result.ok) {
    return { output: result.detail, summary, mutated: true }
  }
  return { output: result.detail, isError: true, summary: 'page action failed' }
}

function badInput(tool: string, message: string): ToolExecution {
  return {
    output: `${message}; the tool was not executed. Call again with the corrected argument.`,
    isError: true,
    summary: tool,
  }
}

function describeTarget(selector: string): string {
  return selector.length > 80 ? `${selector.slice(0, 80)}…` : selector
}
