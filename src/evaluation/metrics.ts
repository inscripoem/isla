/**
 * M6-02 — shared comparison and measurement bench: attempt records and aggregation.
 *
 * One bench answers *"given the same cases, how do the performers compare on
 * quality, latency and cost?"* This module owns the **measurement** half: the shape
 * of one recorded attempt, percentiles without a dependency, and the aggregation.
 * The runner that produces the records is `comparison.ts`; the report is generated
 * from the summary.
 *
 * Honesty rules (NFR-01, NFR-04):
 *  - A missing measurement is `null` — unknown. It is never `0` and never inferred.
 *  - A failed or cancelled attempt is **recorded**, not dropped. Dropping it would
 *    inflate the success picture and hide the failure the bench exists to measure.
 *  - Usage is summed **only when every attempt reports it**. If any contributing
 *    attempt is missing usage, the aggregate is `null` and `unknown` is true: a
 *    partial sum presented as a total is a lie.
 *  - Cold and warm attempts are summarised **separately** — the first attempt after
 *    process start is a different measurement from a subsequent one (NFR-01).
 *  - A stage that was not measured is excluded from that stage's sample and `n`
 *    reports how many were actually measured, so a thin sample is visible.
 *
 * Nothing here talks to a provider, and nothing here decides domain quality: the
 * bench observes and aggregates, and the numbers stay attributable.
 */

export type AttemptOutcome = 'completed' | 'cancelled' | 'failed'

const ATTEMPT_OUTCOMES: readonly AttemptOutcome[] = ['completed', 'cancelled', 'failed']

/** The observable stages, one per owning role (PLAN:116, NFR-01). */
export const TIMING_STAGES = [
  'submitMs',
  'planMs',
  'dialogueMs',
  'synthesisMs',
  'firstAudibleMs',
  'stopToSilenceMs',
] as const
export type TimingStage = (typeof TIMING_STAGES)[number]

export interface StageTiming {
  /** M5 queue/control: accepted -> dispatched. */
  submitMs: number | null
  /** M3 decision. */
  planMs: number | null
  /** M4 dialogue. */
  dialogueMs: number | null
  /** M1 synthesis. */
  synthesisMs: number | null
  /** M1 observed output: input -> first audible sound (NFR-01 headline metric). */
  firstAudibleMs: number | null
  /** M1/M5 Stop -> silence (NFR-01 headline metric). */
  stopToSilenceMs: number | null
}

export interface AttemptUsage {
  inputTokens: number | null
  outputTokens: number | null
  costUsd: number | null
  /** True when the provider reported no usage at all; missing stays missing. */
  usageMissing: boolean
}

export interface AttemptRecord {
  caseId: string
  variantId: string
  /** True for the first attempt after process start. */
  cold: boolean
  outcome: AttemptOutcome
  timing: StageTiming
  /** Input -> first audible output, or the terminal point for a non-completion. */
  totalMs: number | null
  /**
   * Response-provider attempts used for this opportunity (NFR-04 allows one).
   *
   * **`null` means unobserved**, not zero: an adapter can throw before calling a
   * provider, or after an unreported number of calls. This is the provider-attempt
   * count, distinct from the summary's count of bench records.
   */
  attempts: number | null
  usage: AttemptUsage
  /**
   * Why the attempt failed, or `null`. A failure with no reason is a gap in the
   * evidence, so the runner always fills this when it records a failed attempt.
   */
  failureReason: string | null
}

export interface Percentiles {
  /** How many attempts actually reported this measurement (never padded). */
  n: number
  p50: number | null
  p95: number | null
}

export interface WindowSummary {
  /** Number of bench records in this window — not a provider-attempt count. */
  attempts: number
  stages: Record<TimingStage, Percentiles>
  totalMs: Percentiles
}

export interface UsageSummary {
  inputTokens: number | null
  outputTokens: number | null
  costUsd: number | null
  /** True when the aggregate is unknown (a contributing attempt is missing usage). */
  unknown: boolean
}

export interface ComparisonSummary {
  /** Number of bench records in the run — not a provider-attempt count. */
  attempts: number
  outcomes: Record<AttemptOutcome, number>
  /** failed / attempts; `null` when there are no attempts. */
  failureRate: number | null
  cold: WindowSummary
  warm: WindowSummary
  usage: UsageSummary
}

/**
 * Nearest-rank percentile. `q` is in `(0, 1]`. Returns `null` for an empty sample,
 * so an unmeasured stage is never reported as a number.
 */
export function percentile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[rank] ?? null
}

function measured(
  records: readonly AttemptRecord[],
  read: (record: AttemptRecord) => number | null,
): number[] {
  return records.map(read).filter((value): value is number => value !== null)
}

function percentilesOf(values: readonly number[]): Percentiles {
  return { n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95) }
}

/**
 * Aggregate one population (first attempts or later attempts): counts, per-stage
 * percentiles with the sample each measured, and the total.
 */
export function summariseWindow(records: readonly AttemptRecord[]): WindowSummary {
  const stages = Object.fromEntries(
    TIMING_STAGES.map((stage) => [
      stage,
      percentilesOf(measured(records, (record) => record.timing[stage])),
    ]),
  ) as Record<TimingStage, Percentiles>
  return {
    attempts: records.length,
    stages,
    totalMs: percentilesOf(measured(records, (record) => record.totalMs)),
  }
}

/** A field is summed only when every attempt reports it; otherwise it stays unknown. */
function sumOrUnknown(values: readonly (number | null)[]): number | null {
  if (values.length === 0) return null
  if (values.some((value) => value === null)) return null
  return values.reduce<number>((total, value) => total + (value ?? 0), 0)
}

/** Aggregate every attempt — completed, cancelled and failed alike. */
export function summarise(records: readonly AttemptRecord[]): ComparisonSummary {
  const outcomes = Object.fromEntries(ATTEMPT_OUTCOMES.map((outcome) => [outcome, 0])) as Record<
    AttemptOutcome,
    number
  >
  for (const record of records) outcomes[record.outcome] += 1

  const anyMissingUsage = records.some((record) => record.usage.usageMissing)
  const inputTokens = anyMissingUsage ? null : sumOrUnknown(records.map((r) => r.usage.inputTokens))
  const outputTokens = anyMissingUsage ? null : sumOrUnknown(records.map((r) => r.usage.outputTokens))
  const costUsd = anyMissingUsage ? null : sumOrUnknown(records.map((r) => r.usage.costUsd))

  return {
    attempts: records.length,
    outcomes,
    failureRate: records.length === 0 ? null : outcomes.failed / records.length,
    cold: summariseWindow(records.filter((record) => record.cold)),
    warm: summariseWindow(records.filter((record) => !record.cold)),
    usage: {
      inputTokens,
      outputTokens,
      costUsd,
      unknown: inputTokens === null || outputTokens === null || costUsd === null,
    },
  }
}
