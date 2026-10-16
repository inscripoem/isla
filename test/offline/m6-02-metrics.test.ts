import { describe, expect, it } from 'vitest'
import {
  percentile,
  summarise,
  type AttemptRecord,
  type AttemptUsage,
  type StageTiming,
} from '../../src/evaluation/metrics'

const NO_TIMING: StageTiming = {
  submitMs: null,
  planMs: null,
  dialogueMs: null,
  synthesisMs: null,
  firstAudibleMs: null,
  stopToSilenceMs: null,
}

const FULL_USAGE: AttemptUsage = {
  inputTokens: 100,
  outputTokens: 50,
  costUsd: 0.01,
  usageMissing: false,
}

function attempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    caseId: 'case-1',
    variantId: 'variant-rules',
    cold: false,
    outcome: 'completed',
    timing: { ...NO_TIMING },
    totalMs: 100,
    attempts: 1,
    usage: { ...FULL_USAGE },
    ...overrides,
  }
}

describe('percentile', () => {
  it('returns null for an empty sample, never a number', () => {
    expect(percentile([], 0.5)).toBeNull()
    expect(percentile([], 0.95)).toBeNull()
  })

  it('is the sample itself for a single value, and the maximum at q = 1', () => {
    expect(percentile([7], 0.5)).toBe(7)
    expect(percentile([7], 0.95)).toBe(7)
    expect(percentile([3, 1, 2], 1)).toBe(3)
  })

  it('is nearest-rank on an even sample', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2)
    expect(percentile([1, 2, 3, 4], 0.95)).toBe(4)
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3)
  })
})

describe('summarise — honesty of the aggregate', () => {
  it('records failed and cancelled attempts instead of dropping them', () => {
    const summary = summarise([
      attempt({ outcome: 'completed' }),
      attempt({ outcome: 'failed' }),
      attempt({ outcome: 'cancelled' }),
      attempt({ outcome: 'failed' }),
    ])
    expect(summary.attempts).toBe(4)
    expect(summary.outcomes).toEqual({ completed: 1, cancelled: 1, failed: 2 })
    expect(summary.failureRate).toBe(0.5)
  })

  it('separates cold and warm attempts', () => {
    const summary = summarise([
      attempt({ cold: true, totalMs: 500 }),
      attempt({ cold: false, totalMs: 100 }),
      attempt({ cold: false, totalMs: 200 }),
    ])
    expect(summary.cold.attempts).toBe(1)
    expect(summary.cold.totalMs.p50).toBe(500)
    expect(summary.warm.attempts).toBe(2)
    expect(summary.warm.totalMs.p50).toBe(100)
  })

  it('excludes an unmeasured stage and reports the sample it actually measured', () => {
    const summary = summarise([
      attempt({ timing: { ...NO_TIMING, firstAudibleMs: 300 } }),
      attempt({ timing: { ...NO_TIMING, firstAudibleMs: 900 } }),
      attempt({ timing: { ...NO_TIMING } }),
    ])
    expect(summary.warm.stages.firstAudibleMs.n).toBe(2)
    expect(summary.warm.stages.firstAudibleMs.p50).toBe(300)
    expect(summary.warm.stages.firstAudibleMs.p95).toBe(900)
    expect(summary.warm.stages.planMs.n).toBe(0)
    expect(summary.warm.stages.planMs.p50).toBeNull()
  })

  it('sums usage only when every attempt reports it', () => {
    const summary = summarise([attempt(), attempt(), attempt()])
    expect(summary.usage.unknown).toBe(false)
    expect(summary.usage.inputTokens).toBe(300)
    expect(summary.usage.outputTokens).toBe(150)
    expect(summary.usage.costUsd).toBeCloseTo(0.03, 6)
  })

  it('keeps usage unknown when one attempt is missing it — never a partial total', () => {
    const summary = summarise([
      attempt(),
      attempt({ usage: { inputTokens: null, outputTokens: null, costUsd: null, usageMissing: true } }),
    ])
    expect(summary.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      unknown: true,
    })
  })

  it('reports an empty sample as unknown rather than zero', () => {
    const summary = summarise([])
    expect(summary.attempts).toBe(0)
    expect(summary.failureRate).toBe(0)
    expect(summary.warm.totalMs.p50).toBeNull()
    expect(summary.usage.unknown).toBe(true)
    expect(summary.usage.costUsd).toBeNull()
  })

  it('counts a single provider attempt per opportunity as recorded (NFR-04 allows one)', () => {
    const summary = summarise([attempt({ attempts: 1 }), attempt({ attempts: 1 })])
    expect(summary.attempts).toBe(2)
  })
})
