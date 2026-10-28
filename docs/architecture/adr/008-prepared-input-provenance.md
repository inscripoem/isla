# ADR-008 — Prepared-input provenance companion (M6-02)

Status: **proposed.** Date: 2026-10-28. Owner: M6 (evaluation infrastructure).
Affected reviewers: **M5, M3, M4**. Number reserved by M5 in #25 on 2026-10-28.
Related: ADR-007 (measurement bench) · `docs/architecture/evaluation-provenance.md` (proposal, PR #63) ·
issue #41 (M5/M4 answers) · issue #25 (allocation).

## Reservation and scope

M5's reservation in #25 (2026-10-28), excerpts:

> Reserve ADR-008 for M6's prepared-input provenance companion proposal, with M5/M3/M4 as affected
> reviewers.
> …
> This reserves the number only: it does not approve the design, authorise production implementation or
> close S6/G4. M6 authors the ADR; affected owners review it before implementation.

M6 rechecked before creating this file, as the reservation asked:

- `docs/architecture/adr/` on `main` `74e9995` ends at `007`;
- no open PR head adds an `008-*` file: #57 `2a354ca`, #62 `19ced26`, #63 `21fde6f`, #64 `7847a25`,
  #65 `fe63443`;
- #25 contains one ADR-008 comment — M5's reservation. No conflicting reservation exists.

The reservation's scope boundaries are binding on this ADR: a **separate run-bound artifact** that
**references ADR-007 and the existing `FixedConditions`**; `RecordedRunV1` and public ports stay unchanged.
The four topics M5 named are resolved here and remain subject to #41/#63 review: the
input/acknowledgement binding (D3, D5), observed partial and not-run inputs (D4), run and history digests
(D2, D7), and condition eligibility (D6).

## Problem

S6 compares selection variants under declared `FixedConditions`. The recorded run (`RecordedRunV1`) records
the attempt and its outcome, but it has no place to say **which prepared input produced this attempt**. A
reviewer therefore cannot tell whether a completed, failed or cancelled attempt actually received the corpus
inputs the run claims, and a later reader cannot separate two runs that used the same corpus version but a
different input order.

The obvious shortcuts are unsafe:

- **match by text** — two corpus inputs may share text, and a prepared input is not a corpus replay;
- **match by array position** — a batch can stop early, so position is not identity;
- **match by runtime ids** — M5 generates fresh request-message and runtime event ids per submission, so
  they do not name a corpus-side input.

M5's honest name for the path is **prepared-input execution**, not corpus replay: a correct id map does not
re-validate corpus labels under a changed persona, history or timing.

## Forces

- `RecordedRunV1` (`schemaVersion: 1`) is frozen and shared; `parseRecordedRun` refuses unknown fields, so
  provenance cannot ride inside the run artifact without a v2 schema and its own decision.
- The production adapter submits **1–5 inputs** and stops submitting after a rejection or throw
  (`evaluation-adapter.ts`, PR55 dependency `fccb0f2`; not on `main` at `74e9995`).
- M5 does not export each acknowledgement today, and its prepared resolver accepts only `source`, `text`
  and `actorId` (extra fields are refused).
- Missing evidence must stay unknown, never zero (INV-16, NFR-04).
- An artifact that no requirement or owner can reach is a defect
  (`docs/code-governance/structural-constraints.md` §6.1).

## Decision

### D1 — A separate, run-bound companion artifact

Provenance is recorded in a **separate companion record**, not in the run file: `provenanceVersion: 1`,
one JSON object per run, bound to the run by `runId` and by content. `RecordedRunV1` and every public port
stay unchanged. The companion references the run's `FixedConditions`; it never restates them.

### D2 — The key is positional, so the binding must also be content-bound

The key is `runId + caseId + variantId + attempt`, where `attempt` is the 1-based occurrence index among
records with the same `(runId, caseId, variantId)` in the run file. Because `AttemptRecord` carries no record
id, the companion also carries `runDigest`: the SHA-256 of the exact run artifact bytes. Swapping two records
for one case and variant leaves the key set unchanged but changes the digest, so the companion is refused.
Duplicate companion keys are refused; a digest mismatch is refused.

### D3 — Every input carries an explicit status

`inputs[]` holds 1–5 entries in submission order, each with
`status ∈ { accepted, duplicate, rejected, not-submitted, no-acknowledgement }`. Status is recorded, never
inferred. `requestMessageId` and `eventId` are `null` when the observation does not support them — a
rejected submission has a request id and no event id.

### D4 — Observed and unobserved are different facts

A `notRun` case still retains every input that was **actually submitted and observed**, including a rejected
or unacknowledged submission. Only a failure **before any submission** leaves no observed inputs. An
unavailable batch cannot honestly supply 1–5 observed inputs; a not-run entry never receives an invented
acknowledgement.

### D5 — Input identity is a tuple, and it is not observable yet

The intended identity is `(corpusVersion, casesSha256, caseId, candidate.eventId)`, proposed by M5 on
2026-10-28 and pending M3's confirmation. Until M3 confirms it and M5 exports it on the acknowledgement,
`inputs[].inputId` is recorded as **not-yet-observable**; the case is `unscored` with a reason. It is never
inferred from text, array position or runtime ids.

### D6 — An exact link does not bypass condition eligibility

`correlation: exact` does not validate labels. An attempt whose preserved, replaced or unsupported fixture
fields — or whose persona, history or timing conditions — differ from the run's `FixedConditions` is
`unscored` with reason `condition-mismatch`. This retains M5's fixture-field requirement and M4's
condition-eligibility requirement.

### D7 — The admitted record set is identified per attempt

`recordSetRevision` is a digest over the **admitted confirmed record set in admission order**, captured
**per attempt at admission time**; with `history.source: 'durable'` the set grows between attempts, so a
per-run value cannot say which set an attempt admitted. `null` never satisfies `correlation: exact`.

The `null` rule for a run with `history.source: 'none'` is **open**: M4 has not answered whether such a run
carries the digest of the empty set. M5 supports that reading (2026-10-28). Until M4 answers, the rule is
recorded as open, not decided.

### D8 — Refusal, not a partial join

The report command takes an explicit companion path. It refuses the companion when the `runId` differs, the
digest differs, the `(caseId, variantId, attempt)` set differs from the run's, a duplicate key appears, or
the input order cannot be established. A missing or extra entry is a refusal with a reason, never a partial
join. Without a companion, every quality result for that run is `unscored` with reason
`no-provenance-record`.

### D9 — No schema or port change in this decision

No public port, contract or run schema changes. A `schemaVersion: 2` would be a separate decision with its
own triggers; this ADR deliberately does not take it.

## Consequences

- A reviewer can attribute each attempt to prepared inputs **without** trusting text or position, and can
  reject a stale or reordered companion mechanically.
- The companion is a new artifact with a lifecycle of its own (`provenanceVersion: 1`), so a future run-schema
  change does not silently reinterpret old provenance.
- Some cases will be `unscored` rather than scored: an ambiguous or missing link is visible instead of being
  smoothed over. That is the intended cost.
- Implementation needs new code (types, validation, report consumption, tests), so it is **not** authorised by
  this record. The reservation and this proposal are not an implementation approval.
- The corpus/rubric rows stay open until M3 supplies the identity and the reviewed corpus; the evaluation
  table stays absent and G4 stays not run.

## Alternatives considered

- **`schemaVersion: 2` for the run record** — rejected for now: it changes a frozen, shared artifact and
  needs its own decision plus M5/M3 review; the companion achieves the same binding without touching it.
- **Inference by text or order** — rejected: forbidden by M5, and unsound when inputs share text or a batch
  stops early.
- **Restating `FixedConditions` in the companion** — rejected by M4: two copies drift, and a restated
  condition can disagree with the run it claims to describe.
- **Recording only `runId`** — rejected: it cannot separate attempts that share a case and variant.
- **Promoting a missing link to `exact`** — rejected by INV-16 and the honesty rule: unknown is not a pass.

## Open decisions (blocking implementation)

| # | Question | Owner | Effect while open |
| --- | --- | --- | --- |
| 1 | Is `(corpusVersion, casesSha256, caseId, candidate.eventId)` the stable corpus identity? | M3 | `inputId` stays not-yet-observable; link-dependent cases are unscored |
| 2 | Does `history.source: 'none'` carry the empty-set digest or `null`? | M4 | D7's null rule is recorded as open |
| 3 | Who exports the per-input acknowledgement, and in what shape? | M5 | `requestMessageId`/`eventId` may stay `null`; correlation is `missing` |

## Re-open triggers

- M3 confirms or replaces the corpus identity → update D5 and the proposal.
- M4 answers the no-history question → close D7.
- M5 exports acknowledgements → implement the companion with tests.
- A run needs provenance that the companion cannot express → revisit D1 before extending it.
- A real S6 run exists → record whether the companion was used and whether any case stayed unscored.

## References

ADR-007 (measurement bench); `docs/architecture/evaluation-provenance.md` (proposal in PR #63);
FR-06; NFR-03; NFR-04; INV-16; issues #41 and #25 (2026-10-24 to 2026-10-28).
