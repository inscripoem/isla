import { describe, expect, it } from 'vitest'
import {
  claimLineKey,
  collectEvalGateViolations,
  type ClaimDocument,
  type ClaimExemption,
} from '../../src/evaluation/eval-gate'

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

describe('G4 claims: a measured result needs fixed-condition evidence (Tier 1, 1.2)', () => {
  const table = `# Evaluation table

Hardware: M2 MacBook. Provider: DeepSeek. Workload: 20 turns. Sample: 20 runs. Cold/warm: both.

| Claim | Value | Conditions | Artifact |
| --- | --- | --- | --- |
`

  const doc = (text: string): ClaimDocument[] => [{ path: 'README.md', text }]

  it('is not run when there is no table and no claim', () => {
    expect(collectEvalGateViolations(null)).toEqual({ ran: false, violations: [] })
  })

  it('fails a measured claim when no evaluation table exists', () => {
    const result = collectEvalGateViolations(null, doc('Measured p95 latency was 120 ms on the laptop.'))
    expect(result.ran).toBe(true)
    expect(result.violations.join(' ')).toContain('does not exist')
  })

  it('accepts a target stated as a target', () => {
    const result = collectEvalGateViolations(null, doc('The target p95 latency is 150 ms.'))
    expect(result.violations).toEqual([])
  })

  it('accepts a measured claim when the table records the fixed conditions', () => {
    const result = collectEvalGateViolations(table, doc('Measured p95 latency was 120 ms.'))
    expect(result.violations).toEqual([])
  })

  it('fails a claim row with no value', () => {
    const withRow = `${table}| recall@3 |  | hardware+provider | run.json |\n`
    const result = collectEvalGateViolations(withRow)
    expect(result.violations.join(' ')).toContain('records no value')
  })

  it('fails a claim row with no conditions', () => {
    const withRow = `${table}| recall@3 | 0.8 |  | run.json |\n`
    const result = collectEvalGateViolations(withRow)
    expect(result.violations.join(' ')).toContain('names no fixed conditions')
  })

  it('accepts a complete claim row', () => {
    const withRow = `${table}| recall@3 | 0.8 | hardware+provider | run.json |\n`
    expect(collectEvalGateViolations(withRow).violations).toEqual([])
  })
})

describe('G4 claim exemptions expire', () => {
  const line = 'Measured p95 latency was 120 ms on the laptop.'
  const docs: ClaimDocument[] = [{ path: 'README.md', text: line }]
  const exemption = (expires: string): ClaimExemption[] => [
    { key: claimLineKey('README.md', line), expires },
  ]

  it('accepts a reviewed exception before its expiry', () => {
    const result = collectEvalGateViolations(null, docs, {
      claimExemptions: exemption('2026-12-31'),
      today: '2026-11-13',
    })
    expect(result.violations).toEqual([])
  })

  it('fails the same line after the exemption expires', () => {
    const result = collectEvalGateViolations(null, docs, {
      claimExemptions: exemption('2026-01-01'),
      today: '2026-11-13',
    })
    expect(result.violations.join(' ')).toContain('expired')
  })

  it('does not let an exemption hide a different sentence', () => {
    const other: ClaimDocument[] = [
      { path: 'README.md', text: 'Measured p95 latency was 900 ms on the laptop.' },
    ]
    const result = collectEvalGateViolations(null, other, {
      claimExemptions: exemption('2026-12-31'),
      today: '2026-11-13',
    })
    expect(result.violations.join(' ')).toContain('does not exist')
  })
})
