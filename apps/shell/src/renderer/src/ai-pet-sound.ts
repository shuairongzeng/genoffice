import type { AiPetId } from '../../shared/ai-pet-prefs'
import type { AiPetInteractionKind } from './ai-pet-state'

export type AiPetSoundKind = AiPetInteractionKind | 'select'

export interface PetSoundNote {
  /** Starting oscillator frequency in Hz */
  readonly freq: number
  /** Optional target frequency in Hz for a smooth pitch glide */
  readonly slideTo?: number
  /** Start offset in seconds from sound onset */
  readonly startOffsetSec: number
  /** Envelope duration in seconds */
  readonly durationSec: number
  /** Peak gain for this note (kept <= 0.045 for gentle chimes) */
  readonly gain: number
}

export interface PetSoundProfile {
  readonly petId: AiPetId
  readonly kind: AiPetSoundKind
  readonly waveform: OscillatorType
  readonly notes: readonly PetSoundNote[]
}

const PET_SOUND_PROFILES: Record<AiPetId, Record<AiPetSoundKind, Omit<PetSoundProfile, 'petId' | 'kind'>>> = {
  // Bright chirp glide for the bluebird
  bluebird: {
    pet: {
      waveform: 'sine',
      notes: [
        { freq: 988, slideTo: 1319, startOffsetSec: 0, durationSec: 0.1, gain: 0.032 },
        { freq: 1175, slideTo: 1480, startOffsetSec: 0.1, durationSec: 0.12, gain: 0.028 },
      ],
    },
    feed: {
      waveform: 'sine',
      notes: [
        { freq: 1047, slideTo: 1397, startOffsetSec: 0, durationSec: 0.09, gain: 0.032 },
        { freq: 1319, slideTo: 1568, startOffsetSec: 0.095, durationSec: 0.12, gain: 0.03 },
      ],
    },
    play: {
      waveform: 'sine',
      notes: [
        { freq: 1175, slideTo: 1568, startOffsetSec: 0, durationSec: 0.075, gain: 0.032 },
        { freq: 1397, slideTo: 1760, startOffsetSec: 0.075, durationSec: 0.075, gain: 0.032 },
        { freq: 1568, slideTo: 1865, startOffsetSec: 0.15, durationSec: 0.09, gain: 0.026 },
      ],
    },
    select: {
      waveform: 'sine',
      notes: [{ freq: 880, slideTo: 1319, startOffsetSec: 0, durationSec: 0.13, gain: 0.032 }],
    },
  },
  // Soft warm purr/meow chime for the cat
  cat: {
    pet: {
      waveform: 'sine',
      notes: [
        { freq: 440, slideTo: 554, startOffsetSec: 0, durationSec: 0.11, gain: 0.035 },
        { freq: 523, slideTo: 466, startOffsetSec: 0.11, durationSec: 0.12, gain: 0.03 },
      ],
    },
    feed: {
      waveform: 'sine',
      notes: [
        { freq: 494, slideTo: 659, startOffsetSec: 0, durationSec: 0.11, gain: 0.035 },
        { freq: 587, slideTo: 659, startOffsetSec: 0.115, durationSec: 0.11, gain: 0.03 },
      ],
    },
    play: {
      waveform: 'sine',
      notes: [
        { freq: 523, slideTo: 698, startOffsetSec: 0, durationSec: 0.09, gain: 0.034 },
        { freq: 659, slideTo: 784, startOffsetSec: 0.095, durationSec: 0.11, gain: 0.032 },
      ],
    },
    select: {
      waveform: 'sine',
      notes: [{ freq: 415, slideTo: 587, startOffsetSec: 0, durationSec: 0.14, gain: 0.034 }],
    },
  },
  // Crisp 8-bit square arpeggio for the robot
  robot: {
    pet: {
      waveform: 'square',
      notes: [
        { freq: 523, startOffsetSec: 0, durationSec: 0.055, gain: 0.02 },
        { freq: 659, startOffsetSec: 0.06, durationSec: 0.055, gain: 0.02 },
        { freq: 784, startOffsetSec: 0.12, durationSec: 0.08, gain: 0.018 },
      ],
    },
    feed: {
      waveform: 'square',
      notes: [
        { freq: 587, startOffsetSec: 0, durationSec: 0.05, gain: 0.02 },
        { freq: 740, startOffsetSec: 0.055, durationSec: 0.05, gain: 0.02 },
        { freq: 880, startOffsetSec: 0.11, durationSec: 0.09, gain: 0.02 },
      ],
    },
    play: {
      waveform: 'square',
      notes: [
        { freq: 659, startOffsetSec: 0, durationSec: 0.045, gain: 0.02 },
        { freq: 880, startOffsetSec: 0.05, durationSec: 0.045, gain: 0.02 },
        { freq: 1047, startOffsetSec: 0.1, durationSec: 0.05, gain: 0.02 },
        { freq: 1319, startOffsetSec: 0.155, durationSec: 0.075, gain: 0.018 },
      ],
    },
    select: {
      waveform: 'square',
      notes: [
        { freq: 440, startOffsetSec: 0, durationSec: 0.05, gain: 0.02 },
        { freq: 659, startOffsetSec: 0.055, durationSec: 0.075, gain: 0.02 },
      ],
    },
  },
  // Nimble triangle hop for the fox
  fox: {
    pet: {
      waveform: 'triangle',
      notes: [
        { freq: 587, slideTo: 740, startOffsetSec: 0, durationSec: 0.08, gain: 0.034 },
        { freq: 784, slideTo: 880, startOffsetSec: 0.085, durationSec: 0.1, gain: 0.03 },
      ],
    },
    feed: {
      waveform: 'triangle',
      notes: [
        { freq: 659, startOffsetSec: 0, durationSec: 0.07, gain: 0.034 },
        { freq: 880, slideTo: 988, startOffsetSec: 0.075, durationSec: 0.11, gain: 0.032 },
      ],
    },
    play: {
      waveform: 'triangle',
      notes: [
        { freq: 698, startOffsetSec: 0, durationSec: 0.06, gain: 0.034 },
        { freq: 932, startOffsetSec: 0.065, durationSec: 0.06, gain: 0.034 },
        { freq: 1175, slideTo: 1319, startOffsetSec: 0.13, durationSec: 0.09, gain: 0.03 },
      ],
    },
    select: {
      waveform: 'triangle',
      notes: [{ freq: 523, slideTo: 784, startOffsetSec: 0, durationSec: 0.11, gain: 0.034 }],
    },
  },
  // Mellow woody sine chord for the panda
  panda: {
    pet: {
      waveform: 'sine',
      notes: [
        { freq: 294, startOffsetSec: 0, durationSec: 0.18, gain: 0.022 },
        { freq: 370, startOffsetSec: 0, durationSec: 0.18, gain: 0.018 },
      ],
    },
    feed: {
      waveform: 'sine',
      notes: [
        { freq: 330, startOffsetSec: 0, durationSec: 0.16, gain: 0.018 },
        { freq: 415, startOffsetSec: 0, durationSec: 0.16, gain: 0.014 },
        { freq: 494, startOffsetSec: 0.08, durationSec: 0.14, gain: 0.012 },
      ],
    },
    play: {
      waveform: 'sine',
      notes: [
        { freq: 349, startOffsetSec: 0, durationSec: 0.1, gain: 0.022 },
        { freq: 440, startOffsetSec: 0, durationSec: 0.1, gain: 0.018 },
        { freq: 523, startOffsetSec: 0.105, durationSec: 0.12, gain: 0.02 },
      ],
    },
    select: {
      waveform: 'sine',
      notes: [
        { freq: 262, startOffsetSec: 0, durationSec: 0.15, gain: 0.022 },
        { freq: 392, startOffsetSec: 0, durationSec: 0.15, gain: 0.018 },
      ],
    },
  },
}

/** Return the deterministic frequency and waveform spec for a pet and sound kind. */
export function petSoundProfile(petId: AiPetId, kind: AiPetSoundKind): PetSoundProfile {
  const petProfiles = PET_SOUND_PROFILES[petId] ?? PET_SOUND_PROFILES.bluebird
  const spec = petProfiles[kind] ?? petProfiles.pet
  return {
    petId,
    kind,
    waveform: spec.waveform,
    notes: spec.notes,
  }
}

type AudioContextCtor = typeof AudioContext

let sharedCtx: AudioContext | null = null
let sharedCtxCtor: AudioContextCtor | null = null

function resolveAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null
  const win = window as unknown as {
    AudioContext?: AudioContextCtor
    webkitAudioContext?: AudioContextCtor
  }
  return win.AudioContext ?? win.webkitAudioContext ?? null
}

function getAudioContext(): AudioContext | null {
  const Ctor = resolveAudioContextCtor()
  if (!Ctor) return null
  if (sharedCtx && sharedCtxCtor === Ctor && sharedCtx.state !== 'closed') {
    return sharedCtx
  }
  try {
    sharedCtx = new Ctor()
    sharedCtxCtor = Ctor
    return sharedCtx
  } catch {
    sharedCtx = null
    sharedCtxCtor = null
    return null
  }
}

/**
 * Play a gentle, short, ultra-quiet Web Audio chime tailored to the active pet.
 * Safe no-op in headless/jsdom environments or when audio is disabled.
 */
export function playPetSound(
  petId: AiPetId,
  kind: AiPetSoundKind,
  opts?: { readonly enabled?: boolean; readonly reducedMotion?: boolean },
): void {
  if (opts?.enabled === false || opts?.reducedMotion === true) return
  const ctx = getAudioContext()
  if (!ctx) return

  try {
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      const resumed = ctx.resume()
      if (resumed && typeof resumed.catch === 'function') {
        resumed.catch(() => {})
      }
    }
    const profile = petSoundProfile(petId, kind)
    const now = typeof ctx.currentTime === 'number' ? ctx.currentTime : 0
    for (const note of profile.notes) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      const startAt = now + note.startOffsetSec
      const endAt = startAt + note.durationSec
      const attackAt = startAt + Math.min(0.012, note.durationSec * 0.25)

      osc.type = profile.waveform
      osc.frequency.setValueAtTime(note.freq, startAt)
      if (note.slideTo !== undefined && note.slideTo > 0) {
        osc.frequency.exponentialRampToValueAtTime(note.slideTo, endAt)
      }

      gain.gain.setValueAtTime(0.0001, startAt)
      gain.gain.linearRampToValueAtTime(note.gain, attackAt)
      gain.gain.exponentialRampToValueAtTime(0.0001, endAt)

      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(startAt)
      osc.stop(endAt)
    }
  } catch {
    // Ignore autoplay restrictions or incomplete Web Audio implementations
  }
}
