# Delta-008 — Prepared-input provenance companion

Change record for **ADR-008**. Date: 2026-11-09 (review fixes 2026-11-09/10). Branch
`m6-02-provenance` (PR #140), measured at `44b5d98` on `main` `e9e7e7b`; the null-occurrence
refusal `ec7d372` and the docs-only `341303a` follow that measurement. The `dd4cebf`/`78fe3f1`
paragraphs below are **historical**; the verification block below is for the head named in the PR
body, and the historical figures above are not a current measurement. Scope: a **separate**
companion artifact; `RecordedRunV1` and every public port are unchanged.

## Change

Against `main` `e9e7e7b`, the slice changes ten files:

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

## Verification at `dd4cebf` (historical)

- Focused: `pnpm exec vitest run test/offline/m6-02-provenance.test.ts
  test/offline/m6-02-provenance-command.test.ts` → **30 passed / 2 files**.
- The PR's own `verify` check passed at this head; `main`'s required `verify` was not re-measured for this
  branch in this session (the branch is behind `main`).
- No provider, no evaluation table, no quality or latency result.

## Open items (recorded, not resolved here)

- **ADR-008 remains `proposed`.** M3 answered the identity scope and M4 answered D7; the remaining
  affected-owner items are M5's acknowledgement export and the unadopted interface direction. This Delta
  does not approve the ADR and does not authorise a merge.
- **Export shape.** M5 must pin the producing export of `sourceId`, `requestMessageId` and `eventId` before
  any CP05 scoring that joins an attempt to dialogue-side records (ADR-008 open decision 3).
- **Case ids.** The provenance row carries ids pending; no case id is claimed or invented.
- **Companion shape.** The root binding plus `attempts[]` reading still needs M5's explicit confirmation
  (DEBT-09).
- **`exact` scope across a partial batch (M5, 2026-11-11).** A synthetic `accepted → no-acknowledgement →
  not-submitted` batch can currently be recorded as `correlation: exact`. Whether `exact` describes the
  admitted link or the complete batch is an open M5/M4 coordination question; this change does not decide
  it, and the eligibility path must respect the agreed distinction before CP05 scoring.

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
- **Not-run observations** — an optional root `notRun[]` (`caseId`, `variantId`, `occurrence`, `inputs`)
  carries observed inputs for cases the run did not execute, bound to the run's not-run pairs and never
  scored; the run's `notRun[].reason` stays the single authority and the companion carries no reason.
  `RecordedRunV1` is unchanged (ADR-008 D4/D8).
- **Occurrence key** — JSON-encoded tuple, so an identifier containing a delimiter cannot collide with a
  different pair (ADR-008 D2).

Verification: provenance **29** tests and command **13**; `test:m6` 225/225 in 16 files; trace 41/41;
readiness 45/45; `pnpm verify` exit 0. Four mutations each turned their own test red, then were restored.

## Not-run contract (M5 follow-up, 2026-11-09)

- **One reason authority.** The companion's `notRun[]` no longer carries `reason`; the run's
  `notRun[].reason` is rendered. The two could previously disagree on a synthetic case.
- **Occurrence.** A companion entry names `occurrence` (1-based, default 1) among the run's not-run pairs.
  Repeated pairs are explicit; an occurrence the run does not have is refused.
- Regressions: the removed `reason` field, an unknown occurrence, and two repeated pairs rendering both
  run reasons.

Verification at `44b5d98`: provenance **45** tests; `test:m6` **228/228** in 16 files; trace 41/41;
readiness 45/45; full **1586/1586** in 76 files; `pnpm verify` exit 0.

### Null occurrence and review-fix pass (`ec7d372`, `341303a`)

- `ec7d372` refuses a JSON `null` occurrence — the default of 1 applies only to an omitted field — with its
  own regression.
- `341303a` is the docs/ai-use record for that fix and for the Delta refresh below; it changes no code.
- The review-fix pass at the current head also: builds the run's not-run reason index in **one** helper
  (`notRunReasonIndex`) used by both the parser and the renderer, and binds the five-input cap to C1's
  `MAX_SELECTION_CANDIDATES` with an agreement test.
- **Repeated case ids (M5 re-review, 2026-11-11).** `runComparison` accepts repeated case ids, so one
  `(caseId, variantId)` may have both an attempt and a separate not-run occurrence. The companion not-run
  entry is validated **only** against the run's `notRun` occurrence; an earlier executed-pair refusal was a
  false refusal and is removed. A runner-to-report regression covers the mixed case, and the report's
  not-run table now prints `Occurrence`, so two same-reason occurrences are distinguishable.
- **A rejected or never-submitted input cannot claim an event id.** `status: rejected` or
  `status: not-submitted` with a non-null `eventId` is refused (ADR-008 D3: the event id is created on
  admission; a request id may already exist). The positive stopped-batch fixture uses `eventId: null`
  for those inputs, and negative coverage exists for both the executed-attempt and not-run paths.

Verification at the head named in the PR body: provenance **52** tests across the two files; `test:m6` **238/238** in 16
files; trace 41/41; readiness 47/47; full **1601/1601** in 76 files; `pnpm verify` exit 0. Four mutations
turned their own tests red and were restored: reinstating the executed-pair refusal, removing the
rejected-event-id refusal, removing the occurrence column, and removing the `not-submitted`
event-id clause.
