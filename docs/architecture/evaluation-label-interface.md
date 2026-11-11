# Evaluation label interface — proposal

Status: **proposal, not approved.** Owner: M6. Reviewers: M3 (corpus and labels), M4 (rubric and
condition eligibility), M5 (export and aggregation). Anchors: NFR-01, NFR-04; ADR-008 (prepared-input
provenance); the evaluation protocol proposal (PR #142) §1/§3; DEBT-10.

This document fixes the **shape of the label file and its join to a recorded run**. It does not define the
rubric, a score, a threshold or an acceptance result. Until M3/M4 approve the shape, no label is consumed.

**Scope.** This proposal covers the numeric `scores` object for the dialogue subset. Categorical
observations in M3's rubric draft are separate follow-up work; they are not converted to numbers.

This revision records the positions M4 and M5 gave on 2026-11-09 and M3's agreement on 2026-11-10. They
remain **proposed positions, not interface approval**: the rubric (#99), corpus (#98) and export (#101)
remain open.

## Why

The protocol requires human-reviewed labels before an attempt can be scored, and DEBT-10 records that no
label file, owner or join exists. Without this interface, a formal run can only report latency, cost and
outcome; quality stays `unscored` for every attempt.

## Who owns what

| Piece | Owner | Not M6's |
| --- | --- | --- |
| Label values and the review decision | M3, M4 | yes |
| Rubric definition and scale | M4 | yes |
| Corpus version, hash and held-out marking | M3 | yes |
| File shape, validation, join to an attempt, appendix rendering | **M6** | — |
| Thresholds and any pass/fail claim | M3/M4/M5 after a measured pilot | yes |

## Corpus manifest

M3 owns and maintains the manifest with the versioned corpus and held-out split (#98). M6 consumes and
validates it; M6 does not create corpus data or a second authority. The v1 example manifest records the
corpus version, hash and per-case held-out marking; its two cases are development examples, not a formal
held-out set. The v1 hash covers canonical corpus content (requests, labels, review records and manifest
semantics), **not the raw manifest bytes**, so an adapter must preserve that identity rather than re-hash
the file as stored.

## Input identity and acknowledgements

`sourceId` names the corpus source. Its exact identifier and the component that supplies it are pending
M5's mapping in #101; the runtime input-channel `source` is not automatically that id. For an `accepted`
or `duplicate` submission, M5's adapter carries `requestMessageId` and `eventId`; a `rejected` submission
carries the request id and no event id. The label join never infers either from text, array position or a
runtime id.

## File and key

- One label file per **run**, identified by `(corpusVersion, casesSha256, runId, runDigest)`. A label is a
  judgement on a concrete recorded output, so the file carries the run identity; the report refuses a file
  whose `runId` or `runDigest` does not match the input run.
- The report command takes the run as its input plus `--labels <path>` and `--corpus-manifest <path>`. The
  manifest is the authority for that corpus version, hash and held-out marking.
- The **join key** is `(caseId, variantId, attempt)` within that run — the same positional occurrence key
  the provenance companion uses (ADR-008 D2). The effective label for a key is its highest `revision`. A
  label that names an attempt the run does not contain is refused; an attempt without a label stays
  unscored and is not an error.

## Shape (schema version 1)

```json
{
  "schemaVersion": 1,
  "runId": "run-1",
  "runDigest": "sha256-hex…",
  "corpus": { "corpusVersion": "m3-selection-v1", "casesSha256": "0123…" },
  "labels": [
    {
      "caseId": "case-1",
      "variantId": "rules-baseline",
      "attempt": 1,
      "revision": 1,
      "supersedes": null,
      "status": "reviewed",
      "reviewer": "M4",
      "reviewedAt": "2026-11-18",
      "rubricVersion": "dialogue-rubric-0.1",
      "scores": { "persona-consistency": 4, "intent-adherence": 3 }
    }
  ]
}
```

| Field | Type | Rule |
| --- | --- | --- |
| `schemaVersion` | `1` | independent of the run schema |
| `runId` | string | must match the input run |
| `runDigest` | hex SHA-256 | SHA-256 of the exact run artifact bytes |
| `corpus.corpusVersion` | string | must match the version in the supplied corpus manifest |
| `corpus.casesSha256` | hex SHA-256 | must match the hash in the supplied corpus manifest |
| `labels[].caseId` | string | non-blank |
| `labels[].variantId` | string | non-blank |
| `labels[].attempt` | integer ≥ 1 | positional occurrence index |
| `labels[].revision` | integer ≥ 1 | 1 for the first row of a key; higher for a correction |
| `labels[].supersedes` | integer ≥ 1 or null | null iff revision 1; otherwise the immediately previous revision |
| `labels[].status` | `reviewed` \| `draft` | only `reviewed` is eligible |
| `labels[].reviewer` | string | the human who reviewed |
| `labels[].reviewedAt` | `YYYY-MM-DD` | real calendar date |
| `labels[].rubricVersion` | string | supplied by M4 |
| `labels[].scores` | object | dimension → **finite number**; the scale and meaning belong to the rubric, not to M6 |

Validation is strict, in the same style as the provenance companion: unknown keys are refused; duplicate
`(caseId, variantId, attempt, revision)` keys are refused; for each key the revisions form a contiguous
chain from 1 (revision 1 has `supersedes: null`, revision n > 1 names n−1); the highest revision is
effective; a label for an attempt the run does not contain, a case the manifest does not mark held-out, a
non-finite score, a blank reviewer or a malformed date is refused. A refusal writes no table.

## How the report uses it

The report adds a **Human labels (appendix)** table keyed by the join key: case, variant, attempt, status,
reviewer, rubric version, and the opaque score object. It does not aggregate, rank, compare or convert the
scores into a pass/fail; those are the rubric owner's decisions. The failure-rate and latency tables are
unchanged. Every label must be for a case the corpus manifest marks held-out; a label for a development
case is refused before rendering.

A missing label file or a `draft` label leaves the attempt unscored. `provenance-eligible` (#143) means
rules 1–4 passed; it does **not** mean the attempt is label-reviewed. The reason `no-label-record` is
proposed, not implemented, and would add one reason to the eligibility module. A failed or cancelled attempt
may carry a label as a human observation, but that does not make it scoreable; eligibility excludes it
**when** M4's completed-only decision is recorded. A `notRun` entry is never scored.

## What this does not do

- It defines no rubric, no scale and no threshold.
- It does not score, rank or decide acceptance.
- It does not choose where M3 stores the file.
- It does not define the corpus manifest shape; M3 owns it.
- It does not make labels private or anonymous: the reviewer name is evidence.

## Proposed positions (not approval)

1. **Per attempt.** Keep `(caseId, variantId, attempt)`. A label describes one output of one variant, and
   the two dialogue dimensions are scored against that output; it is also ADR-008 D2's key. M3 owns the
   corpus-side confirmation.
2. **Reviewer and rubric version.** A single required `reviewer` field; `rubricVersion` must name the
   version recorded in #99 before any label is consumed. One signature is not both M3 and M4 approval; if
   joint sign-off is required, M3 states it. The proposed default "a reviewer may not mark their own
   variant's output" is **not a validator rule**: `reviewer` and `variantId` are free strings with no
   ownership relation to check. The independent two-reviewer check and disagreement adjudication are
   recorded in #110's external cross-review record.
3. **Revision.** Append-only with `supersedes` and an integer `revision`, as agreed by M3 on 2026-11-10.
   The file records every row; a later row names the revision it supersedes; the highest revision is
   effective. The validator enforces the contiguous chain and refuses a duplicate revision or an unlinked
   duplicate key (see Validation).
4. **Scale.** The validator keeps "finite number" for now; the example is illustrative. Once #99 records a
   rubric version, its range is enforced in the rubric layer, not in the file shape.
5. **Failed/cancelled.** The interface may allow a label as a human observation, but it does not make the
   attempt scoreable. Eligibility excludes failed/cancelled when the completed-only decision is recorded;
   a `notRun` entry is never scored.

## Verification of this document

Documentation only. `pnpm test:trace` 41 and `pnpm test:readiness` 45 pass on this head (main `7995f51`); no code,
test, threshold or result is added. No label file exists yet, so no claim is made that any attempt is
scored.
