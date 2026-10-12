import type {
  ClockPort,
  Deadline,
  DeliveryClassification,
  InputEvent,
  Modality,
  PerformanceReceipt,
  ReceiptStage,
  ReplyIntent,
} from '../contracts'

/**
 * Production M5 policy: epoch/freshness, deterministic fallback, receipt
 * reconciliation and conservative audio delivery classification. The test
 * fixture keeps an independent copy of this behavior as a reference example.
 */

export function nextEpoch(epoch: number): number {
  return epoch + 1
}

export function isDeadlineExpired(clock: ClockPort, deadline: Deadline): boolean {
  return clock.nowMs() >= deadline.atMs
}

export interface ReceiptFact {
  receiptId: string
  outputId: string
  modality: Modality
  stage: ReceiptStage
  /**
   * Canonical serialization of every immutable receipt field. Receipt-id reuse
   * must match this fingerprint exactly; any changed field is a conflict.
   */
  fingerprint: string
}

/**
 * Builds a stable fingerprint of a receipt's immutable identity. Field order is
 * fixed explicitly so structurally equal receipts always hash equally.
 */
export function receiptFingerprint(receipt: PerformanceReceipt): string {
  return JSON.stringify([
    receipt.receiptId,
    receipt.outputId,
    receipt.sessionId,
    receipt.epoch,
    receipt.turnId,
    receipt.segmentId,
    receipt.modality,
    receipt.stage,
    receipt.localTimeMs,
    receipt.chunkIds,
    receipt.reasonCode,
    receipt.source,
  ])
}

export type ReconciliationAction =
  | 'record'
  | 'ignore-duplicate'
  | 'ignore-regression'
  | 'resolve-unknown'
  | 'conflict'

export interface Reconciliation {
  action: ReconciliationAction
  effective: ReceiptFact
  note: string
}

const TERMINAL_STAGES: readonly ReceiptStage[] = ['completed', 'cancelled', 'failed']

const STAGE_ORDER: Record<ReceiptStage, number> = {
  unknown: 0,
  accepted: 1,
  started: 2,
  completed: 3,
  cancelled: 3,
  failed: 3,
}

export function isTerminalReceiptStage(stage: ReceiptStage): boolean {
  return TERMINAL_STAGES.includes(stage)
}

/**
 * A confirmed terminal fact is never overwritten by a contradictory claim;
 * stage regressions are ignored; a conflicting claim under the same receipt id
 * is a conflict; an `unknown` stage may be resolved upward by concrete
 * evidence.
 */
export function reconcileReceipt(
  current: ReceiptFact | null,
  incoming: ReceiptFact,
): Reconciliation {
  if (current === null) {
    return { action: 'record', effective: incoming, note: 'first observation' }
  }
  if (current.receiptId === incoming.receiptId) {
    return current.fingerprint === incoming.fingerprint
      ? { action: 'ignore-duplicate', effective: current, note: 'duplicate receipt id and identity' }
      : { action: 'conflict', effective: current, note: 'same receipt id with changed immutable fields' }
  }
  if (current.stage === 'unknown') {
    return isTerminalReceiptStage(incoming.stage)
      ? { action: 'resolve-unknown', effective: incoming, note: 'evidence resolves unknown' }
      : { action: 'record', effective: incoming, note: 'updated unknown observation' }
  }
  if (isTerminalReceiptStage(current.stage)) {
    if (isTerminalReceiptStage(incoming.stage) && current.stage !== incoming.stage) {
      return {
        action: 'conflict',
        effective: current,
        note: 'contradictory terminal claim cannot overwrite confirmed fact',
      }
    }
    return {
      action: 'ignore-regression',
      effective: current,
      note: 'non-terminal or duplicate claim cannot downgrade a confirmed fact',
    }
  }
  if (STAGE_ORDER[incoming.stage] < STAGE_ORDER[current.stage]) {
    return { action: 'ignore-regression', effective: current, note: 'receipt stage regressed' }
  }
  return { action: 'record', effective: incoming, note: 'advanced observation' }
}

/**
 * Conservative classification: audio that started and was then cancelled or
 * failed is partial-unknown, not automatically not-delivered.
 */
export function classifyAudioDelivery(
  stage: ReceiptStage | null,
  audioStarted: boolean,
): DeliveryClassification {
  if (stage === 'completed') return 'fully-delivered'
  if (stage === 'failed' || stage === 'cancelled') {
    return audioStarted ? 'partial-unknown' : 'not-delivered'
  }
  return 'partial-unknown'
}

export interface FallbackSelection {
  eventId: string
  replyIntent: ReplyIntent
}

export function selectFallback(
  candidates: readonly InputEvent[],
  clock: ClockPort,
): FallbackSelection | null {
  const eligible = [...candidates]
    .filter((candidate) => candidate.expiresAtMs > clock.nowMs())
    .sort((a, b) => a.receivedAtMs - b.receivedAtMs)
  const oldest = eligible[0]
  return oldest === undefined ? null : { eventId: oldest.eventId, replyIntent: 'answer' }
}
