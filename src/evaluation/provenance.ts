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

export interface ProvenanceCompanionV1 {
  readonly provenanceVersion: typeof PROVENANCE_VERSION
  readonly runId: string
  readonly runDigest: string
  readonly attempts: readonly ProvenanceAttempt[]
}

export interface ProvenanceRun {
  readonly runId: string
  readonly records: readonly AttemptRecord[]
}

export type ProvenanceParse =
  | { readonly ok: true; readonly companion: ProvenanceCompanionV1 }
  | { readonly ok: false; readonly violations: readonly string[] }

const ROOT_KEYS = ['provenanceVersion', 'runId', 'runDigest', 'attempts'] as const
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
export function runOccurrenceKeys(
  records: readonly { caseId: string; variantId: string }[],
): string[] {
  const seen = new Map<string, number>()
  return records.map((record) => {
    const base = `${record.caseId}\u0000${record.variantId}`
    const attempt = (seen.get(base) ?? 0) + 1
    seen.set(base, attempt)
    return `${base}\u0000${attempt}`
  })
}

export function companionOccurrenceKey(ref: {
  caseId: string
  variantId: string
  attempt: number
}): string {
  return `${ref.caseId}\u0000${ref.variantId}\u0000${ref.attempt}`
}

/**
 * Binding rules shared by the parser and the report renderer (ADR-008 D2/D8):
 * the companion names this run, and its occurrence-key set equals the run's
 * record set. Extracted so the renderer cannot accept a companion the parser
 * would refuse for binding reasons.
 */
export function provenanceBindingViolations(
  companion: Pick<ProvenanceCompanionV1, 'runId' | 'attempts'>,
  run: ProvenanceRun,
): string[] {
  const violations: string[] = []
  if (companion.runId !== run.runId) violations.push('runId does not match the run')

  const runKeys = new Set(runOccurrenceKeys(run.records))
  const companionKeys = new Set(companion.attempts.map(companionOccurrenceKey))
  for (const key of runKeys) {
    if (!companionKeys.has(key)) {
      const [caseId, variantId, attempt] = key.split('\u0000')
      violations.push(`the companion is missing an entry for ${caseId}/${variantId} attempt ${attempt}`)
    }
  }
  for (const key of companionKeys) {
    if (!runKeys.has(key)) {
      const [caseId, variantId, attempt] = key.split('\u0000')
      violations.push(`the companion has an entry with no run record: ${caseId}/${variantId} attempt ${attempt}`)
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
    // Submission order (ADR-008 D3): once the batch stops, every later entry stays
    // `not-submitted`. A submitted status after that point would claim an
    // observation the order cannot support, so it is refused.
    if (entry.status === 'not-submitted') {
      stopped = true
    } else if (stopped) {
      violations.push(`${at}.status follows a not-submitted entry, so the order cannot be established`)
    }
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
  for (const key of ROOT_KEYS) {
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

    const key = `${entry.caseId}\u0000${entry.variantId}\u0000${entry.attempt}`
    if (seenKeys.has(key)) violations.push(`${at} repeats the occurrence key`)
    seenKeys.add(key)

    parsedAttempts.push({
      caseId: entry.caseId as string,
      variantId: entry.variantId as string,
      attempt: entry.attempt as number,
      inputs: parseInputs(entry.inputs, `${at}.inputs`, violations),
      recordSetRevision: (revision ?? null) as string | null,
      correlation: entry.correlation as Correlation,
    })
  })

  // The binding rules live in one place so the renderer applies the same ones.
  if (nonBlank(input.runId)) {
    violations.push(
      ...provenanceBindingViolations(
        { runId: input.runId, attempts: parsedAttempts },
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
    },
  }
}
