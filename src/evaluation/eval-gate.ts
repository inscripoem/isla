import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { EVALUATION_TABLE_PATH } from './artifacts'
import { columnIndex, parseTables } from './markdown'

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
  /** Whether there was anything to check (a table or a claim that needs one). */
  readonly ran: boolean
  readonly violations: readonly string[]
}

/** A measured-performance claim, as opposed to a target or requirement. */
const CLAIM_MARKER = /\b(p95|p99|recall@|precision@|accuracy|tokens per|cost per)\b/i
/** Wording that marks a number as an intended threshold, not a measured result. */
const TARGET_WORD = /\b(target|threshold|requirement|goal|budget|must|should)\b/i
const CLAIM_DOCUMENTS = ['README.md', 'Report.md'] as const

export interface ClaimDocument {
  readonly path: string
  readonly text: string
}

/** Claims recorded in the evaluation table must carry a value and a conditions reference. */
function claimTableViolations(table: string): string[] {
  const violations: string[] = []
  for (const candidate of parseTables(table)) {
    const claimColumn = columnIndex(candidate.header, 'Claim')
    if (claimColumn < 0) continue
    const valueColumn = columnIndex(candidate.header, 'Value')
    const conditionsColumn = columnIndex(candidate.header, 'Conditions')
    if (valueColumn < 0 || conditionsColumn < 0) continue
    candidate.rows.forEach((row, index) => {
      const claim = (row[claimColumn] ?? '').trim()
      if (claim.length === 0) return
      if ((row[valueColumn] ?? '').trim().length === 0) {
        violations.push(`claim "${claim}" (row ${index + 1}) records no value`)
      }
      if ((row[conditionsColumn] ?? '').trim().length === 0) {
        violations.push(`claim "${claim}" (row ${index + 1}) names no fixed conditions`)
      }
    })
  }
  return violations
}

/**
 * A measured claim in prose without a table is exactly the case G4 exists to stop:
 * the number is asserted, the conditions are absent, and nothing can check it.
 * Targets and requirements are not claims, so they pass.
 */
function proseClaimViolations(documents: readonly ClaimDocument[], hasTable: boolean): string[] {
  const violations: string[] = []
  for (const document of documents) {
    for (const line of document.text.split('\n')) {
      if (!CLAIM_MARKER.test(line) || !/\d/.test(line)) continue
      if (TARGET_WORD.test(line)) continue
      if (!hasTable) {
        violations.push(
          `${document.path} states a measured result ("${line.trim().slice(0, 80)}") but ${EVALUATION_TABLE_PATH} does not exist`,
        )
      }
    }
  }
  return violations
}

/**
 * Check an evaluation table's text, or `null` when there is none. Absence is not
 * a violation — it is a *not run*, which the caller must report as such.
 */
export function collectEvalGateViolations(
  table: string | null,
  documents: readonly ClaimDocument[] = [],
): EvalGateResult {
  const claims = proseClaimViolations(documents, table !== null)
  if (table === null) return { ran: claims.length > 0, violations: claims }
  const haystack = table.toLowerCase()
  const violations = [
    ...REQUIRED_CONDITIONS.filter((condition) => !haystack.includes(condition)).map(
      (condition) =>
        `${EVALUATION_TABLE_PATH} does not record the ${condition} condition required by NFR-01 (gate G4)`,
    ),
    ...claimTableViolations(table),
    ...claims,
  ]
  return { ran: true, violations }
}

function runCli(table: string | null, documents: readonly ClaimDocument[] = []): number {
  const result = collectEvalGateViolations(table, documents)
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
  const documents = CLAIM_DOCUMENTS.filter((path) => existsSync(path)).map((path) => ({
    path,
    text: readFileSync(path, 'utf8'),
  }))
  process.exitCode = runCli(table, documents)
}
