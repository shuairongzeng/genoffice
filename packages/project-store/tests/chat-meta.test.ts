import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectStore } from '../src/store.js'

/**
 * The conversation library's metadata sidecar (store.setChatMeta +
 * listChats' extended answer): one chat-meta.json per project keyed by
 * chatId — the rename's title override and the pin — while the jsonl
 * transcripts stay byte-for-byte untouched. listChats merges the sidecar
 * into every meta and resolves the doc-bound threads' paths from the
 * index's chatIdByPath registry (the reverse of resolveChatForFile), and
 * the optional query filters live by label or stored text.
 */

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'project-store-chat-meta-'))
}

let tmpDir: string
let store: ProjectStore

beforeEach(() => {
  tmpDir = makeTempDir()
  store = new ProjectStore(tmpDir)
  store.ensureDefaultProject()
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

/** write one transcript directly, the way appendChatMessage's writer does */
function seedTranscript(chatId: string, turns: string[]): string {
  const path = join(tmpDir, 'projects', 'default', 'chats', `${chatId}.jsonl`)
  mkdirSync(dirname(path), { recursive: true })
  const body = turns
    .map((text, i) =>
      JSON.stringify({ seq: i, ts: '2026-11-03T09:00:00.000Z', role: 'user', text }),
    )
    .join('\n')
  writeFileSync(path, body + '\n', 'utf8')
  return path
}

const metaFile = (): string => join(tmpDir, 'projects', 'default', 'chat-meta.json')

describe('setChatMeta (the sidecar round-trip)', () => {
  it('writes title and pin, merges patches, and answers the effective meta', () => {
    seedTranscript('kb-ask', ['hello'])
    expect(store.setChatMeta('default', 'kb-ask', { title: 'Research notes' })).toEqual({
      title: 'Research notes',
    })
    expect(store.setChatMeta('default', 'kb-ask', { pinned: true })).toEqual({
      title: 'Research notes',
      pinned: true,
    })
    // the file is one honest json, keyed by chatId
    expect(JSON.parse(readFileSync(metaFile(), 'utf8'))).toEqual({
      'kb-ask': { title: 'Research notes', pinned: true },
    })
  })

  it('a null or empty title clears the override; the entry drops when nothing is left', () => {
    seedTranscript('kb-ask', ['hello'])
    store.setChatMeta('default', 'kb-ask', { pinned: true, title: 'a name' })
    expect(store.setChatMeta('default', 'kb-ask', { title: null })).toEqual({ pinned: true })
    expect(store.setChatMeta('default', 'kb-ask', { title: '' })).toEqual({ pinned: true })
    expect(store.setChatMeta('default', 'kb-ask', { pinned: false })).toBeNull()
    expect(existsSync(metaFile())).toBe(true)
    expect(JSON.parse(readFileSync(metaFile(), 'utf8'))).toEqual({})
  })

  it('the transcripts are never touched: the jsonl bytes are byte-for-byte what the writer left', () => {
    const path = seedTranscript('kb-ask', ['hello'])
    const before = readFileSync(path, 'utf8')
    store.setChatMeta('default', 'kb-ask', { title: 'renamed', pinned: true })
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('a title is trimmed and capped; a pinned write only ever lands as a boolean', () => {
    seedTranscript('kb-ask', ['hello'])
    const meta = store.setChatMeta('default', 'kb-ask', {
      title: `  ${'x'.repeat(300)}  `,
      pinned: false,
    })
    expect(meta?.title).toHaveLength(120)
    expect(meta?.pinned).toBeUndefined()
    // a hand-edited junk sidecar is dropped whole on the next read
    writeFileSync(metaFile(), JSON.stringify({ 'kb-ask': { title: 7, pinned: 'yes' }, bad: 'x' }))
    expect(store.listChats('default').find((m) => m.chatId === 'kb-ask')?.title).toBeUndefined()
    // and a valid entry beside the junk survives
    writeFileSync(
      metaFile(),
      JSON.stringify({ 'kb-ask': { title: 'kept' }, other: { pinned: true } }),
    )
    expect(store.setChatMeta('default', 'kb-ask', { pinned: false })).toEqual({ title: 'kept' })
  })
})

describe('deleteChat drops the sidecar entry with the transcript', () => {
  it('a renamed and pinned thread leaves nothing behind in chat-meta.json', () => {
    seedTranscript('kb-ask', ['hello'])
    store.setChatMeta('default', 'kb-ask', { title: 'named', pinned: true })
    seedTranscript('kb-ask-2', ['other'])
    store.setChatMeta('default', 'kb-ask-2', { title: 'stays' })
    store.deleteChat('default', 'kb-ask')
    expect(JSON.parse(readFileSync(metaFile(), 'utf8'))).toEqual({
      'kb-ask-2': { title: 'stays' },
    })
    expect(existsSync(join(tmpDir, 'projects', 'default', 'chats', 'kb-ask.jsonl'))).toBe(false)
  })
})

describe('listChats carries the library fields', () => {
  it('title and pinned ride the metas; a doc-bound thread resolves its path', () => {
    seedTranscript('kb-ask', ['hello'])
    store.setChatMeta('default', 'kb-ask', { title: 'named', pinned: true })
    // a document thread: resolve registers the path mapping, its transcript
    // lands in the file's project
    const doc = join(tmpDir, 'files', 'Q3 Report.docx')
    mkdirSync(dirname(doc), { recursive: true })
    writeFileSync(doc, 'x', 'utf8')
    const ids = store.resolveChatForFile(doc)
    seedTranscript(ids.chatId, ['a doc turn'])
    // the registry canonicalizes (macOS resolves /var → /private/var), so
    // the answer's path is the file's real path, not the literal input
    const metas = store.listChats('default')
    const family = metas.find((m) => m.chatId === 'kb-ask')
    expect(family?.title).toBe('named')
    expect(family?.pinned).toBe(true)
    expect(family?.docPath).toBeUndefined()
    const bound = metas.find((m) => m.chatId === ids.chatId)
    expect(bound?.docPath).toBe(realpathSync(doc))
    expect(bound?.firstQuestion).toBe('a doc turn')
  })

  it('the live query: label matches (the override and the first question), content matches, case-insensitive', () => {
    seedTranscript('kb-ask', ['市场调研'])
    seedTranscript('kb-ask-2', ['a plain turn'])
    store.setChatMeta('default', 'kb-ask', { title: 'Research notes' })
    // the title override matches
    expect(store.listChats('default', 'research')).toHaveLength(1)
    // the stored turn's text matches, case-insensitively
    expect(store.listChats('default', 'PLAIN TURN')).toHaveLength(1)
    // the first question of an untitled thread matches
    expect(store.listChats('default', '市场')).toHaveLength(1)
    // a miss answers nothing; an empty or absent query answers everything
    expect(store.listChats('default', 'zzz')).toHaveLength(0)
    expect(store.listChats('default', '   ')).toHaveLength(2)
    expect(store.listChats('default')).toHaveLength(2)
  })
})
