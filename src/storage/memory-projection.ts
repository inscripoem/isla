import type { MemoryProjectionPort } from '../contracts'

/**
 * M6 storage — memory projection bookmark (C7, FR-06).
 *
 * Purpose
 * -------
 * Track how far a memory projection has consumed the committed event stream.
 * `appliedSeq` is the highest sequence applied so far. The projection advances
 * one event at a time and never skips ahead (C-12; FR-06).
 *
 * Rules
 * -----
 * Mirrors `createFixtureMemoryProjection` in `test/support/correct-ports.ts`:
 * - next event (seq === appliedSeq + 1)      -> advance the bookmark
 * - already-applied event (seq <= appliedSeq) -> no-op (idempotent)
 * - gap (seq > appliedSeq + 1)                -> do not advance
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
 */
export function createMemoryProjection(): MemoryProjectionPort {
  // Highest event sequence applied so far; 0 means "before the first event".
  let applied = 0
  return {
    // Current projection position.
    appliedSeq: () => applied,
    async apply(event) {
      // Advance only to the immediately next event; ignore old events and gaps.
      if (event.seq === applied + 1) applied = event.seq
      return { appliedSeq: applied }
    },
  }
}
