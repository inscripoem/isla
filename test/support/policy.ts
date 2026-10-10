import type {
  ClockPort,
  Deadline,
  DeliveryClassification,
  ErrorCode,
  InputEvent,
  Modality,
  ReceiptStage,
  ReplyIntent,
} from '../../src/contracts'

/**
 * Fixture-side simulation of policy owned by M5 (epoch/freshness, fallback,
 * receipt reconciliation) and M4 (delivery classification). Production
 * implementations live in their modules; these helpers exist so tests can
 * assert observable contract behavior without importing product code.
 */

export function nextEpoch(epoch: number): number {
  return epoch + 1
}

export function epochIsStale(activeEpoch: number, candidateEpoch: number): boolean {
  return candidateEpoch !== activeEpoch
}

export function isDeadlineExpired(clock: ClockPort, deadline: Deadline): boolean {
  return clock.nowMs() >= deadline.atMs
}

export function deadlineRemainingMs(clock: ClockPort, deadline: Deadline): number {
  return deadline.atMs - clock.nowMs()
}

export interface ReceiptFact {
  receiptId: string
  outputId: string
  modality: Modality
  stage: ReceiptStage
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
 * Deterministic receipt reconciliation. A confirmed terminal fact is never
 * overwritten by a contradictory claim; stage regressions are ignored; a
 * conflicting claim under the same receipt id is a conflict; and an `unknown`
 * stage may be resolved upward by concrete evidence.
 */
export function reconcileReceipt(
  current: ReceiptFact | null,
  incoming: ReceiptFact,
): Reconciliation {
  if (current === null) {
    return { action: 'record', effective: incoming, note: 'first observation' }
  }
  if (current.receiptId === incoming.receiptId) {
    return current.stage === incoming.stage
      ? { action: 'ignore-duplicate', effective: current, note: 'duplicate receipt id and stage' }
      : { action: 'conflict', effective: current, note: 'same receipt id with a contradictory stage' }
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
 * Conservative delivery classification. Audio that started and was then
 * cancelled or failed is partial-unknown, not automatically not-delivered.
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

export interface FreshnessCheck {
  sessionId: string
  epoch: number
  deadline: Deadline
  snapshotRevision?: number
  capabilityRevision?: number
}

export interface ActiveRuntimeState {
  sessionId: string
  epoch: number
  running: boolean
  snapshotRevision: number
  capabilityRevision: number
}

export interface FreshnessOutcome {
  fresh: boolean
  reason?: ErrorCode
}

/** A late result may authorize work only while session, revisions and deadline remain valid. */
export function checkResultFreshness(
  state: ActiveRuntimeState,
  check: FreshnessCheck,
  clock: ClockPort,
): FreshnessOutcome {
  if (!state.running) return { fresh: false, reason: 'stale' }
  if (state.sessionId !== check.sessionId) return { fresh: false, reason: 'stale' }
  if (epochIsStale(state.epoch, check.epoch)) return { fresh: false, reason: 'stale' }
  if (check.snapshotRevision !== undefined && state.snapshotRevision !== check.snapshotRevision) {
    return { fresh: false, reason: 'stale' }
  }
  if (
    check.capabilityRevision !== undefined &&
    state.capabilityRevision !== check.capabilityRevision
  ) {
    return { fresh: false, reason: 'stale' }
  }
  if (isDeadlineExpired(clock, check.deadline)) {
    return { fresh: false, reason: 'deadline_exceeded' }
  }
  return { fresh: true }
}

/**
 * M5-authorized fallback: the deterministic oldest still-eligible candidate
 * with the `answer` intent. Returns null when no candidate is eligible. This is
 * not polling and not a model/provider retry.
 */
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
