import type {
  PerformanceCancel,
  PerformanceCommand,
  PerformanceReceipt,
  PlayerStatus,
} from '../../contracts/app'
import { z } from 'zod'
import {
  counter,
  nonEmptyString,
  performanceCancelSchema,
  performanceCommandSchema,
  performanceReceiptSchema,
} from '../../contracts/app'
import type {
  AudioLease,
  MediaEvent,
  MediaHandle,
  PlaybackContext,
  PlaybackController,
  PlaybackDeps,
  PlayerDispatchErrorCode,
} from './types'
import { PlayerDispatchError } from './types'

/** Receipt source label for the single-output browser player. */
export const M1_PLAYER_SOURCE = 'm1-player'

/**
 * Bootstrap configuration schema. A trusted session must be a nonempty string
 * and the initial epoch a finite nonnegative integer; invalid values are
 * rejected before the controller performs any effect rather than coerced.
 */
const bootstrapConfigSchema = z.strictObject({
  sessionId: nonEmptyString,
  initialEpoch: counter,
})

interface RetainedRecord {
  command: PerformanceCommand
  promise: Promise<PerformanceReceipt>
  settled: boolean
  receipt: PerformanceReceipt | null
}

interface ActiveOperation {
  command: PerformanceCommand
  signal: AbortSignal
  promise: Promise<PerformanceReceipt>
  resolve: (receipt: PerformanceReceipt) => void
  removeAbortListener: () => void
  invalidated: boolean
  terminalChosen: boolean
  terminalReceipt: PerformanceReceipt | null
  pendingTerminal: { stage: PerformanceReceipt['stage']; reasonCode: string | null } | null
  started: boolean
  quarantined: boolean
  handle: MediaHandle | null
  lease: AudioLease | null
  unsubscribe: (() => void) | null
}

function sameCommand(left: PerformanceCommand, right: PerformanceCommand): boolean {
  return (
    left.outputId === right.outputId &&
    left.sessionId === right.sessionId &&
    left.epoch === right.epoch &&
    left.turnId === right.turnId &&
    left.segmentId === right.segmentId &&
    left.audioRef === right.audioRef &&
    left.subtitleText === right.subtitleText &&
    left.actionId === right.actionId &&
    left.capabilityRevision === right.capabilityRevision
  )
}

/**
 * A single-output browser playback controller.
 *
 * One controller serves one trusted session with an initial epoch and at most
 * one active media operation. It retains a current-epoch record per output id
 * (command, core-operation promise and terminal receipt) with no count quota,
 * so identical commands deduplicate even after many completed outputs. Audio
 * leases, media handles and subscriptions are released at each operation's
 * terminal cleanup; retained records survive until a trusted epoch advance or
 * disposal.
 *
 * Admission errors reject with {@link PlayerDispatchError} and never create a
 * conflicting performance receipt. A terminal execute promise always settles to
 * exactly one `completed`, `cancelled` or `failed` receipt.
 */
export function createPlaybackController(deps: PlaybackDeps): PlaybackController {
  const config = bootstrapConfigSchema.parse({
    sessionId: deps.sessionId,
    initialEpoch: deps.initialEpoch,
  })
  const sessionId = config.sessionId
  let lowerBound = config.initialEpoch
  let disposed = false
  let lastStage: PerformanceReceipt['stage'] | null = null

  const records = new Map<string, RetainedRecord>()
  let active: ActiveOperation | null = null
  // Nonzero while a synchronous dependency call (create/subscribe/load/play) is
  // in flight, so a terminal it triggers can be deferred until after the call
  // registers its returned resources.
  let syncBoundaryDepth = 0

  const observerQueue: PerformanceReceipt[] = []
  let observerFlushing = false

  const reportFault = (error: unknown): void => {
    try {
      deps.reportFault(error)
    } catch {
      // Fault reporting is best-effort and must never disturb playback.
    }
  }

  const flushObservers = (): void => {
    observerFlushing = false
    while (observerQueue.length > 0) {
      const receipt = observerQueue.shift()
      if (receipt === undefined) continue
      try {
        deps.onReceipt(receipt)
      } catch (error) {
        reportFault(error)
      }
    }
  }

  const emit = (receipt: PerformanceReceipt): void => {
    observerQueue.push(receipt)
    if (observerFlushing) return
    observerFlushing = true
    void Promise.resolve().then(flushObservers)
  }

  const buildReceipt = (
    command: PerformanceCommand,
    stage: PerformanceReceipt['stage'],
    reasonCode: string | null,
    localTimeMs: number | null,
  ): PerformanceReceipt => {
    const receipt = performanceReceiptSchema.parse({
      receiptId: deps.receipts.newReceiptId(),
      outputId: command.outputId,
      sessionId: command.sessionId,
      epoch: command.epoch,
      turnId: command.turnId,
      segmentId: command.segmentId,
      modality: 'audio',
      stage,
      localTimeMs,
      chunkIds: null,
      reasonCode,
      source: M1_PLAYER_SOURCE,
    })
    // Retained records must not be mutable through a shared receipt payload.
    return Object.freeze(receipt) as PerformanceReceipt
  }

  const safeRelease = (lease: AudioLease | null): void => {
    if (lease === null) return
    try {
      lease.release()
    } catch (error) {
      reportFault(error)
    }
  }

  /** Release an operation's media subscription exactly once, if present. */
  const releaseUnsubscribe = (operation: ActiveOperation): void => {
    if (operation.unsubscribe === null) return
    try {
      operation.unsubscribe()
    } catch (error) {
      reportFault(error)
    }
    operation.unsubscribe = null
  }

  /**
   * Unsubscribe, detach and release one operation's local resources. Retained
   * handle/lease on a failed detach stay quarantined for a later dispose retry.
   */
  const cleanup = (operation: ActiveOperation): boolean => {
    releaseUnsubscribe(operation)
    if (operation.handle !== null) {
      let detached = false
      try {
        detached = operation.handle.detach()
      } catch {
        detached = false
      }
      if (!detached) {
        reportFault(new Error('m1-player: media detach failed'))
        return false
      }
      safeRelease(operation.lease)
      operation.lease = null
      operation.handle = null
      return true
    }
    safeRelease(operation.lease)
    operation.lease = null
    return true
  }

  /**
   * Clean up and commit one selected terminal exactly once. A failed detach
   * never falsely claims cancellation or idle; a previously observed natural
   * completion remains the delivery fact and retained resources are
   * quarantined for a later dispose retry.
   */
  const finalizeTerminal = (
    operation: ActiveOperation,
    stage: PerformanceReceipt['stage'],
    reasonCode: string | null,
  ): PerformanceReceipt => {
    const detached = cleanup(operation)
    let finalStage = stage
    let finalReason = reasonCode
    if (!detached && stage !== 'completed') {
      finalStage = 'failed'
      finalReason = 'cleanup_failed'
    }
    const receipt = buildReceipt(operation.command, finalStage, finalReason, deps.receipts.localNowMs())
    operation.terminalReceipt = receipt
    lastStage = finalStage

    const record = records.get(operation.command.outputId)
    if (record !== undefined) {
      record.settled = true
      record.receipt = receipt
    }
    if (detached) {
      if (active === operation) active = null
    } else {
      operation.quarantined = true
    }
    // Enqueue the fact before resolving so a queued observer sees it first.
    emit(receipt)
    operation.resolve(receipt)
    return receipt
  }

  /**
   * The single terminal-selection guard. Invalidation is committed
   * synchronously, but inside a synchronous dependency boundary the cleanup is
   * deferred until the boundary has registered its returned handle and
   * subscription, so a failed detach still quarantines real resources. The
   * first selection is retained; later attempts return it or the pending null.
   */
  const settleTerminal = (
    operation: ActiveOperation,
    stage: PerformanceReceipt['stage'],
    reasonCode: string | null,
  ): PerformanceReceipt | null => {
    if (operation.terminalChosen) {
      return operation.terminalReceipt
    }
    operation.terminalChosen = true
    operation.invalidated = true
    operation.removeAbortListener()
    if (syncBoundaryDepth > 0) {
      operation.pendingTerminal = { stage, reasonCode }
      return null
    }
    return finalizeTerminal(operation, stage, reasonCode)
  }

  /** Commit a terminal selection deferred by a synchronous dependency boundary. */
  const commitPendingTerminal = (operation: ActiveOperation): void => {
    const pending = operation.pendingTerminal
    if (pending === null) return
    operation.pendingTerminal = null
    finalizeTerminal(operation, pending.stage, pending.reasonCode)
  }

  /** Run a synchronous dependency call whose callbacks may select a terminal. */
  const withinSyncBoundary = <T,>(call: () => T): T => {
    syncBoundaryDepth += 1
    try {
      return call()
    } finally {
      syncBoundaryDepth -= 1
    }
  }

  const onMediaEvent = (operation: ActiveOperation, event: MediaEvent): void => {
    if (operation.invalidated) return
    if (event.type === 'playing') {
      if (operation.started) return
      operation.started = true
      lastStage = 'started'
      emit(buildReceipt(operation.command, 'started', null, deps.receipts.localNowMs()))
      return
    }
    if (event.type === 'ended') {
      if (operation.started) settleTerminal(operation, 'completed', null)
      else settleTerminal(operation, 'failed', 'start_unobserved')
      return
    }
    const reason = event.reasonCode.length > 0 ? event.reasonCode : 'media_error'
    settleTerminal(operation, 'failed', reason)
  }

  const runOperation = async (operation: ActiveOperation): Promise<void> => {
    let lease: AudioLease
    try {
      lease = await deps.resolver.resolve(operation.command.audioRef, operation.signal)
    } catch {
      if (operation.invalidated) return
      settleTerminal(operation, 'failed', 'resolver_failed')
      return
    }
    if (operation.invalidated) {
      // Cancellation cooperation is not assumed: release a late lease directly.
      safeRelease(lease)
      return
    }
    operation.lease = lease

    let handle: MediaHandle
    try {
      handle = withinSyncBoundary(() => deps.media.create())
    } catch {
      commitPendingTerminal(operation)
      if (!operation.terminalChosen) settleTerminal(operation, 'failed', 'media_create_failed')
      return
    }
    operation.handle = handle
    // `create()` is a synchronous boundary: an owner abort may have selected a
    // terminal before this returned handle was registered. Commit it now so a
    // failed detach still quarantines the live handle and retains the lease.
    if (operation.terminalChosen) {
      commitPendingTerminal(operation)
      return
    }

    let unsubscribe: () => void
    try {
      unsubscribe = withinSyncBoundary(() =>
        handle.subscribe((event) => onMediaEvent(operation, event)),
      )
    } catch {
      commitPendingTerminal(operation)
      if (!operation.terminalChosen) settleTerminal(operation, 'failed', 'media_create_failed')
      return
    }
    operation.unsubscribe = unsubscribe
    // `subscribe()` may synchronously deliver a terminal event or abort the
    // owner; commit it now that the returned subscription is registered.
    if (operation.terminalChosen) {
      commitPendingTerminal(operation)
      return
    }

    try {
      withinSyncBoundary(() => handle.load(lease.blob))
    } catch {
      commitPendingTerminal(operation)
      if (!operation.terminalChosen) settleTerminal(operation, 'failed', 'load_failed')
      return
    }
    // `load()` may synchronously deliver a terminal event or abort the owner.
    if (operation.terminalChosen) {
      commitPendingTerminal(operation)
      return
    }

    let playPromise: Promise<void>
    try {
      playPromise = withinSyncBoundary(() => handle.play())
    } catch {
      commitPendingTerminal(operation)
      if (!operation.terminalChosen) settleTerminal(operation, 'failed', 'play_failed')
      return
    }
    Promise.resolve(playPromise).catch(() => {
      if (operation.invalidated) return
      settleTerminal(operation, 'failed', 'play_failed')
    })
    // `play()` may synchronously deliver a terminal event or abort the owner.
    commitPendingTerminal(operation)
  }

  const retireBelow = (bound: number): void => {
    for (const [outputId, record] of [...records]) {
      if (record.command.epoch < bound) records.delete(outputId)
    }
  }

  const isRecordAdmissible = (record: RetainedRecord): Promise<PerformanceReceipt> =>
    record.settled && record.receipt !== null
      ? Promise.resolve(record.receipt)
      : record.promise

  const admit = (command: PerformanceCommand, context: PlaybackContext): Promise<PerformanceReceipt> => {
    let resolvePromise: (receipt: PerformanceReceipt) => void = () => {}
    const promise = new Promise<PerformanceReceipt>((resolve) => {
      resolvePromise = resolve
    })
    const operation: ActiveOperation = {
      command,
      signal: context.signal,
      promise,
      resolve: resolvePromise,
      removeAbortListener: () => {},
      invalidated: false,
      terminalChosen: false,
      terminalReceipt: null,
      pendingTerminal: null,
      started: false,
      quarantined: false,
      handle: null,
      lease: null,
      unsubscribe: null,
    }
    records.set(command.outputId, { command, promise, settled: false, receipt: null })
    active = operation
    lastStage = 'accepted'

    const onAbort = (): void => {
      if (active === operation && !operation.terminalChosen) {
        settleTerminal(operation, 'cancelled', null)
      }
    }
    if (context.signal.aborted) {
      operation.removeAbortListener = () => {}
    } else {
      context.signal.addEventListener('abort', onAbort, { once: true })
      operation.removeAbortListener = () => context.signal.removeEventListener('abort', onAbort)
    }

    emit(buildReceipt(command, 'accepted', null, deps.receipts.localNowMs()))

    if (context.signal.aborted) {
      settleTerminal(operation, 'cancelled', null)
      return promise
    }
    void runOperation(operation)
    return promise
  }

  const rejectAdmission = (code: PlayerDispatchErrorCode): Promise<PerformanceReceipt> =>
    Promise.reject(new PlayerDispatchError(code))

  return {
    execute(command, context) {
      if (disposed) return rejectAdmission('unavailable')

      let parsed: PerformanceCommand
      try {
        parsed = performanceCommandSchema.parse(command)
      } catch {
        return rejectAdmission('invalid_command')
      }
      if (parsed.sessionId !== sessionId) return rejectAdmission('session_mismatch')
      if (parsed.epoch < lowerBound) return rejectAdmission('stale')

      if (active !== null) {
        const existing = records.get(parsed.outputId)
        if (existing !== undefined) {
          if (!sameCommand(existing.command, parsed)) return rejectAdmission('conflict')
          return isRecordAdmissible(existing)
        }
        return rejectAdmission('busy')
      }

      if (parsed.epoch > lowerBound) {
        lowerBound = parsed.epoch
        retireBelow(lowerBound)
      }
      const existing = records.get(parsed.outputId)
      if (existing !== undefined) {
        if (!sameCommand(existing.command, parsed)) return rejectAdmission('conflict')
        return isRecordAdmissible(existing)
      }
      return admit(parsed, context)
    },

    cancel(request: PerformanceCancel) {
      if (disposed) return Promise.resolve(null)
      let parsed: PerformanceCancel
      try {
        parsed = performanceCancelSchema.parse(request)
      } catch {
        return rejectAdmission('invalid_command')
      }
      if (!(parsed.newEpoch > parsed.revokedEpoch)) return rejectAdmission('invalid_command')
      if (active !== null && active.command.epoch > parsed.revokedEpoch) {
        return rejectAdmission('stale_cancel')
      }

      const newBound = Math.max(lowerBound, parsed.newEpoch)
      // Capture the operation before any terminal side effect may clear the
      // mutable active slot.
      const operation = active
      if (operation !== null) {
        if (!operation.terminalChosen) {
          settleTerminal(operation, 'cancelled', null)
        }
        lowerBound = newBound
        retireBelow(lowerBound)
        // A synchronous dependency boundary defers finalisation until it has
        // registered its returned resources; adopt the operation's own terminal
        // promise so the caller observes the same single fact, not an early null.
        return operation.terminalReceipt !== null
          ? Promise.resolve(operation.terminalReceipt)
          : operation.promise
      }
      lowerBound = newBound
      retireBelow(lowerBound)
      return Promise.resolve(null)
    },

    status(): PlayerStatus {
      if (active !== null) {
        return { idle: false, activeOutputId: active.command.outputId, lastStage }
      }
      return { idle: true, activeOutputId: null, lastStage }
    },

    dispose() {
      disposed = true
      // Capture the operation before any terminal side effect may clear the
      // mutable active slot.
      const operation = active
      if (operation !== null) {
        if (!operation.terminalChosen) {
          settleTerminal(operation, 'cancelled', null)
        }
        // Never clean up before a synchronous dependency boundary has
        // registered its returned resources; runOperation commits it then.
        if (syncBoundaryDepth === 0) {
          commitPendingTerminal(operation)
        }
        if (operation.quarantined) {
          const retried = cleanup(operation)
          if (retried && active === operation) active = null
        }
      }
      records.clear()
    },
  }
}
