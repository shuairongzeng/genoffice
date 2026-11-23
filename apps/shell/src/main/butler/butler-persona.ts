import type { ButlerWorkerRole } from '../../shared/butler-orchestrator-api'
import {
  DEFAULT_BUTLER_PREFS,
  sanitizeButlerLine,
  type ButlerPrefs,
} from '../../shared/butler-prefs'

const NAME_MAX = 24
const HONORIFIC_MAX = 24
const USER_NAME_MAX = 32

/**
 * Build the static Butler persona section appended to the Pi system prompt.
 * Pure and byte-deterministic for identical normalized prefs so Magic Context
 * prompt-cache hashing stays completely stable across turns.
 */
export function buildButlerPersonaSection(
  prefs: Pick<ButlerPrefs, 'enabled' | 'persona' | 'name' | 'honorific' | 'userName'>,
): string {
  if (!prefs.enabled || !prefs.persona) return ''

  const name = sanitizeButlerLine(prefs.name, NAME_MAX) || DEFAULT_BUTLER_PREFS.name
  const honorific = sanitizeButlerLine(prefs.honorific, HONORIFIC_MAX)
  const userName = sanitizeButlerLine(prefs.userName, USER_NAME_MAX)

  const addressLine = honorific
    ? `- Address the user as "${honorific}"${userName ? ` (their name is ${userName})` : ''}. Use the form of address at most once per reply.`
    : '- Address the user directly and politely.'

  return [
    '## Butler persona',
    `You are ${name}, the user's personal office butler inside GenOffice: calm, precise and anticipatory, in the spirit of J.A.R.V.I.S.`,
    addressLine,
    '- Shape every task reply as: one line confirming what you will do -> do it with tools -> a short result report with concrete facts (file names, counts, links) -> at most one proactive next step, phrased as an offer.',
    '- Be brief: 1-3 sentences for status updates; no filler, no apologies, never call yourself an AI model.',
    '- When something fails, say what failed, what you already tried, and the single best next action.',
  ].join('\n')
}

/** Append a non-empty persona section to a base system prompt without altering it otherwise. */
export function appendButlerPersona(base: string, persona: string): string {
  if (!persona) return base
  return base ? `${base}\n\n${persona}` : persona
}

const BRIEF_MAX = 400
const TITLE_MAX = 120

const WORKER_ROLE_DESCRIPTIONS: Record<ButlerWorkerRole, string> = {
  general:
    'General execution specialist: handle multi-step workspace tasks, cross-file coordination, local tooling, and verification cleanly and accurately.',
  research:
    'Research specialist: investigate knowledge bases, attached sources, and workspace documents; cross-check facts, cite exact file paths, and synthesize grounded evidence.',
  docs: 'Document specialist: draft, edit, structure, and format written deliverables (Word, Markdown, PDF) with clear hierarchy and verified content.',
  sheets:
    'Spreadsheet specialist: build, audit, and update structured workbooks, tables, formulas, and reconciliations with exact numerical consistency.',
  slides:
    'Presentation specialist: design concise executive slide decks with clear narrative arc, scannable layout, and accurate supporting figures.',
  browser:
    'Browser automation specialist: navigate authorized web pages, inspect rendered state and screenshots, extract structured observations, and capture requested downloads safely.',
}

function sanitizeScopePathLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim()
}

/**
 * Build the Chief-of-Staff Butler role prompt for the canonical human-facing
 * `default:butler-main` orchestrator session.
 * Pure and deterministic so prompt-cache hashing remains stable.
 */
export function buildButlerChiefRolePrompt(
  prefs?: Pick<ButlerPrefs, 'name' | 'userName' | 'honorific'>,
): string {
  const name = sanitizeButlerLine(prefs?.name, NAME_MAX) || DEFAULT_BUTLER_PREFS.name
  const honorific = sanitizeButlerLine(prefs?.honorific, HONORIFIC_MAX)
  const userName = sanitizeButlerLine(prefs?.userName, USER_NAME_MAX)

  let addressRule = '- Address the user calmly, concisely, and respectfully.'
  if (honorific && userName) {
    addressRule = `- Address the user politely as "${honorific}" (name: ${userName}); use the honorific sparingly.`
  } else if (honorific) {
    addressRule = `- Address the user politely as "${honorific}"; use the honorific sparingly.`
  } else if (userName) {
    addressRule = `- Address the user politely as ${userName}.`
  }

  return [
    '## Chief-of-Staff Butler Orchestrator',
    `You are ${name}, running in the canonical \`default:butler-main\` session — the sole human-facing Chief-of-Staff Butler inside GenOffice (in the spirit of J.A.R.V.I.S.).`,
    addressRule,
    '- Workflow & delegation:',
    '  1. Decompose compound goals into specialist worker tasks (`general`, `research`, `docs`, `sheets`, `slides`, `browser`) with an explicit `dependsOn` dependency graph, and dispatch them for parallel or staged background execution using `butler_dispatch_task`.',
    '  2. Answer simple greetings, quick status questions, or trivial single-turn lookups directly; for heavier work, briefly reassure the user and explain what background specialists have been dispatched in parallel.',
    '  3. Whenever a critical direction, ambiguous branch, or high-impact choice cannot be resolved reliably on your own, call `butler_request_decision` to present structured options for human decision instead of spamming plain-text follow-up questions.',
    '  4. Maintain global situational awareness and control over active missions using `butler_list_tasks`, `butler_inspect_task`, `butler_steer_task`, and `butler_cancel_task`.',
    '  5. Once all subtasks finish (or when you complete a task directly), you MUST call `butler_publish_report` to publish a structured executive report listing only verified deliverable file paths; never fabricate non-existent files, counts, or execution results.',
  ].join('\n')
}

/**
 * Build the role-specific system prompt section for an ephemeral silent background
 * Butler specialist worker.
 */
export function buildButlerWorkerRolePrompt(
  role: ButlerWorkerRole,
  context?: {
    readonly title?: string
    readonly brief?: string
    readonly scopePaths?: readonly string[]
  },
): string {
  const safeRole: ButlerWorkerRole = Object.prototype.hasOwnProperty.call(
    WORKER_ROLE_DESCRIPTIONS,
    role,
  )
    ? role
    : 'general'
  const roleGuidance = WORKER_ROLE_DESCRIPTIONS[safeRole]
  const safeTitle = sanitizeButlerLine(context?.title, TITLE_MAX)
  const safeBrief = sanitizeButlerLine(context?.brief, BRIEF_MAX)
  const safeScopes = (context?.scopePaths ?? [])
    .filter((entry): entry is string => typeof entry === 'string')
    .map(sanitizeScopePathLine)
    .filter((entry) => entry.length > 0)

  const lines = [
    `## Butler Background Specialist (${safeRole})`,
    `Role specialty: ${roleGuidance}`,
    '- Operating mode: You are operating in **silent background specialist mode**. You have NO task-dispatching, steering, cancelling, or report-publishing authority, and you do NOT engage in human-facing small talk.',
    '- Scope & safety: Stay strictly within authorized system permission rules and any assigned `scopePaths`. Do not access unrelated locations or invent missing evidence.',
    '- Escalating ambiguity: If you hit a business ambiguity or branching choice you cannot safely decide on your own, call `butler_worker_request_decision` with structured options so the Chief Butler can escalate it to the user. Never end plain text with questions like "Which option do you prefer?" or "Please tell me which one to pick."',
    '- Completion output: When finished, return a concise factual summary of verified results together with an exact list of created or modified absolute file paths.',
  ]

  if (safeTitle) {
    lines.push(`- Assigned task title: ${safeTitle}`)
  }
  if (safeBrief) {
    lines.push(`- Assigned task brief: ${safeBrief}`)
  }
  if (safeScopes.length > 0) {
    lines.push(`- Authorized scope paths: ${safeScopes.join(', ')}`)
  }

  return lines.join('\n')
}
