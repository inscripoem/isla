import { useCallback, useEffect, useRef, useState } from 'react'
import classNames from 'classnames'
import {
  Badge,
  Button,
  Card,
  Checkbox,
  CodeBlock,
  Collapse,
  Divider,
  Input,
  Select,
  Tabs,
  Tag,
  Title,
  notificationOpen,
} from 'animal-island-ui'
import { PlayIcon, RefreshIcon, SendIcon, StopIcon } from 'naive-icons'
import {
  APPLICATION_CONTRACT_VERSION,
  DIAGNOSTICS_PROTOCOL_VERSION,
  INPUT_SOURCES,
  type ApplicationServerMessage,
  type BootstrapSnapshot,
  type ConsoleTransportPort,
  type ControlResumeMessage,
  type ControlStopMessage,
  type DiagnosticReply,
  type InputSource,
  type InputSubmitMessage,
  type ServerMessage,
} from '../contracts'
import { ConsoleTransportError, isApplicationTransport, type ConsoleApplicationTransport } from './app-transport'
import type { PlaybackBinding, PlaybackCallbacks, PlaybackFactory } from './player-binding'
import type { PerformerMachine, PerformerMachineHooks, PerformerState } from './performer-machine'
import { snapshotMessageFromBootstrap } from './performer-adapter'
import { recoveryControlView } from './recovery-control'
import {
  canDispatch,
  createInitialConsoleState,
  reduceApplicationMessage,
  reduceControlAck,
  reduceInputAck,
  reduceServerMessage,
  withBootstrap,
  withConnection,
  withControlFailure,
  withError,
  withFault,
  withInputFailure,
  withPendingControl,
  withPendingInput,
  withPlaybackStatus,
  withReceipt,
  withSubtitle,
  type ConnectionStatus,
  type ConsoleState,
  type RequestOutcome,
} from './console-state'
import './console.css'

const HEALTH_PATH = '/health'
const DIAGNOSTICS_PATH = '/diag'
const PING_KIND = 'ping'

type StatusColor = 'app-green' | 'app-teal' | 'app-yellow' | 'app-orange' | 'app-red'

const CONNECTION_COLORS: Record<ConnectionStatus, StatusColor> = {
  connecting: 'app-yellow',
  open: 'app-green',
  closed: 'app-orange',
  error: 'app-red',
}

const OUTCOME_COLORS: Record<RequestOutcome, StatusColor> = {
  pending: 'app-yellow',
  unknown: 'app-orange',
  accepted: 'app-green',
  applied: 'app-green',
  duplicate: 'app-teal',
  rejected: 'app-red',
  refused: 'app-red',
}

const SOURCE_OPTIONS = INPUT_SOURCES.map((value) => ({ key: value, label: value }))

/**
 * A status channel the console needs but the transport port does not declare:
 * the port has no way to report a socket that closes while idle. The composer
 * that builds the transport supplies this reporter.
 */
export interface TransportStatusReporter {
  onStatus(connection: ConnectionStatus, detail: string | null): void
  onProtocolViolation(detail: string): void
}

export type TransportFactory = (reporter: TransportStatusReporter) => ConsoleTransportPort

/**
 * Constructs the performer machine once the bootstrap identity is known.
 *
 * The factory owns wrapping the application transport with
 * `createMachineTransport`; the console only supplies the hooks it needs.
 */
export interface PerformerFactory {
  (bootstrap: BootstrapSnapshot, transport: ConsoleApplicationTransport, hooks: PerformerMachineHooks): PerformerMachine
}

export interface ConsoleAppProps {
  readonly transportFactory: TransportFactory
  /** Preferred application performer machine; required for an application transport. */
  readonly performerFactory?: PerformerFactory
  /** Requests a one-time operator token only when the operator button is pressed. */
  readonly requestOperatorToken?: () => Promise<string>
  /**
   * Legacy local playback binding. It is an explicit fallback for base-only
   * fixture transports only; production composes the performer machine instead.
   */
  readonly playbackFactory?: PlaybackFactory
}

function identify(error: unknown): string {
  if (error instanceof ConsoleTransportError) return `${error.reason}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

function isInputSource(value: string): value is InputSource {
  return (INPUT_SOURCES as readonly string[]).includes(value)
}

function Facts({ rows }: { readonly rows: readonly (readonly [string, string])[] }) {
  return (
    <dl className="facts">
      {rows.flatMap(([label, value]) => [
        <dt key={`${label}-label`}>{label}</dt>,
        <dd key={`${label}-value`}>{value}</dd>,
      ])}
    </dl>
  )
}

/* ------------------------------------------------------------------ *
 * Diagnostics protocol 1 panel. It stays a separate tab so protocol 1
 * traffic is never mixed with application protocol 0.2 behaviour.
 * ------------------------------------------------------------------ */

interface HealthView {
  service: string
  version: string
  role: string
  loopbackOnly: boolean
  diagnosticsVersion: number
  applicationVersion: number | null
  capabilities: string[]
  uptimeSec: number
}

type SocketState = 'connecting' | 'open' | 'closed' | 'error'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseHealth(value: unknown): HealthView | null {
  if (!isRecord(value) || value.ok !== true) return null
  if (typeof value.service !== 'string' || typeof value.version !== 'string') return null
  if (typeof value.role !== 'string' || typeof value.loopbackOnly !== 'boolean') return null
  if (typeof value.uptimeSec !== 'number' || !isRecord(value.protocol)) return null
  const diagnosticsVersion = value.protocol.diagnostics
  const applicationVersion = value.protocol.application
  if (typeof diagnosticsVersion !== 'number') return null
  if (applicationVersion !== null && typeof applicationVersion !== 'number') return null
  if (!Array.isArray(value.capabilities) || !value.capabilities.every((entry) => typeof entry === 'string')) {
    return null
  }
  return {
    service: value.service,
    version: value.version,
    role: value.role,
    loopbackOnly: value.loopbackOnly,
    diagnosticsVersion,
    applicationVersion,
    capabilities: value.capabilities,
    uptimeSec: value.uptimeSec,
  }
}

function parseReply(value: unknown): DiagnosticReply | null {
  if (!isRecord(value)) return null
  if (value.v !== DIAGNOSTICS_PROTOCOL_VERSION) return null
  if (typeof value.ok !== 'boolean' || typeof value.kind !== 'string') return null
  if (value.ok === false && (!isRecord(value.error) || typeof value.error.code !== 'string')) {
    return null
  }
  return value as unknown as DiagnosticReply
}

function DiagnosticsPanel() {
  const [health, setHealth] = useState<HealthView | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)
  const [healthLoading, setHealthLoading] = useState(true)
  const [socketState, setSocketState] = useState<SocketState>('connecting')
  const [socketError, setSocketError] = useState<string | null>(null)
  const [lastReply, setLastReply] = useState<string | null>(null)
  const [showHealth, setShowHealth] = useState(true)
  const [showSocket, setShowSocket] = useState(true)

  const socketRef = useRef<WebSocket | null>(null)
  const healthAbortRef = useRef<AbortController | null>(null)
  const activeRef = useRef(true)

  const refreshHealth = useCallback(async () => {
    healthAbortRef.current?.abort()
    const controller = new AbortController()
    healthAbortRef.current = controller
    const isCurrent = (): boolean =>
      activeRef.current && !controller.signal.aborted && healthAbortRef.current === controller
    try {
      const response = await fetch(HEALTH_PATH, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`health request failed with status ${response.status}`)
      const parsed = parseHealth(await response.json())
      if (parsed === null) throw new Error('health response failed validation')
      if (!isCurrent()) return
      setHealth(parsed)
      setHealthError(null)
    } catch (error) {
      if (!isCurrent()) return
      setHealth(null)
      setHealthError(error instanceof Error ? error.message : String(error))
    } finally {
      if (isCurrent()) setHealthLoading(false)
    }
  }, [])

  const startSocket = useCallback(() => {
    if (socketRef.current !== null) return
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const socket = new WebSocket(`${scheme}://${window.location.host}${DIAGNOSTICS_PATH}`)
    socketRef.current = socket
    socket.onopen = () => {
      setSocketState('open')
      setSocketError(null)
    }
    socket.onclose = (event) => {
      setSocketState('closed')
      healthAbortRef.current?.abort()
      setHealth(null)
      setHealthLoading(false)
      setHealthError('backend health cleared because the diagnostics socket closed')
      if (!event.wasClean) {
        setSocketError(`diagnostics socket closed unexpectedly (code ${event.code})`)
      }
    }
    socket.onerror = () => {
      setSocketState('error')
      setSocketError('diagnostics socket error')
      healthAbortRef.current?.abort()
      setHealth(null)
      setHealthLoading(false)
      setHealthError('backend health cleared because the diagnostics socket errored')
    }
    socket.onmessage = (event) => {
      try {
        const parsed = parseReply(JSON.parse(String(event.data)))
        setLastReply(
          parsed === null ? 'Unrecognised reply from diagnostics server' : JSON.stringify(parsed, null, 2),
        )
      } catch {
        setLastReply('Unrecognised reply from diagnostics server')
      }
    }
  }, [])

  useEffect(() => {
    activeRef.current = true
    const initialFetchTimer = setTimeout(() => {
      void refreshHealth()
    }, 0)
    return () => {
      activeRef.current = false
      clearTimeout(initialFetchTimer)
      healthAbortRef.current?.abort()
      const socket = socketRef.current
      socketRef.current = null
      if (socket !== null) {
        socket.onopen = null
        socket.onclose = null
        socket.onerror = null
        socket.onmessage = null
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close(1000, 'console unmounting')
        }
      }
    }
  }, [refreshHealth])

  const sendPing = useCallback(() => {
    const socket = socketRef.current
    if (socket === null || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ v: DIAGNOSTICS_PROTOCOL_VERSION, id: `console-${Date.now()}`, kind: PING_KIND }))
  }, [])

  const socketColor: StatusColor =
    socketState === 'open' ? 'app-green' : socketState === 'error' ? 'app-red' : 'app-yellow'

  const healthRows: readonly (readonly [string, string])[] =
    health === null
      ? []
      : [
          ['Service', health.service],
          ['Version', health.version],
          ['Role', health.role],
          ['Loopback only', health.loopbackOnly ? 'yes' : 'no'],
          ['Diagnostics protocol', String(health.diagnosticsVersion)],
          ['Application protocol', health.applicationVersion === null ? 'not implemented' : String(health.applicationVersion)],
          ['Capabilities', health.capabilities.join(', ')],
          ['Uptime', `${health.uptimeSec.toFixed(1)} s`],
        ]

  return (
    <div className="console__stack">
      <Card>
        <div className="console__card-head">
          <Title size="middle">Diagnostics backend health</Title>
          <Tag variant="soft" color={health !== null ? 'app-green' : healthError !== null ? 'app-red' : 'app-yellow'}>
            {health !== null ? 'ok' : healthError !== null ? 'unavailable' : 'unknown'}
          </Tag>
        </div>
        <div className="console__actions">
          <Button
            size="small"
            icon={<RefreshIcon size={18} />}
            loading={healthLoading}
            onClick={() => {
              setHealthLoading(true)
              setHealthError(null)
              void refreshHealth()
            }}
          >
            Refresh health
          </Button>
          <Button size="small" onClick={() => setShowHealth((value) => !value)} aria-expanded={showHealth}>
            {showHealth ? 'Hide details' : 'Show details'}
          </Button>
        </div>
        {healthError !== null && <p className="console__alert">{healthError}</p>}
        {showHealth && health !== null && <Facts rows={healthRows} />}
      </Card>

      <Card>
        <div className="console__card-head">
          <Title size="middle">Diagnostics socket</Title>
          <Tag variant="soft" color={socketColor}>
            {socketState}
          </Tag>
        </div>
        <div className="console__actions">
          <Button size="small" onClick={startSocket} disabled={socketState === 'open'}>
            {DIAGNOSTICS_PATH} {socketState === 'open' ? 'connected' : 'not connected'}
          </Button>
          <Button size="small" onClick={sendPing} disabled={socketState !== 'open'}>
            Ping diagnostics
          </Button>
          <Button size="small" onClick={() => setShowSocket((value) => !value)} aria-expanded={showSocket}>
            {showSocket ? 'Hide reply' : 'Show reply'}
          </Button>
        </div>
        {socketError !== null && <p className="console__alert">{socketError}</p>}
        {showSocket && lastReply !== null && <CodeBlock code={lastReply} />}
        {showSocket && lastReply === null && <p className="console__hint">No diagnostics reply yet.</p>}
      </Card>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Application console. Everything rendered here comes from pure view
 * state; dispatch, playback and receipt observation live in their own
 * modules and are injected.
 * ------------------------------------------------------------------ */

export function ConsoleApp({
  transportFactory,
  performerFactory,
  requestOperatorToken,
  playbackFactory,
}: ConsoleAppProps) {
  const [state, setState] = useState<ConsoleState>(createInitialConsoleState)
  const [source, setSource] = useState<InputSource>('local-audience')
  const [draft, setDraft] = useState('')
  const [playbackMounted, setPlaybackMounted] = useState(false)
  const [machineState, setMachineState] = useState<PerformerState | null>(null)
  const [recoveryAcknowledged, setRecoveryAcknowledged] = useState(false)
  const [operatorRequestPending, setOperatorRequestPending] = useState(false)
  const [operatorRequestError, setOperatorRequestError] = useState<string | null>(null)

  const transportRef = useRef<ConsoleTransportPort | null>(null)
  const playbackRef = useRef<PlaybackBinding | null>(null)
  const machineRef = useRef<PerformerMachine | null>(null)
  const stateRef = useRef(state)
  const counterRef = useRef(0)

  // Mirror the latest view state for event handlers, which must read it outside
  // render. Writing the ref during render is not allowed.
  useEffect(() => {
    stateRef.current = state
  }, [state])

  const nextId = useCallback((prefix: string): string => {
    counterRef.current += 1
    return `${prefix}-${counterRef.current}-${Date.now().toString(36)}`
  }, [])

  useEffect(() => {
    let cancelled = false
    const applyStatus = (connection: ConnectionStatus, detail: string | null): void => {
      if (cancelled) return
      setState((current) => withConnection(current, connection, detail))
      if (connection !== 'open') {
        // A lost or uncertain transport disposes the machine and stops the
        // fallback playback; the console stays non-dispatching and never
        // reconnects, replays or resumes on its own.
        machineRef.current?.dispose('transport closed')
        playbackRef.current?.cancelLocal()
      }
    }
    const transport = transportFactory({
      onStatus: applyStatus,
      onProtocolViolation: (detail) => {
        if (cancelled) return
        setState((current) => withError(current, { requestId: null, code: 'invalid_field', message: detail }))
      },
    })
    transportRef.current = transport

    const application = isApplicationTransport(transport) ? transport : null
    // An application transport without a performer factory is never silently
    // downgraded to the legacy binding.
    if (application !== null && performerFactory === undefined) {
      const detail = 'this build has no performer machine for the application transport'
      setState((current) => withConnection(current, 'error', detail))
      transport.close()
      transportRef.current = null
      return () => {
        cancelled = true
      }
    }

    // Messages that arrive after bootstrap resolution but before the machine
    // exists are queued and replayed in order, exactly once.
    let machineReady = false
    let queued: readonly ApplicationServerMessage[] = []

    const unsubscribeApplication =
      application === null
        ? null
        : application.onApplicationMessage((message) => {
            setState((current) => reduceApplicationMessage(current, message))
            if (!machineReady) {
              queued = [...queued, message]
              return
            }
            machineRef.current?.handleMessage(message)
          })

    const unsubscribeBase =
      application === null
        ? transport.onServerMessage((message: ServerMessage) => {
            setState((current) => reduceServerMessage(current, message))
            playbackRef.current?.handleServerMessage(message)
          })
        : null

    void (async () => {
      try {
        const bootstrap: BootstrapSnapshot = await transport.bootstrap()
        if (cancelled) return
        setState((current) => withBootstrap(current, bootstrap))
        if (application !== null) {
          const hooks: PerformerMachineHooks = {
            onReceipt: (receipt) => {
              if (cancelled) return
              setState((current) => withReceipt(current, receipt))
            },
            onStateChanged: () => {
              if (cancelled) return
              const machine = machineRef.current
              if (machine === null) return
              const next = machine.state()
              setState((current) => {
                const projected = withPlaybackStatus(current, next.playerStatus)
                return next.display.subtitle === null ? projected : withSubtitle(projected, next.display.subtitle)
              })
              setMachineState(next)
            },
            onServiceError: (_raw, reason) => {
              if (cancelled) return
              setState((current) => withError(current, { requestId: null, code: 'invalid_field', message: reason }))
            },
          }
          const createMachine = performerFactory
          if (createMachine === undefined) return
          const machine = createMachine(bootstrap, application, hooks)
          machineRef.current = machine
          // Seed the identity before replaying anything that arrived early.
          machine.handleMessage(snapshotMessageFromBootstrap(bootstrap))
          machineReady = true
          const replay = queued
          queued = []
          for (const message of replay) {
            if (cancelled) return
            machine.handleMessage(message)
          }
          setMachineState(machine.state())
          return
        }
        if (playbackFactory === undefined) return
        const callbacks: PlaybackCallbacks = {
          onReceipt: (receipt) => setState((current) => withReceipt(current, receipt)),
          onStatus: (status) => setState((current) => withPlaybackStatus(current, status)),
          onSubtitle: (subtitleText) => setState((current) => withSubtitle(current, subtitleText)),
          onFault: (message) => setState((current) => withFault(current, message)),
        }
        playbackRef.current = playbackFactory(bootstrap, callbacks)
        setPlaybackMounted(true)
      } catch (error) {
        if (cancelled) return
        setState((current) => withConnection(current, 'error', identify(error)))
      }
    })()

    return () => {
      cancelled = true
      unsubscribeApplication?.()
      unsubscribeBase?.()
      machineRef.current?.dispose('console unmounted')
      machineRef.current = null
      playbackRef.current?.dispose()
      playbackRef.current = null
      transportRef.current = null
      transport.close()
    }
  }, [transportFactory, performerFactory, playbackFactory])

  const dispatchable = canDispatch(state)

  const machine = machineState

  const submitInput = useCallback(async () => {
    const current = stateRef.current
    const session = current.session
    const text = draft.trim()
    const transport = transportRef.current
    if (transport === null || session === null || !canDispatch(current) || text.length === 0) return
    const message: InputSubmitMessage = {
      protocolVersion: APPLICATION_CONTRACT_VERSION,
      messageId: nextId('input'),
      sessionId: session.sessionId,
      epoch: session.epoch,
      kind: 'input.submit',
      payload: { source, text },
    }
    if (transport !== null && isApplicationTransport(transport)) {
      // The machine path never awaits a transport promise: the application
      // listener applies the acknowledgement when it arrives.
      const activeMachine = machineRef.current
      if (activeMachine === null || current.session?.retiring === true) return
      setState((previous) => withPendingInput(previous, message))
      setDraft('')
      let accepted: string | null = null
      try {
        accepted = activeMachine.input(text, message.messageId, source)
      } catch (error) {
        setState((previous) => withInputFailure(previous, message.messageId, identify(error)))
        notificationOpen({ type: 'error', message: 'Input dispatch failed', description: identify(error) })
        return
      }
      if (accepted === null) {
        setState((previous) =>
          withInputFailure(previous, message.messageId, 'the performer machine refused the input'),
        )
      }
      return
    }
    setState((previous) => withPendingInput(previous, message))
    setDraft('')
    try {
      const ack = await transport.sendInput(message)
      setState((previous) => reduceInputAck(previous, ack))
      if (ack.status === 'rejected') {
        notificationOpen({
          type: 'error',
          message: 'Input rejected',
          description: `${ack.code}: ${ack.message}`,
          duration: 4,
        })
      } else {
        notificationOpen({
          type: ack.status === 'accepted' ? 'success' : 'info',
          message: `Input ${ack.status}`,
          description: `${ack.eventId} at sequence ${ack.seq}`,
          duration: 3,
        })
      }
    } catch (error) {
      setState((previous) => withInputFailure(previous, message.messageId, identify(error)))
      notificationOpen({ type: 'error', message: 'Input dispatch failed', description: identify(error) })
    }
  }, [draft, nextId, source])

  const sendControl = useCallback(
    async (action: 'stop' | 'resume') => {
      const current = stateRef.current
      const session = current.session
      const transport = transportRef.current
      if (transport === null || session === null || !canDispatch(current)) return
      const requestId = nextId(`control-${action}`)
      const message: ControlStopMessage | ControlResumeMessage =
        action === 'stop'
          ? {
              protocolVersion: APPLICATION_CONTRACT_VERSION,
              messageId: nextId('control'),
              sessionId: session.sessionId,
              epoch: session.epoch,
              kind: 'control.stop',
              payload: { requestId },
            }
          : {
              protocolVersion: APPLICATION_CONTRACT_VERSION,
              messageId: nextId('control'),
              sessionId: session.sessionId,
              epoch: session.epoch,
              kind: 'control.resume',
              payload: { requestId },
            }
      if (isApplicationTransport(transport)) {
        // The acknowledgement is applied by the application listener.
        const activeMachine = machineRef.current
        if (activeMachine === null || current.session?.retiring === true) return
        setState((previous) => withPendingControl(previous, message))
        let accepted: string | null = null
        try {
          accepted =
            action === 'stop'
              ? activeMachine.stop(requestId, message.messageId)
              : activeMachine.resume(requestId, message.messageId)
        } catch (error) {
          setState((previous) => withControlFailure(previous, requestId, identify(error)))
          notificationOpen({ type: 'error', message: `Control ${action} failed`, description: identify(error) })
          return
        }
        if (accepted === null) {
          setState((previous) =>
            withControlFailure(previous, requestId, 'the performer machine refused the control request'),
          )
        }
        return
      }
      setState((previous) => withPendingControl(previous, message))
      try {
        const ack = await transport.sendControl(message)
        setState((previous) => reduceControlAck(previous, ack))
        notificationOpen({
          type: ack.status === 'applied' ? 'success' : ack.status === 'refused' ? 'error' : 'info',
          message: `Control ${action} ${ack.status}`,
          description: `epoch ${ack.previousEpoch} -> ${ack.epoch} · lifecycle ${ack.lifecycle}`,
        })
      } catch (error) {
        setState((previous) => withControlFailure(previous, requestId, identify(error)))
        notificationOpen({ type: 'error', message: `Control ${action} failed`, description: identify(error) })
      }
    },
    [nextId],
  )

  const attachPerformer = useCallback(() => {
    const activeMachine = machineRef.current
    if (activeMachine === null) return
    try {
      activeMachine.attach()
    } catch (error) {
      setState((previous) =>
        withError(previous, { requestId: null, code: 'invalid_field', message: identify(error) }),
      )
    }
  }, [])

  const bootstrapOperator = useCallback(async () => {
    if (requestOperatorToken === undefined) return
    const activeMachine = machineRef.current
    if (activeMachine === null) return
    setOperatorRequestPending(true)
    setOperatorRequestError(null)
    let token: string
    try {
      token = await requestOperatorToken()
    } catch {
      // The token never enters an error message; only a generic failure is shown.
      setOperatorRequestPending(false)
      setOperatorRequestError('operator bootstrap failed')
      return
    }
    setOperatorRequestPending(false)
    try {
      // The token is exchanged once and then discarded; it is never stored.
      activeMachine.bootstrapOperator(token)
    } catch {
      setOperatorRequestError('operator bootstrap could not be sent')
    }
  }, [requestOperatorToken])

  const requestRecovery = useCallback(() => {
    const activeMachine = machineRef.current
    if (activeMachine === null) return
    const current = stateRef.current
    const eligibility = recoveryControlView({
      connection: current.connection,
      hasSession: current.session !== null,
      machine: activeMachine.state(),
      acknowledged: recoveryAcknowledged,
    })
    // A rendered control may be stale by one event. Re-check the same pure
    // eligibility before mutating so a lost transport or disposed machine never
    // records a request that was not sent.
    if (!eligibility.requestable) return
    try {
      if (activeMachine.recover() === null) return
    } catch {
      return
    }
    setRecoveryAcknowledged(false)
  }, [recoveryAcknowledged])

  const session = state.session
  const connectionSummary =
    session === null
      ? 'no session snapshot yet'
      : `session ${session.sessionId} · epoch ${session.epoch} · lifecycle ${session.lifecycle}`
  const dispatchSummary =
    session === null
      ? 'unknown'
      : `${session.activeTurnId === null ? 'no active turn' : `turn ${session.activeTurnId}`} · performer ${session.performerStatus}`

  const inputRows: readonly (readonly [string, string])[] = [
    ['Session', session === null ? 'unknown' : session.sessionId],
    ['Epoch', session === null ? 'unknown' : String(session.epoch)],
    ['Lifecycle', session === null ? 'unknown' : session.lifecycle],
    ['Active turn', session === null ? 'unknown' : (session.activeTurnId ?? 'none')],
    ['Performer', session === null ? 'unknown' : session.performerStatus],
    ['Output confirmation', session === null ? 'unknown' : session.outputConfirmation],
    ['Capability revision', session === null ? 'unknown' : String(session.capabilityRevision)],
    ['Accepted sequence', session === null ? 'unknown' : String(session.lastSeq)],
    ['Retiring', session === null ? 'unknown' : session.retiring ? 'yes' : 'no'],
  ]

  const playbackRows: readonly (readonly [string, string])[] = [
    ['Idle', String(state.playback.idle)],
    ['Active output', state.playback.activeOutputId ?? 'none'],
    ['Last stage', state.playback.lastStage ?? 'none'],
    ['Last subtitle', state.playback.subtitleText ?? 'none'],
  ]

  const selection = state.selection
  const plan = selection.plan
  const selectionRows: readonly (readonly [string, string])[] = [
    ['Waiting stage', selection.stage],
    ['Plan disposition', plan === null ? 'none' : plan.disposition],
    ['Selected event ids', plan === null ? 'none' : plan.selectedEventIds.join(', ') || 'none'],
    ['Reply intent', plan === null ? 'none' : (plan.replyIntent ?? 'none')],
    ['Plan reason code', plan === null ? 'none' : plan.reasonCode],
    ['Plan synthetic', plan === null ? 'unknown' : plan.synthetic ? 'yes' : 'no'],
    ['Turn reply intent', selection.replyIntent === null ? 'none' : selection.replyIntent.replyIntent],
    [
      'Turn id',
      selection.replyIntent === null
        ? 'none'
        : selection.replyIntent.turnId === null
          ? 'not reported'
          : selection.replyIntent.turnId,
    ],
    [
      'Delivery classification',
      selection.serverDelivery === null ? 'none' : selection.serverDelivery.classification,
    ],
    [
      'Delivery output',
      selection.serverDelivery === null
        ? 'none'
        : selection.serverDelivery.outputId === null
          ? 'not reported'
          : selection.serverDelivery.outputId,
    ],
    [
      'Delivery turn',
      selection.serverDelivery === null
        ? 'none'
        : selection.serverDelivery.turnId === null
          ? 'not reported'
          : selection.serverDelivery.turnId,
    ],
    [
      'Delivery segment',
      selection.serverDelivery === null
        ? 'none'
        : selection.serverDelivery.segmentId === null
          ? 'not reported'
          : selection.serverDelivery.segmentId,
    ],
  ]

  const machinePath = machine !== null
  const retiring = session?.retiring === true
  const allowDispatch = dispatchable && (!machinePath || !retiring)
  const operatorButtonVisible = requestOperatorToken !== undefined && machinePath
  const recovery = machine?.recovery
  // Recovery does not wait for `retiring`: the runtime only retires the session
  // after the operator's first valid request. Eligibility requires the current
  // connected session, an attached performer, operator authority, an explicit
  // acknowledgement and a machine that has not been disposed.
  const recoveryControls = recoveryControlView({
    connection: state.connection,
    hasSession: session !== null,
    machine,
    acknowledged: recoveryAcknowledged,
  })
  const recoveryAvailable = recoveryControls.available
  const recoveryRequestable = recoveryControls.requestable

  const sessionView = (
    <div className="console__stack">
      <Card>
        <div className="console__card-head">
          <Title size="middle">Session</Title>
          <Tag variant="soft" color={session === null ? 'app-orange' : 'app-teal'}>
            {dispatchable ? 'dispatching' : 'non-dispatching'}
          </Tag>
        </div>
        <Facts rows={inputRows} />
        <p className="console__hint">{dispatchSummary}</p>
      </Card>

      <Card>
        <Title size="middle">Input</Title>
        <form
          className="console__form"
          onSubmit={(event) => {
            event.preventDefault()
            void submitInput()
          }}
        >
          <div className="console__field">
            <span className="console__label" id="console-source-label">
              Input source
            </span>
            <Select
              aria-labelledby="console-source-label"
              options={SOURCE_OPTIONS}
              value={source}
              disabled={!allowDispatch}
              onChange={(key) => {
                if (isInputSource(key)) setSource(key)
              }}
            />
          </div>
          <div className="console__field">
            <label className="console__label" htmlFor="console-text">
              Message text
            </label>
            <Input
              id="console-text"
              value={draft}
              disabled={!allowDispatch}
              placeholder="Type an audience message"
              allowClear
              onClear={() => setDraft('')}
              onChange={(event) => setDraft(event.target.value)}
            />
          </div>
          <Button
            type="primary"
            htmlType="submit"
            icon={<SendIcon size={20} />}
            disabled={!allowDispatch || draft.trim().length === 0}
          >
            Submit input
          </Button>
        </form>
        {state.inputs.length === 0 ? (
          <p className="console__hint">No input requests yet.</p>
        ) : (
          <ul className="console__list">
            {[...state.inputs].reverse().map((input) => (
              <li
                key={input.messageId}
                className={classNames('console__list-item', {
                  'console__list-item--pending': input.outcome === 'pending',
                })}
              >
                <Tag size="small" variant="soft" color={OUTCOME_COLORS[input.outcome]}>
                  {input.outcome}
                </Tag>
                <span className="console__list-text">{input.text}</span>
                <span className="console__list-meta">
                  {input.source}
                  {input.eventId === null ? '' : ` · ${input.eventId}`}
                  {input.seq === null ? '' : ` · seq ${input.seq}`}
                </span>
                {input.detail !== null && <span className="console__list-detail">{input.detail}</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <Title size="middle">Control</Title>
        <div className="console__actions">
          <Button danger icon={<StopIcon size={20} />} disabled={!allowDispatch} onClick={() => void sendControl('stop')}>
            Stop
          </Button>
          <Button icon={<PlayIcon size={20} />} disabled={!allowDispatch} onClick={() => void sendControl('resume')}>
            Resume
          </Button>
        </div>
        <p className="console__hint">
          Stop and Resume are the only authorized controls. They are dispatched as requests; the runtime decides the
          resulting epoch and lifecycle.
        </p>
        {state.controls.length === 0 ? (
          <p className="console__hint">No control requests yet.</p>
        ) : (
          <ul className="console__list">
            {[...state.controls].reverse().map((control) => (
              <li
                key={control.messageId}
                className={classNames('console__list-item', {
                  'console__list-item--pending': control.outcome === 'pending',
                })}
              >
                <Tag size="small" variant="soft" color={OUTCOME_COLORS[control.outcome]}>
                  {control.outcome}
                </Tag>
                <span className="console__list-text">{control.action}</span>
                <span className="console__list-meta">
                  {control.previousEpoch === null || control.epoch === null
                    ? control.requestId
                    : `epoch ${control.previousEpoch} -> ${control.epoch}`}
                </span>
                {control.detail !== null && <span className="console__list-detail">{control.detail}</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <div className="console__card-head">
          <Title size="middle">Performer and authority</Title>
          <Tag variant="soft" color={machine === null ? 'app-orange' : machine.performer ? 'app-green' : 'app-yellow'}>
            {machine === null
              ? 'no machine'
              : machine.performer
                ? 'attached'
                : 'not attached'}
          </Tag>
        </div>
        <div className="console__actions">
          <Button size="small" disabled={!machinePath} onClick={attachPerformer}>
            Attach performer
          </Button>
          {operatorButtonVisible && (
            <Button size="small" loading={operatorRequestPending} onClick={() => void bootstrapOperator()}>
              Bootstrap operator
            </Button>
          )}
          {machine !== null && machine.operator && (
            <Tag variant="outlined" color="app-teal">
              operator
            </Tag>
          )}
        </div>
        <Facts
          rows={[
            ['Performer attached', machine === null ? 'unknown' : machine.performer ? 'yes' : 'no'],
            ['Operator authority', machine === null ? 'unknown' : machine.operator ? 'yes' : 'no'],
            ['Session retiring', session === null ? 'unknown' : session.retiring ? 'yes' : 'no'],
          ]}
        />
        {operatorRequestError !== null && <p className="console__alert">{operatorRequestError}</p>}
        {machine?.error !== undefined && machine.error !== null && <p className="console__alert">{machine.error}</p>}
        <Divider type="hairline" />
        <Title size="middle">Recovery</Title>
        <p className="console__hint">
          Recovery is an operator decision, not measured delivery. It retires this session and continues in a fresh
          successor over the same store. The first request does not require retirement to be reported: the server
          starts retirement only after a valid request, so acknowledge below and request recovery once the performer
          and operator are attached to this connected session. A successor session requires reconnect, operator
          bootstrap and performer attach, followed by an explicit Resume. A failed attempt remains retryable, so
          acknowledge again and request recovery once more.
        </p>
        <Checkbox
          size="small"
          direction="vertical"
          options={[
            {
              label:
                "I acknowledge, as the operator's decision, that local playback in this session has ended.",
              value: 'recovery-ack',
            },
          ]}
          value={recoveryAcknowledged ? ['recovery-ack'] : []}
          disabled={!recoveryAvailable}
          onChange={(values) => setRecoveryAcknowledged(values.includes('recovery-ack'))}
        />
        <div className="console__actions">
          <Button
            size="small"
            danger
            disabled={!recoveryRequestable}
            onClick={requestRecovery}
          >
            Request recovery
          </Button>
        </div>
        <Facts
          rows={[
            ['Recovery status', recovery === undefined ? 'none' : recovery.status],
            ['Retired session', recovery?.retiredSessionId ?? 'none'],
            ['Successor session', recovery?.successorSessionId ?? 'none'],
            ['Recoveries', recovery === undefined ? 'none' : String(recovery.recoveries)],
            [
              'Remaining recoveries',
              recovery === undefined || recovery.remainingRecoveries === null
                ? 'unknown'
                : String(recovery.remainingRecoveries),
            ],
          ]}
        />
      </Card>

      <Card>
        <div className="console__card-head">
          <Title size="middle">Selection and delivery</Title>
          <Tag variant="outlined" color="app-blue">
            runtime-reported
          </Tag>
        </div>
        <Facts rows={selectionRows} />
        <p className="console__hint">
          These facts are reported by the runtime as accepted session events. They are not local playback evidence and
          do not prove that this browser released media.
        </p>
        <Divider type="hairline" />
        <Title size="middle">Accepted inputs</Title>
        {selection.acceptedInputs.length === 0 ? (
          <p className="console__hint">No accepted inputs observed.</p>
        ) : (
          <ul className="console__list">
            {[...selection.acceptedInputs].reverse().map((entry) => (
              <li key={entry.eventId} className="console__list-item">
                <Tag size="small" variant="soft" color="app-teal">
                  #{entry.seq}
                </Tag>
                <span className="console__list-text">{entry.text}</span>
                <span className="console__list-meta">
                  {entry.source} · {entry.eventId}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <div className="console__card-head">
          <Title size="middle">Playback and receipts</Title>
          <Tag variant="outlined" color="app-yellow">
            local evidence only
          </Tag>
        </div>
        <Facts rows={playbackRows} />
        <p className="console__hint">
          {machinePath
            ? 'Receipts here are observed in this browser and are local evidence only. They are distinct from the runtime-reported delivery in the Selection and delivery card; local observation is not runtime confirmation.'
            : playbackMounted
              ? 'Receipts here are observed in this browser and are local evidence only. The fallback binding exposes no runtime-confirmed delivery; the runtime-reported delivery is never claimed from these observations.'
              : 'No local player is mounted for this console; playback cannot be observed here.'}
        </p>
        {state.playback.receipts.length === 0 ? (
          <p className="console__hint">No receipts observed.</p>
        ) : (
          <ul className="console__list">
            {[...state.playback.receipts].reverse().map((receipt) => (
              <li key={receipt.receiptId} className="console__list-item">
                <Tag size="small" variant="soft" color="app-teal">
                  {receipt.stage}
                </Tag>
                <span className="console__list-text">{receipt.outputId}</span>
                <span className="console__list-meta">
                  {receipt.modality}
                  {receipt.reasonCode === null ? '' : ` · ${receipt.reasonCode}`}
                  {receipt.localTimeMs === null ? '' : ` · ${receipt.localTimeMs} ms`}
                </span>
              </li>
            ))}
          </ul>
        )}
        {state.playback.faults.length > 0 && (
          <>
            <Divider type="hairline" />
            <ul className="console__list">
              {[...state.playback.faults].reverse().map((fault, index) => (
                <li key={`${index}-${fault}`} className="console__list-item">
                  <Tag size="small" variant="soft" color="app-red">
                    fault
                  </Tag>
                  <span className="console__list-detail">{fault}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      <Card>
        <Title size="middle">Events and errors</Title>
        <p className="console__hint">Only events above the accepted sequence are shown; replayed history is never rendered.</p>
        {state.events.length === 0 ? (
          <p className="console__hint">No new events.</p>
        ) : (
          [...state.events]
            .reverse()
            .map((event) => (
              <Collapse
                key={event.seq}
                question={`#${event.seq} ${event.type}`}
                answer={<CodeBlock code={JSON.stringify(event.data, null, 2)} />}
              />
            ))
        )}
        {state.errors.length > 0 && (
          <>
            <Divider type="hairline" />
            <ul className="console__list">
              {[...state.errors].reverse().map((error, index) => (
                <li key={`${index}-${error.code}-${error.message}`} className="console__list-item">
                  <Tag size="small" variant="soft" color="app-red">
                    {error.code}
                  </Tag>
                  <span className="console__list-detail">{error.message}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </div>
  )

  return (
    <main className="console">
      <header className="console__header">
        <Title size="large">Isla runtime console</Title>
        <p className="console__subtitle">
          Local control surface for application contract {APPLICATION_CONTRACT_VERSION}. Input, control and playback
          evidence only; diagnostics stay on their own protocol.
        </p>
        <div className="console__connection" role="status" aria-atomic="true">
          <Badge dot color={CONNECTION_COLORS[state.connection]} />
          <span className="console__connection-label">{state.connection}</span>
          <span className="console__connection-detail">{connectionSummary}</span>
        </div>
        {state.connectionDetail !== null && <p className="console__hint">{state.connectionDetail}</p>}
      </header>

      <Divider type="dashed-brown" />

      <Tabs
        aria-label="Console sections"
        defaultActiveKey="session"
        items={[
          { key: 'session', label: 'Session', children: sessionView },
          { key: 'diagnostics', label: 'Diagnostics', children: <DiagnosticsPanel /> },
        ]}
      />

      <p className="console__footnote">
        Diagnostic protocol {DIAGNOSTICS_PROTOCOL_VERSION} is deliberately separate from application contract{' '}
        {APPLICATION_CONTRACT_VERSION}; the diagnostics tab never drives session behaviour.
      </p>
    </main>
  )
}
