import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { ipcMain } from 'electron'
import type { WebContents } from 'electron'
import {
  type ProxiedAppExecuteResult,
  type ProxiedAppManifest,
  type ProxiedAppTool,
  type ProxiedAppWindow,
} from '@genoffice/agent-core'
import type { DocumentTabKind } from '../../shared/tabs-api'
import type { DesktopWindowInfo } from '../desktop-control'
import {
  DOCS_PAYLOAD_KEYS,
  MAX_READ_ADDRESSES,
  MEDIA_ANALYZE_PAYLOAD_KEYS,
  MEDIA_READ_PAYLOAD_KEYS,
  PDF_PAYLOAD_KEYS,
  SHEETS_PAYLOAD_KEYS,
  SLIDES_PAYLOAD_KEYS,
  STATIC_PROXIED_APP_TOOLS,
  TEXT_PAGED_DEFAULT_CHARS,
  TEXT_PAGED_MAX_CHARS,
  TOOL_SPECS,
  type AppSkillToolSpec,
} from './app-skill-catalog'

export { STATIC_PROXIED_APP_TOOLS }

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
  /** optional per-tool executor overrides for families that expose multiple tools (e.g. media) */
  toolReaders?: Partial<Record<string, AppDocumentReader>>
}

/** the tab kinds that hold documents or readable media (Home/help/browser are excluded) */
const DOCUMENT_KINDS: readonly DocumentTabKind[] = [
  'docs',
  'sheets',
  'slides',
  'pdf',
  'markdown',
  'html',
  'media',
]

/** per-family label for the guided "nothing open" errors */
const KIND_LABEL: Record<DocumentTabKind, string> = {
  docs: 'Word',
  sheets: 'spreadsheet',
  slides: 'presentation',
  pdf: 'PDF',
  markdown: 'markdown',
  html: 'html',
  media: 'media',
  // the browser never appears in the proxy's documents (agentDocument: false);
  // the label only keeps the Record exhaustive
  browser: 'browser',
}

type ToolSpec = AppSkillToolSpec

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
  toolReaders?: AppSkillProxyDeps['toolReaders'],
): ProxiedAppManifest {
  const docs = windows.filter(
    (w) => !w.present && DOCUMENT_KINDS.includes(w.kind as DocumentTabKind),
  )
  const openKinds = new Set(docs.map((w) => w.kind))
  const tools: ProxiedAppTool[] = []
  for (const kind of DOCUMENT_KINDS) {
    const specs = TOOL_SPECS[kind]
    if (!specs || !openKinds.has(kind)) continue
    for (const spec of specs) {
      const hasReader = spec.requiresToolReader
        ? Boolean(toolReaders?.[spec.name])
        : Boolean(toolReaders?.[spec.name] ?? readers[kind])
      if (!hasReader) continue
      tools.push({
        name: spec.name,
        kind: spec.kind,
        description: spec.description,
        inputSchema: spec.inputSchema,
      })
    }
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
    if (key === 'requirements') {
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error('`requirements` must be a non-empty string')
      }
      payload.requirements = value.trim()
      continue
    }
    if (value === undefined) continue
    if (key === 'timestampSec') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error('`timestampSec` must be a non-negative finite number')
      }
      payload.timestampSec = value
      continue
    }
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
      const min = spec.kind === 'pdf' ? 1 : 0
      const label = spec.kind === 'pdf' ? 'a positive integer' : 'a non-negative integer'
      if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
        throw new Error(`\`${key}\` must be ${label}`)
      }
      payload[key] = value
      continue
    }
    if (
      key === 'startBlockIndex' ||
      key === 'endBlockIndex' ||
      key === 'offset' ||
      key === 'slideIndex'
    ) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new Error(`\`${key}\` must be a non-negative integer`)
      }
      payload[key] = value
      continue
    }
    if (typeof value !== 'string') throw new Error(`\`${key}\` must be a string`)
    payload[key] = value
  }
  return payload
}

function readTextSliceOptions(
  input: Record<string, unknown>,
): { offset: number; maxChars: number } {
  const rawOffset = input.offset
  let offset = 0
  if (rawOffset !== undefined) {
    if (typeof rawOffset !== 'number' || !Number.isInteger(rawOffset) || rawOffset < 0) {
      throw new Error('`offset` must be a non-negative integer')
    }
    offset = rawOffset
  }
  const rawMax = input.maxChars
  let maxChars = TEXT_PAGED_DEFAULT_CHARS
  if (rawMax !== undefined) {
    if (typeof rawMax !== 'number' || !Number.isInteger(rawMax) || rawMax < 1) {
      throw new Error('`maxChars` must be a positive integer')
    }
    maxChars = Math.min(rawMax, TEXT_PAGED_MAX_CHARS)
  }
  return { offset, maxChars }
}

function sliceTextReadResult(raw: unknown, offset: number, maxChars: number): unknown {
  const text =
    typeof raw === 'string'
      ? raw
      : raw && typeof raw === 'object' && typeof (raw as { text?: unknown }).text === 'string'
        ? (raw as { text: string }).text
        : null
  if (text === null) return raw
  if (offset === 0 && text.length <= maxChars) return raw
  if (offset > 0 && text.length > 0 && offset >= text.length) {
    throw new Error(`offset ${offset} is beyond the document length (${text.length} characters)`)
  }
  if (text.length === 0) return raw
  const slice = text.slice(offset, offset + maxChars)
  const end = offset + slice.length
  const more = end < text.length
  return (
    `characters ${offset}..${end} of ${text.length}` +
    (more ? ` (truncated — call again with offset=${end} to continue)` : ' (end of document)') +
    `\n\n${slice}`
  )
}

/** Accept `document` plus common aliases (`tabId`, `path`) so multi-tab reads never silently hit the wrong tab. */
function pickTargetArg(input: Record<string, unknown>): string | undefined {
  for (const key of ['document', 'tabId', 'path'] as const) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

/** one prefixed read call, routed to its window; the read-only surface behind `appskill:execute` */
export async function executeAppSkillRead(
  deps: AppSkillProxyDeps,
  tool: string,
  input: Record<string, unknown>,
): Promise<ProxiedAppExecuteResult> {
  const kind = tool.split(':')[0] as DocumentTabKind
  const specs = TOOL_SPECS[kind]
  const spec = specs?.find((s) => s.name === tool) ?? (specs?.length === 1 ? specs[0] : undefined)
  const reader = spec
    ? (deps.toolReaders?.[spec.name] ?? (spec.requiresToolReader ? undefined : deps.readers[kind]))
    : undefined
  if (!spec || !reader) {
    // a known document family without a wired reader (pdf: the app is a
    // viewer) is a surface limit, not a routing miss
    if (DOCUMENT_KINDS.includes(kind) && specs?.some((s) => s.name === tool || specs.length === 1)) {
      throw new Error(
        `${KIND_LABEL[kind]} documents cannot be read through this surface` +
          ` (the ${kind} app exposes no reader here); only open documents of the other apps are readable`,
      )
    }
    throw new Error(`unknown app tool: ${tool}`)
  }
  const textSliceOpts =
    kind === 'markdown' || kind === 'html' ? readTextSliceOptions(input) : null
  const validatedPayload = readPayload(spec, input)
  const document = pickTargetArg(input)
  const rawKindWindows = (await deps.listWindows()).filter((w) => w.kind === kind)
  const allKindWindows = rawKindWindows.map(windowOf)
  const preferredWindows = rawKindWindows.filter((w) => !w.present).map(windowOf)
  // Prefer non-Present editor windows when targeting implicitly, while still letting
  // explicit active-tab ids (like an active HTML Present tab from shell context) route
  // through to the family reader's owner-redirection fallback.
  const target = document
    ? resolveReadTarget(allKindWindows, kind, document)
    : resolveReadTarget(
        preferredWindows.length > 0 ? preferredWindows : allKindWindows,
        kind,
        undefined,
      )
  const wc = deps.webContentsFor(target.id)
  if (!wc || wc.isDestroyed()) {
    throw new Error(`"${target.title}" is no longer open`)
  }
  const rawResult = await reader(wc, validatedPayload)
  const result = textSliceOpts
    ? sliceTextReadResult(rawResult, textSliceOpts.offset, textSliceOpts.maxChars)
    : rawResult
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

let registeredAppSkillDeps: AppSkillProxyDeps | null = null

export async function getAppSkillManifestFromMain(): Promise<ProxiedAppManifest> {
  if (!registeredAppSkillDeps) return { windows: [], tools: [] }
  return buildAppSkillManifest(
    await registeredAppSkillDeps.listWindows(),
    registeredAppSkillDeps.readers,
    registeredAppSkillDeps.toolReaders,
  )
}

export async function executeAppSkillFromMain(
  tool: string,
  input: Record<string, unknown>,
) {
  if (!registeredAppSkillDeps) {
    throw new Error('app-skill proxy is not initialized')
  }
  return executeAppSkillRead(registeredAppSkillDeps, tool, input)
}

/**
 * Register the two renderer-facing handlers. Safe to call once per process
 * (the shell calls it from app.whenReady, after the family controls exist).
 */
export function registerAppSkillIpc(deps: AppSkillProxyDeps): void {
  registeredAppSkillDeps = deps
  ipcMain.handle(APP_SKILL_CHANNELS.manifest, async () =>
    buildAppSkillManifest(await deps.listWindows(), deps.readers, deps.toolReaders),
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
