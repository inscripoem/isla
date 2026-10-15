import { APPLICATION_CONTRACT_VERSION } from '../../contracts'
import type { CommitDelivery, ConfirmedDelivery, RuntimeEvent } from '../../contracts'
import type { StoredDelivery } from '../backend'

/**
 * M6 storage — row codecs for the SQLite backend (B2).
 *
 * Mapping between committed records and their table rows. `payload` and
 * `versions` are stored as JSON text; all other fields are columns. `rowToEvent`
 * reads with `protocolVersion = 0.2` because the store only admits contract-0.2
 * events, and reading builds a fresh object (record isolation, INV-07).
 */

export interface EventRow {
  session_id: string
  event_id: string
  seq: number
  timestamp_ms: number
  epoch: number
  turn_id: string | null
  segment_id: string | null
  output_id: string | null
  type: string
  source_module: string
  versions: string | null
  payload: string
}

export function eventToRow(event: RuntimeEvent): EventRow {
  return {
    session_id: event.sessionId,
    event_id: event.eventId,
    seq: event.seq,
    timestamp_ms: event.timestampMs,
    epoch: event.epoch,
    turn_id: event.turnId,
    segment_id: event.segmentId,
    output_id: event.outputId,
    type: event.type,
    source_module: event.sourceModule,
    versions: event.versions === null ? null : JSON.stringify(event.versions),
    payload: JSON.stringify(event.payload),
  }
}

export function rowToEvent(row: EventRow): RuntimeEvent {
  return {
    protocolVersion: APPLICATION_CONTRACT_VERSION,
    eventId: row.event_id,
    seq: row.seq,
    timestampMs: row.timestamp_ms,
    sessionId: row.session_id,
    epoch: row.epoch,
    turnId: row.turn_id,
    segmentId: row.segment_id,
    outputId: row.output_id,
    type: row.type,
    sourceModule: row.source_module as RuntimeEvent['sourceModule'],
    versions: row.versions === null ? null : (JSON.parse(row.versions) as Record<string, string>),
    payload: JSON.parse(row.payload) as Record<string, unknown>,
  }
}

export interface DeliveryRow {
  session_id: string
  turn_id: string
  segment_id: string
  modality: string
  text_hash: string
  text: string
  output_id: string | null
  receipt_id: string | null
  classification: string
  terminal_outcome: string
  persona_version: string | null
  event_seq: number
  /** #22 attribution; NULL for legacy rows (never inferred). */
  segment_index: number | null
  persona_profile_id: string | null
  persona_profile_version: string | null
}

export function rowToDelivery(row: DeliveryRow): StoredDelivery {
  return {
    record: {
      sessionId: row.session_id,
      turnId: row.turn_id,
      segmentId: row.segment_id,
      textHash: row.text_hash,
      text: row.text,
      outputId: row.output_id,
      receiptId: row.receipt_id,
      classification: row.classification as ConfirmedDelivery['classification'],
      modality: row.modality as ConfirmedDelivery['modality'],
      segmentIndex: row.segment_index,
      personaProfileId: row.persona_profile_id,
      personaProfileVersion: row.persona_profile_version,
    },
    eventSeq: row.event_seq,
    terminalOutcome: row.terminal_outcome as CommitDelivery['terminalOutcome'],
  }
}
