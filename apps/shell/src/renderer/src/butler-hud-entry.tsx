import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { htmlLang } from '@genoffice/i18n'
import type {
  ButlerBriefing,
  ButlerOpenTarget,
  ButlerSubmitError,
  ButlerTaskUpdate,
} from '../../shared/butler-api'
import {
  DEFAULT_BUTLER_PREFS,
  normalizeButlerPrefs,
  type ButlerPrefs,
} from '../../shared/butler-prefs'
import type { HomeApi } from '../../shared/home-api'
import {
  briefingLineKey,
  composeBriefingSpeech,
  formatAcceleratorKeycaps,
  greetingKey,
  statusLabelKey,
  stepLabelKey,
  upsertTask,
} from './butler-hud-model'
import { speakButler } from './butler-voice'
import { useI18n } from './locale'
import './butler-hud.css'

const MAX_VISIBLE_TASKS = 4
const RESIZE_CARD_MARGIN_PX = 16

const IS_MAC = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac')

function getAiOfficeApi(): Partial<HomeApi> | undefined {
  if (typeof window === 'undefined') return undefined
  return window.aiOffice as Partial<HomeApi> | undefined
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

/**
 * Standalone renderer entry for the J.A.R.V.I.S.-style floating Butler command HUD
 * (`?view=butler-hud`). Renders the transparent floating card, syncs live prefs/tasks,
 * speaks daily briefings and completion announcements, and reports content height.
 */
export function ButlerHudEntry(): React.JSX.Element {
  const { lang, t } = useI18n()
  const langRef = useRef(lang)
  langRef.current = lang
  const tRef = useRef(t)
  tRef.current = t

  const [prefs, setPrefs] = useState<ButlerPrefs>(DEFAULT_BUTLER_PREFS)
  const prefsRef = useRef<ButlerPrefs>(DEFAULT_BUTLER_PREFS)
  const [hotkey, setHotkey] = useState<string | null>(null)
  const [briefing, setBriefing] = useState<ButlerBriefing | null>(null)
  const [tasks, setTasks] = useState<ButlerTaskUpdate[]>([])
  const [input, setInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
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

        if (
          state.briefing &&
          nextPrefs.voice &&
          !nextPrefs.dnd &&
          (opts?.forceBriefing || spokenDayKeyRef.current !== state.briefing.dayKey)
        ) {
          spokenDayKeyRef.current = state.briefing.dayKey
          const speech = composeBriefingSpeech(tRef.current, state.briefing, nextPrefs)
          speakButler(speech, {
            rate: nextPrefs.voiceRate,
            voiceName: nextPrefs.voiceName,
            langTag: htmlLang(langRef.current),
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

    const offShown = api?.onButlerShown?.(() => {
      void refreshHudState()
      focusInput()
    })
    const offTask = api?.onButlerTaskUpdate?.((update) => {
      setTasks((prev) => upsertTask(prev, update))
    })
    const offSpeak = api?.onButlerSpeak?.((req) => {
      const current = prefsRef.current
      speakButler(req.text, {
        rate: current.voiceRate,
        voiceName: current.voiceName,
        langTag: htmlLang(langRef.current),
      })
    })
    const offPrefs = api?.onButlerPrefsChanged?.((next) => {
      const normalized = normalizeButlerPrefs(next)
      prefsRef.current = normalized
      setPrefs(normalized)
    })

    void refreshHudState(document.hasFocus() ? undefined : { peek: true })
    focusInput()

    return () => {
      aliveRef.current = false
      offShown?.()
      offTask?.()
      offSpeak?.()
      offPrefs?.()
    }
  }, [focusInput, refreshHudState])

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

  const handleSubmit = useCallback(async () => {
    const trimmed = input.trim()
    if (!trimmed || submitting) return
    const api = getAiOfficeApi()
    if (typeof api?.butlerSubmit !== 'function') return

    setSubmitting(true)
    setSubmitError(null)
    try {
      const result = await api.butlerSubmit(trimmed)
      if (!aliveRef.current) return
      if (result.ok) {
        lastCommandRef.current = trimmed
        setInput('')
        setSubmitError(null)
      } else if (result.error && result.error !== 'empty') {
        setSubmitError({ code: result.error, message: result.message })
      }
    } catch (err: unknown) {
      if (!aliveRef.current) return
      const message = err instanceof Error ? err.message : ''
      setSubmitError({ code: 'failed', message })
    } finally {
      if (aliveRef.current) {
        setSubmitting(false)
      }
    }
  }, [input, submitting])

  const handleShellKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      getAiOfficeApi()?.butlerHide?.()
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

  const anyRunning = tasks.some((task) => task.status === 'running')
  const visibleTasks = tasks.slice(0, MAX_VISIBLE_TASKS)
  const keycaps = hotkey ? formatAcceleratorKeycaps(hotkey, IS_MAC) : []
  const placeholder = t('butlerHudPlaceholder', { name: prefs.name })

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

  const hasBodySections = Boolean(errorText || briefing || visibleTasks.length > 0)

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
            disabled={submitting}
            onChange={(e) => {
              setInput(e.target.value)
              if (submitError) setSubmitError(null)
            }}
            onKeyDown={handleInputKeyDown}
            autoFocus
          />
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
          <span className="butler-hud-hint">{t('butlerHudHint')}</span>
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
  )
}
