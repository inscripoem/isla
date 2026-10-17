import { describe, expect, it } from 'vitest'
import type { ComparisonRun, Variant } from '../../src/evaluation/comparison'
import { summarise, type AttemptRecord } from '../../src/evaluation/metrics'
import {
  collectReportViolations,
  renderEvaluationReport,
  type FixedConditions,
  type ReportInput,
} from '../../src/evaluation/report'

const VARIANT: Variant = { id: 'rules-baseline', kind: 'rules', combined: false }

const CONDITIONS: FixedConditions = {
  hardware: 'Sample host — Apple M3, 16 GB (test data)',
  providers: ['sample-provider'],
  workload: '3 synthetic cases x 1 variant (test data)',
  sampleSize: 3,
  coldWarm: 'warm',
  persona: { profileId: 'isla', version: '1.0.0' },
  modelVersion: 'sample-model-v1',
  promptVersion: 'prompt-v1',
  textBudget: { maxCharacters: 400, accounting: 'rendered characters, shared with recall' },
  history: { source: 'durable', recordSet: 'case-history-v1' },
  textSource: 'provider',
  clock: 'wall',
  recall: { supplied: true, maxTurns: 0 },
}

function record(overrides: Partial<AttemptRecord>): AttemptRecord {
  return {
    caseId: 'case-normal',
    variantId: VARIANT.id,
    cold: false,
    outcome: 'completed',
    timing: {
      submitMs: 5,
      planMs: 40,
      dialogueMs: 120,
      synthesisMs: 80,
      firstAudibleMs: 245,
      stopToSilenceMs: null,
    },
    totalMs: 245,
    attempts: 1,
    usage: { inputTokens: 120, outputTokens: 60, costUsd: 0.002, usageMissing: false },
    failureReason: null,
    ...overrides,
  }
}

/** One completed (first attempt), one cancelled, one failed with no usage. */
function sampleRun(): ComparisonRun {
  const records = [
    record({ caseId: 'case-normal', outcome: 'completed', cold: true }),
    record({
      caseId: 'case-stop',
      outcome: 'cancelled',
      cold: false,
      totalMs: 150,
      timing: {
        submitMs: 5,
        planMs: 40,
        dialogueMs: 120,
        synthesisMs: null,
        firstAudibleMs: null,
        stopToSilenceMs: null,
      },
    }),
    record({
      caseId: 'case-fail',
      outcome: 'failed',
      cold: false,
      totalMs: null,
      timing: {
        submitMs: null,
        planMs: null,
        dialogueMs: null,
        synthesisMs: null,
        firstAudibleMs: null,
        stopToSilenceMs: null,
      },
      usage: { inputTokens: null, outputTokens: null, costUsd: null, usageMissing: true },
      failureReason: 'sample provider rejection',
    }),
  ]
  return {
    records,
    notRun: [{ variantId: VARIANT.id, caseId: 'case-skip', reason: 'no provider for this case' }],
    summary: summarise(records),
  }
}

function input(overrides: { run?: ComparisonRun; conditions?: Partial<FixedConditions> } = {}): ReportInput {
  return {
    run: overrides.run ?? sampleRun(),
    variants: [VARIANT],
    conditions: { ...CONDITIONS, ...overrides.conditions },
  }
}

describe('the evaluation report is a receipt for a real run', () => {
  it('records the five conditions gate G4 requires, plus the ones #41 asked for', () => {
    const result = renderEvaluationReport(input())
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const text = result.markdown.toLowerCase()
    for (const word of ['hardware', 'provider', 'workload', 'sample', 'cold']) {
      expect(text).toContain(word)
    }
    for (const detail of ['persona', 'model version', 'prompt version', 'text budget', 'history', 'clock', 'maxturns', 'recall port']) {
      expect(text).toContain(detail)
    }
  })

  it('counts completed, cancelled and failed attempts, and reports the failure rate', () => {
    const result = renderEvaluationReport(input())
    if (!result.ok) throw new Error('unreachable')
    expect(result.markdown).toContain('| rules-baseline | rules | no | 3 | 1 | 1 | 1 | 33.3% | unknown |')
  })

  it('prints no number for a stage that was never observed, and keeps usage unknown', () => {
    const result = renderEvaluationReport(input())
    if (!result.ok) throw new Error('unreachable')
    expect(result.markdown).toContain('| stop→silence (M1/M2) | 0 | — | — |')
    expect(result.markdown).toContain('| unknown |')
  })

  it('lists a not-run case with its reason and does not count it as an attempt', () => {
    const result = renderEvaluationReport(input())
    if (!result.ok) throw new Error('unreachable')
    expect(result.markdown).toContain('| rules-baseline | case-skip | no provider for this case |')
    expect(result.markdown).toContain('| 3 | 1 | 1 | 1 |')
  })

  it('labels the first attempt honestly instead of calling it cold', () => {
    const result = renderEvaluationReport(input())
    if (!result.ok) throw new Error('unreachable')
    expect(result.markdown).toContain('first attempt')
    expect(result.markdown).toContain('not** evidence of a')
    expect(result.markdown).toContain('declared cold/warm state above is the run condition')
  })
})

describe('the report refuses a run it cannot honestly publish', () => {
  const violationsOf = (overrides: Parameters<typeof input>[0]): readonly string[] => {
    const result = renderEvaluationReport(input(overrides))
    return result.ok ? [] : result.violations
  }

  it('refuses a fixture text source', () => {
    expect(violationsOf({ conditions: { textSource: 'fixture' } }).join(' ')).toContain(
      'fixture text source is not a benchmark',
    )
  })

  it('refuses latency measured with an injected clock', () => {
    expect(violationsOf({ conditions: { clock: 'injected' } }).join(' ')).toContain('injected clock cannot measure')
  })

  it('allows an injected clock when nothing was measured', () => {
    const noTiming = sampleRun()
    const records = noTiming.records.map((entry) => ({
      ...entry,
      timing: {
        submitMs: null,
        planMs: null,
        dialogueMs: null,
        synthesisMs: null,
        firstAudibleMs: null,
        stopToSilenceMs: null,
      },
      totalMs: null,
    }))
    expect(
      collectReportViolations(input({ run: { ...noTiming, records, summary: summarise(records) }, conditions: { clock: 'injected' } })),
    ).toEqual([])
  })

  it('refuses a run with no attempts', () => {
    const empty: ComparisonRun = { records: [], notRun: [], summary: summarise([]) }
    const violations = violationsOf({ run: empty, conditions: { sampleSize: 1 } })
    expect(violations.join(' ')).toContain('no attempts were recorded')
  })

  it('refuses a declared sample size that does not match the records', () => {
    expect(violationsOf({ conditions: { sampleSize: 9 } }).join(' ')).toContain('does not match the 3 attempts')
  })

  it('refuses a missing fixed condition, naming it', () => {
    expect(violationsOf({ conditions: { hardware: '  ' } }).join(' ')).toContain('hardware is required')
    expect(violationsOf({ conditions: { workload: '' } }).join(' ')).toContain('workload is required')
    expect(violationsOf({ conditions: { providers: [] } }).join(' ')).toContain('at least one provider')
  })

  it('refuses a record for a variant the run did not declare', () => {
    const run = sampleRun()
    expect(
      collectReportViolations({ run, variants: [{ ...VARIANT, id: 'other' }], conditions: { ...CONDITIONS } }).join(' '),
    ).toContain('not declared in the run')
  })
})
