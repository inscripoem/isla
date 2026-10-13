import type { ConfirmedDelivery, RuntimeEvent } from '../contracts'
import { deliveryKey, type StorageBackend, type StorageMutation } from './backend'

/**
 * M6 storage — default in-memory backend (FR-06).
 *
 * Production default for `createEventStore`. SQLite will implement the same
 * `StorageBackend` interface; no store logic changes when it does.
 *
 * Indexing: events are indexed by `sessionId:eventId` (event identity is
 * session-scoped, INTERFACES C7), session sequences by `sessionId:seq`, and
 * deliveries by their composite key, so identity and conflict checks are O(1)
 * rather than linear scans.
 */
function eventKey(sessionId: string, eventId: string): string {
  return `${sessionId}\u0000${eventId}`
}

export function createInMemoryBackend(): StorageBackend {
  const eventsById = new Map<string, RuntimeEvent>()
  const sequenceOwners = new Map<string, string>()
  const eventsBySession = new Map<string, RuntimeEvent[]>()
  const deliveriesByKey = new Map<string, ConfirmedDelivery>()
  const deliveries: ConfirmedDelivery[] = []

  function apply(mutation: StorageMutation): void {
    if (mutation.kind === 'event') {
      const { event } = mutation
      eventsById.set(eventKey(event.sessionId, event.eventId), event)
      sequenceOwners.set(`${event.sessionId}:${event.seq}`, event.eventId)
      const bucket = eventsBySession.get(event.sessionId)
      if (bucket === undefined) eventsBySession.set(event.sessionId, [event])
      else bucket.push(event)
      return
    }
    deliveriesByKey.set(deliveryKey(mutation.record), mutation.record)
    deliveries.push(mutation.record)
  }

  return {
    eventById: (sessionId, eventId) => eventsById.get(eventKey(sessionId, eventId)),
    sequenceOwner: (sessionId, seq) => sequenceOwners.get(`${sessionId}:${seq}`),
    sessionEvents: (sessionId) => eventsBySession.get(sessionId) ?? [],
    deliveryByKey: (key) => deliveriesByKey.get(key),
    deliveries: () => deliveries,
    commit: (mutations) => {
      for (const mutation of mutations) apply(mutation)
    },
  }
}
