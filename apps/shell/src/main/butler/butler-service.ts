import { randomBytes } from 'node:crypto'
import type { Lang } from '@genoffice/i18n'

import {
  MAX_BUTLER_INSTRUCTION,
  type ButlerBriefing,
  type ButlerHudState,
  type ButlerStep,
  type ButlerStepKind,
  type ButlerSubmitResult,
  type ButlerTaskStatus,
  type ButlerTaskUpdate,
} from '../../shared/butler-api'
import type { ButlerPrefs } from '../../shared/butler-prefs'
import { HOME_CHANNELS, type AskRunEvent, type TodoItem } from '../../shared/home-api'
import type {
  PiAgentConfirmRequest,
  PiAgentPromptRequest,
  PiAgentPromptResult,
} from '../../shared/pi-agent-api'
import type { PiRunStartInput } from '../ask-run-hub'
import type { AskRunObserver } from '../ask-run-observer'
import { buildButlerBriefing, formatLocalDayKey, type ButlerTaskRecord } from './butler-briefing'
import type { ButlerPersistedState } from './butler-prefs-store'
import { tButler } from './butler-strings'
import { createInterruptGate } from './interrupt-gate'

const MAX_TITLE_LEN = 60
const MAX_SUMMARY_LEN = 90
const MAX_HUD_TASKS = 6
const MAX_PERSISTED_TASKS = 30
const DEFAULT_PROJECT_ID = 'default'

export interface ButlerServiceDeps {
  readPrefs: () => ButlerPrefs
  readState: () => ButlerPersistedState
  writeState: (state: ButlerPersistedState) => void | Promise<void>
  now: () => number
  lang: () => Lang
  isShellFocused: () => boolean
  activeSessionKey: () => string | null
  notify: (opts: { title: string; body: string; onClick: () => void }) => void
  flashFrame: (on: boolean) => void
  hud: { send(channel: string, payload: unknown): void; isVisible(): boolean }
  openSession: (sessionKey: string) => void
  prompt: (req: PiAgentPromptRequest) => Promise<PiAgentPromptResult>
  engine: () => 'pi' | 'legacy'
  ensureDefaultProject: () => void
  readTodos: () => readonly TodoItem[]
  readRecents: () => readonly { path: string; name: string; mtimeMs: number; missing?: boolean }[]
  hotkey: () => string | null
  newChatId?: () => string
}

export interface ButlerService {
  readonly observer: AskRunObserver
  submit(text: string): ButlerSubmitResult
  hudState(opts?: { forceBriefing?: boolean; peek?: boolean }): ButlerHudState
}

interface LiveTaskRecord {
  readonly sessionKey: string
  readonly title: string
  status: ButlerTaskStatus
  step: ButlerStep | null
  readonly startedAt: number
  readonly fromButler: boolean
  lastText: string
  errorMsg: string
  aborted: boolean
  finished: boolean
}

function extractTitle(text: string, fallback: string): string {
  const firstLine = text.trim().split(/\r?\n/)[0]?.trim() ?? ''
  if (!firstLine) return fallback
  return firstLine.slice(0, MAX_TITLE_LEN)
}

function defaultChatId(now: number): string {
  const d = new Date(now)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hours = String(d.getHours()).padStart(2, '0')
  const minutes = String(d.getMinutes()).padStart(2, '0')
  const seconds = String(d.getSeconds()).padStart(2, '0')
  const suffix = randomBytes(2).toString('hex')
  return `butler-${year}${month}${day}-${hours}${minutes}${seconds}-${suffix}`
}

/** Map a runtime tool name onto one coarse-grained Butler HUD step kind. */
function stepKindForTool(name: string): ButlerStepKind {
  const lower = name.toLowerCase()
  if (lower === 'read' || lower.startsWith('read_') || lower.includes(':read_')) {
    return 'read'
  }
  if (lower === 'grep' || lower === 'find' || lower.includes('search')) {
    return 'search'
  }
  if (lower.startsWith('browser:')) {
    return 'browse'
  }
  if (lower === 'document_agent' || lower === 'edit' || lower === 'write') {
    return 'edit'
  }
  if (lower === 'create_document' || lower === 'run_genoffice') {
    return 'create'
  }
  if (lower === 'bash' || lower === 'powershell') {
    return 'command'
  }
  return 'other'
}

function stripSimpleMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`+/g, '')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+)/gm, '')
    .replace(/[*_~#]/g, '')
}

function extractSummary(lastText: string): string {
  if (!lastText.trim()) return ''
  const stripped = stripSimpleMarkdown(lastText)
  const firstLine =
    stripped
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .find((line) => line.length > 0) ?? ''
  if (!firstLine) return ''

  const sentenceMatch = /^.+?(?:[。！？!?]|(?<=\S)\.(?=\s|$))/.exec(firstLine)
  const candidate = (sentenceMatch ? sentenceMatch[0] : firstLine).trim()
  if (candidate.length <= MAX_SUMMARY_LEN) return candidate
  return `${candidate.slice(0, MAX_SUMMARY_LEN - 1)}…`
}

function formatWithOptionalHonorific(text: string, honorific: string): string {
  if (honorific.trim().length > 0) return text.trim()
  return text.replace(/^[\s,，、.。]+/, '').trim()
}

function isLiveStatus(status: ButlerTaskStatus): boolean {
  return status === 'running' || status === 'confirm'
}

/**
 * Create the main-process Butler coordinator: tracks live Pi runs via
 * `AskRunObserver`, dispatches background HUD commands, enforces interrupt
 * rate limits / DND, and builds once-daily briefings.
 */
export function createButlerService(deps: ButlerServiceDeps): ButlerService {
  const gate = createInterruptGate()
  const records = new Map<string, LiveTaskRecord>()
  const updatesBySession = new Map<string, ButlerTaskUpdate>()
  const pendingSubmissions = new Map<string, { title: string; startedAt: number }>()

  let lastBriefingDayInMem: string | null = null
  let lastBriefingAtInMem: number | null = null

  const fireWriteState = (state: ButlerPersistedState): void => {
    try {
      void Promise.resolve(deps.writeState(state)).catch(() => {})
    } catch {
      // Persistence errors must never crash active runs or IPC handlers.
    }
  }

  const pushUpdate = (update: ButlerTaskUpdate): void => {
    updatesBySession.set(update.sessionKey, update)
    deps.hud.send(HOME_CHANNELS.butlerTaskUpdate, update)
  }

  const toUpdate = (
    record: LiveTaskRecord,
    extras?: { summary?: string; error?: string },
  ): ButlerTaskUpdate => ({
    sessionKey: record.sessionKey,
    title: record.title,
    status: record.status,
    step: record.step,
    ...(extras?.summary ? { summary: extras.summary } : {}),
    ...(extras?.error ? { error: extras.error } : {}),
    startedAt: record.startedAt,
    fromButler: record.fromButler,
  })

  const observer: AskRunObserver = {
    onBegin(input: PiRunStartInput): void {
      const wasPending = pendingSubmissions.delete(input.sessionKey)
      const record: LiveTaskRecord = {
        sessionKey: input.sessionKey,
        title: extractTitle(input.userText, input.chatId),
        status: 'running',
        step: null,
        startedAt: deps.now(),
        fromButler: input.chatId.startsWith('butler-') || wasPending,
        lastText: '',
        errorMsg: '',
        aborted: false,
        finished: false,
      }
      records.set(input.sessionKey, record)
      pushUpdate(toUpdate(record))
    },

    onEvent(event: AskRunEvent): void {
      if (!event.sessionKey) return
      const record = records.get(event.sessionKey)
      if (!record || record.finished) return

      switch (event.type) {
        case 'tool-start': {
          const toolName =
            event.payload && typeof event.payload === 'object'
              ? (event.payload as { name?: unknown }).name
              : undefined
          if (typeof toolName === 'string' && toolName.trim().length > 0) {
            record.step = { tool: toolName, kind: stepKindForTool(toolName) }
            pushUpdate(toUpdate(record))
          }
          break
        }
        case 'reasoning': {
          if (record.step === null) {
            record.step = { tool: 'thinking', kind: 'think' }
            pushUpdate(toUpdate(record))
          }
          break
        }
        case 'text': {
          if (typeof event.payload === 'string') {
            record.lastText = event.payload
          }
          break
        }
        case 'error': {
          const msg =
            typeof event.payload === 'string' ? event.payload : String(event.payload ?? '')
          record.errorMsg = msg || 'Error'
          break
        }
        case 'stop': {
          record.aborted = true
          break
        }
      }
    },

    onConfirm(sessionKey: string, req: PiAgentConfirmRequest | null): void {
      const record = records.get(sessionKey)
      if (!record || record.finished) return

      if (req !== null) {
        record.status = 'confirm'
        pushUpdate(toUpdate(record))

        const prefs = deps.readPrefs()
        const now = deps.now()
        if (
          prefs.notifyConfirm &&
          (!deps.isShellFocused() || deps.activeSessionKey() !== sessionKey) &&
          gate.allow('confirm', now, prefs)
        ) {
          const lang = deps.lang()
          deps.notify({
            title: tButler(lang, 'notifyConfirmTitle', { name: prefs.name }),
            body: tButler(lang, 'notifyConfirmBody', {
              title: record.title,
              tool: req.call.name,
            }),
            onClick: () => deps.openSession(sessionKey),
          })
          if (!deps.isShellFocused()) {
            deps.flashFrame(true)
          }
        }
        return
      }

      if (record.status !== 'running') {
        record.status = 'running'
        pushUpdate(toUpdate(record))
      }
    },

    onFinish(sessionKey: string): void {
      const record = records.get(sessionKey)
      if (!record || record.finished) return
      record.finished = true
      record.step = null

      if (record.aborted) {
        record.status = 'done'
        pushUpdate(toUpdate(record))
        return
      }

      const now = deps.now()
      const status: 'done' | 'error' = record.errorMsg ? 'error' : 'done'
      record.status = status
      const summary = status === 'done' ? extractSummary(record.lastText) : ''

      pushUpdate(
        toUpdate(
          record,
          status === 'done' ? (summary ? { summary } : undefined) : { error: record.errorMsg },
        ),
      )

      const isBackground = record.fromButler || !deps.isShellFocused()
      if (isBackground) {
        const latestState = deps.readState()
        const entry: ButlerTaskRecord = {
          sessionKey,
          title: record.title,
          status,
          finishedAt: now,
        }
        const nextTasks = [
          entry,
          ...latestState.tasks.filter((t) => t.sessionKey !== sessionKey),
        ].slice(0, MAX_PERSISTED_TASKS)
        fireWriteState({
          lastBriefingDay: lastBriefingDayInMem ?? latestState.lastBriefingDay,
          lastBriefingAt: lastBriefingAtInMem ?? latestState.lastBriefingAt,
          tasks: nextTasks,
        })
      }

      const prefs = deps.readPrefs()
      const lang = deps.lang()
      const honorific = prefs.honorific.trim()

      if (prefs.notifyDone && !deps.isShellFocused() && gate.allow(status, now, prefs)) {
        const title = tButler(lang, status === 'done' ? 'notifyDoneTitle' : 'notifyErrorTitle', {
          name: prefs.name,
        })
        const rawBody =
          status === 'done'
            ? tButler(lang, 'notifyDoneBody', {
                honorific,
                title: record.title,
                summary,
              })
            : tButler(lang, 'notifyErrorBody', {
                title: record.title,
                error: record.errorMsg,
              })
        const body = status === 'done' ? formatWithOptionalHonorific(rawBody, honorific) : rawBody
        deps.notify({
          title,
          body,
          onClick: () => deps.openSession(sessionKey),
        })
      }

      if (isBackground && prefs.voice && !prefs.dnd) {
        const rawSpeak = tButler(lang, status === 'done' ? 'speakDone' : 'speakError', {
          honorific,
          title: record.title,
        })
        const text = formatWithOptionalHonorific(rawSpeak, honorific)
        deps.hud.send(HOME_CHANNELS.butlerSpeak, { text })
      }
    },
  }

  return {
    observer,

    submit(text: string): ButlerSubmitResult {
      const trimmed = text.trim()
      if (!trimmed) {
        return { ok: false, error: 'empty' }
      }

      const prefs = deps.readPrefs()
      if (!prefs.enabled) {
        return { ok: false, error: 'disabled' }
      }

      if (deps.engine() === 'legacy') {
        return { ok: false, error: 'legacy' }
      }

      const instruction = trimmed.slice(0, MAX_BUTLER_INSTRUCTION)
      deps.ensureDefaultProject()

      const now = deps.now()
      const chatId = deps.newChatId?.() || defaultChatId(now)
      const projectId = DEFAULT_PROJECT_ID
      const sessionKey = `${projectId}:${chatId}`
      const title = extractTitle(instruction, chatId)

      pendingSubmissions.set(sessionKey, { title, startedAt: now })

      const emitEarlyFailure = (errMsg: string): void => {
        if (!pendingSubmissions.delete(sessionKey)) return
        pushUpdate({
          sessionKey,
          title,
          status: 'error',
          step: null,
          error: errMsg,
          startedAt: now,
          fromButler: true,
        })
      }

      let promptPromise: Promise<PiAgentPromptResult>
      try {
        promptPromise = deps.prompt({
          sessionKey,
          projectId,
          chatId,
          docPath: null,
          instruction,
          lang: deps.lang(),
        })
      } catch (err) {
        promptPromise = Promise.reject(err)
      }

      void promptPromise.then(
        (res) => {
          if (!pendingSubmissions.has(sessionKey)) return
          if (!res.ok) {
            emitEarlyFailure(res.error || 'Failed to start task')
          } else {
            pendingSubmissions.delete(sessionKey)
          }
        },
        (err: unknown) => {
          const errMsg = err instanceof Error ? err.message : String(err ?? '')
          emitEarlyFailure(errMsg || 'Failed to start task')
        },
      )

      return { ok: true, sessionKey }
    },

    hudState(opts?: { forceBriefing?: boolean; peek?: boolean }): ButlerHudState {
      const now = deps.now()
      const prefs = deps.readPrefs()
      const todayKey = formatLocalDayKey(now)
      const stored = deps.readState()
      const effectiveLastDay = lastBriefingDayInMem ?? stored.lastBriefingDay
      const fresh = effectiveLastDay !== todayKey

      let briefing: ButlerBriefing | null = null
      if (prefs.briefing && opts?.peek !== true && (fresh || opts?.forceBriefing === true)) {
        const liveConfirms = [...records.values()]
          .filter((r) => !r.finished && r.status === 'confirm')
          .map((r) => ({ sessionKey: r.sessionKey, title: r.title }))

        briefing = buildButlerBriefing({
          now,
          todos: deps.readTodos(),
          recents: deps.readRecents(),
          tasks: stored.tasks,
          liveConfirms,
          since: stored.lastBriefingAt,
        })

        if (fresh) {
          lastBriefingDayInMem = todayKey
          lastBriefingAtInMem = now
          fireWriteState({
            ...stored,
            lastBriefingDay: todayKey,
            lastBriefingAt: now,
          })
        }
      }

      const tasks = [...updatesBySession.values()]
        .sort((a, b) => {
          const aRank = isLiveStatus(a.status) ? 0 : 1
          const bRank = isLiveStatus(b.status) ? 0 : 1
          if (aRank !== bRank) return aRank - bRank
          return b.startedAt - a.startedAt
        })
        .slice(0, MAX_HUD_TASKS)

      return {
        prefs,
        hotkey: deps.hotkey(),
        briefing,
        tasks,
      }
    },
  }
}
