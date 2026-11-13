import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectAiUseLogReferenceFindings } from '../../src/evaluation/ai-use-log-gate'
import { collectEvalGateFindings } from '../../src/evaluation/eval-gate'
import { aggregateOutcomes } from '../../src/evaluation/gate-aggregate'
import {
  POLICY_SPECS,
  buildGateRecord,
  gateOutcomesRecord,
  writeGateRecord,
} from '../../src/evaluation/gate-record'
import { collectApprovalEvidenceFindings } from '../../src/evaluation/test-approval-gate'
import { policyForTraceCode, traceFindings } from '../../src/evaluation/trace-gate'

const SPEC = POLICY_SPECS['POL-G6-02']!

describe('gate failure records (POL-*)', () => {
  it('builds a record from exactly the declared fields', () => {
    const record = buildGateRecord({
      policy: 'POL-G6-02',
      trigger: 'commit-missing',
      evidence: { entry: 'slice', field: 'commits', value: 'deadbee' },
      commit: 'abcdef1',
      recordedAt: '2026-11-13T00:00:00.000Z',
    })
    expect(record.gate).toBe('G6')
    expect(record.decision).toBe('fail-closed')
    expect(record.action).toBe(SPEC.action)
    expect(Object.keys(record.evidence).sort()).toEqual([...SPEC.fields].sort())
  })

  it('throws when the record promises a field it does not emit', () => {
    expect(() =>
      buildGateRecord({
        policy: 'POL-G6-02',
        trigger: 'commit-missing',
        evidence: { entry: 'slice', field: 'commits' },
      }),
    ).toThrow(/declares/)
  })

  it('throws when the record emits a field the policy does not declare', () => {
    expect(() =>
      buildGateRecord({
        policy: 'POL-G6-02',
        trigger: 'commit-missing',
        evidence: { entry: 'slice', field: 'commits', value: 'x', extra: 1 },
      }),
    ).toThrow(/declares/)
  })

  it('every policy declares a decision, an action and at least one field', () => {
    for (const [id, spec] of Object.entries(POLICY_SPECS)) {
      expect(spec.decision, id).toMatch(/fail-closed|three-state|fail-open-with-debt/)
      expect(spec.action.length, id).toBeGreaterThan(10)
      expect(spec.fields.length, id).toBeGreaterThan(0)
    }
  })

  it('writes one file per failure without overwriting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-records-'))
    try {
      const record = buildGateRecord({
        policy: 'POL-G6-02',
        trigger: 'commit-missing',
        evidence: { entry: 'slice', field: 'commits', value: 'deadbee' },
        commit: 'abcdef1',
        recordedAt: '2026-11-13T00:00:00.000Z',
      })
      writeGateRecord(record, dir)
      writeGateRecord({ ...record, recorded_at: '2026-11-13T00:00:01.000Z' }, dir)
      expect(readdirSync(dir)).toHaveLength(2)
      const written = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]!), 'utf8')) as {
        policy: string
      }
      expect(written.policy).toBe('POL-G6-02')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('POL-PIPE-01: a gate that did not run is not a pass', () => {
  it('reports nothing when every gate succeeded', () => {
    expect(
      aggregateOutcomes({
        g1: 'success',
        g2: 'success',
        g3: 'success',
        trace: 'success',
        g5: 'success',
        g6: 'success',
        g4: 'success',
        build: 'success',
      }),
    ).toEqual({ notVerified: {}, failed: false })
  })

  it('records a skipped or cancelled gate as not-verified', () => {
    const result = aggregateOutcomes({ g2: 'failure', g5: 'skipped' })
    expect(result.failed).toBe(true)
    expect(result.notVerified.g2).toBe('failure')
    expect(result.notVerified.g5).toBe('skipped')
    expect(result.notVerified.g1).toBe('absent')
  })

  it('builds a record whose evidence is the outcome map', () => {
    const record = gateOutcomesRecord({ g6: 'skipped' })
    expect(record.policy).toBe('POL-PIPE-01')
    expect(record.evidence.gate_outcomes).toEqual({ g6: 'skipped' })
  })
})

describe('trace policy mapping', () => {
  it('maps ADR cells to TR-02 and unresolved citations to TR-03', () => {
    expect(policyForTraceCode('trace-adr-unnumbered')).toBe('POL-TR-02')
    expect(policyForTraceCode('trace-test-unresolved')).toBe('POL-TR-03')
    expect(policyForTraceCode('trace-row-orphan')).toBe('POL-TR-03')
    expect(policyForTraceCode('trace-test-missing')).toBe('POL-TR-01')
    expect(policyForTraceCode('trace-component-missing')).toBe('POL-TR-01')
  })

  it('turns a violation into a finding with the declared evidence', () => {
    const [finding] = traceFindings([{ code: 'trace-test-unknown', message: 'x' }])
    expect(finding?.policy).toBe('POL-TR-01')
    expect(Object.keys(finding!.evidence).sort()).toEqual([...POLICY_SPECS['POL-TR-01']!.fields].sort())
  })
})

describe('each gate reports the policy that owns the failure', () => {
  const g1 = (overrides = {}) => ({
    isPullRequest: true,
    changedFiles: ['src/storage/x.ts'],
    approvals: [
      {
        id: 'TA-1',
        task: 't',
        approved_at: '2026-11-01T00:00:00Z',
        approved_by: 'M6',
        scope: ['src/storage/'],
        tests: ['test/offline/m6-storage.test.ts'],
      },
    ],
    recordFirstTouch: 'aaa',
    firstCodeCommit: 'bbb',
    firstCodeCommitTime: '2026-11-02T00:00:00Z',
    isAncestor: () => true,
    fileExists: () => true,
    ...overrides,
  })

  it('G1: scope miss, late record and unavailable history map to G1-01/02/03', () => {
    const scope = collectApprovalEvidenceFindings(g1({ changedFiles: ['src/runtime/x.ts'] }))
    expect(scope.map((f) => f.policy)).toContain('POL-G1-01')
    const late = collectApprovalEvidenceFindings(g1({ isAncestor: () => false }))
    expect(late.map((f) => f.policy)).toContain('POL-G1-02')
    const unknown = collectApprovalEvidenceFindings(g1({ isAncestor: () => null }))
    expect(unknown.map((f) => f.policy)).toContain('POL-G1-03')
  })

  it('G4: claim without table and incomplete row map to G4-01/02', () => {
    const noTable = collectEvalGateFindings(null, [
      { path: 'README.md', text: 'Measured p95 latency was 120 ms.' },
    ])
    expect(noTable.findings.map((f) => f.policy)).toContain('POL-G4-01')
    const incomplete = collectEvalGateFindings(
      'Hardware Hardware provider workload sample cold\n\n| Claim | Value | Conditions |\n| --- | --- | --- |\n| recall@3 |  | x |\n',
    )
    expect(incomplete.findings.map((f) => f.policy)).toContain('POL-G4-02')
  })

  it('G6: unreadable register and missing commit map to G6-03/02', () => {
    const deps = {
      existingCommits: null,
      reachableCommits: null,
      caseIds: new Set<string>(),
      invariantIds: new Set<string>(),
      baseline: [],
      today: '2026-11-13',
    }
    const log = `entries:\n  - task: slice\n    commits: [abcdef1]\n`
    const unreadable = collectAiUseLogReferenceFindings(log, deps)
    expect(unreadable.map((f) => f.policy)).toContain('POL-G6-03')
    const missing = collectAiUseLogReferenceFindings(log, {
      ...deps,
      existingCommits: new Map([['abcdef1', '']]),
    })
    expect(missing.map((f) => f.policy)).toContain('POL-G6-02')
  })
})

describe('catalog and code agree on the policy set', () => {
  it('lists exactly the policies the builder implements', () => {
    const catalog = readFileSync('docs/architecture/runtime-policy-catalog.md', 'utf8')
    const section = catalog.slice(catalog.indexOf('## Pipeline gates (M6)'))
    const ids = new Set(section.match(/POL-[A-Z0-9-]+/g) ?? [])
    expect([...ids].sort()).toEqual(Object.keys(POLICY_SPECS).sort())
  })
})
