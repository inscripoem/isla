/*
 * Serialized `memory.inspect` contract, on the diagnostics plane (protocol 1).
 *
 * This file lives in ./contracts rather than inside the dialogue module so that
 * BOTH ends of the wire can share one declaration without importing assembly
 * internals:
 *
 *   - M4 (producer) builds the payload from an assembled context in
 *     src/dialogue/memory-inspect;
 *   - the protocol-1 boundary parses an incoming reply in this directory
 *     (src/contracts), which must stay free of `src/dialogue`
 *     (test/offline/boundaries.test.ts forbids a contracts -> dialogue edge);
 *   - M2 (consumer) validates the reply in the browser, where a
 *     `src/dialogue` import is likewise forbidden.
 *
 * Reply envelope additions (`MemoryInspectOutcome`, `MemoryInspectUnavailable`,
 * `MemoryInspectReply`) live here rather than in ./protocol so the protocol
 * module keeps its existing shape for every other kind. `outcome` separates
 * "there is no inspection to report" from a protocol error: a stopped or
 * not-yet-started runtime is a valid, correlatable answer, not a malformed
 * request.
 *
 * The declared shape is data only. It contains no behavior, no assembly logic
 * and no imports at all: the two summaries it carries are declared locally
 * (as wire mirrors of their internal counterparts) so that neither end has to
 * reach into `src/dialogue` for a type.
 *
 * Versioning. `MEMORY_INSPECT_SECTION` identifies the section of a protocol-1
 * reply; `MEMORY_INSPECT_SCHEMA_VERSION` is the payload's own version and is
 * bumped only when a field changes meaning or disappears. Adding an optional
 * field does not require a bump; a consumer must reject an unknown version
 * rather than patch missing values.
 *
 * Units. Two different units appear in this payload and must never be presented
 * as each other:
 *
 *   - `admission.admitted` counts admitted history SEGMENTS (every segment of
 *     every admitted turn);
 *   - `recall.persona.*` counts recalled persona FACTS, and `recall.delivery.*`
 *     counts recalled TURNS.
 *
 * The earlier builder documented `admitted` as "records", which is neither of
 * the above; the wire contract states the unit explicitly so a consumer cannot
 * silently relabel it.
 */

/** Version of the payload shape, independent of the transport version. */
export const MEMORY_INSPECT_SCHEMA_VERSION = 1

/** Protocol-1 kind that carries this payload. */
export const MEMORY_INSPECT_KIND = 'get_memory_inspect' as const

/** Section identifier of the reply payload. */
export const MEMORY_INSPECT_SECTION = 'memory.inspect' as const

/** Provenance of one recall, as structured fields (not a rendered string). */
export type RecallProvenance =
  | { kind: 'persona-fact'; factId: string }
  | { kind: 'delivery-turn'; sessionId: string; turnId: string }

/** One recall actually injected into the assembled context. */
export interface InspectRecall {
  provenance: RecallProvenance
  /** Deterministic overlap score that selected the item. */
  score: number
}

/** Admission summary for the assembled turn. */
export interface InspectAdmission {
  /**
   * Number of admitted history SEGMENTS (each turn contributes its own segment
   * count). This is the M4 "may be recalled" view; it is not the M6
   * durable-confirmed audit view, and it is not a count of turns.
   */
  admitted: number
  /** Records excluded from admission, grouped by the reason, with counts. */
  exclusions: Readonly<Partial<Record<string, number>>>
  /** Explicit mention of the M6 durable-confirmed view, which is audit-only here. */
  readonly noteM6Confirmed: 'audit-only'
}

/**
 * Redacted completion summary of the consistency audit, carried on the wire.
 *
 * Counts and a completeness flag only, never statement text. This mirrors the
 * internal `ConsistencyAuditSummary` in src/dialogue/consistency.ts and must be
 * kept in sync with it.
 */
export interface InspectConsistencySummary {
  /** Contradictions reported; partial when `incomplete`. */
  findings: number
  /** True when some offered statement or pair was not examined, or reporting stopped at the findings cap. */
  incomplete: boolean
  statementsOffered: number
  statementsVisited: number
  /** Statements that passed the size gates and produced claims. */
  statementsExamined: number
  /** UTF-16 units of statement text preprocessed. */
  textUnits: number
  claims: number
  /** Pair iterations attempted, bounded by MAX_CONSISTENCY_COMPARISONS. */
  comparisons: number
}

/**
 * Which source supplied the confirmed records for an assembly.
 *
 * This mirrors the internal `HistorySource` union in src/dialogue/context.ts
 * and must be kept in sync with it.
 *
 *  - 'history-port': the durable source (M6). Authoritative.
 *  - 'local-stand-in': the in-memory store, used only because no durable source
 *    was supplied. An offline/test stand-in that must never be mistaken for
 *    durable history.
 *  - 'none': no source at all, so the assembly carries no confirmed history.
 */
export type InspectHistorySource = 'history-port' | 'local-stand-in' | 'none'

/**
 * Redacted memory inspection for one turn.
 *
 * Redaction boundary, by default: identifiers, counts, reasons and character
 * counts only. Never the text of a memory or of persona content. The
 * consistency summary follows the same boundary: counts and a completeness flag.
 */
export interface MemoryInspectPayload {
  /** Payload shape version; a consumer refuses an unknown value. */
  schemaVersion: typeof MEMORY_INSPECT_SCHEMA_VERSION
  sessionId: string
  turnId: string
  /** The intent the reply was generated under. */
  replyIntent: string
  admission: InspectAdmission
  recall: {
    /** Recalled persona FACTS injected and dropped (budget), with counts. */
    persona: { used: number; dropped: number }
    /** Recalled TURNS injected and dropped (budget), with counts. */
    delivery: { used: number; dropped: number }
    /** The recalls actually injected, with score and structured provenance. */
    results: readonly InspectRecall[]
  }
  budget: {
    /** Estimated characters charged to the shared context budget. */
    estimatedCharacters: number
    truncatedByTurnLimit: boolean
    truncatedByCharacterLimit: boolean
  }
  /**
   * Redacted completion summary of the consistency audit (./consistency):
   * counts and a completeness flag only, never statement text.
   *
   * `incomplete: true` is a first-class state. A zero `findings` with
   * `incomplete: true` means the audit was cut short and is NOT an all-clear;
   * a consumer must render it as "partial audit" and must not present the zero
   * as evidence of no contradictions.
   */
  consistency: InspectConsistencySummary
  /** Where the assembled history came from. */
  historySource: InspectHistorySource
  warnings: readonly string[]
}

/** Successful protocol-1 reply payload for the inspection kind. */
export interface MemoryInspectReplyPayload {
  /** Section identifier; refused when it does not match. */
  section: typeof MEMORY_INSPECT_SECTION
  inspect: MemoryInspectPayload
}

/*
 * Reply envelope additions, on this file rather than in ./protocol so the
 * protocol module keeps its existing shape for every other kind. `outcome`
 * separates "there is no inspection to report" from a protocol error: a
 * stopped or not-yet-started runtime is a valid, correlatable answer, not a
 * malformed request.
 */
export type MemoryInspectOutcome = 'observed' | 'unavailable'

export interface MemoryInspectUnavailable {
  section: typeof MEMORY_INSPECT_SECTION
  outcome: 'unavailable'
  /** Why no observation exists; a fixed reason, never free text from the model. */
  reason: 'no-observation' | 'diag-plane-unavailable'
}

export type MemoryInspectReply = MemoryInspectReplyPayload | MemoryInspectUnavailable
