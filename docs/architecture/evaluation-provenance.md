# Prepared-input provenance — companion record (proposal)

Status: **proposal.** Not an approved artifact. `RecordedRunV1` (`schemaVersion: 1`) stays unchanged.
Implementation requires a new ADR with an ID allocated in #25. Updated: 2026-10-27.

## Why a separate artifact

`parseRecordedRun` rejects unknown fields, so provenance cannot ride inside the recorded run. M5 agreed to
a separate companion while the run schema stays frozen (2026-10-24); M4 requires the companion to
**reference** `FixedConditions`, not restate it.

## Key

`runId + caseId + variantId + attempt`, where `attempt` is the 1-based occurrence index among records with
the same `(runId, caseId, variantId)` in the run file. Because `AttemptRecord` carries no record id, the
link is positional; if the run file is reordered the companion must be regenerated, and the report refuses
a companion whose counts disagree with the run.

## Fields

| Field | Type | Source of the requirement |
| --- | --- | --- |
| `provenanceVersion` | `1` | independent lifecycle from the run schema |
| `runId` | string | ties the companion to one run (M5) |
| `caseId` | string | corpus case (M5) |
| `variantId` | string | runId+caseId cannot distinguish variants (M5) |
| `attempt` | integer ≥ 1 | distinguishes repeated attempts (M5) |
| `inputs[]` | 1–5 entries | prepared execution can submit 1–5 inputs (M5) |
| `inputs[].inputId` | string | corpus-side identity — **open question for M3** |
| `inputs[].sourceId` | string | the corpus source the input came from |
| `inputs[].requestMessageId` | string \| null | acknowledgement identity (M5) |
| `inputs[].eventId` | string \| null | absent for a rejected submission (M5) |
| `inputs[].status` | `accepted` \| `duplicate` \| `rejected` \| `no-acknowledgement` | explicit, never inferred |
| `recordSetRevision` | string \| null | M4: identity for `history.recordSet` |
| `correlation` | `exact` \| `missing` \| `ambiguous` | drives the unscored rule |

## Lookup

The report command takes an explicit `--provenance <path>` and requires the companion's `runId` to equal
the run's `runId`; a mismatch is refused. No sibling-file guessing, no text or order matching. Without a
companion, every quality result for that run is `unscored` with reason `no-provenance-record`.

## Format and refusal

The companion is **JSON**, one object per run. The report refuses it unless its
`(caseId, variantId, attempt)` set equals the run's record set; a missing or extra entry is a refusal, not
a partial join.

## Unscored rule

`correlation !== exact` for a case means that case's quality result is `unscored` with reason
`missing-acknowledgement-link` or `ambiguous-acknowledgement-link`; the attempt's
failed/cancelled/not-run classification is preserved.

## Rejected alternatives

- **`schemaVersion: 2`** — changes the frozen run record and needs its own ADR plus M5/M3 review.
- **Inference by text or order** — forbidden by M5.

## Open question

`inputs[].inputId` depends on M3's answer to the corpus-identity question in #41. Until it exists, the link
is recorded as `not-yet-observable`, not inferred.

## References

ADR-007 (evaluation bench); M5 and M4 replies in #41 (2026-10-24).
