import type { ReplayReaderPort, RuntimeEvent } from '../contracts'

/**
 * M6 storage — replay reader (C7, C-12, FR-06).
 *
 * Purpose
 * -------
 * Load an archived session as a read-only view. Replay is used for inspection
 * and evaluation, not for driving the live system.
 *
 * Isolation rule (C-12)
 * ---------------------
 * Replay must never mutate live state and must never call a live
 * provider or renderer. To enforce that, this reader depends only on an event
 * source that returns committed events; it performs no writes.
 *
 * Contract
 * --------
 * Implements `ReplayReaderPort` from `src/contracts/app/ports.ts`.
 *   load(sessionId) -> { sessionId, events }
 *
 * Composition
 * -----------
 * The event source is injected (typically the M6 event store's `readSession`),
 * so the reader stays a pure projection over committed records. M5 owns event
 * sequencing; M6 does not assign or reorder authority.
 */
export function createReplayReader(store: {
  readSession(sessionId: string): Promise<RuntimeEvent[]>
}): ReplayReaderPort {
  return {
    async load(sessionId) {
      // Read-only: delegate to the committed event source, add no state.
      return { sessionId, events: await store.readSession(sessionId) }
    },
  }
}
