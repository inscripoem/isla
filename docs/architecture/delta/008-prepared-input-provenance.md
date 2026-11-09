# Delta-008 — Prepared-input provenance companion

Change record for **ADR-008**. Date: 2026-11-09. Branch `m6-02-provenance` (PR #140), measured at
`dd4cebf` before the planned rebase onto `main` `78fe3f1`. Scope: a **separate** companion artifact;
`RecordedRunV1` and every public port are unchanged.

## Change

Against `main` `78fe3f1`, the slice changes eight files:

- **ADDED** `src/evaluation/provenance.ts` — `ProvenanceCompanionV1`, `ProvenanceAttempt`,
  `ProvenanceInputEntry`, `parseProvenance`. A strict parser: unknown keys, a run-id or digest mismatch,
  a missing/extra/duplicate occurrence key, an unestablishable input order, `exact` with a null
  `recordSetRevision`, and more than five inputs are refused.
- **ADDED** `test/offline/m6-02-provenance.test.ts` — parser cases, refusals and digest normalisation.
- **ADDED** `test/offline/m6-02-provenance-command.test.ts` — the `--provenance` command path, a refusal
  that writes no table, and the rendered section.
- **MODIFIED** `src/evaluation/report-command.ts` — an explicit `--provenance <path>` input; the companion
  is validated against the exact run bytes before any table is written.
- **MODIFIED** `src/evaluation/report.ts` — a provenance appendix and per-attempt row; the renderer
  re-applies the run-id and occurrence-key binding, so the exported API cannot print another run's evidence.
- **MODIFIED** `docs/architecture/trace-matrix.md` — one ADR-008 row; **case ids are pending allocation**
  and the row says so.
- **MODIFIED** `docs/ai-use-log.yaml` — the supervised-session entries for this slice.
- **MODIFIED** `package.json` — the two provenance suites join `test:m6`; no dependency changes.

**FROZEN and unchanged:** `RecordedRunV1` (`schemaVersion: 1` in `src/evaluation/recorded-run.ts`),
`src/contracts/app/ports.ts`, `src/contracts/app/storage.ts`, `architecture-blueprint.md`.

**OBSOLETED:** none. The companion is additive; no existing field, file or call path is removed or
repurposed.

## Why

ADR-008 D1–D8: an attempt in a frozen run record cannot say which prepared input produced it, and text,
array position and runtime ids are all unsafe identities. The companion binds each attempt to its inputs
by content (`runDigest`) and a positional occurrence key, keeps unobserved values `null`
(`not-yet-observable`), and refuses a partial join rather than printing one.

## Verification at `dd4cebf`

- Focused: `pnpm exec vitest run test/offline/m6-02-provenance.test.ts
  test/offline/m6-02-provenance-command.test.ts` → **30 passed / 2 files**.
- The PR's own `verify` check passed at this head; `main`'s required `verify` was not re-measured for this
  branch in this session (the branch is behind `main`).
- No provider, no evaluation table, no quality or latency result.

## Open items (recorded, not resolved here)

- **ADR-008 remains `proposed`.** This Delta records an implementation that awaits M3/M4/M5 approval; it
  does not approve the ADR and does not authorise a merge.
- **Export shape.** M5 must pin the producing export of `sourceId`, `requestMessageId` and `eventId` before
  any CP05 scoring that joins an attempt to dialogue-side records (ADR-008 open decision 3).
- **Case ids.** The provenance row carries ids pending; no case id is claimed or invented.
- **Companion shape.** The root binding plus `attempts[]` reading still needs M5's explicit confirmation
  (DEBT-09).

## Traceability

- **ADR:** ADR-008 (this change).
- **Requirement:** NFR-01 / NFR-04 (evaluation evidence), FR-06 (persistence boundary).
- **Invariant:** INV-16 (missing evidence stays unknown; no scored result from an unbound attempt).
- **Case:** pending allocation; the trace row records that rather than inventing one.

## Review fixes (2026-11-09, M5)

- **Exact acknowledgement** — `correlation: 'exact'` requires at least one `accepted`/`duplicate` input and
  both `requestMessageId` and `eventId` on every such input; otherwise the companion records `missing`
  (ADR-008 D3/D8). A report-boundary regression refuses the synthetic exact-with-null-ids companion.
- **Terminal submission order** — `rejected`, `no-acknowledgement` and `not-submitted` end the batch; a
  later submission is refused (ADR-008 D3).
- **Not-run observations** — an optional root `notRun[]` (`caseId`, `variantId`, `reason`, `inputs`) carries
  observed inputs for cases the run did not execute, bound to the run's not-run pairs and never scored;
  `RecordedRunV1` is unchanged (ADR-008 D4/D8).
- **Occurrence key** — JSON-encoded tuple, so an identifier containing a delimiter cannot collide with a
  different pair (ADR-008 D2).

Verification: provenance **29** tests and command **13**; `test:m6` 225/225 in 16 files; trace 41/41;
readiness 45/45; `pnpm verify` exit 0. Four mutations each turned their own test red, then were restored.
