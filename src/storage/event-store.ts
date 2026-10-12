import {
  appendAckSchema,
  atomicCommitAckSchema,
  deliveryCommitAckSchema,
  type AppendAck,
  type AtomicCommitAck,
  type ConfirmedDelivery,
  type DeliveryCommitAck,
  type EventStorePort,
  type RuntimeEvent,
} from '../contracts'

/**
 * M6 storage — durable event store (C6/C7, FR-06).
 *
 * Purpose
 * -------
 * The single writer of committed framework events and delivery receipts. M5
 * assigns every event sequence number; M6 only acknowledges persistence. Other
 * modules call this store through the M6 ports and never write storage directly.
 *
 * Behaviour (mirrors test/support/correct-ports.ts)
 * -------------------------------------------------
 * append(event)
 *   - same eventId + identical content -> `duplicate`
 *   - same eventId + different content  -> `failed` (reasonCode `conflict`)
 *   - same session + same seq, different eventId -> `failed` (`conflict`)
 *   - otherwise -> `stored`
 * commitDeliveryWithEvent(delivery, event)
 *   - atomic: the receipt and its supporting event are persisted together or not
 *     at all (C-17). delivery key = sessionId:turnId:segmentId:modality.
 *   - no existing receipt -> `applied`; changed textHash -> `conflict`;
 *     same textHash + same classification -> `duplicate`;
 *     same textHash + different classification -> `conflict`.
 * readSession(sessionId) -> events for the session, `seq` strictly increasing.
 * exportJsonl(sessionId)  -> one JSON string per committed event, newline joined,
 *                            matching `readSession` exactly.
 *
 * Implementation decisions (see M6_KB daily log)
 * ----------------------------------------------
 * - E1/E2/E3: maps index events by `eventId`, session sequences by
 *   `sessionId:seq` and receipts by delivery key, so identity and conflict
 *   checks are O(1) rather than linear scans (fixture used linear search).
 * - E4/E5: per-session event buckets plus one `sessionEventsInOrder` helper
 *   shared by `readSession` and `exportJsonl`, so the two can never disagree.
 * - Fault-injection seam: optional `beforeAppend`/`beforeCommit` hooks let the
 *   conformance suite simulate a storage failure that maps to `failed` acks with
 *   no partial mutation. Production defaults to no hooks.
 * - Deferred (not yet applied): canonical (key-order-independent) equality,
 *   full copy-on-write atomicity and input schema validation at the boundary.
 *
 * Boundaries
 * ----------
 * - M6 never assigns authority or `seq`; it only validates uniqueness.
 * - Replay reads through `readSession`; it never mutates live state (C-12).
 */

/** Optional fault-injection hooks used by the conformance suite. */
export interface EventStoreOptions {
  /** Awaited before an append; throwing simulates a storage failure. */
  beforeAppend?: () => void | Promise<void>
  /** Awaited before an atomic commit; throwing simulates a storage failure. */
  beforeCommit?: () => void | Promise<void>
}

/** Concrete event store: the port plus a live confirmed-delivery view. */
export interface EventStore extends EventStorePort {
  /**
   * Live committed delivery records. `HistoryQueryPort` filters this list; the
   * reference stays valid as new deliveries are committed.
   */
  readonly deliveries: ConfirmedDelivery[]
}

function sameContent(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function deliveryKey(
  delivery: Pick<ConfirmedDelivery, 'sessionId' | 'turnId' | 'segmentId' | 'modality'>,
): string {
  return `${delivery.sessionId}:${delivery.turnId}:${delivery.segmentId}:${delivery.modality}`
}

export function createEventStore(options: EventStoreOptions = {}): EventStore {
  // E1: eventId -> committed event.
  const eventsById = new Map<string, RuntimeEvent>()
  // E2: `sessionId:seq` -> owning eventId (session sequence uniqueness).
  const seqOwner = new Map<string, string>()
  // E4: sessionId -> events for that session.
  const eventsBySession = new Map<string, RuntimeEvent[]>()
  // E3: deliveryKey -> committed delivery record.
  const deliveriesByKey = new Map<string, ConfirmedDelivery>()
  // Live view consumed by HistoryQueryPort.
  const deliveries: ConfirmedDelivery[] = []

  function persistEvent(event: RuntimeEvent): void {
    eventsById.set(event.eventId, event)
    seqOwner.set(`${event.sessionId}:${event.seq}`, event.eventId)
    const bucket = eventsBySession.get(event.sessionId)
    if (bucket === undefined) eventsBySession.set(event.sessionId, [event])
    else bucket.push(event)
  }

  // E4/E5: one ordered view shared by readSession and exportJsonl.
  function sessionEventsInOrder(sessionId: string): RuntimeEvent[] {
    const bucket = eventsBySession.get(sessionId)
    if (bucket === undefined) return []
    return [...bucket].sort((a, b) => a.seq - b.seq)
  }

  return {
    deliveries,

    async append(event): Promise<AppendAck> {
      try {
        if (options.beforeAppend !== undefined) await options.beforeAppend()
      } catch {
        return appendAckSchema.parse({
          outcome: 'failed',
          eventId: event.eventId,
          seq: event.seq,
          reasonCode: 'storage_unavailable',
          message: 'append failed before persistence',
        })
      }

      const sameId = eventsById.get(event.eventId)
      if (sameId !== undefined) {
        return sameContent(sameId, event)
          ? appendAckSchema.parse({ outcome: 'duplicate', eventId: event.eventId, seq: event.seq })
          : appendAckSchema.parse({
              outcome: 'failed',
              eventId: event.eventId,
              seq: event.seq,
              reasonCode: 'conflict',
              message: 'reused event id with different content',
            })
      }

      if (seqOwner.has(`${event.sessionId}:${event.seq}`)) {
        return appendAckSchema.parse({
          outcome: 'failed',
          eventId: event.eventId,
          seq: event.seq,
          reasonCode: 'conflict',
          message: 'duplicate sequence number in session',
        })
      }

      persistEvent(event)
      return appendAckSchema.parse({ outcome: 'stored', eventId: event.eventId, seq: event.seq })
    },

    async commitDeliveryWithEvent(delivery, event): Promise<AtomicCommitAck> {
      const failure = (): AtomicCommitAck =>
        atomicCommitAckSchema.parse({
          delivery: {
            status: 'failed',
            reasonCode: 'storage_unavailable',
            message: 'atomic commit failed',
          },
          event: {
            outcome: 'failed',
            eventId: event.eventId,
            seq: event.seq,
            reasonCode: 'storage_unavailable',
            message: 'atomic commit failed',
          },
        })

      try {
        if (options.beforeCommit !== undefined) await options.beforeCommit()
      } catch {
        // Atomic failure: nothing above this point has been mutated.
        return failure()
      }

      const sameId = eventsById.get(event.eventId)
      if (sameId !== undefined && !sameContent(sameId, event)) return failure()

      const sequence = `${event.sessionId}:${event.seq}`
      const owner = seqOwner.get(sequence)
      if (owner !== undefined && owner !== event.eventId) {
        return atomicCommitAckSchema.parse({
          delivery: {
            status: 'failed',
            reasonCode: 'storage_unavailable',
            message: 'atomic commit failed',
          },
          event: {
            outcome: 'failed',
            eventId: event.eventId,
            seq: event.seq,
            reasonCode: 'conflict',
            message: 'duplicate sequence number in session',
          },
        })
      }

      const key = deliveryKey(delivery)
      const existing = deliveriesByKey.get(key)
      let deliveryAck: DeliveryCommitAck
      if (existing === undefined) {
        const record: ConfirmedDelivery = {
          sessionId: delivery.sessionId,
          turnId: delivery.turnId,
          segmentId: delivery.segmentId,
          textHash: delivery.textHash,
          text: delivery.text,
          outputId: delivery.outputId,
          receiptId: delivery.receiptId,
          classification: delivery.classification,
          modality: delivery.modality,
        }
        deliveriesByKey.set(key, record)
        deliveries.push(record)
        deliveryAck = deliveryCommitAckSchema.parse({
          status: 'applied',
          effectiveClassification: delivery.classification,
          recordId: key,
        })
      } else if (existing.textHash !== delivery.textHash) {
        deliveryAck = deliveryCommitAckSchema.parse({
          status: 'conflict',
          recordedClassification: existing.classification,
          incomingClassification: delivery.classification,
          conflictRecordId: `${key}:conflict`,
        })
      } else if (existing.classification === delivery.classification) {
        deliveryAck = deliveryCommitAckSchema.parse({
          status: 'duplicate',
          effectiveClassification: existing.classification,
          recordId: key,
        })
      } else {
        deliveryAck = deliveryCommitAckSchema.parse({
          status: 'conflict',
          recordedClassification: existing.classification,
          incomingClassification: delivery.classification,
          conflictRecordId: `${key}:conflict`,
        })
      }

      if (sameId === undefined) persistEvent(event)

      return atomicCommitAckSchema.parse({
        delivery: deliveryAck,
        event:
          sameId !== undefined
            ? { outcome: 'duplicate', eventId: event.eventId, seq: event.seq }
            : { outcome: 'stored', eventId: event.eventId, seq: event.seq },
      })
    },

    async readSession(sessionId): Promise<RuntimeEvent[]> {
      return sessionEventsInOrder(sessionId)
    },

    async exportJsonl(sessionId): Promise<string> {
      return sessionEventsInOrder(sessionId)
        .map((event) => JSON.stringify(event))
        .join('\n')
    },
  }
}
