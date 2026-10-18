import { randomUUID } from 'node:crypto'
import type { RuntimeComposition } from './composition'
import type { ArchiveSelectionConfig, ArchiveSource, SessionProfile } from './session-archives'
import { DEFAULT_MAX_ARCHIVE_SOURCES, validateArchiveSelection } from './session-archives'

/**
 * M5 explicit session recovery (operator-driven, same backing store).
 *
 * A disconnect after playback started leaves the retired session's delivery
 * evidence unconfirmed and its physical occupancy unknown, so the retained
 * session cannot produce new output. Recovery retires that session and starts a
 * fresh successor whose context is reconstructed from confirmed history alone.
 *
 * This module owns only the selection lineage and the recovery state machine.
 * It does not touch connections, transport or media: `application.ts` retires the
 * old scheduling/connections and adopts the successor this module returns. The
 * actual successor composition is built by a caller-supplied factory, so the
 * composition entry (`createReconstructedRuntimeComposition`) is reused rather
 * than duplicated here.
 *
 * Guarantees
 * ----------
 * - Retiring a session never removes it: its id is appended to the ordered
 *   archive sources and its profile is added to the trusted catalogue, so a
 *   later successor reconstructs it through the existing mechanism.
 * - Earlier selected sources are never dropped. Exceeding the archive-source
 *   bound is an explicit refusal, never a silent truncation.
 * - A failed construction leaves the lineage untouched: the retiring session
 *   stays current and a retry is possible. No second live runtime is created.
 * - A concurrent or repeated request for the same retiring session shares one
 *   successor; a request for an already-retired session is answered
 *   idempotently instead of creating another successor.
 * - Only confirmed history is carried: the successor's reconstruction reads the
 *   base M6 history, which returns fully-delivered records only. Unknown and
 *   partial outcomes are never promoted to speech.
 *
 * Durability is out of scope: this is lifecycle recovery over an existing
 * (for example in-memory) store, not disk/process-crash recovery.
 */

/** Builds one runtime composition over a validated reconstruction selection. */
export type RecoveryCompositionFactory = (
  selection: ArchiveSelectionConfig,
) => Promise<RuntimeComposition>

export type RecoveryErrorCode =
  | 'unknown_session'
  | 'source_limit'
  | 'construction_failed'

export class RecoveryError extends Error {
  readonly code: RecoveryErrorCode

  constructor(code: RecoveryErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RecoveryError'
    this.code = code
  }
}

/**
 * Result of one recovery attempt. `applied` carries the successor composition
 * this request installed; `already_recovered` means a predecessor request (or a
 * concurrent one) already installed the successor.
 */
export type RecoveryResult =
  | {
      readonly status: 'applied'
      readonly composition: RuntimeComposition
      readonly retiredSessionId: string
      readonly sessionId: string
      readonly recoveries: number
      readonly remainingRecoveries: number
    }
  | {
      readonly status: 'already_recovered'
      readonly retiredSessionId: string
      readonly sessionId: string
      readonly recoveries: number
      readonly remainingRecoveries: number
    }

export interface RecoveryStatus {
  readonly sessionId: string
  readonly recoveries: number
  /** Further recoveries permitted before the archive-source bound is reached. */
  readonly remainingRecoveries: number
  readonly inProgress: boolean
  /** The last failed recovery reason, cleared by a later success. */
  readonly lastErrorCode: RecoveryErrorCode | null
}

export interface SessionRecovery {
  currentComposition(): RuntimeComposition
  currentSessionId(): string
  status(): RecoveryStatus
  /**
   * Retire `retiredSessionId` and build a fresh successor. Idempotent for an
   * already-retired id and deduplicated for concurrent requests.
   */
  recover(retiredSessionId: string): Promise<RecoveryResult>
}

export interface SessionRecoveryOptions {
  /** The initial reconstruction selection; validated once at construction. */
  initialSelection: ArchiveSelectionConfig
  build: RecoveryCompositionFactory
  /** Fresh successor live-session id; defaults to a random `session-` id. */
  nextSessionId?: () => string
  /** Upper bound on archive sources; recovery never drops an earlier source. */
  maxSources?: number
}

export async function createSessionRecovery(
  options: SessionRecoveryOptions,
): Promise<SessionRecovery> {
  const maxSources = options.maxSources ?? DEFAULT_MAX_ARCHIVE_SOURCES
  const nextSessionId = options.nextSessionId ?? (() => `session-${randomUUID()}`)

  // Validate the initial selection through the same path a successor uses, so
  // the bound, the catalogue and the live/archive identity rules are identical.
  const initial = validateArchiveSelection({ ...options.initialSelection, maxSources })
  const profile: SessionProfile = initial.liveProfile

  let liveSessionId = initial.liveSessionId
  let sources: ArchiveSource[] = initial.sources.map((source) => ({ sessionId: source.sessionId }))
  let catalogue: Map<string, SessionProfile> = new Map(
    initial.sources.map((source) => [source.sessionId, source.profile]),
  )
  let recoveries = 0
  let lastErrorCode: RecoveryErrorCode | null = null
  let inFlight: Promise<RecoveryResult> | null = null
  /** Live sessions already retired by a successful recovery (never archives). */
  const retiredLiveSessionIds = new Set<string>()

  const selectionFor = (
    nextLiveSessionId: string,
    nextSources: readonly ArchiveSource[],
    nextCatalogue: ReadonlyMap<string, SessionProfile>,
  ): ArchiveSelectionConfig => ({
    liveSessionId: nextLiveSessionId,
    liveProfile: profile,
    selectedSources: nextSources.map((source) => ({ sessionId: source.sessionId })),
    catalogue: new Map(nextCatalogue),
    maxSources,
  })

  // Build the initial runtime. Its identity is the caller's initial live id, so
  // the returned composition and the lineage agree from the start.
  let composition = await options.build(selectionFor(liveSessionId, sources, catalogue))

  const remainingRecoveries = (): number => maxSources - sources.length

  const runRecovery = async (retiredSessionId: string): Promise<RecoveryResult> => {
    if (sources.length + 1 > maxSources) {
      lastErrorCode = 'source_limit'
      throw new RecoveryError(
        'source_limit',
        `recovery would exceed the ${maxSources}-source archive bound; earlier history is retained`,
      )
    }
    const successorSessionId = nextSessionId()
    const successorSources = [...sources, { sessionId: retiredSessionId }]
    const successorCatalogue = new Map(catalogue)
    successorCatalogue.set(retiredSessionId, profile)
    let successor: RuntimeComposition
    try {
      successor = await options.build(
        selectionFor(successorSessionId, successorSources, successorCatalogue),
      )
    } catch (error) {
      lastErrorCode = 'construction_failed'
      throw new RecoveryError(
        'construction_failed',
        `failed to construct the successor session for ${retiredSessionId}`,
        { cause: error },
      )
    }
    // Commit the lineage only after the successor exists, so a failure above
    // leaves the retiring session current and the store untouched.
    retiredLiveSessionIds.add(retiredSessionId)
    sources = successorSources
    catalogue = successorCatalogue
    recoveries += 1
    liveSessionId = successorSessionId
    composition = successor
    lastErrorCode = null
    return {
      status: 'applied',
      composition: successor,
      retiredSessionId,
      sessionId: successorSessionId,
      recoveries,
      remainingRecoveries: remainingRecoveries(),
    }
  }

  return {
    currentComposition: () => composition,
    currentSessionId: () => liveSessionId,
    status: () => ({
      sessionId: liveSessionId,
      recoveries,
      remainingRecoveries: remainingRecoveries(),
      inProgress: inFlight !== null,
      lastErrorCode,
    }),
    recover(retiredSessionId) {
      if (retiredSessionId !== liveSessionId) {
        // A request for an already-retired live session is answered idempotently
        // rather than creating another successor.
        if (retiredLiveSessionIds.has(retiredSessionId)) {
          return Promise.resolve({
            status: 'already_recovered',
            retiredSessionId,
            sessionId: liveSessionId,
            recoveries,
            remainingRecoveries: remainingRecoveries(),
          })
        }
        return Promise.reject(
          new RecoveryError(
            'unknown_session',
            `${retiredSessionId} is neither the current nor a retired session`,
          ),
        )
      }
      // Concurrent requests for the current session share one successor.
      if (inFlight !== null) return inFlight
      const run = runRecovery(retiredSessionId)
      inFlight = run
      // Clearing in a separate reaction keeps `run` immutable for the callers
      // that already hold it; both settlement paths clear the shared slot.
      run.then(
        () => {
          if (inFlight === run) inFlight = null
        },
        () => {
          if (inFlight === run) inFlight = null
        },
      )
      return run
    },
  }
}
