import type { DialogueEndStatus } from '../contracts'
import type { DialogueOutcomeReport } from '../dialogue/dialogue-port'

/**
 * M5's safely projected view of M4's per-call generation/discard accounting.
 *
 * The raw `DialogueOutcomeReport` is a diagnostic object owned by M4 whose
 * `discards` field is an arbitrary `string -> number` record. This module
 * validates one report and rebuilds a fresh, frozen observation that carries only
 * allow-listed fields, so an M5 consumer (composition, production, evaluation)
 * can read the accounting without admitting arbitrary reason keys or extra text
 * fields into its own records.
 *
 * This is an observational channel and adds no storage write of its own: M5
 * already owns the runtime's persistence and delivery decisions, and M6 owns the
 * storage infrastructure. The projection is never a provider attempt and never
 * enters spoken history or the dialogue context.
 */

/**
 * The reason keys M5 understands today. Any other (still numeric) key is folded
 * into `unclassified` so the reason counts keep summing to `discarded` without
 * leaking a producer-chosen label.
 */
export const KNOWN_DISCARD_REASONS = [
  'aborted',
  'deadline',
  'no-speech',
  'leftover',
  'overflow',
  'sink-uncertain',
] as const

export type KnownDiscardReason = (typeof KNOWN_DISCARD_REASONS)[number]

/** Fixed M5 label for reason counts whose producer key is not known to M5. */
export const UNCLASSIFIED_DISCARD_REASON = 'unclassified'

const KNOWN_DISCARD_REASON_SET: ReadonlySet<string> = new Set(KNOWN_DISCARD_REASONS)

const DIALOGUE_END_STATUSES: readonly DialogueEndStatus[] = [
  'completed',
  'cancelled',
  'failed',
  'deadline_exceeded',
]

const USAGE_STATUSES = ['ok', 'failed', 'timeout', 'cancelled'] as const

export type DialogueOutcomeUsageStatus = (typeof USAGE_STATUSES)[number]

/**
 * A validated, redacted projection of one `DialogueOutcomeReport`. The identity
 * fields are copied verbatim from the report, so a report that arrives for an
 * earlier request still carries that request's own session/epoch/turn identity.
 *
 * The observation is frozen: a consumer that attempts to mutate it in place
 * cannot corrupt the collected diagnostics of another consumer, and the mutation
 * attempt is contained at the same boundary that isolates an observer fault.
 */
export interface DialogueOutcomeObservation {
  readonly requestId: string
  readonly sessionId: string
  readonly epoch: number
  readonly turnId: string
  /** Candidates the text source produced for the call. */
  readonly generated: number
  /** Sink writes that fulfilled. This is not playback evidence. */
  readonly emitted: number
  /** `generated - emitted`; candidates without a fulfilled sink write. */
  readonly discarded: number
  /**
   * Reason counts summing to `discarded`. A producer reason key unknown to M5 is
   * folded into `unclassified`; no producer-chosen key crosses this boundary.
   */
  readonly discards: Readonly<Record<string, number>>
  readonly endStatus: DialogueEndStatus
  readonly usageStatus: DialogueOutcomeUsageStatus
}

/**
 * One projected event. `refused` carries an M5-authored reason; it never embeds a
 * producer-provided value, so a malformed report cannot leak its content.
 */
export type DialogueOutcomeEvent =
  | { readonly kind: 'observed'; readonly observation: DialogueOutcomeObservation }
  | { readonly kind: 'refused'; readonly reason: string }

function refused(reason: string): DialogueOutcomeEvent {
  return Object.freeze({ kind: 'refused', reason })
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Validate and project one raw M4 report. A report that is structurally
 * inconsistent with its own accounting is refused rather than repaired, so M5
 * never fabricates a total. Returns `{ kind: 'observed' }` with a fresh object
 * (extra fields dropped, reason keys allow-listed) or `{ kind: 'refused' }`.
 */
export function projectDialogueOutcome(report: DialogueOutcomeReport): DialogueOutcomeEvent {
  if (report === null || typeof report !== 'object') {
    return refused('outcome report is not an object')
  }
  const requestId: unknown = report.requestId
  const sessionId: unknown = report.sessionId
  const epoch: unknown = report.epoch
  const turnId: unknown = report.turnId
  if (!isNonEmptyString(requestId)) return refused('outcome requestId is not a non-empty string')
  if (!isNonEmptyString(sessionId)) return refused('outcome sessionId is not a non-empty string')
  if (!isNonEmptyString(turnId)) return refused('outcome turnId is not a non-empty string')
  if (!isSafeCount(epoch)) return refused('outcome epoch is not a safe non-negative integer')

  const generated: unknown = report.generated
  const emitted: unknown = report.emitted
  const discarded: unknown = report.discarded
  if (!isSafeCount(generated)) return refused('outcome generated is not a safe non-negative integer')
  if (!isSafeCount(emitted)) return refused('outcome emitted is not a safe non-negative integer')
  if (!isSafeCount(discarded))
    return refused('outcome discarded is not a safe non-negative integer')
  if (emitted > generated) return refused('outcome emitted exceeds generated')
  if (discarded !== generated - emitted) {
    return refused('outcome discarded does not equal generated minus emitted')
  }

  const rawDiscards: unknown = report.discards
  if (rawDiscards === null || typeof rawDiscards !== 'object' || Array.isArray(rawDiscards)) {
    return refused('outcome discards is not a reason-count record')
  }
  const discards: Record<string, number> = {}
  let reasonTotal = 0
  for (const [key, value] of Object.entries(rawDiscards as Record<string, unknown>)) {
    if (!isSafeCount(value)) return refused('outcome discards carries a non-safe-integer count')
    if (value === 0) continue
    reasonTotal += value
    const folded = KNOWN_DISCARD_REASON_SET.has(key) ? key : UNCLASSIFIED_DISCARD_REASON
    discards[folded] = (discards[folded] ?? 0) + value
  }
  if (reasonTotal !== discarded) return refused('outcome discards do not sum to discarded')

  const endStatus: unknown = report.endStatus
  if (!DIALOGUE_END_STATUSES.includes(endStatus as DialogueEndStatus)) {
    return refused('outcome endStatus is not a known dialogue end status')
  }
  const usageStatus: unknown = report.usageStatus
  if (!(USAGE_STATUSES as readonly unknown[]).includes(usageStatus)) {
    return refused('outcome usageStatus is not a known usage status')
  }

  /*
   * Freeze the event and observation so a consumer that mutates what it was
   * handed cannot corrupt the same object held by another consumer's collected
   * diagnostics. `discards` is frozen too, so no reason key or count can be added.
   */
  const observation: DialogueOutcomeObservation = Object.freeze({
    requestId,
    sessionId,
    epoch,
    turnId,
    generated,
    emitted,
    discarded,
    discards: Object.freeze(discards),
    endStatus: endStatus as DialogueEndStatus,
    usageStatus: usageStatus as DialogueOutcomeUsageStatus,
  })
  return Object.freeze({ kind: 'observed', observation })
}

/**
 * The injected observational consumer shape used across the M5 composition,
 * production and evaluation boundaries. It receives a frozen, projected
 * `DialogueOutcomeEvent`; it adds no storage write of its own (M5 owns runtime
 * persistence and delivery decisions, M6 owns the storage infrastructure) and is
 * never a provider attempt.
 */
export type DialogueOutcomeObserver = (event: DialogueOutcomeEvent) => void
