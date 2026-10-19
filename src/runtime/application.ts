import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { WebSocket } from 'ws'
import type {
  ClockPort,
  ControlAck,
  ControlResumeMessage,
  InputAck,
  InputSubmitMessage,
  ServerMessage,
  TrustedControlContext,
} from '../contracts'
import { controlAckSchema, controlAckToWire, inputAckSchema, inputAckToWire } from '../contracts'
import { isLoopbackHost } from './config'
import {
  APPLICATION_PATH,
  OPERATOR_BOOTSTRAP_HEADER,
  OPERATOR_BOOTSTRAP_PATH,
  operatorAckMessageSchema,
  parseApplicationClientMessage,
  requestError,
  sessionAttachAckMessageSchema,
  sessionRecoveryAckMessageSchema,
  sessionRecoveryStateMessageSchema,
  type SessionRecoverMessage,
  type SessionRecoveryStateMessage,
} from '../contracts'
import type { RuntimeComposition } from './composition'
import { RecoveryError } from './session-recovery'
import type { RecoveryErrorCode, RecoveryResult, SessionRecovery } from './session-recovery'
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
  /**
   * Explicit operator-driven session recovery. When supplied, an operator may
   * retire the current session and adopt a fresh successor built from confirmed
   * history. The successor is adopted with its own connection generation, so no
   * old message, receipt or asynchronous completion can reach it.
   */
  recovery?: SessionRecovery
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
  const { recovery } = options
  let composition = options.composition
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
  // A recovery swaps the live composition, so the diagnostic session reference
  // is derived from the current composition each time rather than captured once.
  const sessionRef = (): string => correlationRef(composition.sessionId)
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
  /**
   * True from the moment a valid recovery request for the current session is
   * accepted until its successor is installed. While retiring (or after a failed
   * retirement) new input and Resume are refused and the scheduler is halted, so
   * the old session can never keep producing work during or after the swap.
   */
  let retiring = false

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
  // intermediate/stray receipts to the authoritative endpoint. Every callback
  // is bound to the composition that owns it: a delayed send or evidence
  // callback from a retired composition is dropped rather than reaching the
  // installed successor. The transport therefore never closes over the mutable
  // `composition` variable.
  const bindBridge = (owner: RuntimeComposition): void => {
    owner.bridge.bindTransport({
      send: (message) => (composition === owner ? sendToPerformer(message) : 'unsent'),
      handleEvidence: async (message) => {
        if (composition !== owner) return
        await owner.coordinator.endpoint.handlePlayerMessage(message)
      },
      makeMessageId,
      generation: () => performerGeneration,
    })
  }
  bindBridge(composition)

  /**
   * The composition currently draining the scheduler. It is an ownership token,
   * not a boolean: an in-flight pass for a retired composition must not clear
   * the successor's slot or restart its scheduler when it settles.
   */
  let drainOwner: RuntimeComposition | null = null
  let pendingWake = false

  const drain = async (): Promise<void> => {
    const owner = composition
    if (disposed || drainOwner !== null || retiring) return
    drainOwner = owner
    try {
      while (!disposed && !retiring && composition === owner && pendingWake) {
        pendingWake = false
        let sinceYield = 0
        while (!disposed && !retiring && composition === owner && performerId !== null) {
          const outcome = await owner.coordinator.runTurn()
          // A swap or retirement during the await ends this pass; the successor's
          // scheduler is started separately by its own wake.
          if (disposed || retiring || composition !== owner) return
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
      // A drain fault from a superseded composition must not be attributed to
      // the successor, and must not wedge or reset the successor's scheduler.
      if (disposed || retiring || composition !== owner) return
      let epoch: number | undefined
      try {
        epoch = owner.coordinator.epoch()
      } catch {
        epoch = undefined
      }
      reportDiagnostic({
        level: 'warn',
        service: 'isla-runtime',
        operation: 'application.scheduler',
        outcome: 'error',
        sessionRef: correlationRef(owner.sessionId),
        ...(epoch !== undefined ? { epoch } : {}),
      })
    } finally {
      if (drainOwner === owner) drainOwner = null
    }
  }

  const wake = (): void => {
    pendingWake = true
    if (drainOwner === null) void drain()
  }

  const broadcast = (message: ServerMessage | SessionRecoveryStateMessage): void => {
    for (const conn of connections.values()) safeSend(conn, message)
  }
  // Rebound on recovery: the successor coordinator's server messages must reach
  // the connections that survive the swap.
  let unsubscribe = composition.coordinator.endpoint.onServerMessage(broadcast)

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
      // A newly connected client also learns the explicit retirement state, so a
      // reload after a failed retirement remains disabled until a retry succeeds.
      sendRecoveryState(conn)
    } catch {
      // A snapshot fault leaves the connection unbound; it may re-attach.
      const epoch = currentEpoch()
      reportDiagnostic({
        level: 'warn',
        service: 'isla-runtime',
        operation: 'application.snapshot',
        outcome: 'error',
        sessionRef: sessionRef(),
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

  /**
   * Adopt a successfully built successor and retire every old connection. The
   * successor is installed before any socket is closed, so a surviving socket
   * cannot reach the old runtime; `performerId` is cleared first so the close
   * handler does not detach the successor's bridge. Old evidence stays in the
   * shared store; only in-memory scheduling and connections are retired.
   */
  const installSuccessor = (previous: RuntimeComposition, next: RuntimeComposition): void => {
    if (disposed) {
      // The endpoint shut down while the successor was being built: release it
      // and never install or bind it.
      next.dispose()
      return
    }
    performerId = null
    performerGeneration += 1
    unsubscribe()
    composition = next
    // The retiring scheduler's slot is released here; its in-flight pass is
    // fenced by composition identity and cannot run a turn for the successor.
    drainOwner = null
    retiring = false
    unsubscribe = composition.coordinator.endpoint.onServerMessage(broadcast)
    bindBridge(next)
    for (const conn of [...connections.values()]) {
      conn.closed = true
      conn.performer = false
      try {
        conn.ws.close(1001, 'session recovered')
      } catch {
        // Ignore close faults; the connection is dropped from the map regardless.
      }
    }
    connections.clear()
    previous.dispose()
  }

  const sendRecoveryAck = (
    conn: ConnectionState,
    message: SessionRecoverMessage,
    status: 'applied' | 'already_applied',
    result: RecoveryResult,
  ): void => {
    // The envelope stays on the retiring session and the request epoch so the
    // acknowledgement correlates to the request; the successor identity is in
    // the payload. `already_applied` means no second successor was created.
    safeSend(
      conn,
      sessionRecoveryAckMessageSchema.parse({
        protocolVersion: '0.2',
        messageId: makeMessageId(),
        sessionId: message.sessionId,
        epoch: message.epoch,
        kind: 'session.recovery.ack',
        payload: {
          status,
          requestMessageId: message.messageId,
          retiredSessionId: result.retiredSessionId,
          successorSessionId: result.sessionId,
          recoveries: result.recoveries,
          remainingRecoveries: result.remainingRecoveries,
        },
      }),
    )
  }

  /** Map a recovery refusal to a protocol error; only construction is retryable. */
  const recoveryRefusal = (
    code: RecoveryErrorCode,
  ): { code: Parameters<typeof requestError>[4]; message: string; retryable: boolean } => {
    switch (code) {
      case 'unknown_session':
        return {
          code: 'conflict',
          message: 'recovery request matches neither the current nor a retired session',
          retryable: false,
        }
      case 'source_limit':
        return {
          code: 'conflict',
          message: 'session recovery would exceed the archive-source bound',
          retryable: false,
        }
      case 'construction_failed':
        return {
          code: 'storage_unavailable',
          message: 'failed to construct the successor session; retry is possible',
          retryable: true,
        }
    }
  }

  /**
   * Stop the retiring session's scheduling immediately, before the successor
   * construction is awaited. The coordinator revokes all session work (aborting
   * an in-flight turn and clearing queued input); the bridge and gate stay alive
   * until a successful install disposes the composition, so the retiring
   * session's stored evidence remains readable. The `retiring` flag keeps input
   * and Resume refused until the successor is installed, or permanently if
   * retirement failed.
   */
  /** The explicit retirement-state message for one session/epoch. */
  const recoveryStateMessage = (
    sessionId: string,
    epoch: number,
    retiringValue: boolean,
  ): SessionRecoveryStateMessage =>
    sessionRecoveryStateMessageSchema.parse({
      protocolVersion: '0.2',
      messageId: makeMessageId(),
      sessionId,
      epoch,
      kind: 'session.recovery.state',
      payload: { retiring: retiringValue },
    })

  /** Tell one newly connected client the current, authoritative retirement state. */
  const sendRecoveryState = (conn: ConnectionState): void => {
    safeSend(conn, recoveryStateMessage(composition.sessionId, composition.coordinator.epoch(), retiring))
  }

  const retireCurrentSession = (target: RuntimeComposition): void => {
    if (retiring) return
    retiring = true
    target.coordinator.dispose()
    // Publish the authoritative retirement state and the real stopped snapshot so
    // an attached client learns from the runtime that the session is retiring,
    // not from a UI guess. A refusal that never retires the session never
    // reaches here.
    void publishRetirement(target)
  }

  /** Broadcast the explicit retirement state and the real stopped snapshot. */
  const publishRetirement = async (owner: RuntimeComposition): Promise<void> => {
    try {
      const snapshot = await owner.coordinator.endpoint.snapshot()
      // A delayed predecessor publication must never reach successor clients: if
      // the endpoint shut down or the composition already swapped, drop it.
      if (disposed || composition !== owner) return
      broadcast(recoveryStateMessage(owner.sessionId, snapshot.epoch, true))
      broadcast({
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
      // Best effort: the retirement itself is already committed.
    }
  }

  /** Reject new input while the current session is being retired. */
  const sendRetirementInputRefusal = (
    conn: ConnectionState,
    message: InputSubmitMessage,
    owner: RuntimeComposition,
  ): void => {
    const ack: InputAck = inputAckSchema.parse({
      status: 'rejected',
      requestMessageId: message.messageId,
      sessionId: owner.sessionId,
      epoch: owner.coordinator.epoch(),
      code: 'conflict',
      message: 'the session is being retired; continue in the successor session',
      retryable: false,
    })
    safeSend(conn, inputAckToWire(ack, makeMessageId()))
  }

  /** Refuse Resume while the current session is being retired. */
  const sendRetirementControlRefusal = (
    conn: ConnectionState,
    message: ControlResumeMessage,
    owner: RuntimeComposition,
  ): void => {
    const ack: ControlAck = controlAckSchema.parse({
      sessionId: owner.sessionId,
      requestId: message.payload.requestId,
      requestMessageId: message.messageId,
      action: 'resume',
      status: 'refused',
      previousEpoch: owner.coordinator.epoch(),
      epoch: owner.coordinator.epoch(),
      lifecycle: owner.coordinator.lifecycle(),
      outputConfirmation: owner.coordinator.outputConfirmation(),
      reasonCode: 'conflict',
      message: 'resume refused while the session is being retired',
    })
    safeSend(conn, controlAckToWire(ack, makeMessageId()))
  }

  const handleRecover = async (conn: ConnectionState, message: SessionRecoverMessage): Promise<void> => {
    // An operator decision, never inferred from a payload or from measured media.
    if (conn.role !== 'operator') {
      sendError(conn, 'unauthorized', 'session recovery requires operator authority', message.messageId)
      return
    }
    if (recovery === undefined) {
      sendError(conn, 'conflict', 'session recovery is not enabled for this runtime', message.messageId)
      return
    }
    // The envelope session id is the session the operator intends to retire. A
    // request against the current session must carry its current epoch; a
    // request against an already-retired session is answered idempotently and is
    // not epoch-checked against the live successor.
    const retiringCurrent = message.sessionId === composition.sessionId
    if (retiringCurrent && message.epoch !== composition.coordinator.epoch()) {
      sendError(conn, 'stale', 'recovery epoch is not the current epoch', message.messageId)
      return
    }
    // Only a request for the current session may stop the live runtime. Unknown,
    // stale-epoch, unauthorized and already-retired requests never touch it.
    const previous = composition
    if (retiringCurrent) retireCurrentSession(previous)
    let result: RecoveryResult
    try {
      result = await recovery.recover(message.sessionId)
    } catch (error) {
      if (error instanceof RecoveryError) {
        // A refused retirement (for example the archive-source bound) leaves the
        // session stopped and unserviceable for new work; a construction failure
        // leaves it stopped and retryable. The operator may always retry.
        const refusal = recoveryRefusal(error.code)
        sendError(conn, refusal.code, refusal.message, message.messageId, refusal.retryable)
        return
      }
      throw error
    }
    if (disposed) {
      // The endpoint shut down while the successor was building: release the
      // constructed successor and never install or bind it. The shared store is
      // untouched.
      if (result.status === 'applied') result.composition.dispose()
      return
    }
    // A concurrent request that already swapped the endpoint must not install a
    // second successor; the captured `previous` is the guard.
    if (result.status === 'applied' && composition === previous) {
      sendRecoveryAck(conn, message, 'applied', result)
      installSuccessor(previous, result.composition)
    } else {
      sendRecoveryAck(conn, message, 'already_applied', result)
    }
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
    // Control, binding and operator-recovery messages are never blocked by
    // backpressure so Stop and recovery stay responsive under load.
    const exempt =
      message.kind === 'control.stop' ||
      message.kind === 'control.resume' ||
      message.kind === 'session.attach' ||
      message.kind === 'operator.bootstrap' ||
      message.kind === 'session.recover'
    if (!exempt && conn.inFlight >= maxInboundPerConnection) {
      sendError(conn, 'conflict', 'too many concurrent requests', null, true)
      return
    }
    conn.inFlight += 1
    try {
      switch (message.kind) {
        case 'input.submit': {
          const owner = composition
          if (retiring) {
            sendRetirementInputRefusal(conn, message, owner)
            return
          }
          const ack: InputAck = await owner.coordinator.endpoint.submitInput(
            message,
            contextFor(conn),
          )
          // A composition superseded during the await must not answer or
          // schedule work for the successor.
          if (composition !== owner) return
          safeSend(conn, inputAckToWire(ack, makeMessageId()))
          if (ack.status === 'accepted' && !retiring) wake()
          return
        }
        case 'control.stop':
        case 'control.resume': {
          const owner = composition
          if (retiring && message.kind === 'control.resume') {
            sendRetirementControlRefusal(conn, message, owner)
            return
          }
          const ack = await owner.coordinator.endpoint.control(message, contextFor(conn))
          if (composition !== owner) return
          safeSend(conn, controlAckToWire(ack, makeMessageId()))
          return
        }
        case 'performance.receipt': {
          const owner = composition
          if (!conn.performer || performerId !== conn.id) {
            sendError(conn, 'unauthorized', 'player receipts require the bound performer connection', message.messageId)
            return
          }
          if (message.sessionId !== owner.sessionId) {
            sendError(conn, 'unauthorized', 'receipt envelope session does not match this runtime', message.messageId)
            return
          }
          const outcome = await owner.bridge.deliver(message)
          // A delayed receipt from a retired composition must never be forwarded
          // into the installed successor.
          if (composition !== owner) return
          if (outcome === 'forward') await owner.coordinator.endpoint.handlePlayerMessage(message)
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
        case 'session.recover': {
          await handleRecover(conn, message)
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
        sessionRef: sessionRef(),
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
