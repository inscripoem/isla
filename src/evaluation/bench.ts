import type { ComparisonDeps, EvalCase, Variant } from './comparison'
import { runComparison } from './comparison'
import { RECORDED_RUN_SCHEMA_VERSION, type RecordedRunV1 } from './recorded-run'
import type { FixedConditions, RunMeta } from './report'

/**
 * M6-02 R2 — the offline bench harness.
 *
 * `runBench` is the producer side of the recorded-run contract. It wraps the
 * existing `runComparison` with an injected `runVariant`, labels the run with
 * caller-supplied identity and fixed conditions, and returns exactly the
 * `schemaVersion: 1` shape consumed by R1.
 *
 * It does not compose M3/M4/M1/M5 and does not talk to a provider. The caller
 * supplies `runVariant`; R3/S6 later supplies the production adapter.
 *
 * The declared sample size is computed from the attempts actually recorded by
 * `runComparison`, not from the number of cases. A not-run case produces no
 * attempt, so counting cases as attempts would fabricate evidence.
 */

export interface BenchConditions extends Omit<FixedConditions, 'sampleSize'> {}

export interface BenchSpec {
  readonly meta: RunMeta
  readonly conditions: BenchConditions
  readonly variants: readonly Variant[]
  readonly cases: readonly EvalCase[]
}


/**
 * Run the cases through the variants and return a JSON-serialisable recorded run.
 *
 * No `summary` field is emitted: R1 recomputes it from `records`. Unknown or
 * not-run cases remain explicit `notRun` entries; a thrown variant remains a
 * failed record through `runComparison`.
 */
export async function runBench(
  spec: BenchSpec,
  deps: ComparisonDeps,
): Promise<RecordedRunV1> {
  const comparison = await runComparison(
    { variants: spec.variants, cases: spec.cases },
    deps,
  )

  return {
    schemaVersion: RECORDED_RUN_SCHEMA_VERSION,
    meta: spec.meta,
    variants: spec.variants,
    conditions: {
      ...spec.conditions,
      sampleSize: comparison.records.length,
    },
    records: comparison.records,
    notRun: comparison.notRun,
  }
}
