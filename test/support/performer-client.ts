import { WebSocket } from 'ws'
import type { PerformanceCommand, PerformanceReceipt } from '../../src/contracts'
import type { AudioResolver, MediaDriver, ReceiptTools } from '../../src/performance/browser/types'
import { createPerformerMachine } from '../browser/performer-machine'
import type { PerformerState } from '../browser/performer-machine'

/**
 * Node transport wrapper around the shared browser-safe performer state machine.
 *
 * All protocol behaviour (correlation, delayed-execution handshake, conservative
 * expiry, pending cleanup, detach-on-close) lives in
 * `test/browser/performer-machine.ts`; this module only supplies a Node
 * WebSocket transport and await helpers for the automated tests, so the tests
 * exercise the same actual browser logic the demo runs.
 */

type JsonObject = Record<string, unknown>

export interface PerformerClientOptions {
  url: string
  origin: string
  sessionId: string
  resolver: AudioResolver
  media: MediaDriver
  /** Deterministic receipt tools for tests; omitted to use the machine default. */
  receipts?: ReceiptTools
  now?: () => number
  beforeReady?: (command: PerformanceCommand) => Promise<void> | void
}

export interface PerformerClient {
  readonly snapshot: Promise<JsonObject>
  snapshotValue(): JsonObject | null
  attach(): Promise<JsonObject>
  bootstrapOperator(token: string): Promise<JsonObject>
  resume(): Promise<JsonObject>
  stop(): Promise<JsonObject>
  input(text: string, messageId?: string): Promise<JsonObject>
  /** Explicit operator recovery; resolves on the recovery ack or a correlated error. */
  recover(): Promise<JsonObject>
  state(): PerformerState
  events(): JsonObject[]
  receipts(): PerformanceReceipt[]
  errors(): JsonObject[]
  messages(): JsonObject[]
  /** Drops the socket; the machine detaches local work on the close event. */
  disconnect(): Promise<void>
  close(): Promise<void>
}

export function createPerformerClient(options: PerformerClientOptions): PerformerClient {
  const ws = new WebSocket(options.url, { origin: options.origin })
  const received: JsonObject[] = []
  const sessionEvents: JsonObject[] = []
  const errors: JsonObject[] = []
  const observed: PerformanceReceipt[] = []
  const waiters: Array<{ predicate: (message: JsonObject) => boolean; resolve: (message: JsonObject) => void }> = []
  let snapshotValue: JsonObject | null = null
  let resolveSnapshot: (value: JsonObject) => void = () => {}
  let rejectSnapshot: (error: unknown) => void = () => {}
  const snapshotPromise = new Promise<JsonObject>((resolve, reject) => {
    resolveSnapshot = resolve
    rejectSnapshot = reject
  })

  const machine = createPerformerMachine({
    transport: {
      send: (raw) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(raw)
      },
    },
    media: options.media,
    resolver: options.resolver,
    ...(options.receipts !== undefined ? { receipts: options.receipts } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.beforeReady !== undefined ? { beforeReady: options.beforeReady } : {}),
    hooks: {
      onReceipt: (receipt) => {
        observed.push(receipt)
      },
    },
  })

  const settleWaiters = (message: JsonObject): void => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index]
      if (waiter !== undefined && waiter.predicate(message)) {
        waiters.splice(index, 1)
        waiter.resolve(message)
      }
    }
  }

  const waitFor = (predicate: (message: JsonObject) => boolean, timeoutMs = 5000): Promise<JsonObject> =>
    new Promise<JsonObject>((resolve, reject) => {
      const waiter = { predicate, resolve }
      waiters.push(waiter)
      setTimeout(() => {
        const index = waiters.indexOf(waiter)
        if (index >= 0) {
          waiters.splice(index, 1)
          reject(new Error('performer client wait timed out'))
        }
      }, timeoutMs).unref?.()
    })

  ws.on('message', (data: Buffer) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(data.toString('utf8'))
    } catch {
      return
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
    const message = parsed as JsonObject
    received.push(message)
    if (message.kind === 'session.event') sessionEvents.push(message)
    if (message.kind === 'request.error') errors.push(message)
    if (message.kind === 'session.snapshot' && snapshotValue === null) {
      snapshotValue = message
      resolveSnapshot(message)
    }
    machine.handleMessage(message)
    settleWaiters(message)
  })

  ws.on('close', () => {
    machine.dispose('socket_closed')
  })
  ws.on('error', (error) => {
    machine.dispose('socket_error')
    rejectSnapshot(error)
  })

  const payloadOf = (message: JsonObject): JsonObject =>
    (typeof message.payload === 'object' && message.payload !== null ? message.payload : {}) as JsonObject

  return {
    snapshot: snapshotPromise,
    snapshotValue: () => snapshotValue,
    attach: async () => {
      machine.attach()
      return waitFor((message) => message.kind === 'session.attach.ack' || message.kind === 'request.error')
    },
    bootstrapOperator: async (token: string) => {
      machine.bootstrapOperator(token)
      return waitFor((message) => message.kind === 'operator.ack' || message.kind === 'request.error')
    },
    resume: async () => {
      const messageId = machine.resume()
      if (messageId === null) throw new Error('performer client has no session snapshot yet')
      return waitFor(
        (message) => message.kind === 'control.ack' && payloadOf(message).requestMessageId === messageId,
      )
    },
    stop: async () => {
      const messageId = machine.stop()
      if (messageId === null) throw new Error('performer client has no session snapshot yet')
      return waitFor(
        (message) => message.kind === 'control.ack' && payloadOf(message).requestMessageId === messageId,
      )
    },
    recover: async () => {
      const messageId = machine.recover()
      if (messageId === null) throw new Error('performer client has no session snapshot yet')
      return waitFor(
        (message) =>
          (message.kind === 'session.recovery.ack' &&
            payloadOf(message).requestMessageId === messageId) ||
          (message.kind === 'request.error' && payloadOf(message).requestId === messageId),
      )
    },
    state: () => machine.state(),
    input: async (text: string, messageId?: string) => {
      const id = machine.input(text, messageId)
      if (id === null) throw new Error('performer client has no session snapshot yet')
      return waitFor(
        (message) => message.kind === 'input.ack' && payloadOf(message).requestMessageId === id,
      )
    },
    events: () => sessionEvents.slice(),
    receipts: () => observed.slice(),
    errors: () => errors.slice(),
    messages: () => received.slice(),
    disconnect: async () => {
      await new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) {
          resolve()
          return
        }
        ws.once('close', () => resolve())
        ws.close()
      })
    },
    close: async () => {
      machine.dispose('client_closed')
      await new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) {
          resolve()
          return
        }
        ws.once('close', () => resolve())
        ws.close()
      })
    },
  }
}
