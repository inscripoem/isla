import type { ConfirmedDelivery } from '../contracts'
import type { StoredDelivery } from './backend'
import type { StoredDeliveriesSource } from './history-query'

/**
 * M6 storage — recovery view (B3; ADR-005, INV-12).
 *
 * Purpose
 * -------
 * At startup M5 must restore *only* confirmed spoken history and keep every
 * unresolved output `unknown` — never replayed, never quoted as delivered. This
 * read gives M5/M4 the two groups in one place:
 * - `confirmed` — fully-delivered records (spoken history), ordered by the
 *   supporting event `seq`;
 * - `unresolved` — partial/unknown or not-delivered records, with their terminal
 *   outcome and supporting `seq`, so a segment stays `unknown` and is not replayed.
 *
 * Boundary
 * --------
 * M6 owns the data and evidence; M5 owns the lifecycle (new stopped session,
 * blocking new turns pending recovery). This view decides no lifecycle.
 */

export interface RecoveryView {
  /** Fully-delivered spoken history for a session, ordered by supporting event seq. */
  confirmed(sessionId: string): ConfirmedDelivery[]
  /** Non-fully-delivered records for a session, ordered by supporting event seq. */
  unresolved(sessionId: string): readonly StoredDelivery[]
}

export function createRecoveryView(source: StoredDeliveriesSource): RecoveryView {
  function forSession(sessionId: string): StoredDelivery[] {
    return source
      .storedDeliveries()
      .filter((entry) => entry.record.sessionId === sessionId)
      .sort((left, right) => left.eventSeq - right.eventSeq)
  }

  return {
    confirmed(sessionId) {
      return forSession(sessionId)
        .filter((entry) => entry.record.classification === 'fully-delivered')
        .map((entry) => entry.record)
    },
    unresolved(sessionId) {
      return forSession(sessionId).filter(
        (entry) => entry.record.classification !== 'fully-delivered',
      )
    },
  }
}
