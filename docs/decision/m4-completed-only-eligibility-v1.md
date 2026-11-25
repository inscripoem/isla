# M4 completed-only eligibility decision (v1)

- Owner: M4 (@L01nki1). Implemented by: M6 (@MichaelLsh) in `src/evaluation/`.
- Tracks [#99](https://github.com/inscripoem/isla/issues/99) (checkpoint [#75](https://github.com/inscripoem/isla/issues/75), M6-02 / delivery 2D / S1-01 R6).
- Status: **recorded (v1)**. This document records a decision M4 owns. It does not implement it: the named reason and its code live in `src/evaluation/`, which is M6's directory, and this record adds nothing there. #99 was closed on 2026-11-20; as of 2026-11-25 the named reason is still absent from `UNSCORED_REASONS` (`src/evaluation/eligibility.ts`), so implementation remains pending.

## 1. The decision

Only a `completed` attempt is quality-eligible.

- A `failed` or `cancelled` attempt is excluded from quality scoring with a **named reason**, never a free-text message. The reason is a member of the protocol's named set (`UNSCORED_REASONS` in `src/evaluation/eligibility.ts`), so an excluded attempt reports why it was excluded and an operator can count the exclusion.
- A `failed` or `cancelled` attempt is still counted in the protocol §2 outcome counts. Exclusion from quality scoring is not deletion from the run: the outcome counts classify executed attempts as `completed`, `failed` or `cancelled`, and this decision changes none of that.
- A `notRun` entry is never scored and is **not an attempt**. It carries no outcome count and no eligibility state, because the run never attempted it.
- A failed or cancelled attempt may still carry a human label as an observation (see `docs/architecture/evaluation-label-interface.md`); carrying a label does not make the attempt scoreable.

## 2. Basis

The decision was proposed by M4 and recorded as open, not enforced, in the following places. Each is cited precisely:

1. **PR #142 §3** — M4's completed-only eligibility proposal, recorded there as an open decision and not enforced.
2. **`docs/architecture/evaluation-protocol.md` §3** — the paragraph headed "Open decision (proposed by M4, not implemented)", which states the proposal in the same terms as §1 and records that M4 owns the decision and M6 implements it after it is recorded.
3. **`docs/architecture/adr/008-prepared-input-provenance.md` row 4** (open decisions table) — which names "M4's completed-only decision recorded in #142 §3 and absent from #143's `UNSCORED_REASONS`" as the reason a separate named batch-completeness condition is needed before CP05 scoring.
4. **`src/evaluation/eligibility.ts`** — whose `UNSCORED_REASONS` list does not yet carry a completed-only reason. Its current reasons cover provenance rules 1–4 only.

This document changes the status of that proposal from *open* to *recorded*. It does not assert that the reason exists in code.

## 3. Boundary

- The named reason and its implementation live in `src/evaluation/`, which is **M6's directory**. M4 does not add the reason here, and the pull request that lands this document contains no change under `src/`.
- **M6 implements the named reason after this record lands.** The implementation adds the reason to `UNSCORED_REASONS`, evaluates it against the attempt's recorded outcome, and carries a test that a `failed` and a `cancelled` attempt are `unscored` with that reason while still appearing in the §2 outcome counts, and that a `notRun` entry is never scored.
- `docs/architecture/evaluation-protocol.md` is M6's file. M6 updates its own "Open decision" paragraph to a recorded decision when the reason is implemented; this record does not edit it.
- Once the reason is implemented and recorded, the two conditional sentences in `docs/architecture/evaluation-label-interface.md` (the sentence in "How the report uses it" and proposed position 5) can be read as unconditional. This record updates their condition to point at this document; it does not claim the exclusion is enforced in code today.

## 4. Effect on the M4 rubric

This decision changes **no rubric rule, threshold, weight or criterion**, and it does **not** bump the M4 rubric version: `docs/decision/m4-dialogue-scoring-rubric-v0.1.md` stays `v0.1`. The decision says which attempts may be scored at all; it says nothing about how a scoreable attempt is scored. Eligibility sits upstream of the rubric, in the protocol's §3 conditions, not inside the rubric's dimensions.

## 5. Condition eligibility is unchanged by this decision

The condition-eligibility part of the rubric §3 (`docs/decision/m4-dialogue-scoring-rubric-v0.1.md` §3) is **unchanged** by this decision:

- Per-attempt conditions remain the **target semantics**. The two M4-owned conditions — the persona pair `persona {profileId, version}` and `history {source, recordSet}` — are evaluated per attempt once conditions are recorded per attempt.
- The current **per-run** recording stays an **explicit recorded limitation**: the DEBT-13 row in `docs/debt-register.md` records that `condition-mismatch` cannot be evaluated today because conditions are recorded per run, not per attempt, and names "per-attempt conditions, or an explicit recorded limitation" as the two acceptable outcomes.

Completed-only eligibility and condition eligibility are separate conditions. Recording this decision does not close DEBT-13 and does not make `condition-mismatch` evaluable.

## 6. Boundaries of this document

- It creates no code change, introduces no mock or stand-in, and modifies no scoring rule.
- It claims no CP04 or CP05 acceptance and no measured quality, latency or cost result.
- #99 was **closed on 2026-11-20**; this record neither records nor implies the reviewers' acceptance, and its implementation status above is dated 2026-11-25.
