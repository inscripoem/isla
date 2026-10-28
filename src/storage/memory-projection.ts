import type { MemoryProjectionPort } from '../contracts'

/**
 * M6 storage — memory projection bookmark (C7, FR-06; C-66).
 *
 * Purpose
 * -------
 * Track how far a memory projection has consumed the committed event stream for
 * each session. A projection may be shared across sessions, so the bookmark is
 * keyed by sessionId; one session must never advance, skip or block another.
 *
 * Rules
 * -----
 * Per session, the projection advances one event at a time and never skips ahead
 * (C-12; FR-06; INV-06):
 * - next event (seq === current(sessionId) + 1) -> advance that session's bookmark
 * - already-applied event (seq <= current(sessionId)) -> no-op (idempotent)
 * - gap (seq > current(sessionId) + 1) -> do not advance that session's bookmark
 *
 * An incomplete projection must never be reported as current history.
 *
 * Contract
 * --------
 * Implements `MemoryProjectionPort` from `src/contracts/app/ports.ts`.
 *
 * Boundaries
 * ----------
 * - M5 assigns every event sequence number; M6 only consumes it and never
 *   assigns authority.
 * - C-66: the bookmark is session-scoped internally, not process-wide. The
 *   shared port keeps its existing scalar getter for compatibility; a caller
 *   reading a shared projection must use the `apply` result for the event's
 *   session. There is no production caller today.
 */
export function createMemoryProjection(): MemoryProjectionPort {
  // Highest event sequence applied per session; absent means "before the first event".
  const appliedBySession = new Map<string, number>()
  let lastSessionId: string | null = null

  const current = (sessionId: string): number => appliedBySession.get(sessionId) ?? 0

  return {
    // Compatibility scalar: the most recently applied session, not a shared
    // cross-session position. Use `apply`'s return for a specific session.
    appliedSeq: () => (lastSessionId === null ? 0 : current(lastSessionId)),
    async apply(event) {
      const applied = current(event.sessionId)
      // Advance only to the immediately next event; ignore old events and gaps.
      if (event.seq === applied + 1) appliedBySession.set(event.sessionId, event.seq)
      lastSessionId = event.sessionId
      return { appliedSeq: current(event.sessionId) }
    },
  }
}
