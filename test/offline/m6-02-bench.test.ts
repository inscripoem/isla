import { describe, expect, it } from 'vitest'
import { runBench, type BenchConditions } from '../../src/evaluation/bench'
import type { EvalCase, Variant } from '../../src/evaluation/comparison'
import { parseRecordedRun } from '../../src/evaluation/recorded-run'
import {
  SYNTHETIC_CASES,
  SYNTHETIC_VARIANT,
  syntheticRunVariant,
} from '../support/m6-02-synthetic'

const CONDITIONS: BenchConditions = {
  hardware: 'test host',
  providers: ['test-provider'],
  workload: 'synthetic recorded bench',
  coldWarm: 'warm',
  persona: { profileId: 'isla', version: '1.0.0' },
  modelVersion: 'test-model-v1',
  promptVersion: 'prompt-v1',
  textBudget: { maxCharacters: 400, accounting: 'rendered characters' },
  history: { source: 'durable', recordSet: 'recorded-run-v1' },
  textSource: 'provider',
  clock: 'wall',
  recall: { supplied: false, maxTurns: null },
}

const META = { runId: 'bench-1', generatedAt: '2026-10-19' }
const CASE: EvalCase = { id: 'case-1', input: 'hello' }
const VARIANT: Variant = { id: 'v1', kind: 'rules', combined: false }

describe('M6-02 R2 runBench', () => {
  it('returns the frozen v1 shape with an actual attempt sample size', async () => {
    const run = await runBench(
      {
        meta: META,
        conditions: CONDITIONS,
        variants: [SYNTHETIC_VARIANT],
        cases: SYNTHETIC_CASES,
      },
      { runVariant: syntheticRunVariant() },
    )

    expect(run.schemaVersion).toBe(1)
    expect(run.conditions.sampleSize).toBe(3)
    expect(run.records).toHaveLength(3)
    expect(run.notRun).toEqual([])
    expect(run.records.map((record) => record.cold)).toEqual([true, false, false])
    expect('summary' in run).toBe(false)

    const parsed = parseRecordedRun(JSON.stringify(run))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('unreachable')
    expect(parsed.input.run.summary.attempts).toBe(3)
  })

  it('counts attempts, not cases, when a case is not run', async () => {
    const cases: EvalCase[] = [
      { id: 'case-run', input: 'run' },
      { id: 'case-skip', input: 'skip' },
    ]
    const run = await runBench(
      { meta: META, conditions: CONDITIONS, variants: [VARIANT], cases },
      {
        runVariant: async (_variant, evalCase) =>
          evalCase.id === 'case-skip'
            ? { ran: false, reason: 'not configured' }
            : {
                ran: true,
                record: {
                  caseId: 'ignored',
                  variantId: 'ignored',
                  cold: false,
                  outcome: 'completed',
                  timing: {
                    submitMs: null,
                    planMs: null,
                    dialogueMs: null,
                    synthesisMs: null,
                    firstAudibleMs: null,
                    stopToSilenceMs: null,
                  },
                  totalMs: 10,
                  attempts: 1,
                  usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, usageMissing: false },
                  failureReason: null,
                },
              },
      },
    )

    expect(run.conditions.sampleSize).toBe(1)
    expect(run.records).toHaveLength(1)
    expect(run.notRun).toEqual([
      { variantId: 'v1', caseId: 'case-skip', reason: 'not configured' },
    ])
    expect(parseRecordedRun(JSON.stringify(run)).ok).toBe(true)
  })

  it('keeps a thrown variant as a failed record', async () => {
    const run = await runBench(
      { meta: META, conditions: CONDITIONS, variants: [VARIANT], cases: [CASE] },
      { runVariant: () => Promise.reject(new Error('synthetic failure')) },
    )

    expect(run.conditions.sampleSize).toBe(1)
    expect(run.records[0]?.outcome).toBe('failed')
    expect(run.records[0]?.failureReason).toBe('synthetic failure')
    expect(run.records[0]?.attempts).toBeNull()
    const parsed = parseRecordedRun(JSON.stringify(run))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('unreachable')
    expect(parsed.input.run.summary.outcomes.failed).toBe(1)
  })

  it('does not mutate the supplied cases or variants', async () => {
    const cases = [...SYNTHETIC_CASES]
    const variants = [SYNTHETIC_VARIANT]
    await runBench(
      { meta: META, conditions: CONDITIONS, variants, cases },
      { runVariant: syntheticRunVariant() },
    )
    expect(cases).toEqual(SYNTHETIC_CASES)
    expect(variants).toEqual([SYNTHETIC_VARIANT])
  })
})
