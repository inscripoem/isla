import { confirmedDeliverySchema } from '../contracts'
import type {
  CommitDelivery,
  ConfirmedDelivery,
  DeliveryClassification,
  DeliveryCommitAck,
} from '../contracts'

/**
 * Delivery memory: the only place where generated text becomes spoken history.
 *
 * The authority split is deliberate:
 *   - M4 decides whether generation finished (DialogueEnd).
 *   - M1 decides whether sound actually played (PerformanceReceipt).
 *   - M5 decides how a delivery is classified (CommitDelivery).
 *   - M4 only files what M5 hands over, and never upgrades a classification.
 *
 * Storing a non-delivered segment as spoken would make every later reply
 * reference words the audience never heard, so the spoken projection below
 * admits `fully-delivered` records only.
 */

type TerminalOutcome = CommitDelivery['terminalOutcome']

/**
 * POLICY — classification / terminalOutcome pairing (hard reject).
 *
 * Why: the two fields must describe the same outcome. A pair such as
 * `fully-delivered` + `failed` is a caller bug, and filing it would put a
 * segment that never played into spoken history.
 *
 * Approved by the M4 owner as a rejecting rule, not a warning.
 *
 * HOW TO RELAX LATER — single point of change:
 *   1. Stop rejecting entirely: set `DELIVERY_PAIR_POLICY` to 'lenient'.
 *      `commit()` then skips this check and files whatever M5 supplied.
 *   2. Narrow or widen the rule: edit `ALLOWED_DELIVERY_PAIRS`. That table is
 *      the only place where pairings are defined; nothing else encodes them.
 *   3. Downgrade to a recorded warning: replace the early return in `commit()`
 *      with a conflict-style acknowledgement. Do not reuse the 'applied'
 *      status for a pair that was rejected.
 *
 * Whatever changes here must preserve `commit-no-overwrite`: a conflict never
 * overwrites an existing record, and a rejected pair is never stored at all.
 */
export type DeliveryPairPolicy = 'strict' | 'lenient'
export const DELIVERY_PAIR_POLICY: DeliveryPairPolicy = 'strict'

export const ALLOWED_DELIVERY_PAIRS: Readonly<
  Record<DeliveryClassification, readonly TerminalOutcome[]>
> = {
  'fully-delivered': ['completed'],
  'partial-unknown': ['cancelled', 'unknown'],
  'not-delivered': ['failed', 'cancelled', 'unknown'],
}

export function isAllowedDeliveryPair(
  classification: DeliveryClassification,
  terminalOutcome: TerminalOutcome,
): boolean {
  return ALLOWED_DELIVERY_PAIRS[classification].includes(terminalOutcome)
}

export interface DeliveryMemoryStore {
  /** Files one delivery. Idempotent; contradictory input is never applied. */
  commit(delivery: CommitDelivery): Promise<DeliveryCommitAck>
  /** Spoken history only: fully-delivered records with non-empty text. */
  confirmedHistory(sessionId: string): Promise<ConfirmedDelivery[]>
  /** Full audit view, including partial and never-delivered records. */
  records(): readonly CommitDelivery[]
}

function deliveryRecordKey(delivery: CommitDelivery): string {
  return `${delivery.turnId}:${delivery.segmentId}:${delivery.modality}`
}

function toConfirmedDelivery(delivery: CommitDelivery): ConfirmedDelivery {
  return confirmedDeliverySchema.parse({
    sessionId: delivery.sessionId,
    turnId: delivery.turnId,
    segmentId: delivery.segmentId,
    textHash: delivery.textHash,
    text: delivery.text,
    outputId: delivery.outputId,
    receiptId: delivery.receiptId,
    classification: delivery.classification,
    modality: delivery.modality,
  })
}

function conflictAck(
  existing: CommitDelivery,
  incoming: CommitDelivery,
  key: string,
): DeliveryCommitAck {
  return {
    status: 'conflict',
    recordedClassification: existing.classification,
    incomingClassification: incoming.classification,
    conflictRecordId: `${key}:conflict`,
  }
}

export function createDeliveryMemoryStore(): DeliveryMemoryStore {
  const stored = new Map<string, CommitDelivery>()

  return {
    async commit(delivery) {
      if (
        DELIVERY_PAIR_POLICY === 'strict' &&
        !isAllowedDeliveryPair(delivery.classification, delivery.terminalOutcome)
      ) {
        return {
          status: 'failed',
          reasonCode: 'invalid-delivery-pair',
          message:
            `classification ${delivery.classification} is inconsistent with ` +
            `terminal outcome ${delivery.terminalOutcome}`,
        }
      }

      const key = deliveryRecordKey(delivery)
      const existing = stored.get(key)

      if (existing === undefined) {
        stored.set(key, delivery)
        return {
          status: 'applied',
          effectiveClassification: delivery.classification,
          recordId: key,
        }
      }

      // A changed text hash means the finalized text moved under a stable
      // segment identity. That contradicts immutability, so it is a conflict
      // rather than an update.
      if (existing.textHash !== delivery.textHash) {
        return conflictAck(existing, delivery, key)
      }

      if (existing.classification === delivery.classification) {
        return {
          status: 'duplicate',
          effectiveClassification: existing.classification,
          recordId: key,
        }
      }

      return conflictAck(existing, delivery, key)
    },

    async confirmedHistory(sessionId) {
      return [...stored.values()]
        .filter(
          (delivery) =>
            delivery.sessionId === sessionId &&
            delivery.classification === 'fully-delivered' &&
            delivery.text.length > 0,
        )
        .map(toConfirmedDelivery)
    },

    records() {
      return [...stored.values()]
    },
  }
}
