import { describe, expect, it } from 'vitest'
import type { PerformanceReceipt } from '../../src/contracts'
import { createCoordinatorRunner, createFixtureRunner } from '../support/runner-factories'
import type { RunnerOptions } from '../support/runner-factories'
import type { ContractRunner, TurnOutcome } from '../support/contract-runner'
import * as correct from '../support/correct-ports'
import { createGate } from '../support/context'
import {
  createCapturingDialoguePort,
  createCapturingPlayer,
  createCorrelationBreakingReactionPort,
  createCorrelationBreakingSelectionPort,
  createCorrelationBreakingSynthesisPort,
  createCountingPlayer,
  createEmptyCapabilityRenderer,
  createGatedCancelPlayer,
  createGatedDialoguePort,
  createGatedReactionPort,
  createGatedSelectionPort,
  createGatedSynthesisPort,
  createLateDialoguePort,
  createMalformedSelectionPort,
  createMismatchedReceiptPlayer,
  createRevisionSwitchingRenderer,
  createThrowingSelectionPort,
  createUnknownReceiptPlayer,
  createWrongModalityReceiptPlayer,
  createWrongRevisionSelectionPort,
} from '../support/gated-ports'
import {
  FIXTURE_SESSION_ID,
  fixturePerformanceReceipt,
  fixtureRuntimeEvent,
} from '../support/fixture-data'

/**
 * Every regression runs against both the fixture reference runner and the
 * production coordinator, with identical assertions.
 */
const runnerFactories: ReadonlyArray<[string, (options?: RunnerOptions) => ContractRunner]> = [
  ['fixture', createFixtureRunner],
  ['coordinator', createCoordinatorRunner],
]

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe.each(runnerFactories)('C-03 deferred providers after Stop and Resume (%s)', (_label, createRunner) => {
  it('rejects a deferred selection result entered before Stop with zero dispatch', async () => {
    const gate = createGate()
    const entered = createGate()
    const player = createCountingPlayer(correct.createFixturePlayer())
    const renderer = correct.createCountingRenderer(correct.createFixtureRendererPort())
    const runner = createRunner({
      selection: createGatedSelectionPort(gate.promise, () => entered.release()),
      player,
      renderer,
    })
    await runner.resume()
    await runner.accept('deferred selection')
    const turnPromise = runner.runTurn()
    await entered.promise
    await runner.stop()
    await settle()
    const resumed = await runner.resume()
    expect(resumed.status).toBe('applied')
    gate.release()
    const turn = await turnPromise
    expect(turn.status).toBe('stale')
    expect(player.executeCalls()).toBe(0)
    expect(renderer.calls()).toBe(0)
    expect(runner.deliveries()).toHaveLength(0)
  })

  it('rejects a deferred dialogue result entered before Stop with zero playback', async () => {
    const gate = createGate()
    const entered = createGate()
    const player = createCountingPlayer(correct.createFixturePlayer())
    const renderer = correct.createCountingRenderer(correct.createFixtureRendererPort())
    const runner = createRunner({
      dialogue: createGatedDialoguePort(gate.promise, 1, () => entered.release()),
      player,
      renderer,
    })
    await runner.resume()
    await runner.accept('deferred dialogue')
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

  it('rejects a deferred synthesis result entered before Stop with zero playback', async () => {
    const gate = createGate()
    const entered = createGate()
    const player = createCountingPlayer(correct.createFixturePlayer())
    const renderer = correct.createCountingRenderer(correct.createFixtureRendererPort())
    const runner = createRunner({
      synthesis: createGatedSynthesisPort(gate.promise, () => entered.release()),
      player,
      renderer,
    })
    await runner.resume()
    await runner.accept('deferred synthesis')
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

  it('rejects a deferred reaction entered before Stop with zero renderer calls', async () => {
    const gate = createGate()
    const entered = createGate()
    const player = createCountingPlayer(correct.createFixturePlayer())
    const renderer = correct.createCountingRenderer(correct.createFixtureRendererPort())
    const runner = createRunner({
      reaction: createGatedReactionPort(gate.promise, () => entered.release()),
      player,
      renderer,
    })
    await runner.resume()
    await runner.accept('deferred reaction')
    const turnPromise = runner.runTurn()
    await entered.promise
    await runner.stop()
    await settle()
    expect((await runner.resume()).status).toBe('applied')
    gate.release()
    await turnPromise
    expect(renderer.calls()).toBe(0)
    expect(player.executeCalls()).toBe(0)
    expect(runner.deliveries()).toHaveLength(0)
  })

  it('rejects a cancellation-ignoring late dialogue producer', async () => {
    const gate = createGate()
    const entered = createGate()
    const player = createCountingPlayer(correct.createFixturePlayer())
    const renderer = correct.createCountingRenderer(correct.createFixtureRendererPort())
    const runner = createRunner({
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
})

describe.each(runnerFactories)('prompt Stop while dependencies are held (%s)', (_label, createRunner) => {
  it('resolves Stop while a store append is held', async () => {
    const gate = createGate()
    const store = correct.createFixtureEventStore()
    const runner = createRunner({ store })
    await runner.resume()
    await runner.accept('held append')
    await Promise.resolve()
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

  it('resolves Stop while a delivery commit is held', async () => {
    const gate = createGate()
    const store = correct.createFixtureEventStore()
    const runner = createRunner({ store })
    await runner.resume()
    await runner.accept('held commit')
    await Promise.resolve()
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

  it('resolves Stop while cancellation evidence is held and refuses early Resume', async () => {
    const gate = createGate()
    const player = createGatedCancelPlayer(correct.createFixturePlayer(), gate.promise)
    const runner = createRunner({ player })
    await runner.resume()
    await runner.accept('held cancel')
    const stopAck = await runner.stop()
    expect(stopAck.status).toBe('applied')
    expect((await runner.resume()).status).toBe('refused')
    gate.release()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((await runner.resume()).status).toBe('applied')
  })
})

describe.each(runnerFactories)('C-10 receipt reconciliation (%s)', (_label, createRunner) => {
  async function startHeldTurn(): Promise<{
    runner: ContractRunner
    command: { outputId: string; sessionId: string; epoch: number; turnId: string; segmentId: string }
    promise: Promise<TurnOutcome>
    release: () => void
    complete: () => void
  }> {
    const gate = createGate()
    const holdPlayer = correct.createFixturePlayer({ hold: true })
    const player = createCapturingPlayer(holdPlayer)
    const runner = createRunner({ player })
    await runner.resume()
    await runner.accept('receipts')
    runner.hooks.onPlaybackStart = async () => {
      await gate.promise
    }
    const promise = runner.runTurn()
    await waitUntil(() => player.commands().length > 0)
    return {
      runner,
      command: player.commands()[0]!,
      promise,
      release: () => gate.release(),
      complete: () => holdPlayer.complete(),
    }
  }

  function receiptMessage(
    command: { outputId: string; sessionId: string; epoch: number; turnId: string; segmentId: string },
    overrides: Partial<PerformanceReceipt>,
    messageId: string,
  ) {
    return {
      protocolVersion: '0.2' as const,
      messageId,
      sessionId: command.sessionId,
      epoch: command.epoch,
      kind: 'performance.receipt' as const,
      payload: fixturePerformanceReceipt({
        outputId: command.outputId,
        sessionId: command.sessionId,
        epoch: command.epoch,
        turnId: command.turnId,
        segmentId: command.segmentId,
        modality: 'audio',
        ...overrides,
      }),
    }
  }

  it('resolves unknown to completed and never overwrites a completed fact', async () => {
    const { runner, command, promise, release, complete } = await startHeldTurn()
    await runner.endpoint.handlePlayerMessage(
      receiptMessage(command, { receiptId: 'r-unknown', stage: 'unknown' }, 'm-unknown'),
    )
    await runner.endpoint.handlePlayerMessage(
      receiptMessage(command, { receiptId: 'r-done', stage: 'completed' }, 'm-done'),
    )
    await runner.endpoint.handlePlayerMessage(
      receiptMessage(command, { receiptId: 'r-conflict', stage: 'failed' }, 'm-conflict'),
    )
    release()
    complete()
    const turn = await promise
    expect(turn.status).toBe('completed')
    expect(runner.deliveries()[0]?.classification).toBe('fully-delivered')
    expect(runner.rejectedReceipts()).toBe(0)
  })

  it('records a conflict when a receipt id is reused with a different stage', async () => {
    const { runner, command, promise, release, complete } = await startHeldTurn()
    await runner.endpoint.handlePlayerMessage(
      receiptMessage(command, { receiptId: 'r-reuse', stage: 'started' }, 'm-started'),
    )
    await runner.endpoint.handlePlayerMessage(
      receiptMessage(command, { receiptId: 'r-reuse', stage: 'completed' }, 'm-reused'),
    )
    release()
    complete()
    await promise
    const conflicts = runner
      .events()
      .filter(
        (event) =>
          event.type === 'output.receipt' &&
          (event.payload as { reconciliation?: string }).reconciliation === 'conflict',
      )
    expect(conflicts.length).toBeGreaterThanOrEqual(1)
  })
})

describe.each(runnerFactories)('C-11 adapter substitution (%s)', (_label, createRunner) => {
  it('preserves observable outcome and passed selection/intent under substitution', async () => {
    async function run(options: RunnerOptions = {}) {
      const dialogue = createCapturingDialoguePort(correct.createFixtureDialoguePort())
      const runner = createRunner({ ...options, dialogue })
      await runner.resume()
      await runner.accept('first question', 'cand-1')
      await runner.accept('second question', 'cand-2')
      const turn = await runner.runTurn()
      const request = dialogue.requests()[0]
      return {
        status: turn.status,
        intent: request?.responsePlan.replyIntent,
        eventId: request?.selectedInput.eventId,
        text: request?.selectedInput.text,
        deliveries: runner.deliveries().map((delivery) => delivery.classification),
      }
    }
    const primary = await run()
    const alternate = await run({
      selection: correct.createAlternateSelectionPort(),
      reaction: correct.createAlternateReactionPort(),
      synthesis: correct.createAlternateSynthesisPort(),
      renderer: correct.createAlternateRendererPort(),
    })
    expect(primary).toMatchObject({
      status: 'completed',
      eventId: 'event-cand-1',
      text: 'first question',
      intent: 'answer',
      deliveries: ['fully-delivered'],
    })
    expect(alternate).toMatchObject({
      status: 'completed',
      eventId: 'event-cand-2',
      text: 'second question',
      intent: 'clarify',
      deliveries: ['fully-delivered'],
    })
  })
})

describe.each(runnerFactories)('C-14 invalid selection and fallback authority (%s)', (_label, createRunner) => {
  it('uses the M5 fallback for malformed and wrong-revision selection', async () => {
    for (const selection of [createMalformedSelectionPort(), createWrongRevisionSelectionPort()]) {
      const runner = createRunner({ selection })
      await runner.resume()
      await runner.accept('fallback')
      const turn = await runner.runTurn()
      expect(turn.status).toBe('completed')
      expect(turn.plan?.reasonCode).toBe('m5-fallback')
      expect(runner.deliveries()).toHaveLength(1)
    }
  })

  it('treats an expired selection result as stale without fallback', async () => {
    const gate = createGate()
    const runner = createRunner({ selection: createGatedSelectionPort(gate.promise) })
    await runner.resume()
    await runner.accept('expired')
    const turnPromise = runner.runTurn()
    runner.clock.advance(6000)
    gate.release()
    const turn = await turnPromise
    expect(turn.status).toBe('stale')
    expect(runner.deliveries()).toHaveLength(0)
  })

  it('does not fall back after Stop', async () => {
    const gate = createGate()
    const player = createCountingPlayer(correct.createFixturePlayer())
    const runner = createRunner({ selection: createGatedSelectionPort(gate.promise), player })
    await runner.resume()
    await runner.accept('stop fallback')
    const turnPromise = runner.runTurn()
    await runner.stop()
    gate.release()
    const turn = await turnPromise
    expect(turn.status).toBe('stale')
    expect(player.executeCalls()).toBe(0)
  })
})

describe.each(runnerFactories)('C-15 attempt accounting (%s)', (_label, createRunner) => {
  it('adds exactly one attempt per new eligible input and none while unchanged', async () => {
    const runner = createRunner({ selection: correct.createDeferringSelectionPort() })
    await runner.resume()
    await runner.accept('first')
    await runner.runTurn()
    expect(runner.selectionCalls()).toBe(1)
    await runner.runTurn()
    expect(runner.selectionCalls()).toBe(1)
    await runner.accept('second')
    await runner.runTurn()
    expect(runner.selectionCalls()).toBe(2)
  })
})

describe.each(runnerFactories)('persistence and projection integrity (%s)', (_label, createRunner) => {
  it('exports and reads exactly the committed runtime events', async () => {
    const store = correct.createFixtureEventStore()
    const runner = createRunner({ store })
    await runner.resume()
    await runner.accept('export')
    await runner.runTurn()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const runtimeEvents = runner.events().slice().sort((a, b) => a.seq - b.seq)
    const read = await store.readSession(FIXTURE_SESSION_ID)
    const jsonl = (await store.exportJsonl(FIXTURE_SESSION_ID))
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line))
    expect(read).toEqual(runtimeEvents)
    expect(jsonl).toEqual(runtimeEvents)
  })

  it('scopes sequence uniqueness per session', async () => {
    const store = correct.createFixtureEventStore()
    const a = await store.append(fixtureRuntimeEvent({ sessionId: 'session-a', eventId: 'a1', seq: 1 }))
    const b = await store.append(fixtureRuntimeEvent({ sessionId: 'session-b', eventId: 'b1', seq: 1 }))
    expect(a.outcome).toBe('stored')
    expect(b.outcome).toBe('stored')
    const duplicate = await store.append(fixtureRuntimeEvent({ sessionId: 'session-a', eventId: 'a2', seq: 1 }))
    expect(duplicate.outcome).toBe('failed')
  })

  it('does not commit spoken memory when the atomic write fails', async () => {
    const store = correct.createFixtureEventStore()
    const runner = createRunner({ store })
    await runner.resume()
    await runner.accept('failed commit')
    store.failNextCommit = true
    await runner.runTurn()
    expect(runner.lifecycle()).toBe('degraded')
    expect(runner.deliveries()).toHaveLength(0)
    const history = await correct
      .createFixtureHistoryQuery(store)
      .confirmedHistory(FIXTURE_SESSION_ID)
    expect(history).toHaveLength(0)
  })
})

describe.each(runnerFactories)('result correlation and input eligibility (%s)', (_label, createRunner) => {
  it('uses the M5 fallback when selection correlation is broken', async () => {
    const runner = createRunner({ selection: createCorrelationBreakingSelectionPort() })
    await runner.resume()
    await runner.accept('broken correlation')
    const turn = await runner.runTurn()
    expect(turn.status).toBe('completed')
    expect(turn.plan?.reasonCode).toBe('m5-fallback')
    expect(runner.deliveries()).toHaveLength(1)
  })

  it('uses the M5 fallback when selection throws', async () => {
    const runner = createRunner({ selection: createThrowingSelectionPort() })
    await runner.resume()
    await runner.accept('throws')
    const turn = await runner.runTurn()
    expect(turn.status).toBe('completed')
    expect(turn.plan?.reasonCode).toBe('m5-fallback')
  })

  it('does not dispatch a preparation result with broken correlation', async () => {
    const player = createCountingPlayer(correct.createFixturePlayer())
    const renderer = correct.createCountingRenderer(correct.createFixtureRendererPort())
    const runner = createRunner({
      synthesis: createCorrelationBreakingSynthesisPort(),
      player,
      renderer,
    })
    await runner.resume()
    await runner.accept('prep correlation')
    await runner.runTurn()
    expect(player.executeCalls()).toBe(0)
    expect(renderer.calls()).toBe(0)
    expect(runner.deliveries()).toHaveLength(0)
  })

  it('no-ops a reaction with broken correlation but still speaks', async () => {
    const player = createCountingPlayer(correct.createFixturePlayer())
    const renderer = correct.createCountingRenderer(correct.createFixtureRendererPort())
    const runner = createRunner({
      reaction: createCorrelationBreakingReactionPort(),
      player,
      renderer,
    })
    await runner.resume()
    await runner.accept('reaction correlation')
    const turn = await runner.runTurn()
    expect(renderer.calls()).toBe(0)
    expect(player.executeCalls()).toBe(1)
    expect(turn.status).toBe('completed')
  })

  it('filters expired inputs before selection', async () => {
    const runner = createRunner()
    await runner.resume()
    await runner.accept('expires soon')
    runner.clock.advance(60001)
    const turn = await runner.runTurn()
    expect(runner.selectionCalls()).toBe(0)
    expect(turn.status).toBe('deferred')
  })

  it('rechecks input expiry before creating a turn', async () => {
    const gate = createGate()
    const entered = createGate()
    const runner = createRunner({
      inputTtlMs: 1000,
      selection: createGatedSelectionPort(gate.promise, () => entered.release()),
    })
    await runner.resume()
    await runner.accept('expires during selection')
    const turnPromise = runner.runTurn()
    await entered.promise
    runner.clock.advance(1001)
    gate.release()
    const turn = await turnPromise
    expect(turn.status).toBe('deferred')
    expect(runner.deliveries()).toHaveLength(0)
  })
})

describe.each(runnerFactories)('capability refresh and reaction options (%s)', (_label, createRunner) => {
  it('no-ops a reaction that outlives a capability change but still speaks', async () => {
    const gate = createGate()
    const entered = createGate()
    const player = createCountingPlayer(correct.createFixturePlayer())
    const renderer = createRevisionSwitchingRenderer(1)
    const runner = createRunner({
      reaction: createGatedReactionPort(gate.promise, () => entered.release()),
      renderer,
      player,
    })
    await runner.resume()
    await runner.accept('capability change')
    const turnPromise = runner.runTurn()
    await entered.promise
    renderer.bump()
    gate.release()
    const turn = await turnPromise
    expect(renderer.calls()).toBe(0)
    expect(player.executeCalls()).toBe(1)
    expect(turn.status).toBe('completed')
  })

  it('includes no-op among reaction options when no action is mapped', async () => {
    const renderer = correct.createCountingRenderer(createEmptyCapabilityRenderer())
    const runner = createRunner({ renderer })
    await runner.resume()
    await runner.accept('no mapped actions')
    const turn = await runner.runTurn()
    expect(renderer.calls()).toBe(0)
    expect(turn.status).toBe('completed')
    expect(runner.deliveries()).toHaveLength(1)
  })
})

describe.each(runnerFactories)('only accepted registered facts authorize delivery (%s)', (_label, createRunner) => {
  it('does not commit when the returned receipt targets an unregistered output', async () => {
    const store = correct.createFixtureEventStore()
    const runner = createRunner({ store, player: createMismatchedReceiptPlayer() })
    await runner.resume()
    await runner.accept('ghost output')
    await runner.runTurn()
    expect(runner.deliveries()).toHaveLength(0)
    expect(store.events.some((event) => event.type === 'delivery.committed')).toBe(false)
    expect(runner.rejectedReceipts()).toBeGreaterThan(0)
  })

  it('does not commit when the returned receipt has a mismatched modality', async () => {
    const store = correct.createFixtureEventStore()
    const runner = createRunner({ store, player: createWrongModalityReceiptPlayer() })
    await runner.resume()
    await runner.accept('wrong modality')
    await runner.runTurn()
    expect(runner.deliveries()).toHaveLength(0)
    expect(store.events.some((event) => event.type === 'delivery.committed')).toBe(false)
  })

  it('blocks new turns while an output is unknown and resumes after evidence', async () => {
    const player = createCapturingPlayer(createUnknownReceiptPlayer())
    const runner = createRunner({ player })
    await runner.resume()
    await runner.accept('unknown output')
    await runner.runTurn()
    expect(runner.deliveries()).toHaveLength(0)
    await runner.accept('next input')
    expect((await runner.runTurn()).status).toBe('blocked')
    const command = player.commands()[0]!
    await runner.endpoint.handlePlayerMessage({
      protocolVersion: '0.2',
      messageId: 'm-resolve',
      sessionId: command.sessionId,
      epoch: command.epoch,
      kind: 'performance.receipt',
      payload: fixturePerformanceReceipt({
        outputId: command.outputId,
        sessionId: command.sessionId,
        epoch: command.epoch,
        turnId: command.turnId,
        segmentId: command.segmentId,
        modality: 'audio',
        stage: 'completed',
        receiptId: 'receipt-resolution',
      }),
    })
    const resumedTurn = await runner.runTurn()
    expect(resumedTurn.status).not.toBe('blocked')
  })

  it('does not play a second segment while the first output stays unknown', async () => {
    const store = correct.createFixtureEventStore()
    const player = createCountingPlayer(createUnknownReceiptPlayer())
    const runner = createRunner({ segmentCount: 2, store, player })
    await runner.resume()
    await runner.accept('two segments unresolved first')
    await runner.runTurn()
    expect(player.executeCalls()).toBe(1)
    expect(runner.deliveries()).toHaveLength(0)
    expect(store.events.some((event) => event.type === 'delivery.committed')).toBe(false)
  })
})
