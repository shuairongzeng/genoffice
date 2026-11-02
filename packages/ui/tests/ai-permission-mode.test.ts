import { describe, expect, it } from 'vitest'
import { LANGS, type Lang } from '@genoffice/i18n'
import {
  AI_PERMISSION_MODES,
  DEFAULT_AI_PERMISSION_MODE,
  asAiPermissionMode,
  normalizeAiPermissionMode,
  sameAiPermissionMode,
  type AiPermissionMode,
} from '../src/ai-permission-mode'
import {
  AI_CONFIRM_LABELS,
  AI_SESSION_CONFIRM_LABELS,
  aiSessionConfirmLabels,
} from '../src/strings-ai-confirm'
import { AI_PERMISSION_MODE_STRINGS } from '../src/strings-ai-permission'

/**
 * The permission-mode value module and its copy tables: every locale the
 * picker serves carries a name and a one-line hint for each mode, and the
 * confirm card's session-worded variant stays a faithful overlay of the
 * shared labels (the editor apps' panels keep the base wording — their
 * session set really is per conversation).
 */

describe('the mode value', () => {
  it('offers exactly the three postures, smart the default', () => {
    expect([...AI_PERMISSION_MODES]).toEqual(['auto', 'smart', 'paranoid'])
    expect(DEFAULT_AI_PERMISSION_MODE).toBe('smart')
  })

  it('normalize clamps anything malformed to smart — never silently permissive', () => {
    expect(normalizeAiPermissionMode('auto')).toBe('auto')
    expect(normalizeAiPermissionMode('paranoid')).toBe('paranoid')
    expect(normalizeAiPermissionMode(undefined)).toBe('smart')
    expect(normalizeAiPermissionMode(42)).toBe('smart')
    expect(normalizeAiPermissionMode('yolo')).toBe('smart')
    expect(normalizeAiPermissionMode({ mode: 'auto' })).toBe('smart')
  })

  it('asAiPermissionMode answers null on anything the picker never offered', () => {
    expect(asAiPermissionMode('auto')).toBe('auto')
    expect(asAiPermissionMode('smart')).toBe('smart')
    expect(asAiPermissionMode('paranoid')).toBe('paranoid')
    expect(asAiPermissionMode(undefined)).toBeNull()
    expect(asAiPermissionMode('smart ')).toBeNull()
    expect(asAiPermissionMode(1)).toBeNull()
  })

  it('sameAiPermissionMode is the trivial one-field compare', () => {
    expect(sameAiPermissionMode('auto', 'auto')).toBe(true)
    expect(sameAiPermissionMode('auto', 'smart')).toBe(false)
  })
})

describe('AI_PERMISSION_MODE_STRINGS (i18n parity)', () => {
  it('every supported language carries the table, every mode a name and a hint', () => {
    for (const lang of LANGS) {
      const strings = AI_PERMISSION_MODE_STRINGS[lang]
      expect(strings, `locale ${lang}`).toBeDefined()
      for (const mode of AI_PERMISSION_MODES) {
        expect(strings.names[mode]?.trim(), `${lang} ${mode} name`).toBeTruthy()
        expect(strings.hints[mode]?.trim(), `${lang} ${mode} hint`).toBeTruthy()
      }
      expect(strings.title.trim()).toBeTruthy()
    }
  })

  it('covers no language the i18n table does not know', () => {
    const known = new Set<string>(LANGS)
    for (const lang of Object.keys(AI_PERMISSION_MODE_STRINGS)) {
      expect(known.has(lang), `unknown locale ${lang}`).toBe(true)
    }
    expect(Object.keys(AI_PERMISSION_MODE_STRINGS)).toHaveLength(LANGS.length)
  })
})

describe('the session-worded confirm labels', () => {
  it('every locale carries the variant pair', () => {
    for (const lang of LANGS) {
      const variant = AI_SESSION_CONFIRM_LABELS[lang as Lang]
      expect(variant?.allowSession?.trim(), `${lang} allowSession`).toBeTruthy()
      expect(variant?.allowedSessionNote?.trim(), `${lang} allowedSessionNote`).toBeTruthy()
    }
  })

  it('aiSessionConfirmLabels overlays only the session pair, stably per language', () => {
    for (const lang of LANGS) {
      const base = AI_CONFIRM_LABELS[lang]
      const labels = aiSessionConfirmLabels(lang)
      // the shell wording replaces the pair…
      expect(labels.allowSession).toBe(AI_SESSION_CONFIRM_LABELS[lang]!.allowSession)
      expect(labels.allowedSessionNote).toBe(AI_SESSION_CONFIRM_LABELS[lang]!.allowedSessionNote)
      // …and leaves every other field the shared table's
      expect(labels.title).toBe(base.title)
      expect(labels.argsLabel).toBe(base.argsLabel)
      expect(labels.allow).toBe(base.allow)
      expect(labels.deny).toBe(base.deny)
      // one stable object per language: memoized rows compare by identity
      expect(aiSessionConfirmLabels(lang)).toBe(labels)
    }
  })
})

describe('the mode table type-level shape', () => {
  it('the strings record keys every mode', () => {
    const names: Record<AiPermissionMode, string> = AI_PERMISSION_MODE_STRINGS.en.names
    expect(Object.keys(names).sort()).toEqual([...AI_PERMISSION_MODES].sort())
  })
})
