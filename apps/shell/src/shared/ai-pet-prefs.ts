/**
 * Persisted AI pet preferences shared across main, preload, Home, Settings, and
 * the document-mode overlay view (`app-settings.json` under the `aiPet` key).
 *
 * Kept Electron-free and DOM-free so main-process watchers, preload validators,
 * renderer panels, and unit tests all normalize against one exact contract.
 */

export const AI_PET_IDS = ['bluebird', 'cat', 'robot', 'fox', 'panda'] as const
export type AiPetId = (typeof AI_PET_IDS)[number]
export const DEFAULT_AI_PET_ID: AiPetId = 'bluebird'

export type AiPetBondStage = 'stranger' | 'familiar' | 'partner'

export const AI_PET_INTERACTION_MAX = 99_999

export interface AiPetPrefs {
  readonly petId: AiPetId
  readonly bubbles: boolean
  readonly sound: boolean
  readonly interactions: Readonly<Record<AiPetId, number>>
}

export interface AiPetPrefsPatch {
  readonly petId?: AiPetId
  readonly bubbles?: boolean
  readonly sound?: boolean
  readonly interactions?: Partial<Record<AiPetId, number>>
  /** Atomic main-side increment for one pet so concurrent surfaces never clobber counts */
  readonly incrementInteraction?: AiPetId
}

export function isAiPetId(value: unknown): value is AiPetId {
  return typeof value === 'string' && (AI_PET_IDS as readonly string[]).includes(value)
}

function clampInteractionCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.min(AI_PET_INTERACTION_MAX, Math.floor(value))
}

function normalizeInteractions(raw: unknown): Record<AiPetId, number> {
  const src = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<
    Record<AiPetId, unknown>
  >
  return {
    bluebird: clampInteractionCount(src.bluebird),
    cat: clampInteractionCount(src.cat),
    robot: clampInteractionCount(src.robot),
    fox: clampInteractionCount(src.fox),
    panda: clampInteractionCount(src.panda),
  }
}

/** Normalize raw `aiPet` settings into a safe, complete `AiPetPrefs` object. */
export function normalizeAiPetPrefs(value: unknown): AiPetPrefs {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Partial<{
    petId: unknown
    bubbles: unknown
    sound: unknown
    interactions: unknown
  }>
  return {
    petId: isAiPetId(raw.petId) ? raw.petId : DEFAULT_AI_PET_ID,
    bubbles: raw.bubbles !== false,
    sound: raw.sound !== false,
    interactions: normalizeInteractions(raw.interactions),
  }
}

/** Merge a renderer patch into stored `AiPetPrefs` with atomic increment support. */
export function mergeAiPetPrefs(current: AiPetPrefs, rawPatch: unknown): AiPetPrefs {
  const patch = (typeof rawPatch === 'object' && rawPatch !== null ? rawPatch : {}) as Partial<{
    petId: unknown
    bubbles: unknown
    sound: unknown
    interactions: unknown
    incrementInteraction: unknown
  }>
  const nextInteractions: Record<AiPetId, number> = { ...current.interactions }
  if (typeof patch.interactions === 'object' && patch.interactions !== null) {
    const incoming = patch.interactions as Partial<Record<AiPetId, unknown>>
    for (const id of AI_PET_IDS) {
      if (Object.hasOwn(incoming, id)) {
        nextInteractions[id] = clampInteractionCount(incoming[id])
      }
    }
  }
  if (isAiPetId(patch.incrementInteraction)) {
    const id = patch.incrementInteraction
    nextInteractions[id] = clampInteractionCount(nextInteractions[id] + 1)
  }
  return {
    petId: isAiPetId(patch.petId) ? patch.petId : current.petId,
    bubbles: typeof patch.bubbles === 'boolean' ? patch.bubbles : current.bubbles,
    sound: typeof patch.sound === 'boolean' ? patch.sound : current.sound,
    interactions: nextInteractions,
  }
}

export function bondStageForCount(count: number): AiPetBondStage {
  if (!Number.isFinite(count) || count < 5) return 'stranger'
  if (count < 20) return 'familiar'
  return 'partner'
}

export function sameAiPetPrefs(a: AiPetPrefs, b: AiPetPrefs): boolean {
  if (a.petId !== b.petId || a.bubbles !== b.bubbles || a.sound !== b.sound) return false
  for (const id of AI_PET_IDS) {
    if (a.interactions[id] !== b.interactions[id]) return false
  }
  return true
}
