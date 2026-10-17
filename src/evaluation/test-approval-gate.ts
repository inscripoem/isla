import { pathToFileURL } from 'node:url'
import { readChangedFiles } from './changed-files'

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

function main(argv: readonly string[]): number {
  const mode: GateMode = argv[0] === 'enforce' ? 'enforce' : 'advise'
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
