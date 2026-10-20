import type { EvalCase, Variant, VariantRun } from '../../src/evaluation/comparison'
import type { AttemptRecord } from '../../src/evaluation/metrics'

/**
 * Synthetic M6-02 fixtures — a case set and a scripted `runVariant`.
 *
 * These are **test-only** controls, not a re-implementation of the bench: they
 * produce the records a real variant would produce, so the runner and the
 * aggregation can be exercised with **no provider and no model**. Real runs need
 * the pipeline (issue #41 Q1) and are the later, team-gated part.
 *
 * `caseId`, `variantId` and `cold` are deliberately set to obviously wrong values
 * here. The runner owns them, so a test that passes proves the bench labels its own
 * records and cannot be mis-attributed by a variant.
 */

export const SYNTHETIC_VARIANT: Variant = { id: 'rules-baseline', kind: 'rules', combined: false }

/** One normal case, one cancelled at Stop, and one that fails outright. */
export const SYNTHETIC_CASES: readonly EvalCase[] = [
  { id: 'case-normal', input: 'hello there' },
  { id: 'case-stop', input: 'a very long request' },
  { id: 'case-fail', input: 'a request the provider rejects' },
]

const FULL_TIMING = {
  submitMs: 5,
  planMs: 40,
  dialogueMs: 120,
  synthesisMs: 80,
  firstAudibleMs: 245,
  stopToSilenceMs: null,
}

/** A record whose identity fields the runner must replace. */
function record(overrides: Partial<AttemptRecord>): AttemptRecord {
  return {
    caseId: 'unset-by-the-variant',
    variantId: 'unset-by-the-variant',
    cold: false,
    outcome: 'completed',
    timing: { ...FULL_TIMING },
    totalMs: 245,
    attempts: 1,
    usage: { inputTokens: 120, outputTokens: 60, costUsd: 0.002, usageMissing: false },
    failureReason: null,
    ...overrides,
  }
}

/**
 * A deterministic `runVariant`: no clock, no randomness, no provider. Each case id
 * maps to one scripted outcome, so the end-to-end assertion is exact.
 */
export function syntheticRunVariant(): (variant: Variant, evalCase: EvalCase) => Promise<VariantRun> {
  return async (_variant, evalCase) => {
    if (evalCase.id === 'case-fail') {
      return {
        ran: true,
        record: record({
          outcome: 'failed',
          timing: { ...FULL_TIMING, firstAudibleMs: null },
          totalMs: null,
          usage: { inputTokens: null, outputTokens: null, costUsd: null, usageMissing: true },
          failureReason: 'synthetic provider rejection',
        }),
      }
    }
    if (evalCase.id === 'case-stop') {
      return {
        ran: true,
        record: record({
          outcome: 'cancelled',
          timing: { ...FULL_TIMING, stopToSilenceMs: 60 },
          totalMs: 150,
        }),
      }
    }
    return { ran: true, record: record({ outcome: 'completed', timing: { ...FULL_TIMING } }) }
  }
}
