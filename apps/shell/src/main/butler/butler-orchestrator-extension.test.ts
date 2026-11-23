import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'
import type {
  ButlerDecisionItem,
  ButlerDecisionResolution,
  ButlerMissionReport,
  ButlerSubTask,
  ButlerWorkerRole,
} from '../../shared/butler-orchestrator-api'
import {
  BUTLER_CHIEF_TOOL_NAMES,
  BUTLER_WORKER_TOOL_NAMES,
  createButlerChiefExtension,
  createButlerWorkerExtension,
  type ButlerChiefToolBridge,
  type ButlerWorkerToolBridge,
} from './butler-orchestrator-extension'
import { buildButlerChiefRolePrompt, buildButlerWorkerRolePrompt } from './butler-persona'

interface MockExtensionHarness {
  readonly pi: ExtensionAPI
  readonly tools: Map<string, ToolDefinition>
  readonly registeredNames: string[]
  readonly getBeforeAgentStart: () => ((event: unknown, ctx: unknown) => unknown) | null
}

function createMockPiHarness(): MockExtensionHarness {
  const tools = new Map<string, ToolDefinition>()
  const registeredNames: string[] = []
  let beforeAgentStartHandler: ((event: unknown, ctx: unknown) => unknown) | null = null

  const pi = {
    registerTool(tool: ToolDefinition) {
      registeredNames.push(tool.name)
      tools.set(tool.name, tool)
    },
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      if (event === 'before_agent_start') {
        beforeAgentStartHandler = handler
      }
    },
  } as unknown as ExtensionAPI

  return {
    pi,
    tools,
    registeredNames,
    getBeforeAgentStart: () => beforeAgentStartHandler,
  }
}

const dummyCtx = {
  sessionManager: { getSessionId: () => 'pi-test-session' },
} as unknown as Parameters<ToolDefinition['execute']>[4]

function makeTask(overrides: Partial<ButlerSubTask> = {}): ButlerSubTask {
  return {
    id: 'task-1',
    missionId: 'mission-1',
    title: 'Gather Q4 sales figures',
    brief: 'Collect verified Q4 sales totals from workspace sheets.',
    role: 'research',
    dependsOn: [],
    sessionKey: 'default:butler-worker-1',
    status: 'queued',
    step: null,
    artifacts: [],
    createdAt: 1_700_000_000_000,
    ...overrides,
  }
}

function createMockChiefBridge() {
  const sampleTask = makeTask()
  const sampleDecision: ButlerDecisionItem = {
    id: 'dec-1',
    missionId: 'mission-1',
    taskId: 'task-1',
    sessionKey: 'default:butler-worker-1',
    kind: 'choice',
    title: 'Pick target currency',
    summary: 'Source sheets contain both USD and EUR totals.',
    options: [
      { id: 'usd', label: 'USD', style: 'primary' },
      { id: 'eur', label: 'EUR' },
    ],
    status: 'pending',
    createdAt: 1_700_000_000_100,
  }
  const sampleResolution: ButlerDecisionResolution = {
    optionId: 'usd',
    note: 'Use USD for board deck',
    resolvedAt: 1_700_000_000_200,
  }
  const sampleReport: ButlerMissionReport = {
    headline: 'Q4 Sales Brief Ready',
    summary: 'Compiled verified Q4 numbers into an executive summary.',
    artifacts: [
      {
        path: 'D:/workspace/q4-summary.docx',
        label: 'Q4 Summary',
        existsOnDisk: true,
      },
    ],
    risks: ['Pending final audit sign-off'],
    nextSuggestion: 'Review the executive summary before Friday board review.',
    generatedAt: 1_700_000_000_300,
  }

  const dispatchTask = vi.fn<ButlerChiefToolBridge['dispatchTask']>().mockResolvedValue({
    ok: true,
    task: sampleTask,
  })
  const listTasks = vi.fn<ButlerChiefToolBridge['listTasks']>().mockResolvedValue([sampleTask])
  const inspectTask = vi.fn<ButlerChiefToolBridge['inspectTask']>().mockResolvedValue({
    task: sampleTask,
    decisions: [sampleDecision],
  })
  const steerTask = vi.fn<ButlerChiefToolBridge['steerTask']>().mockResolvedValue({ ok: true })
  const cancelTask = vi.fn<ButlerChiefToolBridge['cancelTask']>().mockResolvedValue({ ok: true })
  const requestChiefDecision = vi
    .fn<ButlerChiefToolBridge['requestChiefDecision']>()
    .mockResolvedValue(sampleResolution)
  const publishReport = vi.fn<ButlerChiefToolBridge['publishReport']>().mockResolvedValue({
    ok: true,
    report: sampleReport,
  })

  const bridge: ButlerChiefToolBridge = {
    dispatchTask,
    listTasks,
    inspectTask,
    steerTask,
    cancelTask,
    requestChiefDecision,
    publishReport,
  }

  return {
    bridge,
    spies: {
      dispatchTask,
      listTasks,
      inspectTask,
      steerTask,
      cancelTask,
      requestChiefDecision,
      publishReport,
    },
    fixtures: {
      sampleTask,
      sampleDecision,
      sampleResolution,
      sampleReport,
    },
  }
}

describe('butler-orchestrator-extension', () => {
  it('registers exactly the 7 BUTLER_CHIEF_TOOL_NAMES tools and forwards every call to bridge', async () => {
    const { bridge, spies, fixtures } = createMockChiefBridge()
    const harness = createMockPiHarness()
    createButlerChiefExtension(bridge)(harness.pi)

    expect(harness.registeredNames).toEqual([...BUTLER_CHIEF_TOOL_NAMES])
    expect(harness.registeredNames).toHaveLength(7)

    // 1. butler_dispatch_task (valid DAG task)
    const dispatchTool = harness.tools.get('butler_dispatch_task')!
    const dispatchRes = await dispatchTool.execute(
      'call-dispatch',
      {
        missionId: 'mission-1',
        title: 'Analyze sales',
        brief: 'Summarize Q4 numbers from sheets.',
        role: 'research',
        dependsOn: ['task-0'],
        scopePaths: ['D:/workspace/sales.xlsx'],
        workdir: 'D:/workspace',
      },
      undefined,
      undefined,
      dummyCtx,
    )
    expect(spies.dispatchTask).toHaveBeenCalledWith({
      missionId: 'mission-1',
      title: 'Analyze sales',
      brief: 'Summarize Q4 numbers from sheets.',
      role: 'research',
      dependsOn: ['task-0'],
      scopePaths: ['D:/workspace/sales.xlsx'],
      workdir: 'D:/workspace',
    })
    expect(dispatchRes.isError).toBeUndefined()
    expect(JSON.parse((dispatchRes.content[0] as { text: string }).text)).toEqual({
      ok: true,
      task: fixtures.sampleTask,
    })

    // Validation failures on butler_dispatch_task must not invoke bridge
    const badRoleRes = await dispatchTool.execute(
      'call-bad-role',
      { title: 'Valid title', brief: 'Valid brief', role: 'admin' },
      undefined,
      undefined,
      dummyCtx,
    )
    expect(badRoleRes.isError).toBe(true)
    expect(spies.dispatchTask).toHaveBeenCalledTimes(1)

    const emptyTitleRes = await dispatchTool.execute(
      'call-empty-title',
      { title: '   ', brief: 'Valid brief' },
      undefined,
      undefined,
      dummyCtx,
    )
    expect(emptyTitleRes.isError).toBe(true)
    expect(spies.dispatchTask).toHaveBeenCalledTimes(1)

    // 2. butler_list_tasks
    const listTool = harness.tools.get('butler_list_tasks')!
    const listRes = await listTool.execute(
      'call-list',
      { missionId: 'mission-1' },
      undefined,
      undefined,
      dummyCtx,
    )
    expect(spies.listTasks).toHaveBeenCalledWith('mission-1')
    expect(JSON.parse((listRes.content[0] as { text: string }).text)).toEqual({
      ok: true,
      count: 1,
      tasks: [fixtures.sampleTask],
    })

    // 3. butler_inspect_task (found and not-found)
    const inspectTool = harness.tools.get('butler_inspect_task')!
    const inspectRes = await inspectTool.execute(
      'call-inspect',
      { taskId: 'task-1' },
      undefined,
      undefined,
      dummyCtx,
    )
    expect(spies.inspectTask).toHaveBeenCalledWith('task-1')
    expect(JSON.parse((inspectRes.content[0] as { text: string }).text)).toEqual({
      ok: true,
      task: fixtures.sampleTask,
      decisions: [fixtures.sampleDecision],
    })

    spies.inspectTask.mockResolvedValueOnce(null)
    const inspectMissing = await inspectTool.execute(
      'call-inspect-missing',
      { taskId: 'task-404' },
      undefined,
      undefined,
      dummyCtx,
    )
    expect(inspectMissing.isError).toBe(true)

    // 4. butler_steer_task
    const steerTool = harness.tools.get('butler_steer_task')!
    const steerRes = await steerTool.execute(
      'call-steer',
      { taskId: 'task-1', instruction: 'Include regional breakdown' },
      undefined,
      undefined,
      dummyCtx,
    )
    expect(spies.steerTask).toHaveBeenCalledWith({
      taskId: 'task-1',
      instruction: 'Include regional breakdown',
    })
    expect(steerRes.isError).toBeUndefined()

    const badSteer = await steerTool.execute(
      'call-steer-bad',
      { taskId: 'task-1', instruction: '' },
      undefined,
      undefined,
      dummyCtx,
    )
    expect(badSteer.isError).toBe(true)
    expect(spies.steerTask).toHaveBeenCalledTimes(1)

    // 5. butler_cancel_task
    const cancelTool = harness.tools.get('butler_cancel_task')!
    const cancelRes = await cancelTool.execute(
      'call-cancel',
      { taskId: 'task-1' },
      undefined,
      undefined,
      dummyCtx,
    )
    expect(spies.cancelTask).toHaveBeenCalledWith('task-1')
    expect(cancelRes.isError).toBeUndefined()

    spies.cancelTask.mockResolvedValueOnce({ ok: false, error: 'already finished' })
    const cancelFail = await cancelTool.execute(
      'call-cancel-fail',
      { taskId: 'task-1' },
      undefined,
      undefined,
      dummyCtx,
    )
    expect(cancelFail.isError).toBe(true)

    // 6. butler_request_decision
    const decisionTool = harness.tools.get('butler_request_decision')!
    const decRes = await decisionTool.execute(
      'call-decision',
      {
        missionId: 'mission-1',
        taskId: 'task-1',
        title: 'Choose currency',
        summary: 'Confirm reporting currency for deck',
        detail: 'FX rate snapshot differs slightly between tabs.',
        options: [
          { id: 'usd', label: 'USD', style: 'primary' },
          { id: 'eur', label: 'EUR', description: 'Use ECB closing rate' },
        ],
      },
      undefined,
      undefined,
      dummyCtx,
    )
    expect(spies.requestChiefDecision).toHaveBeenCalledWith({
      missionId: 'mission-1',
      taskId: 'task-1',
      title: 'Choose currency',
      summary: 'Confirm reporting currency for deck',
      detail: 'FX rate snapshot differs slightly between tabs.',
      options: [
        { id: 'usd', label: 'USD', style: 'primary' },
        { id: 'eur', label: 'EUR', description: 'Use ECB closing rate' },
      ],
    })
    expect(JSON.parse((decRes.content[0] as { text: string }).text)).toEqual(
      fixtures.sampleResolution,
    )

    const badDecRes = await decisionTool.execute(
      'call-decision-empty-opts',
      { title: 'Pick', summary: 'Why', options: [] },
      undefined,
      undefined,
      dummyCtx,
    )
    expect(badDecRes.isError).toBe(true)
    expect(spies.requestChiefDecision).toHaveBeenCalledTimes(1)

    // 7. butler_publish_report
    const reportTool = harness.tools.get('butler_publish_report')!
    const reportRes = await reportTool.execute(
      'call-report',
      {
        missionId: 'mission-1',
        headline: 'Q4 Sales Brief Ready',
        summary: 'Compiled verified Q4 numbers.',
        artifactPaths: [{ path: 'D:/workspace/q4-summary.docx', label: 'Q4 Summary' }],
        risks: ['Pending final audit sign-off'],
        nextSuggestion: 'Review the deck.',
      },
      undefined,
      undefined,
      dummyCtx,
    )
    expect(spies.publishReport).toHaveBeenCalledWith({
      missionId: 'mission-1',
      headline: 'Q4 Sales Brief Ready',
      summary: 'Compiled verified Q4 numbers.',
      artifactPaths: [{ path: 'D:/workspace/q4-summary.docx', label: 'Q4 Summary' }],
      risks: ['Pending final audit sign-off'],
      nextSuggestion: 'Review the deck.',
    })
    expect(JSON.parse((reportRes.content[0] as { text: string }).text)).toEqual({
      ok: true,
      report: fixtures.sampleReport,
    })

    const badReportRes = await reportTool.execute(
      'call-report-bad',
      { headline: '', summary: 'Missing headline' },
      undefined,
      undefined,
      dummyCtx,
    )
    expect(badReportRes.isError).toBe(true)
    expect(spies.publishReport).toHaveBeenCalledTimes(1)
  })

  it('catches bridge rejections gracefully as structured error tool results', async () => {
    const { bridge, spies } = createMockChiefBridge()
    spies.dispatchTask.mockRejectedValueOnce(new Error('Mission store unavailable'))

    const harness = createMockPiHarness()
    createButlerChiefExtension(bridge)(harness.pi)

    const dispatchTool = harness.tools.get('butler_dispatch_task')!
    const result = await dispatchTool.execute(
      'call-err',
      { title: 'Test', brief: 'Do work' },
      undefined,
      undefined,
      dummyCtx,
    )
    expect(result.isError).toBe(true)
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      ok: false,
      error: 'Mission store unavailable',
    })
  })

  it('enforces 2-layer isolation on createButlerWorkerExtension: registers ONLY butler_worker_request_decision', async () => {
    const resolution: ButlerDecisionResolution = {
      optionId: 'proceed',
      note: 'Approved by user',
      resolvedAt: 1_700_000_001_000,
    }
    const requestWorkerChoice = vi
      .fn<ButlerWorkerToolBridge['requestWorkerChoice']>()
      .mockResolvedValue(resolution)
    const workerBridge: ButlerWorkerToolBridge = { requestWorkerChoice }

    const harness = createMockPiHarness()
    createButlerWorkerExtension(workerBridge, 'docs', {
      sessionKey: 'default:butler-worker-99',
      title: 'Draft board memo',
      scopePaths: ['D:/workspace/memo.docx'],
    })(harness.pi)

    // Strict tool surface check: ONLY 1 tool allowed, zero chief orchestration tools
    expect(harness.registeredNames).toEqual(['butler_worker_request_decision'])
    expect(harness.registeredNames).toEqual([...BUTLER_WORKER_TOOL_NAMES])
    for (const forbidden of [
      'butler_dispatch_task',
      'butler_list_tasks',
      'butler_inspect_task',
      'butler_steer_task',
      'butler_cancel_task',
      'butler_request_decision',
      'butler_publish_report',
    ]) {
      expect(harness.tools.has(forbidden)).toBe(false)
    }

    const workerTool = harness.tools.get('butler_worker_request_decision')!

    // Invalid payloads rejected before calling bridge
    const invalidNoOpts = await workerTool.execute(
      'w-call-1',
      { title: 'Ambiguity', summary: 'Need choice', options: [] },
      undefined,
      undefined,
      dummyCtx,
    )
    expect(invalidNoOpts.isError).toBe(true)
    expect(requestWorkerChoice).not.toHaveBeenCalled()

    const invalidEmptySummary = await workerTool.execute(
      'w-call-2',
      {
        title: 'Ambiguity',
        summary: '   ',
        options: [{ id: 'a', label: 'Option A' }],
      },
      undefined,
      undefined,
      dummyCtx,
    )
    expect(invalidEmptySummary.isError).toBe(true)
    expect(requestWorkerChoice).not.toHaveBeenCalled()

    const duplicateOptionIds = await workerTool.execute(
      'w-call-dup',
      {
        title: 'Ambiguity',
        summary: 'Pick one',
        options: [
          { id: 'dup', label: 'First' },
          { id: 'dup', label: 'Second' },
        ],
      },
      undefined,
      undefined,
      dummyCtx,
    )
    expect(duplicateOptionIds.isError).toBe(true)
    expect(requestWorkerChoice).not.toHaveBeenCalled()

    // Valid invocation forwards opts.sessionKey and returns ButlerDecisionResolution
    const validRes = await workerTool.execute(
      'w-call-ok',
      {
        title: 'Overwrite existing memo?',
        summary: 'Target file memo.docx already exists on disk.',
        detail: 'Overwrite replaces last week version.',
        options: [
          { id: 'proceed', label: 'Overwrite', style: 'danger' },
          { id: 'new_copy', label: 'Save as v2', style: 'primary' },
        ],
      },
      undefined,
      undefined,
      dummyCtx,
    )
    expect(requestWorkerChoice).toHaveBeenCalledWith('default:butler-worker-99', {
      title: 'Overwrite existing memo?',
      summary: 'Target file memo.docx already exists on disk.',
      detail: 'Overwrite replaces last week version.',
      options: [
        { id: 'proceed', label: 'Overwrite', style: 'danger' },
        { id: 'new_copy', label: 'Save as v2', style: 'primary' },
      ],
    })
    expect(validRes.isError).toBeUndefined()
    expect(JSON.parse((validRes.content[0] as { text: string }).text)).toEqual(resolution)
    expect(validRes.details).toEqual(resolution)
  })

  it('appends Chief and role-specific Worker instructions on before_agent_start', () => {
    const { bridge } = createMockChiefBridge()
    const chiefHarness = createMockPiHarness()
    createButlerChiefExtension(bridge, {
      prefs: {
        name: 'Jarvis\n## Injected',
        honorific: 'Boss\n<tag>',
        userName: 'Alice\r\n{admin}',
      },
    })(chiefHarness.pi)

    const chiefHandler = chiefHarness.getBeforeAgentStart()
    expect(chiefHandler).not.toBeNull()

    // Fallback mode (no systemPromptOptions.sections)
    const chiefFallback = chiefHandler!({ systemPrompt: 'BASE_SYSTEM' }, dummyCtx) as {
      systemPrompt: string
    }
    expect(chiefFallback.systemPrompt.startsWith('BASE_SYSTEM\n\n')).toBe(true)
    expect(chiefFallback.systemPrompt).toContain('default:butler-main')
    expect(chiefFallback.systemPrompt).toContain('Chief-of-Staff Butler')
    expect(chiefFallback.systemPrompt).toContain('butler_dispatch_task')
    expect(chiefFallback.systemPrompt).toContain('butler_request_decision')
    expect(chiefFallback.systemPrompt).toContain('butler_publish_report')
    expect(chiefFallback.systemPrompt).toContain('Jarvis ## Injected')
    expect(chiefFallback.systemPrompt).toContain('"Boss tag"')
    expect(chiefFallback.systemPrompt).toContain('(name: Alice admin)')
    expect(chiefFallback.systemPrompt).not.toContain('Jarvis\n')

    // Structured sections mode (matches Pi ExtensionRunner behavior)
    const chiefSections: Record<string, string> = {}
    const chiefStructured = chiefHandler!(
      { systemPrompt: 'BASE_SYSTEM', systemPromptOptions: { sections: chiefSections } },
      dummyCtx,
    )
    expect(chiefStructured).toBeUndefined()
    expect(chiefSections.butler_chief).toBe(
      buildButlerChiefRolePrompt({
        name: 'Jarvis\n## Injected',
        honorific: 'Boss\n<tag>',
        userName: 'Alice\r\n{admin}',
      }),
    )

    // Worker role prompts across all 6 roles
    const roles: readonly ButlerWorkerRole[] = [
      'general',
      'research',
      'docs',
      'sheets',
      'slides',
      'browser',
    ]
    const seenPrompts = new Set<string>()
    for (const role of roles) {
      const workerHarness = createMockPiHarness()
      createButlerWorkerExtension({ requestWorkerChoice: vi.fn() }, role, {
        sessionKey: `default:butler-worker-${role}`,
        title: `Task for ${role}`,
        scopePaths: ['D:/workspace/shared.md'],
      })(workerHarness.pi)

      const workerHandler = workerHarness.getBeforeAgentStart()
      expect(workerHandler).not.toBeNull()

      const res = workerHandler!({ systemPrompt: 'WORKER_BASE' }, dummyCtx) as {
        systemPrompt: string
      }
      expect(res.systemPrompt.startsWith('WORKER_BASE\n\n')).toBe(true)
      expect(res.systemPrompt).toContain(`(${role})`)
      expect(res.systemPrompt).toContain('silent background specialist mode')
      expect(res.systemPrompt).toContain('butler_worker_request_decision')
      expect(res.systemPrompt).toContain('D:/workspace/shared.md')
      expect(res.systemPrompt).toContain(`Task for ${role}`)
      seenPrompts.add(res.systemPrompt)

      const workerSections: Record<string, string> = {}
      expect(
        workerHandler!(
          { systemPrompt: 'WORKER_BASE', systemPromptOptions: { sections: workerSections } },
          dummyCtx,
        ),
      ).toBeUndefined()
      expect(workerSections.butler_worker).toBe(
        buildButlerWorkerRolePrompt(role, {
          title: `Task for ${role}`,
          scopePaths: ['D:/workspace/shared.md'],
        }),
      )
    }

    // Distinct instructions per role
    expect(seenPrompts.size).toBe(roles.length)
  })
})
