import { describe, expect, it, vi } from 'vitest'
import { BROWSER_SCREENSHOT_TOOL } from '@genoffice/agent-core'
import {
  STATIC_WORKBENCH_SYSTEM_PROMPT,
  createGenofficeWorkbenchExtension,
  createWorkbenchExtensionCoord,
  getStaticWorkbenchToolDefs,
  prepareTurnWorkbenchState,
} from '../src/main/pi-agent/genoffice-workbench-extension'
import type { WorkbenchToolsService } from '../src/main/workbench-tools-service'

function createMockWorkbench(): WorkbenchToolsService {
  return {
    kbList: vi.fn().mockResolvedValue([
      { name: 'notes.md', folder: 'Docs', ext: 'md', sizeBytes: 120, path: 'D:/kb/notes.md' },
    ]),
    kbSearch: vi.fn().mockResolvedValue([]),
    kbRead: vi.fn().mockResolvedValue({ path: 'D:/kb/notes.md', totalChars: 12, text: 'hello' }),
    createDocument: vi.fn().mockResolvedValue({ path: 'D:/kb/out.docx' }),
    editFile: vi.fn().mockResolvedValue({ path: 'D:/kb/notes.md', occurrences: 1 }),
    deleteFile: vi.fn().mockResolvedValue({ path: 'D:/kb/notes.md' }),
    readAttachment: vi.fn().mockResolvedValue({ ok: true, text: 'attached text', totalChars: 13, offset: 0 }),
    readAttachmentImage: vi.fn().mockReturnValue({ ok: false, error: 'not image' }),
    cliContext: vi.fn().mockReturnValue({ workDir: 'D:/work', outDir: 'D:/out' }),
    runCli: vi.fn().mockResolvedValue({ ok: true, code: 0 }),
    getAppSkillManifest: vi.fn().mockResolvedValue({
      windows: [{ id: 't-1', kind: 'docs', title: 'Draft.docx', active: true }],
      tools: [
        {
          name: 'docs:read_document',
          kind: 'docs',
          description: 'Read doc',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    }),
    executeAppSkill: vi.fn().mockResolvedValue({
      target: { id: 't-1', kind: 'docs', title: 'Draft.docx' },
      result: { text: 'doc content' },
    }),
    describeDocumentAgent: vi.fn().mockResolvedValue({
      tabId: 't-1',
      kind: 'docs',
      title: 'Draft.docx',
    }),
    runDocumentAgent: vi.fn().mockResolvedValue({
      ok: true,
      summary: 'Updated paragraph 1',
      edits: [{ tool: 'replace_paragraph', summary: 'Edited line' }],
      checkpointId: 'cp-42',
      tabId: 't-1',
      kind: 'docs',
      title: 'Draft.docx',
    }),
    cancelDocumentAgent: vi.fn().mockReturnValue(true),
    undoDocumentAgent: vi.fn().mockResolvedValue({ ok: true }),
    executeBrowserSkill: vi.fn().mockResolvedValue({
      base64: 'AAAABBBB',
      mime: 'image/png',
      title: 'Example',
      url: 'https://example.com',
      width: 800,
      height: 600,
    }),
    listBrowserTabs: vi.fn().mockResolvedValue([{ id: 'b-1', title: 'Example', active: true }]),
    listSurfaceTabs: vi.fn().mockResolvedValue([
      { id: 't-1', kind: 'docs', title: 'Draft.docx', filePath: 'D:/kb/Draft.docx', active: true },
    ]),
    recordLineage: vi.fn(),
    lineageFor: vi.fn().mockReturnValue(null),
  }
}

describe('genoffice-workbench-extension', () => {
  it('registers all 9 domain tool families statically and keeps before_agent_start systemPrompt byte-identical across state changes', async () => {
    const workbench = createMockWorkbench()
    const coord = createWorkbenchExtensionCoord()
    const factory = createGenofficeWorkbenchExtension(workbench, coord)

    const tools = new Map<string, any>()
    let beforeAgentStart: ((ev: any, ctx: any) => any) | null = null
    const mockPi = {
      registerTool(def: any) {
        tools.set(def.name, def)
      },
      on(ev: string, fn: any) {
        if (ev === 'before_agent_start') beforeAgentStart = fn
      },
    }
    factory(mockPi as any)

    const staticNames = getStaticWorkbenchToolDefs().map((t) => t.name)
    for (const expected of [
      'search_knowledge_base',
      'read_knowledge_file',
      'read_attachment',
      'create_document',
      'edit_file',
      'delete_file',
      'document_agent',
      'run_genoffice',
      'load_guide',
      'docs:read_document',
      'sheets:read_sheet',
      'slides:read_deck',
      'markdown:read_text',
      'html:read_text',
      'pdf:read_pages',
      'media:read_media',
      'media:analyze_media',
      'browser:read_page',
      BROWSER_SCREENSHOT_TOOL,
      'shell:open_browser',
      'shell:switch_tab',
    ]) {
      expect(tools.has(expected), `missing tool ${expected}`).toBe(true)
      expect(staticNames).toContain(expected)
    }

    expect(beforeAgentStart).not.toBeNull()
    const sections1: Record<string, string> = {}
    const structuredRes1 = beforeAgentStart!(
      { systemPrompt: 'BASE_PROMPT', systemPromptOptions: { sections: sections1 } },
      { sessionManager: { getSessionId: () => 'pi-1' } },
    )
    expect(structuredRes1).toBeUndefined()
    expect(sections1.genoffice_workbench).toBe(STATIC_WORKBENCH_SYSTEM_PROMPT)

    // Also preserve fallback behavior when a caller invokes before_agent_start without sections.
    const fallbackRes1 = beforeAgentStart!(
      { systemPrompt: 'BASE_PROMPT', systemPromptOptions: {} },
      { sessionManager: { getSessionId: () => 'pi-1' } },
    )

    // Populate rich per-turn dynamic state and verify sections/systemPrompt remain byte-identical.
    const turnPrepared = await prepareTurnWorkbenchState(workbench, coord, {
      sessionKey: 'sess-1',
      projectId: 'proj-1',
      chatId: 'kb-ask',
      viewer: 'workspace',
      scopePaths: ['D:/kb/notes.md'],
      attachments: [{ path: 'D:/att/spec.pdf', name: 'spec.pdf', ext: 'pdf', sizeBytes: 100 }],
      instruction: 'Check Draft.docx and notes.md',
    })
    coord.bindPiSession('pi-1', turnPrepared.state)

    const sections2: Record<string, string> = {}
    const structuredRes2 = beforeAgentStart!(
      { systemPrompt: 'BASE_PROMPT', systemPromptOptions: { sections: sections2 } },
      { sessionManager: { getSessionId: () => 'pi-1' } },
    )
    expect(structuredRes2).toBeUndefined()
    expect(sections2.genoffice_workbench).toBe(sections1.genoffice_workbench)

    const fallbackRes2 = beforeAgentStart!(
      { systemPrompt: 'BASE_PROMPT', systemPromptOptions: {} },
      { sessionManager: { getSessionId: () => 'pi-1' } },
    )
    expect(fallbackRes1.systemPrompt).toBe(fallbackRes2.systemPrompt)
    expect(fallbackRes1.systemPrompt).toContain(STATIC_WORKBENCH_SYSTEM_PROMPT)

    // Dynamic context goes ONLY into outbound user message prefix.
    expect(turnPrepared.outboundPrompt).toContain('<workbench_context>')
    expect(turnPrepared.outboundPrompt).toContain('Draft.docx')
    expect(turnPrepared.outboundPrompt).toContain('D:/kb/notes.md')
    expect(turnPrepared.outboundPrompt).toContain('spec.pdf')
    expect(turnPrepared.outboundPrompt.endsWith('Check Draft.docx and notes.md')).toBe(true)
  })

  it('enforces delete authorization token, pins document_agent tabId, and forwards screenshot images', async () => {
    const workbench = createMockWorkbench()
    const coord = createWorkbenchExtensionCoord()
    const factory = createGenofficeWorkbenchExtension(workbench, coord)

    const tools = new Map<string, any>()
    factory({
      registerTool: (def: any) => tools.set(def.name, def),
      on: () => {},
    } as any)

    const checkpoints: any[] = []
    const turn = await prepareTurnWorkbenchState(workbench, coord, {
      sessionKey: 'sess-2',
      projectId: 'proj-1',
      chatId: 'kb-ask',
      viewer: 'home',
      scopePaths: [],
      attachments: [],
      instruction: 'Update doc and trash old note',
      onCheckpoint: (cp) => checkpoints.push(cp),
    })

    const ctx = { sessionManager: { getSessionId: () => 'pi-2' } }
    coord.bindPiSession('pi-2', turn.state)

    // 1. delete_file fails closed when permission hook did not record its toolCallId.
    const deleteTool = tools.get('delete_file')
    const unauthDel = await deleteTool.execute('call-unauth', { path: 'D:/kb/notes.md' }, undefined, undefined, ctx)
    expect(unauthDel.isError).toBe(true)
    expect(workbench.deleteFile).not.toHaveBeenCalled()

    // 2. After permission hook records toolCallId, delete_file succeeds once and consumes the grant.
    coord.approvedDeleteCallIds.add('call-auth')
    const authDel = await deleteTool.execute('call-auth', { path: 'D:/kb/notes.md' }, undefined, undefined, ctx)
    expect(authDel.isError).not.toBe(true)
    expect(workbench.deleteFile).toHaveBeenCalledWith({ path: 'D:/kb/notes.md', confirmed: true })
    expect(coord.approvedDeleteCallIds.has('call-auth')).toBe(false)

    // 3. document_agent consumes pinned tabId and propagates checkpoint details.
    coord.pinnedDocumentTabByCallId.set('call-doc', 't-1')
    const docTool = tools.get('document_agent')
    const docRes = await docTool.execute('call-doc', { task: 'Rewrite intro' }, undefined, undefined, ctx)
    expect(workbench.runDocumentAgent).toHaveBeenCalledWith(
      { task: 'Rewrite intro', expectedTabId: 't-1' },
      undefined,
      'pi:sess-2',
    )
    expect(docRes.details?.checkpoint?.checkpointId).toBe('cp-42')
    expect(checkpoints).toHaveLength(1)

    // 4. browser:screenshot_page returns Pi ImageContent.
    const shotTool = tools.get(BROWSER_SCREENSHOT_TOOL)
    const shotRes = await shotTool.execute('call-shot', {}, undefined, undefined, ctx)
    expect(shotRes.content.some((part: any) => part.type === 'image' && part.data === 'AAAABBBB')).toBe(true)
  })
})
