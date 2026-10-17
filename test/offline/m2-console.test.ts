import { describe, expect, it } from 'vitest'
import {
  bootstrapSnapshotSchema,
  clientMessageSchema,
  inputAckSchema,
  serverMessageSchema,
  type ControlAck,
  type ControlResumeMessage,
  type ControlStopMessage,
  type InputAck,
  type InputSubmitMessage,
  type PerformanceReceipt,
  type PlayerStatus,
  type ServerMessage,
} from '../../src/contracts'
import {
  canDispatch,
  createInitialConsoleState,
  reduceControlAck,
  reduceInputAck,
  reduceServerMessage,
  withBootstrap,
  withConnection,
  withPendingControl,
  withPendingInput,
  type ConsoleState,
  type ConnectionStatus,
} from '../../src/console/console-state'
import {
  ConsoleTransportError,
  createAppTransport,
  type SocketCloseInfo,
  type TransportSocket,
} from '../../src/console/app-transport'
import { createPlaybackBinding } from '../../src/console/player-binding'
import { collectConsoleViolations } from '../conformance/console.conformance'
import { createBootstrapOnlyRuntime, createFixtureConsoleTransport } from '../support/correct-ports'
import { createFaultyConsoleTransport } from '../support/faulty-ports'
import { createControlledMediaDriver, createControlledResolver } from '../support/m1-kit'
import { FIXTURE_SESSION_ID, fixturePerformanceCommand } from '../support/fixture-data'

describe('M2 console conformance', () => {
  it('accepts a transport built on a fixture runtime', async () => {
    const violations = await collectConsoleViolations(() =>
      createFixtureConsoleTransport(createBootstrapOnlyRuntime()),
    )
    expect(violations).toEqual([])
  })

  it('rejects a transport that replays stale history', async () => {
    const violations = await collectConsoleViolations(() => createFaultyConsoleTransport())
    expect(violations.map((violation) => violation.code)).toContain('no-history-autoplay')
  })
})

/* ------------------------------------------------------------------ *
 * Pure view state. No DOM, no transport, no timers.
 * ------------------------------------------------------------------ */

const SESSION = FIXTURE_SESSION_ID

function bootstrap(epoch = 1, seq = 4) {
  return bootstrapSnapshotSchema.parse({
    protocolVersion: '0.2',
    messageId: 'm-bootstrap',
    sessionId: SESSION,
    epoch,
    seq,
    lifecycle: 'running',
    activeTurnId: 'turn-fixture-1',
    performerStatus: 'idle',
    outputConfirmation: 'confirmed',
    capabilityRevision: 1,
  })
}

function opened(): ConsoleState {
  return withBootstrap(createInitialConsoleState(), bootstrap())
}

function inputSubmit(messageId: string): InputSubmitMessage {
  return {
    protocolVersion: '0.2',
    messageId,
    sessionId: SESSION,
    epoch: 1,
    kind: 'input.submit',
    payload: { source: 'local-audience', text: 'hello runtime' },
  }
}

function controlStop(requestId: string): ControlStopMessage {
  return { protocolVersion: '0.2', messageId: 'control-message-1', sessionId: SESSION, epoch: 1, kind: 'control.stop', payload: { requestId } }
}

function controlResume(requestId: string): ControlResumeMessage {
  return { protocolVersion: '0.2', messageId: 'control-message-1', sessionId: SESSION, epoch: 1, kind: 'control.resume', payload: { requestId } }
}

function sessionEvent(seq: number): ServerMessage {
  return serverMessageSchema.parse({
    protocolVersion: '0.2',
    messageId: `m-event-${seq}`,
    sessionId: SESSION,
    epoch: 1,
    kind: 'session.event',
    payload: { seq, type: 'turn.started', data: { turnId: 'turn-fixture-1' } },
  })
}

describe('console view state', () => {
  it('dispatches only on an open transport with a live session', () => {
    const initial = createInitialConsoleState()
    expect(canDispatch(initial)).toBe(false)
    expect(canDispatch(opened())).toBe(true)
    expect(canDispatch(withConnection(opened(), 'closed'))).toBe(false)
    expect(canDispatch(withConnection(opened(), 'error', 'socket failed'))).toBe(false)
  })

  it('treats a lost transport as uncertain instead of settled', () => {
    const pending = withPendingInput(opened(), inputSubmit('req-1'))
    const lost = withConnection(pending, 'closed', 'socket closed')

    expect(lost.inputs[0]?.outcome).toBe('unknown')
    expect(lost.inputs[0]?.detail).toBe('transport went down before acknowledgement')
    expect(lost.session?.outputConfirmation).toBe('unknown')
    expect(lost.connectionDetail).toBe('socket closed')
  })

  it('never renders replayed history at or below the accepted sequence', () => {
    const state = opened()
    expect(state.session?.lastSeq).toBe(4)

    const replayed = reduceServerMessage(state, sessionEvent(3))
    expect(replayed.events).toEqual([])
    expect(replayed.session?.lastSeq).toBe(4)

    const fresh = reduceServerMessage(state, sessionEvent(5))
    expect(fresh.events.map((event) => event.seq)).toEqual([5])
    expect(fresh.session?.lastSeq).toBe(5)
  })

  it('marks an acknowledgement from another session or epoch as unknown', () => {
    const pending = withPendingInput(opened(), inputSubmit('req-1'))
    const foreign: InputAck = inputAckSchema.parse({
      status: 'accepted',
      requestMessageId: 'req-1',
      eventId: 'event-1',
      sessionId: SESSION,
      epoch: 2,
      seq: 9,
    })

    const settled = reduceInputAck(pending, foreign)
    expect(settled.inputs[0]?.outcome).toBe('unknown')
    expect(settled.inputs[0]?.detail).toBe('acknowledgement references a different session or epoch')
    expect(settled.session?.lastSeq).toBe(4)
  })

  it('keeps the server vocabulary for a rejected input request', () => {
    const pending = withPendingInput(opened(), inputSubmit('req-1'))
    const rejected: InputAck = inputAckSchema.parse({
      status: 'rejected',
      requestMessageId: 'req-1',
      sessionId: SESSION,
      epoch: 1,
      code: 'invalid_field',
      message: 'text must not be empty',
      retryable: false,
    })

    const settled = reduceInputAck(pending, rejected)
    expect(settled.inputs[0]?.outcome).toBe('rejected')
    expect(settled.inputs[0]?.detail).toBe('invalid_field: text must not be empty')
    expect(settled.session?.lastSeq).toBe(4)
  })

  it('correlates a control acknowledgement by requestId, not by message id', () => {
    const pending = withPendingControl(opened(), controlStop('control-request-1'))
    const ack: ControlAck = {
      sessionId: SESSION,
      requestId: 'control-request-1',
      requestMessageId: 'a-different-message-id',
      action: 'stop',
      status: 'applied',
      previousEpoch: 1,
      epoch: 2,
      lifecycle: 'stopped',
      outputConfirmation: 'pending',
      reasonCode: null,
      message: 'stopped',
    }

    const settled = reduceControlAck(pending, ack)
    expect(settled.controls[0]?.outcome).toBe('applied')
    expect(settled.controls[0]?.epoch).toBe(2)
    expect(settled.session?.epoch).toBe(2)
    expect(settled.session?.lifecycle).toBe('stopped')
    expect(settled.session?.outputConfirmation).toBe('pending')
  })

  it('records a request error and clears the matching pending control', () => {
    const pending = withPendingControl(opened(), controlResume('control-request-1'))
    const error = serverMessageSchema.parse({
      protocolVersion: '0.2',
      messageId: 'm-error',
      sessionId: SESSION,
      epoch: 1,
      kind: 'request.error',
      payload: { requestId: 'control-request-1', code: 'unauthorized', retryable: false, message: 'not authorized' },
    })

    const settled = reduceServerMessage(pending, error)
    expect(settled.controls[0]?.outcome).toBe('unknown')
    expect(settled.controls[0]?.detail).toBe('unauthorized: not authorized')
    expect(settled.errors.map((entry) => entry.code)).toEqual(['unauthorized'])
  })

  it('settles a late control acknowledgement without rolling the session back', () => {
    const stopped = reduceControlAck(withPendingControl(opened(), controlStop('control-request-1')), {
      sessionId: SESSION,
      requestId: 'control-request-1',
      requestMessageId: 'control-message-1',
      action: 'stop',
      status: 'applied',
      previousEpoch: 1,
      epoch: 2,
      lifecycle: 'stopped',
      outputConfirmation: 'pending',
      reasonCode: null,
      message: 'stopped',
    })
    expect(stopped.session?.epoch).toBe(2)
    expect(stopped.session?.lifecycle).toBe('stopped')

    const pendingResume = withPendingControl(stopped, controlResume('control-request-2'))
    const lateResume: ControlAck = {
      sessionId: SESSION,
      requestId: 'control-request-2',
      requestMessageId: 'control-message-2',
      action: 'resume',
      status: 'applied',
      previousEpoch: 0,
      epoch: 1,
      lifecycle: 'running',
      outputConfirmation: 'confirmed',
      reasonCode: null,
      message: 'resumed',
    }

    const settled = reduceControlAck(pendingResume, lateResume)
    const resumed = settled.controls.find((view) => view.requestId === 'control-request-2')
    // Its own request display is settled...
    expect(resumed?.outcome).toBe('applied')
    expect(resumed?.epoch).toBe(1)
    // ...but an older epoch never restores older session state.
    expect(settled.session?.epoch).toBe(2)
    expect(settled.session?.lifecycle).toBe('stopped')
  })

  it('drops an out-of-order snapshot instead of rolling the session back', () => {
    const fresh = reduceServerMessage(opened(), serverMessageSchema.parse(snapshotMessage(2, 10)))
    expect(fresh.session?.epoch).toBe(2)
    expect(fresh.session?.lastSeq).toBe(10)

    const stale = reduceServerMessage(fresh, serverMessageSchema.parse(snapshotMessage(1, 3)))
    expect(stale.session?.epoch).toBe(2)
    expect(stale.session?.lastSeq).toBe(10)
  })

  it('drops a same-epoch snapshot that is behind the accepted sequence', () => {
    const fresh = reduceServerMessage(
      opened(),
      serverMessageSchema.parse(
        snapshotWith(2, 10, { activeTurnId: 'turn-new', capabilityRevision: 2 }),
      ),
    )
    expect(fresh.session?.epoch).toBe(2)
    expect(fresh.session?.lastSeq).toBe(10)
    expect(fresh.session?.activeTurnId).toBe('turn-new')
    expect(fresh.session?.capabilityRevision).toBe(2)

    // A schema-valid epoch-2 snapshot at a lower sequence must not replace the
    // identity, turn, confirmation or capability of the epoch-2 view at seq 10.
    const behind = reduceServerMessage(
      fresh,
      serverMessageSchema.parse(
        snapshotWith(2, 5, {
          activeTurnId: 'turn-old',
          outputConfirmation: 'pending',
          capabilityRevision: 1,
        }),
      ),
    )
    expect(behind.session).toEqual(fresh.session)
    expect(behind.session?.activeTurnId).toBe('turn-new')
    expect(behind.session?.outputConfirmation).toBe('confirmed')
    expect(behind.session?.capabilityRevision).toBe(2)
    expect(behind.session?.lastSeq).toBe(10)
  })
})

/* ------------------------------------------------------------------ *
 * Wire framing. A double replaces the platform WebSocket so the transport
 * can be observed without a server or a browser.
 * ------------------------------------------------------------------ */

interface FakeSocket {
  readonly socket: TransportSocket
  readonly sent: string[]
  open(): void
  emit(payload: unknown): void
  emitRaw(raw: string): void
  disconnect(info: SocketCloseInfo): void
}

function createFakeSocket(): FakeSocket {
  const openHandlers: Array<() => void> = []
  const closeHandlers: Array<(info: SocketCloseInfo) => void> = []
  const errorHandlers: Array<(detail: string) => void> = []
  const messageHandlers: Array<(data: string) => void> = []
  const sent: string[] = []
  let readyState = 0

  const socket: TransportSocket = {
    readyState: () => readyState,
    send(data) {
      sent.push(data)
    },
    close() {
      readyState = 3
    },
    onOpen(handler) {
      openHandlers.push(handler)
    },
    onClose(handler) {
      closeHandlers.push(handler)
    },
    onError(handler) {
      errorHandlers.push(handler)
    },
    onMessage(handler) {
      messageHandlers.push(handler)
    },
  }

  return {
    socket,
    sent,
    open() {
      readyState = 1
      for (const handler of openHandlers) handler()
    },
    emit(payload) {
      const raw = JSON.stringify(payload)
      for (const handler of messageHandlers) handler(raw)
    },
    emitRaw(raw) {
      for (const handler of messageHandlers) handler(raw)
    },
    disconnect(info) {
      readyState = 3
      for (const handler of closeHandlers) handler(info)
    },
  }
}

function snapshotMessage(epoch = 1, lastSeq = 4): Record<string, unknown> {
  return {
    protocolVersion: '0.2',
    messageId: 'm-snapshot',
    sessionId: SESSION,
    epoch,
    kind: 'session.snapshot',
    payload: {
      lifecycle: 'running',
      activeTurnId: 'turn-fixture-1',
      performerStatus: 'idle',
      outputConfirmation: 'confirmed',
      capabilityRevision: 1,
      lastSeq,
    },
  }
}

function snapshotWith(
  epoch: number,
  lastSeq: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    protocolVersion: '0.2',
    messageId: 'm-snapshot',
    sessionId: SESSION,
    epoch,
    kind: 'session.snapshot',
    payload: {
      lifecycle: 'running',
      activeTurnId: 'turn-fixture-1',
      performerStatus: 'idle',
      outputConfirmation: 'confirmed',
      capabilityRevision: 1,
      lastSeq,
      ...overrides,
    },
  }
}

function inputAckMessage(ack: InputAck): Record<string, unknown> {
  return {
    protocolVersion: '0.2',
    messageId: 'm-input-ack',
    sessionId: SESSION,
    epoch: 1,
    kind: 'input.ack',
    payload: ack,
  }
}

async function asFailure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  )
}

describe('console transport framing', () => {
  it('adopts the pushed bootstrap snapshot and reports connection transitions', async () => {
    const fake = createFakeSocket()
    const statuses: ConnectionStatus[] = []
    const transport = createAppTransport({
      url: 'ws://console.test/app',
      createSocket: () => fake.socket,
      onStatus: (connection) => statuses.push(connection),
    })

    const pending = transport.bootstrap()
    fake.open()
    fake.emit(snapshotMessage())
    const snapshot = await pending

    expect(snapshot.sessionId).toBe(SESSION)
    expect(snapshot.epoch).toBe(1)
    expect(snapshot.seq).toBe(4)
    expect(snapshot.outputConfirmation).toBe('confirmed')
    expect(statuses).toEqual(['connecting', 'open'])
  })

  it('reports an unusable inbound frame as a protocol violation and drops it', async () => {
    const fake = createFakeSocket()
    const violations: string[] = []
    const delivered: ServerMessage[] = []
    const transport = createAppTransport({
      url: 'ws://console.test/app',
      createSocket: () => fake.socket,
      onProtocolViolation: (detail) => violations.push(detail),
    })
    transport.onServerMessage((message) => delivered.push(message))

    const pending = transport.bootstrap()
    fake.open()
    fake.emitRaw('{ not json')
    fake.emit({ protocolVersion: '0.2', messageId: 'm-x', sessionId: SESSION, epoch: 1, kind: 'unknown.kind' })
    fake.emit(snapshotMessage())
    await pending

    expect(violations).toEqual([
      'inbound frame is not valid JSON',
      'inbound frame is not a valid v0.2 server message',
    ])
    expect(delivered.map((message) => message.kind)).toEqual(['session.snapshot'])
  })

  it('correlates an input acknowledgement by requestMessageId', async () => {
    const fake = createFakeSocket()
    const transport = createAppTransport({ url: 'ws://console.test/app', createSocket: () => fake.socket })
    const booting = transport.bootstrap()
    fake.open()
    fake.emit(snapshotMessage())
    await booting

    const message = inputSubmit('req-1')
    const pending = transport.sendInput(message)
    const sentFrame = fake.sent[0]
    expect(sentFrame).toBeDefined()
    expect(clientMessageSchema.safeParse(JSON.parse(sentFrame ?? '{}')).success).toBe(true)

    fake.emit(
      inputAckMessage(
        inputAckSchema.parse({
          status: 'accepted',
          requestMessageId: 'req-1',
          eventId: 'event-1',
          sessionId: SESSION,
          epoch: 1,
          seq: 5,
        }),
      ),
    )
    const ack = await pending
    if (ack.status === 'rejected') throw new Error('expected an accepted acknowledgement')
    expect(ack.status).toBe('accepted')
    expect(ack.seq).toBe(5)
  })

  it('refuses to dispatch while the socket is not open', async () => {
    const fake = createFakeSocket()
    const transport = createAppTransport({ url: 'ws://console.test/app', createSocket: () => fake.socket })

    const error = await asFailure(transport.sendInput(inputSubmit('req-never-opened')))
    expect(error).toBeInstanceOf(ConsoleTransportError)
    expect((error as ConsoleTransportError).reason).toBe('closed')
  })

  it('fails outstanding requests with one cause when the socket closes', async () => {
    const fake = createFakeSocket()
    const statuses: Array<[ConnectionStatus, string | null]> = []
    const transport = createAppTransport({
      url: 'ws://console.test/app',
      createSocket: () => fake.socket,
      onStatus: (connection, detail) => statuses.push([connection, detail]),
    })
    const booting = transport.bootstrap()
    fake.open()
    fake.emit(snapshotMessage())
    await booting

    const pending = transport.sendInput(inputSubmit('req-1'))
    fake.disconnect({ wasClean: false, code: 1006 })
    const error = await asFailure(pending)

    expect((error as ConsoleTransportError).reason).toBe('closed')
    expect(statuses[statuses.length - 1]?.[0]).toBe('closed')
    expect(statuses[statuses.length - 1]?.[1]).toContain('code 1006')
  })

  it('gives up on an acknowledgement that never arrives', async () => {
    const fake = createFakeSocket()
    const transport = createAppTransport({
      url: 'ws://console.test/app',
      createSocket: () => fake.socket,
      ackTimeoutMs: 5,
    })
    const booting = transport.bootstrap()
    fake.open()
    fake.emit(snapshotMessage())
    await booting

    const error = await asFailure(transport.sendInput(inputSubmit('req-slow')))
    expect((error as ConsoleTransportError).reason).toBe('timeout')
  })
})

/* ------------------------------------------------------------------ *
 * The M1 player mount. Playback is pure JS here: a controlled resolver and a
 * controlled media driver stand in for audio and the DOM.
 * ------------------------------------------------------------------ */

async function waitFor(check: () => boolean, turns = 50): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('waitFor: the condition was never met')
}

/** Flush pending microtasks so an in-flight binding call can settle. */
async function settleMicrotasks(turns = 8): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve()
}

describe('console playback binding', () => {
  it('mounts the M1 player and cancels locally without revoking the epoch', async () => {
    const resolver = createControlledResolver()
    resolver.setAutoResolve()
    const media = createControlledMediaDriver()
    const receipts: PerformanceReceipt[] = []
    const statuses: PlayerStatus[] = []
    const subtitles: string[] = []
    const faults: string[] = []
    let receiptCount = 0

    const binding = createPlaybackBinding({
      bootstrap: bootstrap(),
      resolver,
      media,
      newReceiptId: () => {
        receiptCount += 1
        return `console-receipt-${receiptCount}`
      },
      localNowMs: () => 12,
      onReceipt: (receipt) => receipts.push(receipt),
      onStatus: (status) => statuses.push(status),
      onSubtitle: (subtitleText) => subtitles.push(subtitleText),
      onFault: (message) => faults.push(message),
    })

    const command = fixturePerformanceCommand()
    binding.handleServerMessage(
      serverMessageSchema.parse({
        protocolVersion: '0.2',
        messageId: 'm-execute',
        sessionId: command.sessionId,
        epoch: command.epoch,
        kind: 'performance.execute',
        payload: command,
      }),
    )

    await waitFor(() => resolver.leases().length === 1)
    expect(subtitles).toEqual([command.subtitleText])
    expect(binding.status().activeOutputId).toBe(command.outputId)

    binding.cancelLocal()
    await waitFor(() => receipts.some((receipt) => receipt.stage === 'cancelled'))

    expect(receipts.map((receipt) => receipt.stage)).toContain('cancelled')
    expect(binding.status().idle).toBe(true)
    expect(resolver.leases()[0]?.releaseCount()).toBe(1)
    expect(faults).toEqual([])

    // The local abort never touched the server's epoch sequence, so a command
    // for the same epoch is still admitted.
    binding.handleServerMessage(
      serverMessageSchema.parse({
        protocolVersion: '0.2',
        messageId: 'm-execute-2',
        sessionId: command.sessionId,
        epoch: command.epoch,
        kind: 'performance.execute',
        payload: { ...command, outputId: 'output-fixture-2' },
      }),
    )
    await waitFor(() => resolver.leases().length === 2)

    expect(faults).toEqual([])
    expect(binding.status().activeOutputId).toBe('output-fixture-2')
    expect(statuses.length).toBeGreaterThan(1)
    binding.dispose()
  })

  it('keeps an identical output playing when a duplicate command arrives', async () => {
    const resolver = createControlledResolver()
    resolver.setAutoResolve()
    const media = createControlledMediaDriver()
    const receipts: PerformanceReceipt[] = []
    const faults: string[] = []

    const binding = createPlaybackBinding({
      bootstrap: bootstrap(),
      resolver,
      media,
      newReceiptId: () => 'console-receipt',
      localNowMs: () => 12,
      onReceipt: (receipt) => receipts.push(receipt),
      onStatus: () => {},
      onSubtitle: () => {},
      onFault: (message) => faults.push(message),
    })

    const command = fixturePerformanceCommand()
    const frame = (messageId: string, payload: typeof command) =>
      serverMessageSchema.parse({
        protocolVersion: '0.2',
        messageId,
        sessionId: payload.sessionId,
        epoch: payload.epoch,
        kind: 'performance.execute',
        payload,
      })

    binding.handleServerMessage(frame('m-execute-1', command))
    await waitFor(() => media.createCount() === 1)
    media.current()?.emitPlaying()
    await waitFor(() => binding.status().lastStage === 'started')

    // The identical command is a duplicate: M1 deduplicates against the retained
    // operation, so the output that is playing must be preserved rather than
    // aborted ahead of validation.
    binding.handleServerMessage(frame('m-execute-2', command))
    await settleMicrotasks()

    expect(faults).toEqual([])
    expect(receipts.some((receipt) => receipt.stage === 'cancelled')).toBe(false)
    expect(binding.status().idle).toBe(false)
    expect(binding.status().activeOutputId).toBe(command.outputId)
    binding.dispose()
  })

  it('preserves newer playback when a stale cancel is rejected', async () => {
    const resolver = createControlledResolver()
    resolver.setAutoResolve()
    const media = createControlledMediaDriver()
    const receipts: PerformanceReceipt[] = []
    const faults: string[] = []

    const binding = createPlaybackBinding({
      bootstrap: bootstrap(1),
      resolver,
      media,
      newReceiptId: () => 'console-receipt',
      localNowMs: () => 12,
      onReceipt: (receipt) => receipts.push(receipt),
      onStatus: () => {},
      onSubtitle: () => {},
      onFault: (message) => faults.push(message),
    })

    // Epoch 2 playback, admitted over the epoch 1 bootstrap.
    const command = fixturePerformanceCommand({ epoch: 2 })
    binding.handleServerMessage(
      serverMessageSchema.parse({
        protocolVersion: '0.2',
        messageId: 'm-execute',
        sessionId: command.sessionId,
        epoch: 2,
        kind: 'performance.execute',
        payload: command,
      }),
    )
    await waitFor(() => media.createCount() === 1)

    // An epoch 1 cancel is stale against the epoch 2 operation: M1 rejects it,
    // so it must not release the signal bound to the newer playback.
    binding.handleServerMessage(
      serverMessageSchema.parse({
        protocolVersion: '0.2',
        messageId: 'm-cancel',
        sessionId: SESSION,
        epoch: 2,
        kind: 'performance.cancel',
        payload: { requestId: 'cancel-1', revokedEpoch: 1, newEpoch: 2 },
      }),
    )
    await waitFor(() => faults.length === 1)

    expect(faults).toEqual(['cancel cancel-1: dispatch rejected (stale_cancel)'])
    expect(receipts.some((receipt) => receipt.stage === 'cancelled')).toBe(false)
    expect(binding.status().idle).toBe(false)
    expect(binding.status().activeOutputId).toBe(command.outputId)
    binding.dispose()
  })

  it('ignores a cancellation whose envelope names another session', async () => {
    const resolver = createControlledResolver()
    resolver.setAutoResolve()
    const media = createControlledMediaDriver()
    const receipts: PerformanceReceipt[] = []
    const faults: string[] = []

    const binding = createPlaybackBinding({
      bootstrap: bootstrap(1),
      resolver,
      media,
      newReceiptId: () => 'console-receipt',
      localNowMs: () => 12,
      onReceipt: (receipt) => receipts.push(receipt),
      onStatus: () => {},
      onSubtitle: () => {},
      onFault: (message) => faults.push(message),
    })

    const command = fixturePerformanceCommand({ epoch: 2 })
    binding.handleServerMessage(
      serverMessageSchema.parse({
        protocolVersion: '0.2',
        messageId: 'm-execute',
        sessionId: command.sessionId,
        epoch: 2,
        kind: 'performance.execute',
        payload: command,
      }),
    )
    await waitFor(() => media.createCount() === 1)

    // `PerformanceCancel` carries no sessionId, so a revoking cancel for another
    // session is schema-valid on the envelope alone. It must not reach M1.
    binding.handleServerMessage(
      serverMessageSchema.parse({
        protocolVersion: '0.2',
        messageId: 'm-cancel',
        sessionId: 'session-other',
        epoch: 2,
        kind: 'performance.cancel',
        payload: { requestId: 'cancel-1', revokedEpoch: 2, newEpoch: 3 },
      }),
    )
    await waitFor(() => faults.length === 1)

    expect(faults).toEqual(['cancel cancel-1: envelope names a different session'])
    expect(receipts.some((receipt) => receipt.stage === 'cancelled')).toBe(false)
    expect(binding.status().idle).toBe(false)
    expect(binding.status().activeOutputId).toBe(command.outputId)
    binding.dispose()
  })

  it('keeps the playing subtitle when a stale command is rejected', async () => {
    const resolver = createControlledResolver()
    resolver.setAutoResolve()
    const media = createControlledMediaDriver()
    const subtitles: string[] = []
    const faults: string[] = []

    const binding = createPlaybackBinding({
      bootstrap: bootstrap(1),
      resolver,
      media,
      newReceiptId: () => 'console-receipt',
      localNowMs: () => 12,
      onReceipt: () => {},
      onStatus: () => {},
      onSubtitle: (text) => subtitles.push(text),
      onFault: (message) => faults.push(message),
    })

    const playing = fixturePerformanceCommand({ epoch: 2, subtitleText: 'now playing' })
    binding.handleServerMessage(
      serverMessageSchema.parse({
        protocolVersion: '0.2',
        messageId: 'm-execute',
        sessionId: playing.sessionId,
        epoch: 2,
        kind: 'performance.execute',
        payload: playing,
      }),
    )
    // The subtitle follows admission, not arrival: it is shown for the output M1
    // accepted, synchronously.
    expect(subtitles).toEqual(['now playing'])

    // An epoch-1 command is stale against the epoch-2 operation: M1 rejects it
    // before any effect, so it must not replace the playing subtitle.
    const stale = fixturePerformanceCommand({
      epoch: 1,
      outputId: 'output-stale',
      subtitleText: 'stale text',
    })
    binding.handleServerMessage(
      serverMessageSchema.parse({
        protocolVersion: '0.2',
        messageId: 'm-execute-stale',
        sessionId: stale.sessionId,
        epoch: 1,
        kind: 'performance.execute',
        payload: stale,
      }),
    )
    await waitFor(() => faults.length === 1)

    expect(faults).toEqual(['output-stale: dispatch rejected (stale)'])
    expect(subtitles).toEqual(['now playing'])
    expect(binding.status().activeOutputId).toBe(playing.outputId)
    binding.dispose()
  })

  it('does not cancel a newer output admitted during an accepted cancel', async () => {
    const resolver = createControlledResolver()
    resolver.setAutoResolve()
    const media = createControlledMediaDriver()
    const receipts: PerformanceReceipt[] = []
    const faults: string[] = []

    const binding = createPlaybackBinding({
      bootstrap: bootstrap(1),
      resolver,
      media,
      newReceiptId: () => 'console-receipt',
      localNowMs: () => 12,
      onReceipt: (receipt) => receipts.push(receipt),
      onStatus: () => {},
      onSubtitle: () => {},
      onFault: (message) => faults.push(message),
    })

    const first = fixturePerformanceCommand({ epoch: 2 })
    binding.handleServerMessage(
      serverMessageSchema.parse({
        protocolVersion: '0.2',
        messageId: 'm-execute-1',
        sessionId: first.sessionId,
        epoch: 2,
        kind: 'performance.execute',
        payload: first,
      }),
    )
    await waitFor(() => media.createCount() === 1)
    media.current()?.emitPlaying()
    await waitFor(() => binding.status().lastStage === 'started')

    // A revoking cancel (2 → 3) and a newer epoch-3 execute are delivered
    // synchronously, before the cancel's continuation resumes. Releasing the
    // caller signal on the accepted cancel would abort the newly admitted output.
    binding.handleServerMessage(
      serverMessageSchema.parse({
        protocolVersion: '0.2',
        messageId: 'm-cancel',
        sessionId: SESSION,
        epoch: 2,
        kind: 'performance.cancel',
        payload: { requestId: 'cancel-1', revokedEpoch: 2, newEpoch: 3 },
      }),
    )
    const second = fixturePerformanceCommand({
      epoch: 3,
      outputId: 'output-fixture-3',
      subtitleText: 'second',
    })
    binding.handleServerMessage(
      serverMessageSchema.parse({
        protocolVersion: '0.2',
        messageId: 'm-execute-3',
        sessionId: second.sessionId,
        epoch: 3,
        kind: 'performance.execute',
        payload: second,
      }),
    )

    await settleMicrotasks()
    await waitFor(() => resolver.leases().length === 2)

    expect(
      receipts.filter((receipt) => receipt.stage === 'cancelled').map((receipt) => receipt.outputId),
    ).toEqual([first.outputId])
    expect(faults).toEqual([])
    expect(binding.status().idle).toBe(false)
    expect(binding.status().activeOutputId).toBe(second.outputId)
    binding.dispose()
  })
})
