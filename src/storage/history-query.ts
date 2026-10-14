import type { HistoryQueryPort } from '../contracts'
import type { StoredDelivery } from './backend'

/**
 * M6 storage — confirmed-history query (C6/C7, FR-06).
 *
 * Purpose
 * -------
 * Answer one question for the rest of the system: "which deliveries for this
 * session count as spoken history?" Only records classified `fully-delivered`
 * qualify. Generated text that was never spoken, partially spoken text, and
 * unresolved (`unknown`) outcomes are excluded (C-17; D2.5 memory/state design).
 *
 * Ordering (INV-08)
 * -----------------
 * Records are returned ordered by their supporting event's `seq` ascending;
 * within a turn, segments keep their emission order. This matches the retrieval
 * policy in `docs/architecture/memory-design.md` and the wording agreed with
 * M4/M5 (issue #22). It must not depend on insertion order.
 *
 * Isolation (INV-07)
 * ------------------
 * The source is read on each query (never a captured snapshot), so the query
 * reflects committed state and records stay isolated from caller mutation.
 *
 * Contract
 * --------
 * Implements `HistoryQueryPort` from `src/contracts/app/ports.ts`. Types are
 * imported from `../contracts`; production code must not import from `test/`.
 *
 * Ownership and boundaries
 * ------------------------
 * - M4 consumes this port during context assembly. M4 owns memory semantics; M6
 *   owns the storage infrastructure that answers the query.
 * - M6 does not decide the classification here.
 */

/** Read access to committed deliveries with their supporting event sequence. */
export interface StoredDeliveriesSource {
  storedDeliveries(): readonly StoredDelivery[]
}

export function createHistoryQuery(source: StoredDeliveriesSource): HistoryQueryPort {
  return {
    async confirmedHistory(sessionId) {
      return source
        .storedDeliveries()
        .filter(
          ({ record }) =>
            record.sessionId === sessionId && record.classification === 'fully-delivered',
        )
        .sort((a, b) => a.eventSeq - b.eventSeq)
        .map(({ record }) => record)
    },
  }
}
