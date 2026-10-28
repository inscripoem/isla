import type {
  ClockPort,
  EventStorePort,
  HistoryQueryPort,
  ReactionPort,
  RendererPort,
  SelectionPort,
  SynthesisPort,
} from '../contracts'
import type { DialogueTextSource } from '../dialogue/dialogue-port'
import type { PersonaRecallPort } from '../dialogue/persona-recall'
import type { AudioLease } from '../performance/browser/types'
import type { StorageConfig } from '../storage/config'
import { createEventStore } from '../storage/event-store'
import { createHistoryQuery } from '../storage/history-query'
import { createSqliteBackend } from '../storage/sqlite/backend'
import { openDatabase } from '../storage/sqlite/database'
import { migrate } from '../storage/sqlite/migrations'
import { createApplicationEndpoint } from './application'
import type { ApplicationDiagnostic, ApplicationEndpoint } from './application'
import { createMonotonicClock } from './clock'
import type { CompositionAudioResources, RuntimeComposition } from './composition'
import { createReconstructedRuntimeComposition } from './composition'
import type { CycleTimings, RuntimeCoordinator, SessionProfileConfig } from './coordinator'
import { createRuntimeAuthorizer } from './control-policy'
import { createDeadlineGate } from './deadline'
import type { RuntimeDeadlineGate } from './deadline'
import type { DialogueOutcomeObserver } from './dialogue-outcome'
import { DiagnosticsServer } from './server'
import type { ArchiveSelectionConfig } from './session-archives'
import { createSessionRecovery } from './session-recovery'
import type { SessionRecovery } from './session-recovery'

/**
 * M5 production composition and durable application lifecycle.
 *
 * One application instance owns the shared SQLite handle, the M6 store and
 * history view over it, the operator-driven session recovery controller and the
 * loopback HTTP/WebSocket server. Every composition (the initial one and each
 * successor) is built through the production reconstruction entry with its own
 * deadline gate, so a recovered session never shares a gate, renderer, bridge or
 * coordinator with its predecessor.
 *
 * Peer modules are injected. This module makes no provider assumption, imports
 * no test code and exposes no fault switch: a deployment supplies the M3/M4/M1
 * factories, and a missing or malformed peer fails visibly at creation. Durable
 * behavior is the real M6 SQLite backend; the application does not reimplement
 * storage.
 *
 * A deployment that acquires long-lived resources before the application exists
 * (for example the retained M1 physical synthesis provider) hands the
 * application one `ownedRelease` cleanup. It is awaited after the durable
 * shutdown drain, so `stop()` resolves only after the owned lifecycle contract
 * has actually completed, and it is awaited by a failed creation so an acquired
 * provider is never leaked. A release fault never replaces the failure it
 * accompanied and is never discarded: a failed creation reports both, and a
 * shutdown preserves every failed phase (one labeled failure or an aggregate)
 * and stays incomplete for every later stop caller.
 */

/**
 * M1 controlled audio resources as the production application consumes them:
 * the composition retirement seam plus the serving queries the `/audio` route
 * needs. The M1 `AudioResourceRegistry` satisfies this structurally; the
 * composition seam (`CompositionAudioResources`) stays narrow, so a composition
 * still cannot serve bytes.
 */
export interface ProductionAudioResources extends CompositionAudioResources {
  /** Pure admission query for one reference and its original session/epoch. */
  admission(audioRef: string, sessionId: string, epoch: number): string | null
  /** Resolve an admitted reference to an owned lease; failures are refusals. */
  resolve(audioRef: string, signal: AbortSignal): Promise<AudioLease>
}

/**
 * Peer ports and per-composition factories a deployment must supply.
 *
 * The renderer and synthesis factories receive the composition's own deadline
 * gate. A live provider must bind its provider work to that gate, so a Stop or
 * stage deadline reaches the peer without a second gate.
 */
export interface ProductionPeers {
  /** M3 selection port; reused by every composition. */
  readonly selection: SelectionPort
  /** M3 reaction port; reused by every composition. */
  readonly reaction: ReactionPort
  /** M4 provider seam; M4's own composition remains the production dialogue path. */
  readonly textSource: DialogueTextSource
  /** Optional M4 persona fact recall. */
  readonly personaRecall?: PersonaRecallPort
  /** M1 renderer factory; must bind the mapped renderer to the supplied gate. */
  readonly createRenderer: (gate: RuntimeDeadlineGate) => RendererPort
  /** M1 synthesis factory; must bind provider work to the supplied gate. */
  readonly createSynthesis: (gate: RuntimeDeadlineGate) => SynthesisPort
  /**
   * M1 controlled audio resources: epoch retirement on Stop, session retirement
   * on dispose, and the serving queries behind the `POST /audio` route.
   */
  readonly audioResources?: ProductionAudioResources
  /** Non-character session profile fields (for example voice identity). */
  readonly profile?: Partial<SessionProfileConfig>
  /** Validated stage timings applied to every composition. */
  readonly timings?: Partial<CycleTimings>
  readonly inputTtlMs?: number
  readonly storageTtlMs?: number
  readonly cancelTtlMs?: number
  readonly maxPendingInputs?: number
  /**
   * Observational consumer of the dialogue port's projected generation/discard
   * accounting (see `DialogueOutcomeObserver`). It is wired into the initial
   * composition and into every recovery successor, so a recovered session reports
   * on the same channel. It adds no storage write of its own (M5 owns the runtime's
   * persistence and delivery decisions, M6 owns the storage infrastructure) and
   * never counts as a provider attempt. Omitted means no reporting.
   */
  readonly onDialogueOutcome?: DialogueOutcomeObserver
}

/**
 * Deployment module contract. A module at an explicit path exports a factory
 * (named `createProductionDeployment` or as the default export) that receives
 * the server clock, the resolved database path and the process environment, and
 * returns the peers, the initial reconstruction selection and the transport
 * origin allowlist for this deployment.
 */
export interface ProductionDeploymentContext {
  readonly clock: ClockPort
  readonly databasePath: string
  readonly env: Readonly<Record<string, string | undefined>>
}

export interface ProductionDeployment {
  readonly peers: ProductionPeers
  readonly initialSelection: ArchiveSelectionConfig
  /** Exact canonical origins permitted to open an application socket. */
  readonly allowedOrigins: readonly string[]
  /** Exact allowed Host header values; omitted means loopback-only hosts. */
  readonly allowedHosts?: readonly string[]
  /**
   * Deployment-owned cleanup for resources acquired before application
   * creation, for example the retained physical synthesis provider. It is
   * idempotent and resolves only after the owned lifecycle contract has actually
   * completed (for example the worker's observed exit). The application awaits
   * it on shutdown; a failed application creation awaits it before the failure
   * is reported. A release fault is reported with the failure it accompanied,
   * and an incomplete shutdown stays observable to every later stop caller.
   */
  readonly release?: () => Promise<void>
}

export type ProductionDeploymentFactory = (
  context: ProductionDeploymentContext,
) => ProductionDeployment | Promise<ProductionDeployment>

export interface ProductionRecoveryOptions {
  /** Upper bound on archive sources; recovery never drops an earlier source. */
  readonly maxSources?: number
  /** Fresh successor live-session id; defaults to a random `session-` id. */
  readonly nextSessionId?: () => string
}

export interface ProductionApplicationOptions {
  /** Resolved storage location; the CLI derives it from `ISLA_STORAGE_DB_PATH`. */
  readonly storage: StorageConfig
  /** Initial reconstruction selection; its live id must be fresh in the store. */
  readonly initialSelection: ArchiveSelectionConfig
  readonly peers: ProductionPeers
  /** Exact canonical origins permitted to open an application socket. */
  readonly allowedOrigins: readonly string[]
  readonly allowedHosts?: readonly string[]
  readonly host?: string
  readonly port?: number
  readonly graceMs?: number
  /** Time source; defaults to the server monotonic clock. */
  readonly clock?: ClockPort
  readonly recovery?: ProductionRecoveryOptions
  /**
   * Deployment-owned cleanup passed through from the deployment (for example
   * the retained physical provider's release). Awaited after the durable
   * shutdown drain and by a failed creation; idempotent. A fault is reported
   * alongside the failure it accompanied, and an incomplete shutdown stays
   * observable to every later stop caller.
   */
  readonly ownedRelease?: () => Promise<void>
  /** Optional local sink for bounded application-internal failure records. */
  readonly onDiagnostic?: (diagnostic: ApplicationDiagnostic) => void
}

export type ProductionApplicationState = 'created' | 'started' | 'stopped'

export interface ProductionApplication {
  readonly storage: StorageConfig
  readonly databasePath: string
  readonly store: EventStorePort
  readonly history: HistoryQueryPort
  readonly recovery: SessionRecovery
  readonly endpoint: ApplicationEndpoint
  readonly server: DiagnosticsServer
  state(): ProductionApplicationState
  /** The live session id, reflecting a recovery when one has been applied. */
  currentSessionId(): string
  /** The live composition, reflecting a recovery when one has been applied. */
  currentComposition(): RuntimeComposition
  /** Starts the loopback server. Rejects when not in the `created` state. */
  start(): Promise<{ host: string; port: number }>
  /**
   * Controlled shutdown: close the construction boundary, stop the transport,
   * drain an in-flight composition build, release every composition, await
   * every admitted store/memory write (a late callback is refused without
   * touching storage), then close the shared SQLite handle and await the
   * deployment-owned release (for example the retained provider's observed
   * worker exit). Cleanup runs once. After a successful stop the handle is
   * closed and no further write can succeed; a shutdown whose phases failed
   * stays incomplete, every failed phase survives in the reported error (one
   * labeled failure or an aggregate), and every later call rejects with that
   * same failure instead of reporting success. Also valid when `start()` was
   * never called or failed.
   */
  stop(): Promise<void>
}

function missingPeer(field: string, expected: string): TypeError {
  return new TypeError(
    `production application requires ${field} (${expected}); missing or invalid deployment configuration`,
  )
}

function assertPeerMethod(
  holder: unknown,
  holderName: string,
  method: string,
  expected: string,
): void {
  if (holder === null || typeof holder !== 'object') {
    throw missingPeer(holderName, expected)
  }
  const candidate = (holder as Record<string, unknown>)[method]
  if (typeof candidate !== 'function') {
    throw missingPeer(`${holderName}.${method}`, expected)
  }
}

/** Validates the injected peer set once, before any database handle is opened. */
export function validateProductionPeers(peers: ProductionPeers): void {
  if (peers === null || typeof peers !== 'object') {
    throw missingPeer('peers', 'ProductionPeers')
  }
  assertPeerMethod(peers.selection, 'peers.selection', 'select', 'M3 SelectionPort')
  assertPeerMethod(peers.reaction, 'peers.reaction', 'decide', 'M3 ReactionPort')
  assertPeerMethod(peers.textSource, 'peers.textSource', 'compose', 'M4 DialogueTextSource')
  if (typeof peers.createRenderer !== 'function') {
    throw missingPeer('peers.createRenderer(gate)', 'M1 RendererPort factory')
  }
  if (typeof peers.createSynthesis !== 'function') {
    throw missingPeer('peers.createSynthesis(gate)', 'M1 SynthesisPort factory')
  }
  if (peers.audioResources !== undefined) {
    assertPeerMethod(peers.audioResources, 'peers.audioResources', 'retireBefore', 'M1 AudioResourceRegistry')
    assertPeerMethod(peers.audioResources, 'peers.audioResources', 'retireSession', 'M1 AudioResourceRegistry')
    assertPeerMethod(peers.audioResources, 'peers.audioResources', 'admission', 'M1 AudioResourceRegistry')
    assertPeerMethod(peers.audioResources, 'peers.audioResources', 'resolve', 'M1 AudioResourceRegistry')
  }
}

/** One-line failure text for a combined lifecycle error. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Builds the production application over a real SQLite database.
 *
 * Creation opens and migrates the database, creates the store/history view over
 * it and builds the initial composition through the recovery controller. The
 * composition starts stopped and dispatches nothing; the server is not started
 * until `start()` is called. A failure after the handle was opened — including a
 * failure while building the initial composition or while creating the endpoint —
 * releases every composition built so far and closes the handle before rejecting.
 *
 * The deployment (and therefore any owned provider) already exists when this
 * call starts, so every failure path also awaits the deployment-owned release
 * before the failure is reported. The release is not assumed to be
 * non-rejecting: a release fault is reported alongside the original creation
 * failure rather than replacing it or being discarded, and the combined error
 * keeps the original failure as its cause. A successful creation passes
 * ownership of that release to the returned application, which awaits it in
 * `stop()`.
 */
export async function createProductionApplication(
  options: ProductionApplicationOptions,
): Promise<ProductionApplication> {
  try {
    return await buildProductionApplication(options)
  } catch (error) {
    if (options !== null && typeof options === 'object' && typeof options.ownedRelease === 'function') {
      try {
        await options.ownedRelease()
      } catch (releaseError) {
        throw new Error(
          `production application creation failed: ${errorText(error)}; owned release failed: ${errorText(releaseError)}`,
          { cause: error },
        )
      }
    }
    throw error
  }
}

async function buildProductionApplication(
  options: ProductionApplicationOptions,
): Promise<ProductionApplication> {
  validateProductionPeers(options.peers)
  if (
    options.storage === null ||
    typeof options.storage !== 'object' ||
    typeof options.storage.dbPath !== 'string' ||
    options.storage.dbPath.length === 0
  ) {
    throw new TypeError(
      'production application requires a storage configuration with a non-empty dbPath',
    )
  }
  if (options.initialSelection === null || typeof options.initialSelection !== 'object') {
    throw new TypeError('production application requires an initial archive selection')
  }
  if (!Array.isArray(options.allowedOrigins) || options.allowedOrigins.length === 0) {
    throw new TypeError('production application requires at least one allowed origin')
  }
  if (options.ownedRelease !== undefined && typeof options.ownedRelease !== 'function') {
    throw new TypeError(
      'production application requires ownedRelease to be a function when supplied',
    )
  }

  const clock = options.clock ?? createMonotonicClock()
  const peers = options.peers
  const database = openDatabase(options.storage.dbPath)
  let databaseOpen = true
  // Every composition built over this database, every build still in flight and
  // the shutdown boundary. Shutdown drains admitted builds and releases every
  // composition before the shared handle closes; the boundary refuses a new
  // build synchronously so a late recovery cannot race the closing handle.
  const compositions = new Set<RuntimeComposition>()
  const coordinators = new Set<RuntimeCoordinator>()
  const pendingBuilds = new Set<Promise<RuntimeComposition>>()
  let shuttingDown = false
  try {
    migrate(database, {
      dbPath: options.storage.dbPath,
      backupDir: options.storage.backupDir,
    })
    const backend = createSqliteBackend(database)
    const store = createEventStore(backend)
    const history = createHistoryQuery(backend)

    const buildComposition = (selection: ArchiveSelectionConfig): Promise<RuntimeComposition> => {
      if (shuttingDown) {
        return Promise.reject(
          new Error(
            'production application is shutting down; refusing to build another composition',
          ),
        )
      }
      const run = (async () => {
        // One gate per composition: the renderer and the synthesis provider of a
        // composition share exactly this gate, and a successor gets a new one.
        const gate = createDeadlineGate(clock)
        let composition: RuntimeComposition
        try {
          composition = await createReconstructedRuntimeComposition({
            clock,
            authorizer: createRuntimeAuthorizer(),
            selection: peers.selection,
            reaction: peers.reaction,
            store,
            history,
            renderer: peers.createRenderer(gate),
            gate,
            synthesis: peers.createSynthesis(gate),
            ...(peers.audioResources !== undefined
              ? { audioResources: peers.audioResources }
              : {}),
            reconstruction: selection,
            textSource: peers.textSource,
            ...(peers.personaRecall !== undefined ? { personaRecall: peers.personaRecall } : {}),
            ...(peers.profile !== undefined ? { profile: peers.profile } : {}),
            ...(peers.timings !== undefined ? { timings: peers.timings } : {}),
            ...(peers.inputTtlMs !== undefined ? { inputTtlMs: peers.inputTtlMs } : {}),
            ...(peers.storageTtlMs !== undefined ? { storageTtlMs: peers.storageTtlMs } : {}),
            ...(peers.cancelTtlMs !== undefined ? { cancelTtlMs: peers.cancelTtlMs } : {}),
            ...(peers.maxPendingInputs !== undefined
              ? { maxPendingInputs: peers.maxPendingInputs }
              : {}),
            ...(peers.onDialogueOutcome !== undefined
              ? { onDialogueOutcome: peers.onDialogueOutcome }
              : {}),
          })
        } catch (error) {
          // The gate was created here; a failed construction must release it.
          gate.dispose()
          throw error
        }
        compositions.add(composition)
        coordinators.add(composition.coordinator)
        return composition
      })()
      pendingBuilds.add(run)
      const clear = (): void => {
        pendingBuilds.delete(run)
      }
      void run.then(clear, clear)
      return run
    }

    const recovery = await createSessionRecovery({
      initialSelection: options.initialSelection,
      ...(options.recovery?.maxSources !== undefined
        ? { maxSources: options.recovery.maxSources }
        : {}),
      ...(options.recovery?.nextSessionId !== undefined
        ? { nextSessionId: options.recovery.nextSessionId }
        : {}),
      build: buildComposition,
    })

    const endpoint = createApplicationEndpoint({
      composition: recovery.currentComposition(),
      clock,
      allowedOrigins: options.allowedOrigins,
      ...(options.allowedHosts !== undefined ? { allowedHosts: options.allowedHosts } : {}),
      ...(options.onDiagnostic !== undefined ? { onDiagnostic: options.onDiagnostic } : {}),
      ...(peers.audioResources !== undefined ? { audioSource: peers.audioResources } : {}),
      recovery,
    })
    const server = new DiagnosticsServer({
      ...(options.host !== undefined ? { host: options.host } : {}),
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}),
      application: endpoint,
    })

    let state: ProductionApplicationState = 'created'
    // The first incomplete shutdown, preserved so a repeated or concurrent stop
    // caller observes the same failure instead of a fabricated success.
    let stopFailure: unknown = null
    // Serializes start/stop so a stop racing a start can never dispose the
    // endpoint while the server is still binding (or leave it listening).
    let lifecycle: Promise<void> = Promise.resolve()
    function serialize<T>(operation: () => Promise<T>): Promise<T> {
      const run = lifecycle.then(operation, operation)
      lifecycle = run.then(
        () => undefined,
        () => undefined,
      )
      return run
    }

    return {
      storage: options.storage,
      databasePath: options.storage.dbPath,
      store,
      history,
      recovery,
      endpoint,
      server,
      state: () => state,
      currentSessionId: () => recovery.currentSessionId(),
      currentComposition: () => recovery.currentComposition(),

      start() {
        return serialize(async () => {
          if (state !== 'created') {
            throw new Error(`production application cannot start in state "${state}"`)
          }
          const bound = await server.start()
          state = 'started'
          return bound
        })
      },

      stop() {
        return serialize(async () => {
          if (state === 'stopped') {
            // Cleanup already ran. A shutdown whose release or drain failed
            // stays incomplete: a later caller observes the same failure rather
            // than a fabricated success.
            if (stopFailure !== null) throw stopFailure
            return
          }
          state = 'stopped'
          // Close the construction boundary synchronously, before any await, so
          // a late recovery request cannot start a build against the closing
          // handle.
          shuttingDown = true
          // Every phase runs even when an earlier one failed, and every phase
          // failure is preserved: a physical release fault is never hidden
          // behind a transport or drain fault, and the aggregate (or the single
          // failure) is what repeated and concurrent callers observe.
          const failures: Error[] = []
          try {
            if (server.stateLabel === 'started') {
              // Disposes the application endpoint, which disposes the live
              // composition. Retired predecessors were disposed on install.
              await server.stop()
            } else {
              // Never started (or a failed start): release the endpoint and the
              // initial composition directly.
              endpoint.dispose()
            }
          } catch (error) {
            failures.push(
              new Error(
                `production application shutdown: transport shutdown failed: ${errorText(error)}`,
                { cause: error },
              ),
            )
          }
          try {
            // A recovery build already in flight is drained over the still-open
            // handle. Builds only preflight the store and construct objects;
            // they never call a peer provider, so a cancellation-ignoring
            // provider cannot hold this open. No new build can be admitted
            // after the boundary, so this terminates.
            while (pendingBuilds.size > 0) {
              await Promise.allSettled([...pendingBuilds])
            }
            // Release every composition built over this handle, including a
            // successor built during shutdown. Dispose is idempotent, so the
            // endpoint may already have disposed the live composition.
            for (const composition of [...compositions]) {
              try {
                composition.dispose()
              } catch {
                // A dispose fault must not prevent the write drain or close.
              }
            }
            // The first settle closes the coordinator write boundary: a late
            // callback (for example a provider that ignores cancellation and
            // resumes after disposal) is refused without touching storage, and
            // every admitted write drains before the handle closes. Settle
            // never rejects, and a failed write leaves the session degraded
            // rather than throwing here.
            for (const coordinator of [...coordinators]) await coordinator.settle()
            if (databaseOpen) {
              databaseOpen = false
              database.close()
            }
          } catch (error) {
            failures.push(
              new Error(
                `production application shutdown: durable drain failed: ${errorText(error)}`,
                { cause: error },
              ),
            )
          }
          // The owned physical release (for example the retained provider's
          // observed worker exit) is awaited after the store drain: the durable
          // boundary and the physical provider lifecycle stay distinct, and
          // stop() resolves only after the owned contract has actually
          // completed. The release is never assumed to be non-rejecting: a
          // fault names this phase, keeps the original error as its cause and
          // marks the shutdown incomplete.
          if (options.ownedRelease !== undefined) {
            try {
              await options.ownedRelease()
            } catch (error) {
              failures.push(
                new Error(
                  `production application shutdown: owned release failed: ${errorText(error)}`,
                  { cause: error },
                ),
              )
            }
          }
          if (failures.length > 0) {
            // Record the incomplete shutdown, so a repeated or concurrent stop
            // caller observes the same failure instead of a fabricated success.
            // Multiple phase failures survive together in one aggregate.
            stopFailure =
              failures.length === 1
                ? failures[0]
                : new AggregateError(
                    failures,
                    failures.map((failure) => failure.message).join('; '),
                    { cause: failures[0] },
                  )
            throw stopFailure
          }
        })
      },
    }
  } catch (error) {
    if (databaseOpen) {
      // Release every composition the failed creation built, drain any admitted
      // write and close the handle. The creation failure stays the reportable
      // error; cleanup faults must not replace it.
      shuttingDown = true
      for (const composition of [...compositions]) {
        try {
          composition.dispose()
        } catch {
          // Cleanup is best-effort.
        }
      }
      for (const coordinator of [...coordinators]) {
        try {
          await coordinator.settle()
        } catch {
          // Settle never rejects by contract; cleanup is best-effort.
        }
      }
      databaseOpen = false
      try {
        database.close()
      } catch {
        // The creation failure is the reportable error; a close fault during
        // cleanup must not replace it.
      }
    }
    throw error
  }
}
