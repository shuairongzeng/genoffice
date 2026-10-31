import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { ChatMessage, ChatMeta, ProjectApi } from '@genoffice/project-store'

import {
  boundAskTranscript,
  claimThread,
  firstQuestionOf,
  listThreads,
  MAX_ASK_ENTRIES,
  panelThreads,
  restoreAskMessages,
  type AskMessage,
} from '../src/renderer/src/KbAskPanel'

function stored(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    projectId: 'default',
    chatId: 'kb-ask',
    role: 'user',
    text: 'who is in the photograph',
    ts: '2026-10-16T09:00:00.000Z',
    seq: 0,
    ...over,
  }
}

describe('restoring a stored knowledge-base thread', () => {
  it('keeps the turns in order with their role and text', () => {
    const restored = restoreAskMessages([
      stored({ role: 'user', text: 'first question', seq: 0 }),
      stored({ role: 'assistant', text: 'first answer', seq: 1 }),
      stored({ role: 'user', text: 'second question', seq: 2 }),
    ])
    expect(restored).toEqual([
      { role: 'user', text: 'first question', toolNotes: [], artifacts: [] },
      { role: 'assistant', text: 'first answer', toolNotes: [], artifacts: [] },
      { role: 'user', text: 'second question', toolNotes: [], artifacts: [] },
    ])
  })

  it('drops a role the panel cannot render', () => {
    // The store types role as user|assistant, but the JSONL on disk is not
    // ours to trust: an unreadable turn is skipped, not shown as a blank one.
    const restored = restoreAskMessages([
      stored({ role: 'user', text: 'kept', seq: 0 }),
      stored({ role: 'system', text: 'dropped', seq: 1 } as Partial<ChatMessage>),
    ])
    expect(restored).toEqual([{ role: 'user', text: 'kept', toolNotes: [], artifacts: [] }])
  })

  it('restores no badges, because a stored turn has none', () => {
    // The badges, token chip and save outcome are this session's state; a
    // turn read back from disk has none of them, and inventing them would
    // show a search or a saved file that did not happen here.
    const restored = restoreAskMessages([
      stored({
        role: 'assistant',
        text: 'an answer',
        seq: 0,
        tools: [{ name: 'kb_search', summary: 'searched 3 files' }],
      }),
    ])
    expect(restored[0]?.toolNotes).toEqual([])
    expect(Object.keys(restored[0] ?? {}).sort()).toEqual([
      'artifacts',
      'role',
      'text',
      'toolNotes',
    ])
  })

  it('is empty for an empty transcript', () => {
    expect(restoreAskMessages([])).toEqual([])
  })
})

/** A project-store that answers, and records what it was asked. */
function recorder(storedMessages: ChatMessage[] = []) {
  const calls: Array<{ method: string; args: unknown }> = []
  const api = {
    resolveChat: async (args: unknown) => {
      calls.push({ method: 'resolveChat', args })
      return { projectId: 'default', chatId: 'kb-ask' }
    },
    appendChat: async (args: unknown) => {
      calls.push({ method: 'appendChat', args })
    },
    loadChat: async (args: unknown) => {
      calls.push({ method: 'loadChat', args })
      return storedMessages
    },
    rebindChat: async (args: unknown) => {
      calls.push({ method: 'rebindChat', args })
      return { projectId: 'default', chatId: 'kb-ask' }
    },
  } as unknown as ProjectApi
  return { api, calls }
}

describe('claiming the panel thread', () => {
  it('asks for a file-less chat under the fixed id, not a fresh one', async () => {
    // The store takes a file-less caller's id verbatim, so a constant is what
    // makes the next launch find this thread again.
    const { api, calls } = recorder([stored({ role: 'user', text: 'older question' })])
    const shown: AskMessage[][] = []
    await claimThread(
      api,
      'kb-ask',
      [],
      (m) => shown.push(m),
      () => true,
    )

    expect(calls[0]).toEqual({
      method: 'resolveChat',
      args: { filePath: null, tempChatId: 'kb-ask' },
    })
    expect(shown[0]).toEqual([
      { role: 'user', text: 'older question', toolNotes: [], artifacts: [] },
    ])
  })

  it('writes the turns asked before the ids landed, after reading back, and drains them', async () => {
    const { api, calls } = recorder([])
    const queued = [
      { role: 'user' as const, text: 'first' },
      { role: 'assistant' as const, text: 'first answer' },
    ]
    await claimThread(
      api,
      'kb-ask',
      queued,
      () => undefined,
      () => true,
    )
    expect(calls.map((c) => c.method)).toEqual([
      'resolveChat',
      'loadChat',
      'appendChat',
      'appendChat',
    ])
    expect(queued).toEqual([])
    expect(calls[2]?.args).toEqual({
      projectId: 'default',
      chatId: 'kb-ask',
      role: 'user',
      text: 'first',
    })
  })

  it('shows nothing when the panel was torn down mid-flight', async () => {
    const { api } = recorder([stored({ text: 'too late to show' })])
    const shown: AskMessage[][] = []
    await claimThread(
      api,
      'kb-ask',
      [],
      (m) => shown.push(m),
      () => false,
    )
    expect(shown).toEqual([])
  })

  it('returns the ids so the panel can write the turns that come next', async () => {
    const { api } = recorder([])
    await expect(
      claimThread(
        api,
        'kb-ask',
        [],
        () => undefined,
        () => true,
      ),
    ).resolves.toEqual({
      projectId: 'default',
      chatId: 'kb-ask',
    })
  })
})

describe('listing the stored threads', () => {
  const meta = (chatId: string, updatedAt: string): ChatMeta => ({
    chatId,
    updatedAt,
    approxCount: 4,
  })

  it('puts the most recent conversation on top', () => {
    const listed = listThreads(
      [meta('old', '2026-10-15T09:00:00.000Z'), meta('new', '2026-10-17T09:00:00.000Z')],
      () => undefined,
    )
    expect(listed.map((t) => t.chatId)).toEqual(['new', 'old'])
  })

  it('labels a conversation by its own first question', () => {
    const first: Record<string, string> = {
      a: 'who is in the photograph',
      b: 'what did the letter say',
    }
    const listed = listThreads(
      [meta('a', '2026-10-17T09:00:00.000Z'), meta('b', '2026-10-16T09:00:00.000Z')],
      (chatId) => first[chatId],
    )
    expect(listed.map((t) => t.label)).toEqual([
      'who is in the photograph',
      'what did the letter say',
    ])
  })

  it('collapses a question that wrapped and truncates a long one', () => {
    expect(
      listThreads([meta('a', '2026-10-17T09:00:00.000Z')], () => 'a\n\n  b   c')[0]?.label,
    ).toBe('a b c')
    const long = 'x'.repeat(200)
    expect(listThreads([meta('a', '2026-10-17T09:00:00.000Z')], () => long)[0]?.label).toHaveLength(
      60,
    )
  })

  it('falls back to the id when a conversation has no question to name it by', () => {
    // An empty thread, or one whose read failed: the id is unique and
    // copyable, which a blank row would not be.
    expect(
      listThreads([meta('kb-ask-1731', '2026-10-17T09:00:00.000Z')], () => undefined)[0]?.label,
    ).toBe('kb-ask-1731')
    expect(
      listThreads([meta('kb-ask-1731', '2026-10-17T09:00:00.000Z')], () => '   ')[0]?.label,
    ).toBe('kb-ask-1731')
  })

  it('is empty when nothing was ever asked', () => {
    expect(listThreads([], () => 'anything')).toEqual([])
  })
})

describe('naming a conversation by its first question', () => {
  it('takes the first user turn, not the first turn of any kind', () => {
    expect(
      firstQuestionOf([
        stored({ role: 'assistant', text: 'an answer that came first', seq: 0 }),
        stored({ role: 'user', text: 'the actual question', seq: 1 }),
      ]),
    ).toBe('the actual question')
  })

  it('is undefined when the thread opens with answers', () => {
    expect(
      firstQuestionOf([stored({ role: 'assistant', text: 'orphan answer', seq: 0 })]),
    ).toBeUndefined()
    expect(firstQuestionOf([])).toBeUndefined()
  })
})

describe('choosing which conversations the panel lists', () => {
  const meta = (chatId: string): ChatMeta => ({
    chatId,
    updatedAt: '2026-10-17T09:00:00.000Z',
    approxCount: 4,
  })

  it('keeps the home thread and the threads a new conversation started', () => {
    expect(
      panelThreads([meta('kb-ask'), meta('kb-ask-1731'), meta('kb-ask-1732')]).map((m) => m.chatId),
    ).toEqual(['kb-ask', 'kb-ask-1731', 'kb-ask-1732'])
  })

  it("never lists another document's AI history, however many are stored", () => {
    // Unsaved editor documents write into the same default project; a
    // list that showed them would offer deleting their transcripts from a
    // panel that has nothing to do with them.
    const listed = panelThreads([
      meta('kb-ask'),
      meta('unsaved-1728000000000'),
      meta('a1b2c3d4e5f6a7b8'),
      meta('kb-asks'),
      meta('ask-kb-ask'),
    ])
    expect(listed.map((m) => m.chatId)).toEqual(['kb-ask'])
  })
})

describe('claiming the thread the panel switched to', () => {
  it('resolves the activated id, not the home thread', async () => {
    // A chip click or a new conversation changes the id; if the claim still
    // asked for the home thread, every turn would land in `kb-ask` no matter
    // which conversation was on screen.
    const { api, calls } = recorder([])
    await claimThread(
      api,
      'kb-ask-1731',
      [],
      () => undefined,
      () => true,
    )
    expect(calls[0]).toEqual({
      method: 'resolveChat',
      args: { filePath: null, tempChatId: 'kb-ask-1731' },
    })
  })
})

describe('bounding the live transcript (issue 27 item 3)', () => {
  it('drops the oldest messages past the cap, keeping the newest order', () => {
    // An all-day Ask session appends two entries per turn; the bound keeps
    // the DOM list the size the docs editor panel keeps its own transcript.
    const entries = Array.from({ length: MAX_ASK_ENTRIES + 5 }, (_, i): AskMessage => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: `turn ${i}`,
      toolNotes: [],
      artifacts: [],
    }))
    const bounded = boundAskTranscript(entries)
    expect(bounded).toHaveLength(MAX_ASK_ENTRIES)
    expect(bounded[0]?.text).toBe('turn 5')
    expect(bounded[bounded.length - 1]?.text).toBe(`turn ${MAX_ASK_ENTRIES + 4}`)
  })

  it('keeps the array reference when at or under the cap', () => {
    // The common case is a patch or an append on a small transcript; a fresh
    // array would churn every memoized row's props for nothing.
    const entries: AskMessage[] = [{ role: 'user', text: 'q', toolNotes: [], artifacts: [] }]
    expect(boundAskTranscript(entries)).toBe(entries)
  })

  it('restores exactly the retained window, not the old store-side 200', async () => {
    // The load is the other half of the bound: reading 200 turns made the
    // remount parse 200 rows (and feed the loop a history it trims to 40
    // anyway). The claim must ask for exactly what the panel keeps.
    const { api, calls } = recorder([])
    await claimThread(
      api,
      'kb-ask',
      [],
      () => undefined,
      () => true,
    )
    const load = calls.find((c) => c.method === 'loadChat')
    expect(load?.args).toMatchObject({ limit: MAX_ASK_ENTRIES })
  })

  it('keeps the cap at sixty, in lockstep with the docs editor panel', () => {
    // Every other bound assertion is relative to the constant, so raising it
    // silently would leave the whole suite green while the transcript grows
    // again. The docs editor panel already lives at 60 (MAX_CHAT_ENTRIES);
    // the parity is pinned from its source so the two caps cannot drift.
    expect(MAX_ASK_ENTRIES).toBe(60)
    const docsRetention = readFileSync(
      new URL('../../docs/src/renderer/ai/chat-retention.ts', import.meta.url),
      'utf8',
    )
    expect(docsRetention).toContain('export const MAX_CHAT_ENTRIES = 60')
  })

  it('bounds a restore prepended in front of live turns from the restored end', () => {
    // The mount path prepends stored history in front of a question asked
    // while the claim was in flight: the bound must drop the oldest RESTORED
    // rows, never the live question.
    const live: AskMessage = {
      role: 'user',
      text: 'asked while loading',
      toolNotes: [],
      artifacts: [],
    }
    const restored = Array.from({ length: MAX_ASK_ENTRIES }, (_, i): AskMessage => ({
      role: 'user',
      text: `stored ${i}`,
      toolNotes: [],
      artifacts: [],
    }))
    const bounded = boundAskTranscript([...restored, live])
    expect(bounded).toHaveLength(MAX_ASK_ENTRIES)
    expect(bounded[bounded.length - 1]).toBe(live)
    expect(bounded[0]?.text).toBe('stored 1')
  })

  it('the writer of the thread still bounds every growth (source pins)', () => {
    // Two load-bearing lines of the bound have no runtime surface a DOM-less
    // test can reach: the valve inside mutateMessages (a growth path that
    // bypasses the writer regresses to unbounded and nothing above goes red),
    // and the restore's prepend order (history lands in front of live turns,
    // so the bound trims stored rows, not the live question). jsdom does not
    // render arrays, so both are pinned in the source; the single-writer
    // property itself stays a review concern — a pin can prove these two
    // lines, not that no future line grows the ref.
    const src = readFileSync(new URL('../src/renderer/src/KbAskPanel.tsx', import.meta.url), 'utf8')
    expect(src).toContain('messagesRef.current = boundAskTranscript(next(messagesRef.current))')
    expect(src).toContain('mutateMessages((prev) => [...restored, ...prev])')
  })
})
