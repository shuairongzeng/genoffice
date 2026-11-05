import React, { useCallback, useEffect, useState } from 'react'
import type { Lang } from '@genoffice/i18n'
import {
  AI_PERMISSION_MODES,
  normalizeAiPermissionMode,
  type AiPermissionMode,
} from './ai-permission-mode'
import { useDismissablePopover } from './popover-dismiss'
import { AI_PERMISSION_MODE_STRINGS } from './strings-ai-permission'

/** Each app's preload exposes these under its own namespace; the panel adapts them. */
export interface AiPermissionModePickerBridge {
  /** the persisted mode (app-settings.json `aiPermissions`); the picker clamps what it reads */
  readonly getMode: () => Promise<AiPermissionMode>
  /** persist a mode change; the store watcher's broadcast re-renders every mount */
  readonly setMode: (mode: AiPermissionMode) => Promise<void>
  /** fires after any panel's write settled in the store — one posture, every mount flips */
  readonly onModeChanged?: ((handler: (mode: AiPermissionMode) => void) => () => void) | undefined
}

/**
 * Composer footer chip showing the AI panel's global permission mode; the
 * popover lists the three postures (fully automatic / ask when needed /
 * always ask), each with a one-line hint, and picking one persists it for
 * the whole app — Home's panel and the doc-mode overlay's copy follow the
 * same store, so both flip on the broadcast the write triggers.
 *
 * Visual family of the model picker (ai-model-picker.css serves both): the
 * same chip, popover and option rows; a mode's row adds the hint line, and
 * the chip leads with a shield glyph so the posture reads at a glance.
 */
export function AiPermissionModePicker({
  bridge,
  lang,
}: {
  readonly bridge: AiPermissionModePickerBridge
  readonly lang: Lang
}): React.JSX.Element | null {
  const strings = AI_PERMISSION_MODE_STRINGS[lang] ?? AI_PERMISSION_MODE_STRINGS.en
  const [mode, setMode] = useState<AiPermissionMode | null>(null)
  const [open, setOpen] = useState(false)
  const [popStyle, setPopStyle] = useState<React.CSSProperties>({})
  const chipRef = React.useRef<HTMLButtonElement | null>(null)
  const popRef = React.useRef<HTMLDivElement | null>(null)

  // tests render panels without a preload bridge: a throwing getter must not
  // take the panel down (the model picker's same guard)
  const refresh = useCallback(() => {
    Promise.resolve()
      .then(() => bridge.getMode())
      .then(
        (next) => setMode(normalizeAiPermissionMode(next)),
        () => {},
      )
  }, [bridge])

  useEffect(() => {
    refresh()
    let off: (() => void) | undefined
    try {
      off = bridge.onModeChanged?.((next) => setMode(normalizeAiPermissionMode(next)))
    } catch {
      off = undefined
    }
    return () => off?.()
  }, [bridge, refresh])

  const close = useCallback(() => setOpen(false), [])
  useDismissablePopover(open, close, {
    inside: () => [chipRef.current, popRef.current],
  })

  const toggle = () => {
    if (!open) {
      const rect = chipRef.current?.getBoundingClientRect()
      // the composer sits at the panel bottom: open upwards, pinned to the chip
      if (rect) setPopStyle({ left: rect.left, bottom: window.innerHeight - rect.top + 6 })
    }
    setOpen((v) => !v)
  }

  const pick = (next: AiPermissionMode) => {
    setOpen(false)
    // optimistic like the model picker: the store watcher's broadcast
    // confirms (or corrects) it, so two mounts never disagree for a frame
    // longer than the round trip
    setMode(next)
    void bridge.setMode(next).catch(() => {})
  }

  if (mode === null) return null
  const chipText = strings.names[mode]

  return (
    <div
      className="ai-model-picker ai-perm-picker"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation()
          setOpen(false)
          chipRef.current?.focus()
        }
      }}
    >
      <button
        ref={chipRef}
        type="button"
        // auto drops every confirmation — the chip wears the danger ink the
        // whole time that posture is on, so the elevated trust is always
        // visible at a glance
        className={`ai-model-chip${open ? ' open' : ''}${mode === 'auto' ? ' ai-perm-auto' : ''}`}
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-tip={`${strings.title}: ${chipText} — ${strings.hints[mode]}`}
        aria-label={`${strings.title}: ${chipText}`}
      >
        <svg
          className="ai-perm-shield"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M12 2 20 5.5V11c0 5.2-3.4 8.9-8 11-4.6-2.1-8-5.8-8-11V5.5L12 2z" />
          {mode === 'auto' && <path d="M8.5 11.5 11 14l4.5-5" />}
        </svg>
        <span className="ai-model-chip-text">{chipText}</span>
        <svg className="ai-model-chip-caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path
            d="M2 6.5 5 3.5l3 3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div
          ref={popRef}
          className="ai-model-pop"
          role="listbox"
          aria-label={strings.title}
          style={popStyle}
        >
          <div className="ai-model-pop-list">
            {AI_PERMISSION_MODES.map((value) => {
              const selected = value === mode
              return (
                <button
                  key={value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  // the auto row is marked in the danger ink too: picking the
                  // no-confirmations posture should never read as routine
                  className={`ai-model-item${selected ? ' selected' : ''}${value === 'auto' ? ' ai-perm-option-auto' : ''}`}
                  onClick={() => pick(value)}
                >
                  <span className="ai-model-item-text">{strings.names[value]}</span>
                  {selected && (
                    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                      <path
                        d="M2.5 6.5 5 9l4.5-6"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                  <span className="ai-model-item-hint">{strings.hints[value]}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
