import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { htmlLang } from '@genoffice/i18n'
import type {
  ButlerBriefing,
  ButlerDecisionItem,
  ButlerDecisionOption,
  ButlerMicArbitrationState,
  ButlerMission,
  ButlerOpenTarget,
  ButlerSubmitError,
  ButlerTaskUpdate,
  ButlerVoiceConfig,
} from '../../shared/butler-api'
import {
  DEFAULT_BUTLER_PREFS,
  normalizeButlerPrefs,
  type ButlerPrefs,
} from '../../shared/butler-prefs'
import {
  DEFAULT_BUTLER_VOICE_CONFIG,
  normalizeButlerVoiceConfig,
} from '../../shared/butler-voice-api'
import type { HomeApi } from '../../shared/home-api'
import {
  isVoiceDismissPhrase,
  matchWakeWord,
  parseFollowUpTranscript,
  uint8ToBase64,
} from './butler-audio-dsp'
import {
  briefingLineKey,
  composeBriefingSpeech,
  formatAcceleratorKeycaps,
  greetingKey,
  statusLabelKey,
  stepLabelKey,
  upsertTask,
} from './butler-hud-model'
import {
  getButlerSpeechState,
  isButlerSpeakingOrEchoGuard,
  isButlerSpeechQueueBusy,
  playWakeEarcon,
  speakButlerSmart,
  startButlerMicCapture,
  stopButlerSpeech,
  subscribeButlerSpeechState,
  type ButlerMicCaptureHandle,
  type ButlerSpeechState,
} from './butler-voice'
import { useI18n } from './locale'
import './butler-hud.css'

const MAX_VISIBLE_TASKS = 4
const RESIZE_CARD_MARGIN_PX = 16
const WAKE_SENTINEL_SILENCE_MS = 700
const WAKE_SENTINEL_MAX_MS = 6000
const COMMAND_LISTEN_MAX_MS = 12000
export const FOLLOW_UP_WINDOW_MS = 300_000
const REPLY_WAIT_FALLBACK_MS = 60_000
const SILENT_TURN_RECOVERY_MS = 500
const FOLLOW_UP_RESUME_DELAY_MS = 260

const IS_MAC = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac')

function getAiOfficeApi(): Partial<HomeApi> | undefined {
  if (typeof window === 'undefined') return undefined
  return window.aiOffice as Partial<HomeApi> | undefined
}

function stripLeadingPunctuation(text: string): string {
  return text.replace(/^[，,、\s]+/, '').trim()
}

/** True when the shell renderer is loaded as the floating Butler HUD (`?view=butler-hud`). */
export function isButlerHudView(
  search: string = typeof window !== 'undefined' ? window.location.search : '',
): boolean {
  return new URLSearchParams(search).get('view') === 'butler-hud'
}

function ReactorGlyph({ running }: { running: boolean }): React.JSX.Element {
  return (
    <span className={`butler-hud-reactor${running ? ' is-running' : ''}`} aria-hidden="true">
      <svg className="butler-hud-reactor-svg" viewBox="0 0 24 24" fill="none">
        <circle
          cx="12"
          cy="12"
          r="9.5"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeOpacity="0.35"
        />
        <g className="butler-hud-reactor-arc">
          <path
            d="M12 2.5A9.5 9.5 0 0 1 20.22 7.25"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <path
            d="M12 21.5A9.5 9.5 0 0 1 3.78 16.75"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </g>
        <circle
          cx="12"
          cy="12"
          r="5.2"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeOpacity="0.7"
        />
        <circle cx="12" cy="12" r="2.2" fill="currentColor" />
      </svg>
    </span>
  )
}

function MicGlyph(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25" stroke="currentColor" strokeWidth="1.35" />
      <path
        d="M3.5 7.75a4.5 4.5 0 0 0 9 0M8 12.25v2M5.75 14.25h4.5"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
    </svg>
  )
}

function StopGlyph(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.6" fill="currentColor" />
    </svg>
  )
}

/**
 * Standalone renderer entry for the J.A.R.V.I.S.-style floating Butler command HUD
 * (`?view=butler-hud`). Renders the transparent floating card, syncs live prefs/tasks,
 * mounts the two-level wake sentinel, speaks announcements via oMLX/system TTS,
 * and reports content height.
 */
export function ButlerHudEntry(): React.JSX.Element {
  const { lang, t } = useI18n()
  const langRef = useRef(lang)
  langRef.current = lang
  const tRef = useRef(t)
  tRef.current = t

  const [prefs, setPrefs] = useState<ButlerPrefs>(DEFAULT_BUTLER_PREFS)
  const prefsRef = useRef<ButlerPrefs>(DEFAULT_BUTLER_PREFS)

  const [voiceConfig, setVoiceConfig] = useState<ButlerVoiceConfig>(DEFAULT_BUTLER_VOICE_CONFIG)
  const voiceConfigRef = useRef<ButlerVoiceConfig>(DEFAULT_BUTLER_VOICE_CONFIG)

  const [arbitration, setArbitration] = useState<ButlerMicArbitrationState>({
    deskMicActive: false,
    ttsSpeaking: false,
    updatedAt: 0,
  })
  const arbitrationRef = useRef<ButlerMicArbitrationState>(arbitration)
  arbitrationRef.current = arbitration

  const [speechState, setSpeechState] = useState<ButlerSpeechState>(() => getButlerSpeechState())

  const [hotkey, setHotkey] = useState<string | null>(null)
  const [briefing, setBriefing] = useState<ButlerBriefing | null>(null)
  const [tasks, setTasks] = useState<ButlerTaskUpdate[]>([])
  const [missions, setMissions] = useState<ButlerMission[]>([])
  const [pendingDecisions, setPendingDecisions] = useState<ButlerDecisionItem[]>([])
  const [resolvingDecisionIds, setResolvingDecisionIds] = useState<
    Readonly<Record<string, boolean>>
  >({})
  const [approvingPlanId, setApprovingPlanId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [activeListening, setActiveListening] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [micLevel, setMicLevel] = useState(0)
  const [sentinelActive, setSentinelActive] = useState(false)
  const [liveConversation, setLiveConversation] = useState(false)
  const [submitError, setSubmitError] = useState<{
    code: ButlerSubmitError
    message?: string
  } | null>(null)

  const aliveRef = useRef(true)
  const spokenDayKeyRef = useRef<string | null>(null)
  const lastCommandRef = useRef('')
  const lastHeightRef = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const activeCaptureRef = useRef<ButlerMicCaptureHandle | null>(null)
  const listenSessionRef = useRef(0)
  const activeListeningRef = useRef(false)
  const transcribingRef = useRef(false)
  const sentinelBusyRef = useRef(false)
  const conversationActiveRef = useRef(false)
  const awaitingReplyRef = useRef(false)
  const lastSubmitErrorRef = useRef<ButlerSubmitError | null>(null)
  const followUpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const replyFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const resumeListenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const silentTurnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hudHydratedFeedRef = useRef(false)
  const hudSeenFeedIdsRef = useRef<Set<string>>(new Set())
  const hudWasChiefBusyRef = useRef(false)
  const startActiveListenRef = useRef<(opts: { wakeAck: boolean; keepConversation?: boolean }) => Promise<void>>(
    async () => undefined,
  )

  useEffect(() => {
    document.body.classList.add('butler-hud-body')
    return () => {
      document.body.classList.remove('butler-hud-body')
    }
  }, [])

  const focusInput = useCallback(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const clearFollowUpTimer = useCallback(() => {
    if (followUpTimerRef.current !== null) {
      clearTimeout(followUpTimerRef.current)
      followUpTimerRef.current = null
    }
  }, [])

  const clearReplyFallbackTimer = useCallback(() => {
    if (replyFallbackTimerRef.current !== null) {
      clearTimeout(replyFallbackTimerRef.current)
      replyFallbackTimerRef.current = null
    }
  }, [])

  const clearResumeListenTimer = useCallback(() => {
    if (resumeListenTimerRef.current !== null) {
      clearTimeout(resumeListenTimerRef.current)
      resumeListenTimerRef.current = null
    }
  }, [])

  const clearSilentTurnTimer = useCallback(() => {
    if (silentTurnTimerRef.current !== null) {
      clearTimeout(silentTurnTimerRef.current)
      silentTurnTimerRef.current = null
    }
  }, [])

  const setConversationActive = useCallback((active: boolean) => {
    conversationActiveRef.current = active
    if (aliveRef.current) {
      setLiveConversation(active)
    }
  }, [])

  const submitCommandText = useCallback(async (rawText: string): Promise<boolean> => {
    const trimmed = rawText.trim()
    if (!trimmed) {
      lastSubmitErrorRef.current = 'empty'
      return false
    }
    const api = getAiOfficeApi()
    if (typeof api?.butlerSubmit !== 'function') {
      lastSubmitErrorRef.current = 'failed'
      return false
    }

    lastSubmitErrorRef.current = null
    setSubmitting(true)
    setSubmitError(null)
    try {
      const result = await api.butlerSubmit(trimmed)
      if (!aliveRef.current) return false
      if (result.ok) {
        lastCommandRef.current = trimmed
        lastSubmitErrorRef.current = null
        setInput('')
        setSubmitError(null)
        return true
      }
      lastSubmitErrorRef.current = result.error ?? 'failed'
      if (result.error && result.error !== 'empty') {
        setSubmitError({ code: result.error, message: result.message })
      }
      return false
    } catch (err: unknown) {
      if (!aliveRef.current) return false
      lastSubmitErrorRef.current = 'failed'
      const message = err instanceof Error ? err.message : ''
      setSubmitError({ code: 'failed', message })
      return false
    } finally {
      if (aliveRef.current) {
        setSubmitting(false)
      }
    }
  }, [])

  const stopActiveListen = useCallback(
    (flushPending = false) => {
      clearFollowUpTimer()
      listenSessionRef.current += 1
      if (getButlerSpeechState().sourceId === 'hud-wake-ack') {
        stopButlerSpeech()
      }
      const handle = activeCaptureRef.current
      activeCaptureRef.current = null
      activeListeningRef.current = false
      setActiveListening(false)
      setMicLevel(0)
      handle?.stop(flushPending)
    },
    [clearFollowUpTimer],
  )

  const endConversationSession = useCallback(
    (hideHud: boolean) => {
      setConversationActive(false)
      awaitingReplyRef.current = false
      clearFollowUpTimer()
      clearReplyFallbackTimer()
      clearResumeListenTimer()
      clearSilentTurnTimer()
      stopActiveListen(false)
      if (hideHud) {
        getAiOfficeApi()?.butlerHide?.()
      }
    },
    [
      clearFollowUpTimer,
      clearReplyFallbackTimer,
      clearResumeListenTimer,
      clearSilentTurnTimer,
      setConversationActive,
      stopActiveListen,
    ],
  )

  const armFollowUpTimer = useCallback(() => {
    clearFollowUpTimer()
    if (!aliveRef.current || !conversationActiveRef.current || !activeListeningRef.current) {
      return
    }
    followUpTimerRef.current = setTimeout(() => {
      followUpTimerRef.current = null
      if (!aliveRef.current) return
      if (activeListeningRef.current && conversationActiveRef.current) {
        endConversationSession(false)
      }
    }, FOLLOW_UP_WINDOW_MS)
  }, [clearFollowUpTimer, endConversationSession])

  const armReplyFallbackTimer = useCallback(() => {
    clearReplyFallbackTimer()
    awaitingReplyRef.current = true
    replyFallbackTimerRef.current = setTimeout(() => {
      replyFallbackTimerRef.current = null
      if (!aliveRef.current) return
      if (awaitingReplyRef.current && conversationActiveRef.current && !activeListeningRef.current) {
        if (
          !getButlerSpeechState().speaking &&
          !isButlerSpeechQueueBusy() &&
          !arbitrationRef.current.ttsSpeaking
        ) {
          endConversationSession(false)
        }
      }
    }, REPLY_WAIT_FALLBACK_MS)
  }, [clearReplyFallbackTimer, endConversationSession])

  const scheduleFollowUpListen = useCallback(
    (delayMs = FOLLOW_UP_RESUME_DELAY_MS) => {
      clearResumeListenTimer()
      if (
        !aliveRef.current ||
        !conversationActiveRef.current ||
        arbitrationRef.current.deskMicActive ||
        prefsRef.current.dnd ||
        !prefsRef.current.enabled
      ) {
        return
      }
      const attemptResume = (): void => {
        resumeListenTimerRef.current = null
        if (
          !aliveRef.current ||
          !conversationActiveRef.current ||
          activeListeningRef.current ||
          transcribingRef.current ||
          arbitrationRef.current.deskMicActive ||
          prefsRef.current.dnd ||
          !prefsRef.current.enabled
        ) {
          return
        }
        if (
          getButlerSpeechState().speaking ||
          isButlerSpeechQueueBusy() ||
          arbitrationRef.current.ttsSpeaking
        ) {
          return
        }
        if (isButlerSpeakingOrEchoGuard()) {
          resumeListenTimerRef.current = setTimeout(attemptResume, 80)
          return
        }
        void startActiveListenRef.current({ wakeAck: false, keepConversation: true })
      }
      resumeListenTimerRef.current = setTimeout(attemptResume, delayMs)
    },
    [clearResumeListenTimer],
  )

  const transcribeAndSubmitCommand = useCallback(
    async (wavBytes: Uint8Array) => {
      const api = getAiOfficeApi()
      if (typeof api?.butlerVoiceTranscribe !== 'function') return

      transcribingRef.current = true
      setTranscribing(true)
      const resumeConversationListen = (): void => {
        if (
          aliveRef.current &&
          conversationActiveRef.current &&
          !arbitrationRef.current.deskMicActive &&
          !prefsRef.current.dnd &&
          prefsRef.current.enabled
        ) {
          scheduleFollowUpListen(180)
        }
      }

      try {
        const res = await api.butlerVoiceTranscribe({
          wavBase64: uint8ToBase64(wavBytes),
          language: voiceConfigRef.current.sttLanguage,
          purpose: 'command',
        })
        if (!aliveRef.current) return
        if (res?.ok) {
          const parsed = parseFollowUpTranscript(
            res.text,
            prefsRef.current.name,
            voiceConfigRef.current.wakeAliases,
          )
          if (parsed.kind === 'dismiss') {
            playWakeEarcon('cancel')
            endConversationSession(true)
            return
          }
          if (parsed.kind === 'wake_only' || parsed.kind === 'empty') {
            resumeConversationListen()
            return
          }

          setInput(parsed.commandText)
          if (conversationActiveRef.current) {
            armReplyFallbackTimer()
          }
          const ok = await submitCommandText(parsed.commandText)
          if (!ok) {
            awaitingReplyRef.current = false
            clearReplyFallbackTimer()
            if (
              lastSubmitErrorRef.current !== 'disabled' &&
              lastSubmitErrorRef.current !== 'legacy'
            ) {
              resumeConversationListen()
            } else {
              setConversationActive(false)
            }
          }
        } else {
          awaitingReplyRef.current = false
          clearReplyFallbackTimer()
          if (res && !res.ok && res.error) {
            setSubmitError({ code: 'failed', message: res.error })
          }
          resumeConversationListen()
        }
      } catch (err: unknown) {
        if (!aliveRef.current) return
        awaitingReplyRef.current = false
        clearReplyFallbackTimer()
        setSubmitError({
          code: 'failed',
          message: err instanceof Error ? err.message : String(err),
        })
        resumeConversationListen()
      } finally {
        transcribingRef.current = false
        if (aliveRef.current) setTranscribing(false)
      }
    },
    [
      armReplyFallbackTimer,
      clearReplyFallbackTimer,
      endConversationSession,
      scheduleFollowUpListen,
      setConversationActive,
      submitCommandText,
    ],
  )

  const startActiveListen = useCallback(
    async (opts: { wakeAck: boolean; keepConversation?: boolean }) => {
      clearResumeListenTimer()
      clearReplyFallbackTimer()
      clearSilentTurnTimer()
      stopActiveListen(false)
      stopButlerSpeech()

      const session = ++listenSessionRef.current
      setConversationActive(opts.keepConversation ?? true)
      awaitingReplyRef.current = false
      activeListeningRef.current = true
      setActiveListening(true)
      setMicLevel(0)
      setSubmitError(null)
      playWakeEarcon('wake')

      const currentPrefs = prefsRef.current
      if (opts.wakeAck && currentPrefs.voice && !currentPrefs.dnd) {
        const ackSpeech = stripLeadingPunctuation(
          tRef.current('butlerVoiceWakeAckSpeech', { honorific: currentPrefs.honorific.trim() }),
        )
        if (ackSpeech) {
          await speakButlerSmart(ackSpeech, {
            prefs: currentPrefs,
            voiceConfig: voiceConfigRef.current,
            langTag: htmlLang(langRef.current),
            sourceId: 'hud-wake-ack',
          })
        }
      }

      if (!aliveRef.current || listenSessionRef.current !== session || !activeListeningRef.current) {
        return
      }

      const handle = startButlerMicCapture({
        continuous: false,
        silenceMs: voiceConfigRef.current.vadSilenceMs,
        maxDurationMs: COMMAND_LISTEN_MAX_MS,
        shouldSuppress: () => isButlerSpeakingOrEchoGuard() || arbitrationRef.current.ttsSpeaking,
        onVoiceActivity: (speaking) => {
          if (!aliveRef.current || listenSessionRef.current !== session) return
          if (speaking) {
            clearFollowUpTimer()
          } else if (activeListeningRef.current && conversationActiveRef.current) {
            armFollowUpTimer()
          }
        },
        onLevel: (lvl) => {
          if (aliveRef.current && listenSessionRef.current === session) {
            setMicLevel(lvl)
          }
        },
        onSpeechSegment: (wavBytes) => {
          if (!aliveRef.current || listenSessionRef.current !== session) return
          clearFollowUpTimer()
          activeCaptureRef.current = null
          activeListeningRef.current = false
          setActiveListening(false)
          setMicLevel(0)
          void transcribeAndSubmitCommand(wavBytes)
        },
        onError: (errMsg) => {
          if (!aliveRef.current || listenSessionRef.current !== session) return
          clearFollowUpTimer()
          clearSilentTurnTimer()
          setConversationActive(false)
          awaitingReplyRef.current = false
          activeCaptureRef.current = null
          activeListeningRef.current = false
          setActiveListening(false)
          setMicLevel(0)
          if (errMsg) {
            setSubmitError({ code: 'failed', message: errMsg })
          }
        },
      })

      if (aliveRef.current && listenSessionRef.current === session && activeListeningRef.current) {
        activeCaptureRef.current = handle
        armFollowUpTimer()
      } else {
        handle.stop(false)
      }
    },
    [
      armFollowUpTimer,
      clearFollowUpTimer,
      clearReplyFallbackTimer,
      clearResumeListenTimer,
      clearSilentTurnTimer,
      setConversationActive,
      stopActiveListen,
      transcribeAndSubmitCommand,
    ],
  )
  startActiveListenRef.current = startActiveListen

  const refreshHudState = useCallback(
    async (opts?: { forceBriefing?: boolean; peek?: boolean }) => {
      const api = getAiOfficeApi()
      if (typeof api?.butlerHudState !== 'function') return
      try {
        const state = await api.butlerHudState(opts)
        if (!aliveRef.current || !state) return

        const nextPrefs = normalizeButlerPrefs(state.prefs)
        prefsRef.current = nextPrefs
        setPrefs(nextPrefs)
        setHotkey(state.hotkey ?? null)
        setBriefing(state.briefing ?? null)
        setTasks(() => {
          let merged: ButlerTaskUpdate[] = []
          for (const item of state.tasks) {
            merged = upsertTask(merged, item)
          }
          return merged
        })
        setPendingDecisions(
          Array.isArray(state.pendingDecisions) ? [...state.pendingDecisions] : [],
        )

        if (
          state.briefing &&
          nextPrefs.voice &&
          !nextPrefs.dnd &&
          (opts?.forceBriefing || spokenDayKeyRef.current !== state.briefing.dayKey)
        ) {
          spokenDayKeyRef.current = state.briefing.dayKey
          const speech = composeBriefingSpeech(tRef.current, state.briefing, nextPrefs)
          void speakButlerSmart(speech, {
            prefs: nextPrefs,
            voiceConfig: voiceConfigRef.current,
            langTag: htmlLang(langRef.current),
            sourceId: 'hud-briefing',
          })
        }
      } catch {
        // Keep the current snapshot if main fails to respond.
      }
    },
    [],
  )

  useEffect(() => {
    aliveRef.current = true
    const api = getAiOfficeApi()
    let receivedDeskPush = false

    if (typeof api?.getButlerVoiceConfig === 'function') {
      void api
        .getButlerVoiceConfig()
        .then((cfg) => {
          if (!aliveRef.current || !cfg) return
          const normalized = normalizeButlerVoiceConfig(cfg)
          voiceConfigRef.current = normalized
          setVoiceConfig(normalized)
        })
        .catch(() => undefined)
    }

    if (typeof api?.butlerDeskState === 'function') {
      void api
        .butlerDeskState()
        .then((snap) => {
          if (!aliveRef.current || receivedDeskPush || !snap) return
          setMissions(Array.isArray(snap.missions) ? [...snap.missions] : [])
        })
        .catch(() => undefined)
    }

    const offShown = api?.onButlerShown?.(() => {
      void refreshHudState()
      focusInput()
    })
    const offTask = api?.onButlerTaskUpdate?.((update) => {
      setTasks((prev) => upsertTask(prev, update))
    })
    const offSpeak = api?.onButlerSpeak?.((req) => {
      const current = prefsRef.current
      if (!current.voice || current.dnd) return
      const isStreamPhase = req.phase === 'stream'
      const shouldEnqueue = isStreamPhase ? req.enqueue !== false : req.enqueue === true
      const shouldOpenFollowUp = isStreamPhase ? req.openFollowUp !== false : req.openFollowUp === true

      if (
        shouldOpenFollowUp &&
        !arbitrationRef.current.deskMicActive &&
        !current.dnd &&
        current.enabled
      ) {
        setConversationActive(true)
      }
      if (req.phase !== 'ack') {
        clearSilentTurnTimer()
        clearResumeListenTimer()
      }
      void speakButlerSmart(req.text, {
        prefs: current,
        voiceConfig: voiceConfigRef.current,
        langTag: htmlLang(langRef.current),
        sourceId: req.streamTurnId ?? 'hud-announce',
        enqueue: shouldEnqueue,
      }).then(() => {
        if (req.phase === 'ack') {
          return
        }
        if (
          aliveRef.current &&
          conversationActiveRef.current &&
          !arbitrationRef.current.deskMicActive &&
          !prefsRef.current.dnd &&
          !isButlerSpeechQueueBusy() &&
          !activeListeningRef.current
        ) {
          clearSilentTurnTimer()
          awaitingReplyRef.current = false
          clearReplyFallbackTimer()
          scheduleFollowUpListen()
        }
      })
    })
    const offPrefs = api?.onButlerPrefsChanged?.((next) => {
      const normalized = normalizeButlerPrefs(next)
      prefsRef.current = normalized
      setPrefs(normalized)
      if (normalized.dnd || !normalized.enabled) {
        endConversationSession(false)
      }
    })
    const offVoiceConfig = api?.onButlerVoiceConfigChanged?.((next) => {
      const normalized = normalizeButlerVoiceConfig(next)
      voiceConfigRef.current = normalized
      setVoiceConfig(normalized)
    })
    const offArbitration = api?.onButlerVoiceArbitration?.((next) => {
      if (!aliveRef.current || !next) return
      arbitrationRef.current = next
      setArbitration(next)
      if (next.deskMicActive) {
        endConversationSession(false)
      }
    })
    const offWakePrompt = api?.onButlerVoiceWakePrompt?.((payload) => {
      if (!aliveRef.current || !payload?.autoListen) return
      void startActiveListen({ wakeAck: Boolean(payload.wakeAck), keepConversation: true })
    })
    const offDesk = api?.onButlerDeskUpdated?.((snap) => {
      if (!aliveRef.current || !snap) return
      receivedDeskPush = true
      setMissions(Array.isArray(snap.missions) ? [...snap.missions] : [])
      setPendingDecisions(snap.decisions.filter((d) => d.status === 'pending'))

      const feed = Array.isArray(snap.feed) ? snap.feed : []
      if (!hudHydratedFeedRef.current) {
        hudHydratedFeedRef.current = true
        for (const entry of feed) {
          hudSeenFeedIdsRef.current.add(entry.id)
        }
        hudWasChiefBusyRef.current = Boolean(snap.chiefBusy)
        return
      }

      for (const entry of feed) {
        hudSeenFeedIdsRef.current.add(entry.id)
      }

      const prevChiefBusy = hudWasChiefBusyRef.current
      hudWasChiefBusyRef.current = Boolean(snap.chiefBusy)

      if (snap.chiefBusy) {
        clearSilentTurnTimer()
      }

      if (
        !conversationActiveRef.current ||
        !awaitingReplyRef.current ||
        arbitrationRef.current.deskMicActive ||
        prefsRef.current.dnd
      ) {
        return
      }

      const canAutoSpeak =
        prefsRef.current.voice &&
        !prefsRef.current.dnd &&
        voiceConfigRef.current.autoSpeakReplies

      if (prevChiefBusy && !snap.chiefBusy) {
        clearSilentTurnTimer()
        if (!canAutoSpeak) {
          awaitingReplyRef.current = false
          clearReplyFallbackTimer()
          scheduleFollowUpListen(120)
          return
        }
        if (
          !getButlerSpeechState().speaking &&
          !isButlerSpeechQueueBusy() &&
          !arbitrationRef.current.ttsSpeaking
        ) {
          silentTurnTimerRef.current = setTimeout(() => {
            silentTurnTimerRef.current = null
            if (
              !aliveRef.current ||
              !conversationActiveRef.current ||
              !awaitingReplyRef.current ||
              activeListeningRef.current ||
              arbitrationRef.current.deskMicActive ||
              prefsRef.current.dnd
            ) {
              return
            }
            if (
              getButlerSpeechState().speaking ||
              isButlerSpeechQueueBusy() ||
              arbitrationRef.current.ttsSpeaking
            ) {
              return
            }
            awaitingReplyRef.current = false
            clearReplyFallbackTimer()
            scheduleFollowUpListen(180)
          }, SILENT_TURN_RECOVERY_MS)
        }
      }
    })
    const offSpeech = subscribeButlerSpeechState((next) => {
      if (aliveRef.current) setSpeechState(next)
    })

    void refreshHudState(document.hasFocus() ? undefined : { peek: true })
    focusInput()

    return () => {
      aliveRef.current = false
      endConversationSession(false)
      offShown?.()
      offTask?.()
      offSpeak?.()
      offPrefs?.()
      offVoiceConfig?.()
      offArbitration?.()
      offWakePrompt?.()
      offDesk?.()
      offSpeech()
    }
  }, [
    clearReplyFallbackTimer,
    clearResumeListenTimer,
    clearSilentTurnTimer,
    endConversationSession,
    focusInput,
    refreshHudState,
    scheduleFollowUpListen,
    setConversationActive,
    startActiveListen,
  ])

  // Always-on two-level wake-word sentinel running while the HUD is idle and
  // no higher-priority mic capture (active listen or Desk mic) is active.
  useEffect(() => {
    const api = getAiOfficeApi()
    const canRunSentinel =
      prefs.enabled &&
      voiceConfig.wakeWordEnabled &&
      !prefs.dnd &&
      !arbitration.deskMicActive &&
      !activeListening &&
      typeof api?.butlerVoiceTranscribe === 'function'

    if (!canRunSentinel) {
      setSentinelActive(false)
      return
    }

    let disposed = false
    setSentinelActive(true)

    const handle = startButlerMicCapture({
      continuous: true,
      bandpassHumanVoice: true,
      silenceMs: WAKE_SENTINEL_SILENCE_MS,
      maxDurationMs: WAKE_SENTINEL_MAX_MS,
      shouldSuppress: () =>
        isButlerSpeakingOrEchoGuard() ||
        arbitrationRef.current.ttsSpeaking ||
        activeListeningRef.current ||
        transcribingRef.current,
      onSpeechSegment: (wavBytes) => {
        if (
          disposed ||
          !aliveRef.current ||
          activeListeningRef.current ||
          transcribingRef.current ||
          sentinelBusyRef.current ||
          isButlerSpeakingOrEchoGuard() ||
          arbitrationRef.current.ttsSpeaking
        ) {
          return
        }

        sentinelBusyRef.current = true
        void (async () => {
          try {
            const res = await api?.butlerVoiceTranscribe?.({
              wavBase64: uint8ToBase64(wavBytes),
              language: voiceConfigRef.current.sttLanguage,
              purpose: 'wake',
            })
            if (disposed || !aliveRef.current || !res?.ok || !res.text.trim()) return

            const matched = matchWakeWord(
              res.text,
              prefsRef.current.name,
              voiceConfigRef.current.wakeAliases,
            )
            if (!matched.matched) return

            if (matched.mode === 'command') {
              if (
                isVoiceDismissPhrase(
                  res.text,
                  prefsRef.current.name,
                  voiceConfigRef.current.wakeAliases,
                )
              ) {
                playWakeEarcon('cancel')
                endConversationSession(true)
                return
              }

              playWakeEarcon('done')
              setConversationActive(true)
              armReplyFallbackTimer()
              const summonRes = await api?.butlerVoiceWakeSummon?.({
                mode: 'command',
                rawText: res.text,
                commandText: matched.commandText,
              })
              if (!summonRes?.ok && !summonRes?.submitted) {
                awaitingReplyRef.current = false
                clearReplyFallbackTimer()
                if (
                  aliveRef.current &&
                  conversationActiveRef.current &&
                  !arbitrationRef.current.deskMicActive &&
                  !prefsRef.current.dnd &&
                  prefsRef.current.enabled
                ) {
                  scheduleFollowUpListen(180)
                }
              }
            } else {
              setConversationActive(true)
              await api?.butlerVoiceWakeSummon?.({
                mode: 'listen',
                rawText: res.text,
              })
            }
          } catch {
            // Keep sentinel resilient across transient ASR/network errors.
          } finally {
            sentinelBusyRef.current = false
          }
        })()
      },
      onError: () => {
        if (!disposed && aliveRef.current) {
          setSentinelActive(false)
        }
      },
    })

    return () => {
      disposed = true
      handle.stop(false)
      if (aliveRef.current) {
        setSentinelActive(false)
      }
    }
  }, [
    activeListening,
    arbitration.deskMicActive,
    armReplyFallbackTimer,
    clearReplyFallbackTimer,
    endConversationSession,
    prefs.dnd,
    prefs.enabled,
    scheduleFollowUpListen,
    setConversationActive,
    voiceConfig.wakeWordEnabled,
  ])

  useEffect(() => {
    const el = cardRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const api = getAiOfficeApi()

    const syncHeight = (): void => {
      const rect = el.getBoundingClientRect()
      const measured = rect.height > 0 ? rect.height : el.offsetHeight
      if (measured <= 0) return
      const nextHeight = Math.ceil(measured) + RESIZE_CARD_MARGIN_PX
      if (nextHeight === lastHeightRef.current) return
      lastHeightRef.current = nextHeight
      api?.butlerResize?.(nextHeight)
    }

    syncHeight()
    const observer = new ResizeObserver(() => {
      syncHeight()
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
    }
  }, [])

  const openTarget = useCallback((target: ButlerOpenTarget) => {
    void getAiOfficeApi()?.butlerOpen?.(target)
  }, [])

  const handleQuickResolveDecision = useCallback(async (decisionId: string, optionId: string) => {
    const api = getAiOfficeApi()
    if (typeof api?.butlerResolveDecision !== 'function') return
    setResolvingDecisionIds((prev) => ({ ...prev, [decisionId]: true }))
    try {
      await api.butlerResolveDecision({ decisionId, optionId })
    } finally {
      if (aliveRef.current) {
        setResolvingDecisionIds((prev) => {
          const next = { ...prev }
          delete next[decisionId]
          return next
        })
      }
    }
  }, [])

  const handleQuickApprovePlan = useCallback(async (missionId: string) => {
    const api = getAiOfficeApi()
    if (typeof api?.butlerApproveMissionPlan !== 'function') return
    setApprovingPlanId(missionId)
    try {
      const res = await api.butlerApproveMissionPlan({ missionId })
      if (aliveRef.current && !res?.ok && res?.error) {
        setSubmitError({ code: 'failed', message: res.error })
      }
    } catch (err: unknown) {
      if (aliveRef.current) {
        setSubmitError({
          code: 'failed',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    } finally {
      if (aliveRef.current) {
        setApprovingPlanId((prev) => (prev === missionId ? null : prev))
      }
    }
  }, [])

  const handleSubmit = useCallback(async () => {
    if (submitting) return
    await submitCommandText(input)
  }, [input, submitCommandText, submitting])

  const handleShellKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      endConversationSession(true)
    }
  }

  const handleInputKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing && !e.shiftKey) {
      e.preventDefault()
      void handleSubmit()
      return
    }
    if (e.key === 'ArrowUp' && input === '' && lastCommandRef.current) {
      e.preventDefault()
      setInput(lastCommandRef.current)
    }
  }

  const anyRunning =
    tasks.some((task) => task.status === 'running') ||
    pendingDecisions.length > 0 ||
    activeListening ||
    transcribing
  const visibleTasks = tasks.slice(0, MAX_VISIBLE_TASKS)
  const keycaps = hotkey ? formatAcceleratorKeycaps(hotkey, IS_MAC) : []
  const placeholder = activeListening
    ? t('butlerVoiceWakeListening')
    : transcribing
      ? t('butlerVoiceTranscribing')
      : t('butlerHudPlaceholder', { name: prefs.name })

  let errorText: string | null = null
  if (submitError) {
    if (submitError.code === 'disabled') {
      errorText = t('butlerErrDisabled')
    } else if (submitError.code === 'legacy') {
      errorText = t('butlerErrLegacy')
    } else {
      errorText = t('butlerErrFailed', { message: submitError.message ?? '' })
    }
  }

  const showSettingsBtn = submitError?.code === 'disabled' || submitError?.code === 'legacy'

  const briefingTitle = briefing
    ? prefs.honorific.trim()
      ? t('butlerHudBriefingTitle', {
          greeting: t(greetingKey(briefing.partOfDay)),
          honorific: prefs.honorific,
        })
      : `${t(greetingKey(briefing.partOfDay))} · ${t('butlerBriefShow')}`
    : ''

  const pendingPlanMission = (() => {
    const candidates = missions.filter(
      (m) => m.status === 'awaiting_plan_approval' && Boolean(m.plan),
    )
    if (candidates.length === 0) return null
    candidates.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
    return candidates[0] ?? null
  })()

  const hasBodySections = Boolean(
    errorText ||
      pendingPlanMission ||
      pendingDecisions.length > 0 ||
      briefing ||
      visibleTasks.length > 0,
  )

  const formatDecisionBtnLabel = (d: ButlerDecisionItem, opt: ButlerDecisionOption): string => {
    if (d.kind === 'permission') {
      if (opt.id === 'allow' || opt.id === 'allow-once') return t('butlerDecisionAllowOnce')
      if (opt.id === 'allow-session') return t('butlerDecisionAllowSession')
      if (opt.id === 'deny') return t('butlerDecisionDeny')
    }
    return opt.label
  }

  return (
    <div className="butler-hud-shell" data-testid="butler-hud-root" onKeyDown={handleShellKeyDown}>
      <div className="butler-hud-card" ref={cardRef}>
        <div className="butler-hud-input-row">
          <ReactorGlyph running={anyRunning} />
          <input
            ref={inputRef}
            className="butler-hud-input"
            type="text"
            value={input}
            placeholder={placeholder}
            aria-label={placeholder}
            disabled={submitting || transcribing}
            onChange={(e) => {
              setInput(e.target.value)
              if (submitError) setSubmitError(null)
            }}
            onKeyDown={handleInputKeyDown}
            autoFocus
          />
          {activeListening && (
            <div
              className="butler-hud-mic-meter"
              data-testid="butler-hud-mic-meter"
              aria-hidden="true"
            >
              <span
                className="butler-hud-mic-meter-fill"
                style={{ transform: `scaleX(${Math.max(0.14, micLevel)})` }}
              />
            </div>
          )}
          {speechState.speaking && (
            <button
              type="button"
              className="butler-hud-icon-btn is-danger"
              data-testid="butler-hud-stop-speech-btn"
              title={t('butlerVoiceStopSpeaking')}
              aria-label={t('butlerVoiceStopSpeaking')}
              onClick={() => stopButlerSpeech()}
            >
              <StopGlyph />
            </button>
          )}
          <button
            type="button"
            className={`butler-hud-icon-btn${activeListening ? ' is-listening' : ''}`}
            data-testid="butler-hud-mic-btn"
            aria-pressed={activeListening}
            disabled={submitting || transcribing}
            title={activeListening ? t('butlerVoiceMicStop') : t('butlerVoiceMicStart')}
            aria-label={activeListening ? t('butlerVoiceMicStop') : t('butlerVoiceMicStart')}
            onClick={() => {
              if (activeListening) {
                setConversationActive(false)
                awaitingReplyRef.current = false
                clearReplyFallbackTimer()
                clearResumeListenTimer()
                stopActiveListen(true)
              } else {
                void startActiveListen({ wakeAck: false, keepConversation: true })
              }
              focusInput()
            }}
          >
            <MicGlyph />
          </button>
          {keycaps.length > 0 && (
            <div className="butler-hud-keycaps" aria-hidden="true">
              {keycaps.map((cap, idx) => (
                <kbd key={`${cap}-${idx}`} className="butler-hud-kbd">
                  {cap}
                </kbd>
              ))}
            </div>
          )}
        </div>

        {liveConversation && (
          <div className="butler-hud-live-bar" data-testid="butler-hud-live-bar">
            <div className="butler-hud-live-left">
              <span className="butler-hud-live-dot" aria-hidden="true" />
              <span className="butler-hud-live-badge">{t('butlerLiveSessionBadge')}</span>
              <span className="butler-hud-live-hint">{t('butlerHudLiveHint')}</span>
            </div>
            <button
              type="button"
              className="butler-hud-hangup-btn"
              data-testid="butler-hud-hangup-btn"
              onClick={() => {
                playWakeEarcon('cancel')
                endConversationSession(false)
                focusInput()
              }}
            >
              {t('butlerLiveSessionHangup')}
            </button>
          </div>
        )}

        {hasBodySections && (
          <div className="butler-hud-body-sections">
            {errorText && (
              <div className="butler-hud-error-row" role="alert">
                <span className="butler-hud-error-text">{errorText}</span>
                {showSettingsBtn && (
                  <button
                    type="button"
                    className="butler-hud-action-btn"
                    onClick={() => openTarget({ type: 'settings' })}
                  >
                    {t('butlerOpenSettings')}
                  </button>
                )}
              </div>
            )}

            {pendingPlanMission && pendingPlanMission.plan && (
              <section
                className="butler-hud-plan-card"
                data-testid="butler-hud-plan-card"
                data-mission-id={pendingPlanMission.id}
                aria-label={t('butlerPlanCardTitle')}
              >
                <div className="butler-hud-decisions-head">
                  <span className="butler-hud-plan-title">
                    {t('butlerHudPlanPendingTitle', {
                      count: pendingPlanMission.plan.steps.length,
                    })}
                  </span>
                  <button
                    type="button"
                    className="butler-hud-brief-trigger"
                    onClick={() =>
                      openTarget({ type: 'desk', missionId: pendingPlanMission.id })
                    }
                  >
                    {t('butlerHudOpenDesk')}
                  </button>
                </div>
                <p
                  className="butler-hud-plan-summary"
                  title={pendingPlanMission.plan.summary}
                >
                  {pendingPlanMission.plan.summary}
                </p>
                <div className="butler-hud-plan-actions">
                  <button
                    type="button"
                    className="butler-hud-action-btn is-confirm"
                    data-testid="butler-hud-approve-plan-btn"
                    disabled={approvingPlanId === pendingPlanMission.id}
                    onClick={() => void handleQuickApprovePlan(pendingPlanMission.id)}
                  >
                    {t('butlerPlanApproveBtn')}
                  </button>
                </div>
              </section>
            )}

            {pendingDecisions.length > 0 && (
              <section
                className="butler-hud-decisions"
                data-testid="butler-hud-decisions"
                aria-label={t('butlerDecisionInboxTitle')}
              >
                <div className="butler-hud-decisions-head">
                  <span className="butler-hud-decisions-title">
                    {t('butlerHudDecisionsPending', { count: pendingDecisions.length })}
                  </span>
                  <button
                    type="button"
                    className="butler-hud-brief-trigger"
                    onClick={() =>
                      openTarget({
                        type: 'desk',
                        ...(pendingDecisions[0]?.missionId
                          ? { missionId: pendingDecisions[0].missionId }
                          : {}),
                        ...(pendingDecisions[0]?.id ? { decisionId: pendingDecisions[0].id } : {}),
                      })
                    }
                  >
                    {t('butlerHudOpenDesk')}
                  </button>
                </div>
                <ul className="butler-hud-decision-list">
                  {pendingDecisions.slice(0, 3).map((d) => {
                    const busy = Boolean(resolvingDecisionIds[d.id])
                    return (
                      <li
                        key={d.id}
                        className="butler-hud-decision-item"
                        data-testid="butler-hud-decision-card"
                      >
                        <button
                          type="button"
                          className="butler-hud-decision-link"
                          onClick={() =>
                            openTarget({
                              type: 'desk',
                              missionId: d.missionId,
                              decisionId: d.id,
                            })
                          }
                        >
                          <span className="butler-hud-decision-title">{d.title}</span>
                          <span className="butler-hud-decision-summary">{d.summary}</span>
                        </button>
                        <div className="butler-hud-decision-actions">
                          {d.options.map((opt) => (
                            <button
                              key={opt.id}
                              type="button"
                              disabled={busy}
                              className={`butler-hud-action-btn${
                                opt.style === 'primary'
                                  ? ' is-confirm'
                                  : opt.style === 'danger'
                                    ? ' is-danger'
                                    : ''
                              }`}
                              data-testid={`butler-hud-decision-opt-${opt.id}`}
                              onClick={() => void handleQuickResolveDecision(d.id, opt.id)}
                            >
                              {formatDecisionBtnLabel(d, opt)}
                            </button>
                          ))}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )}

            {briefing && (
              <section className="butler-hud-briefing" aria-label={briefingTitle}>
                <h2 className="butler-hud-briefing-title">{briefingTitle}</h2>
                {briefing.items.length === 0 ? (
                  <p className="butler-hud-briefing-empty">{t('butlerBriefEmpty')}</p>
                ) : (
                  <ul className="butler-hud-briefing-list">
                    {briefing.items.map((item) => (
                      <li key={item.kind} className="butler-hud-briefing-item">
                        <span className="butler-hud-briefing-line">
                          {t(briefingLineKey(item.kind), { count: item.count })}
                        </span>
                        {item.refs.length > 0 && (
                          <div className="butler-hud-refs">
                            {item.refs.map((ref, idx) => (
                              <button
                                key={`${ref.type}-${idx}-${ref.label}`}
                                type="button"
                                className="butler-hud-chip"
                                title={ref.label}
                                onClick={() => openTarget(ref)}
                              >
                                {ref.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            {visibleTasks.length > 0 && (
              <ul className="butler-hud-tasks">
                {visibleTasks.map((task) => {
                  const subtext =
                    task.status === 'running' && task.step
                      ? `${t(stepLabelKey(task.step.kind))} · ${task.step.tool}`
                      : task.status === 'done' && task.summary
                        ? task.summary
                        : task.status === 'error' && task.error
                          ? task.error
                          : null

                  const isConfirm = task.status === 'confirm'
                  return (
                    <li key={task.sessionKey} className="butler-hud-task">
                      <div className="butler-hud-task-main">
                        <div className="butler-hud-task-top">
                          <span className="butler-hud-task-title" title={task.title}>
                            {task.title}
                          </span>
                          <span className="butler-hud-status-pill" data-status={task.status}>
                            {t(statusLabelKey(task.status))}
                          </span>
                        </div>
                        {subtext && (
                          <p className="butler-hud-task-sub" title={subtext}>
                            {subtext}
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        className={`butler-hud-action-btn${isConfirm ? ' is-confirm' : ''}`}
                        onClick={() =>
                          openTarget({
                            type: 'session',
                            sessionKey: task.sessionKey,
                            label: task.title,
                          })
                        }
                      >
                        {isConfirm ? t('butlerGoConfirm') : t('butlerOpenInPanel')}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )}

        <div className="butler-hud-footer">
          <div className="butler-hud-footer-left">
            {sentinelActive && (
              <span className="butler-hud-sentinel-badge" data-testid="butler-hud-sentinel-badge">
                <span className="butler-hud-sentinel-dot" aria-hidden="true" />
                <span>{t('butlerVoiceSentinelActive')}</span>
              </span>
            )}
            <span className="butler-hud-hint">{t('butlerHudHint')}</span>
          </div>
          <div className="butler-hud-footer-actions">
            <button
              type="button"
              className="butler-hud-brief-trigger"
              data-testid="butler-hud-open-desk-btn"
              onClick={() => openTarget({ type: 'desk' })}
            >
              {t('butlerHudOpenDesk')}
            </button>
            <button
              type="button"
              className="butler-hud-brief-trigger"
              onClick={() => {
                void refreshHudState({ forceBriefing: true })
                focusInput()
              }}
            >
              {t('butlerBriefShow')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
