import { describe, expect, it } from 'vitest'
import {
  appendReasoningStep,
  appendTextStep,
  deriveCombinedText,
  formatThinkingDuration,
  hydrateTimelineSteps,
  recordToolFinishedStep,
  recordToolStartStep,
  resolveTimelineSteps,
  sealStreamingSteps,
  thinkingPreviewLine,
  type AskTimelineStep,
} from '../src/renderer/src/ask-timeline'
import type { AskToolActivity } from '../src/renderer/src/ask-activity'

describe('ask-timeline reducer', () => {
  it('builds interleaved ReAct steps across multiple thinking, tool, and text rounds', () => {
    let steps: AskTimelineStep[] = []

    steps = appendReasoningStep(steps, 'Need to search first', 1000)
    steps = appendReasoningStep(steps, ' before editing.', 1200)
    expect(steps).toEqual([
      {
        kind: 'thinking',
        id: 'think-0',
        text: 'Need to search first before editing.',
        streaming: true,
        startedAt: 1000,
      },
    ])

    steps = appendTextStep(steps, 'Let me check the notes.', 1500)
    expect(steps[0]).toMatchObject({ kind: 'thinking', streaming: false, endedAt: 1500 })
    expect(steps[1]).toMatchObject({ kind: 'text', text: 'Let me check the notes.', streaming: true })

    steps = recordToolStartStep(steps, 'call-1', 2000)
    expect(steps[1]).toMatchObject({ kind: 'text', streaming: false })
    expect(steps[2]).toEqual({ kind: 'tool', id: 'tool-call-1', activityId: 'call-1' })

    steps = recordToolFinishedStep(steps, 'call-1', 2600)
    expect(steps).toHaveLength(3)

    // Leading breaks injected between turns must not leave empty leading newlines in new blocks.
    steps = appendReasoningStep(steps, '\n\nNow I have context; read file next.', 3000)
    expect(steps).toHaveLength(4)
    expect(steps[3]).toEqual({
      kind: 'thinking',
      id: 'think-3',
      text: 'Now I have context; read file next.',
      streaming: true,
      startedAt: 3000,
    })

    steps = recordToolStartStep(steps, 'call-2', 4200)
    steps = recordToolStartStep(steps, 'call-3', 4250)
    expect(steps.map((s) => s.kind)).toEqual(['thinking', 'text', 'tool', 'thinking', 'tool', 'tool'])

    steps = appendTextStep(steps, 'Here is the final answer.', 5000)
    steps = sealStreamingSteps(steps, 5200)
    expect(steps.map((s) => s.kind)).toEqual([
      'thinking',
      'text',
      'tool',
      'thinking',
      'tool',
      'tool',
      'text',
    ])
    expect(steps.every((s) => s.kind === 'tool' || s.streaming === false)).toBe(true)
    expect(deriveCombinedText(steps)).toBe('Let me check the notes.\n\nHere is the final answer.')
  })

  it('seals open thinking step even when tool-executed arrives without prior tool-start', () => {
    let steps = appendReasoningStep([], 'Attempting write.', 100)
    steps = recordToolFinishedStep(steps, 'denied-call', 1500)
    expect(steps).toEqual([
      {
        kind: 'thinking',
        id: 'think-0',
        text: 'Attempting write.',
        streaming: false,
        startedAt: 100,
        endedAt: 1500,
      },
      { kind: 'tool', id: 'tool-denied-call', activityId: 'denied-call' },
    ])
  })

  it('overwrites an open text step in place for corrective text-only retries', () => {
    let steps = appendReasoningStep([], 'Draft response', 100)
    steps = appendTextStep(steps, 'Rejected draft', 200)
    steps = appendTextStep(steps, 'Verified response', 300)
    expect(steps).toHaveLength(2)
    expect(steps[1]).toEqual({
      kind: 'text',
      id: 'text-1',
      text: 'Verified response',
      streaming: true,
    })
  })

  it('hydrates legacy flat snapshots cleanly for mirror compatibility', () => {
    const legacyActivity: AskToolActivity = {
      id: 'legacy-1',
      name: 'search_knowledge_base',
      call: { id: 'legacy-1', name: 'search_knowledge_base', input: { query: 'hi' } },
      status: 'running',
      inputPreview: '{}',
    }
    const resolved = resolveTimelineSteps({
      reasoning: 'Legacy thought',
      activities: [legacyActivity],
      text: '',
      streaming: true,
    })
    expect(resolved).toEqual([
      { kind: 'thinking', id: 'think-0', text: 'Legacy thought', streaming: false },
      { kind: 'tool', id: 'tool-legacy-1', activityId: 'legacy-1' },
    ])

    const continued = appendReasoningStep(hydrateTimelineSteps({ reasoning: 'Turn A', streaming: false }), 'Turn B', 500)
    expect(continued).toEqual([
      { kind: 'thinking', id: 'think-0', text: 'Turn A', streaming: false },
      { kind: 'thinking', id: 'think-1', text: 'Turn B', streaming: true, startedAt: 500 },
    ])
  })

  it('formats thinking previews and elapsed durations cleanly', () => {
    expect(thinkingPreviewLine('\n\n   First   non-empty line  \nSecond line', 25)).toBe(
      'First non-empty line',
    )
    expect(thinkingPreviewLine('A very long reasoning opening sentence that exceeds budget', 18)).toBe(
      'A very long reaso…',
    )
    expect(formatThinkingDuration(1000, 1800)).toBeNull()
    expect(formatThinkingDuration(1000, 2340)).toBe('1.3s')
    expect(formatThinkingDuration(0, 65_000)).toBe('1m 5s')
  })
})
