import { describe, expect, it, vi } from 'vitest'
import type { AiPermissionMode } from '@genoffice/ui/ai-permission-mode'
import { createAiSessionAllows } from '../src/main/ai-session-allows'
import {
  classifyToolPermissionGrade,
  createGenofficePermissionExtension,
} from '../src/main/pi-agent/genoffice-permission-extension'
import { createWorkbenchExtensionCoord } from '../src/main/pi-agent/genoffice-workbench-extension'
import type { WorkbenchToolsService } from '../src/main/workbench-tools-service'

function createMockWorkbench(): WorkbenchToolsService {
  return {
    kbList: vi.fn().mockResolvedValue([]),
    kbSearch: vi.fn().mockResolvedValue([]),
    kbRead: vi.fn().mockResolvedValue({ path: '/tmp/a.txt', totalChars: 512, text: 'hello' }),
    createDocument: vi.fn().mockResolvedValue({ path: '/tmp/out.md' }),
    editFile: vi.fn().mockResolvedValue({ path: '/tmp/a.txt', occurrences: 1 }),
    deleteFile: vi.fn().mockResolvedValue({ path: '/tmp/a.txt' }),
    readAttachment: vi.fn().mockResolvedValue({ ok: true, text: 'att', totalChars: 3, offset: 0 }),
    readAttachmentImage: vi.fn().mockReturnValue({ ok: false, error: 'not image' }),
    cliContext: vi.fn().mockReturnValue(null),
    runCli: vi.fn().mockResolvedValue({ ok: true, code: 0 }),
    getAppSkillManifest: vi.fn().mockResolvedValue({ windows: [], tools: [] }),
    executeAppSkill: vi.fn().mockResolvedValue({ target: { id: '1', kind: 'docs', title: 'Doc' }, result: {} }),
    describeDocumentAgent: vi.fn().mockResolvedValue({ tabId: 'tab-doc-9', kind: 'docs', title: 'Report.docx' }),
    runDocumentAgent: vi.fn().mockResolvedValue({ ok: true, summary: 'done' }),
    cancelDocumentAgent: vi.fn().mockReturnValue(true),
    undoDocumentAgent: vi.fn().mockResolvedValue({ ok: true }),
    executeBrowserSkill: vi.fn().mockResolvedValue({ ok: true }),
    listBrowserTabs: vi.fn().mockResolvedValue([]),
    listSurfaceTabs: vi.fn().mockResolvedValue([]),
    recordLineage: vi.fn(),
    lineageFor: vi.fn().mockReturnValue(null),
  }
}

function captureToolCallHandler(
  factory: ReturnType<typeof createGenofficePermissionExtension>,
): (event: any, ctx: any) => Promise<any> {
  let handler: ((event: any, ctx: any) => Promise<any>) | null = null
  const mockPi = {
    on(event: string, fn: any) {
      if (event === 'tool_call') handler = fn
    },
  }
  factory(mockPi as any)
  if (!handler) throw new Error('tool_call handler was not registered')
  return handler
}

const fakeCtx = {
  sessionManager: {
    getSessionId: () => 'pi-sess-1',
  },
}

describe('genoffice-permission-extension', () => {
  it('classifies GenOffice, Pi core, Magic Context, and unknown third-party tools accurately', () => {
    const coord = createWorkbenchExtensionCoord()
    expect(classifyToolPermissionGrade({ toolName: 'search_knowledge_base', coord })).toBe('read')
    expect(classifyToolPermissionGrade({ toolName: 'read_knowledge_file', coord })).toBe('read')
    expect(classifyToolPermissionGrade({ toolName: 'ctx_memory', coord })).toBe('read')
    expect(classifyToolPermissionGrade({ toolName: 'read', coord })).toBe('read')
    expect(classifyToolPermissionGrade({ toolName: 'bash', coord })).toBe('side-effect')
    expect(classifyToolPermissionGrade({ toolName: 'edit_file', coord })).toBe('side-effect')
    expect(classifyToolPermissionGrade({ toolName: 'document_agent', coord })).toBe('side-effect')
    expect(classifyToolPermissionGrade({ toolName: 'delete_file', coord })).toBe('destructive')

    expect(classifyToolPermissionGrade({ toolName: 'third_party_unknown', coord })).toBe('side-effect')
    expect(
      classifyToolPermissionGrade({
        toolName: 'third_party_ro',
        coord,
        annotations: { readOnlyHint: true },
      }),
    ).toBe('read')
    expect(
      classifyToolPermissionGrade({
        toolName: 'third_party_nuke',
        coord,
        annotations: { destructiveHint: true },
      }),
    ).toBe('destructive')
  })

  it('enforces smart, paranoid, and auto permission modes with AiSessionAllows', async () => {
    let mode: AiPermissionMode = 'smart'
    const sessionAllows = createAiSessionAllows()
    const coord = createWorkbenchExtensionCoord()
    const workbench = createMockWorkbench()
    const requests: any[] = []
    let nextReply = { allowed: true, alwaysAllowSession: false }

    const onToolCall = captureToolCallHandler(
      createGenofficePermissionExtension({
        getPermissionMode: () => mode,
        sessionAllows,
        workbench,
        coord,
        requestConfirm: async (req) => {
          requests.push(req)
          return nextReply
        },
      }),
    )

    // Read-only tools run freely in smart & paranoid.
    await expect(
      onToolCall({ toolCallId: 'c-ro', toolName: 'read_knowledge_file', input: {} }, fakeCtx),
    ).resolves.toBeUndefined()
    expect(requests).toHaveLength(0)

    // edit_file under smart triggers confirmation with size summary and supports session allow.
    nextReply = { allowed: true, alwaysAllowSession: true }
    await expect(
      onToolCall(
        {
          toolCallId: 'c-edit-1',
          toolName: 'edit_file',
          input: { path: '/tmp/a.txt', old_string: 'hello', new_string: 'world!' },
        },
        fakeCtx,
      ),
    ).resolves.toBeUndefined()
    expect(requests).toHaveLength(1)
    expect(requests[0].sessionAllowable).toBe(true)
    expect(requests[0].argsSummary).toContain('file: 512 characters')
    expect(sessionAllows.has('edit_file')).toBe(true)

    // Second edit_file under smart skips card because of AiSessionAllows.
    await expect(
      onToolCall(
        {
          toolCallId: 'c-edit-2',
          toolName: 'edit_file',
          input: { path: '/tmp/a.txt', old_string: 'a', new_string: 'b' },
        },
        fakeCtx,
      ),
    ).resolves.toBeUndefined()
    expect(requests).toHaveLength(1)

    // Switch to paranoid: even session-allowed tool must prompt with sessionAllowable: false.
    mode = 'paranoid'
    nextReply = { allowed: false, alwaysAllowSession: false }
    const declined = await onToolCall(
      {
        toolCallId: 'c-edit-3',
        toolName: 'edit_file',
        input: { path: '/tmp/a.txt', old_string: 'a', new_string: 'b' },
      },
      fakeCtx,
    )
    expect(requests).toHaveLength(2)
    expect(requests[1].sessionAllowable).toBe(false)
    expect(declined).toEqual({
      block: true,
      reason: 'User declined execution of "edit_file".',
    })

    // delete_file under smart never offers sessionAllowable, and populates approvedDeleteCallIds only on allow.
    mode = 'smart'
    nextReply = { allowed: true, alwaysAllowSession: true }
    await expect(
      onToolCall({ toolCallId: 'c-del-1', toolName: 'delete_file', input: { path: '/tmp/a.txt' } }, fakeCtx),
    ).resolves.toBeUndefined()
    expect(requests).toHaveLength(3)
    expect(requests[2].sessionAllowable).toBe(false)
    expect(sessionAllows.has('delete_file')).toBe(false)
    expect(coord.approvedDeleteCallIds.has('c-del-1')).toBe(true)

    // auto skips confirm cards and authorizes delete_file directly.
    mode = 'auto'
    await expect(
      onToolCall({ toolCallId: 'c-del-auto', toolName: 'delete_file', input: { path: '/tmp/a.txt' } }, fakeCtx),
    ).resolves.toBeUndefined()
    expect(requests).toHaveLength(3)
    expect(coord.approvedDeleteCallIds.has('c-del-auto')).toBe(true)
  })

  it('pins target document tabId for document_agent confirmation', async () => {
    const coord = createWorkbenchExtensionCoord()
    const workbench = createMockWorkbench()
    let capturedReq: any = null

    const onToolCall = captureToolCallHandler(
      createGenofficePermissionExtension({
        getPermissionMode: () => 'smart',
        sessionAllows: createAiSessionAllows(),
        workbench,
        coord,
        requestConfirm: async (req) => {
          capturedReq = req
          return { allowed: true }
        },
      }),
    )

    await expect(
      onToolCall(
        { toolCallId: 'c-doc-1', toolName: 'document_agent', input: { task: 'Add title' } },
        fakeCtx,
      ),
    ).resolves.toBeUndefined()

    expect(workbench.describeDocumentAgent).toHaveBeenCalledWith(undefined)
    expect(capturedReq.argsSummary).toBe('works in "Report.docx"')
    expect(coord.pinnedDocumentTabByCallId.get('c-doc-1')).toBe('tab-doc-9')

    await expect(
      onToolCall(
        {
          toolCallId: 'c-doc-2',
          toolName: 'document_agent',
          input: { task: 'Update notes', tabId: ' t-bg ' },
        },
        fakeCtx,
      ),
    ).resolves.toBeUndefined()
    expect(workbench.describeDocumentAgent).toHaveBeenLastCalledWith('t-bg')
  })
})
