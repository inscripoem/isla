# ADR-007 — Shared comparison and measurement bench (M6-02)

Status: accepted (proposal under review). Date: 2026-10-16. Owner: M6 (evaluation tooling lane).
Related: ADR-006 (gate tooling — lands with **PR #27**) · `docs/code-governance/structural-constraints.md` §4 (lands with **PR #32**).

## Problem

`PLAN:53` asks for a **shared comparison runner and total latency/cost**; `PLAN:90` says *M3/M4 supply
semantic cases* while *M1/M2/M5 supply their observations*; `PLAN:116` names the timing sources per role.
`REQUIREMENTS:34–37` (NFR-01/03/04) requires p95 latency, a versioned evaluation set compared under
**fixed conditions**, and that **missing usage stays unknown**.

Today there is no bench. Measurements would be gathered ad hoc, per role, in different shapes — and the
temptation is to claim a "pass" from fixtures alone. This ADR fixes the shape of a measurement before any
number is produced.

## Decisions

### D1 — One bench, two halves

`src/evaluation/metrics.ts` (the record and its aggregation) and `src/evaluation/comparison.ts` (the
runner that produces records). Both are pure over injected dependencies; neither imports a provider.

### D2 — One attempt is one record, and nothing is dropped

Every attempt is recorded with its outcome — `completed`, `cancelled` or `failed` — and a failed attempt
**records why**. A failed attempt is a **measurement, not a gap**: dropping it would inflate the success
picture and hide the tail NFR-01 asks about.

### D3 — Missing is unknown, never zero

A measurement that was not observed is `null`. Usage is summed **only when every attempt reports it**;
otherwise the aggregate is `null` and `unknown` is true. This is the literal reading of NFR-04
(*"Missing usage remains unknown"*), and it is deliberately conservative: a partial sum presented as a
total is a lie.

### D4 — Cold and warm are separate populations

The **first attempt a variant actually makes** in a run is summarised apart from its later attempts
(NFR-01 requires the cold/warm state to be documented). Mixing them would hide the warm-up cost. A
deliberately not-run case is **not** an attempt, so it does not consume a variant's cold slot.

### D5 — Nearest-rank percentiles, no dependency

`p(q) = sorted[min(n − 1, ceil(q·n) − 1)]`, and `null` for an empty sample. Each stage reports the sample
`n` it actually measured, so a thin sample is visible rather than disguised.

### D6 — The bench does not invent a provider

Running the bench against a real provider requires a provider. Without one, the run is reported as
**not run** — never a fabricated pass. Gate G4 reads the same rule from the generated evaluation table.

### D7 — The report is a receipt, and it refuses what it cannot support

`src/evaluation/report.ts` renders a run into the Markdown that gate **G4** reads. It is not a pass/fail
judgement: it records the fixed conditions (NFR-01's five, plus persona, model and prompt versions, the text
budget, the history source and the clock domain — issue #41 Q3), the counts, the percentile table and every
attempt.

It **refuses** to render, naming the reasons, when the run cannot support the numbers it would print:

- a **fixture** text source — it consumes no tokens and is not comparable to a provider run (#41, M4);
- **latency from an injected clock** — a fixture clock returns a constant, so its durations are not
  measurements (#41, M4);
- **no attempts** — a report with no attempts claims nothing;
- a **declared sample size** that differs from the attempts actually recorded;
- a blank required condition, or a record for a variant the run did not declare.

Two rules are structural rather than prose: an unobserved stage prints `—`, never `0`; and the runner's
first-attempt window is labelled **"first attempt"**, not "cold", because it does not establish a cold
process, provider, worker or cache (#41, M5). The declared cold/warm state is the run condition.

The report names its run (`runId`) and generation date, so a reader can attribute the artifact; neither is
inferred from the records. Without provider access the table stays absent and G4 keeps reporting **not
run** — the correct answer, not a pass.

### D8 — A case carries only what changes the prompt per case

`EvalCase` is `{ id, input, replyIntent?, heldOut?, labels? }` (issue #41 Q3a). `replyIntent` is M3's actual
intent — which template renders the reply — and is distinct from `labels.intent`, the human reference label.
`heldOut` keeps an evaluated case out of any tuning loop (NFR-03). An absent field stays absent: the bench
never substitutes a default, because a missing intent or hold-out state rendered as a value would make two
runs look comparable when they are not.

Conditions that hold for the **whole run** — persona id and version, model and prompt versions, text budget,
history source and record set, text source, clock domain — live in the report's `FixedConditions` (D7), not
on each case. Duplicating them per case would let one run contain two different "fixed" conditions.

## Alternatives considered

- **A statistics dependency** (`simple-statistics`, `d3-array`, `ml-matrix`). Rejected: this is one
  nearest-rank function; a dependency is a supply-chain and review cost for no gain.
- **A test runner's benchmark mode.** Rejected: it measures the *runner's* cost, not the product's latency,
  and it cannot express cancellations or missing usage.
- **Reusing the storage conformance fault-injection seam.** Rejected: that seam measures the storage port,
  not the performer. The bench measures real providers under the same cases.
- **Dropping failed attempts from the latency percentiles.** Rejected: it produces flattering numbers and
  hides the failures the bench exists to expose.
- **Estimating a missing cost from the prompt size.** Rejected: it fabricates a number the evidence does not
  carry (NFR-04).

## Consequences

- Numbers are **attributable and reproducible offline** from fixture records, with no provider.
- The aggregate is deliberately conservative: one missing usage makes the total unknown.
- `D3` (the stage names) is **provisional** until the I1-01 timing convention is agreed; the stage set is
  one type, so a rename is a contained change (see Re-open triggers).
- The bench ships *machinery*, not results: the report slice (S4) produces
  `docs/architecture/evaluation-table.md`, which **does not exist yet** and stays empty until M3/M4 supply cases and
  a provider run happens.

## Re-open triggers

- **I1-01** changes the stage set → update `TIMING_STAGES` and this ADR with the agreed convention.
- The report needs statistics beyond percentiles → extend `metrics.ts` first, and only add a dependency
  with a recorded decision.
- M3/M4 supply cases and labels → the eval set moves from synthetic to reviewed (NFR-03).

## References

- `PLAN.en.md:53, 90, 116`; `REQUIREMENTS.en.md:34` (NFR-01), `:36` (NFR-03), `:37` (NFR-04).
- `docs/code-governance/structural-constraints.md` §4 — rules and their enforcement (lands with **PR #32**).
- Gate **G4** (`src/evaluation/eval-gate.ts`, ADR-006 — lands with **PR #27**) reads the evaluation table this bench generates.
- Delta-007.
