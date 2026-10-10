import type { CallContext, TrustedControlContext } from './primitives'
import type {
  CapabilitySnapshot,
  DecisionRequest,
  DecisionResult,
  DialogueEnd,
  DialogueRequest,
  DialogueSegment,
  PerformanceCancel,
  PerformanceCommand,
  PerformanceReceipt,
  PlayerStatus,
  PreparePerformance,
  PreparedAudio,
  SelectionRequest,
  SelectionResult,
} from './pipeline'
import type {
  AppendAck,
  AtomicCommitAck,
  CommitDelivery,
  ConfirmedDelivery,
  DeliveryCommitAck,
  RuntimeEvent,
} from './storage'
import type {
  BootstrapSnapshot,
  ControlAck,
  ControlResumeMessage,
  ControlStopMessage,
  InputAck,
  InputSubmitMessage,
  PlayerMessage,
  ServerMessage,
} from './wire'

/**
 * M1 — synthesis, player and renderer adapters. Preparing speech must not play
 * it; provider SDKs and renderer-specific commands stay behind these ports.
 */
export interface SynthesisPort {
  prepare(request: PreparePerformance, context: CallContext): Promise<PreparedAudio>
}

export interface RendererPort {
  capabilities(): CapabilitySnapshot
  execute(command: PerformanceCommand, context: CallContext): Promise<PerformanceReceipt>
}

export interface PlayerPort {
  execute(command: PerformanceCommand, context: CallContext): Promise<PerformanceReceipt>
  /** Cancellation returns observed terminal evidence, or null when idle. */
  cancel(request: PerformanceCancel, context: CallContext): Promise<PerformanceReceipt | null>
  /** Explicit idle/cancellation evidence; never inferred from server logs. */
  status(): PlayerStatus
}

/** M3 — response-plan selection and rule/decision reaction adapters. */
export interface SelectionPort {
  select(request: SelectionRequest, context: CallContext): Promise<SelectionResult>
}

export interface ReactionPort {
  decide(request: DecisionRequest, context: CallContext): Promise<DecisionResult>
}

/** M4 — dialogue generation and memory commit semantics. */

/** Documented event interface so cancellation before completion is observable. */
export interface DialogueSink {
  segment(segment: DialogueSegment): Promise<void>
}

export interface DialoguePort {
  generate(request: DialogueRequest, context: CallContext, sink: DialogueSink): Promise<DialogueEnd>
}

export interface MemoryCommitPort {
  commit(delivery: CommitDelivery): Promise<DeliveryCommitAck>
}

/** Narrow confirmed-history lookup used by M4 context assembly. */
export interface HistoryQueryPort {
  confirmedHistory(sessionId: string): Promise<ConfirmedDelivery[]>
}

/** M6 — durable event store, replay reader and memory projection. */
export interface EventStorePort {
  append(event: RuntimeEvent): Promise<AppendAck>
  /** Atomically persist a delivery update and its supporting event. */
  commitDeliveryWithEvent(
    delivery: CommitDelivery,
    event: RuntimeEvent,
  ): Promise<AtomicCommitAck>
  readSession(sessionId: string): Promise<RuntimeEvent[]>
  exportJsonl(sessionId: string): Promise<string>
}

export interface MemoryProjectionPort {
  apply(event: RuntimeEvent): Promise<{ appliedSeq: number }>
  appliedSeq(): number
}

export interface ReplayArchive {
  sessionId: string
  events: RuntimeEvent[]
}

export interface ReplayReaderPort {
  load(sessionId: string): Promise<ReplayArchive>
}

/** M5-owned boundaries injected for determinism and control attribution. */
export interface ClockPort {
  nowMs(): number
}

export interface ControlAuthorizerPort {
  isOperator(context: TrustedControlContext): boolean
}

/**
 * M2 — console transport. Bootstrap returns a complete snapshot so the console
 * can construct its first request without guessing identities.
 */
export interface ConsoleTransportPort {
  bootstrap(): Promise<BootstrapSnapshot>
  sendInput(message: InputSubmitMessage): Promise<InputAck>
  sendControl(message: ControlStopMessage | ControlResumeMessage): Promise<ControlAck>
  onServerMessage(listener: (message: ServerMessage) => void): () => void
  close(): void
}

/**
 * Runtime-facing testable port. A fixture implements it for composition tests;
 * M5 remains the authoritative production implementer. It accepts both client
 * messages and player receipts, and exposes explicit control/input results.
 */
export interface RuntimeEndpointPort {
  snapshot(): Promise<BootstrapSnapshot>
  submitInput(message: InputSubmitMessage, context: TrustedControlContext): Promise<InputAck>
  control(
    message: ControlStopMessage | ControlResumeMessage,
    context: TrustedControlContext,
  ): Promise<ControlAck>
  handlePlayerMessage(message: PlayerMessage): Promise<void>
  onServerMessage(listener: (message: ServerMessage) => void): () => void
}
