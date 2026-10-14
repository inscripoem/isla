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
import { deliveryKey, type StorageBackend, type StorageMutation } from './backend'
import { createInMemoryBackend } from './in-memory-backend'

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
 * Content equality is canonical: object key order is irrelevant, so a
 * re-serialised equivalent event is a `duplicate`, not a `conflict` (ADR-002 D1).
 *
 * Persistence seam
 * ----------------
 * All reads and the single atomic write go through an injected `StorageBackend`
 * (default `createInMemoryBackend()`; SQLite later). Storage failure is a
 * property of the backend and is injected by supplying a failing backend from a
 * test adapter, NOT by a fault switch on this production factory
 * (READINESS-KITS: keep fault-injection controls in the test adapter).
 *
 * Boundaries
 * ----------
 * - M6 never assigns authority or `seq`; it only validates uniqueness.
 * - Replay reads through `readSession`; it never mutates live state (C-12).
 */

/** A plain record (object literal) or an object with no prototype. */
function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Canonical, key-order-insensitive rendering of a JSON-like value, used to
 * decide whether two events carry "the same content" (ADR-002 D1).
 *
 * Plain objects and arrays are rendered recursively with object keys sorted, so
 * key order never affects equality; array order does. Everything else keeps
 * JSON semantics and is then re-canonicalised, so a value with its own
 * serialisation (notably `Date#toJSON`) is not flattened to an empty object.
 * Values JSON would drop (functions, `undefined`, symbols) or reject (`bigint`,
 * cycles) get a stable marker, so two structurally different events never
 * compare equal by accident.
 */
function canonical(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'bigint':
      return `bigint:${String(value)}`
    case 'function':
      return 'function'
    case 'symbol':
      return `symbol:${String(value)}`
    case 'undefined':
      return 'undefined'
    case 'object':
      break
    default:
      return JSON.stringify(value)
  }
  const object = value as object
  if (seen.has(object)) return 'cycle'
  seen.add(object)
  try {
    if (Array.isArray(object)) {
      return `[${object.map((item) => canonical(item, seen)).join(',')}]`
    }
    if (isPlainObject(object)) {
      const record = object as Record<string, unknown>
      const entries = Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(record[key], seen)}`)
      return `{${entries.join(',')}}`
    }
    return serialiseOpaque(object)
  } finally {
    seen.delete(object)
  }
}

/**
 * Render a non-plain object (Date, Map, Set, class instance, ...) through JSON,
 * then canonicalise the result so key order inside its JSON projection is still
 * irrelevant. A value JSON cannot represent (e.g. a cycle) gets a marker.
 */
function serialiseOpaque(value: object): string {
  try {
    const json = JSON.stringify(value)
    return json === undefined ? 'undefined' : canonical(JSON.parse(json))
  } catch {
    return 'unserialisable'
  }
}

/** True when two values have the same canonical content (key order irrelevant). */
function sameContent(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b)
}

function toConfirmedDelivery(delivery: {
  sessionId: string
  turnId: string
  segmentId: string
  textHash: string
  text: string
  outputId: string | null
  receiptId: string | null
  classification: ConfirmedDelivery['classification']
  modality: ConfirmedDelivery['modality']
}): ConfirmedDelivery {
  return {
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
}

export function createEventStore(backend: StorageBackend = createInMemoryBackend()): EventStorePort {
  // Single ordered view shared by readSession and exportJsonl, so they cannot disagree.
  function sessionEventsInOrder(sessionId: string): RuntimeEvent[] {
    return [...backend.sessionEvents(sessionId)].sort((a, b) => a.seq - b.seq)
  }

  function storageFailure(event: RuntimeEvent): AppendAck {
    return appendAckSchema.parse({
      outcome: 'failed',
      eventId: event.eventId,
      seq: event.seq,
      reasonCode: 'storage_unavailable',
      message: 'storage write failed',
    })
  }

  function conflictFailure(event: RuntimeEvent): AppendAck {
    return appendAckSchema.parse({
      outcome: 'failed',
      eventId: event.eventId,
      seq: event.seq,
      reasonCode: 'conflict',
      message: 'reused event id with different content',
    })
  }

  return {
    async append(event): Promise<AppendAck> {
      const sameId = backend.eventById(event.sessionId, event.eventId)
      if (sameId !== undefined) {
        return sameContent(sameId, event)
          ? appendAckSchema.parse({ outcome: 'duplicate', eventId: event.eventId, seq: event.seq })
          : conflictFailure(event)
      }

      if (backend.sequenceOwner(event.sessionId, event.seq) !== undefined) {
        return appendAckSchema.parse({
          outcome: 'failed',
          eventId: event.eventId,
          seq: event.seq,
          reasonCode: 'conflict',
          message: 'duplicate sequence number in session',
        })
      }

      try {
        backend.commit([{ kind: 'event', event }])
      } catch {
        return storageFailure(event)
      }
      return appendAckSchema.parse({ outcome: 'stored', eventId: event.eventId, seq: event.seq })
    },

    async commitDeliveryWithEvent(delivery, event): Promise<AtomicCommitAck> {
      // A failed atomic commit reports the actual cause on both sides: a conflict
      // (identity/sequence reuse or changed content) or a storage failure. The
      // delivery acknowledgement must not claim a storage failure for a conflict.
      const failure = (
        reasonCode: 'storage_unavailable' | 'conflict',
        eventFailure: AppendAck,
      ): AtomicCommitAck =>
        atomicCommitAckSchema.parse({
          delivery: {
            status: 'failed',
            reasonCode,
            message: reasonCode === 'conflict' ? 'conflicting atomic commit' : 'atomic commit failed',
          },
          event: eventFailure,
        })

      const sameId = backend.eventById(event.sessionId, event.eventId)
      if (sameId !== undefined && !sameContent(sameId, event)) {
        return failure('conflict', conflictFailure(event))
      }

      const owner = backend.sequenceOwner(event.sessionId, event.seq)
      if (owner !== undefined && owner !== event.eventId) {
        return failure(
          'conflict',
          appendAckSchema.parse({
            outcome: 'failed',
            eventId: event.eventId,
            seq: event.seq,
            reasonCode: 'conflict',
            message: 'duplicate sequence number in session',
          }),
        )
      }

      const key = deliveryKey(delivery)
      const existing = backend.deliveryByKey(key)
      const mutations: StorageMutation[] = []
      let deliveryAck: DeliveryCommitAck

      if (existing === undefined) {
        mutations.push({
          kind: 'delivery',
          record: toConfirmedDelivery(delivery),
          eventSeq: event.seq,
        })
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

      if (sameId === undefined) mutations.push({ kind: 'event', event })

      // The only fallible step: an atomic write of every pending mutation.
      if (mutations.length > 0) {
        try {
          backend.commit(mutations)
        } catch {
          return failure('storage_unavailable', storageFailure(event))
        }
      }

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
