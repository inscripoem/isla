import type {
  BootstrapSnapshot,
  ClientMessage,
  ConsoleTransportPort,
  ControlAck,
  ControlResumeMessage,
  ControlStopMessage,
  InputAck,
  InputSubmitMessage,
  ServerMessage,
} from '../contracts'
import { bootstrapSnapshotSchema, serverMessageSchema } from '../contracts'
import type { ConnectionStatus } from './console-state'

/**
 * Browser-safe application transport for the console (M2).
 *
 * It speaks the v0.2 wire protocol over the platform `WebSocket` — never the
 * Node `ws` package, so the console import graph stays browser-only. Every
 * inbound frame is validated with the shared server schema before it reaches a
 * listener, acknowledgements are correlated by `messageId`, and the bootstrap
 * snapshot is awaited rather than assumed. A timeout and a disconnect are
 * reported as distinct failures so the console can render honest uncertainty
 * instead of inferring state.
 */

/** Wait for the pushed bootstrap snapshot after the socket opens. */
export const BOOTSTRAP_TIMEOUT_MS = 5000
/** Wait for one request acknowledgement before giving up. */
export const ACK_TIMEOUT_MS = 15000

/** WebSocket `OPEN` readyState value, without depending on DOM globals. */
const SOCKET_OPEN = 1

export type TransportFailureReason = 'closed' | 'timeout' | 'invalid_message'

export class ConsoleTransportError extends Error {
  readonly reason: TransportFailureReason

  constructor(reason: TransportFailureReason, message: string) {
    super(message)
    this.name = 'ConsoleTransportError'
    this.reason = reason
  }
}

export interface SocketCloseInfo {
  readonly wasClean: boolean
  readonly code: number
}

/**
 * The minimal socket surface this transport needs. The platform `WebSocket` is
 * adapted to it, and a test double can implement it without any DOM.
 */
export interface TransportSocket {
  readyState(): number
  send(data: string): void
  close(code?: number, reason?: string): void
  onOpen(handler: () => void): void
  onClose(handler: (info: SocketCloseInfo) => void): void
  onError(handler: (detail: string) => void): void
  onMessage(handler: (data: string) => void): void
}

export interface AppTransportOptions {
  readonly url: string
  readonly bootstrapTimeoutMs?: number
  readonly ackTimeoutMs?: number
  readonly onStatus?: (connection: ConnectionStatus, detail: string | null) => void
  /** Called when an inbound frame is not a valid v0.2 server message. */
  readonly onProtocolViolation?: (detail: string) => void
  /** Injectable socket factory. The default adapts the platform `WebSocket`. */
  readonly createSocket?: (url: string) => TransportSocket
}

/** Adapt the platform WebSocket to the transport's minimal socket surface. */
export function adaptWebSocket(socket: WebSocket): TransportSocket {
  return {
    readyState: () => socket.readyState,
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    onOpen: (handler) => socket.addEventListener('open', () => handler()),
    onClose: (handler) =>
      socket.addEventListener('close', (event) => handler({ wasClean: event.wasClean, code: event.code })),
    onError: (handler) => socket.addEventListener('error', () => handler('application transport socket error')),
    onMessage: (handler) => socket.addEventListener('message', (event) => handler(String(event.data))),
  }
}

interface PendingInput {
  resolve: (ack: InputAck) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

interface PendingControl {
  resolve: (ack: ControlAck) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

interface BootstrapWaiter {
  resolve: (snapshot: BootstrapSnapshot) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

export function createAppTransport(options: AppTransportOptions): ConsoleTransportPort {
  const bootstrapTimeoutMs = options.bootstrapTimeoutMs ?? BOOTSTRAP_TIMEOUT_MS
  const ackTimeoutMs = options.ackTimeoutMs ?? ACK_TIMEOUT_MS
  const createSocket = options.createSocket ?? ((url: string) => adaptWebSocket(new WebSocket(url)))
  const listeners = new Set<(message: ServerMessage) => void>()
  const pendingInputs = new Map<string, PendingInput>()
  const pendingControls = new Map<string, PendingControl>()
  let socket: TransportSocket | null = null
  let closed = false
  let bootstrapWaiter: BootstrapWaiter | null = null

  const reportStatus = (connection: ConnectionStatus, detail: string | null = null): void => {
    try {
      options.onStatus?.(connection, detail)
    } catch {
      // Status reporting is best effort and must not disturb the transport.
    }
  }

  const reportViolation = (detail: string): void => {
    try {
      options.onProtocolViolation?.(detail)
    } catch {
      // Violation reporting is best effort and must not disturb the transport.
    }
  }

  /** Reject every outstanding wait exactly once, with a single cause. */
  const failOutstanding = (error: unknown): void => {
    for (const entry of pendingInputs.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pendingInputs.clear()
    for (const entry of pendingControls.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pendingControls.clear()
    const waiter = bootstrapWaiter
    if (waiter !== null) {
      bootstrapWaiter = null
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
  }

  const settleSnapshot = (message: ServerMessage & { kind: 'session.snapshot' }): void => {
    const waiter = bootstrapWaiter
    if (waiter === null) return
    bootstrapWaiter = null
    clearTimeout(waiter.timer)
    try {
      // A strict schema parse rejects a partial snapshot instead of patching it.
      waiter.resolve(
        bootstrapSnapshotSchema.parse({
          protocolVersion: message.protocolVersion,
          messageId: message.messageId,
          sessionId: message.sessionId,
          epoch: message.epoch,
          seq: message.payload.lastSeq,
          lifecycle: message.payload.lifecycle,
          activeTurnId: message.payload.activeTurnId,
          performerStatus: message.payload.performerStatus,
          outputConfirmation: message.payload.outputConfirmation,
          capabilityRevision: message.payload.capabilityRevision,
        }),
      )
    } catch (error) {
      waiter.reject(error)
    }
  }

  const settleInput = (ack: InputAck): void => {
    const entry = pendingInputs.get(ack.requestMessageId)
    if (entry === undefined) return
    pendingInputs.delete(ack.requestMessageId)
    clearTimeout(entry.timer)
    entry.resolve(ack)
  }

  const settleControl = (ack: ControlAck): void => {
    const entry = pendingControls.get(ack.requestMessageId)
    if (entry === undefined) return
    pendingControls.delete(ack.requestMessageId)
    clearTimeout(entry.timer)
    entry.resolve(ack)
  }

  const handleFrame = (raw: string): void => {
    let decoded: unknown
    try {
      decoded = JSON.parse(raw)
    } catch {
      reportViolation('inbound frame is not valid JSON')
      return
    }
    const result = serverMessageSchema.safeParse(decoded)
    if (!result.success) {
      reportViolation('inbound frame is not a valid v0.2 server message')
      return
    }
    const message = result.data
    for (const listener of [...listeners]) {
      try {
        listener(message)
      } catch {
        // One broken listener must not stop delivery to the others.
      }
    }
    if (message.kind === 'session.snapshot') settleSnapshot(message)
    if (message.kind === 'input.ack') settleInput(message.payload)
    if (message.kind === 'control.ack') settleControl(message.payload)
  }

  const openSocket = (): void => {
    if (socket !== null) return
    reportStatus('connecting')
    const created = createSocket(options.url)
    socket = created
    created.onOpen(() => reportStatus('open', null))
    created.onMessage(handleFrame)
    created.onError((detail) => reportStatus('error', detail))
    created.onClose((info) => {
      const detail = info.wasClean
        ? 'application transport closed'
        : `application transport closed unexpectedly (code ${info.code})`
      reportStatus('closed', detail)
      failOutstanding(new ConsoleTransportError('closed', detail))
    })
  }

  const requireOpen = (): TransportSocket => {
    if (socket === null) throw new ConsoleTransportError('closed', 'transport has not been opened')
    if (socket.readyState() !== SOCKET_OPEN) {
      throw new ConsoleTransportError('closed', 'transport socket is not open')
    }
    return socket
  }

  const bootstrap = (): Promise<BootstrapSnapshot> => {
    if (closed) return Promise.reject(new ConsoleTransportError('closed', 'transport is already closed'))
    if (bootstrapWaiter !== null) {
      return Promise.reject(new ConsoleTransportError('closed', 'bootstrap is already in flight'))
    }
    openSocket()
    return new Promise<BootstrapSnapshot>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (bootstrapWaiter !== null && bootstrapWaiter.timer === timer) bootstrapWaiter = null
        reject(new ConsoleTransportError('timeout', `no session snapshot arrived within ${bootstrapTimeoutMs} ms`))
      }, bootstrapTimeoutMs)
      bootstrapWaiter = { resolve, reject, timer }
    })
  }

  const sendInput = (message: InputSubmitMessage): Promise<InputAck> =>
    new Promise<InputAck>((resolve, reject) => {
      let target: TransportSocket
      try {
        target = requireOpen()
      } catch (error) {
        reject(error)
        return
      }
      const timer = setTimeout(() => {
        pendingInputs.delete(message.messageId)
        reject(
          new ConsoleTransportError(
            'timeout',
            `no input acknowledgement for ${message.messageId} within ${ackTimeoutMs} ms`,
          ),
        )
      }, ackTimeoutMs)
      pendingInputs.set(message.messageId, { resolve, reject, timer })
      try {
        target.send(JSON.stringify(message))
      } catch (error) {
        const entry = pendingInputs.get(message.messageId)
        if (entry !== undefined) {
          clearTimeout(entry.timer)
          pendingInputs.delete(message.messageId)
        }
        reject(error)
      }
    })

  const sendControl = (message: ControlStopMessage | ControlResumeMessage): Promise<ControlAck> =>
    new Promise<ControlAck>((resolve, reject) => {
      let target: TransportSocket
      try {
        target = requireOpen()
      } catch (error) {
        reject(error)
        return
      }
      const timer = setTimeout(() => {
        pendingControls.delete(message.messageId)
        reject(
          new ConsoleTransportError(
            'timeout',
            `no control acknowledgement for ${message.messageId} within ${ackTimeoutMs} ms`,
          ),
        )
      }, ackTimeoutMs)
      pendingControls.set(message.messageId, { resolve, reject, timer })
      try {
        target.send(JSON.stringify(message satisfies ClientMessage))
      } catch (error) {
        const entry = pendingControls.get(message.messageId)
        if (entry !== undefined) {
          clearTimeout(entry.timer)
          pendingControls.delete(message.messageId)
        }
        reject(error)
      }
    })

  const close = (): void => {
    closed = true
    failOutstanding(new ConsoleTransportError('closed', 'console closed the transport'))
    const current = socket
    socket = null
    if (current !== null) current.close(1000, 'console closing')
    reportStatus('closed', 'console closed the transport')
  }

  return {
    bootstrap,
    sendInput,
    sendControl,
    onServerMessage(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    close,
  }
}
