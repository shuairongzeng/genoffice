import type { WebContents } from 'electron'
import type {
  AgentTaskStatus,
  AgentTokenUsage,
  AgentToolCall,
  AttachmentInfo,
  ToolExecution,
} from '@genoffice/agent-core'
import {
  finishAskToolActivity,
  startAskToolActivity,
  type AskToolActivity,
} from '../shared/ask-activity'
import {
  appendReasoningStep,
  appendTextStep,
  deriveCombinedText,
  hydrateTimelineSteps,
  recordToolFinishedStep,
  recordToolStartStep,
  sealStreamingSteps,
  type AskTimelineStep,
} from '../shared/ask-timeline'
import type {
  AskActiveSessionState,
  AskActiveSessionTarget,
  AskRunEvent,
  AskRunSnapshot,
} from '../shared/home-api'
import type { PiAgentConfirmRequest, PiDocCheckpoint } from '../shared/pi-agent-api'

const MAX_SESSION_SNAPSHOTS = 32
const SNAPSHOT_HISTORY_LIMIT = 200

export interface StoredChatEntry {
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly attachments?: readonly unknown[]
}

export interface AskRunHubDeps {
  readonly loadStoredChat?: (
    projectId: string,
    chatId: string,
    limit: number,
  ) => readonly StoredChatEntry[]
  readonly emitToAll: (payload: AskRunEvent, excludeSender?: WebContents) => void
}

export interface PiRunStartInput {
  readonly sessionKey: string
  readonly projectId: string
  readonly chatId: string
  readonly docPath: string | null
  readonly userText: string
  readonly skills?: readonly string[]
  readonly attachments?: readonly AttachmentInfo[]
}

interface PiLiveMessage {
  role: 'assistant'
  text: string
  toolNotes: unknown[]
  steps: AskTimelineStep[]
  activities: AskToolActivity[]
  artifacts: unknown[]
  streaming: boolean
  isError?: boolean
  error?: string
  reasoning?: string
  usage?: { inputTokens: number; outputTokens: number }
  subAgent?: AgentTaskStatus & { docKind?: string }
  docCheckpoints?: Array<PiDocCheckpoint & { reverting?: boolean; reverted?: boolean; error?: string }>
}

interface PiLiveRunRecord {
  readonly sessionKey: string
  readonly projectId: string
  readonly chatId: string
  readonly docPath: string | null
  readonly userText: string
  readonly skills?: readonly string[]
  readonly attachments?: readonly AttachmentInfo[]
  userPersisted: boolean
  assistantPersisted: boolean
  assistant: PiLiveMessage
  accumulatedReasoning: string
  reasoningNeedsBreak: boolean
  piConfirm: PiAgentConfirmRequest | null
  lastEventSeq: number
}

export interface AskRunHub {
  getActiveState(): AskActiveSessionState
  setActiveSession(
    target: AskActiveSessionTarget | null,
    excludeSender?: WebContents,
  ): AskActiveSessionState
  beginPiRun(input: PiRunStartInput): void
  markPiUserPersisted(sessionKey: string): void
  markPiAssistantPersisted(sessionKey: string): void
  setPiConfirm(sessionKey: string, req: PiAgentConfirmRequest | null): void
  applyPiEvent(event: AskRunEvent): void
  finishPiRun(sessionKey: string): void
  publishEvent(event: AskRunEvent, excludeSender?: WebContents): void
  getSnapshot(sessionKey?: string): AskRunSnapshot | null
  clearSession(sessionKey: string): void
}

function normalizeTarget(
  raw: AskActiveSessionTarget | null | undefined,
): AskActiveSessionTarget | null {
  if (!raw || typeof raw !== 'object') return null
  const projectId = typeof raw.projectId === 'string' ? raw.projectId.trim() : ''
  const chatId = typeof raw.chatId === 'string' ? raw.chatId.trim() : ''
  if (!projectId || !chatId) return null
  const docPath =
    typeof raw.docPath === 'string' && raw.docPath.trim() !== '' ? raw.docPath : null
  return { projectId, chatId, docPath }
}

function sameTarget(
  a: AskActiveSessionTarget | null,
  b: AskActiveSessionTarget | null,
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.projectId === b.projectId &&
    a.chatId === b.chatId &&
    (a.docPath ?? null) === (b.docPath ?? null)
  )
}

function extractTargetFromPayload(raw: unknown): AskActiveSessionTarget | null {
  if (!raw || typeof raw !== 'object') return null
  return normalizeTarget(raw as AskActiveSessionTarget)
}

function snapshotKeyOf(evt: AskRunEvent): string {
  if (typeof evt.sessionKey === 'string' && evt.sessionKey !== '') return evt.sessionKey
  if (evt.payload && typeof evt.payload === 'object') {
    const p = evt.payload as { sessionKey?: unknown; projectId?: unknown; chatId?: unknown }
    if (typeof p.sessionKey === 'string' && p.sessionKey !== '') return p.sessionKey
    if (typeof p.projectId === 'string' && p.projectId !== '' && typeof p.chatId === 'string' && p.chatId !== '') {
      return `${p.projectId}:${p.chatId}`
    }
  }
  return ''
}

function addTokenUsage(
  prev: { inputTokens: number; outputTokens: number } | undefined,
  delta: AgentTokenUsage,
): { inputTokens: number; outputTokens: number } {
  return {
    inputTokens: (prev?.inputTokens ?? 0) + (delta.inputTokens ?? 0),
    outputTokens: (prev?.outputTokens ?? 0) + (delta.outputTokens ?? 0),
  }
}

function patchCheckpointInMessages(
  messages: unknown[],
  checkpointId: string,
  patch: Record<string, unknown>,
): unknown[] {
  let changed = false
  const next = messages.map((rawMsg) => {
    if (!rawMsg || typeof rawMsg !== 'object') return rawMsg
    const msg = rawMsg as {
      docCheckpoints?: Array<Record<string, unknown> & { checkpointId?: string }>
    }
    if (!Array.isArray(msg.docCheckpoints)) return rawMsg
    if (!msg.docCheckpoints.some((cp) => cp.checkpointId === checkpointId)) return rawMsg
    changed = true
    return {
      ...msg,
      docCheckpoints: msg.docCheckpoints.map((cp) =>
        cp.checkpointId === checkpointId ? { ...cp, ...patch } : cp,
      ),
    }
  })
  return changed ? next : messages
}

/**
 * Authoritative main-process hub for AI workbench session coordination and live Pi run snapshots.
 * Tracks the single canonical active session across Home and Overlay mounts, assigns monotonic
 * sequence numbers to run events, and reduces Pi runtime events so late-mounted or returning
 * surfaces recover the full ReAct timeline without gaps or duplicates.
 */
export function createAskRunHub(deps: AskRunHubDeps): AskRunHub {
  let seqCounter = 0
  let activeSession: AskActiveSessionTarget | null = null
  const runSnapshotsByKey = new Map<string, AskRunSnapshot>()
  let latestRunSnapshot: AskRunSnapshot | null = null
  const legacyRunningKeys = new Set<string>()
  const piLiveRuns = new Map<string, PiLiveRunRecord>()

  const getRunningKeys = (): string[] => {
    const keys = new Set<string>()
    for (const key of piLiveRuns.keys()) keys.add(key)
    for (const key of legacyRunningKeys) keys.add(key)
    return [...keys]
  }

  const emitRunningSessions = (): void => {
    const keys = getRunningKeys()
    deps.emitToAll({
      type: 'running-sessions',
      seq: ++seqCounter,
      payload: keys,
    })
  }

  const storeSnapshotLru = (key: string, snapshot: AskRunSnapshot): void => {
    latestRunSnapshot = snapshot
    if (!key) return
    runSnapshotsByKey.delete(key)
    runSnapshotsByKey.set(key, snapshot)
    if (runSnapshotsByKey.size > MAX_SESSION_SNAPSHOTS) {
      const oldest = runSnapshotsByKey.keys().next().value
      if (oldest !== undefined) runSnapshotsByKey.delete(oldest)
    }
  }

  const buildPiSnapshot = (
    record: PiLiveRunRecord,
    opts: { finished: boolean },
  ): AskRunSnapshot => {
    const stored = deps.loadStoredChat
      ? deps.loadStoredChat(record.projectId, record.chatId, SNAPSHOT_HISTORY_LIMIT)
      : []

    const messages: unknown[] = stored
      .filter((entry) => entry.role === 'user' || entry.role === 'assistant')
      .map((entry) => ({
        role: entry.role,
        text: entry.text,
        toolNotes: [],
        artifacts: [],
        ...(Array.isArray(entry.attachments) && entry.attachments.length > 0
          ? { attachments: entry.attachments }
          : {}),
      }))

    if (!record.userPersisted && record.userText.trim().length > 0) {
      messages.push({
        role: 'user',
        text: record.userText,
        toolNotes: [],
        artifacts: [],
        ...(record.skills && record.skills.length > 0 ? { skills: [...record.skills] } : {}),
        ...(record.attachments && record.attachments.length > 0
          ? { attachments: [...record.attachments] }
          : {}),
      })
    } else if (record.userPersisted) {
      // Attach transient user skills/attachments to the just-persisted tail user turn when needed.
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const entry = messages[i] as Record<string, unknown>
        if (entry.role !== 'user') break
        if (record.skills && record.skills.length > 0 && !entry.skills) {
          entry.skills = [...record.skills]
        }
        if (record.attachments && record.attachments.length > 0 && !entry.attachments) {
          entry.attachments = [...record.attachments]
        }
        break
      }
    }

    const richAssistant: PiLiveMessage = {
      ...record.assistant,
      steps: [...record.assistant.steps],
      activities: [...record.assistant.activities],
      ...(record.assistant.docCheckpoints
        ? { docCheckpoints: [...record.assistant.docCheckpoints] }
        : {}),
    }

    const hasAssistantContent =
      richAssistant.text.trim().length > 0 ||
      richAssistant.steps.length > 0 ||
      richAssistant.activities.length > 0 ||
      Boolean(richAssistant.reasoning) ||
      Boolean(richAssistant.isError) ||
      Boolean(richAssistant.error) ||
      Boolean(richAssistant.docCheckpoints?.length)

    if (opts.finished) {
      if (record.assistantPersisted && messages.length > 0) {
        const tail = messages[messages.length - 1] as { role?: string } | undefined
        if (tail?.role === 'assistant') {
          messages[messages.length - 1] = richAssistant
        } else if (hasAssistantContent) {
          messages.push(richAssistant)
        }
      } else if (hasAssistantContent) {
        messages.push(richAssistant)
      }
    } else {
      messages.push(richAssistant)
    }

    return {
      sessionKey: record.sessionKey,
      projectId: record.projectId,
      chatId: record.chatId,
      docPath: record.docPath,
      messages,
      liveRun: opts.finished
        ? null
        : {
            text: richAssistant.text,
            reasoning: richAssistant.reasoning ?? '',
            busy: true,
          },
      confirmCard: null,
      piConfirm: opts.finished ? null : record.piConfirm,
      eventSeq: Math.max(record.lastEventSeq, seqCounter),
    }
  }

  const reducePiEvent = (record: PiLiveRunRecord, evt: AskRunEvent, seq: number): void => {
    const now = Date.now()
    const assistant = record.assistant
    record.lastEventSeq = seq

    switch (evt.type) {
      case 'text': {
        const text = typeof evt.payload === 'string' ? evt.payload : ''
        if (text.trim().length === 0) break
        const steps = appendTextStep(hydrateTimelineSteps(assistant), text, now)
        assistant.steps = steps
        assistant.text = deriveCombinedText(steps, text)
        break
      }
      case 'reasoning': {
        const chunk = typeof evt.payload === 'string' ? evt.payload : ''
        if (!chunk) break
        if (
          record.reasoningNeedsBreak &&
          record.accumulatedReasoning.length > 0 &&
          !record.accumulatedReasoning.endsWith('\n\n') &&
          !chunk.startsWith('\n\n')
        ) {
          record.accumulatedReasoning += record.accumulatedReasoning.endsWith('\n') ? '\n' : '\n\n'
        }
        record.reasoningNeedsBreak = false
        record.accumulatedReasoning += chunk
        assistant.reasoning = record.accumulatedReasoning
        assistant.steps = appendReasoningStep(hydrateTimelineSteps(assistant), chunk, now)
        break
      }
      case 'tool-start': {
        record.reasoningNeedsBreak = true
        const call = evt.payload as AgentToolCall | undefined
        if (!call || typeof call.id !== 'string') break
        assistant.activities = startAskToolActivity(assistant.activities, call)
        assistant.steps = recordToolStartStep(hydrateTimelineSteps(assistant), call.id, now)
        break
      }
      case 'tool-executed': {
        record.reasoningNeedsBreak = true
        const data = evt.payload as
          | { call?: AgentToolCall; execution?: ToolExecution }
          | undefined
        if (!data?.call || !data.execution) break
        assistant.activities = finishAskToolActivity(
          assistant.activities,
          data.call,
          data.execution,
        )
        assistant.steps = recordToolFinishedStep(
          hydrateTimelineSteps(assistant),
          data.call.id,
          now,
        )
        if (data.call.name === 'document_agent') {
          assistant.subAgent = undefined
        }
        break
      }
      case 'subagent-progress': {
        const subAgent = evt.payload as (AgentTaskStatus & { docKind?: string }) | undefined
        if (subAgent) assistant.subAgent = subAgent
        break
      }
      case 'checkpoint-added': {
        const cp = evt.payload as PiDocCheckpoint | undefined
        if (!cp) break
        assistant.docCheckpoints = [...(assistant.docCheckpoints ?? []), cp]
        break
      }
      case 'checkpoint-updated': {
        const update = evt.payload as (Record<string, unknown> & { checkpointId?: string }) | undefined
        if (!update?.checkpointId || !assistant.docCheckpoints) break
        assistant.docCheckpoints = assistant.docCheckpoints.map((cp) =>
          cp.checkpointId === update.checkpointId ? { ...cp, ...update } : cp,
        )
        break
      }
      case 'usage': {
        const usage = evt.payload as AgentTokenUsage | undefined
        if (usage) {
          assistant.usage = addTokenUsage(assistant.usage, usage)
        }
        break
      }
      case 'error': {
        record.reasoningNeedsBreak = false
        const errorText = typeof evt.payload === 'string' && evt.payload ? evt.payload : 'Error'
        const hasText = assistant.text.trim().length > 0
        const sealed = sealStreamingSteps(hydrateTimelineSteps(assistant), now)
        const nextSteps = hasText
          ? sealed
          : sealStreamingSteps(appendTextStep(sealed, errorText, now), now)
        assistant.text = hasText ? assistant.text : errorText
        assistant.steps = nextSteps
        assistant.streaming = false
        assistant.isError = !hasText
        assistant.error = hasText ? errorText : undefined
        assistant.subAgent = undefined
        record.piConfirm = null
        break
      }
      case 'done': {
        record.reasoningNeedsBreak = false
        assistant.streaming = false
        assistant.steps = sealStreamingSteps(hydrateTimelineSteps(assistant), now)
        assistant.subAgent = undefined
        record.piConfirm = null
        break
      }
      default:
        break
    }
  }

  return {
    getActiveState(): AskActiveSessionState {
      return {
        session: activeSession ? { ...activeSession } : null,
        runningSessionKeys: getRunningKeys(),
      }
    },

    setActiveSession(
      target: AskActiveSessionTarget | null,
      excludeSender?: WebContents,
    ): AskActiveSessionState {
      const normalized = normalizeTarget(target)
      const changed = !sameTarget(activeSession, normalized)
      activeSession = normalized
      if (changed && normalized !== null) {
        const sessionKey = `${normalized.projectId}:${normalized.chatId}`
        deps.emitToAll(
          {
            type: 'switch-session',
            sessionKey,
            seq: ++seqCounter,
            payload: normalized,
          },
          excludeSender,
        )
      }
      return this.getActiveState()
    },

    beginPiRun(input: PiRunStartInput): void {
      const record: PiLiveRunRecord = {
        sessionKey: input.sessionKey,
        projectId: input.projectId,
        chatId: input.chatId,
        docPath: input.docPath ?? null,
        userText: input.userText,
        ...(input.skills && input.skills.length > 0 ? { skills: [...input.skills] } : {}),
        ...(input.attachments && input.attachments.length > 0
          ? { attachments: [...input.attachments] }
          : {}),
        userPersisted: false,
        assistantPersisted: false,
        assistant: {
          role: 'assistant',
          text: '',
          toolNotes: [],
          steps: [],
          activities: [],
          artifacts: [],
          streaming: true,
        },
        accumulatedReasoning: '',
        reasoningNeedsBreak: false,
        piConfirm: null,
        lastEventSeq: seqCounter,
      }
      piLiveRuns.set(input.sessionKey, record)
      if (activeSession === null) {
        activeSession = {
          projectId: input.projectId,
          chatId: input.chatId,
          docPath: input.docPath ?? null,
        }
      }
      emitRunningSessions()
    },

    markPiUserPersisted(sessionKey: string): void {
      const record = piLiveRuns.get(sessionKey)
      if (record) record.userPersisted = true
    },

    markPiAssistantPersisted(sessionKey: string): void {
      const record = piLiveRuns.get(sessionKey)
      if (record) record.assistantPersisted = true
    },

    setPiConfirm(sessionKey: string, req: PiAgentConfirmRequest | null): void {
      const record = piLiveRuns.get(sessionKey)
      if (record) record.piConfirm = req
    },

    applyPiEvent(event: AskRunEvent): void {
      const seq = ++seqCounter
      const stamped: AskRunEvent = { ...event, seq }
      const key = event.sessionKey
      if (key) {
        const record = piLiveRuns.get(key)
        if (record) reducePiEvent(record, stamped, seq)
      }
      deps.emitToAll(stamped)
    },

    finishPiRun(sessionKey: string): void {
      const record = piLiveRuns.get(sessionKey)
      if (!record) return
      record.assistant.streaming = false
      record.assistant.steps = sealStreamingSteps(
        hydrateTimelineSteps(record.assistant),
        Date.now(),
      )
      record.assistant.subAgent = undefined
      record.piConfirm = null
      piLiveRuns.delete(sessionKey)
      emitRunningSessions()
      const finalized = buildPiSnapshot(record, { finished: true })
      storeSnapshotLru(sessionKey, finalized)
    },

    publishEvent(event: AskRunEvent, excludeSender?: WebContents): void {
      if (!event || typeof event !== 'object') return
      const seq = ++seqCounter

      if (event.type === 'switch-session') {
        const target = extractTargetFromPayload(event.payload)
        if (target) {
          activeSession = target
        }
        deps.emitToAll({ ...event, seq }, excludeSender)
        return
      }

      if (event.type === 'snapshot') {
        const snapKey = snapshotKeyOf(event)
        // Live Pi runs own the authoritative snapshot in main; ignore renderer-authored
        // snapshots for those keys to avoid clobbering active timeline state.
        if (snapKey && piLiveRuns.has(snapKey)) {
          return
        }
        const rawSnap = (event.payload ?? {}) as AskRunSnapshot
        const stampedSnap: AskRunSnapshot = {
          ...rawSnap,
          ...(snapKey && !rawSnap.sessionKey ? { sessionKey: snapKey } : {}),
          eventSeq: seqCounter,
        }
        storeSnapshotLru(snapKey, stampedSnap)
        let runningChanged = false
        if (snapKey) {
          const isBusy = rawSnap.liveRun?.busy === true
          if (isBusy && !legacyRunningKeys.has(snapKey)) {
            legacyRunningKeys.add(snapKey)
            runningChanged = true
          } else if (!isBusy && legacyRunningKeys.delete(snapKey)) {
            runningChanged = true
          }
        }
        deps.emitToAll({ ...event, seq, payload: stampedSnap }, excludeSender)
        if (runningChanged) emitRunningSessions()
        return
      }

      if (event.type === 'checkpoint-updated' && event.sessionKey) {
        const update = event.payload as
          | (Record<string, unknown> & { checkpointId?: string })
          | undefined
        if (update?.checkpointId) {
          const liveRecord = piLiveRuns.get(event.sessionKey)
          if (liveRecord?.assistant.docCheckpoints) {
            liveRecord.assistant.docCheckpoints = liveRecord.assistant.docCheckpoints.map((cp) =>
              cp.checkpointId === update.checkpointId ? { ...cp, ...update } : cp,
            )
          }
          const cachedSnap = runSnapshotsByKey.get(event.sessionKey)
          if (cachedSnap && Array.isArray(cachedSnap.messages)) {
            const patched = patchCheckpointInMessages(
              cachedSnap.messages,
              update.checkpointId,
              update,
            )
            if (patched !== cachedSnap.messages) {
              storeSnapshotLru(event.sessionKey, {
                ...cachedSnap,
                messages: patched,
                eventSeq: seq,
              })
            }
          }
        }
      }

      const key = event.sessionKey
      if (key && !piLiveRuns.has(key)) {
        let runningChanged = false
        if (
          event.type === 'text' ||
          event.type === 'reasoning' ||
          event.type === 'tool-start' ||
          event.type === 'tool-executed' ||
          event.type === 'subagent-progress'
        ) {
          if (!legacyRunningKeys.has(key)) {
            legacyRunningKeys.add(key)
            runningChanged = true
          }
        } else if (event.type === 'done' || event.type === 'error') {
          if (legacyRunningKeys.delete(key)) {
            runningChanged = true
          }
        }
        if (runningChanged) emitRunningSessions()
      }

      deps.emitToAll({ ...event, seq }, excludeSender)
    },

    getSnapshot(sessionKey?: string): AskRunSnapshot | null {
      const requestedKey = typeof sessionKey === 'string' ? sessionKey.trim() : ''
      if (requestedKey) {
        const live = piLiveRuns.get(requestedKey)
        if (live) return buildPiSnapshot(live, { finished: false })
        return runSnapshotsByKey.get(requestedKey) ?? null
      }
      if (activeSession) {
        const activeKey = `${activeSession.projectId}:${activeSession.chatId}`
        const live = piLiveRuns.get(activeKey)
        if (live) return buildPiSnapshot(live, { finished: false })
        const cachedActive = runSnapshotsByKey.get(activeKey)
        if (cachedActive) return cachedActive
      }
      const firstLive = piLiveRuns.values().next().value as PiLiveRunRecord | undefined
      if (firstLive) return buildPiSnapshot(firstLive, { finished: false })
      return latestRunSnapshot
    },

    clearSession(sessionKey: string): void {
      runSnapshotsByKey.delete(sessionKey)
      legacyRunningKeys.delete(sessionKey)
      if (latestRunSnapshot?.sessionKey === sessionKey) {
        latestRunSnapshot = null
      }
    },
  }
}
