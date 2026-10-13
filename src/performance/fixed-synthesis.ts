import type {
  CallContext,
  ClockPort,
  PreparePerformance,
  PreparedAudio,
  SynthesisPort,
} from '../contracts/app'
import { preparePerformanceSchema } from '../contracts/app'

/**
 * A catalogued fixed audio asset. The tuple
 * `(text, voiceProfileId, voiceProfileVersion)` is the exact lookup key; the
 * catalog records the opaque audio reference and optional metadata for it.
 */
export interface FixedAudioEntry {
  readonly text: string
  readonly voiceProfileId: string
  readonly voiceProfileVersion: string
  readonly audioRef: string
  readonly format: string
  readonly durationMs: number | null
  readonly timing: { readonly startMs: number; readonly endMs: number } | null
}

export interface FixedSynthesisDeps {
  readonly entries: readonly FixedAudioEntry[]
  readonly clock: ClockPort
}

/** Audio references are opaque, server-controlled `audio://` identifiers. */
const CONTROLLED_REF_PATTERN = /^([a-z][a-z0-9+.-]*):\/\//i

function isControlledAudioRef(ref: string): boolean {
  const match = CONTROLLED_REF_PATTERN.exec(ref)
  if (match === null) return false
  return match[1].toLowerCase() === 'audio'
}

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

function copyTiming(
  timing: { readonly startMs: number; readonly endMs: number } | null,
): { startMs: number; endMs: number } | null {
  return timing === null ? null : { startMs: timing.startMs, endMs: timing.endMs }
}

function copyEntry(entry: FixedAudioEntry): FixedAudioEntry {
  return {
    text: entry.text,
    voiceProfileId: entry.voiceProfileId,
    voiceProfileVersion: entry.voiceProfileVersion,
    audioRef: entry.audioRef,
    format: entry.format,
    durationMs: entry.durationMs,
    timing: copyTiming(entry.timing),
  }
}

function validateEntry(entry: FixedAudioEntry): void {
  if (entry.text.length === 0) throw new Error('fixed-synthesis: text must be nonempty')
  if (entry.voiceProfileId.length === 0) {
    throw new Error('fixed-synthesis: voiceProfileId must be nonempty')
  }
  if (entry.voiceProfileVersion.length === 0) {
    throw new Error('fixed-synthesis: voiceProfileVersion must be nonempty')
  }
  if (entry.audioRef.length === 0) throw new Error('fixed-synthesis: audioRef must be nonempty')
  if (!isControlledAudioRef(entry.audioRef)) {
    throw new Error(`fixed-synthesis: audioRef is not a controlled audio:// reference: ${entry.audioRef}`)
  }
  if (entry.format.length === 0) throw new Error('fixed-synthesis: format must be nonempty')
  if (entry.durationMs !== null && !isFiniteNonNegative(entry.durationMs)) {
    throw new Error('fixed-synthesis: durationMs must be a finite nonnegative number or null')
  }
  if (entry.timing !== null) {
    if (
      !isFiniteNonNegative(entry.timing.startMs) ||
      !isFiniteNonNegative(entry.timing.endMs)
    ) {
      throw new Error('fixed-synthesis: timing bounds must be finite nonnegative numbers')
    }
    if (entry.timing.endMs < entry.timing.startMs) {
      throw new Error('fixed-synthesis: timing.endMs must not be less than startMs')
    }
  }
}

/**
 * An exact-unambiguous metadata lookup over a fixed catalog. The only identity
 * decision is the precise `(text, voiceProfileId, voiceProfileVersion)` tuple;
 * nothing is trimmed, lowercased or joined with an ambiguous delimiter. Its
 * `prepare` performs one synchronous lookup, never plays audio, resolves bytes,
 * renders, subscribes or allocates timers, signal subscriptions, binding leases
 * or media/resolver/renderer calls.
 */
export function createFixedSynthesis(deps: FixedSynthesisDeps): SynthesisPort {
  const byTuple = new Map<string, Map<string, Map<string, FixedAudioEntry>>>()
  const byRef = new Map<string, FixedAudioEntry>()

  for (const raw of deps.entries) {
    validateEntry(raw)
    const entry = copyEntry(raw)
    let voiceVersionMap = byTuple.get(entry.text)
    if (voiceVersionMap === undefined) {
      voiceVersionMap = new Map()
      byTuple.set(entry.text, voiceVersionMap)
    }
    let versionMap = voiceVersionMap.get(entry.voiceProfileId)
    if (versionMap === undefined) {
      versionMap = new Map()
      voiceVersionMap.set(entry.voiceProfileId, versionMap)
    }
    if (versionMap.has(entry.voiceProfileVersion)) {
      throw new Error('fixed-synthesis: duplicate text/voice tuple')
    }
    versionMap.set(entry.voiceProfileVersion, entry)
    if (byRef.has(entry.audioRef)) {
      throw new Error('fixed-synthesis: duplicate audio reference')
    }
    byRef.set(entry.audioRef, entry)
  }

  const deadlineAt = (request: PreparePerformance, context: CallContext): number =>
    Math.min(request.deadline.atMs, context.deadline.atMs)

  const expired = (request: PreparePerformance, context: CallContext): boolean =>
    context.signal.aborted || deps.clock.nowMs() >= deadlineAt(request, context)

  const failure = (request: PreparePerformance, reasonCode: string): PreparedAudio => ({
    ok: false,
    requestId: request.requestId,
    sessionId: request.sessionId,
    epoch: request.epoch,
    turnId: request.turnId,
    segmentId: request.segmentId,
    reasonCode,
    message: `fixed-synthesis: ${reasonCode}`,
  })

  const success = (request: PreparePerformance, entry: FixedAudioEntry): PreparedAudio => ({
    ok: true,
    requestId: request.requestId,
    sessionId: request.sessionId,
    epoch: request.epoch,
    turnId: request.turnId,
    segmentId: request.segmentId,
    audioRef: entry.audioRef,
    format: entry.format,
    durationMs: entry.durationMs,
    timing: copyTiming(entry.timing),
  })

  return {
    async prepare(request, context) {
      let validRequest: PreparePerformance
      try {
        validRequest = preparePerformanceSchema.parse(request)
      } catch {
        throw new Error('fixed-synthesis: malformed prepare request')
      }
      if (expired(validRequest, context)) return failure(validRequest, 'cancelled_or_expired')
      const entry = byTuple
        .get(validRequest.text)
        ?.get(validRequest.voiceProfileId)
        ?.get(validRequest.voiceProfileVersion)
      if (expired(validRequest, context)) return failure(validRequest, 'cancelled_or_expired')
      if (entry === undefined) return failure(validRequest, 'fixed_audio_missing')
      return success(validRequest, entry)
    },
  }
}