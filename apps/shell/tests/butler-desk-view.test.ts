/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ButlerDecisionItem,
  ButlerDecisionKind,
  ButlerDeskSnapshot,
  ButlerMission,
  ButlerMissionStatus,
  ButlerSubTask,
  ButlerSubTaskStatus,
  ButlerWorkerRole,
} from '../src/shared/butler-orchestrator-api'
import type { HomeApi } from '../src/shared/home-api'
import {
  ButlerDeskView,
  canSteerSubTask,
  decisionKindLabelKey,
  formatDecisionOptionLabel,
  formatElapsedDuration,
  isMissionActive,
  isSubTaskActive,
  missionStatusLabelKey,
  missionTaskProgress,
  splitDecisionsForInbox,
  subTaskStatusLabelKey,
  workerRoleLabelKey,
  type ButlerDeskViewProps,
} from '../src/renderer/src/ButlerDeskView'
import { LocaleProvider, type TFunc } from '../src/renderer/src/locale'
import { loadStrings, translate } from '../src/renderer/src/strings'

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const enT: TFunc = (key, params) => translate('en', key, params)
const zhT: TFunc = (key, params) => translate('zh', key, params)

let host: HTMLDivElement
let root: Root
let currentSnapshot: ButlerDeskSnapshot
let pushListeners: Array<(next: ButlerDeskSnapshot) => void>
let unsubscribeSpy: ReturnType<typeof vi.fn>
let delegateMock: ReturnType<typeof vi.fn>
let resolveDecisionMock: ReturnType<typeof vi.fn>
let cancelMissionMock: ReturnType<typeof vi.fn>
let deleteMissionMock: ReturnType<typeof vi.fn>
let cancelTaskMock: ReturnType<typeof vi.fn>
let retryTaskMock: ReturnType<typeof vi.fn>
let steerTaskMock: ReturnType<typeof vi.fn>
let approvePlanMock: ReturnType<typeof vi.fn>
let openPathMock: ReturnType<typeof vi.fn>

function makeEmptySnapshot(overrides?: Partial<ButlerDeskSnapshot>): ButlerDeskSnapshot {
  return {
    chiefSessionKey: 'default:butler-main',
    chiefBusy: false,
    missions: [],
    tasks: [],
    decisions: [],
    feed: [],
    concurrency: { running: 0, maxConcurrent: 3, queued: 0 },
    ...overrides,
  }
}

function makeDecision(overrides: Partial<ButlerDecisionItem> & { id: string }): ButlerDecisionItem {
  return {
    missionId: 'm-1',
    taskId: 't-1',
    sessionKey: 'default:butler-worker-1',
    kind: 'permission',
    title: 'Allow file write',
    summary: 'Write summary into docs/report.md',
    options: [
      { id: 'allow', label: 'Allow', style: 'primary' },
      { id: 'allow-session', label: 'Allow session', style: 'default' },
      { id: 'deny', label: 'Deny', style: 'danger' },
    ],
    status: 'pending',
    createdAt: 1000,
    ...overrides,
  }
}

function makeSubTask(overrides: Partial<ButlerSubTask> & { id: string }): ButlerSubTask {
  return {
    missionId: 'm-1',
    title: 'Analyze workspace',
    brief: 'Read files and summarize risks',
    role: 'research',
    dependsOn: [],
    sessionKey: `default:butler-worker-${overrides.id}`,
    status: 'running',
    step: null,
    artifacts: [],
    createdAt: 1000,
    ...overrides,
  }
}

function makeMission(overrides: Partial<ButlerMission> & { id: string }): ButlerMission {
  return {
    title: 'Weekly Sync Mission',
    goal: 'Compile weekly sync report and verify code risks',
    status: 'running',
    createdAt: 1000,
    updatedAt: 2000,
    taskIds: [],
    ...overrides,
  }
}

beforeAll(async () => {
  await Promise.all([loadStrings('en'), loadStrings('zh')])
})

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)

  currentSnapshot = makeEmptySnapshot()
  pushListeners = []
  unsubscribeSpy = vi.fn()
  delegateMock = vi.fn(async () => ({ ok: true, missionId: 'm-new' }))
  resolveDecisionMock = vi.fn(async () => ({ ok: true }))
  cancelMissionMock = vi.fn(async () => ({ ok: true }))
  deleteMissionMock = vi.fn(async () => ({ ok: true }))
  cancelTaskMock = vi.fn(async () => ({ ok: true }))
  retryTaskMock = vi.fn(async () => ({ ok: true }))
  steerTaskMock = vi.fn(async () => ({ ok: true }))
  approvePlanMock = vi.fn(async () => ({ ok: true }))
  openPathMock = vi.fn(async () => undefined)

  window.aiOffice = {
    butlerDeskState: vi.fn(async () => currentSnapshot),
    onButlerDeskUpdated: vi.fn((handler: (next: ButlerDeskSnapshot) => void) => {
      pushListeners.push(handler)
      return () => {
        unsubscribeSpy()
        const idx = pushListeners.indexOf(handler)
        if (idx >= 0) pushListeners.splice(idx, 1)
      }
    }),
    butlerDelegate: delegateMock,
    butlerResolveDecision: resolveDecisionMock,
    butlerCancelMission: cancelMissionMock,
    butlerDeleteMission: deleteMissionMock,
    butlerCancelTask: cancelTaskMock,
    butlerRetryTask: retryTaskMock,
    butlerSteerTask: steerTaskMock,
    butlerApproveMissionPlan: approvePlanMock,
    openPath: openPathMock,
  } as unknown as HomeApi
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

async function renderDesk(
  props: ButlerDeskViewProps = {},
  lang: 'en' | 'zh' = 'en',
): Promise<void> {
  await act(async () => {
    root.render(
      createElement(LocaleProvider, { initial: lang }, createElement(ButlerDeskView, props)),
    )
    await Promise.resolve()
    await Promise.resolve()
  })
}

function setControlValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('ButlerDeskView pure helpers', () => {
  it('splits pending decisions FIFO and recentResolved newest-first capped at 5 without mutating input', () => {
    const items: ButlerDecisionItem[] = [
      makeDecision({ id: 'p-late', status: 'pending', createdAt: 300 }),
      makeDecision({
        id: 'r-old',
        status: 'resolved',
        createdAt: 100,
        resolution: { optionId: 'allow', resolvedAt: 150 },
      }),
      makeDecision({ id: 'p-early', status: 'pending', createdAt: 100 }),
      makeDecision({
        id: 'r-newest',
        status: 'resolved',
        createdAt: 200,
        resolution: { optionId: 'deny', resolvedAt: 900 },
      }),
      makeDecision({ id: 'r-exp', status: 'expired', createdAt: 500 }),
      makeDecision({
        id: 'r-mid1',
        status: 'resolved',
        createdAt: 220,
        resolution: { optionId: 'allow', resolvedAt: 400 },
      }),
      makeDecision({
        id: 'r-mid2',
        status: 'cancelled',
        createdAt: 350,
      }),
      makeDecision({
        id: 'r-mid3',
        status: 'resolved',
        createdAt: 310,
        resolution: { optionId: 'allow', resolvedAt: 600 },
      }),
    ]
    const originalOrder = items.map((d) => d.id)

    const split = splitDecisionsForInbox(items)
    expect(items.map((d) => d.id)).toEqual(originalOrder)
    expect(split.pending.map((d) => d.id)).toEqual(['p-early', 'p-late'])
    expect(split.recentResolved).toHaveLength(5)
    expect(split.recentResolved.map((d) => d.id)).toEqual([
      'r-newest',
      'r-mid3',
      'r-exp',
      'r-mid1',
      'r-mid2',
    ])
  })

  it('localizes permission option IDs allow / allow-session / deny and preserves custom labels', () => {
    const decision = makeDecision({ id: 'd-perm', kind: 'permission' })
    expect(formatDecisionOptionLabel(decision, { id: 'allow', label: 'Raw' }, enT)).toBe(
      enT('butlerDecisionAllowOnce'),
    )
    expect(formatDecisionOptionLabel(decision, { id: 'allow-once', label: 'Raw' }, zhT)).toBe(
      zhT('butlerDecisionAllowOnce'),
    )
    expect(formatDecisionOptionLabel(decision, { id: 'allow-session', label: 'Raw' }, enT)).toBe(
      enT('butlerDecisionAllowSession'),
    )
    expect(formatDecisionOptionLabel(decision, { id: 'allow-session', label: 'Raw' }, zhT)).toBe(
      zhT('butlerDecisionAllowSession'),
    )
    expect(formatDecisionOptionLabel(decision, { id: 'deny', label: 'Raw' }, enT)).toBe(
      enT('butlerDecisionDeny'),
    )
    expect(formatDecisionOptionLabel(decision, { id: 'deny', label: 'Raw' }, zhT)).toBe(
      zhT('butlerDecisionDeny'),
    )

    const choiceDecision = makeDecision({ id: 'd-choice', kind: 'choice' })
    expect(
      formatDecisionOptionLabel(choiceDecision, { id: 'plan-b', label: 'Use Plan B' }, enT),
    ).toBe('Use Plan B')
    expect(formatDecisionOptionLabel(choiceDecision, { id: 'fallback-id', label: '  ' }, enT)).toBe(
      'fallback-id',
    )
  })

  it('computes mission task progress counts accurately', () => {
    const mission = makeMission({
      id: 'm-prog',
      taskIds: ['t-done', 't-run', 't-queue', 't-wait', 't-fail', 't-missing'],
    })
    const tasksById = new Map<string, ButlerSubTask>([
      ['t-done', makeSubTask({ id: 't-done', status: 'done' })],
      ['t-run', makeSubTask({ id: 't-run', status: 'running' })],
      ['t-queue', makeSubTask({ id: 't-queue', status: 'queued' })],
      ['t-wait', makeSubTask({ id: 't-wait', status: 'waiting_human' })],
      ['t-fail', makeSubTask({ id: 't-fail', status: 'failed' })],
    ])

    expect(missionTaskProgress(mission, tasksById)).toEqual({
      done: 1,
      total: 6,
      active: 3,
    })
  })

  it('maps roles, decision kinds, mission/subtask statuses, and action guards', () => {
    const kinds: ButlerDecisionKind[] = ['permission', 'choice', 'recovery']
    expect(kinds.map(decisionKindLabelKey)).toEqual([
      'butlerDecisionKindPermission',
      'butlerDecisionKindChoice',
      'butlerDecisionKindRecovery',
    ])

    const roles: ButlerWorkerRole[] = [
      'general',
      'files',
      'research',
      'docs',
      'sheets',
      'slides',
      'browser',
      'ops',
    ]
    expect(roles.map(workerRoleLabelKey)).toEqual([
      'butlerRoleGeneral',
      'butlerRoleFiles',
      'butlerRoleResearch',
      'butlerRoleDocs',
      'butlerRoleSheets',
      'butlerRoleSlides',
      'butlerRoleBrowser',
      'butlerRoleOps',
    ])
    expect(formatElapsedDuration(12_000)).toBe('12s')
    expect(formatElapsedDuration(65_000)).toBe('1m 05s')
    expect(formatElapsedDuration(3_900_000)).toBe('1h 05m')

    const subStatuses: ButlerSubTaskStatus[] = [
      'queued',
      'running',
      'waiting_human',
      'done',
      'failed',
      'cancelled',
      'interrupted',
    ]
    expect(subStatuses.map(subTaskStatusLabelKey)).toEqual([
      'butlerTaskStatusQueued',
      'butlerTaskStatusRunning',
      'butlerTaskStatusWaitingHuman',
      'butlerTaskStatusDone',
      'butlerTaskStatusFailed',
      'butlerTaskStatusCancelled',
      'butlerTaskStatusInterrupted',
    ])
    expect(subStatuses.filter(isSubTaskActive)).toEqual(['queued', 'running', 'waiting_human'])
    expect(subStatuses.filter(canSteerSubTask)).toEqual([
      'queued',
      'running',
      'waiting_human',
      'failed',
      'interrupted',
    ])

    const missionStatuses: ButlerMissionStatus[] = [
      'clarifying',
      'awaiting_plan_approval',
      'planning',
      'running',
      'waiting_human',
      'synthesizing',
      'done',
      'failed',
      'cancelled',
      'interrupted',
    ]
    expect(missionStatuses.filter(isMissionActive)).toEqual([
      'clarifying',
      'awaiting_plan_approval',
      'planning',
      'running',
      'waiting_human',
      'synthesizing',
    ])
    expect(missionStatusLabelKey('clarifying')).toBe('butlerMissionStatusClarifying')
    expect(missionStatusLabelKey('awaiting_plan_approval')).toBe('butlerMissionStatusAwaitingPlan')
    expect(missionStatusLabelKey('planning')).toBe('butlerMissionStatusPlanning')
    expect(missionStatusLabelKey('synthesizing')).toBe('butlerMissionStatusSynthesizing')
    expect(missionStatusLabelKey('done')).toBe('butlerTaskStatusDone')
  })
})

describe('ButlerDeskView rendering and interactions', () => {
  it('renders empty state, status pill, concurrency pill, and unsubscribes on unmount', async () => {
    currentSnapshot = makeEmptySnapshot({
      chiefBusy: true,
      concurrency: { running: 2, maxConcurrent: 4, queued: 1 },
    })

    await renderDesk({}, 'zh')

    expect(host.textContent).toContain(zhT('butlerDeskChiefBusy'))
    expect(host.querySelector('[data-testid="butler-concurrency-pill"]')?.textContent).toBe(
      zhT('butlerDeskConcurrency', { running: 2, max: 4, queued: 1 }),
    )
    const feed = host.querySelector('[data-testid="butler-desk-feed"]')!
    expect(feed.textContent).toContain(zhT('butlerDeskEmptyTitle'))
    expect(feed.textContent).toContain(zhT('butlerDeskEmptyHint'))
    expect(host.querySelector('[data-testid="butler-decision-inbox"]')?.textContent).toContain(
      zhT('butlerDecisionEmpty'),
    )
    expect(host.querySelector('[data-testid="butler-missions-panel"]')?.textContent).toContain(
      zhT('butlerMissionsEmpty'),
    )

    expect(unsubscribeSpy).not.toHaveBeenCalled()
    act(() => root.unmount())
    expect(unsubscribeSpy).toHaveBeenCalledTimes(1)
  })

  it('renders executive report card with distinct UI for existing vs missing artifacts', async () => {
    const onPreviewFile = vi.fn()
    const onOpenFile = vi.fn()

    currentSnapshot = makeEmptySnapshot({
      feed: [
        {
          id: 'e-1',
          role: 'user',
          text: 'Prepare weekly executive summary',
          createdAt: 1000,
        },
        {
          id: 'e-2',
          role: 'butler',
          text: 'Mission complete.',
          createdAt: 2000,
          report: {
            headline: 'Q4 Launch Readiness Delivered',
            summary: 'All background teams finished analysis.',
            risks: ['Legacy test coverage is below 60%'],
            artifacts: [
              { path: '/tmp/launch-brief.docx', label: 'Launch Brief', existsOnDisk: true },
              { path: '/tmp/missing-sheet.xlsx', label: 'Missing Sheet', existsOnDisk: false },
            ],
            nextSuggestion: 'Review the Launch Brief before tomorrow morning sync.',
            generatedAt: 2000,
          },
        },
      ],
    })

    await renderDesk({ onPreviewFile, onOpenFile }, 'en')

    const reportCard = host.querySelector('[data-testid="butler-report-card"]')!
    expect(reportCard).toBeTruthy()
    expect(reportCard.textContent).toContain('Q4 Launch Readiness Delivered')
    expect(reportCard.textContent).toContain('All background teams finished analysis.')
    expect(reportCard.textContent).toContain('Legacy test coverage is below 60%')
    expect(reportCard.textContent).toContain(
      'Review the Launch Brief before tomorrow morning sync.',
    )

    const artifactRows = [...reportCard.querySelectorAll('[data-testid="butler-artifact-row"]')]
    expect(artifactRows).toHaveLength(2)

    const existingRow = artifactRows[0]!
    expect(existingRow.getAttribute('data-exists')).toBe('true')
    const previewBtn = existingRow.querySelector<HTMLButtonElement>(
      '[data-testid="butler-artifact-preview-btn"]',
    )!
    const openBtn = existingRow.querySelector<HTMLButtonElement>(
      '[data-testid="butler-artifact-open-btn"]',
    )!
    expect(previewBtn).toBeTruthy()
    expect(openBtn).toBeTruthy()

    await act(async () => {
      previewBtn.click()
      openBtn.click()
    })
    expect(onPreviewFile).toHaveBeenCalledWith('/tmp/launch-brief.docx')
    expect(onOpenFile).toHaveBeenCalledWith('/tmp/launch-brief.docx')

    const missingRow = artifactRows[1]!
    expect(missingRow.getAttribute('data-exists')).toBe('false')
    expect(missingRow.textContent).toContain(enT('butlerReportMissingFile'))
    expect(missingRow.querySelector('[data-testid="butler-artifact-preview-btn"]')).toBeNull()
    expect(missingRow.querySelector('[data-testid="butler-artifact-open-btn"]')).toBeNull()
  })

  it('falls back to window.aiOffice.openPath when onOpenFile prop is omitted', async () => {
    currentSnapshot = makeEmptySnapshot({
      feed: [
        {
          id: 'e-open-fallback',
          role: 'butler',
          text: 'Done',
          createdAt: 1000,
          report: {
            headline: 'Report',
            summary: 'Summary',
            risks: [],
            artifacts: [{ path: '/tmp/summary.pdf', label: 'Summary PDF', existsOnDisk: true }],
            generatedAt: 1000,
          },
        },
      ],
    })

    await renderDesk({}, 'en')
    const openBtn = host.querySelector<HTMLButtonElement>(
      '[data-testid="butler-artifact-open-btn"]',
    )!
    await act(async () => {
      openBtn.click()
      await Promise.resolve()
    })
    expect(openPathMock).toHaveBeenCalledWith('/tmp/summary.pdf')
  })

  it('delegates goals via Enter or send button while ignoring IME composition and Shift+Enter', async () => {
    await renderDesk({}, 'en')

    const input = host.querySelector<HTMLTextAreaElement>('[data-testid="butler-desk-input"]')!
    const sendBtn = host.querySelector<HTMLButtonElement>('[data-testid="butler-desk-send-btn"]')!
    expect(sendBtn.disabled).toBe(true)

    await act(async () => {
      setControlValue(input, 'Audit all modules')
    })
    expect(sendBtn.disabled).toBe(false)

    // IME composing (isComposing / keyCode 229) must not submit
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      )
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          keyCode: 229,
          bubbles: true,
          cancelable: true,
        }),
      )
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      )
      await Promise.resolve()
    })
    expect(delegateMock).not.toHaveBeenCalled()

    // Plain Enter submits and clears draft on ok: true
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
      await Promise.resolve()
    })
    expect(delegateMock).toHaveBeenCalledWith('Audit all modules')
    expect(input.value).toBe('')

    // Failed delegation restores draft and displays error alert
    delegateMock.mockResolvedValueOnce({ ok: false, error: 'Engine offline' })
    await act(async () => {
      setControlValue(input, 'Retry task')
    })
    await act(async () => {
      sendBtn.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(input.value).toBe('Retry task')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Engine offline')
  })

  it('renders Decision Inbox cards, handles focus highlighting, prevents double-click while resolving', async () => {
    let resolvePendingCall!: (val: { ok: boolean }) => void
    resolveDecisionMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePendingCall = resolve
        }),
    )

    currentSnapshot = makeEmptySnapshot({
      decisions: [
        makeDecision({
          id: 'dec-1',
          kind: 'permission',
          title: 'Run shell script',
          summary: 'Execute build check',
          detail: 'npm run build',
          toolName: 'run_command',
        }),
        makeDecision({
          id: 'dec-2',
          kind: 'choice',
          title: 'Pick output format',
          summary: 'DOCX or PDF?',
          options: [{ id: 'docx', label: 'DOCX', style: 'primary' }],
          createdAt: 2000,
        }),
      ],
    })

    await renderDesk({ focusTarget: { decisionId: 'dec-2' } }, 'en')

    const cards = [...host.querySelectorAll<HTMLElement>('[data-testid="butler-decision-card"]')]
    expect(cards).toHaveLength(2)
    expect(cards[0]?.dataset.decisionId).toBe('dec-1')
    expect(cards[0]?.textContent).toContain('run_command')
    expect(cards[0]?.textContent).toContain('npm run build')
    expect(cards[1]?.dataset.decisionId).toBe('dec-2')
    expect(cards[1]?.classList.contains('is-focused')).toBe(true)

    const noteInput = cards[0]!.querySelector<HTMLInputElement>(
      '[data-testid="butler-decision-note"]',
    )!
    const allowBtn = cards[0]!.querySelector<HTMLButtonElement>(
      '[data-testid="butler-decision-opt-allow"]',
    )!
    const denyBtn = cards[0]!.querySelector<HTMLButtonElement>(
      '[data-testid="butler-decision-opt-deny"]',
    )!

    await act(async () => {
      setControlValue(noteInput, 'Only inspect src/')
    })
    await act(async () => {
      allowBtn.click()
      await Promise.resolve()
    })

    // While in-flight, buttons on that card must be disabled to prevent double submit
    expect(allowBtn.disabled).toBe(true)
    expect(denyBtn.disabled).toBe(true)
    expect(resolveDecisionMock).toHaveBeenCalledWith({
      decisionId: 'dec-1',
      optionId: 'allow',
      note: 'Only inspect src/',
    })

    await act(async () => {
      resolvePendingCall({ ok: true })
      await Promise.resolve()
    })
    expect(allowBtn.disabled).toBe(false)
  })

  it('renders collapsible missions board, steers subtasks, cancels tasks/missions, and syncs live pushes', async () => {
    const activeTask = makeSubTask({
      id: 't-active',
      missionId: 'm-active',
      title: 'Inspect codebase',
      role: 'docs',
      status: 'running',
      step: { kind: 'read', tool: 'read_file' },
      progressNote: 'Scanning renderer components',
      dependsOn: ['t-done'],
      artifacts: [{ path: '/tmp/notes.md', label: 'Notes', existsOnDisk: true }],
    })
    const doneTask = makeSubTask({
      id: 't-done',
      missionId: 'm-active',
      title: 'Gather context',
      role: 'research',
      status: 'done',
    })
    const oldTask = makeSubTask({
      id: 't-old',
      missionId: 'm-done',
      title: 'Archived step',
      role: 'sheets',
      status: 'done',
    })

    currentSnapshot = makeEmptySnapshot({
      missions: [
        makeMission({
          id: 'm-done',
          title: 'Completed Mission',
          status: 'done',
          updatedAt: 500,
          taskIds: ['t-old'],
        }),
        makeMission({
          id: 'm-active',
          title: 'Active Mission',
          status: 'running',
          updatedAt: 1000,
          taskIds: ['t-done', 't-active'],
        }),
      ],
      tasks: [doneTask, activeTask, oldTask],
    })

    await renderDesk({}, 'en')

    const missionsPanel = host.querySelector('[data-testid="butler-missions-panel"]')!
    const activeMissionCard = missionsPanel.querySelector<HTMLElement>(
      '[data-mission-id="m-active"]',
    )!
    const doneMissionCard = missionsPanel.querySelector<HTMLElement>('[data-mission-id="m-done"]')!

    // Active mission starts expanded, finished mission starts collapsed
    expect(activeMissionCard.querySelector('[data-task-id="t-active"]')).toBeTruthy()
    expect(doneMissionCard.querySelector('[data-task-id="t-old"]')).toBeNull()
    expect(activeMissionCard.textContent).toContain(enT('butlerRoleDocs'))
    expect(activeMissionCard.textContent).toContain(enT('butlerStepRead'))
    expect(activeMissionCard.textContent).toContain('Scanning renderer components')
    expect(activeMissionCard.textContent).toContain(
      enT('butlerTaskDependsOn', { deps: 'Gather context' }),
    )

    // Expand collapsed mission manually
    const expandBtn = [...doneMissionCard.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === enT('butlerMissionsToggleExpand'),
    )!
    await act(async () => {
      expandBtn.click()
    })
    expect(doneMissionCard.querySelector('[data-task-id="t-old"]')).toBeTruthy()

    // Steer active subtask
    const taskRow = activeMissionCard.querySelector<HTMLElement>('[data-task-id="t-active"]')!
    const steerToggleBtn = [...taskRow.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === enT('butlerTaskSteer'),
    )!
    await act(async () => {
      steerToggleBtn.click()
    })
    const steerInput = taskRow.querySelector<HTMLInputElement>(
      '[data-testid="butler-steer-input"]',
    )!
    const steerSubmit = taskRow.querySelector<HTMLButtonElement>(
      '[data-testid="butler-steer-submit"]',
    )!
    await act(async () => {
      setControlValue(steerInput, 'Focus on ButlerDeskView')
    })
    await act(async () => {
      steerSubmit.click()
      await Promise.resolve()
    })
    expect(steerTaskMock).toHaveBeenCalledWith({
      taskId: 't-active',
      instruction: 'Focus on ButlerDeskView',
    })

    // Cancel subtask and cancel mission
    const cancelTaskBtn = [...taskRow.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === enT('butlerTaskCancel'),
    )!
    const cancelMissionBtn = [
      ...activeMissionCard.querySelectorAll<HTMLButtonElement>('button'),
    ].find((b) => b.textContent === enT('butlerMissionCancel'))!
    await act(async () => {
      cancelTaskBtn.click()
      cancelMissionBtn.click()
      await Promise.resolve()
    })
    expect(cancelTaskMock).toHaveBeenCalledWith('t-active')
    expect(cancelMissionMock).toHaveBeenCalledWith('m-active')

    // Real-time snapshot push updates UI
    await act(async () => {
      for (const listener of pushListeners) {
        listener(
          makeEmptySnapshot({
            chiefBusy: false,
            concurrency: { running: 0, maxConcurrent: 3, queued: 0 },
            feed: [
              {
                id: 'push-1',
                role: 'butler',
                text: 'Pushed update received',
                createdAt: 3000,
              },
            ],
          }),
        )
      }
      await Promise.resolve()
    })
    expect(host.querySelector('[data-testid="butler-desk-feed"]')?.textContent).toContain(
      'Pushed update received',
    )
  })

  it('auto-expands and highlights a finished mission when focusTarget.missionId targets it', async () => {
    const oldTask = makeSubTask({
      id: 't-focus-1',
      missionId: 'm-finished',
      title: 'Final summary',
      role: 'docs',
      status: 'done',
    })
    currentSnapshot = makeEmptySnapshot({
      missions: [
        makeMission({
          id: 'm-finished',
          title: 'Finished Target Mission',
          status: 'done',
          taskIds: ['t-focus-1'],
        }),
      ],
      tasks: [oldTask],
    })

    await renderDesk({ focusTarget: { missionId: 'm-finished' } }, 'en')

    const card = host.querySelector<HTMLElement>('[data-mission-id="m-finished"]')!
    expect(card.classList.contains('is-focused')).toBe(true)
    expect(card.querySelector('[data-task-id="t-focus-1"]')).toBeTruthy()
  })

  it('renders PlanApprovalCard when mission is awaiting_plan_approval and approves via butlerApproveMissionPlan', async () => {
    currentSnapshot = makeEmptySnapshot({
      missions: [
        makeMission({
          id: 'm-plan-1',
          title: 'Q4 Slides Mission',
          status: 'awaiting_plan_approval',
          plan: {
            summary: 'Research quarterly numbers first, then build executive slides.',
            revision: 2,
            updatedAt: 3000,
            steps: [
              {
                id: 'step-1',
                title: 'Collect Q4 metrics',
                brief: 'Read financial sheets in workspace.',
                role: 'research',
                dependsOn: [],
              },
              {
                id: 'step-2',
                title: 'Build presentation deck',
                brief: 'Draft 10-slide PPTX summary.',
                role: 'slides',
                dependsOn: ['step-1'],
              },
            ],
          },
        }),
      ],
    })

    await renderDesk({}, 'en')

    const planCard = host.querySelector<HTMLElement>('[data-testid="butler-plan-card"]')!
    expect(planCard).toBeTruthy()
    expect(planCard.dataset.missionId).toBe('m-plan-1')
    expect(planCard.textContent).toContain(enT('butlerPlanCardTitle'))
    expect(planCard.textContent).toContain(enT('butlerPlanCardRevision', { rev: 2 }))
    expect(planCard.textContent).toContain(
      'Research quarterly numbers first, then build executive slides.',
    )
    expect(planCard.textContent).toContain('Collect Q4 metrics')
    expect(planCard.textContent).toContain('Build presentation deck')
    expect(planCard.textContent).toContain(enT('butlerRoleResearch'))
    expect(planCard.textContent).toContain(enT('butlerRoleSlides'))

    const approveBtn = planCard.querySelector<HTMLButtonElement>(
      '[data-testid="butler-approve-plan-btn"]',
    )!
    await act(async () => {
      approveBtn.click()
      await Promise.resolve()
    })
    expect(approvePlanMock).toHaveBeenCalledWith({ missionId: 'm-plan-1' })
  })

  it('renders Delete Mission and Retry SubTask buttons for failed/cancelled/interrupted tasks with loading guards', async () => {
    let resolveDelete: ((res: { ok: boolean }) => void) | null = null
    let resolveRetry: ((res: { ok: boolean }) => void) | null = null
    deleteMissionMock.mockImplementationOnce(
      () =>
        new Promise<{ ok: boolean }>((resolve) => {
          resolveDelete = resolve
        }),
    )
    retryTaskMock.mockImplementationOnce(
      () =>
        new Promise<{ ok: boolean }>((resolve) => {
          resolveRetry = resolve
        }),
    )

    currentSnapshot = makeEmptySnapshot({
      missions: [
        makeMission({
          id: 'm-del-retry',
          title: 'Recoverable Mission',
          status: 'failed',
          taskIds: ['t-failed', 't-cancelled', 't-interrupted', 't-done'],
        }),
      ],
      tasks: [
        makeSubTask({
          id: 't-failed',
          missionId: 'm-del-retry',
          title: 'Failed step',
          status: 'failed',
        }),
        makeSubTask({
          id: 't-cancelled',
          missionId: 'm-del-retry',
          title: 'Cancelled step',
          status: 'cancelled',
        }),
        makeSubTask({
          id: 't-interrupted',
          missionId: 'm-del-retry',
          title: 'Interrupted step',
          status: 'interrupted',
        }),
        makeSubTask({
          id: 't-done',
          missionId: 'm-del-retry',
          title: 'Completed step',
          status: 'done',
        }),
      ],
    })

    await renderDesk({ focusTarget: { missionId: 'm-del-retry' } }, 'en')

    const missionCard = host.querySelector<HTMLElement>('[data-mission-id="m-del-retry"]')!
    const deleteBtn = missionCard.querySelector<HTMLButtonElement>(
      '[data-testid="butler-delete-mission-btn"]',
    )!
    expect(deleteBtn).toBeTruthy()
    expect(deleteBtn.textContent).toBe(enT('butlerMissionDelete'))

    const failedRow = missionCard.querySelector<HTMLElement>('[data-task-id="t-failed"]')!
    const cancelledRow = missionCard.querySelector<HTMLElement>('[data-task-id="t-cancelled"]')!
    const interruptedRow = missionCard.querySelector<HTMLElement>('[data-task-id="t-interrupted"]')!
    const doneRow = missionCard.querySelector<HTMLElement>('[data-task-id="t-done"]')!

    const failedRetryBtn = failedRow.querySelector<HTMLButtonElement>(
      '[data-testid="butler-retry-task-btn"]',
    )!
    expect(failedRetryBtn).toBeTruthy()
    expect(failedRetryBtn.textContent).toBe(enT('butlerTaskRetry'))
    expect(cancelledRow.querySelector('[data-testid="butler-retry-task-btn"]')).toBeTruthy()
    expect(interruptedRow.querySelector('[data-testid="butler-retry-task-btn"]')).toBeTruthy()
    expect(doneRow.querySelector('[data-testid="butler-retry-task-btn"]')).toBeNull()

    // Click Retry twice while in flight: loading guard disables button and allows only 1 IPC call.
    await act(async () => {
      failedRetryBtn.click()
      failedRetryBtn.click()
      await Promise.resolve()
    })
    expect(failedRetryBtn.disabled).toBe(true)
    expect(retryTaskMock).toHaveBeenCalledTimes(1)
    expect(retryTaskMock).toHaveBeenCalledWith({ taskId: 't-failed' })

    await act(async () => {
      resolveRetry?.({ ok: true })
      await Promise.resolve()
    })
    expect(failedRetryBtn.disabled).toBe(false)

    // Click Delete twice while in flight: loading guard disables button and allows only 1 IPC call.
    await act(async () => {
      deleteBtn.click()
      deleteBtn.click()
      await Promise.resolve()
    })
    expect(deleteBtn.disabled).toBe(true)
    expect(deleteMissionMock).toHaveBeenCalledTimes(1)
    expect(deleteMissionMock).toHaveBeenCalledWith('m-del-retry')

    await act(async () => {
      resolveDelete?.({ ok: false, error: 'Cannot remove mission right now' })
      await Promise.resolve()
    })
    expect(deleteBtn.disabled).toBe(false)
    expect(host.textContent).toContain('Cannot remove mission right now')
  })

  it('renders live step count, elapsed timer, slow/stalled health indicators, and collapsible activityLog timeline', async () => {
    vi.useFakeTimers()
    const baseNow = 1_700_000_065_000
    vi.setSystemTime(baseNow)
    try {
      currentSnapshot = makeEmptySnapshot({
        missions: [
          makeMission({
            id: 'm-telemetry',
            title: 'Scan workspace & run diagnostics',
            status: 'running',
            taskIds: ['t-run-slow', 't-run-stalled', 't-done-log'],
          }),
        ],
        tasks: [
          makeSubTask({
            id: 't-run-slow',
            missionId: 'm-telemetry',
            title: 'Scan videos folder',
            role: 'files',
            status: 'running',
            startedAt: baseNow - 12_000,
            lastActiveAt: baseNow - 35_000,
            stepCount: 3,
            health: 'slow',
            step: {
              kind: 'command',
              tool: 'find',
            },
            activityLog: [
              {
                seq: 1,
                at: baseNow - 10_000,
                kind: 'command',
                tool: 'find',
                summary: 'Scanning D:/Videos for .mp4',
              },
              {
                seq: 2,
                at: baseNow - 4_000,
                kind: 'error',
                tool: 'read',
                summary: 'Permission denied on System Volume',
                isError: true,
              },
            ],
          }),
          makeSubTask({
            id: 't-run-stalled',
            missionId: 'm-telemetry',
            title: 'Verify shell build',
            role: 'ops',
            status: 'running',
            startedAt: baseNow - 95_000,
            lastActiveAt: baseNow - 92_000,
            stepCount: 2,
            consecutiveErrors: 3,
            step: {
              kind: 'command',
              tool: 'bash',
            },
          }),
          makeSubTask({
            id: 't-done-log',
            missionId: 'm-telemetry',
            title: 'Draft report',
            role: 'docs',
            status: 'done',
            startedAt: baseNow - 80_000,
            finishedAt: baseNow - 15_000,
            stepCount: 4,
            activityLog: [
              {
                seq: 1,
                at: baseNow - 75_000,
                kind: 'create',
                tool: 'write',
                summary: 'Created summary.md',
              },
            ],
          }),
        ],
      })

      await renderDesk({}, 'en')

      const slowRow = host.querySelector<HTMLElement>('[data-task-id="t-run-slow"]')!
      expect(slowRow.querySelector('.butler-role-badge')?.textContent).toBe(enT('butlerRoleFiles'))
      expect(
        slowRow.querySelector('[data-testid="butler-subtask-step-badge"]')?.textContent,
      ).toBe(enT('butlerTaskStepCount', { count: 3 }))
      expect(
        slowRow.querySelector('[data-testid="butler-subtask-elapsed-badge"]')?.textContent,
      ).toBe(enT('butlerTaskElapsed', { elapsed: '12s' }))
      const slowHealth = slowRow.querySelector<HTMLElement>(
        '[data-testid="butler-subtask-health-badge"]',
      )!
      expect(slowHealth.dataset.health).toBe('slow')
      expect(slowHealth.textContent).toBe(enT('butlerTaskHealthSlow'))

      // Running subtask activity timeline is expanded by default.
      const slowToggle = slowRow.querySelector<HTMLButtonElement>(
        '[data-testid="butler-subtask-activity-toggle"]',
      )!
      expect(slowToggle.textContent).toBe(enT('butlerTaskActivityHide'))
      const slowList = slowRow.querySelector<HTMLElement>(
        '[data-testid="butler-subtask-activity-list"]',
      )!
      expect(slowList).toBeTruthy()
      expect(slowList.textContent).toContain('find')
      expect(slowList.textContent).toContain('+2s')
      expect(slowList.textContent).toContain('Scanning D:/Videos for .mp4')
      const errorItem = slowList.querySelector<HTMLElement>('[data-error="true"]')!
      expect(errorItem).toBeTruthy()
      expect(errorItem.textContent).toContain('Permission denied on System Volume')

      // Collapse and re-expand the running subtask timeline.
      await act(async () => {
        slowToggle.click()
        await Promise.resolve()
      })
      expect(slowRow.querySelector('[data-testid="butler-subtask-activity-list"]')).toBeNull()
      expect(slowToggle.textContent).toBe(enT('butlerTaskActivityShow', { count: 2 }))

      await act(async () => {
        slowToggle.click()
        await Promise.resolve()
      })
      expect(slowRow.querySelector('[data-testid="butler-subtask-activity-list"]')).toBeTruthy()

      // Advance 1s tick -> live elapsed counter advances to 13s.
      await act(async () => {
        vi.advanceTimersByTime(1000)
        await Promise.resolve()
      })
      expect(
        slowRow.querySelector('[data-testid="butler-subtask-elapsed-badge"]')?.textContent,
      ).toBe(enT('butlerTaskElapsed', { elapsed: '13s' }))

      // Stalled subtask evaluates health dynamically even without a precomputed health field.
      const stalledRow = host.querySelector<HTMLElement>('[data-task-id="t-run-stalled"]')!
      expect(stalledRow.querySelector('.butler-role-badge')?.textContent).toBe(enT('butlerRoleOps'))
      const stalledHealth = stalledRow.querySelector<HTMLElement>(
        '[data-testid="butler-subtask-health-badge"]',
      )!
      expect(stalledHealth.dataset.health).toBe('stalled')
      expect(stalledHealth.textContent).toBe(enT('butlerTaskHealthStalled'))

      // Finished subtask shows fixed duration (1m 05s) and collapsed activityLog until toggled.
      const doneRow = host.querySelector<HTMLElement>('[data-task-id="t-done-log"]')!
      expect(
        doneRow.querySelector('[data-testid="butler-subtask-elapsed-badge"]')?.textContent,
      ).toBe(enT('butlerTaskElapsed', { elapsed: '1m 05s' }))
      expect(doneRow.querySelector('[data-testid="butler-subtask-activity-list"]')).toBeNull()

      const doneToggle = doneRow.querySelector<HTMLButtonElement>(
        '[data-testid="butler-subtask-activity-toggle"]',
      )!
      expect(doneToggle.textContent).toBe(enT('butlerTaskActivityShow', { count: 1 }))
      await act(async () => {
        doneToggle.click()
        await Promise.resolve()
      })
      const doneList = doneRow.querySelector<HTMLElement>(
        '[data-testid="butler-subtask-activity-list"]',
      )!
      expect(doneList).toBeTruthy()
      expect(doneList.textContent).toContain('Created summary.md')
    } finally {
      vi.useRealTimers()
    }
  })

  it('localizes steered system entries, omits duplicate thinking label, and keeps zero-subtask cards free of expand toggles', async () => {
    currentSnapshot = makeEmptySnapshot({
      feed: [
        {
          id: 'sys-steer',
          role: 'system',
          text: 'Steered task "Rename Butler": check hot reload behavior now',
          createdAt: 1000,
        },
      ],
      missions: [
        makeMission({
          id: 'm-synth',
          title: 'Rename Butler',
          status: 'synthesizing',
          updatedAt: 2000,
          taskIds: ['t-think'],
        }),
        makeMission({
          id: 'm-empty',
          title: 'Chat Only',
          status: 'done',
          updatedAt: 1000,
          taskIds: [],
        }),
      ],
      tasks: [
        makeSubTask({
          id: 't-think',
          missionId: 'm-synth',
          role: 'ops',
          status: 'running',
          step: { kind: 'think', tool: 'thinking' },
          progressNote: 'Inspecting app-settings watcher',
        }),
      ],
    })

    await renderDesk({}, 'zh')

    const feed = host.querySelector('[data-testid="butler-desk-feed"]')!
    expect(feed.textContent).toContain(
      zhT('butlerSystemSteeredTask', {
        title: 'Rename Butler',
        instruction: 'check hot reload behavior now',
      }),
    )
    expect(feed.textContent).not.toContain('Steered task')

    const synthCard = host.querySelector<HTMLElement>('[data-mission-id="m-synth"]')!
    expect(synthCard.querySelector('.butler-status-badge')?.textContent).toBe(
      zhT('butlerMissionStatusSynthesizing'),
    )
    const thinkRow = synthCard.querySelector<HTMLElement>('[data-task-id="t-think"]')!
    const noteText = thinkRow.querySelector('.butler-subtask-note')?.textContent ?? ''
    expect(noteText).toContain(zhT('butlerStepThink'))
    expect(noteText).toContain('Inspecting app-settings watcher')
    expect(noteText).not.toContain('thinking')

    const emptyCard = host.querySelector<HTMLElement>('[data-mission-id="m-empty"]')!
    const emptyExpandBtn = [...emptyCard.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) =>
        b.textContent === zhT('butlerMissionsToggleExpand') ||
        b.textContent === zhT('butlerMissionsToggleCollapse'),
    )
    expect(emptyExpandBtn).toBeUndefined()
    expect(emptyCard.querySelector('.butler-mission-progress')).toBeNull()
  })
})
