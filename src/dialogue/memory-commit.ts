import { confirmedDeliverySchema } from '../contracts'
import type {
  CommitDelivery,
  ConfirmedDelivery,
  DeliveryClassification,
  DeliveryCommitAck,
} from '../contracts'
import type { MemoryEntry } from './context'
import { deliveryKey } from './delivery-key'
import { classifyMemoryBucket } from './memory-semantics'
import { personaKeyFromDelivery } from './persona'

/**
 * Delivery memory: generated text only becomes spoken history here.
 *
 * The division of authority is deliberate:
 *   - M4 decides whether generation ended (DialogueEnd).
 *   - M1 decides whether sound actually played (PerformanceReceipt).
 *   - M5 decides how a delivery is classified (CommitDelivery).
 *   - M4 only stores the result M5 delivered, and never upgrades a classification.
 *
 * Storing an undelivered segment as already spoken would make later replies
 * reference words the listener never heard, so the spoken projection below
 * accepts only `fully-delivered` records.
 *
 * Call order (settled in issue #22, option 2): M5 builds the `RuntimeEvent`,
 * allocates its session-scoped `seq` and calls M6's `commitDeliveryWithEvent`.
 * `commit` here is a LOCAL VIEW UPDATE and must only be invoked after that
 * atomic acknowledgement has succeeded. The ordering guarantee is persistence
 * before spoken-memory admission.
 *
 * This store is not a durability claim. It holds only what this process has
 * seen, so it must never be treated as the authoritative history source: see
 * `assembleDialogueContext` for the composition rule.
 */

type TerminalOutcome = CommitDelivery['terminalOutcome']

/**
 * Policy — the pairing of a classification with a terminal outcome (hard reject).
 *
 * The reason: the two fields describe one result. `fully-delivered` together with
 * `failed`, for example, is a caller error, and storing it would put a segment
 * that never played into spoken history.
 *
 * The module owner approved this as a rejection rule rather than a warning.
 *
 * To relax it, change only this file:
 *   1. Stop rejecting altogether: set `DELIVERY_PAIR_POLICY` to 'lenient' and
 *      `commit()` skips the check and stores whatever pair M5 supplied.
 *   2. Narrow or widen the rule: edit `ALLOWED_DELIVERY_PAIRS`. Pairs are defined
 *      only in that table.
 *   3. Downgrade to a logged warning: replace the early return in `commit()` with
 *      a conflict-like acknowledgement. A rejected pair must not reuse the
 *      'applied' status.
 *
 * Whatever changes, `commit-no-overwrite` must hold: a conflict never overwrites
 * an existing record, and a rejected pair is not stored at all.
 */
export type DeliveryPairPolicy = 'strict' | 'lenient'
export const DELIVERY_PAIR_POLICY: DeliveryPairPolicy = 'strict'

export const ALLOWED_DELIVERY_PAIRS: Readonly<
  Record<DeliveryClassification, readonly TerminalOutcome[]>
> = {
  'fully-delivered': ['completed'],
  /*
   * `failed` belongs in this row. Playback started and then failed, so the
   * audience did hear a fragment, which is exactly what `partial-unknown` means.
   * C6 permits the combination and M5 produces it; rejecting it would leave M6
   * holding a delivery M4 refused, degrading a session for a legitimate outcome.
   *
   * Accepting it does not weaken FR-02: admission still requires
   * `fully-delivered`, so the record stays audit-only either way.
   */
  'partial-unknown': ['cancelled', 'unknown', 'failed'],
  'not-delivered': ['failed', 'cancelled', 'unknown'],
}

export function isAllowedDeliveryPair(
  classification: DeliveryClassification,
  terminalOutcome: TerminalOutcome,
): boolean {
  return ALLOWED_DELIVERY_PAIRS[classification].includes(terminalOutcome)
}

/**
 * A stored delivery plus the persona attribution M4 keeps beside it.
 *
 * Attribution is derived only from the delivery's own persisted
 * `personaProfileId`/`personaProfileVersion` (see `personaKeyFromDelivery`). A
 * partial or absent pair is unknown and remains unknown: it is never inferred
 * from turn identity, a local note or any other process-local state. `null`
 * means unknown, and trimming then treats the record as current rather than
 * stale.
 */
export interface StoredDelivery {
  delivery: CommitDelivery
  personaVersion: string | null
  /** Arrival order, kept only so the audit view is stable. */
  seq: number
}

export interface DeliveryMemoryStore {
  /** Store one delivery. Idempotent; a contradictory input is never applied. */
  commit(delivery: CommitDelivery): Promise<DeliveryCommitAck>
  /** Spoken history only: the records that passed admission. */
  confirmedHistory(sessionId: string): Promise<ConfirmedDelivery[]>
  /** Full audit view, including partial deliveries and records never delivered. */
  records(): readonly CommitDelivery[]
  /** Audit view with persona attribution; an input to context assembly. */
  audit(): readonly StoredDelivery[]
  /** Confirmed records with persona attribution, for `MemoryEntrySource`. */
  memoryEntries(sessionId: string): Promise<readonly MemoryEntry[]>
}

/**
 * Isolation boundary — records are copied on the way in and on the way out.
 *
 * Without it a caller holds a reference to committed state, so mutating a
 * delivery object after commit would silently rewrite history, including
 * promoting a never-confirmed delivery into spoken history. The store is the only
 * thing allowed to decide what a record means, so nothing outside it may retain a
 * handle on one.
 */
function isolate(delivery: CommitDelivery): CommitDelivery {
  return structuredClone(delivery)
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
    // Persisted projection of the coordinated attribution: the original segment
    // index and the generating persona. Unknown legacy values stay explicit null.
    segmentIndex: delivery.segmentIndex,
    personaProfileId: delivery.personaProfileId,
    personaProfileVersion: delivery.personaProfileVersion,
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
  const stored = new Map<string, StoredDelivery>()
  let seq = 0

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

      const key = deliveryKey(delivery)
      const existing = stored.get(key)

      if (existing === undefined) {
        stored.set(key, {
          delivery: Object.freeze(isolate(delivery)),
          // Attribution comes only from the delivery's own persisted fields. A
          // partial or absent pair stays unknown (null): it is never inferred
          // from turn identity, a local note or any other process-local state.
          personaVersion: personaKeyFromDelivery(delivery),
          seq: seq++,
        })
        return {
          status: 'applied',
          effectiveClassification: delivery.classification,
          recordId: key,
        }
      }

      /*
       * A changed text hash, segment index or persona attribution means the
       * immutable identity moved under a stable delivery key. That breaks
       * immutability, so it is reported as a conflict rather than applied as an
       * update - the same rule M6 enforces at the storage boundary.
       */
      if (
        existing.delivery.textHash !== delivery.textHash ||
        existing.delivery.segmentIndex !== delivery.segmentIndex ||
        existing.delivery.personaProfileId !== delivery.personaProfileId ||
        existing.delivery.personaProfileVersion !== delivery.personaProfileVersion
      ) {
        return conflictAck(existing.delivery, delivery, key)
      }

      if (existing.delivery.classification === delivery.classification) {
        return {
          status: 'duplicate',
          effectiveClassification: existing.delivery.classification,
          recordId: key,
        }
      }

      return conflictAck(existing.delivery, delivery, key)
    },

    async confirmedHistory(sessionId) {
      /*
       * Ordered by arrival sequence within the session — the local analogue of
       * M6's guarantee that persisted history returns in supporting-event `seq`
       * order. Context assembly reads the tail as the most recent turns, so the
       * order is part of the contract rather than an implementation accident.
       *
       * `seq` is session-scoped: it orders records within one session and must
       * never be compared across sessions.
       */
      return [...stored.values()]
        .filter((entry) => entry.delivery.sessionId === sessionId)
        .sort((left, right) => left.seq - right.seq)
        .filter(
          (entry) => classifyMemoryBucket(toConfirmedDelivery(entry.delivery)).bucket === 'spoken',
        )
        .map((entry) => toConfirmedDelivery(entry.delivery))
    },

    records() {
      return [...stored.values()].map((entry) => isolate(entry.delivery))
    },

    audit() {
      return [...stored.values()]
        .sort((left, right) => left.seq - right.seq)
        .map((entry) => ({
          delivery: isolate(entry.delivery),
          personaVersion: entry.personaVersion,
          seq: entry.seq,
        }))
    },

    async memoryEntries(sessionId) {
      return [...stored.values()]
        .filter((entry) => entry.delivery.sessionId === sessionId)
        .sort((left, right) => left.seq - right.seq)
        .map((entry) => ({
          delivery: toConfirmedDelivery(entry.delivery),
          personaVersion: entry.personaVersion,
        }))
    },
  }
}
