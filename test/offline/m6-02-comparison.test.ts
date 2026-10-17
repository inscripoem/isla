import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runComparison, type EvalCase, type Variant, type VariantRun } from '../../src/evaluation/comparison'
import type { AttemptRecord } from '../../src/evaluation/metrics'
import { SYNTHETIC_CASES, SYNTHETIC_VARIANT, syntheticRunVariant } from '../support/m6-02-synthetic'

const CASE: EvalCase = { id: 'case-1', input: 'hi' }
const VARIANT: Variant = { id: 'v1', kind: 'rules', combined: false }

function never(): Promise<VariantRun> {
  return Promise.reject(new Error('should not be called'))
}

/** A completed attempt; its identity fields are wrong on purpose (see the fixture). */
function completedRecord(): AttemptRecord {
  return {
    caseId: 'ignored',
    variantId: 'ignored',
    cold: false,
    outcome: 'completed',
    timing: {
      submitMs: null,
      planMs: null,
      dialogueMs: null,
      synthesisMs: null,
      firstAudibleMs: 10,
      stopToSilenceMs: null,
    },
    totalMs: 10,
    attempts: 1,
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, usageMissing: false },
    failureReason: null,
  }
}

describe('runComparison — offline end-to-end (no provider)', () => {
  it('runs one variant across the three synthetic cases and aggregates honestly', async () => {
    const run = await runComparison(
      { variants: [SYNTHETIC_VARIANT], cases: SYNTHETIC_CASES },
      { runVariant: syntheticRunVariant() },
    )

    // Every case is accounted for, once.
    expect(run.records.map((record) => record.caseId)).toEqual(['case-normal', 'case-stop', 'case-fail'])
    expect(run.notRun).toEqual([])

    // The failure and the cancellation are recorded, not dropped.
    expect(run.summary.outcomes).toEqual({ completed: 1, cancelled: 1, failed: 1 })
    expect(run.summary.failureRate).toBeCloseTo(1 / 3, 6)

    // Usage is unknown because one attempt could not report it (NFR-04).
    expect(run.summary.usage.unknown).toBe(true)
    expect(run.summary.usage.costUsd).toBeNull()

    // Within the one variant, the first attempt is cold and the rest are warm.
    expect(run.records.map((record) => record.cold)).toEqual([true, false, false])
    expect(run.summary.cold.attempts).toBe(1)
    expect(run.summary.warm.attempts).toBe(2)
  })

  it('labels every record itself, ignoring the identity the variant reports', async () => {
    const run = await runComparison(
      { variants: [SYNTHETIC_VARIANT], cases: SYNTHETIC_CASES },
      { runVariant: syntheticRunVariant() },
    )
    for (const record of run.records) {
      expect(record.variantId).toBe(SYNTHETIC_VARIANT.id)
      expect(SYNTHETIC_CASES.map((c) => c.id)).toContain(record.caseId)
      expect(record.caseId).not.toBe('unset-by-the-variant')
    }
  })

  it('gives each variant its own cold first attempt', async () => {
    const second: Variant = { id: 'v2', kind: 'model', combined: true }
    const run = await runComparison({ variants: [VARIANT, second], cases: [CASE] }, {
      runVariant: async () => ({ ran: true, record: completedRecord() }),
    })
    expect(run.records.map((record) => [record.variantId, record.cold])).toEqual([
      ['v1', true],
      ['v2', true],
    ])
  })

  it('does not let a not-run case consume the cold slot', async () => {
    const cases: EvalCase[] = [
      { id: 'case-skip', input: 'skipped' },
      { id: 'case-run', input: 'runs' },
    ]
    const run = await runComparison({ variants: [VARIANT], cases }, {
      runVariant: async (_variant, evalCase) =>
        evalCase.id === 'case-skip'
          ? { ran: false, reason: 'not configured' }
          : { ran: true, record: completedRecord() },
    })
    expect(run.notRun).toEqual([{ variantId: 'v1', caseId: 'case-skip', reason: 'not configured' }])
    // Nothing was attempted for case-skip, so the first real attempt is still cold.
    expect(run.records.map((record) => [record.caseId, record.cold])).toEqual([['case-run', true]])
  })
})

describe('runComparison — every attempt is accounted for', () => {
  it('records a variant that throws as a failure with a reason, not as a lost case', async () => {
    const run = await runComparison({ variants: [VARIANT], cases: [CASE] }, {
      runVariant: () => Promise.reject(new Error('provider exploded')),
    })
    expect(run.records).toHaveLength(1)
    const record = run.records[0]!
    expect(record.outcome).toBe('failed')
    expect(record.failureReason).toBe('provider exploded')
    expect(record.usage.usageMissing).toBe(true)
    expect(record.totalMs).toBeNull()
    expect(run.summary.outcomes.failed).toBe(1)
  })

  it('records a deliberately not-run case as notRun and claims no attempt for it', async () => {
    const run = await runComparison({ variants: [VARIANT], cases: [CASE] }, {
      runVariant: async () => ({ ran: false, reason: 'no evaluation provider configured' }),
    })
    expect(run.records).toEqual([])
    expect(run.notRun).toEqual([
      { variantId: 'v1', caseId: 'case-1', reason: 'no evaluation provider configured' },
    ])
    // Nothing was attempted, so nothing is claimed: no attempts, unknown usage.
    expect(run.summary.attempts).toBe(0)
    expect(run.summary.usage.unknown).toBe(true)
  })

  it('runs nothing for an empty case set and still reports an honest summary', async () => {
    const run = await runComparison({ variants: [VARIANT], cases: [] }, { runVariant: never })
    expect(run.records).toEqual([])
    expect(run.notRun).toEqual([])
    expect(run.summary.attempts).toBe(0)
    expect(run.summary.failureRate).toBe(0)
  })
})

describe('runComparison — the case shape from issue #41 Q3a', () => {
  it('hands each case to the variant unchanged and invents no missing field', async () => {
    const crafted: readonly EvalCase[] = [
      { id: 'with-intent', input: 'hello', replyIntent: 'greeting', heldOut: true },
      { id: 'bare', input: 'hello' },
    ]
    const seen: EvalCase[] = []
    await runComparison(
      { variants: [VARIANT], cases: crafted },
      {
        runVariant: async (_variant, evalCase) => {
          seen.push(evalCase)
          return { ran: true, record: completedRecord() }
        },
      },
    )

    // The variant sees exactly what the case declared: no defaults, no dropped fields.
    expect(seen).toEqual(crafted)
    expect(Object.keys(seen[1] ?? {})).toEqual(['id', 'input'])
    expect(seen[1]).not.toHaveProperty('replyIntent')
    expect(seen[1]).not.toHaveProperty('heldOut')
  })
})

describe('runComparison — module boundary', () => {
  it('does not import the pipeline: the bench aggregates, it does not compose', () => {
    const source = readFileSync('src/evaluation/comparison.ts', 'utf8')
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '')
    expect(imports.length).toBeGreaterThan(0)
    expect(imports.some((path) => path.includes('runtime') || path.includes('dialogue'))).toBe(false)
    expect(imports).toEqual(['./metrics'])
  })
})
