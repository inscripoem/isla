import type { ConfirmedDelivery, RuntimeEvent } from '../contracts'
import { deliveryKey, type StorageBackend, type StorageMutation } from './backend'

/**
 * M6 storage — default in-memory backend (FR-06).
 *
 * Production default for `createEventStore`. SQLite will implement the same
 * `StorageBackend` interface; no store logic changes when it does.
 *
 * Isolation boundary (INV-07)
 * ---------------------------
 * The backend owns its copies: it deep-copies every record on write and on
 * read, so mutating a caller's input after commit, or a returned record, cannot
 * change committed state. SQLite reads produce fresh rows, so the same boundary
 * holds for the future backend.
 *
 * Indexing
 * --------
 * Events are indexed by `sessionId:eventId` (event identity is session-scoped,
 * INTERFACES C7), session sequences by `sessionId:seq`, and deliveries by their
 * composite key, so identity and conflict checks are O(1).
 */
function eventKey(sessionId: string, eventId: string): string {
  return `${sessionId}\u0000${eventId}`
}

function copy<T>(value: T): T {
  return structuredClone(value)
}

export function createInMemoryBackend(): StorageBackend {
  const eventsById = new Map<string, RuntimeEvent>()
  const sequenceOwners = new Map<string, string>()
  const eventsBySession = new Map<string, RuntimeEvent[]>()
  const deliveriesByKey = new Map<string, ConfirmedDelivery>()
  const deliveries: ConfirmedDelivery[] = []

  function apply(mutation: StorageMutation): void {
    if (mutation.kind === 'event') {
      const event = copy(mutation.event)
      eventsById.set(eventKey(event.sessionId, event.eventId), event)
      sequenceOwners.set(`${event.sessionId}:${event.seq}`, event.eventId)
      const bucket = eventsBySession.get(event.sessionId)
      if (bucket === undefined) eventsBySession.set(event.sessionId, [event])
      else bucket.push(event)
      return
    }
    const record = copy(mutation.record)
    deliveriesByKey.set(deliveryKey(record), record)
    deliveries.push(record)
  }

  return {
    eventById: (sessionId, eventId) => {
      const event = eventsById.get(eventKey(sessionId, eventId))
      return event === undefined ? undefined : copy(event)
    },
    sequenceOwner: (sessionId, seq) => sequenceOwners.get(`${sessionId}:${seq}`),
    sessionEvents: (sessionId) => (eventsBySession.get(sessionId) ?? []).map(copy),
    deliveryByKey: (key) => {
      const record = deliveriesByKey.get(key)
      return record === undefined ? undefined : copy(record)
    },
    deliveries: () => deliveries.map(copy),
    commit: (mutations) => {
      for (const mutation of mutations) apply(mutation)
    },
  }
}
