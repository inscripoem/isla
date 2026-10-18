import type { ConfirmedDelivery, HistoryQueryPort } from '../contracts'

/**
 * M5 archived-session selection and reconstruction (C7; issue #22).
 *
 * After a restart, a fresh live session must be able to continue from confirmed
 * spoken history of earlier sessions. M5 owns the selection: the operator (or
 * persisted configuration) supplies an ORDERED list of archive sources and a
 * trusted session-to-persona catalogue. M4 never discovers databases or guesses
 * their contents; it only consumes the `HistoryQueryPort` this module composes.
 *
 * Guarantees
 * ----------
 * - The selection is validated and snapshotted once at construction: a later
 *   external mutation of the caller's config or catalogue cannot change it.
 * - Invalid selections are rejected explicitly: duplicate sources, the live
 *   session in the archive list, missing (`unknown`) or identity-incompatible
 *   catalogue entries, and an over-large source list (no silent truncation).
 * - Each query for the live session returns the selected archives in the given
 *   order followed by the live session last. Each source keeps its own
 *   supporting-event order; session-local `seq` values are never compared
 *   globally.
 * - A source record whose session does not match the requested source, or whose
 *   KNOWN persona identity contradicts the trusted catalogue, is a hard failure
 *   (fail-closed). A null or half-known attribution is preserved as-is and never
 *   inferred from the live profile.
 * - A source read failure is visible and fail-closed: the port throws before M4
 *   can dispatch any new speech, rather than silently substituting an empty or
 *   local-only history.
 *
 * Durability is out of scope: this is lifecycle reconstruction over an existing
 * (for example in-memory) store, not disk/process-crash recovery. SQLite
 * catalogue/discovery/migrations and durable recovery remain M6's #25 work.
 */

export interface SessionProfile {
  readonly profileId: string
  readonly profileVersion: string
}

/** Trusted session-to-persona metadata: source session id -> expected profile. */
export type SessionProfileCatalogue = ReadonlyMap<string, SessionProfile>

export interface ArchiveSource {
  readonly sessionId: string
}

export interface ArchiveSelectionConfig {
  readonly liveSessionId: string
  readonly liveProfile: SessionProfile
  /** Ordered archive sources; the port preserves this order. */
  readonly selectedSources: readonly ArchiveSource[]
  readonly catalogue: SessionProfileCatalogue
  /** Upper bound on selected sources. Exceeding it is an error, never a truncation. */
  readonly maxSources?: number
}

export type ArchiveSelectionErrorCode =
  | 'empty_live_session'
  | 'invalid_live_profile'
  | 'duplicate_source'
  | 'live_session_in_sources'
  | 'live_session_reused'
  | 'too_many_sources'
  | 'invalid_bounds'
  | 'unknown_session_profile'
  | 'incompatible_session_profile'

export class ArchiveSelectionError extends Error {
  readonly code: ArchiveSelectionErrorCode

  constructor(code: ArchiveSelectionErrorCode, message: string) {
    super(message)
    this.name = 'ArchiveSelectionError'
    this.code = code
  }
}

export const DEFAULT_MAX_ARCHIVE_SOURCES = 8

/**
 * A bound is a positive-or-zero safe integer for a count of sources, or a
 * positive safe integer for a count of records. NaN, Infinity, negative and
 * fractional values are rejected rather than silently changing a limit.
 */
function assertBound(value: number | undefined, name: string, minimum: number): number {
  if (value === undefined) {
    throw new ArchiveSelectionError('invalid_bounds', `${name} must be provided`)
  }
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new ArchiveSelectionError(
      'invalid_bounds',
      `${name} must be a safe integer >= ${minimum}, got ${String(value)}`,
    )
  }
  return value
}

export interface SelectedArchiveSource {
  readonly sessionId: string
  readonly profile: SessionProfile
}

export interface ValidatedArchiveSelection {
  readonly liveSessionId: string
  readonly liveProfile: SessionProfile
  readonly sources: readonly SelectedArchiveSource[]
}

function assertCompleteProfile(
  profile: SessionProfile,
  code: ArchiveSelectionErrorCode,
  label: string,
): void {
  if (profile.profileId.length === 0 || profile.profileVersion.length === 0) {
    throw new ArchiveSelectionError(
      code,
      `${label} must have a non-empty profileId and profileVersion`,
    )
  }
}

/**
 * Validate and snapshot one archive selection. The returned value is frozen and
 * detaches from the caller's arrays, maps and profile objects, so mutation after
 * startup cannot change the selection.
 */
export function validateArchiveSelection(config: ArchiveSelectionConfig): ValidatedArchiveSelection {
  if (config.liveSessionId.length === 0) {
    throw new ArchiveSelectionError('empty_live_session', 'liveSessionId must be non-empty')
  }
  assertCompleteProfile(config.liveProfile, 'invalid_live_profile', 'liveProfile')

  const maxSources =
    config.maxSources === undefined
      ? DEFAULT_MAX_ARCHIVE_SOURCES
      : assertBound(config.maxSources, 'maxSources', 0)
  if (config.selectedSources.length > maxSources) {
    throw new ArchiveSelectionError(
      'too_many_sources',
      `at most ${maxSources} archive sources are allowed, got ${config.selectedSources.length}`,
    )
  }
  if (config.catalogue.has(config.liveSessionId)) {
    throw new ArchiveSelectionError(
      'live_session_reused',
      'the live session id must not reuse a catalogued archive session',
    )
  }

  const seen = new Set<string>()
  const sources: SelectedArchiveSource[] = []
  for (const source of config.selectedSources) {
    if (source.sessionId.length === 0) {
      throw new ArchiveSelectionError('unknown_session_profile', 'archive source sessionId must be non-empty')
    }
    if (source.sessionId === config.liveSessionId) {
      throw new ArchiveSelectionError(
        'live_session_in_sources',
        'the live session cannot also be an archive source',
      )
    }
    if (seen.has(source.sessionId)) {
      throw new ArchiveSelectionError('duplicate_source', `duplicate archive source ${source.sessionId}`)
    }
    seen.add(source.sessionId)

    const profile = config.catalogue.get(source.sessionId)
    if (profile === undefined) {
      throw new ArchiveSelectionError(
        'unknown_session_profile',
        `no trusted session-profile catalogue entry for ${source.sessionId}`,
      )
    }
    assertCompleteProfile(profile, 'unknown_session_profile', `catalogue entry for ${source.sessionId}`)
    // Same identity is required; a different version of the SAME identity is
    // allowed (see the module contract). A different identity is incompatible.
    if (profile.profileId !== config.liveProfile.profileId) {
      throw new ArchiveSelectionError(
        'incompatible_session_profile',
        `archive source ${source.sessionId} belongs to a different persona identity`,
      )
    }
    sources.push({
      sessionId: source.sessionId,
      profile: { profileId: profile.profileId, profileVersion: profile.profileVersion },
    })
  }

  return Object.freeze({
    liveSessionId: config.liveSessionId,
    liveProfile: Object.freeze({ ...config.liveProfile }),
    // Deep copy/freeze: the nested profile is immutable too, so neither a change
    // to the caller's config nor mutation through the returned selection can
    // alter reconstruction.
    sources: Object.freeze(
      sources.map((source) =>
        Object.freeze({
          sessionId: source.sessionId,
          profile: Object.freeze({ ...source.profile }),
        }),
      ),
    ),
  })
}

export type ArchiveHistoryErrorCode =
  | 'source_read_failed'
  | 'source_session_mismatch'
  | 'source_persona_mismatch'
  | 'live_session_mismatch'
  | 'live_persona_mismatch'
  | 'unscoped_session_request'
  | 'source_too_large'

export class ArchiveHistoryError extends Error {
  readonly code: ArchiveHistoryErrorCode
  readonly sessionId: string

  constructor(code: ArchiveHistoryErrorCode, sessionId: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ArchiveHistoryError'
    this.code = code
    this.sessionId = sessionId
  }
}

export interface ReconstructedHistoryDeps {
  readonly selection: ValidatedArchiveSelection
  /**
   * Reads one session's confirmed records from the durable store, already in
   * that session's supporting-event order. The live session and every archive
   * source are read through this same reader.
   */
  readSessionHistory(sessionId: string): Promise<ConfirmedDelivery[]>
  /** Per-source record bound. Exceeding it is an error, never a truncation. */
  readonly maxRecordsPerSource?: number
}

export const DEFAULT_MAX_RECORDS_PER_SOURCE = 2000

/**
 * Compose the live session's `HistoryQueryPort` view: selected archives in order,
 * then the live session last.
 *
 * Every record is validated before it is returned, for the live session and for
 * an archive source alike, so a caller cannot obtain unvalidated records by
 * querying a selected source directly. The view is scoped to its configured live
 * session: a query for the live session returns the ordered composition, a query
 * for a selected source is validated, and any other session is rejected rather
 * than forwarded. Raw archive reads remain available through the base history
 * port.
 */
export function createReconstructedHistoryPort(deps: ReconstructedHistoryDeps): HistoryQueryPort {
  const { selection } = deps
  const maxRecords =
    deps.maxRecordsPerSource === undefined
      ? DEFAULT_MAX_RECORDS_PER_SOURCE
      : assertBound(deps.maxRecordsPerSource, 'maxRecordsPerSource', 1)
  const sourceById = new Map(selection.sources.map((source) => [source.sessionId, source]))

  async function readRecords(
    sessionId: string,
    expectedProfileId: string,
    sessionMismatchCode: ArchiveHistoryErrorCode,
    personaMismatchCode: ArchiveHistoryErrorCode,
  ): Promise<ConfirmedDelivery[]> {
    let records: ConfirmedDelivery[]
    try {
      records = await deps.readSessionHistory(sessionId)
    } catch (error) {
      throw new ArchiveHistoryError(
        'source_read_failed',
        sessionId,
        `failed to read session ${sessionId}`,
        { cause: error },
      )
    }
    if (records.length > maxRecords) {
      throw new ArchiveHistoryError(
        'source_too_large',
        sessionId,
        `session ${sessionId} has ${records.length} records, at most ${maxRecords} are allowed`,
      )
    }
    for (const record of records) {
      if (record.sessionId !== sessionId) {
        throw new ArchiveHistoryError(
          sessionMismatchCode,
          sessionId,
          `record ${record.segmentId} does not belong to session ${sessionId}`,
        )
      }
      // Only a KNOWN identity that contradicts the trusted profile is a failure.
      // Null and half-known raw fields are preserved, never inferred.
      if (record.personaProfileId !== null && record.personaProfileId !== expectedProfileId) {
        throw new ArchiveHistoryError(
          personaMismatchCode,
          sessionId,
          `record ${record.segmentId} carries a persona identity inconsistent with the trusted profile`,
        )
      }
    }
    return records
  }

  return {
    async confirmedHistory(requestedSessionId) {
      if (requestedSessionId === selection.liveSessionId) {
        const archived: ConfirmedDelivery[] = []
        for (const source of selection.sources) {
          archived.push(
            ...(await readRecords(
              source.sessionId,
              source.profile.profileId,
              'source_session_mismatch',
              'source_persona_mismatch',
            )),
          )
        }
        const live = await readRecords(
          selection.liveSessionId,
          selection.liveProfile.profileId,
          'live_session_mismatch',
          'live_persona_mismatch',
        )
        // Archives first (selection order, each in its own seq order), live
        // session last. Session-local seq is never merged or compared across
        // sessions, and restored records are never hidden by new local deliveries.
        return [...archived, ...live]
      }

      // A selected source is still validated, so a direct query cannot bypass the
      // trusted catalogue. Any other session is rejected: this view is scoped to
      // its configured live session and must not forward arbitrary base history,
      // which would bypass the selected sources. Callers that want a raw archive
      // read use the base history port directly.
      const source = sourceById.get(requestedSessionId)
      if (source !== undefined) {
        return readRecords(
          source.sessionId,
          source.profile.profileId,
          'source_session_mismatch',
          'source_persona_mismatch',
        )
      }
      throw new ArchiveHistoryError(
        'unscoped_session_request',
        requestedSessionId,
        `the reconstructed history view is scoped to its live session and does not serve ${requestedSessionId}`,
      )
    },
  }
}
