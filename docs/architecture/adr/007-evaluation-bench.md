# ADR-007 — Shared comparison and measurement bench (M6-02)

Status: accepted (proposal under review). Date: 2026-10-16. Owner: M6 (evaluation tooling lane).
Related: ADR-006 (gate tooling), `docs/code-governance/structural-constraints.md` §4.

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

Every attempt is recorded with its outcome — `completed`, `cancelled` or `failed`. A failed attempt is a
**measurement, not a gap**: dropping it would inflate the success picture and hide the tail NFR-01 asks
about.

### D3 — Missing is unknown, never zero

A measurement that was not observed is `null`. Usage is summed **only when every attempt reports it**;
otherwise the aggregate is `null` and `unknown` is true. This is the literal reading of NFR-04
(*"Missing usage remains unknown"*), and it is deliberately conservative: a partial sum presented as a
total is a lie.

### D4 — Cold and warm are separate populations

The first attempt after process start is summarised apart from subsequent attempts (NFR-01 requires the
cold/warm state to be documented). Mixing them would hide the warm-up cost.

### D5 — Nearest-rank percentiles, no dependency

`p(q) = sorted[min(n − 1, ceil(q·n) − 1)]`, and `null` for an empty sample. Each stage reports the sample
`n` it actually measured, so a thin sample is visible rather than disguised.

### D6 — The bench does not invent a provider

Running the bench against a real provider requires a provider. Without one, the run is reported as
**not run** — never a fabricated pass. Gate G4 reads the same rule from the generated evaluation table.

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
- The bench ships *machinery*, not results: `evaluation-table.md` stays empty until M3/M4 supply cases and
  a provider run happens.

## Re-open triggers

- **I1-01** changes the stage set → update `TIMING_STAGES` and this ADR with the agreed convention.
- The report needs statistics beyond percentiles → extend `metrics.ts` first, and only add a dependency
  with a recorded decision.
- M3/M4 supply cases and labels → the eval set moves from synthetic to reviewed (NFR-03).

## References

- `PLAN.en.md:53, 90, 116`; `REQUIREMENTS.en.md:34` (NFR-01), `:36` (NFR-03), `:37` (NFR-04).
- `docs/code-governance/structural-constraints.md` §4 — rules and their enforcement.
- Gate **G4** (`src/evaluation/eval-gate.ts`, ADR-006) reads the evaluation table this bench generates.
- Delta-007.
