/**
 * M5 VTube Studio acquisition lifecycle (first stage).
 *
 * The deployment supplies an injected connector that opens one exclusive D1
 * connection handle, a credential provider backed by the deployment's store,
 * the plugin identity and the record target. This module performs one bounded
 * acquisition attempt: it starts the connector under cancellation, runs the
 * real D2 pairing primitive on the returned handle, and hands the identical
 * authenticated handle to the current owner.
 *
 * The connector owns opening failures and their cleanup, observes the supplied
 * attempt signal, and must return an acquired handle even when the attempt has
 * already been cancelled so M5 can close it. Cancellation and the caller-owned
 * acquisition deadline settle the caller-visible result immediately; any late
 * handle, admitted credential operation or physical cleanup continues in the
 * attempt's own background work and keeps replacement blocked until it is
 * actually resolved.
 *
 * Credential operations are coordinated per structured plugin-identity/target
 * record inside one explicitly injected coordinator per underlying store. The
 * same coordinator must be passed to every acquisition manager for that store,
 * so constructing another manager cannot bypass a pending save. The coordinator
 * binds the frozen record to the actual store load/save calls. It never caches
 * a value, fabricates `null`, erases a credential or rolls a completed store
 * write back.
 *
 * No renderer, gate facade, endpoint discovery, production composition or
 * recovery unlock is part of this stage.
 */

import type {
  VtsConnectionCompletion,
  VtsConnectionHandle,
} from '../performance/vts-connection'
import { pairVtsConnection } from '../performance/vts-pairing'
import type {
  VtsPairingCredentialProvider,
  VtsPairingFailureCode,
  VtsPairingIdentity,
  VtsPairingResult,
} from '../performance/vts-pairing'

const MAX_TIMER_MS = 2_147_483_647
const MIN_IDENTITY_LENGTH = 3
const MAX_IDENTITY_LENGTH = 32
const MAX_TARGET_LENGTH = 256
const INVALID_OPTIONS_MESSAGE = 'vts-acquisition: invalid options'
const INVALID_SIGNAL_MESSAGE = 'vts-acquisition: ownerSignal must be an AbortSignal'

/** Explicit lifecycle state. No implicit retry or automatic reconnect exists. */
export type VtsAcquisitionState =
  | 'idle'
  | 'acquiring'
  | 'ready'
  | 'stopping'
  | 'blocked'
  | 'stopped'
  | 'failed'
  | 'quarantined'

/** First terminal cause of the current or most recent attempt. */
export type VtsAcquisitionCause = 'owner' | 'deadline' | 'released'

export type VtsAcquisitionStage =
  | 'connect'
  | 'pairing'
  | 'handoff'
  | 'cancelled'
  | 'deadline'
  | 'released'

export type VtsAcquisitionRefusal = 'busy' | 'blocked' | 'quarantined' | 'already_acquired'

export type VtsAcquireFailureReason =
  | 'cancelled'
  | 'deadline_exceeded'
  | 'released'
  | 'connection_failed'
  | 'pairing_failed'
  | 'handoff_rejected'

export interface VtsAcquisitionCleanup {
  /** Observed D1 completion, or null when no owned completion was observed yet. */
  readonly connection: VtsConnectionCompletion | null
  readonly pairing: 'not_started' | 'pending' | 'released' | 'release_failed'
  readonly save: 'not_admitted' | 'pending' | 'settled' | 'rejected'
  readonly lateHandle: 'none' | 'pending' | 'closed' | 'failed'
}

export type VtsAcquireResult =
  | { readonly kind: 'acquired'; readonly handle: VtsConnectionHandle }
  | {
      readonly kind: 'failed'
      readonly stage: VtsAcquisitionStage
      readonly reason: VtsAcquireFailureReason
      readonly cause: VtsAcquisitionCause | null
      readonly pairing: VtsPairingFailureCode | null
      readonly cleanup: VtsAcquisitionCleanup
    }
  | { readonly kind: 'refused'; readonly reason: VtsAcquisitionRefusal }

export type VtsAcquisitionReleaseResult = 'stopped' | 'blocked' | 'quarantined'

export interface VtsAcquisitionOptions {
  /**
   * Open one exclusive D1 handle. The connector owns opening failures and
   * their cleanup, receives the attempt signal, and must return any handle it
   * acquires after cancellation so this module can close it.
   */
  readonly connect: (signal: AbortSignal) => Promise<VtsConnectionHandle>
  /**
   * The explicit coordinator shared by every acquisition manager that uses the
   * same underlying credential store. It binds the frozen identity/target
   * record to the actual store load/save calls.
   */
  readonly credentials: VtsCredentialCoordinator
  readonly identity: VtsPairingIdentity
  /** Structured record target, for example the deployment's endpoint identity. */
  readonly target: string
  readonly mode: 'existing-only' | 'allow-prompt'
  /** Caller-explicit total acquisition deadline. */
  readonly acquisitionTimeoutMs: number
  readonly requestTimeoutMs: number
  readonly humanApprovalTimeoutMs: number
}

export interface VtsAcquisition {
  acquire(ownerSignal?: AbortSignal): Promise<VtsAcquireResult>
  release(): Promise<VtsAcquisitionReleaseResult>
  state(): VtsAcquisitionState
  /** Resolves when no attempt or admitted credential operation is outstanding. */
  whenSettled(): Promise<void>
}

export type VtsCredentialOperation = 'load' | 'save'

/** Frozen structured plugin identity and target record. */
export interface VtsCredentialRecord {
  readonly pluginName: string
  readonly pluginDeveloper: string
  readonly target: string
}

/**
 * Record-aware credential store owned by the deployment. Every load and save
 * receives the frozen record that identifies the plugin identity and target.
 */
export interface VtsCredentialStore {
  load(record: VtsCredentialRecord, signal: AbortSignal): Promise<string | null>
  save(record: VtsCredentialRecord, value: string, signal: AbortSignal): Promise<void>
}

/** Raised when the same store record already has an operation in flight. */
export class VtsCredentialBusyError extends Error {
  readonly record: VtsCredentialRecord
  readonly recordKey: string
  readonly operation: VtsCredentialOperation

  constructor(
    record: VtsCredentialRecord,
    recordKey: string,
    operation: VtsCredentialOperation,
  ) {
    super('vts-acquisition: credential operation already in flight for this record')
    this.name = 'VtsCredentialBusyError'
    this.record = record
    this.recordKey = recordKey
    this.operation = operation
  }
}

export interface VtsCredentialCoordinator {
  /** True while any operation for this structured record is in flight. */
  isBusy(record: VtsCredentialRecord): boolean
  /**
   * Bind a frozen copy of `record` to the store and return a D2 credential
   * provider. Its load/save calls receive that same frozen record.
   */
  provider(record: VtsCredentialRecord): VtsPairingCredentialProvider
  /**
   * Run at most one operation for this record at a time. The claim is taken
   * synchronously, so a reentrant or competing caller is refused before any
   * effect and can never observe a partially admitted save.
   */
  run<T>(
    record: VtsCredentialRecord,
    operation: VtsCredentialOperation,
    action: () => Promise<T> | T,
  ): Promise<T>
}

function isCredentialRecord(value: unknown): value is VtsCredentialRecord {
  return (
    isRecord(value) &&
    isIdentityName(value.pluginName) &&
    isIdentityName(value.pluginDeveloper) &&
    isValidTarget(value.target)
  )
}

function vtsCredentialRecordKey(record: VtsCredentialRecord): string {
  return JSON.stringify([record.pluginName, record.pluginDeveloper, record.target])
}

/**
 * Create the explicit credential coordinator for one underlying store. The
 * deployment must create one coordinator per store and inject the same
 * instance into every acquisition manager for that store; the coordinator
 * holds the in-flight record set itself rather than relying on a process-global
 * label.
 */
export function createVtsCredentialCoordinator(
  store: VtsCredentialStore,
): VtsCredentialCoordinator {
  if (
    !isRecord(store) ||
    typeof store.load !== 'function' ||
    typeof store.save !== 'function'
  ) {
    throw new Error(INVALID_OPTIONS_MESSAGE)
  }

  const inFlight = new Set<string>()

  const run = <T>(
    record: VtsCredentialRecord,
    operation: VtsCredentialOperation,
    action: () => Promise<T> | T,
  ): Promise<T> => {
    if (!isCredentialRecord(record)) throw new Error(INVALID_OPTIONS_MESSAGE)
    const recordKey = vtsCredentialRecordKey(record)
    if (inFlight.has(recordKey)) {
      throw new VtsCredentialBusyError(record, recordKey, operation)
    }
    inFlight.add(recordKey)

    let result: Promise<T> | T
    try {
      result = action()
    } catch (error) {
      inFlight.delete(recordKey)
      throw error
    }

    return Promise.resolve(result).finally(() => {
      inFlight.delete(recordKey)
    })
  }

  return {
    isBusy(record) {
      if (!isCredentialRecord(record)) throw new Error(INVALID_OPTIONS_MESSAGE)
      return inFlight.has(vtsCredentialRecordKey(record))
    },
    run,
    provider(record) {
      if (!isCredentialRecord(record)) throw new Error(INVALID_OPTIONS_MESSAGE)
      const frozen: VtsCredentialRecord = Object.freeze({
        pluginName: record.pluginName,
        pluginDeveloper: record.pluginDeveloper,
        target: record.target,
      })
      return {
        load: (signal) => run(frozen, 'load', () => store.load(frozen, signal)),
        save: (value, signal) => run(frozen, 'save', () => store.save(frozen, value, signal)),
      }
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isIdentityName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= MIN_IDENTITY_LENGTH &&
    value.length <= MAX_IDENTITY_LENGTH
  )
}

function isTimerBudget(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_TIMER_MS
  )
}

function isValidSignal(value: unknown): value is AbortSignal {
  return (
    isRecord(value) &&
    typeof value.aborted === 'boolean' &&
    typeof value.addEventListener === 'function' &&
    typeof value.removeEventListener === 'function'
  )
}

function isValidTarget(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TARGET_LENGTH
}

function validateOptions(options: VtsAcquisitionOptions): void {
  if (!isRecord(options)) throw new Error(INVALID_OPTIONS_MESSAGE)
  const record = options as unknown as Record<string, unknown>

  if (typeof record.connect !== 'function') throw new Error(INVALID_OPTIONS_MESSAGE)

  const identity = record.identity
  if (
    !isRecord(identity) ||
    !isIdentityName(identity.pluginName) ||
    !isIdentityName(identity.pluginDeveloper)
  ) {
    throw new Error(INVALID_OPTIONS_MESSAGE)
  }
  if (!isValidTarget(record.target)) throw new Error(INVALID_OPTIONS_MESSAGE)

  const credentials = record.credentials
  if (
    !isRecord(credentials) ||
    typeof credentials.provider !== 'function' ||
    typeof credentials.isBusy !== 'function'
  ) {
    throw new Error(INVALID_OPTIONS_MESSAGE)
  }

  if (record.mode !== 'existing-only' && record.mode !== 'allow-prompt') {
    throw new Error(INVALID_OPTIONS_MESSAGE)
  }
  if (
    !isTimerBudget(record.acquisitionTimeoutMs) ||
    !isTimerBudget(record.requestTimeoutMs) ||
    !isTimerBudget(record.humanApprovalTimeoutMs)
  ) {
    throw new Error(INVALID_OPTIONS_MESSAGE)
  }
}

function normalizeCompletion(value: unknown): VtsConnectionCompletion {
  if (isRecord(value)) {
    if (value.kind === 'closed') return { kind: 'closed' }
    if (
      value.kind === 'failed' &&
      (value.code === 'close_timeout' || value.code === 'close_failed')
    ) {
      return { kind: 'failed', code: value.code }
    }
  }
  return { kind: 'failed', code: 'close_failed' }
}

function causeStage(cause: VtsAcquisitionCause): VtsAcquisitionStage {
  if (cause === 'owner') return 'cancelled'
  if (cause === 'deadline') return 'deadline'
  return 'released'
}

function causeReason(cause: VtsAcquisitionCause): VtsAcquireFailureReason {
  if (cause === 'owner') return 'cancelled'
  if (cause === 'deadline') return 'deadline_exceeded'
  return 'released'
}

interface Attempt {
  readonly controller: AbortController
  readonly signal: AbortSignal
  readonly outcome: Promise<VtsAcquireResult>
  readonly drained: Promise<void>
  readonly resolveOutcome: (result: VtsAcquireResult) => void
  readonly resolveDrained: () => void
  cause: VtsAcquisitionCause | null
  released: boolean
  connectStarted: boolean
  connectSettled: boolean
  finished: boolean
  accepted: boolean
  outcomeSettled: boolean
  handle: VtsConnectionHandle | null
  connection: VtsConnectionCompletion | null
  pairing: VtsPairingFailureCode | null
  pairingCleanup: 'not_started' | 'pending' | 'released' | 'release_failed'
  pendingLoads: number
  pendingSaves: number
  saveOutcome: 'not_admitted' | 'pending' | 'settled' | 'rejected'
  lateHandle: 'none' | 'pending' | 'closed' | 'failed'
  cleanupFailed: boolean
  timer: ReturnType<typeof setTimeout> | null
  ownerSignal: AbortSignal | null
  onOwnerAbort: (() => void) | null
}

function emptyCleanup(): VtsAcquisitionCleanup {
  return {
    connection: null,
    pairing: 'not_started',
    save: 'not_admitted',
    lateHandle: 'none',
  }
}

export function createVtsAcquisition(options: VtsAcquisitionOptions): VtsAcquisition {
  validateOptions(options)

  // Identity and target are copied and frozen before any effect so a caller
  // mutation cannot change the record key, the store record or the identity
  // used in the protocol.
  const identity: VtsPairingIdentity = Object.freeze({
    pluginName: options.identity.pluginName,
    pluginDeveloper: options.identity.pluginDeveloper,
  })
  const record: VtsCredentialRecord = Object.freeze({
    pluginName: identity.pluginName,
    pluginDeveloper: identity.pluginDeveloper,
    target: options.target,
  })
  const recordCredentials = options.credentials.provider(record)
  const mode = options.mode
  const acquisitionTimeoutMs = options.acquisitionTimeoutMs
  const requestTimeoutMs = options.requestTimeoutMs
  const humanApprovalTimeoutMs = options.humanApprovalTimeoutMs
  const connect = options.connect

  let stateValue: VtsAcquisitionState = 'idle'
  let currentAttempt: Attempt | null = null
  let readyHandle: VtsConnectionHandle | null = null
  let pendingRelease: Promise<VtsAcquisitionReleaseResult> | null = null
  let settledWaiters: Array<() => void> = []

  const createAttempt = (ownerSignal: AbortSignal | null): Attempt => {
    const controller = new AbortController()
    let resolveOutcome!: (result: VtsAcquireResult) => void
    let resolveDrained!: () => void
    const outcome = new Promise<VtsAcquireResult>((resolve) => {
      resolveOutcome = resolve
    })
    const drained = new Promise<void>((resolve) => {
      resolveDrained = resolve
    })
    return {
      controller,
      signal: controller.signal,
      outcome,
      drained,
      resolveOutcome,
      resolveDrained,
      cause: null,
      released: false,
      connectStarted: false,
      connectSettled: false,
      finished: false,
      accepted: false,
      outcomeSettled: false,
      handle: null,
      connection: null,
      pairing: null,
      pairingCleanup: 'not_started',
      pendingLoads: 0,
      pendingSaves: 0,
      saveOutcome: 'not_admitted',
      lateHandle: 'none',
      cleanupFailed: false,
      timer: null,
      ownerSignal,
      onOwnerAbort: null,
    }
  }

  const hasOutstanding = (attempt: Attempt): boolean =>
    attempt.pendingLoads > 0 || attempt.pendingSaves > 0 || attempt.lateHandle === 'pending'

  const classify = (attempt: Attempt): VtsAcquisitionState => {
    if (attempt.cleanupFailed) return 'quarantined'
    if (hasOutstanding(attempt)) return 'blocked'
    if (attempt.released) return 'stopped'
    return 'failed'
  }

  const isQuiet = (): boolean => {
    if (stateValue === 'acquiring' || stateValue === 'stopping') return false
    const attempt = currentAttempt
    if (attempt === null) return true
    return attempt.finished && !hasOutstanding(attempt)
  }

  const currentState = (): VtsAcquisitionState => stateValue

  const notifySettled = (): void => {
    if (!isQuiet()) return
    const waiters = settledWaiters
    settledWaiters = []
    for (const resolve of waiters) resolve()
  }

  const settleOutcome = (attempt: Attempt, result: VtsAcquireResult): void => {
    if (attempt.outcomeSettled) return
    attempt.outcomeSettled = true
    attempt.resolveOutcome(result)
    notifySettled()
  }

  const snapshot = (attempt: Attempt): VtsAcquisitionCleanup => ({
    connection: attempt.connection,
    pairing: attempt.pairingCleanup,
    save: attempt.saveOutcome,
    lateHandle: attempt.lateHandle,
  })

  const clearAcquisitionTimer = (attempt: Attempt): void => {
    if (attempt.timer !== null) {
      clearTimeout(attempt.timer)
      attempt.timer = null
    }
    const signal = attempt.ownerSignal
    const listener = attempt.onOwnerAbort
    attempt.ownerSignal = null
    attempt.onOwnerAbort = null
    if (signal !== null && listener !== null) {
      try {
        signal.removeEventListener('abort', listener)
      } catch {
        // Listener removal is best effort; the attempt is already decided.
      }
    }
  }

  const abortAttempt = (attempt: Attempt, cause: VtsAcquisitionCause): void => {
    if (attempt.cause !== null) return
    attempt.cause = cause
    if (cause === 'released') attempt.released = true
    clearAcquisitionTimer(attempt)
    try {
      attempt.controller.abort(cause)
    } catch {
      // The signal is already terminal; cancellation is still recorded.
    }
    if (currentAttempt !== attempt) return
    if (!attempt.finished && !attempt.accepted) {
      settleOutcome(attempt, {
        kind: 'failed',
        stage: causeStage(cause),
        reason: causeReason(cause),
        cause,
        pairing: attempt.pairing,
        cleanup: snapshot(attempt),
      })
    }
    if (stateValue === 'acquiring' || stateValue === 'stopping') {
      stateValue = 'blocked'
      notifySettled()
    }
  }

  const closeOwned = async (
    attempt: Attempt,
    handle: VtsConnectionHandle,
  ): Promise<VtsConnectionCompletion> => {
    let completion: VtsConnectionCompletion
    try {
      completion = normalizeCompletion(await handle.close())
    } catch {
      completion = { kind: 'failed', code: 'close_failed' }
    }
    attempt.connection = completion
    if (completion.kind === 'failed') attempt.cleanupFailed = true
    return completion
  }

  const settleCredentialOperation = (
    attempt: Attempt,
    operation: VtsCredentialOperation,
    succeeded: boolean,
  ): void => {
    if (operation === 'load') {
      attempt.pendingLoads -= 1
    } else {
      attempt.pendingSaves -= 1
      attempt.saveOutcome = succeeded ? 'settled' : 'rejected'
    }
    if (currentAttempt === attempt && attempt.finished && stateValue === 'blocked') {
      stateValue = classify(attempt)
    }
    notifySettled()
  }

  const trackLoad = (attempt: Attempt, promise: Promise<unknown>): void => {
    attempt.pendingLoads += 1
    promise.then(
      () => settleCredentialOperation(attempt, 'load', true),
      () => settleCredentialOperation(attempt, 'load', false),
    )
  }

  const attemptCredentials = (attempt: Attempt): VtsPairingCredentialProvider => ({
    load: (signal) => {
      const operation = recordCredentials.load(signal)
      trackLoad(attempt, operation)
      return operation
    },
    save: (value, signal) => {
      // Save admission is recorded before the delegated store effect so an
      // immediate cancellation snapshot cannot claim the store was not entered.
      attempt.pendingSaves += 1
      attempt.saveOutcome = 'pending'

      let operation: Promise<void>
      try {
        operation = recordCredentials.save(value, signal)
      } catch (error) {
        if (error instanceof VtsCredentialBusyError) {
          // Refused before any store effect: same-record exclusion is unchanged
          // and the save was never admitted.
          attempt.pendingSaves -= 1
          attempt.saveOutcome = 'not_admitted'
          throw error
        }
        // The store was entered and threw synchronously. The raw error stays
        // private to D2, which maps it to its own failure code.
        settleCredentialOperation(attempt, 'save', false)
        throw error
      }

      operation.then(
        () => settleCredentialOperation(attempt, 'save', true),
        () => settleCredentialOperation(attempt, 'save', false),
      )
      return operation
    },
  })

  const finish = (
    attempt: Attempt,
    stage: VtsAcquisitionStage,
    reason: VtsAcquireFailureReason,
    pairing: VtsPairingFailureCode | null,
  ): void => {
    if (attempt.finished) return
    attempt.finished = true
    attempt.connectSettled = true
    clearAcquisitionTimer(attempt)
    if (currentAttempt === attempt) stateValue = classify(attempt)
    settleOutcome(attempt, {
      kind: 'failed',
      stage: attempt.cause === null ? stage : causeStage(attempt.cause),
      reason: attempt.cause === null ? reason : causeReason(attempt.cause),
      cause: attempt.cause,
      pairing,
      cleanup: snapshot(attempt),
    })
    attempt.resolveDrained()
    notifySettled()
  }

  const finishWithoutEffect = (attempt: Attempt): void => {
    attempt.finished = true
    attempt.connectSettled = true
    clearAcquisitionTimer(attempt)
    if (currentAttempt === attempt) stateValue = classify(attempt)
    attempt.resolveDrained()
    notifySettled()
  }

  const execute = async (
    attempt: Attempt,
    connectPromise: Promise<VtsConnectionHandle | null>,
  ): Promise<void> => {
    try {
      let handle: VtsConnectionHandle | null = null
      try {
        handle = await connectPromise
      } catch {
        handle = null
      }

      if (handle === null) {
        finish(attempt, 'connect', 'connection_failed', null)
        return
      }

      // A handle returned after cancellation is stale and still M5-owned.
      if (attempt.cause !== null) {
        attempt.lateHandle = 'pending'
        const completion = await closeOwned(attempt, handle)
        attempt.lateHandle = completion.kind === 'closed' ? 'closed' : 'failed'
        finish(attempt, 'connect', 'connection_failed', null)
        return
      }

      attempt.handle = handle
      attempt.pairingCleanup = 'pending'

      let pairing: VtsPairingResult
      try {
        pairing = await pairVtsConnection({
          handle,
          identity,
          credentials: attemptCredentials(attempt),
          signal: attempt.signal,
          mode,
          requestTimeoutMs,
          humanApprovalTimeoutMs,
        })
      } catch {
        // D2 rejects before taking ownership only for invalid programming
        // options; the caller-provided handle is still M5-owned.
        attempt.pairingCleanup = 'not_started'
        await closeOwned(attempt, handle)
        finish(attempt, 'pairing', 'pairing_failed', null)
        return
      }

      if (pairing.kind === 'failed') {
        attempt.pairing = pairing.code
        attempt.connection = pairing.cleanup.connection
        attempt.pairingCleanup = pairing.cleanup.pairingSubscription
        if (
          pairing.cleanup.connection.kind === 'failed' ||
          pairing.cleanup.pairingSubscription === 'release_failed'
        ) {
          attempt.cleanupFailed = true
        }
        finish(attempt, 'pairing', 'pairing_failed', pairing.code)
        return
      }

      // D2 authenticated and released only its pairing subscription. Recheck
      // the current attempt and an already-observed closure before accepting.
      attempt.pairing = null
      attempt.pairingCleanup = 'released'
      let connectionCompleted = false
      const observeConnection = (): void => {
        connectionCompleted = true
      }
      try {
        handle.closed.then(observeConnection, observeConnection)
      } catch {
        connectionCompleted = true
      }
      await Promise.resolve()

      if (connectionCompleted || attempt.cause !== null || currentAttempt !== attempt) {
        await closeOwned(attempt, handle)
        finish(attempt, 'handoff', 'handoff_rejected', null)
        return
      }

      attempt.accepted = true
      attempt.finished = true
      clearAcquisitionTimer(attempt)
      readyHandle = handle
      stateValue = 'ready'
      settleOutcome(attempt, { kind: 'acquired', handle })
      attempt.resolveDrained()
      notifySettled()
    } catch {
      if (attempt.accepted || attempt.finished) return
      if (attempt.handle !== null) {
        await closeOwned(attempt, attempt.handle)
      }
      finish(attempt, 'pairing', 'pairing_failed', null)
    }
  }

  const acquire = async (ownerSignal?: AbortSignal): Promise<VtsAcquireResult> => {
    // Admission stays closed until a release continuation has finished, so it
    // cannot clear a successor that started in the same microtask window.
    if (pendingRelease !== null) return { kind: 'refused', reason: 'busy' }
    if (stateValue === 'acquiring' || stateValue === 'stopping') {
      return { kind: 'refused', reason: 'busy' }
    }
    if (stateValue === 'blocked') return { kind: 'refused', reason: 'blocked' }
    if (stateValue === 'quarantined') return { kind: 'refused', reason: 'quarantined' }
    if (stateValue === 'ready') return { kind: 'refused', reason: 'already_acquired' }

    if (ownerSignal !== undefined && !isValidSignal(ownerSignal)) {
      throw new Error(INVALID_SIGNAL_MESSAGE)
    }
    if (ownerSignal !== undefined && ownerSignal.aborted) {
      return {
        kind: 'failed',
        stage: 'cancelled',
        reason: 'cancelled',
        cause: 'owner',
        pairing: null,
        cleanup: emptyCleanup(),
      }
    }

    const attempt = createAttempt(ownerSignal ?? null)
    currentAttempt = attempt
    stateValue = 'acquiring'
    attempt.timer = setTimeout(() => {
      abortAttempt(attempt, 'deadline')
    }, acquisitionTimeoutMs)

    if (ownerSignal !== undefined) {
      const onAbort = (): void => {
        abortAttempt(attempt, 'owner')
      }
      attempt.ownerSignal = ownerSignal
      attempt.onOwnerAbort = onAbort
      try {
        ownerSignal.addEventListener('abort', onAbort, { once: true })
      } catch {
        abortAttempt(attempt, 'owner')
      }
      if (ownerSignal.aborted) abortAttempt(attempt, 'owner')
    }

    if (attempt.cause !== null) {
      finishWithoutEffect(attempt)
      return attempt.outcome
    }

    const connectPromise = Promise.resolve().then(() => {
      // A synchronous owner abort or release can win after acquire returns but
      // before this microtask. Never start external connection work once the
      // attempt is cancelled or no longer current.
      if (attempt.cause !== null || currentAttempt !== attempt) return null
      attempt.connectStarted = true
      return connect(attempt.signal)
    })
    connectPromise.then(
      () => {
        attempt.connectSettled = true
      },
      () => {
        attempt.connectSettled = true
      },
    )
    void execute(attempt, connectPromise)
    return attempt.outcome
  }

  const performRelease = async (): Promise<VtsAcquisitionReleaseResult> => {
    if (stateValue === 'quarantined') return 'quarantined'

    const attempt = currentAttempt
    if (stateValue === 'ready' && attempt !== null) {
      stateValue = 'stopping'
      notifySettled()
      const handle = readyHandle
      readyHandle = null
      const completion =
        handle === null
          ? ({ kind: 'closed' } as VtsConnectionCompletion)
          : await closeOwned(attempt, handle)
      attempt.finished = true
      if (currentAttempt === attempt) {
        currentAttempt = null
        stateValue = completion.kind === 'closed' ? 'stopped' : 'quarantined'
      }
      notifySettled()
      return stateValue === 'stopped' ? 'stopped' : 'quarantined'
    }

    if (stateValue === 'acquiring' && attempt !== null) {
      stateValue = 'stopping'
      notifySettled()
      abortAttempt(attempt, 'released')
      if (!attempt.connectStarted) {
        // The connector was never invoked, so cancellation is complete: no
        // external work is outstanding and admission can reopen.
        finishWithoutEffect(attempt)
        return 'stopped'
      }
      // An unsettled connector is the late-handle owner: replacement stays
      // blocked and the attempt's own background work closes any late result.
      if (!attempt.connectSettled) {
        stateValue = 'blocked'
        notifySettled()
        return 'blocked'
      }
      await attempt.drained
      if (currentAttempt !== attempt) {
        // The attempt was already superseded; never clear the newer owner.
        return currentState() === 'quarantined' ? 'quarantined' : 'stopped'
      }
      if (attempt.cleanupFailed) {
        stateValue = 'quarantined'
        notifySettled()
        return 'quarantined'
      }
      if (hasOutstanding(attempt)) {
        stateValue = 'blocked'
        notifySettled()
        return 'blocked'
      }
      currentAttempt = null
      stateValue = 'stopped'
      notifySettled()
      return 'stopped'
    }

    if (stateValue === 'blocked' || stateValue === 'stopping') return 'blocked'

    if (currentAttempt === attempt) currentAttempt = null
    stateValue = 'stopped'
    notifySettled()
    return 'stopped'
  }

  const release = (): Promise<VtsAcquisitionReleaseResult> => {
    if (pendingRelease !== null) return pendingRelease
    const running = performRelease()
    pendingRelease = running
    const clear = (): void => {
      if (pendingRelease === running) pendingRelease = null
    }
    running.then(clear, clear)
    return running
  }

  return {
    acquire,
    release,
    state: () => stateValue,
    whenSettled: () => {
      if (isQuiet()) return Promise.resolve()
      return new Promise<void>((resolve) => {
        settledWaiters.push(resolve)
      })
    },
  }
}
