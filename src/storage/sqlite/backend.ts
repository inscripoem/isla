import type { DatabaseSync } from 'node:sqlite'
import type { StorageBackend, StorageMutation, StoredDelivery } from '../backend'
import { eventToRow, rowToDelivery, rowToEvent, type DeliveryRow, type EventRow } from './codec'

/**
 * M6 storage — SQLite backend (B2; ADR-004).
 *
 * Implements `StorageBackend` over the B1 schema so the store's behaviour is
 * durable and identical to the in-memory slice:
 * - INV-04: `(session_id, event_id)` and `(session_id, seq)` uniqueness enforced
 *   by the primary/unique constraints.
 * - INV-05: `commit` applies every mutation in one transaction.
 * - INV-07: reads build fresh objects (`rowToEvent`/`rowToDelivery`).
 * - INV-08: `storedDeliveries` carries `event_seq` for ordered history.
 *
 * `node:sqlite` is Node-only; this module stays outside the browser graph.
 */
export function createSqliteBackend(database: DatabaseSync): StorageBackend {
  const insertEvent = database.prepare(
    `INSERT INTO events
       (session_id, event_id, seq, timestamp_ms, epoch, turn_id, segment_id, output_id,
        type, source_module, versions, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertDelivery = database.prepare(
    `INSERT INTO deliveries
       (session_id, turn_id, segment_id, modality, text_hash, text, output_id, receipt_id,
        classification, terminal_outcome, event_seq,
        segment_index, persona_profile_id, persona_profile_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selectEventById = database.prepare(
    'SELECT * FROM events WHERE session_id = ? AND event_id = ?',
  )
  const selectSequenceOwner = database.prepare(
    'SELECT event_id FROM events WHERE session_id = ? AND seq = ?',
  )
  const selectSessionEvents = database.prepare('SELECT * FROM events WHERE session_id = ?')
  const selectDelivery = database.prepare(
    'SELECT * FROM deliveries WHERE session_id = ? AND turn_id = ? AND segment_id = ? AND modality = ?',
  )
  const selectDeliveries = database.prepare('SELECT * FROM deliveries ORDER BY event_seq')

  function applyMutation(mutation: StorageMutation): void {
    if (mutation.kind === 'event') {
      const row = eventToRow(mutation.event)
      insertEvent.run(
        row.session_id,
        row.event_id,
        row.seq,
        row.timestamp_ms,
        row.epoch,
        row.turn_id,
        row.segment_id,
        row.output_id,
        row.type,
        row.source_module,
        row.versions,
        row.payload,
      )
      return
    }
    const delivery = mutation.record
    insertDelivery.run(
      delivery.sessionId,
      delivery.turnId,
      delivery.segmentId,
      delivery.modality,
      delivery.textHash,
      delivery.text,
      delivery.outputId,
      delivery.receiptId,
      delivery.classification,
      mutation.terminalOutcome,
      mutation.eventSeq,
      // #22 attribution, preserved verbatim (NULL stays NULL).
      delivery.segmentIndex,
      delivery.personaProfileId,
      delivery.personaProfileVersion,
    )
  }

  return {
    eventById: (sessionId, eventId) => {
      const row = selectEventById.get(sessionId, eventId) as EventRow | undefined
      return row === undefined ? undefined : rowToEvent(row)
    },
    sequenceOwner: (sessionId, seq) => {
      const row = selectSequenceOwner.get(sessionId, seq) as { event_id: string } | undefined
      return row?.event_id
    },
    sessionEvents: (sessionId) =>
      (selectSessionEvents.all(sessionId) as unknown as EventRow[]).map(rowToEvent),
    deliveryByKey: (sessionId, turnId, segmentId, modality) => {
      const row = selectDelivery.get(sessionId, turnId, segmentId, modality) as
        | DeliveryRow
        | undefined
      return row === undefined ? undefined : rowToDelivery(row).record
    },
    storedDeliveries: () =>
      (selectDeliveries.all() as unknown as DeliveryRow[]).map(rowToDelivery),
    commit: (mutations: readonly StorageMutation[]) => {
      database.exec('BEGIN')
      try {
        for (const mutation of mutations) applyMutation(mutation)
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
  }
}

/** Re-exported for tests/consumers that hold a stored delivery. */
export type { StoredDelivery }
