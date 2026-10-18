import { describe, expect, it } from 'vitest'
import { collectEvalGateViolations } from '../../src/evaluation/eval-gate'

/**
 * Gate G4 is a semantic-evaluation gate with no evaluation set yet (DEBT-01), so
 * its contract is honesty: it must never report a pass it cannot support.
 */
describe('G4 semantic-evaluation gate', () => {
  it('reports not run — never a pass — when there is no evaluation table', () => {
    expect(collectEvalGateViolations(null)).toEqual({ ran: false, violations: [] })
  })

  it('accepts a table that records every fixed condition NFR-01 requires', () => {
    const table = [
      '# Evaluation',
      '',
      '| hardware | providers | workload | sample size | cold/warm |',
      '| --- | --- | --- | --- | --- |',
      '| Apple M2 | deepseek | 30 turns | n = 40 | cold |',
    ].join('\n')
    expect(collectEvalGateViolations(table)).toEqual({ ran: true, violations: [] })
  })

  it('fails a table that reports results without the fixed conditions', () => {
    const result = collectEvalGateViolations('# Evaluation\n\np95 input-to-first-audio: 120 ms\n')
    expect(result.ran).toBe(true)
    expect(result.violations.length).toBeGreaterThan(0)
    expect(result.violations.join(' ')).toContain('hardware')
  })

  it('names the specific condition a partial table omits', () => {
    const table = 'hardware: M2; provider: deepseek; workload: 30 turns; sample: n=40\n'
    // Everything but the cold/warm state.
    const result = collectEvalGateViolations(table)
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]).toContain('cold')
  })
})
