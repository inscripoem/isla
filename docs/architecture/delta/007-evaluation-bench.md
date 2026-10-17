# Delta-007 — Evaluation bench: measurement, runner, report and case shape

Change record for **ADR-007**. Date: 2026-10-16. Branch `m6-02-bench` (based on `main`).
Scope: **additive** — no register, contract, schema or behaviour change.

## Change

- **Added** `src/evaluation/metrics.ts` — `AttemptRecord` / `StageTiming` / `AttemptUsage`, `percentile`,
  `summarise`. Pure functions; no provider import.
- **Added** `test/offline/m6-02-metrics.test.ts` — 10 cases covering percentiles, cold/warm separation,
  failed/cancelled accounting, the measured-sample count, and the usage honesty rule.

## Why

First slice of M6-02 (ADR-007 D1–D5): fix the **shape of a measurement** before any number is produced.
The runner (`comparison.ts`), the eval set and the generated report follow in later slices.

## Verification

- `npx vitest run test/offline/m6-02-metrics.test.ts` → **10 passed**.
- `pnpm verify` → clean (typecheck, lint, all suites, build).

## Traceability

Per `docs/code-governance/structural-constraints.md` §3 (lands with **PR #32**), a new id is **allocated in the register before it
is used, and nobody self-assigns one**. So this slice records its traceability intent here and leaves the
ids **pending allocation**:

- **Invariant (pending id):** *every attempt is accounted for — including failures and cancellations — and
  missing usage stays unknown.*
- **Case (pending id):** `summarise` counts failed/cancelled attempts and keeps usage `unknown` when the
  sample is incomplete (it never reports a partial total).
- **ADR:** ADR-007 (this change).

Once the id convention is agreed (PR #32), the rows are added to `docs/req/requirements.yaml` and
`docs/req/case-registry.yaml`, and an `invariants.md` row is added with its verification and owner.

## Not in this slice

- `comparison.ts` (the runner) and any provider integration.
- The eval set (synthetic first, then M3/M4 cases and labels).
- The generated `docs/architecture/evaluation-table.md` — **not yet produced** (the report slice, S4).

---

## Slice 2 + 3 — the runner and an offline end-to-end run

- **Added** `src/evaluation/comparison.ts` — `Variant`, `EvalCase`, `VariantRun`, `runComparison`.
  Decisions realised there, each recorded as a comment at the point of code:
  - **the bench aggregates, it does not compose** — `runVariant` is injected, and the module imports only
    `./metrics` (a boundary test asserts it) — ADR-007 D1, issue **#41 Q1**;
  - **a thrown variant is still an attempt** — recorded as `failed` with a `failureReason` (new field on
    `AttemptRecord`) and `usageMissing: true`, so a case is never silently lost — ADR-007 D2;
  - **"not run" is first class** — `{ ran: false, reason }` yields a `notRun` entry and **no** record, so
    nothing is claimed — ADR-007 D6;
  - **the bench labels its own records** — `caseId`, `variantId` and `cold` are set by the runner, so a
    variant cannot mis-attribute a result; `cold` is the **first attempt that variant actually made** in the
    run, and a not-run case does not consume that slot.
- **Deviation from the design note, for the record:** the runner takes **only** `runVariant`. The planned
  `now()` dependency was dropped because every timing already arrives inside the record; a run's wall-clock
  stamp belongs to the report slice (S4), which needs it for the header.
- **Added** `test/support/m6-02-synthetic.ts` — a synthetic case set (normal / cancelled at Stop / failed) and
  a scripted `runVariant`; no provider, no model.
- **Added** `test/offline/m6-02-comparison.test.ts` — 7 cases, including the module-boundary guard.

### Verification (slices 2 + 3)

- `npx vitest run test/offline/m6-02-comparison.test.ts test/offline/m6-02-metrics.test.ts` → **18 passed**.
- `pnpm verify` → clean.

---

## Slice 4 — the report (S4)

- **Added** `src/evaluation/report.ts` — `FixedConditions` (NFR-01's five plus #41 Q3's conditions),
  `collectReportViolations` and `renderEvaluationReport`. It refuses a fixture text source, latency from an
  injected clock, zero attempts, a mismatched declared sample size, blank conditions and undeclared
  variants; an unobserved stage prints `—`, never `0`.
- **Changed** `src/evaluation/metrics.ts` — `summariseWindow` exported, so the report reuses the same window
  statistics instead of a second percentile implementation.
- **Added** `test/offline/m6-02-report.test.ts` — 12 cases, including every refusal and the unknown rules.
  Each refusal is mutation-checked (allowing a fixture source, allowing injected-clock latency, or printing
  `0` for an unobserved value each turns the suite red).
- `docs/architecture/evaluation-table.md` is **not** produced: there is no provider access, so gate G4
  correctly stays **not run**.

### Verification (slice 4)

- `npx vitest run test/offline/m6-02-report.test.ts` → **15 passed**.
- `pnpm verify` → **601 passed / 25 files**.

### Corrections after self-review (same slice, before delivery)

- **Cost precision:** the generic number formatter rounded to one decimal, so a per-attempt cost of
  `$0.002` printed as `$0.0` — a non-zero cost reported as zero. Cost now prints up to six decimals, with a
  test that fails at one decimal.
- **Run identity:** the report now requires a `runId` and a `YYYY-MM-DD` generation date and prints them in
  the header. Without them the artifact cannot be attributed to a run.
- **One aggregation rule:** the per-variant usage cell re-implemented the partial-total rule; it now calls
  `summarise` and formats the result, so the report cannot drift from the metric.
- **Decision order:** D8 had been inserted before D7; corrected.

---

## Slice 5 — the case shape (issue #41 Q3a)

- **Changed** `src/evaluation/comparison.ts` — `EvalCase` gains optional `replyIntent` and `heldOut`
  (ADR-007 D8). Absent stays absent; the runner passes the case through unchanged and does not default it.
- **Added** a case in `test/offline/m6-02-comparison.test.ts` — the variant receives the exact declared
  object, a bare case has no invented fields, and duplicate field definitions do not appear because run-wide
  conditions live in `FixedConditions` (D7).
- Mutation-checked: defaulting a missing `replyIntent` turns the test red.

### Verification (slice 5)

- `npx vitest run test/offline/m6-02-comparison.test.ts` → **9 passed**.
- `pnpm verify` → **601 passed / 25 files**.

