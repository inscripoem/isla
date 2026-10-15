import type { CallContext, ClockPort, PreparePerformance, PreparedAudio, SynthesisPort } from '../contracts/app'
import { preparePerformanceSchema } from '../contracts/app'
import type { DeadlineGate } from './browser/types'
import type { AudioResourceErrorCode, AudioResourceRegistry } from './audio-resources'
import { AudioResourceError } from './audio-resources'
import type { KokoroProvider, KokoroRawAudio, KokoroVoiceProfile } from './kokoro-types'
import { KokoroProviderError } from './kokoro-types'
import { MONO_FLOAT32_WAV_FORMAT, encodeMonoFloat32Wav } from './wav'

/**
 * A real Node-side `SynthesisPort` adapter over an injected Kokoro-compatible
 * raw-audio provider and a real controlled audio-resource registry.
 *
 * `prepare` never plays, resolves bytes for playback or renders. It validates and
 * snapshots the original request, maps the exact public voice profile tuple to a
 * private provider voice id and speed, forwards the text verbatim (no character
 * limit, no silent segmentation), and registers the generated audio as an opaque
 * `audio://` resource only after the physical provider settles.
 *
 * The adapter owns one real in-flight generation slot per provider instance.
 * There is no scheduler or queue: a second concurrent call fails `busy` rather
 * than spawning a second generation. A logical owner abort/expiry resolves a
 * failed result promptly and releases its deadline binding, but the physical slot
 * stays occupied until the original provider Promise settles; a late fulfillment
 * or rejection is consumed without publishing a reference or leaking a rejection.
 *
 * Tokenizer-length and SDK truncation guards are NOT implemented or validated
 * here: the injected provider must itself refuse an over-long input with
 * `input_too_long` before physical inference. Concrete `kokoro-js` loading and a
 * real-SDK smoke test are increment B work.
 */

export interface KokoroSynthesisDeps {
  readonly provider: KokoroProvider
  readonly profiles: readonly KokoroVoiceProfile[]
  readonly registry: AudioResourceRegistry
  readonly clock: ClockPort
  readonly deadlineGate: DeadlineGate
}

/** Deterministic reason codes for failed `prepare` results. */
const REASON_CANCELLED = 'cancelled_or_expired'
const REASON_BUSY = 'busy'
const REASON_UNKNOWN_VOICE = 'unknown_voice_profile'
const REASON_INPUT_TOO_LONG = 'input_too_long'
const REASON_PROVIDER_FAILED = 'provider_failed'
const REASON_INVALID_AUDIO = 'invalid_audio'
const REASON_RESOURCE_CAPACITY = 'resource_capacity'
const REASON_RESOURCE_COLLISION = 'resource_collision'
const REASON_SESSION_RETIRED = 'session_retired'
const REASON_RESOURCE_CLOSED = 'resource_closed'
const REASON_RESOURCE_FAILED = 'resource_failed'

function validateProfile(profile: KokoroVoiceProfile): void {
  if (typeof profile !== 'object' || profile === null) {
    throw new Error('kokoro-synthesis: invalid voice profile')
  }
  if (typeof profile.voiceProfileId !== 'string' || profile.voiceProfileId.length === 0) {
    throw new Error('kokoro-synthesis: voice profile id must be a nonempty string')
  }
  if (typeof profile.voiceProfileVersion !== 'string' || profile.voiceProfileVersion.length === 0) {
    throw new Error('kokoro-synthesis: voice profile version must be a nonempty string')
  }
  if (typeof profile.providerVoiceId !== 'string' || profile.providerVoiceId.length === 0) {
    throw new Error('kokoro-synthesis: provider voice id must be a nonempty string')
  }
  if (typeof profile.speed !== 'number' || !Number.isFinite(profile.speed) || profile.speed <= 0) {
    throw new Error('kokoro-synthesis: speed must be a finite positive number')
  }
}

function copyProfile(profile: KokoroVoiceProfile): KokoroVoiceProfile {
  return {
    voiceProfileId: profile.voiceProfileId,
    voiceProfileVersion: profile.voiceProfileVersion,
    providerVoiceId: profile.providerVoiceId,
    speed: profile.speed,
  }
}

function mapRegistryErrorCode(code: AudioResourceErrorCode): string {
  switch (code) {
    case 'capacity_exceeded':
      return REASON_RESOURCE_CAPACITY
    case 'ref_collision':
    case 'invalid_ref':
      return REASON_RESOURCE_COLLISION
    case 'session_retired':
      return REASON_SESSION_RETIRED
    case 'disposed':
      return REASON_RESOURCE_CLOSED
    default:
      return REASON_RESOURCE_FAILED
  }
}

function mapRegistryFailure(error: unknown): string {
  if (error instanceof AudioResourceError) return mapRegistryErrorCode(error.code)
  return REASON_RESOURCE_FAILED
}

function providerFailureReason(error: unknown): string {
  if (error instanceof KokoroProviderError) {
    return error.code === 'input_too_long' ? REASON_INPUT_TOO_LONG : REASON_PROVIDER_FAILED
  }
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (code === 'input_too_long') return REASON_INPUT_TOO_LONG
  }
  return REASON_PROVIDER_FAILED
}

/** Largest value representable in an unsigned 32-bit WAV header field. */
const UINT32_MAX = 0xffffffff
const BYTES_PER_SAMPLE = 4

/**
 * Validate and copy raw provider audio; null when empty, malformed, non-finite or
 * when the sample rate/length cannot be represented in a mono IEEE-float32 WAV
 * header (a positive integer rate and a non-overflowing rate*4 byte rate and data
 * length). Rejecting here prevents publishing a malformed or misleading WAV.
 */
function normalizeRawAudio(value: unknown): KokoroRawAudio | null {
  if (value === null || typeof value !== 'object') return null
  const samples = (value as { samples?: unknown }).samples
  const sampleRate = (value as { sampleRate?: unknown }).sampleRate
  if (!(samples instanceof Float32Array)) return null
  if (samples.length === 0) return null
  if (typeof sampleRate !== 'number' || !Number.isFinite(sampleRate) || sampleRate <= 0) return null
  if (!Number.isInteger(sampleRate) || sampleRate > UINT32_MAX) return null
  if (sampleRate * BYTES_PER_SAMPLE > UINT32_MAX) return null
  if (samples.length * BYTES_PER_SAMPLE > UINT32_MAX) return null
  for (let index = 0; index < samples.length; index += 1) {
    if (!Number.isFinite(samples[index])) return null
  }
  return { samples: new Float32Array(samples), sampleRate }
}

export function createKokoroSynthesis(deps: KokoroSynthesisDeps): SynthesisPort {
  // A nested map keys the tuple structurally. Joining the two unrestricted C5
  // strings with any delimiter (including NUL) would make distinct legal tuples
  // collide, so the id and version are never concatenated.
  const profiles = new Map<string, Map<string, KokoroVoiceProfile>>()
  for (const raw of deps.profiles) {
    validateProfile(raw)
    const byVersion =
      profiles.get(raw.voiceProfileId) ?? new Map<string, KokoroVoiceProfile>()
    if (byVersion.has(raw.voiceProfileVersion)) {
      throw new Error('kokoro-synthesis: duplicate voice profile tuple')
    }
    byVersion.set(raw.voiceProfileVersion, copyProfile(raw))
    profiles.set(raw.voiceProfileId, byVersion)
  }

  // The provider instance owns exactly one physical generation slot.
  let generating = false

  const failure = (request: PreparePerformance, reasonCode: string): PreparedAudio => ({
    ok: false,
    requestId: request.requestId,
    sessionId: request.sessionId,
    epoch: request.epoch,
    turnId: request.turnId,
    segmentId: request.segmentId,
    reasonCode,
    message: `kokoro-synthesis: ${reasonCode}`,
  })

  const success = (
    request: PreparePerformance,
    audioRef: string,
    durationMs: number,
  ): PreparedAudio => ({
    ok: true,
    requestId: request.requestId,
    sessionId: request.sessionId,
    epoch: request.epoch,
    turnId: request.turnId,
    segmentId: request.segmentId,
    audioRef,
    format: MONO_FLOAT32_WAV_FORMAT,
    durationMs,
    timing: null,
  })

  return {
    async prepare(request, context) {
      let validRequest: PreparePerformance
      try {
        validRequest = preparePerformanceSchema.parse(request)
      } catch {
        throw new Error('kokoro-synthesis: malformed prepare request')
      }

      const profile = profiles
        .get(validRequest.voiceProfileId)
        ?.get(validRequest.voiceProfileVersion)
      if (profile === undefined) return failure(validRequest, REASON_UNKNOWN_VOICE)

      const deadlineAt = Math.min(validRequest.deadline.atMs, context.deadline.atMs)
      if (context.signal.aborted || deps.clock.nowMs() >= deadlineAt) {
        return failure(validRequest, REASON_CANCELLED)
      }

      // Bind the effective (earliest-deadline) context; never lengthen either
      // deadline and preserve the original caller signal.
      const effectiveContext: CallContext = { signal: context.signal, deadline: { atMs: deadlineAt } }
      const binding = deps.deadlineGate.bind(effectiveContext)
      if (binding.signal.aborted) {
        binding.release()
        return failure(validRequest, REASON_CANCELLED)
      }

      // Reserve the real generation slot synchronously before invoking provider.
      if (generating) {
        binding.release()
        return failure(validRequest, REASON_BUSY)
      }
      generating = true

      let providerPromise: Promise<KokoroRawAudio>
      try {
        providerPromise = deps.provider.generate({
          text: validRequest.text,
          voiceId: profile.providerVoiceId,
          speed: profile.speed,
        })
      } catch (error) {
        generating = false
        binding.release()
        return failure(validRequest, providerFailureReason(error))
      }

      const result = await new Promise<PreparedAudio>((resolve) => {
        let settled = false
        const finish = (value: PreparedAudio): void => {
          if (settled) return
          settled = true
          binding.signal.removeEventListener('abort', onAbort)
          binding.release()
          resolve(value)
        }
        const onAbort = (): void => finish(failure(validRequest, REASON_CANCELLED))

        // The injected clock is an external boundary: an owner abort can fire
        // synchronously during `nowMs()`, settling the logical wait before the
        // observation returns. Freshness therefore re-observes both the settled
        // terminal and the abort state after every clock read.
        const abortedOrExpired = (): boolean => {
          if (settled || binding.signal.aborted) return true
          if (deps.clock.nowMs() >= deadlineAt) return true
          return settled || binding.signal.aborted
        }

        const complete = (audio: KokoroRawAudio): PreparedAudio => {
          const raw = normalizeRawAudio(audio)
          if (raw === null) return failure(validRequest, REASON_INVALID_AUDIO)
          if (abortedOrExpired()) return failure(validRequest, REASON_CANCELLED)
          const bytes = encodeMonoFloat32Wav(raw.samples, raw.sampleRate)
          const durationMs = (raw.samples.length / raw.sampleRate) * 1000
          let audioRef: string
          try {
            const registration = deps.registry.register({
              requestId: validRequest.requestId,
              sessionId: validRequest.sessionId,
              epoch: validRequest.epoch,
              turnId: validRequest.turnId,
              segmentId: validRequest.segmentId,
              voiceProfileId: profile.voiceProfileId,
              voiceProfileVersion: profile.voiceProfileVersion,
              format: MONO_FLOAT32_WAV_FORMAT,
              bytes,
            })
            audioRef = registration.audioRef
          } catch (error) {
            return failure(validRequest, mapRegistryFailure(error))
          }
          // Every unpublished reference is retired, even when a synchronous owner
          // abort already settled the logical wait during registration or during
          // this final freshness observation. Physical generation occupancy is
          // untouched here; it stays reserved until the provider Promise settles.
          if (abortedOrExpired()) {
            try {
              deps.registry.retire(audioRef)
            } catch {
              // Best-effort reclamation; the honest failure is still returned.
            }
            return failure(validRequest, REASON_CANCELLED)
          }
          // The final clock observation above may have synchronously invalidated
          // the registry owner (retireSession/retireBefore/dispose) without
          // aborting the signal. As the last publication guard, ask the registry
          // whether this exact reference is still the same live, admissible
          // resource for its original identity. The query is clock-free and runs
          // no injected callback, so no unchecked boundary follows it.
          const admissionCode = deps.registry.admission(
            audioRef,
            validRequest.sessionId,
            validRequest.epoch,
          )
          if (admissionCode !== null) {
            try {
              deps.registry.retire(audioRef)
            } catch {
              // Best-effort reclamation; the honest failure is still returned.
            }
            return failure(validRequest, mapRegistryErrorCode(admissionCode))
          }
          return success(validRequest, audioRef, durationMs)
        }

        if (binding.signal.aborted) onAbort()
        else binding.signal.addEventListener('abort', onAbort, { once: true })

        providerPromise.then(
          (audio) => {
            generating = false
            if (settled) return
            let value: PreparedAudio
            try {
              value = complete(audio)
            } catch {
              value = failure(validRequest, REASON_PROVIDER_FAILED)
            }
            finish(value)
          },
          (error) => {
            generating = false
            if (settled) return
            finish(failure(validRequest, providerFailureReason(error)))
          },
        )
      })

      return result
    },
  }
}
