import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applicationClientMessageSchema,
  applicationServerMessageSchema,
  sessionRecoverMessageSchema,
} from '../../src/contracts'
import {
  createControlledMediaDriver,
  createControlledResolver,
  createTestReceiptTools,
  M1_FIXTURE_SEGMENT_0_TEXT,
} from '../support/m1-kit'
import { createCatalogDialogueTextSource } from '../support/m4-kit'
import { createLoopHarness } from '../support/i1-harness'
import type { LoopHarness, LoopHarnessOptions } from '../support/i1-harness'
import type { PerformerClient } from '../support/performer-client'
import { connectApplication, payloadOf } from '../support/app-socket'
import type { JsonObject, RawApplicationSocket } from '../support/app-socket'
import { createPerformerMachine } from '../browser/performer-machine'
import type { ReconstructedRuntimeComposition } from '../../src/runtime/composition'
import type { ArchiveSelectionConfig } from '../../src/runtime/session-archives'
import { createEventStore } from '../../src/storage/event-store'
import { FIXTURE_SESSION_ID } from '../support/fixture-data'

/**
 * I1 explicit session recovery.
 *
 * A disconnect after playback started leaves the retired session's delivery
 * evidence unconfirmed and its physical occupancy unknown, so the retained
 * session can accept input but cannot produce output. These regressions drive
 * the real M5 endpoint, bridge and coordinator over a genuine loopback socket
 * and assert that an operator-driven recovery ends the interrupted session and
 * continues in a fresh, stopped successor built from confirmed history alone.
 */

const LIVE = 'session-live'

const harnesses: LoopHarness[] = []
const clients: PerformerClient[] = []
const rawSockets: RawApplicationSocket[] = []

afterEach(async () => {
  for (const socket of rawSockets.splice(0)) await socket.close().catch(() => {})
  for (const client of clients.splice(0)) await client.close().catch(() => {})
  for (const harness of harnesses.splice(0)) await harness.close()
})

function trackClient(client: PerformerClient): PerformerClient {
  clients.push(client)
  return client
}

async function makeHarness(options: LoopHarnessOptions = {}): Promise<LoopHarness> {
  const harness = await createLoopHarness(options)
  harnesses.push(harness)
  return harness
}

/** A recovery harness over the same store, with deterministic successor ids. */
function recoveryOptions(
  successorIds: string[],
  maxSources?: number,
  onBuild?: (
    selection: ArchiveSelectionConfig,
    info: { initial: boolean; index: number },
  ) => Promise<void> | void,
): LoopHarnessOptions {
  return {
    reconstruction: {
      liveSessionId: LIVE,
      liveProfile: { profileId: 'character-fixture', profileVersion: '1' },
      selectedSources: [],
      catalogue: new Map(),
    },
    // One catalogued segment per turn keeps the confirmed-history counts exact.
    dialogueTextSource: createCatalogDialogueTextSource([M1_FIXTURE_SEGMENT_0_TEXT]),
    recovery: {
      ...(maxSources !== undefined ? { maxSources } : {}),
      ...(onBuild !== undefined ? { onBuild } : {}),
      nextSessionId: () => {
        const id = `session-succ-${successorIds.length + 1}`
        successorIds.push(id)
        return id
      },
    },
  }
}

/** A manually released gate, for holding a successor construction deterministically. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

async function boot(harness: LoopHarness): Promise<void> {
  const token = await harness.bootstrapOperator()
  const ack = await harness.client.bootstrapOperator(token)
  expect(ack.kind).toBe('operator.ack')
  expect((await harness.client.attach()).kind).toBe('session.attach.ack')
  expect(((await harness.client.resume()).payload as { status: string }).status).toBe('applied')
}

async function until<T>(
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
  timeoutMs = 4000,
): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() - start > timeoutMs) throw new Error('until timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Bootstrap operator authority on a raw protocol-0.2 socket. */
async function bootstrapRaw(socket: RawApplicationSocket, token: string): Promise<void> {
  const snapshot = await socket.snapshot()
  socket.send({
    protocolVersion: '0.2',
    messageId: 'raw-bootstrap',
    sessionId: String(snapshot.sessionId),
    epoch: Number(snapshot.epoch),
    kind: 'operator.bootstrap',
    payload: { token },
  })
  const ack = await socket.waitFor((message) => message.kind === 'operator.ack')
  expect(ack.kind).toBe('operator.ack')
}

function recoverMessage(sessionId: string, epoch: number, messageId: string): Record<string, unknown> {
  return {
    protocolVersion: '0.2',
    messageId,
    sessionId,
    epoch,
    kind: 'session.recover',
    payload: { acknowledgePlaybackEnded: true },
  }
}

/** True when the server published a real stopped snapshot to this connection. */
function hasStoppedSnapshot(messages: JsonObject[]): boolean {
  return messages.some(
    (message) => message.kind === 'session.snapshot' && payloadOf(message).lifecycle === 'stopped',
  )
}

/** The explicit retirement state values the server published on this connection. */
function retiringStates(messages: JsonObject[]): boolean[] {
  return messages
    .filter((message) => message.kind === 'session.recovery.state')
    .map((message) => payloadOf(message).retiring === true)
}

describe('I1 explicit session recovery', () => {
  it('rejects the acknowledgement-less and server-side recovery forms', () => {
    const valid = {
      protocolVersion: '0.2',
      messageId: 'recover-1',
      sessionId: 'session-x',
      epoch: 0,
      kind: 'session.recover',
      payload: { acknowledgePlaybackEnded: true },
    }
    expect(sessionRecoverMessageSchema.safeParse(valid).success).toBe(true)
    // The acknowledgement is a required literal, never omitted or falsified.
    expect(sessionRecoverMessageSchema.safeParse({ ...valid, payload: {} }).success).toBe(false)
    expect(
      sessionRecoverMessageSchema.safeParse({
        ...valid,
        payload: { acknowledgePlaybackEnded: false },
      }).success,
    ).toBe(false)
    // It is a client kind under the strict client union, never a server kind.
    expect(applicationClientMessageSchema.safeParse(valid).success).toBe(true)
    expect(applicationServerMessageSchema.safeParse(valid).success).toBe(false)

    const ack = {
      protocolVersion: '0.2',
      messageId: 'recover-ack-1',
      sessionId: 'session-x',
      epoch: 0,
      kind: 'session.recovery.ack',
      payload: {
        status: 'applied',
        requestMessageId: 'recover-1',
        retiredSessionId: 'session-x',
        successorSessionId: 'session-y',
        recoveries: 1,
        remainingRecoveries: 7,
      },
    }
    expect(applicationServerMessageSchema.safeParse(ack).success).toBe(true)
    expect(applicationClientMessageSchema.safeParse(ack).success).toBe(false)
  })

  it('recovers an interrupted session into a fresh stopped successor carrying only confirmed history', async () => {
    const media = createControlledMediaDriver({ autoEvents: true })
    const successorIds: string[] = []
    const harness = await makeHarness({ ...recoveryOptions(successorIds), media })
    await boot(harness)

    // A first, fully-delivered turn is confirmed history in the live session.
    await harness.client.input('a first confirmed question')
    await until(async () => (await harness.confirmedHistory(LIVE)).length, (count) => count >= 1)

    // A second turn starts playing, then the browser disappears before the end.
    // The first turn already reported `started`, so capture those output
    // identities and require a NEWLY started output before the disconnect; an
    // "any started receipt" predicate would match the earlier completed turn.
    const startedBefore = new Set(
      harness.client
        .receipts()
        .filter((receipt) => receipt.stage === 'started')
        .map((receipt) => receipt.outputId),
    )
    media.holdEndedFrom(media.createCount())
    await harness.client.input('an interrupted question')
    await until(
      () =>
        harness.client
          .receipts()
          .some((receipt) => receipt.stage === 'started' && !startedBefore.has(receipt.outputId)),
      (started) => started,
    )
    await harness.client.disconnect()
    await until(
      async () => (await harness.currentComposition().coordinator.endpoint.snapshot()).outputConfirmation,
      (confirmation) => confirmation !== 'confirmed',
    )
    // The interrupted turn is unknown, never confirmed history.
    expect(await harness.confirmedHistory(LIVE)).toHaveLength(1)

    // The operator explicitly ends the interrupted session and continues.
    const operator = trackClient(harness.newClient())
    await operator.snapshot
    await operator.bootstrapOperator(await harness.bootstrapOperator())
    const ack = await operator.recover()
    expect(ack.kind).toBe('session.recovery.ack')
    expect(payloadOf(ack)).toMatchObject({
      status: 'applied',
      retiredSessionId: LIVE,
      successorSessionId: successorIds[0],
      recoveries: 1,
      remainingRecoveries: 7,
    })

    // A fresh stopped successor over the same store.
    const successor = harness.currentSessionId()
    expect(successor).toBe(successorIds[0])
    const successorComposition = harness.currentComposition() as ReconstructedRuntimeComposition
    const successorSnapshot = await successorComposition.coordinator.endpoint.snapshot()
    expect(successorSnapshot.lifecycle).toBe('stopped')
    expect(successorSnapshot.outputConfirmation).toBe('confirmed')
    expect(successorSnapshot.epoch).toBe(0)

    // Only confirmed history is carried: the interrupted turn is excluded.
    const carried = await successorComposition.history.confirmedHistory(successor)
    expect(carried).toHaveLength(1)
    expect(carried[0]?.sessionId).toBe(LIVE)
    // The retired session's own evidence is preserved unchanged.
    expect(await harness.confirmedHistory(LIVE)).toHaveLength(1)

    // The successor needs a manual Resume; nothing is replayed or auto-resumed.
    const next = trackClient(harness.newClient())
    expect((await next.snapshot).sessionId).toBe(successor)
    await next.bootstrapOperator(await harness.bootstrapOperator())
    expect((await next.attach()).kind).toBe('session.attach.ack')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect((await harness.currentComposition().coordinator.endpoint.snapshot()).lifecycle).toBe('stopped')
    expect(next.messages().some((message) => message.kind === 'performance.grant')).toBe(false)
    expect(await harness.confirmedHistory(successor)).toHaveLength(0)

    // The held media was the interrupted session's; the successor's fresh turn
    // plays to completion.
    media.holdEndedFrom(Number.POSITIVE_INFINITY)
    await next.resume()
    await next.input('a fresh successor question')
    await until(async () => (await harness.confirmedHistory(successor)).length, (count) => count >= 1)
    expect((await harness.confirmedHistory(successor))[0]?.classification).toBe('fully-delivered')
  })

  it('retains a stopped partial turn as matching cancellation evidence and excludes it from the successor', async () => {
    const media = createControlledMediaDriver({ autoEvents: true })
    const successorIds: string[] = []
    const harness = await makeHarness({ ...recoveryOptions(successorIds), media })
    await boot(harness)

    await harness.client.input('a confirmed turn')
    await until(async () => (await harness.confirmedHistory(LIVE)).length, (count) => count >= 1)

    // The confirmed turn already reported `started`; require a NEWLY started
    // output for the second turn before stopping it. The second output really
    // playing is this test's precondition, so an "any started receipt" predicate
    // (which could match the earlier completed turn) is not sufficient.
    const startedBefore = new Set(
      harness.client
        .receipts()
        .filter((receipt) => receipt.stage === 'started')
        .map((receipt) => receipt.outputId),
    )
    media.holdEndedFrom(media.createCount())
    await harness.client.input('a stopped partial turn')
    const secondStarted = await until(
      () =>
        harness.client
          .receipts()
          .find((receipt) => receipt.stage === 'started' && !startedBefore.has(receipt.outputId)),
      (receipt) => receipt !== undefined,
    )
    if (secondStarted === undefined) throw new Error('the second output never reached started')
    const secondOutputId = secondStarted.outputId
    expect((((await harness.client.stop()).payload) as { status: string }).status).toBe('applied')

    // Matching partial/cancelled evidence for the SECOND output is retained: the
    // cancelled terminal receipt correlates to that output, and the coordinator
    // keeps a committed delivery for it that is not fully delivered. An ordinary
    // Stop during a started output settles to committed evidence (as the real
    // browser flow shows), so this test does not claim recovery is required for
    // an ordinary Stop; recovery refusal is covered by the disconnect and
    // failed-retirement tests.
    await until(
      () =>
        harness.client.receipts().some(
          (receipt) => receipt.outputId === secondOutputId && receipt.stage === 'cancelled',
        ),
      (cancelled) => cancelled,
    )
    const deliveries = await until(
      () => harness.currentComposition().coordinator.deliveries(),
      (records) => records.some((record) => record.outputId === secondOutputId),
    )
    expect(deliveries.find((record) => record.outputId === secondOutputId)?.classification).not.toBe(
      'fully-delivered',
    )

    // The partial turn is excluded from confirmed history, which holds only the
    // first fully-delivered turn.
    expect(await harness.confirmedHistory(LIVE)).toHaveLength(1)

    // Operator recovery is the explicit way forward; it preserves the retired
    // session's retained evidence while carrying only the confirmed turn.
    const operator = trackClient(harness.newClient())
    await operator.snapshot
    await operator.bootstrapOperator(await harness.bootstrapOperator())
    expect(payloadOf(await operator.recover()).status).toBe('applied')
    const successor = harness.currentSessionId()
    const carried = await (
      harness.currentComposition() as ReconstructedRuntimeComposition
    ).history.confirmedHistory(successor)
    expect(carried).toHaveLength(1)
    expect(carried[0]).toMatchObject({ sessionId: LIVE, classification: 'fully-delivered' })
    // The retired session's own partial evidence and confirmed history survive
    // recovery unchanged.
    expect(await harness.confirmedHistory(LIVE)).toHaveLength(1)
    const retiredEvents = await createEventStore(harness.backend).readSession(LIVE)
    expect(retiredEvents.some((event) => event.outputId === secondOutputId)).toBe(true)
  })

  it('chains repeated recoveries in order and refuses an over-limit recovery without truncation', async () => {
    const successorIds: string[] = []
    const harness = await makeHarness(recoveryOptions(successorIds, 2))
    await boot(harness)
    await harness.client.input('base turn')
    await until(async () => (await harness.confirmedHistory(LIVE)).length, (count) => count >= 1)

    // First recovery.
    const first = trackClient(harness.newClient())
    await first.snapshot
    await first.bootstrapOperator(await harness.bootstrapOperator())
    expect(payloadOf(await first.recover()).status).toBe('applied')
    const firstSuccessor = harness.currentSessionId()
    expect(firstSuccessor).toBe(successorIds[0])

    // A confirmed turn in the first successor becomes a retained archive source.
    const next = trackClient(harness.newClient())
    await next.snapshot
    await next.bootstrapOperator(await harness.bootstrapOperator())
    await next.attach()
    await next.resume()
    await next.input('first successor turn')
    await until(async () => (await harness.confirmedHistory(firstSuccessor)).length, (count) => count >= 1)

    // Second recovery retires the first successor; earlier sources are retained.
    const second = trackClient(harness.newClient())
    await second.snapshot
    await second.bootstrapOperator(await harness.bootstrapOperator())
    const ack = await second.recover()
    expect(payloadOf(ack)).toMatchObject({ status: 'applied', remainingRecoveries: 0 })
    const secondSuccessor = harness.currentSessionId()
    expect(secondSuccessor).toBe(successorIds[1])
    const carried = await (
      harness.currentComposition() as ReconstructedRuntimeComposition
    ).history.confirmedHistory(secondSuccessor)
    expect(carried.map((record) => record.sessionId)).toEqual([LIVE, firstSuccessor])

    // A third recovery would exceed the two-source bound: an explicit refusal.
    // Retirement is committed before the bound is checked, so the current
    // successor is stopped and unserviceable for new work rather than silently
    // continuing; its identity and all retained history are preserved.
    const third = trackClient(harness.newClient())
    await third.snapshot
    await third.bootstrapOperator(await harness.bootstrapOperator())
    const refused = await third.recover()
    expect(refused.kind).toBe('request.error')
    expect(payloadOf(refused)).toMatchObject({ code: 'conflict', retryable: false })
    expect(harness.currentSessionId()).toBe(secondSuccessor)
    expect(successorIds).toHaveLength(2)
    expect(harness.currentComposition().coordinator.lifecycle()).toBe('stopped')
    // The source-limit refusal is a retirement-started failure: the stopped
    // snapshot is authoritative for attached clients.
    expect(hasStoppedSnapshot(third.messages())).toBe(true)
    expect(retiringStates(third.messages())).toContain(true)
    const refusedResume = await third.resume()
    expect(payloadOf(refusedResume)).toMatchObject({ status: 'refused' })
    // The retained sources are never truncated by a refusal.
    expect(await harness.confirmedHistory(LIVE)).toHaveLength(1)
    expect(await harness.confirmedHistory(firstSuccessor)).toHaveLength(1)
  })

  it('deduplicates a concurrent recovery into one successor that still produces new output', async () => {
    const successorIds: string[] = []
    let successorBuilds = 0
    const buildGate = deferred()
    const harness = await makeHarness(
      recoveryOptions(successorIds, undefined, (_selection, info) => {
        if (info.initial) return undefined
        successorBuilds += 1
        return buildGate.promise
      }),
    )
    await boot(harness)
    await harness.client.input('concurrent base')
    await until(async () => (await harness.confirmedHistory(LIVE)).length, (count) => count >= 1)

    const firstSocket = await connectApplication(harness.port, harness.origin)
    const secondSocket = await connectApplication(harness.port, harness.origin)
    rawSockets.push(firstSocket, secondSocket)
    await bootstrapRaw(firstSocket, await harness.bootstrapOperator())
    await bootstrapRaw(secondSocket, await harness.bootstrapOperator())

    // The successor construction is held open, so both requests are genuinely in
    // flight before either can finish: the overlap is deterministic, not a race.
    firstSocket.send(recoverMessage(LIVE, 1, 'recover-a'))
    secondSocket.send(recoverMessage(LIVE, 1, 'recover-b'))
    await until(() => harness.recovery!.status().inProgress, (inProgress) => inProgress)
    await new Promise((resolve) => setTimeout(resolve, 30))
    // Two requests, one shared construction. Removing the concurrency guard makes
    // this counter (and the successor count below) 2.
    expect(successorBuilds).toBe(1)
    expect(successorIds).toHaveLength(1)
    buildGate.resolve()
    await until(() => harness.recovery!.status().recoveries, (count) => count >= 1)

    // Exactly one successor was created and adopted.
    expect(successorIds).toHaveLength(1)
    expect(harness.recovery!.status().recoveries).toBe(1)
    const successor = successorIds[0]!
    expect(harness.currentSessionId()).toBe(successor)

    // The single successor is a usable live runtime: after the race it delivers
    // new grants, completes receipts and commits new-session history (not merely
    // an older session's history or a Resume acknowledgement).
    const next = trackClient(harness.newClient())
    await next.snapshot
    await next.bootstrapOperator(await harness.bootstrapOperator())
    expect((await next.attach()).kind).toBe('session.attach.ack')
    await next.resume()
    await next.input('after concurrent recovery')
    await until(async () => (await harness.confirmedHistory(successor)).length, (count) => count >= 1)
    expect(
      next.messages().some(
        (message) => message.kind === 'performance.grant' && message.sessionId === successor,
      ),
    ).toBe(true)
    expect(
      next.receipts().some((receipt) => receipt.stage === 'completed' && receipt.sessionId === successor),
    ).toBe(true)
    const committed = await harness.confirmedHistory(successor)
    expect(committed).toHaveLength(1)
    expect(committed[0]?.sessionId).toBe(successor)
  })

  it('refuses recovery from a connection without operator authority', async () => {
    const successorIds: string[] = []
    const harness = await makeHarness(recoveryOptions(successorIds))
    await boot(harness)

    const viewer = trackClient(harness.newClient())
    await viewer.snapshot
    const refused = await viewer.recover()
    expect(refused.kind).toBe('request.error')
    expect(payloadOf(refused).code).toBe('unauthorized')
    expect(harness.currentSessionId()).toBe(LIVE)
    expect(successorIds).toHaveLength(0)
    // Unauthorized never retires the session, so no stopped snapshot is published
    // and the live session keeps running (and usable).
    expect(hasStoppedSnapshot(viewer.messages())).toBe(false)
    expect(harness.currentComposition().coordinator.lifecycle()).toBe('running')
  })

  it('refuses a stale-epoch recovery and answers a repeated recovery idempotently', async () => {
    const successorIds: string[] = []
    const harness = await makeHarness(recoveryOptions(successorIds))
    await boot(harness) // Resume advances the live session to epoch 1.

    const socket = await connectApplication(harness.port, harness.origin)
    rawSockets.push(socket)
    const snapshot = await socket.snapshot()
    await bootstrapRaw(socket, await harness.bootstrapOperator())

    // A stale epoch must not retire the current session.
    socket.send(recoverMessage(LIVE, Number(snapshot.epoch) - 1, 'recover-stale'))
    const stale = await socket.waitFor(
      (message) => message.kind === 'request.error' && payloadOf(message).requestId === 'recover-stale',
    )
    expect(payloadOf(stale).code).toBe('stale')
    expect(harness.currentSessionId()).toBe(LIVE)
    // A stale-epoch request never retires the session, so no stopped snapshot.
    expect(hasStoppedSnapshot(socket.messages())).toBe(false)
    expect(harness.currentComposition().coordinator.lifecycle()).toBe('running')

    // The current epoch applies.
    socket.send(recoverMessage(LIVE, Number(snapshot.epoch), 'recover-ok'))
    const ack = await socket.waitFor(
      (message) =>
        message.kind === 'session.recovery.ack' &&
        payloadOf(message).requestMessageId === 'recover-ok',
    )
    expect(payloadOf(ack).status).toBe('applied')
    const successor = harness.currentSessionId()
    expect(successor).toBe(successorIds[0])

    // A repeated request for the retired session is answered idempotently.
    const retry = await connectApplication(harness.port, harness.origin)
    rawSockets.push(retry)
    await bootstrapRaw(retry, await harness.bootstrapOperator())
    retry.send(recoverMessage(LIVE, Number(snapshot.epoch), 'recover-retry'))
    const again = await retry.waitFor(
      (message) =>
        message.kind === 'session.recovery.ack' &&
        payloadOf(message).requestMessageId === 'recover-retry',
    )
    expect(payloadOf(again)).toMatchObject({ status: 'already_applied', successorSessionId: successor })
    expect(successorIds).toHaveLength(1)
  })

  it('keeps the retiring session current and retryable when successor construction fails', async () => {
    const successorIds: string[] = []
    const harness = await makeHarness(recoveryOptions(successorIds))
    await boot(harness)
    await harness.client.input('base before failure')
    await until(async () => (await harness.confirmedHistory(LIVE)).length, (count) => count >= 1)

    const operator = trackClient(harness.newClient())
    await operator.snapshot
    await operator.bootstrapOperator(await harness.bootstrapOperator())

    harness.setRecoveryBuildFailure(true)
    const failed = await operator.recover()
    expect(failed.kind).toBe('request.error')
    expect(payloadOf(failed)).toMatchObject({ code: 'storage_unavailable', retryable: true })
    // The retiring session keeps its identity but is left STOPPED: it cannot
    // produce new work and Resume is refused until a retry succeeds.
    expect(harness.currentSessionId()).toBe(LIVE)
    expect(harness.currentComposition().sessionId).toBe(LIVE)
    expect(harness.recovery!.status().lastErrorCode).toBe('construction_failed')
    expect(harness.currentComposition().coordinator.lifecycle()).toBe('stopped')
    // Retirement published a real stopped snapshot to attached clients; the UI
    // does not have to guess the stopped state from the failure code.
    expect(hasStoppedSnapshot(operator.messages())).toBe(true)
    expect(await harness.confirmedHistory(LIVE)).toHaveLength(1)
    const refusedAfterFailure = await operator.resume()
    expect(payloadOf(refusedAfterFailure)).toMatchObject({ status: 'refused' })
    const refusedInput = await operator.input('after a failed retirement')
    expect(payloadOf(refusedInput)).toMatchObject({ status: 'rejected' })
    // No new output was produced by the stopped session.
    expect(await harness.confirmedHistory(LIVE)).toHaveLength(1)

    // The explicit retirement state is true and persists across a reconnect, so a
    // page reload after the failed retirement stays disabled until a retry.
    expect(retiringStates(operator.messages())).toContain(true)
    await until(() => operator.state().retiring, (value) => value === true)
    const reconnect = await connectApplication(harness.port, harness.origin)
    rawSockets.push(reconnect)
    await reconnect.snapshot()
    const stateFrame = await reconnect.waitFor(
      (message) => message.kind === 'session.recovery.state',
    )
    expect(payloadOf(stateFrame).retiring).toBe(true)

    // A retry after the failure succeeds over the same store.
    harness.setRecoveryBuildFailure(false)
    const ack = await operator.recover()
    expect(ack.kind).toBe('session.recovery.ack')
    expect(payloadOf(ack)).toMatchObject({ status: 'applied', retiredSessionId: LIVE })
    expect(harness.currentSessionId()).toBe(successorIds.at(-1))
  })

  it('stops the retiring session before awaiting construction and refuses input and Resume meanwhile', async () => {
    const successorIds: string[] = []
    const buildGate = deferred()
    let holdSuccessor = true
    const harness = await makeHarness(
      recoveryOptions(successorIds, undefined, (_selection, info) =>
        !info.initial && holdSuccessor ? buildGate.promise : undefined,
      ),
    )
    await boot(harness)
    await harness.client.input('base before retirement')
    await until(async () => (await harness.confirmedHistory(LIVE)).length, (count) => count >= 1)

    const operator = trackClient(harness.newClient())
    await operator.snapshot
    await operator.bootstrapOperator(await harness.bootstrapOperator())

    const pending = operator.recover()
    // The endpoint quiesces BEFORE it awaits the (held) construction, and the
    // explicit retirement state reaches attached clients while it is pending.
    await until(() => harness.currentComposition().coordinator.lifecycle(), (l) => l === 'stopped')
    await until(() => operator.state().retiring, (value) => value === true)

    // New dispatch and Resume are refused while retirement is in progress.
    const inputAck = await operator.input('during retirement')
    expect(payloadOf(inputAck)).toMatchObject({ status: 'rejected', code: 'conflict' })
    const resumeAck = await operator.resume()
    expect(payloadOf(resumeAck)).toMatchObject({ status: 'refused' })
    // The retiring session produces no new output while held.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(await harness.confirmedHistory(LIVE)).toHaveLength(1)

    // Releasing the construction installs a usable successor.
    buildGate.resolve()
    expect(payloadOf(await pending)).toMatchObject({ status: 'applied', retiredSessionId: LIVE })
    expect(harness.currentSessionId()).toBe(successorIds[0])
    // The successor reports retiring false (a stale predecessor publication never
    // reaches it), and it is stopped for a manual Resume.
    const successorSocket = await connectApplication(harness.port, harness.origin)
    rawSockets.push(successorSocket)
    await successorSocket.snapshot()
    const successorState = await successorSocket.waitFor(
      (message) => message.kind === 'session.recovery.state',
    )
    expect(successorState.sessionId).toBe(successorIds[0])
    expect(payloadOf(successorState).retiring).toBe(false)
    expect((await harness.currentComposition().coordinator.endpoint.snapshot()).lifecycle).toBe(
      'stopped',
    )
    holdSuccessor = false
  })

  it('releases a successor built during shutdown without installing or binding it', async () => {
    const successorIds: string[] = []
    const buildGate = deferred()
    const harness = await makeHarness(
      recoveryOptions(successorIds, undefined, (_selection, info) =>
        info.initial ? undefined : buildGate.promise,
      ),
    )
    await boot(harness)
    await harness.client.input('before shutdown')
    await until(async () => (await harness.confirmedHistory(LIVE)).length, (count) => count >= 1)

    const socket = await connectApplication(harness.port, harness.origin)
    rawSockets.push(socket)
    await bootstrapRaw(socket, await harness.bootstrapOperator())
    socket.send(recoverMessage(LIVE, 1, 'recover-shutdown'))
    await until(() => harness.recovery!.status().inProgress, (inProgress) => inProgress)

    // The endpoint shuts down while the successor construction is held; letting
    // the construction finish must release it, never install or bind it.
    await harness.server.stop()
    buildGate.resolve()
    await until(
      () => harness.builtCompositions().some((record) => record.sessionId === successorIds[0] && record.disposed),
      (released) => released,
    )
    const record = harness.builtCompositions().find((entry) => entry.sessionId === successorIds[0])
    expect(record).toMatchObject({ disposed: true, everBound: false })
    // Store evidence is preserved through the shutdown.
    expect(await harness.confirmedHistory(LIVE)).toHaveLength(1)
  })

  it('fails a successor turn closed when a carried source is unreadable, preserving old evidence', async () => {
    const media = createControlledMediaDriver({ autoEvents: true })
    const successorIds: string[] = []
    const harness = await makeHarness({ ...recoveryOptions(successorIds), media })
    await boot(harness)

    // One confirmed turn and one interrupted (unknown) turn in the live session.
    await harness.client.input('a confirmed question')
    await until(async () => (await harness.confirmedHistory(LIVE)).length, (count) => count >= 1)
    // The confirmed turn already reported `started`; capture those output
    // identities and require a NEWLY started output, not any started receipt.
    const startedBefore = new Set(
      harness.client
        .receipts()
        .filter((receipt) => receipt.stage === 'started')
        .map((receipt) => receipt.outputId),
    )
    media.holdEndedFrom(media.createCount())
    await harness.client.input('an interrupted question')
    await until(
      () =>
        harness.client
          .receipts()
          .some((receipt) => receipt.stage === 'started' && !startedBefore.has(receipt.outputId)),
      (started) => started,
    )
    await harness.client.disconnect()
    await until(
      async () => (await harness.currentComposition().coordinator.endpoint.snapshot()).outputConfirmation,
      (confirmation) => confirmation !== 'confirmed',
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    const eventsBefore = await createEventStore(harness.backend).readSession(LIVE)

    // Recover: only the confirmed turn is carried; the unknown turn is not replayed.
    const operator = trackClient(harness.newClient())
    await operator.snapshot
    await operator.bootstrapOperator(await harness.bootstrapOperator())
    expect(payloadOf(await operator.recover()).status).toBe('applied')
    const successor = harness.currentSessionId()
    const carried = await (
      harness.currentComposition() as ReconstructedRuntimeComposition
    ).history.confirmedHistory(successor)
    expect(carried).toHaveLength(1)

    // The carried source is now unreadable: a new turn must fail closed, never
    // speaking from a silently emptied history.
    harness.setHistoryReadFailure(LIVE)
    const next = trackClient(harness.newClient())
    await next.snapshot
    await next.bootstrapOperator(await harness.bootstrapOperator())
    await next.attach()
    await next.resume()
    const ack = await next.input('a question with an unavailable source')
    expect(payloadOf(ack).status).toBe('accepted')
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(harness.currentComposition().coordinator.deliveries()).toHaveLength(0)
    expect(next.receipts().some((receipt) => receipt.stage === 'completed')).toBe(false)
    expect(await harness.confirmedHistory(successor)).toHaveLength(0)

    // Old evidence, including the unknown turn, is preserved unchanged.
    expect(await harness.confirmedHistory(LIVE)).toHaveLength(1)
    expect(await createEventStore(harness.backend).readSession(LIVE)).toEqual(eventsBefore)
  })

  it('does not stop the current session for an unknown recovery target', async () => {
    const successorIds: string[] = []
    const harness = await makeHarness(recoveryOptions(successorIds))
    await boot(harness)
    await harness.client.input('base')
    await until(async () => (await harness.confirmedHistory(LIVE)).length, (count) => count >= 1)

    const socket = await connectApplication(harness.port, harness.origin)
    rawSockets.push(socket)
    const snapshot = await socket.snapshot()
    await bootstrapRaw(socket, await harness.bootstrapOperator())

    socket.send(recoverMessage('session-never-existed', Number(snapshot.epoch), 'recover-unknown'))
    const refused = await socket.waitFor(
      (message) =>
        message.kind === 'request.error' && payloadOf(message).requestId === 'recover-unknown',
    )
    expect(payloadOf(refused).code).toBe('conflict')
    expect(harness.currentSessionId()).toBe(LIVE)
    expect(harness.currentComposition().coordinator.lifecycle()).toBe('running')
    expect(successorIds).toHaveLength(0)
    // An unknown-session refusal never retires the live session.
    expect(hasStoppedSnapshot(socket.messages())).toBe(false)
    // The explicit retirement state was reported false on connect and never set.
    expect(retiringStates(socket.messages())).toContain(false)
    expect(retiringStates(socket.messages())).not.toContain(true)
  })

  it('does not retire or block Resume after a stale refusal against a normally stopped session', async () => {
    const successorIds: string[] = []
    const harness = await makeHarness(recoveryOptions(successorIds))
    await boot(harness) // Resume advances the live session to epoch 1.
    await harness.client.input('normal turn')
    await until(async () => (await harness.confirmedHistory(LIVE)).length, (count) => count >= 1)

    const socket = await connectApplication(harness.port, harness.origin)
    rawSockets.push(socket)
    const snapshot = await socket.snapshot()
    await bootstrapRaw(socket, await harness.bootstrapOperator())

    // An ordinary Stop leaves the session stopped, NOT retired.
    expect(((await harness.client.stop()).payload as { status: string }).status).toBe('applied')
    expect(harness.currentComposition().coordinator.lifecycle()).toBe('stopped')
    expect(retiringStates(socket.messages())).not.toContain(true)

    // A stale-epoch recovery attempt is refused and never sets retirement state.
    socket.send(recoverMessage(LIVE, Number(snapshot.epoch) - 1, 'recover-stale-plain'))
    await socket.waitFor(
      (message) =>
        message.kind === 'request.error' && payloadOf(message).requestId === 'recover-stale-plain',
    )
    expect(harness.currentComposition().coordinator.lifecycle()).toBe('stopped')
    expect(retiringStates(socket.messages())).not.toContain(true)

    // Normal Resume is not blocked by the refusal: it settles to applied as usual.
    await until(
      async () => ((await harness.client.resume()).payload as { status: string }).status,
      (status) => status === 'applied',
    )
    expect(harness.currentComposition().coordinator.lifecycle()).toBe('running')
  })

  it('isolates the successor from stale identities of the retired session', async () => {
    const media = createControlledMediaDriver({ autoEvents: true })
    const successorIds: string[] = []
    const harness = await makeHarness({ ...recoveryOptions(successorIds), media })
    await boot(harness)
    media.holdEndedFrom(0)
    await harness.client.input('held for a stale identity')
    await until(
      () => harness.client.receipts().some((receipt) => receipt.stage === 'started'),
      (started) => started,
    )

    const operator = trackClient(harness.newClient())
    await operator.snapshot
    await operator.bootstrapOperator(await harness.bootstrapOperator())
    expect(payloadOf(await operator.recover()).status).toBe('applied')
    const successor = harness.currentSessionId()

    // A successor connection that attaches as performer cannot settle work for
    // the retired session identity.
    const socket = await connectApplication(harness.port, harness.origin)
    rawSockets.push(socket)
    await socket.snapshot()
    socket.send({
      protocolVersion: '0.2',
      messageId: 'attach-successor',
      sessionId: successor,
      epoch: 0,
      kind: 'session.attach',
      payload: {},
    })
    await socket.waitFor((message) => message.kind === 'session.attach.ack')
    socket.send({
      protocolVersion: '0.2',
      messageId: 'stale-ready',
      sessionId: LIVE,
      epoch: 1,
      kind: 'performance.ready',
      payload: { outputId: 'output-stale', turnId: 'turn-stale', segmentId: 'segment-stale' },
    })
    const refused = await socket.waitFor(
      (message) => message.kind === 'request.error' && payloadOf(message).requestId === 'stale-ready',
    )
    expect(payloadOf(refused).code).toBe('unauthorized')

    // A late receipt for the retired session on a successor connection is
    // likewise refused and writes nothing into the successor.
    socket.send({
      protocolVersion: '0.2',
      messageId: 'stale-receipt',
      sessionId: LIVE,
      epoch: 1,
      kind: 'performance.receipt',
      payload: {
        receiptId: 'receipt-stale',
        outputId: 'output-stale',
        sessionId: LIVE,
        epoch: 1,
        turnId: 'turn-stale',
        segmentId: 'segment-stale',
        modality: 'audio',
        stage: 'completed',
        localTimeMs: null,
        chunkIds: null,
        reasonCode: null,
        source: 'performer',
      },
    })
    const refusedReceipt = await socket.waitFor(
      (message) =>
        message.kind === 'request.error' && payloadOf(message).requestId === 'stale-receipt',
    )
    expect(payloadOf(refusedReceipt).code).toBe('unauthorized')
    expect(harness.currentComposition().coordinator.metrics().rejectedReceipts).toBe(0)

    // The successor is clean until new work is started after a Resume.
    expect((await harness.currentComposition().coordinator.endpoint.snapshot()).lifecycle).toBe('stopped')
    expect(harness.currentComposition().coordinator.deliveries()).toHaveLength(0)
    expect(await harness.confirmedHistory(successor)).toHaveLength(0)
  })

  it('leaves normal Stop and Resume unaffected when recovery is configured', async () => {
    const successorIds: string[] = []
    const harness = await makeHarness(recoveryOptions(successorIds))
    await boot(harness)
    await harness.client.input('normal turn')
    await until(async () => (await harness.confirmedHistory(LIVE)).length, (count) => count >= 1)

    expect((((await harness.client.stop()).payload) as { status: string }).status).toBe('applied')
    await until(
      async () => (((await harness.client.resume()).payload) as { status: string }).status,
      (status) => status === 'applied',
    )
    await harness.client.input('after resume')
    await until(async () => (await harness.confirmedHistory(LIVE)).length, (count) => count >= 2)
    expect(harness.currentSessionId()).toBe(LIVE)
  })

  it('sends the required acknowledgement and adopts the recovery ack in the shared machine', () => {
    const sent: string[] = []
    const resolver = createControlledResolver()
    resolver.setAutoResolve()
    const machine = createPerformerMachine({
      transport: { send: (raw) => sent.push(raw) },
      media: createControlledMediaDriver({ autoEvents: true }),
      resolver,
      receipts: createTestReceiptTools('recovery'),
      now: () => 0,
    })
    machine.handleMessage({
      protocolVersion: '0.2',
      messageId: 'snap-1',
      sessionId: FIXTURE_SESSION_ID,
      epoch: 1,
      kind: 'session.snapshot',
      payload: {
        lifecycle: 'running',
        activeTurnId: null,
        performerStatus: 'idle',
        outputConfirmation: 'pending',
        capabilityRevision: 1,
        lastSeq: 0,
      },
    })
    const messageId = machine.recover()
    expect(messageId).not.toBeNull()
    const outbound = sent
      .map((raw) => JSON.parse(raw) as { kind: string; payload: unknown })
      .find((message) => message.kind === 'session.recover')
    expect(outbound?.payload).toEqual({ acknowledgePlaybackEnded: true })
    expect(machine.state().recovery.status).toBe('requested')

    machine.handleMessage({
      protocolVersion: '0.2',
      messageId: 'ack-1',
      sessionId: FIXTURE_SESSION_ID,
      epoch: 1,
      kind: 'session.recovery.ack',
      payload: {
        status: 'applied',
        requestMessageId: messageId,
        retiredSessionId: FIXTURE_SESSION_ID,
        successorSessionId: 'session-next',
        recoveries: 1,
        remainingRecoveries: 7,
      },
    })
    expect(machine.state().recovery).toMatchObject({
      status: 'applied',
      successorSessionId: 'session-next',
      recoveries: 1,
      remainingRecoveries: 7,
    })

    // An uncorrelated ack does not change the state.
    machine.handleMessage({
      protocolVersion: '0.2',
      messageId: 'ack-2',
      sessionId: FIXTURE_SESSION_ID,
      epoch: 1,
      kind: 'session.recovery.ack',
      payload: {
        status: 'already_applied',
        requestMessageId: 'someone-else',
        retiredSessionId: FIXTURE_SESSION_ID,
        successorSessionId: 'session-other',
        recoveries: 9,
        remainingRecoveries: 0,
      },
    })
    expect(machine.state().recovery.status).toBe('applied')
    expect(machine.state().recovery.successorSessionId).toBe('session-next')
  })

  it('exposes the operator recovery control in the browser demo entry', () => {
    const script = readFileSync(
      fileURLToPath(new URL('../browser/loop.ts', import.meta.url)),
      'utf8',
    )
    expect(script).toContain('machine.recover()')
    expect(script).toContain('recover-ack')
    const html = readFileSync(
      fileURLToPath(new URL('../browser/loop.html', import.meta.url)),
      'utf8',
    )
    expect(html).toContain('id="recover"')
    expect(html).toContain('id="recover-ack"')
    expect(html).toContain('id="recovery-status"')
  })
})
