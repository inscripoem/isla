import type { CommitDelivery, ConfirmedDelivery, RuntimeEvent } from '../contracts'
import {
  deliveryKey,
  type StorageBackend,
  type StorageMutation,
  type StoredDelivery,
} from './backend'

/**
 * M6 storage — default in-memory backend (FR-06).
 *
 * Production default for `createEventStore`. SQLite will implement the same
 * `StorageBackend` interface; no store logic changes when it does.
 *
 * Atomic commit (INV-05)
 * ----------------------
 * `commit` is all-or-nothing across the whole batch. Every fallible step — the
 * deep copy of each event/record — is completed in a `prepare` pass before any
 * mutation is `publish`ed. If any mutation cannot be prepared (e.g. a payload
 * that cannot be structurally cloned), `commit` throws with **no** index or
 * history view changed. Publishing a prepared mutation only mutates in-memory
 * maps and arrays, so it cannot fail part-way.
 *
 * Isolation boundary (INV-07)
 * ---------------------------
 * The backend owns its copies: it deep-copies every record on write and on
 * read, so mutating a caller's input after commit, or a returned record, cannot
 * change committed state. SQLite reads produce fresh rows, so the same boundary
 * holds for the future backend.
 *
 * Ordering (INV-08)
 * -----------------
 * Each committed delivery retains its supporting event `seq`, so confirmed
 * history can be returned in that order regardless of insertion order.
 *
 * Indexing
 * --------
 * Events are indexed by `sessionId:eventId` (session-scoped, INTERFACES C7),
 * session sequences by `sessionId:seq`, and deliveries by their composite key.
 */
function eventKey(sessionId: string, eventId: string): string {
  return `${sessionId}\u0000${eventId}`
}

function copy<T>(value: T): T {
  return structuredClone(value)
}

/**
 * A validated copy of one mutation, ready to publish. Producing it is the only
 * fallible step of a commit; it touches no backend state.
 */
type PreparedMutation =
  | { readonly kind: 'event'; readonly event: RuntimeEvent }
  | {
      readonly kind: 'delivery'
      readonly record: ConfirmedDelivery
      readonly eventSeq: number
      readonly terminalOutcome: CommitDelivery['terminalOutcome']
    }

/** Deep-copy a mutation (fallible). No backend state is touched. */
function prepare(mutation: StorageMutation): PreparedMutation {
  if (mutation.kind === 'event') {
    return { kind: 'event', event: copy(mutation.event) }
  }
  return {
    kind: 'delivery',
    record: copy(mutation.record),
    eventSeq: mutation.eventSeq,
    terminalOutcome: mutation.terminalOutcome,
  }
}

export function createInMemoryBackend(): StorageBackend {
  const eventsById = new Map<string, RuntimeEvent>()
  const sequenceOwners = new Map<string, string>()
  const eventsBySession = new Map<string, RuntimeEvent[]>()
  const deliveriesByKey = new Map<string, ConfirmedDelivery>()
  const storedDeliveries: StoredDelivery[] = []

  /** Publish a prepared mutation. Only touches in-memory maps/arrays (infallible). */
  function publish(mutation: PreparedMutation): void {
    if (mutation.kind === 'event') {
      const event = mutation.event
      eventsById.set(eventKey(event.sessionId, event.eventId), event)
      sequenceOwners.set(`${event.sessionId}:${event.seq}`, event.eventId)
      const bucket = eventsBySession.get(event.sessionId)
      if (bucket === undefined) eventsBySession.set(event.sessionId, [event])
      else bucket.push(event)
      return
    }
    deliveriesByKey.set(deliveryKey(mutation.record), mutation.record)
    storedDeliveries.push({
      record: mutation.record,
      eventSeq: mutation.eventSeq,
      terminalOutcome: mutation.terminalOutcome,
    })
  }

  return {
    eventById: (sessionId, eventId) => {
      const event = eventsById.get(eventKey(sessionId, eventId))
      return event === undefined ? undefined : copy(event)
    },
    sequenceOwner: (sessionId, seq) => sequenceOwners.get(`${sessionId}:${seq}`),
    sessionEvents: (sessionId) => (eventsBySession.get(sessionId) ?? []).map(copy),
    deliveryByKey: (sessionId, turnId, segmentId, modality) => {
      const record = deliveriesByKey.get(deliveryKey({ sessionId, turnId, segmentId, modality }))
      return record === undefined ? undefined : copy(record)
    },
    storedDeliveries: () =>
      storedDeliveries.map((entry) => ({
        record: copy(entry.record),
        eventSeq: entry.eventSeq,
        terminalOutcome: entry.terminalOutcome,
      })),
    commit: (mutations) => {
      // Fallible preparation of the whole batch completes before any mutation is
      // published, so a failure leaves every index and history view unchanged.
      const prepared = mutations.map(prepare)
      for (const mutation of prepared) publish(mutation)
    },
  }
}
