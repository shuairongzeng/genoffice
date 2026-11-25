import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  BUTLER_CHIEF_SESSION_KEY,
  type ButlerDecisionItem,
  type ButlerMission,
  type ButlerMissionReport,
  type ButlerSubTask,
} from '../../shared/butler-orchestrator-api'
import type { PiAgentConfirmReply, PiAgentConfirmRequest } from '../../shared/pi-agent-api'
import {
  createButlerMissionEngine,
  hasCycleInDependencyGraph,
  type ButlerMissionEngineDeps,
} from './butler-mission-engine'
import {
  butlerMissionsPath,
  readButlerMissionState,
  writeButlerMissionState,
  type ButlerPersistedMissions,
} from './butler-mission-store'

let tempRoot: string | undefined

afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = undefined
  }
})

function makeTempDir(): string {
  tempRoot ??= mkdtempSync(join(tmpdir(), 'genoffice-butler-mission-'))
  return tempRoot
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeConfirmReq(
  sessionKey: string,
  requestId = 'req-1',
  sessionAllowable = true,
): PiAgentConfirmRequest {
  return {
    requestId,
    sessionKey,
    call: {
      id: 'call-1',
      name: 'write_file',
      input: { path: '/tmp/out.md' },
    },
    argsSummary: 'Write /tmp/out.md',
    sessionAllowable,
  }
}

describe('butler-mission-store', () => {
  it('returns empty store on ENOENT and corrupt JSON', async () => {
    const dir = makeTempDir()
    const filePath = butlerMissionsPath(dir)
    expect(filePath).toBe(join(dir, 'butler-missions.json'))

    const missing = await readButlerMissionState(filePath)
    expect(missing).toEqual({
      version: 1,
      missions: [],
      tasks: [],
      decisions: [],
      feed: [],
      updatedAt: 0,
      recovered: false,
    })

    writeFileSync(filePath, '{corrupted json', 'utf8')
    const corrupt = await readButlerMissionState(filePath)
    expect(corrupt.recovered).toBe(false)
    expect(corrupt.missions).toEqual([])
  })

  it('trims persisted missions to 30 (with linked tasks/decisions) and feed to 200', async () => {
    const dir = makeTempDir()
    const filePath = join(dir, 'nested', 'butler-missions.json')

    const missions: ButlerMission[] = Array.from({ length: 35 }, (_, i) => ({
      id: `mission-${i}`,
      title: `Mission ${i}`,
      goal: `Goal ${i}`,
      status: 'done',
      createdAt: 1000 + i,
      updatedAt: 1000 + i,
      finishedAt: 1000 + i,
      taskIds: [`task-${i}`],
    }))

    const tasks: ButlerSubTask[] = Array.from({ length: 35 }, (_, i) => ({
      id: `task-${i}`,
      missionId: `mission-${i}`,
      title: `Task ${i}`,
      brief: `Brief ${i}`,
      role: 'general',
      dependsOn: [],
      sessionKey: `default:butler-worker-task-${i}`,
      status: 'done',
      step: null,
      artifacts: [],
      createdAt: 1000 + i,
    }))

    const decisions: ButlerDecisionItem[] = Array.from({ length: 35 }, (_, i) => ({
      id: `dec-${i}`,
      missionId: `mission-${i}`,
      taskId: `task-${i}`,
      sessionKey: `default:butler-worker-task-${i}`,
      kind: 'choice',
      title: `Decision ${i}`,
      summary: `Summary ${i}`,
      options: [{ id: 'ok', label: 'OK' }],
      status: 'resolved',
      createdAt: 1000 + i,
    }))

    const feed = Array.from({ length: 220 }, (_, i) => ({
      id: `entry-${i}`,
      role: 'user' as const,
      text: `Message ${i}`,
      createdAt: 2000 + i,
    }))

    await writeButlerMissionState(filePath, {
      version: 1,
      missions,
      tasks,
      decisions,
      feed,
      updatedAt: 9999,
    })

    const loaded = await readButlerMissionState(filePath)
    expect(loaded.recovered).toBe(false)
    expect(loaded.missions).toHaveLength(30)
    expect(loaded.missions[0]!.id).toBe('mission-5')
    expect(loaded.missions[29]!.id).toBe('mission-34')
    expect(loaded.tasks).toHaveLength(30)
    expect(loaded.tasks.every((t) => !t.id.endsWith('-0') && Number(t.id.split('-')[1]) >= 5)).toBe(
      true,
    )
    expect(loaded.decisions).toHaveLength(30)
    expect(loaded.feed).toHaveLength(200)
    expect(loaded.feed[0]!.id).toBe('entry-20')
    expect(loaded.feed[199]!.id).toBe('entry-219')
  })

  it('recovers non-terminal missions, tasks, and pending decisions on crash restart', async () => {
    const dir = makeTempDir()
    const filePath = butlerMissionsPath(dir)

    const crashedState: ButlerPersistedMissions = {
      version: 1,
      missions: [
        {
          id: 'm-run',
          title: 'Running',
          goal: 'Goal 1',
          status: 'running',
          createdAt: 10,
          updatedAt: 20,
          taskIds: ['t-run', 't-queue'],
        },
        {
          id: 'm-synth',
          title: 'Synth',
          goal: 'Goal 2',
          status: 'synthesizing',
          createdAt: 11,
          updatedAt: 21,
          taskIds: [],
        },
        {
          id: 'm-done',
          title: 'Done',
          goal: 'Goal 3',
          status: 'done',
          createdAt: 12,
          updatedAt: 22,
          taskIds: [],
        },
      ],
      tasks: [
        {
          id: 't-run',
          missionId: 'm-run',
          title: 'Worker 1',
          brief: 'Brief 1',
          role: 'research',
          dependsOn: [],
          sessionKey: 'default:butler-worker-t-run',
          status: 'running',
          step: { tool: 'grep', kind: 'search' },
          artifacts: [],
          createdAt: 10,
        },
        {
          id: 't-queue',
          missionId: 'm-run',
          title: 'Worker 2',
          brief: 'Brief 2',
          role: 'docs',
          dependsOn: ['t-run'],
          sessionKey: 'default:butler-worker-t-queue',
          status: 'queued',
          step: null,
          artifacts: [],
          createdAt: 11,
        },
      ],
      decisions: [
        {
          id: 'd-pending',
          missionId: 'm-run',
          taskId: 't-run',
          sessionKey: 'default:butler-worker-t-run',
          kind: 'permission',
          title: 'Confirm',
          summary: 'Summary',
          options: [{ id: 'allow', label: 'Allow' }],
          status: 'pending',
          createdAt: 15,
        },
      ],
      feed: [],
      updatedAt: 30,
    }

    writeFileSync(filePath, JSON.stringify(crashedState), 'utf8')

    const snapshots: number[] = []
    const engine = createButlerMissionEngine({
      statePath: filePath,
      runPrompt: vi.fn(async () => ({ ok: true })),
      abortSession: vi.fn(async () => {}),
      onSnapshotUpdated: (snap) => snapshots.push(snap.missions.length),
    })

    const snap = await engine.init()
    expect(snapshots).toHaveLength(1)
    expect(snap.missions.find((m) => m.id === 'm-run')?.status).toBe('interrupted')
    expect(snap.missions.find((m) => m.id === 'm-synth')?.status).toBe('interrupted')
    expect(snap.missions.find((m) => m.id === 'm-done')?.status).toBe('done')

    const tRun = snap.tasks.find((t) => t.id === 't-run')!
    expect(tRun.status).toBe('interrupted')
    expect(tRun.step).toBeNull()
    expect(snap.tasks.find((t) => t.id === 't-queue')?.status).toBe('interrupted')
    expect(snap.decisions.find((d) => d.id === 'd-pending')?.status).toBe('expired')
    expect(engine.recoverWorkerRoleForSession('default:butler-worker-t-run')).toBe('research')
    expect(engine.recoverWorkerRoleForSession('default:butler-worker-unknown')).toBeNull()

    const rewritten = JSON.parse(readFileSync(filePath, 'utf8')) as ButlerPersistedMissions
    expect(rewritten.missions.find((m) => m.id === 'm-run')?.status).toBe('interrupted')
    expect(rewritten.decisions.find((d) => d.id === 'd-pending')?.status).toBe('expired')

    await engine.dispose()
  })

  it('preserves clarifying and awaiting_plan_approval missions with conversationNotes and plan across restart', async () => {
    const dir = makeTempDir()
    const filePath = butlerMissionsPath(dir)

    const savedState: ButlerPersistedMissions = {
      version: 1,
      missions: [
        {
          id: 'm-clarify',
          title: 'Clarifying',
          goal: 'Prepare quarterly report',
          status: 'clarifying',
          createdAt: 100,
          updatedAt: 110,
          taskIds: [],
          conversationNotes: ['Prepare quarterly report'],
        },
        {
          id: 'm-draft',
          title: 'Draft Plan',
          goal: 'Analyze Q4 metrics',
          status: 'awaiting_plan_approval',
          createdAt: 120,
          updatedAt: 130,
          taskIds: [],
          conversationNotes: ['Analyze Q4 metrics', 'Focus on APAC'],
          plan: {
            summary: 'Analyze APAC sheets then write brief.',
            steps: [
              {
                id: 's1',
                title: 'Inspect APAC sheet',
                brief: 'Read APAC sales workbook.',
                role: 'sheets',
                dependsOn: [],
                scopePaths: ['D:/work/apac.xlsx'],
              },
              {
                id: 's2',
                title: 'Write summary',
                brief: 'Draft summary doc.',
                role: 'docs',
                dependsOn: ['s1'],
              },
            ],
            revision: 2,
            updatedAt: 130,
          },
        },
      ],
      tasks: [],
      decisions: [],
      feed: [],
      updatedAt: 130,
    }

    writeFileSync(filePath, JSON.stringify(savedState), 'utf8')
    const loaded = await readButlerMissionState(filePath)
    expect(loaded.recovered).toBe(false)
    expect(loaded.missions.find((m) => m.id === 'm-clarify')?.status).toBe('clarifying')
    expect(loaded.missions.find((m) => m.id === 'm-clarify')?.conversationNotes).toEqual([
      'Prepare quarterly report',
    ])
    const draft = loaded.missions.find((m) => m.id === 'm-draft')!
    expect(draft.status).toBe('awaiting_plan_approval')
    expect(draft.conversationNotes).toEqual(['Analyze Q4 metrics', 'Focus on APAC'])
    expect(draft.plan?.revision).toBe(2)
    expect(draft.plan?.steps).toHaveLength(2)
    expect(draft.plan?.steps[1]?.dependsOn).toEqual(['s1'])
  })
})

describe('butler-mission-engine DAG scheduling & concurrency', () => {
  it('runs A and B in parallel, waits for both before starting C, and injects A/B outputs & artifacts', async () => {
    const dir = makeTempDir()
    const statePath = butlerMissionsPath(dir)

    const gateA = deferred<void>()
    const gateB = deferred<void>()
    const startedSessions: string[] = []
    const receivedPrompts = new Map<string, string>()

    let engine!: ReturnType<typeof createButlerMissionEngine>
    engine = createButlerMissionEngine({
      statePath,
      pathExists: async (p) => p.endsWith('artifact-a.md'),
      runPrompt: async (sessionKey, prompt) => {
        startedSessions.push(sessionKey)
        receivedPrompts.set(sessionKey, prompt)

        if (sessionKey === BUTLER_CHIEF_SESSION_KEY) {
          if (prompt.includes('Instructions for Chief Butler')) {
            const missionId = /Mission ID:\s*(mission-\S+)/.exec(prompt)![1]!
            const a = await engine.dispatchTask({
              missionId,
              title: 'Task A',
              brief: 'Produce summary A',
              role: 'research',
            })
            const b = await engine.dispatchTask({
              missionId,
              title: 'Task B',
              brief: 'Produce summary B',
              role: 'sheets',
            })
            await engine.dispatchTask({
              missionId,
              title: 'Task C',
              brief: 'Combine A and B',
              role: 'docs',
              dependsOn: [a.task!.id, b.task!.id],
            })
            return { ok: true, finalText: 'Planned A, B, and C.' }
          }
          return { ok: true, finalText: 'Mission complete.' }
        }

        if (prompt.includes('Title: Task A')) {
          await gateA.promise
          return {
            ok: true,
            finalText: 'Findings from A. Output written to /work/artifact-a.md',
          }
        }
        if (prompt.includes('Title: Task B')) {
          await gateB.promise
          return {
            ok: true,
            finalText: 'Metrics from B. Draft path ./out/missing-b.xlsx',
          }
        }
        return { ok: true, finalText: 'Final combined report C.' }
      },
      abortSession: vi.fn(async () => {}),
    })

    await engine.init()
    const del = await engine.delegate('Prepare quarterly package')
    expect(del.ok).toBe(true)

    await vi.waitFor(() => {
      const tasks = engine.listTasks(del.missionId)
      expect(tasks).toHaveLength(3)
      const byTitle = new Map(tasks.map((t) => [t.title, t]))
      expect(byTitle.get('Task A')?.status).toBe('running')
      expect(byTitle.get('Task B')?.status).toBe('running')
      expect(byTitle.get('Task C')?.status).toBe('queued')
    })

    // Resolve A only; C must still stay queued while B is running.
    gateA.resolve()
    await vi.waitFor(() => {
      const tasks = engine.listTasks(del.missionId)
      const byTitle = new Map(tasks.map((t) => [t.title, t]))
      expect(byTitle.get('Task A')?.status).toBe('done')
      expect(byTitle.get('Task B')?.status).toBe('running')
      expect(byTitle.get('Task C')?.status).toBe('queued')
    })

    gateB.resolve()
    await engine.whenIdle()

    const tasks = engine.listTasks(del.missionId)
    const byTitle = new Map(tasks.map((t) => [t.title, t]))
    expect(byTitle.get('Task C')?.status).toBe('done')

    const cSession = byTitle.get('Task C')!.sessionKey
    const cPrompt = receivedPrompts.get(cSession)!
    expect(cPrompt).toContain('Findings from A')
    expect(cPrompt).toContain('/work/artifact-a.md (existsOnDisk=true)')
    expect(cPrompt).toContain('Metrics from B')
    expect(cPrompt).toContain('./out/missing-b.xlsx (existsOnDisk=false)')

    const snap = engine.getSnapshot()
    expect(snap.missions[0]?.status).toBe('done')
    expect(snap.missions[0]?.report?.artifacts.some((a) => a.path === '/work/artifact-a.md')).toBe(
      true,
    )

    await engine.dispose()
  })

  it('rejects cyclic task dependencies (A -> B -> A and self-loop) without persisting them', async () => {
    const dir = makeTempDir()
    const statePath = butlerMissionsPath(dir)

    // Verify multi-node cycle detection (A -> B -> A and A -> B -> C -> A) via DFS graph helper
    expect(
      hasCycleInDependencyGraph(
        new Map([
          ['task-a', ['task-b']],
          ['task-b', ['task-a']],
        ]),
      ),
    ).toBe(true)
    expect(
      hasCycleInDependencyGraph(
        new Map([
          ['task-a', ['task-b']],
          ['task-b', ['task-c']],
          ['task-c', ['task-a']],
        ]),
      ),
    ).toBe(true)
    expect(
      hasCycleInDependencyGraph(
        new Map([
          ['task-a', []],
          ['task-b', ['task-a']],
          ['task-c', ['task-a', 'task-b']],
        ]),
      ),
    ).toBe(false)

    const engine = createButlerMissionEngine({
      statePath,
      runPrompt: vi.fn(async () => ({ ok: true })),
      abortSession: vi.fn(async () => {}),
    })
    await engine.init()

    const first = await engine.dispatchTask({
      id: 'task-a',
      title: 'Task A',
      brief: 'A',
    })
    expect(first.ok).toBe(true)

    const selfLoopRes = await engine.dispatchTask({
      id: 'task-self',
      missionId: first.task!.missionId,
      title: 'Self',
      brief: 'Self',
      dependsOn: ['task-self'],
    })
    expect(selfLoopRes.ok).toBe(false)
    expect(selfLoopRes.error).toBe('Cyclic task dependency detected')
    expect(engine.listTasks(first.task!.missionId)).toHaveLength(1)

    await engine.whenIdle()
    await engine.dispose()
  })

  it('enforces maxConcurrent slot limit across parallel tasks', async () => {
    const dir = makeTempDir()
    const statePath = butlerMissionsPath(dir)

    let inFlight = 0
    let maxInFlight = 0
    const gates = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()]
    let gateIdx = 0

    const engine = createButlerMissionEngine({
      statePath,
      maxConcurrent: 2,
      runPrompt: async (sessionKey) => {
        if (sessionKey === BUTLER_CHIEF_SESSION_KEY) {
          return { ok: true }
        }
        const myGate = gates[gateIdx++]!
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        try {
          await myGate.promise
          return { ok: true, finalText: 'Worker finished.' }
        } finally {
          inFlight -= 1
        }
      },
      abortSession: vi.fn(async () => {}),
    })

    await engine.init()
    for (let i = 0; i < 4; i += 1) {
      const res = await engine.dispatchTask({
        title: `Worker ${i}`,
        brief: `Work ${i}`,
      })
      expect(res.ok).toBe(true)
    }

    await vi.waitFor(() => {
      const snap = engine.getSnapshot()
      expect(snap.concurrency.maxConcurrent).toBe(2)
      expect(snap.concurrency.running).toBe(2)
      expect(snap.concurrency.queued).toBe(2)
    })

    expect(maxInFlight).toBe(2)
    gates[0]!.resolve()
    gates[1]!.resolve()

    await vi.waitFor(() => {
      expect(gateIdx).toBe(4)
      expect(maxInFlight).toBe(2)
    })

    gates[2]!.resolve()
    gates[3]!.resolve()
    await engine.whenIdle()

    expect(maxInFlight).toBeLessThanOrEqual(2)
    expect(engine.listTasks().every((t) => t.status === 'done')).toBe(true)

    await engine.dispose()
  })

  it('cascades upstream task failure to blocked downstream tasks without deadlocking', async () => {
    const dir = makeTempDir()
    const statePath = butlerMissionsPath(dir)

    const engine = createButlerMissionEngine({
      statePath,
      runPrompt: async (sessionKey, prompt) => {
        if (sessionKey === BUTLER_CHIEF_SESSION_KEY) {
          return { ok: false, error: 'Model unavailable' }
        }
        if (prompt.includes('Title: Task A')) {
          return { ok: false, error: 'Disk full' }
        }
        return { ok: true, finalText: 'Should not run' }
      },
      abortSession: vi.fn(async () => {}),
    })

    await engine.init()
    const a = await engine.dispatchTask({ title: 'Task A', brief: 'Step A' })
    const b = await engine.dispatchTask({
      title: 'Task B',
      brief: 'Step B',
      dependsOn: [a.task!.id],
    })
    const c = await engine.dispatchTask({
      title: 'Task C',
      brief: 'Step C',
      dependsOn: [b.task!.id],
    })

    await engine.whenIdle()

    const tasks = engine.listTasks()
    const map = new Map(tasks.map((t) => [t.id, t]))
    expect(map.get(a.task!.id)?.status).toBe('failed')
    expect(map.get(b.task!.id)?.status).toBe('failed')
    expect(map.get(b.task!.id)?.error).toContain('Upstream task "Task A" ended as failed')
    expect(map.get(c.task!.id)?.status).toBe('failed')
    expect(map.get(c.task!.id)?.error).toContain('Upstream task "Task B" ended as failed')

    const snap = engine.getSnapshot()
    expect(snap.missions[0]?.status).toBe('failed')
    expect(snap.missions[0]?.report).toBeDefined()
    expect(snap.missions[0]?.report?.risks.length).toBeGreaterThan(0)

    await engine.dispose()
  })
})

describe('butler-mission-engine unified HITL gate', () => {
  it('ignores non-worker confirm requests and resolves worker permission & choice gates', async () => {
    const dir = makeTempDir()
    const statePath = butlerMissionsPath(dir)
    const confirmReplies: Array<{ id: string; reply: PiAgentConfirmReply }> = []
    const createdDecisions: ButlerDecisionItem[] = []

    let workerConfirmPromise!: Promise<PiAgentConfirmReply | null>
    let workerChoicePromise!: Promise<{ optionId: string; note?: string; resolvedAt: number }>

    let engine!: ReturnType<typeof createButlerMissionEngine>
    engine = createButlerMissionEngine({
      statePath,
      resolvePermissionConfirm: async (confirmRequestId, reply) => {
        confirmReplies.push({ id: confirmRequestId, reply })
        return true
      },
      onDecisionCreated: (decision) => {
        createdDecisions.push(decision)
      },
      runPrompt: async (sessionKey) => {
        if (sessionKey === BUTLER_CHIEF_SESSION_KEY) {
          return { ok: true, finalText: 'Synthesized.' }
        }
        workerConfirmPromise = engine.interceptWorkerConfirm(
          makeConfirmReq(sessionKey, 'perm-req-1', true),
        )
        const permReply = await workerConfirmPromise
        expect(permReply).toEqual({
          requestId: 'perm-req-1',
          allowed: true,
          alwaysAllowSession: true,
        })

        workerChoicePromise = engine.requestWorkerChoice(sessionKey, {
          title: 'Choose format',
          summary: 'Select export format',
          options: [
            { id: 'pdf', label: 'PDF', style: 'primary' },
            { id: 'docx', label: 'DOCX' },
          ],
        })
        const choice = await workerChoicePromise
        expect(choice.optionId).toBe('docx')
        expect(choice.note).toBe('Include appendix')

        return { ok: true, finalText: 'Worker completed after HITL.' }
      },
      abortSession: vi.fn(async () => {}),
    })

    await engine.init()

    // Non-worker session must return null immediately
    const nonWorker = await engine.interceptWorkerConfirm(
      makeConfirmReq('default:normal-chat-1', 'perm-non-worker'),
    )
    expect(nonWorker).toBeNull()

    const dispatched = await engine.dispatchTask({
      title: 'HITL Worker',
      brief: 'Needs confirm and choice',
    })
    const taskId = dispatched.task!.id

    // Wait for permission decision
    await vi.waitFor(() => {
      expect(createdDecisions).toHaveLength(1)
    })
    const permDec = createdDecisions[0]!
    expect(permDec.kind).toBe('permission')
    expect(permDec.toolName).toBe('write_file')
    expect(permDec.options.map((o) => o.id)).toEqual(['allow', 'allow-session', 'deny'])

    let snap = engine.getSnapshot()
    expect(snap.tasks.find((t) => t.id === taskId)?.status).toBe('waiting_human')
    expect(snap.missions[0]?.status).toBe('waiting_human')

    const resolvePerm = await engine.resolveDecision({
      decisionId: permDec.id,
      optionId: 'allow-session',
    })
    expect(resolvePerm).toEqual({ ok: true })

    // Wait for choice decision
    await vi.waitFor(() => {
      expect(createdDecisions).toHaveLength(2)
    })
    const choiceDec = createdDecisions[1]!
    expect(choiceDec.kind).toBe('choice')

    const resolveChoice = await engine.resolveDecision({
      decisionId: choiceDec.id,
      optionId: 'docx',
      note: 'Include appendix',
    })
    expect(resolveChoice).toEqual({ ok: true })

    await engine.whenIdle()

    expect(confirmReplies).toEqual([
      {
        id: 'perm-req-1',
        reply: { requestId: 'perm-req-1', allowed: true, alwaysAllowSession: true },
      },
    ])
    expect(engine.inspectTask(taskId)?.decisions).toHaveLength(2)
    expect(engine.inspectTask(taskId)?.task.status).toBe('done')

    await engine.dispose()
  })

  it('supports requestChiefDecision during planning and resumes planning cleanly', async () => {
    const dir = makeTempDir()
    const statePath = butlerMissionsPath(dir)
    const createdDecisions: ButlerDecisionItem[] = []

    let engine!: ReturnType<typeof createButlerMissionEngine>
    engine = createButlerMissionEngine({
      statePath,
      onDecisionCreated: (decision) => createdDecisions.push(decision),
      runPrompt: async (sessionKey, prompt) => {
        if (sessionKey === BUTLER_CHIEF_SESSION_KEY && prompt.includes('Goal: Ambiguous goal')) {
          const missionId = /Mission ID:\s*(mission-\S+)/.exec(prompt)![1]!
          const decision = await engine.requestChiefDecision({
            missionId,
            title: 'Scope clarification',
            summary: 'Should we target Q3 or Q4?',
            options: [
              { id: 'q3', label: 'Q3' },
              { id: 'q4', label: 'Q4' },
            ],
          })
          return { ok: true, finalText: `Proceeded with ${decision.optionId}.` }
        }
        return { ok: true }
      },
      abortSession: vi.fn(async () => {}),
    })

    await engine.init()
    const del = await engine.delegate('Ambiguous goal')
    expect(del.ok).toBe(true)

    await vi.waitFor(() => {
      expect(createdDecisions).toHaveLength(1)
    })

    expect(engine.getSnapshot().missions[0]?.status).toBe('waiting_human')

    await engine.resolveDecision({
      decisionId: createdDecisions[0]!.id,
      optionId: 'q4',
    })

    await engine.whenIdle()

    const snap = engine.getSnapshot()
    expect(snap.missions[0]?.status).toBe('done')
    expect(snap.missions[0]?.report?.summary).toContain('Proceeded with q4')

    await engine.dispose()
  })
})

describe('butler-mission-engine report publishing, steering, and cancellation', () => {
  it('validates artifact disk existence in publishReport and falls back deterministically when Chief skips publishReport', async () => {
    const dir = makeTempDir()
    const statePath = butlerMissionsPath(dir)
    const completedEvents: Array<{ mission: ButlerMission; report: ButlerMissionReport }> = []

    let engine!: ReturnType<typeof createButlerMissionEngine>
    engine = createButlerMissionEngine({
      statePath,
      pathExists: async (p) => p === '/real/output/summary.docx',
      onMissionCompleted: (mission, report) => completedEvents.push({ mission, report }),
      runPrompt: async (sessionKey) => {
        if (sessionKey === BUTLER_CHIEF_SESSION_KEY) {
          // Chief returns plain text without calling publishReport -> triggers deterministic fallback
          return { ok: true, finalText: 'Chief summary text' }
        }
        return { ok: true, finalText: 'Done writing /real/output/summary.docx' }
      },
      abortSession: vi.fn(async () => {}),
    })

    await engine.init()

    // Explicit publishReport test with one real path and one missing path
    const del1 = await engine.delegate('Direct publish test')
    await engine.whenIdle()

    const del2 = await engine.delegate('Publish report validation')
    const explicitPub = await engine.publishReport({
      missionId: del2.missionId,
      headline: 'Verified Report',
      summary: 'Checked files on disk',
      artifactPaths: [
        { path: '/real/output/summary.docx', label: 'Summary Doc' },
        { path: '/missing/output/ghost.xlsx', label: 'Missing Sheet' },
      ],
      risks: ['Minor formatting warning'],
      nextSuggestion: 'Review Summary Doc',
    })
    expect(explicitPub.ok).toBe(true)
    expect(explicitPub.report?.artifacts).toEqual([
      { path: '/real/output/summary.docx', label: 'Summary Doc', existsOnDisk: true },
      { path: '/missing/output/ghost.xlsx', label: 'Missing Sheet', existsOnDisk: false },
    ])
    await engine.whenIdle()

    // Deterministic fallback test when worker finishes and Chief omits publishReport
    const dispatched = await engine.dispatchTask({
      title: 'Fallback Worker',
      brief: 'Generate doc',
    })
    await engine.whenIdle()

    const fallbackMission = engine
      .getSnapshot()
      .missions.find((m) => m.taskIds.includes(dispatched.task!.id))!
    expect(fallbackMission.status).toBe('done')
    expect(fallbackMission.report?.summary).toContain('Chief summary text')
    expect(fallbackMission.report?.artifacts).toEqual([
      { path: '/real/output/summary.docx', label: 'summary.docx', existsOnDisk: true },
    ])
    expect(completedEvents.length).toBeGreaterThanOrEqual(2)
    void del1

    await engine.dispose()
  })

  it('steers a running task by aborting, appending instruction, and re-queueing', async () => {
    const dir = makeTempDir()
    const statePath = butlerMissionsPath(dir)
    const firstRunGate = deferred<void>()
    const promptsSeen: string[] = []
    let workerAttempt = 0
    const abortedSessions: string[] = []

    const deps: ButlerMissionEngineDeps = {
      statePath,
      runPrompt: async (sessionKey, prompt) => {
        if (sessionKey === BUTLER_CHIEF_SESSION_KEY) {
          return { ok: true }
        }
        workerAttempt += 1
        promptsSeen.push(prompt)
        if (workerAttempt === 1) {
          await firstRunGate.promise
          return { ok: false, aborted: true }
        }
        return { ok: true, finalText: 'Completed with bar chart.' }
      },
      abortSession: async (sessionKey) => {
        abortedSessions.push(sessionKey)
        firstRunGate.resolve()
      },
    }

    const engine = createButlerMissionEngine(deps)
    await engine.init()

    const dispatched = await engine.dispatchTask({
      title: 'Chart Task',
      brief: 'Create pie chart',
    })
    const taskId = dispatched.task!.id

    await vi.waitFor(() => {
      expect(engine.inspectTask(taskId)?.task.status).toBe('running')
    })

    engine.recordWorkerStep(dispatched.task!.sessionKey, { tool: 'sheets', kind: 'create' }, '50%')
    expect(engine.inspectTask(taskId)?.task.step).toEqual({ tool: 'sheets', kind: 'create' })
    expect(engine.inspectTask(taskId)?.task.progressNote).toBe('50%')

    const steerRes = await engine.steerTask({
      taskId,
      instruction: 'Switch to bar chart instead',
    })
    expect(steerRes).toEqual({ ok: true })

    await engine.whenIdle()

    expect(abortedSessions).toContain(dispatched.task!.sessionKey)
    expect(promptsSeen).toHaveLength(2)
    expect(promptsSeen[1]).toContain('Switch to bar chart instead')
    const finalTask = engine.inspectTask(taskId)!.task
    expect(finalTask.status).toBe('done')
    expect(finalTask.brief).toContain('[Steer] Switch to bar chart instead')

    await engine.dispose()
  })

  it('cancels task and mission cleanly, expiring/cancelling pending decisions without unhandled rejections', async () => {
    const dir = makeTempDir()
    const statePath = butlerMissionsPath(dir)
    const createdDecisions: ButlerDecisionItem[] = []
    const abortedSessions: string[] = []

    let confirmPromise!: Promise<PiAgentConfirmReply | null>
    let choicePromise!: Promise<{ optionId: string; note?: string; resolvedAt: number }>

    let engine!: ReturnType<typeof createButlerMissionEngine>
    engine = createButlerMissionEngine({
      statePath,
      onDecisionCreated: (d) => createdDecisions.push(d),
      runPrompt: async (sessionKey, prompt) => {
        if (sessionKey === BUTLER_CHIEF_SESSION_KEY) return { ok: true }
        if (prompt.includes('Title: Task Confirm')) {
          confirmPromise = engine.interceptWorkerConfirm(
            makeConfirmReq(sessionKey, 'perm-cancel-1', false),
          )
          const reply = await confirmPromise
          return { ok: reply?.allowed === true, finalText: 'after confirm' }
        }
        if (prompt.includes('Title: Task Choice')) {
          choicePromise = engine.requestWorkerChoice(sessionKey, {
            title: 'Pick one',
            summary: 'Waiting before mission cancel',
            options: [{ id: 'a', label: 'A' }],
          })
          await choicePromise
          return { ok: false, aborted: true }
        }
        return { ok: true }
      },
      abortSession: async (sessionKey) => {
        abortedSessions.push(sessionKey)
      },
    })

    await engine.init()

    // 1. cancelTask while waiting_human
    const t1 = await engine.dispatchTask({ title: 'Task Confirm', brief: 'Wait confirm' })
    await engine.dispatchTask({
      title: 'Downstream Task',
      brief: 'Depends on Task Confirm',
      dependsOn: [t1.task!.id],
    })

    await vi.waitFor(() => {
      expect(createdDecisions).toHaveLength(1)
    })
    expect(createdDecisions[0]!.options.map((o) => o.id)).toEqual(['allow', 'deny'])

    const cancelTaskRes = await engine.cancelTask(t1.task!.id)
    expect(cancelTaskRes).toEqual({ ok: true })

    await expect(confirmPromise).resolves.toEqual({
      requestId: 'perm-cancel-1',
      allowed: false,
    })

    await engine.whenIdle()
    expect(engine.inspectTask(t1.task!.id)?.task.status).toBe('cancelled')
    expect(engine.inspectTask(t1.task!.id)?.decisions[0]?.status).toBe('cancelled')
    expect(abortedSessions).toContain(t1.task!.sessionKey)

    // 2. cancelMission while waiting_human on choice gate
    const t2 = await engine.dispatchTask({ title: 'Task Choice', brief: 'Wait choice' })
    const missionId2 = t2.task!.missionId

    await vi.waitFor(() => {
      expect(createdDecisions).toHaveLength(2)
    })

    const cancelMissionRes = await engine.cancelMission(missionId2)
    expect(cancelMissionRes).toEqual({ ok: true })

    const resolvedChoice = await choicePromise
    expect(resolvedChoice.optionId).toBe('cancelled')

    await engine.whenIdle()

    const snap = engine.getSnapshot()
    const mission2 = snap.missions.find((m) => m.id === missionId2)!
    expect(mission2.status).toBe('cancelled')
    expect(snap.decisions.find((d) => d.id === createdDecisions[1]!.id)?.status).toBe('cancelled')

    await engine.dispose()
    // Idempotent second dispose
    await engine.dispose()
  })

  it('invokes onMissionAccepted and onMissionPlanned lifecycle hooks with dispatched subtasks', async () => {
    const dir = makeTempDir()
    const statePath = butlerMissionsPath(dir)
    const acceptedIds: string[] = []
    const plannedEvents: Array<{
      missionId: string
      taskCount: number
      chiefReplyText?: string
    }> = []

    let engine!: ReturnType<typeof createButlerMissionEngine>
    engine = createButlerMissionEngine({
      statePath,
      onMissionAccepted: (mission) => acceptedIds.push(mission.id),
      onMissionPlanned: (mission, missionTasks, chiefReplyText) =>
        plannedEvents.push({
          missionId: mission.id,
          taskCount: missionTasks.length,
          chiefReplyText,
        }),
      runPrompt: async (sessionKey) => {
        if (sessionKey === BUTLER_CHIEF_SESSION_KEY) {
          const snap = engine.getSnapshot()
          const planningMission = snap.missions.find((m) => m.status === 'planning')
          if (planningMission) {
            await engine.dispatchTask({
              missionId: planningMission.id,
              title: 'Draft brief',
              brief: 'Write summary',
              role: 'docs',
            })
            return { ok: true, finalText: '已调派文档专家为您起草简报。' }
          }
          return { ok: true, finalText: '简报已完成。' }
        }
        return { ok: true, finalText: 'Done.' }
      },
      abortSession: vi.fn(async () => {}),
    })

    await engine.init()
    const res = await engine.delegate('帮我起草项目简报')
    expect(res.ok).toBe(true)
    expect(acceptedIds).toEqual([res.missionId])

    await engine.whenIdle()

    expect(plannedEvents).toEqual([
      {
        missionId: res.missionId,
        taskCount: 1,
        chiefReplyText: '已调派文档专家为您起草简报。',
      },
    ])

    await engine.dispose()
  })
})

describe('butler-mission-engine two-stage alignment & plan approval gate', () => {
  it('supports multi-turn clarification, plan proposal, revision, and verbal approval with DAG remapping', async () => {
    const dir = makeTempDir()
    const statePath = butlerMissionsPath(dir)
    const clarifications: string[] = []
    const proposedPlans: Array<{ missionId: string; revision: number; reply?: string }> = []
    const chiefPrompts: string[] = []
    const workerOrder: string[] = []

    let chiefTurn = 0
    let engine!: ReturnType<typeof createButlerMissionEngine>
    engine = createButlerMissionEngine({
      statePath,
      requirePlanApproval: () => true,
      onClarificationAsked: (_m, text) => clarifications.push(text),
      onPlanProposed: (m, plan, reply) =>
        proposedPlans.push({ missionId: m.id, revision: plan.revision, reply }),
      runPrompt: async (sessionKey, prompt) => {
        if (sessionKey === BUTLER_CHIEF_SESSION_KEY) {
          if (prompt.includes('Subtask Outcomes:')) {
            return { ok: true, finalText: '报告已完成并全部汇总。' }
          }
          chiefPrompts.push(prompt)
          chiefTurn += 1
          const missionId = /Mission ID:\s*(mission-\S+)/.exec(prompt)![1]!

          if (chiefTurn === 1) {
            return {
              ok: true,
              finalText: '请问您希望这份季度总结面向管理层还是技术团队，需要包含图表吗？',
            }
          }
          if (chiefTurn === 2) {
            await engine.proposePlan({
              missionId,
              summary: '先整理财务数据，再生成中文汇报文档',
              steps: [
                {
                  id: 'collect',
                  title: '整理财务数据',
                  brief: '统计 Q4 营收与成本。',
                  role: 'sheets',
                },
                {
                  id: 'write',
                  title: '撰写中文汇报',
                  brief: '编写管理层中文汇报。',
                  role: 'docs',
                  dependsOn: ['collect'],
                },
              ],
            })
            return { ok: true, finalText: '我已拟好两步计划，请确认是否按此执行。' }
          }
          if (chiefTurn === 3) {
            await engine.proposePlan({
              missionId,
              summary: '先整理财务数据，再生成英文管理层汇报文档',
              steps: [
                {
                  id: 'collect',
                  title: '整理财务数据',
                  brief: '统计 Q4 营收与成本。',
                  role: 'sheets',
                },
                {
                  id: 'write',
                  title: 'Write English executive report',
                  brief: 'Draft English executive summary.',
                  role: 'docs',
                  dependsOn: ['collect'],
                },
              ],
            })
            return { ok: true, finalText: '已将第 2 步更新为英文报告，确认无误就开始执行。' }
          }
          return { ok: true }
        }

        const title = /Title:\s*(.+)/.exec(prompt)?.[1]?.trim() ?? ''
        workerOrder.push(title)
        return { ok: true, finalText: `Finished ${title}` }
      },
      abortSession: vi.fn(async () => {}),
    })

    await engine.init()

    // Turn 1: Ambiguous request enters 'clarifying'.
    const d1 = await engine.delegate('帮我准备季度汇报')
    expect(d1.ok).toBe(true)
    const missionId = d1.missionId!
    await engine.whenIdle()

    expect(clarifications).toEqual([
      '请问您希望这份季度总结面向管理层还是技术团队，需要包含图表吗？',
    ])
    expect(engine.getSnapshot().missions.find((m) => m.id === missionId)?.status).toBe('clarifying')
    expect(engine.getSnapshot().tasks).toHaveLength(0)

    // Turn 2: Clarification reply reuses SAME missionId and proposes draft v1.
    const d2 = await engine.delegate('面向管理层，不需要图表')
    expect(d2).toEqual({ ok: true, missionId })
    await engine.whenIdle()

    expect(chiefPrompts[1]).toContain('1. User: 帮我准备季度汇报')
    expect(chiefPrompts[1]).toContain('2. User: 面向管理层，不需要图表')
    expect(proposedPlans).toHaveLength(1)
    expect(proposedPlans[0]).toMatchObject({ missionId, revision: 1 })
    expect(engine.getSnapshot().missions.find((m) => m.id === missionId)?.status).toBe(
      'awaiting_plan_approval',
    )
    expect(engine.getSnapshot().tasks).toHaveLength(0)

    // Turn 3: Revision reply updates draft to v2 without dispatching workers.
    const d3 = await engine.delegate('不过把第2步改成英文报告')
    expect(d3).toEqual({ ok: true, missionId })
    await engine.whenIdle()

    expect(chiefPrompts[2]).toContain('Current Draft Plan (revision 1')
    expect(chiefPrompts[2]).toContain('3. User: 不过把第2步改成英文报告')
    expect(proposedPlans).toHaveLength(2)
    expect(proposedPlans[1]).toMatchObject({ missionId, revision: 2 })
    expect(engine.getSnapshot().tasks).toHaveLength(0)

    // Turn 4: Verbal approval dispatches DAG tasks with remapped dependencies and runs to done.
    const d4 = await engine.delegate('好，按这个办')
    expect(d4).toEqual({ ok: true, missionId })
    await engine.whenIdle()

    expect(chiefPrompts).toHaveLength(3)
    expect(workerOrder).toEqual(['整理财务数据', 'Write English executive report'])
    const finalSnap = engine.getSnapshot()
    const finalMission = finalSnap.missions.find((m) => m.id === missionId)!
    expect(finalMission.status).toBe('done')
    expect(finalMission.plan?.approvedAt).toBeTypeOf('number')
    expect(finalMission.taskIds).toHaveLength(2)
    expect(finalSnap.tasks[1]!.dependsOn).toEqual([finalSnap.tasks[0]!.id])

    await engine.dispose()
  })

  it('enforces Critic hard gate on unapproved dispatchTask and executes cleanly via UI approveMissionPlan', async () => {
    const dir = makeTempDir()
    const statePath = butlerMissionsPath(dir)
    const proposedRevisions: number[] = []
    let workerStarted = false

    let engine!: ReturnType<typeof createButlerMissionEngine>
    engine = createButlerMissionEngine({
      statePath,
      requirePlanApproval: () => true,
      onPlanProposed: (_m, plan) => proposedRevisions.push(plan.revision),
      runPrompt: async (sessionKey, prompt) => {
        if (sessionKey === BUTLER_CHIEF_SESSION_KEY) {
          if (prompt.includes('Subtask Outcomes:')) {
            return { ok: true, finalText: 'All approved tasks finished.' }
          }
          const missionId = /Mission ID:\s*(mission-\S+)/.exec(prompt)![1]!
          // Chief attempts to bypass butler_propose_plan by calling dispatchTask directly.
          const r1 = await engine.dispatchTask({
            missionId,
            id: 'raw-1',
            title: 'Research logs',
            brief: 'Scan error logs',
            role: 'research',
          })
          expect(r1).toMatchObject({ ok: true, stagedForApproval: true })
          const r2 = await engine.dispatchTask({
            missionId,
            id: 'raw-2',
            title: 'Draft report',
            brief: 'Summarize findings',
            role: 'docs',
            dependsOn: ['raw-1'],
          })
          expect(r2).toMatchObject({ ok: true, stagedForApproval: true })
          return { ok: true, finalText: 'Drafted 2 steps awaiting your approval.' }
        }
        workerStarted = true
        return { ok: true, finalText: 'Worker completed' }
      },
      abortSession: vi.fn(async () => {}),
    })

    await engine.init()
    const delegated = await engine.delegate('Investigate recent errors and write a report')
    const missionId = delegated.missionId!
    await engine.whenIdle()

    expect(workerStarted).toBe(false)
    expect(proposedRevisions).toEqual([2])
    const awaitingSnap = engine.getSnapshot()
    expect(awaitingSnap.tasks).toHaveLength(0)
    const stagedMission = awaitingSnap.missions.find((m) => m.id === missionId)!
    expect(stagedMission.status).toBe('awaiting_plan_approval')
    expect(stagedMission.plan?.steps.map((s) => s.id)).toEqual(['raw-1', 'raw-2'])
    expect(stagedMission.plan?.steps[1]?.dependsOn).toEqual(['raw-1'])

    // Approve via UI action and verify idempotent second call.
    const approveRes = await engine.approveMissionPlan({ missionId, comment: 'Approved from Desk' })
    expect(approveRes).toEqual({ ok: true })
    await expect(engine.approveMissionPlan({ missionId })).resolves.toEqual({ ok: true })

    await engine.whenIdle()
    expect(workerStarted).toBe(true)
    const doneSnap = engine.getSnapshot()
    const doneMission = doneSnap.missions.find((m) => m.id === missionId)!
    expect(doneMission.status).toBe('done')
    expect(doneSnap.tasks).toHaveLength(2)
    expect(doneSnap.tasks[1]!.dependsOn).toEqual([doneSnap.tasks[0]!.id])

    await engine.dispose()
  })

  it('completes simple single-turn greetings directly as done without triggering plan approval gate', async () => {
    const dir = makeTempDir()
    const statePath = butlerMissionsPath(dir)
    const completedReports: ButlerMissionReport[] = []
    const clarifications: string[] = []
    const proposals: number[] = []

    const engine = createButlerMissionEngine({
      statePath,
      requirePlanApproval: () => true,
      onClarificationAsked: (_m, text) => clarifications.push(text),
      onPlanProposed: (_m, plan) => proposals.push(plan.revision),
      onMissionCompleted: (_m, report) => completedReports.push(report),
      runPrompt: async () => ({
        ok: true,
        finalText: '您好，先生，随时准备为您效劳。',
      }),
      abortSession: vi.fn(async () => {}),
    })

    await engine.init()
    const res = await engine.delegate('你好')
    expect(res.ok).toBe(true)
    await engine.whenIdle()

    expect(clarifications).toEqual([])
    expect(proposals).toEqual([])
    expect(completedReports).toHaveLength(1)
    expect(completedReports[0]!.summary).toBe('您好，先生，随时准备为您效劳。')
    expect(engine.getSnapshot().missions[0]!.status).toBe('done')

    await engine.dispose()
  })

  it('rejects cyclic plan dependencies in proposePlan and supports verbal cancellation', async () => {
    const dir = makeTempDir()
    const statePath = butlerMissionsPath(dir)

    let engine!: ReturnType<typeof createButlerMissionEngine>
    engine = createButlerMissionEngine({
      statePath,
      requirePlanApproval: () => true,
      runPrompt: async (_sk, prompt) => {
        const missionId = /Mission ID:\s*(mission-\S+)/.exec(prompt)![1]!
        const badPlan = await engine.proposePlan({
          missionId,
          summary: 'Cyclic test',
          steps: [
            { id: 'a', title: 'A', brief: 'A', dependsOn: ['b'] },
            { id: 'b', title: 'B', brief: 'B', dependsOn: ['a'] },
          ],
        })
        expect(badPlan.ok).toBe(false)
        expect(badPlan.error).toMatch(/Cyclic/)

        await engine.proposePlan({
          missionId,
          summary: 'Valid plan',
          steps: [{ id: 'a', title: 'A', brief: 'A' }],
        })
        return { ok: true, finalText: 'Ready for review.' }
      },
      abortSession: vi.fn(async () => {}),
    })

    await engine.init()
    const first = await engine.delegate('Run something')
    await engine.whenIdle()
    expect(engine.getSnapshot().missions[0]!.status).toBe('awaiting_plan_approval')

    const cancelled = await engine.delegate('取消任务吧')
    expect(cancelled).toEqual({ ok: true, missionId: first.missionId })
    expect(engine.getSnapshot().missions[0]!.status).toBe('cancelled')

    await engine.dispose()
  })

  it('keeps pure chat decoupled in conversationalMode with <butler_live_state> under 800 chars', async () => {
    const dir = makeTempDir()
    const statePath = butlerMissionsPath(dir)

    const capturedPrompts: string[] = []
    const accepted: string[] = []
    const completed: string[] = []
    const clarifications: string[] = []
    const convReplies: string[] = []

    const engine = createButlerMissionEngine({
      statePath,
      conversationalMode: () => true,
      requirePlanApproval: () => true,
      runPrompt: async (_sk, prompt) => {
        capturedPrompts.push(prompt)
        return { ok: true, finalText: 'Doing well, sir. Need anything opened today?' }
      },
      abortSession: vi.fn(async () => {}),
      onMissionAccepted: (m) => accepted.push(m.id),
      onMissionCompleted: (m) => completed.push(m.id),
      onClarificationAsked: (_m, text) => clarifications.push(text),
      onConversationalReply: (replyText) => convReplies.push(replyText),
    })

    await engine.init()
    const res = await engine.delegate('How are you doing today?')
    expect(res).toEqual({ ok: true })
    await engine.whenIdle()

    expect(accepted).toEqual([])
    expect(completed).toEqual([])
    expect(clarifications).toEqual([])
    expect(convReplies).toEqual(['Doing well, sir. Need anything opened today?'])

    const snap = engine.getSnapshot()
    expect(snap.missions).toEqual([])
    expect(snap.feed.map((f) => f.role)).toEqual(['user', 'butler'])

    expect(capturedPrompts).toHaveLength(1)
    const stateMatch = /<butler_live_state>[\s\S]*?<\/butler_live_state>/.exec(capturedPrompts[0]!)
    expect(stateMatch).not.toBeNull()
    expect(stateMatch![0]!.length).toBeLessThan(800)

    await engine.dispose()
  })

  it('preempts an active conversational Chief turn without aborting running background workers', async () => {
    const dir = makeTempDir()
    const statePath = butlerMissionsPath(dir)

    const workerStarted = deferred<void>()
    const releaseWorker = deferred<void>()
    const turn1Idle = deferred<void>()
    const turnAStarted = deferred<void>()
    const releaseTurnA = deferred<void>()
    const abortCalls: string[] = []
    const convReplies: string[] = []
    const completedReports: ButlerMissionReport[] = []

    let sawTurn1Busy = false
    let chiefCallCount = 0
    let engine!: ReturnType<typeof createButlerMissionEngine>
    engine = createButlerMissionEngine({
      statePath,
      conversationalMode: () => true,
      runPrompt: async (sessionKey) => {
        if (sessionKey === BUTLER_CHIEF_SESSION_KEY) {
          chiefCallCount += 1
          if (chiefCallCount === 1) {
            await engine.dispatchTask({
              title: 'Background job',
              brief: 'Work quietly',
              role: 'general',
            })
            return { ok: true, finalText: 'Dispatched the worker.' }
          }
          if (chiefCallCount === 2) {
            turnAStarted.resolve()
            await releaseTurnA.promise
            return { ok: false, aborted: true, error: 'Aborted' }
          }
          if (chiefCallCount === 3) {
            return { ok: true, finalText: 'Handled your latest message.' }
          }
          return { ok: true, finalText: 'Worker finished cleanly.' }
        }
        workerStarted.resolve()
        await releaseWorker.promise
        return { ok: true, finalText: 'Worker output.' }
      },
      abortSession: vi.fn(async (sk) => {
        abortCalls.push(sk)
        if (sk === BUTLER_CHIEF_SESSION_KEY) {
          releaseTurnA.resolve()
        }
      }),
      onSnapshotUpdated: (snap) => {
        if (snap.chiefBusy && chiefCallCount === 1) {
          sawTurn1Busy = true
        } else if (sawTurn1Busy && !snap.chiefBusy && chiefCallCount === 1) {
          turn1Idle.resolve()
        }
      },
      onConversationalReply: (text) => convReplies.push(text),
      onMissionCompleted: (_m, report) => completedReports.push(report),
    })

    await engine.init()
    await engine.delegate('Start a background job')
    await workerStarted.promise
    await turn1Idle.promise

    // Turn A blocks in Chief prompt; immediately preempt with Turn B.
    const turnAPromise = engine.delegate('First question A')
    await turnAStarted.promise
    await turnAPromise

    await engine.delegate('Actually handle B instead')
    releaseWorker.resolve()
    await engine.whenIdle()

    expect(abortCalls).toEqual([BUTLER_CHIEF_SESSION_KEY])
    expect(convReplies).toEqual(['Handled your latest message.'])
    expect(completedReports).toHaveLength(1)
    expect(engine.getSnapshot().missions[0]!.status).toBe('done')

    await engine.dispose()
  })

  it('supports full voice CRUD lifecycle: auto proposePlan, updateMissionDetails, approve latest, retryTask, listMissions, cancel latest, deleteMission, and executeDesktopAction', async () => {
    const dir = makeTempDir()
    const statePath = butlerMissionsPath(dir)

    const desktopCalls: Array<{
      target: string
      pathOrUrl?: string
      query?: string
      mediaCommand?: string
    }> = []
    const planProposals: Array<{ missionId: string; revision: number; reply?: string }> = []
    const missionPlannedEvents: Array<{ missionId: string; count: number; reply?: string }> = []
    const convReplies: string[] = []

    let failFirstWorkerRun = true
    let turnIndex = 0
    let engine!: ReturnType<typeof createButlerMissionEngine>
    engine = createButlerMissionEngine({
      statePath,
      conversationalMode: () => true,
      requirePlanApproval: () => true,
      executeDesktopAction: async (req) => {
        desktopCalls.push(req)
        return { ok: true }
      },
      runPrompt: async (sessionKey) => {
        if (sessionKey === BUTLER_CHIEF_SESSION_KEY) {
          turnIndex += 1
          if (turnIndex === 1) {
            const proposed = await engine.proposePlan({
              title: 'Draft Report Plan',
              summary: 'Research numbers first.',
              steps: [{ id: 's1', title: 'Fetch totals', brief: 'Read sheet', role: 'research' }],
            })
            expect(proposed.ok).toBe(true)
            expect(proposed.mission?.id).toMatch(/^mission-/)
            return { ok: true, finalText: 'I drafted a 1-step plan. Ready to start?' }
          }
          if (turnIndex === 2) {
            const approved = await engine.approveMissionPlan({ missionId: 'latest' })
            expect(approved.ok).toBe(true)
            return { ok: true, finalText: 'Starting the research specialist now.' }
          }
          return { ok: true, finalText: 'Synthesis summary complete.' }
        }
        if (failFirstWorkerRun) {
          failFirstWorkerRun = false
          return { ok: false, error: 'Temporary timeout' }
        }
        return { ok: true, finalText: 'Fetched totals successfully.' }
      },
      abortSession: vi.fn(async () => {}),
      onPlanProposed: (m, p, reply) =>
        planProposals.push({ missionId: m.id, revision: p.revision, reply }),
      onMissionPlanned: (m, tList, reply) =>
        missionPlannedEvents.push({ missionId: m.id, count: tList.length, reply }),
      onConversationalReply: (reply) => convReplies.push(reply),
    })

    await engine.init()

    // 1. Propose plan without missionId creates mission automatically
    await engine.delegate('Prepare sales totals')
    await engine.whenIdle()
    expect(planProposals).toHaveLength(1)
    const missionId = planProposals[0]!.missionId
    expect(planProposals[0]!.revision).toBe(1)
    expect(convReplies).toEqual([])

    // 2. Update draft mission title & summary via updateMissionDetails
    const updRes = await engine.updateMissionDetails({
      missionId: 'latest',
      title: 'Q4 Sales Audit',
      summary: 'Updated audit summary.',
    })
    expect(updRes.ok).toBe(true)
    expect(updRes.mission?.title).toBe('Q4 Sales Audit')
    expect(updRes.mission?.plan?.revision).toBe(2)

    // 3. Approve plan via 'latest' during conversational turn -> deferred single onMissionPlanned with reply
    await engine.delegate('Yes start it')
    await engine.whenIdle()
    expect(missionPlannedEvents).toEqual([
      { missionId, count: 1, reply: 'Starting the research specialist now.' },
    ])
    expect(convReplies).toEqual([])

    // First worker attempt failed -> mission failed
    expect(engine.listMissions('failed')).toHaveLength(1)
    const failedTask = engine.listTasks(missionId)[0]!
    expect(failedTask.status).toBe('failed')

    // 4. Retry failed task with refined instruction -> mission completes
    const retryRes = await engine.retryTask({
      taskId: failedTask.id,
      instruction: 'Use backup sheet',
    })
    expect(retryRes).toEqual({ ok: true })
    await engine.whenIdle()
    expect(engine.listMissions('done')).toHaveLength(1)
    expect(engine.listMissions('failed')).toHaveLength(0)

    // 5. Desktop action validation & dispatch
    expect(await engine.executeDesktopAction({ target: 'file' })).toEqual({
      ok: false,
      error: 'pathOrUrl is required when target is "file"',
    })
    expect(await engine.executeDesktopAction({ target: 'media-player' })).toEqual({ ok: true })
    expect(
      await engine.executeDesktopAction({
        target: 'media-player',
        query: '起风了',
        mediaCommand: 'play',
      }),
    ).toEqual({ ok: true })
    expect(desktopCalls).toEqual([
      { target: 'media-player' },
      { target: 'media-player', query: '起风了', mediaCommand: 'play' },
    ])

    // 6. Create another draft mission, test cancelMission('latest'), then deleteMission
    await engine.proposePlan({
      summary: 'Another plan',
      steps: [{ title: 'Step A', brief: 'Do A' }],
    })
    expect(engine.listMissions('active')).toHaveLength(1)
    expect(await engine.cancelMission('latest')).toEqual({ ok: true })
    expect(engine.listMissions('cancelled')).toHaveLength(1)

    expect(await engine.deleteMission(missionId)).toEqual({ ok: true })
    expect(engine.listMissions('all')).toHaveLength(1)
    expect(engine.listTasks(missionId)).toEqual([])

    await engine.dispose()
  })
})
