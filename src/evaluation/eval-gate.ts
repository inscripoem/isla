import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { EVALUATION_TABLE_PATH } from './artifacts'

/**
 * M6 / R3 — gate G4: semantic evaluation (ADR-006).
 *
 * G4 needs a versioned evaluation set and provider access. Neither exists yet
 * (DEBT-01), so the gate is **honest rather than absent**: with no evaluation
 * artifact it reports **not run** — explicitly *not* a pass — and it fails when an
 * evaluation table is present but does not record the fixed conditions NFR-01
 * requires. A table that cannot say what it measured cannot support a quality or
 * latency claim, and a gate that silently disappears is worse than one that says
 * it did not run.
 *
 * The pure function is exported so tests can prove every outcome without an
 * evaluation set, and so the gate can be wired to a real evaluation report when
 * M6-02 produces one.
 */

/**
 * The fixed conditions NFR-01 requires an evaluation report to document, matched
 * case-insensitively in the table text: hardware, provider(s), workload, sample
 * size and cold/warm state.
 */
const REQUIRED_CONDITIONS = ['hardware', 'provider', 'workload', 'sample', 'cold'] as const

export interface EvalGateResult {
  /** Whether an evaluation table was present and therefore checked. */
  readonly ran: boolean
  readonly violations: readonly string[]
}

/**
 * Check an evaluation table's text, or `null` when there is none. Absence is not
 * a violation — it is a *not run*, which the caller must report as such.
 */
export function collectEvalGateViolations(table: string | null): EvalGateResult {
  if (table === null) return { ran: false, violations: [] }
  const haystack = table.toLowerCase()
  return {
    ran: true,
    violations: REQUIRED_CONDITIONS.filter((condition) => !haystack.includes(condition)).map(
      (condition) =>
        `${EVALUATION_TABLE_PATH} does not record the ${condition} condition required by NFR-01 (gate G4)`,
    ),
  }
}

function runCli(table: string | null): number {
  const result = collectEvalGateViolations(table)
  if (!result.ran) {
    process.stdout.write(
      'G4: not run — no evaluation set or provider access (this is not a pass)\n',
    )
    return 0
  }
  if (result.violations.length === 0) {
    process.stdout.write('G4: evaluation table records the fixed conditions NFR-01 requires\n')
    return 0
  }
  for (const violation of result.violations) process.stderr.write(`G4: ${violation}\n`)
  return 1
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const table = existsSync(EVALUATION_TABLE_PATH) ? readFileSync(EVALUATION_TABLE_PATH, 'utf8') : null
  process.exitCode = runCli(table)
}
