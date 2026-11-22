import { describe, expect, it, vi } from 'vitest'

import type { ButlerPersistedState } from '../src/main/butler/butler-prefs-store'
import { createButlerService, type ButlerServiceDeps } from '../src/main/butler/butler-service'
import { MAX_BUTLER_INSTRUCTION, type ButlerTaskUpdate } from '../src/shared/butler-api'
import { DEFAULT_BUTLER_PREFS, type ButlerPrefs } from '../src/shared/butler-prefs'
import { HOME_CHANNELS } from '../src/shared/home-api'
import type { PiAgentConfirmRequest, PiAgentPromptResult } from '../src/shared/pi-agent-api'

function localTs(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

function makeHarness(overrides?: Partial<ButlerServiceDeps>) {
  let currentNow = localTs(2026, 11, 22, 10, 0)
  let prefs: ButlerPrefs = { ...DEFAULT_BUTLER_PREFS }
  let state: ButlerPersistedState = {
    lastBriefingDay: null,
    lastBriefingAt: null,
    tasks: [],
  }
  let focused = false
  let activeSession: string | null = null
  let engineKind: 'pi' | 'legacy' = 'pi'
  let chatCounter = 0

  const notifications: Array<{ title: string; body: string; onClick: () => void }> = []
  const hudMessages: Array<{ channel: string; payload: unknown }> = []
  const flashCalls: boolean[] = []
  const openedSessions: string[] = []
  const writeStateCalls: ButlerPersistedState[] = []

  const promptSpy = vi.fn(async (): Promise<PiAgentPromptResult> => ({
    ok: true,
  }))
  const ensureDefaultProjectSpy = vi.fn()

  const deps: ButlerServiceDeps = {
    readPrefs: () => prefs,
    readState: () => state,
    writeState: (next) => {
      state = next
      writeStateCalls.push(next)
    },
    now: () => currentNow,
    lang: () => 'zh',
    isShellFocused: () => focused,
    activeSessionKey: () => activeSession,
    notify: (opts) => notifications.push(opts),
    flashFrame: (on) => flashCalls.push(on),
    hud: {
      send: (channel, payload) => hudMessages.push({ channel, payload }),
      isVisible: () => true,
    },
    openSession: (sessionKey) => openedSessions.push(sessionKey),
    prompt: promptSpy,
    engine: () => engineKind,
    ensureDefaultProject: ensureDefaultProjectSpy,
    readTodos: () => [],
    readRecents: () => [],
    hotkey: () => 'Alt+Space',
    newChatId: () => `butler-test-${++chatCounter}`,
    ...overrides,
  }

  const service = createButlerService(deps)

  return {
    service,
    notifications,
    hudMessages,
    flashCalls,
    openedSessions,
    writeStateCalls,
    promptSpy,
    ensureDefaultProjectSpy,
    setNow: (ts: number) => {
      currentNow = ts
    },
    setPrefs: (patch: Partial<ButlerPrefs>) => {
      prefs = { ...prefs, ...patch }
    },
    setState: (next: ButlerPersistedState) => {
      state = next
    },
    getState: () => state,
    setFocused: (v: boolean) => {
      focused = v
    },
    setActiveSession: (sk: string | null) => {
      activeSession = sk
    },
    setEngine: (e: 'pi' | 'legacy') => {
      engineKind = e
    },
  }
}

describe('butler-service observer & notifications', () => {
  it('notifies, persists, strips markdown summary, and speaks on unfocused done run', () => {
    const h = makeHarness()
    const { observer } = h.service
    const sessionKey = 'default:butler-1'

    observer.onBegin?.({
      sessionKey,
      projectId: 'default',
      chatId: 'butler-1',
      docPath: null,
      userText: '整理本周销售周报\n补充图表',
    })

    observer.onEvent?.({ type: 'reasoning', sessionKey, payload: 'thinking...' })
    observer.onEvent?.({
      type: 'tool-start',
      sessionKey,
      payload: { id: 'c1', name: 'docs:read_document', input: {} },
    })
    observer.onEvent?.({
      type: 'text',
      sessionKey,
      payload:
        '## 完成汇报\n\n已生成 [本周销售周报](https://example.com/report.docx)，共 12 页。接下来需要邮件发送吗？',
    })
    observer.onFinish?.(sessionKey)

    expect(h.notifications).toHaveLength(1)
    expect(h.notifications[0]!.title).toBe('贾维斯 · 任务完成')
    expect(h.notifications[0]!.body).toContain('先生，「整理本周销售周报」已完成。')
    expect(h.notifications[0]!.body).toContain('完成汇报')
    h.notifications[0]!.onClick()
    expect(h.openedSessions).toEqual([sessionKey])

    const speakMsgs = h.hudMessages.filter((m) => m.channel === HOME_CHANNELS.butlerSpeak)
    expect(speakMsgs).toEqual([
      {
        channel: HOME_CHANNELS.butlerSpeak,
        payload: { text: '先生，「整理本周销售周报」已完成。' },
      },
    ])

    expect(h.getState().tasks).toEqual([
      {
        sessionKey,
        title: '整理本周销售周报',
        status: 'done',
        finishedAt: h.getState().tasks[0]!.finishedAt,
      },
    ])

    const updates = h.hudMessages
      .filter((m) => m.channel === HOME_CHANNELS.butlerTaskUpdate)
      .map((m) => m.payload as ButlerTaskUpdate)
    expect(updates.map((u) => [u.status, u.step?.kind ?? null])).toEqual([
      ['running', null],
      ['running', 'think'],
      ['running', 'read'],
      ['done', null],
    ])
    expect(updates[3]!.summary).toBe('完成汇报')
    expect(updates[3]!.fromButler).toBe(true)
  })

  it('extracts clean single-sentence summary capped at 90 characters without breaking filenames', () => {
    const h = makeHarness()
    const { observer } = h.service
    const sessionKey = 'default:butler-sum'

    observer.onBegin?.({
      sessionKey,
      projectId: 'default',
      chatId: 'butler-sum',
      docPath: null,
      userText: 'Build report',
    })
    observer.onEvent?.({
      type: 'text',
      sessionKey,
      payload: 'Created **report.docx** in `Documents`. Would you like me to share it?',
    })
    observer.onFinish?.(sessionKey)

    const lastUpdate = h.hudMessages
      .filter((m) => m.channel === HOME_CHANNELS.butlerTaskUpdate)
      .map((m) => m.payload as ButlerTaskUpdate)
      .at(-1)!
    expect(lastUpdate.summary).toBe('Created report.docx in Documents.')
  })

  it('notifies and speaks error on failed run', () => {
    const h = makeHarness()
    const { observer } = h.service
    const sessionKey = 'default:butler-err'

    observer.onBegin?.({
      sessionKey,
      projectId: 'default',
      chatId: 'butler-err',
      docPath: null,
      userText: '导出 PDF',
    })
    observer.onEvent?.({ type: 'error', sessionKey, payload: 'Disk full' })
    observer.onFinish?.(sessionKey)

    expect(h.notifications).toHaveLength(1)
    expect(h.notifications[0]!.title).toBe('贾维斯 · 任务未完成')
    expect(h.notifications[0]!.body).toBe('「导出 PDF」遇到问题：Disk full')

    const speakMsgs = h.hudMessages.filter((m) => m.channel === HOME_CHANNELS.butlerSpeak)
    expect(speakMsgs).toEqual([
      {
        channel: HOME_CHANNELS.butlerSpeak,
        payload: { text: '先生，「导出 PDF」没能完成。' },
      },
    ])
    expect(h.getState().tasks[0]!.status).toBe('error')
  })

  it('handles confirmation alerts with focus/session gating and frame flashing', () => {
    const h = makeHarness()
    const { observer } = h.service
    const sk = 'default:chat-1'
    const confirmReq: PiAgentConfirmRequest = {
      requestId: 'req-1',
      sessionKey: sk,
      call: { id: 'call-1', name: 'bash', input: { command: 'rm -rf tmp' } },
      sessionAllowable: true,
    }

    observer.onBegin?.({
      sessionKey: sk,
      projectId: 'default',
      chatId: 'chat-1',
      docPath: null,
      userText: '清理临时目录',
    })

    // Case 1: Shell unfocused -> notify AND flashFrame(true).
    h.setFocused(false)
    observer.onConfirm?.(sk, confirmReq)
    expect(h.notifications).toHaveLength(1)
    expect(h.notifications[0]!.title).toBe('贾维斯 · 需要你确认')
    expect(h.notifications[0]!.body).toBe('「清理临时目录」正在等待你批准：bash')
    expect(h.flashCalls).toEqual([true])

    // Confirm cleared -> status returns to running.
    observer.onConfirm?.(sk, null)
    const afterClear = h.hudMessages
      .filter((m) => m.channel === HOME_CHANNELS.butlerTaskUpdate)
      .map((m) => m.payload as ButlerTaskUpdate)
      .at(-1)!
    expect(afterClear.status).toBe('running')

    // Case 2: Shell focused on a DIFFERENT session -> notify WITHOUT flashing.
    h.setFocused(true)
    h.setActiveSession('default:other-session')
    observer.onConfirm?.(sk, confirmReq)
    expect(h.notifications).toHaveLength(2)
    expect(h.flashCalls).toEqual([true])

    // Case 3: Shell focused on THIS session -> neither notify nor flash.
    h.setActiveSession(sk)
    observer.onConfirm?.(sk, confirmReq)
    expect(h.notifications).toHaveLength(2)
    expect(h.flashCalls).toEqual([true])
  })

  it('suppresses finish notifications and TTS for foreground non-butler chat', () => {
    const h = makeHarness()
    const { observer } = h.service
    const sk = 'default:chat-fg'

    h.setFocused(true)
    h.setActiveSession(sk)

    observer.onBegin?.({
      sessionKey: sk,
      projectId: 'default',
      chatId: 'chat-fg',
      docPath: null,
      userText: '帮我改一下标点',
    })
    observer.onEvent?.({ type: 'text', sessionKey: sk, payload: '已修改。' })
    observer.onFinish?.(sk)

    expect(h.notifications).toHaveLength(0)
    expect(h.hudMessages.filter((m) => m.channel === HOME_CHANNELS.butlerSpeak)).toHaveLength(0)
    expect(h.writeStateCalls).toHaveLength(0)
  })

  it('still emits TTS speak for background butler-initiated run even when shell is focused', () => {
    const h = makeHarness()
    const { observer } = h.service
    const sk = 'default:butler-bg'

    h.setFocused(true)
    h.setActiveSession('default:other')

    observer.onBegin?.({
      sessionKey: sk,
      projectId: 'default',
      chatId: 'butler-bg',
      docPath: null,
      userText: '汇总资料',
    })
    observer.onFinish?.(sk)

    expect(h.notifications).toHaveLength(0)
    expect(h.hudMessages.filter((m) => m.channel === HOME_CHANNELS.butlerSpeak)).toHaveLength(1)
    expect(h.writeStateCalls).toHaveLength(1)
  })

  it('suppresses notifications, frame flash, and speak when dnd is true', () => {
    const h = makeHarness()
    const { observer } = h.service
    h.setPrefs({ dnd: true })
    const sk = 'default:butler-dnd'

    observer.onBegin?.({
      sessionKey: sk,
      projectId: 'default',
      chatId: 'butler-dnd',
      docPath: null,
      userText: '任务',
    })
    observer.onConfirm?.(sk, {
      requestId: 'r1',
      sessionKey: sk,
      call: { id: 'c1', name: 'write', input: {} },
      sessionAllowable: false,
    })
    observer.onFinish?.(sk)

    expect(h.notifications).toHaveLength(0)
    expect(h.flashCalls).toEqual([])
    expect(h.hudMessages.filter((m) => m.channel === HOME_CHANNELS.butlerSpeak)).toHaveLength(0)
  })

  it('handles aborted runs silently without persisting or speaking', () => {
    const h = makeHarness()
    const { observer } = h.service
    const sk = 'default:butler-abort'

    observer.onBegin?.({
      sessionKey: sk,
      projectId: 'default',
      chatId: 'butler-abort',
      docPath: null,
      userText: '长任务',
    })
    observer.onEvent?.({ type: 'error', sessionKey: sk, payload: 'aborted' })
    observer.onEvent?.({ type: 'stop', sessionKey: sk, payload: null })
    observer.onFinish?.(sk)

    const finalUpdate = h.hudMessages
      .filter((m) => m.channel === HOME_CHANNELS.butlerTaskUpdate)
      .map((m) => m.payload as ButlerTaskUpdate)
      .at(-1)!
    expect(finalUpdate.status).toBe('done')
    expect(finalUpdate.error).toBeUndefined()
    expect(h.notifications).toHaveLength(0)
    expect(h.writeStateCalls).toHaveLength(0)
    expect(h.hudMessages.filter((m) => m.channel === HOME_CHANNELS.butlerSpeak)).toHaveLength(0)
  })

  it('enforces hourly interrupt budget across finished runs while allowing confirm', () => {
    const h = makeHarness()
    const { observer } = h.service
    h.setPrefs({ maxPerHour: 2, voice: false })

    for (let i = 1; i <= 3; i += 1) {
      const sk = `default:butler-cap-${i}`
      observer.onBegin?.({
        sessionKey: sk,
        projectId: 'default',
        chatId: `butler-cap-${i}`,
        docPath: null,
        userText: `Task ${i}`,
      })
      observer.onFinish?.(sk)
    }

    expect(h.notifications).toHaveLength(2)

    const skConfirm = 'default:butler-cap-4'
    observer.onBegin?.({
      sessionKey: skConfirm,
      projectId: 'default',
      chatId: 'butler-cap-4',
      docPath: null,
      userText: 'Confirm task',
    })
    observer.onConfirm?.(skConfirm, {
      requestId: 'r-cap',
      sessionKey: skConfirm,
      call: { id: 'c-cap', name: 'bash', input: {} },
      sessionAllowable: true,
    })
    expect(h.notifications).toHaveLength(3)
  })

  it('maps all tool categories accurately onto ButlerStepKind', () => {
    const h = makeHarness()
    const { observer } = h.service
    const sk = 'default:butler-tools'

    observer.onBegin?.({
      sessionKey: sk,
      projectId: 'default',
      chatId: 'butler-tools',
      docPath: null,
      userText: 'Tools',
    })

    const cases: Array<[string, string]> = [
      ['read', 'read'],
      ['read_file', 'read'],
      ['docs:read_document', 'read'],
      ['kb_search', 'search'],
      ['grep', 'search'],
      ['find', 'search'],
      ['browser:click_element', 'browse'],
      ['document_agent', 'edit'],
      ['edit', 'edit'],
      ['write', 'edit'],
      ['create_document', 'create'],
      ['run_genoffice', 'create'],
      ['bash', 'command'],
      ['powershell', 'command'],
      ['custom_tool', 'other'],
    ]

    for (const [toolName, expectedKind] of cases) {
      observer.onEvent?.({
        type: 'tool-start',
        sessionKey: sk,
        payload: { id: toolName, name: toolName, input: {} },
      })
      const latest = h.hudMessages
        .filter((m) => m.channel === HOME_CHANNELS.butlerTaskUpdate)
        .map((m) => m.payload as ButlerTaskUpdate)
        .at(-1)!
      expect(latest.step).toEqual({ tool: toolName, kind: expectedKind })
    }
  })
})

describe('butler-service submit & hudState', () => {
  it('validates empty, disabled, and legacy preconditions', () => {
    const h = makeHarness()

    expect(h.service.submit('   \n\t  ')).toEqual({ ok: false, error: 'empty' })

    h.setPrefs({ enabled: false })
    expect(h.service.submit('hello')).toEqual({ ok: false, error: 'disabled' })

    h.setPrefs({ enabled: true })
    h.setEngine('legacy')
    expect(h.service.submit('hello')).toEqual({ ok: false, error: 'legacy' })

    expect(h.promptSpy).not.toHaveBeenCalled()
    expect(h.ensureDefaultProjectSpy).not.toHaveBeenCalled()
  })

  it('dispatches prompt asynchronously, truncates instruction, and returns sessionKey', async () => {
    const h = makeHarness({ newChatId: undefined })
    const longText = 'X'.repeat(MAX_BUTLER_INSTRUCTION + 250)

    const res = h.service.submit(longText)
    expect(res.ok).toBe(true)
    expect(res.sessionKey).toMatch(/^default:butler-\d{8}-\d{6}-[0-9a-f]{4}$/)
    expect(h.ensureDefaultProjectSpy).toHaveBeenCalledTimes(1)
    expect(h.promptSpy).toHaveBeenCalledTimes(1)

    const callArg = h.promptSpy.mock.calls[0]![0]
    expect(callArg.sessionKey).toBe(res.sessionKey)
    expect(callArg.projectId).toBe('default')
    expect(callArg.docPath).toBeNull()
    expect(callArg.instruction).toHaveLength(MAX_BUTLER_INSTRUCTION)
    expect(callArg.lang).toBe('zh')
  })

  it('pushes error update when prompt fails before onBegin, without duplicating if handled by observer', async () => {
    const h1 = makeHarness({
      prompt: vi.fn(async () => ({ ok: false, error: 'Model not configured' })),
    })
    const res1 = h1.service.submit('写周报')
    expect(res1).toEqual({ ok: true, sessionKey: 'default:butler-test-1' })

    await vi.waitFor(() => {
      const updates = h1.hudMessages.filter((m) => m.channel === HOME_CHANNELS.butlerTaskUpdate)
      expect(updates).toHaveLength(1)
    })
    const errUpdate1 = h1.hudMessages[0]!.payload as ButlerTaskUpdate
    expect(errUpdate1).toMatchObject({
      sessionKey: 'default:butler-test-1',
      title: '写周报',
      status: 'error',
      error: 'Model not configured',
      fromButler: true,
    })

    const h2 = makeHarness({
      prompt: vi.fn(async () => {
        throw new Error('Transport crash')
      }),
    })
    h2.service.submit('生成 PPT')
    await vi.waitFor(() => {
      expect(h2.hudMessages).toHaveLength(1)
    })
    expect((h2.hudMessages[0]!.payload as ButlerTaskUpdate).error).toBe('Transport crash')

    // When onBegin/onFinish already handled the run, { ok: false } resolution must not duplicate.
    let observerRef: ReturnType<typeof makeHarness>['service']['observer'] | null = null
    const h3 = makeHarness({
      prompt: vi.fn(async (req) => {
        observerRef!.onBegin?.({
          sessionKey: req.sessionKey,
          projectId: req.projectId,
          chatId: req.chatId,
          docPath: null,
          userText: req.instruction,
        })
        observerRef!.onEvent?.({
          type: 'error',
          sessionKey: req.sessionKey,
          payload: 'Failed once',
        })
        observerRef!.onFinish?.(req.sessionKey)
        return { ok: false, error: 'Failed once' }
      }),
    })
    observerRef = h3.service.observer
    h3.service.submit('已由 observer 处理')
    await new Promise((resolve) => setTimeout(resolve, 20))
    const updates3 = h3.hudMessages.filter((m) => m.channel === HOME_CHANNELS.butlerTaskUpdate)
    expect(updates3).toHaveLength(2) // only onBegin + onFinish
  })

  it('delivers daily briefing once per day even with async writeState, and supports forceBriefing', () => {
    const pendingWrites: ButlerPersistedState[] = []
    const h = makeHarness({
      // Simulate delayed persistence where readState lags behind writeState.
      writeState: (next) => {
        pendingWrites.push(next)
      },
      readTodos: () => [{ id: 'td1', text: 'Send deck', done: false }],
    })

    const first = h.service.hudState()
    expect(first.briefing).not.toBeNull()
    expect(first.briefing!.dayKey).toBe('2026-11-22')
    expect(first.briefing!.items).toHaveLength(1)
    expect(pendingWrites).toHaveLength(1)

    // Same day repeat call must return null even though readState wasn't updated yet.
    const second = h.service.hudState()
    expect(second.briefing).toBeNull()
    expect(pendingWrites).toHaveLength(1)

    // forceBriefing: true builds briefing on demand without duplicating persistence.
    const forced = h.service.hudState({ forceBriefing: true })
    expect(forced.briefing).not.toBeNull()
    expect(forced.briefing!.items).toHaveLength(1)
    expect(pendingWrites).toHaveLength(1)

    // Advancing to the next local day produces a fresh briefing again.
    h.setNow(localTs(2026, 11, 23, 8, 15))
    const nextDay = h.service.hudState()
    expect(nextDay.briefing).not.toBeNull()
    expect(nextDay.briefing!.dayKey).toBe('2026-11-23')
    expect(pendingWrites).toHaveLength(2)
  })

  it('does not consume or persist daily briefing when hudState is called with peek: true', () => {
    const writes: ButlerPersistedState[] = []
    const h = makeHarness({
      writeState: (next) => {
        writes.push(next)
      },
      readTodos: () => [{ id: 'td1', text: 'Send deck', done: false }],
    })

    const peeked = h.service.hudState({ peek: true })
    expect(peeked.briefing).toBeNull()
    expect(writes).toHaveLength(0)

    const shown = h.service.hudState()
    expect(shown.briefing).not.toBeNull()
    expect(shown.briefing!.dayKey).toBe('2026-11-22')
    expect(writes).toHaveLength(1)

    const repeat = h.service.hudState()
    expect(repeat.briefing).toBeNull()
    expect(writes).toHaveLength(1)
  })

  it('ranks active running/confirm tasks ahead of finished tasks and caps hudState tasks at 6', () => {
    const h = makeHarness()
    const { observer } = h.service

    for (let i = 1; i <= 7; i += 1) {
      h.setNow(1000 + i * 100)
      const sk = `default:butler-done-${i}`
      observer.onBegin?.({
        sessionKey: sk,
        projectId: 'default',
        chatId: `butler-done-${i}`,
        docPath: null,
        userText: `Done ${i}`,
      })
      observer.onFinish?.(sk)
    }

    // Older active running and confirm tasks must still rank at the top of the 6 returned.
    h.setNow(500)
    observer.onBegin?.({
      sessionKey: 'default:butler-live-1',
      projectId: 'default',
      chatId: 'butler-live-1',
      docPath: null,
      userText: 'Live running',
    })
    h.setNow(600)
    observer.onBegin?.({
      sessionKey: 'default:butler-live-2',
      projectId: 'default',
      chatId: 'butler-live-2',
      docPath: null,
      userText: 'Live confirm',
    })
    observer.onConfirm?.('default:butler-live-2', {
      requestId: 'r-live',
      sessionKey: 'default:butler-live-2',
      call: { id: 'c-live', name: 'write', input: {} },
      sessionAllowable: true,
    })

    const snap = h.service.hudState()
    expect(snap.tasks).toHaveLength(6)
    expect(snap.tasks[0]!.sessionKey).toBe('default:butler-live-2')
    expect(snap.tasks[1]!.sessionKey).toBe('default:butler-live-1')
    expect(snap.tasks.slice(2).map((t) => t.sessionKey)).toEqual([
      'default:butler-done-7',
      'default:butler-done-6',
      'default:butler-done-5',
      'default:butler-done-4',
    ])
  })

  it('flags an empty run without text, tool, or reasoning as error', () => {
    const h = makeHarness()
    const { observer } = h.service
    const sk = 'default:butler-empty'

    observer.onBegin?.({
      sessionKey: sk,
      projectId: 'default',
      chatId: 'butler-empty',
      docPath: null,
      userText: '测试空回复',
    })
    observer.onFinish?.(sk)

    const finalUpdate = h.hudMessages
      .filter((m) => m.channel === HOME_CHANNELS.butlerTaskUpdate)
      .map((m) => m.payload as ButlerTaskUpdate)
      .at(-1)!
    expect(finalUpdate.status).toBe('error')
    expect(finalUpdate.error).toBe(
      '没有收到任何回复，可能被记忆插件拒绝或模型未输出，请在 AI 面板查看详情',
    )
    expect(h.getState().tasks[0]!.status).toBe('error')
    expect(h.hudMessages.filter((m) => m.channel === HOME_CHANNELS.butlerSpeak)).toEqual([
      {
        channel: HOME_CHANNELS.butlerSpeak,
        payload: { text: '先生，「测试空回复」没能完成。' },
      },
    ])
  })

  it('keeps tool-driven run without final text as done rather than error', () => {
    const h = makeHarness()
    const { observer } = h.service
    const sk = 'default:butler-tool-only'

    observer.onBegin?.({
      sessionKey: sk,
      projectId: 'default',
      chatId: 'butler-tool-only',
      docPath: null,
      userText: '静默执行工具',
    })
    observer.onEvent?.({ type: 'tool-start', sessionKey: sk, payload: { name: 'bash' } })
    observer.onFinish?.(sk)

    const finalUpdate = h.hudMessages
      .filter((m) => m.channel === HOME_CHANNELS.butlerTaskUpdate)
      .map((m) => m.payload as ButlerTaskUpdate)
      .at(-1)!
    expect(finalUpdate.status).toBe('done')
    expect(finalUpdate.error).toBeUndefined()
    expect(h.getState().tasks[0]!.status).toBe('done')
  })
})
