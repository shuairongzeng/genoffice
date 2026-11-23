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
})
