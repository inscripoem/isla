import type { ConfirmedDelivery, Modality } from '../contracts'

/**
 * Delivery identity.
 *
 * A delivery is identified by the session, the turn, the segment position within
 * the turn and the modality it was confirmed for. The text hash is deliberately
 * NOT part of the key: changing the text under a stable identity is a conflict to
 * be reported, not a different delivery to be stored alongside the first one.
 *
 * The session is part of the key because a session-scoped turn counter restarts
 * from the beginning for every session, so `turnId` alone repeats. Omitting the
 * session would make two sessions with the same local turn numbering collide, and
 * the store would report a cross-session conflict for deliveries that never
 * contradicted each other.
 *
 * This matches the identity M6 uses for its own storage, so a key derived here
 * can be compared with one derived there.
 */

/** The parts of a record that take part in delivery identity. */
export interface DeliveryIdentity {
  sessionId: string
  turnId: string
  segmentId: string
  modality: Modality
}

export function deliveryKey(delivery: DeliveryIdentity): string {
  return `${delivery.sessionId}:${delivery.turnId}:${delivery.segmentId}:${delivery.modality}`
}

/**
 * Segment identity and delivery identity differ: one segment may be confirmed
 * for several modalities, and each of those is a separate delivery. This key
 * drops the modality, so it groups the confirmations of a single utterance and
 * lets the caller keep one of them.
 */
export function utteranceKey(delivery: DeliveryIdentity): string {
  return `${delivery.sessionId}:${delivery.turnId}:${delivery.segmentId}`
}

/**
 * Turn identity. A turn belongs to exactly one session, and the session-scoped
 * turn counter restarts per session, so a turn is only identified by the pair.
 */
export function turnKey(delivery: Pick<ConfirmedDelivery, 'sessionId' | 'turnId'>): string {
  return `${delivery.sessionId}:${delivery.turnId}`
}
