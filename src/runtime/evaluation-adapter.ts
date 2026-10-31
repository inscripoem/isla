import { randomUUID } from 'node:crypto'
import type {
  ClockPort,
  CommitDelivery,
  ControlResumeMessage,
  DeliveryClassification,
  EventStorePort,
  HistoryQueryPort,
  InputSource,
  InputSubmitMessage,
  RuntimeEvent,
  TrustedControlContext,
  UsageRecord,
} from '../contracts'
import {
  APPLICATION_CONTRACT_VERSION,
  MAX_SELECTION_CANDIDATES,
  inputSourceSchema,
  usageRecordSchema,
} from '../contracts'
import type { EvalCase, Variant, VariantRun } from '../evaluation/comparison'
import type { AttemptOutcome, AttemptRecord, AttemptUsage, StageTiming } from '../evaluation/metrics'
import { createMonotonicClock } from './clock'
import { createDialogueComposition, createRuntimeComposition } from './composition'
import type { RuntimeComposition } from './composition'
import { createRuntimeAuthorizer } from './control-policy'
import type { CycleOutcome, CycleStatus } from './coordinator'
import { createDeadlineGate } from './deadline'
import type {
  DialogueOutcomeEvent,
  DialogueOutcomeObservation,
  DialogueOutcomeObserver,
} from './dialogue-outcome'
import { validateProductionPeers } from './production'
import type { ProductionPeers } from './production'

/**
 * M5 evaluation adapter — the production `ComparisonDeps.runVariant` seam.
 *
 * M6's runner (`src/evaluation/comparison.ts`) aggregates; it does not compose.
 * This adapter composes: for each case it builds a fresh runtime composition
 * from the variant's explicitly configured deployment peers, drives a real
 * input through the real control path (Resume, then `input.submit`), runs the
 * turn, and maps the coordinator's outcome and recorded evidence into an
 * `AttemptRecord`. The runner owns `caseId`, `variantId` and `cold`; everything
 * else comes from here.
 *
 * Boundaries this adapter keeps:
 *
 *  - **Prerequisites are checked before any attempt.** An unconfigured variant,
 *    variant metadata that disagrees with the configured peers, invalid peers, a
 *    missing consumer, a case condition this adapter cannot execute or a session
 *    id that is not fresh is an honest `{ ran: false, reason }` — nothing was
 *    attempted, so nothing is claimed. The not-run boundary sits before the
 *    first provider invocation: building the composition, attaching the
 *    consumer, Resume and input admission never invoke a selection, reaction,
 *    dialogue or synthesis provider.
 *  - **Prepared inputs are an explicit opt-in and stay bounded.** Without an
 *    input plan the adapter submits `EvalCase.input` once, as it always has.
 *    With an explicit `prepared` plan a resolver keyed by the case id supplies a
 *    batch that is validated, copied to `source`/`text`/`actorId` only and
 *    admitted in order before exactly one `runTurn`; an unknown plan mode, a
 *    missing resolver, a resolver error, or a missing, invalid, empty or
 *    oversized (> `MAX_SELECTION_CANDIDATES`) batch is a not-run before any
 *    runtime or provider work. A batch whose admission fails after at least one
 *    input was accepted is recorded as a failed attempt with its retained
 *    admission evidence and no selection; `runTurn` is skipped rather than run
 *    over a partial batch. The runtime still generates ids, timestamps, persona
 *    and history, so this prepares bounded inputs, not a corpus replay.
 *  - **A supplied `replyIntent` is refused, not ignored.** ADR-007 D8 makes
 *    `EvalCase.replyIntent` the actual prompt condition that renders the reply —
 *    M3's selection decision — and distinct from the human `labels.intent`.
 *    This adapter drives the configured selection port and cannot execute a
 *    supplied intent without overriding M3's decision, so a case carrying one is
 *    refused before any work; `labels` are recorded by M6 and `heldOut` is a
 *    runner concern, so neither needs execution handling here.
 *  - **Once the input is admitted, failures stay records.** A turn that throws,
 *    a non-completed cycle status, a degraded session, an unconfirmed delivery
 *    or a teardown fault all produce a recorded attempt; none of them is
 *    converted into a not-run or silently dropped.
 *  - **`completed` needs matching effective delivery evidence.** The
 *    coordinator's `CycleOutcome.completed` alone can include a dialogue that
 *    produced no speech (zero outputs) or a delivery commit that did not
 *    validate. The bench may only claim completion when the attempt committed at
 *    least one delivery and every committed delivery of the turn is
 *    `fully-delivered`.
 *  - **Execution failure is distinguished from cancellation by recorded
 *    evidence.** The coordinator maps several failed dialogue and dispatch paths
 *    to `CycleOutcome.cancelled`, so the adapter consults the recorded
 *    `dependency.failed` events, the dialogue end status, the turn end status
 *    and the committed deliveries. A recorded operator Stop (`session.stopped`)
 *    is the only confirmed cancellation; every other non-completed cycle is
 *    reported as `failed` with the evidence that caused it, so an execution
 *    failure never disappears from the failure rate.
 *  - **A no-op consumer never produces bench completion.** Receipts are
 *    produced by the attached consumer's own playback machine; the adapter never
 *    fabricates one, and a consumer that confirms nothing leaves the delivery
 *    uncommitted and the attempt non-completed.
 *  - **Timing stays unknown.** Every stage timing and `totalMs` is `null`:
 *    `CycleTimings` are peer budgets, not observed durations, and no agreed
 *    method exists yet for `firstAudibleMs`/`stopToSilenceMs` (M1/M2) or for
 *    per-stage wall time (issue #41). A successful turn's wall time is never
 *    reported as input-to-first-audible.
 *  - **Usage is joined by full invocation identity.** Each `provider.call` event
 *    is one M5 port invocation; a `provider.usage.late` event fills the same
 *    invocation rather than adding an attempt. Port invocation counts are not
 *    underlying model request/retry counts, so `attempts` stays `null` and the
 *    observation callback exposes the labelled port counts. Usage is summed only
 *    when every invoked call reported counts; otherwise the fields stay `null`
 *    and `usageMissing` is true. `costUsd` is always `null`: the runtime's
 *    `UsageRecord` carries no cost, and `pricingRef` is not an amount.
 *  - **Teardown preserves evidence and reports its own faults.** The observation
 *    is taken after the admitted drain (`settle()`), so admitted writes and late
 *    usage are included and anything later stays unknown. A drain, consumer
 *    detach or composition disposal fault is carried in the returned attempt's
 *    `failureReason`, appended after any earlier execution failure, so it stays
 *    visible even when no observation callback is configured and the durable
 *    diagnostic write fails; the `evaluation.cleanup.failed` event and the
 *    observation are additional channels, and a fault during a refused
 *    pre-attempt cleanup is appended to the not-run reason. The outcome and
 *    usage are never rewritten by a cleanup fault, and an observation-callback
 *    exception alone is a diagnostic: it never changes the record or its reason.
 */

/**
 * One variant's deployment peers. The requested variant is matched by `id` and
 * its `kind`/`combined` metadata must agree with the configured variant, so a
 * caller cannot execute one peer set under another variant's label.
 */
export interface EvaluationVariantConfig {
  readonly variant: Variant
  readonly peers: ProductionPeers
}

/**
 * Explicit audio consumer. The adapter binds the composition's bridge transport
 * to it and keeps it attached through the drain. The consumer owns playback and
 * its receipts: the adapter never synthesises a delivery receipt, and a consumer
 * that publishes none leaves the attempt uncompleted.
 *
 * `detach()` is called whenever `attach()` was invoked, including after a failed
 * attach, and must be safe to call then.
 */
export interface EvaluationConsumer {
  attach(composition: RuntimeComposition): Promise<void> | void
  detach?(): Promise<void> | void
}

/** M5 port invocations observed by the coordinator — not provider request counts. */
export interface EvaluationPortInvocations {
  readonly selection: number
  readonly reaction: number
  readonly dialogue: number
}

/** Per-invocation diagnostics: where an invoked call's usage came from. */
export interface EvaluationInvocationObservation {
  readonly call: string
  readonly requestId: string
  readonly disposition: string
  /** `reported` with the call, `late` after a timeout, or `missing` (no record). */
  readonly usage: 'reported' | 'late' | 'missing'
  /**
   * The usage record's own `usageMissing` flag; `null` when no record exists.
   * M4-01 reports a record that declares its counts missing, so provenance
   * `reported` with `usageMissing: true` is a normal current state.
   */
  readonly usageMissing: boolean | null
}

export interface EvaluationAttemptObservation {
  /** The generated session id, so a caller can retrieve the raw evidence. */
  readonly sessionId: string
  readonly variantId: string
  readonly caseId: string
  /** The coordinator's raw cycle status; `null` when the turn threw before one. */
  readonly cycleStatus: CycleStatus | null
  /** The recorded dialogue end status (`dialogue.result`), or `null`. */
  readonly dialogueEndStatus: string | null
  /** The recorded turn end status (`turn.ended`), or `null`. */
  readonly turnEndStatus: string | null
  /** Recorded dependency failures as `stage: reason` strings, in order. */
  readonly dependencyFailures: readonly string[]
  readonly outputConfirmation: 'pending' | 'confirmed' | 'unknown'
  readonly deliveries: readonly {
    readonly turnId: string
    readonly classification: DeliveryClassification
    readonly terminalOutcome: string
  }[]
  readonly invocations: readonly EvaluationInvocationObservation[]
  readonly portInvocations: EvaluationPortInvocations
  /**
   * The dialogue port's projected generation/discard accounting for this attempt,
   * in order. Observational only: it adds no storage write of its own (M5 owns the
   * runtime's persistence and delivery decisions, M6 owns the storage
   * infrastructure), is never a provider attempt, and is never part of spoken
   * history. Each frozen observation keeps the identity of its own request, so a
   * report that arrives outside the current turn is still attributed to the
   * request that produced it.
   */
  readonly dialogueOutcomes: readonly DialogueOutcomeObservation[]
  /**
   * Reports the M5 projection refused, as M5-authored reasons (never raw producer
   * data), plus a fixed label when a consumer-visible observer fault was isolated.
   */
  readonly dialogueOutcomeFailures: readonly string[]
  /** Set when the admitted drain threw despite its contract; the record is unaffected. */
  readonly drainFailure: string | null
  /** Consumer detach and composition disposal faults; the record is unaffected. */
  readonly teardownFailure: string | null
}

/**
 * One prepared input the adapter may admit. Only the three fields the adapter
 * owns are carried: the input contract's `source`/`text` payload plus the
 * `actorId` of the trusted input context. The runtime still generates the event
 * id, timestamps, trust classification and every other `InputEvent` field, so a
 * prepared input is not a replayed event.
 */
export interface PreparedEvaluationInput {
  readonly source: InputSource
  readonly text: string
  readonly actorId: string
}

/**
 * How the adapter produces the inputs it admits for one case before its single
 * `runTurn`.
 *
 * - `case-input` (the default when no plan is configured) submits
 *   `EvalCase.input` once, exactly as before.
 * - `prepared` is the explicit opt-in: the resolver receives **only the case
 *   id** — never the `EvalCase` or its labels — and returns the bounded batch to
 *   admit in order. Only the validated `source`/`text`/`actorId` are copied, and
 *   an extra field on a returned input is refused rather than carried.
 */
export type EvaluationInputPlan =
  | { readonly mode: 'case-input' }
  | {
      readonly mode: 'prepared'
      readonly resolve: (
        caseId: string,
      ) => readonly PreparedEvaluationInput[] | Promise<readonly PreparedEvaluationInput[]>
    }

export interface EvaluationAdapterOptions {
  /** Shared M6 store. Owned by the caller: the adapter never closes it. */
  readonly store: EventStorePort
  /** Shared M6 history reader. Owned by the caller. */
  readonly history: HistoryQueryPort
  readonly variants: readonly EvaluationVariantConfig[]
  readonly consumer?: EvaluationConsumer
  readonly clock?: ClockPort
  /** Fresh session id per attempt; defaults to a random evaluation id. */
  readonly nextSessionId?: () => string
  /**
   * Input execution plan for every case. Omitted (or `case-input`) keeps the
   * original single-input path; `prepared` opts into a resolver-supplied batch
   * (see `EvaluationInputPlan`). An unknown mode, a missing resolver or a bad
   * batch is a not-run, never a fallback to the single input.
   */
  readonly input?: EvaluationInputPlan
  readonly onObservation?: (observation: EvaluationAttemptObservation) => void
  /**
   * Observational consumer of each attempt's projected dialogue generation/discard
   * events (see `DialogueOutcomeObserver`). It is called in addition to the
   * per-attempt `dialogueOutcomes`/`dialogueOutcomeFailures` evidence. It adds no
   * storage write of its own and is never a provider attempt; a synchronous throw
   * or a rejected promise from it is isolated and cannot change the attempt.
   */
  readonly onDialogueOutcome?: DialogueOutcomeObserver
}

export interface EvaluationAdapter {
  runVariant(variant: Variant, evalCase: EvalCase): Promise<VariantRun>
}

const NO_TIMING: StageTiming = {
  submitMs: null,
  planMs: null,
  dialogueMs: null,
  synthesisMs: null,
  firstAudibleMs: null,
  stopToSilenceMs: null,
}

const OPERATOR_CONTEXT: TrustedControlContext = {
  connectionId: 'evaluation-adapter-control',
  role: 'operator',
  actorId: 'evaluation-adapter',
  authenticated: true,
}

const INPUT_CONTEXT: TrustedControlContext = {
  connectionId: 'evaluation-adapter-input',
  role: 'viewer',
  actorId: 'evaluation-adapter',
  authenticated: true,
}

interface InvokedCall {
  readonly identity: string
  readonly call: string
  readonly requestId: string
  disposition: string
  reported: UsageRecord | null
  late: UsageRecord | null
}

/** Recorded runtime evidence consulted when mapping one attempt. */
interface AttemptEvidence {
  /** A `session.stopped` event: the only confirmed cancellation. */
  stopped: boolean
  /** `dependency.failed` events, rendered as `stage: reason`. */
  dependencyFailures: string[]
  /** The last recorded `turn.ended` status, or `null`. */
  turnEndStatus: string | null
  /** The last recorded `dialogue.result` end status, or `null`. */
  dialogueEndStatus: string | null
  /** Committed deliveries belonging to this turn. */
  turnDeliveries: CommitDelivery[]
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** A payload usage that is absent or schema-invalid is missing, never coerced. */
function readUsage(value: unknown): UsageRecord | null {
  const parsed = usageRecordSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/**
 * Joins `provider.call` and `provider.usage.late` events by full invocation
 * identity (call, request id, session, epoch, turn, segment). A late usage
 * updates its own invocation; it never adds another attempt. A late event whose
 * call event has not been observed still describes an invoked call, so it
 * creates the invocation it belongs to.
 */
function joinInvocations(events: readonly RuntimeEvent[]): InvokedCall[] {
  const calls = new Map<string, InvokedCall>()
  for (const event of events) {
    if (event.type !== 'provider.call' && event.type !== 'provider.usage.late') continue
    const payload = event.payload
    const call = stringOf(payload.call)
    const requestId = stringOf(payload.requestId)
    if (call === null || requestId === null) continue
    const identity = [
      call,
      requestId,
      stringOf(payload.sessionId) ?? '',
      String(payload.epoch ?? ''),
      stringOf(payload.turnId) ?? '',
      stringOf(payload.segmentId) ?? '',
    ].join('\u0000')
    const existing = calls.get(identity)
    if (event.type === 'provider.call') {
      const reported = readUsage(payload.usage)
      if (existing === undefined) {
        calls.set(identity, {
          identity,
          call,
          requestId,
          disposition: stringOf(payload.disposition) ?? 'unknown',
          reported,
          late: null,
        })
      } else {
        // The late event may be ordered before its call event; merge instead of
        // dropping either half.
        existing.disposition = stringOf(payload.disposition) ?? existing.disposition
        if (existing.reported === null) existing.reported = reported
      }
      continue
    }
    const usage = readUsage(payload.usage)
    if (usage === null) continue
    if (existing === undefined) {
      calls.set(identity, {
        identity,
        call,
        requestId,
        disposition: 'unknown',
        reported: null,
        late: usage,
      })
      continue
    }
    if (existing.late === null) existing.late = usage
  }
  return [...calls.values()]
}

/**
 * Reads the runtime evidence a mapping decision needs. Values are read
 * defensively: a malformed payload becomes `null` rather than a cast.
 */
function readEvidence(
  events: readonly RuntimeEvent[],
  deliveries: readonly CommitDelivery[],
  turnId: string | null,
): AttemptEvidence {
  const dependencyFailures: string[] = []
  let turnEndStatus: string | null = null
  let dialogueEndStatus: string | null = null
  let stopped = false
  for (const event of events) {
    if (event.type === 'session.stopped') stopped = true
    if (event.type === 'turn.ended') {
      const status = stringOf(event.payload.status)
      if (status !== null) turnEndStatus = status
    }
    if (event.type === 'dialogue.result') {
      const end = event.payload.end
      if (end !== null && typeof end === 'object') {
        const status = stringOf((end as Record<string, unknown>).status)
        if (status !== null) dialogueEndStatus = status
      }
    }
    if (event.type === 'dependency.failed') {
      const stage = stringOf(event.payload.stage) ?? 'unknown'
      const reason = stringOf(event.payload.reason)
      dependencyFailures.push(reason === null ? stage : `${stage}: ${reason}`)
    }
  }
  const turnDeliveries =
    turnId === null ? [] : deliveries.filter((delivery) => delivery.turnId === turnId)
  return { stopped, dependencyFailures, turnEndStatus, dialogueEndStatus, turnDeliveries }
}

/**
 * Effective completed delivery evidence: the turn committed at least one
 * delivery and every committed delivery of that turn is `fully-delivered`
 * (terminal `completed` receipt plus a validated M6 commit).
 */
function hasEffectiveCompletedDelivery(turnDeliveries: readonly CommitDelivery[]): boolean {
  if (turnDeliveries.length === 0) return false
  return turnDeliveries.every((delivery) => delivery.classification === 'fully-delivered')
}

function describeDelivery(delivery: CommitDelivery): string {
  return `${delivery.terminalOutcome} (${delivery.classification})`
}

/**
 * Maps one cycle outcome to the bench outcome. The coordinator's
 * `CycleOutcome.status` reports several failed dialogue and dispatch paths as
 * `cancelled`, so a cancelled cycle is only a cancellation when an operator Stop
 * is recorded; otherwise the recorded evidence decides and the reason names it.
 * A completed dialogue whose cycle failed (for example a synthesis or playback
 * fault) records `turn.ended: failed`; that is a dependency/delivery failure, not
 * a failed dialogue, so the dialogue end status is the dialogue classification
 * source.
 */
function mapOutcome(
  cycle: CycleOutcome | null,
  turnThrew: boolean,
  turnFailure: unknown,
  evidence: AttemptEvidence,
): { outcome: AttemptOutcome; failureReason: string | null } {
  if (turnThrew) {
    return {
      outcome: 'failed',
      failureReason: `the runtime turn threw: ${describeError(turnFailure)}`,
    }
  }
  if (cycle === null) {
    return { outcome: 'failed', failureReason: 'the runtime turn produced no outcome' }
  }
  if (cycle.status === 'completed') {
    if (hasEffectiveCompletedDelivery(evidence.turnDeliveries)) {
      return { outcome: 'completed', failureReason: null }
    }
    return {
      outcome: 'failed',
      failureReason:
        'the runtime reported a completed cycle without matching effective completed delivery evidence',
    }
  }
  if (cycle.status === 'cancelled') {
    /*
     * `deadline_exceeded` is checked before the recorded-stop branch: M4 checks
     * the abort signal before the deadline at every await boundary, so a
     * `deadline_exceeded` end means the clock, not a delivered Stop, ended the
     * call. A delivered prefix can never turn an expired call into a success: an
     * expired end is never `completed`, so this stays a failure with a clear
     * deadline reason.
     */
    if (
      evidence.dialogueEndStatus === 'deadline_exceeded' ||
      evidence.turnEndStatus === 'deadline_exceeded'
    ) {
      return {
        outcome: 'failed',
        failureReason:
          'the dialogue deadline expired before the turn completed (recorded dialogue end status deadline_exceeded)',
      }
    }
    if (evidence.stopped) {
      // A recorded operator Stop is the confirmed cancellation.
      return { outcome: 'cancelled', failureReason: null }
    }
    if (evidence.dependencyFailures.length > 0) {
      return {
        outcome: 'failed',
        failureReason: `the runtime cycle ended after recorded dependency failure: ${evidence.dependencyFailures.join('; ')}`,
      }
    }
    if (evidence.dialogueEndStatus === 'failed') {
      return {
        outcome: 'failed',
        failureReason:
          'the runtime cycle ended with a failed dialogue and no recorded operator stop',
      }
    }
    if (evidence.turnDeliveries.length === 0) {
      return {
        outcome: 'failed',
        failureReason: 'the runtime turn ended without terminal delivery evidence',
      }
    }
    return {
      outcome: 'failed',
      failureReason:
        'the runtime turn ended without completed delivery evidence and no recorded operator stop: ' +
        evidence.turnDeliveries.map(describeDelivery).join('; '),
    }
  }
  return { outcome: 'failed', failureReason: `runtime cycle status: ${cycle.status}` }
}

function sumCounts(
  records: readonly UsageRecord[],
  read: (usage: UsageRecord) => number | null,
): number | null {
  const counts = records.map((usage) => read(usage))
  if (counts.some((count) => count === null)) return null
  return counts.reduce<number>((total, count) => total + (count ?? 0), 0)
}

/**
 * Aggregate one attempt's usage. A field is summed only when every invoked call
 * reported it; any missing call, provider-reported missing usage or null count
 * keeps the field unknown. `costUsd` stays null: the runtime reports no cost.
 */
function aggregateUsage(invocations: readonly InvokedCall[]): AttemptUsage {
  if (invocations.length === 0) {
    return { inputTokens: null, outputTokens: null, costUsd: null, usageMissing: true }
  }
  const resolved = invocations.map((invocation) => invocation.reported ?? invocation.late)
  const missing = resolved.some((usage) => usage === null || usage.usageMissing)
  const present = resolved.filter((usage): usage is UsageRecord => usage !== null)
  return {
    inputTokens: missing ? null : sumCounts(present, (usage) => usage.inputTokens),
    outputTokens: missing ? null : sumCounts(present, (usage) => usage.outputTokens),
    costUsd: null,
    usageMissing: missing,
  }
}

function assertPortMethod(holder: unknown, name: string, method: string): void {
  if (
    holder === null ||
    typeof holder !== 'object' ||
    typeof (holder as Record<string, unknown>)[method] !== 'function'
  ) {
    throw new TypeError(`evaluation adapter requires ${name}.${method}()`)
  }
}

function assertAdapterOptions(options: EvaluationAdapterOptions): void {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('evaluation adapter requires an options object')
  }
  assertPortMethod(options.store, 'store', 'append')
  assertPortMethod(options.store, 'store', 'commitDeliveryWithEvent')
  assertPortMethod(options.store, 'store', 'readSession')
  assertPortMethod(options.history, 'history', 'confirmedHistory')
  if (!Array.isArray(options.variants) || options.variants.length === 0) {
    throw new TypeError('evaluation adapter requires at least one configured variant')
  }
  for (const config of options.variants) {
    if (
      config === null ||
      typeof config !== 'object' ||
      config.variant === null ||
      typeof config.variant !== 'object' ||
      typeof config.variant.id !== 'string' ||
      config.variant.id.length === 0
    ) {
      throw new TypeError(
        'evaluation adapter requires every configured variant to carry a non-empty variant id',
      )
    }
    if (config.variant.kind !== 'rules' && config.variant.kind !== 'model') {
      throw new TypeError(
        `evaluation adapter variant ${config.variant.id} requires kind 'rules' or 'model'`,
      )
    }
    if (typeof config.variant.combined !== 'boolean') {
      throw new TypeError(
        `evaluation adapter variant ${config.variant.id} requires a boolean combined flag`,
      )
    }
  }
  if (options.consumer !== undefined && typeof options.consumer.attach !== 'function') {
    throw new TypeError('evaluation adapter consumer requires an attach(composition) method')
  }
  if (options.clock !== undefined && typeof options.clock.nowMs !== 'function') {
    throw new TypeError('evaluation adapter clock requires nowMs()')
  }
  if (options.nextSessionId !== undefined && typeof options.nextSessionId !== 'function') {
    throw new TypeError('evaluation adapter nextSessionId must be a function')
  }
  if (options.onObservation !== undefined && typeof options.onObservation !== 'function') {
    throw new TypeError('evaluation adapter onObservation must be a function')
  }
}

/**
 * The default single input for a case: the source, text and actor context the
 * adapter has always submitted.
 */
function caseInput(evalCase: EvalCase): PreparedEvaluationInput {
  return { source: 'local-audience', text: evalCase.input, actorId: INPUT_CONTEXT.actorId }
}

const PREPARED_INPUT_FIELDS: readonly string[] = ['source', 'text', 'actorId']

/**
 * Validates one resolver-supplied input against the input contract and copies
 * only `source`/`text`/`actorId`. A strict field check means an extra field
 * (for example a label) is refused rather than carried toward a provider, and
 * the returned object shares nothing with the resolver's value.
 */
function readPreparedInput(
  value: unknown,
  index: number,
): { readonly input: PreparedEvaluationInput } | { readonly invalid: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { invalid: `prepared input ${index + 1} is not an object` }
  }
  const record = value as Record<string, unknown>
  const unexpected = Object.keys(record).filter((key) => !PREPARED_INPUT_FIELDS.includes(key))
  if (unexpected.length > 0) {
    return {
      invalid:
        `prepared input ${index + 1} carries unsupported field(s): ${unexpected.join(', ')}; ` +
        'only source, text and actorId may be admitted',
    }
  }
  const source = inputSourceSchema.safeParse(record.source)
  if (!source.success) {
    return {
      invalid: `prepared input ${index + 1} has a missing or invalid source (expected one of ${inputSourceSchema.options.join(', ')})`,
    }
  }
  if (typeof record.text !== 'string' || record.text.length === 0) {
    return { invalid: `prepared input ${index + 1} has a missing or empty text` }
  }
  if (typeof record.actorId !== 'string' || record.actorId.length === 0) {
    return { invalid: `prepared input ${index + 1} has a missing or empty actorId` }
  }
  return { input: { source: source.data, text: record.text, actorId: record.actorId } }
}

type ResolvedInputPlan =
  | { readonly kind: 'resolved'; readonly inputs: readonly PreparedEvaluationInput[] }
  | { readonly kind: 'refused'; readonly reason: string }

/**
 * Resolves the case's input plan before any runtime work. The default plan (and
 * an explicit `case-input` plan) is the single `EvalCase.input`. A `prepared`
 * plan is refused — never downgraded to the default — when the resolver is
 * missing or throws, or when the batch is missing, invalid, empty or larger than
 * `MAX_SELECTION_CANDIDATES`. The resolver receives only the case id.
 */
async function resolveInputs(
  plan: EvaluationInputPlan | undefined,
  evalCase: EvalCase,
): Promise<ResolvedInputPlan> {
  if (plan === undefined) return { kind: 'resolved', inputs: [caseInput(evalCase)] }
  const candidate = plan as { mode?: unknown; resolve?: unknown }
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return {
      kind: 'refused',
      reason:
        `case ${evalCase.id} requested an input plan that is not a recognized object; ` +
        "expected mode 'case-input' or 'prepared'",
    }
  }
  if (candidate.mode === 'case-input') return { kind: 'resolved', inputs: [caseInput(evalCase)] }
  if (candidate.mode !== 'prepared') {
    return {
      kind: 'refused',
      reason:
        `case ${evalCase.id} requested unknown input mode '${String(candidate.mode)}'; ` +
        "expected 'case-input' or 'prepared'",
    }
  }
  if (typeof candidate.resolve !== 'function') {
    return {
      kind: 'refused',
      reason: `case ${evalCase.id} selected prepared input mode without a resolve(caseId) function`,
    }
  }
  let batch: unknown
  try {
    batch = await candidate.resolve(evalCase.id)
  } catch (error) {
    return {
      kind: 'refused',
      reason: `case ${evalCase.id} prepared input resolver threw: ${describeError(error)}`,
    }
  }
  if (!Array.isArray(batch)) {
    return {
      kind: 'refused',
      reason: `case ${evalCase.id} prepared input resolver did not return an array`,
    }
  }
  if (batch.length === 0) {
    return { kind: 'refused', reason: `case ${evalCase.id} prepared input resolver returned no inputs` }
  }
  if (batch.length > MAX_SELECTION_CANDIDATES) {
    return {
      kind: 'refused',
      reason:
        `case ${evalCase.id} prepared input resolver returned ${batch.length} inputs; ` +
        `at most ${MAX_SELECTION_CANDIDATES} may be admitted before one turn`,
    }
  }
  const inputs: PreparedEvaluationInput[] = []
  for (let index = 0; index < batch.length; index += 1) {
    const read = readPreparedInput(batch[index], index)
    if ('invalid' in read) {
      return { kind: 'refused', reason: `case ${evalCase.id} ${read.invalid}` }
    }
    inputs.push(read.input)
  }
  return { kind: 'resolved', inputs }
}

/**
 * Close a runtime that never reached an attempt: drain admitted work, detach the
 * consumer if it was ever attached, and dispose. Every step is best-effort, but
 * its faults are returned rather than swallowed: a not-run has no record, so the
 * caller appends the cleanup fault to the not-run reason.
 */
async function closeBeforeAttempt(
  composition: RuntimeComposition,
  consumer: EvaluationConsumer,
  detach: boolean,
): Promise<string | null> {
  const faults: string[] = []
  try {
    await composition.coordinator.settle()
  } catch (error) {
    // Settle never rejects by contract; a fault is still reported, not hidden.
    faults.push(`drain failed: ${describeError(error)}`)
  }
  if (detach) {
    try {
      await consumer.detach?.()
    } catch (error) {
      faults.push(`consumer detach failed: ${describeError(error)}`)
    }
  }
  try {
    composition.dispose()
  } catch (error) {
    faults.push(`composition dispose failed: ${describeError(error)}`)
  }
  return faults.length === 0 ? null : faults.join('; ')
}

/** Appends a pre-attempt cleanup fault to a not-run reason. */
function withCleanupFailure(reason: string, cleanupFailure: string | null): string {
  return cleanupFailure === null
    ? reason
    : `${reason}; cleanup after the refusal failed: ${cleanupFailure}`
}

export function createEvaluationAdapter(options: EvaluationAdapterOptions): EvaluationAdapter {
  assertAdapterOptions(options)

  const byId = new Map<string, EvaluationVariantConfig>()
  for (const config of options.variants) {
    if (byId.has(config.variant.id)) {
      throw new TypeError(
        `evaluation adapter received duplicate configuration for variant ${config.variant.id}`,
      )
    }
    byId.set(config.variant.id, config)
  }

  const clock = options.clock ?? createMonotonicClock()
  const nextSessionId = options.nextSessionId ?? (() => `session-eval-${randomUUID()}`)
  const consumer = options.consumer
  const onObservation = options.onObservation
  const inputPlan = options.input
  /** Session ids this adapter has already claimed: an event namespace is used once. */
  const claimedSessionIds = new Set<string>()

  /**
   * Attempts to record a cleanup fault durably as an `evaluation.cleanup.failed`
   * event for the session. Returns `null` when the diagnostic was persisted, or
   * the reason it was not: a thrown write, or an append acknowledgement other
   * than `stored`/`duplicate`. The caller never depends on this channel — the
   * returned attempt carries the cleanup fault itself — so a diagnostic failure
   * can only add detail, never lose the record.
   */
  const recordCleanupFailure = async (
    sessionId: string,
    epoch: number,
    turnId: string | null,
    attemptOutcome: AttemptOutcome,
    failureReason: string | null,
    failures: {
      drainFailure: string | null
      teardownFailure: string | null
      observationFailure: string | null
    },
  ): Promise<string | null> => {
    try {
      const existing = await options.store.readSession(sessionId)
      const lastSeq = existing.reduce((max, event) => Math.max(max, event.seq), 0)
      const seq = lastSeq + 1
      const ack = await options.store.append({
        protocolVersion: APPLICATION_CONTRACT_VERSION,
        eventId: `${sessionId}-evaluation-cleanup-${seq}`,
        seq,
        timestampMs: clock.nowMs(),
        sessionId,
        epoch,
        turnId,
        segmentId: null,
        outputId: null,
        type: 'evaluation.cleanup.failed',
        sourceModule: 'M5',
        versions: null,
        payload: {
          attemptOutcome,
          failureReason,
          drainFailure: failures.drainFailure,
          teardownFailure: failures.teardownFailure,
          observationFailure: failures.observationFailure,
        },
      })
      if (ack.outcome === 'stored' || ack.outcome === 'duplicate') return null
      return `the store acknowledged ${ack.outcome} (${ack.reasonCode})`
    } catch (error) {
      return describeError(error)
    }
  }

  return {
    async runVariant(requested: Variant, evalCase: EvalCase): Promise<VariantRun> {
      const notRun = (reason: string): VariantRun => ({ ran: false, reason })

      // ---- prerequisites: no runtime built, no provider invoked ----
      const config = byId.get(requested.id)
      if (config === undefined) {
        return notRun(`no deployment peers are configured for variant ${requested.id}`)
      }
      if (
        config.variant.kind !== requested.kind ||
        config.variant.combined !== requested.combined
      ) {
        return notRun(
          `variant ${requested.id} was requested as kind=${requested.kind} combined=${requested.combined}, ` +
            `but its configured deployment peers are kind=${config.variant.kind} combined=${config.variant.combined}; ` +
            'refusing to execute mislabelled peers',
        )
      }
      try {
        validateProductionPeers(config.peers)
      } catch (error) {
        return notRun(`variant ${requested.id} cannot run: ${describeError(error)}`)
      }
      if (consumer === undefined) {
        return notRun(
          'no audio consumer is configured; the evaluation adapter does not fabricate playback receipts',
        )
      }

      // ADR-007 D8: `replyIntent` is the actual prompt condition that renders the
      // reply — M3's selection decision — not the human `labels.intent`. This
      // adapter drives the configured selection port and cannot execute a
      // supplied intent without replacing M3's decision, so it refuses the case
      // before any work instead of silently ignoring the condition.
      if (evalCase.replyIntent !== undefined) {
        return notRun(
          `case ${evalCase.id} supplies replyIntent '${evalCase.replyIntent}', which this adapter cannot execute: ` +
            'the reply intent is produced by the configured selection port (ADR-007 D8), and forcing it here would override M3\'s decision; ' +
            'run the case without replyIntent, or supply a selection port that derives the intended condition',
        )
      }

      // The input plan is resolved before any runtime is built. A prepared plan
      // that is unknown, has no resolver, throws or yields a missing, invalid,
      // empty or oversized batch is a not-run: it never falls back to the
      // default single input, and no session is claimed.
      const planned = await resolveInputs(inputPlan, evalCase)
      if (planned.kind === 'refused') {
        return notRun(planned.reason)
      }
      const preparedInputs = planned.inputs

      // A fresh session id is a documented precondition: reusing one would mix
      // this attempt's events with earlier evidence. Both a repeated id and an id
      // that already holds persisted events are refused before any attempt.
      const sessionId = nextSessionId()
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new TypeError('evaluation adapter nextSessionId() must return a non-empty session id')
      }
      if (claimedSessionIds.has(sessionId)) {
        return notRun(
          `session id ${sessionId} was already used by an earlier attempt in this adapter; refusing to reuse an event namespace`,
        )
      }
      let persisted: readonly RuntimeEvent[]
      try {
        persisted = await options.store.readSession(sessionId)
      } catch (error) {
        return notRun(
          `variant ${requested.id} could not verify that session ${sessionId} is fresh: ${describeError(error)}`,
        )
      }
      if (persisted.length > 0) {
        return notRun(
          `session id ${sessionId} already holds ${persisted.length} persisted events; refusing to reuse an existing event namespace`,
        )
      }
      claimedSessionIds.add(sessionId)

      // ---- build the attempt runtime (setup only; no provider attempt) ----
      /*
       * Per-attempt dialogue generation/discard evidence. The collector records
       * every projected event and forwards it to the caller-visible observer, if
       * any. Each event and observation is frozen by the projection, so a consumer
       * that mutates what it was handed cannot corrupt the evidence collected here
       * (the outer arrays are copies as well).
       */
      const dialogueOutcomes: DialogueOutcomeObservation[] = []
      const dialogueOutcomeFailures: string[] = []
      const forwardDialogueOutcome = options.onDialogueOutcome
      const collectDialogueOutcome = (event: DialogueOutcomeEvent): void => {
        if (event.kind === 'observed') dialogueOutcomes.push(event.observation)
        else dialogueOutcomeFailures.push(event.reason)
        if (forwardDialogueOutcome === undefined) return
        // A diagnostic consumer fault is isolated: it never changes the attempt.
        try {
          const result: unknown = forwardDialogueOutcome(event)
          if (isThenable(result)) {
            void Promise.resolve(result).catch(() => {
              dialogueOutcomeFailures.push('observer rejected')
            })
          }
        } catch {
          dialogueOutcomeFailures.push('observer threw')
        }
      }
      const gate = createDeadlineGate(clock)
      let composition: RuntimeComposition
      try {
        const dialogue = createDialogueComposition({
          clock,
          history: options.history,
          textSource: config.peers.textSource,
          ...(config.peers.personaRecall !== undefined
            ? { personaRecall: config.peers.personaRecall }
            : {}),
          onDialogueOutcome: collectDialogueOutcome,
        })
        composition = createRuntimeComposition({
          clock,
          authorizer: createRuntimeAuthorizer(),
          selection: config.peers.selection,
          reaction: config.peers.reaction,
          dialogue: dialogue.dialogue,
          commit: dialogue.memory,
          store: options.store,
          renderer: config.peers.createRenderer(gate),
          gate,
          synthesis: config.peers.createSynthesis(gate),
          ...(config.peers.audioResources !== undefined
            ? { audioResources: config.peers.audioResources }
            : {}),
          sessionId,
          ...(config.peers.profile !== undefined ? { profile: config.peers.profile } : {}),
          ...(config.peers.timings !== undefined ? { timings: config.peers.timings } : {}),
          ...(config.peers.inputTtlMs !== undefined ? { inputTtlMs: config.peers.inputTtlMs } : {}),
          ...(config.peers.storageTtlMs !== undefined
            ? { storageTtlMs: config.peers.storageTtlMs }
            : {}),
          ...(config.peers.cancelTtlMs !== undefined ? { cancelTtlMs: config.peers.cancelTtlMs } : {}),
          ...(config.peers.maxPendingInputs !== undefined
            ? { maxPendingInputs: config.peers.maxPendingInputs }
            : {}),
        })
      } catch (error) {
        // The composition owns the gate once built; a failed build leaves the
        // gate caller-owned and it is released here. A release fault is reported
        // in the not-run reason rather than swallowed.
        let gateCleanupFailure: string | null = null
        try {
          gate.dispose()
        } catch (disposeError) {
          gateCleanupFailure = `gate dispose failed: ${describeError(disposeError)}`
        }
        return notRun(
          withCleanupFailure(
            `variant ${requested.id} could not build its runtime before any attempt: ${describeError(error)}`,
            gateCleanupFailure,
          ),
        )
      }

      // Resume is the only path from `stopped` to `running`, and it requires an
      // authenticated operator context. The adapter is the operator of record.
      // It needs no performer: nothing is dispatched while stopped.
      const resume: ControlResumeMessage = {
        protocolVersion: APPLICATION_CONTRACT_VERSION,
        messageId: `${sessionId}-resume`,
        sessionId,
        epoch: composition.coordinator.epoch(),
        kind: 'control.resume',
        payload: { requestId: `${sessionId}-resume-request` },
      }
      let resumeAck: Awaited<ReturnType<typeof composition.coordinator.endpoint.control>>
      try {
        resumeAck = await composition.coordinator.endpoint.control(resume, OPERATOR_CONTEXT)
      } catch (error) {
        const cleanup = await closeBeforeAttempt(composition, consumer, false)
        return notRun(
          withCleanupFailure(
            `variant ${requested.id} could not resume the fresh session: ${describeError(error)}`,
            cleanup,
          ),
        )
      }
      if (resumeAck.status === 'refused') {
        const cleanup = await closeBeforeAttempt(composition, consumer, false)
        return notRun(
          withCleanupFailure(
            `variant ${requested.id} session resume was refused (${resumeAck.reasonCode ?? 'unknown'}): ${resumeAck.message}`,
            cleanup,
          ),
        )
      }

      // The consumer attaches after Resume so the snapshot it bootstraps from
      // carries the running epoch that the offers and grants will use. A failed
      // attach is still before any provider attempt: the case is a not-run.
      let detach = false
      try {
        detach = true
        await consumer.attach(composition)
      } catch (error) {
        const cleanup = await closeBeforeAttempt(composition, consumer, detach)
        return notRun(
          withCleanupFailure(
            `variant ${requested.id} consumer attach failed before any attempt: ${describeError(error)}`,
            cleanup,
          ),
        )
      }

      // Prime every prepared input through the real endpoint, in order, before
      // the single turn. Each input is admitted under its own actor context, and
      // only the validated source/text/actorId reach admission.
      const inputsToAdmit: Array<{
        readonly message: InputSubmitMessage
        readonly context: TrustedControlContext
      }> = preparedInputs.map((prepared, index) => ({
        message: {
          protocolVersion: APPLICATION_CONTRACT_VERSION,
          messageId: `${sessionId}-input-${index + 1}`,
          sessionId,
          epoch: composition.coordinator.epoch(),
          kind: 'input.submit',
          payload: { source: prepared.source, text: prepared.text },
        },
        context: { ...INPUT_CONTEXT, actorId: prepared.actorId },
      }))

      let acceptedInputs = 0
      let admissionFailure: string | null = null
      for (let index = 0; index < inputsToAdmit.length; index += 1) {
        const { message, context } = inputsToAdmit[index]
        let ack: Awaited<ReturnType<typeof composition.coordinator.endpoint.submitInput>>
        try {
          ack = await composition.coordinator.endpoint.submitInput(message, context)
        } catch (error) {
          admissionFailure =
            `could not admit case input ${index + 1} of ${inputsToAdmit.length}: ${describeError(error)}`
          break
        }
        if (ack.status === 'rejected') {
          admissionFailure =
            `case input ${index + 1} of ${inputsToAdmit.length} was rejected before selection (${ack.code}): ${ack.message}`
          break
        }
        acceptedInputs += 1
      }

      // Nothing was accepted: the case is still a not-run, exactly as the single
      // input path always was.
      if (admissionFailure !== null && acceptedInputs === 0) {
        const cleanup = await closeBeforeAttempt(composition, consumer, detach)
        return notRun(
          withCleanupFailure(`variant ${requested.id} ${admissionFailure}`, cleanup),
        )
      }

      // ---- the attempt boundary: at least one case input is admitted ----
      // From here the case is an attempt. A degraded admission write, a thrown
      // turn, a non-completed status or a teardown fault all stay records.
      let cycle: CycleOutcome | null = null
      let turnThrew = false
      let turnFailure: unknown = null
      if (admissionFailure === null) {
        try {
          cycle = await composition.coordinator.runTurn()
        } catch (error) {
          turnThrew = true
          turnFailure = error
        }
      }

      // The admitted drain: seal operation admission, drain every admitted
      // operation (including an in-flight receipt finalization) and every
      // admitted write, then read the evidence. Anything after this cut stays
      // unknown rather than being invented.
      let drainFailure: string | null = null
      try {
        await composition.coordinator.settle()
      } catch (error) {
        drainFailure = describeError(error)
      }

      const sessionEpoch = composition.coordinator.epoch()
      const events = composition.coordinator.events()
      const deliveries = composition.coordinator.deliveries()
      const metrics = composition.coordinator.metrics()
      const outputConfirmation = composition.coordinator.outputConfirmation()
      const invocations = joinInvocations(events)
      const evidence = readEvidence(events, deliveries, cycle?.turnId ?? null)

      const mapped =
        admissionFailure === null
          ? mapOutcome(cycle, turnThrew, turnFailure, evidence)
          : {
              outcome: 'failed' as const,
              failureReason:
                `the runtime skipped runTurn because only ${acceptedInputs} of ${inputsToAdmit.length} prepared inputs were admitted ` +
                `(${admissionFailure}); a partial batch is never run`,
            }

      // Teardown is best-effort: a fault here never replaces or drops the record,
      // and it is collected so it can be reported rather than swallowed.
      const teardownMessages: string[] = []
      try {
        await consumer.detach?.()
      } catch (error) {
        teardownMessages.push(`consumer detach failed: ${describeError(error)}`)
      }
      try {
        composition.dispose()
      } catch (error) {
        teardownMessages.push(`composition dispose failed: ${describeError(error)}`)
      }
      const teardownFailure = teardownMessages.length === 0 ? null : teardownMessages.join('; ')

      let observationFailure: string | null = null
      if (onObservation !== undefined) {
        try {
          const observationResult: unknown = onObservation({
            sessionId,
            variantId: requested.id,
            caseId: evalCase.id,
            cycleStatus: cycle?.status ?? null,
            dialogueEndStatus: evidence.dialogueEndStatus,
            turnEndStatus: evidence.turnEndStatus,
            dependencyFailures: evidence.dependencyFailures,
            outputConfirmation,
            deliveries: deliveries.map((delivery) => ({
              turnId: delivery.turnId,
              classification: delivery.classification,
              terminalOutcome: delivery.terminalOutcome,
            })),
            invocations: invocations.map((invocation) => ({
              call: invocation.call,
              requestId: invocation.requestId,
              disposition: invocation.disposition,
              usage:
                invocation.reported !== null
                  ? 'reported'
                  : invocation.late !== null
                    ? 'late'
                    : 'missing',
              usageMissing: (invocation.reported ?? invocation.late)?.usageMissing ?? null,
            })),
            portInvocations: {
              selection: metrics.selectionAttempts,
              reaction: metrics.reactionAttempts,
              dialogue: metrics.dialogueAttempts,
            },
            /*
             * The diagnostic cutoff: these two arrays are copied immediately
             * before onObservation runs. A later rejection of the forwarded
             * onDialogueOutcome promise may append to the live failure array, but
             * it cannot revise this completed snapshot.
             */
            dialogueOutcomes: [...dialogueOutcomes],
            dialogueOutcomeFailures: [...dialogueOutcomeFailures],
            drainFailure,
            teardownFailure,
          })
          /*
           * The diagnostic array copies were made immediately above, before this
           * callback is invoked; later changes to the adapter's live arrays do
           * not revise them. The returned thenable is contained without awaiting,
           * so completion and Stop do not wait for it, and a later rejection
           * neither revises the captured arrays nor the returned execution
           * result. This is not a claim that the whole observation object is
           * deeply immutable.
           */
          if (isThenable(observationResult)) {
            void Promise.resolve(observationResult).catch(() => {})
          }
        } catch (error) {
          // The observation is diagnostics; a callback fault never drops the record.
          observationFailure = describeError(error)
        }
      }

      // A durable diagnostic attempt. It is an additional channel, never the only
      // one: a thrown write or a rejected acknowledgement is itself reported.
      let diagnosticFailure: string | null = null
      if (drainFailure !== null || teardownFailure !== null || observationFailure !== null) {
        diagnosticFailure = await recordCleanupFailure(
          sessionId,
          sessionEpoch,
          cycle?.turnId ?? null,
          mapped.outcome,
          mapped.failureReason,
          { drainFailure, teardownFailure, observationFailure },
        )
      }

      // The returned attempt carries the cleanup trouble itself, after any earlier
      // execution failure, so it survives an absent callback and a failed store
      // write. The outcome and usage are never rewritten by a cleanup fault, and
      // a callback-only fault is not an execution or cleanup failure: it stays a
      // diagnostic and does not enter this reason.
      const cleanupNotes: string[] = []
      if (drainFailure !== null) cleanupNotes.push(`drain failed: ${drainFailure}`)
      if (teardownFailure !== null) cleanupNotes.push(teardownFailure)
      if (cleanupNotes.length > 0 && diagnosticFailure !== null) {
        cleanupNotes.push(`cleanup diagnostics were not persisted: ${diagnosticFailure}`)
      }
      const failureReason =
        cleanupNotes.length === 0
          ? mapped.failureReason
          : [mapped.failureReason, `cleanup failed: ${cleanupNotes.join('; ')}`]
              .filter((part): part is string => part !== null && part.length > 0)
              .join('; ')

      const record: AttemptRecord = {
        // The runner owns these three fields and overwrites them; they are
        // filled with what is known here so a direct caller sees a coherent row.
        caseId: evalCase.id,
        variantId: requested.id,
        cold: false,
        outcome: mapped.outcome,
        timing: { ...NO_TIMING },
        totalMs: null,
        attempts: null,
        usage: aggregateUsage(invocations),
        failureReason,
      }

      return { ran: true, record }
    },
  }
}
