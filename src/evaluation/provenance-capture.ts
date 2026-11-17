import {
  PROVENANCE_VERSION,
  parseProvenance,
  provenanceRunDigest,
  type ProvenanceAttempt,
  type ProvenanceCompanionV1,
  type ProvenanceNotRunEntry,
  type ProvenanceRun,
} from './provenance'
import { parseRecordedRun } from './recorded-run'

/**
 * M6 / CP05 (#100) — the producer half of the ADR-008 provenance companion.
 *
 * The merged `parseProvenance` reads, binds and refuses a companion; nothing
 * wrote one. This module writes one and refuses through the same parser, so the
 * producer and the consumer cannot disagree about what a valid companion is.
 *
 * Two rules make the artifact evidence rather than a claim:
 *
 *  1. **The digest is derived, never asserted.** `runDigest` is computed from the
 *     run artifact bytes given to this function. The draft type has no
 *     `runDigest` field, and a draft that carries one at runtime is refused
 *     instead of having its value overwritten silently.
 *  2. **The run is parsed from the same bytes the digest covers.** A caller
 *     cannot pair run object A with artifact B, because there is no run object
 *     argument: `runId` and the record set come from the artifact itself. The
 *     alternative (taking a parsed run and a separate byte string) would let one
 *     companion be bound to two different things and still parse.
 *
 * The function is pure: it takes bytes and returns canonical JSON. Writing the
 * file is the caller's job, so a refusal cannot leave a partial artifact behind.
 */
export interface ProvenanceDraft {
  readonly runId: string
  readonly attempts: readonly ProvenanceAttempt[]
  readonly notRun?: readonly ProvenanceNotRunEntry[]
}

export type ProvenanceCapture =
  | { readonly ok: true; readonly companion: ProvenanceCompanionV1; readonly json: string }
  | { readonly ok: false; readonly violations: readonly string[] }

const DRAFT_KEYS = ['runId', 'attempts', 'notRun'] as const

/**
 * Build the companion for one recorded run and validate it against that run.
 *
 * Returns the canonical JSON on success, or the violations that prevented it.
 * A blank `runId`, a missing or extra attempt, a duplicate occurrence, a not-run
 * observation the run did not record, and an `exact` correlation without an
 * observed acknowledgement are all refusals, not warnings.
 */
export function captureProvenance(
  runBytes: string | Buffer,
  draft: ProvenanceDraft,
): ProvenanceCapture {
  const unknown = Object.keys(draft).filter(
    (key) => !(DRAFT_KEYS as readonly string[]).includes(key),
  )
  if (unknown.length > 0) {
    return {
      ok: false,
      violations: unknown.map(
        (key) =>
          `the draft field "${key}" is not a capture input; runDigest is derived from the run bytes and cannot be asserted`,
      ),
    }
  }

  // The digest covers the exact bytes; the run is parsed from the same text. A
  // Buffer is hashed as raw bytes, so an invalid byte sequence cannot collapse to
  // the same digest as its decoded replacement.
  const text = typeof runBytes === 'string' ? runBytes : runBytes.toString('utf8')
  const recorded = parseRecordedRun(text)
  if (!recorded.ok) return { ok: false, violations: recorded.violations }

  const run: ProvenanceRun = {
    runId: recorded.input.meta.runId,
    records: recorded.input.run.records,
    notRun: recorded.input.run.notRun,
  }

  const candidate = {
    provenanceVersion: PROVENANCE_VERSION,
    runId: draft.runId,
    runDigest: provenanceRunDigest(runBytes),
    attempts: draft.attempts,
    notRun: draft.notRun ?? [],
  }

  const parsed = parseProvenance(candidate, run, runBytes)
  if (!parsed.ok) return { ok: false, violations: parsed.violations }

  return {
    ok: true,
    companion: parsed.companion,
    json: `${JSON.stringify(parsed.companion, null, 2)}\n`,
  }
}
