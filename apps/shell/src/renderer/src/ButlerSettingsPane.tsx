import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { htmlLang } from '@genoffice/i18n'
import {
  mergeButlerPrefs,
  normalizeButlerPrefs,
  sameButlerPrefs,
  type ButlerPrefs,
  type ButlerPrefsPatch,
} from '../../shared/butler-prefs'
import type { SystemPresenceSettings } from '../../shared/home-api'
import { listVoices, speakButler } from './butler-voice'
import { acceleratorFromKeyEvent, formatHotkeyParts, hotkeyPresets } from './hotkey-recorder'
import { useI18n, type TFunc } from './locale'
import './butler-settings.css'

type TextFieldKey = 'name' | 'honorific' | 'userName'
type TextDrafts = Record<TextFieldKey, string | null>

function detectIsMac(): boolean {
  return typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac')
}

function primarySubtag(tag: string): string {
  return tag.trim().toLowerCase().split(/[-_]/)[0] ?? ''
}

function SwitchRow({
  label,
  description,
  checked,
  onToggle,
}: {
  label: string
  description: string
  checked: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <div className="set-field set-field-top">
      <div className="set-field-text">
        <div className="set-field-stack">
          <div className="set-field-label">{label}</div>
          <div className="set-field-desc">{description}</div>
        </div>
      </div>
      <button
        type="button"
        className="set-switch"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={onToggle}
      />
    </div>
  )
}

/**
 * SettingsModal -> AI Butler pane: master switch, summon shortcut presets &
 * recorder, persona identity, proactive notification controls, and TTS voice.
 */
export function ButlerSettingsPane({ t }: { t: TFunc }): React.JSX.Element {
  const { lang } = useI18n()

  const [prefs, setPrefs] = useState<ButlerPrefs>(() => normalizeButlerPrefs(undefined))
  const prefsRef = useRef<ButlerPrefs>(prefs)
  prefsRef.current = prefs
  const hydratedOrMutatedRef = useRef(false)

  const [presence, setPresence] = useState<SystemPresenceSettings | null>(null)
  const [recording, setRecording] = useState(false)
  const [recordInvalid, setRecordInvalid] = useState(false)

  const [textDrafts, setTextDrafts] = useState<TextDrafts>({
    name: null,
    honorific: null,
    userName: null,
  })
  const textDraftsRef = useRef<TextDrafts>(textDrafts)
  textDraftsRef.current = textDrafts

  const [maxPerHourDraft, setMaxPerHourDraft] = useState<string | null>(null)
  const maxPerHourDraftRef = useRef<string | null>(maxPerHourDraft)
  maxPerHourDraftRef.current = maxPerHourDraft

  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [voicesLoaded, setVoicesLoaded] = useState(false)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    const api = typeof window !== 'undefined' ? window.aiOffice : undefined

    if (typeof api?.getButlerPrefs === 'function') {
      void api
        .getButlerPrefs()
        .then((loaded) => {
          if (!aliveRef.current || hydratedOrMutatedRef.current) return
          const next = normalizeButlerPrefs(loaded)
          prefsRef.current = next
          setPrefs(next)
        })
        .catch(() => undefined)
    }

    const offButler = api?.onButlerPrefsChanged?.((incoming) => {
      if (!aliveRef.current) return
      hydratedOrMutatedRef.current = true
      const next = normalizeButlerPrefs(incoming)
      prefsRef.current = next
      setPrefs(next)
    })

    if (typeof api?.getSystemPresence === 'function') {
      void api
        .getSystemPresence()
        .then((sp) => {
          if (aliveRef.current && sp) setPresence(sp)
        })
        .catch(() => undefined)
    }

    void listVoices()
      .then((available) => {
        if (aliveRef.current) {
          setVoices(available)
          setVoicesLoaded(true)
        }
      })
      .catch(() => {
        if (aliveRef.current) setVoicesLoaded(true)
      })

    return () => {
      aliveRef.current = false
      offButler?.()
    }
  }, [])

  const commitButlerPrefs = useCallback((patch: ButlerPrefsPatch) => {
    hydratedOrMutatedRef.current = true
    const next = mergeButlerPrefs(prefsRef.current, patch)
    prefsRef.current = next
    setPrefs(next)
    const api = typeof window !== 'undefined' ? window.aiOffice : undefined
    void api?.setButlerPrefs?.(patch)?.catch?.(() => undefined)
  }, [])

  const applyHotkey = useCallback((patch: { enabled?: boolean; accelerator?: string }) => {
    const api = typeof window !== 'undefined' ? window.aiOffice : undefined
    if (typeof api?.setGlobalHotkey !== 'function') return
    void api
      .setGlobalHotkey(patch)
      .then((sp) => {
        if (aliveRef.current && sp) setPresence(sp)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!recording) return
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation?.()

      if (e.key === 'Escape') {
        setRecording(false)
        setRecordInvalid(false)
        return
      }

      const acc = acceleratorFromKeyEvent(e, detectIsMac())
      if (!acc) {
        setRecordInvalid(true)
        return
      }

      setRecordInvalid(false)
      setRecording(false)
      applyHotkey({ accelerator: acc })
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [recording, applyHotkey])

  const commitTextDraft = useCallback(
    (field: TextFieldKey, rawOverride?: string) => {
      const draft = rawOverride ?? textDraftsRef.current[field]
      if (draft === null) return
      const nextDrafts = { ...textDraftsRef.current, [field]: null }
      textDraftsRef.current = nextDrafts
      setTextDrafts(nextDrafts)

      const merged = mergeButlerPrefs(prefsRef.current, { [field]: draft })
      if (!sameButlerPrefs(prefsRef.current, merged)) {
        commitButlerPrefs({ [field]: merged[field] })
      }
    },
    [commitButlerPrefs],
  )

  const clearTextDraft = useCallback((field: TextFieldKey) => {
    const nextDrafts = { ...textDraftsRef.current, [field]: null }
    textDraftsRef.current = nextDrafts
    setTextDrafts(nextDrafts)
  }, [])

  const commitMaxPerHour = useCallback(
    (rawOverride?: string) => {
      const draft = rawOverride ?? maxPerHourDraftRef.current
      if (draft === null) return
      maxPerHourDraftRef.current = null
      setMaxPerHourDraft(null)

      const trimmed = draft.trim()
      if (!trimmed) return
      const parsed = Number(trimmed)
      if (!Number.isFinite(parsed)) return

      const clamped = Math.min(30, Math.max(1, Math.round(parsed)))
      if (clamped !== prefsRef.current.maxPerHour) {
        commitButlerPrefs({ maxPerHour: clamped })
      }
    },
    [commitButlerPrefs],
  )

  const isMac = detectIsMac()
  const currentLangTag = htmlLang(lang)

  const sortedVoices = useMemo(() => {
    const primary = primarySubtag(htmlLang(lang))
    return [...voices].sort((a, b) => {
      const aMatch = primary && primarySubtag(a.lang) === primary ? 0 : 1
      const bMatch = primary && primarySubtag(b.lang) === primary ? 0 : 1
      if (aMatch !== bMatch) return aMatch - bMatch
      return a.name.localeCompare(b.name)
    })
  }, [voices, lang])

  const hasSelectedVoiceOption =
    prefs.voiceName === '' || sortedVoices.some((voice) => voice.name === prefs.voiceName)

  const hotkeyParts = presence ? formatHotkeyParts(presence.hotkey.accelerator, isMac) : []

  const handlePreviewVoice = () => {
    const current = prefsRef.current
    speakButler(
      t('setButlerVoicePreviewText', { honorific: current.honorific, name: current.name }),
      {
        rate: current.voiceRate,
        voiceName: current.voiceName,
        langTag: currentLangTag,
      },
    )
  }

  return (
    <div className="butler-settings" data-testid="butler-settings-pane">
      <div className="butler-header">
        <h3 className="set-pane-title">{t('setSecButler')}</h3>
        <p className="butler-intro">{t('setButlerIntro')}</p>
      </div>

      <SwitchRow
        label={t('setButlerEnabled')}
        description={t('setButlerEnabledDesc')}
        checked={prefs.enabled}
        onToggle={() => commitButlerPrefs({ enabled: !prefsRef.current.enabled })}
      />

      {presence !== null && (
        <section className="butler-section" aria-label={t('setButlerHotkey')}>
          <SwitchRow
            label={t('setButlerHotkey')}
            description={t('setButlerHotkeyDesc')}
            checked={presence.hotkey.enabled}
            onToggle={() => {
              setRecording(false)
              setRecordInvalid(false)
              applyHotkey({ enabled: !presence.hotkey.enabled })
            }}
          />

          {presence.hotkey.enabled && (
            <div className="butler-hotkey-panel">
              <div className="butler-hotkey-top">
                <div className="butler-keycaps" aria-label={presence.hotkey.accelerator}>
                  {hotkeyParts.map((part, idx) => (
                    <span key={`${part}-${idx}`} className="butler-keycap-item">
                      {idx > 0 && (
                        <span className="butler-keycap-plus" aria-hidden="true">
                          +
                        </span>
                      )}
                      <kbd className="butler-kbd">{part}</kbd>
                    </span>
                  ))}
                </div>

                {presence.hotkeyActive && (
                  <span className="butler-hotkey-status is-active">
                    <span className="butler-hotkey-status-dot" aria-hidden="true" />
                    <span>{t('setButlerHotkeyActive')}</span>
                  </span>
                )}
              </div>

              <div className="butler-presets">
                {hotkeyPresets(isMac).map((preset, index) => {
                  const active = presence.hotkey.accelerator.toLowerCase() === preset.toLowerCase()
                  const label = formatHotkeyParts(preset, isMac).join('+')
                  return (
                    <button
                      key={preset}
                      type="button"
                      className={`butler-preset-chip${active ? ' is-active' : ''}`}
                      aria-pressed={active}
                      data-hotkey-preset={preset}
                      onClick={() => {
                        setRecording(false)
                        setRecordInvalid(false)
                        applyHotkey({ accelerator: preset })
                      }}
                    >
                      <span>{label}</span>
                      {index === 0 && (
                        <span className="butler-preset-badge">
                          {t('setButlerHotkeyRecommended')}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>

              <div className="butler-hotkey-actions">
                <button
                  type="button"
                  className={`butler-record-btn${recording ? ' is-recording' : ''}`}
                  aria-pressed={recording}
                  onClick={() => {
                    setRecordInvalid(false)
                    setRecording((prev) => !prev)
                  }}
                >
                  {recording ? t('setButlerHotkeyRecording') : t('setButlerHotkeyRecord')}
                </button>
                {recordInvalid && (
                  <span className="butler-hotkey-error" role="status">
                    {t('setButlerHotkeyInvalid')}
                  </span>
                )}
              </div>

              {!presence.hotkeyActive && (
                <div className="butler-hotkey-blocked">
                  <span>{t('setGlobalHotkeyBlocked')}</span>
                  <button
                    type="button"
                    className="set-btn"
                    onClick={() =>
                      applyHotkey({
                        enabled: true,
                        accelerator: presence.hotkey.accelerator,
                      })
                    }
                  >
                    {t('setGlobalHotkeyRetry')}
                  </button>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      <section className="butler-section" aria-label={t('setButlerPersona')}>
        <SwitchRow
          label={t('setButlerPersona')}
          description={t('setButlerPersonaDesc')}
          checked={prefs.persona}
          onToggle={() => commitButlerPrefs({ persona: !prefsRef.current.persona })}
        />

        {(
          [
            { key: 'name', id: 'butler-name-input', labelKey: 'setButlerName', maxLength: 24 },
            {
              key: 'honorific',
              id: 'butler-honorific-input',
              labelKey: 'setButlerHonorific',
              maxLength: 24,
            },
            {
              key: 'userName',
              id: 'butler-user-name-input',
              labelKey: 'setButlerUserName',
              maxLength: 32,
            },
          ] as const
        ).map(({ key, id, labelKey, maxLength }) => (
          <div key={key} className="set-field">
            <div className="set-field-text">
              <label className="set-field-label" htmlFor={id}>
                {t(labelKey)}
              </label>
            </div>
            <input
              id={id}
              type="text"
              className="set-input"
              maxLength={maxLength}
              value={textDrafts[key] ?? prefs[key]}
              onFocus={() => {
                if (textDraftsRef.current[key] === null) {
                  const nextDrafts = { ...textDraftsRef.current, [key]: prefsRef.current[key] }
                  textDraftsRef.current = nextDrafts
                  setTextDrafts(nextDrafts)
                }
              }}
              onChange={(e) => {
                const nextDrafts = { ...textDraftsRef.current, [key]: e.target.value }
                textDraftsRef.current = nextDrafts
                setTextDrafts(nextDrafts)
              }}
              onBlur={(e) => commitTextDraft(key, e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitTextDraft(key, e.currentTarget.value)
                  e.currentTarget.blur()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  clearTextDraft(key)
                  e.currentTarget.blur()
                }
              }}
            />
          </div>
        ))}
      </section>

      <section className="butler-section" aria-label={t('setButlerProactive')}>
        <h4 className="set-pane-subtitle">{t('setButlerProactive')}</h4>

        <SwitchRow
          label={t('setButlerBriefing')}
          description={t('setButlerBriefingDesc')}
          checked={prefs.briefing}
          onToggle={() => commitButlerPrefs({ briefing: !prefsRef.current.briefing })}
        />

        <SwitchRow
          label={t('setButlerNotifyDone')}
          description={t('setButlerNotifyDoneDesc')}
          checked={prefs.notifyDone}
          onToggle={() => commitButlerPrefs({ notifyDone: !prefsRef.current.notifyDone })}
        />

        <SwitchRow
          label={t('setButlerNotifyConfirm')}
          description={t('setButlerNotifyConfirmDesc')}
          checked={prefs.notifyConfirm}
          onToggle={() => commitButlerPrefs({ notifyConfirm: !prefsRef.current.notifyConfirm })}
        />

        <SwitchRow
          label={t('setButlerDnd')}
          description={t('setButlerDndDesc')}
          checked={prefs.dnd}
          onToggle={() => commitButlerPrefs({ dnd: !prefsRef.current.dnd })}
        />

        <div className="set-field">
          <div className="set-field-text">
            <label className="set-field-label" htmlFor="butler-max-per-hour">
              {t('setButlerMaxPerHour')}
            </label>
          </div>
          <label className="set-num">
            <input
              id="butler-max-per-hour"
              type="number"
              className="set-input set-num-input"
              min={1}
              max={30}
              step={1}
              value={maxPerHourDraft ?? String(prefs.maxPerHour)}
              onFocus={() => {
                if (maxPerHourDraftRef.current === null) {
                  const val = String(prefsRef.current.maxPerHour)
                  maxPerHourDraftRef.current = val
                  setMaxPerHourDraft(val)
                }
              }}
              onChange={(e) => {
                maxPerHourDraftRef.current = e.target.value
                setMaxPerHourDraft(e.target.value)
              }}
              onBlur={(e) => commitMaxPerHour(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitMaxPerHour(e.currentTarget.value)
                  e.currentTarget.blur()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  maxPerHourDraftRef.current = null
                  setMaxPerHourDraft(null)
                  e.currentTarget.blur()
                }
              }}
            />
            <span className="set-num-unit">{t('setButlerMaxPerHourUnit')}</span>
          </label>
        </div>
      </section>

      <section className="butler-section" aria-label={t('setButlerVoice')}>
        <SwitchRow
          label={t('setButlerVoice')}
          description={t('setButlerVoiceDesc')}
          checked={prefs.voice}
          onToggle={() => commitButlerPrefs({ voice: !prefsRef.current.voice })}
        />

        <div className="set-field">
          <div className="set-field-text">
            <label className="set-field-label" htmlFor="butler-voice-rate">
              {t('setButlerVoiceRate')}
            </label>
          </div>
          <div className="butler-voice-rate-ctrl">
            <input
              id="butler-voice-rate"
              type="range"
              className="set-range"
              min={0.7}
              max={1.6}
              step={0.1}
              value={prefs.voiceRate}
              aria-label={t('setButlerVoiceRate')}
              onChange={(e) => {
                const raw = Number(e.target.value)
                if (Number.isFinite(raw)) {
                  const rounded = Math.round(raw * 10) / 10
                  commitButlerPrefs({ voiceRate: rounded })
                }
              }}
            />
            <span className="butler-voice-rate-val">{`${prefs.voiceRate.toFixed(1)}×`}</span>
          </div>
        </div>

        <div className="set-field">
          <div className="set-field-text">
            <label className="set-field-label" htmlFor="butler-voice-name">
              {t('setButlerVoiceName')}
            </label>
          </div>
          <div className="butler-voice-picker">
            <select
              id="butler-voice-name"
              className="butler-select"
              value={prefs.voiceName}
              aria-label={t('setButlerVoiceName')}
              onChange={(e) => commitButlerPrefs({ voiceName: e.target.value })}
            >
              <option value="">{t('setButlerVoiceAuto')}</option>
              {!hasSelectedVoiceOption && (
                <option value={prefs.voiceName}>{prefs.voiceName}</option>
              )}
              {sortedVoices.map((voice) => (
                <option key={`${voice.name}::${voice.lang}`} value={voice.name}>
                  {voice.lang ? `${voice.name} (${voice.lang})` : voice.name}
                </option>
              ))}
            </select>
            <button type="button" className="set-btn" onClick={handlePreviewVoice}>
              {t('setButlerVoicePreview')}
            </button>
          </div>
        </div>
        {voicesLoaded && voices.length === 0 && (
          <p className="set-field-desc">{t('setButlerVoiceNone')}</p>
        )}
      </section>
    </div>
  )
}
