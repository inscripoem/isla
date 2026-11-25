import { describe, expect, it } from 'vitest'
import {
  collectApprovalEvidenceViolations,
  collectTestApprovalViolations,
  decideApprovalMode,
  G1_EVIDENCE_ACTIVATED_AT,
  G1_TIME_WAIVER_PRS,
  G1_TIME_WAIVER_UNTIL,
  isTimeWaived,
  parseApprovals,
  runCli,
  selectApprovalMode,
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

describe('G1 cutover: mode by PR creation time (Tier 1, #177)', () => {
  const cutover = G1_EVIDENCE_ACTIVATED_AT

  it('keeps the label rule for a PR created before the cutover', () => {
    expect(
      selectApprovalMode({ createdAt: '2026-11-13T17:30:01Z', activatedAt: cutover }),
    ).toEqual({ mode: 'advise', reason: 'pre-cutover' })
  })

  it('uses evidence for a PR created after the cutover', () => {
    expect(
      selectApprovalMode({ createdAt: '2026-11-18T11:24:14Z', activatedAt: cutover }),
    ).toEqual({ mode: 'evidence', reason: 'post-cutover' })
  })

  it('treats the cutover instant itself as post-cutover', () => {
    expect(selectApprovalMode({ createdAt: cutover, activatedAt: cutover })).toEqual({
      mode: 'evidence',
      reason: 'post-cutover',
    })
  })

  it('handles an offset timestamp at the cutover boundary', () => {
    expect(
      selectApprovalMode({ createdAt: '2026-11-16T17:01:01+01:00', activatedAt: cutover }),
    ).toEqual({ mode: 'evidence', reason: 'post-cutover' })
  })

  it('fails closed when the PR creation time is missing', () => {
    expect(selectApprovalMode({ createdAt: null, activatedAt: cutover })).toEqual({
      mode: 'evidence',
      reason: 'created-at-unavailable',
    })
    expect(selectApprovalMode({ createdAt: '   ', activatedAt: cutover })).toEqual({
      mode: 'evidence',
      reason: 'created-at-unavailable',
    })
  })

  it('fails closed when the activation time is missing', () => {
    expect(selectApprovalMode({ createdAt: '2026-11-13T17:30:01Z', activatedAt: null })).toEqual({
      mode: 'evidence',
      reason: 'activated-at-unavailable',
    })
  })

  it('fails closed when either timestamp is unparsable', () => {
    expect(selectApprovalMode({ createdAt: 'not-a-date', activatedAt: cutover })).toEqual({
      mode: 'evidence',
      reason: 'invalid-timestamp',
    })
    expect(
      selectApprovalMode({ createdAt: '2026-11-13T17:30:01Z', activatedAt: 'not-a-date' }),
    ).toEqual({ mode: 'evidence', reason: 'invalid-timestamp' })
  })
})

describe('G1 time-boxed waiver through 2026-11-27 (Tier 1, #176)', () => {
  const beforeExpiry = '2026-11-19T00:00:00Z'
  const atLastSecond = '2026-11-27T23:59:59+08:00'
  const atExpiry = '2026-11-28T00:00:00+08:00'

  it('waives the named PRs before the expiry', () => {
    for (const prNumber of G1_TIME_WAIVER_PRS) {
      expect(isTimeWaived({ prNumber, now: beforeExpiry })).toBe(true)
    }
  })

  it('waives #181 as the CP04 console UI-defect slice', () => {
    expect(isTimeWaived({ prNumber: 181, now: beforeExpiry })).toBe(true)
  })

  it('waives #211 as the M2-202 avatar viewport slice with a post-code TA-014 record', () => {
    expect(isTimeWaived({ prNumber: 211, now: beforeExpiry })).toBe(true)
    expect(
      decideApprovalMode({
        createdAt: null,
        activatedAt: G1_EVIDENCE_ACTIVATED_AT,
        prNumber: 211,
        now: beforeExpiry,
      }),
    ).toEqual({ mode: 'advise', reason: 'waiver' })
  })

  it('returns #211 to evidence after the waiver expires', () => {
    expect(isTimeWaived({ prNumber: 211, now: atExpiry })).toBe(false)
    expect(
      decideApprovalMode({
        createdAt: '2026-11-25T14:00:00Z',
        activatedAt: G1_EVIDENCE_ACTIVATED_AT,
        prNumber: 211,
        now: atExpiry,
      }),
    ).toEqual({ mode: 'evidence', reason: 'post-cutover' })
  })

  it('accepts a Date clock', () => {
    expect(isTimeWaived({ prNumber: 170, now: new Date(beforeExpiry) })).toBe(true)
  })

  it('covers the last second of 27 November Asia/Taipei', () => {
    expect(isTimeWaived({ prNumber: 170, now: atLastSecond })).toBe(true)
  })

  it('stops at the first instant after the window', () => {
    expect(isTimeWaived({ prNumber: 170, now: atExpiry })).toBe(false)
    expect(G1_TIME_WAIVER_UNTIL).toBe(atExpiry)
  })

  it('does not waive an unlisted PR or a missing PR number', () => {
    expect(isTimeWaived({ prNumber: 160, now: beforeExpiry })).toBe(false)
    expect(isTimeWaived({ prNumber: 999, now: beforeExpiry })).toBe(false)
    expect(isTimeWaived({ prNumber: null, now: beforeExpiry })).toBe(false)
  })

  it('grants nothing when the clock or end instant is unreadable', () => {
    expect(isTimeWaived({ prNumber: 170, now: 'not-a-date' })).toBe(false)
    expect(isTimeWaived({ prNumber: 170, now: beforeExpiry, until: 'not-a-date' })).toBe(false)
  })

  it('applies the waiver before the cutover rule for a named PR', () => {
    expect(
      decideApprovalMode({
        createdAt: '2026-11-18T11:24:14Z',
        activatedAt: G1_EVIDENCE_ACTIVATED_AT,
        prNumber: 170,
        now: beforeExpiry,
      }),
    ).toEqual({ mode: 'advise', reason: 'waiver' })
  })

  it('applies the recorded waiver even when the creation time is unavailable', () => {
    expect(
      decideApprovalMode({
        createdAt: null,
        activatedAt: G1_EVIDENCE_ACTIVATED_AT,
        prNumber: 170,
        now: beforeExpiry,
      }),
    ).toEqual({ mode: 'advise', reason: 'waiver' })
  })

  it('keeps #160 on the permanent pre-cutover rule, not the waiver', () => {
    expect(
      decideApprovalMode({
        createdAt: '2026-11-13T17:30:01Z',
        activatedAt: G1_EVIDENCE_ACTIVATED_AT,
        prNumber: 160,
        now: beforeExpiry,
      }),
    ).toEqual({ mode: 'advise', reason: 'pre-cutover' })
  })

  it('returns a post-cutover PR to evidence after the waiver expires', () => {
    expect(
      decideApprovalMode({
        createdAt: '2026-11-18T11:24:14Z',
        activatedAt: G1_EVIDENCE_ACTIVATED_AT,
        prNumber: 175,
        now: atExpiry,
      }),
    ).toEqual({ mode: 'evidence', reason: 'post-cutover' })
  })

  it('does not let the waiver hide an unknown creation time for an unlisted PR', () => {
    expect(
      decideApprovalMode({
        createdAt: null,
        activatedAt: G1_EVIDENCE_ACTIVATED_AT,
        prNumber: 999,
        now: beforeExpiry,
      }),
    ).toEqual({ mode: 'evidence', reason: 'created-at-unavailable' })
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
