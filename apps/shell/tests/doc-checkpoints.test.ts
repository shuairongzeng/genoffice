import { describe, expect, it } from 'vitest'
import {
  checkpointsToRollback,
  collectDocCheckpoints,
  type CheckpointMessageLike,
  type DocCheckpoint,
} from '../src/renderer/src/doc-checkpoints'

const cp = (
  checkpointId: string,
  tabId = 'tab-1',
  extra: Partial<DocCheckpoint> = {},
): DocCheckpoint => ({
  tabId,
  kind: 'markdown',
  title: 'notes.py',
  checkpointId,
  editCount: 1,
  ...extra,
})

describe('collectDocCheckpoints', () => {
  it('assigns ascending step numbers, reverses order, and tracks per-tab later active edits', () => {
    const messages: CheckpointMessageLike[] = [
      { docCheckpoints: [cp('cp-1', 'tab-a'), cp('cp-2', 'tab-b')] },
      { docCheckpoints: [cp('cp-3', 'tab-a', { reverted: true })] },
      { docCheckpoints: [cp('cp-4', 'tab-a')] },
    ]

    const timeline = collectDocCheckpoints(messages)
    expect(timeline.map((e) => e.checkpoint.checkpointId)).toEqual(['cp-4', 'cp-3', 'cp-2', 'cp-1'])
    expect(timeline.map((e) => e.stepNumber)).toEqual([4, 3, 2, 1])

    const byId = new Map(timeline.map((e) => [e.checkpoint.checkpointId, e]))
    expect(byId.get('cp-4')?.laterActiveCount).toBe(0)
    expect(byId.get('cp-3')?.laterActiveCount).toBe(1)
    expect(byId.get('cp-2')?.laterActiveCount).toBe(0)
    // cp-3 is reverted, so only cp-4 counts as later active for tab-a
    expect(byId.get('cp-1')?.laterActiveCount).toBe(1)
  })
})

describe('checkpointsToRollback', () => {
  it('returns reverse-chronological active checkpoints for the target tab only', () => {
    const messages: CheckpointMessageLike[] = [
      { docCheckpoints: [cp('cp-1', 'tab-a'), cp('cp-2', 'tab-b')] },
      { docCheckpoints: [cp('cp-3', 'tab-a', { reverted: true })] },
      { docCheckpoints: [cp('cp-4', 'tab-a')] },
      { docCheckpoints: [cp('cp-5', 'tab-a')] },
    ]

    expect(checkpointsToRollback(messages, 'cp-1').map((c) => c.checkpointId)).toEqual([
      'cp-5',
      'cp-4',
      'cp-1',
    ])
    expect(checkpointsToRollback(messages, 'cp-5').map((c) => c.checkpointId)).toEqual(['cp-5'])
    expect(checkpointsToRollback(messages, 'cp-2').map((c) => c.checkpointId)).toEqual(['cp-2'])
  })

  it('returns empty for unknown, reverted, or in-flight checkpoints', () => {
    const messages: CheckpointMessageLike[] = [
      {
        docCheckpoints: [
          cp('cp-done', 'tab-a', { reverted: true }),
          cp('cp-busy', 'tab-a', { reverting: true }),
        ],
      },
    ]

    expect(checkpointsToRollback(messages, 'missing')).toEqual([])
    expect(checkpointsToRollback(messages, 'cp-done')).toEqual([])
    expect(checkpointsToRollback(messages, 'cp-busy')).toEqual([])
  })
})
