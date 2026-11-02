import type { AgentToolCall, ToolExecution } from './types'
import type { AgentSkill } from './skill'

/**
 * The dock's shell operator skill: the surface context plus the desktop's own
 * action tools. Two halves, one skill:
 *
 * - The system prompt's "current surface" section is LIVE — the panel keeps a
 *   tab snapshot in a ref (refreshed per send, and on every tab change the
 *   mount can hear), and the loop re-reads the composed prompt before every
 *   model request, so the model always knows which tab the person is looking
 *   at, which document is open, and what else is a `switch_tab` away. The
 *   section is an English scaffold regardless of UI locale, like every other
 *   skill prompt (the evidence-line precedent).
 * - The tools act on the desktop: open a browser tab, navigate the active one,
 *   list and switch tabs, open a local file. They are UNGATED on purpose: each
 *   is a direct execution of the person's instruction, immediately visible in
 *   the interface, and trivially reversible (a tab closes, a navigation goes
 *   back) — the risk grade the browser page actions (fill_field /
 *   click_element) carry exists because those change a live page's *content*
 *   in ways the person cannot see coming; opening or switching a tab is the
 *   visible act itself. The URL tools still refuse non-web schemes
 *   (agent-driven loads are http/https only — the navigation policy's rules,
 *   applied main-side where the load happens).
 *
 * The executors cross IPC into the shell main (browser-agent.ts — the dock's
 * agent channel, whose sender gate already serves both panel mounts); the deps
 * here are the renderer's bridges, injected so this module stays
 * dependency-free and the tests fake them.
 */

/** tool names, prefixed so composeSkills never sees a collision */
export const SHELL_OPEN_BROWSER_TOOL = 'shell:open_browser'
export const SHELL_NAVIGATE_TOOL = 'shell:navigate'
export const SHELL_LIST_TABS_TOOL = 'shell:list_tabs'
export const SHELL_SWITCH_TAB_TOOL = 'shell:switch_tab'
export const SHELL_OPEN_PATH_TOOL = 'shell:open_path'

/** longest url/path/id argument the tools accept (the loop's schema check is per-type) */
export const MAX_SHELL_URL_CHARS = 2000
export const MAX_SHELL_PATH_CHARS = 4096
export const MAX_SHELL_TAB_ID_CHARS = 200

/**
 * Surface-section budget: every field the section renders is capped (a huge
 * or hostile title/url/path cannot bloat the ambient prompt), and the tab
 * list stops after the active tab plus this many more — the rest fold into
 * the "… and N more" line. list_tabs (an explicit enumeration the model
 * calls for) stays complete; the section is context that rides every turn.
 */
export const MAX_SURFACE_TITLE_CHARS = 120
export const MAX_SURFACE_URL_CHARS = 200
export const MAX_SURFACE_PATH_CHARS = 300
export const MAX_SURFACE_TABS = 8

/**
 * One open tab as the surface context reports it: the shell strip's tabs and
 * the detached editor windows both satisfy it. `url` rides browser tabs (the
 * page's current address), `filePath` document tabs (absent while untitled).
 */
export interface SurfaceTab {
  id: string
  /** the tab's app family: home, browser, docs, sheets, slides, pdf, markdown, html, help */
  kind: string
  title: string
  active: boolean
  /** browser tabs: the page's current URL */
  url?: string
  /** document tabs: the absolute path behind the tab (absent while untitled) */
  filePath?: string
  /** the tab lives in its own OS window (a detached editor) */
  detached?: boolean
}

/** which mount's panel copy this skill serves — the visibility line differs */
export type SurfaceViewer = 'home' | 'overlay' | 'docked'

/** document kinds whose apps host no delegable agent (docs is the one that does) */
const DOCUMENT_KINDS_WITHOUT_AGENT = new Set(['sheets', 'slides', 'pdf', 'markdown', 'html'])

/** a compact kind label for the section (the model reads it; English by design) */
function kindLabel(kind: string): string {
  if (kind === 'home') return 'home (desktop)'
  return kind
}

/**
 * Control and invisible format characters — newlines, zero-widths, bidi
 * overrides and isolates — never ride a prompt line: a tab title or file name
 * is data the model reads, not a place to smuggle structure (the strip covers
 * the whole Cc/Cf classes, so no invisible codepoint slips past a named one).
 */
const INVISIBLE_CHARS = /[\p{Cc}\p{Cf}]/gu

/** one rendered field: invisible characters stripped, then length-capped */
function fieldOf(value: string | undefined, max: number): string {
  const clean = (value ?? '').replace(INVISIBLE_CHARS, '')
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

/**
 * A browser tab's site name — what background tabs contribute to the ambient
 * section. The active tab keeps its full URL (the model acts on it); a
 * background tab's full URL — query strings and fragments can carry tokens —
 * is breadth the prompt does not need.
 */
function hostOnly(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}

/** one tab's line in the open-tabs list; `background` trims a browser tab's URL to its host */
function tabLine(tab: SurfaceTab, background: boolean): string {
  const where =
    tab.url !== undefined && tab.url !== ''
      ? background
        ? hostOnly(tab.url)
        : fieldOf(tab.url, MAX_SURFACE_URL_CHARS)
      : tab.filePath !== undefined && tab.filePath !== ''
        ? fieldOf(tab.filePath, MAX_SURFACE_PATH_CHARS)
        : '(untitled)'
  const marks = [tab.active ? 'active' : null, tab.detached ? 'own window' : null]
    .filter(Boolean)
    .join(', ')
  const title = fieldOf(tab.title, MAX_SURFACE_TITLE_CHARS)
  return `- ${fieldOf(tab.id, MAX_SHELL_TAB_ID_CHARS)} | ${kindLabel(tab.kind)} | ${title || '(untitled)'} | ${where}${marks ? ` | ${marks}` : ''}`
}

/**
 * The tabs the section lists: the active one always, the rest in the sources'
 * order (the strip's, then the detached windows' — a recency stand-in) up to
 * the budget. When the active tab sits past the cut, it takes the last slot:
 * the line the model reasons from must survive the cap.
 */
function listedTabs(tabs: readonly SurfaceTab[]): SurfaceTab[] {
  if (tabs.length <= MAX_SURFACE_TABS) return [...tabs]
  const kept = tabs.slice(0, MAX_SURFACE_TABS)
  const active = tabs.find((t) => t.active)
  if (active && !kept.includes(active)) kept[MAX_SURFACE_TABS - 1] = active
  return kept
}

/**
 * The "current surface" section: the active tab in one line, the open tabs
 * beneath, and the visibility line that says which of them the person is
 * actually looking at (Home's copy sits on the desktop surface; the overlay's
 * copy floats over the active tab). Pure — the panel feeds the live snapshot,
 * the tests pin the shape. Returns '' when no snapshot has landed yet.
 *
 * The section is ambient context (it rides every model request), so it is
 * budgeted: fields are sanitized and capped, background browser tabs show
 * only their host, and the list stops at {@link MAX_SURFACE_TABS} tabs with a
 * "… and N more" line for the rest.
 */
export function formatSurfaceSection(
  tabs: readonly SurfaceTab[] | null,
  viewer: SurfaceViewer,
): string {
  if (tabs === null || tabs.length === 0) {
    // no snapshot (or nothing open): say so rather than nothing — the model
    // must not invent a surface
    return [
      '## Current surface',
      viewer === 'home'
        ? 'The AI panel is docked to the Home desktop; no tab state is available right now.'
        : 'The AI panel floats over the workspace; no tab state is available right now.',
    ].join('\n')
  }
  const active = tabs.find((t) => t.active) ?? null
  const lines: string[] = ['## Current surface']
  if (active) {
    const where =
      active.url !== undefined && active.url !== ''
        ? fieldOf(active.url, MAX_SURFACE_URL_CHARS)
        : active.filePath !== undefined && active.filePath !== ''
          ? fieldOf(active.filePath, MAX_SURFACE_PATH_CHARS)
          : '(untitled)'
    lines.push(
      `Active tab: ${kindLabel(active.kind)} — "${fieldOf(active.title, MAX_SURFACE_TITLE_CHARS) || '(untitled)'}" (${where})`,
    )
  } else {
    lines.push('No tab is active (the workspace may be empty).')
  }
  lines.push('Open tabs (id | kind | title | url or file):')
  const listed = listedTabs(tabs)
  for (const tab of listed) lines.push(tabLine(tab, tab !== active))
  if (tabs.length > listed.length) lines.push(`… and ${tabs.length - listed.length} more`)
  // the decisive routing line: while a Word document is the active tab, tasks
  // about it belong to the app's own agent — the section names where the
  // person's attention is, so it also names where the work goes. Only docs
  // can be delegated to: the other document kinds get the honest rule (the
  // document-agent bridge's own message — switch to a docs tab or edit in
  // the app), not a promise document_agent cannot keep
  if (active && active.kind === 'docs') {
    lines.push(
      'This is the Word document the person is working in — tasks about its content go through document_agent, never a file rewrite.',
    )
  } else if (active && DOCUMENT_KINDS_WITHOUT_AGENT.has(active.kind)) {
    lines.push(
      `This ${kindLabel(active.kind)} document belongs to its app — document_agent only works on a Word document; tell the person to edit it there, or switch to a docs tab first (shell:switch_tab).`,
    )
  }
  lines.push(
    viewer === 'home'
      ? 'The person is looking at the Home desktop; the AI panel is docked beside it.'
      : viewer === 'docked'
        ? "The AI panel is docked into the document app's own panel slot beside the active tab; the person is looking at that tab."
        : 'The AI panel floats over the workspace; the person is looking at the active tab above.',
  )
  return lines.join('\n')
}

const SHELL_TOOLS_PROMPT = `## Operating the desktop (tabs, browser, files)
You can act on the workspace itself, not only answer about it:
- shell:open_browser opens a new browser tab (an optional url pre-loads it) and
  makes it active — the browser read tools then see its page. It works even
  when no browser tab is open yet.
- shell:navigate loads a url into the ACTIVE browser tab — the one the person
  is looking at, never a background one. When no browser tab is active, make
  one first (shell:open_browser for a new tab, shell:switch_tab for an
  existing one). A bare domain gets https, and only http/https addresses load.
  Its result carries the page's final url after redirects; read it with
  browser:read_page to see what landed.
- shell:list_tabs lists the open tabs (id, kind, title, url or file, active).
- shell:switch_tab activates one tab by its id from shell:list_tabs.
- shell:open_path opens a local file into its app tab (docs, sheets, slides,
  pdf, markdown, html). The path must be absolute and inside the desktop's
  file scope — a starred or recent file, a file in a knowledge folder, or an
  indexed file; anything else is refused, so ask the person to open it
  themselves instead.
These are direct acts the person can see and undo, so they run without a
confirmation step; use them when the person asks for exactly that ("open the
browser", "go to this address", "open that file"), and say what you did.

## Routing your actions (decide this before choosing any tool)
- The active tab is an open document and the task is about that document →
  ALWAYS delegate with document_agent. NEVER rewrite, replace or delete a
  file an app has open (create_document, edit_file, delete_file): the file on
  disk would fork from the live document the person is looking at.
- edit_file and delete_file are for plain text files that are NOT open in any
  app (notes, scripts, configs). A path that is open in a tab belongs to its
  app — a Word document goes through document_agent; other kinds, tell the
  person to edit them in their app.
- The active tab is a browser page → work on its content with the browser
  tools; steer it with shell:navigate.
- Opening things, switching tabs, or files nobody has open → the shell tools
  above.`

export interface ShellSkillDeps {
  /** the live surface snapshot; null before the first pull lands */
  surfaceTabs(): readonly SurfaceTab[] | null
  /**
   * Which mount's copy this is — a value or a live getter (the overlay's
   * docked/floating shape flips at runtime, and the loop re-reads the
   * system prompt before every model request, so a getter keeps the
   * visibility line truthful mid-session).
   */
  viewer: SurfaceViewer | (() => SurfaceViewer)
  /** one tool call, forwarded to the shell main over the dock's agent channel */
  execute(tool: string, input: Record<string, unknown>): Promise<unknown>
  /**
   * Open_browser landed: the browser skill's live gate (its tools exist only
   * while a browser tab is open) must flip now, not at the next refresh —
   * the model's very next call is usually a read of the page it just opened.
   */
  onBrowserTabOpened?(tabId: string): void
}

const INPUT_TOOLS = [
  {
    name: SHELL_OPEN_BROWSER_TOOL,
    description:
      'Open a new browser tab and make it active. The optional url is loaded into it (bare ' +
      'domains get https; only http/https). Works even with no browser tab open; the browser ' +
      'read tools (browser:read_page) follow the new tab.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'optional address to load first (a bare domain gets https)',
        },
      },
    },
  },
  {
    name: SHELL_NAVIGATE_TOOL,
    description:
      'Navigate the ACTIVE browser tab to a url — the one the person is looking at, never a ' +
      'background tab. When no browser tab is active, call shell:open_browser (new tab) or ' +
      'shell:switch_tab (existing one) first. Bare domains get https; only http/https ' +
      'addresses load. The result carries the final url after redirects; read the page ' +
      'afterwards (browser:read_page) to see what landed.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'the address to load' },
      },
      required: ['url'],
    },
  },
  {
    name: SHELL_LIST_TABS_TOOL,
    description:
      'List the open tabs: id, kind, title, url or file path, and which is active. Use the ids ' +
      'with shell:switch_tab.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: SHELL_SWITCH_TAB_TOOL,
    description:
      'Activate one tab by its id (from shell:list_tabs) — the surface the person sees follows.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'the tab id from shell:list_tabs' },
      },
      required: ['id'],
    },
  },
  {
    name: SHELL_OPEN_PATH_TOOL,
    description:
      'Open a local file into its app (docs, sheets, slides, pdf, markdown, html) as a new ' +
      "tab. The path must be absolute and inside the desktop's file scope — a starred or " +
      'recent file, a file in a knowledge folder, or an indexed file; other paths are refused ' +
      '(ask the person to open those).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'absolute path of the file to open' },
      },
      required: ['path'],
    },
  },
] as const

/**
 * Compose the shell operator skill. Always present (unlike the browser skill,
 * whose tools flip with the open browser tabs — open_browser is exactly the
 * tool that makes them exist), the surface section live through the getter.
 */
export function createShellSkill(deps: ShellSkillDeps): AgentSkill {
  const tools = INPUT_TOOLS.map((tool) => ({ ...tool }))
  return {
    id: 'shell',
    get systemPrompt() {
      const viewer = typeof deps.viewer === 'function' ? deps.viewer() : deps.viewer
      return [formatSurfaceSection(deps.surfaceTabs(), viewer), SHELL_TOOLS_PROMPT]
        .filter(Boolean)
        .join('\n\n')
    },
    tools,
    executeTool: async (call: AgentToolCall): Promise<ToolExecution> => {
      try {
        switch (call.name) {
          case SHELL_OPEN_BROWSER_TOOL: {
            const url = call.input.url
            if (url !== undefined && typeof url !== 'string') {
              return badInput('`url` must be a string when present')
            }
            if (typeof url === 'string' && url.length > MAX_SHELL_URL_CHARS) {
              return badInput(`\`url\` must be at most ${MAX_SHELL_URL_CHARS} characters`)
            }
            const result = (await deps.execute(SHELL_OPEN_BROWSER_TOOL, {
              ...(url !== undefined ? { url } : {}),
            })) as { tabId: string }
            deps.onBrowserTabOpened?.(result.tabId)
            return {
              output: `opened a new browser tab (${result.tabId}) and made it active${
                url ? ` at ${url}` : ''
              } — read it with browser:read_page`,
              summary: 'opened a browser tab',
              mutated: true,
            }
          }
          case SHELL_NAVIGATE_TOOL: {
            const url = call.input.url
            if (typeof url !== 'string' || !url.trim()) {
              return badInput('`url` must be a non-empty string')
            }
            if (url.length > MAX_SHELL_URL_CHARS) {
              return badInput(`\`url\` must be at most ${MAX_SHELL_URL_CHARS} characters`)
            }
            const result = (await deps.execute(SHELL_NAVIGATE_TOOL, { url })) as {
              url: string
              tabId: string
            }
            return {
              // result.url is the page's final address after redirects — the
              // load is awaited main-side, so this reports what landed, not
              // what was asked for
              output: `navigated the active browser tab (${result.tabId}) to ${result.url} — read it with browser:read_page to see what landed`,
              summary: `navigated to ${hostOf(result.url)}`,
              mutated: true,
            }
          }
          case SHELL_LIST_TABS_TOOL: {
            // the shell main answers the tab array itself, unwrapped — the
            // seam test in apps/shell pins that both halves agree on that
            // shape (a wrapper here once made every list read "No tabs")
            const tabs = (await deps.execute(SHELL_LIST_TABS_TOOL, {})) as readonly SurfaceTab[]
            return {
              output: formatTabList(tabs),
              summary: 'listed the tabs',
            }
          }
          case SHELL_SWITCH_TAB_TOOL: {
            const id = call.input.id
            if (typeof id !== 'string' || !id.trim()) {
              return badInput('`id` must be a non-empty string (from shell:list_tabs)')
            }
            if (id.length > MAX_SHELL_TAB_ID_CHARS) {
              return badInput(`\`id\` must be at most ${MAX_SHELL_TAB_ID_CHARS} characters`)
            }
            await deps.execute(SHELL_SWITCH_TAB_TOOL, { id })
            return {
              output: `activated tab ${id}`,
              summary: `switched to tab ${id}`,
              mutated: true,
            }
          }
          case SHELL_OPEN_PATH_TOOL: {
            const path = call.input.path
            if (typeof path !== 'string' || !path.trim()) {
              return badInput('`path` must be a non-empty absolute path')
            }
            if (path.length > MAX_SHELL_PATH_CHARS) {
              return badInput(`\`path\` must be at most ${MAX_SHELL_PATH_CHARS} characters`)
            }
            await deps.execute(SHELL_OPEN_PATH_TOOL, { path })
            return {
              output: `opened ${path} into its app tab and made it active`,
              summary: `opened ${baseName(path)}`,
              mutated: true,
            }
          }
          default:
            return { output: `unknown shell tool: ${call.name}`, isError: true, summary: call.name }
        }
      } catch (error) {
        // the shell main's model-facing error (no tab, refused scheme, no
        // app for the file): the reason is the tool result
        return {
          output: error instanceof Error ? error.message : String(error),
          isError: true,
          summary: call.name,
        }
      }
    },
  }
}

/** the tab list as the list_tabs tool renders it for the model (complete — the ids feed switch_tab) */
function formatTabList(tabs: readonly SurfaceTab[]): string {
  if (!Array.isArray(tabs) || tabs.length === 0) {
    return 'No tabs are open. shell:open_browser or shell:open_path can open one.'
  }
  return [
    'Open tabs (id | kind | title | url or file):',
    ...tabs.map((tab) => tabLine(tab, false)),
  ].join('\n')
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url.length > 60 ? `${url.slice(0, 60)}…` : url
  }
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function badInput(message: string): ToolExecution {
  return {
    output: `${message}; the tool was not executed. Call again with the corrected argument.`,
    isError: true,
    summary: 'shell tool input',
  }
}
