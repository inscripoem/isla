import { describe, expect, it } from 'vitest'
import type {
  CapabilitySnapshot,
  ControlStopMessage,
  DecisionRequest,
  EventStorePort,
  InputSubmitMessage,
  MemoryCommitPort,
  PerformanceCommand,
  PerformanceReceipt,
  PlayerPort,
  PreparePerformance,
  ReactionPort,
  RendererPort,
  SelectionPort,
  SelectionRequest,
  SelectionResult,
  ServerMessage,
  SynthesisPort,
} from '../../src/contracts'
import {
  deliveryCommitAckSchema,
  performanceReceiptSchema,
  playerMessageSchema,
  selectionResultSchema,
} from '../../src/contracts'
import {
  createRuntimeCoordinator,
  resolveCycleTimings,
  resolveRuntimeBudgets,
  resolveSessionProfile,
  type RuntimeCoordinatorDeps,
  type SessionProfileConfig,
} from '../../src/runtime/coordinator'
import { createEventStore, createHistoryQuery, createInMemoryBackend } from '../../src/storage'
import { createCoordinatorRunner, createVirtualClock } from '../support/runner-factories'
import * as correct from '../support/correct-ports'
import { createGate } from '../support/context'
import {
  createAbortingRejectionSelectionPort,
  createAcceptedReceiptPlayer,
  createCancelReleasingPlayerPort,
  createCancelTerminalPlayer,
  createCapturingDialoguePort,
  createCapturingPlayer,
  createCountingPlayer,
  createGatedReactionPort,
  createGatedSelectionPort,
  createHangOnceSelectionPort,
  createHistoricalReceiptPlayer,
  createLateDialoguePort,
  createLateSinkDialoguePort,
  createMalformedReceiptPlayer,
  createMalformedSegmentDialoguePort,
  createMalformedSelectionPort,
  createNeverSettlingDialoguePort,
  createNeverSettlingPlayerPort,
  createNeverSettlingReactionPort,
  createNeverSettlingRendererPort,
  createNeverSettlingSelectionPort,
  createNeverSettlingSynthesisPort,
  createPunctuationOnlyDialoguePort,
  createRepeatedIndexDialoguePort,
  createScriptedReceiptPlayer,
  createStagedCancelPlayer,
  createWrongEndCountDialoguePort,
  createWrongModalityReceiptPlayer,
  createWrongRevisionSelectionPort,
} from '../support/gated-ports'
import {
  FIXTURE_SESSION_ID,
  fixtureOperatorContext,
  fixturePerformanceReceipt,
  fixtureUsage,
  fixtureViewerContext,
} from '../support/fixture-data'

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** A valid-shaped selection that reports an epoch one ahead of the request. */
function staleEpochSelectionPort(): SelectionPort {
  return {
    async select(request) {
      return selectionResultSchema.parse({
        requestId: request.requestId,
        sessionId: request.sessionId,
        epoch: request.epoch + 1,
        snapshotRevision: request.snapshotRevision,
        disposition: 'respond',
        selectedEventIds: [request.candidates[0].eventId],
        replyIntent: 'answer',
        reasonCode: 'stale-epoch',
        provider: 'fixture',
        modelVersion: 'fixture-v1',
        usage: fixtureUsage({ requestId: request.requestId }),
      })
    },
  }
}

describe('M5 coordinator cycle control (production)', () => {
  it('rejects a concurrent cycle and reserves the selected input', async () => {
    const gate = createGate()
    const runner = createCoordinatorRunner({ selection: createGatedSelectionPort(gate.promise) })
    await runner.resume()
    await runner.accept('reserved input')
    const first = runner.runTurn()
    expect((await runner.runTurn()).status).toBe('busy')
    gate.release()
    const completed = await first
    expect(completed.status).toBe('completed')
    expect(runner.deliveries()).toHaveLength(1)
    // The selected input was reserved and consumed; no new input means no turn.
    expect((await runner.runTurn()).status).toBe('no-input')
    expect(runner.selectionCalls()).toBe(1)
  })

  it('does not leak a stale-epoch or wrong-revision selection; it uses the authorized fallback', async () => {
    for (const selection of [staleEpochSelectionPort(), createWrongRevisionSelectionPort()]) {
      const runner = createCoordinatorRunner({ selection })
      await runner.resume()
      await runner.accept('fallback')
      const turn = await runner.runTurn()
      expect(turn.status).toBe('completed')
      expect(turn.plan?.reasonCode).toBe('m5-fallback')
      expect(runner.deliveries()).toHaveLength(1)
      expect(runner.deliveries()[0]?.classification).toBe('fully-delivered')
    }
  })

  it('never dispatches a late selection result after Stop and Resume', async () => {
    const gate = createGate()
    const entered = createGate()
    const player = createCountingPlayer(correct.createFixturePlayer())
    const renderer = correct.createCountingRenderer(correct.createFixtureRendererPort())
    const runner = createCoordinatorRunner({
      selection: createGatedSelectionPort(gate.promise, () => entered.release()),
      player,
      renderer,
    })
    await runner.resume()
    await runner.accept('late selection')
    const turnPromise = runner.runTurn()
    await entered.promise
    await runner.stop()
    await settle()
    expect((await runner.resume()).status).toBe('applied')
    gate.release()
    const turn = await turnPromise
    expect(turn.status).toBe('stale')
    expect(player.executeCalls()).toBe(0)
    expect(renderer.calls()).toBe(0)
    expect(runner.deliveries()).toHaveLength(0)
  })

  it('never dispatches a cancellation-ignoring late dialogue producer after Stop and Resume', async () => {
    const gate = createGate()
    const entered = createGate()
    const player = createCountingPlayer(correct.createFixturePlayer())
    const renderer = correct.createCountingRenderer(correct.createFixtureRendererPort())
    const runner = createCoordinatorRunner({
      dialogue: createLateDialoguePort(gate.promise, () => entered.release()),
      player,
      renderer,
    })
    await runner.resume()
    await runner.accept('late dialogue')
    const turnPromise = runner.runTurn()
    await entered.promise
    await runner.stop()
    await settle()
    expect((await runner.resume()).status).toBe('applied')
    gate.release()
    await turnPromise
    expect(player.executeCalls()).toBe(0)
    expect(renderer.calls()).toBe(0)
    expect(runner.deliveries()).toHaveLength(0)
  })

  it('does not fall back into output when the selection deadline expires', async () => {
    const gate = createGate()
    const runner = createCoordinatorRunner({ selection: createGatedSelectionPort(gate.promise) })
    await runner.resume()
    await runner.accept('expired')
    const turnPromise = runner.runTurn()
    runner.clock.advance(6000)
    gate.release()
    const turn = await turnPromise
    expect(turn.status).toBe('stale')
    expect(runner.deliveries()).toHaveLength(0)
    expect(runner.rejectedLate()).toBeGreaterThanOrEqual(1)
  })
})

describe('M5 coordinator reactions (production)', () => {
  it('continues speech with a no-op when the reaction provider throws', async () => {
    const player = createCountingPlayer(correct.createFixturePlayer())
    const renderer = correct.createCountingRenderer(correct.createFixtureRendererPort())
    const throwingReaction: ReactionPort = {
      async decide() {
        throw new Error('reaction provider failure')
      },
    }
    const runner = createCoordinatorRunner({ reaction: throwingReaction, player, renderer })
    await runner.resume()
    await runner.accept('react fail')
    const turn = await runner.runTurn()
    expect(turn.status).toBe('completed')
    expect(renderer.calls()).toBe(0)
    expect(player.executeCalls()).toBe(1)
    expect(runner.deliveries()).toHaveLength(1)
    expect(runner.deliveries()[0]?.classification).toBe('fully-delivered')
  })

  it('continues speech with a no-op when the reaction exceeds its deadline', async () => {
    const gate = createGate()
    const entered = createGate()
    const player = createCountingPlayer(correct.createFixturePlayer())
    const renderer = correct.createCountingRenderer(correct.createFixtureRendererPort())
    const runner = createCoordinatorRunner({
      reaction: createGatedReactionPort(gate.promise, () => entered.release()),
      player,
      renderer,
    })
    await runner.resume()
    await runner.accept('react timeout')
    const turnPromise = runner.runTurn()
    await entered.promise
    // Past the reaction budget (1.5s) but within the cycle deadline (5s).
    runner.clock.advance(2000)
    gate.release()
    const turn = await turnPromise
    expect(turn.status).toBe('completed')
    expect(renderer.calls()).toBe(0)
    expect(player.executeCalls()).toBe(1)
    expect(runner.deliveries()).toHaveLength(1)
  })
})

describe('M5 coordinator receipts and storage (production)', () => {
  it('rejects an unregistered receipt and an identity-mismatched registered receipt', async () => {
    const player = createCapturingPlayer(correct.createFixturePlayer())
    const runner = createCoordinatorRunner({ player })
    await runner.resume()
    await runner.accept('receipts')
    await runner.runTurn()
    const command = player.commands()[0]!
    const before = runner.rejectedReceipts()
    await runner.endpoint.handlePlayerMessage({
      protocolVersion: '0.2',
      messageId: 'm-unregistered',
      sessionId: command.sessionId,
      epoch: command.epoch,
      kind: 'performance.receipt',
      payload: fixturePerformanceReceipt({
        outputId: 'ghost-output',
        sessionId: command.sessionId,
        epoch: command.epoch,
        turnId: command.turnId,
        segmentId: command.segmentId,
        modality: 'audio',
      }),
    })
    await runner.endpoint.handlePlayerMessage({
      protocolVersion: '0.2',
      messageId: 'm-mismatch',
      sessionId: command.sessionId,
      epoch: command.epoch,
      kind: 'performance.receipt',
      payload: fixturePerformanceReceipt({
        outputId: command.outputId,
        sessionId: command.sessionId,
        epoch: command.epoch,
        turnId: 'other-turn',
        segmentId: command.segmentId,
        modality: 'audio',
      }),
    })
    expect(runner.rejectedReceipts()).toBe(before + 2)
  })

  it('ignores a duplicate receipt id/stage and records a conflicting stage without overwriting', async () => {
    const gate = createGate()
    const holdPlayer = correct.createFixturePlayer({ hold: true })
    const player = createCapturingPlayer(holdPlayer)
    const runner = createCoordinatorRunner({ player })
    await runner.resume()
    await runner.accept('receipt reconciliation')
    runner.hooks.onPlaybackStart = async () => {
      await gate.promise
    }
    const turnPromise = runner.runTurn()
    await waitUntil(() => player.commands().length > 0)
    const command = player.commands()[0]!
    const message = (receiptId: string, stage: string, messageId: string) => ({
      protocolVersion: '0.2' as const,
      messageId,
      sessionId: command.sessionId,
      epoch: command.epoch,
      kind: 'performance.receipt' as const,
      payload: fixturePerformanceReceipt({
        receiptId,
        outputId: command.outputId,
        sessionId: command.sessionId,
        epoch: command.epoch,
        turnId: command.turnId,
        segmentId: command.segmentId,
        modality: 'audio',
        stage: stage as 'started' | 'completed',
      }),
    })
    await runner.endpoint.handlePlayerMessage(message('r-keep', 'started', 'm-1'))
    await runner.endpoint.handlePlayerMessage(message('r-keep', 'started', 'm-2'))
    await runner.endpoint.handlePlayerMessage(message('r-keep', 'completed', 'm-3'))
    gate.release()
    holdPlayer.complete()
    const turn = await turnPromise
    expect(turn.status).toBe('completed')
    const actions = runner
      .events()
      .filter((event) => event.type === 'output.receipt')
      .map((event) => (event.payload as { reconciliation?: string }).reconciliation)
    expect(actions.filter((action) => action === 'ignore-duplicate').length).toBeGreaterThanOrEqual(1)
    expect(actions.filter((action) => action === 'conflict').length).toBeGreaterThanOrEqual(1)
  })

  it('degrades and blocks new cycles after an atomic delivery write fails; Stop stays responsive', async () => {
    const store = correct.createFixtureEventStore()
    const runner = createCoordinatorRunner({ store })
    await runner.resume()
    await runner.accept('will fail storage')
    store.failNextCommit = true
    const turn = await runner.runTurn()
    expect(turn.status).toBe('degraded')
    expect(runner.lifecycle()).toBe('degraded')
    expect((await runner.runTurn()).status).toBe('degraded')
    expect(runner.deliveries()).toHaveLength(0)
    expect((await runner.stop()).status).toBe('applied')
  })

  it('acknowledges Stop without awaiting a held storage append', async () => {
    const gate = createGate()
    const store = correct.createFixtureEventStore()
    const runner = createCoordinatorRunner({ store })
    await runner.resume()
    await runner.accept('held append')
    await settle()
    let held = false
    store.beforeAppend = () => {
      held = true
      return gate.promise
    }
    const turnPromise = runner.runTurn()
    await waitUntil(() => held)
    const ack = await runner.stop()
    expect(ack.status).toBe('applied')
    expect(runner.lifecycle()).toBe('stopped')
    store.beforeAppend = undefined
    gate.release()
    await turnPromise
  })

  it('acknowledges Stop without awaiting a held atomic delivery commit', async () => {
    const gate = createGate()
    const store = correct.createFixtureEventStore()
    const runner = createCoordinatorRunner({ store })
    await runner.resume()
    await runner.accept('held commit')
    await settle()
    let held = false
    store.beforeCommit = () => {
      held = true
      return gate.promise
    }
    const turnPromise = runner.runTurn()
    await waitUntil(() => held)
    const ack = await runner.stop()
    expect(ack.status).toBe('applied')
    store.beforeCommit = undefined
    gate.release()
    await turnPromise
  })

  it('rejects a registered audio output receipt with the wrong modality', async () => {
    const store = correct.createFixtureEventStore()
    const runner = createCoordinatorRunner({ store, player: createWrongModalityReceiptPlayer() })
    await runner.resume()
    await runner.accept('wrong modality')
    const turn = await runner.runTurn()
    expect(runner.deliveries()).toHaveLength(0)
    expect(runner.rejectedReceipts()).toBeGreaterThan(0)
    expect(store.events.some((event) => event.type === 'delivery.committed')).toBe(false)
    expect(turn.status).toBe('cancelled')
  })

  it('does not let an old terminal receipt clear the current output state', async () => {
    const runner = createCoordinatorRunner({
      segmentCount: 2,
      player: createHistoricalReceiptPlayer(),
    })
    await runner.resume()
    await runner.accept('two segments, stale second receipt')
    const turn = await runner.runTurn()
    expect(runner.deliveries()).toHaveLength(1)
    expect(runner.deliveries()[0]?.segmentId).toContain('seg-0')
    // The old receipt for the first output must not confirm the second output.
    expect((await runner.endpoint.snapshot()).outputConfirmation).toBe('unknown')
    expect(turn.status).toBe('cancelled')
  })

  it('keeps a reused receipt id from rewriting its facts after a newer receipt', async () => {
    const gate = createGate()
    const holdPlayer = correct.createFixturePlayer({ hold: true })
    const player = createCapturingPlayer(holdPlayer)
    const runner = createCoordinatorRunner({ player })
    await runner.resume()
    await runner.accept('receipt reuse history')
    runner.hooks.onPlaybackStart = async () => {
      await gate.promise
    }
    const turnPromise = runner.runTurn()
    await waitUntil(() => player.commands().length > 0)
    const command = player.commands()[0]!
    const message = (receiptId: string, stage: string, messageId: string) => ({
      protocolVersion: '0.2' as const,
      messageId,
      sessionId: command.sessionId,
      epoch: command.epoch,
      kind: 'performance.receipt' as const,
      payload: fixturePerformanceReceipt({
        receiptId,
        outputId: command.outputId,
        sessionId: command.sessionId,
        epoch: command.epoch,
        turnId: command.turnId,
        segmentId: command.segmentId,
        modality: 'audio',
        stage: stage as 'started' | 'completed',
      }),
    })
    await runner.endpoint.handlePlayerMessage(message('r-old', 'started', 'm-old-1'))
    await runner.endpoint.handlePlayerMessage(message('r-new', 'completed', 'm-new'))
    await runner.endpoint.handlePlayerMessage(message('r-old', 'completed', 'm-old-2'))
    gate.release()
    holdPlayer.complete()
    const turn = await turnPromise
    expect(turn.status).toBe('completed')
    const actions = runner
      .events()
      .filter((event) => event.type === 'output.receipt')
      .map((event) => (event.payload as { reconciliation?: string }).reconciliation)
    // The second use of r-old must conflict with its own recorded stage rather
    // than being accepted as a fresh observation.
    expect(actions[2]).toBe('conflict')
  })

  it('ignores an earlier Stop cancellation that completes after a later Stop', async () => {
    const player = createStagedCancelPlayer()
    const runner = createCoordinatorRunner({ player })
    await runner.resume()
    expect((await runner.stop()).status).toBe('applied')
    expect((await runner.stop()).status).toBe('applied')
    await settle()
    expect((await runner.endpoint.snapshot()).outputConfirmation).toBe('confirmed')
    player.releaseFirst()
    await settle()
    // The earlier Stop's late non-terminal evidence must not clear the later
    // Stop's confirmation.
    expect((await runner.endpoint.snapshot()).outputConfirmation).toBe('confirmed')
  })

  it('keeps evidence pending when a null cancellation disagrees with busy player status', async () => {
    const player: PlayerPort = {
      execute: () => new Promise(() => {}),
      async cancel() {
        return null
      },
      status: () => ({ idle: false, activeOutputId: 'output-busy', lastStage: 'started' }),
    }
    const runner = createCoordinatorRunner({ player })
    await runner.resume()
    expect((await runner.stop()).status).toBe('applied')
    await settle()
    // Null alone cannot prove idle when player status reports an active output.
    expect((await runner.endpoint.snapshot()).outputConfirmation).toBe('pending')
  })

  it('finalizes a registered output from an asynchronous terminal receipt exactly once', async () => {
    const player = createAcceptedReceiptPlayer()
    const runner = createCoordinatorRunner({ player, timings: { playbackMs: 5000 } })
    await runner.resume()
    await runner.accept('async evidence')
    const turnPromise = runner.runTurn()
    await waitUntil(() => player.commands().length > 0)
    const command = player.commands()[0]!
    const message = (messageId: string) => ({
      protocolVersion: '0.2' as const,
      messageId,
      sessionId: command.sessionId,
      epoch: command.epoch,
      kind: 'performance.receipt' as const,
      payload: fixturePerformanceReceipt({
        receiptId: 'r-async',
        outputId: command.outputId,
        sessionId: command.sessionId,
        epoch: command.epoch,
        turnId: command.turnId,
        segmentId: command.segmentId,
        modality: 'audio',
        stage: 'completed',
      }),
    })
    await runner.endpoint.handlePlayerMessage(message('m-async-1'))
    const turn = await turnPromise
    expect(turn.status).toBe('completed')
    expect(runner.deliveries()).toHaveLength(1)
    expect(runner.deliveries()[0]?.classification).toBe('fully-delivered')
    // A retransmitted terminal receipt must not commit a second delivery.
    await runner.endpoint.handlePlayerMessage(message('m-async-2'))
    expect(runner.deliveries()).toHaveLength(1)
    expect(player.commands()).toHaveLength(1)
  })

  it('commits an earlier unknown output exactly once when terminal evidence arrives later', async () => {
    const player = createScriptedReceiptPlayer((_command, call) => ({
      stage: call === 0 ? 'unknown' : 'completed',
    }))
    const runner = createCoordinatorRunner({ player })
    await runner.resume()
    await runner.accept('unknown then terminal')
    const first = await runner.runTurn()
    expect(first.status).toBe('cancelled')
    expect(runner.deliveries()).toHaveLength(0)
    expect((await runner.endpoint.snapshot()).outputConfirmation).toBe('unknown')
    const command = player.commands()[0]!
    const message = (messageId: string) => ({
      protocolVersion: '0.2' as const,
      messageId,
      sessionId: command.sessionId,
      epoch: command.epoch,
      kind: 'performance.receipt' as const,
      payload: fixturePerformanceReceipt({
        receiptId: `receipt-terminal-${command.outputId}`,
        outputId: command.outputId,
        sessionId: command.sessionId,
        epoch: command.epoch,
        turnId: command.turnId,
        segmentId: command.segmentId,
        modality: 'audio',
        stage: 'completed',
      }),
    })
    await runner.endpoint.handlePlayerMessage(message('m-hist-1'))
    expect(runner.deliveries()).toHaveLength(1)
    expect(runner.deliveries()[0]?.classification).toBe('fully-delivered')
    // No replay of the original output.
    expect(player.commands()).toHaveLength(1)
    // A retransmission does not add a second historical delivery.
    await runner.endpoint.handlePlayerMessage(message('m-hist-2'))
    expect(runner.deliveries()).toHaveLength(1)
    // A newer output is unaffected by replayed older evidence.
    await runner.accept('newer output')
    const second = await runner.runTurn()
    expect(second.status).toBe('completed')
    expect(runner.deliveries()).toHaveLength(2)
    await runner.endpoint.handlePlayerMessage(message('m-hist-3'))
    expect(runner.deliveries()).toHaveLength(2)
  })

  it('does not regress a completed output from an older duplicate started receipt', async () => {
    const gate = createGate()
    const holdPlayer = correct.createFixturePlayer({ hold: true })
    const player = createCapturingPlayer(holdPlayer)
    const runner = createCoordinatorRunner({ player })
    await runner.resume()
    await runner.accept('no regression')
    runner.hooks.onPlaybackStart = async () => {
      await gate.promise
    }
    const turnPromise = runner.runTurn()
    await waitUntil(() => player.commands().length > 0)
    const command = player.commands()[0]!
    const message = (receiptId: string, stage: string, messageId: string) => ({
      protocolVersion: '0.2' as const,
      messageId,
      sessionId: command.sessionId,
      epoch: command.epoch,
      kind: 'performance.receipt' as const,
      payload: fixturePerformanceReceipt({
        receiptId,
        outputId: command.outputId,
        sessionId: command.sessionId,
        epoch: command.epoch,
        turnId: command.turnId,
        segmentId: command.segmentId,
        modality: 'audio',
        stage: stage as 'started' | 'completed',
      }),
    })
    await runner.endpoint.handlePlayerMessage(message('r-shared', 'started', 'm-1'))
    await runner.endpoint.handlePlayerMessage(message('r-new', 'completed', 'm-2'))
    expect((await runner.endpoint.snapshot()).outputConfirmation).toBe('confirmed')
    await runner.endpoint.handlePlayerMessage(message('r-shared', 'started', 'm-3'))
    // The older duplicate must not regress the completed fact/confirmation.
    expect((await runner.endpoint.snapshot()).outputConfirmation).toBe('confirmed')
    gate.release()
    holdPlayer.complete()
    const turn = await turnPromise
    expect(turn.status).toBe('completed')
    expect(runner.deliveries()[0]?.classification).toBe('fully-delivered')
  })

  it('conflicts a receipt id reused across different outputs', async () => {
    const player = createScriptedReceiptPlayer(() => ({ stage: 'completed', receiptId: 'receipt-shared' }))
    const runner = createCoordinatorRunner({ player })
    await runner.resume()
    await runner.accept('first output')
    const first = await runner.runTurn()
    expect(first.status).toBe('completed')
    expect(runner.deliveries()).toHaveLength(1)
    await runner.accept('second output')
    const second = await runner.runTurn()
    // The reused id belongs to the first output, so the second cannot finalize.
    expect(runner.deliveries()).toHaveLength(1)
    expect(second.status).toBe('cancelled')
  })

  it('rejects a malformed direct execute receipt without throwing', async () => {
    const player = createMalformedReceiptPlayer()
    const runner = createCoordinatorRunner({ player })
    await runner.resume()
    await runner.accept('malformed direct')
    const turn = await runner.runTurn()
    expect(turn.status).toBe('cancelled')
    expect(runner.deliveries()).toHaveLength(0)
    expect(runner.rejectedReceipts()).toBeGreaterThan(0)
    expect((await runner.endpoint.snapshot()).outputConfirmation).toBe('unknown')
  })

  it('does not clear a Stop revocation when a held memory commit later settles', async () => {
    const gate = createGate()
    let held = false
    let status: { idle: boolean; activeOutputId: string | null; lastStage: 'started' | null } = {
      idle: true,
      activeOutputId: null,
      lastStage: null,
    }
    const player: PlayerPort = {
      async execute(command) {
        status = { idle: false, activeOutputId: command.outputId, lastStage: 'started' }
        return performanceReceiptSchema.parse({
          receiptId: `receipt-${command.outputId}`,
          outputId: command.outputId,
          sessionId: command.sessionId,
          epoch: command.epoch,
          turnId: command.turnId,
          segmentId: command.segmentId,
          modality: 'audio',
          stage: 'completed',
          localTimeMs: null,
          chunkIds: null,
          reasonCode: null,
          source: 'busy-player',
        })
      },
      async cancel() {
        return null
      },
      status: () => status,
    }
    const runner = createCoordinatorRunner({
      player,
      commit: {
        async commit(delivery) {
          held = true
          await gate.promise
          return deliveryCommitAckSchema.parse({
            status: 'applied',
            effectiveClassification: delivery.classification,
            recordId: 'held-memory',
          })
        },
      },
    })
    await runner.resume()
    await runner.accept('held memory')
    const turnPromise = runner.runTurn()
    await waitUntil(() => held)
    await runner.stop()
    await settle()
    expect((await runner.endpoint.snapshot()).outputConfirmation).toBe('pending')
    gate.release()
    const turn = await turnPromise
    // The late memory completion must not clear the Stop's pending evidence.
    expect((await runner.endpoint.snapshot()).outputConfirmation).toBe('pending')
    expect(turn.status).toBe('cancelled')
  })
})

describe('M5 coordinator write acknowledgement validation (production)', () => {
  it('degrades and blocks work when an append acknowledgement is mismatched', async () => {
    const store = correct.createFixtureEventStore()
    const runner = createCoordinatorRunner({ store })
    await runner.resume()
    await settle()
    store.mutateAppendAck = (ack) => ({ ...ack, seq: ack.seq + 100 })
    await runner.accept('mismatched append ack')
    await settle()
    expect(runner.lifecycle()).toBe('degraded')
    expect(runner.storageFailureObserved()).toBe(true)
    expect((await runner.runTurn()).status).toBe('degraded')
    expect(runner.selectionCalls()).toBe(0)
  })

  it('degrades when the store rejects an append acknowledgement', async () => {
    const store = correct.createFixtureEventStore()
    const runner = createCoordinatorRunner({ store })
    await runner.resume()
    await settle()
    store.failNextAppend = true
    await runner.accept('rejected append ack')
    await settle()
    expect(runner.lifecycle()).toBe('degraded')
    expect(runner.storageFailureObserved()).toBe(true)
    expect((await runner.runTurn()).status).toBe('degraded')
    expect(runner.selectionCalls()).toBe(0)
  })

  it('does not start a queued store write after an earlier write fails', async () => {
    const store = correct.createFixtureEventStore()
    const runner = createCoordinatorRunner({ store })
    await runner.resume()
    await settle()
    store.failNextAppend = true
    await runner.accept('first write fails')
    await runner.accept('second write must not start')
    await settle()
    expect(runner.lifecycle()).toBe('degraded')
    // The second append was queued but must not have run after the first failed.
    expect(store.events.some((event) => event.type === 'input.accepted')).toBe(false)
  })

  it('degrades when the store throws on append', async () => {
    const store = correct.createFixtureEventStore()
    const runner = createCoordinatorRunner({ store })
    await runner.resume()
    await settle()
    store.throwNextAppend = true
    await runner.accept('throwing append')
    await settle()
    expect(runner.lifecycle()).toBe('degraded')
    expect((await runner.runTurn()).status).toBe('degraded')
    expect(runner.selectionCalls()).toBe(0)
  })

  it('degrades on an atomic delivery conflict without committing memory', async () => {
    const store = correct.createFixtureEventStore()
    let memoryCalls = 0
    const runner = createCoordinatorRunner({
      store,
      commit: {
        async commit() {
          memoryCalls += 1
          return deliveryCommitAckSchema.parse({
            status: 'applied',
            effectiveClassification: 'fully-delivered',
            recordId: 'unreachable',
          })
        },
      },
    })
    await runner.resume()
    await runner.accept('atomic conflict')
    await settle()
    store.mutateCommitAck = (ack) => ({
      event: ack.event,
      delivery: {
        status: 'conflict',
        recordedClassification: 'fully-delivered',
        incomingClassification: 'fully-delivered',
        conflictRecordId: 'forged-conflict',
      },
    })
    const turn = await runner.runTurn()
    expect(turn.status).toBe('degraded')
    expect(runner.lifecycle()).toBe('degraded')
    expect(runner.deliveries()).toHaveLength(0)
    // A failed atomic persist must not reach the memory commit port.
    expect(memoryCalls).toBe(0)
  })

  it('degrades on a conflicting memory commit without publishing a delivery', async () => {
    const runner = createCoordinatorRunner({
      commit: {
        async commit() {
          return deliveryCommitAckSchema.parse({
            status: 'conflict',
            recordedClassification: 'not-delivered',
            incomingClassification: 'fully-delivered',
            conflictRecordId: 'forged-conflict',
          })
        },
      },
    })
    await runner.resume()
    await runner.accept('memory conflict')
    const turn = await runner.runTurn()
    expect(turn.status).toBe('degraded')
    expect(runner.lifecycle()).toBe('degraded')
    expect(runner.deliveries()).toHaveLength(0)
  })

  it('degrades on a malformed memory commit acknowledgement', async () => {
    const runner = createCoordinatorRunner({
      commit: {
        async commit() {
          return {} as never
        },
      },
    })
    await runner.resume()
    await runner.accept('malformed memory ack')
    const turn = await runner.runTurn()
    expect(turn.status).toBe('degraded')
    expect(runner.deliveries()).toHaveLength(0)
  })
})

describe('M5 coordinator bounded peer waits (production)', () => {
  it('validates stage timing configuration and honours legacy aliases', () => {
    expect(() => resolveCycleTimings({ selectionMs: 0 })).toThrow(/selectionMs/)
    expect(() => resolveCycleTimings({ reactionMs: 1.5 })).toThrow(/reactionMs/)
    expect(() => resolveCycleTimings({ playbackMs: -1 })).toThrow(/playbackMs/)
    const resolved = resolveCycleTimings({}, { decisionDeadlineMs: 123, reactionDeadlineMs: 45 })
    expect(resolved.selectionMs).toBe(123)
    expect(resolved.reactionMs).toBe(45)
    expect(resolved.dialogueMs).toBeGreaterThan(0)
  })

  it('times out a never-settling selection as stale without falling back into output', async () => {
    const player = createCountingPlayer(correct.createFixturePlayer())
    const runner = createCoordinatorRunner({
      selection: createNeverSettlingSelectionPort(),
      player,
      timings: { selectionMs: 30 },
    })
    await runner.resume()
    await runner.accept('never selection')
    const turn = await runner.runTurn()
    expect(turn.status).toBe('stale')
    expect(player.executeCalls()).toBe(0)
    expect(runner.deliveries()).toHaveLength(0)
    expect(runner.rejectedLate()).toBeGreaterThanOrEqual(1)
  })

  it('times out a never-settling reaction to a no-op and still speaks', async () => {
    const player = createCountingPlayer(correct.createFixturePlayer())
    const renderer = correct.createCountingRenderer(correct.createFixtureRendererPort())
    const runner = createCoordinatorRunner({
      reaction: createNeverSettlingReactionPort(),
      player,
      renderer,
      timings: { reactionMs: 30 },
    })
    await runner.resume()
    await runner.accept('never reaction')
    const turn = await runner.runTurn()
    expect(turn.status).toBe('completed')
    expect(renderer.calls()).toBe(0)
    expect(player.executeCalls()).toBe(1)
    expect(runner.deliveries()).toHaveLength(1)
    expect(runner.deliveries()[0]?.classification).toBe('fully-delivered')
  })

  it('times out a never-settling dialogue and ends the turn without output', async () => {
    const player = createCountingPlayer(correct.createFixturePlayer())
    const runner = createCoordinatorRunner({
      dialogue: createNeverSettlingDialoguePort(),
      player,
      timings: { dialogueMs: 30 },
    })
    await runner.resume()
    await runner.accept('never dialogue')
    const turn = await runner.runTurn()
    expect(turn.status).toBe('cancelled')
    expect(player.executeCalls()).toBe(0)
    expect(runner.deliveries()).toHaveLength(0)
    expect(runner.events().some((event) => event.type === 'dependency.failed')).toBe(true)
  })

  it('times out a never-settling synthesis without playback', async () => {
    const player = createCountingPlayer(correct.createFixturePlayer())
    const runner = createCoordinatorRunner({
      synthesis: createNeverSettlingSynthesisPort(),
      player,
      timings: { synthesisMs: 30 },
    })
    await runner.resume()
    await runner.accept('never synthesis')
    const turn = await runner.runTurn()
    // A synthesis fault is an explicit safe outcome, never a completed cycle.
    expect(turn.status).toBe('cancelled')
    expect(player.executeCalls()).toBe(0)
    expect(runner.deliveries()).toHaveLength(0)
    expect(runner.events().some((event) => event.type === 'dependency.failed')).toBe(true)
  })

  it('bounds a never-settling renderer without blocking speech', async () => {
    const player = createCountingPlayer(correct.createFixturePlayer())
    const runner = createCoordinatorRunner({
      renderer: createNeverSettlingRendererPort(),
      player,
      timings: { rendererMs: 30 },
    })
    await runner.resume()
    await runner.accept('never renderer')
    const turn = await runner.runTurn()
    expect(turn.status).toBe('completed')
    expect(player.executeCalls()).toBe(1)
    expect(runner.deliveries()).toHaveLength(1)
  })

  it('bounds a never-settling playback and blocks further turns until evidence', async () => {
    const runner = createCoordinatorRunner({
      player: createNeverSettlingPlayerPort(),
      timings: { playbackMs: 30 },
    })
    await runner.resume()
    await runner.accept('never playback')
    const turn = await runner.runTurn()
    // A playback fault is an explicit safe outcome, never a completed cycle.
    expect(turn.status).toBe('cancelled')
    expect(runner.deliveries()).toHaveLength(0)
    await runner.accept('next input')
    expect((await runner.runTurn()).status).toBe('blocked')
  })

  it('releases revoked work that ignores cancellation and progresses a later cycle', async () => {
    const player = createCountingPlayer(correct.createFixturePlayer())
    const runner = createCoordinatorRunner({
      selection: createHangOnceSelectionPort(),
      player,
    })
    await runner.resume()
    await runner.accept('revoked cycle')
    const turnPromise = runner.runTurn()
    await settle()
    expect((await runner.stop()).status).toBe('applied')
    const turn = await turnPromise
    expect(turn.status).toBe('stale')
    expect(runner.deliveries()).toHaveLength(0)
    expect((await runner.resume()).status).toBe('applied')
    await runner.accept('valid cycle')
    const second = await runner.runTurn()
    expect(second.status).toBe('completed')
    expect(player.executeCalls()).toBe(1)
    expect(runner.deliveries()).toHaveLength(1)
  })

  it('never dispatches a segment emitted after the dialogue call completed', async () => {
    const gate = createGate()
    const player = createCountingPlayer(correct.createFixturePlayer())
    const renderer = correct.createCountingRenderer(correct.createFixtureRendererPort())
    const runner = createCoordinatorRunner({
      dialogue: createLateSinkDialoguePort(gate.promise),
      player,
      renderer,
    })
    await runner.resume()
    await runner.accept('late sink')
    const turn = await runner.runTurn()
    expect(turn.status).toBe('completed')
    gate.release()
    await settle()
    expect(player.executeCalls()).toBe(0)
    expect(renderer.calls()).toBe(0)
    expect(runner.deliveries()).toHaveLength(0)
  })
})

describe('M5 coordinator revocation and segment validation (production)', () => {
  it('revokes a held synthesis when the dialogue call times out, with zero later playback', async () => {
    const player = createCountingPlayer(correct.createFixturePlayer())
    const runner = createCoordinatorRunner({
      dialogue: correct.createFixtureDialoguePort(),
      synthesis: createNeverSettlingSynthesisPort(),
      player,
      timings: { dialogueMs: 30, synthesisMs: 5000 },
    })
    await runner.resume()
    await runner.accept('held synthesis')
    const turn = await runner.runTurn()
    expect(turn.status).toBe('cancelled')
    expect(player.executeCalls()).toBe(0)
    expect(runner.deliveries()).toHaveLength(0)
  })

  it('observes a late peer rejection after abort without failing the cycle', async () => {
    const runner = createCoordinatorRunner({ selection: createAbortingRejectionSelectionPort() })
    await runner.resume()
    await runner.accept('abort then reject')
    const turnPromise = runner.runTurn()
    await settle()
    expect((await runner.stop()).status).toBe('applied')
    const turn = await turnPromise
    expect(turn.status).toBe('stale')
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

  it('frees a never-settling execute with cancellation evidence without losing C-04 history', async () => {
    const player = createCancelReleasingPlayerPort(1)
    const runner = createCoordinatorRunner({ segmentCount: 2, player })
    await runner.resume()
    await runner.accept('cancel evidence')
    runner.hooks.onPlaybackStart = async (index) => {
      if (index === 1) await runner.stop()
    }
    const turn = await runner.runTurn()
    const deliveries = runner.deliveries()
    expect(deliveries).toHaveLength(2)
    expect(deliveries[0]?.classification).toBe('fully-delivered')
    expect(deliveries[1]?.classification).toBe('partial-unknown')
    expect(turn.status).toBe('cancelled')
  })

  it('finalizes an output from cancel evidence when execute never settles', async () => {
    const player = createCancelTerminalPlayer()
    const runner = createCoordinatorRunner({ segmentCount: 2, player, timings: { playbackMs: 5000 } })
    await runner.resume()
    await runner.accept('cancel without resolving execute')
    runner.hooks.onPlaybackStart = async (index) => {
      if (index === 1) await runner.stop()
    }
    const turn = await runner.runTurn()
    const deliveries = runner.deliveries()
    expect(deliveries).toHaveLength(2)
    expect(deliveries[0]?.classification).toBe('fully-delivered')
    expect(deliveries[1]?.classification).toBe('partial-unknown')
    expect(turn.status).toBe('cancelled')
  })

  it('rejects a malformed segment and ends the cycle safely', async () => {
    const player = createCountingPlayer(correct.createFixturePlayer())
    const runner = createCoordinatorRunner({
      dialogue: createMalformedSegmentDialoguePort(),
      player,
    })
    await runner.resume()
    await runner.accept('malformed segment')
    const turn = await runner.runTurn()
    expect(turn.status).toBe('cancelled')
    expect(player.executeCalls()).toBe(0)
    expect(runner.deliveries()).toHaveLength(0)
    expect(runner.events().some((event) => event.type === 'segment.rejected')).toBe(true)
  })

  it('rejects a repeated segment index and ends the cycle safely', async () => {
    const runner = createCoordinatorRunner({ dialogue: createRepeatedIndexDialoguePort() })
    await runner.resume()
    await runner.accept('repeated index')
    const turn = await runner.runTurn()
    expect(turn.status).toBe('cancelled')
    expect(runner.deliveries()).toHaveLength(1)
    const reasons = runner
      .events()
      .filter((event) => event.type === 'segment.rejected')
      .map((event) => (event.payload as { reason?: string }).reason)
    expect(reasons).toContain('index')
  })

  it('rejects a completed end whose segment count disagrees', async () => {
    const runner = createCoordinatorRunner({ dialogue: createWrongEndCountDialoguePort() })
    await runner.resume()
    await runner.accept('wrong end count')
    const turn = await runner.runTurn()
    expect(turn.status).toBe('cancelled')
    const reasons = runner
      .events()
      .filter((event) => event.type === 'dependency.failed')
      .map((event) => (event.payload as { reason?: string }).reason)
    expect(reasons).toContain('segment-count-mismatch')
  })

  it('skips punctuation-only speech without playback', async () => {
    const player = createCountingPlayer(correct.createFixturePlayer())
    const runner = createCoordinatorRunner({
      dialogue: createPunctuationOnlyDialoguePort(),
      player,
    })
    await runner.resume()
    await runner.accept('punctuation only')
    const turn = await runner.runTurn()
    expect(turn.status).toBe('completed')
    expect(player.executeCalls()).toBe(0)
    expect(runner.deliveries()).toHaveLength(0)
    expect(runner.events().some((event) => event.type === 'segment.skipped')).toBe(true)
  })
})

describe('M5 coordinator input and control correlation (production)', () => {
  it('rejects an input whose envelope names a foreign session', async () => {
    const runner = createCoordinatorRunner()
    await runner.resume()
    const ack = await runner.endpoint.submitInput(
      {
        protocolVersion: '0.2',
        messageId: 'm-foreign-input',
        sessionId: 'foreign-session',
        epoch: runner.epoch(),
        kind: 'input.submit',
        payload: { source: 'local-audience', text: 'hello' },
      },
      fixtureViewerContext(),
    )
    expect(ack.status).toBe('rejected')
    expect((await runner.runTurn()).status).toBe('no-input')
  })

  it('returns a rejection for null or primitive endpoint messages instead of throwing', async () => {
    const runner = createCoordinatorRunner()
    await runner.resume()
    const nullInput = await runner.endpoint.submitInput(
      null as unknown as InputSubmitMessage,
      fixtureViewerContext(),
    )
    expect(nullInput.status).toBe('rejected')
    const primitiveInput = await runner.endpoint.submitInput(
      42 as unknown as InputSubmitMessage,
      fixtureViewerContext(),
    )
    expect(primitiveInput.status).toBe('rejected')
    const nullControl = await runner.endpoint.control(
      null as unknown as ControlStopMessage,
      fixtureOperatorContext(),
    )
    expect(nullControl.status).toBe('refused')
    const primitiveControl = await runner.endpoint.control(
      'stop' as unknown as ControlStopMessage,
      fixtureOperatorContext(),
    )
    expect(primitiveControl.status).toBe('refused')
  })

  it('refuses Resume for a throwing or contradictory player status', async () => {
    const throwing: PlayerPort = {
      execute: () => new Promise(() => {}),
      async cancel() {
        return null
      },
      status: () => {
        throw new Error('status boom')
      },
    }
    const contradictory: PlayerPort = {
      execute: () => new Promise(() => {}),
      async cancel() {
        return null
      },
      status: () => ({ idle: true, activeOutputId: 'output-x', lastStage: 'started' }),
    }
    for (const player of [throwing, contradictory]) {
      const runner = createCoordinatorRunner({ player })
      await runner.resume()
      expect((await runner.stop()).status).toBe('applied')
      await settle()
      // Invalid status is not idle evidence, so evidence stays unconfirmed.
      expect((await runner.endpoint.snapshot()).outputConfirmation).toBe('pending')
      expect((await runner.resume()).status).toBe('refused')
    }
  })

  it('returns the stored acknowledgement for an identical retransmission and refuses content reuse', async () => {
    const runner = createCoordinatorRunner()
    await runner.resume()
    const first = await runner.accept('hello', 'm-idem')
    const second = await runner.accept('hello', 'm-idem')
    expect(first.status).toBe('accepted')
    expect(second.status).toBe('duplicate')
    if (first.status === 'accepted' && second.status === 'duplicate') {
      expect(second.eventId).toBe(first.eventId)
      expect(second.seq).toBe(first.seq)
    }
    const reuse = await runner.accept('different text', 'm-idem')
    expect(reuse.status).toBe('rejected')
    expect(runner.deliveries()).toHaveLength(0)
  })

  it('refuses a control message whose envelope names a foreign session', async () => {
    const runner = createCoordinatorRunner()
    await runner.resume()
    const ack = await runner.controlWith(
      {
        protocolVersion: '0.2',
        kind: 'control.stop',
        messageId: 'm-foreign-control',
        sessionId: 'foreign-session',
        epoch: runner.epoch(),
        payload: { requestId: 'r-foreign' },
      },
      fixtureOperatorContext(),
    )
    expect(ack.status).toBe('refused')
    expect(runner.lifecycle()).toBe('running')
  })

  it('refuses Resume while the session is already running', async () => {
    const runner = createCoordinatorRunner()
    await runner.resume()
    const ack = await runner.resume()
    expect(ack.status).toBe('refused')
    expect(ack.reasonCode).toBe('already_running')
  })

  it('revokes queued inputs on Stop so a resumed session has none', async () => {
    const runner = createCoordinatorRunner()
    await runner.resume()
    await runner.accept('queued then stopped')
    expect((await runner.stop()).status).toBe('applied')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((await runner.resume()).status).toBe('applied')
    expect((await runner.runTurn()).status).toBe('no-input')
  })

  it('treats a held selection as stale when a new input advances the authoritative snapshot', async () => {
    const gate = createGate()
    const entered = createGate()
    const runner = createCoordinatorRunner({
      selection: createGatedSelectionPort(gate.promise, () => entered.release()),
    })
    await runner.resume()
    await runner.accept('first')
    const turnPromise = runner.runTurn()
    await entered.promise
    await runner.accept('second')
    gate.release()
    const turn = await turnPromise
    // The authoritative decision snapshot advanced while the selection was held:
    // the request is stale and must not fall back from its obsolete candidates.
    expect(turn.status).toBe('stale')
    expect(turn.plan).toBeNull()
    expect(runner.deliveries()).toHaveLength(0)
    expect(runner.rejectedLate()).toBeGreaterThanOrEqual(1)
    const next = await runner.runTurn()
    expect(next.status).toBe('completed')
    expect(runner.deliveries()).toHaveLength(1)
  })
})

function buildCoordinator(overrides: Partial<RuntimeCoordinatorDeps> = {}) {
  const clock = createVirtualClock()
  return createRuntimeCoordinator({
    clock,
    authorizer: correct.createFixtureControlAuthorizer(),
    selection: correct.createFixtureSelectionPort(),
    reaction: correct.createFixtureReactionPort(),
    dialogue: correct.createFixtureDialoguePort(),
    synthesis: correct.createFixtureSynthesisPort(),
    renderer: correct.createFixtureRendererPort(),
    player: correct.createFixturePlayer(),
    commit: correct.createFixtureMemoryCommit(),
    store: correct.createFixtureEventStore(),
    ...overrides,
  })
}

describe('M5 coordinator session configuration (production)', () => {
  it('uses a fresh random session id by default and keeps explicit sessions', async () => {
    const first = buildCoordinator()
    const second = buildCoordinator()
    const firstId = (await first.endpoint.snapshot()).sessionId
    const secondId = (await second.endpoint.snapshot()).sessionId
    expect(firstId).toMatch(/^session-[0-9a-f-]{36}$/)
    expect(firstId).not.toBe(secondId)
    const explicit = buildCoordinator({ sessionId: 'session-explicit' })
    expect((await explicit.endpoint.snapshot()).sessionId).toBe('session-explicit')
  })

  it('validates the session profile before any peer is called', () => {
    expect(() => resolveSessionProfile({ allowedIntents: [] })).toThrow(/allowedIntents/)
    expect(() => resolveSessionProfile({ voiceProfileId: '' })).toThrow(/voiceProfileId/)
    expect(() => resolveSessionProfile({ allowedIntents: ['nope' as never] })).toThrow(/allowedIntents/)
    expect(() => resolveSessionProfile({ maxTurns: -1 })).toThrow(/maxTurns/)
    const resolved = resolveSessionProfile({ personaSummary: 'custom persona' })
    expect(resolved.personaSummary).toBe('custom persona')
    expect(resolved.allowedIntents.length).toBeGreaterThan(0)
  })

  it('validates storage, cancellation and input budgets', () => {
    expect(() => resolveRuntimeBudgets({ storageTtlMs: 0 })).toThrow(/storageTtlMs/)
    expect(() => resolveRuntimeBudgets({ cancelTtlMs: 1.5 })).toThrow(/cancelTtlMs/)
    expect(() => resolveRuntimeBudgets({ inputTtlMs: -1 })).toThrow(/inputTtlMs/)
    const resolved = resolveRuntimeBudgets({ storageTtlMs: 1234, cancelTtlMs: 99 })
    expect(resolved.storageTtlMs).toBe(1234)
    expect(resolved.cancelTtlMs).toBe(99)
  })

  it('routes the configured session profile into peer requests', async () => {
    const selectionRequests: SelectionRequest[] = []
    const decisionRequests: DecisionRequest[] = []
    const synthesisRequests: PreparePerformance[] = []
    const baseSelection = correct.createFixtureSelectionPort()
    const baseReaction = correct.createFixtureReactionPort()
    const baseSynthesis = correct.createFixtureSynthesisPort()
    const selection: SelectionPort = {
      async select(request, context) {
        selectionRequests.push(request)
        return baseSelection.select(request, context)
      },
    }
    const reaction: ReactionPort = {
      async decide(request, context) {
        decisionRequests.push(request)
        return baseReaction.decide(request, context)
      },
    }
    const synthesis: SynthesisPort = {
      async prepare(request, context) {
        synthesisRequests.push(request)
        return baseSynthesis.prepare(request, context)
      },
    }
    const dialogue = createCapturingDialoguePort(correct.createFixtureDialoguePort())
    const profile: Partial<SessionProfileConfig> = {
      characterProfileId: 'character-custom',
      characterProfileVersion: '2',
      voiceProfileId: 'voice-custom',
      voiceProfileVersion: '7',
      personaSummary: 'Isla is composed.',
      currentTopic: 'topic-custom',
      interactionState: 'excited',
      policyVersion: 'policy-custom',
      providerVersion: 'provider-custom',
      allowedIntents: ['answer'],
      maxTurns: 3,
      maxCharacters: 120,
    }
    const runner = createCoordinatorRunner({
      selection,
      reaction,
      synthesis,
      dialogue,
      profile,
    })
    await runner.resume()
    await runner.accept('profile routing')
    const turn = await runner.runTurn()
    expect(turn.status).toBe('completed')
    expect(selectionRequests[0]?.personaSummary).toBe('Isla is composed.')
    expect(selectionRequests[0]?.currentTopic).toBe('topic-custom')
    expect(selectionRequests[0]?.allowedIntents).toEqual(['answer'])
    expect(selectionRequests[0]?.policyVersion).toBe('policy-custom')
    expect(selectionRequests[0]?.providerVersion).toBe('provider-custom')
    expect(synthesisRequests[0]?.voiceProfileId).toBe('voice-custom')
    expect(synthesisRequests[0]?.voiceProfileVersion).toBe('7')
    expect(decisionRequests[0]?.personaSummary).toBe('Isla is composed.')
    expect(decisionRequests[0]?.interactionState).toBe('excited')
    expect(decisionRequests[0]?.policyVersion).toBe('policy-custom')
    expect(dialogue.requests()[0]?.characterProfileId).toBe('character-custom')
    expect(dialogue.requests()[0]?.characterProfileVersion).toBe('2')
    expect(dialogue.requests()[0]?.contextLimits).toEqual({ maxTurns: 3, maxCharacters: 120 })
  })
})

describe('M5 coordinator epoch and terminal evidence (production)', () => {
  it('carries the recording epoch on a historical delivery finalized after Stop', async () => {
    const player = createCancelTerminalPlayer()
    const runner = createCoordinatorRunner({ segmentCount: 2, player, timings: { playbackMs: 5000 } })
    await runner.resume()
    await runner.accept('historical delivery epoch')
    runner.hooks.onPlaybackStart = async (index) => {
      if (index === 1) await runner.stop()
    }
    const turn = await runner.runTurn()
    expect(turn.status).toBe('cancelled')
    expect(runner.epoch()).toBe(2)
    const deliveryEvents = runner.events().filter((event) => event.type === 'delivery.committed')
    expect(deliveryEvents).toHaveLength(2)
    // Both deliveries were recorded under the turn's epoch, not the Stop epoch.
    expect(deliveryEvents.every((event) => event.epoch === 1)).toBe(true)
  })

  it('treats a cancelled or failed terminal playback as a safe failure, not completed', async () => {
    for (const stage of ['cancelled', 'failed'] as const) {
      const player = createScriptedReceiptPlayer(() => ({ stage }))
      const runner = createCoordinatorRunner({ player })
      await runner.resume()
      await runner.accept(`terminal ${stage}`)
      const turn = await runner.runTurn()
      expect(turn.status).toBe('cancelled')
      expect(runner.deliveries()).toHaveLength(1)
      expect(runner.deliveries()[0]?.classification).toBe('partial-unknown')
    }
  })
})

describe('M5 coordinator receipt identity and Stop confirmation (production)', () => {
  it('conflicts a receipt id reused with a changed immutable field', async () => {
    const gate = createGate()
    const holdPlayer = correct.createFixturePlayer({ hold: true })
    const player = createCapturingPlayer(holdPlayer)
    const runner = createCoordinatorRunner({ player })
    await runner.resume()
    await runner.accept('receipt immutable identity')
    runner.hooks.onPlaybackStart = async () => {
      await gate.promise
    }
    const turnPromise = runner.runTurn()
    await waitUntil(() => player.commands().length > 0)
    const command = player.commands()[0]!
    const message = (source: string, messageId: string) => ({
      protocolVersion: '0.2' as const,
      messageId,
      sessionId: command.sessionId,
      epoch: command.epoch,
      kind: 'performance.receipt' as const,
      payload: fixturePerformanceReceipt({
        receiptId: 'r-immutable',
        outputId: command.outputId,
        sessionId: command.sessionId,
        epoch: command.epoch,
        turnId: command.turnId,
        segmentId: command.segmentId,
        modality: 'audio',
        stage: 'started',
        source,
      }),
    })
    await runner.endpoint.handlePlayerMessage(message('source-one', 'm-imm-1'))
    await runner.endpoint.handlePlayerMessage(message('source-two', 'm-imm-2'))
    gate.release()
    holdPlayer.complete()
    await turnPromise
    const actions = runner
      .events()
      .filter((event) => event.type === 'output.receipt')
      .map((event) => (event.payload as { reconciliation?: string }).reconciliation)
    expect(actions).toContain('conflict')
    expect(actions.filter((action) => action === 'ignore-duplicate')).toHaveLength(0)
  })

  it('keeps cancellation evidence unconfirmed when the held commit fails', async () => {
    const player = createCancelReleasingPlayerPort(0)
    const runner = createCoordinatorRunner({
      player,
      commit: {
        async commit() {
          return deliveryCommitAckSchema.parse({
            status: 'failed',
            reasonCode: 'storage_unavailable',
            message: 'fixture memory failure',
          })
        },
      },
    })
    await runner.resume()
    await runner.accept('cancel with failed commit')
    runner.hooks.onPlaybackStart = async () => {
      await runner.stop()
    }
    const turn = await runner.runTurn()
    await settle()
    expect(runner.lifecycle()).toBe('degraded')
    expect((await runner.endpoint.snapshot()).outputConfirmation).toBe('pending')
    expect(runner.deliveries()).toHaveLength(0)
    expect(turn.status).toBe('degraded')
  })

  it('records a late execute result as historical evidence without re-dispatch', async () => {
    const late: { resolve: ((receipt: PerformanceReceipt) => void) | null } = { resolve: null }
    const captured: { command: PerformanceCommand | null } = { command: null }
    let executeCalls = 0
    const player: PlayerPort = {
      execute(command) {
        executeCalls += 1
        captured.command = command
        return new Promise<PerformanceReceipt>((resolve) => {
          late.resolve = resolve
        })
      },
      async cancel() {
        return null
      },
      status: () => ({ idle: true, activeOutputId: null, lastStage: null }),
    }
    const runner = createCoordinatorRunner({ player, timings: { playbackMs: 20 } })
    await runner.resume()
    await runner.accept('late execute')
    const turn = await runner.runTurn()
    expect(turn.status).toBe('cancelled')
    expect(runner.deliveries()).toHaveLength(0)
    const command = captured.command
    expect(command).not.toBeNull()
    late.resolve!(
      fixturePerformanceReceipt({
        receiptId: 'receipt-late',
        outputId: command!.outputId,
        sessionId: command!.sessionId,
        epoch: command!.epoch,
        turnId: command!.turnId,
        segmentId: command!.segmentId,
        modality: 'audio',
        stage: 'completed',
        localTimeMs: 100,
      }),
    )
    await waitUntil(() => runner.deliveries().length === 1)
    expect(runner.deliveries()[0]?.classification).toBe('fully-delivered')
    // The late result finalizes history only; the output is never dispatched again.
    expect(executeCalls).toBe(1)
  })
})

describe('M5 coordinator endpoint correlation and renderer safety (production)', () => {
  it('rejects player messages that do not correlate to this runtime session', async () => {
    const runner = createCoordinatorRunner()
    await runner.resume()
    await runner.accept('envelope correlation')
    await runner.runTurn()
    expect((await runner.endpoint.snapshot()).outputConfirmation).toBe('confirmed')
    const before = runner.rejectedReceipts()
    await runner.endpoint.handlePlayerMessage({
      protocolVersion: '0.2',
      messageId: 'm-foreign-envelope',
      sessionId: 'foreign-session',
      epoch: 1,
      kind: 'performance.receipt',
      payload: fixturePerformanceReceipt({ sessionId: 'foreign-session', epoch: 1 }),
    })
    // A payload/envelope disagreement fails schema correlation entirely.
    await runner.endpoint.handlePlayerMessage({
      protocolVersion: '0.2',
      messageId: 'm-mismatched-envelope',
      sessionId: 'session-fixture',
      epoch: 1,
      kind: 'performance.receipt',
      payload: fixturePerformanceReceipt({ sessionId: 'other-session', epoch: 1 }),
    })
    expect(runner.rejectedReceipts()).toBe(before + 2)
    // Uncorrelatable messages must not disturb the confirmed output state.
    expect((await runner.endpoint.snapshot()).outputConfirmation).toBe('confirmed')
  })

  it('plays otherwise valid speech with a safe no-op when renderer capabilities fail', async () => {
    const invalid: RendererPort = {
      capabilities: () =>
        ({ rendererId: '', characterId: '', capabilityRevision: -1, actions: [] }) as unknown as CapabilitySnapshot,
      execute: async () => {
        throw new Error('renderer must not run for invalid capabilities')
      },
    }
    const throwing: RendererPort = {
      capabilities: () => {
        throw new Error('capabilities boom')
      },
      execute: async () => {
        throw new Error('renderer must not run after a thrown capabilities')
      },
    }
    for (const renderer of [invalid, throwing]) {
      const player = createCountingPlayer(correct.createFixturePlayer())
      const runner = createCoordinatorRunner({ renderer, player })
      await runner.resume()
      await runner.accept('safe capabilities')
      const turn = await runner.runTurn()
      expect(turn.status).toBe('completed')
      expect(player.executeCalls()).toBe(1)
      expect(runner.deliveries()).toHaveLength(1)
      expect(runner.deliveries()[0]?.classification).toBe('fully-delivered')
    }
  })
})

describe('M5 coordinator trace isolation and stopped-input revocation (production)', () => {
  it('isolates a throwing listener and still persists the input', async () => {
    const store = correct.createFixtureEventStore()
    const runner = createCoordinatorRunner({ store })
    await runner.resume()
    const received: ServerMessage[] = []
    runner.endpoint.onServerMessage(() => {
      throw new Error('bad listener')
    })
    runner.endpoint.onServerMessage((message) => {
      received.push(message)
    })
    const ack = await runner.accept('listener isolation')
    expect(ack.status).toBe('accepted')
    await settle()
    expect(runner.lifecycle()).not.toBe('degraded')
    expect(received.length).toBeGreaterThan(0)
    expect(store.events.some((event) => event.type === 'input.accepted')).toBe(true)
  })

  it('returns detached events, deliveries and outcomes from the trace', async () => {
    const runner = createCoordinatorRunner()
    await runner.resume()
    await runner.accept('detached trace')
    const turn = await runner.runTurn()
    const events = runner.events()
    const deliveries = runner.deliveries()
    expect(events.length).toBeGreaterThan(0)
    expect(deliveries).toHaveLength(1)
    events[0]!.type = 'mutated'
    deliveries[0]!.classification = 'not-delivered'
    turn.deliveries[0]!.classification = 'not-delivered'
    if (turn.plan !== null) turn.plan.reasonCode = 'mutated'
    expect(runner.events()[0]!.type).not.toBe('mutated')
    expect(runner.deliveries()[0]!.classification).toBe('fully-delivered')
    // The outcome carries detached copies, not the internal trace records.
    expect(turn.deliveries[0]).not.toBe(runner.deliveries()[0])
  })

  it('does not leak an input admitted while stopped across Resume', async () => {
    const runner = createCoordinatorRunner()
    await runner.resume()
    expect((await runner.stop()).status).toBe('applied')
    await settle()
    const ack = await runner.accept('admitted while stopped')
    expect(ack.status).toBe('accepted')
    await settle()
    expect((await runner.resume()).status).toBe('applied')
    expect((await runner.runTurn()).status).toBe('no-input')
    expect(runner.deliveries()).toHaveLength(0)
  })
})

function providerCalls(
  runner: ReturnType<typeof createCoordinatorRunner>,
): Array<Record<string, unknown>> {
  return runner
    .events()
    .filter((event) => event.type === 'provider.call')
    .map((event) => event.payload as Record<string, unknown>)
}

function providerCall(
  runner: ReturnType<typeof createCoordinatorRunner>,
  call: string,
): Record<string, unknown> | undefined {
  return providerCalls(runner).find((entry) => entry.call === call)
}

describe('M5 coordinator provider accounting (production)', () => {
  it('counts each invoked provider call once with its identity and usage', async () => {
    const runner = createCoordinatorRunner()
    await runner.resume()
    await runner.accept('accounting success')
    const turn = await runner.runTurn()
    expect(turn.status).toBe('completed')
    const calls = providerCalls(runner)
    expect(calls).toHaveLength(3)
    const selection = providerCall(runner, 'selection')!
    const reaction = providerCall(runner, 'reaction')!
    const dialogue = providerCall(runner, 'dialogue')!
    expect(selection.disposition).toBe('accepted')
    expect(reaction.disposition).toBe('accepted')
    expect(dialogue.disposition).toBe('accepted')
    for (const call of [selection, reaction, dialogue]) {
      expect(call.sessionId).toBe(FIXTURE_SESSION_ID)
      expect(call.epoch).toBe(1)
      expect(call.requestId).toBeTypeOf('string')
      const usage = call.usage as { inputTokens?: number } | null
      expect(usage).not.toBeNull()
      expect(usage?.inputTokens).toBe(10)
    }
    expect(selection.turnId).toBeNull()
    expect(reaction.segmentId).toBeTypeOf('string')
    expect(dialogue.turnId).toBeTypeOf('string')
  })

  it('records an invalid selection with usage and does not count the synthetic fallback', async () => {
    const runner = createCoordinatorRunner({ selection: createMalformedSelectionPort() })
    await runner.resume()
    await runner.accept('invalid fallback accounting')
    const turn = await runner.runTurn()
    expect(turn.status).toBe('completed')
    expect(turn.plan?.reasonCode).toBe('m5-fallback')
    expect(providerCalls(runner).filter((entry) => entry.call === 'selection')).toHaveLength(1)
    const selection = providerCall(runner, 'selection')!
    expect(selection.disposition).toBe('invalid')
    expect((selection.usage as { inputTokens?: number }).inputTokens).toBe(10)
    const planEvent = runner.events().find((event) => event.type === 'selection.plan')!
    expect((planEvent.payload as { synthetic?: boolean }).synthetic).toBe(true)
  })

  it('extracts only safe usage from a thrown provider error', async () => {
    const usage = fixtureUsage({ requestId: 'selection-throw', inputTokens: 4, outputTokens: 2 })
    const selection: SelectionPort = {
      async select() {
        const error = new Error('provider boom with secret') as Error & {
          usage?: unknown
          secret?: string
        }
        error.usage = usage
        error.secret = 'super-secret-token'
        throw error
      },
    }
    const runner = createCoordinatorRunner({ selection })
    await runner.resume()
    await runner.accept('thrown usage accounting')
    await runner.runTurn()
    const selectionCall = providerCall(runner, 'selection')!
    expect(selectionCall.disposition).toBe('failed')
    expect((selectionCall.usage as { inputTokens?: number }).inputTokens).toBe(4)
    const serialized = JSON.stringify(runner.events())
    expect(serialized).not.toContain('super-secret-token')
    expect(serialized).not.toContain('provider boom')
  })

  it('keeps missing usage null instead of zero', async () => {
    const selection: SelectionPort = {
      async select() {
        throw new Error('no usage available')
      },
    }
    const runner = createCoordinatorRunner({ selection })
    await runner.resume()
    await runner.accept('missing usage accounting')
    await runner.runTurn()
    const selectionCall = providerCall(runner, 'selection')!
    expect(selectionCall.disposition).toBe('failed')
    expect(selectionCall.usage).toBeNull()
  })

  it('records a timed-out call once and its late usage separately', async () => {
    const late: { release: ((result: SelectionResult) => void) | null } = { release: null }
    const selection: SelectionPort = {
      select() {
        return new Promise((resolve) => {
          late.release = resolve
        })
      },
    }
    const runner = createCoordinatorRunner({ selection, timings: { selectionMs: 20 } })
    await runner.resume()
    await runner.accept('late selection usage')
    const turn = await runner.runTurn()
    expect(turn.status).toBe('stale')
    const attempts = providerCalls(runner).filter((entry) => entry.call === 'selection')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.disposition).toBe('timeout')
    expect(attempts[0]?.usage).toBeNull()
    late.release!(
      selectionResultSchema.parse({
        requestId: 'selection-late',
        sessionId: FIXTURE_SESSION_ID,
        epoch: 1,
        snapshotRevision: 1,
        disposition: 'respond',
        selectedEventIds: ['event-fixture-1'],
        replyIntent: 'answer',
        reasonCode: 'late',
        provider: 'fixture',
        modelVersion: 'fixture-v1',
        usage: fixtureUsage({ requestId: 'selection-late', inputTokens: 9 }),
      }),
    )
    await waitUntil(() => runner.events().some((event) => event.type === 'provider.usage.late'))
    const lateEvent = runner.events().find((event) => event.type === 'provider.usage.late')!
    expect((lateEvent.payload as { usage?: { inputTokens?: number } }).usage?.inputTokens).toBe(9)
    // The late completion never adds a second attempt or dispatches again.
    expect(providerCalls(runner).filter((entry) => entry.call === 'selection')).toHaveLength(1)
    expect(runner.deliveries()).toHaveLength(0)
  })

  it('persists accepted segments, the selection plan and the dialogue end for reconstruction', async () => {
    const runner = createCoordinatorRunner()
    await runner.resume()
    await runner.accept('reconstruction')
    await runner.runTurn()
    const accepted = runner.events().find((event) => event.type === 'segment.accepted')!
    const segment = (accepted.payload as { segment?: { segmentId?: string; index?: number } }).segment
    expect(segment?.segmentId).toBe(accepted.segmentId)
    expect(segment?.index).toBe(0)
    const plan = runner.events().find((event) => event.type === 'selection.plan')!
    expect((plan.payload as { synthetic?: boolean }).synthetic).toBe(false)
    const result = runner.events().find((event) => event.type === 'dialogue.result')!
    expect((result.payload as { end?: { status?: string } }).end?.status).toBe('completed')
  })
})

describe('M5 coordinator residual boundary defects (production)', () => {
  it('rejects an explicit empty session id at construction', () => {
    expect(() => buildCoordinator({ sessionId: '' })).toThrow(/sessionId/)
  })

  it('constrains the provider selection intent by configured allowedIntents', async () => {
    const selection: SelectionPort = {
      async select(request) {
        return selectionResultSchema.parse({
          requestId: request.requestId,
          sessionId: request.sessionId,
          epoch: request.epoch,
          snapshotRevision: request.snapshotRevision,
          disposition: 'respond',
          selectedEventIds: [request.candidates[0].eventId],
          replyIntent: 'clarify',
          reasonCode: 'clarify',
          provider: 'fixture',
          modelVersion: 'fixture-v1',
          usage: fixtureUsage({ requestId: request.requestId }),
        })
      },
    }
    const runner = createCoordinatorRunner({ selection, profile: { allowedIntents: ['answer'] } })
    await runner.resume()
    await runner.accept('intent constrained')
    const turn = await runner.runTurn()
    expect(turn.status).toBe('completed')
    expect(turn.plan?.reasonCode).toBe('m5-fallback')
    expect(providerCall(runner, 'selection')?.disposition).toBe('invalid')
  })

  it('defers instead of using the answer fallback when it is not allowed', async () => {
    const runner = createCoordinatorRunner({
      selection: createMalformedSelectionPort(),
      profile: { allowedIntents: ['clarify'] },
    })
    await runner.resume()
    await runner.accept('fallback disallowed')
    const turn = await runner.runTurn()
    expect(turn.status).toBe('deferred')
    expect(runner.deliveries()).toHaveLength(0)
  })

  it('reports the safe current renderer capability revision in the snapshot', async () => {
    const alternate = createCoordinatorRunner({ renderer: correct.createAlternateRendererPort() })
    await alternate.resume()
    expect((await alternate.endpoint.snapshot()).capabilityRevision).toBe(3)
    const faulty: RendererPort = {
      capabilities: () => {
        throw new Error('capabilities unavailable')
      },
      execute: async () => {
        throw new Error('renderer unavailable')
      },
    }
    const safe = createCoordinatorRunner({ renderer: faulty })
    expect((await safe.endpoint.snapshot()).capabilityRevision).toBe(0)
  })

  it('returns a detached control acknowledgement safe from caller mutation', async () => {
    const runner = createCoordinatorRunner()
    await runner.resume()
    const message = {
      protocolVersion: '0.2' as const,
      kind: 'control.stop' as const,
      messageId: 'm-detached',
      sessionId: FIXTURE_SESSION_ID,
      epoch: runner.epoch(),
      payload: { requestId: 'r-detached' },
    }
    const first = await runner.controlWith(message, fixtureOperatorContext())
    expect(first.status).toBe('applied')
    first.message = 'mutated by caller'
    const second = await runner.controlWith(
      { ...message, messageId: 'm-detached-2' },
      fixtureOperatorContext(),
    )
    expect(second.status).toBe('duplicate')
    expect(second.message).not.toBe('mutated by caller')
  })

  it('does not confirm Stop from duplicate terminal evidence while finalization is pending', async () => {
    const gate = createGate()
    const store = correct.createFixtureEventStore()
    let held = false
    store.beforeCommit = () => {
      held = true
      return gate.promise
    }
    const captured: { outputId: string; turnId: string; segmentId: string; playing: boolean } = {
      outputId: '',
      turnId: '',
      segmentId: '',
      playing: false,
    }
    const player: PlayerPort = {
      async execute(command) {
        captured.outputId = command.outputId
        captured.turnId = command.turnId
        captured.segmentId = command.segmentId
        captured.playing = true
        return performanceReceiptSchema.parse({
          receiptId: `receipt-held-${command.outputId}`,
          outputId: command.outputId,
          sessionId: command.sessionId,
          epoch: command.epoch,
          turnId: command.turnId,
          segmentId: command.segmentId,
          modality: 'audio',
          stage: 'completed',
          localTimeMs: null,
          chunkIds: null,
          reasonCode: null,
          source: 'held-commit-player',
        })
      },
      async cancel(request) {
        return performanceReceiptSchema.parse({
          receiptId: `receipt-cancel-${request.requestId}`,
          outputId: captured.outputId,
          sessionId: FIXTURE_SESSION_ID,
          epoch: request.revokedEpoch,
          turnId: captured.turnId,
          segmentId: captured.segmentId,
          modality: 'audio',
          stage: 'cancelled',
          localTimeMs: null,
          chunkIds: null,
          reasonCode: null,
          source: 'held-commit-player',
        })
      },
      status: () => ({
        idle: !captured.playing,
        activeOutputId: captured.playing ? captured.outputId : null,
        lastStage: captured.playing ? 'started' : null,
      }),
    }
    const runner = createCoordinatorRunner({ store, player, timings: { playbackMs: 5000 } })
    await runner.resume()
    await runner.accept('held finalization')
    const turnPromise = runner.runTurn()
    await waitUntil(() => held)
    expect((await runner.stop()).status).toBe('applied')
    await settle()
    // Stop's cancellation evidence must await the shared, still-pending commit
    // rather than confirming from the duplicate terminal fact.
    expect((await runner.endpoint.snapshot()).outputConfirmation).toBe('pending')
    gate.release()
    await turnPromise
    expect(runner.deliveries()).toHaveLength(1)
    expect((await runner.endpoint.snapshot()).outputConfirmation).toBe('confirmed')
  })

  it('records historical receipts with their original epoch and full receipt evidence', async () => {
    const player = createCancelTerminalPlayer()
    const runner = createCoordinatorRunner({ segmentCount: 2, player, timings: { playbackMs: 5000 } })
    await runner.resume()
    await runner.accept('historical receipt evidence')
    runner.hooks.onPlaybackStart = async (index) => {
      if (index === 1) await runner.stop()
    }
    const turn = await runner.runTurn()
    expect(runner.epoch()).toBe(2)
    expect(turn.status).toBe('cancelled')
    const receipts = runner.events().filter((event) => event.type === 'output.receipt')
    expect(receipts.length).toBeGreaterThanOrEqual(2)
    expect(receipts.every((event) => event.epoch === 1)).toBe(true)
    for (const event of receipts) {
      const payload = event.payload as { receipt?: { outputId?: string; receiptId?: string } }
      expect(payload.receipt?.outputId).toBe(event.outputId)
      expect(typeof payload.receipt?.receiptId).toBe('string')
    }
  })
})

describe('M5 coordinator final review corrections (production)', () => {
  it('keeps usage from a synchronous provider throw and counts a single attempt', async () => {
    const usage = fixtureUsage({ requestId: 'sync-throw', inputTokens: 6, outputTokens: 2 })
    const selection: SelectionPort = {
      select() {
        const error = new Error('synchronous failure') as Error & { usage?: unknown }
        error.usage = usage
        throw error
      },
    }
    const runner = createCoordinatorRunner({ selection })
    await runner.resume()
    await runner.accept('sync throw usage')
    await runner.runTurn()
    const attempts = providerCalls(runner).filter((entry) => entry.call === 'selection')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.disposition).toBe('failed')
    expect(attempts[0]!.usage).toMatchObject({ inputTokens: 6 })
  })

  it('never reserves or starts a turn when Stop lands during the selection accounting write', async () => {
    const gate = createGate()
    const store = correct.createFixtureEventStore()
    const player = createCountingPlayer(correct.createFixturePlayer())
    const runner = createCoordinatorRunner({ store, player })
    await runner.resume()
    await runner.accept('stop during accounting')
    await waitUntil(() => store.events.some((event) => event.type === 'input.accepted'))
    let held = false
    store.beforeAppend = () => {
      held = true
      return gate.promise
    }
    const turnPromise = runner.runTurn()
    await waitUntil(() => held)
    expect((await runner.stop()).status).toBe('applied')
    store.beforeAppend = undefined
    gate.release()
    const turn = await turnPromise
    await settle()
    expect(turn.status).toBe('stale')
    expect(turn.turnId).toBeNull()
    expect(player.executeCalls()).toBe(0)
    expect(runner.deliveries()).toHaveLength(0)
    expect((await runner.endpoint.snapshot()).activeTurnId).toBeNull()
    expect(runner.events().some((event) => event.type === 'turn.started')).toBe(false)
    // The held accounting record keeps the original epoch identity.
    const providerCallEvent = runner.events().find((event) => event.type === 'provider.call')!
    expect(providerCallEvent.epoch).toBe(1)
    expect(runner.epoch()).toBe(2)
  })

  it('records the accepted input and a provider defer plan for reconstruction', async () => {
    const runner = createCoordinatorRunner({ selection: correct.createDeferringSelectionPort() })
    await runner.resume()
    const ack = await runner.accept('deferred reconstruction')
    expect(ack.status).toBe('accepted')
    const turn = await runner.runTurn()
    expect(turn.status).toBe('deferred')
    const inputEvent = runner.events().find((event) => event.type === 'input.accepted')!
    const recorded = inputEvent.payload as {
      eventId?: string
      input?: { eventId?: string; text?: string; sessionId?: string }
    }
    expect(recorded.eventId).toBe(recorded.input?.eventId)
    expect(recorded.input?.text).toBe('deferred reconstruction')
    expect(recorded.input?.sessionId).toBe(FIXTURE_SESSION_ID)
    const planEvent = runner.events().find((event) => event.type === 'selection.plan')!
    const plan = planEvent.payload as { plan?: { disposition?: string }; synthetic?: boolean }
    expect(plan.plan?.disposition).toBe('defer')
    expect(plan.synthetic).toBe(false)
  })

  it('records no reaction call when Stop aborts before the reaction invocation', async () => {
    let coordinator: ReturnType<typeof buildCoordinator> | null = null
    let reactionCalls = 0
    let stopped = false
    const reaction: ReactionPort = {
      async decide() {
        reactionCalls += 1
        throw new Error('reaction must not be invoked')
      },
    }
    const renderer: RendererPort = {
      capabilities: () => {
        if (!stopped && coordinator !== null) {
          stopped = true
          void coordinator.endpoint.control(
            {
              protocolVersion: '0.2',
              kind: 'control.stop',
              messageId: 'm-stop-during-capabilities',
              sessionId: FIXTURE_SESSION_ID,
              epoch: coordinator.epoch(),
              payload: { requestId: 'r-stop-during-capabilities' },
            },
            fixtureOperatorContext(),
          )
        }
        return correct.createFixtureRendererPort().capabilities()
      },
      execute: async () => {
        throw new Error('renderer must not be invoked')
      },
    }
    coordinator = buildCoordinator({ sessionId: FIXTURE_SESSION_ID, reaction, renderer })
    await coordinator.endpoint.control(
      {
        protocolVersion: '0.2',
        kind: 'control.resume',
        messageId: 'm-resume-before-reaction',
        sessionId: FIXTURE_SESSION_ID,
        epoch: 0,
        payload: { requestId: 'r-resume-before-reaction' },
      },
      fixtureOperatorContext(),
    )
    await coordinator.endpoint.submitInput(
      {
        protocolVersion: '0.2',
        messageId: 'm-input-before-reaction',
        sessionId: FIXTURE_SESSION_ID,
        epoch: 1,
        kind: 'input.submit',
        payload: { source: 'local-audience', text: 'stop before reaction' },
      },
      fixtureViewerContext(),
    )
    await coordinator.runTurn()
    expect(reactionCalls).toBe(0)
    expect(coordinator.metrics().reactionAttempts).toBe(0)
    const reactionCall = coordinator
      .events()
      .find(
        (event) =>
          event.type === 'provider.call' &&
          (event.payload as { call?: string }).call === 'reaction',
      )
    expect(reactionCall).toBeUndefined()
  })
})

describe('M5 coordinator controlled shutdown (production)', () => {
  it('settle awaits every queued write and never rejects after dispose', async () => {
    const base = correct.createFixtureEventStore()
    const appendGate = createGate()
    let appendCalls = 0
    const store: EventStorePort = {
      append: async (event) => {
        appendCalls += 1
        // Hold the first queued write so the settle boundary is observable.
        if (appendCalls === 1) await appendGate.promise
        return base.append(event)
      },
      commitDeliveryWithEvent: (delivery, event) => base.commitDeliveryWithEvent(delivery, event),
      readSession: (sessionId) => base.readSession(sessionId),
      exportJsonl: (sessionId) => base.exportJsonl(sessionId),
    }
    const coordinator = buildCoordinator({ sessionId: FIXTURE_SESSION_ID, store })
    await coordinator.endpoint.control(
      {
        protocolVersion: '0.2',
        kind: 'control.resume',
        messageId: 'm-resume-settle',
        sessionId: FIXTURE_SESSION_ID,
        epoch: 0,
        payload: { requestId: 'r-resume-settle' },
      },
      fixtureOperatorContext(),
    )

    let settled = false
    const settling = coordinator.settle().then(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    // The queued write is genuinely held: settle must not resolve past it.
    expect(appendCalls).toBe(1)
    expect(settled).toBe(false)
    appendGate.release()
    await settling
    expect(settled).toBe(true)

    // Settle after disposal still resolves; it never rejects.
    coordinator.dispose()
    await coordinator.settle()
  })

  it('drains an aborted turn to its bookkeeping and then refuses a late receipt without storage access', async () => {
    const base = correct.createFixtureEventStore()
    const gate = createGate()
    const entered = createGate()
    let storeCalls = 0
    const store: EventStorePort = {
      append: async (event) => {
        storeCalls += 1
        return base.append(event)
      },
      commitDeliveryWithEvent: (delivery, event) => base.commitDeliveryWithEvent(delivery, event),
      readSession: (sessionId) => base.readSession(sessionId),
      exportJsonl: (sessionId) => base.exportJsonl(sessionId),
    }
    const coordinator = buildCoordinator({
      sessionId: FIXTURE_SESSION_ID,
      store,
      selection: createGatedSelectionPort(gate.promise, () => entered.release()),
    })
    await coordinator.endpoint.control(
      {
        protocolVersion: '0.2',
        kind: 'control.resume',
        messageId: 'm-resume-drain',
        sessionId: FIXTURE_SESSION_ID,
        epoch: 0,
        payload: { requestId: 'r-resume-drain' },
      },
      fixtureOperatorContext(),
    )
    await coordinator.endpoint.submitInput(
      {
        protocolVersion: '0.2',
        kind: 'input.submit',
        messageId: 'm-input-drain',
        sessionId: FIXTURE_SESSION_ID,
        epoch: 1,
        payload: { source: 'local-audience', text: 'a turn held at selection' },
      },
      fixtureViewerContext(),
    )
    const turn = coordinator.runTurn()
    await entered.promise

    // Disposal aborts the raw provider; settle drains the bounded cancellation
    // bookkeeping for the already-invoked attempt, then seals writes.
    coordinator.dispose()
    const settling = coordinator.settle()
    gate.release()
    const outcome = await turn
    await settling
    expect(outcome.status).toBe('stale')
    expect(coordinator.metrics().storageFailure).toBe(false)
    const events = await base.readSession(FIXTURE_SESSION_ID)
    const types = events.map((event) => event.type)
    expect(types).toContain('provider.call')
    expect(types).toContain('result.stale')
    expect(events.find((event) => event.type === 'provider.call')?.payload).toMatchObject({
      call: 'selection',
      disposition: 'aborted',
    })

    // A late receipt after the write seal is refused without touching storage.
    const callsAfterSeal = storeCalls
    const malformed = { kind: 'performance.receipt' } as unknown as Parameters<
      typeof coordinator.endpoint.handlePlayerMessage
    >[0]
    await coordinator.endpoint.handlePlayerMessage(malformed)
    expect(storeCalls).toBe(callsAfterSeal)
    expect(coordinator.metrics().storageFailure).toBe(false)
  })

  it('observes a valid completed receipt after settle without touching storage or a confirmed outcome', async () => {
    const base = correct.createFixtureEventStore()
    let storeCalls = 0
    const store: EventStorePort = {
      append: async (event) => {
        storeCalls += 1
        return base.append(event)
      },
      commitDeliveryWithEvent: (delivery, event) => {
        storeCalls += 1
        return base.commitDeliveryWithEvent(delivery, event)
      },
      readSession: (sessionId) => base.readSession(sessionId),
      exportJsonl: (sessionId) => base.exportJsonl(sessionId),
    }
    const coordinator = buildCoordinator({ sessionId: FIXTURE_SESSION_ID, store })
    await coordinator.endpoint.control(
      {
        protocolVersion: '0.2',
        kind: 'control.resume',
        messageId: 'm-resume-late-receipt',
        sessionId: FIXTURE_SESSION_ID,
        epoch: 0,
        payload: { requestId: 'r-resume-late-receipt' },
      },
      fixtureOperatorContext(),
    )
    await coordinator.endpoint.submitInput(
      {
        protocolVersion: '0.2',
        kind: 'input.submit',
        messageId: 'm-input-late-receipt',
        sessionId: FIXTURE_SESSION_ID,
        epoch: 1,
        payload: { source: 'local-audience', text: 'a turn that confirms an output' },
      },
      fixtureViewerContext(),
    )
    const turn = await coordinator.runTurn()
    expect(turn.status).toBe('completed')
    expect(coordinator.outputConfirmation()).toBe('confirmed')
    expect(coordinator.deliveries()).toHaveLength(1)
    const committed = coordinator.deliveries()[0]!
    expect(committed.outputId).not.toBeNull()

    coordinator.dispose()
    await coordinator.settle()
    expect(coordinator.metrics().storageFailure).toBe(false)
    expect(coordinator.lifecycle()).toBe('stopped')
    const storeCallsAfterSeal = storeCalls
    const eventsBefore = coordinator.events().length
    const sessionEventsBefore = (await base.readSession(FIXTURE_SESSION_ID)).length

    // A controlled in-process consumer (the player side) delivers a valid
    // completed receipt for the already-confirmed output after the seal, then an
    // unrelated receipt and a malformed envelope. Each is refused before
    // envelope or payload inspection and observed as an incoming call only.
    const receipt = (messageId: string, outputId: string) => ({
      protocolVersion: '0.2' as const,
      messageId,
      sessionId: FIXTURE_SESSION_ID,
      epoch: coordinator.epoch(),
      kind: 'performance.receipt' as const,
      payload: fixturePerformanceReceipt({
        receiptId: `receipt-late-${messageId}`,
        outputId,
        sessionId: FIXTURE_SESSION_ID,
        epoch: coordinator.epoch(),
        turnId: committed.turnId,
        segmentId: committed.segmentId,
        modality: committed.modality,
        stage: 'completed',
      }),
    })
    await coordinator.endpoint.handlePlayerMessage(receipt('m-late-valid', committed.outputId!))
    expect(coordinator.metrics().lateReceipts).toBe(1)
    await coordinator.endpoint.handlePlayerMessage(receipt('m-late-unrelated', 'output-unrelated'))
    expect(coordinator.metrics().lateReceipts).toBe(2)
    const malformed = { kind: 'performance.receipt' } as unknown as Parameters<
      typeof coordinator.endpoint.handlePlayerMessage
    >[0]
    await coordinator.endpoint.handlePlayerMessage(malformed)
    expect(coordinator.metrics().lateReceipts).toBe(3)

    // Nothing was parsed, attributed, persisted or degraded: the confirmed
    // outcome and every recorded event stay exactly as sealed.
    expect(storeCalls).toBe(storeCallsAfterSeal)
    expect(coordinator.metrics().storageFailure).toBe(false)
    expect(coordinator.outputConfirmation()).toBe('confirmed')
    expect(coordinator.deliveries()).toHaveLength(1)
    expect(coordinator.events()).toHaveLength(eventsBefore)
    expect((await base.readSession(FIXTURE_SESSION_ID)).length).toBe(sessionEventsBefore)
  })

  it('refuses the withheld first completion receipt delivered after the seal and keeps history empty', async () => {
    // The real M6 event store and history query: a refused late receipt must
    // leave confirmed spoken history empty rather than fabricate a record.
    const backend = createInMemoryBackend()
    const base = createEventStore(backend)
    const history = createHistoryQuery(backend)
    let storeCalls = 0
    const store: EventStorePort = {
      append: async (event) => {
        storeCalls += 1
        return base.append(event)
      },
      commitDeliveryWithEvent: (delivery, event) => {
        storeCalls += 1
        return base.commitDeliveryWithEvent(delivery, event)
      },
      readSession: (sessionId) => base.readSession(sessionId),
      exportJsonl: (sessionId) => base.exportJsonl(sessionId),
    }
    const baseCommit = correct.createFixtureMemoryCommit()
    let memoryCommitCalls = 0
    const commit: MemoryCommitPort = {
      commit: async (delivery) => {
        memoryCommitCalls += 1
        return baseCommit.commit(delivery)
      },
    }
    const player = createAcceptedReceiptPlayer()
    const coordinator = buildCoordinator({ sessionId: FIXTURE_SESSION_ID, store, commit, player })
    await coordinator.endpoint.control(
      {
        protocolVersion: '0.2',
        kind: 'control.resume',
        messageId: 'm-resume-first-late',
        sessionId: FIXTURE_SESSION_ID,
        epoch: 0,
        payload: { requestId: 'r-resume-first-late' },
      },
      fixtureOperatorContext(),
    )
    await coordinator.endpoint.submitInput(
      {
        protocolVersion: '0.2',
        kind: 'input.submit',
        messageId: 'm-input-first-late',
        sessionId: FIXTURE_SESSION_ID,
        epoch: 1,
        payload: { source: 'local-audience', text: 'a turn whose completion is withheld' },
      },
      fixtureViewerContext(),
    )
    const turn = coordinator.runTurn()
    await waitUntil(() => player.commands().length > 0)
    // The real command identity of the registered output whose first completion
    // receipt the controlled in-process consumer still holds.
    const command = player.commands()[0]!

    // Disposal revokes the session and settle seals the coordinator while that
    // first completion has never been delivered: the output stays unresolved.
    coordinator.dispose()
    const settling = coordinator.settle()
    await turn
    await settling
    expect(coordinator.outputConfirmation()).toBe('unknown')
    expect(coordinator.deliveries()).toHaveLength(0)
    expect(await history.confirmedHistory(FIXTURE_SESSION_ID)).toEqual([])
    const storeCallsAfterSeal = storeCalls
    const memoryCommitsAfterSeal = memoryCommitCalls
    const eventsBefore = coordinator.events().length
    const sessionEventsBefore = (await base.readSession(FIXTURE_SESSION_ID)).length

    // The withheld completion arrives only now, schema-valid and under the real
    // command identity it was registered with.
    const envelope = {
      protocolVersion: '0.2' as const,
      messageId: 'm-first-late',
      sessionId: command.sessionId,
      epoch: command.epoch,
      kind: 'performance.receipt' as const,
      payload: fixturePerformanceReceipt({
        receiptId: 'receipt-first-late',
        outputId: command.outputId,
        sessionId: command.sessionId,
        epoch: command.epoch,
        turnId: command.turnId,
        segmentId: command.segmentId,
        modality: 'audio',
        stage: 'completed',
      }),
    }
    expect(playerMessageSchema.safeParse(envelope).success).toBe(true)

    await coordinator.endpoint.handlePlayerMessage(envelope)
    expect(coordinator.metrics().lateReceipts).toBe(1)
    // The refused call is observable only in memory: no storage write, no
    // memory commit, no promotion of the unknown output, no spoken history.
    expect(coordinator.metrics().storageFailure).toBe(false)
    expect(storeCalls).toBe(storeCallsAfterSeal)
    expect(memoryCommitCalls).toBe(memoryCommitsAfterSeal)
    expect(coordinator.outputConfirmation()).toBe('unknown')
    expect(coordinator.deliveries()).toHaveLength(0)
    expect(coordinator.events()).toHaveLength(eventsBefore)
    expect((await base.readSession(FIXTURE_SESSION_ID)).length).toBe(sessionEventsBefore)
    expect(await history.confirmedHistory(FIXTURE_SESSION_ID)).toEqual([])
  })
})
