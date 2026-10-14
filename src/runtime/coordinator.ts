import { createHash, randomUUID } from 'node:crypto'
import type {
  BootstrapSnapshot,
  CallContext,
  CapabilitySnapshot,
  ClockPort,
  CommitDelivery,
  ControlAck,
  ControlAuthorizerPort,
  ControlResumeMessage,
  ControlStopMessage,
  Deadline,
  DialogueEnd,
  DialoguePort,
  DialogueSegment,
  EventStorePort,
  InputAck,
  InputEvent,
  InputSubmitMessage,
  MemoryCommitPort,
  PerformanceReceipt,
  PlayerPort,
  PlayerStatus,
  ReactionPort,
  ReceiptStage,
  ReplyIntent,
  RendererPort,
  RuntimeEndpointPort,
  RuntimeEvent,
  SelectionPort,
  SelectionResult,
  ServerMessage,
  SessionLifecycle,
  SynthesisPort,
  TrustedControlContext,
  UsageRecord,
} from '../contracts'
import {
  MAX_DIALOGUE_SEGMENTS,
  NO_OP_ACTION,
  REPLY_INTENTS,
  appendAckSchema,
  atomicCommitAckSchema,
  bootstrapSnapshotSchema,
  capabilitySnapshotSchema,
  controlAckSchema,
  controlResumeMessageSchema,
  controlStopMessageSchema,
  decisionRequestSchema,
  decisionResultSchema,
  deliveryCommitAckSchema,
  dialogueEndSchema,
  dialogueRequestSchema,
  dialogueSegmentSchema,
  inputAckSchema,
  inputSubmitMessageSchema,
  performanceCommandSchema,
  performanceReceiptSchema,
  playerMessageSchema,
  playerStatusSchema,
  preparedAudioSchema,
  replyIntentSchema,
  runtimeEventSchema,
  selectionRequestSchema,
  selectionResultSchema,
  usageRecordSchema,
} from '../contracts'
import {
  classifyAudioDelivery,
  isDeadlineExpired,
  isTerminalReceiptStage,
  nextEpoch,
  receiptFingerprint,
  reconcileReceipt,
  selectFallback,
} from './policy'
import type { ReceiptFact, ReconciliationAction } from './policy'

/**
 * Authoritative M5 coordinator for one controlled response cycle. It owns
 * session lifecycle, epoch, active turn, output registration, deadlines,
 * sequencing and dispatch authorization. Peer selection/dialogue/synthesis/
 * renderer/player/storage behavior is injected through ports; no test code or
 * provider business logic lives here.
 */

export type CycleStatus =
  | 'completed'
  | 'cancelled'
  | 'deferred'
  | 'stale'
  | 'inactive'
  | 'no-input'
  | 'degraded'
  | 'busy'
  | 'blocked'

export interface CycleOutcome {
  status: CycleStatus
  turnId: string | null
  plan: SelectionResult | null
  deliveries: CommitDelivery[]
}

export interface RuntimeMetrics {
  selectionAttempts: number
  reactionAttempts: number
  dialogueAttempts: number
  rejectedLate: number
  rejectedReceipts: number
  storageFailure: boolean
}

/**
 * Per-stage peer budgets, in milliseconds. Each stage owns its bound so that a
 * slow reaction or playback cannot consume the selection budget for the whole
 * turn. Values are validated once when the coordinator is created.
 */
export interface CycleTimings {
  selectionMs: number
  dialogueMs: number
  synthesisMs: number
  reactionMs: number
  rendererMs: number
  playbackMs: number
}

export interface RuntimeCoordinatorDeps {
  clock: ClockPort
  authorizer: ControlAuthorizerPort
  selection: SelectionPort
  reaction: ReactionPort
  dialogue: DialoguePort
  synthesis: SynthesisPort
  renderer: RendererPort
  player: PlayerPort
  commit: MemoryCommitPort
  store: EventStorePort
  /** Fresh random session id when omitted; fixtures pass one explicitly. */
  sessionId?: string
  /** Lifetime of an admitted input, in milliseconds. */
  inputTtlMs?: number
  /** Validated storage/cancellation/input budgets. */
  storageTtlMs?: number
  cancelTtlMs?: number
  /** Validated session/persona/context profile. */
  profile?: Partial<SessionProfileConfig>
  timings?: Partial<CycleTimings>
  /** Legacy alias for `timings.selectionMs`; prefer `timings`. */
  decisionDeadlineMs?: number
  /** Legacy alias for `timings.reactionMs`; prefer `timings`. */
  reactionDeadlineMs?: number
}

export interface RuntimeCoordinator {
  readonly endpoint: RuntimeEndpointPort
  runTurn(): Promise<CycleOutcome>
  lifecycle(): SessionLifecycle
  epoch(): number
  events(): RuntimeEvent[]
  deliveries(): CommitDelivery[]
  metrics(): RuntimeMetrics
}

interface OutputRegistration {
  sessionId: string
  epoch: number
  turnId: string
  segmentId: string
  /** Original segment index captured at dispatch; never parsed from segmentId. */
  segmentIndex: number
  /** Generating persona captured from the original dialogue request. */
  personaProfileId: string
  personaProfileVersion: string
  modality: string
  outputId: string
  text: string
  textHash: string
  /** Stop generation at registration, so a later Stop owns confirmation. */
  stopGeneration: number
  /**
   * Shared delivery-finalization promise for this output. It is created once,
   * so concurrent terminal evidence awaits the same commit outcome instead of
   * racing; a failed or in-flight commit is never reported as confirmed.
   */
  finalization: Promise<boolean> | null
  /** Releases the dispatch wait once terminal or explicit-unknown evidence arrives. */
  settle: (() => void) | null
  /** Bounds the execute wait so settled output work is not retained. */
  stopExecute: AbortController
}

const MAX_STAGE_TIMING_MS = 3_600_000

const DEFAULT_CYCLE_TIMINGS: CycleTimings = {
  selectionMs: 5_000,
  dialogueMs: 60_000,
  synthesisMs: 5_000,
  reactionMs: 1_500,
  rendererMs: 1_000,
  playbackMs: 30_000,
}

/**
 * Server-owned bounds for waiting on a peer or storage call, in milliseconds.
 * Each is validated once when the coordinator is created so an invalid budget
 * fails fast instead of leaving a call unbounded.
 */
export interface RuntimeBudgetConfig {
  /** Lifetime of an admitted input before it is ineligible for selection. */
  inputTtlMs: number
  /** Bound for a single storage or memory call. */
  storageTtlMs: number
  /** Bound for collecting cancellation evidence after Stop. */
  cancelTtlMs: number
}

const DEFAULT_RUNTIME_BUDGETS: RuntimeBudgetConfig = {
  inputTtlMs: 60_000,
  storageTtlMs: 60_000,
  cancelTtlMs: 60_000,
}

function assertBudget(name: keyof RuntimeBudgetConfig, value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_STAGE_TIMING_MS) {
    throw new RangeError(
      `invalid ${name}: expected an integer between 1 and ${MAX_STAGE_TIMING_MS}, got ${value}`,
    )
  }
  return value
}

/** Merges explicit storage/cancellation/input budgets over validated defaults. */
export function resolveRuntimeBudgets(
  overrides: Partial<RuntimeBudgetConfig> = {},
): RuntimeBudgetConfig {
  const merged: RuntimeBudgetConfig = { ...DEFAULT_RUNTIME_BUDGETS, ...overrides }
  return {
    inputTtlMs: assertBudget('inputTtlMs', merged.inputTtlMs),
    storageTtlMs: assertBudget('storageTtlMs', merged.storageTtlMs),
    cancelTtlMs: assertBudget('cancelTtlMs', merged.cancelTtlMs),
  }
}

/**
 * M5-local session, persona and context configuration. Peer requests carry
 * these values instead of hardcoded character/voice/persona/policy/provider
 * literals, so an operator can compose a session without editing the runtime.
 */
export interface SessionProfileConfig {
  characterProfileId: string
  characterProfileVersion: string
  voiceProfileId: string
  voiceProfileVersion: string
  personaSummary: string
  currentTopic: string
  interactionState: string
  policyVersion: string
  providerVersion: string
  allowedIntents: ReplyIntent[]
  maxTurns: number
  maxCharacters: number
}

const DEFAULT_SESSION_PROFILE: SessionProfileConfig = {
  characterProfileId: 'character-default',
  characterProfileVersion: '1',
  voiceProfileId: 'voice-default',
  voiceProfileVersion: '1',
  personaSummary: 'runtime persona',
  currentTopic: 'current',
  interactionState: 'calm',
  policyVersion: 'policy-v1',
  providerVersion: 'provider-v1',
  allowedIntents: [...REPLY_INTENTS],
  maxTurns: 8,
  maxCharacters: 2000,
}

function assertProfileString(name: keyof SessionProfileConfig, value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RangeError(`invalid ${name}: expected a non-empty string`)
  }
  return value
}

function assertProfileCount(name: keyof SessionProfileConfig, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`invalid ${name}: expected a non-negative integer, got ${value}`)
  }
  return value
}

/** Merges explicit profile overrides over validated defaults. */
export function resolveSessionProfile(
  overrides: Partial<SessionProfileConfig> = {},
): SessionProfileConfig {
  const merged: SessionProfileConfig = { ...DEFAULT_SESSION_PROFILE, ...overrides }
  assertProfileString('characterProfileId', merged.characterProfileId)
  assertProfileString('characterProfileVersion', merged.characterProfileVersion)
  assertProfileString('voiceProfileId', merged.voiceProfileId)
  assertProfileString('voiceProfileVersion', merged.voiceProfileVersion)
  assertProfileString('policyVersion', merged.policyVersion)
  assertProfileString('providerVersion', merged.providerVersion)
  if (typeof merged.personaSummary !== 'string') {
    throw new RangeError('invalid personaSummary: expected a string')
  }
  if (typeof merged.currentTopic !== 'string') {
    throw new RangeError('invalid currentTopic: expected a string')
  }
  if (typeof merged.interactionState !== 'string') {
    throw new RangeError('invalid interactionState: expected a string')
  }
  if (!Array.isArray(merged.allowedIntents) || merged.allowedIntents.length === 0) {
    throw new RangeError('invalid allowedIntents: expected at least one reply intent')
  }
  for (const intent of merged.allowedIntents) {
    if (!replyIntentSchema.safeParse(intent).success) {
      throw new RangeError(`invalid allowedIntents entry "${String(intent)}"`)
    }
  }
  assertProfileCount('maxTurns', merged.maxTurns)
  assertProfileCount('maxCharacters', merged.maxCharacters)
  return { ...merged, allowedIntents: [...merged.allowedIntents] }
}


function assertStageTiming(name: keyof CycleTimings, value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_STAGE_TIMING_MS) {
    throw new RangeError(
      `invalid ${name}: expected an integer between 1 and ${MAX_STAGE_TIMING_MS}, got ${value}`,
    )
  }
  return value
}

/**
 * Merges explicit stage timings over legacy aliases and validated defaults, so
 * an invalid budget fails fast before any peer is called.
 */
export function resolveCycleTimings(
  overrides: Partial<CycleTimings> = {},
  legacy: { decisionDeadlineMs?: number; reactionDeadlineMs?: number } = {},
): CycleTimings {
  const merged: CycleTimings = {
    selectionMs: overrides.selectionMs ?? legacy.decisionDeadlineMs ?? DEFAULT_CYCLE_TIMINGS.selectionMs,
    dialogueMs: overrides.dialogueMs ?? DEFAULT_CYCLE_TIMINGS.dialogueMs,
    synthesisMs: overrides.synthesisMs ?? DEFAULT_CYCLE_TIMINGS.synthesisMs,
    reactionMs: overrides.reactionMs ?? legacy.reactionDeadlineMs ?? DEFAULT_CYCLE_TIMINGS.reactionMs,
    rendererMs: overrides.rendererMs ?? DEFAULT_CYCLE_TIMINGS.rendererMs,
    playbackMs: overrides.playbackMs ?? DEFAULT_CYCLE_TIMINGS.playbackMs,
  }
  for (const name of Object.keys(merged) as (keyof CycleTimings)[]) {
    assertStageTiming(name, merged[name])
  }
  return merged
}

export type BoundedOutcome<T> =
  | { readonly kind: 'resolved'; readonly value: T }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'rejected' }

/**
 * Bounds a peer call by a server-owned deadline. When a signal is supplied, a
 * revocation (Stop) releases the caller without waiting for an uncooperative
 * peer; a null signal waits only for the timer, which playback uses so a
 * cancellation receipt can still be collected after Stop. The timer and abort
 * listener are always removed, and a late settle from the peer is observed so
 * it can never surface as an unhandled rejection.
 */
function boundedCall<T>(
  nowMs: number,
  deadline: Deadline,
  signal: AbortSignal | null,
  start: () => Promise<T>,
): Promise<BoundedOutcome<T>> {
  // Authority is checked before the peer is invoked: an already-revoked call
  // must not fire the peer and must have nothing left to observe.
  if (signal !== null && signal.aborted) return Promise.resolve({ kind: 'aborted' })
  let promise: Promise<T>
  try {
    promise = start()
  } catch {
    return Promise.resolve({ kind: 'rejected' })
  }
  const remainingMs = Math.max(0, deadline.atMs - nowMs)
  return new Promise<BoundedOutcome<T>>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const settle = (outcome: BoundedOutcome<T>): void => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      if (signal !== null) signal.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    const onAbort = (): void => settle({ kind: 'aborted' })
    timer = setTimeout(() => settle({ kind: 'timeout' }), remainingMs)
    if (signal !== null) {
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) settle({ kind: 'aborted' })
    }
    // The observer is always attached, including when a race already settled,
    // so a late resolve or rejection is never an unhandled rejection.
    promise.then(
      (value) => settle({ kind: 'resolved', value }),
      () => settle({ kind: 'rejected' }),
    )
  })
}

/** Forwards a source abort to a child controller and returns an unlinker. */
function linkAbort(source: AbortSignal, controller: AbortController): () => void {
  if (source.aborted) {
    controller.abort()
    return () => {}
  }
  const onAbort = (): void => controller.abort()
  source.addEventListener('abort', onAbort, { once: true })
  return () => source.removeEventListener('abort', onAbort)
}

/** Text with no letters or digits is punctuation-only and is not spoken. */
function isPunctuationOnly(text: string): boolean {
  return !/[\p{L}\p{N}]/u.test(text)
}

/** Reads a non-empty string field from unknown input without throwing. */
function stringField(source: unknown, key: string): string | null {
  if (typeof source !== 'object' || source === null) return null
  const value = (source as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Reads a non-empty string field nested one level below unknown input. */
function nestedStringField(source: unknown, outer: string, inner: string): string | null {
  if (typeof source !== 'object' || source === null) return null
  return stringField((source as Record<string, unknown>)[outer], inner)
}

/** Structural copy so an internal record can never be mutated through a read. */
function cloneRecord<T>(value: T): T {
  return structuredClone(value)
}

/**
 * Safe capability set used when a renderer cannot supply valid capabilities.
 * An empty action set leaves only the no-op reaction, so otherwise valid speech
 * still plays instead of the cycle crashing on a renderer fault.
 */
const SAFE_CAPABILITIES: CapabilitySnapshot = Object.freeze({
  rendererId: 'renderer-unavailable',
  characterId: 'character-unavailable',
  capabilityRevision: 0,
  actions: [],
})

/**
 * Outcome of one segment dispatch. `failed` marks a dependency or delivery
 * fault that must not be reported as a successfully completed cycle; `revoked`
 * means Stop or a cycle deadline released the work.
 */
type SegmentDispatchResult = 'delivered' | 'failed' | 'revoked' | 'skipped'

/**
 * Result of reconciling one receipt: the effective stage and whether a
 * committed terminal delivery backs it. Stop uses `confirmed` so it never
 * reports confirmation from a rejected receipt or a failed held commit.
 */
interface ReceiptHandling {
  stage: ReceiptStage | null
  confirmed: boolean
}

/** Outcome of finalizing one output's delivery from terminal evidence. */
type FinalizeOutcome = 'committed' | 'failed' | 'not-terminal'

/** The three provider calls M5 accounts for under NFR-04. */
type ProviderCall = 'selection' | 'reaction' | 'dialogue'

/** Honest disposition of one provider invocation. */
type ProviderDisposition = 'accepted' | 'invalid' | 'rejected' | 'failed' | 'timeout' | 'aborted'

/** Original identity of one provider invocation, recorded with its accounting. */
interface ProviderCallIdentity {
  call: ProviderCall
  requestId: string
  sessionId: string
  epoch: number
  turnId: string | null
  segmentId: string | null
}

/** Bounded provider outcome plus any usage available for this attempt. */
interface ProviderInvocation<T> {
  outcome: BoundedOutcome<T>
  usage: UsageRecord | null
  /** True only when the provider was actually invoked, not skipped as aborted. */
  invoked: boolean
}

/**
 * Reads only the structured `usage` field from an unknown provider value and
 * returns it only when it validates against the usage schema. Missing or
 * malformed usage stays null (unknown), never zero.
 */
function safeUsageFromValue(value: unknown): UsageRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const parsed = usageRecordSchema.safeParse((value as Record<string, unknown>).usage)
  return parsed.success ? parsed.data : null
}

/**
 * Reads only the structured `usage` field from a thrown error. No other error
 * field, message or credential content is ever copied into accounting.
 */
function safeUsageFromError(error: unknown): UsageRecord | null {
  if (typeof error !== 'object' || error === null) return null
  const parsed = usageRecordSchema.safeParse((error as Record<string, unknown>).usage)
  return parsed.success ? parsed.data : null
}

/** Validates an explicitly supplied session id before any state is created. */
function assertSessionId(value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RangeError('invalid sessionId: expected a non-empty string')
  }
  return value
}

/** Original acknowledgement retained for content/actor-aware idempotency. */
interface StoredInputAck {
  eventId: string
  epoch: number
  seq: number
  fingerprint: string
  actorId: string
}

export function createRuntimeCoordinator(deps: RuntimeCoordinatorDeps): RuntimeCoordinator {
  const sessionId = assertSessionId(deps.sessionId ?? `session-${randomUUID()}`)
  const budgets = resolveRuntimeBudgets({
    ...(deps.inputTtlMs !== undefined ? { inputTtlMs: deps.inputTtlMs } : {}),
    ...(deps.storageTtlMs !== undefined ? { storageTtlMs: deps.storageTtlMs } : {}),
    ...(deps.cancelTtlMs !== undefined ? { cancelTtlMs: deps.cancelTtlMs } : {}),
  })
  const profile = resolveSessionProfile(deps.profile)
  const timings = resolveCycleTimings(deps.timings, {
    ...(deps.decisionDeadlineMs !== undefined ? { decisionDeadlineMs: deps.decisionDeadlineMs } : {}),
    ...(deps.reactionDeadlineMs !== undefined ? { reactionDeadlineMs: deps.reactionDeadlineMs } : {}),
  })

  let epoch = 0
  let lifecycle: SessionLifecycle = 'stopped'
  let running = false
  let activeTurnId: string | null = null
  let performerStatus: 'unknown' | 'idle' | 'busy' = 'idle'
  let outputConfirmation: 'pending' | 'confirmed' | 'unknown' = 'confirmed'
  let snapshotRevision = 1
  let seq = 0
  let selectionAttempts = 0
  let reactionAttempts = 0
  let dialogueAttempts = 0
  let rejectedLate = 0
  let rejectedReceipts = 0
  let storageFailure = false
  let turnCounter = 0
  let idCounter = 0
  let turnActive = false
  let deferredKey: string | null = null
  let pending: InputEvent[] = []
  const inputAcks = new Map<string, StoredInputAck>()
  const controlAcks = new Map<string, ControlAck>()
  const events: RuntimeEvent[] = []
  const deliveries: CommitDelivery[] = []
  const outputRegistry = new Map<string, OutputRegistration>()
  // Effective fact per output/modality, used to authorize a delivery.
  const receiptFacts = new Map<string, ReceiptFact>()
  // Receipt-id history so a reused id can never rewrite its recorded facts,
  // even after a newer receipt has replaced the output-level fact.
  const receiptIdFacts = new Map<string, ReceiptFact>()
  const serverListeners = new Set<(message: ServerMessage) => void>()
  let activeAbort: AbortController | null = null
  // Only the output whose playback is currently in flight may change the
  // session-wide confirmation; older receipts stay historical evidence.
  let currentOutputId: string | null = null
  let stopGeneration = 0
  // Serializes every store append and atomic commit in allocated seq order.
  let writeChain: Promise<void> = Promise.resolve()
  // Once a write fails or is unverifiable, no later queued store write starts.
  let writeFailed = false

  function nextId(prefix: string): string {
    idCounter += 1
    return `${prefix}-${idCounter}`
  }

  function allocateSeq(): number {
    seq += 1
    return seq
  }

  function makeEvent(
    type: string,
    extra: Partial<RuntimeEvent> & { seq?: number; sourceModule?: RuntimeEvent['sourceModule'] } = {},
  ): RuntimeEvent {
    return runtimeEventSchema.parse({
      protocolVersion: '0.2',
      eventId: nextId('evt'),
      seq: extra.seq ?? allocateSeq(),
      timestampMs: deps.clock.nowMs(),
      sessionId,
      // Historical evidence (for example a delivery finalized after Stop) must
      // carry the epoch it was recorded under, not the current session epoch.
      epoch: extra.epoch ?? epoch,
      turnId: extra.turnId ?? null,
      segmentId: extra.segmentId ?? null,
      outputId: extra.outputId ?? null,
      type,
      sourceModule: extra.sourceModule ?? 'M5',
      // Honor an explicitly supplied version map (for example the delivery's
      // captured persona identity); never fabricate versions when none exist.
      versions: extra.versions ?? null,
      payload: extra.payload ?? {},
    })
  }

  /**
   * Delivers a publication to a snapshot of the current listeners. Each
   * listener receives its own structural copy and is isolated from the others:
   * a listener that mutates the message, adds/removes listeners, or throws can
   * never corrupt another listener or the storage write that triggered it.
   */
  function emit(message: ServerMessage): void {
    for (const listener of [...serverListeners]) {
      try {
        listener(cloneRecord(message))
      } catch {
        // A listener fault is isolated and must not fail the write unit.
      }
    }
  }

  /**
   * Serializes a write unit behind the previous one. Validation, degradation
   * and publication happen inside the unit so no later queued write can start
   * after a failed or unverifiable acknowledgement.
   */
  function enqueueWrite(unit: () => Promise<void>): Promise<void> {
    const run = writeChain.then(async () => {
      if (writeFailed) return
      await unit()
    })
    writeChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  function boundedCallUnit<T>(call: () => Promise<T>): Promise<BoundedOutcome<T>> {
    const nowMs = deps.clock.nowMs()
    return boundedCall(nowMs, { atMs: nowMs + budgets.storageTtlMs }, null, call)
  }

  /** A storage or memory fault revokes dispatch and blocks all new work. */
  function markWriteFailed(): void {
    if (writeFailed) return
    writeFailed = true
    lifecycle = 'degraded'
    storageFailure = true
    running = false
    activeAbort?.abort()
  }

  function publishEvent(event: RuntimeEvent): void {
    events.push(event)
    emit({
      protocolVersion: '0.2',
      messageId: nextId('srv'),
      sessionId,
      epoch: event.epoch,
      kind: 'session.event',
      payload: { seq: event.seq, type: event.type, data: event.payload },
    })
  }

  /**
   * Appends one event and publishes it as durable only after a valid
   * acknowledgement that matches the exact eventId and seq. A thrown, failed,
   * malformed, mismatched or conflicting acknowledgement degrades the session
   * and stops all later queued writes.
   */
  function commitEvent(event: RuntimeEvent): Promise<void> {
    return enqueueWrite(async () => {
      const outcome = await boundedCallUnit(() => deps.store.append(event))
      if (outcome.kind !== 'resolved') {
        markWriteFailed()
        return
      }
      const parsed = appendAckSchema.safeParse(outcome.value)
      if (
        !parsed.success ||
        parsed.data.eventId !== event.eventId ||
        parsed.data.seq !== event.seq ||
        parsed.data.outcome === 'failed'
      ) {
        markWriteFailed()
        return
      }
      publishEvent(event)
    })
  }

  async function persist(type: string, extra: Partial<RuntimeEvent> = {}): Promise<void> {
    await commitEvent(makeEvent(type, extra))
  }

  /**
   * Persists one provider attempt exactly once, with its original identity, an
   * honest disposition and any schema-valid usage. Synthetic M5 fallback and
   * cancellation results never reach this path.
   */
  function recordProviderCall(
    identity: ProviderCallIdentity,
    disposition: ProviderDisposition,
    usage: UsageRecord | null,
  ): Promise<void> {
    return persist('provider.call', {
      epoch: identity.epoch,
      turnId: identity.turnId,
      segmentId: identity.segmentId,
      payload: { ...identity, disposition, usage },
    })
  }

  /** Records usage that arrived after a timeout or abort, without a new attempt. */
  function recordLateUsage(identity: ProviderCallIdentity, usage: UsageRecord | null): Promise<void> {
    if (usage === null) return Promise.resolve()
    return persist('provider.usage.late', {
      epoch: identity.epoch,
      turnId: identity.turnId,
      segmentId: identity.segmentId,
      payload: { ...identity, usage },
    })
  }

  /**
   * Bounds one provider call and reports its transport outcome with any usage.
   * A timeout or abort keeps late observation separate from dispatch authority:
   * the raw promise is observed for usage only, and never dispatched again. This
   * avoids double-counting a timeout plus its later completion. `onInvoke` runs
   * only when the provider is actually invoked, so an already-aborted call that
   * boundedCall skips counts no attempt.
   */
  function invokeProvider<T>(
    identity: ProviderCallIdentity,
    deadline: Deadline,
    signal: AbortSignal,
    start: () => Promise<T>,
    onInvoke: () => void,
  ): Promise<ProviderInvocation<T>> {
    const holder: { promise: Promise<T> | null; error: unknown; invoked: boolean } = {
      promise: null,
      error: undefined,
      invoked: false,
    }
    const startTracked = (): Promise<T> => {
      holder.invoked = true
      onInvoke()
      let promise: Promise<T>
      try {
        promise = start()
      } catch (error) {
        // A synchronous throw is still an invocation; keep its error so any
        // schema-valid usage it carries is not lost.
        holder.error = error
        throw error
      }
      holder.promise = promise
      promise.then(undefined, (error: unknown) => {
        holder.error = error
      })
      return promise
    }
    return boundedCall(deps.clock.nowMs(), deadline, signal, startTracked).then((outcome) => {
      if (outcome.kind === 'resolved') {
        return { outcome, usage: safeUsageFromValue(outcome.value), invoked: holder.invoked }
      }
      if (outcome.kind === 'rejected') {
        return { outcome, usage: safeUsageFromError(holder.error), invoked: holder.invoked }
      }
      if (holder.promise !== null) {
        void holder.promise
          .then(
            (value) => recordLateUsage(identity, safeUsageFromValue(value)),
            (error: unknown) => recordLateUsage(identity, safeUsageFromError(error)),
          )
          .catch(() => {})
      }
      return { outcome, usage: null, invoked: holder.invoked }
    })
  }

  /**
   * Persists a `provider.call` only when the provider was actually invoked.
   * An already-aborted call that boundedCall skipped leaves no call record.
   */
  function recordInvokedProviderCall<T>(
    invocation: ProviderInvocation<T>,
    identity: ProviderCallIdentity,
    disposition: ProviderDisposition,
  ): Promise<void> {
    if (!invocation.invoked) return Promise.resolve()
    return recordProviderCall(identity, disposition, invocation.usage)
  }

  /**
   * Atomically persists a delivery and its event, then commits spoken memory.
   * The whole sequence is one serialized unit: only when every acknowledgement
   * validates does the event get published and the delivery count as committed.
   */
  function commitDeliveryUnit(delivery: CommitDelivery, deliveryEvent: RuntimeEvent): Promise<boolean> {
    let committed = false
    const run = enqueueWrite(async () => {
      const atomicOutcome = await boundedCallUnit(() =>
        deps.store.commitDeliveryWithEvent(delivery, deliveryEvent),
      )
      if (atomicOutcome.kind !== 'resolved') {
        markWriteFailed()
        return
      }
      const parsedAtomic = atomicCommitAckSchema.safeParse(atomicOutcome.value)
      if (!parsedAtomic.success) {
        markWriteFailed()
        return
      }
      const atomic = parsedAtomic.data
      if (
        atomic.event.outcome === 'failed' ||
        atomic.event.eventId !== deliveryEvent.eventId ||
        atomic.event.seq !== deliveryEvent.seq
      ) {
        markWriteFailed()
        return
      }
      if (atomic.delivery.status === 'failed' || atomic.delivery.status === 'conflict') {
        markWriteFailed()
        return
      }
      if (atomic.delivery.effectiveClassification !== delivery.classification) {
        markWriteFailed()
        return
      }
      publishEvent(deliveryEvent)
      const memoryOutcome = await boundedCallUnit(() => deps.commit.commit(delivery))
      if (memoryOutcome.kind !== 'resolved') {
        markWriteFailed()
        return
      }
      const parsedMemory = deliveryCommitAckSchema.safeParse(memoryOutcome.value)
      if (!parsedMemory.success) {
        markWriteFailed()
        return
      }
      const memoryAck = parsedMemory.data
      if (memoryAck.status === 'failed' || memoryAck.status === 'conflict') {
        markWriteFailed()
        return
      }
      if (memoryAck.effectiveClassification !== delivery.classification) {
        markWriteFailed()
        return
      }
      committed = true
    })
    return run.then(() => committed)
  }

  function snapshot(): BootstrapSnapshot {
    return bootstrapSnapshotSchema.parse({
      protocolVersion: '0.2',
      messageId: nextId('snap'),
      sessionId,
      epoch,
      seq,
      lifecycle,
      activeTurnId,
      performerStatus,
      outputConfirmation,
      // The snapshot reports the safe current renderer revision, not a
      // constant, so a recovered/faulty renderer is observable.
      capabilityRevision: readCapabilities().capabilityRevision,
    })
  }

  function contextForTurn(): CallContext {
    const controller = activeAbort ?? new AbortController()
    return { signal: controller.signal, deadline: { atMs: deps.clock.nowMs() + budgets.cancelTtlMs } }
  }

  /** Stage-scoped call context: same revocation signal, stage-owned deadline. */
  function stageContext(signal: AbortSignal, deadline: Deadline): CallContext {
    return { signal, deadline }
  }

  function active(startedEpoch: number, context: CallContext): boolean {
    return running && epoch === startedEpoch && !context.signal.aborted
  }

  function isDegraded(): boolean {
    return lifecycle === 'degraded'
  }

  /**
   * Session confirmation belongs only to the output that is still current
   * under the same epoch and Stop generation; anything older is historical.
   */
  function ownsConfirmation(registration: OutputRegistration): boolean {
    return (
      running &&
      epoch === registration.epoch &&
      stopGeneration === registration.stopGeneration &&
      currentOutputId === registration.outputId
    )
  }

  /**
   * Reads player status defensively: a thrown or malformed status, or a
   * contradictory idle claim with an active output, is not usable evidence.
   */
  function readPlayerStatus(): PlayerStatus | null {
    let raw: unknown
    try {
      raw = deps.player.status()
    } catch {
      return null
    }
    const parsed = playerStatusSchema.safeParse(raw)
    if (!parsed.success) return null
    if (parsed.data.idle && parsed.data.activeOutputId !== null) return null
    return parsed.data
  }

  /**
   * Reads renderer capabilities defensively: a thrown or malformed capability
   * set becomes the safe empty set, so an otherwise valid segment still speaks
   * with a no-op reaction instead of crashing the cycle.
   */
  function readCapabilities(): CapabilitySnapshot {
    try {
      const parsed = capabilitySnapshotSchema.safeParse(deps.renderer.capabilities())
      return parsed.success ? parsed.data : SAFE_CAPABILITIES
    } catch {
      return SAFE_CAPABILITIES
    }
  }

  function freshAt(startedEpoch: number, deadline: Deadline, signal: AbortSignal): boolean {
    return running && epoch === startedEpoch && !signal.aborted && !isDeadlineExpired(deps.clock, deadline)
  }

  function fresh(startedEpoch: number, deadline: { atMs: number }, context: CallContext): boolean {
    return active(startedEpoch, context) && !isDeadlineExpired(deps.clock, deadline)
  }

  /** Explicit safe outcome when dialogue produced no usable result. */
  function cancelledDialogueEnd(requestId: string, startedEpoch: number, turnId: string): DialogueEnd {
    return dialogueEndSchema.parse({
      requestId,
      sessionId,
      epoch: startedEpoch,
      turnId,
      status: 'cancelled',
      segmentCount: 0,
      usage: {
        provider: 'm5-runtime',
        requestedModel: 'none',
        resolvedModel: null,
        requestId,
        inputTokens: null,
        outputTokens: null,
        usageMissing: true,
        elapsedMs: 0,
        status: 'ok',
        pricingRef: null,
      },
    })
  }

  function submitInput(message: InputSubmitMessage, context: TrustedControlContext): Promise<InputAck> {
    const parsed = inputSubmitMessageSchema.safeParse(message)
    if (!parsed.success) {
      return Promise.resolve(
        inputAckSchema.parse({
          status: 'rejected',
          requestMessageId: stringField(message, 'messageId') ?? 'invalid',
          sessionId,
          epoch,
          code: 'malformed',
          message: 'input message failed schema validation',
          retryable: false,
        }),
      )
    }
    const valid = parsed.data
    const reject = (code: 'conflict' | 'stale' | 'storage_unavailable', text: string, retryable: boolean): InputAck =>
      inputAckSchema.parse({
        status: 'rejected',
        requestMessageId: valid.messageId,
        sessionId,
        epoch,
        code,
        message: text,
        retryable,
      })
    // Envelope identity is checked before any state change or dedup lookup.
    if (valid.sessionId !== sessionId) {
      return Promise.resolve(reject('conflict', 'input session does not match this runtime session', false))
    }
    const fingerprint = `${valid.payload.source}\u0000${valid.payload.text}`
    const stored = inputAcks.get(valid.messageId)
    if (stored !== undefined) {
      // Only the same content from the same actor is an idempotent duplicate;
      // any other reuse of the message id is a conflict, and the stored
      // original acknowledgement is returned rather than a synthesised one.
      if (stored.fingerprint !== fingerprint || stored.actorId !== context.actorId) {
        return Promise.resolve(reject('conflict', 'message id reused with different content or actor', false))
      }
      return Promise.resolve(
        inputAckSchema.parse({
          status: 'duplicate',
          requestMessageId: valid.messageId,
          eventId: stored.eventId,
          sessionId,
          epoch: stored.epoch,
          seq: stored.seq,
        }),
      )
    }
    if (valid.epoch !== epoch) {
      return Promise.resolve(reject('stale', 'input epoch is not the current epoch', true))
    }
    if (lifecycle === 'degraded') {
      return Promise.resolve(reject('storage_unavailable', 'input rejected while the session is degraded', true))
    }
    deferredKey = null
    const eventId = `event-${valid.messageId}`
    const receivedAtMs = deps.clock.nowMs()
    const acceptedInput: InputEvent = {
      eventId,
      sessionId,
      epoch,
      source: valid.payload.source,
      actorId: context.actorId,
      text: valid.payload.text,
      receivedAtMs,
      expiresAtMs: receivedAtMs + budgets.inputTtlMs,
      trust: 'untrusted-content',
    }
    pending.push(acceptedInput)
    // Record the validated accepted input as well as its event id for M6.
    const event = makeEvent('input.accepted', { payload: { eventId, input: acceptedInput } })
    // A newly accepted input advances the decision snapshot so a selection that
    // is still held cannot commit a plan built for an older candidate set.
    snapshotRevision += 1
    // The append is enqueued synchronously, so it keeps allocated seq order.
    void commitEvent(event)
    const ack = inputAckSchema.parse({
      status: 'accepted',
      requestMessageId: valid.messageId,
      eventId,
      sessionId,
      epoch,
      seq: event.seq,
    })
    inputAcks.set(valid.messageId, {
      eventId,
      epoch,
      seq: event.seq,
      fingerprint,
      actorId: context.actorId,
    })
    return Promise.resolve(ack)
  }

  async function control(
    message: ControlStopMessage | ControlResumeMessage,
    context: TrustedControlContext,
  ): Promise<ControlAck> {
    const stopRequested = stringField(message, 'kind') === 'control.stop'
    const action = stopRequested ? 'stop' : 'resume'
    const schema = stopRequested ? controlStopMessageSchema : controlResumeMessageSchema
    const refused = (reasonCode: string, text: string, previousEpoch = epoch): ControlAck =>
      controlAckSchema.parse({
        sessionId,
        requestId: nestedStringField(message, 'payload', 'requestId') ?? 'invalid',
        requestMessageId: stringField(message, 'messageId') ?? 'invalid',
        action,
        status: 'refused',
        previousEpoch,
        epoch,
        lifecycle,
        outputConfirmation,
        reasonCode,
        message: text,
      })
    const parsedControl = schema.safeParse(message)
    if (!parsedControl.success) {
      return refused('malformed', 'control message failed schema validation')
    }
    const valid = parsedControl.data
    // Envelope session identity is checked before any duplicate lookup.
    if (valid.sessionId !== sessionId) {
      return refused('conflict', 'control session does not match this runtime session')
    }
    // Trusted permission is checked before any duplicate lookup.
    if (!deps.authorizer.isOperator(context)) {
      return refused('unauthorized', 'control requires an authenticated operator context')
    }
    const existing = controlAcks.get(valid.payload.requestId)
    if (existing !== undefined) {
      if (existing.action !== action) {
        return refused('conflict', 'request id reused with a different control action')
      }
      // A legitimate retransmission may carry the epoch produced by its own
      // prior application, so it is answered before epoch correlation.
      return { ...existing, requestMessageId: valid.messageId, status: 'duplicate' }
    }
    if (valid.epoch !== epoch) {
      return refused('stale', 'control epoch is not the current epoch')
    }
    if (action === 'resume') {
      if (running) {
        return refused('already_running', 'resume refused while the session is already running')
      }
      if (lifecycle === 'degraded' || storageFailure) {
        return refused('storage_unavailable', 'resume refused while storage recovery is unconfirmed')
      }
      if (outputConfirmation !== 'confirmed') {
        return refused('evidence_pending', 'resume refused while output evidence is unconfirmed')
      }
      const playerStatus = readPlayerStatus()
      if (playerStatus === null || !playerStatus.idle) {
        return refused('performer_busy', 'resume refused while the performer is not confirmed idle')
      }
    }
    const previousEpoch = epoch
    epoch = nextEpoch(epoch)
    if (action === 'stop') {
      // Revocation is immediate; Stop never awaits cancellation or storage.
      running = false
      lifecycle = 'stopped'
      activeTurnId = null
      performerStatus = 'idle'
      outputConfirmation = 'pending'
      // Queued inputs are revoked with the turn they belonged to.
      pending = []
      deferredKey = null
      activeAbort?.abort()
      activeAbort = null
      stopGeneration += 1
      const generation = stopGeneration
      const stopEpoch = epoch
      const revokedOutputId = currentOutputId
      const cancelRequest = {
        requestId: message.payload.requestId,
        revokedEpoch: previousEpoch,
        newEpoch: epoch,
      }
      // Cancellation evidence is scoped to this Stop generation: a later Stop or
      // a later output owns the confirmation state, so an older completion must
      // never clear it. A null result cannot prove idle when player status
      // disagrees, and evidence must validate and correlate to the revoked epoch.
      void (async () => {
        try {
          const cancelDeadline = { atMs: deps.clock.nowMs() + budgets.cancelTtlMs }
          const cancelOutcome = await boundedCall(
            deps.clock.nowMs(),
            cancelDeadline,
            null,
            () => deps.player.cancel(cancelRequest, contextForTurn()),
          )
          if (generation !== stopGeneration || epoch !== stopEpoch) return
          if (revokedOutputId === null) {
            // No output was revoked, so no receipt can authorize confirmation:
            // only explicit valid idle status is evidence.
            const status = readPlayerStatus()
            outputConfirmation = status !== null && status.idle ? 'confirmed' : 'pending'
            return
          }
          // A thrown cancellation provides no evidence; a timeout or abort
          // provides none either, but an explicit idle status may still confirm.
          if (cancelOutcome.kind !== 'resolved') {
            const status = cancelOutcome.kind === 'rejected' ? null : readPlayerStatus()
            outputConfirmation = status !== null && status.idle ? 'confirmed' : 'pending'
            return
          }
          const rawEvidence = cancelOutcome.value
          if (rawEvidence === null) {
            const status = readPlayerStatus()
            outputConfirmation = status !== null && status.idle ? 'confirmed' : 'pending'
            return
          }
          const parsedEvidence = performanceReceiptSchema.safeParse(rawEvidence)
          if (
            !parsedEvidence.success ||
            parsedEvidence.data.sessionId !== sessionId ||
            parsedEvidence.data.epoch !== previousEpoch ||
            parsedEvidence.data.outputId !== revokedOutputId
          ) {
            outputConfirmation = 'pending'
            return
          }
          // Valid terminal cancellation evidence finalizes the revoked output's
          // historical delivery even if execute never settles. Confirmation then
          // reflects committed evidence, not the raw claimed stage: a rejected
          // receipt or a failed held commit must not be reported as confirmed.
          const handling = await handleReceipt(parsedEvidence.data)
          if (generation !== stopGeneration || epoch !== stopEpoch) return
          outputConfirmation = handling.confirmed ? 'confirmed' : 'pending'
        } catch {
          // Cancellation failure keeps the evidence unconfirmed (pending).
          if (generation === stopGeneration && epoch === stopEpoch) outputConfirmation = 'pending'
        }
      })()
      void persist('session.stopped', { payload: { requestId: message.payload.requestId } })
    } else {
      running = true
      lifecycle = 'running'
      activeAbort = new AbortController()
      performerStatus = 'idle'
      // Inputs admitted while stopped belong to the stopped epoch; they must not
      // leak into the resumed epoch's first cycle, so they are revoked here.
      pending = []
      deferredKey = null
      void persist('session.resumed', { payload: { requestId: message.payload.requestId } })
    }
    const ack = controlAckSchema.parse({
      sessionId,
      requestId: message.payload.requestId,
      requestMessageId: message.messageId,
      action,
      status: 'applied',
      previousEpoch,
      epoch,
      lifecycle,
      outputConfirmation,
      reasonCode: null,
      message: `${action} applied`,
    })
    controlAcks.set(message.payload.requestId, ack)
    // Return a detached copy so a caller mutating the acknowledgement cannot
    // corrupt the stored outcome answered to a later duplicate request.
    return cloneRecord(ack)
  }

  /**
   * Reconciles one receipt against the registered output and receipt-id
   * history. It returns the effective stage and whether a terminal delivery was
   * committed, so Stop can set confirmation from committed evidence rather than
   * the raw claimed stage.
   */
  async function handleReceipt(receipt: PerformanceReceipt): Promise<ReceiptHandling> {
    const registration = outputRegistry.get(receipt.outputId)
    const reject = async (reason: string): Promise<ReceiptHandling> => {
      rejectedReceipts += 1
      // Only the in-flight output may be forced unconfirmed; a receipt for any
      // other output remains separate historical evidence.
      if (registration !== undefined && ownsConfirmation(registration)) {
        outputConfirmation = 'unknown'
      }
      await persist('receipt.rejected', { outputId: receipt.outputId, payload: { reason } })
      return { stage: null, confirmed: false }
    }
    if (registration === undefined) return reject('unregistered-output')
    if (
      registration.sessionId !== receipt.sessionId ||
      registration.epoch !== receipt.epoch ||
      registration.turnId !== receipt.turnId ||
      registration.segmentId !== receipt.segmentId
    ) {
      return reject('identity-mismatch')
    }
    if (registration.modality !== receipt.modality) return reject('modality-mismatch')

    const key = `${receipt.outputId}:${receipt.modality}`
    const fact: ReceiptFact = {
      receiptId: receipt.receiptId,
      outputId: receipt.outputId,
      modality: receipt.modality,
      stage: receipt.stage,
      fingerprint: receiptFingerprint(receipt),
    }
    // Receipt-id history keeps a reused id from rewriting its own recorded
    // facts. The full immutable receipt must agree; a reused id with any
    // changed field is a conflict, never a downgrade of the output fact.
    const priorById = receiptIdFacts.get(receipt.receiptId)
    let action: ReconciliationAction
    if (priorById !== undefined) {
      action = priorById.fingerprint === fact.fingerprint ? 'ignore-duplicate' : 'conflict'
    } else {
      action = reconcileReceipt(receiptFacts.get(key) ?? null, fact).action
      if (action === 'record' || action === 'resolve-unknown') {
        receiptIdFacts.set(receipt.receiptId, fact)
      }
    }
    let outputFact = receiptFacts.get(key) ?? null
    if (action === 'record' || action === 'resolve-unknown') {
      outputFact = fact
      receiptFacts.set(key, fact)
    }
    const outputStage = outputFact?.stage ?? null

    await persist('output.receipt', {
      // Historical receipts keep the epoch of the output they belong to.
      epoch: registration.epoch,
      outputId: receipt.outputId,
      payload: { stage: receipt.stage, reconciliation: action, receipt },
    })

    // A terminal fact commits at most once. `confirmed` reflects a committed
    // terminal delivery, so a failed held commit remains unconfirmed rather
    // than being reported as confirmed evidence.
    let confirmed = false
    if (outputStage !== null && isTerminalReceiptStage(outputStage)) {
      confirmed = (await finalizeOutput(receipt.outputId)) !== 'failed'
    }
    // Confirmation mutates only for the owning output/epoch/generation, and a
    // conflict never regresses an already-confirmed fact.
    if (ownsConfirmation(registration) && action !== 'conflict') {
      if (outputStage === null) outputConfirmation = 'unknown'
      else if (isTerminalReceiptStage(outputStage)) outputConfirmation = confirmed ? 'confirmed' : 'unknown'
      else if (outputStage === 'unknown') outputConfirmation = 'unknown'
      else outputConfirmation = 'pending'
    }
    // Release the output wait only after the delivery outcome is final, so a
    // waiting cycle observes any committed delivery. Terminal evidence or an
    // explicit unknown both settle; an in-progress stage keeps waiting.
    if (outputStage !== null && (isTerminalReceiptStage(outputStage) || outputStage === 'unknown')) {
      const settle = registration.settle
      registration.settle = null
      settle?.()
    }
    return { stage: outputStage, confirmed }
  }

  /**
   * Commits one registered output's delivery from its terminal fact. The commit
   * is claimed once and shared: concurrent terminal evidence awaits the same
   * outcome, and a failed or still-pending commit is never reported as
   * confirmed just because finalization was already requested.
   */
  async function finalizeOutput(outputId: string): Promise<FinalizeOutcome> {
    const registration = outputRegistry.get(outputId)
    if (registration === undefined) return 'not-terminal'
    const fact = receiptFacts.get(`${outputId}:${registration.modality}`)
    if (fact === undefined || !isTerminalReceiptStage(fact.stage)) return 'not-terminal'
    if (registration.finalization === null) {
      registration.finalization = commitFinalization(registration, fact)
    }
    const committed = await registration.finalization
    return committed ? 'committed' : 'failed'
  }

  /** Runs the one delivery commit for an output and records it on success. */
  function commitFinalization(registration: OutputRegistration, fact: ReceiptFact): Promise<boolean> {
    const outputId = registration.outputId
    const classification = classifyAudioDelivery(fact.stage, true)
    const delivery: CommitDelivery = {
      sessionId: registration.sessionId,
      turnId: registration.turnId,
      segmentId: registration.segmentId,
      textHash: registration.textHash,
      text: registration.text,
      outputId,
      receiptId: fact.receiptId,
      classification,
      terminalOutcome:
        fact.stage === 'completed' ? 'completed' : fact.stage === 'cancelled' ? 'cancelled' : 'failed',
      modality: 'audio',
      // Immutable attribution captured at dispatch, so a late receipt or Stop
      // finalizes the historical record with its original index and persona.
      segmentIndex: registration.segmentIndex,
      personaProfileId: registration.personaProfileId,
      personaProfileVersion: registration.personaProfileVersion,
    }
    const deliveryEvent = makeEvent('delivery.committed', {
      epoch: registration.epoch,
      turnId: registration.turnId,
      segmentId: registration.segmentId,
      outputId,
      sourceModule: 'M6',
      versions: {
        personaProfileId: registration.personaProfileId,
        personaProfileVersion: registration.personaProfileVersion,
      },
      payload: { classification },
    })
    return commitDeliveryUnit(delivery, deliveryEvent).then(
      (committed) => {
        if (committed) deliveries.push(delivery)
        return committed
      },
      () => false,
    )
  }

  async function dispatchSegment(
    segment: DialogueSegment,
    turnId: string,
    startedEpoch: number,
    signal: AbortSignal,
    personaIdentity: { profileId: string; profileVersion: string },
  ): Promise<SegmentDispatchResult> {
    const synthesisDeadline = { atMs: deps.clock.nowMs() + timings.synthesisMs }
    if (!freshAt(startedEpoch, synthesisDeadline, signal)) return 'revoked'
    // A prior segment that left the output unknown or pending must not allow a
    // further segment to play until the outcome is resolved to confirmed.
    if (outputConfirmation !== 'confirmed') return 'skipped'
    const prepareRequest = {
      requestId: nextId('prepare'),
      sessionId,
      epoch: startedEpoch,
      turnId,
      segmentId: segment.segmentId,
      text: segment.text,
      voiceProfileId: profile.voiceProfileId,
      voiceProfileVersion: profile.voiceProfileVersion,
      deadline: synthesisDeadline,
    }
    const synthesisOutcome = await boundedCall(
      deps.clock.nowMs(),
      synthesisDeadline,
      signal,
      () => deps.synthesis.prepare(prepareRequest, stageContext(signal, synthesisDeadline)),
    )
    if (synthesisOutcome.kind === 'aborted') return 'revoked'
    if (synthesisOutcome.kind !== 'resolved') {
      await persist('dependency.failed', {
        turnId,
        segmentId: segment.segmentId,
        payload: { stage: 'synthesis', reason: synthesisOutcome.kind },
      })
      return 'failed'
    }
    const parsedPrepared = preparedAudioSchema.safeParse(synthesisOutcome.value)
    if (!parsedPrepared.success) {
      await persist('dependency.failed', {
        turnId,
        segmentId: segment.segmentId,
        payload: { stage: 'synthesis', reason: 'malformed' },
      })
      return 'failed'
    }
    const prepared = parsedPrepared.data
    if (!freshAt(startedEpoch, synthesisDeadline, signal)) return 'revoked'
    if (!prepared.ok) {
      await persist('dependency.failed', { turnId, segmentId: segment.segmentId, payload: { reason: prepared.reasonCode } })
      return 'failed'
    }
    if (
      prepared.requestId !== prepareRequest.requestId ||
      prepared.sessionId !== sessionId ||
      prepared.epoch !== startedEpoch ||
      prepared.turnId !== turnId ||
      prepared.segmentId !== segment.segmentId
    ) {
      await persist('result.stale', { turnId, segmentId: segment.segmentId, payload: { stage: 'synthesis' } })
      return 'failed'
    }
    // Capabilities are captured for the request and refreshed after the await,
    // because a held reaction may outlive a capability change.
    const capturedCapabilities = readCapabilities()
    const eligibleForRequest = [...new Set([...capturedCapabilities.actions.map((action) => action.actionId), NO_OP_ACTION])]
    const reactionDeadline = { atMs: deps.clock.nowMs() + timings.reactionMs }
    const decisionRequestId = nextId('decision')
    const decisionRequest = decisionRequestSchema.parse({
      requestId: decisionRequestId,
      sessionId,
      epoch: startedEpoch,
      turnId,
      segmentId: segment.segmentId,
      snapshotRevision,
      capabilityRevision: capturedCapabilities.capabilityRevision,
      task: 'segment-reaction',
      segmentText: segment.text,
      personaSummary: profile.personaSummary,
      interactionState: profile.interactionState,
      eligibleActionIds: eligibleForRequest,
      deadline: reactionDeadline,
      policyVersion: profile.policyVersion,
      providerVersion: profile.providerVersion,
    })
    // A reaction is optional decoration: failure or timeout must fall back to
    // no-op while otherwise valid speech continues. Only revocation (Stop or a
    // changed epoch) aborts the whole segment.
    const reactionIdentity: ProviderCallIdentity = {
      call: 'reaction',
      requestId: decisionRequestId,
      sessionId,
      epoch: startedEpoch,
      turnId,
      segmentId: segment.segmentId,
    }
    const reactionInvocation = await invokeProvider(
      reactionIdentity,
      reactionDeadline,
      signal,
      () => deps.reaction.decide(decisionRequest, stageContext(signal, reactionDeadline)),
      () => {
        reactionAttempts += 1
      },
    )
    const reactionOutcome = reactionInvocation.outcome
    if (reactionOutcome.kind === 'aborted') {
      await recordInvokedProviderCall(reactionInvocation, reactionIdentity, 'aborted')
      return 'revoked'
    }
    const decision: unknown = reactionOutcome.kind === 'resolved' ? reactionOutcome.value : undefined
    const currentCapabilities = readCapabilities()
    const eligibleNow = [...new Set([...currentCapabilities.actions.map((action) => action.actionId), NO_OP_ACTION])]
    const reactionExpired =
      reactionOutcome.kind !== 'resolved' || isDeadlineExpired(deps.clock, reactionDeadline)
    const parsedDecision = decisionResultSchema.safeParse(decision)
    const decisionCorrelated =
      parsedDecision.success &&
      parsedDecision.data.requestId === decisionRequestId &&
      parsedDecision.data.sessionId === sessionId &&
      parsedDecision.data.epoch === startedEpoch &&
      parsedDecision.data.turnId === turnId &&
      parsedDecision.data.segmentId === segment.segmentId
    let actionId: string = NO_OP_ACTION
    if (
      !reactionExpired &&
      parsedDecision.success &&
      parsedDecision.data.status === 'selected' &&
      parsedDecision.data.actionId !== null &&
      parsedDecision.data.requestId === decisionRequestId &&
      parsedDecision.data.sessionId === sessionId &&
      parsedDecision.data.epoch === startedEpoch &&
      parsedDecision.data.turnId === turnId &&
      parsedDecision.data.segmentId === segment.segmentId &&
      parsedDecision.data.snapshotRevision === snapshotRevision &&
      parsedDecision.data.capabilityRevision === currentCapabilities.capabilityRevision &&
      (parsedDecision.data.actionId === NO_OP_ACTION || eligibleNow.includes(parsedDecision.data.actionId))
    ) {
      actionId = parsedDecision.data.actionId
    }
    let reactionDisposition: ProviderDisposition
    if (reactionOutcome.kind === 'rejected') reactionDisposition = 'failed'
    else if (reactionOutcome.kind !== 'resolved') reactionDisposition = reactionOutcome.kind
    else if (reactionExpired) reactionDisposition = 'timeout'
    else if (!decisionCorrelated) reactionDisposition = 'invalid'
    else reactionDisposition = 'accepted'
    await recordInvokedProviderCall(reactionInvocation, reactionIdentity, reactionDisposition)
    const command = performanceCommandSchema.parse({
      outputId: nextId('output'),
      sessionId,
      epoch: startedEpoch,
      turnId,
      segmentId: segment.segmentId,
      audioRef: prepared.audioRef,
      subtitleText: segment.text,
      actionId,
      capabilityRevision: currentCapabilities.capabilityRevision,
    })
    const stopExecute = new AbortController()
    const registration: OutputRegistration = {
      sessionId,
      epoch: startedEpoch,
      turnId,
      segmentId: segment.segmentId,
      segmentIndex: segment.index,
      personaProfileId: personaIdentity.profileId,
      personaProfileVersion: personaIdentity.profileVersion,
      modality: 'audio',
      outputId: command.outputId,
      text: segment.text,
      textHash: createHash('sha256').update(segment.text, 'utf8').digest('hex'),
      stopGeneration,
      finalization: null,
      settle: null,
      stopExecute,
    }
    outputRegistry.set(command.outputId, registration)
    // A no-op reaction makes zero renderer calls; an avatar failure or timeout
    // must not cancel otherwise valid speech.
    if (actionId !== NO_OP_ACTION) {
      const rendererDeadline = { atMs: deps.clock.nowMs() + timings.rendererMs }
      await boundedCall(
        deps.clock.nowMs(),
        rendererDeadline,
        signal,
        () => deps.renderer.execute(command, stageContext(signal, rendererDeadline)),
      )
    }
    if (!running || epoch !== startedEpoch || signal.aborted) return 'revoked'
    // Playback is bounded by its own deadline but deliberately not by the
    // revocation signal: after Stop the player's cancellation receipt is still
    // valid evidence and must be collected rather than discarded.
    currentOutputId = command.outputId
    const outputKey = `${command.outputId}:audio`
    const playbackDeadline = { atMs: deps.clock.nowMs() + timings.playbackMs }
    const settled = new Promise<void>((resolve) => {
      registration.settle = resolve
    })
    const settleNow = (): void => {
      const resolve = registration.settle
      registration.settle = null
      resolve?.()
    }
    // The direct execute value is one evidence source; an endpoint receipt or
    // cancellation evidence resolves the same wait. The wait is released once
    // the output is terminal, explicitly unknown, unusable, or timed out, so a
    // valid terminal receipt may still arrive later and finalize the historical
    // delivery exactly once.
    let executeState: { promise: Promise<PerformanceReceipt> | null } = { promise: null }
    const processExecuteValue = async (raw: unknown): Promise<void> => {
      const parsed = performanceReceiptSchema.safeParse(raw)
      if (parsed.success) {
        await handleReceipt(parsed.data)
        return
      }
      rejectedReceipts += 1
      if (ownsConfirmation(registration)) outputConfirmation = 'unknown'
      await persist('receipt.rejected', {
        outputId: command.outputId,
        payload: { reason: 'malformed-direct' },
      })
    }
    const directTask = (async () => {
      const startExecute = (): Promise<PerformanceReceipt> => {
        const promise = deps.player.execute(command, stageContext(signal, playbackDeadline))
        executeState.promise = promise
        return promise
      }
      const outcome = await boundedCall(
        deps.clock.nowMs(),
        playbackDeadline,
        stopExecute.signal,
        startExecute,
      )
      if (outcome.kind === 'resolved') {
        await processExecuteValue(outcome.value)
      } else if (executeState.promise !== null) {
        // A late execute result after a timeout is still usable historical
        // evidence: observe it, finalize any delivery exactly once, and never
        // dispatch the output again.
        void executeState.promise
          .then((late) => processExecuteValue(late), () => {})
          .catch(() => {})
      }
      const ownStage = receiptFacts.get(outputKey)?.stage ?? null
      // Only an in-progress stage keeps waiting for terminal evidence; anything
      // else (terminal, unknown, rejected, timeout) releases the wait.
      if (ownStage !== 'accepted' && ownStage !== 'started') settleNow()
    })().catch(() => {
      settleNow()
    })
    await boundedCall(deps.clock.nowMs(), playbackDeadline, null, () => settled)
    stopExecute.abort()
    await directTask
    const outputStage = receiptFacts.get(outputKey)?.stage ?? null
    // Only a completed terminal stage is a delivered segment. A cancelled or
    // failed terminal playback is a safe failure, never a completed cycle, and
    // it keeps the terminal confirmation handleReceipt recorded.
    if (outputStage === 'completed') return 'delivered'
    if (outputStage !== null && isTerminalReceiptStage(outputStage)) return 'failed'
    if (ownsConfirmation(registration)) {
      outputConfirmation = outputStage === null || outputStage === 'unknown' ? 'unknown' : 'pending'
    }
    return 'failed'
  }

  async function runTurnImpl(): Promise<CycleOutcome> {
    if (turnActive) return { status: 'busy', turnId: null, plan: null, deliveries: [] }
    if (isDegraded()) return { status: 'degraded', turnId: null, plan: null, deliveries: [] }
    if (!running) return { status: 'inactive', turnId: null, plan: null, deliveries: [] }
    if (outputConfirmation !== 'confirmed') {
      return { status: 'blocked', turnId: null, plan: null, deliveries: [] }
    }
    const now = deps.clock.nowMs()
    const eligiblePending = pending.filter((candidate) => candidate.expiresAtMs > now)
    const droppedExpired = eligiblePending.length !== pending.length
    pending = eligiblePending
    if (eligiblePending.length === 0) {
      return { status: droppedExpired ? 'deferred' : 'no-input', turnId: null, plan: null, deliveries: [] }
    }
    const candidates = eligiblePending.slice(0, 5)
    const candidateKey = `${epoch}:${candidates.map((candidate) => candidate.eventId).join(',')}`
    if (deferredKey === candidateKey) return { status: 'deferred', turnId: null, plan: null, deliveries: [] }
    const startedEpoch = epoch
    let releaseCycle: (() => void) | null = null
    turnActive = true
    try {
      const selectionDeadline = { atMs: deps.clock.nowMs() + timings.selectionMs }
      const preSelectContext = contextForTurn()
      // A cycle-scoped controller lets a dialogue timeout revoke segment work
      // that is already awaiting synthesis, without aborting the session.
      const cycleAbort = new AbortController()
      const cycleSignal = cycleAbort.signal
      const unlinkCycle = linkAbort(preSelectContext.signal, cycleAbort)
      releaseCycle = () => {
        unlinkCycle()
        cycleAbort.abort()
      }
      if (!fresh(startedEpoch, selectionDeadline, preSelectContext)) {
        rejectedLate += 1
        await persist('result.stale', { payload: { stage: 'selection' } })
        return { status: 'stale', turnId: null, plan: null, deliveries: [] }
      }
      const requestSnapshotRevision = snapshotRevision
      const selectionRequest = selectionRequestSchema.parse({
        requestId: nextId('selection'),
        task: 'response-plan',
        sessionId,
        epoch: startedEpoch,
        snapshotRevision: requestSnapshotRevision,
        candidates,
        personaSummary: profile.personaSummary,
        currentTopic: profile.currentTopic,
        recentHistory: [],
        allowedIntents: profile.allowedIntents,
        deadline: selectionDeadline,
        policyVersion: profile.policyVersion,
        providerVersion: profile.providerVersion,
      })
      const context = contextForTurn()
      const selectionIdentity: ProviderCallIdentity = {
        call: 'selection',
        requestId: selectionRequest.requestId,
        sessionId,
        epoch: startedEpoch,
        turnId: null,
        segmentId: null,
      }
      const selectionInvocation = await invokeProvider(
        selectionIdentity,
        selectionDeadline,
        context.signal,
        () => deps.selection.select(selectionRequest, stageContext(context.signal, selectionDeadline)),
        () => {
          selectionAttempts += 1
        },
      )
      const selectionOutcome = selectionInvocation.outcome
      if (selectionOutcome.kind === 'timeout' || selectionOutcome.kind === 'aborted') {
        // An expired or revoked selection is stale and never falls back into
        // output; only a returned-but-invalid result may use the fallback.
        await recordInvokedProviderCall(selectionInvocation, selectionIdentity, selectionOutcome.kind)
        rejectedLate += 1
        await persist('result.stale', { payload: { stage: 'selection' } })
        return { status: 'stale', turnId: null, plan: null, deliveries: [] }
      }
      if (!fresh(startedEpoch, selectionDeadline, context)) {
        await recordInvokedProviderCall(selectionInvocation, selectionIdentity, 'rejected')
        rejectedLate += 1
        await persist('result.stale', { payload: { stage: 'selection' } })
        return { status: 'stale', turnId: null, plan: null, deliveries: [] }
      }
      // The authoritative decision snapshot advancing while the selection is
      // held makes this request stale; its obsolete candidate set may not fall
      // back into output. A provider-reported revision that disagrees with its
      // own request is instead an invalid result that the fallback may replace.
      if (snapshotRevision !== requestSnapshotRevision) {
        await recordInvokedProviderCall(selectionInvocation, selectionIdentity, 'rejected')
        rejectedLate += 1
        await persist('result.stale', { payload: { stage: 'selection' } })
        return { status: 'stale', turnId: null, plan: null, deliveries: [] }
      }
      const result: unknown = selectionOutcome.kind === 'resolved' ? selectionOutcome.value : undefined
      const parsed = selectionResultSchema.safeParse(result)
      const offered =
        parsed.success && parsed.data.disposition === 'respond'
          ? candidates.some((candidate) => candidate.eventId === parsed.data.selectedEventIds[0])
          : false
      const consistent =
        parsed.success &&
        parsed.data.requestId === selectionRequest.requestId &&
        parsed.data.sessionId === sessionId &&
        parsed.data.epoch === startedEpoch &&
        parsed.data.snapshotRevision === requestSnapshotRevision
      // Configured intents constrain the provider plan as well as the fallback.
      const intentAllowed =
        parsed.success &&
        parsed.data.replyIntent !== null &&
        profile.allowedIntents.includes(parsed.data.replyIntent)
      const acceptedPlan =
        parsed.success && consistent && offered && intentAllowed && parsed.data.disposition === 'respond'
      const deferredPlan =
        parsed.success && consistent && parsed.data.disposition === 'defer'
      await recordInvokedProviderCall(
        selectionInvocation,
        selectionIdentity,
        selectionOutcome.kind === 'rejected'
          ? 'failed'
          : acceptedPlan || deferredPlan
            ? 'accepted'
            : 'invalid',
      )
      // The awaited accounting write can outlive Stop, the selection deadline or
      // a snapshot advance. Re-verify authority before reserving or falling back.
      if (!fresh(startedEpoch, selectionDeadline, context) || snapshotRevision !== requestSnapshotRevision) {
        rejectedLate += 1
        await persist('result.stale', { epoch: startedEpoch, payload: { stage: 'selection' } })
        return { status: 'stale', turnId: null, plan: null, deliveries: [] }
      }
      let plan: SelectionResult
      if (deferredPlan && parsed.success) {
        deferredKey = candidateKey
        // Record the provider's validated defer decision for reconstruction.
        await persist('selection.plan', {
          epoch: startedEpoch,
          payload: { plan: parsed.data, synthetic: false },
        })
        return { status: 'deferred', turnId: null, plan: parsed.data, deliveries: [] }
      }
      if (!parsed.success || !consistent || !offered || !intentAllowed) {
        // Only a currently valid M5 fallback may replace an invalid result, and
        // the documented answer fallback is used only when that intent is
        // configured; otherwise the turn is deferred rather than mislabelled.
        const fallback = selectFallback(candidates, deps.clock)
        if (fallback === null || !profile.allowedIntents.includes(fallback.replyIntent)) {
          deferredKey = candidateKey
          return { status: 'deferred', turnId: null, plan: parsed.success ? parsed.data : null, deliveries: [] }
        }
        const chosen = candidates.find((candidate) => candidate.eventId === fallback.eventId)
        if (chosen === undefined) {
          deferredKey = candidateKey
          return { status: 'deferred', turnId: null, plan: null, deliveries: [] }
        }
        plan = {
          requestId: selectionRequest.requestId,
          sessionId,
          epoch: startedEpoch,
          snapshotRevision,
          disposition: 'respond',
          selectedEventIds: [chosen.eventId],
          replyIntent: fallback.replyIntent,
          reasonCode: 'm5-fallback',
          provider: 'm5-fallback',
          modelVersion: 'm5-fallback',
          usage: { provider: 'm5-fallback', requestedModel: 'none', resolvedModel: null, requestId: selectionRequest.requestId, inputTokens: null, outputTokens: null, usageMissing: true, elapsedMs: 0, status: 'ok', pricingRef: null },
        }
      } else {
        plan = parsed.data
      }
      const chosen = candidates.find((candidate) => candidate.eventId === (plan.selectedEventIds[0] ?? ''))
      if (chosen === undefined || plan.replyIntent === null || chosen.expiresAtMs <= deps.clock.nowMs()) {
        deferredKey = candidateKey
        return { status: 'deferred', turnId: null, plan, deliveries: [] }
      }
      deferredKey = null
      turnCounter += 1
      const turnId = `turn-${turnCounter}`
      activeTurnId = turnId
      performerStatus = 'busy'
      snapshotRevision += 1
      // Persist the validated plan (provider or synthetic fallback) with its
      // original identity so M6 can reconstruct the turn record.
      await persist('selection.plan', {
        epoch: startedEpoch,
        payload: { plan, synthetic: plan.provider === 'm5-fallback' },
      })
      await persist('turn.started', { turnId, payload: { replyIntent: plan.replyIntent } })
      const dialogueDeadline = { atMs: deps.clock.nowMs() + timings.dialogueMs }
      // Re-check authority after the awaited persistence write: Stop or deadline
      // expiry during a held append must not invoke dialogue or dispatch output.
      if (!fresh(startedEpoch, dialogueDeadline, context)) {
        rejectedLate += 1
        await persist('result.stale', { turnId, payload: { stage: 'dialogue' } })
        return { status: 'stale', turnId, plan, deliveries: [] }
      }
      const turnDeliveries: CommitDelivery[] = []
      const dialogueRequest = dialogueRequestSchema.parse({
        requestId: nextId('dialogue'),
        sessionId,
        epoch: startedEpoch,
        turnId,
        selectedInput: { eventId: chosen.eventId, text: chosen.text },
        characterProfileId: profile.characterProfileId,
        characterProfileVersion: profile.characterProfileVersion,
        responsePlan: {
          selectionRequestId: selectionRequest.requestId,
          selectedEventId: chosen.eventId,
          replyIntent: plan.replyIntent,
          policyVersion: profile.policyVersion,
        },
        confirmedEventRefs: [],
        contextLimits: { maxTurns: profile.maxTurns, maxCharacters: profile.maxCharacters },
      })
      // Capture the generating persona immediately, before the mutable request
      // object is handed to M4, so peer mutation cannot change what is recorded.
      const personaIdentity = {
        profileId: dialogueRequest.characterProfileId,
        profileVersion: dialogueRequest.characterProfileVersion,
      }
      let cycleFailed = false
      let sinkOpen = true
      let segmentChain: Promise<void> = Promise.resolve()
      let inFlight: Promise<void> | null = null
      const seenSegmentIds = new Set<string>()
      let expectedIndex = 0
      const segmentSink = (rawSegment: DialogueSegment): Promise<void> => {
        // Admission is decided when the producer invokes the sink; queued work
        // retains admission so concurrent, un-awaited callbacks stay ordered.
        if (!sinkOpen || !active(startedEpoch, context)) return Promise.resolve()
        const run = async (): Promise<void> => {
          if (!active(startedEpoch, context)) return
          const parsedSegment = dialogueSegmentSchema.safeParse(rawSegment)
          if (!parsedSegment.success) {
            cycleFailed = true
            void persist('segment.rejected', { turnId, payload: { reason: 'malformed' } })
            return
          }
          const segment = parsedSegment.data
          if (
            segment.requestId !== dialogueRequest.requestId ||
            segment.sessionId !== sessionId ||
            segment.epoch !== startedEpoch ||
            segment.turnId !== turnId
          ) {
            cycleFailed = true
            void persist('segment.rejected', { turnId, segmentId: segment.segmentId, payload: { reason: 'correlation' } })
            return
          }
          if (seenSegmentIds.has(segment.segmentId)) {
            cycleFailed = true
            void persist('segment.rejected', { turnId, segmentId: segment.segmentId, payload: { reason: 'duplicate-id' } })
            return
          }
          if (segment.index !== expectedIndex || expectedIndex >= MAX_DIALOGUE_SEGMENTS) {
            cycleFailed = true
            void persist('segment.rejected', { turnId, segmentId: segment.segmentId, payload: { reason: 'index' } })
            return
          }
          seenSegmentIds.add(segment.segmentId)
          expectedIndex += 1
          if (isPunctuationOnly(segment.text)) {
            void persist('segment.skipped', {
              turnId,
              segmentId: segment.segmentId,
              payload: { reason: 'punctuation-only' },
            })
            return
          }
          const before = deliveries.length
          // Persist the accepted segment with its full validated content and
          // original identity before dispatch, preserving ordering.
          await persist('segment.accepted', {
            epoch: startedEpoch,
            turnId,
            segmentId: segment.segmentId,
            payload: { segment },
          })
          const result = await dispatchSegment(segment, turnId, startedEpoch, cycleSignal, personaIdentity)
          if (result === 'failed') cycleFailed = true
          turnDeliveries.push(...deliveries.slice(before))
        }
        segmentChain = segmentChain.then(run, run)
        inFlight = segmentChain
        return segmentChain
      }
      const dialogueIdentity: ProviderCallIdentity = {
        call: 'dialogue',
        requestId: dialogueRequest.requestId,
        sessionId,
        epoch: startedEpoch,
        turnId,
        segmentId: null,
      }
      let dialogueInvocation: ProviderInvocation<DialogueEnd>
      try {
        dialogueInvocation = await invokeProvider(
          dialogueIdentity,
          dialogueDeadline,
          cycleSignal,
          () =>
            deps.dialogue.generate(dialogueRequest, stageContext(cycleSignal, dialogueDeadline), {
              segment: segmentSink,
            }),
          () => {
            dialogueAttempts += 1
          },
        )
      } finally {
        sinkOpen = false
      }
      const dialogueOutcome = dialogueInvocation.outcome
      // Revoke segment work the dialogue call did not complete (timeout or Stop)
      // so a held synthesis can never later play audio for a dead turn.
      if (dialogueOutcome.kind !== 'resolved') cycleAbort.abort()
      if (inFlight !== null) await inFlight
      let end: DialogueEnd
      let dialogueDisposition: ProviderDisposition
      if (dialogueOutcome.kind === 'resolved') {
        const parsedEnd = dialogueEndSchema.safeParse(dialogueOutcome.value)
        if (
          parsedEnd.success &&
          parsedEnd.data.requestId === dialogueRequest.requestId &&
          parsedEnd.data.sessionId === sessionId &&
          parsedEnd.data.epoch === startedEpoch &&
          parsedEnd.data.turnId === turnId
        ) {
          end = parsedEnd.data
          dialogueDisposition = 'accepted'
        } else {
          await persist('dependency.failed', { turnId, payload: { stage: 'dialogue', reason: 'malformed' } })
          end = cancelledDialogueEnd(dialogueRequest.requestId, startedEpoch, turnId)
          dialogueDisposition = 'invalid'
        }
      } else {
        if (dialogueOutcome.kind === 'timeout') {
          await persist('dependency.failed', { turnId, payload: { stage: 'dialogue' } })
        }
        end = cancelledDialogueEnd(dialogueRequest.requestId, startedEpoch, turnId)
        dialogueDisposition = dialogueOutcome.kind === 'rejected' ? 'failed' : dialogueOutcome.kind
      }
      await recordInvokedProviderCall(dialogueInvocation, dialogueIdentity, dialogueDisposition)
      if (dialogueDisposition === 'accepted') {
        // Persist the validated dialogue end for M6 reconstruction.
        await persist('dialogue.result', {
          epoch: startedEpoch,
          turnId,
          payload: { end },
        })
      }
      // A completed end must agree with the segments actually accepted.
      if (end.status === 'completed' && end.segmentCount !== expectedIndex) {
        cycleFailed = true
        await persist('dependency.failed', {
          turnId,
          payload: { stage: 'dialogue', reason: 'segment-count-mismatch' },
        })
      }
      pending = pending.filter((candidate) => candidate.eventId !== chosen.eventId)
      activeTurnId = null
      performerStatus = 'idle'
      if (!isDegraded()) {
        await persist('turn.ended', { turnId, payload: { status: end.status } })
      }
      if (isDegraded()) {
        return { status: 'degraded', turnId, plan, deliveries: turnDeliveries }
      }
      // A dependency or playback fault is never reported as a completed cycle.
      const completed = end.status === 'completed' && !cycleFailed
      return { status: completed ? 'completed' : 'cancelled', turnId, plan, deliveries: turnDeliveries }
    } finally {
      turnActive = false
      releaseCycle?.()
    }
  }

  /**
   * Cycle driver. It returns detached copies so a caller mutating the outcome
   * (its plan or deliveries) can never corrupt internal trace state.
   */
  async function runTurn(): Promise<CycleOutcome> {
    const outcome = await runTurnImpl()
    return {
      status: outcome.status,
      turnId: outcome.turnId,
      plan: outcome.plan === null ? null : cloneRecord(outcome.plan),
      deliveries: outcome.deliveries.map((delivery) => cloneRecord(delivery)),
    }
  }

  const endpoint: RuntimeEndpointPort = {
    snapshot: () => Promise.resolve(snapshot()),
    submitInput,
    control,
    async handlePlayerMessage(message) {
      const parsed = playerMessageSchema.safeParse(message)
      if (!parsed.success) {
        // The envelope/payload correlation is unverifiable, so it cannot be
        // attributed to the in-flight output; it is rejected without changing
        // confirmation or storage progress.
        rejectedReceipts += 1
        await persist('receipt.rejected', { payload: { reason: 'malformed-envelope' } })
        return
      }
      // Envelope correlation is checked before payload handling: a receipt for
      // another session is never this runtime's evidence.
      if (parsed.data.sessionId !== sessionId) {
        rejectedReceipts += 1
        await persist('receipt.rejected', { payload: { reason: 'envelope-session-mismatch' } })
        return
      }
      await handleReceipt(parsed.data.payload)
    },
    onServerMessage(listener) {
      serverListeners.add(listener)
      return () => {
        serverListeners.delete(listener)
      }
    },
  }

  return {
    endpoint,
    runTurn,
    lifecycle: () => lifecycle,
    epoch: () => epoch,
    events: () => events.map((event) => cloneRecord(event)),
    deliveries: () => deliveries.map((delivery) => cloneRecord(delivery)),
    metrics: () => ({
      selectionAttempts,
      reactionAttempts,
      dialogueAttempts,
      rejectedLate,
      rejectedReceipts,
      storageFailure,
    }),
  }
}
