import { describe, expect, it } from 'vitest'
import type {
  ClockPort,
  ControlAck,
  InputAck,
  PerformanceReceipt,
  PlayerPort,
  RuntimeEndpointPort,
} from '../../src/contracts'
import { performanceReceiptSchema } from '../../src/contracts'
import { createDialoguePort } from '../../src/dialogue'
import type { AssembledDialogueContext, DeliveryMemoryStore } from '../../src/dialogue'
import { createDeliveryMemoryStore } from '../../src/dialogue'
import { createRuntimeCoordinator } from '../../src/runtime/coordinator'
import type { RuntimeCoordinator, SessionProfileConfig } from '../../src/runtime/coordinator'
import { createFixedSynthesis } from '../../src/performance/fixed-synthesis'
import { createEventStore } from '../../src/storage/event-store'
import { createHistoryQuery } from '../../src/storage/history-query'
import { createInMemoryBackend } from '../../src/storage/in-memory-backend'
import type { StorageBackend } from '../../src/storage/backend'
import * as correct from '../support/correct-ports'
import {
  createM1ActualAssetEntries,
  M1_FIXTURE_VOICE_ID,
  M1_FIXTURE_VOICE_VERSION,
} from '../support/m1-kit'
import {
  createCatalogDialogueTextSource,
  createCapturingCatalogDialogueTextSource,
  createDeliveryFailingBackend,
} from '../support/m4-kit'
import { fixtureOperatorContext, fixtureViewerContext } from '../support/fixture-data'
import { createVirtualClock } from '../support/virtual-clock'

/**
 * Deterministic coordinator-level integration checks for the real modules.
 *
 * Real: M4 dialogue context/generation/memory, M5 coordinator, M1 fixed
 * synthesis (keyed by the exact catalog text), and the M6 in-memory store.
 * Substitutes: M3 selection/reaction, the M1 playback/renderer receipts (a
 * deterministic fixture player and renderer that report terminal stages without
 * real media), and the provider dialogue text (the deterministic catalog source).
 * These are coordinator assemblies driven directly, not the production transport;
 * the loopback transport is covered separately in `m4-loopback.test.ts`.
 */
const FIXTURE_PROFILE: Partial<SessionProfileConfig> = {
  characterProfileId: 'character-fixture',
  characterProfileVersion: '1',
  voiceProfileId: M1_FIXTURE_VOICE_ID,
  voiceProfileVersion: M1_FIXTURE_VOICE_VERSION,
}

/** Backend failure injection lives in `../support/m4-kit`. */
interface IntegrationOptions {
  backend?: StorageBackend
  sessionId?: string
  capture?: { view: AssembledDialogueContext | null }
  player?: PlayerPort
  clock?: ClockPort
  /** One shared M4 dialogue port and memory store, for the shared-session case. */
  dialogue?: ReturnType<typeof createDialoguePort>
  memory?: DeliveryMemoryStore
}

interface IntegrationHarness {
  coordinator: RuntimeCoordinator
  memory: DeliveryMemoryStore
  backend: StorageBackend
  sessionId: string
}

function createIntegration(options: IntegrationOptions = {}): IntegrationHarness {
  const clock = options.clock ?? createVirtualClock()
  const backend = options.backend ?? createInMemoryBackend()
  const sessionId = options.sessionId ?? 'session-m4-integration'
  const memory = options.memory ?? createDeliveryMemoryStore()
  const dialogue =
    options.dialogue ??
    createDialoguePort({
      clock,
      history: createHistoryQuery(backend),
      memory,
      ...(options.capture !== undefined
        ? { textSource: createCapturingCatalogDialogueTextSource(options.capture) }
        : { textSource: createCatalogDialogueTextSource() }),
    })
  const coordinator = createRuntimeCoordinator({
    clock,
    authorizer: correct.createFixtureControlAuthorizer(),
    selection: correct.createFixtureSelectionPort(),
    reaction: correct.createFixtureReactionPort(),
    dialogue,
    synthesis: createFixedSynthesis({ entries: createM1ActualAssetEntries(), clock }),
    renderer: correct.createFixtureRendererPort(),
    player: options.player ?? correct.createFixturePlayer(),
    commit: memory,
    store: createEventStore(backend),
    sessionId,
    profile: FIXTURE_PROFILE,
  })
  return { coordinator, memory, backend, sessionId }
}

function inputSubmit(sessionId: string, messageId: string, epoch: number, text: string) {
  return {
    protocolVersion: '0.2' as const,
    messageId,
    sessionId,
    epoch,
    kind: 'input.submit' as const,
    payload: { source: 'local-audience' as const, text },
  }
}

/** Small control/input helpers mirroring the M5 attribution harness. */
function controls(harness: IntegrationHarness) {
  let counter = 0
  const next = (prefix: string): string => `${prefix}-${(counter += 1)}`
  const endpoint: RuntimeEndpointPort = harness.coordinator.endpoint
  return {
    resume: (): Promise<ControlAck> =>
      endpoint.control(
        {
          protocolVersion: '0.2',
          kind: 'control.resume',
          messageId: next('msg'),
          sessionId: harness.sessionId,
          epoch: harness.coordinator.epoch(),
          payload: { requestId: next('control') },
        },
        fixtureOperatorContext(),
      ),
    accept: (text: string): Promise<InputAck> =>
      endpoint.submitInput(
        inputSubmit(harness.sessionId, next('msg'), harness.coordinator.epoch(), text),
        fixtureViewerContext(),
      ),
  }
}

/** A player whose first output fails after start; later outputs complete. */
function createFailOncePlayer(): PlayerPort {
  let calls = 0
  const receipt = (
    command: {
      outputId: string
      sessionId: string
      epoch: number
      turnId: string
      segmentId: string
    },
    stage: 'failed' | 'completed',
  ): PerformanceReceipt =>
    performanceReceiptSchema.parse({
      receiptId: `receipt-${stage}-${command.outputId}`,
      outputId: command.outputId,
      sessionId: command.sessionId,
      epoch: command.epoch,
      turnId: command.turnId,
      segmentId: command.segmentId,
      modality: 'audio',
      stage,
      localTimeMs: 10,
      chunkIds: null,
      reasonCode: stage === 'failed' ? 'playback-failed' : null,
      source: 'integration-fail-once-player',
    })
  return {
    async execute(command) {
      calls += 1
      return receipt(command, calls === 1 ? 'failed' : 'completed')
    },
    async cancel() {
      return null
    },
    status: () => ({ idle: true, activeOutputId: null, lastStage: null }),
  }
}

describe('M4 + M5 + M1 + M6 coordinator integration', () => {
  it('assembles confirmed previous text across two real turns', async () => {
    const capture: { view: AssembledDialogueContext | null } = { view: null }
    const harness = createIntegration({ capture })
    const control = controls(harness)

    await control.resume()
    await control.accept('first message')
    expect((await harness.coordinator.runTurn()).status).toBe('completed')
    const firstHistory = await createHistoryQuery(harness.backend).confirmedHistory(harness.sessionId)
    expect(firstHistory).toHaveLength(2)

    await control.accept('second message')
    expect((await harness.coordinator.runTurn()).status).toBe('completed')

    // The second turn's context is built from the first turn's confirmed text.
    const view = capture.view
    expect(view).not.toBeNull()
    expect(view?.historySource).toBe('history-port')
    expect(view?.turns).toHaveLength(1)
    expect(view?.turns[0]?.segments.map((segment) => segment.segmentIndex)).toEqual([0, 1])
    expect(view?.turns[0]?.text).toContain('We talked about the concert.')

    // Both turns are now durable, each with its two ordered, attributed segments.
    const history = await createHistoryQuery(harness.backend).confirmedHistory(harness.sessionId)
    expect(history).toHaveLength(4)
    expect(history.every((record) => record.personaProfileId === 'character-fixture')).toBe(true)
    expect(history.every((record) => record.personaProfileVersion === '1')).toBe(true)
    expect(history.map((record) => record.segmentIndex)).toEqual([0, 1, 0, 1])
  })

  it('accepts a failed-after-start delivery as audit-only without degrading the session', async () => {
    const harness = createIntegration({ player: createFailOncePlayer() })
    const control = controls(harness)

    await control.resume()
    await control.accept('playback will fail')
    const outcome = await harness.coordinator.runTurn()

    // A playback fault is a safe non-completed cycle, not a degraded session.
    expect(outcome.status).toBe('cancelled')
    expect(harness.coordinator.lifecycle()).toBe('running')

    const audited = harness.coordinator
      .deliveries()
      .find(
        (delivery) =>
          delivery.classification === 'partial-unknown' && delivery.terminalOutcome === 'failed',
      )
    expect(audited).toBeDefined()

    // M6 and M4 both accept the failed-after-start record, but it never becomes
    // spoken history: only the completed segment is confirmed.
    const history = await createHistoryQuery(harness.backend).confirmedHistory(harness.sessionId)
    expect(history.every((record) => record.classification === 'fully-delivered')).toBe(true)
    expect(history.some((record) => record.turnId === audited?.turnId && record.segmentId === audited?.segmentId)).toBe(
      false,
    )
    expect(harness.memory.records().some((record) => record.classification === 'partial-unknown')).toBe(
      true,
    )
    expect(
      (await harness.memory.confirmedHistory(harness.sessionId)).some(
        (record) => record.classification === 'partial-unknown',
      ),
    ).toBe(false)

    // The session is healthy: a later turn still completes.
    await control.accept('next message')
    expect((await harness.coordinator.runTurn()).status).toBe('completed')
  })

  it('shares one M4 dialogue port and memory store across two isolated sessions', async () => {
    const clock = createVirtualClock()
    const backend = createInMemoryBackend()
    const memory = createDeliveryMemoryStore()
    const dialogue = createDialoguePort({
      clock,
      history: createHistoryQuery(backend),
      memory,
      textSource: createCatalogDialogueTextSource(),
    })

    const alpha = createIntegration({
      backend,
      clock,
      sessionId: 'session-alpha',
      dialogue,
      memory,
    })
    const beta = createIntegration({
      backend,
      clock,
      sessionId: 'session-beta',
      dialogue,
      memory,
    })
    const alphaControl = controls(alpha)
    const betaControl = controls(beta)

    await alphaControl.resume()
    await betaControl.resume()
    await alphaControl.accept('alpha input')
    await betaControl.accept('beta input')
    expect((await alpha.coordinator.runTurn()).status).toBe('completed')
    expect((await beta.coordinator.runTurn()).status).toBe('completed')

    const alphaHistory = await createHistoryQuery(backend).confirmedHistory('session-alpha')
    const betaHistory = await createHistoryQuery(backend).confirmedHistory('session-beta')
    expect(alphaHistory.length).toBe(2)
    expect(betaHistory.length).toBe(2)
    expect(alphaHistory.every((record) => record.sessionId === 'session-alpha')).toBe(true)
    expect(betaHistory.every((record) => record.sessionId === 'session-beta')).toBe(true)
    // The shared M4 store keeps the two sessions' records apart too.
    expect((await memory.memoryEntries('session-alpha')).every((entry) => entry.delivery.sessionId === 'session-alpha')).toBe(true)
    expect((await memory.memoryEntries('session-beta')).every((entry) => entry.delivery.sessionId === 'session-beta')).toBe(true)
  })

  it('does not admit a delivery into M4 memory after a failed M6 atomic commit', async () => {
    const { backend, failNextDelivery } = createDeliveryFailingBackend()
    const harness = createIntegration({ backend })
    const control = controls(harness)

    await control.resume()
    await control.accept('storage will fail')
    failNextDelivery()
    const outcome = await harness.coordinator.runTurn()

    expect(outcome.status).toBe('degraded')
    expect(harness.coordinator.lifecycle()).toBe('degraded')
    // Persistence precedes admission: the failed atomic commit admits nothing to M4.
    expect(harness.memory.records()).toHaveLength(0)
    expect(await createHistoryQuery(backend).confirmedHistory(harness.sessionId)).toHaveLength(0)
  })
})
