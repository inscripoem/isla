import { describe, expect, it } from 'vitest'
import { createDeadlineGate } from '../../src/runtime/deadline'
import type { RuntimeDeadlineGate } from '../../src/runtime/deadline'
import { createPerformanceBridge } from '../../src/runtime/performance-bridge'
import type { PerformerTransport, TransportSendResult } from '../../src/runtime/performance-bridge'
import type { CallContext } from '../../src/contracts'
import type {
  PerformanceCommand,
  PerformanceReadyMessage,
  PerformanceStatusMessage,
  PlayerMessage,
  PlayerStatus,
} from '../../src/contracts'
import {
  FIXTURE_SESSION_ID,
  fixturePerformanceCommand,
  fixturePerformanceReceipt,
} from '../support/fixture-data'
import { createVirtualClock } from '../support/virtual-clock'

/**
 * Performance bridge: delayed-execution handshake, conservative vs
 * not-dispatched outcomes, connection-generation correlation, bounded
 * idempotent cancellation, full-fingerprint retention and the tri-state
 * delivery routing. Virtual clock and captured transport; no real media.
 */
/** A production-like deadline gate that counts outstanding bindings. */
function createCountingGate(clock: ReturnType<typeof createVirtualClock>): {
  gate: RuntimeDeadlineGate
  activeBindings: () => number
} {
  const inner = createDeadlineGate(clock)
  let active = 0
  return {
    gate: {
      bind(context: CallContext) {
        const binding = inner.bind(context)
        active += 1
        let released = false
        return {
          signal: binding.signal,
          release() {
            if (released) return
            released = true
            active -= 1
            binding.release()
          },
        }
      },
      dispose: () => inner.dispose(),
    },
    activeBindings: () => active,
  }
}

function setup(
  sendFor?: (message: unknown) => TransportSendResult,
): {
  clock: ReturnType<typeof createVirtualClock>
  bridge: ReturnType<typeof createPerformanceBridge>
  sent: Array<{ kind: string; payload: unknown }>
  evidence: PlayerMessage[]
  bumpGeneration: () => void
  context: (atMs?: number) => { signal: AbortSignal; deadline: { atMs: number } }
  abortLastController: () => void
  activeBindings: () => number
} {
  const clock = createVirtualClock(0)
  const counting = createCountingGate(clock)
  const gate = counting.gate
  let generation = 1
  const sent: Array<{ kind: string; payload: unknown }> = []
  const evidence: PlayerMessage[] = []
  const bridge = createPerformanceBridge({ sessionId: FIXTURE_SESSION_ID, gate, clock })
  const transport: PerformerTransport = {
    send(message) {
      sent.push(message as unknown as { kind: string; payload: unknown })
      return sendFor === undefined ? 'sent' : sendFor(message)
    },
    async handleEvidence(message) {
      evidence.push(message)
    },
    makeMessageId: () => `m-${sent.length}`,
    generation: () => generation,
  }
  bridge.bindTransport(transport)
  const controllers: AbortController[] = []
  return {
    clock,
    bridge,
    sent,
    evidence,
    bumpGeneration: () => {
      generation += 1
    },
    context: (atMs = 30_000) => {
      const controller = new AbortController()
      controllers.push(controller)
      return { signal: controller.signal, deadline: { atMs } }
    },
    abortLastController: () => controllers[controllers.length - 1]?.abort(),
    activeBindings: () => counting.activeBindings(),
  }
}

function command(overrides: Partial<PerformanceCommand> = {}): PerformanceCommand {
  return fixturePerformanceCommand({ ...overrides })
}

function ready(cmd: PerformanceCommand): PerformanceReadyMessage {
  return {
    protocolVersion: '0.2',
    messageId: 'ready-1',
    sessionId: cmd.sessionId,
    epoch: cmd.epoch,
    kind: 'performance.ready',
    payload: { outputId: cmd.outputId, turnId: cmd.turnId, segmentId: cmd.segmentId },
  }
}

function receiptMessage(
  cmd: PerformanceCommand,
  overrides: Parameters<typeof fixturePerformanceReceipt>[0],
): PlayerMessage {
  return {
    protocolVersion: '0.2',
    messageId: 'receipt-1',
    sessionId: cmd.sessionId,
    epoch: cmd.epoch,
    kind: 'performance.receipt',
    payload: fixturePerformanceReceipt({
      outputId: cmd.outputId,
      sessionId: cmd.sessionId,
      epoch: cmd.epoch,
      turnId: cmd.turnId,
      segmentId: cmd.segmentId,
      ...overrides,
    }),
  }
}

function idleStatus(): PlayerStatus {
  return { idle: true, activeOutputId: null, lastStage: 'completed' }
}

function busyStatus(activeOutputId: string, lastStage: PlayerStatus['lastStage'] = 'completed'): PlayerStatus {
  return { idle: false, activeOutputId, lastStage }
}

function statusMessage(
  cmd: PerformanceCommand,
  status: PlayerStatus,
  overrides: { epoch?: number; outputId?: string } = {},
): PerformanceStatusMessage {
  return {
    protocolVersion: '0.2',
    messageId: 'status-1',
    sessionId: cmd.sessionId,
    epoch: overrides.epoch ?? cmd.epoch,
    kind: 'performance.status',
    payload: { outputId: overrides.outputId ?? cmd.outputId, status },
  }
}

describe('performance bridge delayed-execution protocol', () => {
  it('offers without playback, grants after ready, and settles on a terminal receipt', async () => {
    const { bridge, sent, context } = setup()
    const cmd = command()
    const execution = bridge.player.execute(cmd, context())
    expect(sent[0]?.kind).toBe('performance.offer')
    expect(sent.some((message) => message.kind === 'performance.grant')).toBe(false)
    bridge.handleReady(ready(cmd))
    expect(sent.some((message) => message.kind === 'performance.grant')).toBe(true)
    // The performer reports a clean physical release separately from the receipt.
    expect(bridge.handlePhysicalStatus(statusMessage(cmd, idleStatus()))).toBe(true)
    expect(await bridge.deliver(receiptMessage(cmd, { stage: 'completed' }))).toBe('consumed')
    await expect(execution).resolves.toMatchObject({ stage: 'completed' })
    expect(bridge.player.status().idle).toBe(true)
  })

  it('keeps the completed delivery fact while failed detach blocks physical admission', async () => {
    const { bridge, context } = setup()
    const cmd = command({ outputId: 'output-quarantine' })
    const execution = bridge.player.execute(cmd, context())
    bridge.handleReady(ready(cmd))
    // Natural completion with a failed detach: the M1 status is non-idle but the
    // delivery fact is the true `completed`.
    expect(bridge.handlePhysicalStatus(statusMessage(cmd, busyStatus(cmd.outputId)))).toBe(true)
    expect(await bridge.deliver(receiptMessage(cmd, { stage: 'completed' }))).toBe('consumed')
    await expect(execution).resolves.toMatchObject({ stage: 'completed' })
    expect(bridge.player.status()).toMatchObject({ idle: false })

    // A duplicate still returns the retained completed fact, never re-offered.
    await expect(bridge.player.execute(cmd, context())).resolves.toMatchObject({ stage: 'completed' })
    // A new output is blocked while physical occupancy is unproven-idle.
    await expect(
      bridge.player.execute(command({ outputId: 'output-next' }), context()),
    ).resolves.toMatchObject({ stage: 'unknown', reasonCode: 'unresolved_blocks_admission' })

    // A later correlated idle status (for example after a dispose retry) clears
    // physical occupancy without rewriting the delivery fact.
    expect(bridge.handlePhysicalStatus(statusMessage(cmd, idleStatus()))).toBe(true)
    expect(bridge.player.status().idle).toBe(true)
  })

  it('retains a Stop-detach failure terminal and blocks physical admission', async () => {
    const { bridge, context } = setup()
    const cmd = command({ outputId: 'output-stop-quarantine' })
    bridge.player.execute(cmd, context())
    bridge.handleReady(ready(cmd))
    expect(await bridge.deliver(receiptMessage(cmd, { stage: 'started' }))).toBe('forward')
    const cancel = bridge.player.cancel(
      { requestId: 'c-stop', revokedEpoch: cmd.epoch, newEpoch: cmd.epoch + 1 },
      context(),
    )
    expect(
      await bridge.deliver(receiptMessage(cmd, { stage: 'failed', reasonCode: 'cleanup_failed' })),
    ).toBe('consumed')
    await expect(cancel).resolves.toMatchObject({ stage: 'failed', reasonCode: 'cleanup_failed' })
    // The physical report is non-idle while the failed detach retains media; the
    // delivery fact stays the truthful cleanup failure.
    expect(bridge.handlePhysicalStatus(statusMessage(cmd, busyStatus(cmd.outputId, 'failed')))).toBe(true)
    expect(bridge.player.status()).toMatchObject({ idle: false })
    await expect(bridge.player.execute(cmd, context())).resolves.toMatchObject({
      stage: 'failed',
      reasonCode: 'cleanup_failed',
    })
  })

  it('does not manufacture idle from a missing physical status', async () => {
    const { bridge, context } = setup()
    const cmd = command({ outputId: 'output-no-status' })
    bridge.player.execute(cmd, context())
    bridge.handleReady(ready(cmd))
    expect(await bridge.deliver(receiptMessage(cmd, { stage: 'completed' }))).toBe('consumed')
    // No physical status was reported, so physical occupancy is unproven.
    expect(bridge.player.status()).toMatchObject({ idle: false })
  })

  it('settles a provably-unsent grant as not-dispatched without retaining a binding', async () => {
    const { bridge, sent, context, activeBindings } = setup((message) =>
      (message as { kind?: string }).kind === 'performance.grant' ? 'unsent' : 'sent',
    )
    const cmd = command({ outputId: 'output-unsent' })
    const offer = bridge.player.execute(cmd, context())
    expect(activeBindings()).toBe(1)
    bridge.handleReady(ready(cmd))
    await expect(offer).resolves.toMatchObject({ stage: 'unknown', reasonCode: 'grant_unsent' })
    // The proven-unsent grant released its binding and dispatched nothing.
    expect(activeBindings()).toBe(0)
    expect(sent.filter((message) => message.kind === 'performance.grant')).toHaveLength(1)
    expect(bridge.player.status().idle).toBe(true)
    // A later Stop finds no retained waiter and does not wedge.
    await expect(
      bridge.player.cancel({ requestId: 'c', revokedEpoch: cmd.epoch, newEpoch: cmd.epoch + 1 }, context()),
    ).resolves.toBeNull()
    // A fresh output is admitted: the unsent grant left no physical occupancy.
    const offersBefore = sent.filter((message) => message.kind === 'performance.offer').length
    bridge.player.execute(command({ outputId: 'output-after' }), context())
    expect(sent.filter((message) => message.kind === 'performance.offer').length).toBe(offersBefore + 1)
    expect(activeBindings()).toBe(1)
  })

  it('settles a provably-unsent grant as not-dispatched on expiry without a retained binding', async () => {
    const { bridge, clock, context, activeBindings } = setup((message) =>
      (message as { kind?: string }).kind === 'performance.grant' ? 'unsent' : 'sent',
    )
    const cmd = command({ outputId: 'output-unsent-expiry' })
    const offer = bridge.player.execute(cmd, context(30_000))
    bridge.handleReady(ready(cmd))
    expect(activeBindings()).toBe(0)
    clock.set(40_000)
    await expect(offer).resolves.toMatchObject({ stage: 'unknown', reasonCode: 'grant_unsent' })
    expect(bridge.player.status().idle).toBe(true)
  })

  it('rejects a contradictory, premature or mismatched physical status', async () => {
    const { bridge, bumpGeneration, context } = setup()
    const cmd = command({ outputId: 'output-status-guards' })

    // A status before any grant is not evidence.
    expect(bridge.handlePhysicalStatus(statusMessage(cmd, idleStatus()))).toBe(false)

    bridge.player.execute(cmd, context())
    expect(bridge.handlePhysicalStatus(statusMessage(cmd, idleStatus()))).toBe(false)
    bridge.handleReady(ready(cmd))

    // idle:true with a named active output is contradictory.
    expect(
      bridge.handlePhysicalStatus(
        statusMessage(cmd, { idle: true, activeOutputId: cmd.outputId, lastStage: 'completed' }),
      ),
    ).toBe(false)
    // A non-idle report naming a different active output contradicts the grant.
    expect(
      bridge.handlePhysicalStatus(
        statusMessage(cmd, { idle: false, activeOutputId: 'other', lastStage: 'completed' }),
      ),
    ).toBe(false)
    // A retained terminal does not let a superseded generation attest cleanup.
    expect(await bridge.deliver(receiptMessage(cmd, { stage: 'completed' }))).toBe('consumed')
    bumpGeneration()
    expect(bridge.handlePhysicalStatus(statusMessage(cmd, idleStatus()))).toBe(false)
    expect(bridge.player.status()).toMatchObject({ idle: false })
  })

  it('preserves failed-detach uncertainty across disconnect and rebind', async () => {
    const { bridge, bumpGeneration, context } = setup()
    const cmd = command({ outputId: 'output-detach-failed' })
    bridge.player.execute(cmd, context())
    bridge.handleReady(ready(cmd))
    expect(bridge.handlePhysicalStatus(statusMessage(cmd, busyStatus(cmd.outputId)))).toBe(true)
    expect(await bridge.deliver(receiptMessage(cmd, { stage: 'completed' }))).toBe('consumed')

    // The application advances the connection generation before detaching.
    bumpGeneration()
    bridge.detach('performer_disconnected')
    expect(bridge.player.status()).toMatchObject({ idle: false })
    // A new connection cannot attest the old one's cleanup, and fresh media is
    // still blocked.
    expect(bridge.handlePhysicalStatus(statusMessage(cmd, idleStatus()))).toBe(false)
    await expect(
      bridge.player.execute(command({ outputId: 'output-new' }), context()),
    ).resolves.toMatchObject({ stage: 'unknown', reasonCode: 'unresolved_blocks_admission' })
    expect(bridge.player.status()).toMatchObject({ idle: false })
  })

  it('preserves missing-status uncertainty across disconnect and rebind', async () => {
    const { bridge, bumpGeneration, context } = setup()
    const cmd = command({ outputId: 'output-detach-nostatus' })
    bridge.player.execute(cmd, context())
    bridge.handleReady(ready(cmd))
    expect(await bridge.deliver(receiptMessage(cmd, { stage: 'completed' }))).toBe('consumed')

    bumpGeneration()
    bridge.detach('performer_disconnected')
    expect(bridge.player.status()).toMatchObject({ idle: false })
    await expect(
      bridge.player.execute(command({ outputId: 'output-new' }), context()),
    ).resolves.toMatchObject({ stage: 'unknown', reasonCode: 'unresolved_blocks_admission' })
  })

  it('preserves a genuinely clean disconnect as resolved', async () => {
    const { bridge, sent, bumpGeneration, context } = setup()
    const cmd = command({ outputId: 'output-detach-clean' })
    bridge.player.execute(cmd, context())
    bridge.handleReady(ready(cmd))
    expect(bridge.handlePhysicalStatus(statusMessage(cmd, idleStatus()))).toBe(true)
    expect(await bridge.deliver(receiptMessage(cmd, { stage: 'completed' }))).toBe('consumed')

    bumpGeneration()
    bridge.detach('performer_disconnected')
    expect(bridge.player.status().idle).toBe(true)
    // A fresh output is admitted after the verified clean release.
    const offersBefore = sent.filter((message) => message.kind === 'performance.offer').length
    bridge.player.execute(command({ outputId: 'output-clean-next' }), context())
    expect(sent.filter((message) => message.kind === 'performance.offer').length).toBe(offersBefore + 1)
  })

  it('stays conservative for an ambiguous grant until correlated status', async () => {
    const { bridge, sent, context } = setup((message) =>
      (message as { kind?: string }).kind === 'performance.grant' ? 'ambiguous' : 'sent',
    )
    const cmd = command({ outputId: 'output-ambiguous' })
    bridge.player.execute(cmd, context())
    bridge.handleReady(ready(cmd))
    expect(sent.some((message) => message.kind === 'performance.grant')).toBe(true)
    // Delivery is uncertain: the operation is conservatively granted and can
    // never manufacture idle.
    expect(bridge.player.status()).toMatchObject({ idle: false })
    expect(await bridge.deliver(receiptMessage(cmd, { stage: 'completed' }))).toBe('consumed')
    expect(bridge.player.status()).toMatchObject({ idle: false })
    expect(bridge.handlePhysicalStatus(statusMessage(cmd, idleStatus()))).toBe(true)
    expect(bridge.player.status().idle).toBe(true)
  })

  it('ignores a stale-generation or mismatched physical status', async () => {
    const { bridge, bumpGeneration, context } = setup()
    const cmd = command({ outputId: 'output-status-id' })
    bridge.player.execute(cmd, context())
    bridge.handleReady(ready(cmd))
    // Wrong epoch and wrong output identity are both untrusted.
    expect(bridge.handlePhysicalStatus(statusMessage(cmd, idleStatus(), { epoch: cmd.epoch + 1 }))).toBe(false)
    expect(bridge.handlePhysicalStatus(statusMessage(cmd, idleStatus(), { outputId: 'other-output' }))).toBe(false)
    expect(bridge.player.status().idle).toBe(false)
    // A superseded connection generation makes the report stale.
    bumpGeneration()
    expect(bridge.handlePhysicalStatus(statusMessage(cmd, idleStatus()))).toBe(false)
    expect(bridge.player.status().idle).toBe(false)
  })

  it('settles a superseded connection as not-dispatched and idle', async () => {
    const { bridge, sent, bumpGeneration, context } = setup()
    const cmd = command()
    const execution = bridge.player.execute(cmd, context())
    bumpGeneration()
    bridge.handleReady(ready(cmd))
    expect(sent.some((message) => message.kind === 'performance.grant')).toBe(false)
    await expect(execution).resolves.toMatchObject({ stage: 'unknown', reasonCode: 'stale_connection' })
    expect(bridge.player.status().idle).toBe(true)
  })

  it('does not grant after the server deadline already passed', async () => {
    const { bridge, sent, clock, context } = setup()
    const cmd = command()
    const execution = bridge.player.execute(cmd, context(30_000))
    clock.set(40_000)
    bridge.handleReady(ready(cmd))
    expect(sent.some((message) => message.kind === 'performance.grant')).toBe(false)
    await expect(execution).resolves.toMatchObject({ stage: 'unknown', reasonCode: 'expired_before_grant' })
    expect(bridge.player.status().idle).toBe(true)
  })

  it('never grants when no performer is attached', async () => {
    const { bridge, context } = setup(() => 'unsent')
    await expect(bridge.player.execute(command(), context())).resolves.toMatchObject({
      stage: 'unknown',
      reasonCode: 'performer_unavailable',
    })
    expect(bridge.player.status().idle).toBe(true)
  })

  it('keeps granted-but-unconfirmed work conservative after a disconnect', async () => {
    const { bridge, context } = setup()
    const cmd = command()
    const execution = bridge.player.execute(cmd, context())
    bridge.handleReady(ready(cmd))
    bridge.detach('performer_disconnected')
    await expect(execution).resolves.toMatchObject({ stage: 'unknown' })
    expect(bridge.player.status()).toMatchObject({ idle: false, lastStage: 'unknown' })
  })

  it('settles an offered-but-never-granted disconnect as idle', async () => {
    const { bridge, context } = setup()
    const execution = bridge.player.execute(command(), context())
    bridge.detach('performer_disconnected')
    await expect(execution).resolves.toMatchObject({ stage: 'unknown', reasonCode: 'performer_disconnected' })
    expect(bridge.player.status().idle).toBe(true)
  })

  it('rejects a terminal claim before any grant', async () => {
    const { bridge, context } = setup()
    const cmd = command()
    bridge.player.execute(cmd, context())
    expect(await bridge.deliver(receiptMessage(cmd, { stage: 'completed' }))).toBe('rejected')
  })

  it('rejects receipts from a wrong connection generation', async () => {
    const { bridge, bumpGeneration, context } = setup()
    const cmd = command()
    bridge.player.execute(cmd, context())
    bridge.handleReady(ready(cmd))
    bumpGeneration()
    expect(await bridge.deliver(receiptMessage(cmd, { stage: 'completed' }))).toBe('rejected')
  })

  it('retains the first terminal fact, resolves unknown, and forwards contradictions', async () => {
    const { bridge, context } = setup()
    const cmd = command()
    const execution = bridge.player.execute(cmd, context())
    bridge.handleReady(ready(cmd))
    expect(await bridge.deliver(receiptMessage(cmd, { receiptId: 'unknown-1', stage: 'unknown' }))).toBe('consumed')
    await expect(execution).resolves.toMatchObject({ stage: 'unknown' })
    // A later correlated terminal resolves the retained unknown and is forwarded
    // to the coordinator as historical evidence.
    expect(await bridge.deliver(receiptMessage(cmd, { receiptId: 'done-1', stage: 'completed' }))).toBe('forward')
    // A contradictory terminal never overwrites and is forwarded.
    expect(await bridge.deliver(receiptMessage(cmd, { receiptId: 'fail-1', stage: 'failed' }))).toBe('forward')
  })

  it('resolves concurrent cancels without stranding an earlier waiter', async () => {
    const { bridge, context } = setup()
    const cmd = command()
    bridge.player.execute(cmd, context())
    bridge.handleReady(ready(cmd))
    const cancelA = bridge.player.cancel({ requestId: 'c-a', revokedEpoch: cmd.epoch, newEpoch: cmd.epoch + 1 }, context())
    const cancelB = bridge.player.cancel({ requestId: 'c-b', revokedEpoch: cmd.epoch, newEpoch: cmd.epoch + 1 }, context())
    expect(await bridge.deliver(receiptMessage(cmd, { stage: 'cancelled' }))).toBe('consumed')
    await expect(cancelA).resolves.toMatchObject({ stage: 'cancelled' })
    await expect(cancelB).resolves.toMatchObject({ stage: 'cancelled' })
  })

  it('returns null and clears the waiter when a cancel wait is revoked', async () => {
    const { bridge, context, abortLastController } = setup()
    const cmd = command()
    bridge.player.execute(cmd, context())
    bridge.handleReady(ready(cmd))
    const cancel = bridge.player.cancel({ requestId: 'c', revokedEpoch: cmd.epoch, newEpoch: cmd.epoch + 1 }, context())
    abortLastController()
    await expect(cancel).resolves.toBeNull()
  })

  it('does not re-dispatch an unsettled operation with the same identity', async () => {
    const { bridge, context } = setup()
    const cmd = command()
    const first = bridge.player.execute(cmd, context())
    const second = bridge.player.execute(cmd, context())
    expect(second).toBe(first)
    bridge.detach('performer_disconnected')
    await first
  })

  it('rejects a concurrent dispatch of a different output', async () => {
    const { bridge, context } = setup()
    bridge.player.execute(command({ outputId: 'output-a' }), context())
    await expect(
      bridge.player.execute(command({ outputId: 'output-b' }), context()),
    ).resolves.toMatchObject({ reasonCode: 'concurrent_dispatch' })
  })

  it('treats a reused receipt id with changed localTimeMs as a contradiction', async () => {
    const { bridge, context } = setup()
    const cmd = command()
    bridge.player.execute(cmd, context())
    bridge.handleReady(ready(cmd))
    expect(
      await bridge.deliver(receiptMessage(cmd, { receiptId: 'r-1', stage: 'completed', localTimeMs: 100 })),
    ).toBe('consumed')
    expect(
      await bridge.deliver(receiptMessage(cmd, { receiptId: 'r-1', stage: 'completed', localTimeMs: 200 })),
    ).toBe('forward')
  })

  it('rejects an unregistered or mismatched envelope receipt', async () => {
    const { bridge, context } = setup()
    const cmd = command()
    bridge.player.execute(cmd, context())
    expect(await bridge.deliver(receiptMessage(cmd, { outputId: 'output-other', stage: 'completed' }))).toBe('forward')
    expect(await bridge.deliver(receiptMessage(cmd, { turnId: 'other-turn', stage: 'completed' }))).toBe('rejected')
  })

  it('rejects a changed command for a completed output without re-offering', async () => {
    const { bridge, sent, context } = setup()
    const cmd = command({ outputId: 'output-1', subtitleText: 'first' })
    bridge.player.execute(cmd, context())
    bridge.handleReady(ready(cmd))
    expect(await bridge.deliver(receiptMessage(cmd, { stage: 'completed' }))).toBe('consumed')
    const offersBefore = sent.filter((message) => message.kind === 'performance.offer').length
    const changed = command({ outputId: 'output-1', subtitleText: 'changed' })
    await expect(bridge.player.execute(changed, context())).resolves.toMatchObject({
      stage: 'unknown',
      reasonCode: 'duplicate_identity_conflict',
    })
    expect(sent.filter((message) => message.kind === 'performance.offer').length).toBe(offersBefore)
  })

  it('returns the settled unknown for a duplicate after a disconnect without re-offering', async () => {
    const { bridge, sent, context } = setup()
    const cmd = command({ outputId: 'output-1' })
    const first = bridge.player.execute(cmd, context())
    bridge.handleReady(ready(cmd))
    bridge.detach('performer_disconnected')
    await expect(first).resolves.toMatchObject({ stage: 'unknown' })
    const offersBefore = sent.filter((message) => message.kind === 'performance.offer').length
    await expect(bridge.player.execute(cmd, context())).resolves.toMatchObject({ stage: 'unknown' })
    expect(sent.filter((message) => message.kind === 'performance.offer').length).toBe(offersBefore)
  })

  it('blocks a new output while authoritative playback is unresolved', async () => {
    const { bridge, sent, context } = setup()
    const cmd = command({ outputId: 'output-1' })
    bridge.player.execute(cmd, context())
    bridge.handleReady(ready(cmd))
    await bridge.deliver(receiptMessage(cmd, { stage: 'unknown' }))
    const offersBefore = sent.filter((message) => message.kind === 'performance.offer').length
    await expect(bridge.player.execute(command({ outputId: 'output-2' }), context())).resolves.toMatchObject({
      stage: 'unknown',
      reasonCode: 'unresolved_blocks_admission',
    })
    expect(sent.filter((message) => message.kind === 'performance.offer').length).toBe(offersBefore)
  })

  it('preserves the latest grant and admits a fresh output beyond the retention limit', async () => {
    const { bridge, sent, context } = setup()
    for (let index = 0; index < 70; index += 1) {
      const cmd = command({ outputId: `output-window-${index}` })
      const execution = bridge.player.execute(cmd, context())
      bridge.handleReady(ready(cmd))
      // Each output reports its own trusted clean physical release before the
      // next may be admitted.
      expect(bridge.handlePhysicalStatus(statusMessage(cmd, idleStatus()))).toBe(true)
      expect(await bridge.deliver(receiptMessage(cmd, { stage: 'completed' }))).toBe('consumed')
      await execution
    }
    // Retiring old settled records must not lose the most recent grant's trusted
    // physical status, so the bridge stays idle and admits fresh work.
    expect(bridge.player.status().idle).toBe(true)
    const offersBefore = sent.filter((message) => message.kind === 'performance.offer').length
    bridge.player.execute(command({ outputId: 'output-after-window' }), context())
    expect(sent.filter((message) => message.kind === 'performance.offer').length).toBe(offersBefore + 1)
    expect(bridge.player.status()).toMatchObject({ idle: false })
  })

  it('returns the resolved terminal for a duplicate after unknown-to-terminal resolution', async () => {
    const { bridge, sent, context } = setup()
    const cmd = command({ outputId: 'output-unknown-resolve' })
    const execution = bridge.player.execute(cmd, context())
    bridge.handleReady(ready(cmd))
    expect(await bridge.deliver(receiptMessage(cmd, { receiptId: 'unknown-1', stage: 'unknown' }))).toBe('consumed')
    await expect(execution).resolves.toMatchObject({ stage: 'unknown' })
    // A later correlated terminal resolves the retained unknown and is forwarded
    // to the coordinator as historical evidence.
    expect(await bridge.deliver(receiptMessage(cmd, { receiptId: 'done-1', stage: 'completed' }))).toBe('forward')
    const offersBefore = sent.filter((message) => message.kind === 'performance.offer').length
    // A duplicate of the resolved output returns the retained terminal without
    // re-offering.
    await expect(bridge.player.execute(cmd, context())).resolves.toMatchObject({ stage: 'completed' })
    expect(sent.filter((message) => message.kind === 'performance.offer').length).toBe(offersBefore)
  })

  it('never loses an unresolved output under retention pressure and resolves it to terminal', async () => {
    const { bridge, sent, context } = setup()
    const cmd = command({ outputId: 'output-unresolved' })
    const execution = bridge.player.execute(cmd, context())
    bridge.handleReady(ready(cmd))
    expect(await bridge.deliver(receiptMessage(cmd, { receiptId: 'unknown-u', stage: 'unknown' }))).toBe('consumed')
    await expect(execution).resolves.toMatchObject({ stage: 'unknown' })

    const offers = (): number => sent.filter((message) => message.kind === 'performance.offer').length
    const before = offers()
    // Many attempts must neither create operations nor evict the unresolved
    // fact; the output stays unresolved and blocks admission.
    for (let index = 0; index < 70; index += 1) {
      await expect(bridge.player.execute(command({ outputId: `blocked-${index}` }), context())).resolves.toMatchObject({
        stage: 'unknown',
        reasonCode: 'unresolved_blocks_admission',
      })
    }
    expect(offers()).toBe(before)

    // A later correlated terminal still resolves the retained unresolved fact.
    expect(await bridge.deliver(receiptMessage(cmd, { receiptId: 'done-u', stage: 'completed' }))).toBe('forward')
    // The grant still requires a trusted clean physical release before fresh
    // admission, so report it and confirm a new output is then admitted.
    expect(bridge.handlePhysicalStatus(statusMessage(cmd, idleStatus()))).toBe(true)
    bridge.player.execute(command({ outputId: 'output-after-unresolved' }), context())
    expect(offers()).toBe(before + 1)
  })
})
