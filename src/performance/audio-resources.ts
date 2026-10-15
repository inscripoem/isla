import type { ClockPort } from '../contracts/app'
import type { AudioLease, AudioResolver } from './browser/types'

/**
 * A real, controlled server-side registry of generated audio resources.
 *
 * The registry owns opaque `audio://` references and the immutable media bytes
 * behind them. It never treats a reference as a filename, URL or `src` value,
 * and it never fetches. Registering is a local resource-lifecycle operation, not
 * a delivery authorization: it does not create C5 fields or transport authority.
 * M5 remains responsible for invoking trusted session/epoch invalidation and for
 * deciding whether a prepared resource may be dispatched.
 *
 * Every entry records the original request/session/epoch/turn/segment identity
 * and the public voice profile id/version privately. Active bytes count against a
 * configured byte budget; there is no per-epoch output-count quota.
 */

/** Registry lifecycle failure codes surfaced to the synthesis adapter. */
export type AudioResourceErrorCode =
  | 'invalid_config'
  | 'invalid_input'
  | 'invalid_ref'
  | 'ref_collision'
  | 'capacity_exceeded'
  | 'session_retired'
  | 'disposed'
  | 'unknown_ref'
  | 'aborted'

/** A rejection with an explicit lifecycle code; message never discloses paths. */
export class AudioResourceError extends Error {
  readonly code: AudioResourceErrorCode

  constructor(code: AudioResourceErrorCode) {
    super(`m1-audio-registry: ${code}`)
    this.name = 'AudioResourceError'
    this.code = code
  }
}

/** One registration request. The registry generates the reference itself. */
export interface AudioResourceRegistration {
  readonly requestId: string
  readonly sessionId: string
  readonly epoch: number
  readonly turnId: string
  readonly segmentId: string
  readonly voiceProfileId: string
  readonly voiceProfileVersion: string
  readonly format: string
  readonly bytes: Uint8Array
}

/** Facts about a successfully registered resource. */
export interface RegisteredAudioResource {
  readonly audioRef: string
  readonly byteLength: number
  readonly registeredAtMs: number
  readonly expiresAtMs: number
}

/** An immutable metadata view; mutating it cannot alter registry state. */
export interface AudioResourceMetadata {
  readonly audioRef: string
  readonly requestId: string
  readonly sessionId: string
  readonly epoch: number
  readonly turnId: string
  readonly segmentId: string
  readonly voiceProfileId: string
  readonly voiceProfileVersion: string
  readonly format: string
  readonly byteLength: number
  readonly registeredAtMs: number
  readonly expiresAtMs: number
  readonly retired: boolean
  readonly activeLeases: number
}

/** A protected snapshot of registry state. */
export interface AudioResourceSnapshot {
  readonly disposed: boolean
  readonly byteBudget: number
  readonly usedBytes: number
  readonly activeCount: number
  readonly leasedCount: number
  readonly retiredSessions: Readonly<Record<string, number>>
  readonly resources: readonly AudioResourceMetadata[]
}

export interface AudioResourceRegistry extends AudioResolver {
  register(request: AudioResourceRegistration): RegisteredAudioResource
  /** Retire a resource; a held lease survives, a new acquisition cannot start. */
  retire(audioRef: string): boolean
  /** Trusted owner: retire every session resource below `newEpoch`, refuse later ones. */
  retireBefore(sessionId: string, newEpoch: number): number
  /** Trusted owner: retire every session resource and refuse all later epochs. */
  retireSession(sessionId: string): number
  /** Explicit owner/virtual-clock hook: reclaim expired unleased resources. */
  collectExpired(): number
  /** Reject new work, mark resources retired, keep leased bytes pinned. */
  dispose(): void
  /**
   * Pure, clock-free admission query for one reference and its original
   * `sessionId`/`epoch`. Returns `null` only when the reference is the same
   * currently active, unretired resource, its retained identity matches, and the
   * original session/epoch remain admissible; otherwise the lifecycle code that
   * makes it unusable (including `session_retired` even after the entry is
   * reclaimed). It invokes no injected dependency and reads no clock, so a caller
   * may use it as the final check immediately before publishing a reference
   * without introducing another callback boundary.
   */
  admission(audioRef: string, sessionId: string, epoch: number): AudioResourceErrorCode | null
  snapshot(): AudioResourceSnapshot
}

export interface AudioResourceRegistryDeps {
  readonly clock: ClockPort
  /** Hard ceiling on retained resource bytes; a finite positive integer. */
  readonly byteBudget: number
  /** Retention in the injected clock domain, measured at registration. */
  readonly retentionMs: number
  /** Optional reference factory. Must return a unique `audio://` identifier. */
  readonly newRef?: () => string
}

interface Entry {
  audioRef: string
  requestId: string
  sessionId: string
  epoch: number
  turnId: string
  segmentId: string
  voiceProfileId: string
  voiceProfileVersion: string
  format: string
  byteLength: number
  bytes: Uint8Array
  blob: Blob
  registeredAtMs: number
  expiresAtMs: number
  retired: boolean
  activeLeases: number
}

const CONTROLLED_REF_PATTERN = /^audio:\/\/[^\s\\]+$/

function isControlledAudioRef(ref: string): boolean {
  return CONTROLLED_REF_PATTERN.test(ref)
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

let defaultRefCounter = 0

function defaultRefFactory(): string {
  const cryptoObject = globalThis.crypto
  if (cryptoObject !== undefined && typeof cryptoObject.randomUUID === 'function') {
    return `audio://kokoro/${cryptoObject.randomUUID()}`
  }
  defaultRefCounter += 1
  return `audio://kokoro/${defaultRefCounter.toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function createAudioResourceRegistry(
  deps: AudioResourceRegistryDeps,
): AudioResourceRegistry {
  if (deps.clock === null || typeof deps.clock?.nowMs !== 'function') {
    throw new AudioResourceError('invalid_config')
  }
  if (
    typeof deps.byteBudget !== 'number' ||
    !Number.isInteger(deps.byteBudget) ||
    deps.byteBudget <= 0
  ) {
    throw new AudioResourceError('invalid_config')
  }
  if (typeof deps.retentionMs !== 'number' || !Number.isFinite(deps.retentionMs) || deps.retentionMs <= 0) {
    throw new AudioResourceError('invalid_config')
  }
  if (deps.newRef !== undefined && typeof deps.newRef !== 'function') {
    throw new AudioResourceError('invalid_config')
  }

  const clock = deps.clock
  const byteBudget = deps.byteBudget
  const retentionMs = deps.retentionMs
  const newRef = deps.newRef ?? defaultRefFactory

  const active = new Map<string, Entry>()
  // References that were ever used or deliberately retired are never reused.
  const usedRefs = new Set<string>()
  // Monotonic per-session retirement lower bounds; INFINITY retires the session.
  const retiredSessions = new Map<string, number>()
  let usedBytes = 0
  let disposed = false

  const reclaim = (ref: string): boolean => {
    const entry = active.get(ref)
    if (entry === undefined) return false
    active.delete(ref)
    usedBytes -= entry.byteLength
    usedRefs.add(ref)
    return true
  }

  const retireEntry = (entry: Entry): void => {
    entry.retired = true
    usedRefs.add(entry.audioRef)
    if (entry.activeLeases === 0) reclaim(entry.audioRef)
  }

  const assertDisposed = (): void => {
    if (disposed) throw new AudioResourceError('disposed')
  }

  const assertSessionAdmissible = (sessionId: string, epoch: number): void => {
    const bound = retiredSessions.get(sessionId)
    if (bound !== undefined && epoch < bound) throw new AudioResourceError('session_retired')
  }

  const collectExpiredUnleased = (): number => {
    const now = clock.nowMs()
    let reclaimed = 0
    for (const entry of [...active.values()]) {
      if (!entry.retired && entry.activeLeases === 0 && now >= entry.expiresAtMs) {
        usedRefs.add(entry.audioRef)
        if (reclaim(entry.audioRef)) reclaimed += 1
      }
    }
    return reclaimed
  }

  interface RegistrationSnapshot {
    requestId: string
    sessionId: string
    epoch: number
    turnId: string
    segmentId: string
    voiceProfileId: string
    voiceProfileVersion: string
    format: string
    bytes: Uint8Array<ArrayBuffer>
    byteLength: number
  }

  // Validate and copy every caller-owned scalar and byte before any injected
  // callback runs, so a reentrant clock/ref factory cannot mutate what is kept.
  const snapshotRegistration = (request: AudioResourceRegistration): RegistrationSnapshot => {
    if (request === null || typeof request !== 'object') throw new AudioResourceError('invalid_input')
    const requestId = request.requestId
    const sessionId = request.sessionId
    const epoch = request.epoch
    const turnId = request.turnId
    const segmentId = request.segmentId
    const voiceProfileId = request.voiceProfileId
    const voiceProfileVersion = request.voiceProfileVersion
    const format = request.format
    const sourceBytes = request.bytes
    if (!isNonEmpty(requestId)) throw new AudioResourceError('invalid_input')
    if (!isNonEmpty(sessionId)) throw new AudioResourceError('invalid_input')
    if (!isEpoch(epoch)) throw new AudioResourceError('invalid_input')
    if (!isNonEmpty(turnId)) throw new AudioResourceError('invalid_input')
    if (!isNonEmpty(segmentId)) throw new AudioResourceError('invalid_input')
    if (!isNonEmpty(voiceProfileId)) throw new AudioResourceError('invalid_input')
    if (!isNonEmpty(voiceProfileVersion)) throw new AudioResourceError('invalid_input')
    if (!isNonEmpty(format)) throw new AudioResourceError('invalid_input')
    if (!(sourceBytes instanceof Uint8Array) || sourceBytes.byteLength === 0) {
      throw new AudioResourceError('invalid_input')
    }
    const bytes = new Uint8Array(sourceBytes.byteLength)
    bytes.set(sourceBytes)
    return {
      requestId,
      sessionId,
      epoch,
      turnId,
      segmentId,
      voiceProfileId,
      voiceProfileVersion,
      format,
      bytes,
      byteLength: bytes.byteLength,
    }
  }

  const toMetadata = (entry: Entry): AudioResourceMetadata => ({
    audioRef: entry.audioRef,
    requestId: entry.requestId,
    sessionId: entry.sessionId,
    epoch: entry.epoch,
    turnId: entry.turnId,
    segmentId: entry.segmentId,
    voiceProfileId: entry.voiceProfileId,
    voiceProfileVersion: entry.voiceProfileVersion,
    format: entry.format,
    byteLength: entry.byteLength,
    registeredAtMs: entry.registeredAtMs,
    expiresAtMs: entry.expiresAtMs,
    retired: entry.retired,
    activeLeases: entry.activeLeases,
  })

  return {
    register(request) {
      assertDisposed()
      const snapshot = snapshotRegistration(request)
      assertSessionAdmissible(snapshot.sessionId, snapshot.epoch)
      collectExpiredUnleased()

      const audioRef = newRef()
      if (!isNonEmpty(audioRef) || !isControlledAudioRef(audioRef)) {
        throw new AudioResourceError('invalid_ref')
      }
      if (usedRefs.has(audioRef) || active.has(audioRef)) {
        throw new AudioResourceError('ref_collision')
      }
      if (usedBytes + snapshot.byteLength > byteBudget) {
        throw new AudioResourceError('capacity_exceeded')
      }

      // Build the owned Blob before mutating any registry state so a failure
      // cannot leave a partial entry.
      const blob = new Blob([snapshot.bytes], { type: snapshot.format })
      const registeredAtMs = clock.nowMs()

      // Injected callbacks above may have synchronously retired the session,
      // disposed the registry, reclaimed capacity or claimed the reference.
      // Recheck every admission predicate immediately before committing. The
      // commit itself runs no injected code and cannot be interrupted.
      assertDisposed()
      assertSessionAdmissible(snapshot.sessionId, snapshot.epoch)
      if (usedRefs.has(audioRef) || active.has(audioRef)) {
        throw new AudioResourceError('ref_collision')
      }
      if (usedBytes + snapshot.byteLength > byteBudget) {
        throw new AudioResourceError('capacity_exceeded')
      }

      const entry: Entry = {
        audioRef,
        requestId: snapshot.requestId,
        sessionId: snapshot.sessionId,
        epoch: snapshot.epoch,
        turnId: snapshot.turnId,
        segmentId: snapshot.segmentId,
        voiceProfileId: snapshot.voiceProfileId,
        voiceProfileVersion: snapshot.voiceProfileVersion,
        format: snapshot.format,
        byteLength: snapshot.byteLength,
        bytes: snapshot.bytes,
        blob,
        registeredAtMs,
        expiresAtMs: registeredAtMs + retentionMs,
        retired: false,
        activeLeases: 0,
      }
      active.set(audioRef, entry)
      usedRefs.add(audioRef)
      usedBytes += snapshot.byteLength
      return {
        audioRef,
        byteLength: snapshot.byteLength,
        registeredAtMs,
        expiresAtMs: entry.expiresAtMs,
      }
    },

    resolve(audioRef, signal) {
      try {
        assertDisposed()
        if (!isNonEmpty(audioRef) || !isControlledAudioRef(audioRef)) {
          throw new AudioResourceError('invalid_ref')
        }
        if (signal.aborted) throw new AudioResourceError('aborted')
        const entry = active.get(audioRef)
        if (entry === undefined || entry.retired) throw new AudioResourceError('unknown_ref')
        const now = clock.nowMs()
        // The clock is an injected boundary; it may synchronously retire this
        // entry/session/epoch, dispose the registry or abort the caller signal,
        // reclaiming the captured entry. Re-observe the same live entry before
        // accounting for any lease so a removed entry can never be incremented.
        if (disposed) throw new AudioResourceError('disposed')
        if (signal.aborted) throw new AudioResourceError('aborted')
        if (active.get(audioRef) !== entry || entry.retired) {
          throw new AudioResourceError('unknown_ref')
        }
        if (now >= entry.expiresAtMs) {
          if (entry.activeLeases === 0) {
            usedRefs.add(audioRef)
            reclaim(audioRef)
          } else {
            entry.retired = true
            usedRefs.add(audioRef)
          }
          throw new AudioResourceError('unknown_ref')
        }
        entry.activeLeases += 1
        let released = false
        const lease: AudioLease = {
          blob: entry.blob,
          release: () => {
            if (released) return
            released = true
            entry.activeLeases -= 1
            if (entry.activeLeases <= 0) {
              entry.activeLeases = 0
              reclaim(audioRef)
            }
          },
        }
        return Promise.resolve(lease)
      } catch (error) {
        return Promise.reject(error)
      }
    },

    retire(audioRef) {
      if (!isNonEmpty(audioRef) || !isControlledAudioRef(audioRef)) return false
      const entry = active.get(audioRef)
      if (entry === undefined) return false
      retireEntry(entry)
      return true
    },

    retireBefore(sessionId, newEpoch) {
      if (!isNonEmpty(sessionId) || !isEpoch(newEpoch)) return 0
      const previous = retiredSessions.get(sessionId)
      if (previous === undefined || newEpoch > previous) retiredSessions.set(sessionId, newEpoch)
      let retired = 0
      for (const entry of [...active.values()]) {
        if (entry.sessionId === sessionId && entry.epoch < newEpoch) {
          retireEntry(entry)
          retired += 1
        }
      }
      return retired
    },

    retireSession(sessionId) {
      if (!isNonEmpty(sessionId)) return 0
      retiredSessions.set(sessionId, Number.POSITIVE_INFINITY)
      let retired = 0
      for (const entry of [...active.values()]) {
        if (entry.sessionId === sessionId) {
          retireEntry(entry)
          retired += 1
        }
      }
      return retired
    },

    collectExpired() {
      return collectExpiredUnleased()
    },

    dispose() {
      disposed = true
      for (const entry of [...active.values()]) {
        entry.retired = true
        usedRefs.add(entry.audioRef)
        if (entry.activeLeases === 0) reclaim(entry.audioRef)
      }
    },

    admission(audioRef, sessionId, epoch) {
      if (disposed) return 'disposed'
      if (!isNonEmpty(audioRef) || !isControlledAudioRef(audioRef)) return 'invalid_ref'
      const bound = retiredSessions.get(sessionId)
      if (bound !== undefined && epoch < bound) return 'session_retired'
      const entry = active.get(audioRef)
      if (entry === undefined || entry.retired) return 'unknown_ref'
      if (entry.sessionId !== sessionId || entry.epoch !== epoch) return 'unknown_ref'
      return null
    },

    snapshot(): AudioResourceSnapshot {
      const resources = [...active.values()].map(toMetadata)
      const leasedCount = resources.filter((resource) => resource.activeLeases > 0).length
      // A null-prototype record keeps every legal session id (including
      // `__proto__`) as an own data key instead of losing it to the prototype.
      const retiredSessionsView: Record<string, number> = Object.create(null)
      for (const [sessionId, bound] of retiredSessions) retiredSessionsView[sessionId] = bound
      return {
        disposed,
        byteBudget,
        usedBytes,
        activeCount: resources.length,
        leasedCount,
        retiredSessions: retiredSessionsView,
        resources,
      }
    },
  }
}
