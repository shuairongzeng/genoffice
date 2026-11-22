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
