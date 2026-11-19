import type { AgentSkill, AgentToolCall, AgentToolDef, ToolExecution } from '@genoffice/agent-core'

/**
 * AgentSkill for plain-text, config, and code files edited in sourceMode
 * (.txt, .json, .log, .yaml, .yml, .xml, .ini, .toml, .py, .ts, .tsx, .js, .jsx, .css, .sql, .sh, .bat)
 * inside the Markdown app.
 */

export interface PlainTextSkillDeps {
  getText: () => string
  replaceText: (text: string) => void
  fileName?: () => string | null | undefined
  textMode?: () => string
}

const CONTEXT_PREVIEW_LINES = 80
const CONTEXT_PREVIEW_CHARS = 3500
const READ_MAX_LINES = 250
const READ_MAX_CHARS = 16_000
const SEARCH_MAX_HITS = 80

const PLAIN_TEXT_PROMPT = [
  'You are the text file assistant inside GenOffice, helping the user read, search, and edit the currently open plain-text or config file.',
  '',
  '## Editing rules',
  '- Always read the relevant lines first (`read_text` or `search_text`) before editing.',
  '- Prefer `replace_text` for targeted substring edits and `edit_lines` for line-range updates; reserve `write_text` for creating content in a blank file or full-file rewrites.',
  '- Never fabricate file contents you have not read. For structured files (JSON, YAML, XML, INI, TOML), ensure valid syntax after editing.',
  '- Keep replies concise; summarize what changed in one or two sentences.',
].join('\n')

const PLAIN_TEXT_TOOLS: AgentToolDef[] = [
  {
    name: 'read_text',
    description:
      'Read lines of the open text file (1-based line numbers). Returns up to 250 lines per call with line numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        start_line: { type: 'integer', description: '1-based start line (default 1)' },
        end_line: { type: 'integer', description: '1-based inclusive end line' },
      },
    },
  },
  {
    name: 'search_text',
    description: 'Search the open text file for matching lines and return their line numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring to search for' },
        case_sensitive: { type: 'boolean', description: 'Match exact case (default false)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'replace_text',
    risk: 'high',
    description:
      'Replace exact text in the open file. Fails if old_text matches multiple occurrences unless replace_all is true.',
    inputSchema: {
      type: 'object',
      properties: {
        old_text: { type: 'string', description: 'Exact existing text to replace' },
        new_text: { type: 'string', description: 'Replacement text' },
        replace_all: {
          type: 'boolean',
          description: 'Replace every occurrence when true (default false)',
        },
      },
      required: ['old_text', 'new_text'],
    },
  },
  {
    name: 'edit_lines',
    risk: 'high',
    description:
      'Replace an inclusive 1-based line range [start_line, end_line] with new_text. Pass empty string to delete those lines.',
    inputSchema: {
      type: 'object',
      properties: {
        start_line: { type: 'integer', description: '1-based first line to replace' },
        end_line: { type: 'integer', description: '1-based last line to replace (inclusive)' },
        new_text: {
          type: 'string',
          description: 'Replacement block text (multiline allowed; empty string deletes range)',
        },
      },
      required: ['start_line', 'end_line', 'new_text'],
    },
  },
  {
    name: 'write_text',
    risk: 'high',
    description: 'Overwrite the entire file content with new text.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Complete file text' },
      },
      required: ['content'],
    },
  },
]

function detectEol(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

function normalizeEol(text: string, eol: '\r\n' | '\n'): string {
  const lf = text.replace(/\r\n/g, '\n')
  return eol === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n')
}

function errResult(name: string, message: string): ToolExecution {
  return { output: message, isError: true, summary: `${name}: ${message}` }
}

function formatLineSlice(lines: string[], startIdx: number, endIdx: number): string {
  const formatted: string[] = []
  let chars = 0
  let clipped = false
  for (let i = startIdx; i < endIdx; i++) {
    const line = `${i + 1}: ${lines[i] ?? ''}`
    if (chars + line.length + 1 > READ_MAX_CHARS) {
      clipped = true
      break
    }
    formatted.push(line)
    chars += line.length + 1
  }
  const header = `Lines ${startIdx + 1}-${startIdx + formatted.length} of ${lines.length}${clipped ? ' (truncated by character cap)' : ''}`
  return `${header}\n${formatted.join('\n')}`
}

export function createPlainTextSkill(deps: PlainTextSkillDeps): AgentSkill {
  return {
    id: 'plain-text',
    systemPrompt: PLAIN_TEXT_PROMPT,
    tools: PLAIN_TEXT_TOOLS,
    buildContext: () => {
      const raw = deps.getText()
      const lines = splitLines(raw)
      const file = deps.fileName?.() || 'untitled.txt'
      const mode = deps.textMode?.() || 'plain'
      const previewEnd = Math.min(lines.length, CONTEXT_PREVIEW_LINES)
      const previewLines: string[] = []
      let chars = 0
      for (let i = 0; i < previewEnd; i++) {
        const entry = `${i + 1}: ${lines[i] ?? ''}`
        if (chars + entry.length + 1 > CONTEXT_PREVIEW_CHARS) break
        previewLines.push(entry)
        chars += entry.length + 1
      }
      return [
        `<text document>`,
        `File: ${file} | Mode: ${mode} | Lines: ${lines.length} | Characters: ${raw.length}`,
        `Preview (lines 1-${previewLines.length}):`,
        previewLines.join('\n'),
        `</text document>`,
      ].join('\n')
    },
    executeTool: (call: AgentToolCall): ToolExecution => {
      const input = call.input
      const raw = deps.getText()
      const eol = detectEol(raw)
      const lines = splitLines(raw)

      switch (call.name) {
        case 'read_text': {
          const startRaw = Number(input.start_line ?? 1)
          if (!Number.isInteger(startRaw) || startRaw < 1) {
            return errResult(call.name, 'start_line must be an integer >= 1')
          }
          const startIdx = Math.min(startRaw - 1, Math.max(0, lines.length - 1))
          const requestedEnd =
            input.end_line === undefined
              ? startIdx + READ_MAX_LINES
              : Math.min(Number(input.end_line), startIdx + READ_MAX_LINES)
          if (!Number.isInteger(requestedEnd) || requestedEnd < startRaw) {
            return errResult(call.name, 'end_line must be an integer >= start_line')
          }
          const endIdx = Math.min(lines.length, requestedEnd)
          const output = formatLineSlice(lines, startIdx, endIdx)
          return {
            output,
            summary: `Read lines ${startIdx + 1}-${endIdx}`,
          }
        }

        case 'search_text': {
          const query = typeof input.query === 'string' ? input.query : ''
          if (!query) return errResult(call.name, 'query must be a non-empty string')
          const caseSensitive = input.case_sensitive === true
          const needle = caseSensitive ? query : query.toLowerCase()
          const hits: string[] = []
          for (let i = 0; i < lines.length; i++) {
            const hay = caseSensitive ? lines[i]! : lines[i]!.toLowerCase()
            if (hay.includes(needle)) {
              hits.push(`${i + 1}: ${lines[i]}`)
              if (hits.length >= SEARCH_MAX_HITS) break
            }
          }
          if (hits.length === 0) {
            return { output: `No matches found for "${query}".`, summary: `Search "${query}" (0 hits)` }
          }
          return {
            output: `Matches (${hits.length}${hits.length >= SEARCH_MAX_HITS ? '+' : ''}):\n${hits.join('\n')}`,
            summary: `Search "${query}" (${hits.length} hits)`,
          }
        }

        case 'replace_text': {
          const oldRaw = typeof input.old_text === 'string' ? input.old_text : ''
          const newRaw = typeof input.new_text === 'string' ? input.new_text : ''
          if (!oldRaw) return errResult(call.name, 'old_text must be non-empty')
          const replaceAll = input.replace_all === true

          const oldNormalized = normalizeEol(oldRaw, eol)
          const newNormalized = normalizeEol(newRaw, eol)

          const parts = raw.split(oldNormalized)
          const occurrences = parts.length - 1
          if (occurrences === 0) {
            return errResult(call.name, 'old_text was not found in the document')
          }
          if (!replaceAll && occurrences > 1) {
            return errResult(
              call.name,
              `old_text matched ${occurrences} occurrences; provide more surrounding context or pass replace_all: true`,
            )
          }
          const updated = replaceAll
            ? parts.join(newNormalized)
            : `${parts[0]}${newNormalized}${parts.slice(1).join(oldNormalized)}`
          const count = replaceAll ? occurrences : 1
          if (updated === raw) {
            return { output: 'Document already matches the replacement text.', summary: 'No changes needed' }
          }
          deps.replaceText(updated)
          return {
            output: `Replaced ${count} occurrence${count > 1 ? 's' : ''}.`,
            mutated: true,
            summary: `Replaced ${count} occurrence${count > 1 ? 's' : ''}`,
          }
        }

        case 'edit_lines': {
          const startLine = Number(input.start_line)
          const endLine = Number(input.end_line)
          const newText = typeof input.new_text === 'string' ? input.new_text : null
          if (
            !Number.isInteger(startLine) ||
            !Number.isInteger(endLine) ||
            startLine < 1 ||
            endLine < startLine ||
            startLine > lines.length ||
            endLine > lines.length
          ) {
            return errResult(
              call.name,
              `Invalid line range [${startLine}, ${endLine}] for ${lines.length} lines`,
            )
          }
          if (newText === null) return errResult(call.name, 'new_text must be a string')
          const insertLines = newText === '' ? [] : newText.replace(/\r\n/g, '\n').split('\n')
          const nextLines = [
            ...lines.slice(0, startLine - 1),
            ...insertLines,
            ...lines.slice(endLine),
          ]
          const updated = nextLines.join(eol)
          if (updated === raw) {
            return { output: 'No changes made.', summary: 'No changes needed' }
          }
          deps.replaceText(updated)
          return {
            output: `Updated lines ${startLine}-${endLine}.`,
            mutated: true,
            summary: `Edited lines ${startLine}-${endLine}`,
          }
        }

        case 'write_text': {
          const content = typeof input.content === 'string' ? input.content : null
          if (content === null) return errResult(call.name, 'content must be a string')
          const updated = raw.length > 0 ? normalizeEol(content, eol) : content
          if (updated === raw) {
            return { output: 'Document already matches the new content.', summary: 'No changes needed' }
          }
          deps.replaceText(updated)
          return {
            output: `Wrote ${splitLines(updated).length} lines (${updated.length} chars).`,
            mutated: true,
            summary: `Wrote ${updated.length} chars`,
          }
        }

        default:
          return errResult(call.name, `unknown plain-text tool "${call.name}"`)
      }
    },
  }
}
