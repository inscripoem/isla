import { describe, expect, it } from 'vitest'
import { createDeadlineGate } from '../../src/runtime/deadline'
import { createPerformanceBridge } from '../../src/runtime/performance-bridge'
import type { PerformerTransport } from '../../src/runtime/performance-bridge'
import type { PerformanceCommand, PerformanceReadyMessage, PlayerMessage } from '../../src/contracts'
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
function setup(sendResult = true): {
  clock: ReturnType<typeof createVirtualClock>
  bridge: ReturnType<typeof createPerformanceBridge>
  sent: Array<{ kind: string; payload: unknown }>
  evidence: PlayerMessage[]
  bumpGeneration: () => void
  context: (atMs?: number) => { signal: AbortSignal; deadline: { atMs: number } }
  abortLastController: () => void
} {
  const clock = createVirtualClock(0)
  const gate = createDeadlineGate(clock)
  let generation = 1
  const sent: Array<{ kind: string; payload: unknown }> = []
  const evidence: PlayerMessage[] = []
  const bridge = createPerformanceBridge({ sessionId: FIXTURE_SESSION_ID, gate, clock })
  const transport: PerformerTransport = {
    send(message) {
      sent.push(message as unknown as { kind: string; payload: unknown })
      return sendResult
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

describe('performance bridge delayed-execution protocol', () => {
  it('offers without playback, grants after ready, and settles on a terminal receipt', async () => {
    const { bridge, sent, context } = setup()
    const cmd = command()
    const execution = bridge.player.execute(cmd, context())
    expect(sent[0]?.kind).toBe('performance.offer')
    expect(sent.some((message) => message.kind === 'performance.grant')).toBe(false)
    bridge.handleReady(ready(cmd))
    expect(sent.some((message) => message.kind === 'performance.grant')).toBe(true)
    expect(await bridge.deliver(receiptMessage(cmd, { stage: 'completed' }))).toBe('consumed')
    await expect(execution).resolves.toMatchObject({ stage: 'completed' })
    expect(bridge.player.status().idle).toBe(true)
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
    const { bridge, context } = setup(false)
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
})
