import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { readChangedFiles } from './changed-files'
import { readRestorationContext } from './frozen-restoration'
import { writeFindings, type GateFinding } from './gate-record'
import {
  collectTraceViolations,
  nodeTraceFs,
  type AdrBaselineRow,
  type TraceViolation,
} from './trace-fitness'

/**
 * M6 / R3 — trace gate failure records (ADR-006, INV-13).
 *
 * The trace gate runs as a test (`pnpm test:trace`), which reports a violation as a
 * failed assertion. That is enough to block a merge and not enough to act on: the
 * operator still has to reconstruct which policy owns the failure. This entry point
 * re-runs the same pure collector and writes the records, so the test and the
 * record can never disagree about what was found.
 */

/** Which policy owns a trace violation code. Unknown codes fail closed under TR-01. */
export function policyForTraceCode(code: string): string {
  if (code.startsWith('trace-adr')) return 'POL-TR-02'
  if (code === 'trace-row-orphan' || code === 'trace-test-unresolved') return 'POL-TR-03'
  return 'POL-TR-01'
}

export function traceFindings(violations: readonly TraceViolation[]): GateFinding[] {
  return violations.map((violation) => {
    const policy = policyForTraceCode(violation.code)
    const evidence =
      policy === 'POL-TR-02'
        ? { row_key: null, cell: violation.message }
        : policy === 'POL-TR-03'
          ? { code: violation.code, detail: violation.message }
          : { row_key: null, code: violation.code, detail: violation.message }
    return { policy, trigger: violation.code, message: violation.message, evidence }
  })
}

/** The committed ADR-cell exemptions, so a known pending row stays exempt. */
function readAdrBaseline(): AdrBaselineRow[] {
  const path = 'docs/code-governance/gate-baseline.yaml'
  if (!existsSync(path)) return []
  try {
    const parsed = parseYaml(readFileSync(path, 'utf8')) as { traceRows?: AdrBaselineRow[] } | null
    return parsed?.traceRows ?? []
  } catch {
    return []
  }
}

function main(): number {
  const violations = collectTraceViolations(nodeTraceFs(process.cwd()), {
    changedFiles: readChangedFiles(),
    restoration: readRestorationContext() ?? undefined,
    adrBaseline: readAdrBaseline(),
    today: new Date().toISOString().slice(0, 10),
  })
  if (violations.length === 0) {
    process.stdout.write('trace: no violations; no failure record\n')
    return 0
  }
  for (const violation of violations) process.stderr.write(`trace: ${violation.code}: ${violation.message}\n`)
  try {
    for (const path of writeFindings(traceFindings(violations))) {
      process.stdout.write(`trace: failure record ${path}\n`)
    }
  } catch (error) {
    process.stderr.write(
      `trace: could not write the failure record: ${error instanceof Error ? error.message : String(error)}\n`,
    )
  }
  return 1
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) process.exitCode = main()
