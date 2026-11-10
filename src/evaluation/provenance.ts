import { createHash } from 'node:crypto'
import type { AttemptRecord } from './metrics'

/**
 * M6-02 / ADR-008 — prepared-input provenance companion (schema version 1).
 *
 * Shape reading. The proposal lists `caseId`, `variantId`, `attempt`, `inputs`,
 * `recordSetRevision` and `correlation` as flat fields, and also requires
 * "one object per run" whose `(caseId, variantId, attempt)` set equals the run's
 * record set. Those two statements are only both true if the document root holds
 * the run binding and an `attempts` array of per-attempt entries:
 *
 *   { provenanceVersion: 1, runId, runDigest,
 *     attempts: [{ caseId, variantId, attempt, inputs, recordSetRevision, correlation }] }
 *
 * The flat field table therefore describes an entry, not the root. This reading
 * is pending explicit confirmation. The report command consumes the companion
 * through `--provenance` and refuses a mismatch before any table is written, so
 * a wrong reading fails closed instead of publishing a partial join.
 *
 * The parser is pure and strict: unknown keys are refused, the digest is bound to
 * the exact run bytes, the occurrence-key set must equal the run's record set,
 * duplicate keys are refused, and an input list whose order cannot be established
 * is refused. Expected refusals are data (`{ ok: false, violations }`).
 */

export const PROVENANCE_VERSION = 1

export const INPUT_STATUSES = [
  'accepted',
  'duplicate',
  'rejected',
  'not-submitted',
  'no-acknowledgement',
] as const
export type InputStatus = (typeof INPUT_STATUSES)[number]

export const CORRELATIONS = ['exact', 'missing', 'ambiguous'] as const
export type Correlation = (typeof CORRELATIONS)[number]

export interface ProvenanceInputEntry {
  /**
   * Fixture identity `(corpusVersion, casesSha256, caseId, candidate.eventId)`.
   * `null` means **not-yet-observable** (ADR-008 D5): the companion records the
   * absence rather than inventing an id, and a scored result would be `unscored`
   * with reason `missing-input-identity`.
   */
  readonly inputId: string | null
  readonly sourceId: string
  readonly requestMessageId: string | null
  readonly eventId: string | null
  readonly status: InputStatus
}

export interface ProvenanceAttempt {
  readonly caseId: string
  readonly variantId: string
  readonly attempt: number
  readonly inputs: readonly ProvenanceInputEntry[]
  readonly recordSetRevision: string | null
  readonly correlation: Correlation
}

export interface ProvenanceNotRunEntry {
  readonly caseId: string
  readonly variantId: string
  /** 1-based occurrence among the run's not-run entries for this pair. */
  readonly occurrence: number
  readonly inputs: readonly ProvenanceInputEntry[]
}

export interface ProvenanceCompanionV1 {
  readonly provenanceVersion: typeof PROVENANCE_VERSION
  readonly runId: string
  readonly runDigest: string
  readonly attempts: readonly ProvenanceAttempt[]
  /** Observed inputs for cases the run did not execute (ADR-008 D4). */
  readonly notRun: readonly ProvenanceNotRunEntry[]
}

export interface ProvenanceRun {
  readonly runId: string
  readonly records: readonly AttemptRecord[]
  /** The run's not-run cases, so observations can be bound to them. */
  readonly notRun?: readonly { readonly caseId: string; readonly variantId: string; readonly reason: string }[]
}

export type ProvenanceParse =
  | { readonly ok: true; readonly companion: ProvenanceCompanionV1 }
  | { readonly ok: false; readonly violations: readonly string[] }

const ROOT_KEYS = ['provenanceVersion', 'runId', 'runDigest', 'attempts', 'notRun'] as const
const ROOT_REQUIRED_KEYS = ['provenanceVersion', 'runId', 'runDigest', 'attempts'] as const
const NOT_RUN_KEYS = ['caseId', 'variantId', 'occurrence', 'inputs'] as const
const NOT_RUN_REQUIRED_KEYS = ['caseId', 'variantId', 'inputs'] as const
const ATTEMPT_KEYS = [
  'caseId',
  'variantId',
  'attempt',
  'inputs',
  'recordSetRevision',
  'correlation',
] as const
const INPUT_KEYS = ['inputId', 'sourceId', 'requestMessageId', 'eventId', 'status'] as const

const DIGEST_PATTERN = /^[0-9a-fA-F]{64}$/
const MAX_INPUTS = 5

type ObjectValue = Record<string, unknown>

function isObject(value: unknown): value is ObjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Recorded value for an input identity M5 has not exported yet (ADR-008 D5). */
export const UNOBSERVABLE_INPUT_ID = 'not-yet-observable'

/**
 * SHA-256 of the exact run artifact bytes.
 *
 * A `Buffer` is hashed as raw bytes; a string is hashed as UTF-8. The command
 * passes the Buffer it read, so an invalid byte sequence cannot collapse to the
 * same decoded string as another artifact.
 */
export function provenanceRunDigest(runBytes: string | Buffer): string {
  return createHash('sha256').update(runBytes).digest('hex')
}

/**
 * Occurrence key per record: `(caseId, variantId, attempt)` where `attempt` is the
 * 1-based occurrence of that `(caseId, variantId)` in the run file. Positional, so
 * the file order is part of the key.
 */
export interface OccurrenceKeyParts {
  readonly caseId: string
  readonly variantId: string
  readonly attempt: number
}

/**
 * Unambiguous tuple encoding. JSON escaping makes the `caseId`/`variantId`
 * boundary explicit, so two different pairs can never share a key even if an
 * identifier contains the old NUL delimiter (M5 review, 2026-11-09).
 */
export function buildOccurrenceKey(caseId: string, variantId: string, attempt: number): string {
  return JSON.stringify([caseId, variantId, attempt])
}

/** The single parser for those keys; `null` for a malformed key. */
export function parseOccurrenceKey(key: string): OccurrenceKeyParts | null {
  let value: unknown
  try {
    value = JSON.parse(key)
  } catch {
    return null
  }
  if (!Array.isArray(value) || value.length !== 3) return null
  const [caseId, variantId, attempt] = value
  if (typeof caseId !== 'string' || caseId.length === 0) return null
  if (typeof variantId !== 'string' || variantId.length === 0) return null
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1) return null
  return { caseId, variantId, attempt }
}

export function runOccurrenceKeys(
  records: readonly { caseId: string; variantId: string }[],
): string[] {
  const seen = new Map<string, number>()
  return records.map((record) => {
    const base = JSON.stringify([record.caseId, record.variantId])
    const attempt = (seen.get(base) ?? 0) + 1
    seen.set(base, attempt)
    return buildOccurrenceKey(record.caseId, record.variantId, attempt)
  })
}

export function companionOccurrenceKey(ref: {
  caseId: string
  variantId: string
  attempt: number
}): string {
  return buildOccurrenceKey(ref.caseId, ref.variantId, ref.attempt)
}

/**
 * Binding rules shared by the parser and the report renderer (ADR-008 D2/D8):
 * the companion names this run, and its occurrence-key set equals the run's
 * record set. Extracted so the renderer cannot accept a companion the parser
 * would refuse for binding reasons.
 */
export function provenanceBindingViolations(
  companion: Pick<ProvenanceCompanionV1, 'runId' | 'attempts' | 'notRun'>,
  run: ProvenanceRun,
): string[] {
  const violations: string[] = []
  if (companion.runId !== run.runId) violations.push('runId does not match the run')

  const runKeys = new Set(runOccurrenceKeys(run.records))
  const companionKeys = new Set(companion.attempts.map(companionOccurrenceKey))
  for (const key of runKeys) {
    if (!companionKeys.has(key)) {
      const parsed = parseOccurrenceKey(key)
      violations.push(
        parsed === null
          ? `the companion is missing an entry for an unparseable occurrence key: ${key}`
          : `the companion is missing an entry for ${parsed.caseId}/${parsed.variantId} attempt ${parsed.attempt}`,
      )
    }
  }
  for (const key of companionKeys) {
    if (!runKeys.has(key)) {
      const parsed = parseOccurrenceKey(key)
      violations.push(
        parsed === null
          ? `the companion has an entry with an unparseable occurrence key: ${key}`
          : `the companion has an entry with no run record: ${parsed.caseId}/${parsed.variantId} attempt ${parsed.attempt}`,
      )
    }
  }

  // ADR-008 D4: observations for a not-run case must name a case the run did not
  // execute. A pair the run executed is an attempt, not a not-run observation.
  // The run's `notRun[].reason` is the single authority; the companion carries
  // observations only. Occurrences make repeated pairs explicit (M5, 2026-11-09).
  const runNotRun = new Map<string, string>()
  const runOccurrences = new Map<string, number>()
  for (const entry of run.notRun ?? []) {
    const pair = JSON.stringify([entry.caseId, entry.variantId])
    const occurrence = (runOccurrences.get(pair) ?? 0) + 1
    runOccurrences.set(pair, occurrence)
    runNotRun.set(JSON.stringify([entry.caseId, entry.variantId, occurrence]), entry.reason)
  }
  for (const entry of companion.notRun) {
    const key = JSON.stringify([entry.caseId, entry.variantId, entry.occurrence])
    if (!runNotRun.has(key)) {
      violations.push(
        `the companion records a not-run observation for ${entry.caseId}/${entry.variantId} occurrence ${entry.occurrence}, which is not a not-run occurrence in the run`,
      )
    }
  }
  return violations
}

function parseInputs(
  value: unknown,
  path: string,
  violations: string[],
): readonly ProvenanceInputEntry[] {
  if (!Array.isArray(value)) {
    violations.push(`${path} must be an array`)
    return []
  }
  if (value.length > MAX_INPUTS) {
    violations.push(`${path} may hold at most ${MAX_INPUTS} entries`)
  }
  const parsed: ProvenanceInputEntry[] = []
  let stopped = false
  value.forEach((entry, index) => {
    const at = `${path}[${index}]`
    if (!isObject(entry)) {
      violations.push(`${at} must be an object`)
      return
    }
    for (const key of Object.keys(entry)) {
      if (!(INPUT_KEYS as readonly string[]).includes(key)) {
        violations.push(`${at}.${key} is not a recognised field`)
      }
    }
    for (const key of INPUT_KEYS) {
      if (!(key in entry)) violations.push(`${at}.${key} is required`)
    }
    // ADR-008 D5: an identity M5 has not exported is recorded as
    // `not-yet-observable`; `null` is the same state in a typed form. Both are
    // preserved as `null`, never replaced by an invented id.
    let inputId: string | null = null
    if (entry.inputId === null || entry.inputId === UNOBSERVABLE_INPUT_ID) {
      inputId = null
    } else if (nonBlank(entry.inputId)) {
      inputId = entry.inputId
    } else {
      violations.push(
        `${at}.inputId must be a non-empty string, null, or "${UNOBSERVABLE_INPUT_ID}"`,
      )
    }
    if (!nonBlank(entry.sourceId)) violations.push(`${at}.sourceId must be a non-empty string`)
    for (const key of ['requestMessageId', 'eventId'] as const) {
      const field = entry[key]
      if (field !== null && !nonBlank(field)) {
        violations.push(`${at}.${key} must be a string or null`)
      }
    }
    if (!(INPUT_STATUSES as readonly string[]).includes(entry.status as string)) {
      violations.push(`${at}.status must be one of ${INPUT_STATUSES.join(', ')}`)
    }
    // Submission order (ADR-008 D3): `rejected`, `no-acknowledgement` and
    // `not-submitted` are terminal. A later *submitted* status would claim an
    // observation the order cannot support, so it is refused; later entries may
    // only be `not-submitted`.
    const status = entry.status as InputStatus
    const terminal =
      status === 'rejected' || status === 'no-acknowledgement' || status === 'not-submitted'
    if (stopped && status !== 'not-submitted') {
      violations.push(`${at}.status follows a terminal input, so the order cannot be established`)
    }
    if (terminal) stopped = true
    parsed.push({
      inputId,
      sourceId: entry.sourceId as string,
      requestMessageId: (entry.requestMessageId ?? null) as string | null,
      eventId: (entry.eventId ?? null) as string | null,
      status: entry.status as InputStatus,
    })
  })
  return parsed
}

/**
 * ADR-008 D4: a not-run case still retains the inputs that were actually
 * submitted and observed. The observations live in the companion, keyed by the
 * run's `(caseId, variantId)` not-run pairs; the run's `RecordedRunV1` shape is
 * unchanged.
 */
function parseNotRun(
  value: unknown,
  violations: string[],
): readonly ProvenanceNotRunEntry[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    violations.push('notRun must be an array')
    return []
  }
  const parsed: ProvenanceNotRunEntry[] = []
  const seen = new Set<string>()
  value.forEach((entry, index) => {
    const at = `notRun[${index}]`
    if (!isObject(entry)) {
      violations.push(`${at} must be an object`)
      return
    }
    for (const key of Object.keys(entry)) {
      if (!(NOT_RUN_KEYS as readonly string[]).includes(key)) {
        violations.push(`${at}.${key} is not a recognised field`)
      }
    }
    for (const key of NOT_RUN_REQUIRED_KEYS) {
      if (!(key in entry)) violations.push(`${at}.${key} is required`)
    }
    if (!nonBlank(entry.caseId)) violations.push(`${at}.caseId must be a non-empty string`)
    if (!nonBlank(entry.variantId)) violations.push(`${at}.variantId must be a non-empty string`)
    const occurrence = entry.occurrence ?? 1
    if (typeof occurrence !== 'number' || !Number.isInteger(occurrence) || occurrence < 1) {
      violations.push(`${at}.occurrence must be an integer ≥ 1`)
    }
    const inputs = parseInputs(entry.inputs, `${at}.inputs`, violations)
    const pair = JSON.stringify([entry.caseId, entry.variantId, occurrence])
    if (seen.has(pair)) violations.push(`${at} repeats the case, variant and occurrence`)
    seen.add(pair)
    parsed.push({
      caseId: entry.caseId as string,
      variantId: entry.variantId as string,
      occurrence: occurrence as number,
      inputs,
    })
  })
  return parsed
}

export function parseProvenance(
  input: unknown,
  run: ProvenanceRun,
  runBytes: string | Buffer,
): ProvenanceParse {
  const violations: string[] = []
  if (!isObject(input)) return { ok: false, violations: ['the companion must be a JSON object'] }

  for (const key of Object.keys(input)) {
    if (!(ROOT_KEYS as readonly string[]).includes(key)) {
      violations.push(`${key} is not a recognised field`)
    }
  }
  for (const key of ROOT_REQUIRED_KEYS) {
    if (!(key in input)) violations.push(`${key} is required`)
  }

  if (input.provenanceVersion !== PROVENANCE_VERSION) {
    violations.push(`provenanceVersion must be ${PROVENANCE_VERSION}`)
  }
  if (!nonBlank(input.runId)) violations.push('runId must be a non-empty string')

  const digest = provenanceRunDigest(runBytes)
  const claimedDigest =
    typeof input.runDigest === 'string' ? input.runDigest.toLowerCase() : null
  if (claimedDigest === null || !DIGEST_PATTERN.test(claimedDigest)) {
    violations.push('runDigest must be a hex SHA-256')
  } else if (claimedDigest !== digest) {
    violations.push('runDigest does not match the exact run artifact')
  }

  if (!Array.isArray(input.attempts)) {
    violations.push('attempts must be an array')
    return { ok: false, violations }
  }

  const parsedAttempts: ProvenanceAttempt[] = []
  const seenKeys = new Set<string>()
  input.attempts.forEach((entry, index) => {
    const at = `attempts[${index}]`
    if (!isObject(entry)) {
      violations.push(`${at} must be an object`)
      return
    }
    for (const key of Object.keys(entry)) {
      if (!(ATTEMPT_KEYS as readonly string[]).includes(key)) {
        violations.push(`${at}.${key} is not a recognised field`)
      }
    }
    for (const key of ATTEMPT_KEYS) {
      if (!(key in entry)) violations.push(`${at}.${key} is required`)
    }
    if (!nonBlank(entry.caseId)) violations.push(`${at}.caseId must be a non-empty string`)
    if (!nonBlank(entry.variantId)) violations.push(`${at}.variantId must be a non-empty string`)
    if (typeof entry.attempt !== 'number' || !Number.isInteger(entry.attempt) || entry.attempt < 1) {
      violations.push(`${at}.attempt must be an integer ≥ 1`)
    }
    if (!(CORRELATIONS as readonly string[]).includes(entry.correlation as string)) {
      violations.push(`${at}.correlation must be one of ${CORRELATIONS.join(', ')}`)
    }
    const revision =
      typeof entry.recordSetRevision === 'string'
        ? entry.recordSetRevision.toLowerCase()
        : entry.recordSetRevision
    if (revision !== null && !(typeof revision === 'string' && DIGEST_PATTERN.test(revision))) {
      violations.push(`${at}.recordSetRevision must be a hex SHA-256 or null`)
    }
    if (entry.correlation === 'exact' && revision === null) {
      violations.push(`${at}.recordSetRevision cannot be null when correlation is exact`)
    }

    const inputs = parseInputs(entry.inputs, `${at}.inputs`, violations)
    if (entry.correlation === 'exact') {
      const submitted = inputs.filter(
        (input) => input.status === 'accepted' || input.status === 'duplicate',
      )
      if (submitted.length === 0) {
        violations.push(`${at}.correlation is exact but no accepted or duplicate input is recorded`)
      } else if (
        submitted.some((input) => input.requestMessageId === null || input.eventId === null)
      ) {
        violations.push(
          `${at}.correlation is exact but an accepted input has no observed acknowledgement; record "missing" instead`,
        )
      }
    }

    const key = buildOccurrenceKey(
      entry.caseId as string,
      entry.variantId as string,
      entry.attempt as number,
    )
    if (seenKeys.has(key)) violations.push(`${at} repeats the occurrence key`)
    seenKeys.add(key)

    parsedAttempts.push({
      caseId: entry.caseId as string,
      variantId: entry.variantId as string,
      attempt: entry.attempt as number,
      inputs,
      recordSetRevision: (revision ?? null) as string | null,
      correlation: entry.correlation as Correlation,
    })
  })

  const parsedNotRun = parseNotRun(input.notRun, violations)

  // The binding rules live in one place so the renderer applies the same ones.
  if (nonBlank(input.runId)) {
    violations.push(
      ...provenanceBindingViolations(
        { runId: input.runId, attempts: parsedAttempts, notRun: parsedNotRun },
        run,
      ),
    )
  }

  if (violations.length > 0) return { ok: false, violations }
  return {
    ok: true,
    companion: {
      provenanceVersion: PROVENANCE_VERSION,
      runId: input.runId as string,
      runDigest: claimedDigest as string,
      attempts: parsedAttempts,
      notRun: parsedNotRun,
    },
  }
}
