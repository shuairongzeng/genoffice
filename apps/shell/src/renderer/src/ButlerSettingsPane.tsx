import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { htmlLang } from '@genoffice/i18n'
import {
  mergeButlerPrefs,
  normalizeButlerPrefs,
  sameButlerPrefs,
  type ButlerPrefs,
  type ButlerPrefsPatch,
  type ButlerWorkerThinkingEffort,
} from '../../shared/butler-prefs'
import {
  DEFAULT_OMLX_STT_MODEL,
  DEFAULT_OMLX_TTS_MODEL,
  PRESET_OMLX_VOICES,
  mergeButlerVoiceConfig,
  normalizeButlerVoiceConfig,
  sameButlerVoiceConfig,
  type ButlerSttLanguage,
  type ButlerVoiceCloneState,
  type ButlerVoiceConfig,
  type ButlerVoiceConfigPatch,
  type ButlerVoiceProbeResult,
  type ButlerVoiceProvider,
} from '../../shared/butler-voice-api'
import type { SystemPresenceSettings } from '../../shared/home-api'
import { uint8ToBase64 } from './butler-audio-dsp'
import {
  getButlerSpeechState,
  listVoices,
  speakButler,
  speakButlerSmart,
  startButlerMicCapture,
  stopButlerSpeech,
  subscribeButlerSpeechState,
  type ButlerMicCaptureHandle,
  type ButlerSpeechState,
} from './butler-voice'
import { acceleratorFromKeyEvent, formatHotkeyParts, hotkeyPresets } from './hotkey-recorder'
import { useI18n, type TFunc } from './locale'
import './butler-settings.css'

type TextFieldKey = 'name' | 'honorific' | 'userName'
type TextDrafts = Record<TextFieldKey, string | null>

type VoiceTextFieldKey =
  | 'baseUrl'
  | 'apiKey'
  | 'ttsInstructions'
  | 'cloneRefText'
  | 'wakeAliases'
type VoiceTextDrafts = Record<VoiceTextFieldKey, string | null>

const STT_LANGUAGE_OPTIONS: readonly { readonly value: ButlerSttLanguage; readonly label: string }[] = [
  { value: 'zh', label: '中文 (zh)' },
  { value: 'en', label: 'English (en)' },
  { value: 'ja', label: '日本語 (ja)' },
  { value: 'ko', label: '한국어 (ko)' },
]

const CLONE_MAX_RECORD_MS = 10_000

function detectIsMac(): boolean {
  return typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac')
}

function primarySubtag(tag: string): string {
  return tag.trim().toLowerCase().split(/[-_]/)[0] ?? ''
}

function uniqueNonEmpty(items: readonly (string | undefined | null)[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of items) {
    const trimmed = typeof item === 'string' ? item.trim() : ''
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

async function readFileAsBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') {
    const buf = await file.arrayBuffer()
    return new Uint8Array(buf)
  }
  if (typeof Response !== 'undefined') {
    const buf = await new Response(file).arrayBuffer()
    return new Uint8Array(buf)
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const res = reader.result
      if (res instanceof ArrayBuffer) {
        resolve(new Uint8Array(res))
      } else {
        reject(new Error('Failed to read file bytes'))
      }
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.readAsArrayBuffer(file)
  })
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
 * recorder, persona identity, proactive notification controls, oMLX/system TTS
 * & STT engine, voice cloning, and hands-free wake-word controls.
 */
export function ButlerSettingsPane({ t }: { t: TFunc }): React.JSX.Element {
  const { lang } = useI18n()
  const tRef = useRef(t)
  tRef.current = t

  const [prefs, setPrefs] = useState<ButlerPrefs>(() => normalizeButlerPrefs(undefined))
  const prefsRef = useRef<ButlerPrefs>(prefs)
  prefsRef.current = prefs
  const hydratedOrMutatedRef = useRef(false)

  const [voiceConfig, setVoiceConfig] = useState<ButlerVoiceConfig>(() =>
    normalizeButlerVoiceConfig(undefined),
  )
  const voiceConfigRef = useRef<ButlerVoiceConfig>(voiceConfig)
  voiceConfigRef.current = voiceConfig
  const voiceHydratedOrMutatedRef = useRef(false)
  const voiceSaveSeqRef = useRef(0)

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

  const [voiceDrafts, setVoiceDrafts] = useState<VoiceTextDrafts>({
    baseUrl: null,
    apiKey: null,
    ttsInstructions: null,
    cloneRefText: null,
    wakeAliases: null,
  })
  const voiceDraftsRef = useRef<VoiceTextDrafts>(voiceDrafts)
  voiceDraftsRef.current = voiceDrafts

  const [maxPerHourDraft, setMaxPerHourDraft] = useState<string | null>(null)
  const maxPerHourDraftRef = useRef<string | null>(maxPerHourDraft)
  maxPerHourDraftRef.current = maxPerHourDraft

  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [voicesLoaded, setVoicesLoaded] = useState(false)

  const [showApiKey, setShowApiKey] = useState(false)
  const [probing, setProbing] = useState(false)
  const [probeResult, setProbeResult] = useState<ButlerVoiceProbeResult | null>(null)
  const [probedSttModels, setProbedSttModels] = useState<string[]>([])
  const [probedTtsModels, setProbedTtsModels] = useState<string[]>([])
  const [probedVoices, setProbedVoices] = useState<string[]>([])

  const [cloneState, setCloneState] = useState<ButlerVoiceCloneState | null>(null)
  const [cloneRecording, setCloneRecording] = useState(false)
  const [cloneRecordLevel, setCloneRecordLevel] = useState(0)
  const [cloneBusy, setCloneBusy] = useState(false)
  const [cloneError, setCloneError] = useState<string | null>(null)
  const [speechState, setSpeechState] = useState<ButlerSpeechState>(() => getButlerSpeechState())

  const aliveRef = useRef(true)
  const cloneMicHandleRef = useRef<ButlerMicCaptureHandle | null>(null)
  const cloneRecordTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cloneFileInputRef = useRef<HTMLInputElement | null>(null)

  const clearCloneTimer = useCallback(() => {
    if (cloneRecordTimerRef.current !== null) {
      clearTimeout(cloneRecordTimerRef.current)
      cloneRecordTimerRef.current = null
    }
  }, [])

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

    if (typeof api?.getButlerVoiceConfig === 'function') {
      void api
        .getButlerVoiceConfig()
        .then((loaded) => {
          if (!aliveRef.current || voiceHydratedOrMutatedRef.current) return
          const next = normalizeButlerVoiceConfig(loaded)
          voiceConfigRef.current = next
          setVoiceConfig(next)
        })
        .catch(() => undefined)
    }

    const offVoiceConfig = api?.onButlerVoiceConfigChanged?.((incoming) => {
      if (!aliveRef.current) return
      voiceHydratedOrMutatedRef.current = true
      const next = normalizeButlerVoiceConfig(incoming)
      voiceConfigRef.current = next
      setVoiceConfig(next)
    })

    if (typeof api?.butlerVoiceCloneGet === 'function') {
      void api
        .butlerVoiceCloneGet()
        .then((state) => {
          if (aliveRef.current && state) setCloneState(state)
        })
        .catch(() => undefined)
    }

    if (typeof api?.getSystemPresence === 'function') {
      void api
        .getSystemPresence()
        .then((sp) => {
          if (aliveRef.current && sp) setPresence(sp)
        })
        .catch(() => undefined)
    }

    const offSpeech = subscribeButlerSpeechState((next) => {
      if (aliveRef.current) setSpeechState(next)
    })

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
      offVoiceConfig?.()
      offSpeech()
      clearCloneTimer()
      cloneMicHandleRef.current?.stop(false)
      cloneMicHandleRef.current = null
    }
  }, [clearCloneTimer])

  const commitButlerPrefs = useCallback((patch: ButlerPrefsPatch) => {
    hydratedOrMutatedRef.current = true
    const next = mergeButlerPrefs(prefsRef.current, patch)
    prefsRef.current = next
    setPrefs(next)
    const api = typeof window !== 'undefined' ? window.aiOffice : undefined
    void api?.setButlerPrefs?.(patch)?.catch?.(() => undefined)
  }, [])

  const commitVoiceConfig = useCallback((patch: ButlerVoiceConfigPatch) => {
    voiceHydratedOrMutatedRef.current = true
    const seq = ++voiceSaveSeqRef.current
    const next = mergeButlerVoiceConfig(voiceConfigRef.current, patch)
    voiceConfigRef.current = next
    setVoiceConfig(next)
    const api = typeof window !== 'undefined' ? window.aiOffice : undefined
    void api
      ?.setButlerVoiceConfig?.(patch)
      ?.then((persisted) => {
        if (!aliveRef.current || seq !== voiceSaveSeqRef.current || !persisted) return
        const normalized = normalizeButlerVoiceConfig(persisted)
        voiceConfigRef.current = normalized
        setVoiceConfig(normalized)
      })
      ?.catch?.(() => undefined)
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

  const commitVoiceDraft = useCallback(
    (field: VoiceTextFieldKey, rawOverride?: string) => {
      const draft = rawOverride ?? voiceDraftsRef.current[field]
      if (draft === null) return
      const nextDrafts = { ...voiceDraftsRef.current, [field]: null }
      voiceDraftsRef.current = nextDrafts
      setVoiceDrafts(nextDrafts)

      const merged = mergeButlerVoiceConfig(voiceConfigRef.current, { [field]: draft })
      if (!sameButlerVoiceConfig(voiceConfigRef.current, merged)) {
        commitVoiceConfig({ [field]: merged[field] })
      }
    },
    [commitVoiceConfig],
  )

  const clearVoiceDraft = useCallback((field: VoiceTextFieldKey) => {
    const nextDrafts = { ...voiceDraftsRef.current, [field]: null }
    voiceDraftsRef.current = nextDrafts
    setVoiceDrafts(nextDrafts)
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

  const handleProbeConnection = useCallback(async () => {
    if (probing) return
    const api = typeof window !== 'undefined' ? window.aiOffice : undefined
    if (typeof api?.butlerVoiceProbe !== 'function') return

    // Commit any active endpoint drafts first so the probed URL/key stay persisted.
    const pendingPatch: ButlerVoiceConfigPatch = {
      ...(voiceDraftsRef.current.baseUrl !== null
        ? { baseUrl: voiceDraftsRef.current.baseUrl }
        : {}),
      ...(voiceDraftsRef.current.apiKey !== null
        ? { apiKey: voiceDraftsRef.current.apiKey }
        : {}),
    }
    if (Object.keys(pendingPatch).length > 0) {
      const nextDrafts = { ...voiceDraftsRef.current, baseUrl: null, apiKey: null }
      voiceDraftsRef.current = nextDrafts
      setVoiceDrafts(nextDrafts)
      commitVoiceConfig(pendingPatch)
    }

    const current = voiceConfigRef.current
    setProbing(true)
    setProbeResult(null)
    try {
      const res = await api.butlerVoiceProbe({
        baseUrl: current.baseUrl,
        apiKey: current.apiKey,
        ttsModel: current.ttsModel,
      })
      if (!aliveRef.current || !res) return
      setProbeResult(res)
      if (res.ok) {
        setProbedSttModels([...res.sttModels])
        setProbedTtsModels([...res.ttsModels])
        setProbedVoices([...res.voices])

        const syncPatch: ButlerVoiceConfigPatch = {
          ...(res.sttModels.length > 0 &&
          !res.sttModels.includes(voiceConfigRef.current.sttModel)
            ? { sttModel: res.sttModels[0] }
            : {}),
          ...(res.ttsModels.length > 0 &&
          !res.ttsModels.includes(voiceConfigRef.current.ttsModel)
            ? { ttsModel: res.ttsModels[0] }
            : {}),
          ...(res.voices.length > 0 && !res.voices.includes(voiceConfigRef.current.ttsVoice)
            ? { ttsVoice: res.voices[0] }
            : {}),
        }
        if (Object.keys(syncPatch).length > 0) {
          commitVoiceConfig(syncPatch)
        }
      }
    } catch (err: unknown) {
      if (!aliveRef.current) return
      setProbeResult({
        ok: false,
        latencyMs: 0,
        sttModels: [],
        ttsModels: [],
        voices: [],
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      if (aliveRef.current) setProbing(false)
    }
  }, [commitVoiceConfig, probing])

  const uploadCloneAudio = useCallback(async (wavBytes: Uint8Array, fileName: string) => {
    const api = typeof window !== 'undefined' ? window.aiOffice : undefined
    if (typeof api?.butlerVoiceCloneSet !== 'function') return

    setCloneBusy(true)
    setCloneError(null)
    try {
      const refText = (
        voiceDraftsRef.current.cloneRefText ?? voiceConfigRef.current.cloneRefText
      ).trim()
      const updated = await api.butlerVoiceCloneSet({
        audioBase64: uint8ToBase64(wavBytes),
        fileName,
        refText,
      })
      if (!aliveRef.current) return
      voiceHydratedOrMutatedRef.current = true
      const normalized = normalizeButlerVoiceConfig(updated)
      voiceConfigRef.current = normalized
      setVoiceConfig(normalized)
      setCloneState({
        hasAudio: normalized.cloneHasAudio,
        fileName: normalized.cloneAudioName || fileName,
        byteLength: wavBytes.byteLength,
        updatedAt: Date.now(),
      })
    } catch (err: unknown) {
      if (!aliveRef.current) return
      setCloneError(err instanceof Error ? err.message : String(err))
    } finally {
      if (aliveRef.current) setCloneBusy(false)
    }
  }, [])

  const handleCloneFileChange = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = ''
      if (!file) return
      try {
        const bytes = await readFileAsBytes(file)
        if (!aliveRef.current) return
        await uploadCloneAudio(bytes, file.name)
      } catch (err: unknown) {
        if (!aliveRef.current) return
        setCloneError(err instanceof Error ? err.message : String(err))
      }
    },
    [uploadCloneAudio],
  )

  const handleToggleCloneRecord = useCallback(() => {
    if (cloneRecording) {
      clearCloneTimer()
      cloneMicHandleRef.current?.stop(true)
      cloneMicHandleRef.current = null
      setCloneRecording(false)
      setCloneRecordLevel(0)
      return
    }

    setCloneError(null)
    setCloneRecording(true)
    setCloneRecordLevel(0)

    const handle = startButlerMicCapture({
      silenceMs: 2500,
      maxDurationMs: CLONE_MAX_RECORD_MS,
      continuous: false,
      onLevel: (level) => {
        if (aliveRef.current) setCloneRecordLevel(level)
      },
      onSpeechSegment: (wavBytes) => {
        clearCloneTimer()
        cloneMicHandleRef.current = null
        if (!aliveRef.current) return
        setCloneRecording(false)
        setCloneRecordLevel(0)
        void uploadCloneAudio(wavBytes, 'mic-sample.wav')
      },
      onError: (msg) => {
        clearCloneTimer()
        cloneMicHandleRef.current = null
        if (!aliveRef.current) return
        setCloneRecording(false)
        setCloneRecordLevel(0)
        setCloneError(msg)
      },
    })

    cloneMicHandleRef.current = handle
    cloneRecordTimerRef.current = setTimeout(() => {
      cloneRecordTimerRef.current = null
      if (cloneMicHandleRef.current === handle) {
        cloneMicHandleRef.current = null
        handle.stop(true)
        if (aliveRef.current) {
          setCloneRecording(false)
          setCloneRecordLevel(0)
        }
      }
    }, CLONE_MAX_RECORD_MS + 200)
  }, [clearCloneTimer, cloneRecording, uploadCloneAudio])

  const handleClearClone = useCallback(async () => {
    const api = typeof window !== 'undefined' ? window.aiOffice : undefined
    if (typeof api?.butlerVoiceCloneClear !== 'function') return
    setCloneBusy(true)
    setCloneError(null)
    try {
      const updated = await api.butlerVoiceCloneClear()
      if (!aliveRef.current) return
      voiceHydratedOrMutatedRef.current = true
      const normalized = normalizeButlerVoiceConfig(updated)
      voiceConfigRef.current = normalized
      setVoiceConfig(normalized)
      setCloneState({
        hasAudio: false,
        fileName: '',
        byteLength: 0,
        updatedAt: null,
      })
    } catch (err: unknown) {
      if (!aliveRef.current) return
      setCloneError(err instanceof Error ? err.message : String(err))
    } finally {
      if (aliveRef.current) setCloneBusy(false)
    }
  }, [])

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

  const sttModelOptions = useMemo(
    () => uniqueNonEmpty([...probedSttModels, DEFAULT_OMLX_STT_MODEL, voiceConfig.sttModel]),
    [probedSttModels, voiceConfig.sttModel],
  )

  const ttsModelOptions = useMemo(
    () => uniqueNonEmpty([...probedTtsModels, DEFAULT_OMLX_TTS_MODEL, voiceConfig.ttsModel]),
    [probedTtsModels, voiceConfig.ttsModel],
  )

  const presetVoiceOptions = useMemo(
    () =>
      uniqueNonEmpty([
        ...(probedVoices.length > 0 ? probedVoices : PRESET_OMLX_VOICES),
        voiceConfig.ttsVoice,
      ]),
    [probedVoices, voiceConfig.ttsVoice],
  )

  const hasSelectedVoiceOption =
    prefs.voiceName === '' || sortedVoices.some((voice) => voice.name === prefs.voiceName)

  const hotkeyParts = presence ? formatHotkeyParts(presence.hotkey.accelerator, isMac) : []

  const isPreviewSpeaking = speechState.speaking && speechState.sourceId === 'settings-preview'

  const handlePreviewVoice = () => {
    if (isPreviewSpeaking) {
      stopButlerSpeech()
      return
    }

    const current = prefsRef.current
    const previewText = tRef.current('setButlerVoicePreviewText', {
      honorific: current.honorific,
      name: current.name,
    })
    const api = typeof window !== 'undefined' ? window.aiOffice : undefined
    if (typeof api?.butlerVoiceTtsStart === 'function') {
      const drafts = voiceDraftsRef.current
      const override: Partial<ButlerVoiceConfig> = {
        ...(drafts.baseUrl !== null ? { baseUrl: drafts.baseUrl } : {}),
        ...(drafts.apiKey !== null ? { apiKey: drafts.apiKey } : {}),
        ...(drafts.ttsInstructions !== null ? { ttsInstructions: drafts.ttsInstructions } : {}),
        ...(drafts.cloneRefText !== null ? { cloneRefText: drafts.cloneRefText } : {}),
      }
      void speakButlerSmart(previewText, {
        prefs: current,
        voiceConfig: voiceConfigRef.current,
        langTag: currentLangTag,
        sourceId: 'settings-preview',
        ...(Object.keys(override).length > 0 ? { configOverride: override } : {}),
      })
      return
    }

    speakButler(previewText, {
      rate: current.voiceRate,
      voiceName: current.voiceName,
      langTag: currentLangTag,
    })
  }

  const effectiveCloneHasAudio = voiceConfig.cloneHasAudio || cloneState?.hasAudio === true
  const effectiveCloneAudioName =
    cloneState?.fileName || voiceConfig.cloneAudioName || 'sample.wav'
  const effectiveCloneRefText = (voiceDrafts.cloneRefText ?? voiceConfig.cloneRefText).trim()
  const showCloneIncompleteWarning =
    voiceConfig.cloneEnabled && (!effectiveCloneHasAudio || effectiveCloneRefText.length === 0)
  const showSystemVoiceControls =
    voiceConfig.provider === 'system' || voiceConfig.fallbackToSystem === true

  const renderVoiceTextInput = ({
    field,
    id,
    label,
    placeholder,
    maxLength,
    type = 'text',
    extraButton,
  }: {
    field: VoiceTextFieldKey
    id: string
    label: string
    placeholder?: string
    maxLength: number
    type?: 'text' | 'password'
    extraButton?: React.JSX.Element
  }): React.JSX.Element => (
    <div className="set-field">
      <div className="set-field-text">
        <label className="set-field-label" htmlFor={id}>
          {label}
        </label>
      </div>
      <div className="butler-voice-input-group">
        <input
          id={id}
          type={type}
          className="set-input"
          maxLength={maxLength}
          placeholder={placeholder}
          value={voiceDrafts[field] ?? voiceConfig[field]}
          onFocus={() => {
            if (voiceDraftsRef.current[field] === null) {
              const nextDrafts = { ...voiceDraftsRef.current, [field]: voiceConfigRef.current[field] }
              voiceDraftsRef.current = nextDrafts
              setVoiceDrafts(nextDrafts)
            }
          }}
          onChange={(e) => {
            const nextDrafts = { ...voiceDraftsRef.current, [field]: e.target.value }
            voiceDraftsRef.current = nextDrafts
            setVoiceDrafts(nextDrafts)
          }}
          onBlur={(e) => commitVoiceDraft(field, e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commitVoiceDraft(field, e.currentTarget.value)
              e.currentTarget.blur()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              clearVoiceDraft(field)
              e.currentTarget.blur()
            }
          }}
        />
        {extraButton}
      </div>
    </div>
  )

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

      <section className="butler-section" aria-label={t('butlerSetReasoningTitle')}>
        <h4 className="set-pane-subtitle">{t('butlerSetReasoningTitle')}</h4>

        <SwitchRow
          label={t('butlerSetChiefFast')}
          description={t('butlerSetChiefFastDesc')}
          checked={prefs.chiefFastMode}
          onToggle={() => commitButlerPrefs({ chiefFastMode: !prefsRef.current.chiefFastMode })}
        />

        <div className="set-field set-field-top">
          <div className="set-field-text">
            <div className="set-field-stack">
              <label className="set-field-label" htmlFor="butler-worker-effort">
                {t('butlerSetWorkerEffort')}
              </label>
              <div className="set-field-desc">{t('butlerSetWorkerEffortDesc')}</div>
            </div>
          </div>
          <select
            id="butler-worker-effort"
            className="butler-select"
            aria-label={t('butlerSetWorkerEffort')}
            value={prefs.workerThinkingEffort}
            onChange={(e) =>
              commitButlerPrefs({
                workerThinkingEffort: e.target.value as ButlerWorkerThinkingEffort,
              })
            }
          >
            <option value="high">{t('setAiThinkingHigh')}</option>
            <option value="medium">{t('setAiThinkingMedium')}</option>
            <option value="low">{t('setAiThinkingLow')}</option>
            <option value="follow">{t('butlerSetWorkerEffortFollow')}</option>
          </select>
        </div>

        <SwitchRow
          label={t('butlerSetPlanConfirm')}
          description={t('butlerSetPlanConfirmDesc')}
          checked={prefs.planConfirmBeforeDispatch}
          onToggle={() =>
            commitButlerPrefs({
              planConfirmBeforeDispatch: !prefsRef.current.planConfirmBeforeDispatch,
            })
          }
        />
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
            <label className="set-field-label" htmlFor="butler-voice-engine">
              {t('setButlerVoiceEngine')}
            </label>
          </div>
          <select
            id="butler-voice-engine"
            className="butler-select"
            aria-label={t('setButlerVoiceEngine')}
            value={voiceConfig.provider}
            onChange={(e) =>
              commitVoiceConfig({ provider: e.target.value as ButlerVoiceProvider })
            }
          >
            <option value="omlx">{t('setButlerVoiceEngineOmlx')}</option>
            <option value="system">{t('setButlerVoiceEngineSystem')}</option>
          </select>
        </div>

        {voiceConfig.provider === 'omlx' && (
          <div className="butler-voice-panel" data-testid="butler-voice-omlx-panel">
            {renderVoiceTextInput({
              field: 'baseUrl',
              id: 'butler-voice-base-url',
              label: t('setButlerVoiceBaseUrl'),
              maxLength: 512,
            })}

            {renderVoiceTextInput({
              field: 'apiKey',
              id: 'butler-voice-api-key',
              label: t('setButlerVoiceApiKey'),
              maxLength: 256,
              type: showApiKey ? 'text' : 'password',
              extraButton: (
                <button
                  type="button"
                  className="set-btn"
                  data-testid="butler-voice-toggle-key-btn"
                  aria-label={showApiKey ? t('setButlerVoiceHideKey') : t('setButlerVoiceShowKey')}
                  onClick={() => setShowApiKey((prev) => !prev)}
                >
                  {showApiKey ? t('setButlerVoiceHideKey') : t('setButlerVoiceShowKey')}
                </button>
              ),
            })}

            <div className="butler-voice-probe-row">
              <button
                type="button"
                className="set-btn"
                data-testid="butler-voice-probe-btn"
                disabled={probing}
                onClick={() => void handleProbeConnection()}
              >
                {probing ? t('setButlerVoiceProbing') : t('setButlerVoiceProbe')}
              </button>

              {probeResult && (
                <span
                  className={`butler-voice-probe-status ${probeResult.ok ? 'is-ok' : 'is-err'}`}
                  data-testid="butler-voice-probe-status"
                  role="status"
                >
                  {probeResult.ok
                    ? t('setButlerVoiceProbeOk', {
                        ms: probeResult.latencyMs,
                        sttCount: probeResult.sttModels.length,
                        voiceCount: probeResult.voices.length,
                      })
                    : t('setButlerVoiceProbeFail', { error: probeResult.error || 'Unknown error' })}
                </span>
              )}
            </div>

            <div className="set-field">
              <div className="set-field-text">
                <label className="set-field-label" htmlFor="butler-voice-stt-model">
                  {t('setButlerVoiceSttModel')}
                </label>
              </div>
              <select
                id="butler-voice-stt-model"
                className="butler-select"
                aria-label={t('setButlerVoiceSttModel')}
                value={voiceConfig.sttModel}
                onChange={(e) => commitVoiceConfig({ sttModel: e.target.value })}
              >
                {sttModelOptions.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </div>

            <div className="set-field">
              <div className="set-field-text">
                <label className="set-field-label" htmlFor="butler-voice-stt-lang">
                  {t('setButlerVoiceSttLang')}
                </label>
              </div>
              <select
                id="butler-voice-stt-lang"
                className="butler-select"
                aria-label={t('setButlerVoiceSttLang')}
                value={voiceConfig.sttLanguage}
                onChange={(e) =>
                  commitVoiceConfig({ sttLanguage: e.target.value as ButlerSttLanguage })
                }
              >
                <option value="auto">{t('setButlerVoiceSttLangAuto')}</option>
                {STT_LANGUAGE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="set-field">
              <div className="set-field-text">
                <label className="set-field-label" htmlFor="butler-voice-tts-model">
                  {t('setButlerVoiceTtsModel')}
                </label>
              </div>
              <select
                id="butler-voice-tts-model"
                className="butler-select"
                aria-label={t('setButlerVoiceTtsModel')}
                value={voiceConfig.ttsModel}
                onChange={(e) => commitVoiceConfig({ ttsModel: e.target.value })}
              >
                {ttsModelOptions.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </div>

            <div className="set-field">
              <div className="set-field-text">
                <label className="set-field-label" htmlFor="butler-voice-preset">
                  {t('setButlerVoicePreset')}
                </label>
              </div>
              <div className="butler-voice-picker">
                <select
                  id="butler-voice-preset"
                  className="butler-select"
                  aria-label={t('setButlerVoicePreset')}
                  value={voiceConfig.ttsVoice}
                  onChange={(e) => commitVoiceConfig({ ttsVoice: e.target.value })}
                >
                  {presetVoiceOptions.map((voice) => (
                    <option key={voice} value={voice}>
                      {voice}
                    </option>
                  ))}
                </select>
                {!showSystemVoiceControls && (
                  <button
                    type="button"
                    className="set-btn"
                    data-testid="butler-voice-preview-btn"
                    onClick={handlePreviewVoice}
                  >
                    {isPreviewSpeaking
                      ? t('setButlerVoiceStopPreview')
                      : t('setButlerVoicePreview')}
                  </button>
                )}
              </div>
            </div>

            {renderVoiceTextInput({
              field: 'ttsInstructions',
              id: 'butler-voice-instructions',
              label: t('setButlerVoiceInstructions'),
              placeholder: t('setButlerVoiceInstructionsPlaceholder'),
              maxLength: 400,
            })}

            <div className="butler-voice-clone-card" data-testid="butler-voice-clone-card">
              <SwitchRow
                label={t('setButlerVoiceCloneTitle')}
                description={t('setButlerVoiceCloneDesc')}
                checked={voiceConfig.cloneEnabled}
                onToggle={() =>
                  commitVoiceConfig({ cloneEnabled: !voiceConfigRef.current.cloneEnabled })
                }
              />

              <div className="butler-voice-clone-toolbar">
                <span className="butler-voice-clone-status">
                  {effectiveCloneHasAudio
                    ? t('setButlerVoiceCloneReady', { name: effectiveCloneAudioName })
                    : t('setButlerVoiceCloneNoAudio')}
                </span>

                <div className="butler-voice-clone-actions">
                  <input
                    ref={cloneFileInputRef}
                    type="file"
                    accept=".wav,audio/wav"
                    className="butler-visually-hidden"
                    data-testid="butler-voice-clone-file-input"
                    onChange={(e) => void handleCloneFileChange(e)}
                  />
                  <button
                    type="button"
                    className="set-btn"
                    data-testid="butler-voice-clone-upload-btn"
                    disabled={cloneBusy || cloneRecording}
                    onClick={() => cloneFileInputRef.current?.click()}
                  >
                    {t('setButlerVoiceCloneUpload')}
                  </button>
                  <button
                    type="button"
                    className={`butler-record-btn${cloneRecording ? ' is-recording' : ''}`}
                    data-testid="butler-voice-clone-record-btn"
                    disabled={cloneBusy}
                    aria-pressed={cloneRecording}
                    onClick={handleToggleCloneRecord}
                  >
                    {cloneRecording
                      ? t('setButlerVoiceCloneStopRecord')
                      : t('setButlerVoiceCloneRecord')}
                  </button>
                  <button
                    type="button"
                    className="set-btn danger"
                    data-testid="butler-voice-clone-clear-btn"
                    disabled={cloneBusy || cloneRecording || !effectiveCloneHasAudio}
                    onClick={() => void handleClearClone()}
                  >
                    {t('setButlerVoiceCloneClear')}
                  </button>
                </div>
              </div>

              {cloneRecording && (
                <div className="butler-voice-level-track" aria-hidden="true">
                  <div
                    className="butler-voice-level-fill"
                    style={{ transform: `scaleX(${Math.max(0.08, cloneRecordLevel)})` }}
                  />
                </div>
              )}

              {renderVoiceTextInput({
                field: 'cloneRefText',
                id: 'butler-voice-clone-ref-text',
                label: t('setButlerVoiceCloneRefText'),
                placeholder: t('setButlerVoiceCloneRefTextPlaceholder'),
                maxLength: 500,
              })}

              {showCloneIncompleteWarning && (
                <p
                  className="butler-voice-clone-warning"
                  data-testid="butler-voice-clone-warning"
                  role="status"
                >
                  {t('setButlerVoiceCloneWarnIncomplete')}
                </p>
              )}

              {cloneError && (
                <p className="butler-voice-clone-error" role="alert">
                  {cloneError}
                </p>
              )}
            </div>

            <SwitchRow
              label={t('setButlerVoiceFallback')}
              description={t('setButlerVoiceFallbackDesc')}
              checked={voiceConfig.fallbackToSystem}
              onToggle={() =>
                commitVoiceConfig({ fallbackToSystem: !voiceConfigRef.current.fallbackToSystem })
              }
            />
          </div>
        )}

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

        {showSystemVoiceControls && (
          <>
            {voiceConfig.provider === 'omlx' && (
              <p className="butler-voice-fallback-heading">
                {t('setButlerVoiceSystemFallbackLabel')}
              </p>
            )}
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
                <button
                  type="button"
                  className="set-btn"
                  data-testid="butler-voice-preview-btn"
                  onClick={handlePreviewVoice}
                >
                  {isPreviewSpeaking ? t('setButlerVoiceStopPreview') : t('setButlerVoicePreview')}
                </button>
              </div>
            </div>
            {voicesLoaded && voices.length === 0 && (
              <p className="set-field-desc">{t('setButlerVoiceNone')}</p>
            )}
          </>
        )}
      </section>

      <section className="butler-section" aria-label={t('setButlerWakeSection')}>
        <h4 className="set-pane-subtitle">{t('setButlerWakeSection')}</h4>

        <SwitchRow
          label={t('setButlerWakeEnabled')}
          description={t('setButlerWakeEnabledDesc', { name: prefs.name })}
          checked={voiceConfig.wakeWordEnabled}
          onToggle={() =>
            commitVoiceConfig({ wakeWordEnabled: !voiceConfigRef.current.wakeWordEnabled })
          }
        />

        {renderVoiceTextInput({
          field: 'wakeAliases',
          id: 'butler-wake-aliases',
          label: t('setButlerWakeAliases'),
          placeholder: t('setButlerWakeAliasesPlaceholder'),
          maxLength: 240,
        })}

        <SwitchRow
          label={t('setButlerHotkeyAutoListen')}
          description={t('setButlerHotkeyAutoListenDesc')}
          checked={voiceConfig.hotkeyAutoListen}
          onToggle={() =>
            commitVoiceConfig({ hotkeyAutoListen: !voiceConfigRef.current.hotkeyAutoListen })
          }
        />

        <SwitchRow
          label={t('setButlerAutoSpeakReplies')}
          description={t('setButlerAutoSpeakRepliesDesc')}
          checked={voiceConfig.autoSpeakReplies}
          onToggle={() =>
            commitVoiceConfig({ autoSpeakReplies: !voiceConfigRef.current.autoSpeakReplies })
          }
        />

        <div className="set-field">
          <div className="set-field-text">
            <label className="set-field-label" htmlFor="butler-vad-silence">
              {t('setButlerVadSilence')}
            </label>
          </div>
          <div className="butler-voice-rate-ctrl">
            <input
              id="butler-vad-silence"
              type="range"
              className="set-range"
              min={450}
              max={3000}
              step={50}
              value={voiceConfig.vadSilenceMs}
              aria-label={t('setButlerVadSilence')}
              onChange={(e) => {
                const raw = Number(e.target.value)
                if (Number.isFinite(raw)) {
                  commitVoiceConfig({ vadSilenceMs: Math.round(raw) })
                }
              }}
            />
            <span className="butler-voice-rate-val butler-vad-val">
              {`${voiceConfig.vadSilenceMs} ms`}
            </span>
          </div>
        </div>
      </section>
    </div>
  )
}
