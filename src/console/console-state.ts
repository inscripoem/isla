import type {
  BootstrapSnapshot,
  ControlAck,
  ControlResumeMessage,
  ControlStopMessage,
  InputAck,
  InputSource,
  InputSubmitMessage,
  OutputConfirmation,
  PerformanceReceipt,
  PerformerStatus,
  PlayerStatus,
  ServerMessage,
  SessionLifecycle,
} from '../contracts'

/**
 * Pure console view state for M2.
 *
 * It owns no transport, no DOM, no timers and no playback: every transition is
 * a function from one immutable state to the next. That keeps the console's
 * behaviour — request correlation, sequence discipline, disconnect uncertainty
 * — testable without a browser.
 *
 * Two honesty rules are structural here rather than cosmetic:
 *  - a session event is only ever accepted when its sequence is strictly above
 *    the last accepted sequence, so replayed history can never be rendered;
 *  - playback status and receipts are marked as local evidence, because the
 *    console has no return channel to claim runtime confirmation.
 */

/** Local transport connection state. It is never derived from server messages. */
export type ConnectionStatus = 'connecting' | 'open' | 'closed' | 'error'

/**
 * Outcome of one console-issued request. The server's own vocabulary is kept
 * (`accepted`/`duplicate`/`rejected` for input, `applied`/`duplicate`/`refused`
 * for control) and `unknown` is an explicit result, never a guess.
 */
export type RequestOutcome =
  | 'pending'
  | 'unknown'
  | 'accepted'
  | 'duplicate'
  | 'rejected'
  | 'applied'
  | 'refused'

export interface InputRequestView {
  readonly messageId: string
  readonly source: InputSource
  readonly text: string
  readonly outcome: RequestOutcome
  readonly detail: string | null
  readonly eventId: string | null
  readonly seq: number | null
}

export interface ControlRequestView {
  readonly messageId: string
  readonly requestId: string
  readonly action: 'stop' | 'resume'
  readonly outcome: RequestOutcome
  readonly detail: string | null
  readonly previousEpoch: number | null
  readonly epoch: number | null
}

export interface SessionView {
  readonly sessionId: string
  readonly epoch: number
  readonly lifecycle: SessionLifecycle
  readonly activeTurnId: string | null
  readonly performerStatus: PerformerStatus
  readonly outputConfirmation: OutputConfirmation
  readonly capabilityRevision: number
  /** Highest accepted event sequence. Only strictly greater sequences are new. */
  readonly lastSeq: number
}

export interface EventView {
  readonly seq: number
  readonly type: string
  readonly data: Record<string, unknown>
}

export interface ErrorView {
  readonly requestId: string | null
  readonly code: string
  readonly message: string
}

export interface PlaybackView {
  readonly idle: boolean
  readonly activeOutputId: string | null
  readonly lastStage: string | null
  readonly subtitleText: string | null
  /**
   * Locally observed performance receipts. They are evidence recorded by this
   * browser session, not runtime-confirmed delivery.
   */
  readonly receipts: readonly PerformanceReceipt[]
  readonly faults: readonly string[]
}

export interface ConsoleState {
  readonly connection: ConnectionStatus
  readonly connectionDetail: string | null
  readonly session: SessionView | null
  readonly inputs: readonly InputRequestView[]
  readonly controls: readonly ControlRequestView[]
  readonly events: readonly EventView[]
  readonly errors: readonly ErrorView[]
  readonly playback: PlaybackView
}

/** Retained history per list. Older entries are dropped; newest are kept. */
export const MAX_LOG_ENTRIES = 60

const IDLE_PLAYBACK: PlaybackView = {
  idle: true,
  activeOutputId: null,
  lastStage: null,
  subtitleText: null,
  receipts: [],
  faults: [],
}

export function createInitialConsoleState(): ConsoleState {
  return {
    connection: 'connecting',
    connectionDetail: null,
    session: null,
    inputs: [],
    controls: [],
    events: [],
    errors: [],
    playback: IDLE_PLAYBACK,
  }
}

/**
 * Whether the console may issue a new request. Requests are only dispatched on
 * an open transport with a live session, so a closed or uncertain console stays
 * non-dispatching instead of guessing.
 */
export function canDispatch(state: ConsoleState): boolean {
  return state.connection === 'open' && state.session !== null
}

function keepNewest<T>(entries: readonly T[], entry: T): readonly T[] {
  const next = entries.length >= MAX_LOG_ENTRIES ? entries.slice(entries.length - MAX_LOG_ENTRIES + 1) : [...entries]
  next.push(entry)
  return next
}

/**
 * Record a transport lifecycle transition. Every non-open transition is
 * uncertain by definition: in-flight requests become `unknown`, output
 * confirmation becomes `unknown`, and nothing is automatically replayed or
 * resumed. Local playback cancellation is the player binding's responsibility.
 */
export function withConnection(
  state: ConsoleState,
  connection: ConnectionStatus,
  detail: string | null = null,
): ConsoleState {
  if (connection === 'open') {
    return { ...state, connection, connectionDetail: detail }
  }
  const markUnknown = <T extends { readonly outcome: RequestOutcome; readonly detail: string | null }>(
    entry: T,
  ): T =>
    entry.outcome === 'pending'
      ? { ...entry, outcome: 'unknown', detail: 'transport went down before acknowledgement' }
      : entry
  return {
    ...state,
    connection,
    connectionDetail: detail,
    session:
      state.session === null ? null : { ...state.session, outputConfirmation: 'unknown' },
    inputs: state.inputs.map(markUnknown),
    controls: state.controls.map(markUnknown),
  }
}

/**
 * Accept a completed bootstrap as the authoritative session identity and the
 * starting sequence. A completed bootstrap also proves the transport is open.
 */
export function withBootstrap(state: ConsoleState, bootstrap: BootstrapSnapshot): ConsoleState {
  return {
    ...state,
    connection: 'open',
    connectionDetail: null,
    session: {
      sessionId: bootstrap.sessionId,
      epoch: bootstrap.epoch,
      lifecycle: bootstrap.lifecycle,
      activeTurnId: bootstrap.activeTurnId,
      performerStatus: bootstrap.performerStatus,
      outputConfirmation: bootstrap.outputConfirmation,
      capabilityRevision: bootstrap.capabilityRevision,
      lastSeq: bootstrap.seq,
    },
  }
}

export function withPendingInput(state: ConsoleState, message: InputSubmitMessage): ConsoleState {
  return {
    ...state,
    inputs: keepNewest(state.inputs, {
      messageId: message.messageId,
      source: message.payload.source,
      text: message.payload.text,
      outcome: 'pending',
      detail: null,
      eventId: null,
      seq: null,
    }),
  }
}

export function withPendingControl(
  state: ConsoleState,
  message: ControlStopMessage | ControlResumeMessage,
): ConsoleState {
  return {
    ...state,
    controls: keepNewest(state.controls, {
      messageId: message.messageId,
      requestId: message.payload.requestId,
      action: message.kind === 'control.stop' ? 'stop' : 'resume',
      outcome: 'pending',
      detail: null,
      previousEpoch: null,
      epoch: null,
    }),
  }
}

export function withPlaybackStatus(state: ConsoleState, status: PlayerStatus): ConsoleState {
  return {
    ...state,
    playback: {
      ...state.playback,
      idle: status.idle,
      activeOutputId: status.activeOutputId,
      lastStage: status.lastStage,
    },
  }
}

/** Subtitle display is rendered separately from audio playback. */
export function withSubtitle(state: ConsoleState, subtitleText: string): ConsoleState {
  return { ...state, playback: { ...state.playback, subtitleText } }
}

export function withReceipt(state: ConsoleState, receipt: PerformanceReceipt): ConsoleState {
  return {
    ...state,
    playback: {
      ...state.playback,
      lastStage: receipt.stage,
      receipts: keepNewest(state.playback.receipts, receipt),
    },
  }
}

export function withFault(state: ConsoleState, message: string): ConsoleState {
  return { ...state, playback: { ...state.playback, faults: keepNewest(state.playback.faults, message) } }
}

export function withError(state: ConsoleState, error: ErrorView): ConsoleState {
  return { ...state, errors: keepNewest(state.errors, error) }
}

function replaceInput(
  inputs: readonly InputRequestView[],
  messageId: string,
  update: (view: InputRequestView) => InputRequestView,
): readonly InputRequestView[] {
  let matched = false
  const next = inputs.map((view) => {
    if (view.messageId !== messageId) return view
    matched = true
    return update(view)
  })
  return matched ? next : inputs
}

function replaceControl(
  controls: readonly ControlRequestView[],
  requestId: string,
  update: (view: ControlRequestView) => ControlRequestView,
): readonly ControlRequestView[] {
  let matched = false
  const next = controls.map((view) => {
    if (view.requestId !== requestId) return view
    matched = true
    return update(view)
  })
  return matched ? next : controls
}

/** Mark a pending request as unresolved evidence after a local dispatch failure. */
export function withInputFailure(state: ConsoleState, messageId: string, detail: string): ConsoleState {
  return {
    ...state,
    inputs: replaceInput(state.inputs, messageId, (view) =>
      view.outcome === 'pending' ? { ...view, outcome: 'unknown', detail } : view,
    ),
  }
}

export function withControlFailure(state: ConsoleState, requestId: string, detail: string): ConsoleState {
  return {
    ...state,
    controls: replaceControl(state.controls, requestId, (view) =>
      view.outcome === 'pending' ? { ...view, outcome: 'unknown', detail } : view,
    ),
  }
}

/** Apply an acknowledgement that was resolved by the transport promise. */
export function reduceInputAck(state: ConsoleState, ack: InputAck): ConsoleState {
  return applyInputAck(state, ack)
}

export function reduceControlAck(state: ConsoleState, ack: ControlAck): ConsoleState {
  return applyControlAck(state, ack)
}

/** Advance the accepted sequence, never backwards and never on a stale value. */
function advanceSeq(state: ConsoleState, seq: number): ConsoleState {
  const session = state.session
  if (session === null || seq <= session.lastSeq) return state
  return { ...state, session: { ...session, lastSeq: seq } }
}

const IDENTITY_MISMATCH = 'acknowledgement references a different session or epoch'

function applyInputAck(state: ConsoleState, ack: InputAck): ConsoleState {
  const session = state.session
  const mismatch = session !== null && (ack.sessionId !== session.sessionId || ack.epoch !== session.epoch)
  if (ack.status === 'rejected') {
    return {
      ...state,
      inputs: replaceInput(state.inputs, ack.requestMessageId, (view) => ({
        ...view,
        outcome: mismatch ? 'unknown' : 'rejected',
        detail: mismatch ? IDENTITY_MISMATCH : `${ack.code}: ${ack.message}${ack.retryable ? ' (retryable)' : ''}`,
      })),
    }
  }
  const settled: ConsoleState = {
    ...state,
    inputs: replaceInput(state.inputs, ack.requestMessageId, (view) => ({
      ...view,
      outcome: mismatch ? 'unknown' : ack.status,
      detail: mismatch ? IDENTITY_MISMATCH : null,
      eventId: ack.eventId,
      seq: ack.seq,
    })),
  }
  return mismatch ? settled : advanceSeq(settled, ack.seq)
}

function applyControlAck(state: ConsoleState, ack: ControlAck): ConsoleState {
  const applied = ack.status === 'applied'
  const settled: ConsoleState = {
    ...state,
    controls: replaceControl(state.controls, ack.requestId, (view) => ({
      ...view,
      outcome: ack.status,
      detail: applied ? null : `${ack.reasonCode ?? ack.status}: ${ack.message}`,
      previousEpoch: ack.previousEpoch,
      epoch: ack.epoch,
    })),
  }
  const session = settled.session
  if (session === null || ack.sessionId !== session.sessionId) return settled
  // A late acknowledgement may settle its own request display (above), but it
  // must not roll the session back: an older epoch never overwrites newer state.
  if (ack.epoch < session.epoch) return settled
  return {
    ...settled,
    session: {
      ...session,
      epoch: ack.epoch,
      lifecycle: ack.lifecycle,
      outputConfirmation: ack.outputConfirmation,
    },
  }
}

function applySnapshot(state: ConsoleState, message: ServerMessage & { kind: 'session.snapshot' }): ConsoleState {
  const payload = message.payload
  const previous = state.session
  // An out-of-order snapshot must not roll the session back. A snapshot for the
  // same session is dropped outright rather than merged when it is at an older
  // epoch, or at the same epoch but behind the sequence already accepted, so the
  // accepted identity, turn, confirmation, capability and sequence stay
  // monotonic.
  if (
    previous !== null &&
    previous.sessionId === message.sessionId &&
    (message.epoch < previous.epoch ||
      (message.epoch === previous.epoch && message.payload.lastSeq < previous.lastSeq))
  ) {
    return state
  }
  const sameSession = previous !== null && previous.sessionId === message.sessionId
  return {
    ...state,
    session: {
      sessionId: message.sessionId,
      epoch: message.epoch,
      lifecycle: payload.lifecycle,
      activeTurnId: payload.activeTurnId,
      performerStatus: payload.performerStatus,
      outputConfirmation: payload.outputConfirmation,
      capabilityRevision: payload.capabilityRevision,
      lastSeq: sameSession ? Math.max(previous.lastSeq, payload.lastSeq) : payload.lastSeq,
    },
  }
}

function applySessionEvent(state: ConsoleState, message: ServerMessage & { kind: 'session.event' }): ConsoleState {
  const session = state.session
  if (session === null || message.sessionId !== session.sessionId) return state
  // Replayed history at or below the accepted sequence is never rendered.
  if (message.payload.seq <= session.lastSeq) return state
  return {
    ...state,
    session: { ...session, lastSeq: message.payload.seq },
    events: keepNewest(state.events, {
      seq: message.payload.seq,
      type: message.payload.type,
      data: message.payload.data,
    }),
  }
}

function applyRequestError(state: ConsoleState, message: ServerMessage & { kind: 'request.error' }): ConsoleState {
  const payload = message.payload
  const withError: ConsoleState = {
    ...state,
    errors: keepNewest(state.errors, {
      requestId: payload.requestId,
      code: payload.code,
      message: payload.message,
    }),
  }
  if (payload.requestId === null) return withError
  return {
    ...withError,
    controls: replaceControl(withError.controls, payload.requestId, (view) =>
      view.outcome === 'pending'
        ? { ...view, outcome: 'unknown', detail: `${payload.code}: ${payload.message}` }
        : view,
    ),
  }
}

/**
 * Apply one inbound server message. Performance commands are deliberately not
 * handled here: dispatch belongs to the player binding, so the view state can
 * never silently start playback.
 */
export function reduceServerMessage(state: ConsoleState, message: ServerMessage): ConsoleState {
  switch (message.kind) {
    case 'input.ack':
      return applyInputAck(state, message.payload)
    case 'control.ack':
      return applyControlAck(state, message.payload)
    case 'session.snapshot':
      return applySnapshot(state, message)
    case 'session.event':
      return applySessionEvent(state, message)
    case 'request.error':
      return applyRequestError(state, message)
    case 'performance.execute':
    case 'performance.cancel':
      return state
  }
}
