import type { DialogueRequest } from '../contracts'

/**
 * Segment identity and the finalized-text registry.
 *
 * Identity rule: a segment is determined by the session it belongs to, the turn
 * that contains it, and its position within that turn. The request id is
 * deliberately not part of identity, because the same turn may be regenerated
 * while the segments must keep a stable identity for the whole turn.
 *
 * The session is part of the id because the session-scoped turn counter restarts
 * for every session. Without it, one process serving two sessions would let a
 * reused turn id resolve to the first session's finalized text, and the second
 * session would inherit a sentence it never generated.
 *
 * This id is an IDENTITY, not an ordering key. Ordering must not be derived from
 * the spelling of the identifier: `DialogueSegment.index` is the authoritative
 * carrier of position within a turn, and the coordinated C6/C7 contract now
 * persists it as `segmentIndex` on both `CommitDelivery` and `ConfirmedDelivery`.
 * The read side (`./context`) orders by that field directly; there is no
 * identifier-derived position fallback.
 *
 * If the identity rule changes, change only `deriveSegmentId`; every caller
 * builds segment ids through it.
 */
export function deriveSegmentId(request: DialogueRequest, index: number): string {
  return `${request.sessionId}:${request.turnId}-seg-${index}`
}

export interface FinalizedSegmentRegistry {
  /** Text already finalized for this segment; null when it has never been seen. */
  finalizedText(segmentId: string): string | null
  /**
   * Register a candidate text and return the authoritative text for the segment.
   * A different candidate that arrives later is ignored rather than applied, so
   * immutability is structural rather than accidental.
   */
  finalize(segmentId: string, text: string): string
}

export function createFinalizedSegmentRegistry(): FinalizedSegmentRegistry {
  const finalized = new Map<string, string>()
  return {
    finalizedText: (segmentId) => finalized.get(segmentId) ?? null,
    finalize: (segmentId, text) => {
      const existing = finalized.get(segmentId)
      if (existing !== undefined) return existing
      finalized.set(segmentId, text)
      return text
    },
  }
}
