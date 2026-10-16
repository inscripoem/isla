import { describe, expect, it } from 'vitest'
import {
  collectTestApprovalViolations,
  runCli,
  TEST_APPROVAL_LABEL,
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
    // Reached through CHANGED_FILES_FILE, so the space survives: the gate sees one
    // code path, not two broken ones.
    expect(collectTestApprovalViolations({ isPullRequest: true, labels: [], changedFiles: ['src/a b.ts'] })).toHaveLength(1)
  })
})
