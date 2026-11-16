import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * M6 / R3 — gate failure records (ADR-006).
 *
 * A gate verdict is only useful if the decision after it is already made. This
 * module is the machine-readable half of that decision: one record per failure,
 * naming the policy that owns the response, the decision, the action, and the
 * evidence an operator needs to act without reconstructing the reasoning.
 *
 * The policy table lives here once (`POLICY_SPECS`) and is rendered into
 * `docs/architecture/runtime-policy-catalog.md`; an agreement test keeps the two
 * in step. Every policy declares its evidence fields here too, so a gate cannot
 * promise seven fields and emit six without a test turning red.
 */

export type GateName = 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'TRACE' | 'PIPE'

export type GateDecision = 'fail-closed' | 'three-state' | 'fail-open-with-debt'

export interface PolicySpec {
  readonly gate: GateName
  readonly decision: GateDecision
  readonly action: string
  readonly fields: readonly string[]
}

/** One source for policy id, decision, action and the evidence keys it promises. */
export const POLICY_SPECS: Readonly<Record<string, PolicySpec>> = {
  'POL-PIPE-01': {
    gate: 'PIPE',
    decision: 'fail-closed',
    action:
      'report every gate that did not run as not-verified, never as pass; record the outcome map',
    fields: ['gate_outcomes'],
  },
  'POL-PIPE-02': {
    gate: 'PIPE',
    decision: 'fail-closed',
    action: 'record the red push run on main; a human reverts or fixes forward within one working day',
    fields: ['run', 'failed_gates'],
  },
  'POL-G1-01': {
    gate: 'G1',
    decision: 'fail-closed',
    action: 'block the merge; never create, edit or backdate an approval record',
    fields: ['files', 'approval_id', 'record_commit', 'first_code_commit', 'approved_at'],
  },
  'POL-G1-02': {
    gate: 'G1',
    decision: 'fail-closed',
    action: 'block the merge; reorder the commits rather than rewriting history to fake the order',
    fields: ['approval_id', 'approved_at', 'first_code_commit'],
  },
  'POL-G1-03': {
    gate: 'G1',
    decision: 'fail-closed',
    action: 'block the merge; unknown history is not approval, so fetch the history and re-run',
    fields: ['reason'],
  },
  'POL-G4-01': {
    gate: 'G4',
    decision: 'fail-closed',
    action: 'block the merge; mark the number unverified and never substitute zero or a guess',
    fields: ['document', 'line', 'claim', 'missing'],
  },
  'POL-G4-02': {
    gate: 'G4',
    decision: 'fail-closed',
    action: 'block the merge until the claim row carries a value and its fixed conditions',
    fields: ['claim', 'missing'],
  },
  'POL-G4-03': {
    gate: 'G4',
    decision: 'three-state',
    action: 'pass the step, record not-run, and refuse any numeric claim until a table exists',
    fields: ['reason'],
  },
  'POL-G4-04': {
    gate: 'G4',
    decision: 'fail-closed',
    action: 'block the merge; an expired exemption is debt that must be re-reviewed, not renewed silently',
    fields: ['document', 'line', 'expires'],
  },
  'POL-G6-01': {
    gate: 'G6',
    decision: 'fail-closed',
    action: 'block the merge; never append an entry on the author\'s behalf',
    fields: ['changed_files', 'log_changed'],
  },
  'POL-G6-02': {
    gate: 'G6',
    decision: 'fail-closed',
    action: 'block the merge; the entry owner corrects the reference, the gate never rewrites it',
    fields: ['entry', 'field', 'value'],
  },
  'POL-G6-03': {
    gate: 'G6',
    decision: 'fail-closed',
    action: 'block the merge; an unreadable register is a failure, never an empty register',
    fields: ['register'],
  },
  'POL-G6-04': {
    gate: 'G6',
    decision: 'fail-closed',
    action: 'block the merge; the exemption expired and must be re-reviewed or removed',
    fields: ['value', 'expires'],
  },
  'POL-TR-01': {
    gate: 'TRACE',
    decision: 'fail-closed',
    action: 'block the merge; the row owner repairs the code, test or citation the row names',
    fields: ['row_key', 'code', 'detail'],
  },
  'POL-TR-02': {
    gate: 'TRACE',
    decision: 'fail-closed',
    action: 'block the merge; name an allocated ADR or record an explicit em dash',
    fields: ['row_key', 'cell'],
  },
  'POL-TR-03': {
    gate: 'TRACE',
    decision: 'fail-closed',
    action: 'block the merge; a row the parser cannot see is not evidence, so fix the table shape',
    fields: ['code', 'detail'],
  },
  'POL-G2-01': {
    gate: 'G2',
    decision: 'fail-closed',
    action: 'block the merge; no auto-fix and no suppression of the diagnostic',
    fields: ['step', 'outcome'],
  },
  'POL-G3-01': {
    gate: 'G3',
    decision: 'fail-closed',
    action: 'block the merge; never regenerate the registry to make the schema pass',
    fields: ['step', 'outcome'],
  },
  'POL-G5-01': {
    gate: 'G5',
    decision: 'fail-closed',
    action: 'block the merge; never skip, delete or weaken a failing test',
    fields: ['step', 'outcome'],
  },
  'POL-TR-04': {
    gate: 'TRACE',
    decision: 'fail-open-with-debt',
    action: 'pass with an advisory count; the citation stays unverified until migrated to file::title',
    fields: ['detail'],
  },
} as const

export interface GateRecord {
  readonly policy: string
  readonly gate: GateName
  readonly trigger: string
  readonly decision: GateDecision
  readonly action: string
  readonly evidence: Readonly<Record<string, unknown>>
  readonly commit: string | null
  readonly base: string | null
  readonly run: string | null
  readonly recorded_at: string
  readonly inputs: {
    readonly approvals_hash: string | null
    readonly baseline_hash: string | null
  }
}

export interface GateRecordInput {
  readonly policy: string
  readonly trigger: string
  readonly evidence: Readonly<Record<string, unknown>>
  readonly commit?: string | null
  readonly base?: string | null
  readonly run?: string | null
  readonly recordedAt?: string
  readonly inputs?: GateRecord['inputs']
}

/** Field names must match the policy exactly; a mismatch is a builder defect, not a pass. */
export function buildGateRecord(input: GateRecordInput): GateRecord {
  const spec = POLICY_SPECS[input.policy]
  if (spec === undefined) throw new Error(`no policy spec for ${input.policy}`)
  const declared = [...spec.fields].sort()
  const emitted = Object.keys(input.evidence).sort()
  if (declared.length !== emitted.length || declared.some((field, i) => field !== emitted[i])) {
    throw new Error(
      `${input.policy} declares [${declared.join(', ')}] but the record emits [${emitted.join(', ')}]`,
    )
  }
  return {
    policy: input.policy,
    gate: spec.gate,
    trigger: input.trigger,
    decision: spec.decision,
    action: spec.action,
    evidence: input.evidence,
    commit: input.commit ?? null,
    base: input.base ?? null,
    run: input.run ?? null,
    recorded_at: input.recordedAt ?? new Date().toISOString(),
    inputs: input.inputs ?? { approvals_hash: null, baseline_hash: null },
  }
}

/** SHA-256 of a file's bytes, or `null` when it does not exist. */
export function fileHash(path: string): string | null {
  if (!existsSync(path)) return null
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Write one record under `.cache/gate-failures/`, which CI uploads. The filename
 * carries the policy, the commit and the timestamp so two runs never overwrite
 * each other; a repeated failure leaves both records.
 */
export function writeGateRecord(record: GateRecord, dir = '.cache/gate-failures'): string {
  mkdirSync(dir, { recursive: true })
  const commit = (record.commit ?? 'nocommit').slice(0, 12)
  const stamp = record.recorded_at.replace(/[:.]/g, '-')
  const path = join(dir, `${record.policy}-${commit}-${stamp}.json`)
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`)
  return path
}

/** POL-PIPE-01: the aggregate step's view of every gate, including the ones that never ran. */
export function gateOutcomesRecord(
  outcomes: Readonly<Record<string, string>>,
  context: { commit?: string | null; base?: string | null; run?: string | null } = {},
): GateRecord {
  return buildGateRecord({
    policy: 'POL-PIPE-01',
    trigger: 'gate-not-run',
    evidence: { gate_outcomes: outcomes },
    ...context,
  })
}

/** A structured violation: the message an operator reads, plus the record it becomes. */
export interface GateFinding {
  readonly policy: string
  readonly trigger: string
  readonly message: string
  readonly evidence: Readonly<Record<string, unknown>>
}

/**
 * One record per policy per run. Repeating the same policy for ten rows would bury
 * the decision in duplicates; the first finding carries the representative evidence
 * and the message names the concrete case.
 */
export function recordsForFindings(
  findings: readonly GateFinding[],
  context: { commit?: string | null; base?: string | null; run?: string | null } = {},
): GateRecord[] {
  const seen = new Set<string>()
  const records: GateRecord[] = []
  for (const finding of findings) {
    if (seen.has(finding.policy)) continue
    seen.add(finding.policy)
    records.push(
      buildGateRecord({
        policy: finding.policy,
        trigger: finding.trigger,
        evidence: finding.evidence,
        ...context,
      }),
    )
  }
  return records
}

/** Write every record and return the paths, so the caller can print them. */
export function writeFindings(
  findings: readonly GateFinding[],
  context: { commit?: string | null; base?: string | null; run?: string | null } = {},
  dir = '.cache/gate-failures',
): string[] {
  return recordsForFindings(findings, context).map((record) => writeGateRecord(record, dir))
}
