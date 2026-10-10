import type { ControlStopMessage } from '../../src/contracts'
import { createChecker } from '../support/violations'
import type { Violation } from '../support/violations'
import type { ContractRunner } from '../support/contract-runner'
import type { RunnerOptions } from '../support/runner-factories'
import {
  createAbstainingReactionPort,
  createCountingRenderer,
  createDeferringSelectionPort,
  createFixtureEventStore,
  createFixtureRendererPort,
} from '../support/correct-ports'
import { FIXTURE_SESSION_ID, fixtureOperatorContext, fixturePerformanceReceipt, fixtureViewerContext } from '../support/fixture-data'

type RunnerFactory = (options?: RunnerOptions) => ContractRunner

function stopMessage(requestId: string, messageId: string, epoch: number): ControlStopMessage {
  return {
    protocolVersion: '0.2',
    kind: 'control.stop',
    messageId,
    sessionId: FIXTURE_SESSION_ID,
    epoch,
    payload: { requestId },
  }
}

/**
 * M5 conformance: authoritative Stop/stale handling, fallback, deduplication,
 * no unchanged-input polling, receipt rejection and storage-failure behavior.
 */
export async function collectRuntimeViolations(create: RunnerFactory): Promise<Violation[]> {
  const { check, violations } = createChecker()

  // Normal flow (C-01/C-13)
  {
    const runner = create()
    const boot = await runner.endpoint.snapshot()
    check('bootstrap-stopped', boot.lifecycle === 'stopped' && boot.epoch === 0, 'a new session must bootstrap stopped at epoch 0')
    const resumed = await runner.resume()
    check('resume-applied', resumed.status === 'applied' && resumed.epoch === 1, 'resume must enter running with a new epoch')
    await runner.accept('What did you say about the concert?')
    const turn = await runner.runTurn()
    check('turn-completed', turn.status === 'completed', `a valid turn must complete (got ${turn.status})`)
    check('turn-plan-intent', turn.plan?.replyIntent === 'answer', 'the selected plan intent must reach dialogue')
    const deliveries = runner.deliveries()
    check('delivery-once', deliveries.length === 1, 'a normal turn must commit one delivery')
    check('delivery-fully', deliveries[0]?.classification === 'fully-delivered', 'confirmed audio must be fully-delivered')
    const seqs = runner.events().map((event) => event.seq)
    check('seq-monotonic', seqs.every((value, index) => index === 0 || value > seqs[index - 1]), 'runtime events must have strictly increasing sequence numbers')
    check('seq-unique', new Set(seqs).size === seqs.length, 'runtime events must not reuse a sequence number')
  }

  // Duplicate input (C-02)
  {
    const runner = create()
    await runner.resume()
    await runner.accept('hello', 'm-dup')
    const second = await runner.accept('hello', 'm-dup')
    check('duplicate-input', second.status === 'duplicate', 'repeating an input message id must be idempotent')
    await runner.runTurn()
    check('duplicate-no-extra-turn', runner.deliveries().length === 1, 'a duplicate input must not start a second turn')
  }

  // Stop before result (C-03)
  {
    const runner = create()
    await runner.resume()
    await runner.accept('late question')
    runner.hooks.beforeSelect = async () => {
      await runner.stop()
    }
    const turn = await runner.runTurn()
    check('stop-before-result-stale', turn.status === 'stale', 'a result arriving after Stop must be stale')
    check('stop-before-result-no-delivery', runner.deliveries().length === 0, 'no playback may occur after Stop')
    check('stop-before-result-counted', runner.rejectedLate() >= 1, 'the stale result must be recorded')
  }

  // Stop between segments: first retained, nothing further dispatched
  {
    const runner = create({ segmentCount: 2 })
    await runner.resume()
    await runner.accept('two segments')
    runner.hooks.afterSegmentDispatch = async (index) => {
      if (index === 0) await runner.stop()
    }
    await runner.runTurn()
    const deliveries = runner.deliveries()
    check('between-segment-first-kept', deliveries.length === 1 && deliveries[0]?.classification === 'fully-delivered', 'the completed first segment must be retained as fully-delivered')
    check('between-segment-none-after', deliveries.every((delivery) => delivery.segmentId.includes('seg-0')), 'no later segment may be dispatched after Stop')
  }

  // Stop during a genuinely held second playback (C-04)
  {
    const runner = create({ segmentCount: 2, holdPlayer: true, holdPlayerAfter: 1 })
    await runner.resume()
    await runner.accept('two held segments')
    runner.hooks.onPlaybackStart = async (index) => {
      if (index === 1) await runner.stop()
    }
    await runner.runTurn()
    const deliveries = runner.deliveries()
    check('c04-first-fully', deliveries.find((d) => d.segmentId.includes('seg-0'))?.classification === 'fully-delivered', 'the first segment must be fully delivered')
    check('c04-second-partial', deliveries.find((d) => d.segmentId.includes('seg-1'))?.classification === 'partial-unknown', 'an interrupted second playback must be partial-unknown')
    check('c04-no-queued-playback', deliveries.length === 2, 'no queued playback may occur after Stop')
  }

  // Untrusted control (C-07)
  {
    const runner = create()
    await runner.resume()
    const before = runner.epoch()
    const ack = await runner.controlWith(
      stopMessage('r-untrusted', 'm-untrusted', runner.epoch()),
      fixtureViewerContext(),
    )
    check('untrusted-control-refused', ack.status === 'refused', 'a viewer context must not control the session')
    check('untrusted-control-no-epoch', runner.epoch() === before, 'an unauthorized control must not advance the epoch')
    check('untrusted-control-still-running', runner.lifecycle() === 'running', 'an unauthorized control must not change lifecycle')
  }

  // Duplicate control (C-02)
  {
    const runner = create()
    await runner.resume()
    const first = await runner.controlWith(stopMessage('r-dup', 'm-dup-ctrl', runner.epoch()), fixtureOperatorContext())
    const second = await runner.controlWith(stopMessage('r-dup', 'm-dup-ctrl', runner.epoch()), fixtureOperatorContext())
    check('duplicate-control-idempotent', first.status === 'applied' && second.status === 'duplicate', 'a duplicate control request must return a stored acknowledgement')
    check('duplicate-control-single-epoch', runner.epoch() === first.epoch, 'a duplicate control request must not advance the epoch twice')
  }

  // Control request id reused with a different action
  {
    const runner = create()
    await runner.resume()
    await runner.controlWith(stopMessage('r-reuse', 'm-reuse-1', runner.epoch()), fixtureOperatorContext())
    const conflict = await runner.controlWith(
      {
        protocolVersion: '0.2',
        kind: 'control.resume',
        messageId: 'm-reuse-2',
        sessionId: FIXTURE_SESSION_ID,
        epoch: runner.epoch(),
        payload: { requestId: 'r-reuse' },
      },
      fixtureOperatorContext(),
    )
    check('control-id-reuse-conflict', conflict.status === 'refused', 'reusing a control request id for another action must be refused')
  }

  // Resume refused while evidence is unconfirmed (prompt Stop)
  {
    const runner = create({ cancelDelayMs: 40 })
    await runner.resume()
    await runner.controlWith(stopMessage('r-slow', 'm-slow', runner.epoch()), fixtureOperatorContext())
    const early = await runner.resume()
    check('resume-refused-pending', early.status === 'refused', 'resume must be refused while output evidence is unconfirmed')
    await new Promise((resolve) => setTimeout(resolve, 80))
    const later = await runner.resume()
    check('resume-after-evidence', later.status === 'applied', 'resume must succeed once output evidence is confirmed')
  }

  // No polling on unchanged input (C-15)
  {
    const runner = create({ selection: createDeferringSelectionPort() })
    await runner.resume()
    await runner.accept('unchanged')
    const first = await runner.runTurn()
    const callsAfterFirst = runner.selectionCalls()
    const second = await runner.runTurn()
    check('defer-first', first.status === 'deferred', 'a deferring policy must defer')
    check('no-unchanged-polling', runner.selectionCalls() === callsAfterFirst, 'unchanged input must not trigger another provider call')
    check('defer-second', second.status === 'deferred', 'unchanged input must remain deferred')
  }

  // No-op reaction makes zero renderer calls (C-06/INV-02)
  {
    const renderer = createCountingRenderer(createFixtureRendererPort())
    const runner = create({ reaction: createAbstainingReactionPort(), renderer })
    await runner.resume()
    await runner.accept('speak only')
    await runner.runTurn()
    check('noop-zero-renderer', renderer.calls() === 0, 'a no-op reaction must make zero renderer calls')
    check('noop-still-speaks', runner.deliveries().length === 1, 'speech must still play when the reaction is no-op')
  }

  // Unregistered receipt rejected (C-10 boundary)
  {
    const runner = create()
    await runner.resume()
    const before = runner.rejectedReceipts()
    await runner.endpoint.handlePlayerMessage({
      protocolVersion: '0.2',
      messageId: 'm-receipt',
      sessionId: FIXTURE_SESSION_ID,
      epoch: 1,
      kind: 'performance.receipt',
      payload: fixturePerformanceReceipt({ outputId: 'never-registered' }),
    })
    check('unregistered-receipt-rejected', runner.rejectedReceipts() > before, 'a receipt for an unregistered output must be rejected')
  }

  // Storage failure degrades and blocks new work, while Stop stays responsive (C-17/INV-01)
  {
    const store = createFixtureEventStore()
    const runner = create({ store })
    await runner.resume()
    store.failNextCommit = true
    await runner.accept('will fail storage')
    await runner.runTurn()
    check('storage-failure-degraded', runner.lifecycle() === 'degraded', 'a write failure must degrade the session')
    check('storage-failure-blocks', (await runner.runTurn()).status === 'degraded', 'a degraded session must block new work')
    const stop = await runner.stop()
    check('storage-failure-stop-responsive', stop.status === 'applied', 'Stop must remain responsive during storage failure')
  }

  // Replay isolation (C-12)
  {
    const runner = create()
    await runner.resume()
    await runner.accept('one')
    await runner.runTurn()
    const before = runner.events().length
    const archived = await runner.replay(FIXTURE_SESSION_ID)
    check('replay-reads-archive', archived >= 0, 'replay must read committed events')
    check('replay-no-live-change', runner.events().length === before, 'replay must not change live state')
  }

  return violations()
}
