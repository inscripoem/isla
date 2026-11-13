import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseDocument } from 'yaml'
import { readChangedFiles } from './changed-files'
import { commitTime, firstCommitTouching, isAncestorOf, mergeBase } from './git-facts'

/**
 * M6 / R3 — gate G1: tests are approved before implementation (ADR-006).
 *
 * G1 asks a *process* question: were the tests for this change agreed before the
 * change was written? No static check can prove that, so the gate uses the
 * convention the team already documents in `.github/PULL_REQUEST_TEMPLATE.md` — a
 * `tests-approved` label on the pull request.
 *
 * The gate has two modes:
 *   - `advise` (default): report the missing label, but do not fail the run.
 *   - `enforce`: fail the run so the gate can block a merge once branch protection
 *     requires it.
 *
 * It only applies to pull requests that change code or prompts. A push to a branch
 * is not where a change is approved, and a documentation-only change has no test to
 * approve first.
 */

export const TEST_APPROVAL_LABEL = 'tests-approved'

const CODE_OR_PROMPT_PREFIXES = ['src/', 'prompts/']

export type GateMode = 'enforce' | 'advise'

export interface TestApprovalInput {
  /** True only for a pull-request run. */
  readonly isPullRequest: boolean
  /** Label names carried by the pull request. */
  readonly labels: readonly string[]
  /** Files changed by the pull-request diff. */
  readonly changedFiles: readonly string[]
}

export function collectTestApprovalViolations(input: TestApprovalInput): string[] {
  if (!input.isPullRequest) return []
  const touchesCodeOrPrompt = input.changedFiles.some((file) =>
    CODE_OR_PROMPT_PREFIXES.some((prefix) => file.startsWith(prefix)),
  )
  if (!touchesCodeOrPrompt) return []
  if (input.labels.includes(TEST_APPROVAL_LABEL)) return []
  return [
    `this pull request changes code or prompts but does not carry the "${TEST_APPROVAL_LABEL}" label (gate G1)`,
  ]
}

export function runCli(input: TestApprovalInput, mode: GateMode): number {
  const violations = collectTestApprovalViolations(input)
  if (violations.length === 0) {
    process.stdout.write('G1: tests-approved requirement satisfied (or not applicable)\n')
    return 0
  }
  for (const violation of violations) process.stderr.write(`G1 (${mode}): ${violation}\n`)
  if (mode === 'advise') {
    process.stdout.write(
      `G1: advisory only — add the "${TEST_APPROVAL_LABEL}" label before this gate is switched to enforce\n`,
    )
    return 0
  }
  return 1
}


export const APPROVALS_PATH = 'docs/code-governance/test-approvals.yaml'

/**
 * A recorded test approval. The record is the durable form of the label: it can
 * carry a date, a scope and the tests that were agreed.
 *
 * The gate proves **ordering**, not judgement. A record committed before the first
 * code commit is evidence that the tests were written down first; it is not proof
 * that a human read them. Review still owns that question.
 */
export interface ApprovalRecord {
  readonly id: string
  readonly task: string
  readonly approved_at: string
  readonly approved_by: string
  readonly scope: readonly string[]
  readonly tests: readonly string[]
}

export type ApprovalsParse =
  | { readonly ok: true; readonly approvals: readonly ApprovalRecord[] }
  | { readonly ok: false; readonly errors: readonly string[] }

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

export function parseApprovals(text: string): ApprovalsParse {
  const document = parseDocument(text, { uniqueKeys: true })
  if (document.errors.length > 0) {
    return { ok: false, errors: document.errors.map((error) => error.message) }
  }
  const root = document.toJS() as { approvals?: unknown } | null
  const approvals = root?.approvals
  if (!Array.isArray(approvals) || approvals.length === 0) {
    return { ok: false, errors: [`${APPROVALS_PATH} has no non-empty "approvals" list`] }
  }
  const errors: string[] = []
  const records: ApprovalRecord[] = []
  approvals.forEach((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`approval ${index} is not a mapping`)
      return
    }
    const record = entry as Record<string, unknown>
    const text = (field: string): string | null =>
      typeof record[field] === 'string' && (record[field] as string).trim().length > 0
        ? (record[field] as string).trim()
        : null
    const id = text('id')
    const task = text('task')
    const approvedAt = text('approved_at')
    const approvedBy = text('approved_by')
    const scope = Array.isArray(record.scope)
      ? record.scope.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : null
    const tests = Array.isArray(record.tests)
      ? record.tests.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : null
    const label = id ?? `approval ${index}`
    if (id === null) errors.push(`${label} has no non-empty "id"`)
    if (task === null) errors.push(`${label} has no non-empty "task"`)
    if (approvedAt === null || !ISO_INSTANT.test(approvedAt)) {
      errors.push(`${label} has no ISO-8601 "approved_at"`)
    }
    if (approvedBy === null) errors.push(`${label} has no non-empty "approved_by"`)
    if (scope === null || scope.length === 0) errors.push(`${label} has no non-empty "scope"`)
    if (tests === null || tests.length === 0) errors.push(`${label} has no non-empty "tests"`)
    if (
      id !== null &&
      task !== null &&
      approvedAt !== null &&
      ISO_INSTANT.test(approvedAt) &&
      approvedBy !== null &&
      scope !== null &&
      scope.length > 0 &&
      tests !== null &&
      tests.length > 0
    ) {
      records.push({ id, task, approved_at: approvedAt, approved_by: approvedBy, scope, tests })
    }
  })
  return errors.length > 0 ? { ok: false, errors } : { ok: true, approvals: records }
}

export interface ApprovalEvidenceInput {
  readonly isPullRequest: boolean
  readonly changedFiles: readonly string[]
  /** `null` when the record file is missing or unparsable. */
  readonly approvals: readonly ApprovalRecord[] | null
  /** First commit in the diff range touching the approvals file, or `null` if it predates it. */
  readonly recordFirstTouch: string | null
  /** First commit in the diff range touching code or prompts. */
  readonly firstCodeCommit: string | null
  readonly firstCodeCommitTime: string | null
  readonly isAncestor: (ancestor: string, descendant: string) => boolean | null
  readonly fileExists: (relative: string) => boolean
}

function covers(scope: string, file: string): boolean {
  return scope.endsWith('/') ? file.startsWith(scope) : file === scope
}

/**
 * Evidence mode: a recorded approval must cover every changed code path, name
 * tests that exist, and have been committed **before** the first code commit.
 *
 * A missing base, a missing history answer or an unreadable record is a violation,
 * never a pass. The one thing it cannot check is whether a human actually approved;
 * that stays a review obligation and is stated in the ADR.
 */
export function collectApprovalEvidenceViolations(input: ApprovalEvidenceInput): string[] {
  if (!input.isPullRequest) return []
  const codeFiles = input.changedFiles.filter((file) =>
    CODE_OR_PROMPT_PREFIXES.some((prefix) => file.startsWith(prefix)),
  )
  if (codeFiles.length === 0) return []

  const violations: string[] = []
  if (input.approvals === null) {
    return [
      `this pull request changes code or prompts but ${APPROVALS_PATH} is missing or unreadable (gate G1)`,
    ]
  }

  const covering = new Map<string, ApprovalRecord>()
  for (const file of codeFiles) {
    const match = input.approvals.find((approval) =>
      approval.scope.some((scope) => covers(scope, file)),
    )
    if (match === undefined) {
      violations.push(`no recorded approval covers ${file} (gate G1)`)
      continue
    }
    covering.set(file, match)
  }

  for (const [file, approval] of covering) {
    for (const test of approval.tests) {
      if (!input.fileExists(test)) {
        violations.push(`approval ${approval.id} names ${test}, which does not exist (gate G1)`)
      }
    }
    void file
  }

  if (input.recordFirstTouch !== null) {
    if (input.firstCodeCommit === null) {
      violations.push(
        'code changed but the first code commit could not be determined; G1 is not verified',
      )
    } else {
      const ordered = input.isAncestor(input.recordFirstTouch, input.firstCodeCommit)
      if (ordered === null) {
        violations.push('commit history is unavailable; G1 is not verified')
      } else if (!ordered) {
        violations.push(
          `the approval record was committed after implementation began: ${input.recordFirstTouch} is not an ancestor of ${input.firstCodeCommit} (gate G1)`,
        )
      }
    }
  }

  if (input.firstCodeCommitTime !== null) {
    for (const approval of new Set(covering.values())) {
      const approved = Date.parse(approval.approved_at)
      const first = Date.parse(input.firstCodeCommitTime)
      if (Number.isFinite(approved) && Number.isFinite(first) && approved > first) {
        violations.push(
          `approval ${approval.id} is dated ${approval.approved_at}, after the first code commit (${input.firstCodeCommitTime}) (gate G1)`,
        )
      }
    }
  }

  return violations
}

function main(argv: readonly string[]): number {
  const requested = argv[0]
  const mode: GateMode = requested === 'enforce' ? 'enforce' : 'advise'
  if (requested === 'evidence') {
    const labelMode = collectTestApprovalViolations({
      isPullRequest: process.env.GITHUB_EVENT_NAME === 'pull_request',
      labels: [],
      changedFiles: [],
    })
    void labelMode
    const changedFiles = argv.length > 1 ? argv.slice(1) : readChangedFiles()
    const base = process.env.GATE_BASE_SHA ?? mergeBase('origin/main')
    const approvalsText = existsSync(APPROVALS_PATH) ? readFileSync(APPROVALS_PATH, 'utf8') : null
    const parsed = approvalsText === null ? null : parseApprovals(approvalsText)
    const violations: string[] = []
    if (parsed !== null && !parsed.ok) {
      violations.push(...parsed.errors)
    }
    const firstCode = firstCommitTouching(['src', 'prompts'], base)
    violations.push(
      ...collectApprovalEvidenceViolations({
        isPullRequest: process.env.GITHUB_EVENT_NAME === 'pull_request',
        changedFiles,
        approvals: parsed !== null && parsed.ok ? parsed.approvals : null,
        recordFirstTouch: firstCommitTouching([APPROVALS_PATH], base),
        firstCodeCommit: firstCode,
        firstCodeCommitTime: firstCode === null ? null : commitTime(firstCode),
        isAncestor: isAncestorOf,
        fileExists: (relative) => existsSync(relative),
      }),
    )
    if (violations.length === 0) {
      process.stdout.write('G1: recorded test approvals cover this change and predate implementation\n')
      return 0
    }
    for (const violation of violations) process.stderr.write(`G1 (evidence): ${violation}\n`)
    return 1
  }
  const labels = (process.env.PR_LABELS ?? '')
    .split(',')
    .map((label) => label.trim())
    .filter((label) => label.length > 0)
  // Explicit arguments win; otherwise read the list CI wrote to CHANGED_FILES_FILE,
  // so a filename containing a space cannot be split by the shell.
  const fromArgv = argv.slice(1)
  return runCli(
    {
      isPullRequest: process.env.GITHUB_EVENT_NAME === 'pull_request',
      labels,
      changedFiles: fromArgv.length > 0 ? fromArgv : readChangedFiles(),
    },
    mode,
  )
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2))
}
