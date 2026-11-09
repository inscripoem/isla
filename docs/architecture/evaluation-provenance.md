# Prepared-input provenance — companion record (proposal)

Status: **proposal.** Not an approved artifact. `RecordedRunV1` (`schemaVersion: 1`) stays unchanged.
Implementation requires a new ADR. M5 reserved its number in #25 on 2026-10-28; the reservation is a number
only — it does not approve this design, authorise production implementation or close S6/G4. The numbered
file is a separate slice, so this document names the reservation without an id: the trace gate refuses a
reference to an ADR file that does not exist yet. Updated: 2026-11-04.

## Why a separate artifact

`parseRecordedRun` rejects unknown fields, so provenance cannot ride inside the recorded run. M5 agreed to
a separate companion while the run schema stays frozen (2026-10-24); M4 requires the companion to
**reference** `FixedConditions`, not restate it.

## Key

`runId + caseId + variantId + attempt`, where `attempt` is the 1-based occurrence index among records with
the same `(runId, caseId, variantId)` in the run file. Because `AttemptRecord` carries no record id, the
link is positional, so the companion also carries `runDigest`: the SHA-256 of the exact run artifact bytes;
the ADR fixes the canonicalisation if a byte-stable serialization is required. A digest mismatch is
refused — swapping two records for the same case and variant changes the digest even though the
occurrence-key set is unchanged.

## Fields

| Field | Type | Source of the requirement |
| --- | --- | --- |
| `provenanceVersion` | `1` | independent lifecycle from the run schema |
| `runId` | string | ties the companion to one run (M5) |
| `runDigest` | string (hex SHA-256) | binds the companion to the exact ordered run content (M5) |
| `caseId` | string | corpus case (M5) |
| `variantId` | string | runId+caseId cannot distinguish variants (M5) |
| `attempt` | integer ≥ 1 | distinguishes repeated attempts (M5) |
| `inputs[]` | one entry per prepared input, in submission order; later entries stay `not-submitted` when the batch stops; zero entries only when nothing was submitted | prepared execution can submit 1–5 inputs (M5); the list never invents an observation |
| `inputs[].inputId` | string | corpus-side identity — M3 confirmed the tuple on 2026-10-29; recorded as `not-yet-observable` until M5 exports it |
| `inputs[].sourceId` | string | the corpus source the input came from |
| `inputs[].requestMessageId` | string \| null | acknowledgement identity (M5) |
| `inputs[].eventId` | string \| null | absent for a rejected submission (M5) |
| `inputs[].status` | `accepted` \| `duplicate` \| `rejected` \| `not-submitted` \| `no-acknowledgement` | explicit, never inferred |
| `recordSetRevision` | string \| null | content-bound digest over the admitted confirmed record set in admission order, captured per attempt at admission time; `null` only when the set was genuinely unobserved; `none` and `local` carry the digest of the set M4 actually observed (the empty set for `none`); `null` never satisfies `correlation: exact` |
| `correlation` | `exact` \| `missing` \| `ambiguous` | drives the unscored rule |

## Lookup

The report command takes an explicit `--provenance <path>` and requires the companion's `runId` to equal
the run's `runId`; a mismatch is refused. No sibling-file guessing, no text or order matching. Without a
companion, every quality result for that run is `unscored` with reason `no-provenance-record`.

## Format and refusal

The companion is **JSON**, one object per run. The report refuses it unless (a) `runDigest` matches the run
artifact, (b) the `(caseId, variantId, attempt)` set equals the run's record set, and (c) no duplicate
`(caseId, variantId, attempt)` key appears. A missing or extra entry is a refusal, not a partial join. The
input list is ordered by submission; a companion whose input order cannot be established is refused.

## Unscored rule

`correlation !== exact` for a case means that case's quality result is `unscored` with a reason that names
the independent defect: `missing-input-identity` (the corpus identity was not observable),
`missing-history-observation` (the admitted set was not captured), `missing-acknowledgement-link`, or
`ambiguous-acknowledgement-link`. The attempt's failed/cancelled/not-run classification is preserved.

An exact acknowledgement does **not** bypass the condition check. An attempt whose preserved, replaced or
unsupported fixture fields — or whose persona, history or timing conditions — differ from the run's
`FixedConditions` is `unscored` with reason `condition-mismatch`. `FixedConditions` is referenced, never
restated.

## Record set revision

`recordSetRevision` is not a label or a counter. It is a digest over the **admitted confirmed record set in
admission order**, captured **per attempt at admission time**: with `history.source: 'durable'` the set grows
between attempts, so a per-run or end-of-run value cannot say which set an attempt admitted.

The null rule is decided (M4, [issue #41](https://github.com/inscripoem/isla/issues/41#issuecomment-6476254278),
2026-10-28):

| Captured evidence at admission | `recordSetRevision` | `correlation` |
| --- | --- | --- |
| M4 assembly observed, admitted set empty | digest of the empty set | may be `exact` |
| M4 assembly observed, admitted set non-empty | digest of that set | may be `exact` |
| M4 assembly observed, set not captured | `null` | `missing` |
| No M4 assembly observation | `null` | `missing` (unobserved) |

`null` means only that the set was genuinely unobserved. A `history.source: 'none'` or `'local'` run is M4's
explicit, observable assembly decision, not a capture failure, and carries the digest of the set M4 observed
(the empty set for `none`). `correlation: exact` is never derived from `history.source` alone.

## Partial admission and not-run

Prepared execution can stop submitting after a rejection or throw; later entries are not submitted, and a
batch with no acceptance is a `notRun` entry rather than an `AttemptRecord` (PR55 dependency commit
`fccb0f2`, `evaluation-adapter.ts:1097-1123`; merged into `main` through #65 as `4e4f7cd`). A `notRun`
case still retains every input that was actually submitted and observed; only a failure before any
submission leaves no observed inputs (M5, 2026-10-28). The companion distinguishes:

- `not-submitted` — the batch stopped before this entry was submitted;
- `no-acknowledgement` — the entry was submitted but no acknowledgement was returned;
- `rejected` — submitted and refused (`requestMessageId` without `eventId`).

Not-run entries are retained outside the record occurrence keys, keyed by `(caseId, variantId)`, and never
receive invented acknowledgements. A batch that never submitted an input supplies zero observed inputs; a
stopped batch supplies only the entries it actually observed, with the remaining prepared entries marked
`not-submitted`.

**Example (partial admission):** three inputs are prepared; the second is rejected, so the third is
`not-submitted`. The attempt keeps `accepted` / `rejected` / `not-submitted`, and the case's quality result
is `unscored` because not every prepared input has an acknowledgement.

**Example (pre-submission refusal):** the batch fails before **any input is submitted**. There is no
`AttemptRecord`; the run records a `notRun` entry and the companion records no inputs for it, because no
input was observed. A batch that stops **after** a rejected or unacknowledged submission is different: the
case may still be `notRun`, but those observed inputs are retained rather than discarded.

## Rejected alternatives

- **`schemaVersion: 2`** — changes the frozen run record and needs its own ADR plus M5/M3 review.
- **`null` for a known-empty set (option b)** — rejected: a decidable correlation filed in the unscored
  bucket destroys the stratification signal a no-history run is meant to provide (M4, 2026-10-28).
- **Inference by text or order** — forbidden by M5.

## Input identity (M5 and M3 answers, 2026-10-28/29; still not observable)

M5 checked this against PR #57 `2a354ca` and the PR55 dependency `fccb0f2` and reported that the end-to-end
corpus identity link **does not exist today**:

- PR55's prepared resolver accepts only `source`, `text` and `actorId`; extra fields are refused;
- M5 generates fresh request-message and runtime event IDs, and accepted/duplicate acknowledgements return
  those runtime IDs, not a corpus-side identifier;
- the current adapter does not export each acknowledgement at all.

M3 confirmed `(corpusVersion, casesSha256, caseId, candidate.eventId)` as the v1 corpus-side identity on
2026-10-29 ([#41](https://github.com/inscripoem/isla/issues/41#issuecomment-6508103610)). The identity is a
fixture identity, not a runtime event ID; a future M5 admission capture must bind it to the submitted request
and the returned acknowledgement. Until that capture exists, `inputs[].inputId` stays `not-yet-observable` and
is never inferred from text, array position or runtime IDs.

## References

ADR-007 (evaluation bench); the reserved provenance ADR (number allocated in #25, 2026-10-28, not
approved); FR-06; INV-16; M5 and M4 replies in #41 (2026-10-24 to 2026-10-28).
