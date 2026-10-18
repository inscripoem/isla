import { afterEach, describe, expect, it } from 'vitest'
import { createLoopHarness } from '../support/i1-harness'
import type { LoopHarness } from '../support/i1-harness'
import { connectApplication, payloadOf } from '../support/app-socket'
import type { JsonObject, RawApplicationSocket } from '../support/app-socket'
import { createGatedStore } from '../support/gated-store'
import type { GatedStore } from '../support/gated-store'
import { createInMemoryBackend } from '../../src/storage/in-memory-backend'
import { createFixtureMemoryCommit } from '../support/correct-ports'
import { fixturePerformanceReceipt } from '../support/fixture-data'
import type { CommitDelivery, DeliveryCommitAck, MemoryCommitPort, PerformanceReceipt } from '../../src/contracts'

/**
 * M5 inbound ordering (DELIVERY-PLAN 2026-10-16.5, item 2).
 *
 * The socket handler is concurrent, so ordering across bridge-resolved terminal
 * paths must be demonstrated through the real application, bridge and
 * coordinator. These regressions drive the real loopback endpoint with a
 * scripted protocol-0.2 performer and a store that can hold an append or a
 * delivery commit, covering a real duplicate, a conflicting terminal, a Stop
 * during a delayed write, and a genuine stale-generation rejection.
 */

const harnesses: LoopHarness[] = []
const sockets: RawApplicationSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) await socket.close().catch(() => {})
  for (const harness of harnesses.splice(0)) await harness.close()
})

function track(socket: RawApplicationSocket): RawApplicationSocket {
  sockets.push(socket)
  return socket
}

interface OfferIdentity {
  outputId: string
  turnId: string
  segmentId: string
  sessionId: string
  epoch: number
}

function commandOf(offer: JsonObject): OfferIdentity {
  const payload = payloadOf(offer)
  return {
    outputId: payload.outputId as string,
    turnId: payload.turnId as string,
    segmentId: payload.segmentId as string,
    sessionId: offer.sessionId as string,
    epoch: offer.epoch as number,
  }
}

function readyMessage(identity: OfferIdentity): JsonObject {
  return {
    protocolVersion: '0.2',
    messageId: `ready-${identity.outputId}`,
    sessionId: identity.sessionId,
    epoch: identity.epoch,
    kind: 'performance.ready',
    payload: {
      outputId: identity.outputId,
      turnId: identity.turnId,
      segmentId: identity.segmentId,
    },
  }
}

function receiptMessage(
  identity: OfferIdentity,
  overrides: Partial<PerformanceReceipt>,
  suffix: string,
): JsonObject {
  return {
    protocolVersion: '0.2',
    messageId: `receipt-envelope-${suffix}`,
    sessionId: identity.sessionId,
    epoch: identity.epoch,
    kind: 'performance.receipt',
    payload: fixturePerformanceReceipt({
      receiptId: `receipt-${suffix}`,
      outputId: identity.outputId,
      sessionId: identity.sessionId,
      epoch: identity.epoch,
      turnId: identity.turnId,
      segmentId: identity.segmentId,
      modality: 'audio',
      ...overrides,
    }),
  }
}

function inputMessage(harness: LoopHarness, text: string, messageId: string): JsonObject {
  return {
    protocolVersion: '0.2',
    messageId,
    sessionId: harness.sessionId,
    epoch: harness.composition.coordinator.epoch(),
    kind: 'input.submit',
    payload: { source: 'local-audience', text },
  }
}

function controlMessage(harness: LoopHarness, kind: 'control.stop' | 'control.resume', requestId: string): JsonObject {
  return {
    protocolVersion: '0.2',
    messageId: `msg-${requestId}`,
    sessionId: harness.sessionId,
    epoch: harness.composition.coordinator.epoch(),
    kind,
    payload: { requestId },
  }
}

const attachMessage = (harness: LoopHarness, messageId: string): JsonObject => ({
  protocolVersion: '0.2',
  messageId,
  sessionId: harness.sessionId,
  epoch: harness.composition.coordinator.epoch(),
  kind: 'session.attach',
  payload: {},
})

/**
 * A same-socket response barrier. The attach acknowledgement is handled after
 * any earlier client message, so receiving one more proves the earlier message's
 * synchronous processing already ran. (The ack carries a server-generated
 * messageId, so the barrier is counted rather than correlated by id.)
 */
async function sameSocketBarrier(socket: RawApplicationSocket, harness: LoopHarness): Promise<void> {
  const before = socket.messages().filter((message) => message.kind === 'session.attach.ack').length
  socket.send(attachMessage(harness, `barrier-${before + 1}`))
  await until(
    () => socket.messages().filter((message) => message.kind === 'session.attach.ack').length > before,
    (done) => done,
  )
}

async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, timeoutMs = 4000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() - start > timeoutMs) throw new Error('until timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function outputReceiptActions(harness: LoopHarness): string[] {
  return harness
    .composition.coordinator.events()
    .filter((event) => event.type === 'output.receipt')
    .map((event) => (event.payload as { reconciliation?: string }).reconciliation ?? 'unknown')
}

/** Connects a scripted performer, bootstraps the operator and resumes. */
async function attachScriptedPerformer(harness: LoopHarness): Promise<RawApplicationSocket> {
  const socket = track(await connectApplication(harness.port, harness.origin))
  await socket.snapshot()
  const token = await harness.bootstrapOperator()
  socket.send({
    protocolVersion: '0.2',
    messageId: 'bootstrap-1',
    sessionId: harness.sessionId,
    epoch: harness.composition.coordinator.epoch(),
    kind: 'operator.bootstrap',
    payload: { token },
  })
  await socket.waitFor((message) => message.kind === 'operator.ack')
  socket.send(attachMessage(harness, 'attach-1'))
  await socket.waitFor((message) => message.kind === 'session.attach.ack')
  socket.send(controlMessage(harness, 'control.resume', 'resume-1'))
  await socket.waitFor((message) => message.kind === 'control.ack')
  return socket
}

/** Drives one offer to a grant for a scripted performer. */
async function driveToGrant(socket: RawApplicationSocket, harness: LoopHarness): Promise<OfferIdentity> {
  socket.send(inputMessage(harness, 'ordering input', 'ordering-input-1'))
  const offer = await socket.waitFor((message) => message.kind === 'performance.offer')
  const identity = commandOf(offer)
  socket.send(readyMessage(identity))
  await socket.waitFor((message) => message.kind === 'performance.grant')
  return identity
}

function countingCommit(): { commit: MemoryCommitPort; calls: () => number } {
  const delegate = createFixtureMemoryCommit()
  let calls = 0
  return {
    calls: () => calls,
    commit: {
      async commit(delivery: CommitDelivery): Promise<DeliveryCommitAck> {
        calls += 1
        return delegate.commit(delivery)
      },
    },
  }
}

async function makeHarness(): Promise<{ harness: LoopHarness; gated: GatedStore; memory: () => number }> {
  const backend = createInMemoryBackend()
  const gated = createGatedStore(backend)
  const memory = countingCommit()
  const harness = await createLoopHarness({ backend, store: gated.store, commit: memory.commit })
  harnesses.push(harness)
  return { harness, gated, memory: memory.calls }
}

describe('M5 inbound ordering through the real application/bridge/coordinator', () => {
  it('reconciles a real duplicate and a conflicting terminal with one delivery and ordered evidence', async () => {
    const { harness, gated, memory } = await makeHarness()
    const socket = await attachScriptedPerformer(harness)
    const identity = await driveToGrant(socket, harness)

    // A non-terminal receipt is forwarded, so an identical retransmission is
    // reconciled by the coordinator's receipt-id history as a duplicate.
    socket.send(receiptMessage(identity, { stage: 'started' }, 'started-1'))
    socket.send(receiptMessage(identity, { stage: 'started' }, 'started-1'))
    await until(() => outputReceiptActions(harness).length, (count) => count >= 2)
    expect(outputReceiptActions(harness).slice(0, 2)).toEqual(['record', 'ignore-duplicate'])

    gated.holdNextCommit()
    socket.send(receiptMessage(identity, { stage: 'completed' }, 'completed-1'))
    await until(() => gated.holdingCommit(), (holding) => holding)

    // A conflicting terminal arrives while the delivery commit is held. A
    // same-socket attach barrier proves it was processed before the hold lifts.
    socket.send(receiptMessage(identity, { stage: 'failed', reasonCode: 'conflicting' }, 'conflict-1'))
    await sameSocketBarrier(socket, harness)
    expect(gated.holdingCommit()).toBe(true)
    gated.releaseCommit()

    await until(
      () =>
        harness.composition.coordinator.deliveries().length === 1 &&
        outputReceiptActions(harness).includes('conflict'),
      (done) => done,
    )

    expect(harness.composition.coordinator.deliveries()).toHaveLength(1)
    expect(gated.commitCalls()).toBe(1)
    expect(memory()).toBe(1)
    expect((await harness.confirmedHistory())).toHaveLength(1)
    expect((await harness.confirmedHistory())[0]?.classification).toBe('fully-delivered')
    expect(socket.messages().filter((message) => message.kind === 'performance.offer')).toHaveLength(1)
    expect((await harness.composition.coordinator.endpoint.snapshot()).outputConfirmation).toBe('confirmed')

    // Persisted evidence keeps a strictly increasing sequence.
    const events = harness.composition.coordinator.events()
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index]!.seq).toBeGreaterThan(events[index - 1]!.seq)
    }
  })

  it('keeps Stop responsive during a delayed commit and still commits exactly once', async () => {
    const { harness, gated } = await makeHarness()
    const socket = await attachScriptedPerformer(harness)
    const identity = await driveToGrant(socket, harness)

    gated.holdNextCommit()
    socket.send(receiptMessage(identity, { stage: 'completed' }, 'completed-stop'))
    await until(() => gated.holdingCommit(), (holding) => holding)

    socket.send(controlMessage(harness, 'control.stop', 'stop-during-commit'))
    const stopAck = await socket.waitFor(
      (message) => message.kind === 'control.ack' && payloadOf(message).requestId === 'stop-during-commit',
    )
    // The acknowledgement arrives while the delivery commit is still held.
    expect(payloadOf(stopAck).status).toBe('applied')
    expect(gated.holdingCommit()).toBe(true)

    gated.releaseCommit()
    await until(() => harness.composition.coordinator.deliveries().length, (count) => count >= 1)
    expect(harness.composition.coordinator.deliveries()).toHaveLength(1)
    expect(gated.commitCalls()).toBe(1)
    expect(socket.messages().filter((message) => message.kind === 'performance.offer')).toHaveLength(1)
  })

  it('preserves ordering and commits once when an append is held before the terminal', async () => {
    const { harness, gated, memory } = await makeHarness()
    const socket = await attachScriptedPerformer(harness)
    const identity = await driveToGrant(socket, harness)

    gated.holdNextAppend()
    socket.send(receiptMessage(identity, { stage: 'started' }, 'started-append'))
    await until(() => gated.holdingAppend(), (holding) => holding)

    // The terminal is processed through the real bridge while the preceding
    // append is still held, so the serialized write chain cannot commit it yet.
    socket.send(receiptMessage(identity, { stage: 'completed' }, 'completed-append'))
    await sameSocketBarrier(socket, harness)
    expect(gated.holdingAppend()).toBe(true)
    expect(harness.composition.coordinator.deliveries()).toHaveLength(0)

    gated.releaseAppend()
    await until(() => harness.composition.coordinator.deliveries().length, (count) => count >= 1)
    expect(harness.composition.coordinator.deliveries()).toHaveLength(1)
    expect(gated.commitCalls()).toBe(1)
    expect(memory()).toBe(1)
    expect((await harness.confirmedHistory())).toHaveLength(1)
    expect((await harness.composition.coordinator.endpoint.snapshot()).outputConfirmation).toBe('confirmed')
  })

  it('rejects a stale-generation terminal receipt after a reconnect', async () => {
    const { harness } = await makeHarness()
    const socket = await attachScriptedPerformer(harness)
    const identity = await driveToGrant(socket, harness)
    socket.send(receiptMessage(identity, { stage: 'started' }, 'started-stale'))
    await until(() => outputReceiptActions(harness).length, (count) => count >= 1)

    // The performer disappears mid-playback; the server retains conservative
    // unknown evidence and a non-idle status.
    await socket.close()

    const reconnected = await attachScriptedPerformer(harness)
    reconnected.send(receiptMessage(identity, { stage: 'completed' }, 'stale-terminal'))
    // A same-socket response barrier proves the stale receipt was processed: the
    // attach handler runs after the receipt's synchronous bridge rejection.
    await sameSocketBarrier(reconnected, harness)

    expect(harness.composition.coordinator.deliveries()).toHaveLength(0)
    expect(await harness.confirmedHistory()).toHaveLength(0)
    expect((await harness.composition.coordinator.endpoint.snapshot()).outputConfirmation).not.toBe('confirmed')
  })
})
