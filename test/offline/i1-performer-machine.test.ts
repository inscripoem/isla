import { describe, expect, it } from 'vitest'
import { createPerformerMachine } from '../browser/performer-machine'
import type { PerformerTransport } from '../browser/performer-machine'
import {
  FIXTURE_SESSION_ID,
  fixturePerformanceCommand,
} from '../support/fixture-data'
import {
  createControlledMediaDriver,
  createControlledResolver,
  createTestReceiptTools,
} from '../support/m1-kit'
import type { PerformanceCommand } from '../../src/contracts'

/**
 * Deterministic tests for the shared performer state machine's conservative
 * expiry, correlation and resource cleanup. They inject a browser clock that is
 * deliberately offset from the server's and drive offer/ready/grant through a
 * captured transport, so no real network or timing is involved.
 */
function snapshotMessage(epoch: number): unknown {
  return {
    protocolVersion: '0.2',
    messageId: 'snap-1',
    sessionId: FIXTURE_SESSION_ID,
    epoch,
    kind: 'session.snapshot',
    payload: {
      lifecycle: 'running',
      activeTurnId: null,
      performerStatus: 'idle',
      outputConfirmation: 'confirmed',
      capabilityRevision: 1,
      lastSeq: 0,
    },
  }
}

function offerMessage(command: PerformanceCommand): unknown {
  return {
    protocolVersion: '0.2',
    messageId: 'offer-1',
    sessionId: command.sessionId,
    epoch: command.epoch,
    kind: 'performance.offer',
    payload: command,
  }
}

function grantMessage(command: PerformanceCommand, remainingLifetimeMs: number): unknown {
  return {
    protocolVersion: '0.2',
    messageId: 'grant-1',
    sessionId: command.sessionId,
    epoch: command.epoch,
    kind: 'performance.grant',
    payload: {
      outputId: command.outputId,
      sessionId: command.sessionId,
      epoch: command.epoch,
      turnId: command.turnId,
      segmentId: command.segmentId,
      remainingLifetimeMs,
    },
  }
}

function cancelMessage(command: PerformanceCommand): unknown {
  return {
    protocolVersion: '0.2',
    messageId: 'cancel-1',
    sessionId: command.sessionId,
    epoch: command.epoch + 1,
    kind: 'performance.cancel',
    payload: { requestId: 'r-1', revokedEpoch: command.epoch, newEpoch: command.epoch + 1 },
  }
}

function setup(
  startNow: number,
  options: { media?: ReturnType<typeof createControlledMediaDriver> } = {},
): {
  sent: Array<Record<string, unknown>>
  media: ReturnType<typeof createControlledMediaDriver>
  machine: ReturnType<typeof createPerformerMachine>
  setNow: (value: number) => void
  advance: (ms: number) => void
} {
  let browserNow = startNow
  const sent: Array<Record<string, unknown>> = []
  const media = options.media ?? createControlledMediaDriver({ autoEvents: true })
  const resolver = createControlledResolver()
  resolver.setAutoResolve()
  const transport: PerformerTransport = {
    send: (raw) => {
      sent.push(JSON.parse(raw) as Record<string, unknown>)
    },
  }
  const machine = createPerformerMachine({
    transport,
    media,
    resolver,
    receipts: createTestReceiptTools('machine'),
    now: () => browserNow,
  })
  machine.handleMessage(snapshotMessage(1))
  return {
    sent,
    media,
    machine,
    setNow: (value) => {
      browserNow = value
    },
    advance: (ms) => {
      browserNow += ms
    },
  }
}

function command(overrides: Partial<PerformanceCommand> = {}): PerformanceCommand {
  return fixturePerformanceCommand({ ...overrides })
}

function controlAck(epoch: number): unknown {
  return {
    protocolVersion: '0.2',
    messageId: `ack-${epoch}`,
    sessionId: FIXTURE_SESSION_ID,
    epoch,
    kind: 'control.ack',
    payload: {
      sessionId: FIXTURE_SESSION_ID,
      requestId: `r-${epoch}`,
      requestMessageId: `m-${epoch}`,
      action: 'resume',
      status: 'applied',
      previousEpoch: epoch - 1,
      epoch,
      lifecycle: 'running',
      outputConfirmation: 'confirmed',
      reasonCode: null,
      message: 'ok',
    },
  }
}

function inputAck(epoch: number): unknown {
  return {
    protocolVersion: '0.2',
    messageId: `in-${epoch}`,
    sessionId: FIXTURE_SESSION_ID,
    epoch,
    kind: 'input.ack',
    payload: {
      status: 'accepted',
      requestMessageId: 'm-in',
      eventId: 'event-in',
      sessionId: FIXTURE_SESSION_ID,
      epoch,
      seq: 1,
    },
  }
}

function operatorAck(requestMessageId: string): unknown {
  return {
    protocolVersion: '0.2',
    messageId: 'op-ack',
    sessionId: FIXTURE_SESSION_ID,
    epoch: 1,
    kind: 'operator.ack',
    payload: { role: 'operator', requestMessageId },
  }
}

function attachAck(epoch: number): unknown {
  return {
    protocolVersion: '0.2',
    messageId: 'attach-ack',
    sessionId: FIXTURE_SESSION_ID,
    epoch,
    kind: 'session.attach.ack',
    payload: { connectionId: 'conn-1', performer: true },
  }
}

/** Lets the controller's admission microtasks run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function countReceipts(
  sent: Array<Record<string, unknown>>,
  outputId: string,
  stage: string,
): number {
  return sent.filter((message) => {
    if (message.kind !== 'performance.receipt') return false
    const payload = message.payload as { outputId?: string; stage?: string }
    return payload.outputId === outputId && payload.stage === stage
  }).length
}

describe('performer machine terminal publication', () => {
  it('publishes an ordinary terminal exactly once', async () => {
    const { sent, machine } = setup(5_000)
    const cmd = command({ outputId: 'once-1' })
    machine.handleMessage(offerMessage(cmd))
    machine.handleMessage(grantMessage(cmd, 1_000))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(countReceipts(sent, 'once-1', 'completed')).toBe(1)
  })

  it('reconciles a cached terminal after the 64-entry retirement boundary and frees admission', async () => {
    const { sent, media, machine } = setup(5_000)
    const firstId = 'retire-0'
    for (let index = 0; index < 65; index += 1) {
      const cmd = command({ outputId: `retire-${index}` })
      machine.handleMessage(offerMessage(cmd))
      machine.handleMessage(grantMessage(cmd, 1_000))
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(media.createCount()).toBe(65)
    expect(countReceipts(sent, firstId, 'completed')).toBe(1)

    // Retry the retired output: the M1 controller still retains the
    // current-epoch terminal and returns it without an observer callback.
    const retry = command({ outputId: firstId })
    machine.handleMessage(offerMessage(retry))
    machine.handleMessage(grantMessage(retry, 1_000))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(countReceipts(sent, firstId, 'completed')).toBe(2)
    // The cached terminal did not create media, and admission was released.
    expect(media.createCount()).toBe(65)

    const fresh = command({ outputId: 'fresh-after-retire' })
    machine.handleMessage(offerMessage(fresh))
    machine.handleMessage(grantMessage(fresh, 1_000))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(media.createCount()).toBe(66)
  })

  it('does not reopen local admission when a terminal cleanup failed', async () => {
    const media = createControlledMediaDriver({ autoEvents: true, detachResult: false })
    const { sent, machine } = setup(5_000, { media })
    const first = command({ outputId: 'cleanup-failed-1' })
    machine.handleMessage(offerMessage(first))
    machine.handleMessage(grantMessage(first, 1_000))
    await new Promise((resolve) => setTimeout(resolve, 20))
    // The delivery fact is the truthful natural `completed` and is published
    // exactly once, but the failed detach retains quarantined media.
    expect(countReceipts(sent, 'cleanup-failed-1', 'completed')).toBe(1)
    expect(media.current()?.detached()).toBe(false)

    // Admission stays closed: no ready is sent for a fresh offer and no media is
    // created while the controller remains physically occupied.
    const next = command({ outputId: 'cleanup-failed-next' })
    const readyBefore = sent.filter((message) => message.kind === 'performance.ready').length
    machine.handleMessage(offerMessage(next))
    machine.handleMessage(grantMessage(next, 1_000))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sent.filter((message) => message.kind === 'performance.ready').length).toBe(readyBefore)
    expect(media.createCount()).toBe(1)
  })
})

describe('performer machine conservative expiry', () => {
  it('applies the server remaining lifetime to its own request start', async () => {
    const { sent, media, machine, advance } = setup(5_000)
    const cmd = command()
    machine.handleMessage(offerMessage(cmd))
    expect(sent.some((message) => message.kind === 'performance.ready')).toBe(true)
    advance(200)
    machine.handleMessage(grantMessage(cmd, 1_000))
    // remainingLocal = 1000 - 200 = 800 > 0, so playback is admitted.
    await settle()
    expect(media.createCount()).toBe(1)
  })

  it('discards a grant past the conservative local expiry without playback', () => {
    const { sent, media, machine, advance } = setup(5_000)
    const cmd = command()
    machine.handleMessage(offerMessage(cmd))
    advance(1_100)
    machine.handleMessage(grantMessage(cmd, 1_000))
    expect(media.createCount()).toBe(0)
    const expired = sent.find(
      (message) => (message.payload as { reasonCode?: string } | undefined)?.reasonCode === 'offer_expired',
    )
    expect(expired).toBeDefined()
  })

  it('works across different clock origins (browser offset from server)', async () => {
    const { media, machine } = setup(10_000_000)
    const cmd = command()
    machine.handleMessage(offerMessage(cmd))
    machine.handleMessage(grantMessage(cmd, 500))
    await settle()
    expect(media.createCount()).toBe(1)
  })

  it('ignores a grant that arrives after Stop', () => {
    const { media, machine } = setup(5_000)
    const cmd = command()
    machine.handleMessage(offerMessage(cmd))
    machine.handleMessage(cancelMessage(cmd))
    machine.handleMessage(grantMessage(cmd, 1_000))
    expect(media.createCount()).toBe(0)
  })

  it('ignores a duplicate grant without replacing abort ownership', async () => {
    const { media, machine } = setup(5_000)
    const cmd = command()
    machine.handleMessage(offerMessage(cmd))
    machine.handleMessage(grantMessage(cmd, 1_000))
    machine.handleMessage(grantMessage(cmd, 500))
    await settle()
    expect(media.createCount()).toBe(1)
  })

  it('releases a completed operation so a later offer is accepted', async () => {
    const { media, machine } = setup(5_000)
    const first = command({ outputId: 'output-1' })
    machine.handleMessage(offerMessage(first))
    machine.handleMessage(grantMessage(first, 1_000))
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = command({ outputId: 'output-2' })
    machine.handleMessage(offerMessage(second))
    machine.handleMessage(grantMessage(second, 1_000))
    await settle()
    expect(media.createCount()).toBe(2)
  })

  it('rejects a malformed server message instead of casting it', () => {
    const { media, machine } = setup(5_000)
    machine.handleMessage({ kind: 'performance.offer' })
    machine.handleMessage('nonsense')
    expect(media.createCount()).toBe(0)
  })

  it('ignores stale messages after an epoch advance and does not block fresh work', async () => {
    const { sent, media, machine } = setup(5_000)
    const stale = command({ outputId: 'output-stale', subtitleText: 'stale subtitle' })
    machine.handleMessage(offerMessage(stale))
    // Stop advances 1 -> 2; Resume ack then advances to 3.
    machine.handleMessage(cancelMessage(stale))
    machine.handleMessage(controlAck(3))
    expect(machine.state().epoch).toBe(3)

    const readyBefore = sent.filter((message) => message.kind === 'performance.ready').length
    const displayBefore = machine.state().display
    machine.handleMessage(offerMessage(stale))
    machine.handleMessage(grantMessage(stale, 1_000))
    machine.handleMessage(inputAck(1))
    machine.handleMessage(snapshotMessage(1))
    machine.handleMessage(cancelMessage(stale))
    expect(media.createCount()).toBe(0)
    expect(machine.state().epoch).toBe(3)
    expect(machine.state().display).toEqual(displayBefore)
    expect(sent.filter((message) => message.kind === 'performance.ready').length).toBe(readyBefore)

    const fresh = command({ outputId: 'output-fresh', epoch: 3 })
    machine.handleMessage(offerMessage(fresh))
    machine.handleMessage(grantMessage(fresh, 1_000))
    await settle()
    expect(media.createCount()).toBe(1)
  })

  it('ignores a repeated offer for an already completed output', async () => {
    const { media, machine } = setup(5_000)
    const cmd = command({ outputId: 'output-dup' })
    machine.handleMessage(offerMessage(cmd))
    machine.handleMessage(grantMessage(cmd, 1_000))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(media.createCount()).toBe(1)
    machine.handleMessage(offerMessage(cmd))
    machine.handleMessage(grantMessage(cmd, 1_000))
    await settle()
    expect(media.createCount()).toBe(1)
  })

  it('correlates operator and attach acknowledgements to their requests', () => {
    const { sent, machine } = setup(5_000)
    machine.bootstrapOperator('token')
    const bootstrap = sent.find((message) => message.kind === 'operator.bootstrap')
    const bootstrapId = bootstrap?.messageId as string
    machine.handleMessage(operatorAck('wrong-id'))
    expect(machine.state().operator).toBe(false)
    machine.handleMessage(operatorAck(bootstrapId))
    expect(machine.state().operator).toBe(true)

    machine.attach()
    machine.handleMessage(attachAck(1))
    expect(machine.state().performer).toBe(true)
  })

  it('ignores an unsolicited attach acknowledgement', () => {
    const { machine } = setup(5_000)
    machine.handleMessage(attachAck(1))
    expect(machine.state().performer).toBe(false)
  })
})
