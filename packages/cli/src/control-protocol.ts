/**
 * Wire format between the genoffice CLI and the running GenOffice shell.
 *
 * The shell listens on a local socket (unix socket in userData, named pipe on
 * Windows) and publishes its endpoint plus a per-run token in
 * userData/control.json. One newline-terminated JSON request per connection,
 * one JSON reply. Both sides import this file, so the shapes stay in step.
 */

export const CONTROL_FILE = 'control.json'
export const CONTROL_PROTOCOL = 1
export const CONTROL_MAX_REQUEST_BYTES = 64 * 1024

export interface ControlEndpoint {
  protocol: number
  pid: number
  /** unix socket path or `\\.\pipe\...` name */
  endpoint: string
  token: string
}

/**
 * Where to put the caret / selection in an open document; one structural kind
 * per file type, plus the universal text target — the first find match —
 * which any editor with a find can answer (the search deep link, issue #56).
 */
export type ControlTarget =
  | { kind: 'slide'; slide: number; el?: string }
  | { kind: 'block'; block: number }
  | { kind: 'range'; sheet?: string; range: string }
  | { kind: 'page'; page: number }
  | { kind: 'text'; text: string }

/**
 * The desktop domain: the Home surface's own state (wallpaper, icon layout,
 * todos) and the windows/tabs the user has open. Read actions answer a
 * snapshot; the write actions go through the same validated, atomic stores
 * the renderer IPC uses, so a CLI edit lands exactly like a UI edit.
 */
export type DesktopControlRequest =
  | { cmd: 'desktop'; action: 'get-state' }
  | { cmd: 'desktop'; action: 'set-wallpaper'; wallpaper: string }
  | { cmd: 'desktop'; action: 'arrange'; mode: DesktopArrangeMode }
  | { cmd: 'desktop'; action: 'todo-add'; text: string }
  | { cmd: 'desktop'; action: 'todo-list' }
  | { cmd: 'desktop'; action: 'windows-list' }

/** the icon arrangement modes the desktop itself offers in its sort menu —
 *  the single runtime source every desktop-arrange surface derives from */
export const DESKTOP_ARRANGE_MODES = ['custom', 'name', 'kind', 'mtime'] as const

export type DesktopArrangeMode = (typeof DESKTOP_ARRANGE_MODES)[number]

/**
 * Every action of the `desktop` domain, described once. The two MCP surfaces
 * derive from this list — the running app's single `desktop` tool (its action
 * enum, its parameters and its description) and the standalone `genoffice
 * mcp` server's `desktop_*` tools — so the two vocabularies cannot drift
 * apart: an action described here exists on both, and one that is not does
 * not exist on either.
 */
export interface DesktopActionInfo {
  /** the control-protocol action */
  action: DesktopActionName
  /** the CLI words that name the action (the compact argv form) */
  cli: readonly string[]
  /** the standalone `genoffice mcp` tool name */
  tool: string
  /** reads only; never mutates the desktop's stores */
  readOnly: boolean
  /** the in-app tool's description clause — flows after `"<action>"` */
  description: string
  /** the standalone tool's own description */
  toolDescription: string
  /** the one argument the action takes, if any */
  arg?: DesktopActionArg
}

/** one argument a desktop action takes, described once for every surface */
export interface DesktopActionArg {
  /** the argument's name in the tool schema / CLI positional */
  key: 'wallpaper' | 'mode' | 'text'
  /** what values the argument accepts */
  description: string
  /** closed set of values; the in-app tool's schema becomes an enum */
  choices?: readonly string[]
}

export const DESKTOP_ACTION_NAMES = [
  'get-state',
  'set-wallpaper',
  'arrange',
  'todo-add',
  'todo-list',
  'windows-list',
] as const

export type DesktopActionName = (typeof DESKTOP_ACTION_NAMES)[number]

/**
 * The names tuple and the protocol's request union must cover each other
 * exactly — this stays assignable only while they do, so adding a protocol
 * action without describing it (or describing one that cannot be sent) fails
 * the build rather than silently diverging the two MCP surfaces.
 */
export type DesktopActionCoverage =
  Exclude<DesktopControlRequest['action'], DesktopActionName> extends never
    ? Exclude<DesktopActionName, DesktopControlRequest['action']> extends never
      ? true
      : never
    : never

export const DESKTOP_ACTIONS_MATCH: DesktopActionCoverage = true

export const DESKTOP_ACTIONS: readonly DesktopActionInfo[] = [
  {
    action: 'get-state',
    cli: ['get-state'],
    tool: 'desktop_get_state',
    readOnly: true,
    description:
      'returns the current wallpaper, the icon layout summary, the todo list and the open windows/tabs in one snapshot',
    toolDescription:
      "The running GenOffice app's Home desktop in one snapshot: current wallpaper, icon layout summary, todo list and open windows/tabs.",
  },
  {
    action: 'set-wallpaper',
    cli: ['set-wallpaper'],
    tool: 'desktop_set_wallpaper',
    readOnly: false,
    description: 'changes the desktop wallpaper',
    toolDescription:
      'Change the Home desktop wallpaper: "default" (the live aurora), a builtin wallpaper name (an unknown name\'s error reply lists the available ones), or an absolute path to a png/jpg/webp image (imported into the app).',
    arg: {
      key: 'wallpaper',
      description: '"default", a builtin name like "teal-deep", or an absolute png/jpg/webp path',
    },
  },
  {
    action: 'arrange',
    cli: ['arrange'],
    tool: 'desktop_arrange',
    readOnly: false,
    description: 'sets how the desktop icons are arranged',
    toolDescription:
      'Arrange the Home desktop icons: by name, kind or last-modified (a computed sort), or "custom" to return to the saved drag layout.',
    arg: {
      key: 'mode',
      description: 'the arrangement: name, kind, mtime, or custom for the saved drag layout',
      choices: DESKTOP_ARRANGE_MODES,
    },
  },
  {
    action: 'todo-add',
    cli: ['todo', 'add'],
    tool: 'desktop_todo_add',
    readOnly: false,
    description: 'adds one item to the Home todo widget',
    toolDescription: 'Add one item to the Home desktop todo widget.',
    arg: { key: 'text', description: 'the todo item text' },
  },
  {
    action: 'todo-list',
    cli: ['todo', 'list'],
    tool: 'desktop_todo_list',
    readOnly: true,
    description: "returns the widget's items",
    toolDescription: 'List the Home desktop todo widget items (text + done state).',
  },
  {
    action: 'windows-list',
    cli: ['windows', 'list'],
    tool: 'desktop_windows_list',
    readOnly: true,
    description: 'enumerates the open editor tabs and detached windows, with unsaved-changes state',
    toolDescription:
      'Enumerate the windows and editor tabs the running GenOffice app has open (kind, title, path, active/dirty/detached).',
  },
]

export type ControlRequest =
  | { cmd: 'open'; path: string; target?: ControlTarget }
  | { cmd: 'selection'; path: string }
  | DesktopControlRequest

export interface ControlEnvelope {
  token: string
  request: ControlRequest
}

export type ControlErrorReason =
  | 'target_not_found'
  | 'out_of_range'
  | 'sheet_not_found'
  | 'invalid_argument'
  | 'unsupported'
  | 'file_not_found'
  | 'file_not_open_in_gui'
  | 'app_unavailable'
  | 'app_crashed'

export interface ControlError {
  reason: ControlErrorReason
  message: string
  detail?: Record<string, unknown>
}

export type ControlReply =
  { ok: true; result: Record<string, unknown> } | { ok: false; error: ControlError }

/**
 * What a renderer answers to `window.__genofficeControl(req)`; `not_ready`
 * means the document has not finished loading and the shell should ask again.
 */
export type RendererControlRequest = { cmd: 'goto'; target: ControlTarget } | { cmd: 'selection' }

export type RendererControlReply =
  | { status: 'ok'; result: Record<string, unknown> }
  | { status: 'not_ready' }
  | { status: 'error'; error: ControlError }
