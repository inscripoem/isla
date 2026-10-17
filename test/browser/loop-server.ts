import { createApplicationEndpoint } from '../../src/runtime/application'
import { createDialogueComposition, createRuntimeComposition } from '../../src/runtime/composition'
import { createMonotonicClock } from '../../src/runtime/clock'
import { createRuntimeAuthorizer } from '../../src/runtime/control-policy'
import { createDeadlineGate } from '../../src/runtime/deadline'
import { DiagnosticsServer } from '../../src/runtime/server'
import { createMappedRenderer } from '../../src/performance/mapped-renderer'
import type { RendererDriver, RendererObservation } from '../../src/performance/mapped-renderer'
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

/**
 * I1 interactive-loop demo runtime.
 *
 * This is a demo/test entry point, not the product console (M2) or the standard
 * diagnostic CLI. M3 is not implemented yet, so this script injects the explicit
 * fixture selection/reaction substitutes from `test/support`; production source
 * never imports them. M4 is real: the production dialogue context/generation/
 * memory runs against the shared M6 in-memory history and M4's memory commit
 * port, with a deterministic catalog text source substituting only the provider.
 * It also wires the real M5 coordinator, the merged M1 fixed synthesis and mapped
 * renderer, the server-side audio bridge and the browser-facing application
 * endpoint.
 */

const PORT = Number(process.env.ISLA_LOOP_PORT ?? 4317)
const ALLOWED_ORIGINS = ['http://127.0.0.1:5173', 'http://localhost:5173']

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

async function main(): Promise<void> {
  const clock = createMonotonicClock()
  const backend = createInMemoryBackend()
  const gate = createDeadlineGate(clock)
  // Real M4 against the shared M6 history: context/generation/memory are the
  // production implementation, with only the provider text substituted by the
  // deterministic catalog source that matches the M1 WAV assets.
  const m4 = createDialogueComposition({
    clock,
    history: createHistoryQuery(backend),
    textSource: createCatalogDialogueTextSource(),
  })
  let receiptCounter = 0
  const renderer = createMappedRenderer({
    snapshot: {
      rendererId: 'renderer-demo',
      characterId: 'character-demo',
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
    deadlineGate: gate,
    receipts: {
      newReceiptId: () => `avatar-${(receiptCounter += 1)}`,
      localNowMs: () => null,
    },
  })
  const composition = createRuntimeComposition({
    clock,
    authorizer: createRuntimeAuthorizer(),
    selection: correct.createFixtureSelectionPort(),
    reaction: correct.createFixtureReactionPort(),
    dialogue: m4.dialogue,
    commit: m4.memory,
    store: createEventStore(backend),
    renderer,
    gate,
    audioEntries: createM1ActualAssetEntries(),
    sessionId: 'session-loop-demo',
    profile: {
      characterProfileId: 'character-fixture',
      characterProfileVersion: '1',
      voiceProfileId: M1_FIXTURE_VOICE_ID,
      voiceProfileVersion: M1_FIXTURE_VOICE_VERSION,
    },
  })
  const application = createApplicationEndpoint({
    composition,
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

void main().catch((error: unknown) => {
  log('startup_failed', { error: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
})
