import type { ConfirmedDelivery, HistoryQueryPort } from '../contracts'

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
 * Source
 * ------
 * The delivery set is read through a source on each query (never a captured
 * snapshot), so the query reflects committed state and records stay isolated
 * from caller mutation (INV-07). The event store's backend implements this
 * source. Ordering by the supporting event sequence is applied separately.
 *
 * Contract
 * --------
 * Implements `HistoryQueryPort` from `src/contracts/app/ports.ts`. Types are
 * imported from `../contracts`; production code must not import from `test/`
 * (AGENTS.md).
 *
 * Ownership and boundaries
 * ------------------------
 * - M4 consumes this port during context assembly. M4 owns memory semantics; M6
 *   owns the storage infrastructure that answers the query.
 * - M6 does not decide the classification here. It only filters records that M5
 *   and M4 already committed through `commitDeliveryWithEvent`.
 *
 * Behaviour
 * ---------
 * confirmedHistory(sessionId) -> ConfirmedDelivery[]
 *   - read the committed deliveries from the source
 *   - filter by sessionId
 *   - keep records whose classification is exactly `fully-delivered`
 */

/** Read access to committed deliveries; implemented by the storage backend. */
export interface DeliveriesSource {
  deliveries(): readonly ConfirmedDelivery[]
}

export function createHistoryQuery(source: DeliveriesSource): HistoryQueryPort {
  return {
    async confirmedHistory(sessionId) {
      // Keep only fully-delivered receipts for this session.
      return source
        .deliveries()
        .filter(
          (record) => record.sessionId === sessionId && record.classification === 'fully-delivered',
        )
    },
  }
}
