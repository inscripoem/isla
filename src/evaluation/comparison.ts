import { summarise, type AttemptRecord, type ComparisonSummary } from './metrics'

/**
 * M6-02 — the comparison runner.
 *
 * Runs a set of **cases** through a set of **variants** and returns every recorded
 * attempt plus its aggregate. It is deliberately dependency-free and provider-free:
 *
 *  - **It aggregates; it does not compose.** Driving `M3 → M4 → M1 → M5` is the
 *    caller's job, injected as `runVariant` (ADR-007 D1; see issue #41 Q1). This
 *    module imports nothing from `src/runtime` or `src/dialogue`.
 *  - **A variant that throws is still an attempt.** The runner records it as a
 *    failure with a reason, because losing a case silently is the one outcome a
 *    measurement bench must not produce (ADR-007 D2).
 *  - **"Not run" is a first-class result.** A variant that cannot run (no provider,
 *    out of scope) returns `{ ran: false, reason }`; the runner records it in
 *    `notRun` and produces **no** `AttemptRecord` — nothing was attempted, so
 *    nothing is claimed.
 *  - **The bench labels the record.** `caseId`, `variantId` and `cold` are set by
 *    the runner, not accepted from the variant, so a variant cannot mis-attribute
 *    its own results. `cold` is the **first attempt that variant actually made** in
 *    this run (a per-variant warm-up); every later attempt is warm. A deliberately
 *    not-run case is not an attempt, so it does not consume the cold slot.
 *
 * Every other field — outcome, timing, totals, attempts, usage — comes from the
 * variant through `runVariant`; the runner does not invent a measurement.
 */

export interface Variant {
  readonly id: string
  /** A rules path, or a model path (the performers NFR-03 compares). */
  readonly kind: 'rules' | 'model'
  /** One combined call, versus a split path — NFR-03's "combined-call baseline". */
  readonly combined: boolean
}

export interface EvalCase {
  readonly id: string
  /** The viewer input the case exercises. */
  readonly input: string
  /**
   * Human reference labels (NFR-03). Absent for a synthetic case — an absent label
   * is unknown, never a stand-in for a real one.
   */
  readonly labels?: { readonly intent?: string; readonly note?: string }
}

/** What one variant produced for one case. */
export type VariantRun =
  | { readonly ran: true; readonly record: AttemptRecord }
  | { readonly ran: false; readonly reason: string }

export interface ComparisonDeps {
  /**
   * Run one case through one variant. Supplied by the caller: the real
   * implementation wires the pipeline, and tests supply a synthetic one.
   */
  runVariant(variant: Variant, evalCase: EvalCase): Promise<VariantRun>
}

export interface NotRunEntry {
  readonly variantId: string
  readonly caseId: string
  readonly reason: string
}

export interface ComparisonRun {
  readonly records: readonly AttemptRecord[]
  /** Cases that were deliberately not attempted, with the reason. */
  readonly notRun: readonly NotRunEntry[]
  readonly summary: ComparisonSummary
}

const NO_TIMING = {
  submitMs: null,
  planMs: null,
  dialogueMs: null,
  synthesisMs: null,
  firstAudibleMs: null,
  stopToSilenceMs: null,
} as const

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function runComparison(
  input: { readonly variants: readonly Variant[]; readonly cases: readonly EvalCase[] },
  deps: ComparisonDeps,
): Promise<ComparisonRun> {
  const records: AttemptRecord[] = []
  const notRun: NotRunEntry[] = []

  for (const variant of input.variants) {
    // A variant is "cold" until it has actually attempted something. A deliberately
    // not-run case is not an attempt, so it must not consume the cold slot.
    let warmedUp = false
    for (const evalCase of input.cases) {
      let run: VariantRun
      try {
        run = await deps.runVariant(variant, evalCase)
      } catch (error) {
        // A thrown variant is still an attempt. Record it as a failure so the case
        // is accounted for rather than silently lost (ADR-007 D2).
        records.push({
          caseId: evalCase.id,
          variantId: variant.id,
          cold: !warmedUp,
          outcome: 'failed',
          timing: { ...NO_TIMING },
          totalMs: null,
          attempts: 1,
          usage: { inputTokens: null, outputTokens: null, costUsd: null, usageMissing: true },
          failureReason: describeError(error),
        })
        warmedUp = true
        continue
      }

      if (run.ran) {
        // The bench owns the identity of the record; the variant owns the measurement.
        records.push({ ...run.record, caseId: evalCase.id, variantId: variant.id, cold: !warmedUp })
        warmedUp = true
      } else {
        notRun.push({ variantId: variant.id, caseId: evalCase.id, reason: run.reason })
      }
    }
  }

  return { records, notRun, summary: summarise(records) }
}
