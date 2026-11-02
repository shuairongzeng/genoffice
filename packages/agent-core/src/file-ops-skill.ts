import type { AgentToolDef } from './types'
import type { AgentSkill, ExecutedToolCall } from './skill'

/**
 * The dock's file operator skill: the panel's write powers over the text
 * files the knowledge base already reads — edit_file patches an existing
 * file (an exact old-string → new-string replacement, the one honest shape:
 * every edit is a visible minimal diff, never a silent whole-file rewrite),
 * delete_file moves one to the OS trash.
 *
 * Both are scoped main-side by the kb:read verdicts (starred / recent /
 * knowledge folder / indexed — the same rules open_path consults), so the
 * agent cannot reach an arbitrary absolute path the desktop never surfaced.
 * Risk grades: edit_file is 'high' (a file changes, but the change is a
 * reviewable diff and the session may always-allow it); delete_file is
 * 'always-ask' — destructive, gated on EVERY call, never session-allowed.
 *
 * The skill is storage-agnostic (the host injects the two operations, which
 * cross IPC into the shell main like the other kb tools); the deleteFile dep
 * runs only from this skill's executeTool, which the loop gates first — the
 * host's wiring marks the request `confirmed` there, and the main side
 * refuses any delete that arrives without it.
 */

export const EDIT_FILE_TOOL = 'edit_file'
export const DELETE_FILE_TOOL = 'delete_file'

/** keep in step with the main-process gate, which refuses larger patches */
export const MAX_EDIT_PATCH_CHARS = 100_000

export interface EditFileRequest {
  /** absolute path of the file to patch (the main side checks the scope) */
  path: string
  /** the exact text to replace — must occur once, or with replace_all at least once */
  oldString: string
  /** the replacement ('' deletes the old text) */
  newString: string
  /** replace every occurrence instead of requiring exactly one */
  replaceAll?: boolean
}

export interface EditFileResult {
  path: string
  /** how many occurrences were replaced */
  occurrences: number
  /** the file's size in bytes after the edit */
  bytes: number
}

export interface FileOpsDeps {
  editFile(request: EditFileRequest): Promise<EditFileResult>
  /**
   * Move one file to the OS trash. Called only from this skill's
   * executeTool — the code path that runs after the loop's always-ask gate
   * allowed the call — which is what lets the host's wiring truthfully mark
   * the request as confirmed.
   */
  deleteFile(path: string): Promise<{ path: string }>
}

const FILE_OPS_SYSTEM_PROMPT = `## Editing and deleting files
You can change the text files the knowledge base reads, not only answer
about them:
- edit_file patches an existing file: pass the exact text to replace
  (old_string) and its replacement (new_string). Read the file first
  (read_knowledge_file or the read tools) and quote it exactly — the match
  is literal. Include enough surrounding lines that old_string matches
  exactly one place; when the same text genuinely appears everywhere it
  should change, set replace_all to true. new_string may be empty to cut
  the old text out. The result says how many occurrences changed and the
  file's new size; only claim an edit after a successful result.
- delete_file moves one file to the OS trash. It asks the person every
  single time (it is destructive), so use it only when they asked for
  exactly that, and say where the file went. If they decline, do not retry.
Both tools accept only files the desktop already knows (starred, recent, in
a knowledge folder, or indexed); anything else is refused — ask the person
to handle those themselves.
NEITHER tool is for a file an app has open: the file on disk would fork
from the live document the person is looking at. A Word document open in a
tab goes through document_agent; other open kinds, tell the person to edit
them in their app. The main process refuses an edit to an open file with
the same instruction — the refusal is the routing, follow it.`

// a plain-past-tense claim about this run: "the file was deleted" as corpus
// history ("I deleted the old draft last week") still trips the guard — the
// same accepted false-positive the create-document skill's saved-claims
// guard has, and the loop applies a correction at most once, so it costs one
// extra turn and cannot loop
const CLAIMS_DELETED =
  /\bI(?:'ve| have)? deleted\b|\b(?:has been|is now) (?:deleted|moved to (?:the )?trash)\b|\bdeleted (?:it|the (?:file|document))\b|\bmoved (?:it|the (?:file|document)) to (?:the )?trash\b/i

export function createFileOpsSkill(deps: FileOpsDeps): AgentSkill {
  const tools: AgentToolDef[] = [
    {
      name: EDIT_FILE_TOOL,
      description:
        'Patch an existing text file (markdown, notes, code) with an exact ' +
        'old_string → new_string replacement. Read the file first and quote the text ' +
        'literally; old_string must match exactly one place (or set replace_all). ' +
        "Returns the number of occurrences replaced and the file's new size.",
      // a real file changes on disk: the host's confirmation card gates it
      risk: 'high',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'absolute path of the file to edit' },
          old_string: {
            type: 'string',
            description: 'the exact text to find (quote the file literally)',
          },
          new_string: { type: 'string', description: 'the replacement text (may be empty)' },
          replace_all: {
            type: 'boolean',
            description: 'replace every occurrence instead of requiring exactly one',
          },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
    {
      name: DELETE_FILE_TOOL,
      description:
        'Move one file to the OS trash (recoverable from the system trash). ' +
        'Destructive: the confirmation asks every time, with no always-allow. ' +
        'Use only when the person asked to delete this file; say where it went.',
      // destructive: gated on every call, never session-allowed
      risk: 'always-ask',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'absolute path of the file to delete' },
        },
        required: ['path'],
      },
    },
  ]
  return {
    id: 'file-ops',
    systemPrompt: FILE_OPS_SYSTEM_PROMPT,
    tools,
    executeTool: async (call) => {
      try {
        switch (call.name) {
          case EDIT_FILE_TOOL: {
            const path = call.input.path
            const oldString = call.input.old_string
            const newString = call.input.new_string
            const replaceAll = call.input.replace_all
            if (typeof path !== 'string' || !path.trim()) {
              return badInput('`path` must be a non-empty absolute path')
            }
            if (typeof oldString !== 'string' || oldString === '') {
              return badInput('`old_string` must be a non-empty string (quote the file exactly)')
            }
            if (typeof newString !== 'string') {
              return badInput('`new_string` must be a string (it may be empty)')
            }
            if (oldString === newString) {
              return badInput(
                '`old_string` and `new_string` are identical — an edit must change the text',
              )
            }
            if (oldString.length > MAX_EDIT_PATCH_CHARS) {
              return badInput(`\`old_string\` must be at most ${MAX_EDIT_PATCH_CHARS} characters`)
            }
            if (newString.length > MAX_EDIT_PATCH_CHARS) {
              return badInput(`\`new_string\` must be at most ${MAX_EDIT_PATCH_CHARS} characters`)
            }
            if (replaceAll !== undefined && typeof replaceAll !== 'boolean') {
              return badInput('`replace_all` must be a boolean when present')
            }
            const result = await deps.editFile({
              path,
              oldString,
              newString,
              ...(replaceAll === true ? { replaceAll: true } : {}),
            })
            const name = path.split(/[\\/]/).pop() ?? path
            return {
              output: `edited ${name}: replaced ${result.occurrences} occurrence${
                result.occurrences === 1 ? '' : 's'
              }, the file is now ${result.bytes} bytes\n  path: ${result.path}`,
              summary: `edited ${name}`,
              mutated: true,
            }
          }
          case DELETE_FILE_TOOL: {
            const path = call.input.path
            if (typeof path !== 'string' || !path.trim()) {
              return badInput('`path` must be a non-empty absolute path')
            }
            await deps.deleteFile(path)
            const name = path.split(/[\\/]/).pop() ?? path
            return {
              output: `moved ${name} to the OS trash (recoverable there)\n  path: ${path}`,
              summary: `deleted ${name}`,
              mutated: true,
            }
          }
          default:
            return {
              output: `unknown file-ops tool: ${call.name}`,
              isError: true,
              summary: call.name,
            }
        }
      } catch (error) {
        // the shell main's model-facing error (scope refusal, not found,
        // ambiguous match): the reason is the tool result
        return {
          output: error instanceof Error ? error.message : String(error),
          isError: true,
          summary: call.name,
        }
      }
    },
    verifyResponse: (finalText, executed: readonly ExecutedToolCall[]) => {
      const deleted = executed.some((c) => c.name === DELETE_FILE_TOOL && c.ok)
      if (deleted || !CLAIMS_DELETED.test(finalText)) return null
      return (
        'The reply says a file was deleted, but delete_file did not succeed in this run. ' +
        'Say plainly what actually happened (it may have been declined); only claim a deletion ' +
        'the tool reported.'
      )
    },
  }
}

function badInput(message: string) {
  return {
    output: `${message}; the tool was not executed. Call again with the corrected argument.`,
    isError: true,
    summary: 'file-ops tool input',
  }
}
