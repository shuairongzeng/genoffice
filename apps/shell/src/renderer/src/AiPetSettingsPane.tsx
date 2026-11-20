import { useCallback, useEffect, useRef, useState } from 'react'
import {
  bondStageForCount,
  mergeAiPetPrefs,
  normalizeAiPetPrefs,
  type AiPetBondStage,
  type AiPetId,
  type AiPetPrefs,
  type AiPetPrefsPatch,
} from '../../shared/ai-pet-prefs'
import { AI_PET_CATALOG, petMetaFor } from './ai-pet-catalog'
import { MascotSvg } from './AiMascot'
import {
  IDLE_PET_RUN_SNAPSHOT,
  useAiPetBehavior,
  type AiPetInteractionKind,
  type AiPetMood,
} from './ai-pet-state'
import { playPetSound } from './ai-pet-sound'
import type { StringKey, TFunc } from './locale'
import './ai-pet-settings.css'

/** Ordered mood presets exposed in the interactive stage mood preview bar. */
export const PET_PREVIEW_MOODS: readonly {
  readonly mood: AiPetMood
  readonly labelKey: StringKey
}[] = [
  { mood: 'idle', labelKey: 'petMoodIdle' },
  { mood: 'curious', labelKey: 'petMoodCurious' },
  { mood: 'thinking', labelKey: 'petMoodThinking' },
  { mood: 'working', labelKey: 'petMoodWorking' },
  { mood: 'petted', labelKey: 'petMoodPetted' },
  { mood: 'fed', labelKey: 'petMoodFed' },
  { mood: 'playful', labelKey: 'petMoodPlayful' },
  { mood: 'sleepy', labelKey: 'petMoodSleepy' },
  { mood: 'error', labelKey: 'petMoodError' },
]

const BOND_STAGE_KEYS: Record<AiPetBondStage, StringKey> = {
  stranger: 'petBondStranger',
  familiar: 'petBondFamiliar',
  partner: 'petBondPartner',
}

function aiMotionReduced(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

function ActionIcon({ kind }: { readonly kind: AiPetInteractionKind }): React.JSX.Element {
  if (kind === 'pet') {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M8 13.4C4.2 10.6 2.2 8.2 2.2 5.6A3.1 3.1 0 0 1 8 4a3.1 3.1 0 0 1 5.8 1.6c0 2.6-2 5-5.8 7.8Z"
          stroke="currentColor"
          strokeWidth="1.35"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  if (kind === 'feed') {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="9.2" r="4.3" stroke="currentColor" strokeWidth="1.35" />
        <path
          d="M8 4.9C8 3.2 9.4 2.1 11.2 2.2c0 1.7-1.1 2.9-3.2 2.7Z"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 2.1 9.5 6l3.9 1.5L9.5 9 8 12.9 6.5 9 2.6 7.5 6.5 6 8 2.1Z"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * Settings AI Pet Studio pane: interactive preview stage with live gaze, rubbing,
 * nurturing actions, mood preview chips, companion picker, and desktop pet prefs.
 */
export function AiPetSettingsPane({ t }: { t: TFunc }): React.JSX.Element {
  const [prefs, setPrefs] = useState<AiPetPrefs>(() => normalizeAiPetPrefs(undefined))
  const prefsRef = useRef<AiPetPrefs>(prefs)
  prefsRef.current = prefs
  const hydratedOrMutatedRef = useRef(false)

  const [previewMood, setPreviewMood] = useState<AiPetMood | null>(null)
  const stagePetRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    let alive = true
    const api = typeof window !== 'undefined' ? window.aiOffice : undefined
    if (typeof api?.getAiPetPrefs === 'function') {
      void api
        .getAiPetPrefs()
        .then((loaded) => {
          if (!alive || hydratedOrMutatedRef.current) return
          const next = normalizeAiPetPrefs(loaded)
          prefsRef.current = next
          setPrefs(next)
        })
        .catch(() => undefined)
    }
    const off = api?.onAiPetPrefsChanged?.((incoming) => {
      if (!alive) return
      hydratedOrMutatedRef.current = true
      const next = normalizeAiPetPrefs(incoming)
      prefsRef.current = next
      setPrefs(next)
    })
    return () => {
      alive = false
      off?.()
    }
  }, [])

  const commitPetPrefs = useCallback((patch: AiPetPrefsPatch) => {
    hydratedOrMutatedRef.current = true
    const next = mergeAiPetPrefs(prefsRef.current, patch)
    prefsRef.current = next
    setPrefs(next)
    const api = typeof window !== 'undefined' ? window.aiOffice : undefined
    void api?.setAiPetPrefs?.(patch)?.catch?.(() => undefined)
  }, [])

  const onInteract = useCallback(
    (kind: AiPetInteractionKind) => {
      const current = prefsRef.current
      playPetSound(current.petId, kind, {
        enabled: current.sound,
        reducedMotion: aiMotionReduced(),
      })
      setPreviewMood(null)
      commitPetPrefs({ incrementInteraction: current.petId })
    },
    [commitPetPrefs],
  )

  const behavior = useAiPetBehavior({
    collapsed: true,
    dragging: false,
    runState: IDLE_PET_RUN_SNAPSHOT,
    reducedMotion: aiMotionReduced(),
    petRef: stagePetRef,
    windowGaze: false,
    onInteract,
  })

  const activeMeta = petMetaFor(prefs.petId)
  const interactionCount = prefs.interactions[prefs.petId]
  const bondStage = bondStageForCount(interactionCount)
  const displayedMood = previewMood ?? behavior.mood

  const handleSelectPet = (petId: AiPetId) => {
    setPreviewMood(null)
    commitPetPrefs({ petId })
    behavior.wakeUp()
    playPetSound(petId, 'select', {
      enabled: prefsRef.current.sound,
      reducedMotion: aiMotionReduced(),
    })
  }

  const handleToggleBubbles = () => {
    commitPetPrefs({ bubbles: !prefsRef.current.bubbles })
  }

  const handleToggleSound = () => {
    const nextSound = !prefsRef.current.sound
    commitPetPrefs({ sound: nextSound })
    if (nextSound) {
      playPetSound(prefsRef.current.petId, 'select', {
        enabled: true,
        reducedMotion: aiMotionReduced(),
      })
    }
  }

  const handleResetPosition = () => {
    const api = typeof window !== 'undefined' ? window.aiOffice : undefined
    void api?.setAiDock?.({ petPos: null })?.catch?.(() => undefined)
  }

  return (
    <div className="ai-pet-studio">
      <div className="ai-pet-header">
        <h3 className="set-pane-title">{t('setPetTitle')}</h3>
        <p className="ai-pet-pane-desc">{t('setPetSubtitle')}</p>
      </div>

      <section className="ai-pet-stage" aria-label={t(activeMeta.nameKey)}>
        <div className="ai-pet-stage-hero">
          <div className="ai-pet-stage-visual">
            {prefs.bubbles && behavior.activeBubble !== null && (
              <div className="ai-pet-stage-bubble" role="status" aria-live="polite">
                {t(activeMeta.lineKeys[behavior.activeBubble])}
              </div>
            )}
            <div className="ai-pet-stage-pedestal" aria-hidden="true" />
            <button
              ref={stagePetRef}
              type="button"
              className="ai-pet-stage-pet"
              aria-label={t(activeMeta.nameKey)}
              onPointerEnter={behavior.onPointerEnter}
              onPointerLeave={behavior.onPointerLeave}
              onPointerMove={behavior.onPointerMove}
              onClick={() => {
                setPreviewMood(null)
                behavior.triggerPet()
              }}
            >
              <MascotSvg petId={prefs.petId} mood={displayedMood} />
            </button>
          </div>

          <div className="ai-pet-stage-info">
            <div className="ai-pet-stage-title-row">
              <h4 className="ai-pet-stage-name">{t(activeMeta.nameKey)}</h4>
              <span className="ai-pet-bond-badge" data-bond-stage={bondStage}>
                {t(BOND_STAGE_KEYS[bondStage])}
              </span>
            </div>
            <div className="ai-pet-stage-tag">{t(activeMeta.tagKey)}</div>
            <div className="ai-pet-stage-count">
              {t('petBondCount', { n: interactionCount })}
            </div>

            <div className="ai-pet-actions">
              <button
                type="button"
                className="ai-pet-action-btn"
                onClick={() => {
                  setPreviewMood(null)
                  behavior.triggerPet()
                }}
              >
                <ActionIcon kind="pet" />
                <span>{t('petActionPet')}</span>
              </button>
              <button
                type="button"
                className="ai-pet-action-btn"
                onClick={() => {
                  setPreviewMood(null)
                  behavior.triggerFeed()
                }}
              >
                <ActionIcon kind="feed" />
                <span>{t('petActionFeed')}</span>
              </button>
              <button
                type="button"
                className="ai-pet-action-btn"
                onClick={() => {
                  setPreviewMood(null)
                  behavior.triggerPlay()
                }}
              >
                <ActionIcon kind="play" />
                <span>{t('petActionPlay')}</span>
              </button>
            </div>
          </div>
        </div>

        <div className="ai-pet-mood-bar">
          {PET_PREVIEW_MOODS.map(({ mood, labelKey }) => {
            const pressed =
              mood === 'idle'
                ? previewMood === null && displayedMood === 'idle'
                : previewMood === mood
            return (
              <button
                key={mood}
                type="button"
                className="ai-pet-mood-chip"
                aria-pressed={pressed}
                data-mood-chip={mood}
                onClick={() => {
                  setPreviewMood((curr) => (mood === 'idle' || curr === mood ? null : mood))
                }}
              >
                {t(labelKey)}
              </button>
            )
          })}
        </div>

        <p className="ai-pet-stage-hint">{t('setPetStageHint')}</p>
      </section>

      <section className="ai-pet-section">
        <div className="ai-pet-section-label">{t('setPetSelectLabel')}</div>
        <div className="ai-pet-grid" role="radiogroup" aria-label={t('setPetSelectLabel')}>
          {AI_PET_CATALOG.map((meta) => {
            const active = prefs.petId === meta.id
            return (
              <button
                key={meta.id}
                type="button"
                role="radio"
                aria-checked={active}
                data-pet-card={meta.id}
                className={`ai-pet-card${active ? ' is-active' : ''}`}
                onClick={() => handleSelectPet(meta.id)}
              >
                <div className="ai-pet-card-top">
                  <div className="ai-pet-card-avatar">
                    <MascotSvg decorative petId={meta.id} mood={active ? 'hover' : 'idle'} />
                  </div>
                  {active && <span className="ai-pet-card-badge">{t('setPetActiveBadge')}</span>}
                </div>
                <div className="ai-pet-card-name">{t(meta.nameKey)}</div>
                <div className="ai-pet-card-tag">{t(meta.tagKey)}</div>
                <div className="ai-pet-card-desc">{t(meta.descKey)}</div>
              </button>
            )
          })}
        </div>
      </section>

      <div className="ai-pet-prefs-list">
        <div className="set-field">
          <div className="set-field-text">
            <div className="set-field-stack">
              <div className="set-field-label">{t('setPetBubbles')}</div>
              <div className="set-field-desc">{t('setPetBubblesDesc')}</div>
            </div>
          </div>
          <button
            type="button"
            className="set-switch"
            role="switch"
            aria-checked={prefs.bubbles}
            aria-label={t('setPetBubbles')}
            onClick={handleToggleBubbles}
          />
        </div>

        <div className="set-field">
          <div className="set-field-text">
            <div className="set-field-stack">
              <div className="set-field-label">{t('setPetSound')}</div>
              <div className="set-field-desc">{t('setPetSoundDesc')}</div>
            </div>
          </div>
          <button
            type="button"
            className="set-switch"
            role="switch"
            aria-checked={prefs.sound}
            aria-label={t('setPetSound')}
            onClick={handleToggleSound}
          />
        </div>

        <div className="set-field">
          <div className="set-field-text">
            <div className="set-field-stack">
              <div className="set-field-label">{t('setPetResetPos')}</div>
            </div>
          </div>
          <button type="button" className="set-btn" onClick={handleResetPosition}>
            {t('setPetResetPos')}
          </button>
        </div>
      </div>
    </div>
  )
}
