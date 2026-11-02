import { ipcMain, webContents } from 'electron'
import type { WebContents } from 'electron'
import {
  MAX_AGENT_TASK_CHARS,
  type AgentTaskResult,
  type AgentTaskStatus,
} from '@genoffice/agent-core'

/**
 * Shell-main half of the document-agent delegation (W2). The dock panel's
 * `document_agent` tool calls land here over `document-agent:run`; this
 * module routes the task to the ACTIVE docs tab's renderer, which runs its
 * headless copy of the docs agent loop (apps/docs/src/renderer/ai/
 * headless-agent.ts) against the live editor, and answers with the task's
 * result. The sub-agent's live progress streams back the same way
 * (`docs:agent-task-progress` → `document-agent:progress` to the calling
 * panel), so the global panel can show the rolling "文档助手：…" status
 * instead of a silent spinner.
 *
 * The plumbing mirrors the MCP docs bridge (mcp/docs-bridge.ts): a pending
 * map keyed by task id, reply validation by sender webContents, a timeout, a
 * destroyed-watcher so a tab closed mid-task fails its run honestly, and the
 * same readiness handshake (`docs:agent-ready`) so a task never waits out
 * its whole cap on a tab that is still booting. One delegated task per
 * document at a time (a second call answers a busy error — the simpler
 * honest policy: no hidden queue).
 *
 * Target pinning: the panel resolves the target at CARD time with the
 * read-only `document-agent:describe` and shows the document's title; the
 * run carries that tab id, and a mismatch (the person switched tabs between
 * the card and the allow) refuses with a re-ask instead of quietly working
 * on a different document.
 *
 * The channels serve the same panel-hosting webContents the browser skill's
 * channel does (the shell renderer and the drawer overlay's panel copy);
 * everything else is refused before the call is even parsed.
 */

export const DOCUMENT_AGENT_CHANNELS = {
  run: 'document-agent:run',
  /** read-only: which document a delegation would target right now (card time) */
  describe: 'document-agent:describe',
  cancel: 'document-agent:cancel',
  progress: 'document-agent:progress',
} as const

/** the app-side channels (the renderer half is the docs app's headless agent) */
const TASK_COMMAND = 'docs:agent-task'
const TASK_PROGRESS = 'docs:agent-task-progress'
const TASK_RESULT = 'docs:agent-task-result'
const TASK_ABORT = 'docs:agent-task-abort'
const TASK_READY = 'docs:agent-ready'

/** how long one delegated task may run before the bridge aborts it */
export const DOCUMENT_AGENT_TIMEOUT_MS = 3 * 60_000
/** how long a not-yet-ready tab may take to announce itself (mirror of the MCP bridge's boot window, shorter) */
export const DOCUMENT_AGENT_READY_TIMEOUT_MS = 10_000
/** a buffered cancel older than this is stale (the race window is sub-millisecond) */
const CANCEL_BUFFER_MS = 2_000
/** LOW-10: what the bridge accepts from a renderer's result report (the rest truncates) */
const MAX_RESULT_SUMMARY_CHARS = 20_000
const MAX_RESULT_EDITS = 100
const MAX_EDIT_TOOL_CHARS = 100
const MAX_EDIT_SUMMARY_CHARS = 400

/** one tab as the routing sees it (the same enumeration the surface context uses) */
export interface DocumentAgentTab {
  id: string
  kind: string
  title: string
  active: boolean
}

/** the describe answer: which document a delegation targets right now */
export interface DocumentAgentTarget {
  tabId: string
  title: string
}

export interface DocumentAgentBridgeDeps {
  /** the open document tabs (shell strip first, detached editor windows after); sync or async */
  listDocumentTabs(): readonly DocumentAgentTab[] | Promise<readonly DocumentAgentTab[]>
  /** the live webContents behind one tab id (undefined: closed or asleep) */
  webContentsFor(tabId: string): WebContents | undefined
  /**
   * The webContents the run channel serves — both panel copies that host the
   * dock's AgentLoop (the shell window's renderer and the drawer overlay's
   * standalone panel), the same gate `browserskill:execute` uses; every other
   * webContents is refused before the call is parsed.
   */
  panelWebContents(): readonly WebContents[]
}

interface ActiveTask {
  taskId: string
  tabId: string
  wcId: number
  /** the panel webContents awaiting the result (progress is relayed here) */
  caller: WebContents
  resolve: (result: AgentTaskResult) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const activeByTask = new Map<string, ActiveTask>()
/** the task running in one document tab, by tab id (the busy rule) */
const busyByTab = new Map<string, string>()
/** tabs that announced headless-agent readiness, by webContents id */
const readyIds = new Set<number>()
/** a cancel that landed while its caller's task was still registering, by caller id → time */
const bufferedCancels = new Map<number, number>()
let taskSeq = 0
let installed = false

/** tabs whose 'destroyed' hook is attached (once per webContents id) */
const watchedIds = new Set<number>()

const KIND_LABEL: Record<string, string> = {
  docs: 'a Word document',
  sheets: 'a spreadsheet',
  slides: 'a presentation',
  pdf: 'a PDF',
  markdown: 'a markdown document',
  html: 'an html document',
  browser: 'the browser',
  home: 'the Home desktop',
}

/** resolve the tab a delegated task targets: strictly the ACTIVE docs tab */
function resolveTarget(
  tabs: readonly DocumentAgentTab[],
): { tab: DocumentAgentTab } | { error: string } {
  // the active tab's kind comes first: a focused spreadsheet is a sharper,
  // more honest answer than "no Word document is open"
  const active = tabs.find((t) => t.active)
  if (active && active.kind !== 'docs') {
    const label = KIND_LABEL[active.kind] ?? active.kind
    return {
      error:
        `the active tab is ${label}, not a Word document — the document assistant works on the ` +
        'active Word document; switch to it first (shell:switch_tab)',
    }
  }
  const docsTabs = tabs.filter((t) => t.kind === 'docs')
  if (docsTabs.length === 0) {
    return {
      error:
        'no Word document is open — open one first (shell:open_path, or a new document tab), ' +
        'then delegate to the document assistant',
    }
  }
  if (!active) {
    return {
      error:
        'no Word document tab is active — switch to it first (shell:switch_tab), then delegate ' +
        'to the document assistant',
    }
  }
  return { tab: active }
}

function settleTask(taskId: string, run: (task: ActiveTask) => void): void {
  const task = activeByTask.get(taskId)
  if (!task) return
  activeByTask.delete(taskId)
  if (busyByTab.get(task.tabId) === taskId) busyByTab.delete(task.tabId)
  clearTimeout(task.timer)
  run(task)
}

/** a closed tab can never answer: fail its run and drop its readiness */
function watchDestroyed(wcId: number): void {
  if (watchedIds.has(wcId)) return
  const wc = webContents.fromId(wcId)
  if (!wc || wc.isDestroyed()) return
  watchedIds.add(wcId)
  wc.once('destroyed', () => {
    watchedIds.delete(wcId)
    readyIds.delete(wcId)
    for (const [taskId, task] of [...activeByTask]) {
      if (task.wcId !== wcId) continue
      settleTask(taskId, (t) =>
        t.reject(
          new Error(
            'the document tab was closed mid-task; the task stopped — check what it had ' +
              'already applied before retrying',
          ),
        ),
      )
    }
  })
}

/** drop a stale buffered cancel (the race window is sub-millisecond; anything older is poison) */
function takeBufferedCancel(callerId: number): boolean {
  const at = bufferedCancels.get(callerId)
  if (at === undefined) return false
  bufferedCancels.delete(callerId)
  return Date.now() - at <= CANCEL_BUFFER_MS
}

/**
 * Wait for the tab's headless agent to announce readiness — the MCP bridge's
 * handshake, so a task for a still-booting tab waits (bounded) instead of
 * burning its whole 3-minute cap.
 */
function waitForReady(wcId: number): Promise<void> {
  if (readyIds.has(wcId)) return Promise.resolve()
  const wc = webContents.fromId(wcId)
  if (!wc || wc.isDestroyed()) return Promise.reject(new Error('the document tab was closed'))
  watchDestroyed(wcId)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error('the document tab is still loading its agent — wait a moment and delegate again'),
      )
    }, DOCUMENT_AGENT_READY_TIMEOUT_MS)
    const poll = (): void => {
      if (readyIds.has(wcId)) {
        clearTimeout(timer)
        resolve()
        return
      }
      const live = webContents.fromId(wcId)
      if (!live || live.isDestroyed()) {
        clearTimeout(timer)
        reject(new Error('the document tab was closed'))
        return
      }
      setTimeout(poll, 100)
    }
    poll()
  })
}

/** LOW-10: clip a renderer's result report to the bridge's accepted sizes */
function normalizeEdits(raw: unknown): { tool: string; summary: string }[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw
    .filter(
      (e): e is { tool: string; summary: string } =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as { tool?: unknown }).tool === 'string' &&
        typeof (e as { summary?: unknown }).summary === 'string',
    )
    .slice(0, MAX_RESULT_EDITS)
    .map((e) => ({
      tool: e.tool.slice(0, MAX_EDIT_TOOL_CHARS),
      summary: e.summary.slice(0, MAX_EDIT_SUMMARY_CHARS),
    }))
}

/**
 * Register the document-agent bridge. Safe to call once per process (the
 * shell calls it from app.whenReady, before any docs tab can exist).
 */
export function installDocumentAgentBridge(deps: DocumentAgentBridgeDeps): void {
  if (installed) return
  installed = true

  const isPanel = (sender: WebContents): boolean =>
    deps.panelWebContents().some((wc) => !wc.isDestroyed() && wc === sender)

  ipcMain.on(TASK_READY, (event) => {
    readyIds.add(event.sender.id)
    watchDestroyed(event.sender.id)
  })

  ipcMain.on(TASK_PROGRESS, (event, raw: unknown) => {
    const payload = raw as { taskId?: unknown; status?: unknown }
    if (!payload || typeof payload.taskId !== 'string') return
    const task = activeByTask.get(payload.taskId)
    // the progress is only valid from the tab the task runs in
    if (!task || task.wcId !== event.sender.id) return
    // and only a well-formed status rides on to the panel
    if (!isAgentTaskStatus(payload.status)) return
    if (!task.caller.isDestroyed()) {
      task.caller.send(DOCUMENT_AGENT_CHANNELS.progress, {
        taskId: payload.taskId,
        status: payload.status,
      })
    }
  })

  ipcMain.on(TASK_RESULT, (event, raw: unknown) => {
    const payload = raw as { taskId?: unknown; ok?: unknown; summary?: unknown; edits?: unknown }
    if (!payload || typeof payload.taskId !== 'string') return
    const task = activeByTask.get(payload.taskId)
    if (!task || task.wcId !== event.sender.id) return
    const summary =
      typeof payload.summary === 'string' ? payload.summary.slice(0, MAX_RESULT_SUMMARY_CHARS) : ''
    settleTask(payload.taskId, (t) => {
      if (payload.ok === true) {
        const edits = normalizeEdits(payload.edits)
        t.resolve({ ok: true, summary, ...(edits ? { edits } : {}) })
      } else {
        t.reject(new Error(summary || 'the document assistant failed the task'))
      }
    })
  })

  // the card-time read: which document a delegation would target right now.
  // Read-only — nothing runs, nothing is pinned beyond the answer itself
  ipcMain.handle(
    DOCUMENT_AGENT_CHANNELS.describe,
    async (event): Promise<DocumentAgentTarget | { error: string }> => {
      if (!isPanel(event.sender))
        throw new Error('document-agent:describe is not callable from this sender')
      const target = resolveTarget(await deps.listDocumentTabs())
      if ('error' in target) return { error: target.error }
      return { tabId: target.tab.id, title: target.tab.title }
    },
  )

  ipcMain.handle(
    DOCUMENT_AGENT_CHANNELS.run,
    async (event, raw: unknown): Promise<AgentTaskResult> => {
      // sender gate: the same panel copies the browser skill's channel serves
      if (!isPanel(event.sender))
        throw new Error('document-agent:run is not callable from this sender')

      const task = (raw ?? {}) as { task?: unknown; expectedTabId?: unknown }
      if (typeof task.task !== 'string' || !task.task.trim()) {
        throw new Error('`task` must be a non-empty string')
      }
      if (task.task.length > MAX_AGENT_TASK_CHARS) {
        throw new Error(`\`task\` must be at most ${MAX_AGENT_TASK_CHARS} characters`)
      }

      const target = resolveTarget(await deps.listDocumentTabs())
      if ('error' in target) throw new Error(target.error)

      // target pinning: the card showed THIS document's title; a tab switch
      // between the card and the allow must re-ask, not quietly retarget
      if (typeof task.expectedTabId === 'string' && task.expectedTabId !== target.tab.id) {
        throw new Error(
          `the active document changed since the confirmation (it showed "${target.tab.title}") — ` +
            'switch back to it, or send the task again',
        )
      }

      const wc = deps.webContentsFor(target.tab.id)
      if (!wc || wc.isDestroyed()) {
        throw new Error('the document tab is no longer live — switch to it and try again')
      }
      watchDestroyed(wc.id)

      // a cancel that beat this run's registration: the run was already
      // stopping — refuse instead of starting a task the person cancelled
      if (takeBufferedCancel(event.sender.id)) {
        throw new Error('the delegated task was cancelled before it started')
      }

      if (busyByTab.has(target.tab.id)) {
        throw new Error(
          'the document assistant is already working in this document — wait for it to finish, ' +
            'then delegate again',
        )
      }

      await waitForReady(wc.id)
      // the ready wait re-runs the busy check: a second task could have started
      // while this one was waiting for the tab to boot
      if (busyByTab.has(target.tab.id)) {
        throw new Error(
          'the document assistant is already working in this document — wait for it to finish, ' +
            'then delegate again',
        )
      }
      if (takeBufferedCancel(event.sender.id)) {
        throw new Error('the delegated task was cancelled before it started')
      }

      const taskId = `agent-${++taskSeq}`
      const result = new Promise<AgentTaskResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          // stop the renderer's task too: a timed-out task must not keep editing
          if (!wc.isDestroyed()) wc.send(TASK_ABORT, { taskId })
          settleTask(taskId, (t) =>
            t.reject(
              new Error(
                'the delegated task timed out after 3 minutes — the document assistant stopped; ' +
                  'check what it had applied before retrying',
              ),
            ),
          )
        }, DOCUMENT_AGENT_TIMEOUT_MS)
        activeByTask.set(taskId, {
          taskId,
          tabId: target.tab.id,
          wcId: wc.id,
          caller: event.sender,
          resolve,
          reject,
          timer,
        })
        busyByTab.set(target.tab.id, taskId)
      })
      wc.send(TASK_COMMAND, { taskId, task: task.task })
      return result
    },
  )

  ipcMain.handle(DOCUMENT_AGENT_CHANNELS.cancel, (event) => {
    // the same sender gate as the run channel: only a panel copy can cancel
    if (!isPanel(event.sender)) return false
    // the caller's in-flight task (the loop serializes tool calls, so a
    // panel has at most one); the renderer answers with an aborted result
    let hadActive = false
    for (const [taskId, task] of [...activeByTask]) {
      if (task.caller !== event.sender) continue
      hadActive = true
      const wc = webContents.fromId(task.wcId)
      if (wc && !wc.isDestroyed()) wc.send(TASK_ABORT, { taskId })
    }
    // the race: a cancel that lands while its run is still registering (the
    // handler's awaits) has no task to abort — buffer it per caller so the
    // registration finds it and refuses to start
    if (!hadActive) bufferedCancels.set(event.sender.id, Date.now())
    return true
  })
}

/** test seam: the routing decision, pure over the tab list */
export function documentAgentTargetError(tabs: readonly DocumentAgentTab[]): string | undefined {
  const target = resolveTarget(tabs)
  return 'error' in target ? target.error : undefined
}

/** a well-formed status the bridge relays (the kind is the contract) */
export function isAgentTaskStatus(value: unknown): value is AgentTaskStatus {
  if (!value || typeof value !== 'object') return false
  const kind = (value as { kind?: unknown }).kind
  return (
    typeof kind === 'string' &&
    [
      'thinking',
      'reading',
      'inserting',
      'replacing',
      'applying',
      'writing',
      'image',
      'analyzing',
      'other',
    ].includes(kind)
  )
}
