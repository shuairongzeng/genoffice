import { describe, expect, it } from 'vitest'
import { strings } from '../src/renderer/i18n/strings'

/**
 * zh defines the key set, every sibling locale must cover it. The LangDicts
 * constraint at the `defineStrings(strings)` call already turns a missing key
 * into a compile error, but a type error names neither the locale nor the
 * key. These runtime checks read the shipped table directly, in the style of
 * apps/markdown/tests/i18n-key-parity.test.ts, so a drifting table fails CI
 * with a message that says exactly which keys moved.
 */

const LOCALES = Object.keys(strings) as Array<keyof typeof strings>

describe('browser strings — key parity', () => {
  it('every locale carries exactly the zh key set', () => {
    const reference = Object.keys(strings.zh).sort()
    expect(reference.length, 'zh defines the key set').toBeGreaterThan(0)
    for (const lang of LOCALES) {
      const keys = Object.keys(strings[lang]).sort()
      const missing = reference.filter((key) => !keys.includes(key))
      const extra = keys.filter((key) => !reference.includes(key))
      expect(
        missing,
        `${lang} is missing ${missing.length} key(s): ${missing.slice(0, 8).join(', ')}`,
      ).toEqual([])
      expect(
        extra,
        `${lang} carries ${extra.length} key(s) zh does not have: ${extra.slice(0, 8).join(', ')}`,
      ).toEqual([])
    }
  })

  it('no locale ships an empty label', () => {
    for (const lang of LOCALES) {
      for (const [key, value] of Object.entries(strings[lang])) {
        expect(value.length, `${lang}.${key} is an empty string`).toBeGreaterThan(0)
      }
    }
  })

  it('covers the locale set the other apps ship', () => {
    // drift here would silently strand a locale the suite supports
    expect(LOCALES.sort()).toEqual(
      [
        'zh',
        'en',
        'vi',
        'ja',
        'ko',
        'fr',
        'de',
        'es',
        'th',
        'id',
        'ru',
        'ar',
        'pt',
        'it',
        'pl',
        'cs',
        'nl',
        'ms',
        'he',
        'hi',
        'zh-TW',
      ].sort(),
    )
  })
})
