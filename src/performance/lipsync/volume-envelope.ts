/**
 * Deterministic 20 ms root-mean-square envelopes for generated mono float PCM.
 *
 * The envelope is a visualisation aid, not an audio transform: samples keep
 * their original signed finite values in the WAV, and only the final RMS values
 * are clipped to `[0, 1]`. Windows are half-open elapsed-time intervals from 0.
 * A final partial window is retained and its energy is normalized by the actual
 * span it covers. Sample rates that do not divide into 50 windows per second use
 * integer time units so a sample straddling a boundary contributes exactly its
 * overlap to each window, without gaps or drift.
 *
 * This module is dependency-free and uses only typed arrays and arithmetic; it
 * reads no clock, environment, file or audio device.
 */

/** One fixed-window RMS curve for a complete mono sample interval. */
export interface VolumeEnvelope {
  readonly stepMs: 20
  readonly durationMs: number
  readonly levels: readonly number[]
}

/** One curve delivered with the exact registered audio identity. */
export interface VolumeEnvelopeEvent extends VolumeEnvelope {
  readonly audioRef: string
  readonly sessionId: string
  readonly epoch: number
  readonly turnId: string
  readonly segmentId: string
}

const STEP_MS = 20 as const
/** Integer time units per input sample; one 20 ms window spans `sampleRate`. */
const UNITS_PER_SAMPLE = 50
/** Largest value representable in an unsigned 32-bit WAV header field. */
const UINT32_MAX = 0xffffffff
const BYTES_PER_SAMPLE = 4

/**
 * Reject a container or rate the synthesis adapter would not publish as a WAV.
 * Sample finiteness is checked on the same read used by the energy sum.
 */
function assertValidAudioShape(samples: Float32Array, sampleRate: number): void {
  if (!(samples instanceof Float32Array) || samples.length === 0) {
    throw new Error('m1-volume-envelope: samples must be a nonempty Float32Array')
  }
  if (
    !Number.isInteger(sampleRate) ||
    sampleRate <= 0 ||
    sampleRate * BYTES_PER_SAMPLE > UINT32_MAX
  ) {
    throw new Error('m1-volume-envelope: sampleRate must fit a mono float WAV header')
  }
}

/**
 * Compute one native, unamplified RMS level per fixed 20 ms window. The input
 * must be nonempty finite mono float PCM at a positive integer rate. This does
 * not resample or retain sample values beyond the squared-energy accumulator.
 */
export function computeVolumeEnvelope(
  samples: Float32Array,
  sampleRate: number,
): VolumeEnvelope {
  assertValidAudioShape(samples, sampleRate)

  const windowUnits = sampleRate
  const levels: number[] = []
  let windowEnd = windowUnits
  let windowEnergy = 0
  let occupiedUnits = 0

  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index]
    if (!Number.isFinite(value)) {
      throw new Error('m1-volume-envelope: samples must be finite')
    }
    const squared = value * value
    const sampleStart = index * UNITS_PER_SAMPLE
    const sampleEnd = sampleStart + UNITS_PER_SAMPLE
    let position = sampleStart
    while (position < sampleEnd) {
      const boundary = Math.min(sampleEnd, windowEnd)
      const overlap = boundary - position
      windowEnergy += squared * overlap
      occupiedUnits += overlap
      position = boundary
      if (position === windowEnd) {
        levels.push(Math.min(1, Math.sqrt(windowEnergy / occupiedUnits)))
        windowEnergy = 0
        occupiedUnits = 0
        windowEnd += windowUnits
      }
    }
  }

  // The final window is intentionally partial: normalize by the units actually
  // covered rather than by a full 20 ms span.
  if (occupiedUnits > 0) {
    levels.push(Math.min(1, Math.sqrt(windowEnergy / occupiedUnits)))
  }

  return Object.freeze({
    stepMs: STEP_MS,
    durationMs: (samples.length * 1000) / sampleRate,
    levels: Object.freeze(levels),
  })
}
