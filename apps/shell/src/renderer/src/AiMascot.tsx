import { useId } from 'react'
import type { AiPetMood } from './ai-pet-state'

export interface MascotSvgProps {
  /** Active behavioral mood driving eyes, aura, wings, and status badges */
  readonly mood?: AiPetMood
  /** Decorative host mode (e.g. empty panel greeting): hides notification badges */
  readonly decorative?: boolean
  readonly className?: string
}

/**
 * 2.5D Lively Bluebird mascot shared across the Home floating pet,
 * the native document-mode overlay view, and the empty ask panel hello card.
 *
 * All geometry, contact shadow, aura ring, and corner badges stay inside
 * [3..69, 3..61] of the 72x64 viewBox so nothing clips inside the 68x62
 * transparent native overlay window (`PET_SIZE`).
 */
export function MascotSvg({
  mood = 'idle',
  decorative = false,
  className,
}: MascotSvgProps): React.JSX.Element {
  const uid = useId().replace(/:/g, '_')
  const idBody = `${uid}-body`
  const idBelly = `${uid}-belly`
  const idWing = `${uid}-wing`
  const idTuft = `${uid}-tuft`
  const idBeak = `${uid}-beak`
  const idIris = `${uid}-iris`
  const idSpec = `${uid}-spec`
  const idAura = `${uid}-aura`

  const showAura =
    !decorative &&
    (mood === 'thinking' ||
      mood === 'working' ||
      mood === 'unread-done' ||
      mood === 'attention' ||
      mood === 'error')

  const eyesClosed = mood === 'sleepy'
  const eyesHappy = mood === 'petted'
  const showErrorBrow = mood === 'error'
  const showBadge =
    !decorative &&
    (mood === 'thinking' ||
      mood === 'working' ||
      mood === 'unread-done' ||
      mood === 'attention' ||
      mood === 'error' ||
      mood === 'sleepy')

  const rootClass = className ? `ai-mascot-svg ${className}` : 'ai-mascot-svg'

  return (
    <svg
      className={rootClass}
      data-mood={mood}
      data-decorative={decorative ? 'true' : undefined}
      viewBox="0 0 72 64"
      width="56"
      height="50"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id={idBody} cx="36%" cy="28%" r="72%" fx="32%" fy="24%">
          <stop offset="0%" className="ai-mascot-stop-body-hi" />
          <stop offset="52%" className="ai-mascot-stop-body-mid" />
          <stop offset="100%" className="ai-mascot-stop-body-lo" />
        </radialGradient>
        <radialGradient id={idBelly} cx="50%" cy="34%" r="68%">
          <stop offset="0%" className="ai-mascot-stop-belly-hi" />
          <stop offset="100%" className="ai-mascot-stop-belly-lo" />
        </radialGradient>
        <linearGradient id={idWing} x1="15%" y1="10%" x2="85%" y2="95%">
          <stop offset="0%" className="ai-mascot-stop-wing-hi" />
          <stop offset="100%" className="ai-mascot-stop-wing-lo" />
        </linearGradient>
        <linearGradient id={idTuft} x1="20%" y1="0%" x2="70%" y2="100%">
          <stop offset="0%" className="ai-mascot-stop-body-hi" />
          <stop offset="100%" className="ai-mascot-stop-wing-lo" />
        </linearGradient>
        <linearGradient id={idBeak} x1="50%" y1="0%" x2="50%" y2="100%">
          <stop offset="0%" className="ai-mascot-stop-beak-hi" />
          <stop offset="100%" className="ai-mascot-stop-beak-lo" />
        </linearGradient>
        <radialGradient id={idIris} cx="38%" cy="32%" r="70%">
          <stop offset="0%" className="ai-mascot-stop-iris-hi" />
          <stop offset="100%" className="ai-mascot-stop-iris-lo" />
        </radialGradient>
        <linearGradient id={idSpec} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" className="ai-mascot-stop-spec-hi" />
          <stop offset="100%" className="ai-mascot-stop-spec-lo" />
        </linearGradient>
        <linearGradient id={idAura} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" className="ai-mascot-stop-aura-a" />
          <stop offset="100%" className="ai-mascot-stop-aura-b" />
        </linearGradient>
      </defs>

      {/* Soft contact shadow anchored beneath the bird */}
      <ellipse className="ai-mascot-ground-shadow" cx="36" cy="58.2" rx="16.5" ry="2.5" />

      {/* Outer ambient status ring kept safely inside [3..69, 3..61] */}
      {showAura && (
        <g className="ai-mascot-aura-group">
          <ellipse
            className="ai-mascot-aura"
            cx="36"
            cy="36.5"
            rx="27.5"
            ry="22"
            stroke={`url(#${idAura})`}
            strokeWidth="2"
            strokeLinecap="round"
          />
        </g>
      )}

      {/* Main articulated rig */}
      <g className="ai-mascot-body-rig">
        <g className="ai-mascot-breathe">
          {/* Tail feathers tucked on the right flank */}
          <g className="ai-mascot-tail">
            <path
              className="ai-mascot-tail-feather"
              fill={`url(#${idWing})`}
              d="M54.5 42.5 C62 38.8 66.5 41.8 65.8 45.6 C64.2 49.2 59.2 49 54.8 47.6 Z"
            />
            <path
              className="ai-mascot-tail-feather-sub"
              fill={`url(#${idWing})`}
              d="M53.2 46.2 C60 45.8 63.2 48.6 61.6 51.4 C59.4 53.5 54.6 52.2 51.8 49.8 Z"
            />
          </g>

          {/* Left wing (pivoted at shoulder) */}
          <g className="ai-mascot-wing-left">
            <path
              className="ai-mascot-wing"
              fill={`url(#${idWing})`}
              d="M15.5 35.4 C9.8 38 9 45.2 14.2 48.6 C18.8 51.4 24.4 48.4 25.2 44.4 C25.8 41.2 21.6 36.4 15.5 35.4 Z"
            />
            <path
              className="ai-mascot-wing-line"
              d="M13.5 41.2 Q17 44.5 22.2 44.8"
              strokeWidth="1.1"
              strokeLinecap="round"
            />
          </g>

          {/* Right wing (pivoted at shoulder) */}
          <g className="ai-mascot-wing-right">
            <path
              className="ai-mascot-wing"
              fill={`url(#${idWing})`}
              d="M56.5 35.4 C62.2 38 63 45.2 57.8 48.6 C53.2 51.4 47.6 48.4 46.8 44.4 C46.2 41.2 50.4 36.4 56.5 35.4 Z"
            />
            <path
              className="ai-mascot-wing-line"
              d="M58.5 41.2 Q55 44.5 49.8 44.8"
              strokeWidth="1.1"
              strokeLinecap="round"
            />
          </g>

          {/* Three-feather sculpted crest */}
          <g className="ai-mascot-tuft-group">
            <path
              className="ai-mascot-tuft-feather"
              fill={`url(#${idTuft})`}
              d="M31.6 20.6 C29 14.8 32.8 10.6 35.8 12.2 C34.2 14.3 33.4 17 33.8 20 Z"
            />
            <path
              className="ai-mascot-tuft-feather"
              fill={`url(#${idTuft})`}
              d="M34.2 19.5 C33.5 11.2 40 7.6 43.8 10.2 C41.4 13 38.6 15.8 37.5 19.8 Z"
            />
            <path
              className="ai-mascot-tuft-feather"
              fill={`url(#${idTuft})`}
              d="M37.5 20.2 C40.2 14.4 45.6 13 47.4 15.6 C44.8 16.8 41.8 18.2 39.2 20.6 Z"
            />
          </g>

          {/* 2.5D rounded body sphere */}
          <path
            className="ai-mascot-shape"
            fill={`url(#${idBody})`}
            d="M36 18.2 C49.4 18.2 59 26.8 59 38.8 C59 50.4 49.6 57.2 36 57.2 C22.4 57.2 13 50.4 13 38.8 C13 26.8 22.6 18.2 36 18.2 Z"
          />

          {/* Top-left translucent specular crescent */}
          <path
            className="ai-mascot-specular"
            fill={`url(#${idSpec})`}
            d="M20.2 28.5 C23.6 22 31 19.6 37.4 20.4 C32.2 21.8 26.2 24.8 22.8 30.8 C21.5 32.6 19.1 30.8 20.2 28.5 Z"
          />

          {/* Rim highlight along top contour for contrast on dark wallpapers */}
          <path
            className="ai-mascot-rim"
            d="M15.4 31.8 C17.5 23.2 25.8 18.8 36 18.8 C45.8 18.8 53.5 22.8 56.2 30.5"
            strokeWidth="1.2"
            strokeLinecap="round"
          />

          {/* Creamy softly contoured belly plumage */}
          <path
            className="ai-mascot-belly"
            fill={`url(#${idBelly})`}
            d="M36 39 C41.4 39 47.6 41.8 48 47.8 C48.4 53.2 42.6 56.2 36 56.2 C29.4 56.2 23.6 53.2 24 47.8 C24.4 41.8 30.6 39 36 39 Z"
          />

          {/* Eyes: asleep arcs, happy crescents, or wide expressive layered irises */}
          {eyesClosed ? (
            <g className="ai-mascot-eyes-closed">
              <path
                className="ai-mascot-eye-closed"
                d="M23.2 33.4 Q27.5 36.8 31.8 33.4"
                strokeWidth="2.1"
                strokeLinecap="round"
              />
              <path
                className="ai-mascot-eye-closed"
                d="M40.2 33.4 Q44.5 36.8 48.8 33.4"
                strokeWidth="2.1"
                strokeLinecap="round"
              />
            </g>
          ) : eyesHappy ? (
            <g className="ai-mascot-eyes-happy">
              <path
                className="ai-mascot-eye-happy"
                d="M23.2 34.4 Q27.5 29.5 31.8 34.4"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
              <path
                className="ai-mascot-eye-happy"
                d="M40.2 34.4 Q44.5 29.5 48.8 34.4"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
            </g>
          ) : (
            <g className="ai-mascot-eyes-open">
              <g className="ai-mascot-eye" transform="translate(27.5 33)">
                <g className="ai-mascot-blink">
                  <ellipse className="ai-mascot-eyeball" cx="0" cy="0" rx="5.1" ry="5.3" />
                  <g className="ai-mascot-iris-group">
                    <circle
                      className="ai-mascot-iris"
                      cx="0"
                      cy="0"
                      r="3.2"
                      fill={`url(#${idIris})`}
                    />
                    <circle className="ai-mascot-pupil" cx="0" cy="0" r="1.9" />
                    <circle className="ai-mascot-glint" cx="-1.15" cy="-1.25" r="1.1" />
                    <circle className="ai-mascot-glint-sub" cx="1.0" cy="1.15" r="0.52" />
                  </g>
                </g>
                {showErrorBrow && (
                  <path
                    className="ai-mascot-brow"
                    d="M-4 -6.4 Q-0.5 -5.4 3.2 -7.2"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                )}
              </g>
              <g className="ai-mascot-eye" transform="translate(44.5 33)">
                <g className="ai-mascot-blink">
                  <ellipse className="ai-mascot-eyeball" cx="0" cy="0" rx="5.1" ry="5.3" />
                  <g className="ai-mascot-iris-group">
                    <circle
                      className="ai-mascot-iris"
                      cx="0"
                      cy="0"
                      r="3.2"
                      fill={`url(#${idIris})`}
                    />
                    <circle className="ai-mascot-pupil" cx="0" cy="0" r="1.9" />
                    <circle className="ai-mascot-glint" cx="-1.15" cy="-1.25" r="1.1" />
                    <circle className="ai-mascot-glint-sub" cx="1.0" cy="1.15" r="0.52" />
                  </g>
                </g>
                {showErrorBrow && (
                  <path
                    className="ai-mascot-brow"
                    d="M-3.2 -7.2 Q0.5 -5.4 4 -6.4"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                )}
              </g>
            </g>
          )}

          {/* Sculpted two-tone warm golden beak */}
          <g className="ai-mascot-beak-group">
            <path
              className="ai-mascot-beak-lower"
              d="M33.9 39.5 L36 42.4 L38.1 39.5 Q36 40.3 33.9 39.5 Z"
            />
            <path
              className="ai-mascot-beak-upper"
              fill={`url(#${idBeak})`}
              d="M32.6 38 Q36 36.4 39.4 38 L36.6 41.4 Q36 42.1 35.4 41.4 Z"
            />
          </g>

          {/* Soft cheek blushes */}
          <ellipse className="ai-mascot-blush" cx="19.8" cy="40" rx="3.8" ry="2.2" />
          <ellipse className="ai-mascot-blush" cx="52.2" cy="40" rx="3.8" ry="2.2" />
        </g>
      </g>

      {/* Top-right compact status micro-badges (kept inside [52..68, 5..18]) */}
      {showBadge && (
        <g className="ai-mascot-badge">
          {mood === 'thinking' && (
            <g className="ai-mascot-badge-dots">
              <rect
                className="ai-mascot-badge-pill"
                x="52.5"
                y="7.5"
                width="15"
                height="9"
                rx="4.5"
              />
              <circle
                className="ai-mascot-badge-dot ai-mascot-badge-dot-1"
                cx="56.2"
                cy="12"
                r="1.25"
              />
              <circle
                className="ai-mascot-badge-dot ai-mascot-badge-dot-2"
                cx="60"
                cy="12"
                r="1.25"
              />
              <circle
                className="ai-mascot-badge-dot ai-mascot-badge-dot-3"
                cx="63.8"
                cy="12"
                r="1.25"
              />
            </g>
          )}
          {mood === 'working' && (
            <g className="ai-mascot-badge-spark">
              <circle className="ai-mascot-badge-spark-bg" cx="60.5" cy="11.5" r="5.2" />
              <path
                className="ai-mascot-badge-spark-star"
                d="M60.5 7.4 L61.5 10.5 L64.6 11.5 L61.5 12.5 L60.5 15.6 L59.5 12.5 L56.4 11.5 L59.5 10.5 Z"
              />
            </g>
          )}
          {mood === 'unread-done' && (
            <g className="ai-mascot-badge-unread">
              <circle className="ai-mascot-badge-unread-ring" cx="61" cy="11.5" r="4.6" />
              <circle className="ai-mascot-badge-unread-core" cx="61" cy="11.5" r="3" />
            </g>
          )}
          {mood === 'attention' && (
            <g className="ai-mascot-badge-attention">
              <circle className="ai-mascot-badge-attention-bg" cx="60.5" cy="11.5" r="5.2" />
              <path
                className="ai-mascot-badge-glyph"
                d="M60.5 8.5 V11.9"
                strokeWidth="1.65"
                strokeLinecap="round"
              />
              <circle className="ai-mascot-badge-glyph-dot" cx="60.5" cy="14.2" r="0.9" />
            </g>
          )}
          {mood === 'error' && (
            <g className="ai-mascot-badge-error">
              <circle className="ai-mascot-badge-error-bg" cx="60.5" cy="11.5" r="5.2" />
              <path
                className="ai-mascot-badge-glyph"
                d="M58.5 9.5 L62.5 13.5 M62.5 9.5 L58.5 13.5"
                strokeWidth="1.65"
                strokeLinecap="round"
              />
            </g>
          )}
          {mood === 'sleepy' && (
            <g className="ai-mascot-badge-zzz">
              <path
                className="ai-mascot-zzz ai-mascot-zzz-1"
                d="M55.2 13 H58.6 L55.2 16.4 H58.6"
                strokeWidth="1.45"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                className="ai-mascot-zzz ai-mascot-zzz-2"
                d="M60.8 7.5 H65 L60.8 11.7 H65"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>
          )}
        </g>
      )}
    </svg>
  )
}
