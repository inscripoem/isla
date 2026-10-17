import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { WebSocket } from 'ws'
import type { ClockPort, InputAck, ServerMessage, TrustedControlContext } from '../contracts'
import { controlAckToWire, inputAckToWire } from '../contracts'
import { isLoopbackHost } from './config'
import {
  APPLICATION_PATH,
  OPERATOR_BOOTSTRAP_HEADER,
  OPERATOR_BOOTSTRAP_PATH,
  operatorAckMessageSchema,
  parseApplicationClientMessage,
  requestError,
  sessionAttachAckMessageSchema,
} from '../contracts'
import type { RuntimeComposition } from './composition'
import type { PerformerBridgeMessage, TransportSendResult } from './performance-bridge'

/**
 * M5 application endpoint. It owns the browser-facing transport boundary:
 * exact-origin and loopback-host validation, server-owned connection roles, the
 * single active performer binding with a monotonic connection generation, an
 * explicit local operator bootstrap, and the response scheduler. It validates
 * every inbound protocol-0.2 message, converts acknowledgements to wire
 * envelopes and routes performer `ready`/receipt messages to the bridge. It
 * never infers authority from a payload.
 */

export interface ApplicationEndpointOptions {
  composition: RuntimeComposition
  clock: ClockPort
  /** Exact canonical origins permitted to open an application socket. */
  allowedOrigins: readonly string[]
  /** Exact allowed Host header values; when omitted, the host must be loopback. */
  allowedHosts?: readonly string[]
  operatorBootstrapTtlMs?: number
  maxConnections?: number
  maxSendBufferBytes?: number
  /** Concurrent non-control inbound messages allowed per connection. */
  maxInboundPerConnection?: number
  /**
   * Optional local sink for bounded application-internal failure records. It is
   * not a wire message and carries no error text, stack, cause, thrown-object
   * property, payload or frame. A throwing, rejecting, nonsettling or reentrant
   * sink is isolated and never awaited.
   */
  onDiagnostic?: (diagnostic: ApplicationDiagnostic) => void
}

type ApplicationDiagnosticOperation =
  | 'application.scheduler'
  | 'application.request'
  | 'application.snapshot'

/**
 * A bounded local diagnostic for an application-internal failure. Identifiers
 * that may be externally influenced are recorded only as an opaque bounded
 * digest (see `correlationRef`), so no arbitrary supplied text reaches the sink.
 */
export interface ApplicationDiagnostic {
  level: 'warn'
  service: 'isla-runtime'
  operation: ApplicationDiagnosticOperation
  outcome: 'error'
  /** Opaque bounded digest of the runtime session id. */
  sessionRef: string
  epoch?: number
  connectionId?: string
  messageKind?: string
  /** Opaque bounded digest of the client request id; omitted when absent. */
  requestRef?: string
}

/**
 * Opaque, bounded, stable correlation reference for a possibly externally
 * influenced identifier: a truncated digest of fixed length. The same input
 * always yields the same reference, so records still join, while the arbitrary
 * supplied text is never emitted.
 */
function correlationRef(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)
}

export interface ApplicationEndpoint {
  readonly path: string
  allowRequest(origin: string | undefined, host: string | undefined): boolean
  handleHttp(req: IncomingMessage, res: ServerResponse): boolean
  onConnection(ws: WebSocket, req: IncomingMessage): void
  dispose(): void
}

const DEFAULT_OPERATOR_BOOTSTRAP_TTL_MS = 5 * 60 * 1000
const DEFAULT_MAX_CONNECTIONS = 16
const DEFAULT_MAX_SEND_BUFFER_BYTES = 1_048_576
const DEFAULT_MAX_INBOUND_PER_CONNECTION = 8
const MAX_OPERATOR_TOKENS = 32
/** Upper bound on response opportunities processed before an explicit yield. */
const TURNS_BEFORE_YIELD = 8

// A bare `host` or `host:port`, optionally a bracketed IPv6 literal. Host
// headers carrying credentials, a path, a query or a fragment are rejected
// rather than normalized away.
const HOST_ENTRY_PATTERN = /^(?:\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+)(?::\d{1,5})?$/

function canonicalOrigin(origin: string): string | null {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  // Reject credentials, paths, queries and fragments: an Origin is only
  // `scheme://host[:port]`. This prevents an allowlist entry from being matched
  // through arbitrary URL normalization.
  if (url.username !== '' || url.password !== '') return null
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null
  return `${url.protocol}//${url.host}`
}

function hostName(hostHeader: string | undefined): string | null {
  if (hostHeader === undefined || hostHeader.length === 0) return null
  if (!HOST_ENTRY_PATTERN.test(hostHeader)) return null
  try {
    const parsed = new URL(`http://${hostHeader}`).hostname
    return parsed.startsWith('[') && parsed.endsWith(']') ? parsed.slice(1, -1) : parsed
  } catch {
    return null
  }
}

function isValidHostEntry(entry: string): boolean {
  return HOST_ENTRY_PATTERN.test(entry)
}

function assertLimit(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}, got ${value}`)
  }
  return value
}

interface ConnectionState {
  id: string
  ws: WebSocket
  role: 'viewer' | 'operator'
  performer: boolean
  closed: boolean
  inFlight: number
}

interface OperatorBootstrapStore {
  issue(): { token: string; expiresAtMs: number }
  consume(token: string): boolean
}

function createOperatorBootstrapStore(clock: ClockPort, ttlMs: number): OperatorBootstrapStore {
  const tokens = new Map<string, number>()
  const purge = (): void => {
    const now = clock.nowMs()
    for (const [token, expiresAtMs] of tokens) {
      if (expiresAtMs <= now) tokens.delete(token)
    }
  }
  return {
    issue() {
      purge()
      while (tokens.size >= MAX_OPERATOR_TOKENS) {
        const oldest = tokens.keys().next().value
        if (oldest === undefined) break
        tokens.delete(oldest)
      }
      const token = randomBytes(32).toString('base64url')
      const expiresAtMs = clock.nowMs() + ttlMs
      // The token is retained server-side for one explicit redemption only and
      // is never logged.
      tokens.set(token, expiresAtMs)
      return { token, expiresAtMs }
    },
    consume(token) {
      const expiresAtMs = tokens.get(token)
      if (expiresAtMs === undefined) return false
      tokens.delete(token)
      return expiresAtMs > clock.nowMs()
    },
  }
}

export function createApplicationEndpoint(options: ApplicationEndpointOptions): ApplicationEndpoint {
  const { composition } = options
  const allowedOrigins = new Set(
    options.allowedOrigins
      .map((origin) => canonicalOrigin(origin))
      .filter((origin): origin is string => origin !== null),
  )
  const allowedHosts = options.allowedHosts?.map((host) => {
    if (!isValidHostEntry(host)) {
      throw new RangeError(`invalid allowed host entry: "${host}"`)
    }
    return host.toLowerCase()
  })
  const bootstrapTtlMs = assertLimit('operatorBootstrapTtlMs', options.operatorBootstrapTtlMs ?? DEFAULT_OPERATOR_BOOTSTRAP_TTL_MS, 1, 24 * 60 * 60 * 1000)
  const maxConnections = assertLimit('maxConnections', options.maxConnections ?? DEFAULT_MAX_CONNECTIONS, 1, 1024)
  const maxSendBufferBytes = assertLimit('maxSendBufferBytes', options.maxSendBufferBytes ?? DEFAULT_MAX_SEND_BUFFER_BYTES, 1024, 1024 * 1024 * 1024)
  const maxInboundPerConnection = assertLimit(
    'maxInboundPerConnection',
    options.maxInboundPerConnection ?? DEFAULT_MAX_INBOUND_PER_CONNECTION,
    1,
    1024,
  )
  const bootstraps = createOperatorBootstrapStore(options.clock, bootstrapTtlMs)

  const connections = new Map<string, ConnectionState>()
  const sessionRef = correlationRef(composition.sessionId)
  let reporting = false

  /** Reads the coordinator epoch defensively so reporting can never throw. */
  const currentEpoch = (): number | undefined => {
    try {
      return composition.coordinator.epoch()
    } catch {
      return undefined
    }
  }

  /**
   * Delivers one bounded record to the optional sink, best-effort. A synchronous
   * throw or a synchronous reentrant report is suppressed. A returned thenable is
   * assimilated through Promise.resolve only (one safe `then` access, supporting
   * object and function thenables and tolerating a throwing accessor) and its
   * rejection consumed, so a hostile or nonsettling sink is neither awaited nor
   * able to become an unhandled rejection.
   */
  const reportDiagnostic = (diagnostic: ApplicationDiagnostic): void => {
    const sink = options.onDiagnostic
    if (sink === undefined || reporting) return
    reporting = true
    try {
      void Promise.resolve(sink(diagnostic)).then(undefined, () => {})
    } catch {
      // A synchronous sink throw or throwing `then` accessor is isolated.
    } finally {
      reporting = false
    }
  }

  let performerId: string | null = null
  let performerGeneration = 0
  let messageCounter = 0
  let connectionCounter = 0
  let disposed = false

  const makeMessageId = (): string => {
    messageCounter += 1
    return `app-${messageCounter}`
  }

  const allowHost = (host: string | undefined): boolean => {
    const name = hostName(host)
    if (name === null) return false
    if (allowedHosts !== undefined) {
      const normalized = host?.toLowerCase() ?? ''
      return allowedHosts.includes(normalized)
    }
    return isLoopbackHost(name)
  }

  const allowOrigin = (origin: string | undefined): boolean => {
    if (origin === undefined) return false
    const canonical = canonicalOrigin(origin)
    return canonical !== null && allowedOrigins.has(canonical)
  }

  const safeSend = (conn: ConnectionState, payload: unknown): TransportSendResult => {
    if (conn.ws.readyState !== WebSocket.OPEN) return 'unsent'
    if (conn.ws.bufferedAmount > maxSendBufferBytes) {
      conn.ws.close(1013, 'send buffer limit exceeded')
      return 'unsent'
    }
    try {
      conn.ws.send(JSON.stringify(payload))
      return 'sent'
    } catch {
      // A synchronous throw from the socket layer can happen after bytes were
      // queued, so the transport cannot prove the frame was unsent. Report the
      // attempt as ambiguous; a closed socket or rejected buffer is proven
      // unsent above.
      return 'ambiguous'
    }
  }

  const sendError = (
    conn: ConnectionState,
    code: Parameters<typeof requestError>[4],
    message: string,
    requestId: string | null = null,
    retryable = false,
  ): void => {
    safeSend(
      conn,
      requestError(
        composition.sessionId,
        composition.coordinator.epoch(),
        makeMessageId(),
        requestId,
        code,
        message,
        retryable,
      ),
    )
  }

  const contextFor = (conn: ConnectionState): TrustedControlContext => ({
    connectionId: conn.id,
    role: conn.role,
    actorId: conn.role === 'operator' ? `operator-${conn.id}` : `viewer-${conn.id}`,
    authenticated: true,
  })

  const sendToPerformer = (message: PerformerBridgeMessage): TransportSendResult => {
    if (performerId === null) return 'unsent'
    const conn = connections.get(performerId)
    if (conn === undefined) return 'unsent'
    return safeSend(conn, message)
  }

  // The bridge dispatches offers/grants to the performer and forwards
  // intermediate/stray receipts to the authoritative endpoint.
  composition.bridge.bindTransport({
    send: sendToPerformer,
    handleEvidence: (message) => composition.coordinator.endpoint.handlePlayerMessage(message),
    makeMessageId,
    generation: () => performerGeneration,
  })

  let draining = false
  let pendingWake = false

  const drain = async (): Promise<void> => {
    if (disposed || draining) return
    draining = true
    try {
      while (!disposed && pendingWake) {
        pendingWake = false
        let sinceYield = 0
        while (!disposed && performerId !== null) {
          const outcome = await composition.coordinator.runTurn()
          if (disposed) break
          const progressed = outcome.status === 'completed' || outcome.status === 'cancelled'
          if (!progressed) break
          sinceYield += 1
          if (sinceYield >= TURNS_BEFORE_YIELD) {
            sinceYield = 0
            // Bounded yield: lets Stop and receipt messages be processed while
            // still draining more than one burst of accepted inputs.
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 0)
            })
          }
        }
      }
    } catch {
      // A drain fault must not wedge the scheduler; a later wake retries.
      const epoch = currentEpoch()
      reportDiagnostic({
        level: 'warn',
        service: 'isla-runtime',
        operation: 'application.scheduler',
        outcome: 'error',
        sessionRef,
        ...(epoch !== undefined ? { epoch } : {}),
      })
    } finally {
      draining = false
    }
  }

  const wake = (): void => {
    pendingWake = true
    if (!draining) void drain()
  }

  const broadcast = (message: ServerMessage): void => {
    for (const conn of connections.values()) safeSend(conn, message)
  }
  const unsubscribe = composition.coordinator.endpoint.onServerMessage(broadcast)

  const handleSnapshot = async (conn: ConnectionState): Promise<void> => {
    try {
      const snapshot = await composition.coordinator.endpoint.snapshot()
      safeSend(conn, {
        protocolVersion: '0.2',
        messageId: makeMessageId(),
        sessionId: snapshot.sessionId,
        epoch: snapshot.epoch,
        kind: 'session.snapshot',
        payload: {
          lifecycle: snapshot.lifecycle,
          activeTurnId: snapshot.activeTurnId,
          performerStatus: snapshot.performerStatus,
          outputConfirmation: snapshot.outputConfirmation,
          capabilityRevision: snapshot.capabilityRevision,
          lastSeq: snapshot.seq,
        },
      })
    } catch {
      // A snapshot fault leaves the connection unbound; it may re-attach.
      const epoch = currentEpoch()
      reportDiagnostic({
        level: 'warn',
        service: 'isla-runtime',
        operation: 'application.snapshot',
        outcome: 'error',
        sessionRef,
        ...(epoch !== undefined ? { epoch } : {}),
        connectionId: conn.id,
      })
    }
  }

  const handleAttach = (conn: ConnectionState, messageId: string, sessionId: string, epoch: number): void => {
    if (sessionId !== composition.sessionId) {
      sendError(conn, 'conflict', 'attach session does not match this runtime session', messageId)
      return
    }
    if (epoch !== composition.coordinator.epoch()) {
      sendError(conn, 'stale', 'attach epoch is not the current epoch', messageId)
      return
    }
    if (performerId !== null && performerId !== conn.id) {
      sendError(conn, 'conflict', 'a performer is already attached to this session', messageId)
      return
    }
    // A duplicate attach on the same socket preserves the existing binding and
    // generation, so live work is not invalidated and audio is never replayed.
    const alreadyBound = performerId === conn.id
    performerId = conn.id
    conn.performer = true
    if (!alreadyBound) performerGeneration += 1
    safeSend(
      conn,
      sessionAttachAckMessageSchema.parse({
        protocolVersion: '0.2',
        messageId: makeMessageId(),
        sessionId: composition.sessionId,
        epoch: composition.coordinator.epoch(),
        kind: 'session.attach.ack',
        payload: { connectionId: conn.id, performer: true },
      }),
    )
    wake()
  }

  const handleOperatorBootstrap = (
    conn: ConnectionState,
    messageId: string,
    sessionId: string,
    epoch: number,
    token: string,
  ): void => {
    if (sessionId !== composition.sessionId) {
      sendError(conn, 'conflict', 'bootstrap session does not match this runtime session', messageId)
      return
    }
    if (epoch !== composition.coordinator.epoch()) {
      sendError(conn, 'stale', 'bootstrap epoch is not the current epoch', messageId)
      return
    }
    if (!bootstraps.consume(token)) {
      sendError(conn, 'unauthorized', 'operator bootstrap token is invalid or expired', messageId)
      return
    }
    conn.role = 'operator'
    safeSend(
      conn,
      operatorAckMessageSchema.parse({
        protocolVersion: '0.2',
        messageId: makeMessageId(),
        sessionId: composition.sessionId,
        epoch: composition.coordinator.epoch(),
        kind: 'operator.ack',
        payload: { role: 'operator', requestMessageId: messageId },
      }),
    )
  }

  const handleMessage = async (conn: ConnectionState, raw: string): Promise<void> => {
    if (disposed || conn.closed) return
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(raw)
    } catch {
      sendError(conn, 'malformed', 'message is not valid JSON')
      return
    }
    const parsed = parseApplicationClientMessage(parsedJson)
    if (!parsed.ok) {
      sendError(conn, parsed.code, parsed.message)
      return
    }
    const message = parsed.message
    // Control and binding messages are never blocked by backpressure so Stop
    // stays responsive under load.
    const exempt =
      message.kind === 'control.stop' ||
      message.kind === 'control.resume' ||
      message.kind === 'session.attach' ||
      message.kind === 'operator.bootstrap'
    if (!exempt && conn.inFlight >= maxInboundPerConnection) {
      sendError(conn, 'conflict', 'too many concurrent requests', null, true)
      return
    }
    conn.inFlight += 1
    try {
      switch (message.kind) {
        case 'input.submit': {
          const ack: InputAck = await composition.coordinator.endpoint.submitInput(
            message,
            contextFor(conn),
          )
          safeSend(conn, inputAckToWire(ack, makeMessageId()))
          if (ack.status === 'accepted') wake()
          return
        }
        case 'control.stop':
        case 'control.resume': {
          const ack = await composition.coordinator.endpoint.control(message, contextFor(conn))
          safeSend(conn, controlAckToWire(ack, makeMessageId()))
          return
        }
        case 'performance.receipt': {
          if (!conn.performer || performerId !== conn.id) {
            sendError(conn, 'unauthorized', 'player receipts require the bound performer connection', message.messageId)
            return
          }
          if (message.sessionId !== composition.sessionId) {
            sendError(conn, 'unauthorized', 'receipt envelope session does not match this runtime', message.messageId)
            return
          }
          const outcome = await composition.bridge.deliver(message)
          if (outcome === 'forward') await composition.coordinator.endpoint.handlePlayerMessage(message)
          return
        }
        case 'performance.ready': {
          if (!conn.performer || performerId !== conn.id) {
            sendError(conn, 'unauthorized', 'ready requires the bound performer connection', message.messageId)
            return
          }
          if (message.sessionId !== composition.sessionId) {
            sendError(conn, 'unauthorized', 'ready envelope session does not match this runtime', message.messageId)
            return
          }
          composition.bridge.handleReady(message)
          return
        }
        case 'performance.status': {
          if (!conn.performer || performerId !== conn.id) {
            sendError(conn, 'unauthorized', 'physical status requires the bound performer connection', message.messageId)
            return
          }
          if (message.sessionId !== composition.sessionId) {
            sendError(conn, 'unauthorized', 'status envelope session does not match this runtime', message.messageId)
            return
          }
          composition.bridge.handlePhysicalStatus(message)
          return
        }
        case 'session.attach': {
          handleAttach(conn, message.messageId, message.sessionId, message.epoch)
          return
        }
        case 'operator.bootstrap': {
          handleOperatorBootstrap(conn, message.messageId, message.sessionId, message.epoch, message.payload.token)
          return
        }
        default: {
          sendError(conn, 'unknown_kind', 'message kind is not supported')
        }
      }
    } catch {
      const requestId = typeof message.messageId === 'string' ? message.messageId : null
      reportDiagnostic({
        level: 'warn',
        service: 'isla-runtime',
        operation: 'application.request',
        outcome: 'error',
        sessionRef,
        epoch: message.epoch,
        connectionId: conn.id,
        messageKind: message.kind,
        ...(requestId !== null ? { requestRef: correlationRef(requestId) } : {}),
      })
      sendError(conn, 'internal', 'request failed while processing', null, true)
    } finally {
      conn.inFlight -= 1
    }
  }

  return {
    path: APPLICATION_PATH,

    allowRequest(origin: string | undefined, host: string | undefined): boolean {
      return allowOrigin(origin) && allowHost(host)
    },

    handleHttp(req: IncomingMessage, res: ServerResponse): boolean {
      const rawUrl = req.url ?? ''
      let pathname: string
      try {
        pathname = new URL(rawUrl, 'http://localhost').pathname
      } catch {
        return false
      }
      if (pathname !== OPERATOR_BOOTSTRAP_PATH) return false

      const deny = (status: number, code: string): boolean => {
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify({ ok: false, error: { code } }))
        return true
      }

      if (req.method !== 'POST') return deny(405, 'method_not_allowed')
      if (req.headers[OPERATOR_BOOTSTRAP_HEADER] === undefined) return deny(403, 'forbidden')
      if (!allowOrigin(req.headers.origin) || !allowHost(req.headers.host)) return deny(403, 'forbidden')

      const issued = bootstraps.issue()
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      // The one-time token is returned only to the explicit same-origin,
      // loopback-host bootstrap caller; it is never logged.
      res.end(JSON.stringify({ ok: true, token: issued.token, expiresAtMs: issued.expiresAtMs }))
      return true
    },

    onConnection(ws: WebSocket, _req: IncomingMessage): void {
      if (disposed || connections.size >= maxConnections) {
        ws.close(1013, 'connection limit')
        return
      }
      connectionCounter += 1
      const conn: ConnectionState = {
        id: `conn-${connectionCounter}`,
        ws,
        role: 'viewer',
        performer: false,
        closed: false,
        inFlight: 0,
      }
      connections.set(conn.id, conn)
      void handleSnapshot(conn)
      ws.on('message', (data: Buffer) => {
        void handleMessage(conn, data.toString('utf8'))
      })
      ws.on('close', () => {
        conn.closed = true
        connections.delete(conn.id)
        if (performerId === conn.id) {
          performerId = null
          conn.performer = false
          performerGeneration += 1
          // A lost performer cannot prove old media stopped: retain conservative
          // unknown evidence and a non-idle status.
          composition.bridge.detach('performer_disconnected')
        }
      })
      ws.on('error', () => {
        // Connection errors are surfaced through the close path.
      })
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      unsubscribe()
      for (const conn of connections.values()) {
        conn.closed = true
        try {
          conn.ws.close(1001, 'application endpoint disposed')
        } catch {
          // Ignore close faults during shutdown.
        }
      }
      connections.clear()
      performerId = null
      composition.dispose()
    },
  }
}
