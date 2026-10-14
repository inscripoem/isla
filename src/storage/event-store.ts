import {
  appendAckSchema,
  atomicCommitAckSchema,
  commitDeliverySchema,
  deliveryCommitAckSchema,
  deliveryEventCorrelationIssue,
  runtimeEventSchema,
  type AppendAck,
  type AtomicCommitAck,
  type ConfirmedDelivery,
  type DeliveryCommitAck,
  type EventStorePort,
  type RuntimeEvent,
} from '../contracts'
import { deliveryKey, type StorageBackend, type StorageMutation } from './backend'
import { createInMemoryBackend } from './in-memory-backend'
import { canonicalJson, jsonValueIssue } from './payload'

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
 *   - no existing receipt -> `applied`; changed textHash, segment index or
 *     persona attribution -> `conflict`; same content and classification ->
 *     `duplicate`; same textHash + different classification -> `conflict`.
 *   - a delivery whose required fields are omitted or malformed, whose
 *     `classification`/`terminalOutcome` combination is inconsistent, or whose
 *     known provenance/correlation contradicts the supporting event -> `failed`
 *     (`invalid_delivery` / `inconsistent_delivery`) with nothing persisted.
 *     A supporting event that fails `RuntimeEvent` validation (for example an
 *     omitted `versions` or a non-string/null version member) -> `failed`
 *     (`invalid_event`) before its fields are read. The same identity and
 *     sequence remain reusable by a corrected retry.
 * readSession(sessionId) -> events for the session, `seq` strictly increasing.
 * exportJsonl(sessionId)  -> one JSON string per committed event, newline joined,
 *                            matching `readSession` exactly.
 *
 * Content equality and the payload contract
 * -----------------------------------------
 * An event `payload` must be a **JSON value** (see `./payload`): the durable
 * store persists it as JSON, so an unsupported value is rejected with
 * `unsupported_payload` before publication rather than silently altered. For
 * accepted events, equality is canonical — object key order is irrelevant and
 * array order is significant — so a re-serialised equivalent event is a
 * `duplicate`, not a `conflict` (ADR-002 D1).
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

/**
 * True when two events carry the same content. Both values are JSON values by
 * the time they are compared (validated by `jsonValueIssue` before publication),
 * so equality is the canonical rendering: object key order is irrelevant and
 * array order is significant (ADR-002 D1).
 */
function sameContent(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b)
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
  segmentIndex: ConfirmedDelivery['segmentIndex']
  personaProfileId: ConfirmedDelivery['personaProfileId']
  personaProfileVersion: ConfirmedDelivery['personaProfileVersion']
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
    segmentIndex: delivery.segmentIndex,
    personaProfileId: delivery.personaProfileId,
    personaProfileVersion: delivery.personaProfileVersion,
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

  function unsupportedFailure(event: RuntimeEvent, issue: string): AppendAck {
    return appendAckSchema.parse({
      outcome: 'failed',
      eventId: event.eventId,
      seq: event.seq,
      reasonCode: 'unsupported_payload',
      message: `unsupported event payload: ${issue}`,
    })
  }

  return {
    async append(event): Promise<AppendAck> {
      const payloadIssue = jsonValueIssue(event.payload)
      if (payloadIssue !== null) return unsupportedFailure(event, payloadIssue)

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
      // A failed atomic commit reports the actual cause on both sides: an
      // unsupported payload, a conflict (identity/sequence reuse or changed
      // content), or a storage failure. The delivery acknowledgement must not
      // claim one cause for another.
      const parsedDelivery = commitDeliverySchema.safeParse(delivery)
      // The store is the durable boundary: a delivery whose required fields are
      // omitted or malformed is rejected before any mutation, so it can never be
      // persisted with `undefined` attribution. The schema is strict, so an
      // explicit `null` legacy unknown is accepted while an omitted field is not.
      if (!parsedDelivery.success) {
        return atomicCommitAckSchema.parse({
          delivery: {
            status: 'failed',
            reasonCode: 'invalid_delivery',
            message: 'delivery failed schema validation',
          },
          event: appendAckSchema.parse({
            outcome: 'failed',
            eventId: event.eventId,
            seq: event.seq,
            reasonCode: 'invalid_delivery',
            message: 'atomic commit rejected an invalid delivery',
          }),
        })
      }
      // The supporting event is validated at the same boundary, before its
      // fields are read for correlation: a malformed event (for example a
      // missing `versions`, or a non-string/null version member) must not be
      // read, must never be persisted, and must not reach the JSON payload
      // check. This preserves the existing `unsupported_payload` behavior,
      // because a function payload is still a schema-valid `unknown` value.
      if (!runtimeEventSchema.safeParse(event).success) {
        const message = 'supporting event failed schema validation'
        return atomicCommitAckSchema.parse({
          delivery: { status: 'failed', reasonCode: 'invalid_event', message },
          event: appendAckSchema.parse({
            outcome: 'failed',
            eventId: event.eventId,
            seq: event.seq,
            reasonCode: 'invalid_event',
            message,
          }),
        })
      }
      // Contradictory known provenance or correlation between the delivery and
      // its supporting event is rejected before any mutation, as one paired
      // failure: the batch is internally inconsistent, not an identity conflict.
      const correlationIssue = deliveryEventCorrelationIssue(parsedDelivery.data, event)
      if (correlationIssue !== null) {
        const message = `delivery and supporting event disagree on ${correlationIssue}`
        return atomicCommitAckSchema.parse({
          delivery: { status: 'failed', reasonCode: 'inconsistent_delivery', message },
          event: appendAckSchema.parse({
            outcome: 'failed',
            eventId: event.eventId,
            seq: event.seq,
            reasonCode: 'inconsistent_delivery',
            message,
          }),
        })
      }
      const failure = (
        reasonCode: 'storage_unavailable' | 'conflict' | 'unsupported_payload',
        eventFailure: AppendAck,
      ): AtomicCommitAck =>
        atomicCommitAckSchema.parse({
          delivery: {
            status: 'failed',
            reasonCode,
            message:
              reasonCode === 'conflict'
                ? 'conflicting atomic commit'
                : reasonCode === 'unsupported_payload'
                  ? 'unsupported event payload'
                  : 'atomic commit failed',
          },
          event: eventFailure,
        })

      const payloadIssue = jsonValueIssue(event.payload)
      if (payloadIssue !== null) {
        return failure('unsupported_payload', unsupportedFailure(event, payloadIssue))
      }

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
      const existing = backend.deliveryByKey(
        delivery.sessionId,
        delivery.turnId,
        delivery.segmentId,
        delivery.modality,
      )
      const mutations: StorageMutation[] = []
      let deliveryAck: DeliveryCommitAck

      if (existing === undefined) {
        mutations.push({
          kind: 'delivery',
          record: toConfirmedDelivery(delivery),
          eventSeq: event.seq,
          terminalOutcome: delivery.terminalOutcome,
        })
        deliveryAck = deliveryCommitAckSchema.parse({
          status: 'applied',
          effectiveClassification: delivery.classification,
          recordId: key,
        })
      } else if (
        existing.textHash !== delivery.textHash ||
        // Attribution is part of the immutable identity: the same delivery key
        // with a changed segment index or persona must conflict, never be
        // silently accepted as a duplicate or overwrite the recorded history.
        existing.segmentIndex !== delivery.segmentIndex ||
        existing.personaProfileId !== delivery.personaProfileId ||
        existing.personaProfileVersion !== delivery.personaProfileVersion
      ) {
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
