// @vitest-environment jsdom
/**
 * Docs MCP bridge read_document coverage: overview + full HTML preview,
 * pagination for long documents (>16,000 chars), explicit block ranges with
 * safe clamping, and out-of-range error reporting.
 */
import { describe, expect, it } from 'vitest'
import { Editor, type JSONContent } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { installMcpBridge } from '../src/renderer/mcp-bridge'
import type { FileActionContext } from '../src/renderer/file-actions'

interface BridgeResult {
  requestId: string
  ok: boolean
  result?: { text?: string }
  error?: string
}

function paragraph(text: string): JSONContent {
  return { type: 'docParagraph', content: [{ type: 'text', text }] }
}

function tableOf(rows: string[][]): JSONContent {
  return {
    type: 'docTable',
    content: rows.map((cells) => ({
      type: 'docTableRow',
      content: cells.map((cell) => ({
        type: 'docTableCell',
        content: [paragraph(cell)],
      })),
    })),
  }
}

function createEditor(blocks: JSONContent[]): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: { type: 'doc', content: blocks },
  })
}

function mountBridge(editor: Editor) {
  let listener: ((msg: { requestId: string; command: string; payload?: unknown }) => void) | null =
    null
  const results = new Map<string, BridgeResult>()
  ;(window as unknown as Record<string, unknown>).desktop = {
    onMcpCommand: (cb: typeof listener) => {
      listener = cb
      return () => {
        listener = null
      }
    },
    reportMcpResult: (res: BridgeResult) => {
      results.set(res.requestId, res)
    },
    signalMcpReady: () => {},
  }
  const ctx = {
    editor,
    doc: { parsed: { blocks: [] }, isBlank: false },
  } as unknown as FileActionContext
  const uninstall = installMcpBridge({ getCtx: () => ctx })
  let seq = 0
  const callRead = async (payload: Record<string, unknown> = {}): Promise<BridgeResult> => {
    const requestId = `req-${++seq}`
    listener?.({ requestId, command: 'read_document', payload })
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 5))
      const res = results.get(requestId)
      if (res) return res
    }
    throw new Error(`Timed out waiting for ${requestId}`)
  }
  return { callRead, uninstall }
}

describe('docs mcp-bridge read_document', () => {
  it('includes full HTML content and multi-row tables alongside the block overview when omitted', async () => {
    const longTail = `${'Prefix wording for long paragraph testing. '.repeat(3)}TAIL_MARKER_881`
    const editor = createEditor([
      paragraph(longTail),
      tableOf([
        ['Month', 'Item', 'Amount'],
        ['2026-08', 'Claude', '225'],
        ['2026-09', 'Codex', '205'],
        ['Total', 'Summary', '9527'],
      ]),
    ])
    const { callRead, uninstall } = mountBridge(editor)
    try {
      const res = await callRead()
      expect(res.ok).toBe(true)
      const text = res.result?.text ?? ''
      expect(text).toContain('0|p|')
      expect(text).toContain('1|table|')
      expect(text).toContain('TAIL_MARKER_881')
      expect(text).toContain('<td>9527</td>')
    } finally {
      uninstall()
      editor.destroy()
    }
  })

  it('truncates oversized documents in preview and points to read_document offset pagination', async () => {
    const blocks = Array.from({ length: 20 }, (_, i) =>
      paragraph(`Block ${i}: ${'AlphaBetaGammaDelta '.repeat(50)}END_${i}`),
    )
    const editor = createEditor(blocks)
    const { callRead, uninstall } = mountBridge(editor)
    try {
      const first = await callRead()
      expect(first.ok).toBe(true)
      const text = first.result?.text ?? ''
      expect(text).toContain('offset=16000')
      expect(text).toContain('read_document')
      expect(text).not.toContain('read_blocks')
      expect(text).not.toContain('END_19')

      const tail = await callRead({ offset: 16000 })
      expect(tail.ok).toBe(true)
      expect(tail.result?.text).toContain('END_19')
    } finally {
      uninstall()
      editor.destroy()
    }
  })

  it('reads explicit block ranges, clamps out-of-bounds endBlockIndex, and rejects invalid ranges', async () => {
    const editor = createEditor([
      paragraph('First block'),
      paragraph('Second block FULL_SECOND_BODY'),
      paragraph('Third block FINAL_MARKER'),
    ])
    const { callRead, uninstall } = mountBridge(editor)
    try {
      const res = await callRead({ startBlockIndex: 1, endBlockIndex: 999 })
      expect(res.ok).toBe(true)
      expect(res.result?.text).toContain('FULL_SECOND_BODY')
      expect(res.result?.text).toContain('FINAL_MARKER')
      expect(res.result?.text).not.toContain('First block')

      const bad = await callRead({ startBlockIndex: 10 })
      expect(bad.ok).toBe(false)
      expect(bad.error).toMatch(/out of range/i)
    } finally {
      uninstall()
      editor.destroy()
    }
  })
})
