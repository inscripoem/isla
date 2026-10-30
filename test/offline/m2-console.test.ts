import { describe, expect, it } from 'vitest'
import {
  applicationClientMessageSchema,
  bootstrapSnapshotSchema,
  clientMessageSchema,
  inputAckSchema,
  inputSubmitMessageSchema,
  serverMessageSchema,
  type ApplicationClientMessage,
  type ControlAck,
  type ControlResumeMessage,
  type ControlStopMessage,
  type InputAck,
  type InputSubmitMessage,
  type PerformanceCommand,
  type PerformanceReceipt,
  type PlayerStatus,
  type ServerMessage,
} from '../../src/contracts'
import {
  canDispatch,
  createInitialConsoleState,
  reduceApplicationMessage,
  reduceControlAck,
  reduceInputAck,
  reduceServerMessage,
  reduceSessionFrontier,
  withBootstrap,
  withConnection,
  withPendingControl,
  withPendingInput,
  withReceipt,
  type ConsoleState,
  type ConnectionStatus,
  type SessionFrontier,
} from '../../src/console/console-state'
import {
  ConsoleTransportError,
  createAppTransport,
  isApplicationTransport,
  type SocketCloseInfo,
  type TransportSocket,
} from '../../src/console/app-transport'
import {
  OPERATOR_BOOTSTRAP_HEADER,
  OPERATOR_BOOTSTRAP_PATH,
} from '../../src/contracts'
import {
  OperatorBootstrapError,
  requestOperatorBootstrap,
} from '../../src/console/operator-bootstrap'
import { createPlaybackBinding } from '../../src/console/player-binding'
import { collectConsoleViolations } from '../conformance/console.conformance'
import { createBootstrapOnlyRuntime, createFixtureConsoleTransport } from '../support/correct-ports'
import { createFaultyConsoleTransport } from '../support/faulty-ports'
import {
  createControlledMediaDriver,
  createControlledResolver,
  createTestReceiptTools,
} from '../support/m1-kit'
import { FIXTURE_SESSION_ID, fixturePerformanceCommand } from '../support/fixture-data'
import {
  createPerformerMachine,
  type PerformerMachine,
  type PerformerMachineHooks,
  type PerformerTransport,
} from '../../src/console/performer-machine'
import { recoveryControlView } from '../../src/console/recovery-control'

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

  it('projects the session frontier exactly like the console session view', () => {
    let state = opened()
    let frontier: SessionFrontier = { sessionId: SESSION, epoch: 1, lifecycle: 'running', lastSeq: 4 }
    const messages: ServerMessage[] = [
      sessionEvent(6),
      serverMessageSchema.parse({
        protocolVersion: '0.2',
        messageId: 'm-stop-ack',
        sessionId: SESSION,
        epoch: 2,
        kind: 'control.ack',
        payload: {
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
        },
      }),
      serverMessageSchema.parse(snapshotWith(3, 7, { lifecycle: 'running', capabilityRevision: 2 })),
    ]

    for (const message of messages) {
      state = reduceServerMessage(state, message)
      frontier = reduceSessionFrontier(frontier, message)
    }

    expect(state.session).not.toBeNull()
    // The frontier the player binding reduces must project the same accepted
    // session identity, epoch, lifecycle and sequence as the console view, so
    // admission cannot drift from the state the console already accepted.
    expect(frontier).toEqual({
      sessionId: state.session!.sessionId,
      epoch: state.session!.epoch,
      lifecycle: state.session!.lifecycle,
      lastSeq: state.session!.lastSeq,
    })
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

  it('refuses a command the console has already superseded by an accepted Stop', async () => {
    const resolver = createControlledResolver()
    resolver.setAutoResolve()
    const media = createControlledMediaDriver()
    const receipts: PerformanceReceipt[] = []
    const subtitles: string[] = []
    const faults: string[] = []

    const binding = createPlaybackBinding({
      bootstrap: bootstrap(1),
      resolver,
      media,
      newReceiptId: () => 'console-receipt',
      localNowMs: () => 12,
      onReceipt: (receipt) => receipts.push(receipt),
      onStatus: () => {},
      onSubtitle: (text) => subtitles.push(text),
      onFault: (message) => faults.push(message),
    })

    // A correlated Stop acknowledgement the console accepts advances it to
    // epoch 2 / stopped. The binding is never asked to perform it, so only the
    // frontier it reduces from every decoded message keeps M1's epoch boundary
    // in step with the accepted session.
    binding.handleServerMessage(
      serverMessageSchema.parse({
        protocolVersion: '0.2',
        messageId: 'm-stop-ack',
        sessionId: SESSION,
        epoch: 2,
        kind: 'control.ack',
        payload: {
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
        },
      }),
    )

    // A late epoch-1 command the console has already superseded, and a command
    // at the stopped epoch, must both be refused rather than admitted ahead of
    // the boundary and replacing the subtitle.
    const late = fixturePerformanceCommand({ epoch: 1, subtitleText: 'late' })
    const stopped = fixturePerformanceCommand({ epoch: 2, subtitleText: 'stopped' })
    binding.handleServerMessage(
      serverMessageSchema.parse({
        protocolVersion: '0.2',
        messageId: 'm-execute-late',
        sessionId: SESSION,
        epoch: 1,
        kind: 'performance.execute',
        payload: late,
      }),
    )
    binding.handleServerMessage(
      serverMessageSchema.parse({
        protocolVersion: '0.2',
        messageId: 'm-execute-stopped',
        sessionId: SESSION,
        epoch: 2,
        kind: 'performance.execute',
        payload: stopped,
      }),
    )
    await settleMicrotasks()

    expect(faults).toEqual([
      'ignored output-fixture-1: the command is behind the accepted epoch',
      'ignored output-fixture-1: the accepted session is stopped',
    ])
    expect(subtitles).toEqual([])
    expect(receipts).toEqual([])
    expect(binding.status().idle).toBe(true)
    binding.dispose()
  })

  it('does not let an old busy continuation revoke a newer output', async () => {
    const resolver = createControlledResolver()
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

    const frame = (messageId: string, command: PerformanceCommand) =>
      serverMessageSchema.parse({
        protocolVersion: '0.2',
        messageId,
        sessionId: command.sessionId,
        epoch: command.epoch,
        kind: 'performance.execute',
        payload: command,
      })

    // A owns the slot at epoch 1.
    const first = fixturePerformanceCommand({ outputId: 'output-a' })
    binding.handleServerMessage(frame('m-execute-a', first))
    expect(binding.status().activeOutputId).toBe(first.outputId)

    // B is a different output at the same epoch: M1 rejects it busy, and its
    // continuation is queued behind this synchronous delivery.
    const busy = fixturePerformanceCommand({ outputId: 'output-b' })
    binding.handleServerMessage(frame('m-execute-b', busy))

    // Before that continuation resumes, an accepted cancel 1 → 2 and a newer
    // epoch-2 output C are delivered. C reuses the caller signal the accepted
    // cancel deliberately left bound, so an unconditional supersede by the old
    // continuation would abort the newer output.
    binding.handleServerMessage(
      serverMessageSchema.parse({
        protocolVersion: '0.2',
        messageId: 'm-cancel-1',
        sessionId: SESSION,
        epoch: 2,
        kind: 'performance.cancel',
        payload: { requestId: 'cancel-1', revokedEpoch: 1, newEpoch: 2 },
      }),
    )
    const newer = fixturePerformanceCommand({ epoch: 2, outputId: 'output-c' })
    binding.handleServerMessage(frame('m-execute-c', newer))

    await settleMicrotasks()

    // The resumed continuation revalidates the owner, re-offers on the current
    // caller and is rejected as stale; it must not cancel the newer output.
    expect(faults).toEqual(['output-b: dispatch rejected (stale)'])
    expect(
      receipts.filter((receipt) => receipt.stage === 'cancelled').map((receipt) => receipt.outputId),
    ).toEqual([first.outputId])
    expect(binding.status().idle).toBe(false)
    expect(binding.status().activeOutputId).toBe(newer.outputId)
    binding.dispose()
  })

  it('discards a busy continuation the console stopped by acknowledgement', async () => {
    const resolver = createControlledResolver()
    const media = createControlledMediaDriver()
    const receipts: PerformanceReceipt[] = []
    const subtitles: string[] = []
    const faults: string[] = []

    const binding = createPlaybackBinding({
      bootstrap: bootstrap(1),
      resolver,
      media,
      newReceiptId: () => 'console-receipt',
      localNowMs: () => 12,
      onReceipt: (receipt) => receipts.push(receipt),
      onStatus: () => {},
      onSubtitle: (text) => subtitles.push(text),
      onFault: (message) => faults.push(message),
    })

    const frame = (messageId: string, command: PerformanceCommand) =>
      serverMessageSchema.parse({
        protocolVersion: '0.2',
        messageId,
        sessionId: command.sessionId,
        epoch: command.epoch,
        kind: 'performance.execute',
        payload: command,
      })

    // A owns the slot at epoch 1; B at the same epoch is rejected busy and its
    // continuation is queued behind this synchronous delivery.
    const first = fixturePerformanceCommand({ outputId: 'output-a', subtitleText: 'first' })
    binding.handleServerMessage(frame('m-execute-a', first))
    expect(binding.status().activeOutputId).toBe(first.outputId)
    const busy = fixturePerformanceCommand({ outputId: 'output-b', subtitleText: 'second' })
    binding.handleServerMessage(frame('m-execute-b', busy))

    // Before the continuation resumes, the console accepts a correlated Stop
    // acknowledgement advancing it to epoch 2 / stopped. The retry must revalidate
    // admission against that frontier and discard, not re-offer into M1.
    binding.handleServerMessage(
      serverMessageSchema.parse({
        protocolVersion: '0.2',
        messageId: 'm-stop-ack',
        sessionId: SESSION,
        epoch: 2,
        kind: 'control.ack',
        payload: {
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
        },
      }),
    )
    await settleMicrotasks()

    expect(faults).toEqual(['ignored output-b: the command is behind the accepted epoch'])
    expect(subtitles).toEqual(['first'])
    expect(binding.status().activeOutputId).not.toBe(busy.outputId)
    expect(receipts.every((receipt) => receipt.outputId !== busy.outputId)).toBe(true)
    binding.dispose()
  })

  it('discards a busy continuation the console stopped by snapshot', async () => {
    const resolver = createControlledResolver()
    const media = createControlledMediaDriver()
    const receipts: PerformanceReceipt[] = []
    const subtitles: string[] = []
    const faults: string[] = []

    const binding = createPlaybackBinding({
      bootstrap: bootstrap(1),
      resolver,
      media,
      newReceiptId: () => 'console-receipt',
      localNowMs: () => 12,
      onReceipt: (receipt) => receipts.push(receipt),
      onStatus: () => {},
      onSubtitle: (text) => subtitles.push(text),
      onFault: (message) => faults.push(message),
    })

    const frame = (messageId: string, command: PerformanceCommand) =>
      serverMessageSchema.parse({
        protocolVersion: '0.2',
        messageId,
        sessionId: command.sessionId,
        epoch: command.epoch,
        kind: 'performance.execute',
        payload: command,
      })

    const first = fixturePerformanceCommand({ outputId: 'output-a', subtitleText: 'first' })
    binding.handleServerMessage(frame('m-execute-a', first))
    const busy = fixturePerformanceCommand({ outputId: 'output-b', subtitleText: 'second' })
    binding.handleServerMessage(frame('m-execute-b', busy))

    // A stopped snapshot at epoch 2 advances the accepted frontier the same way a
    // Stop acknowledgement does; the pending retry must read that frontier and
    // discard rather than admit an epoch-1 command the console has superseded.
    binding.handleServerMessage(
      serverMessageSchema.parse(snapshotWith(2, 10, { lifecycle: 'stopped' })),
    )
    await settleMicrotasks()

    expect(faults).toEqual(['ignored output-b: the command is behind the accepted epoch'])
    expect(subtitles).toEqual(['first'])
    expect(binding.status().activeOutputId).not.toBe(busy.outputId)
    expect(receipts.every((receipt) => receipt.outputId !== busy.outputId)).toBe(true)
    binding.dispose()
  })

  it('discards a busy continuation a local cancellation superseded', async () => {
    const resolver = createControlledResolver()
    const media = createControlledMediaDriver()
    const receipts: PerformanceReceipt[] = []
    const subtitles: string[] = []
    const faults: string[] = []

    const binding = createPlaybackBinding({
      bootstrap: bootstrap(1),
      resolver,
      media,
      newReceiptId: () => 'console-receipt',
      localNowMs: () => 12,
      onReceipt: (receipt) => receipts.push(receipt),
      onStatus: () => {},
      onSubtitle: (text) => subtitles.push(text),
      onFault: (message) => faults.push(message),
    })

    const frame = (messageId: string, command: PerformanceCommand) =>
      serverMessageSchema.parse({
        protocolVersion: '0.2',
        messageId,
        sessionId: command.sessionId,
        epoch: command.epoch,
        kind: 'performance.execute',
        payload: command,
      })

    const first = fixturePerformanceCommand({ outputId: 'output-a', subtitleText: 'first' })
    binding.handleServerMessage(frame('m-execute-a', first))
    const busy = fixturePerformanceCommand({ outputId: 'output-b', subtitleText: 'second' })
    binding.handleServerMessage(frame('m-execute-b', busy))

    // A disconnect or unmount cancels local playback and renews the caller signal.
    // The pending retry must not re-offer on the fresh signal, which would
    // resurrect an operation the console deliberately cancelled.
    binding.cancelLocal()
    await settleMicrotasks()

    expect(faults).toEqual(['ignored output-b: a local cancellation superseded the attempt'])
    expect(subtitles).toEqual(['first'])
    expect(binding.status().idle).toBe(true)
    expect(receipts.every((receipt) => receipt.outputId !== busy.outputId)).toBe(true)
    binding.dispose()
  })

  it('discards a busy continuation after the player is disposed', async () => {
    const resolver = createControlledResolver()
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

    const frame = (messageId: string, command: PerformanceCommand) =>
      serverMessageSchema.parse({
        protocolVersion: '0.2',
        messageId,
        sessionId: command.sessionId,
        epoch: command.epoch,
        kind: 'performance.execute',
        payload: command,
      })

    const first = fixturePerformanceCommand({ outputId: 'output-a' })
    binding.handleServerMessage(frame('m-execute-a', first))
    const busy = fixturePerformanceCommand({ outputId: 'output-b' })
    binding.handleServerMessage(frame('m-execute-b', busy))

    // Disposing the mount invalidates the pending attempt; the retry must discard
    // rather than offer a command to a disposed player.
    binding.dispose()
    await settleMicrotasks()

    expect(faults).toEqual(['ignored output-b: the local player is disposed'])
    expect(receipts.every((receipt) => receipt.outputId !== busy.outputId)).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * Application transport extension (protocol 0.2). Base messages keep reaching
 * `onServerMessage`; extended kinds reach only `onApplicationMessage`.
 * ------------------------------------------------------------------ */

function attachAckMessage(): Record<string, unknown> {
  return {
    protocolVersion: '0.2',
    messageId: 'm-attach-ack',
    sessionId: SESSION,
    epoch: 1,
    kind: 'session.attach.ack',
    payload: { connectionId: 'conn-1', performer: true },
  }
}

function operatorAckMessage(): Record<string, unknown> {
  return {
    protocolVersion: '0.2',
    messageId: 'm-operator-ack',
    sessionId: SESSION,
    epoch: 1,
    kind: 'operator.ack',
    payload: { role: 'operator', requestMessageId: 'bootstrap-1' },
  }
}

function recoveryStateMessage(): Record<string, unknown> {
  return {
    protocolVersion: '0.2',
    messageId: 'm-recovery-state',
    sessionId: SESSION,
    epoch: 1,
    kind: 'session.recovery.state',
    payload: { retiring: true },
  }
}

function attachApplicationMessage(): ApplicationClientMessage {
  return applicationClientMessageSchema.parse({
    protocolVersion: '0.2',
    messageId: 'm-attach',
    sessionId: SESSION,
    epoch: 1,
    kind: 'session.attach',
    payload: {},
  })
}

async function bootedTransport(options: {
  onProtocolViolation?: (detail: string) => void
}): Promise<{ fake: FakeSocket; transport: ReturnType<typeof createAppTransport> }> {
  const fake = createFakeSocket()
  const transport = createAppTransport({
    url: 'ws://console.test/app',
    createSocket: () => fake.socket,
    onProtocolViolation: options.onProtocolViolation,
  })
  const booting = transport.bootstrap()
  fake.open()
  fake.emit(snapshotMessage())
  await booting
  return { fake, transport }
}

describe('application transport extension', () => {
  it('delivers extended kinds to application listeners and base kinds to both, once each', async () => {
    const { fake, transport } = await bootedTransport({})
    const baseKinds: string[] = []
    const appKinds: string[] = []
    transport.onServerMessage((message) => baseKinds.push(message.kind))
    transport.onApplicationMessage((message) => appKinds.push(message.kind))

    fake.emit(attachAckMessage())
    fake.emit(operatorAckMessage())
    fake.emit(recoveryStateMessage())
    fake.emit(sessionEvent(6))

    // Extended kinds are never handed to the frozen base listeners.
    expect(baseKinds).toEqual(['session.event'])
    // Every valid application message reaches the application listener once.
    expect(appKinds).toEqual([
      'session.attach.ack',
      'operator.ack',
      'session.recovery.state',
      'session.event',
    ])
  })

  it('keeps the base snapshot/ack behaviour while extended frames flow', async () => {
    const fake = createFakeSocket()
    const transport = createAppTransport({ url: 'ws://console.test/app', createSocket: () => fake.socket })
    const baseKinds: string[] = []
    transport.onServerMessage((message) => {
      baseKinds.push(message.kind)
      if (message.kind === 'session.snapshot') throw new Error('broken base listener')
    })
    transport.onServerMessage((message) => baseKinds.push(`second:${message.kind}`))

    const pending = transport.bootstrap()
    fake.open()
    // Bootstrap settles only on the snapshot, not on an extended frame.
    fake.emit(attachAckMessage())
    fake.emit(snapshotMessage())
    const snapshot = await pending
    expect(snapshot.sessionId).toBe(SESSION)

    // A throwing listener does not stop the next listener on the same frame.
    expect(baseKinds).toEqual(['session.snapshot', 'second:session.snapshot'])
  })

  it('reports unknown kinds and invalid JSON with the existing detail strings and drops them', async () => {
    const violations: string[] = []
    const fake = createFakeSocket()
    const transport = createAppTransport({
      url: 'ws://console.test/app',
      createSocket: () => fake.socket,
      onProtocolViolation: (detail) => violations.push(detail),
    })
    const appKinds: string[] = []
    transport.onApplicationMessage((message) => appKinds.push(message.kind))

    const booting = transport.bootstrap()
    fake.open()
    fake.emitRaw('{ not json')
    fake.emit({ protocolVersion: '0.2', messageId: 'm-x', sessionId: SESSION, epoch: 1, kind: 'unknown.kind' })
    // A malformed extended kind is invalid, not silently accepted.
    fake.emit({ ...attachAckMessage(), payload: { connectionId: 'conn-1' } })
    fake.emit(snapshotMessage())
    await booting

    expect(violations).toEqual([
      'inbound frame is not valid JSON',
      'inbound frame is not a valid v0.2 server message',
      'inbound frame is not a valid v0.2 server message',
    ])
    expect(appKinds).toEqual(['session.snapshot'])
  })

  it('is detected by the guard while a base-only fixture transport is rejected', async () => {
    const { transport } = await bootedTransport({})
    expect(isApplicationTransport(transport)).toBe(true)

    const fixture = createFixtureConsoleTransport(createBootstrapOnlyRuntime())
    expect(isApplicationTransport(fixture)).toBe(false)
  })

  it('sends a valid application frame and keeps it to one JSON frame', async () => {
    const { fake, transport } = await bootedTransport({})
    const message = attachApplicationMessage()
    transport.sendApplication(message)

    expect(fake.sent).toHaveLength(1)
    const decoded = JSON.parse(fake.sent[0] ?? '{}')
    expect(applicationMessageEcho(decoded)).toEqual(message)
  })

  it('rejects an invalid application message locally and writes nothing', async () => {
    const { fake, transport } = await bootedTransport({})
    const invalid = { ...attachApplicationMessage(), messageId: '' } as never
    expect(() => transport.sendApplication(invalid)).toThrowError()
    expect(fake.sent).toEqual([])
  })

  it('refuses to send on a closed transport with reason closed', async () => {
    const { transport } = await bootedTransport({})
    transport.close()
    let error: unknown = null
    try {
      transport.sendApplication(attachApplicationMessage())
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ConsoleTransportError)
    expect((error as ConsoleTransportError).reason).toBe('closed')
  })
})

/** Round-trip a decoded frame through the shared client schema for comparison. */
function applicationMessageEcho(value: unknown): unknown {
  return applicationClientMessageSchema.parse(value)
}

/* ------------------------------------------------------------------ *
 * Operator bootstrap. The fetch is injected, so no network is touched.
 * ------------------------------------------------------------------ */

interface RecordedFetch {
  readonly calls: Array<{ input: string; init: RequestInit }>
}

function jsonResponse(body: unknown, status = 200): Response {
  const serialized = typeof body === 'string' ? body : JSON.stringify(body)
  return new Response(serialized, {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function recordingFetch(response: () => Promise<Response>): {
  fetchImpl: typeof fetch
  recorded: RecordedFetch
} {
  const recorded: RecordedFetch = { calls: [] }
  const fetchImpl = ((input: string, init: RequestInit) => {
    recorded.calls.push({ input, init })
    return response()
  }) as unknown as typeof fetch
  return { fetchImpl, recorded }
}

async function bootstrapFailure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  )
}

describe('operator bootstrap', () => {
  it('posts to the documented path with the required header, same-origin credentials and no body', async () => {
    const secret = 'one-time-token-value'
    const { fetchImpl, recorded } = recordingFetch(() =>
      Promise.resolve(jsonResponse({ ok: true, token: secret, expiresAtMs: 1234 })),
    )

    const result = await requestOperatorBootstrap({ fetchImpl })

    expect(result).toEqual({ token: secret, expiresAtMs: 1234 })
    expect(recorded.calls).toHaveLength(1)
    const call = recorded.calls[0]!
    expect(call.input).toBe(OPERATOR_BOOTSTRAP_PATH)
    expect(call.init.method).toBe('POST')
    expect(call.init.credentials).toBe('same-origin')
    expect(call.init.body).toBeUndefined()
    const headers = call.init.headers as Record<string, string>
    expect(headers[OPERATOR_BOOTSTRAP_HEADER]).toBe('1')
  })

  it('rejects a structurally invalid body without leaking the token', async () => {
    const secret = 'must-not-appear-token'
    const invalidBodies: unknown[] = [
      { ok: false, token: secret, expiresAtMs: 1 },
      { ok: true, token: '', expiresAtMs: 1 },
      { ok: true, token: secret, expiresAtMs: -1 },
      { ok: true, token: secret, expiresAtMs: Number.POSITIVE_INFINITY },
      { ok: true, token: secret },
      [],
    ]
    for (const body of invalidBodies) {
      const { fetchImpl } = recordingFetch(() => Promise.resolve(jsonResponse(body)))
      const error = await bootstrapFailure(requestOperatorBootstrap({ fetchImpl }))
      expect(error).toBeInstanceOf(OperatorBootstrapError)
      expect((error as OperatorBootstrapError).reason).toBe('invalid_response')
      expect((error as Error).message).not.toContain(secret)
    }
  })

  it('reports malformed JSON, non-2xx and network failures with the documented reasons', async () => {
    const malformed = recordingFetch(() => Promise.resolve(jsonResponse('{ not json')))
    const malformedError = await bootstrapFailure(requestOperatorBootstrap({ fetchImpl: malformed.fetchImpl }))
    expect((malformedError as OperatorBootstrapError).reason).toBe('invalid_response')

    const refused = recordingFetch(() => Promise.resolve(jsonResponse({ ok: true }, 403)))
    const httpError = await bootstrapFailure(requestOperatorBootstrap({ fetchImpl: refused.fetchImpl }))
    expect(httpError).toBeInstanceOf(OperatorBootstrapError)
    expect((httpError as OperatorBootstrapError).reason).toBe('http')

    const offline = recordingFetch(() => Promise.reject(new Error('socket hang up')))
    const networkError = await bootstrapFailure(requestOperatorBootstrap({ fetchImpl: offline.fetchImpl }))
    expect(networkError).toBeInstanceOf(OperatorBootstrapError)
    expect((networkError as OperatorBootstrapError).reason).toBe('network')
  })

  it('times out a request that never settles and leaves no pending timer', async () => {
    const { fetchImpl } = recordingFetch(
      () => new Promise<Response>(() => {}),
    )
    const start = Date.now()
    const error = await bootstrapFailure(requestOperatorBootstrap({ fetchImpl, timeoutMs: 5 }))
    expect(error).toBeInstanceOf(OperatorBootstrapError)
    expect((error as OperatorBootstrapError).reason).toBe('timeout')
    expect(Date.now() - start).toBeLessThan(1000)
  })

  it('honours an injected abort and rejects without abandoning the contract', async () => {
    const secret = 'abort-secret-token'
    const controller = new AbortController()
    const { fetchImpl } = recordingFetch(
      () =>
        new Promise<Response>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error(secret)))
        }),
    )
    const pending = requestOperatorBootstrap({ fetchImpl, signal: controller.signal, timeoutMs: 5000 })
    controller.abort()
    const error = await bootstrapFailure(pending)
    expect(error).toBeInstanceOf(OperatorBootstrapError)
    expect((error as OperatorBootstrapError).reason).toBe('timeout')
    expect((error as Error).message).not.toContain(secret)
  })
})

/* ------------------------------------------------------------------ *
 * The owner-reviewed browser-safe performer machine extraction. The console
 * view drives the production module in `src/console/performer-machine.ts`; a
 * fake transport plus controlled media and deterministic receipt/clock tools
 * keep every frame observable without a socket, audio device or timer.
 * ------------------------------------------------------------------ */

interface RecordedMachineFrame {
  readonly raw: string
  readonly message: ApplicationClientMessage
}

function createRecordingPerformerTransport(): {
  transport: PerformerTransport
  frames: RecordedMachineFrame[]
} {
  const frames: RecordedMachineFrame[] = []
  return {
    transport: {
      send: (raw) => {
        const message = applicationClientMessageSchema.parse(JSON.parse(raw))
        frames.push({ raw, message })
      },
    },
    frames,
  }
}

function machineSnapshotMessage(epoch = 1): Record<string, unknown> {
  return {
    protocolVersion: '0.2',
    messageId: 'snap-console-1',
    sessionId: SESSION,
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

function machineOfferMessage(command: PerformanceCommand): Record<string, unknown> {
  return {
    protocolVersion: '0.2',
    messageId: `offer-${command.outputId}`,
    sessionId: command.sessionId,
    epoch: command.epoch,
    kind: 'performance.offer',
    payload: command,
  }
}

function machineGrantMessage(
  command: PerformanceCommand,
  remainingLifetimeMs = 1_000,
): Record<string, unknown> {
  return {
    protocolVersion: '0.2',
    messageId: `grant-${command.outputId}`,
    sessionId: command.sessionId,
    epoch: command.epoch,
    kind: 'performance.grant',
    payload: {
      outputId: command.outputId,
      sessionId: command.sessionId,
      turnId: command.turnId,
      segmentId: command.segmentId,
      epoch: command.epoch,
      remainingLifetimeMs,
    },
  }
}

function createConsoleMachine(
  media = createControlledMediaDriver({ autoEvents: true }),
  hooks?: PerformerMachineHooks,
): {
  machine: PerformerMachine
  frames: RecordedMachineFrame[]
  media: ReturnType<typeof createControlledMediaDriver>
} {
  const resolver = createControlledResolver()
  resolver.setAutoResolve()
  const { transport, frames } = createRecordingPerformerTransport()
  const machine = createPerformerMachine({
    transport,
    media,
    resolver,
    receipts: createTestReceiptTools('console'),
    now: () => 5_000,
    hooks,
  })
  machine.handleMessage(machineSnapshotMessage(1))
  return { machine, frames, media }
}

describe('console performer machine extraction', () => {
  it('emits application frames with the requested source and control correlation ids', () => {
    const { machine, frames } = createConsoleMachine()

    machine.attach()
    expect(frames.at(-1)?.message.kind).toBe('session.attach')

    machine.bootstrapOperator('one-time-token')
    const bootstrap = frames.at(-1)?.message
    expect(bootstrap?.kind).toBe('operator.bootstrap')
    expect(bootstrap?.payload).toEqual({ token: 'one-time-token' })

    const inputId = machine.input('hello console', 'console-input-1', 'cohost-text')
    expect(inputId).toBe('console-input-1')
    const input = frames.at(-1)?.message
    expect(input?.kind).toBe('input.submit')
    expect(input?.messageId).toBe('console-input-1')
    expect(input?.payload).toEqual({ source: 'cohost-text', text: 'hello console' })

    const resumeId = machine.resume('console-resume-request', 'console-resume-message')
    expect(resumeId).toBe('console-resume-message')
    const resume = frames.at(-1)?.message
    expect(resume?.kind).toBe('control.resume')
    expect(resume?.messageId).toBe('console-resume-message')
    expect(resume?.payload).toEqual({ requestId: 'console-resume-request' })

    const stopId = machine.stop('console-stop-request', 'console-stop-message')
    expect(stopId).toBe('console-stop-message')
    const stop = frames.at(-1)?.message
    expect(stop?.kind).toBe('control.stop')
    expect(stop?.messageId).toBe('console-stop-message')
    expect(stop?.payload).toEqual({ requestId: 'console-stop-request' })

    const recoverId = machine.recover()
    expect(recoverId).not.toBeNull()
    const recover = frames.at(-1)?.message
    expect(recover?.kind).toBe('session.recover')
    expect(recover?.messageId).toBe(recoverId)
    // The acknowledgement stays the required literal; it is never measured.
    expect(recover?.payload).toEqual({ acknowledgePlaybackEnded: true })

    // Every recorded frame already round-tripped through the shared client
    // schema in the recording transport, so the correlation is wire-valid.
    expect(frames.map((frame) => frame.message.kind)).toEqual([
      'session.attach',
      'operator.bootstrap',
      'input.submit',
      'control.resume',
      'control.stop',
      'session.recover',
    ])
    for (const frame of frames) {
      expect(applicationClientMessageSchema.safeParse(JSON.parse(frame.raw)).success).toBe(true)
    }

    // Defaults are unchanged when no arguments are supplied.
    expect(machine.input('default source')).not.toBeNull()
    expect(frames.at(-1)?.message.payload).toEqual({ source: 'local-audience', text: 'default source' })
    expect(machine.resume()).not.toBeNull()
    expect(machine.stop()).not.toBeNull()
  })

  it('reports the player status as idle before a controller and after terminal release', async () => {
    const { machine, frames } = createConsoleMachine()
    expect(machine.state().playerStatus).toEqual({ idle: true, activeOutputId: null, lastStage: null })

    const command = fixturePerformanceCommand()
    machine.handleMessage(machineOfferMessage(command))
    machine.handleMessage(machineGrantMessage(command))
    await waitFor(() =>
      frames.some(
        (frame) =>
          frame.message.kind === 'performance.receipt' &&
          (frame.message.payload as PerformanceReceipt).stage === 'completed',
      ),
    )

    const completed = frames.find(
      (frame) =>
        frame.message.kind === 'performance.receipt' &&
        (frame.message.payload as PerformanceReceipt).stage === 'completed',
    )
    const completedPayload = completed?.message.payload as PerformanceReceipt | undefined
    expect(completedPayload?.stage).toBe('completed')

    // The physical status is reported ahead of each receipt and reflects the
    // controller's own observation, not the delivery fact alone.
    const statusIndex = frames.findIndex(
      (frame, index) =>
        frame.message.kind === 'performance.status' &&
        index < frames.indexOf(completed!) &&
        (frame.message.payload as { outputId: string }).outputId === command.outputId,
    )
    expect(statusIndex).toBeGreaterThanOrEqual(0)
    expect(statusIndex).toBeLessThan(frames.indexOf(completed!))
    const statusPayload = frames[statusIndex]?.message.payload as { outputId: string; status: PlayerStatus }
    expect(statusPayload.outputId).toBe(command.outputId)

    // A naturally completed output releases local admission, so the controller
    // reports idle and names no active output.
    expect(machine.state().playerStatus.idle).toBe(true)
    expect(machine.state().playerStatus.activeOutputId).toBeNull()
    machine.dispose('test complete')
  })

  it('keeps the player status non-idle while a granted output is playing', async () => {
    const { machine, frames, media } = createConsoleMachine()
    const command = fixturePerformanceCommand({ outputId: 'output-console-playing' })
    machine.handleMessage(machineOfferMessage(command))
    machine.handleMessage(machineGrantMessage(command))
    await waitFor(() => frames.some((frame) => frame.message.kind === 'performance.ready'))
    await waitFor(() => media.createCount() === 1)

    expect(machine.state().playerStatus.idle).toBe(false)
    expect(machine.state().playerStatus.activeOutputId).toBe(command.outputId)
    machine.dispose('test complete')
  })

  it('generates realm-unique message ids that never collide with a caller prefix', () => {
    const first = createConsoleMachine().machine
    const second = createConsoleMachine().machine

    const firstId = first.input('first instance')
    const secondId = second.input('second instance')
    expect(firstId).not.toBeNull()
    expect(secondId).not.toBeNull()
    expect(firstId).not.toBe(secondId)

    // A caller-supplied simple prefix is honoured verbatim and is not the
    // shape the machine generates for itself.
    expect(first.input('explicit', 'm-prefix-1')).toBe('m-prefix-1')
    for (const id of [firstId!, secondId!]) {
      expect(id).not.toBe('m-prefix-1')
      expect(id.startsWith('m-prefix')).toBe(false)
      // The realm nonce plus a monotonically increasing sequence, not a bare
      // counter that a reloaded realm would restart.
      expect(id).toMatch(/^m[0-9a-z]+-\d+-msg-\d+$/)
    }
    first.dispose('test complete')
    second.dispose('test complete')
  })
})

/* ------------------------------------------------------------------ *
 * C1 selection and waiting projection. Pure view state over accepted
 * session events, with server-confirmed delivery kept as server evidence.
 * ------------------------------------------------------------------ */

import {
  applicationServerMessageSchema,
  deliveryClassificationSchema,
  inputEventSchema,
  selectionResultSchema,
  type ApplicationServerMessage,
} from '../../src/contracts'

const PIPELINE_EPOCH = 1

function pipelineInput(
  eventId: string,
  text: string,
  source: 'local-audience' | 'cohost-text' | 'external-fixture' = 'local-audience',
) {
  return inputEventSchema.parse({
    eventId,
    sessionId: SESSION,
    epoch: PIPELINE_EPOCH,
    source,
    actorId: 'fixture-actor',
    text,
    receivedAtMs: 1,
    expiresAtMs: 1_000,
    trust: 'untrusted-content',
  })
}

function inputAcceptedEvent(
  seq: number,
  eventId: string,
  text: string,
  overrides: Record<string, unknown> = {},
): ServerMessage {
  return serverMessageSchema.parse({
    protocolVersion: '0.2',
    messageId: `m-input-${seq}`,
    sessionId: SESSION,
    epoch: PIPELINE_EPOCH,
    kind: 'session.event',
    payload: { seq, type: 'input.accepted', data: { eventId, input: pipelineInput(eventId, text), ...overrides } },
  })
}

function respondPlan(requestId = 'selection-1', selectedEventId = 'event-a') {
  return selectionResultSchema.parse({
    requestId,
    sessionId: SESSION,
    epoch: PIPELINE_EPOCH,
    snapshotRevision: 1,
    disposition: 'respond',
    selectedEventIds: [selectedEventId],
    replyIntent: 'answer',
    reasonCode: 'provider-answered',
    provider: 'fixture-provider',
    modelVersion: 'fixture-1',
    usage: {
      provider: 'fixture-provider',
      requestedModel: 'fixture-model',
      resolvedModel: 'fixture-model',
      requestId,
      inputTokens: 1,
      outputTokens: 1,
      usageMissing: false,
      elapsedMs: 1,
      status: 'ok',
      pricingRef: null,
    },
  })
}

function deferPlan(requestId = 'selection-1') {
  return selectionResultSchema.parse({
    requestId,
    sessionId: SESSION,
    epoch: PIPELINE_EPOCH,
    snapshotRevision: 1,
    disposition: 'defer',
    selectedEventIds: [],
    replyIntent: null,
    reasonCode: 'provider-deferred',
    provider: 'fixture-provider',
    modelVersion: 'fixture-1',
    usage: {
      provider: 'fixture-provider',
      requestedModel: 'fixture-model',
      resolvedModel: 'fixture-model',
      requestId,
      inputTokens: 1,
      outputTokens: 1,
      usageMissing: false,
      elapsedMs: 1,
      status: 'ok',
      pricingRef: null,
    },
  })
}

function selectionPlanEvent(
  seq: number,
  plan: unknown,
  synthetic = false,
  overrides: Record<string, unknown> = {},
): ServerMessage {
  return serverMessageSchema.parse({
    protocolVersion: '0.2',
    messageId: `m-plan-${seq}`,
    sessionId: SESSION,
    epoch: PIPELINE_EPOCH,
    kind: 'session.event',
    payload: { seq, type: 'selection.plan', data: { plan, synthetic, ...overrides } },
  })
}

function turnStartedEvent(
  seq: number,
  replyIntent: unknown = 'answer',
  turnId: unknown = 'turn-1',
  overrides: Record<string, unknown> = {},
): ServerMessage {
  return serverMessageSchema.parse({
    protocolVersion: '0.2',
    messageId: `m-turn-${seq}`,
    sessionId: SESSION,
    epoch: PIPELINE_EPOCH,
    kind: 'session.event',
    payload: { seq, type: 'turn.started', data: { turnId, replyIntent, ...overrides } },
  })
}

function deliveryCommittedEvent(
  seq: number,
  classification: unknown = 'fully-delivered',
  overrides: Record<string, unknown> = {},
): ServerMessage {
  return serverMessageSchema.parse({
    protocolVersion: '0.2',
    messageId: `m-delivery-${seq}`,
    sessionId: SESSION,
    epoch: PIPELINE_EPOCH,
    kind: 'session.event',
    payload: {
      seq,
      type: 'delivery.committed',
      data: {
        outputId: 'output-a',
        turnId: 'turn-1',
        segmentId: 'segment-1',
        classification,
        ...overrides,
      },
    },
  })
}

function stoppedControlAck(
  seqEpoch = 2,
  action: 'stop' | 'resume' = 'stop',
  status: 'applied' | 'duplicate' = 'applied',
): ServerMessage {
  return serverMessageSchema.parse({
    protocolVersion: '0.2',
    messageId: `m-control-${action}`,
    sessionId: SESSION,
    epoch: seqEpoch,
    kind: 'control.ack',
    payload: {
      sessionId: SESSION,
      requestId: `control-${action}-1`,
      requestMessageId: 'control-message-1',
      action,
      status,
      previousEpoch: seqEpoch - 1,
      epoch: seqEpoch,
      lifecycle: action === 'stop' ? 'stopped' : 'running',
      outputConfirmation: action === 'stop' ? 'pending' : 'confirmed',
      reasonCode: null,
      message: action === 'stop' ? 'stopped' : 'resumed',
    },
  })
}

function recoveryState(epoch: number, retiring: boolean): ApplicationServerMessage {
  return applicationServerMessageSchema.parse({
    protocolVersion: '0.2',
    messageId: 'm-recovery-state',
    sessionId: SESSION,
    epoch,
    kind: 'session.recovery.state',
    payload: { retiring },
  })
}

function reduceAll(state: ConsoleState, messages: readonly ServerMessage[]): ConsoleState {
  return messages.reduce((current, message) => reduceServerMessage(current, message), state)
}

describe('C1 selection and waiting projection', () => {
  it('projects an accepted input through plan, turn and server delivery', () => {
    const input = inputAcceptedEvent(5, 'event-a', 'hello captain', {
      input: pipelineInput('event-a', 'hello captain', 'cohost-text'),
    })
    const state = reduceAll(opened(), [
      input,
      selectionPlanEvent(6, respondPlan(), false),
      turnStartedEvent(7, 'answer', 'turn-1'),
      deliveryCommittedEvent(8, 'fully-delivered'),
    ])

    expect(state.selection.stage).toBe('delivered')
    expect(state.selection.acceptedInputs).toHaveLength(1)
    expect(state.selection.acceptedInputs[0]).toMatchObject({
      eventId: 'event-a',
      seq: 5,
      text: 'hello captain',
      source: 'cohost-text',
    })
    expect(state.selection.plan).toMatchObject({
      seq: 6,
      disposition: 'respond',
      selectedEventIds: ['event-a'],
      replyIntent: 'answer',
      reasonCode: 'provider-answered',
      synthetic: false,
    })
    expect(state.selection.replyIntent).toMatchObject({ turnId: 'turn-1', replyIntent: 'answer' })
    // Delivery is labelled as server evidence and kept separate from local receipts.
    expect(state.selection.serverDelivery).toMatchObject({
      seq: 8,
      outputId: 'output-a',
      turnId: 'turn-1',
      segmentId: 'segment-1',
      classification: 'fully-delivered',
    })
    expect(
      deliveryClassificationSchema.safeParse(state.selection.serverDelivery?.classification).success,
    ).toBe(true)
    expect(state.playback.receipts).toEqual([])
  })

  it('projects the real minimal turn and delivery payloads without inventing identity', () => {
    // The runtime publishes the stored event payload only: `turn.started`
    // carries `{ replyIntent }` and `delivery.committed` carries
    // `{ classification }`, with no durable identity on the application wire.
    const turnMinimal = serverMessageSchema.parse({
      protocolVersion: '0.2',
      messageId: 'm-turn-minimal',
      sessionId: SESSION,
      epoch: PIPELINE_EPOCH,
      kind: 'session.event',
      payload: { seq: 7, type: 'turn.started', data: { replyIntent: 'answer' } },
    })
    const deliveryMinimal = serverMessageSchema.parse({
      protocolVersion: '0.2',
      messageId: 'm-delivery-minimal',
      sessionId: SESSION,
      epoch: PIPELINE_EPOCH,
      kind: 'session.event',
      payload: { seq: 8, type: 'delivery.committed', data: { classification: 'fully-delivered' } },
    })

    const base = reduceAll(opened(), [
      inputAcceptedEvent(5, 'event-a', 'hello captain'),
      selectionPlanEvent(6, respondPlan(), false),
    ])

    const speaking = reduceServerMessage(base, turnMinimal)
    expect(speaking.selection.stage).toBe('speaking')
    expect(speaking.selection.replyIntent?.replyIntent).toBe('answer')
    expect(speaking.selection.replyIntent?.turnId).toBeNull()

    const delivered = reduceServerMessage(speaking, deliveryMinimal)
    expect(delivered.selection.stage).toBe('delivered')
    expect(delivered.selection.serverDelivery?.classification).toBe('fully-delivered')
    expect(delivered.selection.serverDelivery?.outputId).toBeNull()
    expect(delivered.selection.serverDelivery?.turnId).toBeNull()
    expect(delivered.selection.serverDelivery?.segmentId).toBeNull()
  })

  it('still accepts a reported identity in the event data for forward compatibility', () => {
    const state = reduceAll(opened(), [
      turnStartedEvent(7, 'answer', 'turn-reported'),
      deliveryCommittedEvent(8, 'fully-delivered', {
        outputId: 'output-reported',
        turnId: 'turn-reported',
        segmentId: 'segment-reported',
      }),
    ])

    expect(state.selection.stage).toBe('delivered')
    expect(state.selection.replyIntent?.turnId).toBe('turn-reported')
    expect(state.selection.serverDelivery).toMatchObject({
      outputId: 'output-reported',
      turnId: 'turn-reported',
      segmentId: 'segment-reported',
      classification: 'fully-delivered',
    })
  })

  it('walks the waiting stages from awaiting-selection to delivered', () => {
    let state = opened()
    state = reduceServerMessage(state, inputAcceptedEvent(5, 'event-a', 'hello'))
    expect(state.selection.stage).toBe('awaiting-selection')
    state = reduceServerMessage(state, selectionPlanEvent(6, respondPlan()))
    expect(state.selection.stage).toBe('selected')
    state = reduceServerMessage(state, turnStartedEvent(7))
    expect(state.selection.stage).toBe('speaking')
    state = reduceServerMessage(state, deliveryCommittedEvent(8))
    expect(state.selection.stage).toBe('delivered')
  })

  it('resolves the selected text from the accepted input without inventing any', () => {
    const state = reduceAll(opened(), [
      inputAcceptedEvent(5, 'event-a', 'the real text'),
      selectionPlanEvent(6, respondPlan('selection-1', 'event-a')),
    ])
    const selectedId = state.selection.plan?.selectedEventIds[0]
    const selectedInput = state.selection.acceptedInputs.find((entry) => entry.eventId === selectedId)
    expect(selectedInput?.text).toBe('the real text')
  })

  it('projects a deferred plan with no invented selected text', () => {
    const state = reduceAll(opened(), [
      inputAcceptedEvent(5, 'event-a', 'hello'),
      selectionPlanEvent(6, deferPlan()),
    ])
    expect(state.selection.stage).toBe('deferred')
    expect(state.selection.plan).toMatchObject({
      disposition: 'defer',
      selectedEventIds: [],
      replyIntent: null,
      reasonCode: 'provider-deferred',
    })
    // No selected text is fabricated for a defer.
    expect(state.selection.plan?.selectedEventIds).toEqual([])
  })

  it('leaves state unchanged for a malformed plan, reply intent or classification', () => {
    const base = reduceAll(opened(), [
      inputAcceptedEvent(5, 'event-a', 'hello'),
      selectionPlanEvent(6, respondPlan()),
    ])

    // A malformed plan payload is ignored; only the raw event log advances.
    const badPlan = reduceServerMessage(base, selectionPlanEvent(7, { disposition: 'respond' }))
    expect(badPlan.selection).toEqual(base.selection)

    // A malformed turn.started reply intent is ignored.
    const badIntent = reduceServerMessage(base, turnStartedEvent(7, 'not-an-intent'))
    expect(badIntent.selection).toEqual(base.selection)

    // A malformed delivery classification is ignored.
    const badDelivery = reduceServerMessage(base, deliveryCommittedEvent(8, 'made-up'))
    expect(badDelivery.selection).toEqual(base.selection)
  })

  it('ignores a plan and pipeline event from another session or epoch', () => {
    const base = reduceAll(opened(), [inputAcceptedEvent(5, 'event-a', 'hello')])

    const foreignSession = serverMessageSchema.parse({
      protocolVersion: '0.2',
      messageId: 'm-foreign',
      sessionId: 'session-other',
      epoch: PIPELINE_EPOCH,
      kind: 'session.event',
      payload: { seq: 6, type: 'selection.plan', data: { plan: respondPlan(), synthetic: false } },
    })
    // Another session is fenced out before projection.
    expect(reduceServerMessage(base, foreignSession)).toEqual(base)

    // A plan whose payload names a different epoch is malformed for this view.
    const foreignEpoch = selectionPlanEvent(
      6,
      { ...respondPlan(), epoch: PIPELINE_EPOCH + 1 },
      false,
    )
    expect(reduceServerMessage(base, foreignEpoch).selection).toEqual(base.selection)

    // A turn.started with a mismatched input event id is ignored.
    const mismatchedInput = inputAcceptedEvent(6, 'event-b', 'second', {
      eventId: 'event-a',
    })
    // The reused id does not create a duplicate acceptance.
    const afterDuplicate = reduceServerMessage(
      reduceAll(opened(), [inputAcceptedEvent(5, 'event-a', 'hello')]),
      mismatchedInput,
    )
    expect(afterDuplicate.selection.acceptedInputs).toHaveLength(1)
  })

  it('keeps the plan visible for audit when a newer accepted input supersedes it', () => {
    const state = reduceAll(opened(), [
      inputAcceptedEvent(5, 'event-a', 'first'),
      selectionPlanEvent(6, respondPlan('selection-1', 'event-a')),
      inputAcceptedEvent(7, 'event-b', 'second'),
    ])
    // A newer input reopens selection while the old plan stays visible.
    expect(state.selection.stage).toBe('awaiting-selection')
    expect(state.selection.plan).toMatchObject({ seq: 6, selectedEventIds: ['event-a'] })
    expect(state.selection.acceptedInputs.map((entry) => entry.eventId)).toEqual(['event-a', 'event-b'])
  })

  it('never replaces a newer plan with an older one', () => {
    const state = reduceAll(opened(), [
      inputAcceptedEvent(5, 'event-a', 'first'),
      selectionPlanEvent(6, respondPlan('selection-1', 'event-a')),
      selectionPlanEvent(8, deferPlan('selection-2')),
      selectionPlanEvent(7, respondPlan('selection-3', 'event-a')),
    ])
    expect(state.selection.plan).toMatchObject({ seq: 8, disposition: 'defer' })
  })
})

describe('C1 waiting stage from control and lifecycle', () => {
  it('enters stopped on an applied stop ack; only retirement blocks dispatch', () => {
    const state = reduceServerMessage(opened(), stoppedControlAck(2, 'stop', 'applied'))
    expect(state.selection.stage).toBe('stopped')
    expect(state.session?.lifecycle).toBe('stopped')
    // A stopped session stays dispatchable so the operator can Resume it. A
    // retiring session, in contrast, blocks dispatch.
    expect(canDispatch(state)).toBe(true)
    expect(canDispatch(reduceApplicationMessage(state, recoveryState(2, true)))).toBe(false)
  })

  it('enters stopped on a duplicate stop ack as well', () => {
    const state = reduceServerMessage(opened(), stoppedControlAck(2, 'stop', 'duplicate'))
    expect(state.selection.stage).toBe('stopped')
  })

  it('resumes to idle when no accepted input is newer than the last plan', () => {
    let state = reduceServerMessage(opened(), inputAcceptedEvent(5, 'event-a', 'hello'))
    state = reduceServerMessage(state, selectionPlanEvent(6, respondPlan()))
    state = reduceServerMessage(state, stoppedControlAck(2, 'stop', 'applied'))
    expect(state.selection.stage).toBe('stopped')

    state = reduceServerMessage(state, stoppedControlAck(3, 'resume', 'applied'))
    // The plan is still the newest evidence for the accepted input, so the
    // console shows the selected stage, not idle.
    expect(state.selection.stage).toBe('selected')
  })

  it('resumes to awaiting-selection when an accepted input is newer than the last plan', () => {
    let state = reduceServerMessage(opened(), inputAcceptedEvent(5, 'event-a', 'hello'))
    state = reduceServerMessage(state, selectionPlanEvent(6, respondPlan()))
    state = reduceServerMessage(state, inputAcceptedEvent(7, 'event-b', 'newer'))
    state = reduceServerMessage(state, stoppedControlAck(2, 'stop', 'applied'))
    state = reduceServerMessage(state, stoppedControlAck(3, 'resume', 'applied'))
    expect(state.selection.stage).toBe('awaiting-selection')
  })

  it('resumes to idle when there is no input at all', () => {
    let state = reduceServerMessage(opened(), stoppedControlAck(2, 'stop', 'applied'))
    state = reduceServerMessage(state, stoppedControlAck(3, 'resume', 'applied'))
    expect(state.selection.stage).toBe('idle')
  })

  it('stops and un-stops the waiting stage from a snapshot', () => {
    let state = reduceServerMessage(opened(), inputAcceptedEvent(5, 'event-a', 'hello'))
    state = reduceServerMessage(state, serverMessageSchema.parse(snapshotWith(2, 10, { lifecycle: 'stopped' })))
    expect(state.selection.stage).toBe('stopped')

    state = reduceServerMessage(state, serverMessageSchema.parse(snapshotWith(3, 11, { lifecycle: 'running' })))
    // Leaving stopped is decided by the input-versus-plan evidence, so a
    // still-unplanned accepted input returns to awaiting-selection.
    expect(state.selection.stage).toBe('awaiting-selection')
  })
})

describe('C1 retirement state', () => {
  it('blocks dispatch while retiring, without inferring it from lifecycle', () => {
    let state = opened()
    expect(canDispatch(state)).toBe(true)
    // A stopped lifecycle alone does not block dispatch in this projection.
    state = reduceServerMessage(state, stoppedControlAck(2, 'stop', 'applied'))
    expect(canDispatch(state)).toBe(true)

    state = reduceApplicationMessage(state, recoveryState(2, true))
    expect(state.session?.retiring).toBe(true)
    expect(canDispatch(state)).toBe(false)

    state = reduceApplicationMessage(state, recoveryState(2, false))
    expect(state.session?.retiring).toBe(false)
    expect(canDispatch(state)).toBe(true)
  })

  it('starts a successor session non-retiring on its snapshot', () => {
    let state = reduceApplicationMessage(opened(), recoveryState(1, true))
    expect(state.session?.retiring).toBe(true)

    const successor = reduceServerMessage(
      state,
      serverMessageSchema.parse({
        ...snapshotWith(1, 0, { lifecycle: 'stopped' }),
        sessionId: 'session-successor',
      }),
    )
    expect(successor.session?.sessionId).toBe('session-successor')
    expect(successor.session?.retiring).toBe(false)
  })

  it('ignores a stale retirement frame for an older epoch', () => {
    // Advance the accepted epoch so a lower-epoch frame is genuinely stale.
    let state = reduceServerMessage(opened(), stoppedControlAck(2, 'stop', 'applied'))
    expect(state.session?.epoch).toBe(2)
    state = reduceApplicationMessage(state, recoveryState(2, false))
    expect(state.session?.retiring).toBe(false)

    // A frame for the current session at an older epoch never regresses.
    const stale = reduceApplicationMessage(state, recoveryState(1, true))
    expect(stale.session?.retiring).toBe(false)
    expect(stale).toEqual(state)
  })

  it('leaves the view unchanged for base and other application messages', () => {
    const base = opened()
    const baseEvent = sessionEvent(6)
    expect(reduceApplicationMessage(base, baseEvent).events.map((entry) => entry.seq)).toEqual([6])

    const attachAck = applicationServerMessageSchema.parse({
      protocolVersion: '0.2',
      messageId: 'm-attach-ack',
      sessionId: SESSION,
      epoch: 1,
      kind: 'session.attach.ack',
      payload: { connectionId: 'conn-1', performer: true },
    })
    expect(reduceApplicationMessage(base, attachAck)).toEqual(base)
  })
})

/* ------------------------------------------------------------------ *
 * M2-01 session C2: the runtime audio resolver, the machine transport
 * adapter and the bootstrap snapshot conversion. The fetch is injected,
 * so no network is touched and no DOM is used.
 * ------------------------------------------------------------------ */

import {
  createRuntimeAudioResolver,
  RUNTIME_AUDIO_FETCH_HEADER,
  RUNTIME_AUDIO_PATH,
} from '../../src/console/runtime-audio-resolver'
import {
  createMachineTransport,
  snapshotMessageFromBootstrap,
} from '../../src/console/performer-adapter'
import { AUDIO_FETCH_HEADER, AUDIO_PATH } from '../../src/runtime/config'

interface RecordedAudioFetch {
  readonly calls: Array<{ input: string; init: RequestInit }>
}

function audioFetch(response: () => Promise<Response>): {
  fetchImpl: typeof fetch
  recorded: RecordedAudioFetch
} {
  const recorded: RecordedAudioFetch = { calls: [] }
  const fetchImpl = ((input: string, init: RequestInit) => {
    recorded.calls.push({ input, init })
    return response()
  }) as unknown as typeof fetch
  return { fetchImpl, recorded }
}

function audioResponse(status = 200): Response {
  return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' }), { status })
}

async function resolverFailure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  )
}

describe('runtime audio resolver', () => {
  it('posts one encoded ref to the documented path with the required header and no body', async () => {
    const { fetchImpl, recorded } = audioFetch(() => Promise.resolve(audioResponse()))
    const resolver = createRuntimeAudioResolver({ fetchImpl })
    const controller = new AbortController()

    const lease = await resolver.resolve('audio://fixture/segment 0&x=1', controller.signal)

    expect(recorded.calls).toHaveLength(1)
    const call = recorded.calls[0]!
    expect(call.init.method).toBe('POST')
    expect(call.init.credentials).toBe('same-origin')
    expect(call.init.body).toBeUndefined()
    expect(call.init.signal).toBe(controller.signal)
    const headers = call.init.headers as Record<string, string>
    expect(headers[RUNTIME_AUDIO_FETCH_HEADER]).toBe('1')
    expect(headers.accept).toBe('audio/*')

    // The reference is only ever a single encoded query value: it never becomes
    // a path segment or a filename.
    const url = new URL(call.input, 'http://console.test')
    expect(url.pathname).toBe(RUNTIME_AUDIO_PATH)
    expect(url.searchParams.getAll('ref')).toEqual(['audio://fixture/segment 0&x=1'])
    expect(call.input.startsWith(`${RUNTIME_AUDIO_PATH}?ref=`)).toBe(true)
    expect(call.input).not.toContain('audio://fixture/segment 0&x=1')

    expect(lease.blob.size).toBe(3)
    expect(() => lease.release()).not.toThrow()
  })

  it('keeps the audio path in a single query param for a path-like reference', async () => {
    const { fetchImpl, recorded } = audioFetch(() => Promise.resolve(audioResponse()))
    const resolver = createRuntimeAudioResolver({ fetchImpl })

    await resolver.resolve('../etc/passwd?ref=other', new AbortController().signal)

    const call = recorded.calls[0]!
    const url = new URL(call.input, 'http://console.test')
    expect(url.pathname).toBe(RUNTIME_AUDIO_PATH)
    expect(url.searchParams.getAll('ref')).toEqual(['../etc/passwd?ref=other'])
  })

  it('rejects an empty reference locally without fetching', async () => {
    const { fetchImpl, recorded } = audioFetch(() => Promise.resolve(audioResponse()))
    const resolver = createRuntimeAudioResolver({ fetchImpl })

    const error = await resolverFailure(resolver.resolve('', new AbortController().signal))
    expect(error).toBeInstanceOf(Error)
    expect(recorded.calls).toEqual([])
  })

  it('reports a non-2xx status without leaking the response body', async () => {
    const secret = 'secret-body-must-not-leak'
    const { fetchImpl } = audioFetch(() =>
      Promise.resolve(
        new Response(secret, { status: 403, headers: { 'content-type': 'text/plain' } }),
      ),
    )
    const resolver = createRuntimeAudioResolver({ fetchImpl })

    const error = await resolverFailure(resolver.resolve('audio://fixture/x', new AbortController().signal))
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('403')
    expect((error as Error).message).not.toContain(secret)
  })

  it('propagates a network failure and an aborted fetch as-is', async () => {
    const offline = audioFetch(() => Promise.reject(new Error('socket hang up')))
    const offlineError = await resolverFailure(
      createRuntimeAudioResolver({ fetchImpl: offline.fetchImpl }).resolve(
        'audio://fixture/x',
        new AbortController().signal,
      ),
    )
    expect(offlineError).toBeInstanceOf(Error)
    expect((offlineError as Error).message).toBe('socket hang up')
    expect(offlineError).not.toBeInstanceOf(Response)

    const controller = new AbortController()
    const abortError = new DOMException('The operation was aborted.', 'AbortError')
    const aborted = audioFetch(
      () =>
        new Promise<Response>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(abortError))
        }),
    )
    const pending = createRuntimeAudioResolver({ fetchImpl: aborted.fetchImpl }).resolve(
      'audio://fixture/x',
      controller.signal,
    )
    controller.abort()
    const error = await resolverFailure(pending)
    expect(error).toBe(abortError)
    expect((error as Error).name).toBe('AbortError')
  })

  it('keeps the browser constants at parity with the runtime route configuration', () => {
    expect(RUNTIME_AUDIO_PATH).toBe(AUDIO_PATH)
    expect(RUNTIME_AUDIO_FETCH_HEADER).toBe(AUDIO_FETCH_HEADER)
  })
})

/* ------------------------------------------------------------------ *
 * Performer adapter: the machine transport bridge and the bootstrap
 * snapshot conversion.
 * ------------------------------------------------------------------ */

function validAttachRaw(): string {
  return JSON.stringify({
    protocolVersion: '0.2',
    messageId: 'm-attach',
    sessionId: SESSION,
    epoch: 1,
    kind: 'session.attach',
    payload: {},
  })
}

describe('performer adapter', () => {
  it('forwards a valid raw machine frame exactly once through sendApplication', () => {
    const sent: ApplicationClientMessage[] = []
    const base = createFixtureConsoleTransport(createBootstrapOnlyRuntime())
    const application = {
      ...base,
      sendApplication: (message: ApplicationClientMessage) => {
        sent.push(message)
      },
      onApplicationMessage: () => () => {},
    }

    createMachineTransport(application).send(validAttachRaw())

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ kind: 'session.attach', messageId: 'm-attach' })
    // The forwarded frame already round-tripped through the shared client schema.
    expect(applicationClientMessageSchema.safeParse(sent[0]).success).toBe(true)
  })

  it('refuses an invalid frame without writing anything', () => {
    const sent: ApplicationClientMessage[] = []
    const base = createFixtureConsoleTransport(createBootstrapOnlyRuntime())
    const application = {
      ...base,
      sendApplication: (message: ApplicationClientMessage) => {
        sent.push(message)
      },
      onApplicationMessage: () => () => {},
    }
    const machineTransport = createMachineTransport(application)

    expect(() => machineTransport.send('{ not json')).toThrowError(/^invalid application client message: /)
    expect(() =>
      machineTransport.send(
        JSON.stringify({
          protocolVersion: '0.2',
          messageId: '',
          sessionId: SESSION,
          epoch: 1,
          kind: 'session.attach',
          payload: {},
        }),
      ),
    ).toThrowError(/^invalid application client message: /)
    expect(sent).toEqual([])
  })

  it('converts a flat bootstrap snapshot into a valid session.snapshot message', () => {
    const source = bootstrapSnapshotSchema.parse({
      protocolVersion: '0.2',
      messageId: 'm-bootstrap-convert',
      sessionId: SESSION,
      epoch: 3,
      seq: 17,
      lifecycle: 'stopped',
      activeTurnId: 'turn-convert',
      performerStatus: 'busy',
      outputConfirmation: 'pending',
      capabilityRevision: 4,
    })

    const message = snapshotMessageFromBootstrap(source)
    expect(applicationServerMessageSchema.safeParse(message).success).toBe(true)
    expect(message).toEqual({
      protocolVersion: '0.2',
      messageId: 'm-bootstrap-convert',
      sessionId: SESSION,
      epoch: 3,
      kind: 'session.snapshot',
      payload: {
        lifecycle: 'stopped',
        activeTurnId: 'turn-convert',
        performerStatus: 'busy',
        outputConfirmation: 'pending',
        capabilityRevision: 4,
        lastSeq: 17,
      },
    })
  })
})

/* ------------------------------------------------------------------ *
 * C3 batch-input fixture. A server substitute builds the whole batch from
 * the shared schemas; the console projection is exercised through the real
 * application reducer. Fixture clock values are not delivery evidence.
 * ------------------------------------------------------------------ */

import { createBatchInputScenario, selectionPlanMessage } from '../support/m2-batch-input'
import {
  createPlaybackBinding as createBatchPlaybackBinding,
  type PlaybackBinding as BatchPlaybackBinding,
  type PlaybackCallbacks as BatchPlaybackCallbacks,
} from '../../src/console/player-binding'

function reduceBatch(
  state: ConsoleState,
  messages: readonly ApplicationServerMessage[],
): ConsoleState {
  return messages.reduce((current, message) => reduceApplicationMessage(current, message), state)
}

function openedWithLastSeq(lastSeq: number): ConsoleState {
  return withBootstrap(
    createInitialConsoleState(),
    bootstrapSnapshotSchema.parse({
      protocolVersion: '0.2',
      messageId: 'm-bootstrap-batch',
      sessionId: SESSION,
      epoch: PIPELINE_EPOCH,
      seq: lastSeq,
      lifecycle: 'running',
      activeTurnId: null,
      performerStatus: 'idle',
      outputConfirmation: 'confirmed',
      capabilityRevision: 1,
    }),
  )
}

describe('C3 batch-input fixture and projection', () => {
  it('accepts a three-input batch in order and resolves the selected text from the batch', () => {
    const scenario = createBatchInputScenario({
      sessionId: SESSION,
      epoch: PIPELINE_EPOCH,
      startSeq: 4,
    })
    expect(scenario.inputs).toHaveLength(3)

    let state = openedWithLastSeq(4)
    for (const acknowledgement of scenario.acknowledgements) {
      state = reduceApplicationMessage(state, serverMessageSchema.parse(inputAckMessage(acknowledgement)))
    }
    state = reduceBatch(state, scenario.events)

    // Every accepted input is present, oldest to newest, with its own text.
    const accepted = state.selection.acceptedInputs
    expect(accepted.map((entry) => entry.text)).toEqual(
      scenario.inputs.map((input) => input.text),
    )
    expect(accepted.map((entry) => entry.source)).toEqual(
      scenario.inputs.map((input) => input.source),
    )
    expect(accepted.map((entry) => entry.eventId)).toEqual(
      scenario.inputs.map((input) => input.eventId),
    )

    // The plan selects the configured (second) input; the text is that input's
    // accepted text, never invented by the fixture scenario.
    expect(state.selection.plan?.selectedEventIds).toEqual([scenario.selectedInput.eventId])
    const selectedId = state.selection.plan?.selectedEventIds[0]
    const selected = accepted.find((entry) => entry.eventId === selectedId)
    expect(selected?.text).toBe(scenario.selectedInput.text)
    expect(scenario.selectedInput.eventId).toBe(scenario.inputs[1]!.eventId)
  })

  it('walks the batch waiting stages and exposes intent, turn and delivery', () => {
    const scenario = createBatchInputScenario({
      sessionId: SESSION,
      epoch: PIPELINE_EPOCH,
      startSeq: 4,
    })
    const [firstAccepted, , thirdAccepted, plan, turn, delivery] = [
      scenario.events[0]!,
      scenario.events[1]!,
      scenario.events[2]!,
      scenario.events[3]!,
      scenario.events[4]!,
      scenario.events[5]!,
    ]

    let state = reduceApplicationMessage(openedWithLastSeq(4), firstAccepted)
    state = reduceApplicationMessage(state, scenario.events[1]!)
    expect(state.selection.stage).toBe('awaiting-selection')
    state = reduceApplicationMessage(state, thirdAccepted)
    expect(state.selection.stage).toBe('awaiting-selection')

    state = reduceApplicationMessage(state, plan)
    expect(state.selection.stage).toBe('selected')
    expect(state.selection.plan?.disposition).toBe('respond')
    expect(state.selection.plan?.synthetic).toBe(false)
    expect(state.selection.plan?.replyIntent).toBe('answer')

    state = reduceApplicationMessage(state, turn)
    expect(state.selection.stage).toBe('speaking')
    // The runtime wire carries the stored event payload only, so the durable
    // turn identity is unreported rather than fabricated.
    expect(state.selection.replyIntent?.turnId).toBeNull()
    expect(state.selection.replyIntent?.replyIntent).toBe('answer')

    state = reduceApplicationMessage(state, delivery)
    expect(state.selection.stage).toBe('delivered')
    expect(state.selection.serverDelivery).toMatchObject({
      outputId: null,
      turnId: null,
      segmentId: null,
      classification: 'fully-delivered',
    })
    expect(state.session?.lastSeq).toBe(scenario.events[scenario.events.length - 1]!.payload.seq)
  })

  it('leaves a deferred plan deferred, shows no selected text and ignores a malformed plan', () => {
    const scenario = createBatchInputScenario({
      sessionId: SESSION,
      epoch: PIPELINE_EPOCH,
      startSeq: 4,
    })
    const accepted = scenario.events.slice(0, 3)
    let state = reduceBatch(openedWithLastSeq(4), accepted)

    const deferSeq = scenario.events[scenario.events.length - 1]!.payload.seq + 1
    const deferMessage = selectionPlanMessage({
      sessionId: SESSION,
      epoch: PIPELINE_EPOCH,
      seq: deferSeq,
      synthetic: false,
      plan: selectionResultSchema.parse({
        requestId: 'fixture-batch-defer',
        sessionId: SESSION,
        epoch: PIPELINE_EPOCH,
        snapshotRevision: 1,
        disposition: 'defer',
        selectedEventIds: [],
        replyIntent: null,
        reasonCode: 'fixture-defer',
        provider: 'fixture-provider',
        modelVersion: 'fixture-model-v1',
        usage: {
          provider: 'fixture-provider',
          requestedModel: 'fixture-model-v1',
          resolvedModel: 'fixture-model-v1',
          requestId: 'fixture-batch-defer',
          inputTokens: 3,
          outputTokens: 0,
          usageMissing: false,
          elapsedMs: 2,
          status: 'ok',
          pricingRef: null,
        },
      }),
    })
    state = reduceApplicationMessage(state, deferMessage)
    expect(state.selection.stage).toBe('deferred')
    expect(state.selection.plan?.disposition).toBe('defer')
    expect(state.selection.plan?.selectedEventIds).toEqual([])
    expect(state.selection.plan?.replyIntent).toBeNull()

    const priorSelection = state.selection
    const malformed = serverMessageSchema.parse({
      protocolVersion: '0.2',
      messageId: 'fixture-batch-malformed-plan',
      sessionId: SESSION,
      epoch: PIPELINE_EPOCH,
      kind: 'session.event',
      payload: {
        seq: deferSeq + 1,
        type: 'selection.plan',
        data: { plan: { disposition: 'respond' }, synthetic: false },
      },
    })
    const afterMalformed = reduceApplicationMessage(state, malformed)
    // Only the raw event log advances; the projection is untouched.
    expect(afterMalformed.selection).toEqual(priorSelection)
  })

  it('validates every fixture message and never duplicates accepted inputs on replay', () => {
    const scenario = createBatchInputScenario({
      sessionId: SESSION,
      epoch: PIPELINE_EPOCH,
      startSeq: 4,
    })

    for (const message of scenario.messages) {
      expect(inputSubmitMessageSchema.safeParse(message).success).toBe(true)
    }
    for (const event of scenario.events) {
      expect(applicationServerMessageSchema.safeParse(event).success).toBe(true)
    }
    for (const acknowledgement of scenario.acknowledgements) {
      expect(inputAckSchema.safeParse(acknowledgement).success).toBe(true)
    }

    // Sequence values are unique and strictly increasing from startSeq + 1.
    const seqs = scenario.events.map((event) => event.payload.seq)
    expect(seqs).toEqual([5, 6, 7, 8, 9, 10])
    const ids = scenario.events.map((event) => event.messageId)
    expect(new Set(ids).size).toBe(ids.length)

    const full = reduceBatch(openedWithLastSeq(4), scenario.events)
    expect(full.selection.acceptedInputs).toHaveLength(3)

    // Re-feeding the accepted-input events is a no-op below the accepted frontier.
    const replay = reduceBatch(full, scenario.events.filter((event) => event.payload.type === 'input.accepted'))
    expect(replay.selection.acceptedInputs).toHaveLength(3)
    expect(replay.selection).toEqual(full.selection)
  })
})

describe('C3 batch delivery versus local receipts', () => {
  it('keeps local playback receipts separate from the server-confirmed delivery', async () => {
    const resolver = createControlledResolver()
    resolver.setAutoResolve()
    const media = createControlledMediaDriver()
    const receipts: PerformanceReceipt[] = []
    const callbacks: BatchPlaybackCallbacks = {
      onReceipt: (receipt) => receipts.push(receipt),
      onStatus: () => {},
      onSubtitle: () => {},
      onFault: () => {},
    }
    const binding: BatchPlaybackBinding = createBatchPlaybackBinding({
      bootstrap: bootstrap(),
      resolver,
      media,
      newReceiptId: () => 'batch-console-receipt',
      localNowMs: () => 20,
      ...callbacks,
    })

    const scenario = createBatchInputScenario({
      sessionId: SESSION,
      epoch: PIPELINE_EPOCH,
      startSeq: 4,
    })
    const state = reduceBatch(openedWithLastSeq(4), scenario.events)

    // The fixture delivery is server evidence in the selection view.
    expect(state.selection.serverDelivery?.classification).toBe('fully-delivered')
    // It is never stored as a local receipt by the projection.
    expect(state.playback.receipts).toEqual([])

    // A local performance command records a receipt, which stays local evidence.
    const command = fixturePerformanceCommand()
    binding.handleServerMessage(
      serverMessageSchema.parse({
        protocolVersion: '0.2',
        messageId: 'm-batch-execute',
        sessionId: command.sessionId,
        epoch: command.epoch,
        kind: 'performance.execute',
        payload: command,
      }),
    )
    await waitFor(() => receipts.length > 0)

    const recorded = withReceipt(state, receipts[0]!)
    expect(recorded.playback.receipts).toHaveLength(1)
    // The server-confirmed delivery is unchanged and not replaced by the receipt.
    expect(recorded.selection.serverDelivery).toEqual(state.selection.serverDelivery)
    binding.dispose()
  })
})

/* ------------------------------------------------------------------ *
 * C3 acknowledgement sequencing. The runtime acknowledges an input before it
 * publishes the matching `input.accepted` event at the same sequence, so the
 * acknowledgement must settle only its request view and never advance the
 * accepted event sequence.
 * ------------------------------------------------------------------ */

describe('C3 accepted acknowledgement does not hide its event', () => {
  it('applies the input.accepted event at the acknowledged sequence once', () => {
    const scenario = createBatchInputScenario({
      sessionId: SESSION,
      epoch: PIPELINE_EPOCH,
      startSeq: 4,
    })
    const acknowledgement = scenario.acknowledgements[1]!
    const accepted = scenario.events[1]!
    if (accepted.payload.type !== 'input.accepted') {
      throw new Error('expected an accepted-input event at the acknowledged sequence')
    }

    // Seed the request, then correlate the acknowledgement first exactly as the
    // runtime delivers it.
    let state = withPendingInput(openedWithLastSeq(4), scenario.messages[1]!)
    expect(state.session?.lastSeq).toBe(4)

    state = reduceApplicationMessage(state, serverMessageSchema.parse(inputAckMessage(acknowledgement)))
    expect(state.inputs[0]?.outcome).toBe('accepted')
    // The acknowledgement itself never advances the accepted event sequence.
    expect(state.session?.lastSeq).toBe(4)

    state = reduceApplicationMessage(state, accepted)
    const acceptedInputs = state.selection.acceptedInputs
    expect(acceptedInputs).toHaveLength(1)
    expect(acceptedInputs[0]).toMatchObject({
      eventId: scenario.inputs[1]!.eventId,
      seq: accepted.payload.seq,
      text: scenario.inputs[1]!.text,
    })
    // The event itself advances the sequence, exactly once.
    expect(state.session?.lastSeq).toBe(accepted.payload.seq)
    if (acknowledgement.status === 'rejected') throw new Error('expected an accepted acknowledgement')
    expect(acknowledgement.seq).toBe(accepted.payload.seq)
  })
})

/* ------------------------------------------------------------------ *
 * Successor-session projection. A snapshot naming a different session
 * retires the previous identity: its selection, event log and still-pending
 * requests must not be projected under the new session.
 * ------------------------------------------------------------------ */

function successorSnapshot(sessionId: string, lastSeq: number): ServerMessage {
  return serverMessageSchema.parse({
    ...snapshotWith(PIPELINE_EPOCH, lastSeq, { activeTurnId: null, lifecycle: 'running' }),
    sessionId,
  })
}

function settledDelivery(): ConsoleState {
  return reduceAll(openedWithLastSeq(4), [
    inputAcceptedEvent(5, 'event-a', 'hello captain'),
    selectionPlanEvent(6, respondPlan()),
    turnStartedEvent(7, 'answer', 'turn-1'),
    deliveryCommittedEvent(8, 'fully-delivered'),
  ])
}

describe('successor session projection reset', () => {
  it('clears the retired selection and event log while the successor starts non-retiring', () => {
    const previous = settledDelivery()
    expect(previous.selection.acceptedInputs).toHaveLength(1)
    expect(previous.selection.plan).not.toBeNull()
    expect(previous.selection.replyIntent).not.toBeNull()
    expect(previous.selection.serverDelivery).not.toBeNull()
    expect(previous.events).toHaveLength(4)

    const successor = reduceServerMessage(previous, successorSnapshot('session-successor', 0))

    expect(successor.session?.sessionId).toBe('session-successor')
    expect(successor.session?.retiring).toBe(false)
    expect(successor.session?.lastSeq).toBe(0)
    expect(successor.selection).toEqual({
      stage: 'idle',
      acceptedInputs: [],
      plan: null,
      replyIntent: null,
      serverDelivery: null,
    })
    expect(successor.events).toEqual([])
  })

  it('preserves the selection and event log for a same-session snapshot at a newer sequence', () => {
    const previous = settledDelivery()
    const refreshed = reduceServerMessage(
      previous,
      serverMessageSchema.parse(snapshotWith(PIPELINE_EPOCH, 12, { lifecycle: 'running' })),
    )

    expect(refreshed.session?.sessionId).toBe(SESSION)
    expect(refreshed.session?.lastSeq).toBe(12)
    expect(refreshed.selection).toEqual(previous.selection)
    expect(refreshed.events).toEqual(previous.events)
  })

  it('marks pending requests unknown on a successor snapshot and keeps settled entries settled', () => {
    let state = withPendingInput(opened(), inputSubmit('req-pending'))
    state = reduceInputAck(
      state,
      inputAckSchema.parse({
        status: 'accepted',
        requestMessageId: 'req-pending',
        eventId: 'event-a',
        sessionId: SESSION,
        epoch: 1,
        seq: 5,
      }),
    )
    state = withPendingInput(state, { ...inputSubmit('req-outstanding'), messageId: 'req-outstanding' })
    state = withPendingControl(state, controlStop('control-settled'))
    state = reduceControlAck(state, {
      sessionId: SESSION,
      requestId: 'control-settled',
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
    state = withPendingControl(state, controlResume('control-outstanding'))

    const successor = reduceServerMessage(state, successorSnapshot('session-successor', 0))

    const settledInput = successor.inputs.find((view) => view.messageId === 'req-pending')
    expect(settledInput?.outcome).toBe('accepted')
    const outstandingInput = successor.inputs.find((view) => view.messageId === 'req-outstanding')
    expect(outstandingInput?.outcome).toBe('unknown')
    expect(outstandingInput?.detail).toBe('session changed before acknowledgement')

    const settledControl = successor.controls.find((view) => view.requestId === 'control-settled')
    expect(settledControl?.outcome).toBe('applied')
    const outstandingControl = successor.controls.find((view) => view.requestId === 'control-outstanding')
    expect(outstandingControl?.outcome).toBe('unknown')
    expect(outstandingControl?.detail).toBe('session changed before acknowledgement')
  })
})

/* ------------------------------------------------------------------ *
 * Recovery eligibility, disposal guards and the expiry observation.
 * ------------------------------------------------------------------ */

describe('console recovery eligibility', () => {
  const connectedMachine = {
    disposed: false,
    performer: true,
    operator: true,
    recovery: { status: 'idle' as const },
  }
  const connected = {
    connection: 'open' as const,
    hasSession: true,
    machine: connectedMachine,
    acknowledged: true,
  }

  it('allows the first explicitly acknowledged recovery request before retirement is reported', () => {
    // Retirement is not an input to this decision: the runtime starts retirement
    // only after the first valid session.recover, so requiring it here would
    // deadlock a connected current session.
    expect(recoveryControlView(connected)).toEqual({ available: true, requestable: true })
  })

  it('requires the explicit acknowledgement before the request is available', () => {
    expect(recoveryControlView({ ...connected, acknowledged: false })).toEqual({
      available: true,
      requestable: false,
    })
  })

  it('withdraws both controls when the transport is not open or no session is known', () => {
    expect(recoveryControlView({ ...connected, connection: 'closed' })).toEqual({
      available: false,
      requestable: false,
    })
    expect(recoveryControlView({ ...connected, hasSession: false })).toEqual({
      available: false,
      requestable: false,
    })
    expect(recoveryControlView({ ...connected, machine: null })).toEqual({
      available: false,
      requestable: false,
    })
  })

  it('withdraws both controls after disposal or without performer/operator authority', () => {
    expect(recoveryControlView({ ...connected, machine: { ...connectedMachine, disposed: true } })).toEqual({
      available: false,
      requestable: false,
    })
    expect(recoveryControlView({ ...connected, machine: { ...connectedMachine, performer: false } })).toEqual({
      available: false,
      requestable: false,
    })
    expect(recoveryControlView({ ...connected, machine: { ...connectedMachine, operator: false } })).toEqual({
      available: false,
      requestable: false,
    })
  })

  it('keeps an outstanding request from being sent twice', () => {
    expect(
      recoveryControlView({
        ...connected,
        machine: { ...connectedMachine, recovery: { status: 'requested' } },
      }),
    ).toEqual({ available: true, requestable: false })
  })
})

describe('console performer machine recovery guards', () => {
  it('ignores every outgoing request after disposal', () => {
    const { machine, frames } = createConsoleMachine()
    const sentBeforeDispose = frames.length
    machine.dispose('transport closed')

    expect(machine.state().disposed).toBe(true)
    machine.attach()
    machine.bootstrapOperator('one-time-token')
    expect(machine.input('late input')).toBeNull()
    expect(machine.resume()).toBeNull()
    expect(machine.stop()).toBeNull()
    expect(machine.recover()).toBeNull()

    expect(frames).toHaveLength(sentBeforeDispose)
    expect(machine.state().recovery.status).toBe('idle')
  })

  it('does not mark recovery requested when the transport rejects the send', () => {
    let open = true
    const sent: string[] = []
    const transport: PerformerTransport = {
      send(raw) {
        if (!open) throw new Error('closed transport')
        sent.push(raw)
      },
    }
    const resolver = createControlledResolver()
    resolver.setAutoResolve()
    const machine = createPerformerMachine({
      transport,
      media: createControlledMediaDriver({ autoEvents: true }),
      resolver,
      receipts: createTestReceiptTools('closed-transport'),
      now: () => 5_000,
    })
    machine.handleMessage(machineSnapshotMessage(1))
    open = false

    expect(() => machine.recover()).toThrow('closed transport')
    expect(sent).toEqual([])
    expect(machine.state().recovery.status).toBe('idle')
    expect(machine.state().disposed).toBe(false)
    machine.dispose('test complete')
  })

  it('reports an expired offer through the local receipt hook as well as the wire', () => {
    const receipts: PerformanceReceipt[] = []
    const { machine, frames } = createConsoleMachine(undefined, {
      onReceipt: (receipt) => receipts.push(receipt),
    })
    const command = fixturePerformanceCommand({ outputId: 'output-console-expiry' })

    machine.handleMessage(machineOfferMessage(command))
    machine.handleMessage(machineGrantMessage(command, 0))

    const receiptFrame = frames.find((frame) => frame.message.kind === 'performance.receipt')
    expect(receiptFrame).toBeDefined()
    expect(receiptFrame?.message.payload).toMatchObject({
      outputId: command.outputId,
      stage: 'unknown',
      reasonCode: 'offer_expired',
      source: 'performer-machine',
    })
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toEqual(receiptFrame?.message.payload)
    machine.dispose('test complete')
  })
})
