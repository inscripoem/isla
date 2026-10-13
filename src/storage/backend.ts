import type { ConfirmedDelivery, RuntimeEvent } from '../contracts'

/**
 * M6 storage — persistence backend seam (C6/C7, FR-06).
 *
 * Purpose
 * -------
 * The event-store logic (identity/sequence conflict rules, atomic delivery
 * commit, ordering, export) is defined once against this interface. Concrete
 * storage (in-memory now, SQLite later) implements it. This keeps the store's
 * behaviour independent of the persistence technology.
 *
 * Why a backend, not a test hook
 * ------------------------------
 * Storage failure is a property of the persistence layer, so failure is
 * injected by supplying a backend (e.g. a failing test backend), never by
 * exposing a fault switch on production API (READINESS-KITS: keep fault
 * injection in the test adapter).
 *
 * Contract
 * --------
 * `commit` must be atomic: it applies every mutation or none. A storage failure
 * throws, and the caller converts that into `failed` acknowledgements without
 * partial state (FR-06; C-17).
 */

/** A single atomic mutation: a committed event and/or a committed delivery. */
export type StorageMutation =
  | { readonly kind: 'event'; readonly event: RuntimeEvent }
  | { readonly kind: 'delivery'; readonly record: ConfirmedDelivery }

/** Composite delivery identity: sessionId:turnId:segmentId:modality. */
export function deliveryKey(
  record: Pick<ConfirmedDelivery, 'sessionId' | 'turnId' | 'segmentId' | 'modality'>,
): string {
  return `${record.sessionId}:${record.turnId}:${record.segmentId}:${record.modality}`
}

export interface StorageBackend {
  /**
   * Committed event with this identity in this session, if any. Event identity
   * is session-scoped (INTERFACES C7): two sessions may each hold `evt-1`.
   */
  eventById(sessionId: string, eventId: string): RuntimeEvent | undefined
  /** Event id owning this session sequence, if any (M5 assigns seq). */
  sequenceOwner(sessionId: string, seq: number): string | undefined
  /** Committed events for a session (unordered). */
  sessionEvents(sessionId: string): RuntimeEvent[]
  /** Committed delivery with this composite key, if any. */
  deliveryByKey(key: string): ConfirmedDelivery | undefined
  /** Live committed delivery records (consumed by HistoryQueryPort). */
  deliveries(): ConfirmedDelivery[]
  /** Apply all mutations atomically; throw on storage failure. */
  commit(mutations: readonly StorageMutation[]): void
}
