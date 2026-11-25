import type { MouthPlaybackKey, MouthPlaybackSample } from '../browser/types'
import type { VolumeEnvelopeEvent } from './volume-envelope'

/**
 * Synthesised Kokoro envelopes are measured in fixed 20 ms RMS windows. The
 * gain and every playback decision stay here; the stored raw RMS is never
 * modified.
 */
const STEP_MS = 20

const DEFAULT_MAX_ENVELOPES = 8
const DEFAULT_MAX_RETIRED = 32
const MAX_SESSIONS = 8
const MAX_RETIRED_SESSIONS = 16

export type OpeningWriter = (
  opening: number,
  signal: AbortSignal,
) => void | Promise<void>

export interface EnvelopePlaybackOptions {
  /** Maximum supplied envelopes retained for outputs that have not played yet. */
  readonly maxEnvelopes?: number
  /** Maximum retired identities remembered to reject late supply. */
  readonly maxRetired?: number
}

export interface EnvelopePlayback {
  supply(envelope: VolumeEnvelopeEvent): boolean
  observe(sample: MouthPlaybackSample): void
  disconnect(): Promise<void>
  close(): Promise<void>
  flush(): Promise<void>
}

interface EnvelopeIdentity {
  readonly audioRef: string
  readonly sessionId: string
  readonly epoch: number
  readonly turnId: string
  readonly segmentId: string
}

interface RetainedEnvelope extends EnvelopeIdentity {
  readonly durationMs: number
  readonly levels: readonly number[]
  readonly order: number
}

interface ActiveOutput {
  readonly key: MouthPlaybackKey
  readonly envelope: RetainedEnvelope
}

/**
 * A retired identity. `outputId === null` means the identity was retired before
 * any output pinned it, so every output for that identity is fenced.
 */
interface RetiredKey {
  readonly identity: EnvelopeIdentity
  readonly outputId: string | null
}

interface WriteJob {
  readonly controller: AbortController
  readonly done: Promise<void>
  complete(): void
  supersede(): void
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function positiveLimit(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

function identityOf(envelope: EnvelopeIdentity): EnvelopeIdentity {
  return {
    audioRef: envelope.audioRef,
    sessionId: envelope.sessionId,
    epoch: envelope.epoch,
    turnId: envelope.turnId,
    segmentId: envelope.segmentId,
  }
}

function sameIdentity(left: EnvelopeIdentity, right: EnvelopeIdentity): boolean {
  return (
    left.audioRef === right.audioRef &&
    left.sessionId === right.sessionId &&
    left.epoch === right.epoch &&
    left.turnId === right.turnId &&
    left.segmentId === right.segmentId
  )
}

function sameKey(left: MouthPlaybackKey, right: MouthPlaybackKey): boolean {
  return left.outputId === right.outputId && sameIdentity(left, right)
}

/**
 * Validate every field and sample once, then retain a frozen defensive copy.
 * A zero-duration envelope is valid with no windows; any malformed value is
 * ignored rather than coerced.
 */
function validateEnvelope(
  raw: VolumeEnvelopeEvent,
): Omit<RetainedEnvelope, 'order'> | null {
  try {
    const value = raw as unknown as Record<string, unknown> | null
    if (typeof value !== 'object' || value === null) return null
    const { audioRef, sessionId, epoch, turnId, segmentId } = value
    if (
      !nonEmptyString(audioRef) ||
      !nonEmptyString(sessionId) ||
      !Number.isInteger(epoch) ||
      (epoch as number) < 0 ||
      !nonEmptyString(turnId) ||
      !nonEmptyString(segmentId)
    ) {
      return null
    }
    if (value.stepMs !== STEP_MS) return null
    const durationMs = value.durationMs
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
      return null
    }
    const expected = Math.ceil(durationMs / STEP_MS)
    const rawLevels = value.levels
    if (!Array.isArray(rawLevels) || rawLevels.length !== expected) return null
    const levels = new Array<number>(expected)
    for (let index = 0; index < expected; index += 1) {
      const level = rawLevels[index]
      if (
        typeof level !== 'number' ||
        !Number.isFinite(level) ||
        level < 0 ||
        level > 1
      ) {
        return null
      }
      levels[index] = level
    }
    return Object.freeze({
      audioRef,
      sessionId,
      epoch: epoch as number,
      turnId,
      segmentId,
      durationMs,
      levels: Object.freeze(levels),
    })
  } catch {
    return null
  }
}

/** Abort correlation without letting a signal listener disturb the media path. */
function abortQuietly(controller: AbortController): void {
  try {
    controller.abort()
  } catch {
    // A throwing abort listener cannot reopen the mouth or break playback.
  }
}

/** Convert one stored raw RMS window into the simple bounded opening gain. */
function openingAt(envelope: RetainedEnvelope, positionMs: number): number {
  if (!(positionMs >= 0 && positionMs < envelope.durationMs)) return 0
  const index = Math.floor(positionMs / STEP_MS)
  const rms = envelope.levels[index] ?? 0
  return Math.min(1, 5 * rms)
}

/**
 * Owns one connection's envelope state and one bounded opening write channel.
 *
 * Supply only retains a validated envelope. An output is bound to an envelope
 * only when an actual `playing` sample for the exact admitted identity arrives.
 * Epoch fences are per session, so a new session may stage its own epoch reset
 * without cancelling a still-playing output from another session. Pause,
 * waiting, terminal, Stop and disconnect force an immediate neutral zero, which
 * supersedes any slower ordinary acknowledgement. Closing forgets all state; a
 * replacement connection must create a new controller.
 */
export function createEnvelopePlayback(
  writeOpening: OpeningWriter,
  options: EnvelopePlaybackOptions = {},
): EnvelopePlayback {
  const maxEnvelopes = positiveLimit(options.maxEnvelopes, DEFAULT_MAX_ENVELOPES)
  const maxRetired = positiveLimit(options.maxRetired, DEFAULT_MAX_RETIRED)

  let active: ActiveOutput | null = null
  let lastPlaybackSession: string | null = null
  const pending: RetainedEnvelope[] = []
  const retiredKeys: RetiredKey[] = []
  const sessionEpochs = new Map<string, number>()
  const retiredSessions: string[] = []
  let order = 0

  let closed = false
  let closing: Promise<void> | null = null
  let current: WriteJob | null = null
  let queued: number | null = null

  function rememberRetired(identity: EnvelopeIdentity, outputId: string | null): void {
    if (
      retiredKeys.some(
        (candidate) =>
          candidate.outputId === outputId && sameIdentity(candidate.identity, identity),
      )
    ) {
      return
    }
    retiredKeys.push({ identity: identityOf(identity), outputId })
    if (retiredKeys.length > maxRetired) retiredKeys.shift()
  }

  function isSessionRetired(sessionId: string): boolean {
    return retiredSessions.includes(sessionId)
  }

  function retireSession(sessionId: string): void {
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const candidate = pending[index]
      if (candidate !== undefined && candidate.sessionId === sessionId) {
        pending.splice(index, 1)
        rememberRetired(candidate, null)
      }
    }
    sessionEpochs.delete(sessionId)
    if (isSessionRetired(sessionId)) return
    retiredSessions.push(sessionId)
    if (retiredSessions.length > MAX_RETIRED_SESSIONS) retiredSessions.shift()
  }

  function removePendingIdentity(identity: EnvelopeIdentity): void {
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const candidate = pending[index]
      if (candidate !== undefined && sameIdentity(candidate, identity)) {
        pending.splice(index, 1)
        rememberRetired(candidate, null)
      }
    }
  }

  function removePendingThroughSession(sessionId: string, bound: number): void {
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const candidate = pending[index]
      if (
        candidate !== undefined &&
        candidate.sessionId === sessionId &&
        candidate.order <= bound
      ) {
        pending.splice(index, 1)
        rememberRetired(candidate, null)
      }
    }
  }

  /**
   * A tombstone for a different pinned output must not block a refresh of the
   * legitimate active output. Tombstones that fence the whole identity do.
   */
  function isSupplyRetired(identity: EnvelopeIdentity): boolean {
    const matches = retiredKeys.filter((candidate) =>
      sameIdentity(candidate.identity, identity),
    )
    if (matches.length === 0) return false
    const pinned = active
    if (pinned !== null && sameIdentity(pinned.envelope, identity)) {
      return matches.some(
        (candidate) =>
          candidate.outputId === null || candidate.outputId === pinned.key.outputId,
      )
    }
    return true
  }

  function startWrite(opening: number): WriteJob {
    const controller = new AbortController()
    let settleDone: () => void = () => {}
    const done = new Promise<void>((resolve) => {
      settleDone = resolve
    })
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      settleDone()
    }
    const job: WriteJob = {
      controller,
      done,
      supersede: settle,
      complete() {
        settle()
        if (current !== job) return
        current = null
        if (closed || queued === null) return
        const next = queued
        queued = null
        startWrite(next)
      },
    }
    current = job

    let result: void | Promise<void>
    try {
      result = writeOpening(opening, controller.signal)
    } catch {
      job.complete()
      return job
    }
    if (result === undefined) {
      job.complete()
      return job
    }
    void Promise.resolve(result).then(
      () => job.complete(),
      () => job.complete(),
    )
    return job
  }

  /** Write a normal sample: one in flight, newer values coalesced to the latest. */
  function queueOpening(opening: number): void {
    if (closed) return
    if (current === null) {
      startWrite(opening)
      return
    }
    queued = opening
  }

  function supersedeCurrent(): void {
    queued = null
    const stale = current
    if (stale !== null) {
      abortQuietly(stale.controller)
      stale.supersede()
    }
  }

  /** A neutral event supersedes stale work and writes zero without waiting. */
  function forceZero(): void {
    if (closed) return
    supersedeCurrent()
    if (closed) return
    startWrite(0)
  }

  /** A genuinely new bound output replaces stale multi-tick correlation at once. */
  function replaceOpening(opening: number): void {
    if (closed) return
    supersedeCurrent()
    if (closed) return
    startWrite(opening)
  }

  function noteSessionEpoch(sessionId: string, epoch: number): void {
    const bound = sessionEpochs.get(sessionId)
    if (bound === undefined) {
      if (sessionEpochs.size >= MAX_SESSIONS) {
        for (const candidate of sessionEpochs.keys()) {
          if (candidate === active?.envelope.sessionId) continue
          if (candidate === lastPlaybackSession) continue
          retireSession(candidate)
          break
        }
      }
      sessionEpochs.set(sessionId, epoch)
      return
    }
    if (epoch <= bound) return
    sessionEpochs.set(sessionId, epoch)
    // Advancing one session's own epoch revokes its older outputs. A different
    // session's envelope never reaches this branch.
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const candidate = pending[index]
      if (
        candidate !== undefined &&
        candidate.sessionId === sessionId &&
        candidate.epoch < epoch
      ) {
        pending.splice(index, 1)
        rememberRetired(candidate, null)
      }
    }
    if (
      active !== null &&
      active.envelope.sessionId === sessionId &&
      active.envelope.epoch < epoch
    ) {
      const revoked = active
      active = null
      rememberRetired(revoked.envelope, revoked.key.outputId)
      forceZero()
    }
  }

  function findPending(key: MouthPlaybackKey): RetainedEnvelope | null {
    return pending.find((candidate) => sameIdentity(candidate, key)) ?? null
  }

  /**
   * Bind a pending envelope to its first true output. The last genuinely
   * played session survives the gap between segments; only a different session
   * that actually plays may retire it. Earlier pending envelopes are pruned
   * only inside the session that is playing, so foreign synth data staged for
   * a future session remains available until that session really starts.
   */
  function activate(envelope: RetainedEnvelope, key: MouthPlaybackKey): void {
    const previous = active
    if (previous !== null) {
      rememberRetired(previous.envelope, previous.key.outputId)
    }
    const priorSession = previous?.envelope.sessionId ?? lastPlaybackSession
    if (priorSession !== null && priorSession !== envelope.sessionId) {
      retireSession(priorSession)
    }
    lastPlaybackSession = envelope.sessionId

    const pendingIndex = pending.findIndex(
      (candidate) => candidate.order === envelope.order,
    )
    if (pendingIndex >= 0) pending.splice(pendingIndex, 1)

    // Segment order is session-local. A foreign session's staged envelope is
    // not retired just because synthesis delivered it before this segment.
    removePendingThroughSession(envelope.sessionId, envelope.order)
    active = { key: Object.freeze({ ...key }), envelope }
  }

  function admitPlaying(key: MouthPlaybackKey, positionMs: number): void {
    if (!Number.isFinite(positionMs)) return
    if (isSessionRetired(key.sessionId)) return
    const bound = sessionEpochs.get(key.sessionId)
    if (bound === undefined || key.epoch !== bound) return

    if (active !== null && sameIdentity(active.envelope, key)) {
      // The first true outputId owns the envelope; a foreign clock sample can
      // never steal or silence it.
      if (active.key.outputId !== key.outputId) return
      queueOpening(openingAt(active.envelope, positionMs))
      return
    }

    const envelope = findPending(key)
    if (envelope === null) return
    if (active !== null && envelope.order < active.envelope.order) return

    activate(envelope, key)
    // A genuine first activation may follow a held terminal zero. It must not
    // wait for that stale acknowledgement: the ordered sink already got the
    // neutral frame, so dispatch this opening immediately on a fresh signal.
    replaceOpening(openingAt(envelope, positionMs))
  }

  function admitReversible(key: MouthPlaybackKey): void {
    if (active === null || !sameKey(active.key, key)) return
    // Waiting/pause keep the binding so a later actual playing tick can resume.
    forceZero()
  }

  function admitTerminal(key: MouthPlaybackKey): void {
    // A terminal is authoritative even before any supply or epoch state exists.
    rememberRetired(key, key.outputId)

    if (active !== null && sameKey(active.key, key)) {
      const ended = active
      active = null
      removePendingThroughSession(ended.envelope.sessionId, ended.envelope.order)
      forceZero()
      return
    }

    if (active !== null && sameIdentity(active.envelope, key)) {
      // A foreign outputId cannot close the pinned legitimate output.
      return
    }

    // An as-yet-unplayed (or staged) output is fenced; an unrelated active
    // output is untouched and never receives this zero.
    removePendingIdentity(key)
  }

  function supply(raw: VolumeEnvelopeEvent): boolean {
    if (closed) return false
    const envelope = validateEnvelope(raw)
    if (envelope === null) return false
    if (isSessionRetired(envelope.sessionId)) return false

    const bound = sessionEpochs.get(envelope.sessionId)
    if (bound !== undefined && envelope.epoch < bound) return false
    if (bound === undefined || envelope.epoch > bound) {
      noteSessionEpoch(envelope.sessionId, envelope.epoch)
    }

    if (isSupplyRetired(envelope)) return false

    if (active !== null && sameIdentity(active.envelope, envelope)) {
      active = {
        key: active.key,
        envelope: { ...envelope, order: active.envelope.order },
      }
      return true
    }

    const pendingIndex = pending.findIndex((candidate) =>
      sameIdentity(candidate, envelope),
    )
    if (pendingIndex >= 0) {
      const existing = pending[pendingIndex]
      if (existing !== undefined) {
        pending[pendingIndex] = { ...envelope, order: existing.order }
      }
      return true
    }

    order += 1
    pending.push({ ...envelope, order })
    if (pending.length > maxEnvelopes) {
      const dropped = pending.shift()
      if (dropped !== undefined) rememberRetired(dropped, null)
    }
    return true
  }

  function readObservation(raw: MouthPlaybackSample): {
    readonly key: MouthPlaybackKey
    readonly state: unknown
    readonly positionMs: unknown
  } | null {
    try {
      const value = raw as unknown as {
        readonly key?: unknown
        readonly state?: unknown
        readonly positionMs?: unknown
      } | null
      if (typeof value !== 'object' || value === null) return null
      const key = value.key as MouthPlaybackKey | undefined
      if (
        typeof key !== 'object' ||
        key === null ||
        !nonEmptyString(key.audioRef) ||
        !nonEmptyString(key.sessionId) ||
        !Number.isInteger(key.epoch) ||
        key.epoch < 0 ||
        !nonEmptyString(key.turnId) ||
        !nonEmptyString(key.segmentId) ||
        !nonEmptyString(key.outputId)
      ) {
        return null
      }
      return { key, state: value.state, positionMs: value.positionMs }
    } catch {
      return null
    }
  }

  function observe(raw: MouthPlaybackSample): void {
    if (closed) return
    const observation = readObservation(raw)
    if (observation === null) return
    const { key, state, positionMs } = observation

    if (state === 'playing') {
      if (typeof positionMs !== 'number') return
      admitPlaying(key, positionMs)
      return
    }
    if (state === 'waiting' || state === 'paused') {
      admitReversible(key)
      return
    }
    if (state === 'ended' || state === 'error' || state === 'stopped') {
      admitTerminal(key)
    }
  }

  function close(): Promise<void> {
    if (closing !== null) return closing
    // Assign the closure guard before any external writer runs: a sink may call
    // close() synchronously while receiving its own forced zero.
    closed = true
    let resolveClosing: () => void = () => {}
    closing = new Promise<void>((resolve) => {
      resolveClosing = resolve
    })
    queued = null
    active = null
    lastPlaybackSession = null
    pending.length = 0
    retiredKeys.length = 0
    sessionEpochs.clear()
    retiredSessions.length = 0

    const stale = current
    if (stale !== null) {
      abortQuietly(stale.controller)
      stale.supersede()
    }
    const zero = startWrite(0)
    void zero.done.then(resolveClosing, resolveClosing)
    return closing
  }

  async function flush(): Promise<void> {
    for (;;) {
      if (current !== null) {
        const job = current
        await job.done
        continue
      }
      if (!closed && queued !== null) {
        const next = queued
        queued = null
        startWrite(next)
        continue
      }
      return
    }
  }

  return {
    supply,
    observe,
    disconnect: close,
    close,
    flush,
  }
}
