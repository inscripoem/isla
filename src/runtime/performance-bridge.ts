import type {
  CallContext,
  ClockPort,
  PerformanceCancel,
  PerformanceCommand,
  PerformanceReceipt,
  PlayerMessage,
  PlayerPort,
  PlayerStatus,
  ReceiptStage,
  ServerMessage,
} from '../contracts'
import {
  performanceGrant,
  performanceOffer,
  playerStatusSchema,
  type PerformanceGrantMessage,
  type PerformanceOfferMessage,
  type PerformanceReadyMessage,
  type PerformanceStatusMessage,
} from '../contracts'
import type { DeadlineBinding } from '../performance/browser/types'
import type { RuntimeDeadlineGate } from './deadline'
import { receiptFingerprint } from './policy'

/**
 * Server-side audio bridge for the first interactive loop (M5 transport).
 *
 * Player-only: the reaction/avatar adapter is injected separately (the merged
 * M1 mapped renderer), so audio is never dispatched before the coordinator has
 * registered the output. The bridge implements the delayed-execution handshake
 * (offer → ready → grant) and correlates the real receipts that come back.
 *
 * Authority rules:
 * - `ws.send` is never playback completion; an operation settles only on an
 *   observed settling receipt or on explicit evidence produced here.
 * - An operation that was never granted (still `offered`) cannot have played, so
 *   a Stop/disconnect settles it as not-dispatched and the status stays idle.
 *   A granted operation is conservative: losing the connection cannot prove the
 *   media stopped, so it stays unknown/non-idle until correlated evidence.
 * - Evidence from a superseded connection generation, a wrong envelope, or a
 *   terminal claim before any grant is rejected, never forwarded as a valid
 *   fact for another connection.
 * - Terminal facts are retained by full fingerprint; contradictory claims never
 *   overwrite the first, while a correlated terminal may resolve an earlier
 *   `unknown`.
 * - Cancellation ownership is idempotent and bounded; a repeated cancel never
 *   strands an earlier waiter, and every waiter releases its timer/listener.
 */

export const PERFORMER_BRIDGE_SOURCE = 'm5-performer-bridge'

export type PerformerBridgeMessage =
  | ServerMessage
  | PerformanceOfferMessage
  | PerformanceGrantMessage

/**
 * Result of one transport send, distinguishing what the transport can prove.
 *
 * `sent` means the frame was handed to the socket. `unsent` means the transport
 * proved no dispatch (for example a closed socket or a rejected send buffer) so
 * no playback can have happened. `ambiguous` means the attempt failed without
 * proving whether the payload was buffered or partially written; the caller must
 * stay conservative rather than assume it was unsent.
 */
export type TransportSendResult = 'sent' | 'unsent' | 'ambiguous'

export interface PerformerTransport {
  send(message: PerformerBridgeMessage): TransportSendResult
  handleEvidence(message: PlayerMessage): Promise<void>
  makeMessageId(): string
  generation(): number
}

export type DeliveryOutcome = 'consumed' | 'forward' | 'rejected'

export interface PerformanceBridge {
  readonly player: PlayerPort
  bindTransport(transport: PerformerTransport): void
  handleReady(message: PerformanceReadyMessage): boolean
  /**
   * Accepts a correlated physical-status report from the bound performer. It is
   * separate from a delivery receipt: a receipt records the delivery fact while
   * this records whether local media is still physically occupied.
   */
  handlePhysicalStatus(message: PerformanceStatusMessage): boolean
  deliver(message: PlayerMessage): Promise<DeliveryOutcome>
  detach(reason: string): void
  dispose(): void
}

interface Operation {
  command: PerformanceCommand
  generation: number
  deadlineAtMs: number
  binding: DeadlineBinding
  phase: 'offered' | 'granted'
  settled: boolean
  settledReceipt: PerformanceReceipt | null
  promise: Promise<PerformanceReceipt>
  resolve: (receipt: PerformanceReceipt) => void
  onAbort: () => void
}

interface CancelWaiter {
  resolve: (receipt: PerformanceReceipt | null) => void
  cleanup: () => void
}

const MAX_TRACKED_OUTPUTS = 64
const MAX_CANCEL_WAITERS = 4

function settlingStage(stage: ReceiptStage): boolean {
  return stage === 'completed' || stage === 'cancelled' || stage === 'failed' || stage === 'unknown'
}

function sameCommandIdentity(left: PerformanceCommand, right: PerformanceCommand): boolean {
  return (
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

export function createPerformanceBridge(options: {
  sessionId: string
  gate: RuntimeDeadlineGate
  clock: ClockPort
}): PerformanceBridge {
  let transport: PerformerTransport | null = null
  let disposed = false

  const operations = new Map<string, Operation>()
  const terminalFacts = new Map<string, PerformanceReceipt>()
  const cancelWaiters = new Map<string, Set<CancelWaiter>>()
  let unresolvedOutputId: string | null = null
  let lastStage: ReceiptStage | null = null

  /**
   * The most recent dispatch this bridge authorized on the current connection
   * generation. A delivery terminal alone does not prove the media was
   * released, so physical admission stays blocked until a correlated physical
   * status for this grant reports idle.
   */
  let latestGranted: { outputId: string; epoch: number; generation: number } | null = null
  const physicalReports = new Map<string, { generation: number; epoch: number; status: PlayerStatus }>()

  const makeReceipt = (
    command: PerformanceCommand,
    stage: ReceiptStage,
    reasonCode: string | null,
  ): PerformanceReceipt => ({
    receiptId: `${PERFORMER_BRIDGE_SOURCE}-${command.outputId}-${stage}`,
    outputId: command.outputId,
    sessionId: command.sessionId,
    epoch: command.epoch,
    turnId: command.turnId,
    segmentId: command.segmentId,
    modality: 'audio',
    stage,
    localTimeMs: null,
    chunkIds: null,
    reasonCode,
    source: PERFORMER_BRIDGE_SOURCE,
  })

  const evict = (): void => {
    while (operations.size > MAX_TRACKED_OUTPUTS) {
      let removed = false
      for (const [key, value] of operations) {
        if (value.settled) {
          operations.delete(key)
          removed = true
          break
        }
      }
      if (!removed) break
    }
    while (terminalFacts.size > MAX_TRACKED_OUTPUTS) {
      const oldest = terminalFacts.keys().next().value
      if (oldest === undefined) break
      terminalFacts.delete(oldest)
    }
    while (physicalReports.size > MAX_TRACKED_OUTPUTS) {
      const oldest = physicalReports.keys().next().value
      if (oldest === undefined) break
      physicalReports.delete(oldest)
    }
  }

  /**
   * The trusted physical status for the most recent grant, or null when none is
   * proven. The report must belong to the grant's own connection generation and
   * match its identity/epoch. It is intentionally NOT invalidated by a later
   * connection generation: after a disconnect/rebind the last verified state is
   * preserved, so a clean release stays resolved while an unproven or occupied
   * state keeps physical uncertainty instead of silently manufacturing idle.
   */
  const trustedPhysicalStatus = (): PlayerStatus | null => {
    if (latestGranted === null) return null
    const report = physicalReports.get(latestGranted.outputId)
    if (report === undefined) return null
    if (report.generation !== latestGranted.generation) return null
    if (report.epoch !== latestGranted.epoch) return null
    return report.status
  }

  const settle = (operation: Operation, receipt: PerformanceReceipt, unresolved: boolean): void => {
    if (operation.settled) return
    operation.settled = true
    operation.settledReceipt = structuredClone(receipt)
    operation.binding.signal.removeEventListener('abort', operation.onAbort)
    operation.binding.release()
    operation.resolve(receipt)
    if (unresolved) unresolvedOutputId = operation.command.outputId
    evict()
  }

  const resolveCancel = (outputId: string, receipt: PerformanceReceipt | null): void => {
    const set = cancelWaiters.get(outputId)
    if (set === undefined) return
    cancelWaiters.delete(outputId)
    for (const waiter of set) {
      waiter.cleanup()
      waiter.resolve(receipt)
    }
  }

  const unsettledOperation = (): Operation | undefined => {
    for (const operation of operations.values()) {
      if (!operation.settled) return operation
    }
    return undefined
  }

  const player: PlayerPort = {
    execute(command: PerformanceCommand, context: CallContext): Promise<PerformanceReceipt> {
      if (disposed || transport === null) {
        return Promise.resolve(makeReceipt(command, 'unknown', 'performer_unavailable'))
      }
      const existing = operations.get(command.outputId)
      if (existing !== undefined) {
        // Full identity is always required. A changed command for an existing
        // output id is a conflict, never a replay of the old work, regardless of
        // whether the old operation settled.
        if (!sameCommandIdentity(existing.command, command)) {
          return Promise.resolve(makeReceipt(command, 'unknown', 'duplicate_identity_conflict'))
        }
        if (!existing.settled) return existing.promise
        const retained = terminalFacts.get(command.outputId)
        if (retained !== undefined) return Promise.resolve(structuredClone(retained))
        if (existing.settledReceipt !== null) {
          // A legitimate duplicate after an unknown/timeout returns the settled
          // outcome; it is never re-offered.
          return Promise.resolve(structuredClone(existing.settledReceipt))
        }
        return Promise.resolve(makeReceipt(command, 'unknown', 'duplicate_unresolved'))
      }
      // An unresolved authoritative playback blocks admission of a new output.
      if (unresolvedOutputId !== null) {
        return Promise.resolve(makeReceipt(command, 'unknown', 'unresolved_blocks_admission'))
      }
      if (unsettledOperation() !== undefined) {
        return Promise.resolve(makeReceipt(command, 'unknown', 'concurrent_dispatch'))
      }
      // Physical admission: a delivery terminal does not prove the previous
      // media was released. Block while the most recent grant has no trusted
      // idle status (a missing status can never manufacture idle).
      if (latestGranted !== null) {
        const physical = trustedPhysicalStatus()
        if (physical === null || !physical.idle) {
          return Promise.resolve(makeReceipt(command, 'unknown', 'unresolved_blocks_admission'))
        }
      }

      const storedCommand = structuredClone(command)
      const binding = options.gate.bind(context)
      const operation: Operation = {
        command: storedCommand,
        generation: transport.generation(),
        deadlineAtMs: context.deadline.atMs,
        binding,
        phase: 'offered',
        settled: false,
        settledReceipt: null,
        promise: Promise.resolve(makeReceipt(storedCommand, 'unknown', 'uninitialized')),
        resolve: () => {},
        onAbort: () => {},
      }
      operation.promise = new Promise<PerformanceReceipt>((resolve) => {
        operation.resolve = resolve
      })
      operation.onAbort = () => {
        // A never-granted operation cannot have played: settle as not-dispatched
        // so Stop/expiry does not wedge Resume. A granted one stays conservative.
        const granted = operation.phase === 'granted'
        settle(
          operation,
          makeReceipt(storedCommand, 'unknown', granted ? 'expired_or_revoked' : 'not_dispatched'),
          granted,
        )
      }
      binding.signal.addEventListener('abort', operation.onAbort, { once: true })
      operations.set(storedCommand.outputId, operation)
      lastStage = 'accepted'
      evict()
      if (binding.signal.aborted) {
        operation.onAbort()
        return operation.promise
      }
      const sent = transport.send(performanceOffer(storedCommand, transport.makeMessageId()))
      if (sent === 'unsent') {
        // Provably no dispatch: the offer cannot have been seen, so there is no
        // playback to reconcile and no physical occupancy.
        settle(operation, makeReceipt(storedCommand, 'unknown', 'performer_unavailable'), false)
      }
      return operation.promise
    },

    cancel(request: PerformanceCancel, context: CallContext): Promise<PerformanceReceipt | null> {
      if (disposed || transport === null) return Promise.resolve(null)
      transport.send({
        protocolVersion: '0.2',
        messageId: transport.makeMessageId(),
        sessionId: options.sessionId,
        epoch: request.newEpoch,
        kind: 'performance.cancel',
        payload: request,
      })
      const unsettled = unsettledOperation()
      const outputId = unsettled?.command.outputId ?? unresolvedOutputId
      if (outputId === null) return Promise.resolve(null)
      const operation = operations.get(outputId)
      if (operation === undefined) return Promise.resolve(null)
      if (operation.phase === 'offered' && !operation.settled) {
        // Never authorized; no local media to cancel and no evidence to wait for.
        settle(operation, makeReceipt(operation.command, 'unknown', 'not_dispatched'), false)
        return Promise.resolve(null)
      }
      const set = cancelWaiters.get(outputId) ?? new Set<CancelWaiter>()
      if (set.size >= MAX_CANCEL_WAITERS) return Promise.resolve(null)
      const binding = options.gate.bind(context)
      return new Promise<PerformanceReceipt | null>((resolve) => {
        let done = false
        const onAbort = (): void => {
          if (done) return
          done = true
          const current = cancelWaiters.get(outputId)
          current?.delete(waiter)
          if (current !== undefined && current.size === 0) cancelWaiters.delete(outputId)
          binding.release()
          resolve(null)
        }
        const waiter: CancelWaiter = {
          resolve: (receipt) => {
            if (done) return
            done = true
            resolve(receipt)
          },
          cleanup: () => {
            binding.release()
            binding.signal.removeEventListener('abort', onAbort)
          },
        }
        set.add(waiter)
        cancelWaiters.set(outputId, set)
        binding.signal.addEventListener('abort', onAbort, { once: true })
        if (binding.signal.aborted) onAbort()
      })
    },

    status(): PlayerStatus {
      const unresolved = unresolvedOutputId
      if (unresolved !== null) {
        return { idle: false, activeOutputId: unresolved, lastStage: 'unknown' }
      }
      const unsettled = unsettledOperation()
      if (unsettled !== undefined) {
        return { idle: false, activeOutputId: unsettled.command.outputId, lastStage }
      }
      // The delivery fact and the physical status are separate evidence. Only a
      // trusted, correlated physical status may clear physical occupancy; a
      // delivery terminal or a missing status never manufactures idle.
      const physical = trustedPhysicalStatus()
      if (physical !== null) {
        if (physical.idle) return { idle: true, activeOutputId: null, lastStage }
        return {
          idle: false,
          activeOutputId: physical.activeOutputId ?? latestGranted?.outputId ?? null,
          lastStage: physical.lastStage ?? lastStage,
        }
      }
      if (latestGranted !== null) {
        return { idle: false, activeOutputId: latestGranted.outputId, lastStage }
      }
      return { idle: true, activeOutputId: null, lastStage }
    },
  }

  return {
    player,

    bindTransport(next: PerformerTransport): void {
      transport = next
    },

    handleReady(message: PerformanceReadyMessage): boolean {
      if (disposed || transport === null) return true
      const outputId = message.payload.outputId
      const operation = operations.get(outputId)
      if (operation === undefined || operation.settled || operation.phase !== 'offered') return true
      const command = operation.command
      if (operation.generation !== transport.generation()) {
        // Superseded connection: no grant was ever sent, so no playback happened.
        settle(operation, makeReceipt(command, 'unknown', 'stale_connection'), false)
        return true
      }
      if (
        message.sessionId !== command.sessionId ||
        message.epoch !== command.epoch ||
        message.payload.turnId !== command.turnId ||
        message.payload.segmentId !== command.segmentId
      ) {
        settle(operation, makeReceipt(command, 'unknown', 'ready_identity_mismatch'), false)
        return true
      }
      const remainingMs = operation.deadlineAtMs - options.clock.nowMs()
      if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
        settle(operation, makeReceipt(command, 'unknown', 'expired_before_grant'), false)
        return true
      }
      const grantOutcome = transport.send(performanceGrant(command, remainingMs, transport.makeMessageId()))
      if (grantOutcome === 'unsent') {
        // The grant provably never reached the performer, so no playback can
        // have started: release the binding and settle as not-dispatched rather
        // than wedging Stop/Resume on a grant that was never delivered.
        settle(operation, makeReceipt(command, 'unknown', 'grant_unsent'), false)
        return true
      }
      // 'sent' and 'ambiguous' both authorize the operation. An ambiguous send
      // could not prove the grant was unsent, so it is conservatively treated as
      // possibly granted and stays physical-occupancy blocked until correlated
      // status evidence arrives.
      operation.phase = 'granted'
      latestGranted = {
        outputId: command.outputId,
        epoch: command.epoch,
        generation: transport.generation(),
      }
      return true
    },

    handlePhysicalStatus(message: PerformanceStatusMessage): boolean {
      if (disposed || transport === null) return false
      if (message.sessionId !== options.sessionId) return false
      const parsed = playerStatusSchema.safeParse(message.payload.status)
      if (!parsed.success) return false
      const status = parsed.data
      // A contradictory claim of idle with a named active output is not usable
      // evidence, matching the coordinator's defensive status read.
      if (status.idle && status.activeOutputId !== null) return false
      const outputId = message.payload.outputId
      const epoch = message.epoch
      const generation = transport.generation()
      // Full correlation: only a report for the output this bridge most recently
      // granted under this exact epoch and the *current* connection generation
      // is trusted. A status before any grant, a wrong-epoch/identity report, a
      // retained-terminal report from a superseded connection and any
      // post-rebind report about an old output are rejected rather than allowed
      // to manufacture idle.
      if (
        latestGranted === null ||
        latestGranted.outputId !== outputId ||
        latestGranted.epoch !== epoch ||
        latestGranted.generation !== generation
      ) {
        return false
      }
      // A non-idle report that names a different active output contradicts the
      // grant it claims to describe.
      if (!status.idle && status.activeOutputId !== null && status.activeOutputId !== outputId) {
        return false
      }
      physicalReports.set(outputId, { generation, epoch, status })
      return true
    },

    async deliver(message: PlayerMessage): Promise<DeliveryOutcome> {
      const receipt = message.payload
      const operation = operations.get(receipt.outputId)
      if (operation === undefined) {
        // Never dispatched by this bridge; the coordinator owns reconciliation.
        return 'forward'
      }
      if (operation.generation !== (transport?.generation() ?? -1)) {
        return 'rejected'
      }
      const command = operation.command
      if (
        command.sessionId !== receipt.sessionId ||
        command.epoch !== receipt.epoch ||
        command.turnId !== receipt.turnId ||
        command.segmentId !== receipt.segmentId
      ) {
        return 'rejected'
      }
      if (receipt.modality !== 'audio') return 'rejected'
      lastStage = receipt.stage
      if (!settlingStage(receipt.stage)) {
        // Intermediate evidence is recorded by the coordinator; not consumed.
        return operation.phase === 'offered' ? 'rejected' : 'forward'
      }
      if (operation.phase === 'offered') {
        // A settling claim before any grant is not credible evidence.
        return 'rejected'
      }

      const retained = terminalFacts.get(receipt.outputId)
      if (retained === undefined) {
        terminalFacts.set(receipt.outputId, structuredClone(receipt))
        const pending = !operation.settled
        if (pending) settle(operation, receipt, receipt.stage === 'unknown')
        if (unresolvedOutputId === receipt.outputId && receipt.stage !== 'unknown') {
          unresolvedOutputId = null
        }
        let consumed = pending
        if (cancelWaiters.has(receipt.outputId)) {
          resolveCancel(receipt.outputId, receipt)
          consumed = true
        }
        return consumed ? 'consumed' : 'forward'
      }
      if (receiptFingerprint(retained) === receiptFingerprint(receipt)) {
        if (cancelWaiters.has(receipt.outputId)) {
          resolveCancel(receipt.outputId, retained)
          return 'consumed'
        }
        return 'consumed'
      }
      if (retained.stage === 'unknown' && receipt.stage !== 'unknown') {
        // A correlated terminal may resolve an earlier explicit-unknown.
        terminalFacts.set(receipt.outputId, structuredClone(receipt))
        if (!operation.settled) settle(operation, receipt, false)
        if (unresolvedOutputId === receipt.outputId) unresolvedOutputId = null
        if (cancelWaiters.has(receipt.outputId)) {
          resolveCancel(receipt.outputId, receipt)
          return 'consumed'
        }
        return 'forward'
      }
      // Contradiction: keep the first retained fact; forward the claim.
      if (cancelWaiters.has(receipt.outputId)) resolveCancel(receipt.outputId, retained)
      return 'forward'
    },

    detach(reason: string): void {
      for (const operation of operations.values()) {
        if (operation.settled) continue
        const granted = operation.phase === 'granted'
        settle(operation, makeReceipt(operation.command, 'unknown', reason), granted)
      }
      for (const [outputId, set] of [...cancelWaiters]) {
        const operation = operations.get(outputId)
        const receipt =
          operation !== undefined
            ? makeReceipt(operation.command, 'unknown', reason)
            : null
        cancelWaiters.delete(outputId)
        for (const waiter of set) {
          waiter.cleanup()
          waiter.resolve(receipt)
        }
      }
      // Physical uncertainty survives the disconnect. The last grant and its
      // verified report are retained so that a completed/failed output with a
      // failed cleanup (or no report at all) stays non-idle after detach/rebind
      // instead of silently becoming idle once no operation is unsettled. A
      // genuinely clean disconnect (last report idle) is preserved as resolved.
      // A new connection cannot attest the old one's cleanup: its generation
      // differs, so `handlePhysicalStatus` rejects a report for the old output.
      lastStage = 'unknown'
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      for (const operation of operations.values()) {
        if (!operation.settled) {
          settle(operation, makeReceipt(operation.command, 'unknown', 'bridge_disposed'), false)
        }
      }
      for (const set of cancelWaiters.values()) {
        for (const waiter of set) {
          waiter.cleanup()
          waiter.resolve(null)
        }
      }
      cancelWaiters.clear()
      operations.clear()
      terminalFacts.clear()
      physicalReports.clear()
      latestGranted = null
      unresolvedOutputId = null
      lastStage = 'unknown'
    },
  }
}
