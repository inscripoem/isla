import { pathToFileURL } from 'node:url'
import type { ClockPort, EventStorePort, RendererPort } from '../../src/contracts'
import { createApplicationEndpoint } from '../../src/runtime/application'
import { createReconstructedRuntimeComposition } from '../../src/runtime/composition'
import type { ReconstructedRuntimeComposition } from '../../src/runtime/composition'
import { createMonotonicClock } from '../../src/runtime/clock'
import { createRuntimeAuthorizer } from '../../src/runtime/control-policy'
import { createDeadlineGate } from '../../src/runtime/deadline'
import type { RuntimeDeadlineGate } from '../../src/runtime/deadline'
import { createSessionRecovery } from '../../src/runtime/session-recovery'
import { DiagnosticsServer } from '../../src/runtime/server'
import { createMappedRenderer } from '../../src/performance/mapped-renderer'
import type { RendererDriver, RendererObservation } from '../../src/performance/mapped-renderer'
import type { StorageBackend } from '../../src/storage/backend'
import { createEventStore } from '../../src/storage/event-store'
import { createHistoryQuery } from '../../src/storage/history-query'
import { createInMemoryBackend } from '../../src/storage/in-memory-backend'
import * as correct from '../support/correct-ports'
import { createCatalogDialogueTextSource } from '../support/m4-kit'
import {
  createM1ActualAssetEntries,
  M1_FIXTURE_VOICE_ID,
  M1_FIXTURE_VOICE_VERSION,
} from '../support/m1-kit'
import type { ArchiveSelectionConfig } from '../../src/runtime/session-archives'

/**
 * I1 interactive-loop demo runtime.
 *
 * This is a demo/test entry point, not the product console (M2) or the standard
 * diagnostic CLI. M3 is not implemented yet, so this script injects the explicit
 * fixture selection/reaction substitutes from `test/support`; production source
 * never imports them. M4 is real: the production reconstructed runtime runs the
 * production dialogue context/generation/memory against the shared M6 in-memory
 * history and M4's memory commit port, with a deterministic catalog text source
 * substituting only the provider. It also wires the real M5 coordinator, the
 * merged M1 fixed synthesis and mapped renderer, the server-side audio bridge,
 * the browser-facing application endpoint and explicit operator recovery.
 */

const PORT = Number(process.env.ISLA_LOOP_PORT ?? 4317)
const ALLOWED_ORIGINS = ['http://127.0.0.1:5173', 'http://localhost:5173']

/** Live session started by the demo. */
export const LOOP_SESSION_ID = 'session-loop-demo'
/**
 * Registered M4 personality profile the demo runs as. It MUST resolve in the
 * persona registry (`src/dialogue/persona.ts`): an unregistered id yields a
 * voiceless turn, so the demo would accept input and produce no audio while
 * still looking healthy. The regression in
 * `test/offline/i1-loop-demo.test.ts` pins this through the real composition.
 */
export const LOOP_CHARACTER_PROFILE_ID = 'character-fixture'
export const LOOP_CHARACTER_PROFILE_VERSION = '1'
/**
 * Renderer-snapshot identity. This is the renderer's own character id, distinct
 * from the personality profile and never validated against it by M5.
 */
const RENDERER_CHARACTER_ID = 'character-demo'

/** The demo's initial live session selection (no cross-session archives yet). */
export const LOOP_INITIAL_SELECTION: ArchiveSelectionConfig = {
  liveSessionId: LOOP_SESSION_ID,
  liveProfile: {
    profileId: LOOP_CHARACTER_PROFILE_ID,
    profileVersion: LOOP_CHARACTER_PROFILE_VERSION,
  },
  selectedSources: [],
  catalogue: new Map(),
}

function acceptanceDriver(): RendererDriver {
  return {
    async dispatch(): Promise<RendererObservation> {
      // Local test acceptance only: no avatar completion is claimed and nothing
      // is forwarded to the browser. The demo displays the reaction from the offer.
      return { stage: 'accepted', reasonCode: 'local-test-acceptance', localTimeMs: null }
    },
  }
}

function log(event: string, details: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ level: 'info', service: 'isla-loop', event, ...details })}\n`)
}

export interface LoopCompositionDeps {
  clock: ClockPort
  backend: StorageBackend
  store: EventStorePort
}

export type LoopCompositionBuilder = (
  selection: ArchiveSelectionConfig,
) => Promise<ReconstructedRuntimeComposition>

/**
 * Build the demo runtime from the shared store, with the real M4 dialogue, M5
 * coordinator, M1 synthesis/renderer and server-side bridge. Exported (with no
 * side effects) so a regression test can construct the ACTUAL demo composition
 * and prove a turn still produces output; the harness's own defaults must not be
 * able to mask a demo identity mismatch.
 */
export function createLoopCompositionBuilder(deps: LoopCompositionDeps): LoopCompositionBuilder {
  let receiptCounter = 0
  const createRenderer = (deadlineGate: RuntimeDeadlineGate): RendererPort =>
    createMappedRenderer({
      snapshot: {
        rendererId: 'renderer-demo',
        characterId: RENDERER_CHARACTER_ID,
        capabilityRevision: 1,
        actions: [
          { actionId: 'neutral', description: 'neutral face', observability: 'observable', parameterBounds: [] },
          { actionId: 'smile', description: 'smile', observability: 'observable', parameterBounds: [] },
        ],
      },
      bindings: [
        { actionId: 'neutral', driverAction: 'browser:neutral' },
        { actionId: 'smile', driverAction: 'browser:smile' },
      ],
      driver: acceptanceDriver(),
      deadlineGate,
      receipts: {
        newReceiptId: () => `avatar-${(receiptCounter += 1)}`,
        localNowMs: () => null,
      },
    })

  return async (selection) => {
    const deadlineGate = createDeadlineGate(deps.clock)
    return createReconstructedRuntimeComposition({
      clock: deps.clock,
      authorizer: createRuntimeAuthorizer(),
      selection: correct.createFixtureSelectionPort(),
      reaction: correct.createFixtureReactionPort(),
      store: deps.store,
      history: createHistoryQuery(deps.backend),
      renderer: createRenderer(deadlineGate),
      gate: deadlineGate,
      audioEntries: createM1ActualAssetEntries(),
      reconstruction: selection,
      textSource: createCatalogDialogueTextSource(),
      profile: {
        voiceProfileId: M1_FIXTURE_VOICE_ID,
        voiceProfileVersion: M1_FIXTURE_VOICE_VERSION,
      },
    })
  }
}

async function main(): Promise<void> {
  const clock = createMonotonicClock()
  const backend = createInMemoryBackend()
  const store = createEventStore(backend)

  // Explicit operator recovery over the shared store. Each successor gets its
  // own deadline gate and mapped renderer bound to that gate, and is built from
  // the confirmed history of the retired sessions through the production
  // reconstruction entry. The initial selection starts the demo's live session.
  const recovery = await createSessionRecovery({
    initialSelection: LOOP_INITIAL_SELECTION,
    build: createLoopCompositionBuilder({ clock, backend, store }),
  })
  const composition = recovery.currentComposition()
  const application = createApplicationEndpoint({
    composition,
    recovery,
    clock,
    allowedOrigins: ALLOWED_ORIGINS,
    // Local structured diagnostics in the demo's log style. The record is
    // already bounded and free of input content, credentials and payloads; the
    // sink only re-labels the service.
    onDiagnostic: (diagnostic) => {
      log(diagnostic.operation, {
        level: diagnostic.level,
        outcome: diagnostic.outcome,
        sessionRef: diagnostic.sessionRef,
        ...(diagnostic.epoch !== undefined ? { epoch: diagnostic.epoch } : {}),
        ...(diagnostic.connectionId !== undefined ? { connectionId: diagnostic.connectionId } : {}),
        ...(diagnostic.messageKind !== undefined ? { messageKind: diagnostic.messageKind } : {}),
        ...(diagnostic.requestRef !== undefined ? { requestRef: diagnostic.requestRef } : {}),
      })
    },
  })
  const server = new DiagnosticsServer({ host: '127.0.0.1', port: PORT, application })
  const bound = await server.start()
  log('listening', {
    host: bound.host,
    port: bound.port,
    applicationPath: application.path,
    operatorBootstrap: '/operator/bootstrap',
    page: 'http://127.0.0.1:5173/loop.html',
  })

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log('shutdown_started', { signal })
    try {
      await server.stop()
      log('shutdown_complete', { signal })
    } catch (error) {
      log('shutdown_failed', { error: error instanceof Error ? error.message : String(error) })
      process.exitCode = 1
    }
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

// Start the server only when this module is the process entry point. Importing
// it (for example from the loop-demo regression test) must never bind a port.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  void main().catch((error: unknown) => {
    log('startup_failed', { error: error instanceof Error ? error.message : String(error) })
    process.exitCode = 1
  })
}
