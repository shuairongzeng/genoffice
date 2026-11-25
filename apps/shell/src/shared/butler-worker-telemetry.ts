/**
 * Pure helpers for Butler worker role inference, telemetry secret redaction,
 * tool-call summary extraction, progress-note parsing, and health evaluation.
 *
 * Kept Electron-free and DOM-free so shared, main, preload, and renderer
 * bundles can import them with zero runtime side effects.
 */

import type {
  ButlerSubTaskStatus,
  ButlerWorkerHealth,
  ButlerWorkerRole,
} from './butler-orchestrator-api'

export const BUTLER_WORKER_ROLES = [
  'general',
  'files',
  'research',
  'docs',
  'sheets',
  'slides',
  'browser',
  'ops',
] as const

type SpecialistRole = Exclude<ButlerWorkerRole, 'general'>

const EXPLICIT_SPECIALIST_ROLES: ReadonlySet<string> = new Set(
  BUTLER_WORKER_ROLES.filter((role): role is SpecialistRole => role !== 'general'),
)

const ROLE_MATCH_ORDER: readonly SpecialistRole[] = [
  'files',
  'ops',
  'browser',
  'sheets',
  'slides',
  'docs',
  'research',
]

const ROLE_PATTERNS: Readonly<Record<SpecialistRole, readonly RegExp[]>> = {
  files: [
    /\u89c6\u9891|\u7535\u5f71|\u5f71\u7247|\u672c\u5730\u6587\u4ef6|\u672c\u673a\u6587\u4ef6|\u6587\u4ef6\u5939|\u76ee\u5f55|\u78c1\u76d8|\u4e0b\u8f7d\u76ee\u5f55|\u91cd\u547d\u540d/gi,
    /\.(?:mp4|mkv|avi|flac|mp3)\b/gi,
    /\b(?:scan disk|local files?|find videos?|videos?|folders?|movies?|rename files?|organize files?)\b/gi,
  ],
  ops: [
    /\u811a\u672c|\u7f16\u8bd1|\u6784\u5efa|\u6392\u9519|\u6392\u67e5|\u62a5\u9519|\u7ec8\u7aef|\u4ee3\u7801|\u8fdb\u7a0b|\u7aef\u53e3/gi,
    /\b(?:git|npm|pnpm|yarn|python|powershell|pwsh|bash|build|debug|debugging|script|scripts|compile|vitest|pytest)\b/gi,
  ],
  browser: [
    /\u6d4f\u89c8\u5668|\u7f51\u7ad9|\u7f51\u9875|\u7f51\u5740|\u5929\u6c14|\u65b0\u95fb|\u70ed\u641c|\u5b98\u7f51/gi,
    /https?:\/\//gi,
    /\b(?:browser|webpages?|websites?)\b/gi,
  ],
  sheets: [
    /\u8868\u683c|\u5de5\u4f5c\u7c3f|\u5bf9\u8d26|\u516c\u5f0f/gi,
    /\b(?:excel|xlsx|xls|csv|spreadsheets?|workbook)\b/gi,
  ],
  slides: [
    /\u5e7b\u706f\u7247|\u6f14\u793a\u6587\u7a3f/gi,
    /\b(?:ppt|pptx|slides?|deck|powerpoint|keynote)\b/gi,
  ],
  docs: [
    /\u6587\u6863|\u64b0\u5199|\u8d77\u8349\u62a5\u544a|\u6392\u7248/gi,
    /\b(?:word|docx|markdown)\b/gi,
  ],
  research: [
    /\u8c03\u7814|\u6df1\u5ea6\u68c0\u7d22|\u7efc\u8ff0|\u77e5\u8bc6\u5e93|\u5bf9\u6bd4\u5206\u6790/gi,
    /\b(?:research|investigate|investigation|literature review|fact[- ]check(?:ing)?)\b/gi,
  ],
}

const BEARER_SECRET_RE = /\bBearer\s+[^\s"',;)\]]+/gi
const SK_SECRET_RE = /(^|[^A-Za-z0-9_])sk-[A-Za-z0-9_-]{8,}/g
const KV_SECRET_RE =
  /(api[_-]?key|token|secret|password)["']?\s*[:=]\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s"'&;,)]+)/gi

const SHELL_TOOLS = new Set(['bash', 'powershell', 'pwsh', 'shell', 'exec', 'run_command'])
const FILE_TOOLS = new Set([
  'read',
  'write',
  'edit',
  'ls',
  'find',
  'grep',
  'read_file',
  'write_file',
  'edit_file',
  'list_dir',
  'find_by_name',
  'grep_search',
])

const HEREDOC_START_RE = /<<-?\s*(['"]?)([A-Za-z0-9_.-]+)\1/
const PS_HERESTRING_START_RE = /@(['"])\s*$/
const DEFAULT_TOOL_SUMMARY_MAX_LEN = 96
const DEFAULT_PROGRESS_NOTE_MAX_LEN = 110
const SLOW_STEP_MS = 45_000
const STALLED_STEP_MS = 90_000

function countDistinctMatches(text: string, patterns: readonly RegExp[]): number {
  if (!text) return 0
  const hits = new Set<string>()
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const token = match[0]?.toLowerCase()
      if (token) hits.add(token)
    }
  }
  return hits.size
}

/**
 * Infer a specialist worker role from an explicit role override or task title
 * and brief. Explicit non-general specialist roles are preserved as-is.
 */
export function inferButlerWorkerRole(input: {
  readonly role?: string | null
  readonly title?: string
  readonly brief?: string
}): ButlerWorkerRole {
  const explicit = typeof input.role === 'string' ? input.role.trim() : ''
  if (explicit && EXPLICIT_SPECIALIST_ROLES.has(explicit)) {
    return explicit as SpecialistRole
  }

  const title = typeof input.title === 'string' ? input.title : ''
  const brief = typeof input.brief === 'string' ? input.brief : ''
  if (!title.trim() && !brief.trim()) return 'general'

  let bestRole: ButlerWorkerRole = 'general'
  let bestScore = 0
  for (const role of ROLE_MATCH_ORDER) {
    const patterns = ROLE_PATTERNS[role]
    // Weight title cues higher than brief details when multiple domains appear.
    const score = countDistinctMatches(title, patterns) * 2 + countDistinctMatches(brief, patterns)
    if (score > bestScore) {
      bestScore = score
      bestRole = role
    }
  }
  return bestRole
}

/**
 * Redact bearer tokens, API keys, and credential assignments from telemetry text.
 */
export function redactTelemetrySecrets(text: string): string {
  if (!text) return ''
  return text
    .replace(BEARER_SECRET_RE, '***')
    .replace(SK_SECRET_RE, (_full, prefix: string) => `${prefix}***`)
    .replace(KV_SECRET_RE, '***')
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function truncateTelemetryText(text: string, maxLen: number): string {
  const safeMax = Number.isFinite(maxLen) ? Math.floor(maxLen) : 0
  if (safeMax <= 0) return ''
  if (text.length <= safeMax) return text
  if (safeMax === 1) return text.slice(0, 1)
  return `${text.slice(0, safeMax - 1).trimEnd()}…`
}

function sanitizeTelemetryValue(raw: string, maxLen: number): string {
  const collapsed = collapseWhitespace(redactTelemetrySecrets(raw))
  if (!collapsed) return ''
  return truncateTelemetryText(collapsed, maxLen)
}

function readFirstString(
  input: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const val = input[key]
    if (typeof val === 'string') {
      const trimmed = val.trim()
      if (trimmed) return trimmed
    }
  }
  return undefined
}

function isNoiseShellLine(line: string): boolean {
  if (!line) return true
  if (line.startsWith('#')) return true
  if (/^::\s|^rem\s/i.test(line)) return true
  if (/^set\s+-[a-z]+/i.test(line) || /^set\s+-o\s+\S+/i.test(line)) return true
  return false
}

function isClosingQuoteOnlyLine(line: string): boolean {
  return /^["'`});\s]+$/.test(line)
}

function unclosedTrailingQuote(line: string): '"' | "'" | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  const last = trimmed[trimmed.length - 1]
  if (last !== '"' && last !== "'") return null
  let count = 0
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] === last && trimmed[i - 1] !== '\\') {
      count += 1
    }
  }
  return count % 2 === 1 ? last : null
}

function isIncompleteLauncherLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false
  if (trimmed.endsWith('\\') || trimmed.endsWith('{')) return true
  return unclosedTrailingQuote(trimmed) !== null
}

function extractFirstCommandLine(command: string): string {
  const lines = command.replace(/\r\n/g, '\n').split('\n')
  const candidates: string[] = []
  let activeDelimiter: string | null = null
  let psHereQuote: string | null = null

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (activeDelimiter !== null) {
      if (trimmed === activeDelimiter) activeDelimiter = null
      continue
    }
    if (psHereQuote !== null) {
      if (trimmed.startsWith(`${psHereQuote}@`)) psHereQuote = null
      continue
    }

    const heredocMatch = HEREDOC_START_RE.exec(rawLine)
    if (heredocMatch) {
      activeDelimiter = heredocMatch[2]
      const cleaned = collapseWhitespace(rawLine.replace(HEREDOC_START_RE, ''))
      if (cleaned && !isNoiseShellLine(cleaned)) {
        candidates.push(cleaned)
      }
      continue
    }

    const psMatch = PS_HERESTRING_START_RE.exec(trimmed)
    if (psMatch) {
      psHereQuote = psMatch[1]
      const cleaned = trimmed.replace(PS_HERESTRING_START_RE, '').replace(/=\s*$/, '').trim()
      const isBareVarAssignment = /^\$[A-Za-z_][A-Za-z0-9_.:]*$/.test(cleaned)
      if (cleaned && !isBareVarAssignment && !isNoiseShellLine(cleaned)) {
        candidates.push(cleaned)
      }
      continue
    }

    if (trimmed) candidates.push(trimmed)
  }

  const firstIdx = candidates.findIndex((line) => !isNoiseShellLine(line))
  if (firstIdx === -1) return candidates[0] ?? ''

  const first = candidates[firstIdx]!
  if (!isIncompleteLauncherLine(first)) {
    return first
  }

  const bodyParts: string[] = []
  for (let i = firstIdx + 1; i < candidates.length && bodyParts.length < 2; i += 1) {
    const next = candidates[i]!
    if (isNoiseShellLine(next) || isClosingQuoteOnlyLine(next)) continue
    bodyParts.push(next.replace(/;\s*$/, ''))
  }
  if (bodyParts.length === 0) return first

  const openQuote = unclosedTrailingQuote(first)
  if (openQuote) {
    const joinedBody = bodyParts.join('; ').replace(new RegExp(`${openQuote}\\s*$`), '')
    return `${first}${joinedBody}${openQuote}`
  }
  const base = first.replace(/\\\s*$/, '').trimEnd()
  return `${base} ${bodyParts.join('; ')}`
}

function extractFileToolSummary(tool: string, input: Record<string, unknown>): string {
  const path = readFirstString(input, [
    'path',
    'file_path',
    'target_file',
    'SearchPath',
    'SearchDirectory',
    'directory',
  ])
  const pattern = readFirstString(input, ['pattern', 'Query', 'query', 'glob', 'Includes'])

  if ((tool === 'grep' || tool === 'grep_search' || tool === 'find' || tool === 'find_by_name') && pattern) {
    return path ? `${pattern} (${path})` : pattern
  }
  if (path) return path
  if (pattern) return pattern
  return ''
}

function formatFallbackInput(input: Record<string, unknown>): string {
  const preferred = readFirstString(input, [
    'path',
    'file_path',
    'url',
    'query',
    'q',
    'command',
    'cmd',
    'pattern',
    'selector',
    'title',
    'name',
  ])
  if (preferred) return preferred

  const cleanEntries: Record<string, unknown> = {}
  let hasKeys = false
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) {
      cleanEntries[k] = v
      hasKeys = true
    }
  }
  if (!hasKeys) return ''

  try {
    const serialized = JSON.stringify(cleanEntries)
    return serialized && serialized !== '{}' ? serialized : ''
  } catch {
    return ''
  }
}

/**
 * Produce a concise, single-line, secret-redacted summary of a worker tool call.
 */
export function summarizeWorkerToolCall(
  toolName: string,
  input?: Record<string, unknown> | null,
  maxLen = DEFAULT_TOOL_SUMMARY_MAX_LEN,
): string {
  if (!input || typeof input !== 'object' || Array.isArray(input) || maxLen <= 0) {
    return ''
  }

  const tool = toolName.trim().toLowerCase()
  let rawSummary = ''

  if (SHELL_TOOLS.has(tool)) {
    const cmd = readFirstString(input, ['command', 'CommandLine', 'cmd', 'script'])
    if (cmd) rawSummary = extractFirstCommandLine(cmd)
  } else if (FILE_TOOLS.has(tool)) {
    rawSummary = extractFileToolSummary(tool, input)
  } else if (tool.startsWith('browser')) {
    rawSummary = readFirstString(input, ['url', 'Url', 'query', 'selector']) ?? ''
  } else if (tool === 'search_files' || tool.startsWith('kb')) {
    const q = readFirstString(input, ['q', 'query'])
    const path = readFirstString(input, ['path'])
    rawSummary = q ? (path ? `${q} (${path})` : q) : path ?? ''
  }

  if (!rawSummary) {
    rawSummary = formatFallbackInput(input)
  }

  return rawSummary ? sanitizeTelemetryValue(rawSummary, maxLen) : ''
}

function stripMarkdownLineDecorators(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`+/g, '')
    .replace(/^\s*(?:#{1,6}\s+|>\s*|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)+/, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .trim()
}

function isMeaningfulNaturalLine(line: string): boolean {
  if (!line) return false
  if (/^[-=*_~|`.\s]+$/.test(line)) return false
  if (/^\|?(?:\s*:?-{2,}:?\s*\|)+\s*$/.test(line)) return false
  return /[\p{L}\p{N}]/u.test(line)
}

/**
 * Extract the latest meaningful natural-language line from a worker's clean
 * assistant text, ignoring fenced code blocks and markdown scaffolding.
 */
export function extractWorkerProgressNote(
  cleanTurnText: string,
  maxLen = DEFAULT_PROGRESS_NOTE_MAX_LEN,
): string {
  if (!cleanTurnText || !cleanTurnText.trim() || maxLen <= 0) return ''

  const lines = cleanTurnText.replace(/\r\n/g, '\n').split('\n')
  const candidateLines: string[] = []
  let activeFence: string | null = null

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed)
    if (fenceMatch) {
      const markerChar = fenceMatch[1][0]
      if (activeFence === null) {
        activeFence = markerChar
      } else if (activeFence === markerChar && trimmed === fenceMatch[1]) {
        activeFence = null
      }
      continue
    }
    if (activeFence !== null) continue

    const stripped = stripMarkdownLineDecorators(rawLine)
    if (isMeaningfulNaturalLine(stripped)) {
      candidateLines.push(stripped)
    }
  }

  for (let i = candidateLines.length - 1; i >= 0; i -= 1) {
    const cleaned = sanitizeTelemetryValue(candidateLines[i], maxLen)
    if (cleaned) return cleaned
  }
  return ''
}

/**
 * Classify a worker's execution health from its current status, active step
 * duration, and consecutive tool errors.
 */
export function evaluateWorkerHealth(input: {
  readonly status: ButlerSubTaskStatus
  readonly startedAt?: number
  readonly stepStartedAt?: number
  readonly consecutiveErrors?: number
  readonly now: number
}): ButlerWorkerHealth {
  if (input.status !== 'running') return 'normal'
  const errors = input.consecutiveErrors ?? 0
  const stepElapsed =
    input.stepStartedAt !== undefined && Number.isFinite(input.stepStartedAt)
      ? input.now - input.stepStartedAt
      : -1

  if (errors >= 3 || stepElapsed >= STALLED_STEP_MS) {
    return 'stalled'
  }
  if (errors >= 2 || stepElapsed >= SLOW_STEP_MS) {
    return 'slow'
  }
  return 'normal'
}
