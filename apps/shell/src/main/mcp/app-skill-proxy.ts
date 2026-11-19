import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { ipcMain } from 'electron'
import type { WebContents } from 'electron'
import {
  PROXIED_APP_DOCUMENT_FIELD,
  type ProxiedAppExecuteResult,
  type ProxiedAppManifest,
  type ProxiedAppTool,
  type ProxiedAppWindow,
} from '@genoffice/agent-core'
import type { DocumentTabKind } from '../../shared/tabs-api'
import type { DesktopWindowInfo } from '../desktop-control'

/**
 * Shell-main half of the desktop loop's app-skill proxy (charter workstream
 * D3). The home Ask panel's AgentLoop composes a skill whose read tools are
 * the *other open apps'* documents; this module is where those calls land.
 *
 * Two handlers:
 * - `appskill:manifest` — the open-window enumeration (pulled from the same
 *   desktop-control source the CLI/MCP `desktop windows list` uses) plus the
 *   read tool each open app exposes. Tools exist only while at least one tab
 *   of that app is open, so a closed app degrades to "tool absent" instead of
 *   a failing call.
 * - `appskill:execute` — one prefixed read call, routed to the target window:
 *   docs/sheets go through their MCP renderer bridges, slides/markdown/html
 *   through the session/read functions the open-documents control already
 *   uses. Targeting follows that control's rules (tab id, then path; the
 *   active tab when no target is given).
 *
 * READ-ONLY BY DESIGN. Only read executors are wired here — no insert, save,
 * apply-ops, close. Cross-window writes would have to carry the target app's
 * confirmation loop (risk annotation + confirmTool + the reviewable-edit UI)
 * across a window boundary; until that loop is proxied too, writes belong to
 * each app's own AI panel. The renderer skill states this boundary to the
 * model, and nothing here can mutate a document even if asked.
 *
 * Deps are injected (the enumeration, the webContents resolver, the per-family
 * readers) so the module's routing is unit-testable without Electron and
 * index.ts keeps ownership of the live tab state.
 */

export const APP_SKILL_CHANNELS = {
  manifest: 'appskill:manifest',
  execute: 'appskill:execute',
} as const

/** the read surface of one app family: live content of one open window */
export type AppDocumentReader = (
  wc: WebContents,
  payload: Record<string, unknown>,
) => Promise<unknown>

export interface AppSkillProxyDeps {
  /** the open-window enumeration the desktop-control domain serves (shell tabs + detached editor windows) */
  listWindows: () => DesktopWindowInfo[] | Promise<DesktopWindowInfo[]>
  /** the live webContents behind one enumerated tab id (a dormant tab re-awakens like it does for the MCP tools) */
  webContentsFor: (tabId: string) => WebContents | undefined
  /** one read executor per family; a family absent here is never proxied */
  readers: Partial<Record<DocumentTabKind, AppDocumentReader>>
}

/** the tab kinds that hold documents (the registry's six apps; Home/help are not documents) */
const DOCUMENT_KINDS: readonly DocumentTabKind[] = [
  'docs',
  'sheets',
  'slides',
  'pdf',
  'markdown',
  'html',
]

/** per-family label for the guided "nothing open" errors */
const KIND_LABEL: Record<DocumentTabKind, string> = {
  docs: 'Word',
  sheets: 'spreadsheet',
  slides: 'presentation',
  pdf: 'PDF',
  markdown: 'markdown',
  html: 'html',
  // the browser never appears in the proxy's documents (agentDocument: false);
  // the label only keeps the Record exhaustive
  browser: 'browser',
}

/** input keys forwarded to the family reader (validated); every tool also takes `document` */
const SHEETS_PAYLOAD_KEYS = ['range', 'addresses', 'sheet', 'sheetId'] as const
const PDF_PAYLOAD_KEYS = ['start', 'end'] as const
/** mirrors the sheets read tool's own cap */
const MAX_READ_ADDRESSES = 100

interface ToolSpec {
  kind: DocumentTabKind
  name: string
  description: string
  inputSchema: Record<string, unknown>
  payloadKeys: readonly string[]
}

/** the read tool each readable family exposes (pdf has none: the app is a viewer) */
const TOOL_SPECS: Partial<Record<DocumentTabKind, ToolSpec>> = {
  docs: {
    kind: 'docs',
    name: 'docs:read_document',
    description:
      'Read a Word document the user has open in GenOffice. Returns a block list — one ' +
      '"index|type|text" line per block (a reading overview; long blocks are clipped). ' +
      'Read-only: to modify this open document, switch to its tab if needed (shell:switch_tab) and call document_agent.',
    inputSchema: { type: 'object', properties: { ...PROXIED_APP_DOCUMENT_FIELD } },
    payloadKeys: [],
  },
  sheets: {
    kind: 'sheets',
    name: 'sheets:read_sheet',
    description:
      'Read a spreadsheet the user has open in GenOffice. Without `range` or `addresses`: ' +
      'returns the workbook overview (sheet names, ids, data extents) plus a first-screen ' +
      'cell preview grid with formulas (up to 100 rows / 2,000 cells). Pass `range` (e.g. ' +
      '"A1:F32") or `addresses` (cell addresses or A1 ranges) to read specific regions, ' +
      'clamped automatically to the worksheet data extent. ' +
      'Read-only: to modify this open workbook, switch to its tab if needed (shell:switch_tab) and call document_agent.',
    inputSchema: {
      type: 'object',
      properties: {
        ...PROXIED_APP_DOCUMENT_FIELD,
        range: {
          type: 'string',
          description:
            'A1 range to read as a grid (e.g. "A1:F32", clamped safely to the worksheet data extent; max 2,000 cells)',
        },
        addresses: {
          type: 'array',
          items: { type: 'string' },
          description:
            'A1 cell addresses (e.g. ["A1", "B2"]) or A1 range strings (e.g. ["A1:F32"]) to read; omit for the overview + preview grid',
        },
        sheet: {
          type: 'string',
          description: 'worksheet name to read from; default the active sheet',
        },
        sheetId: {
          type: 'string',
          description: 'worksheet id from a previous overview (a name is preferred)',
        },
      },
    },
    payloadKeys: SHEETS_PAYLOAD_KEYS,
  },
  slides: {
    kind: 'slides',
    name: 'slides:read_deck',
    description:
      'Read the presentation the user has open in GenOffice: every slide with its elements ' +
      '(ids, types, text, geometry in document-space EMU). ' +
      'Read-only: to modify this open deck, switch to its tab if needed (shell:switch_tab) and call document_agent.',
    inputSchema: { type: 'object', properties: { ...PROXIED_APP_DOCUMENT_FIELD } },
    payloadKeys: [],
  },
  markdown: {
    kind: 'markdown',
    name: 'markdown:read_text',
    description:
      'Read the markdown/plain-text content of a document the user has open in the GenOffice markdown/text editor. ' +
      'Read-only: to modify this open document, switch to its tab if needed (shell:switch_tab) and call document_agent.',
    inputSchema: { type: 'object', properties: { ...PROXIED_APP_DOCUMENT_FIELD } },
    payloadKeys: [],
  },
  html: {
    kind: 'html',
    name: 'html:read_text',
    description:
      'Read the HTML source text of a document the user has open in the GenOffice html editor. ' +
      'Read-only: to modify this open document, switch to its tab if needed (shell:switch_tab) and call document_agent.',
    inputSchema: { type: 'object', properties: { ...PROXIED_APP_DOCUMENT_FIELD } },
    payloadKeys: [],
  },
  pdf: {
    kind: 'pdf',
    name: 'pdf:read_pages',
    description:
      'Read text (including OCR text for scanned pages) from a PDF the user has open in GenOffice, ' +
      '1-based inclusive page numbers (up to 10 pages per call; defaults to pages 1-10). ' +
      'Read-only: to modify or annotate this open PDF, switch to its tab if needed (shell:switch_tab) and call document_agent.',
    inputSchema: {
      type: 'object',
      properties: {
        ...PROXIED_APP_DOCUMENT_FIELD,
        start: {
          type: 'integer',
          description: '1-based start page number (defaults to 1)',
        },
        end: {
          type: 'integer',
          description: '1-based end page number, inclusive (defaults to start + 9, capped at 10 pages per call)',
        },
      },
    },
    payloadKeys: PDF_PAYLOAD_KEYS,
  },
}

function windowOf(info: DesktopWindowInfo): ProxiedAppWindow {
  return {
    id: info.id,
    kind: info.kind,
    title: info.title,
    active: info.active === true,
    ...(info.filePath ? { filePath: info.filePath } : {}),
    ...(info.dirty !== undefined ? { dirty: info.dirty } : {}),
    ...(info.detached ? { detached: true } : {}),
  }
}

/**
 * The manifest as the renderer skill consumes it: every open document window
 * (context the model can see, readable or not — an open PDF is context), and
 * the read tool for each family that has both a reader and an open tab.
 */
export function buildAppSkillManifest(
  windows: readonly DesktopWindowInfo[],
  readers: AppSkillProxyDeps['readers'],
): ProxiedAppManifest {
  const docs = windows.filter((w) => DOCUMENT_KINDS.includes(w.kind as DocumentTabKind))
  const openKinds = new Set(docs.map((w) => w.kind))
  const tools: ProxiedAppTool[] = []
  for (const kind of DOCUMENT_KINDS) {
    const spec = TOOL_SPECS[kind]
    if (!spec || !readers[kind] || !openKinds.has(kind)) continue
    tools.push({
      name: spec.name,
      kind: spec.kind,
      description: spec.description,
      inputSchema: spec.inputSchema,
    })
  }
  return { windows: docs.map(windowOf), tools }
}

function sameOpenPath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    let r = resolve(p)
    try {
      r = realpathSync.native(r)
    } catch {
      // unsaved or moved file: compare the resolved path as-is
    }
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

function listingOf(windows: readonly ProxiedAppWindow[]): string {
  return windows.map((w) => `  ${w.id}  ${w.filePath ?? '(never saved)'}  — ${w.title}`).join('\n')
}

/**
 * Resolve the target of one read call: exact tab id, then path, then the
 * family's active tab. The guided errors mirror the open-documents control's
 * ("no match" lists what is open; "none open" names the family).
 */
function resolveReadTarget(
  windows: readonly ProxiedAppWindow[],
  kind: DocumentTabKind,
  target: string | undefined,
): ProxiedAppWindow {
  if (target) {
    const byId = windows.find((w) => w.id === target)
    if (byId) return byId
    const byPath = windows.find((w) => w.filePath !== undefined && sameOpenPath(w.filePath, target))
    if (byPath) return byPath
    if (windows.length === 0) {
      throw new Error(`no ${KIND_LABEL[kind]} document is open, so "${target}" cannot be read`)
    }
    throw new Error(
      `no open ${KIND_LABEL[kind]} document matches "${target}". Currently open:\n${listingOf(windows)}`,
    )
  }
  const active = windows.find((w) => w.active) ?? windows[0]
  if (!active) throw new Error(`no ${KIND_LABEL[kind]} document is open`)
  return active
}

/** validate + narrow the family's read payload to the keys its reader takes */
function readPayload(spec: ToolSpec, input: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  for (const key of spec.payloadKeys) {
    const value = input[key]
    if (value === undefined) continue
    if (key === 'addresses') {
      if (!Array.isArray(value) || !value.every((a) => typeof a === 'string')) {
        throw new Error('`addresses` must be an array of A1 address strings')
      }
      if (value.length > MAX_READ_ADDRESSES) {
        throw new Error(`read at most ${MAX_READ_ADDRESSES} addresses per call`)
      }
      payload.addresses = value
      continue
    }
    if (key === 'start' || key === 'end') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        throw new Error(`\`${key}\` must be a positive integer`)
      }
      payload[key] = value
      continue
    }
    if (typeof value !== 'string') throw new Error(`\`${key}\` must be a string`)
    payload[key] = value
  }
  return payload
}

/** one prefixed read call, routed to its window; the read-only surface behind `appskill:execute` */
export async function executeAppSkillRead(
  deps: AppSkillProxyDeps,
  tool: string,
  input: Record<string, unknown>,
): Promise<ProxiedAppExecuteResult> {
  const kind = tool.split(':')[0] as DocumentTabKind
  const spec = TOOL_SPECS[kind]
  const reader = deps.readers[kind]
  if (!spec || !reader) {
    // a known document family without a wired reader (pdf: the app is a
    // viewer) is a surface limit, not a routing miss
    if (DOCUMENT_KINDS.includes(kind)) {
      throw new Error(
        `${KIND_LABEL[kind]} documents cannot be read through this surface` +
          ` (the ${kind} app exposes no reader here); only open documents of the other apps are readable`,
      )
    }
    throw new Error(`unknown app tool: ${tool}`)
  }
  const document = typeof input.document === 'string' && input.document ? input.document : undefined
  const windows = (await deps.listWindows()).filter((w) => w.kind === kind).map(windowOf)
  const target = resolveReadTarget(windows, kind, document)
  const wc = deps.webContentsFor(target.id)
  if (!wc || wc.isDestroyed()) {
    throw new Error(`"${target.title}" is no longer open`)
  }
  const result = await reader(wc, readPayload(spec, input))
  return {
    target: {
      id: target.id,
      kind: target.kind,
      title: target.title,
      ...(target.filePath ? { path: target.filePath } : {}),
    },
    result,
  }
}

/**
 * Register the two renderer-facing handlers. Safe to call once per process
 * (the shell calls it from app.whenReady, after the family controls exist).
 */
export function registerAppSkillIpc(deps: AppSkillProxyDeps): void {
  ipcMain.handle(APP_SKILL_CHANNELS.manifest, async () =>
    buildAppSkillManifest(await deps.listWindows(), deps.readers),
  )
  ipcMain.handle(APP_SKILL_CHANNELS.execute, async (_event, call: unknown) => {
    const { tool, input } = (call ?? {}) as { tool?: unknown; input?: unknown }
    if (typeof tool !== 'string' || !tool) throw new Error('appskill:execute requires a tool name')
    if (
      input !== undefined &&
      input !== null &&
      (typeof input !== 'object' || Array.isArray(input))
    ) {
      throw new Error('appskill:execute input must be an object')
    }
    return executeAppSkillRead(deps, tool, (input ?? {}) as Record<string, unknown>)
  })
}
