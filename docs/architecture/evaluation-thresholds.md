# Evaluation thresholds — register

Status: **proposal; every value is `pending`.** Date: 2026-11-09. Owner: M6.
Rule source: the evaluation protocol, **PR #142** (this proposal), §5.
No threshold is approved, no baseline exists, no pilot has run, and no CP5 or G4 result is claimed.

## Rule

A threshold has three parts: **statistic**, **comparison** and **verification** (protocol §5.1). It may be
fixed only after a pilot that produced a recorded result on a named head with declared conditions
(§5.2–5.3), and it must name its baseline, head, date and approving owner. Without a baseline it is
`pending` — never `0` and never a target (§5.4).

## Requirement thresholds (all pending)

| NFR | Obligation | Statistic | Comparison | Verification | Baseline | Head / date | Approver | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| NFR-01 | input → first audible output | p95 | pending | M1/M2 observation method (#102); report `firstAudibleMs` | pending | pending | M1/M2/M5 | pending |
| NFR-01 | Stop → silence | p95 | pending | M1/M2 observation method (#102); report `stopToSilenceMs` | pending | pending | M1/M2/M5 | pending |
| NFR-02 | safe-outcome proportion under injected faults | proportion | pending | fault-injection suites; C-74 process restart | pending | pending | M5 | pending |
| NFR-02 | recovery duration | duration | pending | same suites; the declared recovery boundary | pending | pending | M5 | pending |
| NFR-03 | selection appropriateness, intent adherence, persona consistency, unacceptable-response rate | pending | pending | M3/M4 rubric and reviewed labels (#99) | pending | pending | M3/M4 (pending #99 review) | pending |
| NFR-04 | token / cost / session caps | totals | pending | usage and price export (#101); report usage rule | pending | pending | M3/M5 | pending |
| NFR-05 | retention / deletion period | duration | pending | retention decision (#107); memory/state design | pending | pending | M5 | pending |

## Deterministic obligations — not measured thresholds

These are acceptance rules verified by tests, not values awaiting a baseline, so they do not appear above:

- **NFR-04** — at most one provider attempt per decision opportunity (case C-15).
- **NFR-05** — zero unauthorized privileged transitions in the reviewed adversarial suite (proposed
  obligation). This is separate from the suite's not-yet-observed result and from the pending
  retention/deletion period; a pilot may record the observed result but does not set a nonzero allowance.
- **NFR-06** — zero business-logic changes for a provider substitution; the substitute passes the shared
  contract suite.

Recording them as `pending` thresholds would invent a measurement the requirement does not ask for.

## Reported metrics without a requirement threshold

`submitMs`, `planMs`, `dialogueMs` and `synthesisMs` are reported stage metrics (protocol §2). **No threshold
is assigned to them**, because no NFR names one; a threshold invented for them would have no requirement
basis. Subtitle/action timing error is likewise unthresholded and has no observation path today. All of
them render `—` when unobserved; none is converted to `0`.

## Status vocabulary

- `pending` — no baseline exists. This is a value state, not an estimate.
- `0`, a target, or a course example is **not** a value for a missing baseline.
- `observed`, `unknown` and `not run` stay distinct (INV-16); a not-run case is not an attempt.

## What changes a row

1. A pilot that produces a recorded run on a named head, with the conditions declared.
2. The baseline value, head, date and approving owner recorded in the row.
3. Or a recorded team decision to drop the requirement threshold — with the requirement row updated in
   the same change.

A single run without declared conditions does not fix a threshold.

## What this document does not claim

No measured baseline, no pilot, no evaluation table, no G4 pass, no CP5 acceptance, and no label or
rubric. It records the **shape** of the thresholds and the honest state of each value.

## Verification

Documentation only. `pnpm test:trace` and `pnpm test:readiness` pass on the head this lands at; no code,
test, threshold or result is added. Every numeric token above is a statistic (`p95`) or an issue number,
not a threshold value.
