/**
 * Offline system speech synthesis helpers for Butler briefings and task completion
 * reports. Built solely on `window.speechSynthesis` with graceful degradation
 * when speech APIs or system voices are unavailable.
 */

export interface ButlerVoiceCandidate {
  readonly name: string
  readonly lang: string
  readonly localService?: boolean
}

const VOICES_WAIT_TIMEOUT_MS = 1500

function primaryLanguageSubtag(tag: string): string {
  return tag.trim().toLowerCase().split(/[-_]/)[0] ?? ''
}

function matchesPrimaryLanguage(voiceLang: string, primary: string): boolean {
  if (!primary) return false
  return primaryLanguageSubtag(voiceLang) === primary
}

/**
 * Pick the best system voice for the user's preference and current UI language:
 * 1) Exact match on `preferredName` when provided,
 * 2) Voice matching the primary language subtag (preferring `localService`),
 * 3) `null` when no match exists (let the OS pick its default).
 */
export function pickVoice<T extends ButlerVoiceCandidate>(
  voices: readonly T[],
  uiLangTag: string,
  preferredName: string,
): T | null {
  if (voices.length === 0) return null

  const trimmedName = preferredName.trim()
  if (trimmedName) {
    const exact = voices.find((voice) => voice.name === trimmedName)
    if (exact) return exact
  }

  const primary = primaryLanguageSubtag(uiLangTag)
  if (!primary) return null

  const matching = voices.filter((voice) => matchesPrimaryLanguage(voice.lang, primary))
  if (matching.length === 0) return null

  const local = matching.find((voice) => voice.localService === true)
  return local ?? matching[0] ?? null
}

/** Speak a butler announcement via `window.speechSynthesis`, cancelling any active utterance first. */
export function speakButler(
  text: string,
  opts: { rate: number; voiceName: string; langTag: string },
): void {
  const clean = text.trim()
  if (!clean) return
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
  if (typeof SpeechSynthesisUtterance === 'undefined') return

  const synth = window.speechSynthesis
  if (!synth || typeof synth.speak !== 'function') return

  try {
    synth.cancel()
    const utterance = new SpeechSynthesisUtterance(clean)
    const rate = Number.isFinite(opts.rate) ? Math.min(1.6, Math.max(0.7, opts.rate)) : 1
    utterance.rate = rate
    if (opts.langTag) utterance.lang = opts.langTag
    const voices = typeof synth.getVoices === 'function' ? synth.getVoices() : []
    const chosen = pickVoice(voices, opts.langTag, opts.voiceName)
    if (chosen) utterance.voice = chosen
    synth.speak(utterance)
  } catch {
    // Voice output is strictly best-effort; never surface TTS errors to callers.
  }
}

/** Resolve available system speech synthesis voices, waiting briefly for async population. */
export function listVoices(): Promise<SpeechSynthesisVoice[]> {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    return Promise.resolve([])
  }
  const synth = window.speechSynthesis
  if (!synth || typeof synth.getVoices !== 'function') {
    return Promise.resolve([])
  }

  const initial = synth.getVoices()
  if (initial.length > 0) {
    return Promise.resolve([...initial])
  }

  return new Promise<SpeechSynthesisVoice[]>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      synth.removeEventListener?.('voiceschanged', onChanged)
      try {
        resolve([...synth.getVoices()])
      } catch {
        resolve([])
      }
    }
    const onChanged = (): void => {
      finish()
    }
    const timer = setTimeout(finish, VOICES_WAIT_TIMEOUT_MS)
    synth.addEventListener?.('voiceschanged', onChanged)
  })
}
