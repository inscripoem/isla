import { describe, expect, it } from 'vitest'
import {
  collectApprovalEvidenceViolations,
  collectTestApprovalViolations,
  parseApprovals,
  runCli,
  TEST_APPROVAL_LABEL,
  type ApprovalEvidenceInput,
  type ApprovalRecord,
} from '../../src/evaluation/test-approval-gate'

/** Gate G1: a code or prompt pull request needs the `tests-approved` label. */
describe('G1 test-approval gate', () => {
  const code = { isPullRequest: true, labels: [], changedFiles: ['src/storage/event-store.ts'] }

  it('does not apply outside a pull request', () => {
    expect(collectTestApprovalViolations({ ...code, isPullRequest: false })).toEqual([])
  })

  it('does not apply to a documentation-only change', () => {
    expect(
      collectTestApprovalViolations({ ...code, changedFiles: ['docs/README.md'] }),
    ).toEqual([])
  })

  it('accepts a code pull request carrying the label', () => {
    expect(
      collectTestApprovalViolations({ ...code, labels: [TEST_APPROVAL_LABEL] }),
    ).toEqual([])
  })

  it('flags a code pull request without the label, and names the label', () => {
    const violations = collectTestApprovalViolations(code)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain(TEST_APPROVAL_LABEL)
  })

  it('treats a prompt change the same as a code change', () => {
    expect(collectTestApprovalViolations({ ...code, changedFiles: ['prompts/m4/persona.md'] })).toHaveLength(1)
  })

  it('is advisory by default and fails only when set to enforce', () => {
    expect(runCli(code, 'advise')).toBe(0)
    expect(runCli(code, 'enforce')).toBe(1)
    expect(runCli({ ...code, labels: [TEST_APPROVAL_LABEL] }, 'enforce')).toBe(0)
  })
})

describe('G1 reads the CI change set (finding 2)', () => {
  it('counts a spaced filename under src/ as a code change', () => {
    // One path with a space in it: the gate must see a single code path, not two
    // broken ones. The NUL-separated list it reads in CI is what preserves this.
    expect(collectTestApprovalViolations({ isPullRequest: true, labels: [], changedFiles: ['src/a b.ts'] })).toHaveLength(1)
  })
})

describe('G1 evidence: recorded approval predates implementation (Tier 1, 1.1)', () => {
  const record = (overrides: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
    id: 'TA-001',
    task: '#157 memory tables',
    approved_at: '2026-11-01T09:00:00Z',
    approved_by: 'M6',
    scope: ['src/storage/'],
    tests: ['test/offline/m6-storage.test.ts'],
    ...overrides,
  })

  const input = (overrides: Partial<ApprovalEvidenceInput> = {}): ApprovalEvidenceInput => ({
    isPullRequest: true,
    changedFiles: ['src/storage/memory-store.ts'],
    approvals: [record()],
    recordFirstTouch: 'aaaaaaa',
    firstCodeCommit: 'bbbbbbb',
    firstCodeCommitTime: '2026-11-02T09:00:00Z',
    isAncestor: () => true,
    fileExists: () => true,
    ...overrides,
  })

  it('passes when the record was committed before the first code commit', () => {
    expect(collectApprovalEvidenceViolations(input())).toEqual([])
  })

  it('fails when the record was committed after implementation began', () => {
    const violations = collectApprovalEvidenceViolations(input({ isAncestor: () => false }))
    expect(violations.join(' ')).toContain('after implementation began')
  })

  it('fails closed when the history answer is unavailable', () => {
    const violations = collectApprovalEvidenceViolations(input({ isAncestor: () => null }))
    expect(violations.join(' ')).toContain('history is unavailable')
  })

  it('fails when there is no approval record at all', () => {
    const violations = collectApprovalEvidenceViolations(input({ approvals: null }))
    expect(violations.join(' ')).toContain('test-approvals.yaml')
  })

  it('fails when an approval does not cover a changed code file', () => {
    const violations = collectApprovalEvidenceViolations(
      input({ changedFiles: ['src/runtime/composition.ts'] }),
    )
    expect(violations.join(' ')).toContain('no recorded approval covers src/runtime/composition.ts')
  })

  it('fails when an approval names a test that does not exist', () => {
    const violations = collectApprovalEvidenceViolations(input({ fileExists: () => false }))
    expect(violations.join(' ')).toContain('does not exist')
  })

  it('fails when the approval date is later than the first code commit', () => {
    const violations = collectApprovalEvidenceViolations(
      input({
        approvals: [record({ approved_at: '2026-11-03T09:00:00Z' })],
      }),
    )
    expect(violations.join(' ')).toContain('after the first code commit')
  })

  it('fails when code changed but the first code commit cannot be determined', () => {
    const violations = collectApprovalEvidenceViolations(input({ firstCodeCommit: null }))
    expect(violations.join(' ')).toContain('could not be determined')
  })

  it('does not apply outside a pull request or to documentation only', () => {
    expect(collectApprovalEvidenceViolations(input({ isPullRequest: false }))).toEqual([])
    expect(
      collectApprovalEvidenceViolations(input({ changedFiles: ['docs/architecture/memory-design.md'] })),
    ).toEqual([])
  })

  it('accepts an approval that came from before the diff range', () => {
    expect(collectApprovalEvidenceViolations(input({ recordFirstTouch: null }))).toEqual([])
  })
})

describe('approval record shape', () => {
  const valid = `version: "1"
approvals:
  - id: TA-001
    task: slice
    approved_at: "2026-11-01T09:00:00Z"
    approved_by: M6
    scope: ["src/storage/"]
    tests: ["test/offline/m6-storage.test.ts"]
`

  it('parses a well-formed record', () => {
    const parsed = parseApprovals(valid)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.approvals[0]?.id).toBe('TA-001')
  })

  it('rejects a record with no scope', () => {
    const broken = valid.replace('    scope: ["src/storage/"]\n', '')
    const parsed = parseApprovals(broken)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.errors.join(' ')).toContain('scope')
  })

  it('rejects a non-ISO approval date', () => {
    const broken = valid.replace('"2026-11-01T09:00:00Z"', '"last Tuesday"')
    const parsed = parseApprovals(broken)
    expect(parsed.ok).toBe(false)
  })

  it('rejects an empty approvals list', () => {
    const parsed = parseApprovals('version: "1"\napprovals: []\n')
    expect(parsed.ok).toBe(false)
  })
})
