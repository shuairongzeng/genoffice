import { describe, expect, it } from 'vitest'
import type { AskRunEvent } from '../src/shared/home-api'
import { createAskRunHub, type StoredChatEntry } from '../src/main/ask-run-hub'

describe('createAskRunHub', () => {
  it('tracks authoritative activeSession and broadcasts switch-session only when changed', () => {
    const emitted: Array<{ payload: AskRunEvent; excludeSender?: unknown }> = []
    const hub = createAskRunHub({
      emitToAll: (payload, excludeSender) => emitted.push({ payload, excludeSender }),
    })

    expect(hub.getActiveState()).toEqual({ session: null, runningSessionKeys: [] })

    const senderA = { id: 'home' } as never
    const first = hub.setActiveSession(
      { projectId: 'default', chatId: 'kb-ask', docPath: null },
      senderA,
    )
    expect(first).toEqual({
      session: { projectId: 'default', chatId: 'kb-ask', docPath: null },
      runningSessionKeys: [],
    })
    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.payload).toMatchObject({
      type: 'switch-session',
      sessionKey: 'default:kb-ask',
      payload: { projectId: 'default', chatId: 'kb-ask', docPath: null },
    })
    expect(emitted[0]!.excludeSender).toBe(senderA)

    // Setting an identical target must not emit duplicate broadcasts.
    hub.setActiveSession({ projectId: 'default', chatId: 'kb-ask', docPath: null }, senderA)
    expect(emitted).toHaveLength(1)
  })

  it('maintains live Pi ReAct timeline snapshot, dedups user turns, and restores piConfirm', () => {
    const storedChats = new Map<string, StoredChatEntry[]>()
    const emitted: AskRunEvent[] = []
    const hub = createAskRunHub({
      loadStoredChat: (projectId, chatId) => storedChats.get(`${projectId}:${chatId}`) ?? [],
      emitToAll: (payload) => emitted.push(payload),
    })

    const sessionKey = 'default:kb-ask'
    storedChats.set(sessionKey, [
      { role: 'user', text: 'Earlier question' },
      { role: 'assistant', text: 'Earlier reply' },
    ])

    hub.beginPiRun({
      sessionKey,
      projectId: 'default',
      chatId: 'kb-ask',
      docPath: null,
      userText: 'Create summary doc',
      skills: ['writer'],
    })

    // Before store persistence, snapshot synthesizes the pending user turn once.
    const prePersistSnap = hub.getSnapshot(sessionKey)!
    expect(prePersistSnap.messages).toHaveLength(4)
    expect((prePersistSnap.messages[2] as { text: string; skills?: string[] }).text).toBe(
      'Create summary doc',
    )
    expect((prePersistSnap.messages[2] as { skills?: string[] }).skills).toEqual(['writer'])
    expect(prePersistSnap.liveRun).toEqual({ text: '', reasoning: '', busy: true })
    expect(hub.getActiveState().runningSessionKeys).toEqual([sessionKey])

    // Once pi-runtime appends the user message to project-store, avoid duplication.
    storedChats.get(sessionKey)!.push({ role: 'user', text: 'Create summary doc' })
    hub.markPiUserPersisted(sessionKey)

    hub.applyPiEvent({ type: 'reasoning', sessionKey, payload: 'Checking open tabs first.' })
    hub.applyPiEvent({
      type: 'tool-start',
      sessionKey,
      payload: { id: 'call-1', name: 'create_document', input: { title: 'Summary' } },
    })
    hub.setPiConfirm(sessionKey, {
      requestId: 'req-99',
      sessionKey,
      call: { id: 'call-1', name: 'create_document', input: { title: 'Summary' } },
      sessionAllowable: true,
    })

    const midSnap = hub.getSnapshot(sessionKey)!
    expect(midSnap.messages).toHaveLength(4)
    const assistantMid = midSnap.messages[3] as {
      streaming: boolean
      steps: Array<{ kind: string }>
      activities: Array<{ id: string; status: string }>
    }
    expect(assistantMid.streaming).toBe(true)
    expect(assistantMid.steps.map((s) => s.kind)).toEqual(['thinking', 'tool'])
    expect(assistantMid.activities).toMatchObject([{ id: 'call-1', status: 'running' }])
    expect(midSnap.piConfirm?.requestId).toBe('req-99')

    hub.setPiConfirm(sessionKey, null)
    hub.applyPiEvent({
      type: 'tool-executed',
      sessionKey,
      payload: {
        call: { id: 'call-1', name: 'create_document', input: { title: 'Summary' } },
        execution: { output: 'path: C:/Summary.docx', summary: 'saved', isError: false },
      },
    })
    hub.applyPiEvent({ type: 'text', sessionKey, payload: 'Summary document is ready.' })
    hub.applyPiEvent({ type: 'done', sessionKey, payload: null })

    // Persist plain assistant text as pi-runtime does, mark persisted, and finish run.
    storedChats.get(sessionKey)!.push({ role: 'assistant', text: 'Summary document is ready.' })
    hub.markPiAssistantPersisted(sessionKey)
    hub.finishPiRun(sessionKey)

    expect(hub.getActiveState().runningSessionKeys).toEqual([])
    const settledSnap = hub.getSnapshot(sessionKey)!
    expect(settledSnap.liveRun).toBeNull()
    expect(settledSnap.messages).toHaveLength(4)
    const assistantEnd = settledSnap.messages[3] as {
      text: string
      streaming: boolean
      steps: Array<{ kind: string }>
      activities: Array<{ id: string; status: string }>
    }
    expect(assistantEnd.streaming).toBe(false)
    expect(assistantEnd.text).toBe('Summary document is ready.')
    expect(assistantEnd.steps.map((s) => s.kind)).toEqual(['thinking', 'tool', 'text'])
    expect(assistantEnd.activities).toMatchObject([{ id: 'call-1', status: 'done' }])

    // Verify monotonic sequence numbers across emitted events.
    const seqs = emitted.map((e) => e.seq ?? 0)
    expect(seqs.every((s, idx) => idx === 0 || s > seqs[idx - 1]!)).toBe(true)
    expect(settledSnap.eventSeq).toBeGreaterThanOrEqual(seqs.at(-1) ?? 0)
  })
})
