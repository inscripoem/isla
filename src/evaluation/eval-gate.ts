import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { EVALUATION_TABLE_PATH } from './artifacts'
import { writeFindings, type GateFinding } from './gate-record'
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
 * Findings carry the policy that owns the response (POL-G4-0x); the CLI writes one
 * failure record per policy so an operator reads a decision, not a log.
 */

const GATE_BASELINE_PATH = 'docs/code-governance/gate-baseline.yaml'

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

/** One expiry-dated exemption for a reviewed prose-claim exception. */
export interface ClaimExemption {
  /** SHA-256 of `path|trimmed line`. */
  readonly key: string
  readonly expires: string
}

export interface EvalGateOptions {
  readonly claimExemptions?: readonly ClaimExemption[]
  /** Today as YYYY-MM-DD; an expired exemption fails instead of renewing itself. */
  readonly today?: string
}

/** Stable identity for one claim line, so an edited sentence loses its exemption. */
export function claimLineKey(path: string, line: string): string {
  return createHash('sha256').update(`${path}|${line.trim()}`).digest('hex')
}

/** Claims recorded in the evaluation table must carry a value and a conditions reference. */
function claimTableFindings(table: string): GateFinding[] {
  const findings: GateFinding[] = []
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
        findings.push({
          policy: 'POL-G4-02',
          trigger: 'claim-value-missing',
          message: `claim "${claim}" (row ${index + 1}) records no value`,
          evidence: { claim, missing: 'value' },
        })
      }
      if ((row[conditionsColumn] ?? '').trim().length === 0) {
        findings.push({
          policy: 'POL-G4-02',
          trigger: 'claim-conditions-missing',
          message: `claim "${claim}" (row ${index + 1}) names no fixed conditions`,
          evidence: { claim, missing: 'conditions' },
        })
      }
    })
  }
  return findings
}

/**
 * A measured claim in prose without a table is exactly the case G4 exists to stop:
 * the number is asserted, the conditions are absent, and nothing can check it.
 * Targets and requirements are not claims, so they pass.
 */
function proseClaimFindings(
  documents: readonly ClaimDocument[],
  hasTable: boolean,
  options: EvalGateOptions,
): GateFinding[] {
  const findings: GateFinding[] = []
  const today = options.today ?? new Date().toISOString().slice(0, 10)
  for (const document of documents) {
    document.text.split('\n').forEach((line, index) => {
      if (!CLAIM_MARKER.test(line) || !/\d/.test(line)) return
      if (TARGET_WORD.test(line)) return
      const exemption = options.claimExemptions?.find(
        (entry) => entry.key === claimLineKey(document.path, line),
      )
      if (exemption !== undefined) {
        if (exemption.expires >= today) return
        findings.push({
          policy: 'POL-G4-04',
          trigger: 'exemption-expired',
          message: `${document.path} claim exemption expired on ${exemption.expires}; re-review the sentence`,
          evidence: { document: document.path, line: index + 1, expires: exemption.expires },
        })
        return
      }
      if (!hasTable) {
        findings.push({
          policy: 'POL-G4-01',
          trigger: 'claim-without-table',
          message: `${document.path} states a measured result ("${line.trim().slice(0, 80)}") but ${EVALUATION_TABLE_PATH} does not exist`,
          evidence: {
            document: document.path,
            line: index + 1,
            claim: line.trim().slice(0, 200),
            missing: 'table',
          },
        })
      }
    })
  }
  return findings
}

/**
 * Check an evaluation table's text, or `null` when there is none. Absence is not
 * a violation — it is a *not run*, which the caller must report as such.
 */
export function collectEvalGateFindings(
  table: string | null,
  documents: readonly ClaimDocument[] = [],
  options: EvalGateOptions = {},
): { readonly ran: boolean; readonly findings: readonly GateFinding[] } {
  const claims = proseClaimFindings(documents, table !== null, options)
  if (table === null) return { ran: claims.length > 0, findings: claims }
  const haystack = table.toLowerCase()
  const findings: GateFinding[] = [
    ...REQUIRED_CONDITIONS.filter((condition) => !haystack.includes(condition)).map(
      (condition): GateFinding => ({
        policy: 'POL-G4-01',
        trigger: 'condition-missing',
        message: `${EVALUATION_TABLE_PATH} does not record the ${condition} condition required by NFR-01 (gate G4)`,
        evidence: {
          document: EVALUATION_TABLE_PATH,
          line: null,
          claim: condition,
          missing: 'condition',
        },
      }),
    ),
    ...claimTableFindings(table),
    ...claims,
  ]
  return { ran: true, findings }
}

/** String view for callers that only need messages (existing tests and logs). */
export function collectEvalGateViolations(
  table: string | null,
  documents: readonly ClaimDocument[] = [],
  options: EvalGateOptions = {},
): EvalGateResult {
  const result = collectEvalGateFindings(table, documents, options)
  return { ran: result.ran, violations: result.findings.map((finding) => finding.message) }
}

function readClaimExemptions(): ClaimExemption[] {
  if (!existsSync(GATE_BASELINE_PATH)) return []
  try {
    const parsed = parseYaml(readFileSync(GATE_BASELINE_PATH, 'utf8')) as {
      claims?: unknown
    } | null
    const claims = parsed?.claims
    if (!Array.isArray(claims)) return []
    return claims.filter(
      (entry): entry is ClaimExemption =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof (entry as ClaimExemption).key === 'string' &&
        typeof (entry as ClaimExemption).expires === 'string',
    )
  } catch {
    return []
  }
}

function runCli(
  table: string | null,
  documents: readonly ClaimDocument[] = [],
  options: EvalGateOptions = {},
  context: { commit?: string | null; base?: string | null } = {},
): number {
  const result = collectEvalGateFindings(table, documents, options)
  if (!result.ran) {
    process.stdout.write('G4: not run — no evaluation set or provider access (this is not a pass)\n')
    return 0
  }
  if (result.findings.length === 0) {
    process.stdout.write('G4: evaluation table records the fixed conditions NFR-01 requires\n')
    return 0
  }
  for (const finding of result.findings) process.stderr.write(`G4: ${finding.message}\n`)
  try {
    for (const path of writeFindings(result.findings, context)) {
      process.stdout.write(`G4: failure record ${path}\n`)
    }
  } catch (error) {
    process.stderr.write(
      `G4: could not write the failure record: ${error instanceof Error ? error.message : String(error)}\n`,
    )
  }
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
  const claimExemptions = readClaimExemptions()
  process.exitCode = runCli(table, documents, { claimExemptions })
}
