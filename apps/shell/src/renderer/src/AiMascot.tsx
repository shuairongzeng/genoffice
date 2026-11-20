import { useId } from 'react'
import type { AiPetId } from '../../shared/ai-pet-prefs'
import type { AiPetMood as BaseAiPetMood } from './ai-pet-state'
import './ai-pet-artwork.css'

/** Complete set of 14 visual moods supported by all pet mascots. */
export type MascotMood = BaseAiPetMood | 'fed' | 'playful'

export interface MascotSvgProps {
  /** Active behavioral mood driving eyes, aura, secondary rigs, and status badges */
  readonly mood?: MascotMood
  /** Decorative host mode (e.g. empty panel greeting): hides notification badges */
  readonly decorative?: boolean
  readonly className?: string
  /** Companion species identifier (defaults to 'bluebird') */
  readonly petId?: AiPetId
}

interface ArtworkProps {
  readonly mood: MascotMood
  readonly uid: string
  readonly idSpec: string
}

interface ExpressiveEyesProps {
  readonly mood: MascotMood
  readonly idIris: string
  readonly leftX: number
  readonly rightX: number
  readonly eyeY: number
  readonly rx: number
  readonly ry: number
  readonly irisR: number
  readonly pupilRx: number
  readonly pupilRy: number
  readonly lightArcs?: boolean
}

/** Shared expressive eye pair supporting sleepy, happy, error brow, and gaze tracking. */
function ExpressiveEyes({
  mood,
  idIris,
  leftX,
  rightX,
  eyeY,
  rx,
  ry,
  irisR,
  pupilRx,
  pupilRy,
  lightArcs = false,
}: ExpressiveEyesProps): React.JSX.Element {
  const eyesClosed = mood === 'sleepy'
  const eyesHappy = mood === 'petted'
  const showErrorBrow = mood === 'error'
  const closedClass = lightArcs
    ? 'ai-mascot-eye-closed ai-pet-panda-eye-closed'
    : 'ai-mascot-eye-closed'
  const happyClass = lightArcs
    ? 'ai-mascot-eye-happy ai-pet-panda-eye-happy'
    : 'ai-mascot-eye-happy'
  const browClass = lightArcs ? 'ai-mascot-brow ai-pet-panda-brow' : 'ai-mascot-brow'
  const arcHalf = Math.max(3.2, rx * 0.86)

  if (eyesClosed) {
    return (
      <g className="ai-mascot-eyes-closed">
        <path
          className={closedClass}
          d={`M${leftX - arcHalf} ${eyeY + 0.3} Q${leftX} ${eyeY + 3.1} ${leftX + arcHalf} ${eyeY + 0.3}`}
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          className={closedClass}
          d={`M${rightX - arcHalf} ${eyeY + 0.3} Q${rightX} ${eyeY + 3.1} ${rightX + arcHalf} ${eyeY + 0.3}`}
          strokeWidth="2"
          strokeLinecap="round"
        />
      </g>
    )
  }

  if (eyesHappy) {
    return (
      <g className="ai-mascot-eyes-happy">
        <path
          className={happyClass}
          d={`M${leftX - arcHalf} ${eyeY + 0.9} Q${leftX} ${eyeY - 2.9} ${leftX + arcHalf} ${eyeY + 0.9}`}
          strokeWidth="2.1"
          strokeLinecap="round"
        />
        <path
          className={happyClass}
          d={`M${rightX - arcHalf} ${eyeY + 0.9} Q${rightX} ${eyeY - 2.9} ${rightX + arcHalf} ${eyeY + 0.9}`}
          strokeWidth="2.1"
          strokeLinecap="round"
        />
      </g>
    )
  }

  return (
    <g className="ai-mascot-eyes-open">
      {[
        { x: leftX, browD: `M-3.5 -5.6 Q-0.4 -4.6 3.0 -6.4` },
        { x: rightX, browD: `M-3.0 -6.4 Q0.4 -4.6 3.5 -5.6` },
      ].map((side) => (
        <g key={side.x} className="ai-mascot-eye" transform={`translate(${side.x} ${eyeY})`}>
          <g className="ai-mascot-blink">
            <ellipse className="ai-mascot-eyeball" cx="0" cy="0" rx={rx} ry={ry} />
            <g className="ai-mascot-iris-group">
              <circle className="ai-mascot-iris" cx="0" cy="0" r={irisR} fill={`url(#${idIris})`} />
              <ellipse className="ai-mascot-pupil" cx="0" cy="0" rx={pupilRx} ry={pupilRy} />
              <circle className="ai-mascot-glint" cx="-1.0" cy="-1.1" r="0.95" />
              <circle className="ai-mascot-glint-sub" cx="0.85" cy="1.0" r="0.45" />
            </g>
          </g>
          {showErrorBrow && (
            <path className={browClass} d={side.browD} strokeWidth="1.4" strokeLinecap="round" />
          )}
        </g>
      ))}
    </g>
  )
}

/** Shared top-right status micro-badges kept inside [52..68, 5..18]. */
function SharedStatusBadge({ mood }: { readonly mood: MascotMood }): React.JSX.Element {
  return (
    <g className="ai-mascot-badge">
      {mood === 'thinking' && (
        <g className="ai-mascot-badge-dots">
          <rect className="ai-mascot-badge-pill" x="52.5" y="7.5" width="15" height="9" rx="4.5" />
          <circle
            className="ai-mascot-badge-dot ai-mascot-badge-dot-1"
            cx="56.2"
            cy="12"
            r="1.25"
          />
          <circle className="ai-mascot-badge-dot ai-mascot-badge-dot-2" cx="60" cy="12" r="1.25" />
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
  )
}

/** Species-specific floating particles for `fed` and `playful` moods inside [6..66, 9..28]. */
function PetParticles({
  petId,
  mood,
}: {
  readonly petId: AiPetId
  readonly mood: MascotMood
}): React.JSX.Element | null {
  if (mood === 'fed') {
    return (
      <g className="ai-pet-particles ai-pet-particles-fed">
        {petId === 'bluebird' && (
          <>
            <path
              className="ai-pet-treat-leaf"
              d="M12.5 16.8 C13.5 13.8 16.5 13.2 17.2 15.2 C15.6 16.6 13.8 17.2 12.5 16.8 Z"
            />
            <circle className="ai-pet-treat-berry" cx="11.5" cy="19.5" r="2.7" />
            <circle className="ai-mascot-glint" cx="10.7" cy="18.6" r="0.8" />
            <circle className="ai-pet-treat-berry" cx="15.4" cy="21.4" r="2.3" />
            <circle className="ai-mascot-glint" cx="14.7" cy="20.6" r="0.7" />
            <path
              className="ai-pet-treat-note"
              d="M58.2 18.8 V12.8 L62.8 11.6 V17.2"
              fill="none"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle className="ai-pet-treat-note" cx="56.8" cy="19.2" r="1.6" />
            <circle className="ai-pet-treat-note" cx="61.4" cy="17.6" r="1.6" />
          </>
        )}
        {petId === 'cat' && (
          <>
            <path
              className="ai-pet-treat-fish"
              d="M9.5 17.5 C11.5 14.5 15.8 14.8 17.5 17.5 C15.8 20.2 11.5 20.5 9.5 17.5 Z"
            />
            <path className="ai-pet-treat-fish" d="M17.2 17.5 L20.4 15.2 V19.8 Z" />
            <circle className="ai-mascot-pupil" cx="11.8" cy="17.2" r="0.65" />
            <path
              className="ai-pet-treat-heart"
              d="M59.5 19.8 C57 17.6 55.5 15.6 56.8 13.8 C57.8 12.5 59.2 13.2 59.5 14.4 C59.8 13.2 61.2 12.5 62.2 13.8 C63.5 15.6 62 17.6 59.5 19.8 Z"
            />
          </>
        )}
        {petId === 'robot' && (
          <>
            <path
              className="ai-pet-treat-bolt"
              d="M13.8 12.2 L9.8 18.2 H13.2 L12.2 22.8 L16.8 16.6 H13.2 Z"
              strokeLinejoin="round"
            />
            <rect
              className="ai-pet-treat-battery-frame"
              x="55.5"
              y="13.5"
              width="9.2"
              height="5.4"
              rx="1.4"
            />
            <rect
              className="ai-pet-treat-battery-cap"
              x="64.8"
              y="15.1"
              width="1.4"
              height="2.2"
              rx="0.5"
            />
            <rect
              className="ai-pet-treat-battery-fill"
              x="57"
              y="14.9"
              width="6.2"
              height="2.6"
              rx="0.6"
            />
          </>
        )}
        {petId === 'fox' && (
          <>
            <path
              className="ai-pet-treat-leaf"
              d="M10.8 16.6 C11.8 13.8 14.8 13.4 15.2 15.4 C13.6 16.6 12 17 10.8 16.6 Z"
            />
            <circle className="ai-pet-treat-berry" cx="10.2" cy="19.2" r="2.5" />
            <circle className="ai-mascot-glint" cx="9.5" cy="18.4" r="0.7" />
            <circle className="ai-pet-treat-berry" cx="13.8" cy="21" r="2.2" />
            <circle className="ai-mascot-glint" cx="13.2" cy="20.2" r="0.6" />
            <path
              className="ai-pet-spark-gold"
              d="M60 12.2 L61.1 15.3 L64.2 16.4 L61.1 17.5 L60 20.6 L58.9 17.5 L55.8 16.4 L58.9 15.3 Z"
            />
          </>
        )}
        {petId === 'panda' && (
          <>
            <path
              className="ai-pet-treat-leaf"
              d="M8.5 18.5 C10 14.5 14 13.8 15.5 16.5 C13.5 18.8 10.5 19.5 8.5 18.5 Z"
            />
            <path
              className="ai-pet-treat-leaf"
              d="M10.2 22.5 C11.8 19.8 15 19.8 16.2 21.8 C14.4 23.2 11.8 23.5 10.2 22.5 Z"
            />
            <path
              className="ai-pet-treat-heart"
              d="M60.5 19.2 C58.2 17.2 56.8 15.4 58 13.8 C58.9 12.6 60.2 13.2 60.5 14.3 C60.8 13.2 62.1 12.6 63 13.8 C64.2 15.4 62.8 17.2 60.5 19.2 Z"
            />
          </>
        )}
      </g>
    )
  }

  if (mood === 'playful') {
    return (
      <g className="ai-pet-particles ai-pet-particles-playful">
        {petId === 'cat' ? (
          <>
            <circle className="ai-pet-yarn-ball" cx="12" cy="18.2" r="3.4" />
            <path
              className="ai-pet-yarn-thread"
              d="M9.6 16.8 Q12 18.4 14.6 16.8"
              strokeWidth="0.9"
            />
            <path
              className="ai-pet-yarn-thread"
              d="M9.6 19.6 Q12 17.8 14.4 19.8"
              strokeWidth="0.9"
            />
            <path
              className="ai-pet-spark-gold"
              d="M59.5 12.4 L60.5 15.1 L63.2 16.1 L60.5 17.1 L59.5 19.8 L58.5 17.1 L55.8 16.1 L58.5 15.1 Z"
            />
          </>
        ) : petId === 'robot' ? (
          <>
            <rect className="ai-pet-spark-cyan" x="11" y="13.5" width="2.2" height="6.6" rx="0.6" />
            <rect
              className="ai-pet-spark-cyan"
              x="8.8"
              y="15.7"
              width="6.6"
              height="2.2"
              rx="0.6"
            />
            <rect className="ai-pet-spark-gold" x="58.5" y="12" width="2.2" height="2.2" rx="0.5" />
            <rect
              className="ai-pet-spark-pink"
              x="61.5"
              y="14.8"
              width="2.2"
              height="2.2"
              rx="0.5"
            />
            <rect
              className="ai-pet-spark-mint"
              x="58.5"
              y="17.6"
              width="2.2"
              height="2.2"
              rx="0.5"
            />
          </>
        ) : petId === 'panda' ? (
          <>
            <path
              className="ai-pet-spark-mint"
              d="M11.8 12.6 L12.9 15.5 L15.8 16.6 L12.9 17.7 L11.8 20.6 L10.7 17.7 L7.8 16.6 L10.7 15.5 Z"
            />
            <path
              className="ai-pet-treat-heart"
              d="M60.5 19.4 C58.2 17.4 56.8 15.6 58 14 C58.9 12.8 60.2 13.4 60.5 14.5 C60.8 13.4 62.1 12.8 63 14 C64.2 15.6 62.8 17.4 60.5 19.4 Z"
            />
          </>
        ) : (
          <>
            <path
              className="ai-pet-spark-gold"
              d="M12.2 12.2 L13.3 15.2 L16.3 16.3 L13.3 17.4 L12.2 20.4 L11.1 17.4 L8.1 16.3 L11.1 15.2 Z"
            />
            <circle className="ai-pet-spark-cyan" cx="15.8" cy="22.4" r="1.3" />
            <path
              className={petId === 'fox' ? 'ai-pet-spark-gold' : 'ai-pet-treat-heart'}
              d={
                petId === 'fox'
                  ? 'M59.8 12.8 L60.8 15.5 L63.5 16.5 L60.8 17.5 L59.8 20.2 L58.8 17.5 L56.1 16.5 L58.8 15.5 Z'
                  : 'M59.5 19.6 C57.2 17.6 55.8 15.8 57 14.2 C57.9 13 59.2 13.6 59.5 14.7 C59.8 13.6 61.1 13 62 14.2 C63.2 15.8 61.8 17.6 59.5 19.6 Z'
              }
            />
          </>
        )}
      </g>
    )
  }

  return null
}

/** 2.5D Lively Bluebird ("Pip") — preserves all backward-compatible structure and classes. */
function BluebirdArtwork({ mood, uid, idSpec }: ArtworkProps): React.JSX.Element {
  const idBody = `${uid}-body`
  const idBelly = `${uid}-belly`
  const idWing = `${uid}-wing`
  const idTuft = `${uid}-tuft`
  const idBeak = `${uid}-beak`
  const idIris = `${uid}-iris`

  const eyesClosed = mood === 'sleepy'
  const eyesHappy = mood === 'petted'
  const showErrorBrow = mood === 'error'

  return (
    <>
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
      </defs>

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

          {/* Rim highlight along top contour */}
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
            {(mood === 'fed' || mood === 'playful') && (
              <ellipse className="ai-pet-bluebird-mouth" cx="36" cy="40.8" rx="1.4" ry="0.9" />
            )}
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
    </>
  )
}

/** 2.5D Ginger Tabby Cat ("Mochi") with independent ears, curled tail, and whiskers. */
function CatArtwork({ mood, uid, idSpec }: ArtworkProps): React.JSX.Element {
  const idCatBody = `${uid}-cat-body`
  const idCatBib = `${uid}-cat-bib`
  const idCatIris = `${uid}-cat-iris`

  return (
    <>
      <defs>
        <radialGradient id={idCatBody} cx="35%" cy="26%" r="74%" fx="32%" fy="22%">
          <stop offset="0%" className="ai-pet-stop-cat-hi" />
          <stop offset="55%" className="ai-pet-stop-cat-mid" />
          <stop offset="100%" className="ai-pet-stop-cat-lo" />
        </radialGradient>
        <radialGradient id={idCatBib} cx="50%" cy="30%" r="70%">
          <stop offset="0%" className="ai-pet-stop-cat-bib-hi" />
          <stop offset="100%" className="ai-pet-stop-cat-bib-lo" />
        </radialGradient>
        <radialGradient id={idCatIris} cx="38%" cy="32%" r="72%">
          <stop offset="0%" className="ai-pet-stop-cat-iris-hi" />
          <stop offset="100%" className="ai-pet-stop-cat-iris-lo" />
        </radialGradient>
      </defs>

      <g className="ai-mascot-body-rig">
        <g className="ai-mascot-breathe">
          {/* Curled ginger tail with cream tip */}
          <g className="ai-pet-cat-tail">
            <path
              fill={`url(#${idCatBody})`}
              d="M49.5 49.5 C57.5 50 63.5 44.5 63.5 37.5 C63.5 32.8 59.5 31.2 57.5 33.8 C56 35.8 57.2 39.2 55.2 42.8 C53.4 46 50.8 47 48.8 47 Z"
            />
            <path
              className="ai-pet-cat-tail-tip"
              d="M57.8 33.5 C59.8 31.4 63.4 32.8 63.5 37 C61.4 36.2 59.4 36.4 57.5 37.6 C56.8 35.8 57 34.4 57.8 33.5 Z"
            />
          </g>

          {/* Left pointed ear */}
          <g className="ai-pet-cat-ear-l">
            <path fill={`url(#${idCatBody})`} d="M20.2 24.4 L17.2 9.6 Q22.8 11.4 29.2 17.6 Z" />
            <path className="ai-pet-cat-ear-inner" d="M20.8 21.6 L19 12.8 Q22.8 14.2 26.8 18.2 Z" />
          </g>

          {/* Right pointed ear */}
          <g className="ai-pet-cat-ear-r">
            <path fill={`url(#${idCatBody})`} d="M51.8 24.4 L54.8 9.6 Q49.2 11.4 42.8 17.6 Z" />
            <path className="ai-pet-cat-ear-inner" d="M51.2 21.6 L53 12.8 Q49.2 14.2 45.2 18.2 Z" />
          </g>

          {/* Seated chubby cat silhouette */}
          <path
            className="ai-mascot-shape"
            fill={`url(#${idCatBody})`}
            d="M36 16.5 C46.8 16.5 54 22.8 54 32 C54 37.2 52.4 40 53.4 45.6 C54.4 51.6 49.5 56.8 36 56.8 C22.5 56.8 17.6 51.6 18.6 45.6 C19.6 40 18 37.2 18 32 C18 22.8 25.2 16.5 36 16.5 Z"
          />

          {/* Top-left specular highlight and contour rim */}
          <path
            className="ai-mascot-specular"
            fill={`url(#${idSpec})`}
            d="M21 25.5 C24 20 30.5 17.8 37 18.4 C32 19.8 26.5 22.4 23.2 27.6 C21.8 29.2 19.8 27.5 21 25.5 Z"
          />
          <path
            className="ai-mascot-rim"
            d="M29.4 17.8 C31.6 17 33.8 16.8 36 16.8 C38.2 16.8 40.4 17 42.6 17.8"
            strokeWidth="1.15"
            strokeLinecap="round"
          />

          {/* Cream bib and seated paws */}
          <path
            fill={`url(#${idCatBib})`}
            d="M36 39 C43.5 39 46.5 44.5 46 50.5 C45.5 54.5 41.5 56.2 36 56.2 C30.5 56.2 26.5 54.5 26 50.5 C25.5 44.5 28.5 39 36 39 Z"
          />
          <ellipse fill={`url(#${idCatBib})`} cx="30.6" cy="54.2" rx="4.2" ry="2.4" />
          <ellipse fill={`url(#${idCatBib})`} cx="41.4" cy="54.2" rx="4.2" ry="2.4" />
          <circle className="ai-pet-cat-paw-pad" cx="30.6" cy="54.4" r="1.1" />
          <circle className="ai-pet-cat-paw-pad" cx="41.4" cy="54.4" r="1.1" />

          {/* Warm tabby markings on forehead, cheeks, and flanks */}
          <g className="ai-pet-cat-stripes">
            <path
              className="ai-pet-cat-stripe"
              d="M36 18.2 V22.4 M32.4 18.8 Q33.2 21 33.4 22.8 M39.6 18.8 Q38.8 21 38.6 22.8"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
            <path
              className="ai-pet-cat-stripe"
              d="M19.2 30.8 Q21.6 31.2 22.6 32.2 M19.4 33.8 Q21.5 34 22.4 34.8"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
            <path
              className="ai-pet-cat-stripe"
              d="M52.8 30.8 Q50.4 31.2 49.4 32.2 M52.6 33.8 Q50.5 34 49.6 34.8"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
            <path
              className="ai-pet-cat-stripe"
              d="M19.8 46.5 Q22.2 47 23.4 48.2 M52.2 46.5 Q49.8 47 48.6 48.2"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </g>

          <ExpressiveEyes
            mood={mood}
            idIris={idCatIris}
            leftX={27.5}
            rightX={44.5}
            eyeY={30.8}
            rx={4.4}
            ry={4.7}
            irisR={3.0}
            pupilRx={1.35}
            pupilRy={2.2}
          />

          {/* Whiskers, pink triangle nose, and w-shaped muzzle */}
          <g className="ai-pet-cat-whiskers">
            <path
              className="ai-pet-cat-whisker"
              d="M14.2 32.8 Q18.5 33.2 22.4 34.4 M14.4 36.2 Q18.5 36 22.2 36.2"
              strokeWidth="1"
              strokeLinecap="round"
            />
            <path
              className="ai-pet-cat-whisker"
              d="M57.8 32.8 Q53.5 33.2 49.6 34.4 M57.6 36.2 Q53.5 36 49.8 36.2"
              strokeWidth="1"
              strokeLinecap="round"
            />
          </g>
          <path className="ai-pet-cat-nose" d="M34.4 34.2 H37.6 Q36 36.4 34.4 34.2 Z" />
          {(mood === 'fed' || mood === 'playful') && (
            <path className="ai-pet-cat-tongue" d="M34.6 36.6 Q36 39.2 37.4 36.6 Z" />
          )}
          <path
            className="ai-pet-cat-mouth"
            d="M32.4 36.4 Q34.2 38 36 36.2 Q37.8 38 39.6 36.4"
            strokeWidth="1.2"
            strokeLinecap="round"
          />

          <ellipse className="ai-mascot-blush" cx="20.6" cy="36.2" rx="3.4" ry="1.9" />
          <ellipse className="ai-mascot-blush" cx="51.4" cy="36.2" rx="3.4" ry="1.9" />

          {mood === 'sleepy' && (
            <g className="ai-pet-cat-bubble">
              <circle cx="41.5" cy="38.8" r="2.6" strokeWidth="0.9" />
              <circle className="ai-pet-cat-bubble-glint" cx="40.7" cy="38" r="0.7" />
            </g>
          )}
        </g>
      </g>
    </>
  )
}

/** 2.5D Cyber Bot ("Byte") with glowing antenna, dark visor, and LED gaze eyes. */
function RobotArtwork({ mood, uid, idSpec }: ArtworkProps): React.JSX.Element {
  const idChassis = `${uid}-robot-chassis`
  const idVisor = `${uid}-robot-visor`
  const idLed = `${uid}-robot-led`
  const idAntenna = `${uid}-robot-antenna`

  const eyesClosed = mood === 'sleepy'
  const eyesHappy = mood === 'petted'
  const showErrorBrow = mood === 'error'

  return (
    <>
      <defs>
        <radialGradient id={idChassis} cx="35%" cy="25%" r="76%">
          <stop offset="0%" className="ai-pet-stop-robot-hi" />
          <stop offset="56%" className="ai-pet-stop-robot-mid" />
          <stop offset="100%" className="ai-pet-stop-robot-lo" />
        </radialGradient>
        <linearGradient id={idVisor} x1="15%" y1="0%" x2="85%" y2="100%">
          <stop offset="0%" className="ai-pet-stop-robot-visor-hi" />
          <stop offset="100%" className="ai-pet-stop-robot-visor-lo" />
        </linearGradient>
        <radialGradient id={idLed} cx="38%" cy="32%" r="72%">
          <stop offset="0%" className="ai-pet-stop-robot-led-hi" />
          <stop offset="100%" className="ai-pet-stop-robot-led-lo" />
        </radialGradient>
        <radialGradient id={idAntenna} cx="36%" cy="32%" r="70%">
          <stop offset="0%" className="ai-pet-stop-robot-antenna-hi" />
          <stop offset="100%" className="ai-pet-stop-robot-antenna-lo" />
        </radialGradient>
      </defs>

      <g className="ai-mascot-body-rig">
        <g className="ai-mascot-breathe">
          {/* Glowing top orb antenna */}
          <g className="ai-pet-robot-antenna">
            <rect
              className="ai-pet-robot-antenna-base"
              x="32.5"
              y="14.5"
              width="7"
              height="3"
              rx="1.2"
            />
            <path
              className="ai-pet-robot-antenna-stem"
              d="M36 14.5 V9.8"
              strokeWidth="2.1"
              strokeLinecap="round"
            />
            <circle
              className="ai-pet-robot-antenna-orb"
              cx="36"
              cy="7.6"
              r="2.9"
              fill={`url(#${idAntenna})`}
            />
            <circle className="ai-mascot-glint" cx="35" cy="6.6" r="0.9" />
          </g>

          {/* Floating side arms */}
          <g className="ai-pet-robot-arm-l">
            <path
              fill={`url(#${idChassis})`}
              d="M16.8 38.5 C12.5 38.8 11.4 43.8 14 46.8 C15.8 48.6 18.4 47.4 18.8 44.8 Z"
            />
          </g>
          <g className="ai-pet-robot-arm-r">
            <path
              fill={`url(#${idChassis})`}
              d="M55.2 38.5 C59.5 38.8 60.6 43.8 58 46.8 C56.2 48.6 53.6 47.4 53.2 44.8 Z"
            />
          </g>

          {/* Headphone ear pods */}
          <rect className="ai-pet-robot-ear" x="14.2" y="25.5" width="4.2" height="10.5" rx="2" />
          <rect className="ai-pet-robot-ear" x="53.6" y="25.5" width="4.2" height="10.5" rx="2" />

          {/* Lower torso chassis and chest power core */}
          <path
            fill={`url(#${idChassis})`}
            d="M23.5 44.5 H48.5 C50 44.5 51 46 50.5 48.5 L49 53.5 C48.4 55.5 46.2 56.6 43.6 56.6 H28.4 C25.8 56.6 23.6 55.5 23 53.5 L21.5 48.5 C21 46 22 44.5 23.5 44.5 Z"
          />
          <circle className="ai-pet-robot-core" cx="36" cy="50.6" r="2.7" fill={`url(#${idLed})`} />
          <circle className="ai-mascot-glint" cx="35.1" cy="49.7" r="0.8" />

          {/* Rounded metallic head shell */}
          <rect
            className="ai-mascot-shape"
            x="17.5"
            y="17"
            width="37"
            height="28.5"
            rx="11"
            fill={`url(#${idChassis})`}
          />
          <path
            className="ai-mascot-specular"
            fill={`url(#${idSpec})`}
            d="M20.5 23 C22.5 18.8 27 17.6 33.5 17.8 C29 19 24.5 20.6 21.8 25 C20.8 26.2 19.6 24.8 20.5 23 Z"
          />
          <path
            className="ai-mascot-rim"
            d="M23 17.6 H49"
            strokeWidth="1.15"
            strokeLinecap="round"
          />

          {/* Dark reflective glass visor */}
          <rect
            className="ai-pet-robot-visor"
            x="20.5"
            y="21.5"
            width="31"
            height="19.5"
            rx="7.5"
            fill={`url(#${idVisor})`}
            strokeWidth="1.1"
          />
          <path className="ai-pet-robot-visor-glare" d="M22.5 29.2 L29.5 22.4 H35.5 L24.5 33.2 Z" />

          {/* Expressive LED visor face */}
          {eyesClosed ? (
            <g className="ai-mascot-eyes-closed">
              <path
                className="ai-pet-robot-eye-closed"
                d="M25 31.2 H32 M40 31.2 H47"
                strokeWidth="2.1"
                strokeLinecap="round"
              />
              <path
                className="ai-pet-robot-eye-closed"
                d="M34 36.2 H38"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </g>
          ) : eyesHappy ? (
            <g className="ai-mascot-eyes-happy">
              <path
                className="ai-pet-robot-eye-happy"
                d="M24.8 32.6 L28.5 28.4 L32.2 32.6 M39.8 32.6 L43.5 28.4 L47.2 32.6"
                strokeWidth="2.1"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <rect
                className="ai-pet-robot-blush"
                x="23"
                y="34.5"
                width="3.2"
                height="1.8"
                rx="0.6"
              />
              <rect
                className="ai-pet-robot-blush"
                x="45.8"
                y="34.5"
                width="3.2"
                height="1.8"
                rx="0.6"
              />
              <path
                className="ai-pet-robot-mouth"
                d="M33 35.8 Q36 38.4 39 35.8"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </g>
          ) : (
            <g className="ai-mascot-eyes-open">
              {[
                { x: 28.5, browD: 'M-3.5 -5.2 L3.2 -3.8' },
                { x: 43.5, browD: 'M-3.2 -3.8 L3.5 -5.2' },
              ].map((side) => (
                <g key={side.x} className="ai-mascot-eye" transform={`translate(${side.x} 31.2)`}>
                  <g className="ai-mascot-blink">
                    <ellipse className="ai-pet-robot-eye-glow" cx="0" cy="0" rx="4.2" ry="4.4" />
                    <g className="ai-mascot-iris-group">
                      <rect
                        className="ai-pet-robot-led"
                        x="-2.8"
                        y="-3.2"
                        width="5.6"
                        height="6.4"
                        rx="2.2"
                        fill={`url(#${idLed})`}
                      />
                      <circle className="ai-mascot-glint" cx="-0.9" cy="-1.2" r="1" />
                    </g>
                  </g>
                  {showErrorBrow && (
                    <path
                      className="ai-mascot-brow ai-pet-robot-brow"
                      d={side.browD}
                      strokeWidth="1.45"
                      strokeLinecap="round"
                    />
                  )}
                </g>
              ))}
              {(mood === 'fed' || mood === 'playful') && (
                <path
                  className="ai-pet-robot-mouth"
                  d="M32.5 36.2 Q36 39 39.5 36.2"
                  strokeWidth="1.45"
                  strokeLinecap="round"
                />
              )}
            </g>
          )}
        </g>
      </g>
    </>
  )
}

/** 2.5D Russet Fox ("Vesper") with sharp dark-tipped ears, cream cheeks, and fluffy tail. */
function FoxArtwork({ mood, uid, idSpec }: ArtworkProps): React.JSX.Element {
  const idFoxBody = `${uid}-fox-body`
  const idFoxCream = `${uid}-fox-cream`
  const idFoxIris = `${uid}-fox-iris`

  return (
    <>
      <defs>
        <radialGradient id={idFoxBody} cx="35%" cy="26%" r="74%" fx="30%" fy="22%">
          <stop offset="0%" className="ai-pet-stop-fox-hi" />
          <stop offset="56%" className="ai-pet-stop-fox-mid" />
          <stop offset="100%" className="ai-pet-stop-fox-lo" />
        </radialGradient>
        <radialGradient id={idFoxCream} cx="50%" cy="35%" r="70%">
          <stop offset="0%" className="ai-pet-stop-fox-cream-hi" />
          <stop offset="100%" className="ai-pet-stop-fox-cream-lo" />
        </radialGradient>
        <radialGradient id={idFoxIris} cx="38%" cy="32%" r="72%">
          <stop offset="0%" className="ai-pet-stop-fox-iris-hi" />
          <stop offset="100%" className="ai-pet-stop-fox-iris-lo" />
        </radialGradient>
      </defs>

      <g className="ai-mascot-body-rig">
        <g className="ai-mascot-breathe">
          {/* Fluffy sweeping tail with cream tip */}
          <g className="ai-pet-fox-tail">
            <path
              fill={`url(#${idFoxBody})`}
              d="M43.5 51.8 C54 52.8 64 46.5 64.5 36.5 C64.8 30 60 27.4 55.4 30.4 C51.4 33 50.8 40.5 45.5 44.5 Z"
            />
            <path
              fill={`url(#${idFoxCream})`}
              d="M57.2 29.8 C61 28.2 64.5 30.8 64.4 35.8 C62.2 34.4 59.4 34.6 56.6 36.2 C55.4 33.4 56 31 57.2 29.8 Z"
            />
          </g>

          {/* Left dark-tipped triangular ear */}
          <g className="ai-pet-fox-ear-l">
            <path fill={`url(#${idFoxBody})`} d="M20.5 24.5 L16.2 7.5 Q23 11 29.8 18 Z" />
            <path
              className="ai-pet-fox-ear-tip"
              d="M17.8 14.2 L16.2 7.5 Q19.7 9.4 22.8 12.2 Q19.8 12.5 17.8 14.2 Z"
            />
            <path className="ai-pet-fox-ear-inner" d="M21.2 22 L19 13.8 Q23 15.2 27 18.8 Z" />
          </g>

          {/* Right dark-tipped triangular ear */}
          <g className="ai-pet-fox-ear-r">
            <path fill={`url(#${idFoxBody})`} d="M48.5 24.5 L52.8 7.5 Q46 11 39.2 18 Z" />
            <path
              className="ai-pet-fox-ear-tip"
              d="M51.2 14.2 L52.8 7.5 Q49.3 9.4 46.2 12.2 Q49.2 12.5 51.2 14.2 Z"
            />
            <path className="ai-pet-fox-ear-inner" d="M47.8 22 L50 13.8 Q46 15.2 42 18.8 Z" />
          </g>

          {/* Seated torso, chest ruff, and dark paws */}
          <path
            fill={`url(#${idFoxBody})`}
            d="M34.5 36.5 C43.5 36.5 48.5 42.5 48.5 49.5 C48.5 54.5 42.5 56.8 34.5 56.8 C26.5 56.8 20.5 54.5 20.5 49.5 C20.5 42.5 25.5 36.5 34.5 36.5 Z"
          />
          <path
            fill={`url(#${idFoxCream})`}
            d="M34.5 38.5 C39.8 38.5 42.5 43.2 41.2 49.2 C39.5 53.2 37.2 55.2 34.5 55.2 C31.8 55.2 29.5 53.2 27.8 49.2 C26.5 43.2 29.2 38.5 34.5 38.5 Z"
          />
          <ellipse className="ai-pet-fox-paw" cx="29.8" cy="54.6" rx="3.4" ry="2.1" />
          <ellipse className="ai-pet-fox-paw" cx="39.2" cy="54.6" rx="3.4" ry="2.1" />

          {/* Sculpted head with cream cheek fur */}
          <path
            className="ai-mascot-shape"
            fill={`url(#${idFoxBody})`}
            d="M34.5 16.5 C45 16.5 51.5 22.8 51.8 29.5 C52 34.8 46.8 39.8 34.5 40.5 C22.2 39.8 17 34.8 17.2 29.5 C17.5 22.8 24 16.5 34.5 16.5 Z"
          />
          <path
            fill={`url(#${idFoxCream})`}
            d="M17.5 30.2 C20.5 28.5 27 30.2 30.8 35.8 C27.2 39.2 21.5 38.2 18.2 34.5 C17.2 33 17.1 31.2 17.5 30.2 Z"
          />
          <path
            fill={`url(#${idFoxCream})`}
            d="M51.5 30.2 C48.5 28.5 42 30.2 38.2 35.8 C41.8 39.2 47.5 38.2 50.8 34.5 C51.8 33 51.9 31.2 51.5 30.2 Z"
          />

          {/* Top-left specular crescent and rim highlight */}
          <path
            className="ai-mascot-specular"
            fill={`url(#${idSpec})`}
            d="M20.2 24.8 C23.2 19.6 29.5 17.6 35.8 18.2 C31 19.5 25.8 22 22.6 26.8 C21.2 28.4 19.2 26.8 20.2 24.8 Z"
          />
          <path
            className="ai-mascot-rim"
            d="M28.5 17.4 C30.8 16.8 32.8 16.6 34.5 16.6 C36.5 16.6 38.6 16.8 40.6 17.4"
            strokeWidth="1.15"
            strokeLinecap="round"
          />

          <ExpressiveEyes
            mood={mood}
            idIris={idFoxIris}
            leftX={26.8}
            rightX={42.2}
            eyeY={29.5}
            rx={4.2}
            ry={4.4}
            irisR={2.85}
            pupilRx={1.65}
            pupilRy={1.85}
          />

          {/* Fox nose, gentle smile, and blushes */}
          <ellipse className="ai-pet-fox-nose" cx="34.5" cy="34.8" rx="1.9" ry="1.35" />
          {(mood === 'fed' || mood === 'playful') && (
            <path className="ai-pet-fox-tongue" d="M33.2 36.8 Q34.5 39.2 35.8 36.8 Z" />
          )}
          <path
            className="ai-pet-fox-mouth"
            d="M31.6 36.6 Q33.2 38 34.5 36.4 Q35.8 38 37.4 36.6"
            strokeWidth="1.15"
            strokeLinecap="round"
          />
          <ellipse className="ai-mascot-blush" cx="20.4" cy="34.4" rx="3.2" ry="1.8" />
          <ellipse className="ai-mascot-blush" cx="48.6" cy="34.4" rx="3.2" ry="1.8" />
        </g>
      </g>
    </>
  )
}

/** 2.5D Bamboo Panda ("Rollie") with round dark ears, tilted eye patches, and bamboo sprig. */
function PandaArtwork({ mood, uid, idSpec }: ArtworkProps): React.JSX.Element {
  const idPandaFur = `${uid}-panda-fur`
  const idPandaDark = `${uid}-panda-dark`
  const idPandaIris = `${uid}-panda-iris`
  const idBamboo = `${uid}-panda-bamboo`

  return (
    <>
      <defs>
        <radialGradient id={idPandaFur} cx="35%" cy="28%" r="74%">
          <stop offset="0%" className="ai-pet-stop-panda-hi" />
          <stop offset="60%" className="ai-pet-stop-panda-mid" />
          <stop offset="100%" className="ai-pet-stop-panda-lo" />
        </radialGradient>
        <radialGradient id={idPandaDark} cx="36%" cy="28%" r="76%">
          <stop offset="0%" className="ai-pet-stop-panda-dark-hi" />
          <stop offset="100%" className="ai-pet-stop-panda-dark-lo" />
        </radialGradient>
        <radialGradient id={idPandaIris} cx="38%" cy="32%" r="72%">
          <stop offset="0%" className="ai-pet-stop-panda-iris-hi" />
          <stop offset="100%" className="ai-pet-stop-panda-iris-lo" />
        </radialGradient>
        <linearGradient id={idBamboo} x1="0%" y1="100%" x2="100%" y2="0%">
          <stop offset="0%" className="ai-pet-stop-bamboo-lo" />
          <stop offset="100%" className="ai-pet-stop-bamboo-hi" />
        </linearGradient>
      </defs>

      <g className="ai-mascot-body-rig">
        <g className="ai-mascot-breathe">
          {/* Round dark ears */}
          <g className="ai-pet-panda-ear-l">
            <circle cx="21.2" cy="17.2" r="5.8" fill={`url(#${idPandaDark})`} />
          </g>
          <g className="ai-pet-panda-ear-r">
            <circle cx="50.8" cy="17.2" r="5.8" fill={`url(#${idPandaDark})`} />
          </g>

          {/* Chubby torso */}
          <path
            fill={`url(#${idPandaFur})`}
            d="M36 33 C48 33 56 40 56 49 C56 54.5 48.5 57.2 36 57.2 C23.5 57.2 16 54.5 16 49 C16 40 24 33 36 33 Z"
          />

          {/* Bamboo sprig tucked under the right paw */}
          <g className="ai-pet-panda-bamboo">
            <path
              d="M48.5 50.5 L61.2 34.2"
              stroke={`url(#${idBamboo})`}
              strokeWidth="2.8"
              strokeLinecap="round"
            />
            <path
              className="ai-pet-panda-bamboo-node"
              d="M51.8 44.5 L54.4 46.5 M56 39.2 L58.6 41.2"
              strokeWidth="1.1"
              strokeLinecap="round"
            />
            <path
              fill={`url(#${idBamboo})`}
              d="M58.5 37.6 C61.2 34 65 34.2 65.4 36.8 C63.2 38.2 60.5 38.5 58.5 37.6 Z"
            />
            <path
              fill={`url(#${idBamboo})`}
              d="M56.2 40.2 C53.8 36.2 54.8 32.8 57.6 33.4 C58.2 35.8 57.8 38.4 56.2 40.2 Z"
            />
          </g>

          {/* Dark shoulder arms and seated feet with pink paw pads */}
          <path
            fill={`url(#${idPandaDark})`}
            d="M20.5 39 C15.2 41.2 14.5 47.8 18.8 50.8 C22.5 53.2 26.8 50.2 26.2 46 C25.8 42.5 23.2 39.2 20.5 39 Z"
          />
          <path
            fill={`url(#${idPandaDark})`}
            d="M51.5 39 C56.8 41.2 57.5 47.8 53.2 50.8 C49.5 53.2 45.2 50.2 45.8 46 C46.2 42.5 48.8 39.2 51.5 39 Z"
          />
          <ellipse cx="25.4" cy="54" rx="4.6" ry="3.2" fill={`url(#${idPandaDark})`} />
          <ellipse cx="46.6" cy="54" rx="4.6" ry="3.2" fill={`url(#${idPandaDark})`} />
          <circle className="ai-pet-panda-paw-pad" cx="25.4" cy="54.2" r="1.5" />
          <circle className="ai-pet-panda-paw-pad" cx="46.6" cy="54.2" r="1.5" />

          {/* Round cream head */}
          <path
            className="ai-mascot-shape"
            fill={`url(#${idPandaFur})`}
            d="M36 14.5 C46.8 14.5 53.5 21 53.5 29.5 C53.5 37.5 46.5 41.5 36 41.5 C25.5 41.5 18.5 37.5 18.5 29.5 C18.5 21 25.2 14.5 36 14.5 Z"
          />
          <path
            className="ai-mascot-specular"
            fill={`url(#${idSpec})`}
            d="M21.5 23.5 C24.5 18 30.8 16 37 16.6 C32 18 26.5 20.6 23.4 25.5 C22 27.2 20.2 25.4 21.5 23.5 Z"
          />
          <path
            className="ai-mascot-rim"
            d="M26 16.2 C29 15 32.5 14.8 36 14.8 C39.5 14.8 43 15 46 16.2"
            strokeWidth="1.2"
            strokeLinecap="round"
          />

          {/* Tilted iconic dark eye patches */}
          <path
            fill={`url(#${idPandaDark})`}
            d="M23.5 26.2 C25.8 23.6 30.8 24.4 32.2 27.8 C33.4 30.8 30.6 34.4 27 34.2 C23.2 34 21.4 29 23.5 26.2 Z"
          />
          <path
            fill={`url(#${idPandaDark})`}
            d="M48.5 26.2 C46.2 23.6 41.2 24.4 39.8 27.8 C38.6 30.8 41.4 34.4 45 34.2 C48.8 34 50.6 29 48.5 26.2 Z"
          />

          <ExpressiveEyes
            mood={mood}
            idIris={idPandaIris}
            leftX={27.8}
            rightX={44.2}
            eyeY={29.2}
            rx={3.4}
            ry={3.5}
            irisR={2.35}
            pupilRx={1.4}
            pupilRy={1.45}
            lightArcs
          />

          {/* Nose, gentle smile, and rosy cheeks */}
          <ellipse cx="36" cy="33.5" rx="2.1" ry="1.35" fill={`url(#${idPandaDark})`} />
          {(mood === 'fed' || mood === 'playful') && (
            <path className="ai-pet-panda-tongue" d="M34.6 35.6 Q36 38.2 37.4 35.6 Z" />
          )}
          <path
            className="ai-pet-panda-mouth"
            d="M32.8 35.5 Q34.4 37.2 36 35.4 Q37.6 37.2 39.2 35.5"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
          <ellipse className="ai-mascot-blush" cx="21.8" cy="35.6" rx="3.4" ry="1.9" />
          <ellipse className="ai-mascot-blush" cx="50.2" cy="35.6" rx="3.4" ry="1.9" />
        </g>
      </g>
    </>
  )
}

/**
 * 2.5D companion mascot selector rendering 5 distinct vector species across 14 moods.
 *
 * All geometry, contact shadow, aura ring, particles, and corner badges stay inside
 * [3..69, 3..61] of the 72x64 viewBox so nothing clips inside the 68x62
 * transparent native overlay window (`PET_SIZE`).
 */
export function MascotSvg({
  mood = 'idle',
  decorative = false,
  className,
  petId = 'bluebird',
}: MascotSvgProps): React.JSX.Element {
  const uid = useId().replace(/:/g, '_')
  const idSpec = `${uid}-spec`
  const idAura = `${uid}-aura`

  const showAura =
    !decorative &&
    (mood === 'thinking' ||
      mood === 'working' ||
      mood === 'unread-done' ||
      mood === 'attention' ||
      mood === 'error')

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
      data-pet={petId}
      data-mood={mood}
      data-decorative={decorative ? 'true' : undefined}
      viewBox="0 0 72 64"
      width="56"
      height="50"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={idSpec} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" className="ai-mascot-stop-spec-hi" />
          <stop offset="100%" className="ai-mascot-stop-spec-lo" />
        </linearGradient>
        <linearGradient id={idAura} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" className="ai-mascot-stop-aura-a" />
          <stop offset="100%" className="ai-mascot-stop-aura-b" />
        </linearGradient>
      </defs>

      {/* Soft contact shadow anchored beneath the mascot */}
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

      {petId === 'cat' ? (
        <CatArtwork mood={mood} uid={uid} idSpec={idSpec} />
      ) : petId === 'robot' ? (
        <RobotArtwork mood={mood} uid={uid} idSpec={idSpec} />
      ) : petId === 'fox' ? (
        <FoxArtwork mood={mood} uid={uid} idSpec={idSpec} />
      ) : petId === 'panda' ? (
        <PandaArtwork mood={mood} uid={uid} idSpec={idSpec} />
      ) : (
        <BluebirdArtwork mood={mood} uid={uid} idSpec={idSpec} />
      )}

      <PetParticles petId={petId} mood={mood} />

      {showBadge && <SharedStatusBadge mood={mood} />}
    </svg>
  )
}
