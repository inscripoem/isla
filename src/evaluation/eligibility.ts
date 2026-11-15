import type { AttemptRecord } from './metrics'
import {
  companionOccurrenceKey,
  parseOccurrenceKey,
  runOccurrenceKeys,
  type ProvenanceCompanionV1,
} from './provenance'

/**
 * M6-02 — scoring eligibility (evaluation protocol §3, ADR-008).
 *
 * This module answers one question per attempt: **may this attempt be scored at
 * all?** It does not score, rank or compare anything — that needs human labels
 * and the rubric, which M3/M4 own.
 *
 * The reasons are the protocol's named set, never a free-text message. Rule 5 of
 * the protocol (`condition-mismatch`) is **not evaluated here**: the recorded run
 * carries `FixedConditions` per run, not per attempt, so there is nothing to
 * compare an attempt against. The report states that limitation rather than
 * pretending the condition check passed.
 *
 * **`provenance-eligible` is not "may be scored".** It means rules 1–4 passed. A
 * scored attempt also needs a human-reviewed label (protocol §1), which is a
 * separate interface (#145) and is not an input to this module; the label gate sits
 * outside it.
 */

export const UNSCORED_REASONS = [
  'no-provenance-record',
  'missing-acknowledgement-link',
  'ambiguous-acknowledgement-link',
  'missing-input-identity',
  'missing-history-observation',
] as const
export type UnscoredReason = (typeof UNSCORED_REASONS)[number]

export type Eligibility =
  | { readonly state: 'provenance-eligible' }
  | { readonly state: 'unscored'; readonly reason: UnscoredReason }

export interface AttemptEligibility {
  readonly caseId: string
  readonly variantId: string
  readonly attempt: number
  readonly eligibility: Eligibility
}

const PROVENANCE_ELIGIBLE: Eligibility = { state: 'provenance-eligible' }
const unscored = (reason: UnscoredReason): Eligibility => ({ state: 'unscored', reason })

/**
 * Eligible per attempt, in the run's record order.
 *
 * Order of checks follows protocol §3: a companion must exist (1), the link must
 * be exact (2), the prepared input must have an identity (3), and the admitted
 * record set must be observed (4). The first failure names the reason, so an
 * attempt is never reported with a later reason that hides an earlier gap.
 */
export function evaluateEligibility(
  companion: ProvenanceCompanionV1 | null,
  records: readonly AttemptRecord[],
): readonly AttemptEligibility[] {
  const keys = runOccurrenceKeys(records)

  if (companion === null) {
    return records.map((record, index) => ({
      caseId: record.caseId,
      variantId: record.variantId,
      attempt: attemptOf(keys[index]),
      eligibility: unscored('no-provenance-record'),
    }))
  }

  const entries = new Map(
    companion.attempts.map((entry) => [companionOccurrenceKey(entry), entry]),
  )

  return records.map((record, index) => {
    const key = keys[index] as string
    const entry = entries.get(key)
    return {
      caseId: record.caseId,
      variantId: record.variantId,
      attempt: attemptOf(key),
      eligibility: entry === undefined ? unscored('no-provenance-record') : eligibilityOf(entry),
    }
  })
}

function attemptOf(key: string | undefined): number {
  if (key === undefined) return 1
  const parsed = parseOccurrenceKey(key)
  // The key is built by `runOccurrenceKeys`; a malformed key is a programming error.
  if (parsed === null) throw new Error(`unexpected occurrence key: ${key}`)
  return parsed.attempt
}

function eligibilityOf(entry: {
  readonly correlation: 'exact' | 'missing' | 'ambiguous'
  readonly recordSetRevision: string | null
  readonly inputs: readonly {
    readonly inputId: string | null
    readonly status: string
  }[]
}): Eligibility {
  if (entry.correlation === 'missing') return unscored('missing-acknowledgement-link')
  if (entry.correlation === 'ambiguous') return unscored('ambiguous-acknowledgement-link')

  // `correlation: 'exact'` with a null `recordSetRevision` is already refused by
  // `parseProvenance` (`provenance.ts`), so the combination is unreachable here.
  // The dialogue ran on an accepted (or duplicate) submission; without an
  // observable identity for that input there is no fixture to score against.
  const submitted = entry.inputs.filter(
    (input) => input.status === 'accepted' || input.status === 'duplicate',
  )
  if (submitted.length === 0 || submitted.some((input) => input.inputId === null)) {
    return unscored('missing-input-identity')
  }

  if (entry.recordSetRevision === null) return unscored('missing-history-observation')

  return PROVENANCE_ELIGIBLE
}
