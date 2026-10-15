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
  type PerformanceGrantMessage,
  type PerformanceOfferMessage,
  type PerformanceReadyMessage,
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

export interface PerformerTransport {
  send(message: PerformerBridgeMessage): boolean
  handleEvidence(message: PlayerMessage): Promise<void>
  makeMessageId(): string
  generation(): number
}

export type DeliveryOutcome = 'consumed' | 'forward' | 'rejected'

export interface PerformanceBridge {
  readonly player: PlayerPort
  bindTransport(transport: PerformerTransport): void
  handleReady(message: PerformanceReadyMessage): boolean
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
      if (!sent) settle(operation, makeReceipt(storedCommand, 'unknown', 'performer_unavailable'), false)
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
      operation.phase = 'granted'
      transport.send(performanceGrant(command, remainingMs, transport.makeMessageId()))
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
      unresolvedOutputId = null
      lastStage = 'unknown'
    },
  }
}
