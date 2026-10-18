import type { ConfirmedDelivery } from '../contracts'

/**
 * M5 delivery-evidence ordering (INV-15, C6/C7).
 *
 * `HistoryQueryPort.confirmedHistory` returns one session's records ordered by
 * the supporting event `seq` ascending; it is a read order, not a turn order.
 * A consumer that reconstructs one turn groups records by
 * `(sessionId, turnId)` and orders them with this pure helper:
 *
 * - records with a known `segmentIndex` come first, ascending;
 * - records with an unknown (`null`) index follow, in input order;
 * - ties and unknowns keep their supporting-event-sequence input order.
 *
 * This never claims an original position for an unknown index: an unknown
 * record is placed after every known one and keeps the read order among its
 * peers. It does not reorder the history port and does not decide memory
 * semantics; it is a deterministic, dependency-free reconstruction step.
 */
export function orderTurnDeliveries(
  records: readonly ConfirmedDelivery[],
  sessionId: string,
  turnId: string,
): ConfirmedDelivery[] {
  return records
    .filter((record) => record.sessionId === sessionId && record.turnId === turnId)
    .map((record, inputOrder) => ({ record, inputOrder }))
    .sort((a, b) => {
      const aIndex = a.record.segmentIndex
      const bIndex = b.record.segmentIndex
      if (aIndex === null && bIndex === null) return a.inputOrder - b.inputOrder
      if (aIndex === null) return 1
      if (bIndex === null) return -1
      if (aIndex !== bIndex) return aIndex - bIndex
      return a.inputOrder - b.inputOrder
    })
    .map((entry) => entry.record)
}
