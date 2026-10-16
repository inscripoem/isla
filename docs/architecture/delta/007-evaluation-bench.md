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

Per `docs/code-governance/structural-constraints.md` §3, a new id is **allocated in the register before it
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
- The generated `docs/architecture/evaluation-table.md`.
