import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import type {
  ClockPort,
  ConfirmedDelivery,
  DialoguePort,
  EventStorePort,
  HistoryQueryPort,
  MemoryCommitPort,
  ReactionPort,
  SelectionPort,
} from '../../src/contracts'
import type { CapabilitySnapshot, PerformanceCommand } from '../../src/contracts/app'
import { createApplicationEndpoint } from '../../src/runtime/application'
import type { ApplicationDiagnostic } from '../../src/runtime/application'
import {
  createDialogueComposition,
  createReconstructedRuntimeComposition,
  createRuntimeComposition,
} from '../../src/runtime/composition'
import type { RuntimeComposition } from '../../src/runtime/composition'
import { createMonotonicClock } from '../../src/runtime/clock'
import { createRuntimeAuthorizer } from '../../src/runtime/control-policy'
import type { CycleTimings, RuntimeCoordinator, SessionProfileConfig } from '../../src/runtime/coordinator'
import type { ArchiveSelectionConfig } from '../../src/runtime/session-archives'
import { createDeadlineGate } from '../../src/runtime/deadline'
import type { RuntimeDeadlineGate } from '../../src/runtime/deadline'
import { DiagnosticsServer } from '../../src/runtime/server'
import { createMappedRenderer } from '../../src/performance/mapped-renderer'
import type { RendererDriver, RendererObservation } from '../../src/performance/mapped-renderer'
import type { MediaDriver } from '../../src/performance/browser/types'
import { createEventStore } from '../../src/storage/event-store'
import { createHistoryQuery } from '../../src/storage/history-query'
import { createInMemoryBackend } from '../../src/storage/in-memory-backend'
import type { StorageBackend } from '../../src/storage/backend'
import type { AssembledDialogueContext, DeliveryMemoryStore, DialogueTextSource } from '../../src/dialogue'
import * as correct from './correct-ports'
import {
  createCatalogDialogueTextSource,
  createCapturingCatalogDialogueTextSource,
} from './m4-kit'
import {
  createM1ActualAssetEntries,
  createM1ActualBlobMap,
  createControlledMediaDriver,
  createRegistryResolver,
  M1_FIXTURE_VOICE_ID,
  M1_FIXTURE_VOICE_VERSION,
} from './m1-kit'
import type { AudioResolver } from '../../src/performance/browser/types'
import { createPerformerClient } from './performer-client'
import type { PerformerClient } from './performer-client'
import { FIXTURE_SESSION_ID } from './fixture-data'

const LOOP_ORIGIN = 'http://127.0.0.1:4173'

function fixedCapabilities(): CapabilitySnapshot {
  return {
    rendererId: 'renderer-i1',
    characterId: 'character-i1',
    capabilityRevision: 1,
    actions: [
      { actionId: 'neutral', description: 'neutral face', observability: 'observable', parameterBounds: [] },
      { actionId: 'smile', description: 'smile', observability: 'observable', parameterBounds: [] },
    ],
  }
}

/**
 * A renderer driver that reports only a local test acceptance. It fabricates no
 * avatar completion and forwards nothing to the browser; the demo browser
 * displays the reaction from the offer, separately.
 */
function createAcceptanceDriver(): RendererDriver {
  return {
    async dispatch(): Promise<RendererObservation> {
      return { stage: 'accepted', reasonCode: 'local-test-acceptance', localTimeMs: null }
    },
  }
}

export interface LoopHarnessOptions {
  selection?: SelectionPort
  reaction?: ReactionPort
  dialogue?: DialoguePort
  commit?: MemoryCommitPort
  backend?: StorageBackend
  clock?: ClockPort
  sessionId?: string
  timings?: Partial<CycleTimings>
  profile?: Partial<SessionProfileConfig>
  allowedOrigins?: string[]
  media?: MediaDriver
  resolver?: AudioResolver
  beforeReady?: (command: PerformanceCommand) => Promise<void> | void
  maxPendingInputs?: number
  /** Captures bounded application diagnostics emitted by the endpoint. */
  onDiagnostic?: (diagnostic: ApplicationDiagnostic) => void
  /** Replaces the store port (for controlled-persistence regressions). */
  store?: EventStorePort
  /** Wraps the composed coordinator (for fault-injection regressions). */
  wrapCoordinator?: (coordinator: RuntimeCoordinator) => RuntimeCoordinator
  /** Use the real M4 dialogue composition instead of the fixture substitute. */
  realM4?: boolean
  /** Provider substitute for real M4; defaults to the deterministic catalog source. */
  dialogueTextSource?: DialogueTextSource
  /** Records the assembled M4 context so a test can observe it. */
  captureView?: { view: AssembledDialogueContext | null }
  /** Cross-session reconstruction selection. Implies `realM4`. */
  reconstruction?: ArchiveSelectionConfig
  /** Injects a read failure for one session, to prove fail-closed reconstruction. */
  reconstructionReadFailureSession?: string
}

export interface LoopHarness {
  readonly server: DiagnosticsServer
  readonly port: number
  readonly origin: string
  readonly sessionId: string
  readonly composition: RuntimeComposition
  readonly backend: StorageBackend
  readonly gate: RuntimeDeadlineGate
  /** The clock domain the runtime and gate use, for test-supplied deadlines. */
  readonly clock: ClockPort
  readonly client: PerformerClient
  readonly resolver: AudioResolver
  readonly media: MediaDriver
  /** Real M4 memory store when real M4 is composed; null for the fixture substitute. */
  readonly m4Memory: DeliveryMemoryStore | null
  bootstrapOperator(): Promise<string>
  confirmedHistory(): Promise<ConfirmedDelivery[]>
  /** A fresh performer connection bound to the same loopback server. */
  newClient(overrides?: {
    beforeReady?: (command: PerformanceCommand) => Promise<void> | void
  }): PerformerClient
  close(): Promise<void>
}

/** Base M6 history reader, optionally failing one session to prove fail-closed reconstruction. */
function createBaseHistory(backend: StorageBackend, failingSession?: string): HistoryQueryPort {
  const base = createHistoryQuery(backend)
  if (failingSession === undefined) return base
  return {
    async confirmedHistory(sessionId: string): Promise<ConfirmedDelivery[]> {
      if (sessionId === failingSession) {
        throw new Error(`injected archive read failure for ${sessionId}`)
      }
      return base.confirmedHistory(sessionId)
    },
  }
}

export async function createLoopHarness(options: LoopHarnessOptions = {}): Promise<LoopHarness> {
  const clock = options.clock ?? createMonotonicClock()
  const backend = options.backend ?? createInMemoryBackend()
  const store = options.store ?? createEventStore(backend)
  const gate = createDeadlineGate(clock)
  const capabilities = fixedCapabilities()
  let receiptCounter = 0
  const renderer = createMappedRenderer({
    snapshot: capabilities,
    bindings: [
      { actionId: 'neutral', driverAction: 'browser:neutral' },
      { actionId: 'smile', driverAction: 'browser:smile' },
    ],
    driver: createAcceptanceDriver(),
    deadlineGate: gate,
    receipts: {
      newReceiptId: () => `avatar-${(receiptCounter += 1)}`,
      localNowMs: () => null,
    },
  })

  const reconstruction = options.reconstruction
  const realM4 = options.realM4 === true || reconstruction !== undefined
  let sessionId = options.sessionId ?? reconstruction?.liveSessionId ?? FIXTURE_SESSION_ID

  let m4Memory: DeliveryMemoryStore | null = null
  let composition: RuntimeComposition

  if (reconstruction !== undefined) {
    // The production reconstructed-runtime entry owns the binding between the
    // reconstruction and the runtime session/profile, and preflights the fresh
    // session id through the store before startup. The harness supplies the
    // ports; it does not re-align the id or the character identity itself.
    const textSource =
      options.dialogueTextSource ??
      (options.captureView !== undefined
        ? createCapturingCatalogDialogueTextSource(options.captureView)
        : createCatalogDialogueTextSource())
    const reconstructed = await createReconstructedRuntimeComposition({
      clock,
      authorizer: createRuntimeAuthorizer(),
      selection: options.selection ?? correct.createFixtureSelectionPort(),
      reaction: options.reaction ?? correct.createFixtureReactionPort(),
      store,
      history: createBaseHistory(backend, options.reconstructionReadFailureSession),
      renderer,
      gate,
      audioEntries: createM1ActualAssetEntries(),
      reconstruction,
      textSource,
      // Voice and any other non-character profile fields are supplied here; the
      // production entry binds the character identity to the selection.
      profile: {
        voiceProfileId: M1_FIXTURE_VOICE_ID,
        voiceProfileVersion: M1_FIXTURE_VOICE_VERSION,
        ...(options.profile ?? {}),
      },
      ...(options.timings !== undefined ? { timings: options.timings } : {}),
      ...(options.maxPendingInputs !== undefined
        ? { maxPendingInputs: options.maxPendingInputs }
        : {}),
    })
    composition = reconstructed
    m4Memory = reconstructed.memory
    sessionId = reconstructed.selection.liveSessionId
  } else {
    let dialoguePort = options.dialogue
    let commitPort = options.commit
    if (realM4) {
      const textSource =
        options.dialogueTextSource ??
        (options.captureView !== undefined
          ? createCapturingCatalogDialogueTextSource(options.captureView)
          : createCatalogDialogueTextSource())
      const composed = createDialogueComposition({
        clock,
        history: createBaseHistory(backend, options.reconstructionReadFailureSession),
        textSource,
      })
      m4Memory = composed.memory
      dialoguePort = dialoguePort ?? composed.dialogue
      commitPort = commitPort ?? composed.memory
    }
    composition = createRuntimeComposition({
      clock,
      authorizer: createRuntimeAuthorizer(),
      selection: options.selection ?? correct.createFixtureSelectionPort(),
      reaction: options.reaction ?? correct.createFixtureReactionPort(),
      dialogue: dialoguePort ?? correct.createFixtureDialoguePort(),
      commit: commitPort ?? correct.createFixtureMemoryCommit(),
      store,
      renderer,
      gate,
      audioEntries: createM1ActualAssetEntries(),
      sessionId,
      profile: {
        characterProfileId: realM4 ? 'character-fixture' : 'character-i1',
        characterProfileVersion: '1',
        voiceProfileId: M1_FIXTURE_VOICE_ID,
        voiceProfileVersion: M1_FIXTURE_VOICE_VERSION,
        ...(options.profile ?? {}),
      },
      ...(options.timings !== undefined ? { timings: options.timings } : {}),
      ...(options.maxPendingInputs !== undefined ? { maxPendingInputs: options.maxPendingInputs } : {}),
    })
  }
  if (options.wrapCoordinator !== undefined) {
    // Test-only seam: a wrapped coordinator still exposes the real endpoint and
    // bridge, so a fault is injected through the actual application path.
    composition = { ...composition, coordinator: options.wrapCoordinator(composition.coordinator) }
  }
  const endpoint = createApplicationEndpoint({
    composition,
    clock,
    allowedOrigins: options.allowedOrigins ?? [LOOP_ORIGIN],
    ...(options.onDiagnostic !== undefined ? { onDiagnostic: options.onDiagnostic } : {}),
  })
  const server = new DiagnosticsServer({ port: 0, graceMs: 200, application: endpoint })
  await server.start()
  const address = server.addressInfo as AddressInfo | null
  const port = address?.port ?? 0

  const resolver = options.resolver ?? createRegistryResolver(createM1ActualBlobMap())
  const media = options.media ?? createControlledMediaDriver({ autoEvents: true })
  let counter = 0
  const client = createPerformerClient({
    url: `ws://127.0.0.1:${port}/app`,
    origin: LOOP_ORIGIN,
    sessionId,
    resolver,
    media,
    receipts: {
      newReceiptId: () => `player-${(counter += 1)}`,
      localNowMs: () => null,
    },
    ...(options.beforeReady !== undefined ? { beforeReady: options.beforeReady } : {}),
  })

  const bootstrapOperator = (): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/operator/bootstrap',
          method: 'POST',
          headers: {
            origin: LOOP_ORIGIN,
            host: `127.0.0.1:${port}`,
            'x-isla-operator-bootstrap': '1',
            'content-length': '0',
          },
        },
        (res) => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => {
            body += chunk
          })
          res.on('end', () => {
            try {
              const parsed = JSON.parse(body) as { ok?: boolean; token?: string }
              if (parsed.ok === true && typeof parsed.token === 'string') resolve(parsed.token)
              else reject(new Error(`bootstrap rejected: ${body}`))
            } catch (error) {
              reject(error)
            }
          })
        },
      )
      req.on('error', reject)
      req.end()
    })

  await client.snapshot

  return {
    server,
    port,
    origin: LOOP_ORIGIN,
    sessionId,
    composition,
    backend,
    gate,
    clock,
    client,
    resolver,
    media,
    m4Memory,
    bootstrapOperator,
    confirmedHistory: () => createHistoryQuery(backend).confirmedHistory(sessionId),
    newClient: (overrides = {}) => {
      let localCounter = 0
      return createPerformerClient({
        url: `ws://127.0.0.1:${port}/app`,
        origin: LOOP_ORIGIN,
        sessionId,
        resolver,
        media,
        receipts: {
          newReceiptId: () => `player-alt-${(localCounter += 1)}`,
          localNowMs: () => null,
        },
        ...overrides,
      })
    },
    close: async () => {
      await client.close().catch(() => {})
      try {
        await server.stop()
      } catch {
        // already disposed
      }
    },
  }
}
