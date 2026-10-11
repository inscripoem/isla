import type { DialogueRequest } from '../contracts'

/**
 * Segment identity and the finalized-text registry.
 *
 * Identity rule: a segment is identified by its turn and its position within
 * that turn. The request id is deliberately NOT part of the identity, because
 * the same turn may be regenerated and a segment must keep one stable identity
 * for the whole turn.
 *
 * If the identity rule ever needs to change, change `deriveSegmentId` only;
 * every caller derives ids through it.
 */
export function deriveSegmentId(request: DialogueRequest, index: number): string {
  return `${request.turnId}-seg-${index}`
}

export interface FinalizedSegmentRegistry {
  /** Previously finalized text for a segment, or null when unseen. */
  finalizedText(segmentId: string): string | null
  /**
   * Registers candidate text and returns the text that is authoritative for
   * this segment. A later, different candidate is ignored rather than applied,
   * which makes immutability a structural property instead of a coincidence.
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
