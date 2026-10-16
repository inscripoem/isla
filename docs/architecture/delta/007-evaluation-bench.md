# Delta-007 — Evaluation bench: the measurement record

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
