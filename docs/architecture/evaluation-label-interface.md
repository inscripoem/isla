# Evaluation label interface — proposal

Status: **proposal, not approved.** Owner: M6. Reviewers: M3 (corpus and labels), M4 (rubric and
condition eligibility), M5 (export and aggregation). Anchors: NFR-01, NFR-04; ADR-008 (prepared-input
provenance); the evaluation protocol proposal (PR #142) §1/§3; DEBT-10.

This document fixes the **shape of the label file and its join to a recorded run**. It does not define the
rubric, a score, a threshold or an acceptance result. Until M3/M4 approve the shape, no label is consumed.

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

## File and key

- One label file per corpus version, identified by `(corpusVersion, casesSha256)`.
- The report command takes two explicit inputs: `--labels <path>` and `--corpus-manifest <path>`. The
  producer chooses the label directory; the label file names the corpus it belongs to, and the manifest is
  the authority for that corpus version, hash and held-out marking.
- The **join key** is `(caseId, variantId, attempt)` — the same positional occurrence key the provenance
  companion uses (ADR-008 D2). A label that names an attempt the run does not contain is refused, and an
  attempt without a label is **not an error**; it stays unscored.

## Shape (schema version 1)

```json
{
  "schemaVersion": 1,
  "corpus": { "corpusVersion": "m3-selection-v1", "casesSha256": "0123…" },
  "labels": [
    {
      "caseId": "case-1",
      "variantId": "rules-baseline",
      "attempt": 1,
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
| `corpus.corpusVersion` | string | must match the version in the supplied corpus manifest |
| `corpus.casesSha256` | hex SHA-256 | must match the hash in the supplied corpus manifest |
| `labels[].caseId` | string | non-blank |
| `labels[].variantId` | string | non-blank |
| `labels[].attempt` | integer ≥ 1 | positional occurrence index |
| `labels[].status` | `reviewed` \| `draft` | only `reviewed` is eligible |
| `labels[].reviewer` | string | the human who reviewed |
| `labels[].reviewedAt` | `YYYY-MM-DD` | real calendar date |
| `labels[].rubricVersion` | string | supplied by M4 |
| `labels[].scores` | object | dimension → **finite number**; the scale and meaning belong to the rubric, not to M6 |

Validation is strict, in the same style as the provenance companion: unknown keys are refused; duplicate
`(caseId, variantId, attempt)` keys are refused; a label for an attempt the run does not contain is refused;
a label for a case the corpus manifest does not mark held-out is refused; a non-finite score, a blank
reviewer or a malformed date is refused. A refusal writes no table.

## How the report uses it

The report adds a **Human labels (appendix)** table keyed by the join key: case, variant, attempt, status,
reviewer, rubric version, and the opaque score object. It does not aggregate, rank, compare or convert the
scores into a pass/fail; those are the rubric owner's decisions. The failure-rate and latency tables are
unchanged. Every label must be for a case the corpus manifest marks held-out; a label for a development
case is refused before rendering.

A missing label file or a `draft` label leaves the attempt unscored. The reason `no-label-record` is
proposed, not implemented, and would add one reason to the eligibility module (#143). A failed or cancelled
attempt may carry a label, but eligibility excludes it once M4's completed-only decision is recorded; until
then no attempt is scored, so the question does not change today's output.

## What this does not do

- It defines no rubric, no scale and no threshold.
- It does not score, rank or decide acceptance.
- It does not choose where M3 stores the file.
- It does not define the corpus manifest shape; M3 owns it.
- It does not make labels private or anonymous: the reviewer name is evidence.

## Open questions for the reviewers

1. **Per attempt or per case?** A label is attached to one attempt's output. If M3/M4 intend one label per
   case applied to every variant, the key should drop `variantId` and `attempt` — decide before
   implementation.
2. **Who may set `status: reviewed`?** One named reviewer, or any of M3/M4? A `reviewer` field is required
   either way.
3. **Revision policy.** If a label is corrected, should the file keep the previous label (a
   `supersedes` field) or is the file replaced? The provenance rule is append-only evidence.
4. **Scale.** The interface accepts any finite number; if the rubric fixes a range, the validator could
   enforce it. That is M4's call.
5. **Failed/cancelled labels.** May a failed or cancelled attempt carry a label at all? The file can allow
   it and let eligibility exclude it, or refuse it at write time. M4's completed-only proposal decides the
   eligibility half.

## Verification of this document

Documentation only. `pnpm test:trace` 41 and `pnpm test:readiness` 45 pass at `main 58990bd`; no code,
test, threshold or result is added. No label file exists yet, so no claim is made that any attempt is
scored.
