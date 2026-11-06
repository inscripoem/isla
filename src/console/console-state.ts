import {
  deliveryClassificationSchema,
  inputEventSchema,
  replyIntentSchema,
  selectionResultSchema,
} from '../contracts'
import type {
  ApplicationServerMessage,
  BootstrapSnapshot,
  ControlAck,
  ControlResumeMessage,
  ControlStopMessage,
  DeliveryClassification,
  InputAck,
  InputSource,
  InputSubmitMessage,
  OutputConfirmation,
  PerformanceReceipt,
  PerformerStatus,
  PlayerStatus,
  ReplyIntent,
  SelectionDisposition,
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
  /**
   * Explicit retirement state pushed by the server. It is never inferred from
   * lifecycle; a successor session starts non-retiring.
   */
  readonly retiring: boolean
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

/**
 * One accepted input as the console observed it. It carries the validated
 * InputEvent identity and text; nothing is invented.
 */
export interface AcceptedInputView {
  readonly eventId: string
  readonly seq: number
  readonly text: string
  readonly source: InputSource
}

/**
 * The latest validated response plan observed from the pipeline. It stays
 * visible for audit even when a newer accepted input has made it stale.
 */
export interface SelectionPlanView {
  readonly seq: number
  readonly disposition: SelectionDisposition
  readonly selectedEventIds: readonly string[]
  readonly replyIntent: ReplyIntent | null
  readonly reasonCode: string
  readonly synthetic: boolean
}

/**
 * The latest `turn.started` reply intent and its turn identity.
 *
 * The application wire carries the stored event payload only, so the durable
 * identity is usually unreported. `turnId` is `null` when it is absent from the
 * event data; it is never fabricated.
 */
export interface ReplyIntentView {
  readonly seq: number
  readonly turnId: string | null
  readonly replyIntent: ReplyIntent
}

/**
 * Explicit waiting stage derived from observed pipeline events. The console
 * never fabricates a stage: an unknown message leaves it unchanged.
 */
export type WaitingStage =
  | 'idle'
  | 'awaiting-selection'
  | 'selected'
  | 'deferred'
  | 'speaking'
  | 'delivered'
  | 'stopped'

/**
 * A delivery the server has confirmed. It is server evidence, deliberately
 * separate from the locally observed playback receipts in {@link PlaybackView}.
 *
 * The application wire carries the stored event payload only, so durable
 * identity may be unreported. Each identity field is `null` when it is absent
 * from the event data; it is never fabricated.
 */
export interface ServerDeliveryView {
  readonly seq: number
  readonly outputId: string | null
  readonly turnId: string | null
  readonly segmentId: string | null
  readonly classification: DeliveryClassification
}

/**
 * The console's real understanding of the selection/waiting pipeline, built
 * only from accepted session events. It carries no invented text or delivery.
 */
export interface SelectionView {
  readonly stage: WaitingStage
  /** Bounded newest list of accepted inputs, ordered oldest to newest. */
  readonly acceptedInputs: readonly AcceptedInputView[]
  readonly plan: SelectionPlanView | null
  readonly replyIntent: ReplyIntentView | null
  /** The latest server-confirmed delivery, or null before any is committed. */
  readonly serverDelivery: ServerDeliveryView | null
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
  readonly selection: SelectionView
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

const IDLE_SELECTION: SelectionView = {
  stage: 'idle',
  acceptedInputs: [],
  plan: null,
  replyIntent: null,
  serverDelivery: null,
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
    selection: IDLE_SELECTION,
  }
}

/**
 * Whether the console may issue a new request. Requests are only dispatched on
 * an open transport with a live session, so a closed or uncertain console stays
 * non-dispatching instead of guessing.
 */
export function canDispatch(state: ConsoleState): boolean {
  if (state.connection !== 'open' || state.session === null) return false
  return !state.session.retiring
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
      retiring: false,
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
  // An accepted acknowledgement settles only its own request view. It does not
  // advance `lastSeq`: the runtime sends `input.ack` before it publishes the
  // matching `input.accepted` event at the same sequence, so advancing here
  // would make that event look like replayed history. `lastSeq` advances only
  // on bootstrap, snapshots and accepted session events, so an event at the
  // acknowledged sequence is still strictly above the frontier and applies.
  return settled
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
  const advanced: ConsoleState = {
    ...settled,
    session: {
      ...session,
      epoch: ack.epoch,
      lifecycle: ack.lifecycle,
      outputConfirmation: ack.outputConfirmation,
    },
  }
  // Only an applied/duplicate control ack changes the waiting stage. A refused
  // acknowledgement leaves the observed pipeline evidence untouched.
  if (!applied && ack.status !== 'duplicate') return advanced
  if (ack.action === 'stop') {
    return { ...advanced, selection: { ...advanced.selection, stage: 'stopped' } }
  }
  if (ack.action === 'resume') {
    return { ...advanced, selection: { ...advanced.selection, stage: resumeStage(advanced.selection) } }
  }
  return advanced
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
  // A snapshot for a different session is a real successor: the previous
  // session's selection, event log and still-pending requests describe a
  // retired identity and must not be projected under the new one. Settled
  // request entries are retained as history.
  const markStale = <T extends { readonly outcome: RequestOutcome; readonly detail: string | null }>(
    entry: T,
  ): T =>
    entry.outcome === 'pending'
      ? { ...entry, outcome: 'unknown', detail: 'session changed before acknowledgement' }
      : entry
  const advanced: ConsoleState = {
    ...state,
    inputs: sameSession ? state.inputs : state.inputs.map(markStale),
    controls: sameSession ? state.controls : state.controls.map(markStale),
    events: sameSession ? state.events : [],
    selection: sameSession ? state.selection : IDLE_SELECTION,
    session: {
      sessionId: message.sessionId,
      epoch: message.epoch,
      lifecycle: payload.lifecycle,
      activeTurnId: payload.activeTurnId,
      performerStatus: payload.performerStatus,
      outputConfirmation: payload.outputConfirmation,
      capabilityRevision: payload.capabilityRevision,
      lastSeq: sameSession ? Math.max(previous.lastSeq, payload.lastSeq) : payload.lastSeq,
      // Retirement is only ever set by an explicit recovery state frame. A
      // successor snapshot starts non-retiring; a same-session refresh keeps the
      // state already confirmed.
      retiring: sameSession ? previous.retiring : false,
    },
  }
  // A snapshot reflects lifecycle without inventing events: a stopped snapshot
  // stops the waiting projection, and leaving stopped is decided by the same
  // input-versus-plan evidence a Resume acknowledgement uses.
  // A successor projection starts from the idle selection produced above; a
  // same-session refresh keeps the selection it was given.
  const projection = advanced.selection
  const wasStopped = sameSession && previous.lifecycle === 'stopped'
  if (payload.lifecycle === 'stopped') {
    return { ...advanced, selection: { ...projection, stage: 'stopped' } }
  }
  if (wasStopped) {
    return { ...advanced, selection: { ...projection, stage: resumeStage(projection) } }
  }
  return advanced
}

/**
 * The stage a plan projects, unless an accepted input arrived after it, in
 * which case the console is waiting for a selection of the newer input again.
 */
function planStage(
  plan: SelectionPlanView | null,
  newestInputSeq: number | null,
): 'selected' | 'deferred' | null {
  if (plan === null) return null
  if (newestInputSeq !== null && newestInputSeq > plan.seq) return null
  return plan.disposition === 'respond' ? 'selected' : 'deferred'
}

/** Resume/successor stage: plan or newer-input evidence decides, else idle. */
function resumeStage(selection: SelectionView): WaitingStage {
  const newestInput =
    selection.acceptedInputs.length === 0
      ? null
      : selection.acceptedInputs[selection.acceptedInputs.length - 1]!.seq
  const planned = planStage(selection.plan, newestInput)
  if (planned !== null) return planned
  return newestInput !== null ? 'awaiting-selection' : 'idle'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Read one durable identity field the runtime chose to report. The application
 * wire carries the stored event payload only, so an identity is often absent;
 * an absent or non-string value is recorded as `null` and never fabricated.
 */
function reportedIdentity(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Project one accepted pipeline event onto the selection view. It returns the
 * state unchanged when the payload is malformed, names another session/epoch or
 * is not a pipeline event the console understands.
 */
function applyPipelineEvent(
  state: ConsoleState,
  message: ServerMessage & { kind: 'session.event' },
): ConsoleState {
  const selection = state.selection
  const data = asRecord(message.payload.data)
  if (data === null) return state
  const seq = message.payload.seq
  const epoch = message.epoch

  switch (message.payload.type) {
    case 'input.accepted': {
      const eventId = data.eventId
      const input = inputEventSchema.safeParse(data.input)
      if (typeof eventId !== 'string' || !input.success) return state
      if (
        input.data.sessionId !== message.sessionId ||
        input.data.epoch !== epoch ||
        input.data.eventId !== eventId
      ) {
        return state
      }
      // An already-recorded input is never duplicated.
      if (selection.acceptedInputs.some((entry) => entry.eventId === eventId)) return state
      const acceptedInputs = keepNewest<AcceptedInputView>(selection.acceptedInputs, {
        eventId,
        seq,
        text: input.data.text,
        source: input.data.source,
      })
      const newestInput = acceptedInputs[acceptedInputs.length - 1]!.seq
      // A plan that covers this input keeps its stage; an older plan leaves the
      // console waiting for a selection of the newer input.
      const stage = planStage(selection.plan, newestInput) ?? 'awaiting-selection'
      return {
        ...state,
        selection: { ...selection, acceptedInputs, stage },
      }
    }
    case 'selection.plan': {
      const plan = selectionResultSchema.safeParse(data.plan)
      const synthetic = data.synthetic
      if (!plan.success || typeof synthetic !== 'boolean') return state
      if (plan.data.sessionId !== message.sessionId || plan.data.epoch !== epoch) return state
      // Never replace a newer plan with an older one.
      if (selection.plan !== null && selection.plan.seq >= seq) return state
      const nextPlan: SelectionPlanView = {
        seq,
        disposition: plan.data.disposition,
        selectedEventIds: [...plan.data.selectedEventIds],
        replyIntent: plan.data.replyIntent,
        reasonCode: plan.data.reasonCode,
        synthetic,
      }
      const newestInput =
        selection.acceptedInputs.length === 0
          ? null
          : selection.acceptedInputs[selection.acceptedInputs.length - 1]!.seq
      const planned = planStage(nextPlan, newestInput)
      return {
        ...state,
        selection: {
          ...selection,
          plan: nextPlan,
          stage: planned ?? (newestInput !== null ? 'awaiting-selection' : selection.stage),
        },
      }
    }
    case 'turn.started': {
      const parsedIntent = replyIntentSchema.safeParse(data.replyIntent)
      if (!parsedIntent.success) return state
      return {
        ...state,
        selection: {
          ...selection,
          stage: 'speaking',
          replyIntent: {
            seq,
            turnId: reportedIdentity(data.turnId),
            replyIntent: parsedIntent.data,
          },
        },
      }
    }
    case 'delivery.committed': {
      const classification = deliveryClassificationSchema.safeParse(data.classification)
      if (!classification.success) return state
      return {
        ...state,
        selection: {
          ...selection,
          stage: 'delivered',
          serverDelivery: {
            seq,
            outputId: reportedIdentity(data.outputId),
            turnId: reportedIdentity(data.turnId),
            segmentId: reportedIdentity(data.segmentId),
            classification: classification.data,
          },
        },
      }
    }
    default:
      return state
  }
}

function applySessionEvent(state: ConsoleState, message: ServerMessage & { kind: 'session.event' }): ConsoleState {
  const session = state.session
  if (session === null || message.sessionId !== session.sessionId) return state
  // Replayed history at or below the accepted sequence is never rendered.
  if (message.payload.seq <= session.lastSeq) return state
  const advanced: ConsoleState = {
    ...state,
    session: { ...session, lastSeq: message.payload.seq },
    events: keepNewest(state.events, {
      seq: message.payload.seq,
      type: message.payload.type,
      data: message.payload.data,
    }),
  }
  return applyPipelineEvent(advanced, message)
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

/**
 * Apply one inbound application (protocol 0.2) message. Base messages are
 * delegated unchanged to {@link reduceServerMessage}; only the explicit
 * retirement state is handled here. Attach, operator, offer, grant and recovery
 * acknowledgement messages leave the view unchanged, and retirement is never
 * inferred from lifecycle.
 */
export function reduceApplicationMessage(
  state: ConsoleState,
  message: ApplicationServerMessage,
): ConsoleState {
  switch (message.kind) {
    case 'session.recovery.state': {
      const session = state.session
      if (session === null || message.sessionId !== session.sessionId) return state
      // A frame for an older epoch is stale and never regresses the current
      // retirement state.
      if (message.epoch < session.epoch) return state
      return { ...state, session: { ...session, retiring: message.payload.retiring } }
    }
    case 'session.attach.ack':
    case 'operator.ack':
    case 'performance.offer':
    case 'performance.grant':
    case 'session.recovery.ack':
      return state
    default:
      return reduceServerMessage(state, message)
  }
}

/**
 * The accepted session frontier the console player binding fences admission
 * against: the identity, epoch, lifecycle and highest accepted sequence already
 * accepted from server messages.
 *
 * It is the session projection of {@link reduceServerMessage} without the view
 * lists. The binding is never asked to perform a snapshot or a control
 * acknowledgement, so M1's own epoch boundary only advances on the commands it
 * was given directly and can lag the console. Reducing every decoded message
 * through {@link reduceSessionFrontier} and refusing a command outside the
 * result keeps an output the console has already superseded or stopped from
 * ever being admitted.
 */
export interface SessionFrontier {
  readonly sessionId: string
  readonly epoch: number
  readonly lifecycle: SessionLifecycle
  readonly lastSeq: number
}

function advanceFrontierSeq(frontier: SessionFrontier, seq: number): SessionFrontier {
  return seq > frontier.lastSeq ? { ...frontier, lastSeq: seq } : frontier
}

/** Project one inbound server message onto the accepted session frontier. */
export function reduceSessionFrontier(frontier: SessionFrontier, message: ServerMessage): SessionFrontier {
  switch (message.kind) {
    case 'input.ack': {
      const ack = message.payload
      // A rejected request never advances the sequence, and an acknowledgement
      // for another identity is not evidence about this session.
      if (ack.status === 'rejected') return frontier
      if (ack.sessionId !== frontier.sessionId || ack.epoch !== frontier.epoch) return frontier
      return advanceFrontierSeq(frontier, ack.seq)
    }
    case 'control.ack': {
      const ack = message.payload
      if (ack.sessionId !== frontier.sessionId || ack.epoch < frontier.epoch) return frontier
      return { ...frontier, epoch: ack.epoch, lifecycle: ack.lifecycle }
    }
    case 'session.snapshot': {
      const payload = message.payload
      const sameSession = message.sessionId === frontier.sessionId
      // A snapshot behind the accepted epoch, or behind the accepted sequence at
      // the same epoch, never rolls the session back.
      if (
        sameSession &&
        (message.epoch < frontier.epoch ||
          (message.epoch === frontier.epoch && payload.lastSeq < frontier.lastSeq))
      ) {
        return frontier
      }
      return {
        sessionId: message.sessionId,
        epoch: message.epoch,
        lifecycle: payload.lifecycle,
        lastSeq: sameSession ? Math.max(frontier.lastSeq, payload.lastSeq) : payload.lastSeq,
      }
    }
    case 'session.event':
      if (message.sessionId !== frontier.sessionId) return frontier
      return advanceFrontierSeq(frontier, message.payload.seq)
    default:
      return frontier
  }
}
