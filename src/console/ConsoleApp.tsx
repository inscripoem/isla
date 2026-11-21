import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import {
  APPLICATION_CONTRACT_VERSION,
  DIAGNOSTICS_PROTOCOL_VERSION,
  type ApplicationServerMessage,
  type BootstrapSnapshot,
  type ConsoleTransportPort,
  type ControlResumeMessage,
  type ControlStopMessage,
  type InputSource,
  type InputSubmitMessage,
  type ServerMessage,
} from '../contracts'
import { ConsoleTransportError, isApplicationTransport, type ConsoleApplicationTransport } from './app-transport'
import type { PlaybackBinding, PlaybackCallbacks, PlaybackFactory } from './player-binding'
import type { PerformerMachine, PerformerMachineHooks, PerformerState } from './performer-machine'
import { snapshotMessageFromBootstrap } from './performer-adapter'
import { recoveryControlView } from './recovery-control'
import { AudioBars, Glyph, HandwrittenIslaStudio, KanbanRow, Particle, PopNum, Tag } from './design/ui'
import { OutcomeRing, SeqTicker, SourceBars } from './design/charts'
import { capWord } from './design/format'
import { toast } from './design/toast'
import { DepthLayers } from './fx/depth'
import { CursorLayer } from './fx/cursor'
import { useTypewriter } from './fx/typewriter'
import { ControlDeck, EventsSection, SessionFacts } from './pages/SessionPage'
import { PlaybackSection } from './pages/PlaybackPage'
import { PipelineStepper, SelectionSection } from './pages/SelectionPage'
import { DiagnosticsPage } from './pages/DiagnosticsPage'
import type { ConnectionStatus, ConsoleState } from './console-state'
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
} from './console-state'
import './console.css'

const LIVE_CLASS: Record<ConnectionStatus, string> = {
  connecting: 'connecting',
  open: 'open',
  closed: 'closed',
  error: 'error',
}

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

/**
 * Console error fence: a render fault must never blank the operator surface.
 * It names the failure and keeps the rest of the cockpit visible.
 */
class ConsoleErrorFence extends Component<{ children: ReactNode; area: string }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`console ${this.props.area} render fault`, error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="isla-card isla-card--orange" role="alert">
          <h2 className="isla-card__title">console fault — {this.props.area}</h2>
          <pre className="isla-code">{this.state.error.message}</pre>
          <p className="isla-hint">{String(this.state.error.stack ?? '').slice(0, 600)}</p>
        </div>
      )
    }
    return this.props.children
  }
}

/**
 * The Isla cockpit: one screen, everything visible. The stage is the
 * permanent centre of the console; the operator panels sit beside it as
 * glass sections. Everything rendered here comes from pure view state;
 * dispatch, playback and receipt observation live in their own modules and
 * are injected. Behaviour — transport bootstrap, performer machine wiring,
 * request correlation, the honesty rules — is unchanged from the M2
 * conformance baseline; only the visual voice and the single-surface layout
 * are new.
 */
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
  /** Brand board: the handwritten ISLA holds, then flips out to the kanban cast.
   * Reduced-motion sessions park on the mascots from the first render. */
  const [brandFace, setBrandFace] = useState<'write' | 'kanban'>(() =>
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'kanban'
      : 'write',
  )
  const [brandCycle, setBrandCycle] = useState(0)
  /** Local stage presentation (player bar): danmaku overlay and cinema dim. */
  const [danmakuOn, setDanmakuOn] = useState(true)
  const [cinema, setCinema] = useState(false)
  /** Audience display: local view switch and a freeze control. */
  const [displayView, setDisplayView] = useState<'feed' | 'sources' | 'outcomes'>('feed')
  const [displayFrozen, setDisplayFrozen] = useState<readonly { readonly seq: number; readonly source: string; readonly text: string }[] | null>(null)
  /** Status window: one large rolling bar cycling the stage messages. */
  const [statusExpanded, setStatusExpanded] = useState(false)
  const [statusIndex, setStatusIndex] = useState(0)

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

  // The brand board timeline: the whole "ISLA STUDIO" signature handwrites
  // (~5.2s), holds, then the ENTIRE line flips over to the kanban cast; a
  // later cycle flips back and replays the strokes. Reduced-motion sessions
  // park on the mascots.
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let mounted = true
    const timers: number[] = []
    const cycle = (): void => {
      setBrandFace('write')
      setBrandCycle((value) => value + 1)
      timers.push(
        window.setTimeout(() => {
          if (mounted) setBrandFace('kanban')
        }, 6800),
      )
    }
    cycle()
    const interval = window.setInterval(cycle, 14500)
    return () => {
      mounted = false
      window.clearInterval(interval)
      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [])

  const stageRef = useRef<HTMLDivElement | null>(null)
  const toggleFullscreen = useCallback(() => {
    const stage = stageRef.current
    if (stage === null) return
    if (document.fullscreenElement === stage) {
      void document.exitFullscreen().catch(() => undefined)
    } else if (stage.requestFullscreen !== undefined) {
      void stage.requestFullscreen().catch(() => undefined)
    }
  }, [])

  // Player-bar keyboard shortcuts. Typing inside the composer is never
  // intercepted, and none of these touch session or playback state: they are
  // local presentation toggles only.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return
      }
      const key = event.key.toLowerCase()
      if (key === 'd') setDanmakuOn((value) => !value)
      else if (key === 'c') setCinema((value) => !value)
      else if (key === 'f') toggleFullscreen()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleFullscreen])

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

    const bootstrapApplication = async (): Promise<void> => {
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
    }

    // React StrictMode mounts, runs effects, and immediately runs their cleanup
    // in development. The zero-delay timer lets that discarded initial effect's
    // cleanup cancel bootstrap before that mount starts a WebSocket.
    const bootstrapTimer = setTimeout(() => {
      if (cancelled) return
      void bootstrapApplication()
    }, 0)

    return () => {
      cancelled = true
      clearTimeout(bootstrapTimer)
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
        toast({ type: 'error', message: 'Input dispatch failed', description: identify(error) })
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
        toast({
          type: 'error',
          message: 'Input rejected',
          description: `${ack.code}: ${ack.message}`,
          duration: 4,
        })
      } else {
        toast({
          type: ack.status === 'accepted' ? 'success' : 'info',
          message: `Input ${ack.status}`,
          description: `${ack.eventId} at sequence ${ack.seq}`,
          duration: 3,
        })
      }
    } catch (error) {
      setState((previous) => withInputFailure(previous, message.messageId, identify(error)))
      toast({ type: 'error', message: 'Input dispatch failed', description: identify(error) })
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
          toast({ type: 'error', message: `Control ${action} failed`, description: identify(error) })
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
        toast({
          type: ack.status === 'applied' ? 'success' : ack.status === 'refused' ? 'error' : 'info',
          message: `Control ${action} ${ack.status}`,
          description: `epoch ${ack.previousEpoch} -> ${ack.epoch} · lifecycle ${ack.lifecycle}`,
        })
      } catch (error) {
        setState((previous) => withControlFailure(previous, requestId, identify(error)))
        toast({ type: 'error', message: `Control ${action} failed`, description: identify(error) })
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
      ? 'No session snapshot yet'
      : `Session ${session.sessionId} · epoch ${session.epoch} · lifecycle ${session.lifecycle}`

  const machinePath = machine !== null
  const retiring = session?.retiring === true
  const allowDispatch = dispatchable && (!machinePath || !retiring)
  const operatorButtonVisible = requestOperatorToken !== undefined && machinePath
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

  const localEvidenceNote = machinePath
    ? 'Receipts here are observed in this browser and are local evidence only. They are distinct from the runtime-reported delivery in the plan panel; local observation is not runtime confirmation.'
    : playbackMounted
      ? 'Receipts here are observed in this browser and are local evidence only. The fallback binding exposes no runtime-confirmed delivery; the runtime-reported delivery is never claimed from these observations.'
      : 'No local player is mounted for this console; playback cannot be observed here.'

  // The stage is the permanent centre of the cockpit: its subtitle streams
  // here and its facts read out below it.
  const { shown, typing } = useTypewriter(state.playback.subtitleText)
  const speaking = !state.playback.idle && state.playback.lastStage !== null && state.playback.lastStage !== 'completed'
  // Audience data charts: everything below is derived from what the console
  // actually observed — accepted inputs, request outcomes and the rolling
  // sequence feed. Nothing is invented.
  const sourceBars = useMemo(() => {
    const counts = new Map<string, number>()
    for (const entry of state.selection.acceptedInputs) {
      counts.set(entry.source, (counts.get(entry.source) ?? 0) + 1)
    }
    return [...counts.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count)
  }, [state.selection.acceptedInputs])

  const outcomeSlices = useMemo(() => {
    const order = ['accepted', 'duplicate', 'rejected', 'pending', 'unknown']
    const counts = new Map<string, number>()
    for (const input of state.inputs) {
      counts.set(input.outcome, (counts.get(input.outcome) ?? 0) + 1)
    }
    return order.filter((label) => counts.has(label)).map((label) => ({ label, count: counts.get(label) ?? 0 }))
  }, [state.inputs])

  const tickerPoints = useMemo(
    () =>
      state.selection.acceptedInputs.slice(-20).map((entry) => ({
        seq: entry.seq,
        label: `${entry.source}: ${entry.text.slice(0, 28)}`,
      })),
    [state.selection.acceptedInputs],
  )

  // Roll the status bar every 2.8s; hovering the window pauses it via CSS
  // is not needed — the record expander freezes it for careful reading.
  useEffect(() => {
    if (statusExpanded) return
    const interval = window.setInterval(() => {
      setStatusIndex((value) => value + 1)
    }, 2800)
    return () => window.clearInterval(interval)
  }, [statusExpanded])

  // Frozen copy for the display freeze toggle: refreshed on every render
  // while live, held constant while frozen.
  const feedSnapshot = state.selection.acceptedInputs.slice(-7).map((entry) => ({
    seq: entry.seq,
    source: entry.source,
    text: entry.text,
  }))

  const subtitle = state.playback.subtitleText
  // The status window messages: human phrasing on the ticker, the exact
  // protocol values in the expandable records.
  const statusMessages: readonly { readonly label: string; readonly tile: string; readonly value: string; readonly text: string }[] = [
    {
      label: 'Idle',
      tile: 'Idle',
      value: String(state.playback.idle),
      text: state.playback.idle ? 'Stage is idle' : 'Stage is performing',
    },
    {
      label: 'Active output',
      tile: 'Active Output',
      value: state.playback.activeOutputId ?? 'none',
      text: state.playback.activeOutputId === null ? 'No active output' : `Output ${state.playback.activeOutputId}`,
    },
    {
      label: 'Last stage',
      tile: 'Last Stage',
      value: state.playback.lastStage ?? 'none',
      text: state.playback.lastStage === null ? 'No stage activity yet' : `Last stage: ${state.playback.lastStage}`,
    },
    {
      label: 'Last subtitle',
      tile: 'Last Subtitle',
      value: subtitle ?? 'none',
      text: subtitle === null || subtitle.length === 0 ? 'No subtitle yet' : subtitle,
    },
  ]

  return (
    <main className="console">
      <DepthLayers />
      <CursorLayer />

      {/* The Isla Studio lockup floats in the blank sky strip above the HUD,
        * not inside the header. */}
      <div className="console__brandband" role="img" aria-label="Isla Studio">
        <span className={`isla-brand__flip ${brandFace === 'kanban' ? 'is-kanban' : ''}`.trim()}>
          <span className="isla-brand__face isla-brand__face--write" aria-hidden="true">
            <HandwrittenIslaStudio key={`write-${brandCycle}`} className="isla-brand__write" />
          </span>
          <span className="isla-brand__face isla-brand__face--kanban" aria-hidden="true">
            <KanbanRow size={126} />
          </span>
        </span>
      </div>

      <header className="console__header">
        <div className="console__connection" role="status" aria-atomic="true">
          <span className={`isla-live isla-live--${LIVE_CLASS[state.connection]}`}>
            <span className="isla-live__dot" aria-hidden="true" />
            {/* The protocol word stays verbatim for the conformance scripts;
              * the pill shows the capitalized voice beside it. */}
            <span className="console__connection-label isla-visually-hidden">{state.connection}</span>
            <span aria-hidden="true">{capWord(state.connection)}</span>
          </span>
        </div>

        <div className="isla-header__meta">
          <PopNum value={session === null ? 'none' : session.lastSeq}>
            <span className="isla-stat" title={connectionSummary}>
              #{session === null ? '—' : session.lastSeq}
            </span>
          </PopNum>
          <span className="isla-stat" title="application and diagnostics protocol versions">
            app {APPLICATION_CONTRACT_VERSION} · diag {DIAGNOSTICS_PROTOCOL_VERSION}
          </span>
          {session !== null && (
            <Tag tone={state.connection === 'open' ? 'accepted' : state.connection === 'error' ? 'error' : 'pending'} dot pulse={state.connection === 'open'}>
              {session.lifecycle}
            </Tag>
          )}
        </div>

        <span className="console__connection-detail">{connectionSummary}</span>
        {state.connectionDetail !== null && <p className="console__hint">{state.connectionDetail}</p>}
      </header>

      <div className={`console__deck ${cinema ? 'is-cinema' : ''}`.trim()}>
        <section className="console__stagewall" aria-label="Live stage">
          <ConsoleErrorFence area="stage">
            {/* The pipeline runs as a single row above the stage. */}
            <div className="console__piperow isla-rise">
              <PipelineStepper stage={state.selection.stage} />
            </div>

            {/* The stage box: a proper 16:9 live window. */}
            <div ref={stageRef} className="isla-stage console__stagebox isla-rise isla-rise--focus">
              <div className="isla-stage__laser" aria-hidden="true" />
              {danmakuOn && state.selection.acceptedInputs.length > 0 && (
                <div className="isla-stage__danmaku" aria-hidden="true">
                  {state.selection.acceptedInputs.slice(-6).map((entry, index, list) => (
                    <span
                      key={entry.eventId}
                      className="isla-danmaku__item"
                      style={
                        {
                          '--drift': `${10 + (entry.seq % 5)}s`,
                          '--drift-delay': `${(list.length - index) * -1.7}s`,
                          top: `${14 + ((entry.seq * 37) % 52)}%`,
                        } as Record<string, string>
                      }
                    >
                      <span className="isla-danmaku__name">{entry.source}</span>
                      {entry.text}
                    </span>
                  ))}
                </div>
              )}
              <div className="isla-stage__hud">
                <Tag tone={state.connection === 'open' ? 'accepted' : state.connection === 'error' ? 'error' : 'pending'} dot pulse={state.connection === 'open'}>
                  {session === null ? 'No session' : session.lifecycle}
                </Tag>
                <Tag tone="neutral" dot pulse={state.selection.stage === 'speaking'}>
                  {state.selection.stage}
                </Tag>
                <span className="isla-stage__output">
                  {state.playback.idle ? 'No active output' : `Out ${state.playback.activeOutputId ?? 'unknown'}`}
                </span>
              </div>

              {session?.lifecycle === 'stopped' && (
                <div className="isla-stage__stopped" role="status">
                  <span className="isla-stage__stopped-ico" aria-hidden="true">
                    <Glyph name="pause" size={22} />
                  </span>
                  Live stopped
                </div>
              )}
              <div className="isla-stage__viz">
                <AudioBars speaking={speaking && session?.lifecycle !== 'stopped'} />
                <span className="isla-stage__state">
                  <Particle on={!state.playback.idle && session?.lifecycle !== 'stopped'} pulse={speaking} />
                  {session?.lifecycle === 'stopped' ? 'Stopped' : speaking ? 'Speaking' : state.playback.idle ? 'Idle' : 'Live'}
                </span>
              </div>

              {state.playback.subtitleText !== null && state.playback.subtitleText.length > 0 ? (
                <p className="isla-subtitle">
                  {shown}
                  {typing && <span className="isla-subtitle__caret" aria-hidden="true" />}
                </p>
              ) : (
                <p className="isla-subtitle isla-subtitle--empty">Waiting for the next line…</p>
              )}
              {machine?.display.reaction !== null && machine?.display.reaction !== undefined && (
                <span className="isla-reaction" key={machine.display.reaction}>
                  Reaction: <strong>{machine.display.reaction}</strong>
                </span>
              )}

              <div className="isla-player" role="group" aria-label="Local stage player controls">
                <button
                  type="button"
                  className={`isla-player__btn ${danmakuOn ? 'is-on' : ''}`.trim()}
                  aria-pressed={danmakuOn}
                  aria-label="Toggle danmaku comments (shortcut D)"
                  onClick={() => setDanmakuOn((value) => !value)}
                >
                  <Glyph name="danmaku" size={16} />
                </button>
                <span className="isla-player__keys" aria-hidden="true">
                  <kbd>D</kbd>
                  <kbd>C</kbd>
                  <kbd>F</kbd>
                </span>
              </div>
            </div>

            {/* The audience display sits directly beneath the stage: a live-room
              * screen with the rolling input feed and the chart views. */}
            <div className="isla-display isla-rise" aria-label="Audience display">
              <div className="isla-display__bar">
                <span className="isla-display__live">
                  <Particle on={!state.playback.idle} pulse={speaking} />
                  Audience feed
                </span>
                <span className="isla-display__views" role="group" aria-label="Display view">
                  {(['feed', 'sources', 'outcomes'] as const).map((view) => (
                    <button
                      key={view}
                      type="button"
                      className="isla-display__view"
                      aria-pressed={displayView === view}
                      onClick={() => setDisplayView(view)}
                    >
                      {capWord(view)}
                    </button>
                  ))}
                </span>
                <button
                  type="button"
                  className={`isla-player__btn ${displayFrozen === null ? 'is-on' : ''}`.trim()}
                  aria-label={displayFrozen === null ? 'Freeze the audience feed (local view)' : 'Resume the audience feed (local view)'}
                  onClick={() => setDisplayFrozen((current) => (current === null ? feedSnapshot : null))}
                >
                  <Glyph name={displayFrozen === null ? 'pause' : 'play'} size={14} />
                </button>
              </div>
              {displayView === 'feed' && (
                <ul className="isla-display__feed">
                  {(displayFrozen ?? state.selection.acceptedInputs.slice(-7)).map((entry) => (
                    <li key={entry.seq} className="isla-display__row">
                      <span className="isla-display__seq">#{entry.seq}</span>
                      <span className="isla-display__source">
                        <Glyph name={entry.source === 'local-audience' ? 'ticket' : entry.source === 'cohost-text' ? 'mic' : 'plug'} size={13} />
                      </span>
                      <span className="isla-display__text">{entry.text}</span>
                    </li>
                  ))}
                  {(displayFrozen ?? state.selection.acceptedInputs).length === 0 && (
                    <li className="isla-display__row is-empty">No inputs on the feed yet.</li>
                  )}
                </ul>
              )}
              {displayView === 'sources' && <SourceBars entries={sourceBars} />}
              {displayView === 'outcomes' && <OutcomeRing slices={outcomeSlices} />}
              {displayView === 'feed' && <SeqTicker points={tickerPoints} />}
            </div>

            <div className="console__statuswin isla-rise" aria-label="Stage status">
              <div className="console__statuswin-roll" role="status" aria-label="Stage status">
                <div
                  className="console__statuswin-track"
                  style={{ transform: `translateX(-${(statusIndex % statusMessages.length) * 100}%)` }}
                >
                  {statusMessages.map((message) => (
                    <div key={message.label} className="console__statuswin-slide">
                      <span className="console__statuswin-chip">{message.tile}</span>
                      <span className="console__statuswin-big">{message.text}</span>
                    </div>
                  ))}
                </div>
                <div className="console__statuswin-dots">
                  {statusMessages.map((message, index) => (
                    <button
                      key={message.label}
                      type="button"
                      className={`console__statuswin-dot ${index === statusIndex % statusMessages.length ? 'is-here' : ''}`.trim()}
                      aria-label={`Show status: ${message.tile}`}
                      onClick={() => setStatusIndex(index)}
                    />
                  ))}
                </div>
              </div>
              <button
                type="button"
                className={`console__statuswin-expand ${statusExpanded ? 'is-open' : ''}`.trim()}
                aria-expanded={statusExpanded}
                onClick={() => setStatusExpanded((value) => !value)}
              >
                Records
                <span className="isla-collapse__chevron is-collapsed" aria-hidden="true" />
              </button>
              <div className={`console__statuswin-detail ${statusExpanded ? 'is-open' : ''}`.trim()}>
                <div className="console__statuswin-inner">
                  <dl className="facts">
                    {statusMessages.map((message) => [
                      <dt key={`${message.label}-label`}>{message.label}</dt>,
                      <dd key={`${message.label}-value`}>{message.value}</dd>,
                    ])}
                  </dl>
                </div>
              </div>
            </div>
          </ConsoleErrorFence>
        </section>

        <div className="console__panels">
          <ConsoleErrorFence area="panels">
            <ControlDeck
              state={state}
              machine={machine}
              source={source}
              onSourceChange={setSource}
              draft={draft}
              onDraftChange={setDraft}
              allowDispatch={allowDispatch}
              machinePath={machinePath}
              onSubmit={() => void submitInput()}
              onControl={(action: 'stop' | 'resume') => void sendControl(action)}
              onAttach={attachPerformer}
              onBootstrapOperator={() => void bootstrapOperator()}
              operatorPending={operatorRequestPending}
              operatorError={operatorRequestError}
              operatorButtonVisible={operatorButtonVisible}
              recovery={recoveryControls}
              recoveryAcknowledged={recoveryAcknowledged}
              onRecoveryAcknowledge={setRecoveryAcknowledged}
              onRequestRecovery={requestRecovery}
              cinema={cinema}
              onToggleCinema={() => setCinema((value) => !value)}
              onFullscreen={toggleFullscreen}
            />
            <PlaybackSection playback={state.playback} localEvidenceNote={localEvidenceNote} />
            <SessionFacts state={state} machine={machine} />
            <SelectionSection selection={state.selection} />
            <EventsSection state={state} />
            <DiagnosticsPage />
          </ConsoleErrorFence>
        </div>
      </div>

    </main>
  )
}
