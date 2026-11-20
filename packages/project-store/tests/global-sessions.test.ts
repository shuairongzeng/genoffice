import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ProjectStore, canonicalPathKey } from '../src/store.js'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'project-store-global-sessions-'))
}

describe('global sessions & document session binding', () => {
  let rootDir: string
  let docsDir: string
  let store: ProjectStore

  beforeEach(() => {
    rootDir = makeTempDir()
    docsDir = makeTempDir()
    store = new ProjectStore(rootDir)
    store.ensureDefaultProject()
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
    rmSync(docsDir, { recursive: true, force: true })
  })

  it('aggregates chats across projects with exact messageCount, lastMessagePreview, and docExists', () => {
    const docA = join(docsDir, 'alpha.docx')
    const docB = join(docsDir, 'beta.md')
    writeFileSync(docA, 'alpha')
    writeFileSync(docB, 'beta')

    const p1 = store.resolveChatForFile(docA)
    store.appendChatMessage(p1.projectId, p1.chatId, { role: 'user', text: 'Summarize alpha' })
    store.appendChatMessage(p1.projectId, p1.chatId, {
      role: 'assistant',
      text: 'Alpha summary response',
    })

    const proj2 = store.createProject('Research Project')
    store.moveFileToProject(docB, proj2.id)
    const p2 = store.resolveChatForFile(docB)
    store.appendChatMessage(p2.projectId, p2.chatId, { role: 'user', text: 'Check beta outline' })
    store.appendChatMessage(p2.projectId, p2.chatId, {
      role: 'assistant',
      text: 'Beta final answer line',
    })

    const free = { projectId: 'default', chatId: 'kb-ask' }
    store.appendChatMessage(free.projectId, free.chatId, { role: 'user', text: 'General question' })
    store.appendChatMessage(free.projectId, free.chatId, {
      role: 'assistant',
      text: 'General answer reply',
    })

    const all = store.listAllChats()
    expect(all.length).toBeGreaterThanOrEqual(3)

    const alphaRow = all.find((c) => c.chatId === p1.chatId)
    expect(alphaRow).toBeDefined()
    expect(alphaRow?.messageCount).toBe(2)
    expect(alphaRow?.lastMessagePreview).toBe('Alpha summary response')
    expect(alphaRow?.docExists).toBe(true)
    expect(canonicalPathKey(alphaRow!.docPath!)).toBe(canonicalPathKey(docA))

    const betaRow = all.find((c) => c.chatId === p2.chatId)
    expect(betaRow?.projectName).toBe('Research Project')
    expect(betaRow?.docExists).toBe(true)

    const freeRow = all.find((c) => c.chatId === 'kb-ask')
    expect(freeRow?.docPath).toBeUndefined()
    expect(freeRow?.docExists).toBeUndefined()

    // Removing the underlying document flips docExists to false while preserving the history
    unlinkSync(docB)
    const afterDelete = store.listAllChats()
    const betaAfter = afterDelete.find((c) => c.chatId === p2.chatId)
    expect(betaAfter?.docExists).toBe(false)

    // Query matches title, path, or stored message body across all projects
    const bodyMatches = store.listAllChats('outline')
    expect(bodyMatches.map((c) => c.chatId)).toEqual([p2.chatId])
  })

  it('supports multiple threads per document via setChatMeta(docPath) and migrates them on fileRenamed', () => {
    const oldDoc = join(docsDir, 'draft-v1.docx')
    const newDoc = join(docsDir, 'draft-v2.docx')
    writeFileSync(oldDoc, 'content')

    const primary = store.resolveChatForFile(oldDoc)
    store.appendChatMessage(primary.projectId, primary.chatId, { role: 'user', text: 'First thread' })
    store.appendChatMessage(primary.projectId, primary.chatId, {
      role: 'assistant',
      text: 'First reply',
    })

    const childChatId = `${primary.chatId}-1700000001`
    store.appendChatMessage(primary.projectId, childChatId, {
      role: 'user',
      text: 'Second thread on same doc',
    })
    store.appendChatMessage(primary.projectId, childChatId, {
      role: 'assistant',
      text: 'Second reply',
    })
    store.setChatMeta(primary.projectId, childChatId, {
      title: 'Deep Dive Thread',
      docPath: oldDoc,
      pinned: true,
    })

    const beforeRename = store
      .listAllChats()
      .filter((c) => c.docPath && canonicalPathKey(c.docPath) === canonicalPathKey(oldDoc))
    expect(beforeRename.map((c) => c.chatId).sort()).toEqual([primary.chatId, childChatId].sort())

    // Simulate file rename on disk and update store
    writeFileSync(newDoc, 'content')
    unlinkSync(oldDoc)
    store.fileRenamed(oldDoc, newDoc)

    const afterRename = store
      .listAllChats()
      .filter((c) => c.docPath && canonicalPathKey(c.docPath) === canonicalPathKey(newDoc))
    expect(afterRename.map((c) => c.chatId).sort()).toEqual([primary.chatId, childChatId].sort())
    const childMeta = afterRename.find((c) => c.chatId === childChatId)
    expect(childMeta?.title).toBe('Deep Dive Thread')
    expect(childMeta?.pinned).toBe(true)
    expect(childMeta?.docExists).toBe(true)
  })

  it('preserves chat metadata during rebindChatToFile and supports batch deleteChats', () => {
    const targetDoc = join(docsDir, 'newly-saved.md')
    writeFileSync(targetDoc, '# Saved')

    const tempChatId = 'tab-untitled-1'
    store.appendChatMessage('default', tempChatId, { role: 'user', text: 'Temp question' })
    store.appendChatMessage('default', tempChatId, { role: 'assistant', text: 'Temp answer' })
    store.setChatMeta('default', tempChatId, { title: 'Unsaved Notes', pinned: true })

    const bound = store.rebindChatToFile('default', tempChatId, targetDoc)
    expect(store.loadChat(bound.projectId, bound.chatId)).toHaveLength(2)

    const reboundMeta = store.listAllChats().find((c) => c.chatId === bound.chatId)
    expect(reboundMeta?.title).toBe('Unsaved Notes')
    expect(reboundMeta?.pinned).toBe(true)
    expect(canonicalPathKey(reboundMeta!.docPath!)).toBe(canonicalPathKey(targetDoc))

    // Add one extra chat in a second project and batch-delete both
    const p2 = store.createProject('Archive')
    store.appendChatMessage(p2.id, 'extra-chat', { role: 'user', text: 'To delete' })
    store.appendChatMessage(p2.id, 'extra-chat', { role: 'assistant', text: 'Ack' })

    const result = store.deleteChats([
      { projectId: bound.projectId, chatId: bound.chatId },
      { projectId: p2.id, chatId: 'extra-chat' },
    ])
    expect(result.deleted).toBe(2)
    expect(store.loadChat(bound.projectId, bound.chatId)).toEqual([])
    expect(store.loadChat(p2.id, 'extra-chat')).toEqual([])
  })
})
